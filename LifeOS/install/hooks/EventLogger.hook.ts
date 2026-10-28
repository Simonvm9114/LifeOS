#!/usr/bin/env bun
/**
 * @version 1.2.0
 * 1.2.0 (2026-10-25, STATVS ISA F16 step 1, dual-write): the record gets one `skill-run` row per Skill call (skill,
 *   intent when the args name one of the skill's intent files, session, the run line's run_id, an args digest) and one
 *   `tool-run` row per Bash call that runs a LifeOS tool with bun (a .ts under skills/<S>/Tools/ or LIFEOS/TOOLS/), with
 *   the exit code and the harness's duration_ms, on success (PostToolUse) and failure (PostToolUseFailure). Both go
 *   through LIFEOS/STATVS/lib/quality.ts, imported only when a call qualifies, so every other tool call pays one string
 *   test; execution.jsonl and tool-activity.jsonl keep writing exactly as before, and a record fault is logged and never
 *   fails the hook.
 * 1.1.1 (2026-10-14): the skill run line is appended through
 *   appendPrivateRecord (0600 file, owner-only directory, existing ones tightened), and its arguments
 *   are redacted and cut to SKILL_ARGS_KEEP characters.
 * EventLogger.hook.ts - Unified observability event logger
 *
 * Consolidation (2026-07-10, the principal's hook consolidation): merges FIVE
 * behavior-preserving append-JSONL loggers into one dispatcher keyed on
 * `hook_event_name`. None of these emit model-context output — they only
 * append structured events and (for PostToolUse) bump the ISA heartbeat.
 *
 * 2026-09-30: the Skill branch writes THE run line —
 * session_id, turn, run_id, parent_run_id beside the original fields.
 * SkillInvocationLog (second writer, invocations.jsonl) is retired.
 *
 * Merged sources (each logic block preserved byte-for-behavior):
 *   1. ToolActivityTracker.hook.ts  → PostToolUse (all tools). Ground-truth
 *      audit → MEMORY/OBSERVABILITY/tool-activity.jsonl + ISA heartbeat bump.
 *   2. SkillExecutionLog.hook.ts    → PostToolUse (Skill only). Additional
 *      write → MEMORY/SKILLS/execution.jsonl. Runs IN ADDITION to (1) — both
 *      files are written on a Skill PostToolUse; downstream reads execution.jsonl.
 *   3. ToolFailureTracker.hook.ts   → PostToolUseFailure →
 *      MEMORY/OBSERVABILITY/tool-failures.jsonl.
 *   4. StopFailureHandler.hook.ts   → StopFailure →
 *      MEMORY/SECURITY/<YYYY>/<MM>/stop-failures-<YYYY-MM-DD>.jsonl (log-only).
 *   5. ConfigAudit.hook.ts          → ConfigChange →
 *      MEMORY/OBSERVABILITY/config-changes.jsonl.
 *
 * 2026-10-09 (intent anatomy, ISA 20261009-intent-ideal-state ISC-6): PostToolUse
 * also runs the intent voice (lib/intent-voice.ts). A main-session Read of
 * skills/<Skill>/Intents/<Intent>.md during that skill's execution says "Running
 * the <Intent> intent in the <Skill> skill" once, replacing the per-intent curl
 * blocks. The POST is awaited under a short timeout before exit; this hook is
 * registered async on PostToolUse, so the wait never holds the tool.
 *
 * DISPATCH:
 *   PostToolUse        → tool-activity ALWAYS, + skill-execution when tool==Skill,
 *                        + intent voice when tool==Read of an intent file
 *   PostToolUseFailure → tool-failure
 *   StopFailure        → stop-failure
 *   ConfigChange       → config-audit
 *
 * ONE IMPROVEMENT over the pre-merge behavior: ConfigAudit's settings snapshot
 * moved from volatile /tmp/pai-settings-snapshot.json to
 * MEMORY/STATE/pai-settings-snapshot.json so the diff baseline survives reboots
 * (previously it lost its baseline on every restart, forcing an "initial
 * snapshot" no-diff on the first ConfigChange after boot).
 *
 * SECRETS (GHSA-8qfr-7fpx-68x9, @godagoo): every captured string is redacted
 * before it is truncated, the settings snapshot stores env values as sha256
 * hashes, and every file written here is 0600 — see lib/event-capture.ts.
 *
 * Every event path is registered to this ONE file (matcher * for PostToolUse
 * subsumes the former Skill-matcher entry). Fail-open throughout: any error is
 * logged to stderr and the process exits 0 so a logging fault never blocks a turn.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { lifeosPath, getSettingsPath, getSkillsDir } from './lib/paths';
import { redactLabelled } from './lib/label-redact';
import { appendPrivateLine, appendPrivateRecord, capture, captureGroundTruth, diffSettings, previewJson } from './lib/event-capture';
import { resolveBun } from './lib/resolve-bin';
import { getISOTimestamp, getPSTDate, getYearMonth } from './lib/time';
import { invariant } from '../LIFEOS/TOOLS/Invariant';
import { PULSE_BASE } from '../LIFEOS/PULSE/endpoint';
import { maybeAnnounceIntent, postIntentVoice } from './lib/intent-voice';
import { isDesktopChannel, logSkippedVoice } from './lib/notification-channel';
import { readPick } from './lib/router-pick';
import { bumpLastToolActivity, bumpLastToolActivityByUUID } from './lib/isa-utils';
import {
  buildExecutionLine,
  extractSkillArgs,
  extractSkillName,
  isoZTimestamp,
} from './lib/skill-notify-core';

// ── Shared stdin reader (identical 2s-timeout pattern used by all five) ──────
// 10MB cap: a fast/continuous stream could buffer multi-GB inside the 2s window
// (public issue #1533, @christauff). Over the cap → settle with what we have;
// that one oversized event is truncated, consistent with fail-open behavior.
const STDIN_CAP_BYTES = 10_000_000;
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.pause(); } catch { /* already closed */ }
      resolve(data);
    };
    const timer = setTimeout(finish, 2000);
    process.stdin.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > STDIN_CAP_BYTES) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// ═════════════════════════════════════════════════════════════════════════
