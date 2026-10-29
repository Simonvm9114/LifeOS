/**
 * MemoryEntryMeta — per-entry age and durability metadata for the hot-layer
 * memory files.
 *
 * ## Why this exists
 *
 * `PRINCIPAL_MEMORY.md` and `DA_MEMORY.md` hold up to 48 entries each and carry
 * only a file-level `last_updated`. The reviewer curates them in set-overwrite
 * mode, and its own instructions tell it to supersede contradictions and to
 * "keep the most recent entry" when it cannot source a winner — but nothing on
 * disk records which entry is more recent, so that rule was unexecutable. The
 * same blindness hit consolidation: at ≥80% occupancy the reviewer must drop
 * entries, and it chose without knowing which facts had been true for months.
 *
 * ## The shape of the fix
 *
 * Nothing about the memory files changes. The metadata is computed
 * deterministically by `MemoryWriter` from the eviction/addition delta it
 * already has in hand inside the write lock, stored in a sidecar under
 * `MEMORY/STATE/`, and injected into the reviewer's prompt at render time.
 *
 * Three properties are load-bearing:
 *
 *   1. **The model never authors a date.** A model-authored timestamp is a
 *      hallucinated timestamp, and a hallucinated timestamp read back later as
 *      fact is worse than no timestamp at all.
 *   2. **This can never break a memory write.** The ledger append in
 *      `setEntries` is deliberately fail-closed; this is the opposite. Memory
 *      curation is the load-bearing path and an optimization may not block it,
 *      so every entry point here swallows its own failures and returns false.
 *   3. **The store is derived and disposable.** Delete it and the reviewer
 *      prompt degrades to its pre-2026-08-20 behavior. Nothing else reads it.
 *
 * ## What `survivals` measures
 *
 * Not Honcho's `times_derived`, which counts independent re-derivation from
 * source material. Set-overwrite means the reviewer resubmits every entry on
 * every run, so resubmission carries no such signal. This counts curation
 * passes survived — still real, because each pass is a chance to be dropped and
 * omission is exactly how forgetting works here. Named for what it is.
 *
 * ## Known limit
 *
 * Keys normalize away the trailing provenance tag, letter case, and whitespace
 * runs. A genuinely reworded entry starts a new history. Fuzzy matching would
 * introduce false merges into the one surface where a wrong fact is most
 * durable, so the reset is deliberate.
 *
 * The same applies after `MemoryWriter.restoreContent`: a restore does not
 * re-stamp the store, so restored entries render bare until the next curation
 * write, which then stamps them with that day's date and makes old facts look
 * new. Rare and human-invoked. The honest fix is a rebuild-from-ledger pass,
 * tracked in the originating ISA's Remaining Work rather than bodged here.
 *
 * Origin: Honcho parity review 2026-08-20 (tracked in the maintainer's private
 * work notes).
 *
 * @version 1.0.1
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { getClaudeDir } from "./Paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep

import { invariant } from "./Invariant";
import { rowFile, type LedgerRowBase } from "./lib/CortexLedgerCore";

const CLAUDE_ROOT = getClaudeDir();

/** Default store location. Under STATE/ so it can never be mistaken for fold-owned content. */
export const DEFAULT_STORE_PATH = pathResolve(
  CLAUDE_ROOT,
  "LIFEOS/MEMORY/STATE/memory-entry-meta.json",
);

const SCHEMA_VERSION = 1;

/** Trailing provenance tag written by the reviewer — see MemoryReviewer's entry contract. */
const PROVENANCE_TAG = /\s*~(?:explicit|deduced|inferred)\s*$/;

/**
 * The annotation this module renders into the reviewer prompt.
 *
 * Exported because `MemoryWriter.validateAndDedup` strips it at the write
 * chokepoint. The prompt tells the reviewer never to echo it back, and a prompt
 * is not a guarantee: models copy the string sitting above their output. An
 * echoed annotation would be accepted by every existing check (the prefix still
 * matches, ~33 chars fits under the 256 cap, it isn't instruction-shaped, and
 * the marker check only knows BEGIN/END), land on disk, and then — because the
 * baked-in suffix changes the entry text — orphan the very record it came from
 * and reset that entry's history to zero. Stripping beats refusing: under
 * set-overwrite a refusal evicts the fact entirely, while a strip preserves
 * both the fact and its key continuity.
 */
export const ANNOTATION_PATTERN = /\s*⟨since[^⟩]*⟩\s*$/;

