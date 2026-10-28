/**
 * SchtasksUser.ts — the Windows Task Scheduler backend for LifeOS installers.
 *
 * WHY THIS EXISTS
 *
 * Every LifeOS background job is scheduled by an `Install*.ts` script that
 * speaks launchd, and lib/SystemdUser.ts added the Linux backend. Windows has
 * neither, so on Windows the jobs simply never run (the install docs say they
 * "skip cleanly"). This module is the third backend, built to the same shape
 * as SystemdUser.ts so an installer can adopt it with the same ten-line branch:
 * it consumes the very same `UnitSpec` (label, exec, log, schedule).
 *
 * THE ONE RULE IT OBEYS
 *
 * Strictly additive, exactly like SystemdUser.ts. Nothing here runs on darwin
 * or linux, and no installer's launchd or systemd path is altered by adopting
 * it. An installer gains a `process.platform === "win32"` branch and keeps its
 * existing code untouched.
 *
 * HOW A JOB RUNS
 *
 * Task Scheduler has no equivalent of StandardOutPath, Environment= or a
 * hidden console, and bun.exe launched directly flashes a console window on
 * every run. So every task runs the same tiny wrapper, lib/TaskRunner.ts:
 *
 *   conhost.exe --headless <bun.exe> <TaskRunner.ts> <label>.json
 *
 * The JSON beside the task (in TASK_DIR) carries the job's argv, log paths,
 * working directory and environment. TaskRunner appends stdout/stderr to the
 * log like launchd and systemd do, sets HOME (unset on Windows — see #1729)
 * and a PATH with bun and Git's bash ahead of WSL's bash stub (see #2225).
 * Keeping the job in a JSON file rather than on the command line also keeps
 * long argv clear of the Windows command-line limit (see #2003).
 *
 * LAUNCHD → TASK SCHEDULER TRANSLATION
 *
 *   StartInterval N + RunAtLoad   → TimeTrigger from install+2min, repeat every N
 *   StartCalendarInterval H:M     → CalendarTrigger daily at H:M
 *   KeepAlive + ThrottleInterval  → LogonTrigger + RestartOnFailure every N
 *   WatchPaths [dirs]             → a "daemon" task whose TaskRunner watches the
 *                                    dirs and runs the job on change (Task
 *                                    Scheduler has no file-change trigger)
 *
 * Every task sets StartWhenAvailable, the Task Scheduler counterpart of
 * systemd's `Persistent=true`: a run missed while the machine slept or was off
 * fires once when it is next available. Tasks run as the current user, only
 * while that user is logged on (InteractiveToken), with no admin rights and no
 * stored password — the same scope as a launchd LaunchAgent. They also run on
 * battery, since the typical Windows LifeOS host is a laptop.
 *
 * A KeepAlive daemon (the Workflows dispatcher) is restarted by TaskRunner
 * itself after `restartSec` whenever it exits, the way launchd's KeepAlive does
 * for any exit; Task Scheduler's RestartOnFailure stays as the backstop for the
 * runner dying.
 *
 * TASK FOLDER
 *
 * Tasks register in the Task Scheduler root by default, beside the "LifeOS
 * Pulse" task PULSE/manage.ps1 registers. LIFEOS_SCHTASKS_FOLDER=<name> puts
 * them in `\<name>\` instead; tests use it so a test task can never replace a
 * live one of the same label.
 *
 * Every operation has a synchronous form (`*Sync`) for callers that are
 * synchronous themselves (Services.ts, the Workflows schedule installer); the
 * async exports are the same operations for the async Install*.ts scripts.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "node:url";
import { getLifeosDir } from "../Paths";
import type { Schedule, UnitSpec } from "./SystemdUser";

export type { Schedule, UnitSpec };

declare const Bun: { spawnSync: (cmd: string[], opts?: any) => any };

/**
 * Where each task's XML and runner JSON live: beside the job logs, in the
 * LifeOS state tree of this install (CLAUDE_CONFIG_DIR / LIFEOS_DIR honoured).
 * NOT under %LOCALAPPDATA%: when the installer is driven from an MSIX-packaged
 * app (the Claude desktop app is one), Windows silently redirects that app's
 * writes to AppData into its private Packages\<app>\LocalCache folder. Task
 * Scheduler runs outside the package, cannot see the redirected file, and the
 * task fails with nothing in any log. The user-profile root is not virtualized.
 */
