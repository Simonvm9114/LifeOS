#!/usr/bin/env bun
/**
 * @version 3.7.13
 * TRIGGER: UserPromptSubmit (routing match, always-on) — also runs on PostToolUse via PostToolObserver and on PostToolUseFailure.
 * AlgorithmNudge — the Algorithm live nudge layer ("Events ask the rest").
 *
 * ROWS (what each one is for):
 *   depth-directive   — a plain-language depth directive in a NO-RUN turn signals the turn
 *                       IS a run; doctrine criteria 10/15 only have teeth once one exists.
 *   doctrine-class    — a prompt asking for judgment about the thinking system itself
 *                       (Algorithm, ISA doctrine, standing rules). Advice inherits the
 *                       blast radius of what it advises; the row asks the entry question
 *                       (run or stated reason) at the only moment a backstop can exist
 *                       (a live miss, 2026-08-15: entry misjudgment escapes every
 *                       in-run check because no run registers).
 *   (exec-delegation, sweep-delegation and inherited-dispatch are retired, 2026-10-15
 *    native-unblock ISC-17: whether to delegate, and on which model, is Claude Code's
 *    own call; a row second-guessing it was advice the model would ignore.)
 *   skill-gap        — a substantive session that never invoked a skill AND whose
 *                       prompts matched no skill's USE WHEN asks the opposite question
 *                       from skill-routing: not "you skipped a skill" but "nothing here
 *                       covers this — should a skill exist?" Advisory; the model checks
 *                       real coverage and proposes, the hook never names a skill.
 *                       He asked for this row by name, so it is a NAMED EXCEPTION to
 *                       the unobservable-state rule below; the argument is at the row.
 *   capability        — a Bash failure exercising a Doctor-tracked capability that
 *                       capabilities.json marks broken emits its compile-time CAP_FIX
 *                       command (60-min per-capability cooldown; the manifest is state
 *                       only, never a prose source).
 *
 * Every row is an ADVISORY QUESTION. A Stop-blocking variant was adversarially killed for
 * good reason: it Goodharts into token dispatches, because it gates on procedure instead of
 * outcome. Keep rows advisory.
 *
 * TWO SCOPES:
 *   ALWAYS-ON  (any session)          → skill-routing + depth-directive
 *                                       (UserPromptSubmit),
 *                                       late-ISA + skill-gap (PostToolUse),
 *                                       capability row (PostToolUseFailure)
 *   RUN-SCOPED (live Algorithm run)   → stale-isa
 *
 * Fires the right one-line question at the moment it's answerable. Deterministic,
 * zero inference calls, always exits 0, hot path target <20ms.
 *
 * A row may only fire for state the model cannot observe from its own context — an
 * unwritten ISA, a stale one, a destructive op's blast radius, a capability the manifest
 * knows is broken. Asking the model to notice something already in front of it (probe-fail,
 * agent-return, claim-close, spend) is scaffolding and does not earn a row.
 * NAMED EXCEPTION (doctrine §Events, v8.22.0): entry rows — depth-directive and
 * doctrine-class — key on the prompt itself, because their job is making the run exist;
 * an entry misjudgment leaves no run for any in-run check to bind, and prose teeth for
 * exactly this class demonstrably failed live twice (2026-07-16 and 2026-08-15).
 *
 * Events (dispatched by hook_event_name):
 *   UserPromptSubmit          → routing match (always-on) + depth + doctrine-class
 *   PostToolUse               → stale-ISA | late-ISA | skill-gap
 *                               (reaches here via PostToolObserver's import of run())
 *   PostToolUseFailure        → capability row
 *
 * State: MEMORY/STATE/isa-nudge/{session_id}.json
 *        MEMORY/STATE/skill-gap-nudge.json          (cross-session rate limit)
 *        MEMORY/OBSERVABILITY/skill-gap-candidates.jsonl (SuggestSkills corpus)
 *   { toolCallsSinceISAEdit, toolCallsTotal, lateISAFired, lastNudgeAt: {type: epochMs},
 *     primaryTranscript }
 *
 * Skill index: MEMORY/STATE/skill-usewhen-index.json — trigger phrases parsed from
 * every skills/*\/SKILL.md frontmatter USE WHEN clause. NEVER scanned synchronously
 * on the hot path: a stale/missing index triggers a DETACHED rebuild
 * (`bun AlgorithmNudge.hook.ts --rebuild-index`) and this turn proceeds without it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { resolveBun } from './lib/resolve-bin';
import { deriveAscent, type AscentState } from '../LIFEOS/TOOLS/ascent';
import { getClaudeDir, lifeosPath } from "./lib/paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { hookCovers } from "./lib/function-hooks";
// The depth matcher is shared with the Route step (LIFEOS/ROUTER/Depth.ts): one list, never two.
import { boundedPhraseRe, stripFences, matchDepthDirective } from "../LIFEOS/ROUTER/Depth";
export { boundedPhraseRe, stripFences, matchDepthDirective };

// Terminal telemetry only. Headless spawns (the texting bridge, scheduled jobs) must never receive these
// notes — once a model-drift warning and a memory-freshness line were relayed into a text reply.
export const HEADLESS = !!(process.env.LIFEOS_TEXTING_SESSION || process.env.LIFEOS_NOTIFICATION_CHANNEL === "headless");
if (import.meta.main && HEADLESS) process.exit(0);


const CLAUDE_DIR = getClaudeDir();
// Overridable so tests can PRODUCE a state-machine edge instead of hand-writing
// its precondition, and so test runs stop appending to the production diagnostic
// log (Forge delta audit H-B, M-E — the log was 7 lines, all of them test noise).
const WORK_JSON = process.env.LIFEOS_WORK_JSON
  || join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE', 'work.json');
const SELFHEAL_LOG = process.env.LIFEOS_SELFHEAL_LOG
  || join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'OBSERVABILITY', 'hook-selfheal.jsonl');
const STATE_DIR = join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE', 'isa-nudge');
const SKILLS_DIR = join(CLAUDE_DIR, 'skills');
const INDEX_PATH = join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE', 'skill-usewhen-index.json');

const STALE_ISA_THRESHOLD = 15;            // tool calls with zero ISA edits (run-scoped)
const LATE_ISA_THRESHOLD = 25;             // tool calls with NO registered run (always-on, once)
const LATE_ISA_REARM = 75;                 // re-arm late-ISA when calls elapsed while no run (v3.7.2, public issue #2074, PR #2083)
const COOLDOWN_MS = 5 * 60 * 1000;         // default per-nudge-type
const ROUTE_COOLDOWN_MS = 60 * 60 * 1000;  // per-skill routing cooldown
const INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ROUTING_LOG_CAP_BYTES = 512_000;     // telemetry stops appending past this (Forge audit)
const ROUTE_MAX_MATCHES = 6;               // more matches than this = generic prompt = noise
const ISA_PATH_RE = /(?:^|\/)(?:ISA\.md|bunker\.isa\.md)$/i;
/** Exported for the L-A coverage gap: a break here makes stale-isa fire forever. */
export const ISA_PATH_RE_FOR_TEST = ISA_PATH_RE;
/**
 * A run is LIVE when its derived ascent state is on the wall. Resolved through
 * `deriveAscent` — never a hand-listed phase set (doctrine v8.17.2 § Telemetry:
 * "Never hand-list phase names anywhere").
 *
 * The hand-listed version here held the RETIRED 8-station vocabulary
 * (observe/think/plan/build/execute/verify) while live ISAs wrote
 * marking/climbing/learn/complete, so no run resolved as active and every
 * run-scoped row went silent: last `stale-isa` fire 2026-07-23, and
 * `toolCallsSinceISAEditAbs` sat at 0 across all 392 recorded sessions
 * (measured 2026-07-30). Same class as the isa-utils fix of 2026-07-27, which
 * this file missed.
 */
