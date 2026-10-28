#!/usr/bin/env bun
/**
 * @version 1.0.0
 * Mount.ts — make a Codex CLI home a mirror of THIS LifeOS install.
 *
 * "Mirror" means symlinks and one generated file, never copies:
 *
 *   $CODEX_HOME/LIFEOS        → <install>/LIFEOS        (USER resolves through to the real USER dir)
 *   $CODEX_HOME/hooks         → <install>/hooks
 *   $CODEX_HOME/commands      → <install>/commands
 *   $CODEX_HOME/agents        → <install>/agents
 *   $CODEX_HOME/lifeos-codex  → <install>/LIFEOS/CODEX
 *   $CODEX_HOME/skills          no LifeOS skills are mounted: the context router finds them in the
 *                               install and reads one SKILL.md on demand; the skills step only prunes
 *                               views an earlier mount left behind (Codex's own skills/.system survives)
 *   $CODEX_HOME/AGENTS.md       generated: the system prompt + the LifeOS context router (Render.ts)
 *   $CODEX_HOME/config.toml     managed lines only: drop model_instructions_file, set project_doc_max_bytes
 *                               and skills.max_context_tokens; every other table byte-preserved
 *   $CODEX_HOME/hooks.json      one Bridge.ts entry per Codex event
 *
 * Idempotent. `--check` reports drift and changes nothing (exit 1 on drift);
 * `--sync` (default) converges. `--only <step>` limits either mode to one step:
 * retire | links | skills | agents | config | hooks | state | catalog | live.
 *
 * Safety:
 *   - never writes `[hooks.state]` (trust is the principal's act in /hooks);
 *   - never deletes: the previous copy-based port moves under
 *     `$CODEX_HOME/.lifeos-retired-<date>/` after its Codex-authored work dirs
 *     and bridge state are relocated into USER;
 *   - refuses to replace a real directory with a symlink unless the retire
 *     step has moved it.
 *
 * Install-generic: no home paths, no identity. CODEX_HOME wins when set.
 */

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { invariant } from "../TOOLS/Invariant.ts";
import { renderAgentsMd, sameRender } from "./Render.ts";
import { renderSkillView } from "./SkillCatalog.ts";
import { CODEX_EVENTS, EVENT_BUDGET_S, daName, type CodexEvent } from "./Bridge.ts";

export const INSTALL_ROOT = resolve(import.meta.dir, "..", "..");
export const LIFEOS_DIR = join(INSTALL_ROOT, "LIFEOS");
export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
export const STATE_DIR = join(LIFEOS_DIR, "USER", "CODEX");

export const PROJECT_DOC_MAX_BYTES = 4_000_000;   // AGENTS.md is ~125 KB today; the cap truncates silently, so leave headroom
export const SKILLS_MAX_CONTEXT_TOKENS = 16_000;  // Compact summaries keep the catalog useful without reserving a huge prompt budget.

const MANAGED_BEGIN = "# ── LIFEOS-MANAGED (LIFEOS/CODEX/Mount.ts) — do not hand-edit ──────────────";
const MANAGED_END = "# ── end LIFEOS-MANAGED ───────────────────────────────────────────────────────";

export type Step = "retire" | "links" | "skills" | "agents" | "config" | "hooks" | "state" | "catalog" | "live" | "retired";
export const STEPS: Step[] = ["retire", "links", "skills", "agents", "config", "hooks", "state"];
export interface Change { step: Step; what: string; detail: string }
export interface Ctx { installRoot: string; codexHome: string; stateDir: string; check: boolean; date: string }

// ── helpers ──────────────────────────────────────────────────────────────────

function isSymlink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
function isRealDir(p: string): boolean { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }
function linkTarget(p: string): string | null { try { return readlinkSync(p); } catch { return null; } }
function exists(p: string): boolean { try { lstatSync(p); return true; } catch { return false; } }

