/**
 * InstallEngine — shared install logic for the LifeOS bare-skill installer.
 *
 * This is a standalone install engine, reshaped for the bare-skill context
 * from the now-retired pre-6.x GUI installer engine (detect logic + types):
 * no web/electron wizard, no separate types module, plus
 * the bare-skill extras the wizard never needed — harness detection (the skill
 * installs into Claude Code / Hermes / Cursor / OpenClaw) and dev-tree refusal
 * (never mutate the author's source repo).
 *
 * All detection here is READ-ONLY and non-destructive. The 7 setup Tools import
 * from this one sibling module (flat 2-level skill structure forbids a lib/ dir).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { claudeDirFor } from "./lib/claude-dir";

// ── Types (inlined — the skill ships without the engine's types.ts) ──

export type Platform = "darwin" | "linux" | "windows";

export interface OsInfo {
  platform: Platform;
  arch: string;
  version: string;
  name: string;
}

export interface ToolInfo {
  installed: boolean;
  version?: string;
  path?: string;
}

export type Harness = "claude-code" | "opencode" | "hermes" | "cursor" | "openclaw" | "unknown";

export interface HarnessInfo {
  name: Harness;
  /** Where this harness loads skills from (absolute), if known. */
  skillsDir?: string;
  /** The config root the harness resolves (e.g. ~/.claude). */
  configRoot?: string;
  /**
   * "detected" = the harness binary was found on PATH; "assumed" = inferred
   * from a config dir alone, or the clean-machine default. The Setup intent
   * must confirm an "assumed" harness with the user before branching (#1448 —
   * a leftover ~/.claude dir sent an OpenCode install down the Claude Code path).
   */
  confidence: "detected" | "assumed";
}

export interface EnvDetection {
  os: OsInfo;
  harness: HarnessInfo;
  /** Has a graphical session (vs headless/SSH) — gates GUI-dependent steps. */
  display: boolean;
  /** Running inside an SSH session. */
  ssh: boolean;
  bun: ToolInfo;
  git: ToolInfo;
  /**
   * A prior LifeOS install is present. Keyed on `<configRoot>/LIFEOS/VERSION`,
   * which only DeployCore writes — settings.json exists on any harness that has
   * ever run, LifeOS or not (public issue #1727, @rpriven).
   */
  existingInstall: boolean;
  /**
   * This IS the author's live source tree — refuse all mutation. Marker: the
   * private maintenance skill only exists in the source repo,
   * never in a public install.
   */
  isDevTree: boolean;
  settingsExists: boolean;
  claudeMdExists: boolean;
  homeDir: string;
  configRoot: string;
  timezone: string;
}