export const TASK_DIR = join(getLifeosDir(), "MEMORY", "STATE", "schtasks");

/** The Task Scheduler folder LifeOS tasks register in: "" for the root, else LIFEOS_SCHTASKS_FOLDER. */
const FOLDER_RE = /^[A-Za-z0-9._ -]+$/;
export function taskFolder(env: Record<string, string | undefined> = process.env): string {
  const f = (env.LIFEOS_SCHTASKS_FOLDER ?? "").trim().replace(/^\\+|\\+$/g, "");
  if (f && !FOLDER_RE.test(f)) throw new Error(`SchtasksUser: invalid LIFEOS_SCHTASKS_FOLDER ${JSON.stringify(f)} — must match ${FOLDER_RE}`);
  return f;
}

/** The TaskPath Get-ScheduledTask reports for the folder: `\` or `\<folder>\`. */
export function taskPath(env: Record<string, string | undefined> = process.env): string {
  const f = taskFolder(env);
  return f ? `\\${f}\\` : "\\";
}

/** The full task name schtasks takes for a label: `label` in the root, `\folder\label` otherwise. */
export function taskName(label: string, env: Record<string, string | undefined> = process.env): string {
  assertValidLabel(label);
  const f = taskFolder(env);
  return f ? `\\${f}\\${label}` : label;
}
/** The wrapper every task runs; sits beside this file in TOOLS/lib. */
export const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "TaskRunner.ts");

/* ── The JSON contract between this module and TaskRunner.ts ─────────────── */

export interface RunnerSpec {
  label: string;
  exec: string[];
  logPath: string;
  errLogPath?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  /** Set for WatchPaths jobs: TaskRunner stays resident and runs `exec` on change. */
  watchPaths?: string[];
  /** Set for KeepAlive daemons: TaskRunner re-runs `exec` this many seconds after every exit. */
  keepAliveSec?: number;
}

export function runnerSpec(spec: UnitSpec): RunnerSpec {
  assertValidLabel(spec.label);
  const r: RunnerSpec = { label: spec.label, exec: spec.exec, logPath: spec.logPath };
  if (spec.errLogPath) r.errLogPath = spec.errLogPath;
  if (spec.workingDirectory) r.workingDirectory = spec.workingDirectory;
  if (spec.environment) r.environment = spec.environment;
  if (spec.schedule.kind === "watch") r.watchPaths = spec.schedule.paths;
  if (spec.schedule.kind === "daemon") r.keepAliveSec = spec.schedule.restartSec;
  return r;
}

/* ── Task XML rendering ─────────────────────────────────────────────────── */

/** XML-escape, failing closed on control characters for the same reason
 *  SystemdUser's esc() does: no legitimate value contains one, and a free-text
 *  field must never be able to smuggle structure into the task definition. */
function esc(v: string): string {
  const bad = v.match(/[\x00-\x1f\x7f]/);
  if (bad) {
    const code = bad[0].charCodeAt(0).toString(16).padStart(2, "0");
    throw new Error(`SchtasksUser: refusing to render task field containing control character 0x${code}`);
  }
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Same constraint as SystemdUser: the label becomes the task name and the
 *  basename of files under TASK_DIR, so it must not be able to traverse. */
const LABEL_RE = /^[A-Za-z0-9._-]+$/;
function assertValidLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `SchtasksUser: invalid task label ${JSON.stringify(label)} — must match ${LABEL_RE} (prevents path traversal on the task filename)`,
    );
  }
}