function ensureLink(ctx: Ctx, changes: Change[], step: Step, path: string, target: string): void {
  if (isSymlink(path) && linkTarget(path) === target) return;
  if (isRealDir(path)) { changes.push({ step, what: "blocked", detail: `${path} is a real directory; the retire step must move it first` }); return; }
  changes.push({ step, what: exists(path) ? "relink" : "link", detail: `${path} → ${target}` });
  if (ctx.check) return;
  if (exists(path)) unlinkSync(path);
  symlinkSync(target, path);
  invariant(linkTarget(path) === target, `symlink ${path} did not land on ${target}`);
}

function moveInto(ctx: Ctx, changes: Change[], src: string, destDir: string, label: string): void {
  if (!exists(src)) return;
  changes.push({ step: "retire", what: "move", detail: `${label}: ${src} → ${destDir}/` });
  if (ctx.check) return;
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, src.split("/").pop()!);
  invariant(!exists(dest), `retire destination already exists: ${dest}`);
  renameSync(src, dest);
}

/**
 * The previous port wrote Codex prefix rules (rules/default.rules) that allow
 * commands against its own now-retired paths. They are dead and carry the old
 * layout's absolute paths; the bridge's permission mirror replaces them.
 */
function retireStaleRules(ctx: Ctx, changes: Change[], retired: string): void {
  const rules = join(ctx.codexHome, "rules", "default.rules");
  if (!exists(rules)) return;
  try {
    if (!readFileSync(rules, "utf8").includes("lifeos-codex")) return;
  } catch { return; }
  moveInto(ctx, changes, rules, join(retired, "rules"), "previous port's prefix rules");
}

// ── steps ────────────────────────────────────────────────────────────────────

/** Move the copy-based port aside, relocating anything Codex sessions authored into USER first. */
export function stepRetire(ctx: Ctx, changes: Change[]): void {
  const retired = join(ctx.codexHome, `.lifeos-retired-${ctx.date}`);
  retireStaleRules(ctx, changes, retired);
  const oldLifeos = join(ctx.codexHome, "LIFEOS");
  const oldData = join(ctx.codexHome, "LIFEOS_DATA");
  const oldPort = join(ctx.codexHome, "lifeos-codex");
  const nothingToRetire = !isRealDir(oldLifeos) && !isRealDir(oldData) && !isRealDir(oldPort) && !isRealDir(join(ctx.codexHome, "hooks"));
  if (nothingToRetire) return;

  // 1. Codex-authored work dirs → USER/MEMORY/WORK (never orphaned in the retired copy)
  const userWork = join(ctx.installRoot, "LIFEOS", "USER", "MEMORY", "WORK");
  for (const workRoot of [join(oldLifeos, "MEMORY", "WORK"), join(oldData, "USER", "MEMORY", "WORK")]) {
    if (!isRealDir(workRoot)) continue;
    for (const name of readdirSync(workRoot)) {
      const src = join(workRoot, name);
      if (!isRealDir(src)) continue;
      const dest = join(userWork, name);
      if (exists(dest)) { changes.push({ step: "retire", what: "keep", detail: `${name} already exists under USER/MEMORY/WORK; the retired copy keeps its version` }); continue; }
      changes.push({ step: "retire", what: "relocate", detail: `work dir ${name} → USER/MEMORY/WORK/` });
      if (!ctx.check) { mkdirSync(userWork, { recursive: true }); renameSync(src, dest); }
    }
  }

  // 2. bridge state (events, voice id) → USER/CODEX at 0600
  const oldState = join(oldPort, "state");
  if (isRealDir(oldState)) {
    for (const name of readdirSync(oldState)) {
      const src = join(oldState, name);
      const dest = join(ctx.stateDir, name);
      if (exists(dest)) continue;
      changes.push({ step: "retire", what: "relocate", detail: `state ${name} → USER/CODEX/` });
      if (!ctx.check) { mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 }); renameSync(src, dest); chmodSync(dest, 0o600); }
    }
  }

  // 3. the copies themselves
  moveInto(ctx, changes, oldLifeos, retired, "system-tree copy");
  moveInto(ctx, changes, oldData, retired, "template USER copy");
  moveInto(ctx, changes, oldPort, retired, "previous port");
  for (const name of ["hooks", "commands", "agents"]) {
    const p = join(ctx.codexHome, name);
    if (isRealDir(p)) moveInto(ctx, changes, p, retired, `${name} copy`);
  }
  const skillsDir = join(ctx.codexHome, "skills");
  if (isRealDir(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      if (name === ".system") continue;
      const p = join(skillsDir, name);
      if (isRealDir(p)) moveInto(ctx, changes, p, join(retired, "skills"), "skill copy");
    }
  }
}

