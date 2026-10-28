#!/usr/bin/env bun
/**
 * DeployComponents — Setup step 7.5 (opt-in). Deploys the AI-wide runtime
 * components that the bare skill SHIPS but does not auto-activate: the Pulse
 * dashboard service, the statusline, and the optional launchd jobs
 * (worksweep, derivedsync). Each component is OPT-IN — the Setup intent asks
 * which the user wants, then calls this with `--components <csv>` (or `--all`).
 *
 * Thin orchestrator: it does not reimplement plist substitution / launchctl.
 * Every launchd component (pulse, worksweep, derivedsync, and any other
 * registry service) is delegated to `LIFEOS/TOOLS/Services.ts install --only`,
 * the single source of truth for background services, which runs that
 * service's own installer (deployViaServices below).
 *
 * Self-staging: every component reads from the live runtime tree
 * `<configRoot>/LIFEOS`, falling back to the shipped payload `install/LifeOS/`
 * when the runtime tree isn't laid down yet — uniform across all four (the
 * cross-vendor audit flagged the prior pulse/statusline-only staging as an
 * inconsistent contract).
 *
 * Safety: dry-run by default (`--apply` to mutate); REFUSES on the author's live
 * source tree (`--allow-dev` to override); idempotent per component (a loaded,
 * unchanged service is left running — no restart, no backup churn); never
 * overwrites a populated file without a timestamped backup; a component whose
 * prerequisites are absent reports a LOUD blocker and fails the run (no silent
 * no-op success).
 *
 * Consent-only components: `automode` is a real component but is NEVER part of
 * `--all` or the no-selection planning view. It changes how the harness asks for
 * permission, so it only ever deploys when the installer typed its name — see
 * CONSENT_ONLY_COMPONENTS below.
 *
 * Usage:
 *   bun DeployComponents.ts [--components pulse,statusline,worksweep,derivedsync | --all]
 *                           [--config-root <dir>] [--skill-root <dir>]
 *                           [--apply] [--allow-dev] [--decline-services <csv>]
 *   bun DeployComponents.ts --components automode --apply            # opt in
 *   bun DeployComponents.ts --components automode --revoke --apply   # turn it back off
 *   (dry-run by default — reports the plan per component without writing)
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteText } from "./lib/atomic-write";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { copyMissing, refuseDevInstallWrites } from "./InstallEngine";

// Enhancement components are the à-la-carte half of setup. The "LifeOS Core"
// (skills + system prompt + base settings + CLAUDE.md) is installed by Setup's
// core steps; these are the opt-in extras the user (or their AI) picks some/all/none of.
//
// Two kinds:
// - Non-launchd: statusline, tooltips, spinnerverbs, agents, commands, workflows, automode — settings.json merges + file copies
// - Launchd services: delegated to Services.ts, the single source of truth for every background service
export const NON_LAUNCHD_COMPONENTS = ["statusline", "tooltips", "spinnerverbs", "agents", "commands", "workflows", "helm", "automode"] as const;

/**
 * The optional components documented in Setup.md step 7's component table. This is
 * the single source of truth for `--all` and the no-selection dry-run plan;
 * hooks use InstallHooks.ts and therefore are not a DeployComponents entry.
 */
export const DOCUMENTED_OPTIONAL_COMPONENTS = [
  "statusline", "tooltips", "spinnerverbs", "agents", "commands", "workflows", "helm",
  "pulse", "worksweep", "derivedsync",
] as const;

/**
 * Components that a blanket selection must never reach. `--all` and the
 * no-selection dry-run plan both skip these; they deploy only when the
 * installer names them in `--components`.
 *
 * `automode` qualifies because it does not add a feature — it removes the
 * per-action permission prompt. 8.0.0 shipped that state as a silent default and
 * a stranger's install could push and ssh without ever being asked; the fix was
 * conservative defaults plus this explicitly-typed path back in. A component that
 * changes how consent itself works cannot ride in on "install everything".
 */
export const CONSENT_ONLY_COMPONENTS = ["automode"] as const;

/** The three settings keys the automode opt-in owns — the complete set, in both directions. */
export const AUTOMODE_OPTED_IN = {
  permissionsDefaultMode: "auto",
  skipDangerousModePermissionPrompt: true,
  skipAutoPermissionPrompt: true,
} as const;

/** A launchd service as this tool addresses it: short name for the CLI, full label for the probe. */
interface LaunchdComponent {
  /** what the user types and what Services.ts receives as `--only` (short form) */
  component: string;
  /** the launchd/systemd label the load probe asserts */
  label: string;
  optIn: boolean;
}

// A component is just a name — the launchd half is resolved at runtime, so it
// cannot be typed as a literal union any more.
type Component = string;

/**
 * Read the launchd service list from the Services.ts registry instead of
 * restating it (public issue #1872, @GRyndStone).
 *
 * The hand-maintained copy had drifted in both directions: it advertised three
 * services the registry no longer has, and it offered one whose `install` is a
 * `#`-prefixed NOTE rather than a runnable command — so `--all` asked Services.ts
 * to install things that either do not exist or cannot be installed. Entries
 * whose install starts with `#` are filtered here for that reason.
 *
 * Services.ts guards its CLI behind `import.meta.main`, so importing it is a
 * pure read of the registry. Live tree first, shipped payload as the fallback
 * for a runtime that has not been laid down yet.
 */