const IN_FLIGHT: ReadonlySet<AscentState> = new Set<AscentState>(['marking', 'ascending', 'anchoring']);
const CAPABILITIES_PATH = process.env.LIFEOS_CAPABILITIES_PATH
  || join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE', 'capabilities.json');
const CAP_COOLDOWN_MS = 60 * 60 * 1000;    // per-capability; moment-of-need, never nagging
const SILENCE_TRACE_THRESHOLD = 100;       // delegate events with zero primary before tracing
const SKILL_GAP_THRESHOLD = 40;            // primary tool calls before a skill-less session is worth a question
const SKILL_GAP_GLOBAL_COOLDOWN_MS = 12 * 60 * 60 * 1000;  // cross-session; a declined proposal must not re-nag
/**
 * A test run must never write the real stamp or the real corpus. Both are cross-session
 * state, so a suite that touched them would silence the row in live sessions for twelve
 * hours and file fake evidence for SuggestSkills — caught live: a self-test session id
 * sat in the production corpus. Under `bun test` the defaults resolve to '' (writes and
 * the cooldown read are skipped); a test that wants the real behavior sets the env vars
 * to its own scratch paths, which still win.
 */
const IN_TEST = process.env.NODE_ENV === 'test';
const SKILL_GAP_STAMP = process.env.LIFEOS_SKILL_GAP_STAMP
  || (IN_TEST ? '' : join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE', 'skill-gap-nudge.json'));
const SKILL_GAP_LOG = process.env.LIFEOS_SKILL_GAP_LOG
  || (IN_TEST ? '' : join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'OBSERVABILITY', 'skill-gap-candidates.jsonl'));

// Destructive-infra ops (Algorithm criterion 16, v8.7.0 — deleting workers deleted the apex
// DNS record their custom domain owned; every warm-cache probe passed while the world
// went NXDOMAIN).
// Matches Bash commands that delete cloud infra resources; fires the
// ownership-enumeration + authority-re-list + baseline-parity question.
export const DESTRUCTIVE_INFRA_RE = new RegExp([
  /\bwrangler(?:@[\w.^~-]+)?\s+(?:[\w:-]+\s+)*delete\b/.source,            // wrangler delete, r2 bucket delete, d1 delete, kv namespace delete, pages project delete
  /\bcf\s+(?:zones|dns\s+records|registrar)\s+[\w-]*delete[\w-]*\b/.source, // cf CLI destructive subcommands
  // cf CLI replaced Wrangler 2026-09-29: any `cf … delete` / `bulk-delete` (workers, d1, r2 buckets and objects,
  // kv namespaces, queues, pages projects…), bare, via bunx, pinned, or forwarded by CfEnv.ts.
  /(?<![\w.-])cf(?:@[\w.^~-]+)?\s+(?:[\w:-]+\s+)*(?:bulk-)?delete\b/.source,
  /\bCfEnv\.ts\s+(?:[\w:-]+\s+)*(?:bulk-)?delete\b/.source,
  /-X\s*DELETE\b[^|;&\n]*(?:workers\/(?:scripts|domains|services)|dns_records|custom_domains?|r2\/buckets|d1\/database|pages\/projects|zones\/)/i.source, // raw CF API deletes
].join('|'), 'i');
// Articulation-missing (Algorithm v8.31.0 criteria 1 and 6 + Events row; ISAFormat
// v2.28.0 § The Ideal State ladder). Fires when an ISA edit lands on a PROJECT
// ISA (outside MEMORY/WORK, exact filename ISA.md — bunker.isa.md health
// contracts are exempt) whose ladder has no L1 (`### L1` under
// `## Ideal State`, or the legacy standalone `## Articulation`). Within the
// bounding rule: an on-disk section's existence is the unwritten/stale-ISA
// state class. Once per file per session (24h cooldown).
const PROJECT_ISA_RE = /(?:^|\/)ISA\.md$/;
const ARTICULATION_RE = /^###\s+L1\b|^##\s+Articulation\s*$/m;
const ARTICULATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ARTICULATION_NUDGE = 'This project ISA has no L1 in its `## Ideal State` ladder — its describe-it-in-text ideal state was never written down (ISAFormat v2.28.0). Direction comes first: before building further, write the ladder (`bun LIFEOS/TOOLS/IsaLadder.ts migrate <isa> --full` drafts it from the ISA\'s own text), run Skill("ISA","discuss <isa> discover") so the principal confirms or corrects the draft in recommended-answer rounds (criterion 6, v8.41.0), and Skill("ISA","restate") so the principal confirms L3 and L2 (criterion 1).';

// Alignment owed (Algorithm v8.41.0 criterion 6 + Events row; ISAFormat § The alignment
// loop). Fires when an ISA edit lands on an ISA.md whose own state says a Discuss round is
// owed in align or deepen mode (`IsaAlign.ts status`): a corrected restate never re-aligned,
// asks clustering, thick fog. The discover case (no ladder) stays with the articulation row
// above, and never hides an align or deepen reason on the same ISA. Within the bounding rule: Log blocks, ask fences and fog counts are on-disk state the
// model does not hold in context. Advisory; once per file per session per day. IsaAlign is required lazily
// so the hook pays its load only on ISA edits.
const ALIGNMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ALIGNMENT_NUDGE = (path: string, mode: string, depth: string, reasons: string[]) =>
  `This ISA owes a Discuss round (${mode}, ${depth}): ${reasons.join('; ')}. Before building the uncertain part, run Skill("ISA","discuss ${path} ${mode} ${depth}"): the ladder shown first, recommended-answer questions with one challenge, answers folded into the ladder the same turn. The principal's \`proceed\` overrides, logged in Decisions (criterion 6, v8.41.0). Advisory.`;

// Absence-review-missing (Algorithm v8.29.0 criterion 3 + Events row; ISAFormat
// v2.26.0 `absence` class). Fires when an ISA edit lands on ANY ISA (task or
// project) that carries `## Features` and no `absence_review:` frontmatter key
// while phase ≠ complete — the substantial-work discriminator is the on-disk
// section, never a self-declared tier. Within the bounding rule: an on-disk
// key's absence is a state the model cannot see from context. Advisory; once
// per file per session (24h cooldown).
const FEATURES_SECTION_RE = /^##\s+Features\s*$/m;
const ABSENCE_REVIEW_RE = /^absence_review:\s*\S/m;
const PHASE_COMPLETE_RE = /^phase:\s*complete\b/m;
const ABSENCE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// (advisor-consult row retired 2026-09-10 with the LifeOS Advisor agent — the principal: an
// advisor is a meta-system, not a pickable agent, and it was doing no routing. The
// model does the work itself now; there is no advisor open/close frontmatter convention.)
/** The YAML frontmatter block only — a key mentioned in the body (a criterion quoting it, a code fence) is not the key. */
function frontmatterOf(body: string): string { const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/); return m ? m[1] : ''; }
const ABSENCE_NUDGE = 'This `## Features` ISA has no `absence_review:` key — its anti-criteria were never seeded by a mind that did not see the criteria (Algorithm v8.29.0 criterion 3; ISAFormat v2.26.0). Run the absence pass (ISA Scaffold § Absence pass: one non-forked fresh reviewer briefed from the Ideal State ladder, Problem, Vision, Constraints, Out of Scope only), or log the skip as a Decisions row and set `absence_review: skipped — <reason>`. Advisory only.';