export function stepLinks(ctx: Ctx, changes: Change[]): void {
  ensureLink(ctx, changes, "links", join(ctx.codexHome, "LIFEOS"), join(ctx.installRoot, "LIFEOS"));
  for (const name of ["hooks", "commands", "agents"]) {
    const target = join(ctx.installRoot, name);
    if (existsSync(target)) ensureLink(ctx, changes, "links", join(ctx.codexHome, name), target);
  }
  ensureLink(ctx, changes, "links", join(ctx.codexHome, "lifeos-codex"), join(ctx.installRoot, "LIFEOS", "CODEX"));
}

export function installSkillNames(installRoot: string): string[] {
  const dir = join(installRoot, "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => !n.startsWith(".") && existsSync(join(dir, n, "SKILL.md"))).sort();
}

/**
 * Runtime-data segments a skill may carry that are never part of the skill:
 * machine-bound, regenerated, never shipped (mirrors the `skill-runtime-data`
 * containment zone). They are left OUT of the Codex-facing view because
 * Codex's skill scanner has a traversal limit — one install's node_modules
 * alone pushed the walk past it (observed 2026-09-08: "skills scan reached
 * its traversal limit") — and because nothing in them is a skill file.
 */
export const SKILL_RUNTIME_SEGMENTS = new Set(["node_modules", "profile-data", "state", "cache", ".playwright-cli", ".cache", ".sdk_bootstrap", ".git"]);

/** Does any directory named like a runtime segment exist anywhere under `dir`? (bounded walk; runtime dirs themselves are not entered) */
function subtreeHasRuntime(dir: string): boolean {
  let n = 0;
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d)) {
      if (SKILL_RUNTIME_SEGMENTS.has(e)) return true;
      const p = join(d, e);
      if (++n > 50_000) return true; // pathological tree: treat as runtime-bearing, materialize, keep the scanner safe
      if (isRealDir(p) && walk(p)) return true;
    }
    return false;
  };
  return walk(dir);
}

type ViewKind = "copy" | "link" | "dir";
/** relative path → how the view carries it. Computed from the install side only. */
export function planSkillView(src: string): Map<string, ViewKind> {
  const plan = new Map<string, ViewKind>();
  plan.set("SKILL.md", "copy"); // Codex's scanner follows symlinked folders but not a symlinked SKILL.md (probed 2026-09-08)
  const visit = (rel: string) => {
    const abs = rel ? join(src, rel) : src;
    for (const e of readdirSync(abs)) {
      if (SKILL_RUNTIME_SEGMENTS.has(e)) continue;
      const r = rel ? `${rel}/${e}` : e;
      if (r === "SKILL.md") continue;
      const p = join(src, r);
      if (isRealDir(p) && subtreeHasRuntime(p)) { plan.set(r, "dir"); visit(r); }
      else plan.set(r, "link");
    }
  };
  visit("");
  return plan;
}

/** The kinds a view entry currently has, keyed the same way; undefined when absent. */
function currentViewKind(viewRoot: string, rel: string, src: string): ViewKind | "foreign" | undefined {
  const p = join(viewRoot, rel);
  if (!exists(p)) return undefined;
  if (isSymlink(p)) return linkTarget(p) === join(src, rel) ? "link" : "foreign";
  if (isRealDir(p)) return "dir";
  if (rel === "SKILL.md") {
    try { return readFileSync(p, "utf8") === renderSkillView(readFileSync(join(src, rel), "utf8")) && (statSync(p).mode & 0o222) === 0 ? "copy" : "foreign"; } catch { return "foreign"; }
  }
  return "foreign";
}

