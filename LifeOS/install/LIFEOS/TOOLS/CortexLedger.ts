#!/usr/bin/env bun
/**
 * @version 1.1.1
 * CortexLedger — CLI over the hot-layer memory event ledger.
 *
 *   bun CortexLedger.ts status                 — rows, kinds, head per file, horizon
 *   bun CortexLedger.ts genesis                — anchor: checkpoint current live bytes (refuses if events exist)
 *   bun CortexLedger.ts verify [--json]        — fold vs live files; entries drift = CRITICAL (exit 2), byte-only drift = warn (exit 1)
 *   bun CortexLedger.ts adopt [--force]        — record live edits (rename sweep, hand edit) as memory/adopt events; the drift remedy
 *   bun CortexLedger.ts fold [--at ISO] [--heal] — render from events; --heal rebuilds a missing/corrupt live file (erases any live edit)
 *   bun CortexLedger.ts checkpoint             — append full-state checkpoint (compaction anchor)
 *   bun CortexLedger.ts compact                — archive rows before the last checkpoint
 *   bun CortexLedger.ts redact <entry-hash>    — append a fold-honored tombstone (physical-rewrite runbook: see MemorySystem.md)
 *   bun CortexLedger.ts provenance             — write LEDGER/provenance/<base>.map.json (entry-hash → first admitting event)
 *
 * Verification semantics (the normalization contract, Max finding 3):
 *   - The ENTRIES region is the fold-owned region: parse both sides with THE
 *     shared parser and compare entry sets — mismatch is CRITICAL drift.
 *   - Full-byte mismatch with equal entries is warn-level: out-of-band
 *     frontmatter writers (release version bumper) are legal and get folded
 *     into the ledger at the next memory/set, which snapshots the live file's
 *     frontmatter into its content.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import {
  appendEvent,
  archiveDir,
  entriesHash,
  eventsPath,
  foldState,
  ledgerDir,
  readRows,
  rowFile,
  sha256,
  LedgerIntegrityError,
} from "./lib/CortexLedgerCore";
import { getClaudeDir } from "./Paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep
import { adoptLive, parseMemoryContent, serializeMemoryContent, atomicWriteContent } from "./MemoryWriter";
import { replayParked } from "./ParkedReplay";

const ROOT = process.env.CORTEX_LEDGER_ROOT || getClaudeDir();

/** The fold-owned files, root-relative. The ONLY files this system projects. */
export const FOLD_OWNED = [
  "LIFEOS/USER/PRINCIPAL/PRINCIPAL_MEMORY.md",
  "LIFEOS/USER/DIGITAL_ASSISTANT/DA_MEMORY.md",
];

function liveAbs(rel: string): string {
  return pathResolve(ROOT, rel);
}

/** Render one file's final content from fold state: head content minus redacted entries. */
function renderFile(rel: string, state: ReturnType<typeof foldState>): string | null {
  const content = state.files.get(rel);
  if (content === undefined) return null;
  if (state.redacted.size === 0) return content;
  const parsed = parseMemoryContent(content);
  const kept = parsed.entries.filter((e) => !state.redacted.has(sha256(e)));
  if (kept.length === parsed.entries.length) return content;
  return serializeMemoryContent(parsed, kept, "CortexLedger.fold", state.lastTs ?? undefined);
}

interface VerifyFileReport {
  file: string;
  status: "ok" | "byte-drift" | "entries-drift" | "no-events" | "file-missing";
  detail?: string;
}

/**
 * "unverified" is a blocking result: the ledger has no events, so nothing was
 * checked. It is never "ok" (verifying zero evidence proves nothing). A file with
 * no anchoring event once other events exist is CRITICAL for the same reason.
 */
export function verifyAll(): { status: "ok" | "warn" | "critical" | "unverified"; files: VerifyFileReport[]; rows: number } {
  let rows;
  try {
    rows = readRows();
  } catch (e) {
    if (e instanceof LedgerIntegrityError) {
      return { status: "critical", files: [{ file: "(ledger)", status: "entries-drift", detail: e.message }], rows: -1 };
    }
    throw e;
  }
  if (rows.length === 0) {
    return {
      status: "unverified",
      files: FOLD_OWNED.map((f) => ({ file: f, status: "no-events" as const, detail: "no ledger events; run `CortexLedger.ts genesis` to anchor" })),
      rows: 0,
    };
  }
  const state = foldState();
  const reports: VerifyFileReport[] = [];
  for (const rel of FOLD_OWNED) {
    const folded = renderFile(rel, state);
    if (folded === null) {
      reports.push({ file: rel, status: "no-events", detail: "no ledger event anchors this file; it cannot be verified" });
      continue;
    }
    const abs = liveAbs(rel);
    if (!existsSync(abs)) {
      reports.push({ file: rel, status: "file-missing", detail: "live file absent; `fold --heal` reconstructs it" });
      continue;
    }
    const live = readFileSync(abs, "utf8");
    const liveEntries = parseMemoryContent(live).entries;
    const foldedEntries = parseMemoryContent(folded).entries;
    if (entriesHash(liveEntries) !== entriesHash(foldedEntries)) {
      reports.push({
        file: rel,
        status: "entries-drift",
        detail: `live has ${liveEntries.length} entries, fold has ${foldedEntries.length}; an out-of-band edit changed the entries — \`CortexLedger.ts adopt\` records it`,
      });
    } else if (live !== folded) {
      reports.push({ file: rel, status: "byte-drift", detail: "entries equal; non-entry bytes differ (out-of-band frontmatter/body edit — folds in at next curation write)" });
    } else {
      reports.push({ file: rel, status: "ok" });
    }
  }
  const status = reports.some((r) => r.status === "entries-drift" || r.status === "file-missing" || r.status === "no-events")
    ? "critical"
    : reports.some((r) => r.status === "byte-drift")
      ? "warn"
      : "ok";
  return { status, files: reports, rows: rows.length };
}

