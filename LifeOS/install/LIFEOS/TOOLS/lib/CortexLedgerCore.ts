/**
 * CortexLedgerCore — the append-only event ledger behind the hot-layer memory
 * files (log-plus-projection, design run 20260816-cortex-ledger-design).
 *
 * The invariant this file carries: **curated ⟺ folded** — every autonomically
 * curated byte of a fold-owned memory file is a deterministic render of ledger
 * events. The LLM authors events (the reviewer's op:"set" full desired state);
 * deterministic code folds events into files. A legitimate out-of-band edit
 * (a rename sweep, a hand edit) is folded in as a `memory/adopt` event that
 * carries the live bytes, so the file and the ledger agree again. Enforcement is detection-first:
 * `verifyLedger()` runs on the health cadence and drift is CRITICAL.
 *
 * Contract facts callers rely on:
 *   - `appendEvent` is FAIL-CLOSED for folding kinds: it returns an error and
 *     the caller MUST NOT touch the target file. A lost curation cycle is
 *     strictly cheaper than a file the ledger cannot reconstruct.
 *   - Rows are hash-chained: row_hash = sha256(prev_row_hash + canonical row).
 *     Chain verification anchors at the FIRST row of the file — after a
 *     `compact`, that row is a checkpoint whose prev_row_hash points into the
 *     archive; the anchor rule is what makes compaction legal.
 *   - A torn FINAL line (crash mid-append) is quarantined to torn-<ts>.txt and
 *     truncated, recorded in ledger-incidents.jsonl. A torn INTERIOR line is an
 *     integrity failure and every reader throws — never silently skipped.
 *   - Folding kinds carry the full rendered document (`content`), so any fold
 *     is a byte copy of the last folding event plus redact filtering. This is
 *     the snapshot-log variant (cross-vendor audit, blocker 1): no render template,
 *     no frontmatter carry-over logic, no divergence with out-of-band
 *     frontmatter writers like the release version bumper.
 *
 * No imports from MemoryWriter (MemoryWriter imports THIS module).
 * CORTEX_LEDGER_ROOT overrides the root for tests only.
 *
 * The generic primitives (sha256, canonical JSON, the chain step, the O_EXCL
 * lock, torn-tail quarantine) come from LedgerCore, shared with STATVS (STATVS
 * ISA ISC-26). Cortex keeps its own on-disk names: the quarantine file is
 * `torn-<stamp>.txt` in the ledger dir, the temp file is `<events>.tmp`, and
 * the incident row goes to ledger-incidents.jsonl. The lock never takes over a
 * stale lockfile (staleMs: Infinity), as before.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
  appendFileSync,
} from "node:fs";
import { claudeRel, getClaudeDir } from "../Paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep
import { dirname, resolve as pathResolve } from "node:path";
import { invariant, InvariantViolation } from "../Invariant";
import { sha256, rowHash, withFileLock, quarantineTornTail as quarantineTail } from "./LedgerCore";

export { sha256 };

// ── Paths ──

function root(): string {
  return process.env.CORTEX_LEDGER_ROOT || getClaudeDir();
}
export function ledgerDir(): string {
  return pathResolve(root(), "LIFEOS/MEMORY/LEDGER");
}
/**
 * A row's file key, root-relative. Windows builds before claudeRel wrote absolute keys
 * (C:\Users\…\.claude\LIFEOS\USER\…); rows are hash-chained and never rewritten, so readers map
 * them here instead. Undefined when the row names no file.
 */
export function rowFile(row: { file?: unknown }): string | undefined {
  return typeof row.file === "string" ? claudeRel(row.file) : undefined;
}
export function eventsPath(): string {
  return pathResolve(ledgerDir(), "cortex-events.jsonl");
}
export function archiveDir(): string {
  return pathResolve(ledgerDir(), "archive");
}
const incidentsPath = () => pathResolve(ledgerDir(), "ledger-incidents.jsonl");
const lockPath = () => eventsPath() + ".lock";

// ── Types ──

export const LEDGER_SCHEMA_VERSION = 1;

/** Kinds whose events change fold output. Everything else is audit-only. */
export const FOLDING_KINDS = new Set(["memory/set", "memory/restore", "memory/adopt", "checkpoint", "memory/redact"]);

export interface LedgerRowBase {
  v: number;
  seq: number;
  id: string;
  kind: string;
  ts: string;
  updated_by?: string;
  session_id?: string;
  run_id?: string;
  prev_row_hash: string;
  row_hash: string;
  /** Root-relative target file for single-file kinds. */
  file?: string;
  [key: string]: unknown;
}

/** Caller-supplied slice of a row; envelope fields are computed by appendEvent. */
export interface LedgerEventInput {
  kind: string;
  ts: string;
  updated_by?: string;
  session_id?: string;
  run_id?: string;
  file?: string;
  [key: string]: unknown;
}