/**
 * The Codex-facing view of one skill. Real directories exist only where a
 * subtree carries runtime data the scanner must not walk; everything else is a
 * symlink into the install; SKILL.md is a read-only copy so the scanner reads
 * it (it does not follow a symlinked file) and an edit lands on the install
 * copy, never here. A skill's own tools resolve `import.meta.dir` through the
 * symlinks to the real tree, so node_modules is found at run time unchanged.
 */
function ensureSkillView(ctx: Ctx, changes: Change[], dir: string, src: string): void {
  const name = dir.split("/").pop();
  const plan = planSkillView(src);
  const drift: string[] = [];
  // 1. everything the plan wants, in the shape it wants
  for (const [rel, kind] of plan) {
    const cur = isRealDir(dir) || isSymlink(dir) ? currentViewKind(dir, rel, src) : undefined;
    if (cur !== kind) drift.push(`${rel}:${cur ?? "absent"}→${kind}`);
  }
  // 2. nothing the plan does not want (only our own symlinks, our SKILL.md copy, and empty dirs are ever removed)
  const extras: string[] = [];
  const foreign: string[] = [];
  if (isRealDir(dir)) {
    const walk = (rel: string) => {
      for (const e of readdirSync(join(dir, rel))) {
        const r = rel ? `${rel}/${e}` : e;
        const kind = plan.get(r);
        const p = join(dir, r);
        if (kind === "dir" && isRealDir(p)) { walk(r); continue; }
        if (kind) continue;
        if (isSymlink(p) && (linkTarget(p) ?? "").startsWith(src)) extras.push(r);
        else if (isRealDir(p)) { walk(r); extras.push(r); }
        else foreign.push(r);
      }
    };
    walk("");
  }
  if (isSymlink(dir)) drift.unshift("(whole-dir symlink → view)");
  for (const f of foreign) changes.push({ step: "skills", what: "foreign", detail: `${name}/${f}: real entry inside the Codex view; left in place` });
  if (!drift.length && !extras.length) return;
  changes.push({ step: "skills", what: isSymlink(dir) ? "reshape" : exists(dir) ? "refresh" : "mount", detail: `${name}: ${[...drift.slice(0, 3), ...(drift.length > 3 ? [`+${drift.length - 3} more`] : []), ...extras.map((e) => `prune ${e}`)].join(", ")}` });
  if (ctx.check) return;

  if (isSymlink(dir)) unlinkSync(dir);
  mkdirSync(dir, { recursive: true });
  for (const r of extras.sort((a, b) => b.length - a.length)) {
    const p = join(dir, r);
    if (isSymlink(p)) unlinkSync(p);
    else if (isRealDir(p) && readdirSync(p).length === 0) rmdirSync(p);
  }
  for (const [rel, kind] of plan) {
    const p = join(dir, rel);
    const cur = currentViewKind(dir, rel, src);
    if (cur === kind) continue;
    if (cur === "foreign" && !isSymlink(p) && !(rel === "SKILL.md")) continue; // reported above, never overwritten
    if (isSymlink(p)) unlinkSync(p);
    if (kind === "dir") { if (!isRealDir(p)) mkdirSync(p); continue; }
    if (kind === "link") { mkdirSync(join(p, ".."), { recursive: true }); symlinkSync(join(src, rel), p); continue; }
    // Validate the generated text before touching the current view.
    const skillView = renderSkillView(readFileSync(join(src, rel), "utf8"));
    // Read-only view: compact catalog field, original description and body retained.
    if (existsSync(p)) chmodSync(p, 0o644);
    writeFileSync(p, skillView);
    chmodSync(p, 0o444);
  }
  invariant(currentViewKind(dir, "SKILL.md", src) === "copy", `skill view ${dir}: SKILL.md is not a read-only copy of the install's`);
}

/** A view we made: every file is a symlink into the install or the read-only SKILL.md copy, every dir recursively the same. */
function isOurView(dir: string, installSkills: string): boolean {
  const walk = (d: string, top: boolean): boolean => readdirSync(d).every((e) => {
    const p = join(d, e);
    if (isSymlink(p)) return (linkTarget(p) ?? "").startsWith(installSkills);
    if (isRealDir(p)) return walk(p, false);
    return top && e === "SKILL.md" && (statSync(p).mode & 0o222) === 0;
  });
  return walk(dir, true);
}