const DESTRUCTIVE_INFRA_NUDGE = 'A destructive infra op just ran (criterion 16). Three questions before anything closes on it: (1) what did that resource OWN per the provider\'s authority API — DNS records, routes, domains, bindings? A dependent record "already existing" is not evidence it survives the delete. (2) Re-list from the authority post-op — a probe through a warm cache is not the authority. (3) Does the flow that resource served still run at its measured baseline? One synthetic event is not parity.';

// Doctor-manifest capabilities → the command shapes that exercise them.
// Fed by LIFEOS/TOOLS/Doctor.ts (v2 design, #1461): broken fires once with the
// fix command, declined and live are ALWAYS silent, absent manifest is silent.
const CAP_COMMAND_RES: Array<{ id: string; re: RegExp }> = [
  { id: 'codex', re: /\bcodex\b/ },
  // cf (Wrangler's replacement, 2026-09-29) only at command position, so `rg cf src` is not a Cloudflare call.
  { id: 'cloudflare', re: /\bwrangler\b|(?:^|[;&|(]|\bbunx)\s*(?:\S*\/)?cf(?:@\S+)?\s+[a-z]|\bCfEnv\.ts\b/ },
  // Both hostnames: source now builds this URL from PULSE_BASE (127.0.0.1),
  // but hand-typed curls and older scripts still say localhost.
  // public issue #1618, @asdf8675309
  { id: 'voice', re: /(?:localhost|127\.0\.0\.1):31337\/notify/ },
  { id: 'interceptor', re: /\binterceptor\b/ },
];

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  /** Present ONLY on a delegate's tool events — the discriminator (2026-07-30). */
  agent_id?: string;
  agent_type?: string;
  /** Session carrier, when the harness supplies it on UserPromptSubmit (same
   *  field ModelDriftGuard consumes; named ModelRungGuard until 2026-08-19). */
  model?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  transcript_path?: string;
}

interface NudgeState {
  toolCallsSinceISAEdit: number;
  /** True calls-since-last-ISA-edit. Unlike toolCallsSinceISAEdit (which
   *  self-resets when the stale-isa nudge fires, so it can't re-nag), this
 *  resets ONLY on a genuine ISA edit. ISACloseGate, retired 2026-09-21, read it (Stop) to judge
   *  whether a completed piece of work left the ISA stale. */
  toolCallsSinceISAEditAbs: number;
  toolCallsTotal: number;
  lateISAFired: boolean;
  /** toolCallsTotal at the last late-ISA fire; the row re-arms LATE_ISA_REARM
   *  calls later while still no run is registered (public issue #2074,
   *  @mefsnef; PR #2083, @Bowlerjim). */
  lateISAFiredAtCalls?: number;
  /** True while an OPEN run is bound to this session. The open→closed edge
   *  restarts the untracked-work clock (Forge audit H1). */
  runWasOpen?: boolean;
  /** Delegate-vs-primary event tallies. A session that only ever sees delegate
   *  events is one whose top-level loop is itself an SDK agent — every tool-event
   *  row is silent for it, and silence is the one failure this system never
   *  notices, so it gets a trace (Forge audit M1). */
  delegateEvents?: number;
  primaryEvents?: number;
  silenceLogged?: boolean;
  /** Set permanently the first time this session invokes the Skill tool. The
   *  skill-gap row's central gate: a session that reached for a skill at all is
   *  not the session that needs to be asked whether one is missing. */
  skillInvoked?: boolean;
  /** Set when the skill-routing row fires. The two rows are opposites — one says
   *  "a skill covers this, use it", the other "nothing covers this, build one" —
   *  and emitting both in one session is a contradiction, not two data points. */
  routeMatched?: boolean;
  /** Primary tool calls, monotonic. Unlike toolCallsTotal (which resets on the
   *  run-closed edge), this only ever counts up, so the skill-gap substance floor
   *  measures the whole session's work and not the stretch since a run closed. */
  primaryCalls?: number;
  skillGapFired?: boolean;
  lastNudgeAt: Record<string, number>;
  /** The primary conversation's transcript_path, recorded at UserPromptSubmit —
   *  the one event that never fires for subagents. Tool events whose
   *  transcript_path differs are subagent activity: stay silent (Forge audit
   *  2026-07-11: nudges were leaking into delegation fan-outs). */
  primaryTranscript?: string;
}

interface ActiveSession {
  slug: string;
  phase: string;
  /** Derived run state — the same value the tab, status line and board show. */
  ascent: AscentState;
}

interface SkillIndex {
  builtAt: number;
  gen: string;
  entries: Array<{ skill: string; phrases: string[] }>;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch { return fallback; }
}

/** session_id must be a plain token — anything else (traversal, separators)
 *  is refused outright (Forge audit 2026-07-11, finding 3). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function loadState(sessionId: string): NudgeState {
  const s = readJson<Partial<NudgeState>>(join(STATE_DIR, `${sessionId}.json`), {});
  return {
    toolCallsSinceISAEdit: s.toolCallsSinceISAEdit ?? (s as any).toolCallsSinceIsaEdit ?? 0,
    toolCallsSinceISAEditAbs: s.toolCallsSinceISAEditAbs ?? (s as any).toolCallsSinceIsaEditAbs ?? 0,
    toolCallsTotal: s.toolCallsTotal ?? 0,
    lateISAFired: s.lateISAFired ?? (s as any).lateIsaFired ?? false,
    lateISAFiredAtCalls: s.lateISAFiredAtCalls ?? 0,
    runWasOpen: s.runWasOpen ?? false,
    delegateEvents: s.delegateEvents ?? 0,
    primaryEvents: s.primaryEvents ?? 0,
    silenceLogged: s.silenceLogged ?? false,
    skillInvoked: s.skillInvoked ?? false,
    routeMatched: s.routeMatched ?? false,
    primaryCalls: s.primaryCalls ?? 0,
    skillGapFired: s.skillGapFired ?? false,
    lastNudgeAt: s.lastNudgeAt ?? {},
    primaryTranscript: s.primaryTranscript,
  };
}

function saveState(sessionId: string, state: NudgeState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state));
  } catch {}
}

/** Tracked = an ISA backs the row. The `isa` pointer is the tracked marker
 *  everywhere else in the system (isa-utils, ascent derivation), so gating on
 *  it here cannot drift independently. Replaces the retired currentMode marker,
 *  which ISASync stopped writing 2026-07-14 (agents-dashboard redesign) —
 *  gating on it silenced mid-run nudges for exactly the runs they exist for.
 *  Pure; exported for tests. */
export function isTrackedRow(s: Record<string, unknown>): boolean {
  return typeof s.isa === 'string' && s.isa.length > 0;
}

/** The row's derived run state — the same call every other surface makes. */
export function rowAscent(s: Record<string, unknown>): AscentState {
  const pm = String(s.progress ?? '').match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  return deriveAscent({
    phase: String(s.phase ?? s.currentPhase ?? ''),
    tracked: true,
    active: true,
    done: pm ? Number(pm[1]) : 0,
    total: pm ? Number(pm[2]) : 0,
  });
}

/** A tracked row still on the wall. Pure; exported for tests. */
export function isInFlightRow(s: Record<string, unknown>): boolean {
  return isTrackedRow(s) && IN_FLIGHT.has(rowAscent(s));
}