async function loadLaunchdComponents(lifeosDir: string, payloadRoot: string): Promise<{ components: LaunchdComponent[]; source?: string; blocker?: string }> {
  const candidates = [join(lifeosDir, "TOOLS", "Services.ts"), join(payloadRoot, "TOOLS", "Services.ts")];
  const source = candidates.find(existsSync);
  if (!source) {
    return { components: [], blocker: `Services.ts not found (looked in ${candidates.join(", ")}) — cannot resolve the launchd service registry` };
  }
  try {
    const mod = (await import(source)) as { SERVICES?: Array<{ label?: unknown; install?: unknown; optIn?: unknown }> };
    if (!Array.isArray(mod.SERVICES)) return { components: [], source, blocker: `${source} exports no SERVICES array` };
    const components = mod.SERVICES
      .filter((s) => typeof s?.label === "string" && typeof s?.install === "string" && !s.install.trimStart().startsWith("#"))
      .map((s) => ({ label: s.label as string, component: (s.label as string).replace(/^com\.lifeos\./, ""), optIn: s.optIn === true }));
    return { components, source };
  } catch (err) {
    return { components: [], source, blocker: `importing ${source} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface Ctx {
  configRoot: string;
  lifeosDir: string; // <configRoot>/LIFEOS — the live runtime root
  payloadRoot: string; // <skillRoot>/install/LIFEOS — the shipped runtime tree
  installRoot: string; // <skillRoot>/install — settings.enhancements.json + agents/ live here
  home: string;
  bun: string; // resolved bun binary path — substituted for __BUN_PATH__ in launchd plists
  launchAgents: string;
  apply: boolean;
  revoke: boolean; // automode only: turn the opt-in back off instead of on
  launchd: LaunchdComponent[]; // resolved from the Services.ts registry
}

interface ComponentResult {
  component: Component;
  ready: boolean; // can be deployed (present in live tree OR payload)
  actions: string[]; // what apply will / did do
  blockers: string[]; // why it can't run — a non-empty list FAILS the run
  applied?: boolean;
  probe?: { name: string; passed: boolean; detail: string };
  error?: string;
}

// ── helpers ──────────────────────────────────────────────────────────

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}

/**
 * Resolve the live runtime dir robustly. The runtime references all-caps
 * `LIFEOS` (statusline, plists), but the sibling install tools use mixed-case
 * `LifeOS` (works on macOS's case-insensitive FS, latent on Linux). Pick
 * whichever actually exists; default to the all-caps runtime name.
 */
function resolveLifeosDir(configRoot: string): string {
  for (const name of ["LIFEOS", "LifeOS"]) {
    if (existsSync(join(configRoot, name))) return join(configRoot, name);
  }
  return join(configRoot, "LIFEOS");
}

const stamp = (): string => String(Date.now());

/** Back up a file aside as <file>.lifeos-backup-<ts> (only if it exists). */
function backup(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const dst = `${path}.lifeos-backup-${stamp()}`;
  copyFileSync(path, dst);
  return dst;
}

/** Where a component's path can be sourced from. */
function availability(rel: string, ctx: Ctx): { inLive: boolean; inPayload: boolean } {
  return { inLive: existsSync(join(ctx.lifeosDir, rel)), inPayload: existsSync(join(ctx.payloadRoot, rel)) };
}

/**
 * Ensure a component path exists in the live tree, copying from the shipped
 * payload only when ABSENT (never overwrites a populated target — idempotent).
 * Returns whether the path is present after the call.
 */
function ensurePresent(rel: string, ctx: Ctx): boolean {
  const dst = join(ctx.lifeosDir, rel);
  if (existsSync(dst)) return true;
  const src = join(ctx.payloadRoot, rel);
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  return true;
}

const uid = (): string => execFileSync("id", ["-u"]).toString().trim();

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("launchctl", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }).toString();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) };
  }
}

/** True when any systemd --user unit named `<label>.{service,timer,path}` appears in `listing`. */
export function systemdListingHasLabel(listing: string, label: string): boolean {
  return listing.split("\n").some((line) => /^(.+)\.(service|timer|path)$/.exec(line.trim().split(/\s+/)[0] ?? "")?.[1] === label);
}

/**
 * Windows: a LifeOS service is a current-user Task Scheduler task named for its label (TOOLS/lib/SchtasksUser.ts), in the
 * root folder or LIFEOS_SCHTASKS_FOLDER; Pulse's is "LifeOS Pulse" (PULSE/manage.ps1). Registered and not disabled = loaded.
 */
export function windowsTaskLoaded(label: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!/^[A-Za-z0-9._-]+$/.test(label)) return false;
  const folder = (env.LIFEOS_SCHTASKS_FOLDER ?? "").trim().replace(/^\\+|\\+$/g, "");
  if (folder && !/^[A-Za-z0-9._ -]+$/.test(folder)) return false;
  const [path, name] = label === "com.lifeos.pulse" ? ["\\", "LifeOS Pulse"] : [folder ? `\\${folder}\\` : "\\", label];
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$t = Get-ScheduledTask -TaskPath '${path}' -TaskName '${name}' -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() }`],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 30000, windowsHide: true }).toString().trim();
    return out !== "" && out !== "Disabled";
  } catch { return false; }
}

/** Is the service loaded? launchd on macOS, systemd --user on Linux, Task Scheduler on Windows — the same split Services.ts installs with. */
export function serviceLoaded(label: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return windowsTaskLoaded(label);
  if (platform === "linux") {
    try {
      const listing = execFileSync("systemctl", ["--user", "list-units", "--all", "--type=service,timer,path", "--plain", "--no-legend"], { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 }).toString();
      return systemdListingHasLabel(listing, label);
    } catch { return false; }
  }
  return launchctl(["print", `gui/${uid()}/${label}`]).ok;
}

// ── component deployers ──────────────────────────────────────────────

/** The Workflow that keeps the statusline's shared caches fresh: the renderer only reads them. */
export const STATUSLINE_REFRESH = "statusline-refresh";
/** The launchd job that runs it: the one Workflows dispatcher, which evaluates every local schedule (Workflows ISA ISC-311/312). */
export const STATUSLINE_REFRESH_LABEL = "com.lifeos.workflows-dispatcher";
const STATUSLINE_REFRESH_FILE = `${STATUSLINE_REFRESH}.workflow.yaml`;

export interface RefreshDeps {
  platform?: NodeJS.Platform;
  /** Is the launchd job already loaded? */
  loaded?: (label: string) => boolean;
  /** Runs one argv; returns stdout or throws with the failure text. */
  run?: (argv: string[], env: Record<string, string>) => string;
}

export interface RefreshOutcome {
  /** What apply will do (dry run) or did. */
  actions: string[];
  /** True when the schedule is in place (or already was), or does not apply here. A false value fails the statusline probe. */
  ok: boolean;
  detail: string;
}

/**
 * launchd starts the refresher with only the plist's environment, and schedule-install bakes the install-root variables of
 * the process that ran it into that plist. An install in a non-default config directory must hand them over, or the job
 * looks for `$HOME/.claude` every minute. The default location needs nothing, so its plist stays unchanged.
 */
