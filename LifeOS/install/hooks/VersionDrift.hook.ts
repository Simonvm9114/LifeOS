#!/usr/bin/env bun
/**
 * VersionDrift.hook.ts — deterministic version-drift tooth (UserPromptSubmit).
 *
 * Versioning used to depend on the DA remembering to bump by hand; 2026-07-16 the
 * principal had to ask "did you bump the versions properly?" (answer: no).
 * This hook closes that class: when the core surface has drifted past the last
 * vX.Y.Z tag beyond thresholds and no bump is in flight, it injects a nag line
 * so the system asks the DA instead of the principal asking the system.
 *
 * Deterministic, zero inference. Quiet by design:
 *   - VERSION already moved past the tag → a bump is in flight → silent.
 *   - drift below thresholds (fresh tag, small change set) → silent.
 *   - nag at most once per NAG_INTERVAL_MIN even when drifted.
 * Thresholds (tunable): NAG_FILES=10 changed core files, or any drift once the
 * tag is older than NAG_AGE_HOURS=48.
 *
 * @version 1.0.8
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { hookCovers } from "./lib/function-hooks";
import { join, dirname } from "node:path";
import { getClaudeDir } from "./lib/paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { CORE_SURFACE } from "../LIFEOS/TOOLS/CoreSurface";

// Terminal telemetry only. Headless spawns (the texting bridge, scheduled jobs) must never receive these
// notes — on 2026-09-04 a model-drift warning and a memory-freshness line were relayed into an iMessage reply.
export const HEADLESS = !!(process.env.LIFEOS_TEXTING_SESSION || process.env.LIFEOS_NOTIFICATION_CHANNEL === "headless");


const CLAUDE_DIR = getClaudeDir();
const VERSION_FILE = join(CLAUDE_DIR, "LIFEOS", "VERSION");
const STATE_FILE = join(CLAUDE_DIR, "LIFEOS", "MEMORY", "STATE", "version-drift-nag.json");

const NAG_FILES = 10;
const NAG_AGE_HOURS = 48;
const NAG_INTERVAL_MIN = 60;

// The one core surface (LIFEOS/TOOLS/CoreSurface.ts), shared with ClassifyChange and
// UpdateKaiRepo; test/regression/core-surface-sync.test.ts asserts nobody keeps a copy.
// Every entry is a git pathspec, so the diff below selects exactly isCorePath()'s files.
function git(args: string[]): string {
  try {
    return execFileSync("git", ["-C", CLAUDE_DIR, ...args], { windowsHide: true,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 3000,
    }).trim();
  } catch { return ""; }
}

function lastSemverTag(): string | null {
  const tags = git(["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*"]).split("\n").map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => {
      const pa = a.slice(1).split(".").map(Number), pb = b.slice(1).split(".").map(Number);
      for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
      return 0;
    });
  return tags.length ? tags[tags.length - 1]! : null;
}

function recentlyNagged(): boolean {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return Date.now() - Date.parse(s.ts) < NAG_INTERVAL_MIN * 60_000;
  } catch { return false; }
}

function markNagged(count: number, tag: string): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ ts: new Date().toISOString(), count, tag }) + "\n");
}

/** The version-drift nag line, or null when quiet. */
export function run(): string | null {
  if (HEADLESS) return null;
  if (recentlyNagged()) return null; // Max MEDIUM-7: the free check before three git calls
  const tag = lastSemverTag();
  if (!tag) return null; // untagged repo — bootstrap is UpdateKaiRepo's job, not a nag

  // Bump in flight: VERSION already moved past the tag → UpdateKaiRepo will tag it.
  let version = "";
  try { version = readFileSync(VERSION_FILE, "utf8").trim(); } catch { /* fall through */ }
  if (version && `v${version}` !== tag) return null;

  const changed = git(["diff", "--name-only", tag, "--", ...CORE_SURFACE])
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (changed.length === 0) return null;

  const tagEpoch = Number(git(["log", "-1", "--format=%ct", tag]) || "0");
  const ageHours = tagEpoch ? (Date.now() / 1000 - tagEpoch) / 3600 : 0;

  const drifted = changed.length >= NAG_FILES || (ageHours > NAG_AGE_HOURS && changed.length >= 1);
  if (!drifted) return null;

  markNagged(changed.length, tag);
  return `⏫ VERSION-DRIFT: ${changed.length} core file(s) ahead of ${tag}` +
    `${ageHours >= 1 ? ` (tag ${Math.round(ageHours)}h old)` : ""}, no bump in flight — ` +
    (existsSync(join(CLAUDE_DIR, "commands", "rc.md"))
      ? `run /rc (ReleaseCandidate: classify, bump through UpdateKaiRepo --bump, cut) before this ages further, or defer explicitly to the principal.`
      : `bump LIFEOS/VERSION (Major.Feature.Patch) and tag it before this ages further, or defer explicitly to the principal.`);
}

if (import.meta.main) {
  // Armed session: runs once inside HookBridge prompt-context instead.
  try { const sid = (JSON.parse(readFileSync(0, "utf8") || "{}") as { session_id?: string }).session_id ?? ""; if (hookCovers(sid, "prompt-context")) process.exit(0); } catch { /* no stdin */ }
  const line = run();
  if (line) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: line } }));
}
