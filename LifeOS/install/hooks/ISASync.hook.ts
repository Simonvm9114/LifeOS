#!/usr/bin/env bun
/**
 * @version 1.6.4
 * ISASync.hook.ts — ISA → work.json sync via PostToolUse
 *
 * TRIGGER: PostToolUse (Write, Edit, MultiEdit, Read)
 *
 * v4.1.0 (PRD → ISA rename): the per-session artifact is now ISA.md.
 * Sessions created before v4.1.0 still ship a PRD.md; this hook reads either,
 * preferring ISA.md when both exist (legacy behavior — there should never be
 * both for a single session).
 *
 * v6.9.0 (Resume After Complete): Read events on ISA files now bump
 * lastToolActivity via the slug-keyed path so reading a complete ISA
 * registers as a heartbeat for that ISA's slug. Read NEVER writes back to
 * the file — only Write/Edit/MultiEdit do.
 *
 * - Write/Edit/MultiEdit on ISA.md (or legacy PRD.md) → full sync; auto-rewind fires inside syncToWorkJson
 * - Read on ISA.md → bump lastToolActivity on the slug, rebind sessionUUID, debounced
 *
 * v1.5.0 (hook-fed phase strip): on any write whose DERIVED ascent state
 * changed for this session, emit a `<lifeos-ascent-delta>` block carrying the
 * exact response-format phase strip, computed from the same deriveAscent()
 * every dashboard surface reads. The model echoes it verbatim and never
 * computes its own — same contract as the 🧠 MEMORY and ⚙️ SYSTEM lines
 * (SystemChangeSurface: "a model-computed status line failed compliance
 * repeatedly in the 2026-05-28 experiment; never go back"). Found 2026-08-11:
 * the response strip said 🧗 Ascending while the board derived 🥾 Traverse,
 * because the strip was the last derived-state line the model self-computed.
 * No ISA write → no block → no strip: an unregistered run can no longer
 * claim a state the board doesn't show.
 *
 * v1.6.0 (herdr sidebar): the same derived state also reports `isa=<done>/<total>`
 * and `phase=<ascent label>` to the herdr workspace this pane owns, so the
 * sidebar's spaces row carries the run's progress. Every sync reports, because
 * progress moves without the phase moving. Subagents never report.
 */

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import {
  parseFrontmatter,
  syncToWorkJson,
  readRegistry,
  bumpLastToolActivityBySlug,
  ARTIFACT_FILENAME,
  LEGACY_ARTIFACT_FILENAME,
} from './lib/isa-utils';
import { setAscentTab } from './lib/tab-setter';
import { isaProgressLabel, reportHerdrMetadata } from './lib/herdr-tabs';
import { projectSessionIdentity } from './lib/session-identity';
import { deriveAscent, ascentTag } from '../LIFEOS/TOOLS/ascent';
import { isSubagentContext } from './lib/subagent';
import { lifeosPath } from './lib/paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { hookDrawn } from './lib/function-hooks';
import { randomUUID } from 'crypto';
import { invariant, InvariantViolation } from '../LIFEOS/TOOLS/Invariant';

/** Sync an ISA write to work.json; returns the hook-fed phase strip when the derived state changed. */
export async function run(input: any): Promise<string | null> {
  let strip: string | null = null;
  try { strip = await main(input); } catch (err) { console.error('[ISASync]', err); }
  let echo: string | null = null;
  try { echo = await testStrategyEcho(input); } catch { /* the echo must never break sync */ }
  return [strip, echo].filter(Boolean).join('\n') || null;
}

/**
 * Write-time echo of the Test Strategy parse (20260924-eval-intake-and-close-gate
 * ISC-7). Authors never saw their rows rejected: 28% of the estate's rows were
 * dropped at parse time and nobody was told. After an Edit/Write of an ISA, any
 * row the parser dropped or read differently from how it was written is named
 * back to the author in the same turn. Clean tables produce nothing.
 */
export async function testStrategyEcho(input: any): Promise<string | null> {
  const toolName = String(input?.tool_name || '');
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) return null;
  const filePath = String(input?.tool_input?.file_path || '');
  if (!filePath.endsWith(ARTIFACT_FILENAME) || !existsSync(filePath)) return null;
  const { parseTestStrategyDiagnostic } = await import('../LIFEOS/TOOLS/lib/IsaTestStrategy');
  const { dropped, repaired = [] } = parseTestStrategyDiagnostic(filePath);
  if (!dropped.length && !repaired.length) return null;
  const MAX = 8;
  const lines = [`Test Strategy in ${filePath.replace(process.env.HOME || '~', '~')}: ${dropped.length} row(s) dropped (never run, never counted), ${repaired.length} read differently from how they are written.`];
  for (const d of dropped.slice(0, MAX)) lines.push(`  ✗ dropped — ${d.reason}: ${d.raw.slice(0, 120)}`);
  if (dropped.length > MAX) lines.push(`  … ${dropped.length - MAX} more dropped`);
  for (const r of repaired.slice(0, MAX)) lines.push(`  ~ ${r.isc || '(no id)'} — ${r.reason}`);
  if (repaired.length > MAX) lines.push(`  … ${repaired.length - MAX} more read differently`);
  lines.push('Fix these rows in the ISA so the table says what actually runs.');
  return lines.join('\n');
}

