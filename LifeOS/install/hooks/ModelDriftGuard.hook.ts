#!/usr/bin/env bun
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * @version 2.2.4
 * TRIGGER: UserPromptSubmit
 * ModelDriftGuard — warn when the model serving this session is not the configured one.
 *
 * WHAT IT DOES: compares the model actually serving this session against the one
 * `settings.json` configures, and warns when they differ.
 *
 * WHY: on 2026-07-31 a session ran below its configured model for its
 * entire length and nothing noticed — not a hook, not a gate, not `/ic`. A full
 * subsystem analysis shipped on the wrong carrier, and the only detection in the
 * end was the principal getting angry twice. `fallbackModel` keeps that path live, and
 * the serving model is precisely the thing the loop cannot observe about itself.
 *
 * What it does NOT do: change the model, or judge what class of work is running.
 * A hook cannot set the main loop's carrier, and classifying a prompt as
 * needing more intelligence is not deterministically detectable — ~20 attempts
 * proved it. It reports one measured gap between two files and stops.
 *
 * Performance: hot-path hook. Reads a tail of the transcript, no LLM calls.
 * Failure mode: any error logs to stderr and exits 0, never blocking prompts.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { hookCovers } from "./lib/function-hooks";
import { join } from "node:path";
import { homedir } from "node:os";
import { getClaudeDir, getLifeosDir } from "./lib/paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Terminal telemetry only. Headless spawns (the texting bridge, scheduled jobs) must never receive these
// notes — on 2026-09-04 a model-drift warning and a memory-freshness line were relayed into an iMessage reply.
export const HEADLESS = !!(process.env.LIFEOS_TEXTING_SESSION || process.env.LIFEOS_NOTIFICATION_CHANNEL === "headless");
if (import.meta.main && HEADLESS) process.exit(0);


const STDIN_TIMEOUT_MS = 300;
const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const CLAUDE_ROOT = getClaudeDir();
const LIFEOS_DIR = getLifeosDir(); // resolver owns CLAUDE_CONFIG_DIR > LIFEOS_DIR precedence (public issue #1968)
const SETTINGS_PATH = join(CLAUDE_ROOT, "settings.json");
// Log path keeps its old name on purpose: IntegrityCheck, Inference, and the
// AlgorithmImprovement intent read it, and the history predates the rename.
const LOG_PATH = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "model-rung.jsonl");
/** Only the tail can hold the current session's carrier; the file grows large. */
const TAIL_BYTES = 256 * 1024;

/**
 * Model order, strongest first. Mirrors `EFFORT_MODEL` in `LIFEOS/TOOLS/models.ts`
 * (max/high/medium/low) as TIER ALIASES, never pinned model IDs — an alias
 * resolves to the latest model in its tier, which is the auto-update mechanism.
 */
const RUNGS = ["fable", "opus", "sonnet", "haiku"] as const;
type Rung = (typeof RUNGS)[number];

interface HookInput {
  transcript_path?: string;
  /**
   * The session carrier, when the harness supplies it directly on the event.
   * Preferred over the transcript scrape because it is present on turn one,
   * where the scrape is structurally blind. Absent on harness versions that
   * do not send it, which is why the transcript path remains the fallback.
   */
  model?: string;
}

async function readStdinWithTimeout(timeoutMs: number = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 10_000_000) {
        clearTimeout(timer);
        try { process.stdin.pause(); } catch { /* closed */ }
        resolve(data);
      }
    });
    process.stdin.on("end", () => { clearTimeout(timer); resolve(data); });
    process.stdin.on("error", (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

function parseHookInput(raw: string): HookInput {
  try {
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      transcript_path: typeof record.transcript_path === "string" ? record.transcript_path : undefined,
      model: typeof record.model === "string" && record.model.trim() ? record.model : undefined,
    };
  } catch {
    return {};
  }
}

/** Map any carrier string (alias or full model ID) onto its rung. */
export function rungOf(model: string | null | undefined): Rung | null {
  if (!model) return null;
  const m = model.toLowerCase();
  return RUNGS.find((r) => m.includes(r)) ?? null;
}

/** What `settings.json "model"` configures this session to run on. */
export function configuredRung(settingsPath: string = SETTINGS_PATH): Rung | null {
  try {
    if (!existsSync(settingsPath)) return null;
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    return rungOf(typeof parsed.model === "string" ? parsed.model : null);
  } catch {
    return null;
  }
}

/**
 * The carrier actually serving this session, read from the last assistant
 * message in the transcript. Null on the very first prompt, when no assistant
 * message exists yet — the check simply starts on turn two.
 *
 * Sidechain rows are skipped: a subagent writes its own `message.model` into the
 * same transcript, so a delegate dispatched to a lower rung would otherwise be
 * read as the main loop's carrier and warn about a gap that does not exist.
 * (ported from public PR #1738, @elhoim)
 */
export function liveModel(transcriptPath: string | undefined): string | null {
  let fd: number | null = null;
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    const size = statSync(transcriptPath).size;
    // Read ONLY the tail — the file reaches hundreds of MB and this is a hot path.
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(transcriptPath, "r");
    const got = readSync(fd, buf, 0, len, start);
    const tail = buf.subarray(0, got).toString("utf8");
    const lines = tail.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i] as string) as Record<string, unknown>;
        if (row.isSidechain === true) continue; // a subagent's carrier, not ours
        const msg = row.message as Record<string, unknown> | undefined;
        if (msg && typeof msg.model === "string" && msg.model.trim()) return msg.model;
      } catch { /* partial line at the tail boundary */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Positive when `live` sits below `configured`. Zero when equal or either is unknown. */
export function rungGap(configured: Rung | null, live: Rung | null): number {
  if (!configured || !live) return 0;
  return RUNGS.indexOf(live) - RUNGS.indexOf(configured);
}

function log(event: Record<string, unknown>): void {
  try {
    mkdirSync(join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY"), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf8");
  } catch { /* observability is never worth failing a prompt over */ }
}

/**
 * v2.2.0: the served model is the earliest signal a lineup changed — a session
 * on a NEWER id than the registry knows means models.ts is behind. Fire
 * `ModelSync --sync` detached (never awaited, stdio ignored, at most once a
 * day via a stamp file) so the registry and price table catch up the first
 * turn after a release, before the daily launchd job. Hot path stays a
 * version compare plus one stat; any failure is swallowed.
 */
const SYNC_STAMP = join(LIFEOS_DIR, "MEMORY", "STATE", "model-sync.trigger");
export function servedAheadOfRegistry(model: string | null | undefined, current: Record<string, string>): boolean {
  if (!model) return false;
  const bare = model.replace(/\[[^\]]*\]$/, "");
  const m = bare.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,3}))?(?:-\d{8})?$/);
  if (!m) return false;
  const reg = current[m[1]]?.match(/^claude-[a-z]+-(\d+)(?:-(\d{1,3}))?(?:-\d{8})?$/);
  if (!reg) return false;
  const served = [Number(m[2]), Number(m[3] ?? 0)];
  const have = [Number(reg[1]), Number(reg[2] ?? 0)];
  return served[0] > have[0] || (served[0] === have[0] && served[1] > have[1]);
}