// 1 + 2. PostToolUse: ToolActivityTracker (always) + SkillExecutionLog (Skill)
// ═════════════════════════════════════════════════════════════════════════

interface ToolUseInput {
  session_id: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  /** Tool execution time in milliseconds (harness field; excludes permission-prompt and hook time). */
  duration_ms?: number;
  // Present ONLY when the call originates from a subagent; absent in the main
  // session. The only signal distinguishing delegated work from the operator's
  // own session (session_id/transcript_path/cwd are byte-identical between the
  // two), so dropping them destroys attribution (public issue #1806, @xmasyx).
  agent_id?: string;
  agent_type?: string;
}

const OBS_DIR = lifeosPath('MEMORY', 'OBSERVABILITY');
const ACTIVITY_FILE = join(OBS_DIR, 'tool-activity.jsonl');

const SKILLS_DIR = lifeosPath('MEMORY', 'SKILLS');
const EXECUTION_FILE = join(SKILLS_DIR, 'execution.jsonl');

// Capture rules (redact before truncate, 0600 files) live in lib/event-capture.ts
// (GHSA-8qfr-7fpx-68x9, @godagoo).

/** The skill run line goes through the private append: 0600 file, owner-only directory, an existing
 * file or directory tightened (2026-10-14). */
function appendSkillJsonLine(filePath: string, line: unknown): void {
  appendPrivateRecord(filePath, line);
}

/** Skill arguments can be personal (names, drafts, topics): kept redacted and bounded, never whole. */
export const SKILL_ARGS_KEEP = 200;