/** Windows command-line quoting for the action's <Arguments>. Each argument is
 *  quoted; a literal `"` cannot be represented safely, so it is rejected. */
export function argLine(argv: string[]): string {
  return argv
    .map((a) => {
      if (a.includes('"')) throw new Error(`SchtasksUser: argument contains a double quote: ${a}`);
      // A trailing backslash would escape the closing quote; double it.
      return `"${a.replace(/(\\+)$/, "$1$1")}"`;
    })
    .join(" ");
}

/** ISO-8601 duration in whole seconds or minutes. Task Scheduler's minimum
 *  repetition interval is one minute, so intervals are clamped up to it. */
function duration(seconds: number, minSeconds = 0): string {
  const s = Math.max(Math.round(seconds), minSeconds);
  return s % 60 === 0 ? `PT${s / 60}M` : `PT${s}S`;
}

/** Local wall-clock timestamp without zone, which is what StartBoundary wants. */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Is the task resident (daemon or watcher) rather than a one-shot run? */
export function isResident(s: Schedule): boolean {
  return s.kind === "daemon" || s.kind === "watch";
}

function triggerXml(s: Schedule, user: string, now: Date): string[] {
  switch (s.kind) {
    case "interval": {
      // StartBoundary two minutes out stands in for launchd's RunAtLoad,
      // matching SystemdUser's OnBootSec=2min.
      const start = new Date(now.getTime() + 2 * 60_000);
      return [
        "    <TimeTrigger>",
        "      <Repetition>",
        `        <Interval>${duration(s.seconds, 60)}</Interval>`,
        "        <StopAtDurationEnd>false</StopAtDurationEnd>",
        "      </Repetition>",
        `      <StartBoundary>${localStamp(start)}</StartBoundary>`,
        "      <Enabled>true</Enabled>",
        "    </TimeTrigger>",
      ];
    }
    case "calendar": {
      const start = new Date(now);
      start.setHours(s.hour, s.minute, 0, 0);
      // Start tomorrow if today's slot has passed, so registering the task
      // never reads as an already-missed run.
      if (start <= now) start.setDate(start.getDate() + 1);
      return [
        "    <CalendarTrigger>",
        `      <StartBoundary>${localStamp(start)}</StartBoundary>`,
        "      <Enabled>true</Enabled>",
        "      <ScheduleByDay>",
        "        <DaysInterval>1</DaysInterval>",
        "      </ScheduleByDay>",
        "    </CalendarTrigger>",
      ];
    }
    case "daemon":
    case "watch":
      return [
        "    <LogonTrigger>",
        "      <Enabled>true</Enabled>",
        `      <UserId>${esc(user)}</UserId>`,
        "    </LogonTrigger>",
      ];
  }
}

/**
 * Render the Task Scheduler XML for a spec. `user` is DOMAIN\name of the
 * account the task runs as; `bun` is the absolute bun.exe; `jsonPath` is where
 * the RunnerSpec for this task is written. `now` is injectable for tests.
 */