/**
 * Does an ISA-backed row carry this session UUID, and is it closed?
 *
 * This is NOT a suppressor — that was the H1 blackout. It answers the only
 * question the closed case needs: "no run was ever written" and "your run closed
 * and you kept working" are different situations that were getting the SAME
 * instruction. `late-isa` told a session holding a fully populated ISA at 23/23
 * to "scaffold the ISA now" — a wrong instruction where the old code merely said
 * nothing (Forge delta audit H-A, observed live on this run's own session).
 */
function closedRunFor(sessionId: string): { progress: string } | null {
  const reg = readJson<{ sessions?: Record<string, Record<string, unknown>> }>(WORK_JSON, {});
  for (const s of Object.values(reg.sessions || {})) {
    if ((s.sessionUUID as string) !== sessionId) continue;
    if (!isTrackedRow(s)) continue;
    return { progress: String(s.progress ?? '') };
  }
  return null;
}

/**
 * Find the OPEN run bound to this harness session UUID — tracked and still on
 * the wall. `registry` is injectable so the regression tests exercise THIS
 * function rather than only the extracted predicates (Forge audit M3: deleting
 * the tracked check left all 50 tests green).
 *
 * There is deliberately no `hasRegisteredRun` companion any more. It used to
 * gate `late-isa` on "was a run EVER written", which combined with this
 * function to black out a session completely the moment its run closed: a
 * closed row is not in flight, so `stale-isa` was impossible, and it was still
 * tracked, so `late-isa` stayed suppressed — no third path, for the rest of the
 * session (Forge audit H1; 6 of 24 live UUIDs were in that state, one at 348
 * tool calls, including the run that found it). The untracked-work clock now
 * RESTARTS when a run closes, which re-arms `late-isa` for the next stretch
 * while still keeping it quiet in the moments right after a completion — the
 * 2026-07-12 misfire this originally guarded against.
 */
export function activeAlgorithmSession(
  sessionId: string,
  registry?: { sessions?: Record<string, Record<string, unknown>> },
): ActiveSession | null {
  const reg = registry ?? readJson<{ sessions?: Record<string, Record<string, unknown>> }>(WORK_JSON, {});
  const sessions = reg.sessions || {};
  for (const [slug, s] of Object.entries(sessions)) {
    if ((s.sessionUUID as string) !== sessionId) continue;
    if (!isInFlightRow(s)) continue;
    return { slug, phase: String(s.phase ?? s.currentPhase ?? ''), ascent: rowAscent(s) };
  }
  return null;
}

function cooled(state: NudgeState, type: string, now: number, ms: number = COOLDOWN_MS): boolean {
  return now - (state.lastNudgeAt[type] || 0) >= ms;
}

function fire(state: NudgeState, type: string, now: number, text: string, out: string[]): void {
  state.lastNudgeAt[type] = now;
  out.push(text);
}

// ── Skill-routing index ──────────────────────────────────────────────────────

/** Extract USE WHEN trigger phrases from a SKILL.md frontmatter description.
 *  Pure; exported for tests. */