// ── The run line ─────────────────────────────────────────────────────────────
// execution.jsonl is the ONE skill-run record. Besides the original fields it
// carries session_id, turn, a generated run_id, parent_run_id and
// prior_run_id_same_turn. Unknown values stay null; nothing here guesses.
//   turn          — the router turn id of the prompt being worked, read through
//                   readPick (hooks/lib/router-pick.ts) with its staleness guard:
//                   a pick older than TURN_MAX_AGE_MS belongs to an earlier
//                   prompt the advisor did not overwrite, so it reads as null.
//   parent_run_id — ONLY an explicit carrier: LIFEOS_PARENT_RUN_ID in the
//                   environment, set by whatever spawned this session for a
//                   run it owns. Sequence is not parentage, so absent carrier
//                   means null (F-W7 / A4).
//   prior_run_id_same_turn — the previous run recorded for this session when it
//                   shares a known turn with this one: an ordering fact, never
//                   a claim of nesting. Run state is one small file per session.
//   NESTING THROUGH AGENTS (ISC-25, checked 2026-09-30): a Skill called from inside a
//                   subagent arrives with session_id identical to the parent's plus agent_id and
//                   agent_type, and NOTHING that names the parent run or the Agent call that spawned
//                   it (the payload shape is the ToolUseInput above; AgentInvocation.hook.ts documents
//                   that SubagentStart/Stop add no link either). So the parent run id cannot be
//                   propagated from the payload, and it is not guessed: the line records agent_id and
//                   agent_type so the agent's runs group together, and parent_run_id stays null. The
//                   only explicit carrier is LIFEOS_PARENT_RUN_ID, which a spawner that owns a run
//                   (a headless child process) must set; no spawner in this tree sets it today.
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_ID = /^run_[0-9a-f-]{36}$/;
const TURN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RUN_STATE_DIR = (): string => process.env.LIFEOS_RUN_STATE_DIR || lifeosPath('MEMORY', 'STATE', 'run-state');

interface RunState { run_id: string; turn: string | null; skill: string; ts: string }

function currentTurn(session: string | null, now = Date.now()): string | null {
  if (!session || !SAFE_SESSION.test(session)) return null;
  const pick = readPick(session, now - TURN_MAX_AGE_MS);
  return pick && typeof pick.turn === 'string' && pick.turn.length > 0 ? pick.turn : null;
}

/** The explicit parent carrier, or null. A malformed value is ignored rather than recorded as a parent. */
function explicitParent(): string | null {
  const v = process.env.LIFEOS_PARENT_RUN_ID;
  return typeof v === 'string' && RUN_ID.test(v) ? v : null;
}

function readRunState(session: string | null): RunState | null {
  if (!session || !SAFE_SESSION.test(session)) return null;
  try {
    const s = JSON.parse(readFileSync(join(RUN_STATE_DIR(), session + '.json'), 'utf8')) as RunState;
    return typeof s.run_id === 'string' && s.run_id ? s : null;
  } catch { return null; }
}

function writeRunState(session: string | null, state: RunState): void {
  if (!session || !SAFE_SESSION.test(session)) return;
  const dir = RUN_STATE_DIR();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, session + '.json');
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

function buildRunLine(data: ToolUseInput, skill: string, args: string, ts: string): Record<string, unknown> {
  const session = typeof data.session_id === 'string' && data.session_id ? data.session_id : null;
  const turn = currentTurn(session);
  const prior = readRunState(session);
  const run_id = 'run_' + randomUUID();
  const parent_run_id = explicitParent();
  const prior_run_id_same_turn = prior && turn !== null && prior.turn === turn ? prior.run_id : null;
  invariant(skill.length > 0 && RUN_ID.test(run_id), 'a run line names a skill and carries a run id');
  invariant(parent_run_id !== run_id && prior_run_id_same_turn !== run_id, 'a run is never its own parent or predecessor');
  try { writeRunState(session, { run_id, turn, skill, ts }); } catch { /* state is best effort; the line still lands */ }
  return {
    ...buildExecutionLine(skill, args, ts),
    session_id: session,
    turn,
    run_id,
    parent_run_id,
    prior_run_id_same_turn,
    ...(typeof data.agent_id === 'string' ? { agent_id: data.agent_id } : {}),
    ...(typeof data.agent_type === 'string' ? { agent_type: data.agent_type } : {}),
  };
}