function removeOurView(dir: string): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (isSymlink(p)) unlinkSync(p);
    else if (isRealDir(p)) removeOurView(p);
    else { chmodSync(p, 0o644); unlinkSync(p); }
  }
  rmdirSync(dir);
}

export function stepSkills(ctx: Ctx, changes: Change[]): void {
  const codexSkills = join(ctx.codexHome, "skills");
  if (!ctx.check) mkdirSync(codexSkills, { recursive: true });
  // LifeOS skills are intentionally not mounted into Codex's scanned directory.
  // Codex injects every discovered skill description eagerly; the startup router
  // searches the live source tree and reads exactly one SKILL.md on demand.
  const wanted = new Set<string>();
  const installSkills = join(ctx.installRoot, "skills");
  for (const name of wanted) ensureSkillView(ctx, changes, join(codexSkills, name), join(installSkills, name));
  if (!existsSync(codexSkills)) return;
  for (const name of readdirSync(codexSkills)) {
    if (name === ".system" || wanted.has(name)) continue;
    const p = join(codexSkills, name);
    const ours = (isSymlink(p) && (linkTarget(p) ?? "").startsWith(installSkills)) || (isRealDir(p) && isOurView(p, installSkills));
    if (ours) {
      changes.push({ step: "skills", what: "prune", detail: `${name}: no longer a skill in the install` });
      if (!ctx.check) { if (isSymlink(p)) unlinkSync(p); else removeOurView(p); }
    } else if (isRealDir(p)) {
      changes.push({ step: "skills", what: "foreign", detail: `${name}: real directory not from the install (retire step moves copies; a hand-installed Codex skill stays)` });
    }
  }
}

export function stepAgents(ctx: Ctx, changes: Change[]): void {
  const path = join(ctx.codexHome, "AGENTS.md");
  const { text, missing } = renderAgentsMd({ installRoot: ctx.installRoot, codexHome: ctx.codexHome, daName: daName(join(ctx.installRoot, "LIFEOS")) });
  for (const m of missing) changes.push({ step: "agents", what: "missing-import", detail: m });
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (sameRender(current, text)) return;
  changes.push({ step: "agents", what: current ? "regenerate" : "generate", detail: `${path} (${text.length} bytes)` });
  if (!ctx.check) writeFileSync(path, text);
}