export interface AppendOk {
  ok: true;
  row: LedgerRowBase;
}
export interface AppendErr {
  ok: false;
  message: string;
}
export type AppendResult = AppendOk | AppendErr;

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

// ── Hashing ──

/** Canonical hash of an entry SET — order-sensitive join, the fold-owned region. */
export function entriesHash(entries: string[]): string {
  return sha256(entries.join("\n"));
}

// ── Torn-tail quarantine ──

function quarantineTornTail(raw: string, lastNewline: number): void {
  const torn = raw.slice(lastNewline + 1);
  // LedgerCore moves the bytes after the last newline aside and truncates via
  // tmp+rename, so a crash mid-truncation can't lose parsed rows.
  quarantineTail(eventsPath(), ledgerDir(), {
    fileName: (stamp) => `torn-${stamp}.txt`,
    tmpPath: eventsPath() + ".tmp",
  });
  try {
    appendFileSync(
      incidentsPath(),
      JSON.stringify({ ts: new Date().toISOString(), kind: "torn-tail-truncated", bytes: torn.length }) + "\n",
      "utf8",
    );
  } catch { /* incident log is best-effort; the quarantine file is the record */ }
}

// ── Reading ──

/**
 * Read and chain-verify every row. The first row is the chain anchor (its
 * prev_row_hash is accepted verbatim — post-compact it references the archive).
 * Interior corruption throws LedgerIntegrityError; a torn final line is healed
 * (quarantine + truncate) when `healTail` is true, thrown otherwise.
 */
export function readRows(opts: { healTail?: boolean } = {}): LedgerRowBase[] {
  const path = eventsPath();
  if (!existsSync(path)) return [];
  let raw = readFileSync(path, "utf8");
  if (raw.length === 0) return [];

  // Torn tail: content after the last newline that fails to parse.
  if (!raw.endsWith("\n")) {
    const lastNewline = raw.lastIndexOf("\n");
    const tail = raw.slice(lastNewline + 1);
    let tornOk = false;
    try { JSON.parse(tail); tornOk = true; } catch { /* torn */ }
    if (tornOk) {
      // Complete JSON missing only its newline (crash between write and nothing
      // else) — accept it; the next append restores the invariant.
      raw += "\n";
    } else if (opts.healTail) {
      quarantineTornTail(raw, lastNewline);
      raw = raw.slice(0, lastNewline + 1);
    } else {
      throw new LedgerIntegrityError(`torn final line (${tail.length} bytes); run with healTail or CortexLedger verify`);
    }
  }

  const rows: LedgerRowBase[] = [];
  let prev: string | null = null;
  const lines = raw.split("\n").filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    let row: LedgerRowBase;
    try {
      row = JSON.parse(lines[i]) as LedgerRowBase;
    } catch {
      throw new LedgerIntegrityError(`unparseable interior row at line ${i + 1} of ${lines.length}`);
    }
    if (row.v !== LEDGER_SCHEMA_VERSION) {
      throw new LedgerIntegrityError(`row seq=${row.seq} has schema v=${row.v}; this build folds only v${LEDGER_SCHEMA_VERSION}. Schema changes are checkpoint-and-compact boundaries.`);
    }
    const { row_hash, ...sansHash } = row;
    const expected = rowHash(prev === null ? row.prev_row_hash : prev, sansHash as Record<string, unknown>);
    if (row_hash !== expected) {
      throw new LedgerIntegrityError(`hash-chain break at seq=${row.seq} (line ${i + 1})`);
    }
    if (prev !== null && rows.length > 0 && row.seq !== rows[rows.length - 1].seq + 1) {
      throw new LedgerIntegrityError(`non-monotonic seq at line ${i + 1}: ${rows[rows.length - 1].seq} → ${row.seq}`);
    }
    rows.push(row);
    prev = row_hash;
  }
  return rows;
}