function handlePostToolUse(raw: string): StatvsWork | null {
  // ── ToolActivityTracker logic (ALWAYS) ────────────────────────────────
  let data: ToolUseInput;
  try {
    data = JSON.parse(raw) as ToolUseInput;
  } catch (e) {
    console.error('[ToolActivityTracker]', e instanceof Error ? e.message : String(e));
    return null;
  }
  const work: StatvsWork = { skillRun: null, toolRuns: toolRunsFor(data, 'success') };

  try {
    const toolName = data.tool_name || 'unknown';

    const inputPreview = data.tool_input ? previewJson(data.tool_input, 300) : '';

    const groundTruth = data.tool_input
      ? captureGroundTruth(toolName, data.tool_input, data.tool_response)
      : undefined;

    const event = {
      timestamp: getISOTimestamp(),
      event: 'tool_use',
      source: 'tool-activity',
      type: 'tool_use',
      session_id: data.session_id,
      tool_name: toolName,
      tool_input_preview: inputPreview,
      // Subagent attribution when present (public issue #1806, @xmasyx).
      ...(typeof data.agent_id === 'string' ? { agent_id: data.agent_id } : {}),
      ...(typeof data.agent_type === 'string' ? { agent_type: data.agent_type } : {}),
      ...(groundTruth ? { ground_truth: groundTruth } : {}),
    };

    appendPrivateLine(ACTIVITY_FILE, event);

    // Heartbeat (2026-07-15 reversal of the narrow-bump design): EVERY tool
    // call bumps the session's row (30s debounce inside). The old rule bumped
    // only on files under MEMORY/WORK/<slug>/, which made runs doing real work
    // between ISA edits read as dead within 10 minutes, so live work showed as
    // dead to the principal. Phantom-dead proved worse than the
    // phantom-active the old rule guarded against. The path-based bump stays
    // for cross-session ISA touches (a different UUID working an ISA's files).
    if (typeof data.session_id === 'string') bumpLastToolActivityByUUID(data.session_id);
    const toolFilePath = typeof data.tool_input?.file_path === 'string'
      ? data.tool_input.file_path
      : null;
    if (toolFilePath) bumpLastToolActivity(toolFilePath);

    // Drift healer (2026-07-20): ISA edits that bypass ISASync's Write/Edit
    // trigger (Bash sed, git, other machines) leave work.json rows stale in
    // wrong kanban lanes. WorkReconcile re-syncs rows whose ISA mtime moved.
    // Spawn gate: state-file mtime check keeps this to one detached spawn per
    // minute; the tool itself debounces again internally.
    try {
      const reconcileState = lifeosPath('MEMORY', 'STATE', 'work-reconcile.json');
      let due = true;
      try {
        due = Date.now() - statSync(reconcileState).mtimeMs > 60_000;
      } catch { /* no state file yet — run it */ }
      if (due) {
        // Absolute bun path: a detached child inherits a minimal PATH, so the
        // bare name ENOENTs. That failure arrives on the 'error' EVENT, past
        // this sync try/catch — so it was swallowed, WorkReconcile never wrote
        // its state file, and `due` stayed true on every single tool call.
        // (ported from public PR #1738, @elhoim)
        const proc = spawn(resolveBun(), [lifeosPath('TOOLS', 'WorkReconcile.ts')], { windowsHide: true,
          detached: true,
          stdio: 'ignore',
        });
        proc.on('error', (err) => console.error('[WorkReconcile spawn]', err instanceof Error ? err.message : String(err)));
        proc.unref();
      }
    } catch { /* healing is best-effort; never break the logger */ }
  } catch (e) {
    console.error('[ToolActivityTracker]', e instanceof Error ? e.message : String(e));
  }

  // ── SkillExecutionLog logic (ADDITIONAL, only when tool_name === "Skill") ──
  // Runs regardless of any failure above — the two writes are independent, and
  // downstream reads execution.jsonl separately from tool-activity.jsonl.
  if (data.tool_name === 'Skill') {
    try {
      const skill = extractSkillName(data.tool_input);
      if (skill) {
        const args = extractSkillArgs(data.tool_input);
        const ts = isoZTimestamp(getISOTimestamp());
        const line = buildRunLine(data, skill, capture(args, SKILL_ARGS_KEEP), ts);
        appendSkillJsonLine(EXECUTION_FILE, line);
        work.skillRun = skillRunRow(data, skill, args, typeof line.run_id === 'string' ? line.run_id : null);
      }
    } catch (error) {
      console.error('[SkillExecutionLog]', error instanceof Error ? error.message : String(error));
    }
  }
  return work;
}