/** Managed edit of config.toml: minimal, line-based, everything else byte-preserved. */
export function manageConfigToml(toml: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  let lines = toml.split("\n");

  // strip a previous managed block so the edit is idempotent
  const b = lines.indexOf(MANAGED_BEGIN), e = lines.indexOf(MANAGED_END);
  if (b >= 0 && e > b) lines.splice(b, e - b + 1);

  // top-level keys live before the first table header
  const tableAt = () => { const i = lines.findIndex((l) => /^\s*\[/.test(l)); return i < 0 ? lines.length : i; };
  const drop = lines.findIndex((l, i) => i < tableAt() && /^\s*model_instructions_file\s*=/.test(l));
  if (drop >= 0) { notes.push(`removed ${lines[drop].trim()} (it REPLACES Codex's base instructions; AGENTS.md now carries LifeOS on top of them)`); lines.splice(drop, 1); }

  const pdmb = lines.findIndex((l, i) => i < tableAt() && /^\s*project_doc_max_bytes\s*=/.test(l));
  const pdmbLine = `project_doc_max_bytes = ${PROJECT_DOC_MAX_BYTES}`;
  if (pdmb >= 0) { if (lines[pdmb].trim() !== pdmbLine) { notes.push(`set ${pdmbLine}`); lines[pdmb] = pdmbLine; } }
  else { notes.push(`set ${pdmbLine}`); lines.splice(tableAt(), 0, pdmbLine, ""); }

  // [skills] table: set max_context_tokens inside an existing table, else append a managed block
  const skillsHdr = lines.findIndex((l) => /^\s*\[skills\]\s*$/.test(l));
  const mctLine = `max_context_tokens = ${SKILLS_MAX_CONTEXT_TOKENS}`;
  if (skillsHdr >= 0) {
    let i = skillsHdr + 1, found = -1;
    while (i < lines.length && !/^\s*\[/.test(lines[i])) { if (/^\s*max_context_tokens\s*=/.test(lines[i])) found = i; i++; }
    if (found >= 0) { if (lines[found].trim() !== mctLine) { notes.push(`set skills.${mctLine}`); lines[found] = mctLine; } }
    else { notes.push(`set skills.${mctLine}`); lines.splice(skillsHdr + 1, 0, mctLine); }
  } else {
    notes.push(`set skills.${mctLine}`);
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", MANAGED_BEGIN, "[skills]", mctLine, MANAGED_END, "");
  }
  const text = lines.join("\n");
  return { text, notes: text === toml ? [] : notes };
}

export function hooksStateBlock(toml: string): string {
  return toml.split("\n").filter((l) => /^\s*\[hooks\.state/.test(l) || /^\s*trusted_hash\s*=/.test(l)).join("\n");
}

export function stepConfig(ctx: Ctx, changes: Change[]): void {
  const path = join(ctx.codexHome, "config.toml");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { text, notes } = manageConfigToml(current);
  if (text === current) return;
  for (const n of notes) changes.push({ step: "config", what: "config", detail: n });
  if (ctx.check) return;
  invariant(hooksStateBlock(text) === hooksStateBlock(current), "config edit would alter [hooks.state] trust — refusing");
  writeFileSync(path, text);
}

/**
 * The bun that runs this mount, by absolute path. Codex.app sessions start with a
 * minimal PATH; a bare `bun` there would never launch the bridge and the mirror
 * would go inert with no signal. hooks.json is per-install output already.
 */
export function bunPath(): string { return process.execPath; }

/**
 * A path as one shell word. Plain paths stay bare, so an existing hooks.json is
 * byte-identical and keeps its /hooks trust; a path with spaces or shell
 * metacharacters is single-quoted.
 */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9_\/.,:+@%=-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

export function renderHooksJson(installRoot: string, bun = bunPath()): string {
  const bridge = join(installRoot, "LIFEOS", "CODEX", "Bridge.ts");
  const hooks: Record<string, unknown[]> = {};
  for (const ev of CODEX_EVENTS as readonly CodexEvent[]) {
    hooks[ev] = [{ hooks: [{ type: "command", command: `${shellWord(bun)} ${shellWord(bridge)} ${ev}`, timeout: EVENT_BUDGET_S[ev], statusMessage: `LifeOS ${ev}` }] }];
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

export function stepHooks(ctx: Ctx, changes: Change[]): void {
  const path = join(ctx.codexHome, "hooks.json");
  const text = renderHooksJson(ctx.installRoot);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current === text) return;
  changes.push({ step: "hooks", what: current ? "rewrite" : "write", detail: `${path} — ${CODEX_EVENTS.length} events → Bridge.ts; the principal must trust the new definitions in /hooks before they run` });
  if (!ctx.check) writeFileSync(path, text);
}

export function stepState(ctx: Ctx, changes: Change[]): void {
  const dir = ctx.stateDir;
  if (!existsSync(dir)) { changes.push({ step: "state", what: "mkdir", detail: `${dir} (0700)` }); if (!ctx.check) mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  if (!existsSync(dir)) return;
  // Windows has no POSIX mode bits (stat always reports 0666), so every check would report drift there.
  if (process.platform === "win32") return;
  const mode = statSync(dir).mode & 0o777;
  if (mode !== 0o700) { changes.push({ step: "state", what: "chmod", detail: `${dir} ${mode.toString(8)} → 700` }); if (!ctx.check) chmodSync(dir, 0o700); }
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    const m = statSync(p).mode & 0o777;
    if (m !== 0o600) { changes.push({ step: "state", what: "chmod", detail: `${p} ${m.toString(8)} → 600` }); if (!ctx.check) chmodSync(p, 0o600); }
  }
}

// ── check-only probes ────────────────────────────────────────────────────────

/** Ask Codex's own renderer which skills it sees; every install skill must appear exactly once with no omission warning. */
export function checkCatalog(ctx: Ctx, changes: Change[]): void {
  const r = spawnSync("codex", ["debug", "prompt-input", "skill catalog check"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: ctx.codexHome }, timeout: 90_000 });
  if (r.status !== 0) { changes.push({ step: "catalog", what: "probe-failed", detail: (r.stderr || r.error?.message || "codex debug prompt-input failed").slice(0, 200) }); return; }
  let text = "";
  try { const msgs = JSON.parse(r.stdout) as Array<{ content?: Array<{ text?: string }> }>; text = msgs.map((m) => m.content?.map((c) => c.text ?? "").join("\n") ?? "").join("\n"); } catch { text = r.stdout; }
  const router = renderAgentsMd({ installRoot: ctx.installRoot, codexHome: ctx.codexHome, daName: daName(join(ctx.installRoot, "LIFEOS")) }).text;
  const stableRouter = router.replace(/<!-- ── end LIFEOS-MANAGED · rendered [^\n]*-->/g, "<!-- end -->").trimEnd();
  const stablePrompt = text.replace(/<!-- ── end LIFEOS-MANAGED · rendered [^\n]*-->/g, "<!-- end -->");
  if (!stablePrompt.includes(stableRouter)) changes.push({ step: "catalog", what: "context-mismatch", detail: "native prompt lacks the current system-prompt-plus-router payload" });
  // One catalog line per skill: `- Name: <description> (file: rN/Name/SKILL.md)`. Codex caps the
  // catalog at a window-derived budget that `skills.max_context_tokens` can lower but not raise
  // (probed 2026-09-08: 1000 shrank descriptions, 60000 and 200000 rendered identically), so the
  // compact source metadata is projected into the native description field. The full
  // original description lives in the view body. Check exact emitted text.
  const listed = new Map<string, number>();
  // (name is keyed off the `(file: rN/<Name>/SKILL.md)` suffix, not the label — Codex rendered one label as `Name:Name:`)
  for (const m of text.matchAll(/^- ([^\n]*) \(file: r\d+\/([A-Za-z0-9_.-]+)\/SKILL\.md\)$/gm)) {
    listed.set(m[2], (listed.get(m[2]) ?? 0) + 1);
  }
  for (const name of installSkillNames(ctx.installRoot)) {
    const n = listed.get(name) ?? 0;
    if (n !== 0) changes.push({ step: "catalog", what: "eager-skill", detail: `${name} appears ${n}×; LifeOS skills must be router-discovered` });
  }
  if (/traversal limit/.test(r.stderr)) changes.push({ step: "catalog", what: "traversal-limit", detail: "the skill scanner hit its traversal limit — a skill view is exposing runtime data (SKILL_RUNTIME_SEGMENTS)" });
}


/** No copy-based port remains at the top level; when a retired dir exists it holds the system-tree copy. */
export function checkRetired(ctx: Ctx, changes: Change[]): void {
  for (const name of ["LIFEOS", "LIFEOS_DATA", "hooks", "lifeos-codex"]) {
    if (isRealDir(join(ctx.codexHome, name))) changes.push({ step: "retire", what: "copy-remains", detail: `${name} is still a real directory under the Codex home` });
  }
  const retired = readdirSync(ctx.codexHome).filter((n) => n.startsWith(".lifeos-retired-"));
  for (const r of retired) {
    if (!existsSync(join(ctx.codexHome, r, "LIFEOS"))) changes.push({ step: "retire", what: "incomplete", detail: `${r} holds no LIFEOS copy` });
  }
}

/** A live Codex turn leaves SessionStart, UserPromptSubmit, PreToolUse and Stop records for one session within 24h. */
export function checkLive(ctx: Ctx, changes: Change[]): void {
  const p = join(ctx.stateDir, "events.jsonl");
  if (!existsSync(p)) { changes.push({ step: "live", what: "no-telemetry", detail: p }); return; }
  const since = Date.now() - 24 * 3600 * 1000;
  const bySession = new Map<string, Set<string>>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { at?: string; event?: string; session_id?: string | null; tool_name?: string | null; hooks?: string[]; fanout?: number };
      if (!r.at || Date.parse(r.at) < since || !r.session_id || !Array.isArray(r.hooks)) continue;
      const s = bySession.get(r.session_id) ?? new Set<string>();
      s.add(String(r.event));
      // the payload-shape question: a Codex edit must fan out and reach the bridge's mirror of the native permission rules
      if (r.event === "PreToolUse" && r.tool_name === "apply_patch" && (r.fanout ?? 0) > 0 && r.hooks.includes("Bridge.permissionMirror")) s.add("apply_patch→permissionMirror");
      bySession.set(r.session_id, s);
    } catch { /* legacy record shape */ }
  }
  const need = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "apply_patch→permissionMirror"];
  const ok = [...bySession.values()].some((s) => need.every((e) => s.has(e)));
  if (!ok) changes.push({ step: "live", what: "no-live-session", detail: `no session in 24h carried all of ${need.join(", ")} (hooks trusted in /hooks yet? did the turn edit a file?)` });
}