function triggerRegistrySync(model: string | null | undefined): void {
  try {
    const registry = join(LIFEOS_DIR, "TOOLS", "models.ts");
    const src = readFileSync(registry, "utf8");
    const current: Record<string, string> = {};
    for (const m of src.matchAll(/^\s+(fable|opus|sonnet|haiku):\s*"([^"]+)"/gm)) current[m[1]] = m[2];
    if (!servedAheadOfRegistry(model, current)) return;
    if (existsSync(SYNC_STAMP) && Date.now() - statSync(SYNC_STAMP).mtimeMs < 86_400_000) return;
    mkdirSync(join(LIFEOS_DIR, "MEMORY", "STATE"), { recursive: true });
    appendFileSync(SYNC_STAMP, `${new Date().toISOString()} served=${model}\n`);
    log({ event: "registry-behind", model, registry: current });
    const child = Bun.spawn(["bun", join(LIFEOS_DIR, "TOOLS", "ModelSync.ts"), "--sync"], { windowsHide: true, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    child.unref();
  } catch { /* never worth failing a prompt over */ }
}

function emit(line: string): void {
  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line },
  }));
}

/** The model-drift warning line, or null when as-configured / unverified. */
export function run(rawInput: Record<string, unknown>): string | null {
  if (HEADLESS) return null;
  let out: string | null = null;
  try {
    const input = parseHookInput(JSON.stringify(rawInput));
    const configured = configuredRung();
    // Direct field first (present on turn one), transcript scrape as fallback.
    const model = input.model ?? liveModel(input.transcript_path);
    const live = rungOf(model);
    const gap = rungGap(configured, live);

    // The one thing worth saying: the model actually serving this session is not
    // the one configured for it. That is silent drift — `fallbackModel` makes it a
    // live path — and it is the only rung fact the loop cannot observe about itself.
    if (configured && live && gap !== 0) {
      log({ event: "drift", configured, live, model, gap });
      // Name-free by construction: the release sanitizer rewrites the principal's
      // name to a raw PRINCIPAL_NAME-style template token, which then showed up
      // verbatim in this user-visible warning (public issue #1724,
      // @waveman2020-sudo; literal kept out of this comment per the
      // self-referential-redaction rule — the Doctor placeholder probe scans
      // this file).
      out =
        `⚠️ MODEL DRIFT: this session is running '${model}' (${live}), not the configured ` +
          `'${configured}'. Nothing was asked for this — treat it as drift. Judgment-class work ` +
          `does not belong on a carrier you did not choose.`;
    } else {
      log({ event: live ? "as-configured" : "unverified", configured, live, model });
    }
    triggerRegistrySync(model);
  } catch (err) {
    process.stderr.write(`ModelDriftGuard error: ${(err as Error)?.message || String(err)}\n`);
  }
  return out;
}

if (import.meta.main) {
  const raw = await readStdinWithTimeout();
  let parsed: Record<string, unknown> = {};
  try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { /* empty */ }
  // Armed session: runs once inside HookBridge prompt-context, fed $.session.model().
  if (hookCovers(typeof parsed.session_id === "string" ? parsed.session_id : "", "prompt-context")) process.exit(0);
  const line = run(parsed);
  if (line) emit(line);
  process.exit(0);
}