// ═════════════════════════════════════════════════════════════════════════
// STATVS dual-write: skill-run and tool-run rows (STATVS ISA F16, step 1)
// ═════════════════════════════════════════════════════════════════════════
// The record module (LIFEOS/STATVS/lib/quality.ts, which loads the record engine) is imported only when a call owes a
// row: a Skill call, or a Bash call that runs a LifeOS tool with bun. Every other call pays toolRunsFor's string test.

export interface SkillRunRow { skill: string; intent?: string; session_id?: string; run_id?: string; args_hash?: string }
export interface ToolRunRow { tool: string; exit_code: number; ms: number; session_id?: string; skill?: string }
interface StatvsWork { skillRun: SkillRunRow | null; toolRuns: ToolRunRow[] }

const ID_SHAPE = /^[^\s\u0000-\u001f]{1,160}$/;
const INTENT_WORD = /^[A-Z][A-Za-z0-9]{1,63}$/;
/** At most this many tool rows per Bash call; a longer chain is one command, not a batch job. */
export const MAX_TOOL_ROWS = 5;

/** The intent a Skill call names: the first word of its args when skills/<skill>/Intents/<Word>.md exists, else undefined. */
export function intentFor(skill: string, args: string, skillsDir: string = process.env.LIFEOS_SKILLS_DIR || getSkillsDir()): string | undefined {
  const word = args.trim().split(/\s+/, 1)[0] ?? '';
  if (!INTENT_WORD.test(word) || !/^[A-Za-z0-9_.-]+$/.test(skill)) return undefined;
  try { return existsSync(join(skillsDir, skill, 'Intents', word + '.md')) ? word : undefined; } catch { return undefined; }
}

function skillRunRow(data: ToolUseInput, skill: string, args: string, runId: string | null): SkillRunRow {
  const row: SkillRunRow = { skill };
  const intent = intentFor(skill, args);
  if (intent) row.intent = intent;
  if (typeof data.session_id === 'string' && ID_SHAPE.test(data.session_id)) row.session_id = data.session_id;
  if (runId && ID_SHAPE.test(runId)) row.run_id = runId;
  if (args) row.args_hash = createHash('sha256').update(args).digest('hex').slice(0, 16);
  return row;
}

/**
 * The LifeOS tools a shell command runs with bun, as repo-relative paths with their skill: a simple command whose program
 * is bun, `bun [run] [flags] <path>.ts`, where the path ends in skills/<Skill>/Tools/<...>.ts or LIFEOS/TOOLS/<...>.ts.
 * The command line is walked with the shared shell parser (hooks/lib/shell-commands.ts: quotes, heredocs, `sh -c`,
 * wrappers), so a tool path inside a heredoc, a quoted string or another program's arguments is not a run. `bun test`,
 * `bun -e` and test files are not tool runs. Distinct paths, in order, at most MAX_TOOL_ROWS. The parser loads only when
 * the cheap text test passes, so other calls never pay for it.
 */