// ── Low-level probes (from engine detect.ts, unchanged) ──

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Absolute path of a binary on PATH, or null. Never `command -v` through
 * tryExec on Windows: execSync runs cmd.exe there, which has no `command`
 * built-in, so every probe failed and DetectEnv reported bun, git and the
 * harness binary missing while running on bun (public issue #2295).
 * Bun.which is cross-platform and PATHEXT-aware (finds npm's claude.cmd);
 * the shell probes are the fallback when this file runs outside bun.
 */
function findBin(name: string): string | null {
  const bun = (globalThis as { Bun?: { which(bin: string): string | null } }).Bun;
  if (bun) return bun.which(name);
  const out = tryExec(process.platform === "win32" ? `where ${name}` : `command -v ${name}`);
  return out ? out.split(/\r?\n/)[0] : null;
}

export function detectOS(): OsInfo {
  const platform: Platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch;
  let version = "";
  let name = "";
  if (platform === "darwin") {
    version = tryExec("sw_vers -productVersion") || "";
    name = `macOS ${version}`.trim();
  } else if (platform === "linux") {
    name = tryExec("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'") || "Linux";
    version = tryExec("uname -r") || "";
  } else {
    name = "Windows";
    version = tryExec("ver") || "";
  }
  return { platform, arch, version, name };
}

export function detectTool(name: string, versionCmd: string): ToolInfo {
  const path = findBin(name);
  if (!path) return { installed: false };
  const out = tryExec(versionCmd);
  const m = out?.match(/(\d+\.\d+[.\d]*)/);
  return { installed: true, version: m?.[1] || out || undefined, path };
}

// ── Harness detection (NEW — bare-skill needs to know where it landed) ──

/**
 * Detect which harness is hosting this install and where it loads skills from.
 * Signal strength (#1448): config dir + harness binary on PATH beats config dir
 * alone beats binary alone — a leftover ~/.claude dir on a machine without the
 * claude CLI must not out-rank a live OpenCode install. Anything short of a
 * binary match is reported as confidence "assumed", never as fact.
 */
export function detectHarness(home: string): HarnessInfo {
  const candidates: Array<{ name: Harness; root: string; skills: string; bin: string }> = [
    { name: "claude-code", root: resolve(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")), skills: "skills", bin: "claude" },
    { name: "opencode", root: process.env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode"), skills: "skills", bin: "opencode" },
    { name: "hermes", root: join(home, ".hermes"), skills: "skills", bin: "hermes" },
    { name: "cursor", root: join(home, ".cursor"), skills: "skills", bin: "cursor" },
    { name: "openclaw", root: join(home, ".openclaw"), skills: "skills", bin: "openclaw" },
  ];
  const hasBin = (c: (typeof candidates)[number]) => !!findBin(c.bin);
  const info = (c: (typeof candidates)[number], confidence: HarnessInfo["confidence"]): HarnessInfo => ({
    name: c.name,
    configRoot: c.root,
    skillsDir: join(c.root, c.skills),
    confidence,
  });
  // Explicit override wins outright: the operator has said which harness is
  // running this install, so no confirm is needed (public issue #1937, @mj-deving).
  const override = process.env.LIFEOS_HARNESS?.trim();
  const overridden = override ? candidates.find((c) => c.name === override) : undefined;
  if (overridden) return info(overridden, "detected");
  // A machine with two live harnesses (config dir + binary for both) used to
  // report the first as "detected", which bypassed the Setup confirm and sent
  // the install down the wrong path. More than one qualifier is a guess, so it
  // reports "assumed" and the existing Setup.md step-3 confirm fires.
  const live = candidates.filter((c) => existsSync(c.root) && hasBin(c));
  if (live.length === 1) return info(live[0], "detected");
  if (live.length > 1) return info(live[0], "assumed");
  for (const c of candidates) {
    if (existsSync(c.root)) return info(c, "assumed");
  }
  for (const c of candidates) {
    if (hasBin(c)) return info(c, "detected");
  }
  // Default assumption when nothing is present yet (a clean machine pre-bootstrap).
  return { name: "claude-code", configRoot: join(home, ".claude"), skillsDir: join(home, ".claude", "skills"), confidence: "assumed" };
}

/**
 * Dev-tree refusal marker. The private maintenance skill exists
 * ONLY in the author's source repo — never in a public install (release tooling
 * strips all `_ALLCAPS` skills). Its presence means "this is the live source;
 * do not mutate." A `.git` remote check is a secondary signal, while the private maintenance marker alone
 * is decisive and cheap.
 */
export function detectDevTree(configRoot: string): boolean {
  return existsSync(join(configRoot, "skills", "_LIFEOS"));
}

// ── Dev-install write guard ──

/**
 * Canonical path of `p` even when it does not exist yet: realpath the deepest
 * existing ancestor (following symlinks, canonical case on darwin), then append
 * the not-yet-created tail. A dangling symlink is followed to where it points.
 */
export function realPathLoose(p: string, depth = 0): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    const rest = (): string[] => [...tail].reverse();
    try {
      return join((realpathSync.native ?? realpathSync)(cur), ...rest());
    } catch { /* missing or dangling — try the symlink, then the parent */ }
    try {
      if (depth < 16 && lstatSync(cur).isSymbolicLink()) {
        return realPathLoose(join(resolve(dirname(cur), readlinkSync(cur)), ...rest()), depth + 1);
      }
    } catch { /* not a symlink / unreadable */ }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.push(basename(cur));
    cur = parent;
  }
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

export interface DevWriteViolation {
  /** The write target as the tool spelled it. */
  target: string;
  /** Where that target really lives after resolving symlinks. */
  resolved: string;
  /** The dev install's config root (real path). */
  devRoot: string;
  /** Which protected area of that install the target landed in. */
  via: "config-root" | "user-tree" | "data-home";
}

/**
 * Config roots that might be a maintainer install, even when the tool was
 * pointed somewhere else. A temporary HOME hides ~/.claude from `homedir()`, but
 * the environment (LIFEOS_DIR, CLAUDE_CONFIG_DIR) and the passwd entry
 * (`userInfo().homedir`, which ignores $HOME) still name it.
 */
function devRootCandidates(extra: string[]): string[] {
  const c = [...extra];
  const env = process.env;
  if (env.CLAUDE_CONFIG_DIR) c.push(env.CLAUDE_CONFIG_DIR);
  if (env.LIFEOS_DIR) c.push(env.LIFEOS_DIR, dirname(resolve(env.LIFEOS_DIR)));
  // Every home the OS or the environment names, in the same order as before. This is a deny-side
  // guard on the maintainer's HOME profile, so it deliberately does not follow CLAUDE_CONFIG_DIR here.
  const homes: string[] = [];
  if (env.HOME) homes.push(env.HOME);
  try { homes.push(homedir()); } catch { /* no home */ }
  try { homes.push(userInfo().homedir); } catch { /* no passwd entry */ }
  for (const h of homes) c.push(join(h, ".claude"));
  return c;
}

/**
 * Generalised dev-install test. A path is protected when, after `realpath`, it
 * is inside (a) a config root containing `skills/_LIFEOS`, (b) that root's
 * `LIFEOS/USER` (or `LIFEOS/MEMORY`) link target wherever it really lives, or
 * (c) the data home holding that USER target (`<configDir>`). Checking the
 * resolved WRITE TARGETS, not only the config root, is the point: a clean temp
 * root plus LIFEOS_CONFIG_DIR at the maintainer's data home used to pass.
 *
 * Returns the first violation, or null when every target is clear.
 */
export function findDevWriteViolation(targets: string[], extraRoots: string[] = []): DevWriteViolation | null {
  const seen = new Set<string>();
  const protectedAreas: Array<{ path: string; devRoot: string; via: DevWriteViolation["via"] }> = [];
  for (const cand of devRootCandidates(extraRoots)) {
    const root = realPathLoose(cand);
    if (seen.has(root) || !detectDevTree(root)) continue;
    seen.add(root);
    protectedAreas.push({ path: root, devRoot: root, via: "config-root" });
    for (const link of ["USER", "MEMORY"]) {
      const real = realPathLoose(join(root, "LIFEOS", link));
      if (!isWithin(real, root)) {
        protectedAreas.push({ path: real, devRoot: root, via: "user-tree" });
        // The data home is the directory that holds the USER tree (~/.config/LIFEOS).
        const home = basename(real) === "USER" ? dirname(real) : basename(dirname(real)) === "USER" ? dirname(dirname(real)) : null;
        if (home && home !== dirname(home)) protectedAreas.push({ path: home, devRoot: root, via: "data-home" });
      }
    }
  }
  for (const target of targets) {
    const resolved = realPathLoose(target);
    for (const area of protectedAreas) {
      if (isWithin(resolved, area.path)) return { target, resolved, devRoot: area.devRoot, via: area.via };
    }
  }
  return null;
}

/**
 * Entry point for every writing install tool. Exits 2 with a `dev-tree` refusal
 * when any write target resolves inside a maintainer install; `allowDev` is the
 * explicit sandbox override. The tool's config root is always a candidate dev
 * root and a target, so the old `detectDevTree(configRoot)` refusal is subsumed.
 */
export function refuseDevInstallWrites(configRoot: string, writeTargets: string[], allowDev: boolean): void {
  if (allowDev) return;
  const v = findDevWriteViolation([configRoot, ...writeTargets], [configRoot]);
  if (!v) return;
  console.log(JSON.stringify({
    ok: false,
    refused: "dev-tree",
    detail: `${v.target} resolves to ${v.resolved}, inside the LifeOS dev install at ${v.devRoot} (${v.via}; a source tree, dev-tree marker present) — refusing to write. Point --config-root/--config-dir (or LIFEOS_CONFIG_DIR/LIFEOS_DIR) at a clean location, or use --allow-dev only in a sandbox.`,
    target: v.target,
    resolved: v.resolved,
    devRoot: v.devRoot,
  }, null, 2));
  process.exit(2);
}

// ── Composite env detection (the DetectEnv Tool payload) ──

export function detectEnv(): EnvDetection {
  const home = homedir();
  const os = detectOS();
  const harness = detectHarness(home);
  const configRoot = harness.configRoot || join(home, ".claude");
  const settingsPath = join(configRoot, "settings.json");
  const claudeMdPath = join(configRoot, "CLAUDE.md");
  const ssh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT);
  // GUI session: macOS always has one locally; Linux needs DISPLAY/WAYLAND and not pure-SSH.
  const display =
    os.platform === "darwin" ? !ssh : !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !ssh;

  return {
    os,
    harness,
    display,
    ssh,
    bun: detectTool("bun", "bun --version"),
    git: detectTool("git", "git --version"),
    // public issue #1727, @rpriven — LifeOS-specific marker, not settings.json.
    existingInstall: existsSync(join(configRoot, "LIFEOS", "VERSION")),
    isDevTree: detectDevTree(configRoot),
    settingsExists: existsSync(settingsPath),
    claudeMdExists: existsSync(claudeMdPath),
    homeDir: home,
    configRoot,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ── Existing-content + API-key scan (from engine detect.ts, inlined types) ──

export interface ApiKeyScan {
  fish?: string;
  anthropic?: string;
  openai?: string;
  google?: string;
  perplexity?: string;
}

/**
 * Scan shell rc files + config dirs for API-key VALUES. Returns provider → key.
 * Only well-formed assignments are accepted (no `$VAR` indirection, no
 * obvious placeholders). Read-only.
 */
export function scanApiKeys(home: string, configDir: string): ApiKeyScan {
  const candidates = [
    join(home, ".zshenv"),
    join(home, ".zshrc"),
    join(home, ".zprofile"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(configDir, ".env"),
    join(configDir, "credentials.env"),
    join(home, ".config", "LIFEOS", ".env"),
  ];
  const patterns: Array<[keyof ApiKeyScan, RegExp]> = [
    ["fish", /(?:^|\n)\s*(?:export\s+)?FISH_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["anthropic", /(?:^|\n)\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["openai", /(?:^|\n)\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["google", /(?:^|\n)\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_API_KEY)\s*=\s*["']?([^"'\s#]+)/],
    ["perplexity", /(?:^|\n)\s*(?:export\s+)?PERPLEXITY_API_KEY\s*=\s*["']?([^"'\s#]+)/],
  ];
  const placeholder = /^(your-key-here|sk-xxxxxxxx|xxxxx|REPLACE_ME|TODO)/i;
  const found: ApiKeyScan = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const [provider, regex] of patterns) {
      if (found[provider]) continue;
      const m = content.match(regex);
      if (!m) continue;
      const value = m[1];
      if (value.startsWith("$")) continue;
      if (placeholder.test(value)) continue;
      if (value.length < 12) continue;
      found[provider] = value;
    }
  }
  return found;
}

function fileExists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export interface ExistingUserContent {
  telosPresent: boolean;
  identityPresent: boolean;
  contactsPresent: boolean;
  projectsPresent: boolean;
  /** True if the user config tree already holds real (non-template) content. */
  populated: boolean;
}

/**
 * Read-only scan of a user config tree for already-present content, so setup
 * can branch on "populated tree" vs "fresh scaffold" without overwriting.
 */
export function detectExistingUserContent(lifeosUserDir: string): ExistingUserContent {
  // Covers both the current single-file schema (TELOS/TELOS.md) and the legacy
  // split layout (TELOS/MISSION.md, TELOS/GOALS.md).
  const telosPresent =
    fileExists(lifeosUserDir, "TELOS/TELOS.md") ||
    fileExists(lifeosUserDir, "TELOS/MISSION.md") ||
    fileExists(lifeosUserDir, "TELOS/GOALS.md");
  const identityPresent =
    fileExists(lifeosUserDir, "PRINCIPAL/PRINCIPAL_IDENTITY.md") ||
    fileExists(lifeosUserDir, "PRINCIPAL_IDENTITY.md") ||
    fileExists(lifeosUserDir, "DIGITAL_ASSISTANT/DA_IDENTITY.md");
  const contactsPresent = fileExists(lifeosUserDir, "CONTACTS.md");
  const projectsPresent = fileExists(lifeosUserDir, "PROJECTS.md");
  return {
    telosPresent,
    identityPresent,
    contactsPresent,
    projectsPresent,
    populated: telosPresent || identityPresent,
  };
}

// ── Settings.json hook inspection (read-only; InstallHooks does the writes) ──

export interface SettingsHookScan {
  exists: boolean;
  hookEventCount: number;
  hookEntryCount: number;
}

/**
 * Read-only count of existing hooks in a harness settings.json, so ScanConflicts
 * can report what's already wired before InstallHooks proposes a merge.
 */
export function scanSettingsHooks(settingsPath: string): SettingsHookScan {
  if (!existsSync(settingsPath)) return { exists: false, hookEventCount: 0, hookEntryCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  }
  if (typeof parsed !== "object" || parsed === null) return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  const events = Object.keys(hooks as Record<string, unknown>);
  let entries = 0;
  for (const ev of events) {
    const bucket = (hooks as Record<string, unknown>)[ev];
    if (Array.isArray(bucket)) entries += bucket.length;
  }
  return { exists: true, hookEventCount: events.length, hookEntryCount: entries };
}

// ════════════════════════════════════════════════════════════════════
//  Mutating helpers (used by ScaffoldUser / LinkUser / ActivateImports /
//  InstallHooks). Each is purpose-built for the bare-skill installer but
//  follows the proven logic from the legacy engine actions.ts.
// ════════════════════════════════════════════════════════════════════

import { cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

// Extended 2026-07-25 (Forge finding, v7.15.0 re-audit). The set stopped at .ts,
// so every Pulse component and the built Next bundle were invisible to
// substitution — a fresh install shipped a dashboard rendering
// `desc="scored against TELOS — is this good for what {{PRINCIPAL_NAME}} is
// actually doing?"` to the user, both in src and in the served
// out/_next/static chunk. .css carries them too (placeholders in CSS content strings).
const TEMPLATE_EXTENSIONS = new Set([
  ".md", ".json", ".txt", ".ts", ".toml", ".yaml", ".yml", ".sh",
  ".tsx", ".jsx", ".js", ".css",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "MEMORY"]);

/**
 * Directory skip shared by BOTH template walkers (`substituteTree` and
 * `checkSurvivingPlaceholders`). If it lives in only one walker the two
 * disagree about what they traverse — the checker reports "surviving
 * placeholders" in files substitution deliberately skips, and the gate reads
 * as broken substitution (public issues #1852, @DRAZY; #1874, @GRyndStone).
 * Anything skipped here is skipped by both, which is the property that makes
 * the substitute → verify pair a closed loop.
 *
 * Three classes:
 *  - SKIP_DIRS (node_modules, .git, MEMORY — user state, never templatized);
 *  - the redistribution payload `skills/LifeOS/install/`, whose ~121 template
 *    files must stay generic for the NEXT install (public issue #1828,
 *    @Piroshki, root cause @DRAZY);
 *  - the install skill's own machinery `skills/LifeOS/{Tools,Intents}`, so the
 *    engine can never rewrite the IDENTITY_PLACEHOLDERS table it verifies
 *    against, or the Setup.md prose that documents the tokens.
 */
function shouldSkipDir(dir: string, entryName: string): boolean {
  if (SKIP_DIRS.has(entryName)) return true;
  if (!dir.endsWith(join("skills", "LifeOS"))) return false;
  return entryName === "install" || entryName === "Tools" || entryName === "Intents";
}

/**
 * Extension of a path's BASENAME, lowercased; "" when there is none.
 *
 * Was `filePath.slice(filePath.lastIndexOf("."))`, which searches the whole path:
 * for `~/.claude/skills/Fabric/Patterns/raycast/yt` that returns
 * ".claude/skills/Fabric/Patterns/raycast/yt" — the dot in `.claude`. Harmless by
 * accident (no such key in the set, so extension-less files were skipped), but it
 * would have mis-typed any file under a dotted directory the moment the set grew.
 */
function fileExtension(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Recursive, existsSync-GUARDED copy. Copies only files/dirs absent at dst —
 * NEVER overwrites a populated target. Returns count + any failures. (Ported
 * from engine actions.ts copyMissing.)
 */
export function copyMissing(src: string, dst: string): { copied: number; failures: string[] } {
  const failures: string[] = [];
  let copied = 0;
  const walk = (s: string, d: string): void => {
    if (!existsSync(s)) return;
    const stat = lstatSync(s);
    if (stat.isFile()) {
      if (!existsSync(d)) {
        try {
          mkdirSync(dirname(d), { recursive: true });
          cpSync(s, d);
          copied++;
        } catch (err) {
          failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    for (const entry of readdirSync(s, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!existsSync(dp)) mkdirSync(dp, { recursive: true });
        walk(sp, dp);
      } else if (entry.isFile() && !existsSync(dp)) {
        try {
          cpSync(sp, dp);
          copied++;
        } catch (err) {
          failures.push(`${sp} → ${dp}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };
  walk(src, dst);
  return { copied, failures };
}

export interface TemplateVars {
  [placeholder: string]: string;
}

/**
 * Walk a tree and replace `{{PLACEHOLDER}}` tokens in template-extension files.
 * Atomic per-file (tmp + rename). Directory skips are `shouldSkipDir` — the same
 * set `checkSurvivingPlaceholders` uses, so substitution and verification always
 * traverse identically. `opts.dryRun` counts what would change and writes nothing.
 * (Simplified from engine actions.ts substituteTemplates.)
 */
/** The rule a followed symlink meets in substituteTree and checkSurvivingPlaceholders alike: its real path stays inside the walked root or the one sanctioned USER link. */
function linkContainment(rootDir: string): (real: string) => boolean {
  const realOrNull = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
  const linkRoots = [rootDir, join(rootDir, "LIFEOS", "USER"), ...(basename(resolve(rootDir)) === "LIFEOS" ? [join(rootDir, "USER")] : [])]
    .map(realOrNull).filter((p): p is string => p !== null);
  return (real: string): boolean => linkRoots.some((r) => real === r || real.startsWith(r + sep));
}

export function substituteTree(rootDir: string, vars: TemplateVars, opts: { dryRun?: boolean } = {}): { scanned: number; modified: number; applied: number } {
  let scanned = 0;
  let modified = 0;
  let applied = 0;
  // The timezone token is filled from the machine when the caller does not supply it, so
  // no install keeps another person's zone (in-family audit, 7.52.0 cut).
  if (!vars["{{TIMEZONE}}"]) vars = { ...vars, "{{TIMEZONE}}": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
  const entries = Object.entries(vars);
  // The prose form `{PRINCIPAL.NAME}` / `{DA_IDENTITY.NAME}` (documented in the release
  // workflow's token table) resolves to the same values as its {{TOKEN}} twin. Before this,
  // 100+ workflow lines addressed the owner by an unfilled token after setup (in-family audit, 7.52.0).
  const dotted: Array<[string, string]> = [
    ["{PRINCIPAL.NAME}", "{{PRINCIPAL_NAME}}"], ["{PRINCIPAL.FULL_NAME}", "{{PRINCIPAL_FULL_NAME}}"],
    ["{DA_IDENTITY.NAME}", "{{DA_NAME}}"], ["{DA_IDENTITY.FULL_NAME}", "{{DA_FULL_NAME}}"],
    ["{DA_IDENTITY.DISPLAY_NAME}", "{{DA_NAME}}"], ["{DA_IDENTITY.VOICEID}", "{{PRIMARY_VOICE_ID}}"],
  ];
  const processFile = (filePath: string): void => {
    if (!TEMPLATE_EXTENSIONS.has(fileExtension(filePath))) return;
    scanned++;
    const before = readFileSync(filePath, "utf-8");
    let after = before;
    for (const [prose, token] of dotted) {
      const value = (vars as Record<string, string | undefined>)[token];
      if (value === undefined || !after.includes(prose)) continue;
      const parts = after.split(prose);
      applied += parts.length - 1;
      after = parts.join(value);
    }
    for (const [placeholder, value] of entries) {
      // Only substitute properly-delimited {{TOKEN}} placeholders. A caller
      // passing a bare key (e.g. "HOME") would otherwise rewrite every HOME
      // substring across settings AND source — `const HOME` became
      // `const /home/<user>` and corrupted 146 .ts files on one install
      // (public issue #1484, @docxology).
      if (!/^\{\{[A-Z0-9_]+\}\}$/.test(placeholder)) continue;
      const parts = after.split(placeholder);
      applied += parts.length - 1;
      after = parts.join(value);
    }
    if (after !== before && opts.dryRun) { modified++; return; }
    if (after !== before) {
      // Preserve the original mode: writeFileSync creates the tmp at umask
      // default (0644) and renameSync replaces the inode, so without this every
      // substituted hook lost its exec bit — 10 wired hooks silently dead on a
      // fresh install (public issue #1803, @mark-219).
      const mode = statSync(filePath).mode & 0o7777;
      const tmp = filePath + ".lifeos.tmp";
      writeFileSync(tmp, after, { mode });
      renameSync(tmp, filePath);
      modified++;
    }
  };
  // LinkUser makes <configRoot>/LIFEOS/USER a symlink before this pass runs, and a Dirent
  // reports a symlink as neither file nor directory, so the USER scaffold (and its
  // {{TIMEZONE}}) was never visited (round-6 in-family audit). Symlinked directories are
  // followed once each, by real path, so a cycle cannot loop. A followed link must stay inside the walked root or
  // inside that one sanctioned cross-root link (LIFEOS/USER, or USER when the root is LIFEOS/): a link whose real path
  // leaves them points at another profile, a checkout or a system file, and rendering it would write there.
  const seen = new Set<string>();
  const contained = linkContainment(rootDir);
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (shouldSkipDir(dir, entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) processFile(child);
      else if (entry.isSymbolicLink()) {
        try {
          const real = realpathSync(child);
          if (!contained(real)) continue;
          if (statSync(real).isDirectory()) { if (!seen.has(real)) { seen.add(real); walk(child); } }
          else processFile(child);
        } catch { /* dangling link */ }
      }
    }
  };
  if (existsSync(rootDir) && lstatSync(rootDir).isFile()) processFile(rootDir);
  else walk(rootDir);
  return { scanned, modified, applied };
}

/**
 * Identity placeholders the release sanitizer emits and `substituteTree` is
 * expected to fill. Scoped deliberately: the payload legitimately contains other
 * `{{TOKEN}}` forms (Art's thumbnail templating, Fabric pattern bodies, prose
 * about placeholders), so a blanket `{{[A-Z_]+}}` sweep is noise, not a signal.
 */
// Built at runtime so the literal `{{TOKEN}}` form never appears in this file:
// a substitution pass that reaches it (a file-shaped root, a walker without the
// skip list) would otherwise rewrite the very table the gate verifies against.
// ported from public PR #2022, @rathko
const IDENTITY_TOKEN_NAMES = [
  "DA_NAME", "DA_FULL_NAME", "PRINCIPAL_NAME", "PRINCIPAL_FULL_NAME",
  "PRIMARY_VOICE_ID", "SECONDARY_VOICE_ID", "LIFEOS_VERSION", "TIMEZONE",
] as const;
const IDENTITY_PLACEHOLDERS: readonly string[] = [
  ...IDENTITY_TOKEN_NAMES.map((n) => "{{" + n + "}}"),
  // The dotted prose form substituteTree also fills (in-family audit, 7.52.0 cut).
  ...["PRINCIPAL.NAME", "PRINCIPAL.FULL_NAME", "DA_IDENTITY.NAME", "DA_IDENTITY.FULL_NAME", "DA_IDENTITY.DISPLAY_NAME", "DA_IDENTITY.VOICEID"].map((n) => "{" + n + "}"),
];

/**
 * Post-substitution verification: report any identity placeholder still present
 * in the installed tree.
 *
 * Why this exists (Forge finding D, 2026-07-25 v7.15.0 audit): `substituteTree`
 * has no code caller. The install is AI-driven by design — `Intents/Setup.md`
 * step 34 instructs the agent to call it — so a skipped or mis-rooted step ships
 * a system that addresses its owner as `{{PRINCIPAL_NAME}}` with nothing failing.
 * The old engine's `runSurvivingPlaceholdersCheck` covered this and was lost when
 * `engine/actions.ts` was retired; this restores it against the current engine.
 * Verification, not mutation: the caller decides whether to re-run substitution
 * or abort.
 */
export function checkSurvivingPlaceholders(rootDir: string): {
  passed: boolean; files: Array<{ file: string; placeholder: string; count: number }>; total: number; scanned: number;
} {
  const files: Array<{ file: string; placeholder: string; count: number }> = [];
  let total = 0;
  let scanned = 0;
  const processFile = (filePath: string): void => {
    if (!TEMPLATE_EXTENSIONS.has(fileExtension(filePath))) return;
    scanned++;
    let src: string;
    try { src = readFileSync(filePath, "utf-8"); } catch { return; }
    for (const placeholder of IDENTITY_PLACEHOLDERS) {
      const count = src.split(placeholder).length - 1;
      if (count > 0) { files.push({ file: filePath, placeholder, count }); total += count; }
    }
  };
  const seen = new Set<string>();
  const contained = linkContainment(rootDir);
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Same skip set as substituteTree — see shouldSkipDir. A walker that
      // descends where substitution never went reports unfillable tokens as
      // install failures (public issues #1852, @DRAZY; #1874, @GRyndStone).
      if (shouldSkipDir(dir, entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) processFile(child);
      else if (entry.isSymbolicLink()) {
        // Same symlink rule as substituteTree: the USER link is walked once, by real path, and a link
        // that leaves the walked root is not checked, since rendering never wrote there.
        try {
          const real = realpathSync(child);
          if (!contained(real)) continue;
          if (statSync(real).isDirectory()) { if (!seen.has(real)) { seen.add(real); walk(child); } }
          else processFile(child);
        } catch { /* dangling link */ }
      }
    }
  };
  if (existsSync(rootDir) && lstatSync(rootDir).isFile()) processFile(rootDir);
  else walk(rootDir);
  // public issue #2058, @cammcd: require both scanned > 0 and total === 0 to pass
  return { passed: scanned > 0 && total === 0, files, total, scanned };
}

/**
 * Establish the system/user separation contract: the live `<configRoot>/LIFEOS/USER`
 * becomes a SYMLINK to `<configDir>/USER` (the private user-data home). Copies any
 * live USER content into the data home first (existsSync-guarded), then replaces
 * the live dir with a symlink. Idempotent — a correct symlink is left untouched.
 * EXDEV (cross-filesystem) rename falls back to cp + rm. (Ported from engine.)
 */
/** Byte-compare two files; treats unreadable as "differs" (conservative). */
function filesDiffer(a: string, b: string): boolean {
  try {
    return !readFileSync(a).equals(readFileSync(b));
  } catch {
    return true;
  }
}

/**
 * Merge `src` into `dst` with LIVE-WINS semantics for the USER migration: a
 * missing dst file is copied; a byte-identical one is skipped; a DIFFERING one
 * is overwritten with src AFTER the displaced dst file is preserved aside as
 * `<file>.replaced-<stamp>`. Lossless in every direction — nothing is removed
 * without a recoverable copy. Symlinked entries are skipped (Dirent semantics).
 */
function mergeTree(src: string, dst: string, stamp: string): { copied: number; overwritten: number; preserved: number; failures: string[] } {
  let copied = 0;
  let overwritten = 0;
  let preserved = 0;
  const failures: string[] = [];
  const walk = (s: string, d: string): void => {
    if (!existsSync(s)) return;
    if (lstatSync(s).isFile()) {
      if (!existsSync(d)) {
        try { mkdirSync(dirname(d), { recursive: true }); cpSync(s, d); copied++; }
        catch (err) { failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`); }
      } else if (filesDiffer(s, d)) {
        try { cpSync(d, `${d}.replaced-${stamp}`); cpSync(s, d); overwritten++; preserved++; }
        catch (err) { failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      return;
    }
    for (const entry of readdirSync(s, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      if (entry.isDirectory()) { if (!existsSync(dp)) mkdirSync(dp, { recursive: true }); walk(sp, dp); }
      else if (entry.isFile()) walk(sp, dp);
    }
  };
  walk(src, dst);
  return { copied, overwritten, preserved, failures };
}

export interface LinkResult {
  action: "already-linked" | "linked" | "scaffolded-linked" | "link-repair-failed";
  target: string;
  copied: number;
  overwritten?: number;
  preserved?: number;
  backup?: string;
  error?: string;
}

/**
 * Establish ONE `live → data` directory symlink under the boundary contract.
 * Extracted from setupUserSeparation so `LIFEOS/USER` and `LIFEOS/MEMORY` get
 * byte-identical branch/backup/merge semantics rather than one of them being a
 * real directory in the harness tree (public issue #1882, @jacobo-ortiz,
 * @CarbonRaven, @xg-gh-25). `SystemUserBoundary.md` documents BOTH as symlinks
 * into the private USER_DATA repo; the installer only ever created the first,
 * so every personal write under MEMORY landed in the system tree.
 */
function establishLink(liveUserDir: string, dataUserDir: string): LinkResult {
  // Same path on both sides (configDir resolves inside configRoot) — nothing to
  // separate; the rename-aside branch below would EEXIST on its own symlink and
  // strand the backup tree. Public issue #1694, @dissembler21-png.
  if (resolve(liveUserDir) === resolve(dataUserDir)) {
    return { action: "already-linked", target: dataUserDir, copied: 0 };
  }

  // Branch (a): inspect any symlink occupying liveUserDir. lstatSync does NOT
  // follow the link, so it sees a DANGLING link (target moved, deleted, or
  // restored from backup) that existsSync — which follows — reports as absent.
  // Without this, a dangling link fell through every branch to symlinkSync on an
  // occupied path, EEXIST'd, and returned a success-shaped "scaffolded-linked"
  // action with the error buried in it. (Forge cross-vendor audit 2026-08-11, [C])
  const liveLstat = lstatSync(liveUserDir, { throwIfNoEntry: false });
  if (liveLstat?.isSymbolicLink()) {
    let dest: string | null = null;
    try { dest = readlinkSync(liveUserDir); } catch { /* unreadable link → treat as stale */ }
    if (dest === dataUserDir && existsSync(liveUserDir)) {
      // Correct link, target present → genuine no-op.
      return { action: "already-linked", target: dataUserDir, copied: 0 };
    }
    // Wrong target, or dangling (target missing) → remove the stale link so the
    // rebuild branches below recreate it. Unlinking a symlink never touches the
    // target's contents.
    try {
      unlinkSync(liveUserDir);
    } catch (err) {
      return { action: "link-repair-failed", target: dataUserDir, copied: 0, error: `could not remove stale/dangling USER symlink at ${liveUserDir}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  mkdirSync(dataUserDir, { recursive: true });
  let copied = 0;

  // Branch (b): live USER is a real dir → migrate into the data home LOSSLESSLY,
  // then symlink. We RENAME the live dir aside (never rm) so the user's real tree
  // ALWAYS survives, then merge it into the data home with live-wins so real
  // content beats any template stub ScaffoldUser placed first. The backup is
  // retained and reported; recovery is always possible, including if the symlink
  // step itself fails. This fixes the prior copyMissing-then-rm data-loss path
  // where a divergent dest stub was kept and the user's real file destroyed.
  if (existsSync(liveUserDir) && lstatSync(liveUserDir).isDirectory()) {
    const stamp = String(Date.now());
    const backupDir = `${liveUserDir}.pre-link-backup-${stamp}`;
    try {
      renameSync(liveUserDir, backupDir);
    } catch (err) {
      return { action: "linked", target: dataUserDir, copied: 0, error: `could not move live USER aside before symlink: ${err instanceof Error ? err.message : String(err)}` };
    }
    const merged = mergeTree(backupDir, dataUserDir, stamp);
    copied = merged.copied;
    try {
      mkdirSync(dirname(liveUserDir), { recursive: true });
      // public issue #1730, @umair-a11y — "junction" lets Windows link a dir without
      // elevation; the arg is ignored on POSIX.
      symlinkSync(dataUserDir, liveUserDir, "junction");
      return { action: "linked", target: dataUserDir, copied, overwritten: merged.overwritten, preserved: merged.preserved, backup: backupDir };
    } catch (err) {
      return { action: "linked", target: dataUserDir, copied, overwritten: merged.overwritten, preserved: merged.preserved, backup: backupDir, error: `symlink creation failed (live USER preserved at ${backupDir}): ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Branch (c): fresh install — scaffold the data home (if empty) + symlink.
  try {
    mkdirSync(dirname(liveUserDir), { recursive: true });
    // public issue #1730, @umair-a11y — see junction note above.
    symlinkSync(dataUserDir, liveUserDir, "junction");
    return { action: "scaffolded-linked", target: dataUserDir, copied };
  } catch (err) {
    return { action: "scaffolded-linked", target: dataUserDir, copied, error: `symlink creation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The `.gitignore` seeded into a fresh USER_DATA repo. This file IS the
 * implementation of the durable/ephemeral split that `SystemUserBoundary.md`
 * describes for `LIFEOS/MEMORY/**` — durable notes are tracked, runtime state is
 * local-only. Keep the two in step: the doc names this constant as the control
 * of record, so a change here is a change to the documented contract.
 *
 * Everything not matched below is tracked, which is why the durable set
 * (KNOWLEDGE, RELATIONSHIP, WISDOM, PLANS, RESEARCH, BOOKMARKS, REFERENCE,
 * SKILLS, PROJECT, TEAMS, SYSTEMUPDATES, VERIFICATION) needs no entry.
 */
export const USER_DATA_GITIGNORE = `# LifeOS USER_DATA repo — durable/ephemeral split.
# Contract: LIFEOS/DOCUMENTATION/SystemUserBoundary.md § USER.
# Durable life data is tracked; runtime state and secrets stay machine-local.

# --- Secrets — never push, even to a private repo ---
CONFIG/CREDENTIALS/
*.env
*.env.*
!*.env.example

# --- Top-level runtime state ---
CACHE/
DAEMON/
INBOX/
Backups/

# --- Nested projects with their own git lifecycle ---
CUSTOMIZATIONS/WORKFLOWS/

# --- MEMORY: ephemeral subtrees (durable ones are tracked by omission) ---
MEMORY/OBSERVABILITY/
MEMORY/LEARNING/
MEMORY/SECURITY/
MEMORY/VOICE/
MEMORY/CACHE/
MEMORY/PULSE_DATA/
MEMORY/SCRATCHPAD/
MEMORY/RAW/
MEMORY/AUTO/
MEMORY/CALLS/
MEMORY/INBOX/
MEMORY/ARCHIVE/
MEMORY/DATA/
# Per-skill runtime state and browser profiles, by convention underscore-prefixed.
MEMORY/_*/

# STATE/ is ephemeral caches EXCEPT work.json, the canonical session registry.
# Must use /* (file glob) not / (dir match): git cannot re-include a file inside
# a fully-excluded directory.
MEMORY/STATE/*
!MEMORY/STATE/work.json

# WORK/<slug>/ keeps only ISA.md — per-session intermediates are local-only.
MEMORY/WORK/*/*
!MEMORY/WORK/*/ISA.md

# --- Build/OS artifacts ---
node_modules/
*.log
.DS_Store
`;

export interface UserRepoResult {
  action: "already-repo" | "initialized" | "skipped" | "init-failed";
  path: string;
  /** Why the step no-op'd, for "already-repo" and "skipped". */
  reason?: string;
  gitignore: "written" | "present" | "not-written";
  error?: string;
}

/** Run a git command in `cwd`, returning trimmed stdout or null on any failure. */
function tryGit(cwd: string, args: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd, timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Initialize the private USER_DATA repo at `<configDir>/USER` — `git init`, the
 * durable/ephemeral `.gitignore` above, and a seed commit.
 *
 * `SystemUserBoundary.md` has documented this repo and its git-tracked split
 * since Phase G.1, but no install tool ever created it: `setupUserSeparation`
 * only laid the symlinks, so a fresh install had the documented control on paper
 * and nothing on disk (public issue #1897, @waveman2020-sudo).
 *
 * Three guards, all provable no-ops rather than best-effort:
 *  - a directory that is already the top level of a git repo is left untouched;
 *  - a directory INSIDE an existing repo (a config dir nested under the harness
 *    tree, or under any other checkout) is skipped, never nested-init'd;
 *  - no git on PATH is a skip, not a failure.
 * The seed commit stages `.gitignore` by explicit path — never `-A` — so the
 * step can only ever add the file it just wrote, whatever else is lying around.
 * Committer identity is passed per-invocation with `-c`, so a machine with no
 * global git identity still gets a commit and its config is never mutated.
 */
export function initUserDataRepo(dataUserDir: string): UserRepoResult {
  return initLocalRepo(dataUserDir, USER_DATA_GITIGNORE, "LifeOS: initialize private USER_DATA repo");
}

/**
 * Ignore rules the config-root repo needs BEFORE any commit can happen there:
 * the env file, the harness's OAuth token store, per-skill sessions, the two
 * links into the private USER_DATA tree (no trailing slash, so the symlink
 * entries themselves are ignored — and the real dirs too if linking failed),
 * and Claude Code's own transcript/state dirs. Appended line-by-line when
 * missing, because install.sh already seeds a capture-rules `.gitignore` at
 * this root before Setup runs, so a write-if-absent would leave `.env`
 * uncovered (public issue #2036, @tzioup).
 */
export const CONFIG_ROOT_GITIGNORE_RULES = [
  "# LifeOS config-root repo — local history only; secrets and harness state are never tracked",
  ".env",
  ".env.*",
  "!.env.example",
  // The age-sealed copy is what git carries (Secrets.ts seal) — mirrors the
  // live config-root .gitignore; without these two re-includes a public install
  // could never commit its sealed secrets (2026-09-03 /LI audit, finding 2).
  "!.env.age",
  "!.env.age.meta.json",
  "/.credentials.json",
  "**/.session/",
  "LIFEOS/USER",
  "LIFEOS/MEMORY",
  "projects/",
  ".lifeos-skill-backups/",
  "history.jsonl",
  "file-history/",
  "shell-snapshots/",
  "session-env/",
  "paste-cache/",
  "todos/",
  "debug/",
  "telemetry/",
  "[Ss]tatsig/",
  "node_modules/",
  "*.log",
  ".retired-*/",
  ".lifeos-overlay-backups/",
  "*.lifeos-backup-*",
  "LifeOS.backup-*/",
];

/** Append whichever of `rules` the file lacks (exact-line match). Idempotent. */
export function ensureGitignoreRules(dir: string, rules: string[]): UserRepoResult["gitignore"] {
  if (rules.length === 0) throw new Error("InvariantViolation: ensureGitignoreRules called with no rules");
  const file = join(dir, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = rules.filter((r) => !have.has(r));
  if (missing.length === 0) return "present";
  try {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${existing}${sep}${missing.join("\n")}\n`);
    return "written";
  } catch {
    return "not-written";
  }
}

/**
 * Initialize a LOCAL git repo at the config root (no remote is ever created),
 * so an install has history from day one — public issue #2036, @tzioup. The
 * ignore rules are ensured FIRST and unconditionally: they protect whichever
 * repo sees this tree — the one created here, one the operator already keeps
 * (#1566), or a parent checkout this root is nested in (git honours a nested
 * `.gitignore`, and nesting a second repo is refused as before).
 */
export function initConfigRootRepo(configRoot: string): UserRepoResult {
  if (!existsSync(configRoot)) return { action: "skipped", path: configRoot, reason: "config root does not exist", gitignore: "not-written" };
  const gitignore = ensureGitignoreRules(configRoot, CONFIG_ROOT_GITIGNORE_RULES);
  const r = initLocalRepo(configRoot, `${CONFIG_ROOT_GITIGNORE_RULES.join("\n")}\n`, "LifeOS: initialize config-root repo");
  return { ...r, gitignore: gitignore === "written" ? "written" : r.gitignore };
}

function initLocalRepo(path: string, seedGitignore: string, commitMessage: string): UserRepoResult {
  if (!existsSync(path)) return { action: "skipped", path, reason: "directory does not exist", gitignore: "not-written" };

  if (!findBin("git")) {
    // Non-fatal by contract: the boundary is the symlinks, and those are already
    // established. Record the degradation and let the install finish.
    return { action: "skipped", path, reason: "git not found on PATH", gitignore: "not-written" };
  }

  // `--show-toplevel` answers both "is this a repo?" and "whose repo?" in one
  // call, which a bare existsSync(.git) cannot: it also catches the case where an
  // ancestor is the checkout and we would otherwise nest a second repo inside it.
  const toplevel = tryGit(path, "rev-parse --show-toplevel");
  if (toplevel) {
    let here = path;
    try { here = realpathSync(path); } catch { /* fall back to the literal path */ }
    let top = toplevel;
    try { top = realpathSync(toplevel); } catch { /* ditto */ }
    if (top === here) return { action: "already-repo", path, reason: `already a git repo (${toplevel})`, gitignore: existsSync(join(path, ".gitignore")) ? "present" : "not-written" };
    return { action: "skipped", path, reason: `inside an existing git repo (${toplevel}) — refusing to nest a second one`, gitignore: "not-written" };
  }

  // `-b main` needs git >= 2.28; fall back to whatever the default branch is.
  if (tryGit(path, "init -b main") === null && tryGit(path, "init") === null) {
    return { action: "init-failed", path, gitignore: "not-written", error: `git init failed in ${path}` };
  }

  const gitignorePath = join(path, ".gitignore");
  let gitignore: UserRepoResult["gitignore"] = "present";
  if (!existsSync(gitignorePath)) {
    try {
      writeFileSync(gitignorePath, seedGitignore);
      gitignore = "written";
    } catch (err) {
      return { action: "initialized", path, gitignore: "not-written", error: `git init succeeded but .gitignore write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const ident = `-c user.name="LifeOS Installer" -c user.email="installer@lifeos.local"`;
  if (tryGit(path, "add -- .gitignore") === null) {
    return { action: "initialized", path, gitignore, error: "repo created but staging .gitignore failed" };
  }
  if (tryGit(path, `${ident} commit -m "${commitMessage}" -- .gitignore`) === null) {
    return { action: "initialized", path, gitignore, error: "repo created but the seed commit failed" };
  }
  return { action: "initialized", path, gitignore };
}

/**
 * The boundary contract in full: BOTH `<configRoot>/LIFEOS/USER` and
 * `<configRoot>/LIFEOS/MEMORY` become symlinks into `<configDir>/USER`.
 *
 * MEMORY was previously left as a real directory inside the harness tree, so an
 * install honoured half of `SystemUserBoundary.md` and wrote knowledge notes,
 * transcripts and observability JSONL into the system tree — invisible to the
 * USER_DATA repo the doc says holds them (public issue #1882, @jacobo-ortiz,
 * @CarbonRaven, @xg-gh-25). This links it instead of sanctioning a second root.
 * A MEMORY-leg failure is folded into the returned `error` so callers fail loud
 * rather than reporting a half-established boundary as success.
 *
 * The third leg initializes the private USER_DATA git repo the boundary doc has
 * always assumed exists (public issue #1897, @waveman2020-sudo). It runs last,
 * so the seed commit sees the finished layout. Unlike the MEMORY leg its failure
 * is NOT folded into `error`: the boundary itself is the two symlinks, and those
 * are already established by the time it runs, so a machine with no git gets a
 * working install plus a recorded `repo.reason` rather than a failed one.
 */
export function setupUserSeparation(
  configRoot: string,
  configDir: string,
): LinkResult & { memory: LinkResult; repo: UserRepoResult } {
  const user = establishLink(join(configRoot, "LIFEOS", "USER"), join(configDir, "USER"));
  const memory = establishLink(join(configRoot, "LIFEOS", "MEMORY"), join(configDir, "USER", "MEMORY"));
  const repo = initUserDataRepo(join(configDir, "USER"));
  const error = [user.error, memory.error ? `MEMORY: ${memory.error}` : undefined].filter(Boolean).join(" | ") || undefined;
  return { ...user, error, memory, repo };
}

/**
 * Establish only the MEMORY leg. LinkUser uses it when the USER leg already
 * resolves correctly, so a missing or wrong MEMORY link is repaired without
 * rebuilding the USER link.
 */
export function linkMemory(configRoot: string, configDir: string): LinkResult {
  return establishLink(join(configRoot, "LIFEOS", "MEMORY"), join(configDir, "USER", "MEMORY"));
}

/**
 * Validate the symlink contract, both legs: `<configRoot>/LIFEOS/USER` is a
 * symlink → `<configDir>/USER`, and `<configRoot>/LIFEOS/MEMORY` is a symlink
 * → `<configDir>/USER/MEMORY` (the pair setupUserSeparation establishes).
 * (Ported from engine validate.ts runSymlinkContractCheck.)
 *
 * Only the USER leg was checked, so an install whose MEMORY link was never
 * made (or was later replaced by a real directory) passed the contract while
 * writing memory into the system tree (public issue #1972, @willhern829, @spazbg).
 */
/** True when both paths exist and canonicalize to the same directory. */
function sameRealDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export function checkSymlinkContract(configRoot: string, configDir: string): { passed: boolean; detail: string } {
  const legs: ReadonlyArray<readonly [link: string, expected: string]> = [
    [join(configRoot, "LIFEOS", "USER"), join(configDir, "USER")],
    [join(configRoot, "LIFEOS", "MEMORY"), join(configDir, "USER", "MEMORY")],
  ];
  const passed: string[] = [];
  for (const [link, expected] of legs) {
    if (!existsSync(link)) return { passed: false, detail: `missing: ${link}` };
    const st = lstatSync(link);
    if (!st.isSymbolicLink()) return { passed: false, detail: `${link} is not a symlink (system/user separation broken)` };
    let target: string;
    try {
      target = readlinkSync(link);
    } catch (err) {
      return { passed: false, detail: `readlink failed for ${link}: ${err instanceof Error ? err.message : String(err)}` };
    }
    // The contract is where the link resolves, not how its target is spelled: a
    // relative link, a symlinked home or /private canonicalization reaches the
    // same directory with a different string (public issue #1694).
    if (target !== expected && !sameRealDir(link, expected)) {
      return { passed: false, detail: `${link}: symlink points to ${target}, expected ${expected}` };
    }
    passed.push(target === expected ? `${link} → ${expected}` : `${link} → ${target} (resolves to ${expected})`);
  }
  return { passed: true, detail: passed.join("; ") };
}

// ── Hooks merge (InstallHooks core — the one genuinely-new piece) ──

type HookEntry = { type?: string; command?: string; url?: string; [k: string]: unknown };
type MatcherGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type HooksMap = Record<string, MatcherGroup[]>;

/**
 * Every spelling of the install root a hook command may carry. Order matters: the
 * `${CLAUDE_CONFIG_DIR:-…}` default forms must match WHOLE, ahead of the bare
 * ~/.claude / $HOME/.claude they contain, so an upgrade dedupes a stale
 * `$HOME/.claude/x` entry against the new templated form of the same hook.
 * LIFEOS_DIR / CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_ROOT stay in the set — dropping
 * any would un-dedupe hooks written that way.
 * ported from public PR #1943, @MarnuLombard
 */
const ROOT_FORMS: RegExp[] = [
  /\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}/,
  /\$\{CLAUDE_CONFIG_DIR:-\$\{HOME\}\/\.claude\}/,
  /\$\{CLAUDE_CONFIG_DIR:-~\/\.claude\}/,
  /\$\{?CLAUDE_CONFIG_DIR\}?/,
  /\$\{?LIFEOS_DIR\}?/,
  /\$\{?CLAUDE_PROJECT_DIR\}?/,
  /\$\{?CLAUDE_PLUGIN_ROOT\}?/,
  /~\/\.claude/,
  /\$HOME\/\.claude/,
  /\$\{HOME\}\/\.claude/,
];
const ROOT_PATTERN = new RegExp(ROOT_FORMS.map((r) => r.source).join("|"), "g");

/**
 * Normalize a hook command for dedup: collapse any install-root spelling (see
 * ROOT_FORMS) to a single canonical token and squeeze whitespace, so the same hook
 * expressed as `${LIFEOS_DIR}/x`, `$HOME/.claude/x`, or
 * `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/x` all dedupe to one.
 */
function normalizeCommand(cmd: string, configRoot?: string): string {
  let out = cmd;
  // An already-installed entry carries the resolved configRoot literal while the
  // incoming payload entry still carries the $HOME form. Both must collapse to
  // the same token or a second run duplicates every hook.
  // On Windows the root may appear raw, bash-escaped (installs before
  // hookRootPath) or with forward slashes (hookRootPath); collapse all three.
  if (configRoot) {
    for (const form of new Set([shellQuoteRoot(configRoot, "none"), hookRootPath(configRoot), configRoot])) {
      out = out.split(form).join("§ROOT§");
    }
  }
  return out
    .replace(ROOT_PATTERN, "§ROOT§")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identity key for a hook entry: http → url, else normalized command. */
export function hookKey(h: HookEntry, configRoot?: string): string {
  if (h.type === "http" && h.url) return `http:${h.url}`;
  if (h.command) return `cmd:${normalizeCommand(h.command, configRoot)}`;
  return `raw:${JSON.stringify(h)}`;
}

/** Remove only registrations that name a retired hook script. Pure; preserves foreign hooks. */
export function pruneRetiredHooks(existing: HooksMap, retirements: string[], configRoot?: string): { hooks: HooksMap; pruned: number } {
  const retired = new Set(retirements.filter(path => /^hooks\/.+\.(?:ts|js|sh)$/.test(path)).map(path => `§ROOT§/${path}`));
  const hooks: HooksMap = {};
  let pruned = 0;
  // Pruning is narrower than deduplication: project and plugin roots belong to
  // their owners, and a later argument can merely mention a retired filename.
  const pruneRoots = [
    /\$\{CLAUDE_CONFIG_DIR:-\$HOME\/\.claude\}/,
    /\$\{CLAUDE_CONFIG_DIR:-\$\{HOME\}\/\.claude\}/,
    /\$\{CLAUDE_CONFIG_DIR:-~\/\.claude\}/,
    /\$\{?CLAUDE_CONFIG_DIR\}?/,
    /\$\{?LIFEOS_DIR\}?/,
    /~\/\.claude/,
    /\$HOME\/\.claude/,
    /\$\{HOME\}\/\.claude/,
  ];
  const rootPattern = new RegExp(pruneRoots.map(root => root.source).join("|"), "g");
  const literalRoot = configRoot ? resolve(configRoot) : undefined;
  const executedScript = (command: string): string => {
    const tokens = command.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
    const first = tokens[0]?.replace(/^["']|["']$/g, "") ?? "";
    const runner = /^(?:bun|node|bash|sh)$/.test(first);
    return (runner ? tokens[1] : tokens[0])?.replace(/^["']|["']$/g, "") ?? "";
  };
  for (const [event, groups] of Object.entries(existing ?? {})) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = groups.flatMap(group => {
      if (!group || !Array.isArray(group.hooks)) return [group];
      const entries = group.hooks;
      const remaining = entries.filter(entry => {
        const script = typeof entry?.command === "string" ? executedScript(entry.command) : "";
        const normalized = (literalRoot && script.startsWith(`${literalRoot}/`) ? `§ROOT§${script.slice(literalRoot.length)}` : script).replace(rootPattern, "§ROOT§");
        const matches = retired.has(normalized);
        if (matches) pruned++;
        return !matches;
      });
      if (remaining.length === entries.length) return [group];
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    if (kept.length || groups.length === 0 || kept.length === groups.length) hooks[event] = kept;
  }
  return { hooks, pruned };
}

type QuoteState = "none" | "single" | "double";

/** Which quote (if any) the shell is inside at `offset` of `cmd`, scanning left to right. */
function quoteStateAt(cmd: string, offset: number): QuoteState {
  let state: QuoteState = "none";
  for (let i = 0; i < offset; i++) {
    const c = cmd[i];
    if (state === "none") {
      if (c === "\\") i++;
      else if (c === "'") state = "single";
      else if (c === '"') state = "double";
    } else if (state === "double") {
      if (c === "\\") i++;
      else if (c === '"') state = "none";
    } else if (c === "'") state = "none";
  }
  return state;
}

/** The config root as the shell must read it at that position: one word whatever the path holds (spaces, `$`, `;`, quotes). */
function shellQuoteRoot(root: string, state: QuoteState): string {
  if (state === "single") return root.replace(/'/g, "'\\''"); // verbatim inside '…'; a ' closes the quote, adds an escaped ', reopens
  if (state === "double") return root.replace(/[\\"$`]/g, "\\$&");
  return root.replace(/[^A-Za-z0-9_./:@%+,=~-]/g, "\\$&");
}

/**
 * Resolve the payload's HOME-relative hook paths to `configRoot` BEFORE merge.
 *
 * `install/hooks/hooks.json` ships every command as a literal
 * `$HOME/.claude/hooks/<name>` (EmitSkill round-trips the live settings.json).
 * normalizeCommand collapsed that form for the DEDUP comparison only — nothing
 * ever rewrote it on the write path, so an install into any non-default config
 * root wrote commands pointing at `$HOME/.claude`. `$HOME` expands at hook FIRE
 * time, so those hooks were not merely dead: on a machine that also has a real
 * `~/.claude`, the isolated profile executed the DEFAULT profile's hook
 * binaries on every event (discussion #1900 finding 1, @Patrickraveaux).
 *
 * Harness-provided vars (LIFEOS_DIR, CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_ROOT)
 * are left alone — those resolve correctly at fire time by design.
 */
export function rewriteHookRoots(hooks: HooksMap, configRoot: string): HooksMap {
  const out: HooksMap = JSON.parse(JSON.stringify(hooks ?? {}));
  for (const groups of Object.values(out)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (typeof h.command === "string") h.command = rewriteHomeRoot(h.command, configRoot);
      }
    }
  }
  return out;
}

const HOME_FORMS = /(?:~|\$HOME|\$\{HOME\})\/\.claude/g;

/** One command with every HOME-relative `.claude` root resolved to `configRoot`, quoted for its shell position. */
function rewriteHomeRoot(cmd: string, configRoot: string): string {
  return cmd.replace(HOME_FORMS, (_m, offset: number) => shellQuoteRoot(hookRootPath(configRoot), quoteStateAt(cmd, offset)));
}

/**
 * The config root as hook commands spell it. On Windows the hooks run through
 * Git Bash, where a backslash is an escape: the bash-escaped `C:\\Users\\me\\.claude`
 * reached bun as `C:Usersme.claude` once the command line also passed through
 * MSYS argv parsing, so every `bun <root>/...` hook failed to load. Forward
 * slashes need no escaping, and bash and bun both accept them.
 */
export function hookRootPath(configRoot: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? configRoot.replace(/\\/g, "/") : configRoot;
}

/** Rewrite installed commands that carry the bash-escaped Windows root to the hookRootPath form. */
export function repairWindowsHookRoots(hooks: HooksMap, configRoot: string, platform: NodeJS.Platform = process.platform): { hooks: HooksMap; repaired: number } {
  if (platform !== "win32") return { hooks, repaired: 0 };
  const escaped = shellQuoteRoot(resolve(configRoot), "none");
  const fixed = hookRootPath(resolve(configRoot), platform);
  const out: HooksMap = JSON.parse(JSON.stringify(hooks ?? {}));
  let repaired = 0;
  for (const groups of Object.values(out)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (typeof h.command === "string" && h.command.includes(escaped)) {
          h.command = h.command.split(escaped).join(fixed);
          repaired++;
        }
      }
    }
  }
  return { hooks: out, repaired };
}

/**
 * Repoint installed LifeOS hook registrations that still name `$HOME/.claude` inside a custom `configRoot`.
 *
 * An install made before rewriteHookRoots existed wrote the payload's `$HOME/.claude/hooks/<name>` literals into a
 * non-default profile's settings.json. mergeHooks dedups that entry against the rewritten incoming one (both normalize
 * to the same key) and keeps the stale command, so the profile went on firing the DEFAULT profile's hooks after every
 * upgrade. Only an entry whose rewritten command is exactly a shipped incoming command is touched, so a foreign hook
 * that deliberately names `~/.claude` stays as written. The default root needs no repair: `$HOME/.claude` already is it.
 * Pure (no I/O).
 */
export function repointHookRoots(existing: HooksMap, incoming: HooksMap, configRoot: string, home: string): { hooks: HooksMap; repointed: number } {
  const hooks: HooksMap = JSON.parse(JSON.stringify(existing ?? {}));
  if (resolve(configRoot) === resolve(claudeDirFor({}, home))) return { hooks, repointed: 0 };
  const shipped = new Set(
    Object.values(incoming ?? {})
      .flatMap((groups) => (Array.isArray(groups) ? groups : []))
      .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
      .map((h) => h.command)
      .filter((c): c is string => typeof c === "string"),
  );
  let repointed = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue;
      for (const h of g.hooks) {
        if (typeof h.command !== "string") continue;
        const rewritten = rewriteHomeRoot(h.command, configRoot);
        if (rewritten !== h.command && shipped.has(rewritten)) {
          h.command = rewritten;
          repointed++;
        }
      }
    }
  }
  return { hooks, repointed };
}

/**
 * Additively merge `incoming` hooks into `existing` settings.hooks, per matcher
 * bucket, idempotent by normalized-command (and url for http). NEVER removes or
 * reorders a foreign entry. Returns the merged map + counts. Pure (no I/O).
 */
export function mergeHooks(existing: HooksMap, incoming: HooksMap, configRoot?: string): { merged: HooksMap; added: number; skipped: number } {
  // Deep-clone existing so we never mutate the caller's object.
  const merged: HooksMap = JSON.parse(JSON.stringify(existing ?? {}));
  let added = 0;
  let skipped = 0;

  for (const [event, incomingGroups] of Object.entries(incoming ?? {})) {
    if (!Array.isArray(merged[event])) merged[event] = [];
    const eventBucket = merged[event];

    for (const inGroup of incomingGroups) {
      const matcher = inGroup.matcher ?? "";
      const inHooks = Array.isArray(inGroup.hooks) ? inGroup.hooks : [];
      // Find a same-matcher group already present.
      let target = eventBucket.find((g) => (g.matcher ?? "") === matcher);
      if (!target) {
        // New matcher bucket — append a fresh group, then fill it (counts each hook as added).
        target = { matcher, hooks: [] };
        eventBucket.push(target);
      }
      if (!Array.isArray(target.hooks)) target.hooks = [];
      // Dedup against EVERY same-matcher group, not just the first: a settings.json
      // can carry the same matcher twice (hand edits, older installers), and a hook
      // living in the second group was re-added to the first on every upgrade. New
      // hooks still land in the first group. public issue #2239, @Clausinho
      const present = new Set(
        eventBucket
          .filter((g) => (g.matcher ?? "") === matcher)
          .flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : []).map((h) => hookKey(h, configRoot))),
      );
      for (const h of inHooks) {
        const key = hookKey(h, configRoot);
        if (present.has(key)) {
          skipped++;
        } else {
          target.hooks.push(h);
          present.add(key);
          added++;
        }
      }
    }
  }
  return { merged, added, skipped };
}

/**
 * Uncomment the identity `@`-imports in a CLAUDE.md, each guarded by existsSync
 * of its symlink-resolved target under configRoot. Lines shipped as
 * `<!-- @LIFEOS/USER/... -->` are activated to `@LIFEOS/USER/...` only when the target
 * resolves. Returns which imports were activated vs left commented.
 */
export function activateImports(claudeMdPath: string, configRoot: string): { activated: string[]; skipped: string[] } {
  const activated: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(claudeMdPath)) return { activated, skipped };
  const lines = readFileSync(claudeMdPath, "utf-8").split("\n");
  // Two dormant-import conventions, both accepted. The shipped template uses
  // `<!-- @LIFEOS/USER/... -->`: Claude Code skips imports inside an HTML comment.
  // The hash-prefixed `# @LIFEOS/USER/...` form is still matched so CLAUDE.md files
  // from older installs activate, but it was never dormant: Claude Code resolves
  // `@path` inside a heading line, so it loaded the USER templates at every
  // session start (public issue #2296). Activation strips the wrapper either way.
  const commented = /^\s*#\s+(@[\w./-]+)\s*$|^\s*<!--\s*(@[\w./-]+)\s*-->\s*$/;
  const out = lines.map((line) => {
    const m = line.match(commented);
    if (!m) return line;
    const importPath = m[1] || m[2]; // e.g. @LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md
    const rel = importPath.replace(/^@/, "");
    if (existsSync(join(configRoot, rel))) {
      activated.push(importPath);
      return importPath;
    }
    skipped.push(importPath);
    return line;
  });
  if (activated.length > 0) writeFileSync(claudeMdPath, out.join("\n"));
  return { activated, skipped };
}

export { resolve };