function cmdStatus(): number {
  const rows = readRows();
  const byKind = new Map<string, number>();
  for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  console.log(JSON.stringify({
    ledger: eventsPath(),
    rows: rows.length,
    kinds: Object.fromEntries(byKind),
    horizon: rows[0]?.ts ?? null,
    head_seq: rows[rows.length - 1]?.seq ?? 0,
  }, null, 2));
  return 0;
}

function cmdGenesis(): number {
  if (readRows().length > 0) {
    console.error("genesis refused: ledger already has events (genesis is only the FIRST anchor)");
    return 1;
  }
  const files: Record<string, string> = {};
  for (const rel of FOLD_OWNED) {
    const abs = liveAbs(rel);
    if (!existsSync(abs)) {
      console.error(`genesis refused: live file missing: ${abs}`);
      return 1;
    }
    files[rel] = readFileSync(abs, "utf8");
  }
  const res = appendEvent({ kind: "checkpoint", ts: new Date().toISOString(), updated_by: "CortexLedger.genesis", files });
  if (!res.ok) {
    console.error(`genesis append failed: ${res.message}`);
    return 1;
  }
  console.log(`genesis checkpoint appended (seq=${res.row.seq}) covering ${Object.keys(files).length} files`);
  return 0;
}

function cmdVerify(json: boolean): number {
  const report = verifyAll();
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`ledger verify: ${report.status.toUpperCase()} (${report.rows} rows)`);
    for (const f of report.files) console.log(`  ${f.file}: ${f.status}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  return report.status === "ok" ? 0 : report.status === "warn" ? 1 : report.status === "unverified" ? 3 : 2;
}

/** Adopt every drifted fold-owned file. Exit 0 adopted or clean, 1 refused or failed. */
function cmdAdopt(force: boolean): number {
  let code = 0;
  for (const rel of FOLD_OWNED) {
    const r = adoptLive(liveAbs(rel), { updatedBy: "CortexLedger.adopt", force });
    if (!r.ok) {
      console.error(`  ${rel}: ${r.code} — ${r.message}`);
      for (const e of r.lost ?? []) console.error(`    would drop: ${e}`);
      code = 1;
    } else if (!r.adopted) {
      console.log(`  ${rel}: matches the ledger, nothing to adopt`);
    } else {
      console.log(`  ${rel}: adopted (seq=${r.seq}, ${r.committed ? "committed" : "uncommitted"}, +${r.gained.length} −${r.lost.length})`);
      for (const e of r.lost) console.log(`    dropped: ${e}`);
    }
  }
  if (code === 0) {
    // Reviewer writes refused while the files drifted are replayed now that they agree.
    const rep = replayParked({});
    if (rep.applied.length > 0) console.log(`  replayed ${rep.applied.length} parked reviewer item(s), +${rep.added} entr${rep.added === 1 ? "y" : "ies"}`);
  }
  return code;
}

function cmdFold(at: string | undefined, heal: boolean): number {
  const state = foldState(at);
  if (state.files.size === 0) {
    console.error("fold: no folding events in range");
    return 1;
  }
  for (const rel of FOLD_OWNED) {
    const rendered = renderFile(rel, state);
    if (rendered === null) { console.log(`  ${rel}: no events`); continue; }
    const n = parseMemoryContent(rendered).entries.length;
    if (heal) {
      const w = atomicWriteContent(liveAbs(rel), rendered);
      if (w !== true) { console.error(`  ${rel}: heal write failed — ${w.message}`); return 1; }
      console.log(`  ${rel}: healed to seq=${state.lastSeq} (${n} entries)`);
    } else {
      const abs = liveAbs(rel);
      const match = existsSync(abs) && readFileSync(abs, "utf8") === rendered;
      console.log(`  ${rel}: fold=${n} entries @ seq=${state.lastSeq}${at ? ` (at ${at})` : ""} — ${match ? "matches live" : "DIFFERS from live"}`);
    }
  }
  return 0;
}

function cmdCheckpoint(): number {
  const state = foldState();
  if (state.files.size === 0) { console.error("checkpoint refused: no folding events (run genesis first)"); return 1; }
  const files: Record<string, string> = {};
  for (const rel of FOLD_OWNED) {
    const rendered = renderFile(rel, state);
    if (rendered !== null) files[rel] = rendered;
  }
  const res = appendEvent({ kind: "checkpoint", ts: new Date().toISOString(), updated_by: "CortexLedger.checkpoint", files });
  if (!res.ok) { console.error(`checkpoint append failed: ${res.message}`); return 1; }
  console.log(`checkpoint appended (seq=${res.row.seq})`);
  return 0;
}

function cmdCompact(): number {
  const rows = readRows();
  let lastCheckpointIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === "checkpoint") { lastCheckpointIdx = i; break; }
  }
  if (lastCheckpointIdx <= 0) { console.log("compact: nothing to archive (no checkpoint past row 1)"); return 0; }
  const archived = rows.slice(0, lastCheckpointIdx);
  const kept = rows.slice(lastCheckpointIdx);
  mkdirSync(archiveDir(), { recursive: true });
  const archivePath = pathResolve(archiveDir(), `events-${archived[0].seq}-${archived[archived.length - 1].seq}.jsonl`);
  writeFileSync(archivePath, archived.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const w = atomicWriteContent(eventsPath(), kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (w !== true) { console.error(`compact rewrite failed: ${w.message}`); return 1; }
  console.log(`compacted: ${archived.length} rows → ${archivePath}; ${kept.length} rows retained (anchor seq=${kept[0].seq})`);
  return 0;
}

function cmdRedact(entryHash: string): number {
  if (!/^[0-9a-f]{64}$/.test(entryHash)) {
    console.error("redact requires a sha256 entry hash (64 hex chars). Compute: sha256 of the exact entry line.");
    return 1;
  }
  const res = appendEvent({ kind: "memory/redact", ts: new Date().toISOString(), updated_by: "CortexLedger.redact", target_entry_hash: entryHash });
  if (!res.ok) { console.error(`redact append failed: ${res.message}`); return 1; }
  console.log(`redact tombstone appended (seq=${res.row.seq}). Run \`fold --heal\` to apply to live files; physical-rewrite runbook covers archives.`);
  return 0;
}