export function parseUseWhen(description: string): string[] {
  const m = description.match(/USE WHEN\s+([\s\S]*?)(?:\.\s*NOT FOR|$)/i);
  if (!m) return [];
  return m[1]
    // Case-sensitive ` OR ` separates triggers ("sigma or yara" stays one phrase)
    // (public issue #2183, @drpaulobernardy); a description with no NOT FOR keeps
    // the YAML closing quote on its last phrase (public issue #2179, @drpaulobernardy).
    .split(/[,·]| OR /)
    .map(p => p.trim().toLowerCase().replace(/["'”]+$/, '').replace(/\.$/, ''))
    // floor 6 matches the matchSkills floors — shorter phrases are dead index
    // weight (Forge audit 2026-07-11, finding 5)
    .filter(p => p.length >= 6 && p.length <= 60);
}

/** Generic English words that are legitimate USE WHEN triggers for a human
 *  reading a skill list but pure noise as automatic single-word matchers —
 *  they fire on ordinary prose (Forge audit 2026-07-11, finding 2). Multiword
 *  phrases containing them still match. Tune from the routing telemetry. */
const ROUTE_STOPWORDS = new Set([
  'research', 'analyze', 'analysis', 'network', 'profile', 'metrics', 'revenue',
  'calendar', 'schedule', 'upgrade', 'extract', 'develop', 'improve', 'content',
  'monitor', 'opinion', 'reminder', 'comment', 'summary', 'publish', 'deploy',
  'search', 'review', 'install', 'update', 'create', 'archive', 'projects',
  'expenses', 'recordings', 'critique', 'knowledge',
]);

/** Deterministic phrase match with noise guards (D3 in the run ISA):
 *  multiword phrases ≥7 chars → substring; single words ≥6 chars → word boundary.
 *  >ROUTE_MAX_MATCHES skills matching = generic prompt = return [].
 *  Pure; exported for tests. */
export function matchSkills(prompt: string, index: SkillIndex): Array<{ skill: string; phrase: string }> {
  const p = prompt.toLowerCase();
  const hits: Array<{ skill: string; phrase: string }> = [];
  for (const { skill, phrases } of index.entries) {
    let best: string | null = null;
    for (const phrase of phrases) {
      const multiword = phrase.includes(' ');
      if (multiword) {
        if (phrase.length >= 7 && p.includes(phrase)) {
          if (!best || phrase.length > best.length) best = phrase;
        }
      } else if (phrase.length >= 6 && !ROUTE_STOPWORDS.has(phrase)) {
        // Unicode-safe boundary — see boundedPhraseRe. The mute miss it fixes was
        // in the one nudge whose whole job is catching forgotten capabilities
        // (public issue #1787, @xmasyx; fix confirmed by @waveman2020-sudo).
        const re = boundedPhraseRe(phrase);
        if (re && re.test(p)) {
          if (!best || phrase.length > best.length) best = phrase;
        }
      }
    }
    if (best) hits.push({ skill, phrase: best });
  }
  if (hits.length === 0 || hits.length > ROUTE_MAX_MATCHES) return [];
  return hits.sort((a, b) => b.phrase.length - a.phrase.length).slice(0, 3);
}

/** Skills the user hid from the model in settings `skillOverrides` ("off" or
 *  "user-invocable-only"). A nudge toward one tells the model to call a skill it
 *  cannot call (public issue #2265, @MatiasBarboza). Unreadable settings hide nothing. */
export function hiddenSkills(claudeDir: string = CLAUDE_DIR): Set<string> {
  const hidden = new Set<string>();
  for (const name of ["settings.json", "settings.local.json"]) {
    try {
      const o = JSON.parse(readFileSync(join(claudeDir, name), "utf-8"))?.skillOverrides;
      if (!o || typeof o !== "object") continue;
      for (const [skill, mode] of Object.entries(o)) {
        if (mode === "off" || mode === "user-invocable-only") hidden.add(skill);
      }
    } catch { /* missing or malformed settings: nothing hidden */ }
  }
  return hidden;
}

/** Build the index by scanning skills/*\/SKILL.md frontmatter. Slow path only —
 *  invoked via --rebuild-index (detached from the hot path). */
export function buildIndex(): SkillIndex {
  const entries: SkillIndex['entries'] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(SKILLS_DIR); } catch { /* no skills dir */ }
  const hidden = hiddenSkills();
  for (const dir of dirs) {
    if (hidden.has(dir)) continue;
    const skillMd = join(SKILLS_DIR, dir, 'SKILL.md');
    try {
      if (!existsSync(skillMd)) continue;
      const head = readFileSync(skillMd, 'utf-8').slice(0, 4096);
      const fm = head.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      // The model cannot invoke these; never route it toward one (public issue #2265).
      if (/(?:^|\n)disable-model-invocation:\s*true\b/.test(fm[1])) continue;
      // Anchored to line start: a nested `metadata.short-description:` key
      // (Codex catalog projection, 2026-09-08) contains the substring
      // `description:` and, unanchored, captured a string with no USE WHEN —
      // every skill was skipped and the index rebuilt to zero entries.
      const desc = fm[1].match(/(?:^|\n)description:\s*([\s\S]*?)(?:\n[a-zA-Z_-]+:|$)/);
      if (!desc) continue;
      const phrases = parseUseWhen(desc[1]);
      if (phrases.length > 0) entries.push({ skill: dir, phrases });
    } catch { /* skip unreadable skill */ }
  }

  // Read the current generation and store it in the index
  const gen = readSkillGeneration();

  return { builtAt: Date.now(), entries, gen } as unknown as SkillIndex;
}

/** Routing-fire telemetry — the tuning instrument for the noise floors
 *  (Forge audit 2026-07-11, finding 2: tune from real fire-rate data). */
/**
 * Cross-session gate for the skill-gap row. Per-session `lastNudgeAt` cannot rate-limit
 * a row that fires once per session by construction — a run of short sessions would ask
 * the same question every time. The stamp lives outside session state for that reason.
 * Fails OPEN: an unreadable or malformed stamp must never permanently silence the row.
 */
function skillGapCooled(now: number): boolean {
  try {
    if (!SKILL_GAP_STAMP || !existsSync(SKILL_GAP_STAMP)) return true;
    const v = JSON.parse(readFileSync(SKILL_GAP_STAMP, 'utf-8')) as { lastFiredAt?: number };
    if (typeof v.lastFiredAt !== 'number' || !Number.isFinite(v.lastFiredAt)) return true;
    return now - v.lastFiredAt >= SKILL_GAP_GLOBAL_COOLDOWN_MS;
  } catch { return true; }
}

/**
 * Record the fire: the stamp (rate limit) and one corpus row for SuggestSkills.
 * The row carries COUNTS AND IDENTIFIERS ONLY — never prompt text, file paths, or
 * anything the user typed. The corpus exists to establish recurrence, and recurrence
 * needs no content; writing content here would put user work into a store nothing
 * redacts on the way out.
 */
function recordSkillGap(sessionId: string, calls: number, now: number): void {
  try {
    if (!SKILL_GAP_STAMP) throw new Error('no stamp path');
    mkdirSync(dirname(SKILL_GAP_STAMP), { recursive: true });
    writeFileSync(SKILL_GAP_STAMP, JSON.stringify({ lastFiredAt: now }));
  } catch { /* rate limiting is best-effort; never break the session */ }
  try {
    if (!SKILL_GAP_LOG) throw new Error('no log path');
    mkdirSync(dirname(SKILL_GAP_LOG), { recursive: true });
    appendFileSync(SKILL_GAP_LOG, JSON.stringify({
      ts: new Date(now).toISOString(),
      session_id: sessionId,
      calls,
    }) + '\n');
  } catch { /* telemetry is best-effort */ }
}

const SKILL_GAP_NUDGE = (calls: number) =>
  `${calls} tool calls this session, the Skill tool never invoked, and no skill's USE WHEN matched. `
  + `Before you answer: does a skill already cover this work class? Read the candidate bodies — a name `
  + `match is not coverage. If nothing covers it and the class will recur, propose ONE skill in a sentence `
  + `and offer CreateSkill. If it is one-off or already covered, say nothing.`;

/**
 * Routing-fire telemetry. Counts and identifiers only, the same rule as
 * recordSkillGap above: the prompt's length, never its text (a hooks audit
 * dropped the 80-char prompt_head). `fired` holds skill names and
 * USE WHEN phrases from our own skill index, never user input. The file is 0600
 * and an existing looser file is tightened on every write (idempotent repair).
 */
export function logRoutingFire(
  sessionId: string,
  prompt: string,
  matches: Array<{ skill: string; phrase: string }>,
  path: string = join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'OBSERVABILITY', 'algo-nudge-routing.jsonl'),
): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session: sessionId.slice(0, 8),
      prompt_chars: prompt.length,
      fired: matches.map(m => `${m.skill}:${m.phrase}`),
    });
    // Bounded append (Forge audit 2026-07-11): tuning telemetry, not a system of
    // record. Newest lines are lost when full; that's fine for floor-tuning.
    if (existsSync(path)) {
      const st = statSync(path);
      if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
      if (st.size > ROUTING_LOG_CAP_BYTES) return;
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    writeFileSync(path, line + '\n', { flag: 'a', mode: 0o600 });
  } catch {}
}

// ISC-15b: maintained generation for skill freshness + fallback check for SKILL.md edits
interface SkillGenerationFile {
  gen: string;
  lastFallbackCheck: number;
}

const SKILL_FALLBACK_CHECK_MS = 60_000;
let lastSkillFallbackCheckMs = 0;
const SKILL_GENERATION_PATH = join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE', 'skill-generation.json');

/** Read the maintained generation for skills. Bumped by writers after changes. */
function readSkillGeneration(): string {
  try {
    if (existsSync(SKILL_GENERATION_PATH)) {
      const data = JSON.parse(readFileSync(SKILL_GENERATION_PATH, 'utf-8')) as SkillGenerationFile;
      return data.gen || '0';
    }
  } catch { /* corrupt or missing → fallback will regenerate */ }
  return '0';
}

/** Write skill generation (used by writers and fallback checker). */
function writeSkillGeneration(gen: string): void {
  try {
    mkdirSync(dirname(SKILL_GENERATION_PATH), { recursive: true });
    writeFileSync(SKILL_GENERATION_PATH, JSON.stringify({ gen, lastFallbackCheck: Date.now() } satisfies SkillGenerationFile));
  } catch { /* generation write is best-effort */ }
}

/** Fallback check: walk SKILL.md mtimes once per 60s to catch out-of-band edits. */
function checkAndBumpSkillGenerationIfChanged(): void {
  const now = Date.now();
  if (now - lastSkillFallbackCheckMs < SKILL_FALLBACK_CHECK_MS) return;
  lastSkillFallbackCheckMs = now;

  let newestMtime = 0;
  try {
    for (const dir of readdirSync(SKILLS_DIR)) {
      try {
        const t = statSync(join(SKILLS_DIR, dir, 'SKILL.md')).mtimeMs;
        if (t > newestMtime) newestMtime = t;
      } catch { /* not a skill dir */ }
    }
  } catch { /* no skills dir */ }
  // Hiding a skill in settings changes the index too (public issue #2265).
  for (const name of ["settings.json", "settings.local.json"]) {
    try { const t = statSync(join(CLAUDE_DIR, name)).mtimeMs; if (t > newestMtime) newestMtime = t; } catch { /* absent */ }
  }

  if (newestMtime > 0) {
    const currentGen = readSkillGeneration();
    const currentTime = Number(currentGen.split(':')[1] || '0');
    if (newestMtime > currentTime) {
      const newGen = `fallback:${newestMtime}`;
      writeSkillGeneration(newGen);
    }
  }
}

