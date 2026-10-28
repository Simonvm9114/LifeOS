#!/usr/bin/env bun
/**
 * @version 2.3.3
 * MemoryReviewFire — Stop hook that owns the WHOLE memory-review cadence.
 *
 * Lost-window compensation (public issue #1908, @jacobo-ortiz): the spawn used to
 * zero the session counter unconditionally, so a reviewer run that then timed out
 * or failed silently lost every turn it was sent. Now the spawn subtracts what it
 * sent and records it; the next fire reads this transcript's latest row from
 * reviewer-runs.jsonl and, if that run failed and has not been compensated yet,
 * restores those turns once. The window is capped at 2× turn_threshold so a
 * backlog drains over several fires instead of building one giant prompt (the
 * thing most likely to time out again).
 *
 * Consolidation (2026-07-11, thinking-system BLE strip): the old design split
 * the cadence across two hooks — MemoryReviewTrigger (per-prompt: tick counter,
 * idle detection, pending_review flag, debounce-cancel) and this one (consume
 * the flag at Stop). Firing at Stop is already the quiet moment the idle/
 * debounce machinery approximated, so the handshake was scaffolding. Now:
 *
 *   On every primary-session Stop:
 *     1. THIS SESSION's turn_count += 1, last_message_at = now
 *     2. If this session's turn_count >= turn_threshold — OR the GLOBAL last
 *        review is older than max_hours_since_review and this session has moved
 *        at all — AND minutes since the GLOBAL last_review >= min_minutes_between
 *        → spawn MemoryReviewer.ts detached, reset this session's counter, stamp
 *        the global clock.
 *
 * Per-session cadence (public issue #1711, @jacobo-ortiz): the turn counter used
 * to live in the single global review-state.json, so two concurrent sessions
 * incremented and reset each other's count — a busy session could starve a quiet
 * one, and read-modify-write interleaving lost ticks outright. The counter now
 * lives per session at MEMORY/STATE/memory-review/<session_id>.json, mirroring
 * the per-session pattern already used by hooks/MemoryTurnStart.hook.ts.
 *
 * The two halves of the trigger are deliberately scoped differently:
 *   - turn_threshold is PER SESSION. It asks "has this conversation moved enough
 *     to be worth reviewing?", which is only meaningful within one transcript.
 *   - min_minutes_between stays GLOBAL. It is the inference-volume guard, and a
 *     per-session rate cap would let N sessions run N reviews per window.
 *
 * OBSERVABILITY/review-state.json is still written on every Stop as a mirror, so
 * the statusline 🧠 MEM line, MemoryStatus.ts, MemoryHealthCheck.ts and the Pulse
 * memory module keep reading the schema they already know. Its `last_review_at`
 * remains load-bearing (it IS the global rate cap); its turn count is now
 * display-only and last-writer-wins across concurrent sessions.
 * Cadence parameters: LIFEOS/USER/CONFIG/memory-review.json.
 *
 * Failure mode: any error logs to stderr and exits 0 (never block Stop).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, resolve as pathResolve } from "node:path";
import { isSubagentContext as isSubagent } from './lib/subagent';
import { invariant } from '../LIFEOS/TOOLS/Invariant';
import { principalThreadDir } from "../LIFEOS/TOOLS/DeliveredContext";
import { getClaudeDir } from "./lib/paths"; // public issue #1665 @rogdex24, #1584 @ramazanpolat — aliased resolve sites missed by the 09-03 sweep

const CLAUDE_ROOT = getClaudeDir();
const STATE_PATH = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/review-state.json");
const SESSION_STATE_DIR = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/STATE/memory-review");
const CONFIG_PATH = pathResolve(CLAUDE_ROOT, "LIFEOS/USER/CONFIG/memory-review.json");
const FIRE_LOG_PATH = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/reviewer-fires.jsonl");
const REVIEWER_PATH = pathResolve(CLAUDE_ROOT, "LIFEOS/TOOLS/MemoryReviewer.ts");
const RUNS_LOG_PATH = pathResolve(CLAUDE_ROOT, "LIFEOS/MEMORY/OBSERVABILITY/reviewer-runs.jsonl");

/** Per-session state files older than this are pruned opportunistically. */
const SESSION_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ReviewState {
  turn_count_since_last_review: number;
  last_review_at: string | null;
  last_message_at: string | null;
  pending_review: boolean; // kept for statusline schema compat; always false now
  schema_version: 1;
}