function cmdProvenance(): number {
  const rows = readRows();
  const state = foldState();
  const dir = pathResolve(ledgerDir(), "provenance");
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const rel of FOLD_OWNED) {
    const rendered = renderFile(rel, state);
    if (rendered === null) continue;
    const entries = parseMemoryContent(rendered).entries;
    const map: Record<string, { event_id: string; ts: string; session_id?: string; run_id?: string }> = {};
    for (const entry of entries) {
      for (const row of rows) {
        if (row.kind !== "memory/set" || rowFile(row) !== rel) continue;
        const additions = (row.additions as string[] | undefined) ?? [];
        const all = (row.entries as string[] | undefined) ?? [];
        if (additions.includes(entry) || (all.includes(entry) && !(entry in map))) {
          map[sha256(entry)] = { event_id: row.id, ts: row.ts, ...(row.session_id ? { session_id: row.session_id as string } : {}), ...(row.run_id ? { run_id: row.run_id as string } : {}) };
          if (additions.includes(entry)) break; // FIRST admitting event wins (design: re-introductions get their own rows)
        }
      }
    }
    const base = rel.split("/").pop()!.replace(/\.md$/, "");
    writeFileSync(pathResolve(dir, `${base}.map.json`), JSON.stringify({ generated: new Date().toISOString(), file: rel, entries: map }, null, 2) + "\n", "utf8");
    written++;
  }
  console.log(`provenance maps written: ${written} → ${dir}`);
  return 0;
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flag = (name: string) => args.includes(name);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    switch (cmd) {
      case "status": process.exit(cmdStatus());
      case "genesis": process.exit(cmdGenesis());
      case "verify": process.exit(cmdVerify(flag("--json")));
      case "adopt": process.exit(cmdAdopt(flag("--force")));
      case "fold": process.exit(cmdFold(opt("--at"), flag("--heal")));
      case "checkpoint": process.exit(cmdCheckpoint());
      case "compact": process.exit(cmdCompact());
      case "redact": process.exit(cmdRedact(args[1] ?? ""));
      case "provenance": process.exit(cmdProvenance());
      default:
        console.error("Usage: bun CortexLedger.ts {status|genesis|verify [--json]|adopt [--force]|fold [--at ISO] [--heal]|checkpoint|compact|redact <hash>|provenance}");
        process.exit(2);
    }
  } catch (e) {
    if (e instanceof LedgerIntegrityError) {
      console.error(`LEDGER INTEGRITY: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

if (import.meta.main) main();