/** Public API for writers to bump skill generation after writing SKILL.md. */
export function bumpSkillGeneration(): void {
  const gen = `writer:${Date.now()}`;
  writeSkillGeneration(gen);
}

/** Check if skill index is fresh by generation. */
function isSkillIndexFresh(index: SkillIndex | null): boolean {
  if (!index) return false;

  // Run fallback check once per 60s
  checkAndBumpSkillGenerationIfChanged();

  // Check generation matches
  const currentGen = readSkillGeneration();
  const indexGen = (index as unknown as { gen?: string }).gen || '';
  if (currentGen !== indexGen) return false;

  // Index is older than six hours
  if (Date.now() - index.builtAt > INDEX_MAX_AGE_MS) return false;

  return true;
}

/** Load the index if fresh; kick a detached rebuild if stale/missing (never block).
 *  ISC-15b: freshness check uses maintained generation with fallback for out-of-band edits. */
function loadIndex(): SkillIndex | null {
  const idx = readJson<SkillIndex | null>(INDEX_PATH, null);
  const fresh = isSkillIndexFresh(idx);
  if (fresh) {
    return idx;
  }

  // Index is missing or stale — kick a detached rebuild
  const bun = resolveBun();
  try {
    Bun.spawn([bun, import.meta.path, '--rebuild-index'],
      { windowsHide: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
  } catch (e) {
    // Never block the turn, but never swallow silently either — a failed
    // self-heal must leave a trace something can see.
    try {
      appendFileSync(
        lifeosPath('MEMORY', 'OBSERVABILITY', 'hook-selfheal.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), hook: 'AlgorithmNudge', action: 'rebuild-index', bun, error: String(e) }) + '\n',
      );
    } catch { /* observability write itself is best-effort */ }
  }
  return idx; // stale index still usable this turn; missing → null → skip routing
}

// ── The nudge logic ──────────────────────────────────────────────────────────

/** Returns the joined nudge text for this event, or null. No exit, no stdout. */
/** Gate predicates — deliberately DISTINCT (Forge audit 2026-07-11, finding 1:
 *  a shared predicate silently narrowed the principal nudge, now cut). Exported for tests. */
export function routeSuppressed(p: string): boolean {
  return /^[</]/.test(p) || p.length < 15; // commands + short acks: not routing material
}

// ── Depth directive (always-on, no-run turns) ────────────────────────────────

/** Past this length the doctrine matcher scans only the head/tail windows (same bound as Depth.ts). */
const HEAD_TAIL_MAX_PROMPT = 1500;

/** Depth gets its own suppression: only command/tag prefixes. routeSuppressed's
 *  15-char floor would eat bare directives ("go deep", "ultrathink") — and a bare
 *  directive is the most common form of the steering this row exists to catch
 *  (post-ship audit 2026-07-12). The phrase match itself is the content floor. */
export function depthSuppressed(p: string): boolean {
  return /^[</]/.test(p);
}

// ── Doctrine-class (always-on, no-run turns) ────────────────────────────────
// AlgorithmReference § Events row: "A prompt asks for judgment about the thinking
// system itself — the Algorithm, ISA doctrine, standing rules". Advice there
// inherits the blast radius of what it advises. The row was documented as
// always-on but had no executable branch until 2026-09-10 (core-loop audit,
// finding 9): a "deep analysis of the algorithm and the ISA system" prompt fired
// only the depth row. Same discipline as depth: bounded phrases, fences stripped,
// head/tail windows on long prompts, one advisory line on a false positive.
const DOCTRINE_SUBJECTS = [
  'the algorithm', 'our algorithm', 'algorithm doctrine', 'the isa system', 'isa doctrine', 'isa format',
  'the isa format', 'our isas', 'the thinking system', 'our thinking system', 'the system prompt',
  'standing rules', 'operational rules', 'operational_rules', 'claude.md', 'the hook system', 'our hooks',
  'hook system', 'the eval system', 'our eval system', 'the nudge', 'the nudges', 'algorithmnudge',
  'progressive loading', 'progressive context', 'context loading', 'the doctrine', 'our doctrine',
  'lifeos core', 'the core loop',
];
const DOCTRINE_JUDGMENT_RE = /\b(analy[sz]e|analysis|assess|audit|review|critique|evaluate|improve|optimi[sz]e|redesign|rethink|restructure|simplify|change|should (?:we|i|it|the)|what do you think|is it (?:right|worth|time)|how (?:should|could|would) (?:we|i)|what would you (?:change|do|cut))\b/;

export function matchDoctrineClass(prompt: string): string | null {
  const stripped = stripFences(prompt);
  const p = (stripped.length > HEAD_TAIL_MAX_PROMPT
    ? stripped.slice(0, 300) + '\n' + stripped.slice(-400)
    : stripped).toLowerCase();
  if (!DOCTRINE_JUDGMENT_RE.test(p)) return null;
  for (const subject of DOCTRINE_SUBJECTS) {
    const re = boundedPhraseRe(subject);
    if (re && re.test(p)) return subject;
  }
  return null;
}

interface CapManifest {
  capabilities: Record<string, { state?: string }>;
}

// Static fix commands, keyed by capability id — MIRRORS the CAPS registry in
// LIFEOS/TOOLS/Doctor.ts (like the Pulse module's CAP_TITLES mirror). Sourced
// here as compile-time constants so the nudge NEVER pulls a runnable command
// string out of the on-disk manifest. Forge audit 2026-07-12: the manifest is
// a file, this text lands in the model's context, so a poisoned manifest must
// be able to flip a *state* at most — never inject prose the model might run.
const CAP_FIX: Record<string, string> = {
  codex: 'bun install -g @openai/codex && codex login',
  cloudflare: 'add CLOUDFLARE_API_TOKEN to <configRoot>/.env, then: bun LIFEOS/TOOLS/Doctor.ts --network',
  voice: 'set fish_reference_id under [da.voices.main] in LIFEOS_CONFIG.toml, then: bun LIFEOS/TOOLS/Doctor.ts --network',
  interceptor: 'install Google Chrome (or Brave), then re-run: bun LIFEOS/TOOLS/Doctor.ts',
};

/** Pure: which capability nudge (if any) does this failed command earn?
 *  broken → one line with the STATIC fix; declined/live/stale/absent → null.
 *  Reads ONLY `state` from the manifest — no manifest string reaches the model. */
export function capabilityNudgeFor(command: string, manifest: CapManifest): { id: string; text: string } | null {
  if (!command) return null;
  for (const { id, re } of CAP_COMMAND_RES) {
    if (!re.test(command)) continue;
    const entry = manifest.capabilities?.[id];
    if (!entry || entry.state !== 'broken') return null;
    const fix = CAP_FIX[id] ? ` Fix: ${CAP_FIX[id]}` : '';
    return {
      id,
      text: `That failure touched the "${id}" capability, which Doctor has as BROKEN.${fix} Or opt out for good: bun LIFEOS/TOOLS/Doctor.ts decline ${id}.`,
    };
  }
  return null;
}

export function run(input: HookInput): string | null {
  if (HEADLESS) return null;
  try {
    const sessionId = input.session_id || '';
    const event = input.hook_event_name || '';
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;

    const now = Date.now();
    const state = loadState(sessionId);
    const active = activeAlgorithmSession(sessionId);
    const out: string[] = [];

    if (event === 'UserPromptSubmit') {
      // Only the primary conversation receives UserPromptSubmit — record its
      // transcript so tool events can be primary-gated below.
      if (input.transcript_path) state.primaryTranscript = input.transcript_path;
      const p = (input.prompt || '').trim();
      // A slash-command prompt routes the turn explicitly — a skill or command is
      // driving it, and the harness can load a skill from that path with no Skill
      // tool call to observe. Treating it as skill-less would fire skill-gap on a
      // `/rc` session, burn the 12h cooldown, and file a fabricated row in the
      // corpus SuggestSkills weighs highest. `routeSuppressed` already scopes slash
      // commands out for the same reason.
      if (p.startsWith('/')) state.skillInvoked = true;

      // The skill-routing, depth-directive and doctrine-class rows were CUT 2026-10-25 (ISA
      // 20261025-hook-minimization, the principal: "a very low number of hooks, and then nothing but the
      // algorithm"). Each keyed on the prompt, which is in the model's context when the row fires: the
      // skill listing carries USE WHEN, depth is native (system prompt § Dynamic range), and the
      // Algorithm carries doctrine-class scrutiny. Without routeMatched, skill-gap keys on skillInvoked alone.

      // The `principal` row was CUT here (2026-07-30). Its trigger was "the
      // principal sent a message mid-run", and that message is in my context at
      // the moment the row fires — precisely what this file's own bounding rule
      // forbids: a row may only ask about state the model CANNOT observe from
      // its own context. It survived every prior review because it was DEAD
      // (same `active` gate as stale-isa), so nobody re-read it against the rule.
      // Folding his message into the ISA remains required — that is doctrine
      // criterion 14, carried by the ISA and its close gates, not by a reminder.
    }

    // Primary-only gate for tool events: subagents share the session_id but
    // carry their own transcript_path. Mismatch → subagent → silent.
    // A delegate's tool events arrive on the PARENT's session_id AND the parent's
    // transcript_path — byte-identical, probed 2026-07-30 — so the transcript
    // comparison alone can never discriminate, and every run-scoped row leaked
    // into every subagent (watched fire twice inside a review agent's context,
    // which also inflated this session's counters with the delegate's calls).
    // The harness stamps delegate tool events with `agent_id`/`agent_type` and
    // omits `effort`; the primary's carry `effort` and no `agent_id`. That flag
    // is the discriminator, verified absent on the primary for BOTH tool event
    // types (PostToolUse and PostToolUseFailure — the capability row's path).
    // The transcript compare stays as a fallback for any harness build that
    // doesn't send `agent_id`; on such a build the behaviour is exactly the old
    // one, so this can only ever tighten, never silence the primary.
    const isSubagentEvent = event !== 'UserPromptSubmit'
      && (
        !!input.agent_id
        || (!!state.primaryTranscript
          && !!input.transcript_path
          && input.transcript_path !== state.primaryTranscript)
      );
    if (event !== 'UserPromptSubmit') {
      if (isSubagentEvent) state.delegateEvents = (state.delegateEvents ?? 0) + 1;
      else state.primaryEvents = (state.primaryEvents ?? 0) + 1;
      // A session whose EVERY tool event reads as a delegate has no tool-event
      // coverage at all — every row is silent for it. That is the system's
      // signature failure (nothing breaks when a nudge doesn't fire), so it
      // leaves a trace exactly once instead of vanishing (Forge audit M1).
      // Sustained window, not the late-isa floor: PostToolUse fires when a tool
      // RETURNS, so a session whose first act is a delegation sees the delegate's
      // events while its own Agent call is still open — `primaryEvents` is
      // legitimately 0 for a while (Forge delta audit M-F).
      if (!state.silenceLogged
        && (state.delegateEvents ?? 0) >= SILENCE_TRACE_THRESHOLD
        && (state.primaryEvents ?? 0) === 0) {
        state.silenceLogged = true;
        try {
          appendFileSync(
            SELFHEAL_LOG,
            JSON.stringify({
              ts: new Date().toISOString(),
              hook: 'AlgorithmNudge',
              kind: 'all-events-classified-delegate',
              session_id: sessionId,
              delegateEvents: state.delegateEvents,
              note: 'every tool event carried agent_id — all tool-event nudge rows are silent for this session',
            }) + '\n',
          );
        } catch {}
      }
    }
    if (isSubagentEvent) { saveState(sessionId, state); return null; }

    // ALWAYS-ON: capability moment-of-need. A failed command that exercises a
    // Doctor-tracked capability, while the manifest says BROKEN, gets ONE line
    // with the fix command — at the exact moment the user paid for the gap.
    if (event === 'PostToolUseFailure' && input.tool_name === 'Bash') {
      const cmd = String((input.tool_input as Record<string, unknown>)?.command || '');
      const capNudge = capabilityNudgeFor(cmd, readJson<CapManifest>(CAPABILITIES_PATH, { capabilities: {} }));
      if (capNudge && cooled(state, `capability:${capNudge.id}`, now, CAP_COOLDOWN_MS)) {
        fire(state, `capability:${capNudge.id}`, now, capNudge.text, out);
      }
    }

    if (event === 'PostToolUse') {
      state.toolCallsTotal += 1;
      state.primaryCalls = (state.primaryCalls ?? 0) + 1;
      const tool = input.tool_name || '';
      // Reaching for a skill even once takes this session out of scope permanently.
      if (tool === 'Skill') state.skillInvoked = true;

      // ALWAYS-ON: skill-gap. The inverse of skill-routing: that row catches under-USE
      // of skills that exist, this one catches work no skill covers at all. He asked for
      // it in those terms — notice work that involved no skill and maybe should have,
      // check that none already covers it, then propose one.
      //
      // NAMED EXCEPTION to this file's bounding rule (same standing as the entry rows):
      // whether THIS turn invoked a skill is observable to the model from its own
      // context, so the row is scaffolding by the letter of the rule. He asked for it
      // explicitly, which outranks my judgment (criterion 15), and the part
      // that actually is unobservable carries the row's weight anyway — the session-wide
      // tally and the cross-session cooldown are state the model cannot see. The row
      // stays advisory and asks a question; it never names the skill, because a hook
      // cannot judge coverage. That judgment is the model's, and the line says so.
      if (!state.skillGapFired
        && !state.skillInvoked
        && !state.routeMatched
        && (state.primaryCalls ?? 0) >= SKILL_GAP_THRESHOLD
        && skillGapCooled(now)) {
        state.skillGapFired = true;
        recordSkillGap(sessionId, state.primaryCalls ?? 0, now);
        fire(state, 'skill-gap', now, SKILL_GAP_NUDGE(state.primaryCalls ?? 0), out);
      }

      const filePath = String((input.tool_input as Record<string, unknown>)?.file_path || '');

      // ALWAYS-ON: destructive infra op (criterion 16, v8.7.0). Fires on success —
      // the questions are about what must be verified AFTER the op, so run-gating
      // would miss exactly the "run already declared done" case that burned us.
      if (tool === 'Bash' && cooled(state, 'destructive-infra', now)) {
        const cmd = String((input.tool_input as Record<string, unknown>)?.command || '');
        if (DESTRUCTIVE_INFRA_RE.test(cmd)) {
          fire(state, 'destructive-infra', now, DESTRUCTIVE_INFRA_NUDGE, out);
        }
      }

      const isISAEdit = (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') && ISA_PATH_RE.test(filePath);

      // ALWAYS-ON: articulation-missing (v8.27.0). Project ISAs only — task ISAs
      // under MEMORY/WORK are exempt (Vision carries their articulation), as are
      // bunker.isa.md health contracts (filename mismatch by construction).
      if (isISAEdit
        && PROJECT_ISA_RE.test(filePath)
        && !filePath.includes('/MEMORY/WORK/')
        && cooled(state, `articulation:${filePath}`, now, ARTICULATION_COOLDOWN_MS)) {
        try {
          const isaBody = readFileSync(filePath, 'utf-8');
          if (!ARTICULATION_RE.test(isaBody)) {
            fire(state, `articulation:${filePath}`, now, ARTICULATION_NUDGE, out);
          }
        } catch { /* unreadable → silent */ }
      }

      // ALWAYS-ON: alignment owed (v8.41.0). ISA.md files only (bunker.isa.md health
      // contracts carry no ladder by design); align and deepen only.
      if (isISAEdit
        && PROJECT_ISA_RE.test(filePath)
        && cooled(state, `alignment:${filePath}`, now, ALIGNMENT_COOLDOWN_MS)) {
        try {
          const { alignmentStatus } = require('../LIFEOS/TOOLS/IsaAlign') as typeof import('../LIFEOS/TOOLS/IsaAlign');
          const st = alignmentStatus(readFileSync(filePath, 'utf-8'), filePath);
          // A discover reason never hides an align or deepen one (the articulation row owns discover).
          const owed = st.reasons.filter((r) => r.mode !== 'discover');
          if (owed.length) {
            const mode = owed.some((r) => r.mode === 'align') ? 'align' : 'deepen';
            fire(state, `alignment:${filePath}`, now, ALIGNMENT_NUDGE(filePath, mode, mode === 'align' ? 'quick' : 'full', owed.map((r) => r.text)), out);
          }
        } catch { /* unreadable or unparsable → silent */ }
      }

      // ALWAYS-ON: absence-review-missing (v8.29.0). Any ISA carrying
      // `## Features` with no `absence_review:` key and phase ≠ complete.
      // Advisory; the discriminator is the on-disk section. 24h cooldown.
      if (isISAEdit
        && cooled(state, `absence:${filePath}`, now, ABSENCE_COOLDOWN_MS)) {
        try {
          const isaBody = readFileSync(filePath, 'utf-8');
          if (FEATURES_SECTION_RE.test(isaBody) && !ABSENCE_REVIEW_RE.test(frontmatterOf(isaBody)) && !PHASE_COMPLETE_RE.test(frontmatterOf(isaBody))) {
            fire(state, `absence:${filePath}`, now, ABSENCE_NUDGE, out);
          }
        } catch { /* unreadable → silent */ }
      }

      // (advisor-consult row retired 2026-09-10 with the LifeOS Advisor agent.)

      if (active) {
        state.runWasOpen = true;
        // stale-ISA counter
        state.toolCallsSinceISAEdit = isISAEdit ? 0 : state.toolCallsSinceISAEdit + 1;
        state.toolCallsSinceISAEditAbs = isISAEdit ? 0 : state.toolCallsSinceISAEditAbs + 1;
        if (state.toolCallsSinceISAEdit >= STALE_ISA_THRESHOLD && cooled(state, 'stale-isa', now)) {
          state.toolCallsSinceISAEdit = 0;
          fire(state, 'stale-isa', now, `${STALE_ISA_THRESHOLD}+ tool calls with zero ISA edits. Is the ISA still the true shape of done, or has the work learned something it hasn't?`, out);
        }

      } else {
        // No OPEN run. If one was open a moment ago, it just closed: restart the
        // untracked-work clock so the next stretch is covered again, and stay
        // quiet in the calls immediately after a completion (the 2026-07-12
        // misfire). Without this edge, a session went permanently dark the
        // moment its run closed — 6 of 24 live UUIDs were in that state, one at
        // 348 tool calls (Forge audit H1).
        if (state.runWasOpen) {
          state.runWasOpen = false;
          state.toolCallsTotal = 0;
          state.lateISAFired = false;
        }
        // The cooldown is what makes the 2026-07-12 misfire actually impossible
        // rather than merely expensive: the clock restart is counted in TOOL
        // CALLS, and 25 of those elapse in under a minute on parallel blocks. It
        // also bounds the row when a run's progress oscillates around N/N, which
        // reopens and recloses it repeatedly (Forge delta audit M-A, M-B).
        // Re-arm: a session that never registers a run used to get this row
        // exactly once, then silence for hours (public issue #2074, @mefsnef;
        // PR #2083, @Bowlerjim). LATE_ISA_REARM calls after the last fire, with
        // still no run, it fires again; the cooldown still paces it.
        const rearmed = state.lateISAFired
          && state.toolCallsTotal - (state.lateISAFiredAtCalls ?? 0) >= LATE_ISA_REARM;
        if ((!state.lateISAFired || rearmed)
          && state.toolCallsTotal >= LATE_ISA_THRESHOLD
          && cooled(state, 'late-isa', now)) {
          // ALWAYS-ON: late-ISA. This deep with no open run is either genuinely
          // trivial-iterative or an unwritten climb (dynamic-range audit: 2h of
          // substantive work before the ISA appeared) — or a run that closed and
          // kept going, which needs the opposite instruction.
          state.lateISAFired = true;
          state.lateISAFiredAtCalls = state.toolCallsTotal;
          const closed = closedRunFor(sessionId);
          const text = closed
            ? `${LATE_ISA_THRESHOLD}+ tool calls since your run closed at ${closed.progress || 'its last criterion'}. The work didn't stop when the ISA did — reopen it with the criteria this stretch is actually proving, or scaffold a new one.`
            : `${LATE_ISA_THRESHOLD}+ tool calls and no run registered. Still trivial, or does done need writing down? If this is a real climb, scaffold the ISA now — nudge coverage starts when it exists.`;
          fire(state, 'late-isa', now, text, out);
        }
      }
    }

    saveState(sessionId, state);
    if (out.length === 0) return null;
    return out.map(n => `🧭 ALGO-NUDGE: ${n}`).join('\n');
  } catch {
    // never block the session
    return null;
  }
}

if (import.meta.main) {
  if (process.argv.includes('--rebuild-index')) {
    try {
      const idx = buildIndex();
      mkdirSync(join(CLAUDE_DIR, 'LIFEOS', 'MEMORY', 'STATE'), { recursive: true });
      writeFileSync(INDEX_PATH, JSON.stringify(idx));
      console.log(`index: ${idx.entries.length} skills, ${idx.entries.reduce((n, e) => n + e.phrases.length, 0)} phrases`);
    } catch (e) {
      console.error(String(e));
    }
    process.exit(0);
  }
  (async () => {
    const killer = setTimeout(() => process.exit(0), 4000);
    let raw = '';
    const timer = new Promise<void>(r => setTimeout(r, 1500));
    const reader = (async () => { for await (const chunk of Bun.stdin.stream()) raw += Buffer.from(chunk).toString(); })();
    await Promise.race([reader, timer]);
    if (raw) {
      try {
        const input: HookInput = JSON.parse(raw);
        // Armed session: the prompt-time nudge runs once inside HookBridge prompt-context.
        if (input.hook_event_name === "UserPromptSubmit" && hookCovers(input.session_id ?? "", "prompt-context")) { clearTimeout(killer); process.exit(0); }
        const text = run(input);
        if (text) {
          console.log(JSON.stringify({
            hookSpecificOutput: { hookEventName: input.hook_event_name || 'PostToolUse', additionalContext: text },
          }));
        }
      } catch { /* never block */ }
    }
    clearTimeout(killer);
    process.exit(0);
  })();
}