const INITIAL_STATE: ReviewState = {
  turn_count_since_last_review: 0,
  last_review_at: null,
  last_message_at: null,
  pending_review: false,
  schema_version: 1,
};

function loadConfig(): { turn_threshold: number; min_minutes_between: number; max_hours_since_review: number } {
  const fallback = { turn_threshold: 8, min_minutes_between: 30, max_hours_since_review: 24 };
  try {
    if (!existsSync(CONFIG_PATH)) return fallback;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      turn_threshold: typeof raw.turn_threshold === "number" ? raw.turn_threshold : fallback.turn_threshold,
      min_minutes_between: typeof raw.min_minutes_between === "number" ? raw.min_minutes_between : fallback.min_minutes_between,
      max_hours_since_review:
        typeof raw.max_hours_since_review === "number" ? raw.max_hours_since_review : fallback.max_hours_since_review,
    };
  } catch {
    return fallback;
  }
}

function loadState(): ReviewState {
  try {
    if (!existsSync(STATE_PATH)) return { ...INITIAL_STATE };
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return {
      turn_count_since_last_review: typeof raw.turn_count_since_last_review === "number" ? raw.turn_count_since_last_review : 0,
      last_review_at: typeof raw.last_review_at === "string" ? raw.last_review_at : null,
      last_message_at: typeof raw.last_message_at === "string" ? raw.last_message_at : null,
      pending_review: false,
      schema_version: 1,
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

function saveState(state: ReviewState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, STATE_PATH);
}

// ── Per-session cadence state (public issue #1711, @jacobo-ortiz) ────────────

export interface SessionReviewState {
  turn_count_since_last_review: number;
  last_review_at: string | null;
  last_message_at: string | null;
  /** Turns handed to the reviewer at the last spawn — what a failed run loses (public issue #1908, @jacobo-ortiz). */
  last_turns_sent: number;
  /** runId of the failed run whose turns were already restored, so restoration happens once. */
  compensated_run_id: string | null;
  schema_version: 1;
}

/**
 * Same sanitiser as hooks/MemoryTurnStart.hook.ts so both per-session stores
 * key off an identical filename for a given session.
 *
 * A null session_id (no stdin, or unparseable) degrades to one shared "unknown"
 * bucket — i.e. exactly the pre-fix global behaviour, which is the right
 * fallback: it never fires more often than the old code did.
 */
/** The counter bucket. A Tex thread outlives its Claude sessions (a 6h TTL and policy resets start new ones),
 *  so its turns count against the thread, hashed so no number lands in a filename (Tex ISA F17). */
export function counterKey(sessionId: string | null, env: Record<string, string | undefined> = process.env): string | null {
  const thread = env.LIFEOS_TEXTING_THREAD;
  return env.LIFEOS_TEXTING_SESSION && thread ? `texting-${createHash("sha256").update(thread).digest("hex").slice(0, 16)}` : sessionId;
}

function sessionStatePath(sessionId: string | null): string {
  const safe = (sessionId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(SESSION_STATE_DIR, `${safe}.json`);
}

function loadSessionState(sessionId: string | null): SessionReviewState {
  const empty: SessionReviewState = {
    turn_count_since_last_review: 0,
    last_review_at: null,
    last_message_at: null,
    last_turns_sent: 0,
    compensated_run_id: null,
    schema_version: 1,
  };
  try {
    const p = sessionStatePath(sessionId);
    if (!existsSync(p)) return empty;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return {
      turn_count_since_last_review:
        typeof raw.turn_count_since_last_review === "number" ? raw.turn_count_since_last_review : 0,
      last_review_at: typeof raw.last_review_at === "string" ? raw.last_review_at : null,
      last_message_at: typeof raw.last_message_at === "string" ? raw.last_message_at : null,
      last_turns_sent: typeof raw.last_turns_sent === "number" ? raw.last_turns_sent : 0,
      compensated_run_id: typeof raw.compensated_run_id === "string" ? raw.compensated_run_id : null,
      schema_version: 1,
    };
  } catch {
    return empty;
  }
}

/** Latest reviewer-runs.jsonl row for this transcript: the outcome of the last run this session spawned. */
export interface LastRun { runId: string; ok: boolean }
function lastRunFor(transcriptPath: string | null, logPath: string = RUNS_LOG_PATH): LastRun | null {
  if (!transcriptPath || !existsSync(logPath)) return null;
  try {
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const r = JSON.parse(lines[i]);
        if (r?.transcript === transcriptPath && typeof r.runId === "string") return { runId: r.runId, ok: r.ok === true };
      } catch { /* malformed line — keep looking */ }
    }
  } catch { /* unreadable log — no compensation this fire */ }
  return null;
}

/**
 * Decide the review window for this fire (public issue #1908, @jacobo-ortiz).
 * If the last run for this transcript failed and has not been compensated, its
 * turns come back into the counter once. The window is min(counter, 2×threshold)
 * and is SUBTRACTED from the counter, never zeroed, so a backlog drains over
 * several fires. Mutates `session`; returns what to send and what was restored.
 */
export function planReviewWindow(session: SessionReviewState, lastRun: LastRun | null, turnThreshold: number): { turns: number; restored: number } {
  let restored = 0;
  if (lastRun && !lastRun.ok && lastRun.runId !== session.compensated_run_id && session.last_turns_sent > 0) {
    restored = session.last_turns_sent;
    session.turn_count_since_last_review += restored;
    session.compensated_run_id = lastRun.runId;
  }
  const turns = Math.min(session.turn_count_since_last_review, Math.max(1, 2 * turnThreshold));
  session.turn_count_since_last_review -= turns;
  session.last_turns_sent = turns;
  return { turns, restored };
}

function saveSessionState(sessionId: string | null, state: SessionReviewState): void {
  invariant(Number.isInteger(state.turn_count_since_last_review) && state.turn_count_since_last_review >= 0, `session turn counter must be a non-negative integer, got ${state.turn_count_since_last_review}`);
  invariant(Number.isInteger(state.last_turns_sent) && state.last_turns_sent >= 0, `last_turns_sent must be a non-negative integer, got ${state.last_turns_sent}`);
  const p = sessionStatePath(sessionId);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

/**
 * Drop per-session files untouched for SESSION_STATE_TTL_MS. Called only when a
 * review actually fires — rare enough to keep Stop cheap, frequent enough that
 * the directory cannot grow without bound. Never removes the current session's
 * file, and never throws.
 */
function pruneSessionStates(currentPath: string, nowMs: number): void {
  try {
    if (!existsSync(SESSION_STATE_DIR)) return;
    for (const name of readdirSync(SESSION_STATE_DIR)) {
      if (!name.endsWith(".json")) continue;
      const p = join(SESSION_STATE_DIR, name);
      if (p === currentPath) continue;
      try {
        if (nowMs - statSync(p).mtimeMs > SESSION_STATE_TTL_MS) unlinkSync(p);
      } catch { /* skip this file */ }
    }
  } catch { /* best-effort */ }
}

function minutesSince(iso: string | null, nowMs: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - t) / 60_000);
}