export function installRootEnv(ctx: Pick<Ctx, "configRoot" | "lifeosDir" | "home">): Record<string, string> {
  if (resolve(ctx.configRoot) === resolve(join(ctx.home, ".claude"))) return {};
  return { CLAUDE_CONFIG_DIR: ctx.configRoot, LIFEOS_DIR: ctx.lifeosDir };
}

const runArgv = (argv: string[], env: Record<string, string>): string =>
  execFileSync(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).toString();

/**
 * The statusline's refresher. The Bun renderer only reads caches (tide, sats, usage, Codex, cosmos,
 * weather ...); the `statusline-refresh` Workflow fills them every minute. A public install gets the
 * renderer from the runtime tree and the Workflow definition from the shipped USER template, so this
 * puts the definition in place (copy-if-missing, a customised one wins) and installs its schedule
 * through the Workflows engine, the one scheduler. launchd is macOS-only; elsewhere nothing schedules
 * it and the outcome says so. A payload that predates the Bun renderer has no STATUSLINE tree: nothing to do.
 */
export function installStatuslineRefresh(ctx: Ctx, deps: RefreshDeps = {}): RefreshOutcome {
  const platform = deps.platform ?? process.platform;
  const loaded = deps.loaded ?? ((label: string) => serviceLoaded(label, platform));
  const run = deps.run ?? runArgv;
  const out: RefreshOutcome = { actions: [], ok: true, detail: "" };

  const renderer = availability("STATUSLINE/Refresh.ts", ctx);
  if (!renderer.inLive && !renderer.inPayload) {
    out.detail = "no Bun statusline renderer in this runtime — nothing to refresh";
    return out;
  }
  const engine = availability("WORKFLOWS/engine/schedule-install.ts", ctx);
  if (!engine.inLive && !engine.inPayload) {
    out.ok = false;
    out.detail = "Workflows engine not in the live tree or payload — the statusline caches will not refresh";
    return out;
  }
  const userDir = join(ctx.lifeosDir, "USER");
  const definition = join(userDir, "WORKFLOWS", STATUSLINE_REFRESH_FILE);
  const template = join(ctx.installRoot, "USER", "WORKFLOWS", STATUSLINE_REFRESH_FILE);
  if (!existsSync(definition) && !existsSync(template)) {
    out.ok = false;
    out.detail = `${STATUSLINE_REFRESH_FILE} is neither in ${userDir}/WORKFLOWS nor in the payload — run ScaffoldUser, then re-run this`;
    return out;
  }
  if (platform !== "darwin") {
    out.detail = "no scheduler for the statusline refresher on this platform (launchd is macOS-only); run `bun LIFEOS/STATUSLINE/Refresh.ts` from your own scheduler every minute";
    return out;
  }

  const schedule = join(ctx.lifeosDir, "WORKFLOWS", "engine", "schedule-install.ts");
  const copyDefinition = (): void => {
    if (existsSync(definition)) return;
    // Invariant: only a shipped definition is ever copied in, and only into the install's own USER/WORKFLOWS.
    if (!existsSync(template)) throw new Error(`invariant violated: ${STATUSLINE_REFRESH_FILE} has no shipped template at ${template}`);
    mkdirSync(dirname(definition), { recursive: true });
    copyFileSync(template, definition);
  };
  if (!existsSync(definition)) out.actions.push(`copy ${STATUSLINE_REFRESH_FILE} from payload → ${definition}`);
  if (loaded(STATUSLINE_REFRESH_LABEL)) {
    out.detail = `${STATUSLINE_REFRESH_LABEL} already scheduled (left as is)`;
    if (!ctx.apply) {
      out.actions.push(out.detail);
      return out;
    }
    // The schedule stays untouched, but a definition that went missing is put back, as the dry run said it would be.
    if (!existsSync(definition) && existsSync(userDir)) {
      try { copyDefinition(); } catch (err) {
        out.ok = false;
        out.detail = `${out.detail}; could not restore ${STATUSLINE_REFRESH_FILE}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return out;
  }
  out.actions.push(`bun ${schedule.replace(ctx.home, "~")} install ${STATUSLINE_REFRESH} (launchd ${STATUSLINE_REFRESH_LABEL}, every minute)`);
  if (!ctx.apply) return out;

  try {
    ensurePresent("STATUSLINE", ctx);
    ensurePresent("WORKFLOWS", ctx);
    if (!existsSync(userDir)) {
      out.ok = false;
      out.detail = `${userDir} does not exist yet — run ScaffoldUser and LinkUser first`;
      return out;
    }
    copyDefinition();
    run([ctx.bun, schedule, "install", STATUSLINE_REFRESH], { HOME: ctx.home, PATH: process.env.PATH ?? "/usr/bin:/bin", LIFEOS_NOTIFICATION_CHANNEL: "headless", ...installRootEnv(ctx) });
    out.ok = loaded(STATUSLINE_REFRESH_LABEL);
    out.detail = out.ok ? `${STATUSLINE_REFRESH_LABEL} loaded (every minute)` : `schedule-install exited 0 but ${STATUSLINE_REFRESH_LABEL} is not loaded`;
  } catch (err) {
    out.ok = false;
    out.detail = `could not schedule ${STATUSLINE_REFRESH}: ${err instanceof Error ? err.message.split("\n").slice(0, 3).join(" | ") : String(err)}`;
  }
  return out;
}

/** Does settings.json already point statusLine at the shipped LIFEOS_StatusLine.sh? A user who declined the statusline has no such command. */
export function statuslineWired(ctx: Pick<Ctx, "configRoot">): boolean {
  try {
    const settings = JSON.parse(readFileSync(join(ctx.configRoot, "settings.json"), "utf-8")) as { statusLine?: { command?: unknown } };
    const command = settings.statusLine?.command;
    return typeof command === "string" && command.includes("LIFEOS_StatusLine.sh");
  } catch { return false; }
}

/**
 * The update path (Update.md step 5.5). An install that updates gets the renderer from OverlaySystem and the definition
 * from ScaffoldUser, but nothing there schedules it. This does only that one thing, and only for an install whose
 * settings.json already uses the shipped statusline: it never wires statusLine, so a user who declined it gets no job.
 * Idempotent: a schedule that is already loaded is left as it is.
 */
export function refreshStatuslineOnUpdate(ctx: Ctx, deps: RefreshDeps = {}): RefreshOutcome {
  if (!statuslineWired(ctx)) {
    return { actions: [], ok: true, detail: "statusline is not wired in settings.json — the refresher is not scheduled" };
  }
  return installStatuslineRefresh(ctx, deps);
}

/**
 * The settings.json statusLine command for the script at `scriptPath`. Claude Code runs it through a shell, so a
 * home or config root holding a space or shell metacharacter must stay one word: those paths are single-quoted
 * (with `$HOME` kept outside the quotes so it still expands). A plain path keeps the unquoted `$HOME/...` form
 * every existing install already has, so an upgrade does not rewrite it.
 */
export function statuslineCommand(scriptPath: string, home: string): string {
  const plain = (s: string) => /^[A-Za-z0-9_./:@%+,=~-]*$/.test(s);
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  if (scriptPath.startsWith(`${home}/`)) {
    const rel = scriptPath.slice(home.length + 1);
    return plain(home) && plain(rel) ? `$HOME/${rel}` : `"$HOME"/${sq(rel)}`;
  }
  return plain(scriptPath) ? scriptPath : sq(scriptPath);
}

/** Statusline: place the script, chmod +x, wire settings.json statusLine, schedule its cache refresher. */
function deployStatusline(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "statusline", ready: false, actions: [], blockers: [] };
  const av = availability("LIFEOS_StatusLine.sh", ctx);
  const scriptPath = join(ctx.lifeosDir, "LIFEOS_StatusLine.sh");
  const settingsPath = join(ctx.configRoot, "settings.json");
  // Build the settings.json command from the ACTUAL install root (ctx.lifeosDir),
  // not a hardcoded ~/.claude — a custom --config-root (e.g. ~/.claude-alt) places
  // the script under its own LIFEOS/, and the old literal pointed at the wrong tree.
  const command = statuslineCommand(scriptPath, ctx.home);

  if (!av.inLive && !av.inPayload) {
    r.blockers.push(`LIFEOS_StatusLine.sh not in live tree (${scriptPath}) or payload`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    if (!av.inLive) r.actions.push(`copy LIFEOS_StatusLine.sh from payload → ${scriptPath}`);
    r.actions.push(`chmod +x ${scriptPath}`, `wire settings.json statusLine → ${command}`);
    const plan = installStatuslineRefresh(ctx);
    r.actions.push(...plan.actions);
    if (!plan.ok) r.blockers.push(plan.detail);
    return r;
  }

  try {
    ensurePresent("LIFEOS_StatusLine.sh", ctx);
    chmodSync(scriptPath, 0o755);

    // A populated-but-unparseable settings.json must NOT be rewritten from {} —
    // that would silently drop the user's whole config. Abort with a blocker.
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {
        r.blockers.push(`settings.json exists but is not valid JSON — refusing to rewrite (would drop your config). Fix it, then re-run.`);
        return r;
      }
    }
    const current = settings.statusLine as Record<string, unknown> | undefined;
    // A pre-7.40.4 install wired refreshInterval: 1 — a full render (with its git
    // subprocesses) every second. Idempotency must not preserve that value, so a
    // matching command with interval 1 counts as NOT wired and is rewritten to 5
    // (public issue #1998, @hjo20).
    const alreadyWired = current?.command === command && current?.refreshInterval !== 1;
    if (!alreadyWired) {
      backup(settingsPath);
      // ported from public PR #1772, @asdf8675309; value adapted to 5 — a 1s
      // refresh re-runs the statusline script every second for no visible gain.
      settings.statusLine = { type: "command", command, refreshInterval: 5 };
      // Atomic — never leave a half-written settings.json (public PR #1643, @elhoim)
      atomicWriteText(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    r.applied = !alreadyWired;
    const reread = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const wired = (reread.statusLine as Record<string, unknown> | undefined)?.command === command;
    let executable = false;
    try { execFileSync("test", ["-x", scriptPath]); executable = true; } catch { executable = false; }
    const refresh = installStatuslineRefresh(ctx);
    r.probe = { name: "statusline-wired", passed: wired && executable && refresh.ok, detail: `wired=${wired} executable=${executable}${alreadyWired ? " (idempotent)" : ""}; refresher: ${refresh.detail || "scheduled"}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/**
 * Merge a single Claude-Code enhancement key (spinnerTipsOverride / spinnerVerbs)
 * from the shipped `install/settings.enhancements.json` into the user's
 * settings.json — set-the-key semantics (these are whole-object settings, like
 * statusLine). Idempotent (deep-equal → skip), backup-before-write, parse-abort.
 */
function deploySettingsKey(component: Component, key: string, ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component, ready: false, actions: [], blockers: [] };
  const enhPath = join(ctx.installRoot, "settings.enhancements.json");
  if (!existsSync(enhPath)) {
    r.blockers.push(`settings.enhancements.json not in payload (${enhPath}) — runtime not staged`);
    return r;
  }
  let enh: Record<string, unknown>;
  try { enh = JSON.parse(readFileSync(enhPath, "utf-8")); } catch { r.blockers.push(`${enhPath} is not valid JSON`); return r; }
  if (!(key in enh)) {
    r.blockers.push(`${key} not present in settings.enhancements.json`);
    return r;
  }
  // A user's own taste overrides the shipped neutral value: when
  // <configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/LifeOS/<key>.json exists it is
  // deployed instead. A present-but-malformed file is a blocker naming the file
  // and key, never a silent fall back to the shipped value.
  const userOverride = join(ctx.lifeosDir, "USER", "CUSTOMIZATIONS", "SKILLS", "LifeOS", `${key}.json`);
  if (key === "spinnerVerbs" && existsSync(userOverride)) {
    let ov: unknown;
    try { ov = JSON.parse(readFileSync(userOverride, "utf-8")); } catch { r.blockers.push(`${userOverride} is not valid JSON (key ${key})`); return r; }
    if (!ov || typeof ov !== "object" || !Array.isArray((ov as { verbs?: unknown }).verbs)) {
      r.blockers.push(`${userOverride} has no \`verbs\` array (key ${key})`);
      return r;
    }
    enh = { ...enh, [key]: ov };
  }
  r.ready = true;
  const settingsPath = join(ctx.configRoot, "settings.json");
  if (!ctx.apply) {
    r.actions.push(`merge settings.${key} into ${settingsPath} (backup-first, idempotent)`);
    return r;
  }
  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); }
      catch { r.blockers.push(`settings.json exists but is not valid JSON — refusing to rewrite (would drop your config).`); return r; }
    }
    const already = JSON.stringify(settings[key]) === JSON.stringify(enh[key]);
    if (!already) {
      backup(settingsPath);
      settings[key] = enh[key];
      // Atomic — never leave a half-written settings.json (public PR #1643, @elhoim)
      atomicWriteText(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    r.applied = !already;
    const reread = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
    const passed = JSON.stringify(reread[key]) === JSON.stringify(enh[key]);
    r.probe = { name: `${component}-merged`, passed, detail: `settings.${key} set${already ? " (idempotent)" : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/**
 * Read settings.json for a write. A populated-but-unparseable file must NOT be
 * rewritten from `{}` — that would silently drop the user's whole config — so
 * that case records a blocker and returns undefined.
 */
function readSettingsForWrite(settingsPath: string, r: ComponentResult): Record<string, unknown> | undefined {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch {
    r.blockers.push("settings.json exists but is not valid JSON — refusing to rewrite (would drop your config). Fix it, then re-run.");
    return undefined;
  }
}

/** Does this settings object already carry the exact opted-in (or revoked) auto-mode shape? */
function automodeMatches(settings: Record<string, unknown>, revoke: boolean): boolean {
  const mode = (settings.permissions as Record<string, unknown> | undefined)?.defaultMode;
  return revoke
    ? mode === undefined
      && settings.skipDangerousModePermissionPrompt === false
      && settings.skipAutoPermissionPrompt === false
    : mode === AUTOMODE_OPTED_IN.permissionsDefaultMode
      && settings.skipDangerousModePermissionPrompt === AUTOMODE_OPTED_IN.skipDangerousModePermissionPrompt
      && settings.skipAutoPermissionPrompt === AUTOMODE_OPTED_IN.skipAutoPermissionPrompt;
}

/**
 * Apply the auto-mode opt-in (or its reversal) to a settings object, in place.
 *
 * Exactly three keys, in both directions. It does not touch `permissions.allow`,
 * `permissions.deny`, `permissions.ask`, or the `autoMode` prose block. 8.0.0's
 * outbound verb pre-approvals (ssh, scp, rsync, curl, git push, wrangler,
 * osascript) and its self-modification pre-authorization were removed on purpose:
 * they let a stranger's install push and ssh with no prompt, and no flag —
 * including this one — brings them back. Auto mode means "stop asking before
 * file edits and command runs", not "pre-approve reaching off this machine".
 */
export function applyAutoMode(settings: Record<string, unknown>, revoke: boolean): Record<string, unknown> {
  const perms = settings.permissions as Record<string, unknown> | undefined;
  if (revoke) {
    if (perms && "defaultMode" in perms) {
      const next = { ...perms };
      delete next.defaultMode;
      settings.permissions = next;
    }
  } else {
    settings.permissions = { ...(perms ?? {}), defaultMode: AUTOMODE_OPTED_IN.permissionsDefaultMode };
  }
  settings.skipDangerousModePermissionPrompt = revoke ? false : AUTOMODE_OPTED_IN.skipDangerousModePermissionPrompt;
  settings.skipAutoPermissionPrompt = revoke ? false : AUTOMODE_OPTED_IN.skipAutoPermissionPrompt;
  return settings;
}

/** Impossible-state guard: never write a settings object that is not the shape this call intended. */
function assertAutoModeShape(settings: Record<string, unknown>, revoke: boolean): void {
  if (!automodeMatches(settings, revoke)) {
    throw new Error(`automode invariant violated: the settings object about to be written is not the ${revoke ? "revoked" : "opted-in"} shape`);
  }
}

/**
 * automode: the informed opt-in. Writes the permission mode and the two skip
 * flags into the installed settings — and nothing else — when the installer
 * asked for it by name. `--revoke` is the documented way back off, and it is the
 * same three keys in reverse, so the reversal is as exact as the opt-in.
 *
 * This is the only component whose name must be typed: `--all` never reaches it
 * (CONSENT_ONLY_COMPONENTS).
 */
function deployAutoMode(ctx: Ctx): ComponentResult {
  const revoke = ctx.revoke;
  const r: ComponentResult = { component: "automode", ready: true, actions: [], blockers: [] };
  const settingsPath = join(ctx.configRoot, "settings.json");
  const change = revoke
    ? 'remove permissions.defaultMode, set skipDangerousModePermissionPrompt=false and skipAutoPermissionPrompt=false'
    : 'set permissions.defaultMode="auto", skipDangerousModePermissionPrompt=true and skipAutoPermissionPrompt=true';

  if (!ctx.apply) {
    r.actions.push(`${revoke ? "revoke" : "apply"} auto mode in ${settingsPath} — ${change} (backup-first, idempotent; no permission rules and no autoMode prose are written)`);
    return r;
  }

  try {
    const settings = readSettingsForWrite(settingsPath, r);
    if (!settings) { r.ready = false; return r; }
    const already = automodeMatches(settings, revoke);
    if (!already) {
      applyAutoMode(settings, revoke);
      assertAutoModeShape(settings, revoke);
      backup(settingsPath);
      // Atomic — never leave a half-written settings.json (public PR #1643, @elhoim)
      atomicWriteText(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
    r.applied = !already;
    const reread = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    r.probe = {
      name: revoke ? "automode-revoked" : "automode-applied",
      passed: automodeMatches(reread, revoke),
      detail: `${change}${already ? " (idempotent)" : ""}`,
    };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/** Agents: copyMissing the shipped agents tree into the harness agents dir (never overwrites). */
function deployAgents(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "agents", ready: false, actions: [], blockers: [] };
  const src = join(ctx.installRoot, "agents");
  const dst = join(ctx.configRoot, "agents");
  if (!existsSync(src) && !existsSync(dst)) {
    r.blockers.push(`agents not in payload (${src}) and not already installed (${dst})`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    r.actions.push(existsSync(src) ? `copyMissing agents → ${dst} (never overwrites existing)` : `agents already present at ${dst} — no-op`);
    return r;
  }
  try {
    if (!existsSync(src)) {
      r.applied = false;
      r.probe = { name: "agents-present", passed: true, detail: `already present at ${dst} (no payload to copy)` };
      return r;
    }
    const { copied, failures } = copyMissing(src, dst);
    r.applied = copied > 0;
    r.probe = { name: "agents-copied", passed: failures.length === 0 && existsSync(dst), detail: `${copied} agent file(s) copied${failures.length ? `, ${failures.length} failed` : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

// commands mirrors agents exactly: copy the payload's install/commands/ into the
// user's ~/.claude/commands/, never overwriting. The payload is already filtered
// at emit time to public commands only (a command ships iff its target skill
// ships), so there is nothing private-pointing to guard against here.
function deployCommands(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "commands", ready: false, actions: [], blockers: [] };
  const src = join(ctx.installRoot, "commands");
  const dst = join(ctx.configRoot, "commands");
  if (!existsSync(src) && !existsSync(dst)) {
    r.blockers.push(`commands not in payload (${src}) and not already installed (${dst})`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    r.actions.push(existsSync(src) ? `copyMissing commands → ${dst} (never overwrites existing)` : `commands already present at ${dst} — no-op`);
    return r;
  }
  try {
    if (!existsSync(src)) {
      r.applied = false;
      r.probe = { name: "commands-present", passed: true, detail: `already present at ${dst} (no payload to copy)` };
      return r;
    }
    const { copied, failures } = copyMissing(src, dst);
    r.applied = copied > 0;
    r.probe = { name: "commands-copied", passed: failures.length === 0 && existsSync(dst), detail: `${copied} command file(s) copied${failures.length ? `, ${failures.length} failed` : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

// workflows mirrors commands: copy the payload's install/workflows/ (the public
// Workflow-tool scripts the RELEASE_MANIFEST "workflows" component promises —
// UpgradeFanout.js, invoked by the Upgrade skill by its meta.name) into the
// user's ~/.claude/workflows/, never overwriting. Existence-gated on both sides
// like commands: a payload without the dir is a blocker only when nothing is
// installed either. public issue #1953, @catchingknives
function deployWorkflows(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "workflows", ready: false, actions: [], blockers: [] };
  const src = join(ctx.installRoot, "workflows");
  const dst = join(ctx.configRoot, "workflows");
  if (!existsSync(src) && !existsSync(dst)) {
    r.blockers.push(`workflows not in payload (${src}) and not already installed (${dst})`);
    return r;
  }
  r.ready = true;
  if (!ctx.apply) {
    r.actions.push(existsSync(src) ? `copyMissing workflows → ${dst} (never overwrites existing)` : `workflows already present at ${dst} — no-op`);
    return r;
  }
  try {
    if (!existsSync(src)) {
      r.applied = false;
      r.probe = { name: "workflows-present", passed: true, detail: `already present at ${dst} (no payload to copy)` };
      return r;
    }
    const { copied, failures } = copyMissing(src, dst);
    r.applied = copied > 0;
    r.probe = { name: "workflows-copied", passed: failures.length === 0 && existsSync(dst), detail: `${copied} workflow file(s) copied${failures.length ? `, ${failures.length} failed` : ""}` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/**
 * Probe Pulse's actual HTTP surface, not just its launchd label (public issue
 * #1873, @GRyndStone). A loaded label proves launchd accepted the plist; it says
 * nothing about whether the server bound its port — and a Pulse that loads and
 * then dies on a missing build is exactly the state users reported as "installed
 * but the dashboard is dead". This is the same two-evidence-class rule the
 * Setup/Update intents state for Pulse.
 */
function probePulseHealth(): { ok: boolean; detail: string } {
  const url = "http://127.0.0.1:31337/healthz";
  try {
    const code = execFileSync("curl", ["-fsS", "--max-time", "5", "-o", "/dev/null", "-w", "%{http_code}", url], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    }).toString().trim();
    return { ok: code === "200", detail: `${url} → HTTP ${code || "(no status)"}` };
  } catch (err) {
    return { ok: false, detail: `${url} unreachable — the service label loaded but the server is not answering (${err instanceof Error ? err.message.split("\n")[0] : String(err)})` };
  }
}

/**
 * Delegate launchd service install to Services.ts — the single source of truth for
 * every background service. This keeps DeployComponents focused on non-launchd
 * components (settings merges, file copies) while Services.ts owns the full
 * launchd machinery.
 */
function deployViaServices(entry: LaunchdComponent, ctx: Ctx): ComponentResult {
  const component = entry.component;
  const r: ComponentResult = { component, ready: false, actions: [], blockers: [] };
  const servicesTs = join(ctx.lifeosDir, "TOOLS", "Services.ts");

  // Services.ts must be present (either in live tree or staged from payload)
  const av = availability("TOOLS", ctx);
  if (!av.inLive && !av.inPayload) {
    r.blockers.push(`TOOLS not in live tree (${join(ctx.lifeosDir, "TOOLS")}) or payload`);
    return r;
  }
  r.ready = true;

  // The registry's own label — not a reconstructed one. A vendor-labelled service
  // (the Hermes sidecar, ai.hermes.gateway) has no com.lifeos. prefix to add back.
  const label = entry.label;

  if (!ctx.apply) {
    if (!av.inLive) r.actions.push(`stage TOOLS from payload → ${join(ctx.lifeosDir, "TOOLS")}`);
    r.actions.push(`bun ${servicesTs.replace(ctx.home, "~")} install --only ${component} --yes`);
    return r;
  }

  try {
    ensurePresent("TOOLS", ctx);
    if (!existsSync(servicesTs)) {
      r.blockers.push(`Services.ts still missing after staging: ${servicesTs}`);
      return r;
    }
    // Delegate to Services.ts. It resolves its tree from CLAUDE_CONFIG_DIR (Paths.getClaudeDir), never from
    // --config-root, so the root this install targets is handed over explicitly; otherwise a custom-root
    // install wires the services of the ambient or default profile and reports them as installed.
    const out = execFileSync("bun", [servicesTs, "install", "--only", component, "--yes"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120000, // some services take longer (e.g. Pulse waits for healthz)
      cwd: dirname(servicesTs),
      env: { ...process.env, CLAUDE_CONFIG_DIR: ctx.configRoot, LIFEOS_DIR: ctx.lifeosDir },
    }).toString();
    r.applied = true;
    // Confirm the job actually loaded
    const loaded = serviceLoaded(label);
    if (!loaded) {
      r.probe = { name: `${component}-loaded`, passed: false, detail: `Services.ts exit 0 but ${label} not loaded: ${out.trim().split("\n").slice(-1)[0]}` };
      return r;
    }
    // Pulse gets a second evidence class: the label is loaded AND the server answers.
    if (component === "pulse") {
      const health = probePulseHealth();
      r.probe = { name: "pulse-healthz", passed: health.ok, detail: `${label} loaded via Services.ts; ${health.detail}` };
      return r;
    }
    r.probe = { name: `${component}-loaded`, passed: true, detail: `${label} loaded via Services.ts` };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

/**
 * helm: the reference terminal (kitty config layer, herdr config, shell layer, Hammerspoon
 * hotkeys) through its own installer, `LIFEOS/DOCUMENTATION/Terminal/install.sh`, which is
 * idempotent and never overwrites a user's herdr config or real files. Windows has no kitty
 * build, Linux needs kitty already installed, and a Mac needs kitty or Homebrew to get it, so
 * each of those reports a plain skip rather than a blocker: Helm is the reference setup, never
 * a prerequisite for LifeOS.
 */
export function helmApplicability(platform: NodeJS.Platform, hasKitty: boolean, hasBrew = false): string | null {
  if (platform === "darwin") return hasKitty || hasBrew ? null : "neither kitty nor Homebrew is installed — install one, then run Terminal/install.sh";
  if (platform === "linux") return hasKitty ? null : "kitty is not installed — install it, then run Terminal/install.sh";
  return `no kitty build for ${platform}`;
}

function deployHelm(ctx: Ctx): ComponentResult {
  const r: ComponentResult = { component: "helm", ready: false, actions: [], blockers: [] };
  const script = join(ctx.lifeosDir, "DOCUMENTATION", "Terminal", "install.sh");
  if (!existsSync(script)) {
    r.blockers.push(`Helm installer missing at ${script}`);
    return r;
  }
  r.ready = true;
  const has = (cmd: string) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }); return true; } catch { return false; } };
  const hasKitty = has("kitty") || existsSync("/Applications/kitty.app");
  const skip = helmApplicability(process.platform, hasKitty, has("brew"));
  if (skip) {
    r.actions.push(`skipped: ${skip}`);
    r.applied = false;
    return r;
  }
  if (!ctx.apply) {
    r.actions.push(`bash ${script} (kitty + config link, Helm.app, helm on PATH, herdr config if absent, shell layer, Hammerspoon hotkeys if installed)`);
    return r;
  }
  try {
    const out = execFileSync("bash", [script], { stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, env: { ...process.env, HOME: ctx.home } }).toString();
    r.applied = true;
    const linked = join(ctx.home, ".config", "kitty");
    r.probe = { name: "helm-installed", passed: existsSync(linked) && /✓ Done/.test(out), detail: out.trim().split("\n").slice(-1)[0] ?? "" };
  } catch (err) {
    r.error = err instanceof Error ? err.message : String(err);
  }
  return r;
}

function deploy(component: Component, ctx: Ctx): ComponentResult {
  // Non-launchd components: handled directly
  switch (component) {
    case "helm": return deployHelm(ctx);
    case "statusline": return deployStatusline(ctx);
    case "tooltips": return deploySettingsKey("tooltips", "spinnerTipsOverride", ctx);
    case "spinnerverbs": return deploySettingsKey("spinnerverbs", "spinnerVerbs", ctx);
    case "agents": return deployAgents(ctx);
    case "commands": return deployCommands(ctx);
    case "workflows": return deployWorkflows(ctx);
    case "automode": return deployAutoMode(ctx);
  }
  // Launchd components: delegate to Services.ts
  const entry = ctx.launchd.find((l) => l.component === component || l.label === component);
  if (entry) return deployViaServices(entry, ctx);
  return { component, ready: false, actions: [], blockers: [`unknown component: ${component}`] };
}

// ── selection ────────────────────────────────────────────────────────

/**
 * Turn the CLI selection into the component list to deploy.
 *
 * One rule, one place: a blanket selection (`--all`, or the no-selection dry-run
 * planning view) is exactly Setup.md step 7's documented optional component set. Any
 * other service is available only through an explicit `--components` csv.
 */
export function expandSelection(selectAll: boolean, requested: string[], _known: readonly string[]): string[] {
  if (!selectAll && requested.length > 0) return [...requested];
  return [...DOCUMENTED_OPTIONAL_COMPONENTS];
}

/**
 * Persist the install's core-service choices in the existing per-install service registry.
 *
 * Only a core service the user was asked about and said no to (`declined`, labels or short names) is added. A core
 * service that is selected or loaded leaves the list. Anything else keeps its previous state: a service the user was
 * never offered is never recorded as declined (before 2026-10-13 every unselected core service was, so the six core
 * services InstallAll now installs read as "declined" on installs that never saw the question).
 */
export function recordDeclinedServices(path: string, services: Pick<LaunchdComponent, "label" | "component" | "optIn">[], selected: string[], declined: string[], loaded: (label: string) => boolean): string[] {
  const entries: Record<string, unknown>[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  if (!Array.isArray(entries)) throw new Error(`${path} must be a JSON array`);
  const metadata = entries.find((entry) => Array.isArray(entry?._declined));
  const previous = new Set<string>(metadata?._declined as string[] | undefined ?? []);
  const next = new Set(previous);
  const names = (s: { label: string; component: string }) => [s.label, s.component];
  for (const service of services.filter((s) => !s.optIn)) {
    if (names(service).some((n) => selected.includes(n)) || loaded(service.label)) next.delete(service.label);
    else if (names(service).some((n) => declined.includes(n))) next.add(service.label);
  }
  const labels = [...next].sort();
  if (JSON.stringify([...previous].sort()) !== JSON.stringify(labels) || !metadata) {
    if (metadata) metadata._declined = labels;
    else entries.push({ _declined: labels });
    mkdirSync(dirname(path), { recursive: true });
    backup(path);
    atomicWriteText(path, JSON.stringify(entries, null, 2) + "\n");
  }
  return labels;
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const a = process.argv.slice(2);
  const home = process.env.HOME || homedir(); // public issue #1729, @umair-a11y
  const configRoot = arg(a, "--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const skillRoot = arg(a, "--skill-root") || join(import.meta.dir, "..");
  const apply = a.includes("--apply");
  const allowDev = a.includes("--allow-dev");
  const revoke = a.includes("--revoke");

  refuseDevInstallWrites(configRoot, [resolveLifeosDir(configRoot), join(configRoot, "settings.json")], allowDev);

  const lifeosDir = resolveLifeosDir(configRoot);
  const payloadRoot = existsSync(join(skillRoot, "install", "LIFEOS"))
    ? join(skillRoot, "install", "LIFEOS")
    : join(skillRoot, "install", "LifeOS");

  // Update.md step 5.5: only the statusline refresher's schedule, nothing else, no component selection.
  if (a.includes("--refresh-statusline")) {
    const ctx: Ctx = {
      configRoot, lifeosDir, payloadRoot, installRoot: join(skillRoot, "install"), home, launchd: [], apply, revoke: false,
      bun: /\/bun$/.test(process.execPath) ? process.execPath : join(home, ".bun", "bin", "bun"),
      launchAgents: join(home, "Library", "LaunchAgents"),
    };
    const outcome = refreshStatuslineOnUpdate(ctx);
    console.log(JSON.stringify({ ok: outcome.ok, dryRun: !apply, configRoot, ...outcome, note: apply ? undefined : "dry-run — re-run with --apply" }, null, 2));
    process.exit(outcome.ok ? 0 : 1);
  }

  // Selection: --all, or --components csv. Dry-run with no selection plans all.
  const csv = arg(a, "--components");
  const selectAll = a.includes("--all");
  const requested = csv ? csv.split(",").map((s) => s.trim()).filter(Boolean) : [];
  // The registry is only needed when the selection can include a launchd service.
  // A statusline-only run on a tree without the runtime should not fail on it.
  const needsRegistry = selectAll || !csv || requested.some((c) => !(NON_LAUNCHD_COMPONENTS as readonly string[]).includes(c));
  const registry = await loadLaunchdComponents(lifeosDir, payloadRoot);
  if (needsRegistry && registry.blocker) {
    console.log(JSON.stringify({ ok: false, error: registry.blocker, hint: "deploy the runtime (DeployCore.ts) or pass --skill-root at a staged release, then re-run" }, null, 2));
    process.exit(1);
  }
  const known = [...NON_LAUNCHD_COMPONENTS, ...registry.components.map((l) => l.component)];

  let selected: Component[];
  if (selectAll) {
    selected = expandSelection(true, requested, known);
  } else if (csv) {
    const unknown = requested.filter((c) => !known.includes(c) && !registry.components.some((l) => l.label === c));
    if (unknown.length) {
      console.log(JSON.stringify({ ok: false, error: `unknown component(s): ${unknown.join(", ")}`, known }, null, 2));
      process.exit(1);
    }
    selected = expandSelection(false, requested, known);
  } else if (apply) {
    console.log(JSON.stringify({ ok: false, error: "--apply needs --components <csv> or --all (opt-in: nothing deploys implicitly)", known }, null, 2));
    process.exit(1);
  } else {
    selected = expandSelection(true, [], known); // dry-run planning view
  }

  // --revoke belongs to automode and nothing else. Silently ignoring it on a
  // mixed selection would read as "the reversal ran"; refuse instead.
  const revokable = (CONSENT_ONLY_COMPONENTS as readonly string[]).filter((c) => selected.includes(c));
  if (revoke && (revokable.length === 0 || selected.length !== revokable.length)) {
    console.log(JSON.stringify({ ok: false, error: `--revoke applies only to ${CONSENT_ONLY_COMPONENTS.join(", ")} — select just that component to turn it back off`, selected }, null, 2));
    process.exit(1);
  }

  const ctx: Ctx = {
    configRoot,
    lifeosDir,
    payloadRoot,
    installRoot: join(skillRoot, "install"),
    home,
    launchd: registry.components,
    // launchd runs the plist with a minimal PATH, so ProgramArguments[0] must be an
    // absolute bun path. Prefer the interpreter running this installer; fall back to
    // the standard bun install location.
    bun: /\/bun$/.test(process.execPath) ? process.execPath : join(home, ".bun", "bin", "bun"),
    launchAgents: join(home, "Library", "LaunchAgents"),
    apply,
    revoke,
  };

  const results = selected.map((c) => deploy(c, ctx));
  // A blocked component (prereq absent, nothing written) is a FAILURE, not a
  // silent success — `ok` factors in blockers, error, AND probe in both modes.
  let ok = results.every((r) => r.blockers.length === 0 && !r.error && (!r.probe || r.probe.passed));
  let declined: string[] | undefined;
  let declarationError: string | undefined;
  // Recorded on every apply, green or not: a selected or loaded core service leaves the declined
  // list (so /ic reports a failed one missing). Only an explicit --decline-services adds to it;
  // a core service this run never offered is not "declined" (InstallAll installs the core set).
  if (apply) {
    const declinedNow = arg(a, "--decline-services")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    try { declined = recordDeclinedServices(join(ctx.lifeosDir, "USER/CONFIG/services.json"), ctx.launchd, selected, declinedNow, serviceLoaded); }
    catch (e) { declarationError = e instanceof Error ? e.message : String(e); ok = false; }
  }

  console.log(JSON.stringify({
    ok,
    dryRun: !apply,
    configRoot,
    lifeosDir: ctx.lifeosDir,
    payloadRoot: ctx.payloadRoot,
    registry: { source: registry.source, launchdServices: registry.components.length },
    selected,
    declined,
    declarationError,
    consentOnly: {
      components: [...CONSENT_ONLY_COMPONENTS],
      note: "never included by --all or the default plan; deploys only when named in --components, after the installer says yes (Setup.md step 7)",
    },
    results,
    note: apply ? undefined : "dry-run — re-run with --apply --components <csv> after the user opts in",
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

// Guarded so the tests can import the pure helpers without running the CLI.
if (import.meta.main) {
  main().catch((err) => {
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2));
    process.exit(1);
  });
}