export interface EntryMeta {
  /** ISO-8601 of the write that first admitted this entry. */
  first_seen: string;
  /** ISO-8601 of the most recent write that carried it. */
  last_seen: string;
  /** How many curation writes this entry has survived. Always ≥ 1. */
  survivals: number;
}

export interface MetaStore {
  schema_version: number;
  /** Keyed by repo-relative memory file path, then by normalized entry key. */
  files: Record<string, Record<string, EntryMeta>>;
}

export interface MetaOptions {
  /** Override the store location. Tests inject a temp path; production omits it. */
  storePath?: string;
}

function emptyStore(): MetaStore {
  return { schema_version: SCHEMA_VERSION, files: {} };
}

/**
 * The identity of an entry for metadata purposes.
 *
 * Collapses the three ways an entry's text churns without its meaning changing:
 * the reviewer flipping its provenance tag, casing drift, and whitespace runs.
 */
export function normalizeKey(entry: string): string {
  // Annotation first: a trailing ⟨…⟩ un-anchors PROVENANCE_TAG, so stripping in
  // the other order would leave both the annotation AND the tag baked into the
  // key. This is the second belt — the writer already strips at its chokepoint.
  return entry
    .replace(ANNOTATION_PATTERN, "")
    .replace(PROVENANCE_TAG, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Read the store. A missing, unreadable, corrupt, or shape-invalid file reads as
 * empty — this is a cache, and a caller must never have to handle its absence.
 */
export function readStore(storePath: string = DEFAULT_STORE_PATH): MetaStore {
  try {
    if (!existsSync(storePath)) return emptyStore();
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptyStore();
    const files = (parsed as MetaStore).files;
    if (typeof files !== "object" || files === null || Array.isArray(files)) return emptyStore();
    return { schema_version: SCHEMA_VERSION, files: files as MetaStore["files"] };
  } catch {
    return emptyStore();
  }
}

function writeStore(storePath: string, store: MetaStore): boolean {
  // Invariants before the write: an impossible store shape persisting here
  // would silently poison every later reviewer prompt.
  invariant(store.schema_version === SCHEMA_VERSION, `store schema_version must be ${SCHEMA_VERSION}`);
  invariant(store.files !== null && typeof store.files === "object", "store.files must be an object");
  for (const [rel, entries] of Object.entries(store.files)) {
    invariant(rel.length > 0, "store file key must be non-empty");
    for (const [key, meta] of Object.entries(entries)) {
      invariant(key.length > 0, `entry key must be non-empty in ${rel}`);
      invariant(
        Number.isInteger(meta.survivals) && meta.survivals >= 1,
        `survivals must be an integer ≥ 1 (${rel} → ${key})`,
      );
      invariant(meta.first_seen.length > 0 && meta.last_seen.length > 0, `timestamps must be set (${rel} → ${key})`);
    }
  }

  const tmp = `${storePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(tmp, storePath);
    return true;
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // The temp file is unreachable too. Nothing further to clean up.
    }
    return false;
  }
}

/**
 * Fold one memory write into the metadata store.
 *
 * Called by `MemoryWriter.setEntries` after a successful atomic write, with the
 * same prior/new entry lists the in-lock guards were decided against.
 *
 * Never throws on I/O and never propagates a failure to the caller — a false
 * return means the metadata is stale, which costs the reviewer some context and
 * costs the memory file nothing.
 */
export function recordWrite(
  rel: string,
  priorEntries: string[],
  newEntries: string[],
  ts: string,
  options: MetaOptions = {},
): boolean {
  try {
    invariant(rel.length > 0, "recordWrite needs a relative memory-file path");
    invariant(ts.length > 0, "recordWrite needs a timestamp");

    const storePath = options.storePath ?? DEFAULT_STORE_PATH;
    const store = readStore(storePath);
    const prior = store.files[rel] ?? {};
    const priorKeys = new Set(priorEntries.map(normalizeKey));
    const next: Record<string, EntryMeta> = {};

    for (const entry of newEntries) {
      const key = normalizeKey(entry);
      if (key.length === 0) continue;
      // Already counted this write (two submitted entries normalizing to the
      // same key) — the writer's exact-string dedup lets that through.
      if (next[key]) continue;

      const carried = priorKeys.has(key) ? prior[key] : undefined;
      next[key] = carried
        ? { first_seen: carried.first_seen, last_seen: ts, survivals: carried.survivals + 1 }
        : { first_seen: ts, last_seen: ts, survivals: 1 };
    }

    // Evicted entries are simply absent from `next` — forgetting is omission
    // here for the same reason it is in the memory file itself.
    store.files[rel] = next;
    return writeStore(storePath, store);
  } catch {
    return false;
  }
}

export interface BackfillResult {
  events_replayed: number;
  files: Record<string, number>;
}

/**
 * Rebuild the store by replaying the ledger's memory writes in order.
 *
 * Without this, the cold start is a lie: the first write after deployment
 * stamps every currently-live entry with that day's date, so a fact that has
 * been true since June reads the same as one added this afternoon — and the
 * age discrimination this module exists to provide would not exist for a single
 * current entry. The ledger already holds every `memory/set` with its full
 * entry list and timestamp, which is exactly the history needed.
 *
 * Ages recovered this way are "at least this old": the ledger's genesis is its
 * horizon, so an entry predating it dates to the earliest event that carries
 * it. Understating age is the safe direction — it can only make the reviewer
 * more cautious about superseding something.
 *
 * Idempotent: replaying from an empty store always yields the same result.
 */
export function backfillFromLedger(rows: LedgerRowBase[], options: MetaOptions = {}): BackfillResult {
  const storePath = options.storePath ?? DEFAULT_STORE_PATH;
  const rebuilt: MetaStore = emptyStore();
  let replayed = 0;

  for (const row of rows) {
    const kind = (row as { kind?: string }).kind;
    if (kind !== "memory/set" && kind !== "memory/restore") continue;
    const rel = rowFile(row as { file?: unknown });
    const entries = (row as { entries?: string[] }).entries;
    const ts = (row as { ts?: string }).ts;
    if (typeof rel !== "string" || !Array.isArray(entries) || typeof ts !== "string") continue;
    if ((row as { rejected?: boolean }).rejected === true) continue;

    const prior = rebuilt.files[rel] ?? {};
    const next: Record<string, EntryMeta> = {};
    for (const entry of entries) {
      const key = normalizeKey(entry);
      if (key.length === 0 || next[key]) continue;
      const carried = prior[key];
      next[key] = carried
        ? { first_seen: carried.first_seen, last_seen: ts, survivals: carried.survivals + 1 }
        : { first_seen: ts, last_seen: ts, survivals: 1 };
    }
    rebuilt.files[rel] = next;
    replayed++;
  }

  writeStore(storePath, rebuilt);
  return {
    events_replayed: replayed,
    files: Object.fromEntries(Object.entries(rebuilt.files).map(([rel, m]) => [rel, Object.keys(m).length])),
  };
}

/** How the age/durability context is fenced off from the entry text itself. */
const ANNOTATION = (firstSeen: string, survivals: number) =>
  `  ⟨since ${firstSeen.slice(0, 10)} · survived ${survivals}⟩`;

/**
 * Render entries with their age and durability for the reviewer prompt.
 *
 * Prompt-side only: the returned strings are never written to disk and are
 * never accepted back from the model as entry text. An entry with no metadata
 * renders bare, so a deleted store degrades to today's behavior.
 */
export function annotate(rel: string, entries: string[], options: MetaOptions = {}): string[] {
  try {
    const store = readStore(options.storePath ?? DEFAULT_STORE_PATH);
    const meta = store.files[rel];
    if (!meta) return entries;
    return entries.map((entry) => {
      // Idempotent: strip any annotation already on the line before adding one,
      // so a double render can never stack two of them.
      const bare = entry.replace(ANNOTATION_PATTERN, "");
      const record = meta[normalizeKey(bare)];
      return record ? `${bare}${ANNOTATION(record.first_seen, record.survivals)}` : bare;
    });
  } catch {
    return entries;
  }
}

// ── CLI ──

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "backfill") {
    const { readRows } = await import("./lib/CortexLedgerCore");
    console.log(JSON.stringify(backfillFromLedger(readRows()), null, 2));
  } else if (command === "status") {
    const store = readStore();
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(store.files).map(([rel, m]) => {
            const records = Object.values(m);
            const oldest = records.map((r) => r.first_seen).sort()[0] ?? null;
            return [rel, { entries: records.length, oldest_first_seen: oldest }];
          }),
        ),
        null,
        2,
      ),
    );
  } else {
    console.error("Usage: bun MemoryEntryMeta.ts {backfill|status}");
    process.exit(1);
  }
}