function logFire(payload: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(FIRE_LOG_PATH), { recursive: true });
    appendFileSync(FIRE_LOG_PATH, JSON.stringify(payload) + "\n", "utf8");
  } catch { /* best-effort */ }
}

/**
 * Claude Code hands every Stop hook a JSON payload on stdin carrying
 * session_id and transcript_path — the identity of the session that just
 * fired. Read it so the reviewer analyzes THIS session's transcript instead
 * of guessing via globally-newest-mtime, which grabs a concurrent session's
 * transcript whenever two sessions overlap (public issue #1495, @christauff).
 * `input` is the whole payload — the subagent guard reads its agent stamp, the
 * only marker a forked subagent sets (public PR #1958, @theNetworkChuck).
 */
function readHookInput(): { sessionId: string | null; transcriptPath: string | null; input: unknown } {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return { sessionId: null, transcriptPath: null, input: null };
    const j = JSON.parse(raw);
    return {
      sessionId: typeof j.session_id === "string" ? j.session_id : null,
      transcriptPath: typeof j.transcript_path === "string" ? j.transcript_path : null,
      input: j,
    };
  } catch {
    return { sessionId: null, transcriptPath: null, input: null };
  }
}

/**
 * The reviewer's argv. A text on the principal's own line starts a fresh session, so its transcript holds that
 * one text; the reviewer reads the principal thread's log instead, every text since its last run (Tex ISA F19,
 * ISC-246). Only the thread directory (a hash) crosses the argv, never the number. Any other session keeps its
 * transcript.
 */