// ── main ─────────────────────────────────────────────────────────────────────

/** YYYYMMDD in the machine's local zone — the retired dir is named for the day the principal saw it happen. */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export function run(opts: { check: boolean; only?: Step; installRoot?: string; codexHome?: string; stateDir?: string; date?: string }): Change[] {
  const ctx: Ctx = {
    installRoot: opts.installRoot ?? INSTALL_ROOT,
    codexHome: opts.codexHome ?? CODEX_HOME,
    stateDir: opts.stateDir ?? join(opts.installRoot ?? INSTALL_ROOT, "LIFEOS", "USER", "CODEX"),
    check: opts.check,
    date: opts.date ?? localDate(),
  };
  invariant(existsSync(join(ctx.installRoot, "LIFEOS", "LIFEOS_SYSTEM_PROMPT.md")), `not a LifeOS install root: ${ctx.installRoot}`);
  invariant(existsSync(ctx.codexHome), `CODEX_HOME does not exist: ${ctx.codexHome}`);
  const changes: Change[] = [];
  const steps: Record<Step, (c: Ctx, ch: Change[]) => void> = {
    retire: stepRetire, links: stepLinks, skills: stepSkills, agents: stepAgents, config: stepConfig, hooks: stepHooks, state: stepState,
    catalog: checkCatalog, live: checkLive, retired: checkRetired,
  };
  const order: Step[] = opts.only ? [opts.only] : STEPS;
  for (const s of order) steps[s](ctx, changes);
  return changes;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const quiet = args.includes("--quiet");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] as Step) : undefined;
  if (only && !["retire", "links", "skills", "agents", "config", "hooks", "state", "catalog", "live", "retired"].includes(only)) {
    process.stderr.write(`unknown --only step: ${only}\n`); process.exit(2);
  }
  let changes: Change[];
  try { changes = run({ check, only }); } catch (e) { process.stderr.write(`Mount: ${String(e)}\n`); process.exit(2); }
  const blocked = changes.filter((c) => ["blocked", "probe-failed", "not-listed", "duplicate", "missing-summary", "description-mismatch", "context-mismatch", "traversal-limit", "no-live-session", "no-telemetry", "missing-import", "copy-remains", "incomplete"].includes(c.what));
  if (!quiet) {
    if (!changes.length) process.stdout.write(`Codex mirror: converged (${check ? "check" : "sync"}, ${only ?? "all steps"})\n`);
    for (const c of changes) process.stdout.write(`${check ? "DRIFT" : "APPLIED"} [${c.step}] ${c.what}: ${c.detail}\n`);
    if (!check && changes.some((c) => c.step === "hooks")) process.stdout.write("\nhooks.json changed → open Codex and run /hooks to review and trust the new definitions.\n");
  }
  process.exit(check ? (changes.length ? 1 : 0) : (blocked.length ? 1 : 0));
}