export function bunToolRuns(command: string): Array<{ tool: string; skill?: string }> {
  if (!command.includes('bun') || !(command.includes('/Tools/') || command.includes('LIFEOS/TOOLS/'))) return [];
  let commands: Array<{ argv: string[] }>;
  try {
    const sh = require('./lib/shell-commands') as typeof import('./lib/shell-commands');
    commands = sh.simpleCommands(command).commands.filter((c) => sh.programName(c.argv[0]) === 'bun');
  } catch (e) {
    console.error('[EventLogger] tool-run parse failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
  const out: Array<{ tool: string; skill?: string }> = [];
  const seen = new Set<string>();
  for (const { argv } of commands) {
    let i = 1;
    if (argv[i] === 'run') i++;
    while (i < argv.length && argv[i]!.startsWith('-')) i++;
    const path = argv[i] ?? '';
    if (!path.endsWith('.ts') || /\.test\.ts$/.test(path)) continue;
    const sk = path.match(/(?:^|\/)(skills\/([A-Za-z0-9_.-]+)\/Tools\/[A-Za-z0-9_.\/-]+\.ts)$/);
    const lt = sk ? null : path.match(/(?:^|\/)(LIFEOS\/TOOLS\/[A-Za-z0-9_.\/-]+\.ts)$/);
    const tool = sk?.[1] ?? lt?.[1];
    if (!tool || tool.includes('/../') || seen.has(tool)) continue;
    seen.add(tool);
    out.push(sk ? { tool, skill: sk[2]! } : { tool });
    if (out.length >= MAX_TOOL_ROWS) break;
  }
  return out;
}

/** The exit code of a Bash call: the response's own code on success (else 0); on failure "Exit code N" from the error, 130 for an interrupt, else 1. */
export function exitCodeOf(data: { tool_response?: unknown; error?: unknown; is_interrupt?: unknown }, outcome: 'success' | 'failure'): number {
  if (outcome === 'success') {
    const r = data.tool_response;
    if (r && typeof r === 'object') {
      const c = (r as Record<string, unknown>).exit_code ?? (r as Record<string, unknown>).exitCode;
      if (typeof c === 'number' && Number.isInteger(c)) return c;
    }
    return 0;
  }
  if (data.is_interrupt === true) return 130;
  const m = typeof data.error === 'string' ? data.error.match(/exit code (\d{1,3})/i) : null;
  return m ? Number(m[1]) : 1;
}

/** The tool rows one Bash call owes; [] for any other tool, a command with no LifeOS tool, or a payload with no duration. */
export function toolRunsFor(data: { session_id?: unknown; tool_name?: unknown; tool_input?: Record<string, unknown>; tool_response?: unknown; duration_ms?: unknown; error?: unknown; is_interrupt?: unknown }, outcome: 'success' | 'failure'): ToolRunRow[] {
  if (data.tool_name !== 'Bash' || typeof data.tool_input?.command !== 'string') return [];
  const runs = bunToolRuns(data.tool_input.command);
  if (!runs.length) return [];
  // The harness's own timing is the only honest duration; a payload without it gets no row rather than a made-up 0.
  if (typeof data.duration_ms !== 'number' || !Number.isFinite(data.duration_ms) || data.duration_ms < 0) {
    console.error('[EventLogger] tool-run skipped: the payload carries no duration_ms');
    return [];
  }
  const exit_code = exitCodeOf(data, outcome);
  const session = typeof data.session_id === 'string' && ID_SHAPE.test(data.session_id) ? data.session_id : undefined;
  return runs.map((r) => ({ tool: r.tool, exit_code, ms: Math.round(data.duration_ms as number), ...(session ? { session_id: session } : {}), ...(r.skill ? { skill: r.skill } : {}) }));
}

/** Append the rows a call owes. Never throws: the record's own refusals are logged by quality.ts, anything else here. */
async function writeStatvs(work: StatvsWork | null): Promise<void> {
  if (!work || (!work.skillRun && work.toolRuns.length === 0)) return;
  try {
    const q = await import('../LIFEOS/STATVS/lib/quality.ts');
    if (work.skillRun) q.recordSkillRun(work.skillRun);
    for (const t of work.toolRuns) q.recordToolRun(t);
  } catch (e) {
    console.error('[EventLogger] STATVS row not written:', e instanceof Error ? e.message : String(e));
  }
}

// ── Intent voice (PostToolUse, Read only) ────────────────────────────────────
// One announcement per intent per execution, replacing the per-intent curl blocks.
// All gating (main session, recent Skill call, dedupe, desktop channel) lives in
// lib/intent-voice.ts. Fail-open: any fault is logged to stderr and swallowed.
const INTENT_VOICE_STATE_DIR = lifeosPath('MEMORY', 'STATE', 'intent-voice');

async function announceIntentIfDue(raw: string): Promise<void> {
  try {
    const data = JSON.parse(raw) as ToolUseInput;
    if (data.tool_name !== 'Read') return;
    await maybeAnnounceIntent(data, {
      now: Date.now(),
      executionFile: EXECUTION_FILE,
      stateDir: INTENT_VOICE_STATE_DIR,
      isDesktop: isDesktopChannel,
      post: (message) => postIntentVoice(PULSE_BASE, message),
      onChannelSkip: (message, sessionId) => logSkippedVoice({ hookLabel: 'IntentVoice', message, sessionId }),
    });
  } catch (e) {
    console.error('[IntentVoice]', e instanceof Error ? e.message : String(e));
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 3. PostToolUseFailure: ToolFailureTracker
// ═════════════════════════════════════════════════════════════════════════

interface ToolFailureInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}

interface ToolFailureEvent {
  timestamp: string;
  event: 'tool_failure';
  session_id: string;
  tool_name: string;
  error: string;
  tool_input_preview: string;
}

const FAILURES_FILE = join(OBS_DIR, 'tool-failures.jsonl');

function handlePostToolUseFailure(raw: string): StatvsWork | null {
  let work: StatvsWork | null = null;
  try {
    const data: ToolFailureInput = JSON.parse(raw);
    try { work = { skillRun: null, toolRuns: toolRunsFor(data, 'failure') }; } catch { /* the failure log still lands */ }
    const toolName = data.tool_name || 'unknown';
    const error = data.error || 'unknown error';

    // Redact, then truncate, tool input for storage
    const inputPreview = data.tool_input ? previewJson(data.tool_input, 500) : '';
    const cleanError = redactLabelled(error.slice(0, 1000 + 4096));

    const event: ToolFailureEvent = {
      timestamp: getISOTimestamp(),
      event: 'tool_failure',
      session_id: data.session_id,
      tool_name: toolName,
      error: cleanError.slice(0, 1000),
      tool_input_preview: inputPreview,
    };

    appendPrivateLine(FAILURES_FILE, event);
    console.error(`[ToolFailureTracker] Logged failure: ${toolName} — ${cleanError.slice(0, 80)}`);
  } catch (err) {
    console.error(`[ToolFailureTracker] Error: ${err}`);
  }
  return work;
}

// ═════════════════════════════════════════════════════════════════════════
// 4. StopFailure: StopFailureHandler (log-only; no voice per 2026-06-11)
// ═════════════════════════════════════════════════════════════════════════

interface StopFailureInput {
  session_id?: string;
  hook_event_name?: string;
  error?: string;
}

function handleStopFailure(raw: string): void {
  let input: StopFailureInput;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const timestamp = getISOTimestamp();
  const [year, month] = getYearMonth().split('-');
  const logDir = lifeosPath('MEMORY', 'SECURITY', year, month);

  const logEntry = {
    timestamp,
    session_id: input.session_id || 'unknown',
    event_type: 'stop_failure',
    hook_event: input.hook_event_name || 'StopFailure',
    error_details: typeof input.error === 'string' && input.error ? capture(input.error, 4000) : 'unknown API error',
  };

  try {
    appendPrivateLine(join(logDir, `stop-failures-${getPSTDate()}.jsonl`), logEntry);
  } catch {
    // Silent — don't block on logging failure
  }

  // Log-only. Nothing here speaks, and re-adding voice is a regression, not a feature:
  // Claude Code already prints the error on screen, so a spoken StopFailure carries zero
  // new information. Suppression lists do not fix this — any kind the list fails to name
  // (e.g. "unknown") speaks anyway. The JSONL above is the record.
}

// ═════════════════════════════════════════════════════════════════════════
// 5. ConfigChange: ConfigAudit
// ═════════════════════════════════════════════════════════════════════════

interface ConfigChangeInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  config_path?: string;
  config_key?: string;
  old_value?: unknown;
  new_value?: unknown;
}

interface ConfigChangeEvent {
  timestamp: string;
  event: 'config_change';
  session_id: string;
  config_path: string;
  config_key: string;
  change_summary: string;
}

const AUDIT_FILE = join(OBS_DIR, 'config-changes.jsonl');
// IMPROVEMENT (2026-07-10): moved from volatile /tmp so the diff baseline
// survives reboots. STATE dir is created on demand before writing the snapshot.
const SNAPSHOT_PATH = lifeosPath('MEMORY', 'STATE', 'pai-settings-snapshot.json');

// Sensitive keys that warrant extra logging
const SENSITIVE_KEYS = new Set([
  'permissions', 'hooks', 'env', 'mcpServers',
  'permissions.allow', 'permissions.deny', 'permissions.ask',
]);

function handleConfigChange(raw: string): void {
  try {
    const data: ConfigChangeInput = JSON.parse(raw);

    // Use file-diff to determine what actually changed
    const { changedKeys, summary } = diffSettings(getSettingsPath(), SNAPSHOT_PATH);
    const configKey = changedKeys.join(',');
    const isSensitive = changedKeys.some(k => SENSITIVE_KEYS.has(k));

    const event: ConfigChangeEvent = {
      timestamp: getISOTimestamp(),
      event: 'config_change',
      session_id: data.session_id,
      config_path: data.config_path || 'settings.json',
      config_key: configKey,
      change_summary: summary,
    };

    appendPrivateLine(AUDIT_FILE, event);

    const sensitivity = isSensitive ? ' [SENSITIVE]' : '';
    console.error(`[ConfigAudit] Logged: ${configKey}${sensitivity} — ${summary}`);
  } catch (err) {
    console.error(`[ConfigAudit] Error: ${err}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Dispatcher
// ═════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) { process.exit(0); }

    // Parse just enough to route. A malformed payload for a PostToolUse still
    // gets handed to the PostToolUse handler (which re-parses and logs its own
    // error) to preserve the pre-merge fail-open behavior.
    let eventName = '';
    try {
      eventName = (JSON.parse(raw) as { hook_event_name?: string }).hook_event_name || '';
    } catch {
      // hook_event_name unreadable — fall through; nothing to dispatch safely.
    }

    switch (eventName) {
      case 'PostToolUse': {
        const work = handlePostToolUse(raw);
        await Promise.all([announceIntentIfDue(raw), writeStatvs(work)]);
        break;
      }
      case 'PostToolUseFailure':
        await writeStatvs(handlePostToolUseFailure(raw));
        break;
      case 'StopFailure':
        handleStopFailure(raw);
        break;
      case 'ConfigChange':
        handleConfigChange(raw);
        break;
      default:
        // Unknown / missing event name — no-op, fail open.
        break;
    }
  } catch (e) {
    console.error('[EventLogger]', e instanceof Error ? e.message : String(e));
  }
  process.exit(0);
}

// Run as the hook; imported by a test, only the pure helpers above are used.
if (import.meta.main) main();