async function main(input: any): Promise<string | null> {
  const toolInput = input.tool_input || {};
  const toolName = (input.tool_name || '') as string;
  // Trigger for ISA.md (or legacy PRD.md) anywhere — the Algorithm sanctions
  // TWO ISA homes (`MEMORY/WORK/{slug}/ISA.md` for tasks, `<project>/ISA.md`
  // for persistent things), but this hook watched only the first, so every
  // project ISA was invisible to work.json and every run surface reading it
  // (public issue #1807, @mhaisham).
  // (The per-tool-call liveness heartbeat lives in EventLogger.hook.ts, which
  // fires on every PostToolUse — one home, 2026-07-15 consolidation.)
  const filePath = toolInput.file_path || '';
  const isISA = filePath.endsWith('/' + ARTIFACT_FILENAME) || filePath.endsWith(ARTIFACT_FILENAME);
  const isLegacyPRD = filePath.endsWith('/' + LEGACY_ARTIFACT_FILENAME) || filePath.endsWith(LEGACY_ARTIFACT_FILENAME);
  if (!isISA && !isLegacyPRD) return null;
  const isWorkISA = filePath.includes('MEMORY/WORK/');

  // v6.9.0: Read trigger — bump heartbeat on the slug, rebind UUID, debounced.
  // No file write-back, no rewind. Read alone never mutates the ISA.
  if (toolName === 'Read') {
    const slugMatch = filePath.match(/MEMORY\/WORK\/([^/]+)\//);
    if (slugMatch) {
      bumpLastToolActivityBySlug(slugMatch[1], input.session_id);
      // public PR #2130, @pai-scaffolde: refresh the body hash on Read of an ISA
      if (isISA || isLegacyPRD) {
        const { refreshBodyHashBySlug } = await import('./lib/isa-utils');
        refreshBodyHashBySlug(slugMatch[1]);
      }
    }
    return null;
  }

  // Use the actual file path that was just written/edited, not findLatestISA()
  // findLatestISA() scans all artifacts by mtime and can return the wrong file
  // when multiple sessions exist or when a file's mtime is bumped by git ops.
  const isaPath = filePath;
  if (!existsSync(isaPath)) return null;

  const content = readFileSync(isaPath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm) return null;

  // The slug IS the directory name — derive it when frontmatter omits it.
  // syncToWorkJson keys the registry by fm.slug and silently no-ops without
  // one, so every minimal/hand-written ISA (sanctioned by Algorithm criterion 2)
  // was invisible to the board: tracked runs rendered as "NO ISA" sessions
  // (found 2026-07-22 — both of this session's ISAs never registered).
  if (!fm.slug) {
    if (isWorkISA) {
      const slugFromPath = filePath.match(/MEMORY\/WORK\/([^/]+)\//);
      if (slugFromPath) fm.slug = slugFromPath[1];
    } else {
      // Project ISA (<project>/ISA.md): the slug is the project directory name,
      // prefixed to avoid colliding with a same-named WORK slug
      // (public issue #1807, @mhaisham).
      const dirMatch = filePath.match(/([^/]+)\/[^/]+$/);
      if (dirMatch) fm.slug = 'project-' + dirMatch[1].toLowerCase();
    }
  }

  // Check existing phase before sync to detect phase changes
  const newPhase = (fm.phase || '').toUpperCase();
  let oldPhase = '';
  if (fm.slug) {
    try {
      const registry = readRegistry();
      const existing = registry.sessions[fm.slug];
      if (existing) oldPhase = (existing.phase || '').toUpperCase();
    } catch { /* silent */ }
  }

  // Sync frontmatter + criteria to work.json (pass session_id for session name lookup)
  syncToWorkJson(fm, isaPath, content, input.session_id);

  // The row's sessionName (frontmatter task/title/H1) is the session's name
  // now. Push it into session-names.json + the tab label so the status line
  // and the kitty tab show the ISA's name, not the first prompt's (2026-09-11:
  // every ISA session's status line was stuck on its first-prompt name).
  if (input.session_id) {
    try { projectSessionIdentity(input.session_id, { source: 'ISASync' }); }
    catch (err) { console.error('[ISASync] projectSessionIdentity failed:', err); }
  }

  // Derive the run's state ONCE from what was just written — the same
  // deriveAscent() the board reads — and reuse it for the tab and the strip,
  // so the two cannot disagree by construction.
  const [doneStr, totalStr] = String(fm.progress || '0/0').split('/');
  const done = parseInt(doneStr, 10) || 0;
  const total = parseInt(totalStr, 10) || 0;
  const state = deriveAscent({
    phase: newPhase,
    tracked: true,
    active: true,
    done,
    total,
  });

  // Herdr's spaces rows render `$isa $phase $project`, and an unreported token
  // simply doesn't draw — so the sidebar only shows this run's progress if we
  // send it. Fires on EVERY sync, not only on a phase change: progress moving
  // 3/7 → 4/7 is the number the row exists to show. The phase comes off the one
  // ASCENT table through the state derived above, never a hand-listed name, so
  // the row and the board cannot disagree. No ttl: syncs are sporadic and an
  // expiring token would blank the row mid-run; the tokens die with the space.
  if (!isSubagentContext(input)) {
    try {
      reportHerdrMetadata('workspace', {
        // A bare `0/24` read as noise in the sidebar (2026-09-18); the unit says what is counted.
        // A finished run says so: `✓ 11/11` reads as a result, `11/11` as a count (2026-10-13).
        // Since 2026-10-15 a bar carries the share and the word goes: `▰▰▰▰▰▰▰▱ 133/144`.
        isa: isaProgressLabel(done, total),
        phase: ascentTag(state).label.toLowerCase(),
      });
    } catch (err) {
      console.error('[ISASync] herdr report failed:', err);
    }
  }

  // Repaint the tab when the run's declared phase changes.
  //
  // The old gate was an explicit phase allowlist that had to be extended by hand
  // every time the vocabulary moved — and wasn't, twice (2026-07-22, 2026-07-27),
  // so tab colors silently stopped firing mid-run. `deriveAscent` resolves any
  // phase value, current or retired, through the one table; an unknown value
  // falls back to a real state instead of being dropped on the floor.
  //
  // A derived-state change repaints too. Progress reaching n/n turns the run to 🪨 Cairn
  // with no phase edit, and the phase gate alone left the herdr row showing 🧗 on an
  // 11/11 run whose phase token said cairn (2026-10-13). One file per session records the
  // state last painted, so an unchanged state never repaints.
  const sid = String(input.session_id || '').replace(/[^\w-]/g, '');
  const paintedFile = sid ? lifeosPath('MEMORY', 'STATE', 'ascent-tab', `${sid}.txt`) : '';
  let painted = '';
  if (paintedFile && existsSync(paintedFile)) {
    try { painted = readFileSync(paintedFile, 'utf-8').trim(); } catch { /* unreadable = unpainted */ }
  }
  if (sid && (newPhase !== oldPhase || painted !== state)) {
    try {
      setAscentTab(state, input.session_id);
      const { mkdirSync, writeFileSync } = require('fs');
      mkdirSync(lifeosPath('MEMORY', 'STATE', 'ascent-tab'), { recursive: true });
      writeFileSync(paintedFile, state);
    } catch (err) {
      console.error('[ISASync] setAscentTab failed:', err);
    }
  }

  // v1.5.0: hook-fed phase strip (see header). Fires once per DERIVED-state
  // transition — not per phase change, so progress reaching n/n emits 🪨 Cairn
  // without a phase edit. Per-session dedupe file; subagents never emit (their
  // ISA edits would strip-spam their own contexts, which helps nobody).
  let stripDelta: string | null = null;
  // Pass the parsed payload: a fork's env is its parent's, only the stdin stamp
  // names it (public PR #1958, @theNetworkChuck).
  // When the LifeOSHooks plugin stamped this session it pins the strip as a
  // status line from the same derivation (HookBridge isa-state); no echo block.
  if (input.session_id && fm.slug && !isSubagentContext(input) && !hookDrawn(input.session_id)) {
    try {
      const stripDir = lifeosPath('MEMORY', 'STATE', 'ascent-strip');
      const stripFile = join(stripDir, `${String(input.session_id).replace(/[^\w-]/g, '')}.json`);
      let prev: { slug?: string; state?: string } = {};
      if (existsSync(stripFile)) {
        try { prev = JSON.parse(readFileSync(stripFile, 'utf-8')); } catch { /* corrupt = no prior */ }
      }
      if (prev.slug !== fm.slug || prev.state !== state) {
        const { mkdirSync, writeFileSync } = require('fs');
        mkdirSync(stripDir, { recursive: true });
        writeFileSync(stripFile, JSON.stringify({ slug: fm.slug, state, at: new Date().toISOString() }));
        const tag = ascentTag(state);
        stripDelta = [
          '<lifeos-ascent-delta>',
          "The run's derived ascent state changed (computed by ISASync through the same deriveAscent() every dashboard surface reads). Lead the next visible status note with this phase strip VERBATIM, exactly once. Never compute a strip yourself:",
          `════ LifeOS | Algorithm | ${tag.icon} ${tag.label} ════`,
          '</lifeos-ascent-delta>',
        ].join('\n');
      }
    } catch { /* the strip is decoration — it must never break sync */ }
  }

  // ─────────── HTML Mirror trigger 1 (v6.5.0 ISA HTML Mirror) ───────────
  // Fire ISARender ONLY on transition to `complete`. Per-phase changes during
  // active work do NOT fire renders — user-stated constraint:
  //   "lots of phase changes as it's being written; we don't want to be
  //    constantly remaking the HTML file."
  if (newPhase === 'COMPLETE' && oldPhase !== 'COMPLETE' && fm.slug) {
    try {
      const isaRender = lifeosPath('TOOLS', 'ISARender.ts');
      const proc = spawn('bun', [isaRender, isaPath], { windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
    } catch (err) {
      console.error('[ISASync] ISARender spawn failed:', err);
    }
  }

  // ─────────── HTML Mirror trigger 2 — session state tracking ───────────
  // Record this edit so ISARenderOnStop.hook.ts can decide whether to render
  // at end-of-turn. The Stop hook gates on ISA.html already existing, so
  // pre-completion edits never trigger renders even though they show up here.
  if (input.session_id) {
    const queued = queueRenderEdit(input.session_id, isaPath);
    if (!queued.ok && queued.reason !== 'bad-session-id') console.error(`[ISASync] render queue not written: ${queued.reason}`);
  }

  return stripDelta;
}

/** Same token shape ISARenderOnStop.claimQueue accepts; anything else never becomes a path. */
const RENDER_QUEUE_SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type RenderQueueResult = { ok: true; file: string } | { ok: false; reason: string };

/**
 * Record an ISA edit in this session's render queue (read by ISARenderOnStop).
 * The session id must be a plain token, the queue directory must resolve to
 * itself under the real STATE directory (no symlinked hop out), an existing
 * queue file must be a regular file inside it, and the write lands through an
 * exclusive temp file plus an atomic rename, so a planted symlink is replaced
 * rather than followed.
 */
export function queueRenderEdit(
  sessionId: unknown,
  isaPath: string,
  stateDir: string = lifeosPath('MEMORY', 'STATE', 'isa-render-debounce'),
): RenderQueueResult {
  if (typeof sessionId !== 'string' || !RENDER_QUEUE_SESSION_RE.test(sessionId)) return { ok: false, reason: 'bad-session-id' };
  const { mkdirSync, writeFileSync, renameSync, realpathSync, lstatSync, unlinkSync } = require('fs') as typeof import('fs');
  const { dirname, basename, sep } = require('path') as typeof import('path');
  try {
    mkdirSync(stateDir, { recursive: true });
    const realParent = realpathSync(dirname(stateDir));
    const realDir = realpathSync(stateDir);
    if (realDir !== join(realParent, basename(stateDir))) return { ok: false, reason: 'state-dir-escapes' };
    const stateFile = join(realDir, `${sessionId}.json`);
    invariant(dirname(stateFile) === realDir && !stateFile.slice(realDir.length + 1).includes(sep), 'render queue file must sit directly in the real state dir');
    let edited: string[] = [];
    let st: import('fs').Stats | null = null;
    try { st = lstatSync(stateFile); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    if (st) {
      if (!st.isFile()) return { ok: false, reason: 'queue-file-not-regular' };
      try {
        const prior = JSON.parse(readFileSync(stateFile, 'utf-8')).edited_isas;
        if (Array.isArray(prior)) edited = prior.filter((e: unknown): e is string => typeof e === 'string');
      } catch { /* corrupt queue = start fresh */ }
    }
    if (!edited.includes(isaPath)) edited.push(isaPath);
    const tmp = join(realDir, `.${sessionId}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ session_id: sessionId, edited_isas: edited, updated: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    try { renameSync(tmp, stateFile); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
    return { ok: true, file: stateFile };
  } catch (err) {
    if (err instanceof InvariantViolation) throw err;
    return { ok: false, reason: `io:${(err as NodeJS.ErrnoException)?.code || 'error'}` };
  }
}

if (import.meta.main) {
  let input: any = null;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  const additionalContext = await run(input);
  if (additionalContext) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }));
  process.exit(0);
}
