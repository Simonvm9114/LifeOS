#!/usr/bin/env bun
/**
 * @version 1.2.0
 * ISARenderOnStop.hook.ts — Re-render edited ISAs at end-of-turn.
 *
 * TRIGGER: Stop event (assistant's turn ends).
 *
 * Reads the per-session state file written by ISASync.hook.ts at every ISA
 * Edit/Write. For each ISA edited this turn, spawns ISARender.ts ONLY IF the
 * sibling ISA.html already exists — i.e., the ISA has reached `phase: complete`
 * at least once before. Pre-completion edits never fire renders here — this is
 * the doctrinal gate that prevents "constant remaking" during active authoring.
 *
 * State file: ~/.claude/LIFEOS/MEMORY/STATE/isa-render-debounce/<session_id>.json
 * Claimed by an atomic rename, then removed, at each Stop fire.
 *
 * Trust (hooks audit shard ad #4, #5, #15): the session id must be a plain id and
 * the state file must resolve inside the state dir, so neither the read nor the
 * unlink can reach another path. Queue entries are data: each must be an absolute
 * ISA path (ISA.md or *.isa.md) whose realpath is still an ISA file inside the
 * user's home tree (task ISAs under MEMORY/WORK and project ISAs both live there);
 * duplicates collapse to one render and at most MAX_RENDERS run per Stop.
 * Two concurrent Stops cannot both render one queue: the first rename wins.
 *
 * Hook MUST NOT block Stop longer than ~100ms. Renders are spawned detached
 * and never awaited.
 */

import { readFileSync, existsSync, unlinkSync, realpathSync, renameSync, statSync, appendFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname, isAbsolute, sep } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { lifeosPath } from './lib/paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { isIsaPath } from './lib/isa-utils';

const STATE_DIR = lifeosPath('MEMORY', 'STATE', 'isa-render-debounce');
const ISA_RENDER = lifeosPath('TOOLS', 'ISARender.ts');
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_RENDERS = 20;

/**
 * Has this ISA reached completion at least once? This is the real gate the
 * `ISA.html`-exists check was only a proxy for. It is true for a resumed ISA
 * (iteration > 1 / resumed_from_phase) or a currently-complete one — which
 * fixes the hole where an ISA completed before the mirror convention (or
 * resumed into a new iteration) never got a mirror because no html existed yet.
 * A brand-new iteration-1 ISA still in first authoring returns false, so the
 * "don't remake during active authoring" guard is preserved exactly.
 * Reads only the frontmatter block; runs solely on the cold path (html missing).
 */
function hasReachedCompletion(isaPath: string): boolean {
  try {
    const fm = (readFileSync(isaPath, 'utf-8').match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
    if (/^phase:\s*complete\b/mi.test(fm)) return true;
    const iter = fm.match(/^iteration:\s*(\d+)/mi);
    if (iter && parseInt(iter[1], 10) > 1) return true;
    if (/^resumed_from_phase:\s*\S/mi.test(fm)) return true;
    return false;
  } catch {
    return false;
  }
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Atomically take this session's render queue. Returns the entries, or null when
 * there is nothing to take: a bad session id, no queue, a queue file that resolves
 * outside the state dir, or another Stop that already claimed it.
 */
export function claimQueue(sessionId: unknown, stateDir = STATE_DIR): unknown[] | null {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  const stateFile = join(stateDir, `${sessionId}.json`);
  if (!existsSync(stateFile)) return null;
  let realDir: string;
  try {
    realDir = realpathSync(stateDir);
    const realFile = realpathSync(stateFile);
    if (!within(realFile, realDir) || realFile === realDir || !statSync(realFile).isFile()) return null;
  } catch {
    return null;
  }
  const claimed = join(realDir, `${sessionId}.json.${process.pid}.${randomUUID()}.claim`);
  try {
    renameSync(stateFile, claimed); // rename moves the link itself; containment was checked above
  } catch {
    return null; // a concurrent Stop took it first
  }
  try {
    const parsed = JSON.parse(readFileSync(claimed, 'utf-8'));
    return Array.isArray(parsed?.edited_isas) ? parsed.edited_isas : [];
  } catch {
    return [];
  } finally {
    try { unlinkSync(claimed); } catch {}
  }
}

/** Queue entries that are safe to hand to ISARender: real ISA files in the home tree, deduped, capped. */
export function renderableEntries(entries: unknown[], home = homedir()): { targets: string[]; rejected: string[] } {
  const targets: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  let realHome: string;
  try { realHome = realpathSync(home); } catch { realHome = home; }
  for (const entry of entries) {
    if (typeof entry !== 'string' || !isAbsolute(entry) || !isIsaPath(entry)) { rejected.push(`${String(entry).slice(0, 200)}:not-isa`); continue; }
    let real: string;
    try {
      real = realpathSync(entry);
      if (!statSync(real).isFile()) throw new Error('not a file');
    } catch {
      rejected.push(`${entry}:missing`);
      continue;
    }
    if (!isIsaPath(real) || !within(real, realHome)) { rejected.push(`${entry}:outside`); continue; }
    if (seen.has(real)) continue;
    if (targets.length >= MAX_RENDERS) { rejected.push(`${entry}:over-cap`); continue; }
    seen.add(real);
    targets.push(real);
  }
  return { targets, rejected };
}

function main(): void {
  let input: any;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return;
  }
  const sessionId = input?.session_id;
  const queue = claimQueue(sessionId);
  if (!queue) return;

  const { targets, rejected } = renderableEntries(queue);
  const rendered: string[] = [];
  const skipped: string[] = [...rejected];

  for (const isaPath of targets) {
    const htmlPath = join(dirname(isaPath), 'ISA.html');
    // Doctrinal gate: only render once the ISA has been completed at least once.
    // Fast path: an existing ISA.html proves prior completion. Cold path: no html
    // yet, so check the frontmatter directly — catches resumed / pre-convention
    // ISAs the html-exists proxy used to miss. First-authoring ISAs still skip.
    if (!existsSync(htmlPath) && !hasReachedCompletion(isaPath)) {
      skipped.push(`${isaPath}:pre-completion`);
      continue;
    }
    try {
      const proc = spawn('bun', [ISA_RENDER, isaPath], { windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
      rendered.push(isaPath);
    } catch {
      skipped.push(`${isaPath}:spawn-failed`);
    }
  }

  // Log to observability (best-effort, non-blocking).
  if (rendered.length || skipped.length) {
    try {
      const logDir = lifeosPath('MEMORY', 'OBSERVABILITY');
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, 'isa-render.jsonl'),
        JSON.stringify({
          ts: new Date().toISOString(),
          session_id: sessionId,
          rendered,
          skipped,
        }) + '\n');
    } catch {}
  }
}

if (import.meta.main) {
  try { main(); } catch {}
  console.log(JSON.stringify({ continue: true }));
  process.exit(0);
}