export function reviewerArgs(
  turnsReviewed: number,
  transcriptPath: string | null,
  env: Record<string, string | undefined> = process.env,
  threadRoot?: string,
): string[] {
  const args = [REVIEWER_PATH, "review", "--turns", String(turnsReviewed)];
  const sender = env.LIFEOS_TEXTING_SESSION;
  const thread = sender ? principalThreadDir(sender, threadRoot) : null;
  if (thread) args.push("--thread", thread);
  else if (transcriptPath && existsSync(transcriptPath)) args.push("--input", transcriptPath);
  return args;
}

function spawnReviewer(turnsReviewed: number, transcriptPath: string | null): { spawned: boolean; reason: string } {
  if (!existsSync(REVIEWER_PATH)) {
    return { spawned: false, reason: "reviewer-not-found" };
  }
  try {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDECODE;
    const proc = spawn("bun", reviewerArgs(turnsReviewed, transcriptPath), { windowsHide: true,
      env,
      stdio: "ignore",
      detached: true,
    });
    proc.unref();
    return { spawned: true, reason: `pid=${proc.pid}` };
  } catch (e) {
    return { spawned: false, reason: `spawn-failed: ${(e as Error)?.message || String(e)}` };
  }
}

function main(): void {
  try {
    const { sessionId, transcriptPath, input } = readHookInput();
    if (isSubagent(input)) process.exit(0);

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const config = loadConfig();
    const global = loadState();
    const bucket = counterKey(sessionId);
    const session = loadSessionState(bucket);

    // Tick THIS session only. A concurrent session's Stop no longer touches it.
    session.turn_count_since_last_review += 1;
    session.last_message_at = now;

    // Turn threshold: per session (has this conversation moved enough?).
    // Minute floor: global (the inference-volume guard across all sessions).
    const minutesSinceReview = minutesSince(global.last_review_at, nowMs);
    const turnsDue = session.turn_count_since_last_review >= config.turn_threshold;

    // Time-based safety net (public issue #1893, @waveman2020-sudo): the turn
    // threshold is per session, so a principal who works in many short sessions
    // never reaches it in any single one and the reviewer starves indefinitely
    // despite heavy cumulative activity. Once max_hours_since_review have passed
    // since the GLOBAL last review, partial progress in this session is enough.
    // The global minute floor below still gates the actual fire, so this can
    // widen when a review is due but can never produce a burst. A null
    // last_review_at (never reviewed) reads as infinitely stale in both terms.
    const staleDue =
      session.turn_count_since_last_review >= 1 &&
      minutesSinceReview >= config.max_hours_since_review * 60;

    const due = (turnsDue || staleDue) && minutesSinceReview >= config.min_minutes_between;

    if (due) {
      // Restore a lost window once, cap it, subtract instead of zeroing (public issue #1908, @jacobo-ortiz).
      const { turns: turnsReviewed, restored } = planReviewWindow(session, lastRunFor(transcriptPath), config.turn_threshold);
      const { spawned, reason } = spawnReviewer(turnsReviewed, transcriptPath);
      logFire({ ts: now, turns_since_last_review: turnsReviewed, restored_turns: restored, turns_carried: session.turn_count_since_last_review, trigger: turnsDue ? "turns" : "stale", spawned, reason, session_id: sessionId, transcript_path: transcriptPath });
      session.last_review_at = now;
      global.last_review_at = now;
      pruneSessionStates(sessionStatePath(bucket), nowMs);
    }

    saveSessionState(bucket, session);

    // Mirror for the statusline / MemoryStatus / MemoryHealthCheck / Pulse.
    // Schema is unchanged; the turn count reflects whichever session wrote last
    // and is display-only, while last_review_at above is the real rate cap.
    // Merge, never clobber: MemoryReviewer.stampLastReviewAt (PR #2032) also
    // writes last_review_at when a run completes, possibly between this hook's
    // load and save. Keep whichever stamp is later. public issue #1908, @jacobo-ortiz
    const onDisk = loadState().last_review_at;
    if (onDisk && (!global.last_review_at || Date.parse(onDisk) > Date.parse(global.last_review_at))) global.last_review_at = onDisk;
    global.turn_count_since_last_review = session.turn_count_since_last_review;
    global.last_message_at = now;
    saveState(global);
  } catch (e) {
    process.stderr.write(`MemoryReviewFire error: ${(e as Error)?.message || String(e)}\n`);
  }
  process.exit(0);
}

// Guarded so the planning function is importable by tests (public issue #1908, @jacobo-ortiz).
if (import.meta.main) main();