/** Last row, or null. Heals a torn tail (append-path semantics). */
function lastRow(): LedgerRowBase | null {
  const rows = readRows({ healTail: true });
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

// ── Locking ──

/**
 * Hold the ledger lock for `action`. Fail-closed: lock timeout or acquisition
 * failure, and any ordinary error the action throws, come back as AppendErr.
 * An InvariantViolation is rethrown, never typed away (Code invariants rule).
 */
function withLedgerLock<T>(action: () => T): T | AppendErr {
  mkdirSync(ledgerDir(), { recursive: true });
  const res = withFileLock(lockPath(), () => {
    try {
      return { threw: false as const, value: action() };
    } catch (e: unknown) {
      if (e instanceof InvariantViolation) throw e;
      return { threw: true as const, message: (e as Error)?.message ?? String(e) };
    }
  }, { deadlineMs: 5000, staleMs: Infinity, retryMs: 25 });
  // LedgerCore's messages ("lock acquisition failed: …", "lock held past deadline: <path>")
  // with the "ledger " prefix are the exact strings Cortex returned before.
  if (res.ok === false) return { ok: false, message: `ledger ${res.message}` };
  if (res.value.threw) return { ok: false, message: `ledger action threw: ${res.value.message}` };
  return res.value.value;
}

// ── Appending ──

/** True when the file exists, is non-empty, and its last byte is not a newline. */
function lacksFinalNewline(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one event. FAIL-CLOSED: on any error the caller must abort the write
 * this event was meant to record. The row is written in ONE write() call and
 * fsync'd before the lock releases; the directory is fsync'd on first create.
 */
export function appendEvent(partial: LedgerEventInput): AppendResult {
  invariant(typeof partial.kind === "string" && partial.kind.length > 0, "ledger event requires a kind");
  invariant(!Number.isNaN(Date.parse(partial.ts)), `ledger event ts must be ISO: ${partial.ts}`);
  if (Array.isArray((partial as Record<string, unknown>).entries)) {
    invariant(((partial as Record<string, unknown>).entries as unknown[]).length <= 64, "entries[] exceeds sane cap (64)");
  }
  if (FOLDING_KINDS.has(partial.kind) && partial.kind !== "memory/redact" && partial.kind !== "checkpoint") {
    invariant(typeof (partial as Record<string, unknown>).content === "string", `folding kind ${partial.kind} requires full content`);
  }

  const res = withLedgerLock<AppendResult>(() => {
    const tail = lastRow();
    const seq = tail ? tail.seq + 1 : 1;
    const prev = tail ? tail.row_hash : "genesis";
    const sansHash: Record<string, unknown> = {
      ...partial,
      v: LEDGER_SCHEMA_VERSION,
      seq,
      id: `ev${seq}-${sha256(`${seq}:${partial.ts}:${partial.kind}`).slice(0, 8)}`,
      prev_row_hash: prev,
    };
    const row = { ...sansHash, row_hash: rowHash(prev, sansHash) } as LedgerRowBase;
    // readRows accepts a complete final row that lost only its newline; persist the separator here,
    // in the same write, or this row would be glued onto it as one unparseable line.
    const line = (lacksFinalNewline(eventsPath()) ? "\n" : "") + JSON.stringify(row) + "\n";

    const created = !existsSync(eventsPath());
    const fd = openSync(eventsPath(), "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) {
      try {
        const dirFd = openSync(dirname(eventsPath()), "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      } catch { /* dir fsync unsupported on some filesystems */ }
    }
    return { ok: true, row };
  });
  return res as AppendResult;
}

// ── Content-addressed archive (full file bytes; never trimmed) ──

/** Store content by hash; returns the hash. Best-effort by contract — the ledger row already carries content. */
export function archiveContent(content: string): string {
  const h = sha256(content);
  try {
    mkdirSync(archiveDir(), { recursive: true });
    const p = pathResolve(archiveDir(), `${h}.md`);
    if (!existsSync(p)) writeFileSync(p, content, "utf8");
  } catch { /* recoverability extra — ledger content is the durable copy */ }
  return h;
}

// ── Fold ──

export interface FoldState {
  /** root-relative file → full rendered content (pre-redact). */
  files: Map<string, string>;
  /** entry-hash → redact event id, applied at render time. */
  redacted: Map<string, string>;
  lastSeq: number;
  lastTs: string | null;
  horizonTs: string | null;
}

/**
 * Replay events into per-file content. `at` folds only events with ts <= at.
 * Throws LedgerIntegrityError on chain/schema problems; throws a plain Error
 * naming the horizon when `at` predates the earliest retained event.
 */
export function foldState(at?: string): FoldState {
  const rows = readRows();
  const state: FoldState = { files: new Map(), redacted: new Map(), lastSeq: 0, lastTs: null, horizonTs: rows.length > 0 ? rows[0].ts : null };
  if (at && rows.length > 0 && Date.parse(at) < Date.parse(rows[0].ts)) {
    throw new Error(`--at ${at} predates the retained horizon ${rows[0].ts}; earlier history lives in ${archiveDir()}`);
  }
  for (const row of rows) {
    if (at && Date.parse(row.ts) > Date.parse(at)) break;
    switch (row.kind) {
      case "memory/set":
      case "memory/restore":
      case "memory/adopt": {
        const file = rowFile(row);
        if (file !== undefined && typeof row.content === "string") {
          state.files.set(file, row.content as string);
        }
        break;
      }
      case "checkpoint": {
        const files = row.files as Record<string, string> | undefined;
        if (files) for (const [rel, content] of Object.entries(files)) state.files.set(rel, content);
        break;
      }
      case "memory/redact": {
        if (typeof row.target_entry_hash === "string") state.redacted.set(row.target_entry_hash as string, row.id);
        break;
      }
      default:
        // Audit-only kinds (memory/rejected, proposal/apply, …) never fold.
        break;
    }
    state.lastSeq = row.seq;
    state.lastTs = row.ts;
  }
  return state;
}