export function renderTaskXml(
  spec: UnitSpec,
  opts: { user: string; bun: string; jsonPath: string; now?: Date; name?: string },
): string {
  assertValidLabel(spec.label);
  const now = opts.now ?? new Date();
  const resident = isResident(spec.schedule);
  const restartSec = spec.schedule.kind === "daemon" ? spec.schedule.restartSec : 60;
  const args = argLine(["--headless", opts.bun, RUNNER, opts.jsonPath]);

  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${esc(spec.description)} — generated by LifeOS lib/SchtasksUser.ts; do not edit, re-run the installer.</Description>`,
    `    <URI>${esc(opts.name && opts.name.startsWith("\\") ? opts.name : `\\${opts.name ?? spec.label}`)}</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    ...triggerXml(spec.schedule, opts.user, now),
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${esc(opts.user)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    // Never stack runs: a slow sweep must finish before the next one starts.
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    // The systemd `Persistent=true` counterpart: catch up a missed run.
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    // Resident tasks run forever; one-shots get a generous ceiling so a hung
    // run cannot block every later one under IgnoreNew.
    `    <ExecutionTimeLimit>${resident ? "PT0S" : "PT12H"}</ExecutionTimeLimit>`,
    "    <Priority>7</Priority>",
  ];
  if (resident) {
    // KeepAlive + ThrottleInterval. Task Scheduler's floor is one minute.
    lines.push(
      "    <RestartOnFailure>",
      `      <Interval>${duration(restartSec, 60)}</Interval>`,
      "      <Count>999</Count>",
      "    </RestartOnFailure>",
    );
  }
  lines.push(
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    // conhost --headless gives the job a console that is never shown, so no
    // window flashes up on every run.
    "      <Command>conhost.exe</Command>",
    `      <Arguments>${esc(args)}</Arguments>`,
    `      <WorkingDirectory>${esc(spec.workingDirectory ?? dirname(getLifeosDir()))}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  );
  return lines.join("\r\n") + "\r\n";
}

/** schtasks only reliably accepts task XML as UTF-16LE with a BOM. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.from("﻿" + xml, "utf16le");
}

/* ── schtasks plumbing ──────────────────────────────────────────────────── */

export interface Run {
  ok: boolean;
  out: string;
  err: string;
}

function sh(cmd: string[]): Run {
  // A missing binary makes Bun.spawnSync throw; return a normal failed Run
  // instead so the caller can print a diagnosis, as SystemdUser does.
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true });
    return { ok: p.exitCode === 0, out: p.stdout?.toString() ?? "", err: p.stderr?.toString() ?? "" };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

function powershell(script: string): Run {
  return sh(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script]);
}

export function schtasks(args: string[]): Run {
  return sh(["schtasks.exe", ...args]);
}

/** DOMAIN\name of the current user, as Task Scheduler wants it. `whoami`
 *  rather than USERNAME/USERDOMAIN, which a non-interactive shell may lack. */
function currentUser(): string {
  const who = sh(["whoami.exe"]).out.trim();
  if (who) return who;
  const name = process.env.USERNAME ?? "";
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/** Absolute path of an executable, or "". Uses `where.exe` and prefers the
 *  .exe hit — `which` does not exist on Windows (see #1992), and npm-style
 *  .cmd shims cannot be launched directly (see #2057). For bun, falls back to
 *  the installer's default location. */
export function whichSync(bin: string): string {
  const hits = sh(["where.exe", bin]).out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (exe) return exe;
  if (bin === "bun") {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    const fallback = join(home, ".bun", "bin", "bun.exe");
    if (home && existsSync(fallback)) return fallback;
  }
  return "";
}

export async function which(bin: string): Promise<string> {
  return whichSync(bin);
}

function taskFiles(label: string): { xml: string; json: string } {
  assertValidLabel(label);
  return { xml: join(TASK_DIR, `${label}.xml`), json: join(TASK_DIR, `${label}.json`) };
}

/** A PowerShell single-quoted literal. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * End the task AND the runner it started. `schtasks /End` only terminates the
 * task's own process (conhost); the bun TaskRunner beneath it survives as an
 * orphan, which for a resident watcher means it keeps running after uninstall.
 * Every runner's command line carries its task's unique JSON path, so match
 * on that. The job process the runner started (a daemon such as the Workflows
 * dispatcher) is stopped too; anything that job started in turn is left alone,
 * as launchd's AbandonProcessGroup leaves a restarted dispatcher's runs alone.
 */
function stopTask(label: string): void {
  schtasks(["/End", "/TN", taskName(label)]);
  const needle = psq(taskFiles(label).json);
  powershell(
    `$all = Get-CimInstance Win32_Process; ` +
      `$r = @($all | Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -and $_.CommandLine.Contains(${needle}) }); ` +
      `$ids = @($r | ForEach-Object { $_.ProcessId }); ` +
      `$kids = @($all | Where-Object { $ids -contains $_.ParentProcessId }); ` +
      `foreach ($p in @($r) + $kids) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`,
  );
}

/** Task Scheduler's informational result codes, which are not failures. */
function describeResult(code: number): string {
  if (code === 0x41301) return "currently running";
  if (code === 0x41303) return "has not run yet";
  if (code === 0) return "success";
  return `failed, 0x${code.toString(16).toUpperCase()}`;
}

/* ── Public operations ──────────────────────────────────────────────────── */

/**
 * Write the runner JSON and task XML, then register the task. Idempotent:
 * `/F` replaces an existing task of the same name, and a resident task is
 * ended first so the new definition takes over cleanly. Resident tasks are
 * started immediately (systemd's `enable --now`); scheduled ones wait for
 * their first trigger.
 */
export function installSync(spec: UnitSpec, log: (m: string) => void): boolean {
  const bun = whichSync("bun");
  if (!bun) {
    log("bun.exe not found on PATH or in %USERPROFILE%\\.bun\\bin — install bun first");
    return false;
  }
  if (!existsSync(RUNNER)) {
    log(`task runner missing at ${RUNNER}`);
    return false;
  }
  const user = currentUser();
  if (!user) {
    log("could not resolve the current user via whoami");
    return false;
  }
  const name = taskName(spec.label);

  mkdirSync(TASK_DIR, { recursive: true });
  mkdirSync(dirname(spec.logPath), { recursive: true });
  if (spec.errLogPath) mkdirSync(dirname(spec.errLogPath), { recursive: true });

  const files = taskFiles(spec.label);
  if (isResident(spec.schedule)) stopTask(spec.label);

  writeFileSync(files.json, JSON.stringify(runnerSpec(spec), null, 2) + "\n");
  log(`wrote ${files.json}`);
  writeFileSync(files.xml, encodeTaskXml(renderTaskXml(spec, { user, bun, jsonPath: files.json, name })));
  log(`wrote ${files.xml}`);

  const create = schtasks(["/Create", "/TN", name, "/XML", files.xml, "/F"]);
  if (!create.ok) {
    log(`schtasks /Create failed: ${(create.err || create.out).trim()}`);
    return false;
  }

  if (isResident(spec.schedule)) {
    const run = schtasks(["/Run", "/TN", name]);
    if (!run.ok) log(`note: registered but could not start now: ${(run.err || run.out).trim()}`);
  }
  log(`scheduled task registered — ${name}`);
  return true;
}

export async function install(spec: UnitSpec, log: (m: string) => void): Promise<boolean> {
  return installSync(spec, log);
}

/** End and delete the task, and remove every file this label created. */
export function uninstallLabelSync(label: string, log: (m: string) => void): boolean {
  const files = taskFiles(label);
  const name = taskName(label);
  stopTask(label);
  const del = schtasks(["/Delete", "/TN", name, "/F"]);
  if (del.ok) log(`scheduled task deleted — ${name}`);
  else log(`no scheduled task named ${name} — nothing to delete`);
  for (const f of [files.xml, files.json]) {
    if (existsSync(f)) {
      rmSync(f);
      log(`removed ${f}`);
    }
  }
  return true;
}

export function uninstallSync(spec: UnitSpec, log: (m: string) => void): boolean {
  return uninstallLabelSync(spec.label, log);
}

export async function uninstall(spec: UnitSpec, log: (m: string) => void): Promise<boolean> {
  return uninstallSync(spec, log);
}

/**
 * Every task registered in one Task Scheduler folder that is not disabled,
 * by bare task name. Read through the ScheduledTasks module rather than
 * `schtasks /Query`, whose output is translated on non-English Windows. A
 * failed query is an empty set (the caller then reports "not loaded").
 */
export function enabledTaskNames(path: string = taskPath()): Set<string> {
  const r = powershell(
    `Get-ScheduledTask -TaskPath ${psq(path)} -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.State -ne 'Disabled' } | ForEach-Object { $_.TaskName }`,
  );
  return new Set(r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
}

/** Is a task for this label registered (and not disabled) in the LifeOS task folder? */
export function isLoadedSync(label: string): boolean {
  assertValidLabel(label);
  return enabledTaskNames().has(label);
}

/**
 * Print whether the task is registered and what it is doing. Queried through
 * the ScheduledTasks PowerShell module rather than `schtasks /Query`, whose
 * field names are translated on non-English Windows. The label is already
 * constrained by LABEL_RE, so it is safe to interpolate.
 */
export function statusSync(spec: UnitSpec, log: (m: string) => void): boolean {
  assertValidLabel(spec.label);
  const where = `-TaskPath ${psq(taskPath())} -TaskName '${spec.label}'`;
  const ps = [
    `$t = Get-ScheduledTask ${where} -ErrorAction SilentlyContinue`,
    "if (-not $t) { exit 3 }",
    "$i = $t | Get-ScheduledTaskInfo",
    "$f = { param($d) if ($d -and $d.Year -gt 1999) { $d.ToString('yyyy-MM-dd HH:mm') } else { 'never' } }",
    "\"state: $($t.State)\"",
    "\"last run: $(& $f $i.LastRunTime)\"",
    "\"result: $($i.LastTaskResult)\"",
    "\"next run: $(& $f $i.NextRunTime)\"",
  ].join("; ");
  const r = powershell(ps);
  if (!r.ok) {
    log(`not installed (no scheduled task named ${taskName(spec.label)})`);
    return false;
  }
  for (const line of r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^result: (\d+)$/);
    log(m ? `last result: ${describeResult(Number(m[1]))}` : line);
  }
  log(`log: ${spec.logPath}`);
  return true;
}

export async function status(spec: UnitSpec, log: (m: string) => void): Promise<boolean> {
  return statusSync(spec, log);
}

/** Start a registered task now (schtasks /Run), e.g. a first run after install. */
export function runNowSync(label: string): Run {
  return schtasks(["/Run", "/TN", taskName(label)]);
}

/**
 * The cadence a rendered task XML declares, in Services.ts's vocabulary
 * ("every 1h", "daily/scheduled", "at load"). `xml` is the decoded text.
 */
export function cadenceOfTaskXml(xml: string): string {
  if (/<CalendarTrigger>/.test(xml)) return "daily/scheduled";
  const iv = xml.match(/<TimeTrigger>[\s\S]*?<Interval>PT(\d+)([MS])<\/Interval>/);
  if (iv) {
    const s = iv[2] === "M" ? +iv[1] * 60 : +iv[1];
    return s % 3600 === 0 ? `every ${s / 3600}h` : `every ${Math.round(s / 60)}m`;
  }
  if (/<LogonTrigger>/.test(xml)) return "at load";
  return "—";
}

/**
 * The environment every LifeOS task carries: HOME (Task Scheduler sets none,
 * #1729) and the install-root variables (CLAUDE_CONFIG_DIR, LIFEOS_DIR) of the
 * process that installed it, so a job of an install in a non-default config
 * directory finds its own tree, as schedule-install.ts bakes them into plists.
 */
export function installEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const home = env.HOME ?? env.USERPROFILE;
  if (home) out.HOME = home;
  for (const k of ["CLAUDE_CONFIG_DIR", "LIFEOS_DIR"]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** The LifeOS root a task's paths hang off (`<config>/LIFEOS`), honouring the install-root variables. */
export function lifeosRoot(): string {
  return getLifeosDir();
}

/** True when this module is the right backend for the running platform. */
export function isWindows(): boolean {
  return process.platform === "win32";
}
