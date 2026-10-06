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
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Schedule, UnitSpec } from "./SystemdUser";

export type { Schedule, UnitSpec };

declare const Bun: { spawn: (cmd: string[], opts?: any) => any };

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? join(HOME, "AppData", "Local");
/** Where each task's XML and runner JSON live. Per-user, no admin needed. */
export const TASK_DIR = join(LOCAL_APP_DATA, "LifeOS", "schtasks");
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
}

export function runnerSpec(spec: UnitSpec): RunnerSpec {
  assertValidLabel(spec.label);
  const r: RunnerSpec = { label: spec.label, exec: spec.exec, logPath: spec.logPath };
  if (spec.errLogPath) r.errLogPath = spec.errLogPath;
  if (spec.workingDirectory) r.workingDirectory = spec.workingDirectory;
  if (spec.environment) r.environment = spec.environment;
  if (spec.schedule.kind === "watch") r.watchPaths = spec.schedule.paths;
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
  opts: { user: string; bun: string; jsonPath: string; now?: Date },
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
    `    <URI>\\${esc(spec.label)}</URI>`,
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
    `      <WorkingDirectory>${esc(spec.workingDirectory ?? HOME)}</WorkingDirectory>`,
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

async function sh(cmd: string[]): Promise<Run> {
  // A missing binary makes Bun.spawn throw; return a normal failed Run instead
  // so the caller can print a diagnosis, as SystemdUser does.
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    return { ok: exit === 0, out, err };
  } catch (e) {
    return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) };
  }
}

export function schtasks(args: string[]): Promise<Run> {
  return sh(["schtasks.exe", ...args]);
}

/** DOMAIN\name of the current user, as Task Scheduler wants it. `whoami`
 *  rather than USERNAME/USERDOMAIN, which a non-interactive shell may lack. */
async function currentUser(): Promise<string> {
  const r = await sh(["whoami.exe"]);
  const who = r.out.trim();
  if (who) return who;
  const name = process.env.USERNAME ?? "";
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/** Absolute path of an executable, or "". Uses `where.exe` and prefers the
 *  .exe hit — `which` does not exist on Windows (see #1992), and npm-style
 *  .cmd shims cannot be launched directly (see #2057). For bun, falls back to
 *  the installer's default location. */
export async function which(bin: string): Promise<string> {
  const r = await sh(["where.exe", bin]);
  const hits = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  if (exe) return exe;
  if (bin === "bun") {
    const fallback = join(HOME, ".bun", "bin", "bun.exe");
    if (existsSync(fallback)) return fallback;
  }
  return "";
}

function taskFiles(label: string): { xml: string; json: string } {
  assertValidLabel(label);
  return { xml: join(TASK_DIR, `${label}.xml`), json: join(TASK_DIR, `${label}.json`) };
}

/* ── Public operations ──────────────────────────────────────────────────── */

/**
 * Write the runner JSON and task XML, then register the task. Idempotent:
 * `/F` replaces an existing task of the same name, and a resident task is
 * ended first so the new definition takes over cleanly. Resident tasks are
 * started immediately (systemd's `enable --now`); scheduled ones wait for
 * their first trigger.
 */
export async function install(spec: UnitSpec, log: (m: string) => void): Promise<boolean> {
  const bun = await which("bun");
  if (!bun) {
    log("bun.exe not found on PATH or in %USERPROFILE%\\.bun\\bin — install bun first");
    return false;
  }
  if (!existsSync(RUNNER)) {
    log(`task runner missing at ${RUNNER}`);
    return false;
  }
  const user = await currentUser();
  if (!user) {
    log("could not resolve the current user via whoami");
    return false;
  }

  mkdirSync(TASK_DIR, { recursive: true });
  mkdirSync(dirname(spec.logPath), { recursive: true });
  if (spec.errLogPath) mkdirSync(dirname(spec.errLogPath), { recursive: true });

  const files = taskFiles(spec.label);
  if (isResident(spec.schedule)) await schtasks(["/End", "/TN", spec.label]);

  writeFileSync(files.json, JSON.stringify(runnerSpec(spec), null, 2) + "\n");
  log(`wrote ${files.json}`);
  writeFileSync(files.xml, encodeTaskXml(renderTaskXml(spec, { user, bun, jsonPath: files.json })));
  log(`wrote ${files.xml}`);

  const create = await schtasks(["/Create", "/TN", spec.label, "/XML", files.xml, "/F"]);
  if (!create.ok) {
    log(`schtasks /Create failed: ${(create.err || create.out).trim()}`);
    return false;
  }

  if (isResident(spec.schedule)) {
    const run = await schtasks(["/Run", "/TN", spec.label]);
    if (!run.ok) log(`note: registered but could not start now: ${(run.err || run.out).trim()}`);
  }
  log(`scheduled task registered — ${spec.label}`);
  return true;
}

/** End and delete the task, and remove every file this spec created. */
export async function uninstall(spec: UnitSpec, log: (m: string) => void): Promise<boolean> {
  const files = taskFiles(spec.label);
  await schtasks(["/End", "/TN", spec.label]);
  const del = await schtasks(["/Delete", "/TN", spec.label, "/F"]);
  if (del.ok) log(`scheduled task deleted — ${spec.label}`);
  else log(`no scheduled task named ${spec.label} — nothing to delete`);
  for (const f of [files.xml, files.json]) {
    if (existsSync(f)) {
      rmSync(f);
      log(`removed ${f}`);
    }
  }
  return true;
}

/**
 * Print whether the task is registered and what it is doing. Queried through
 * PowerShell's ScheduledTasks module rather than `schtasks /Query`, whose
 * field names are translated on non-English Windows. The label is already
 * constrained by LABEL_RE, so it is safe to interpolate.
 */
export async function status(spec: UnitSpec, log: (m: string) => void): Promise<boolean> {
  assertValidLabel(spec.label);
  const ps = [
    `$t = Get-ScheduledTask -TaskName '${spec.label}' -ErrorAction SilentlyContinue`,
    "if (-not $t) { exit 3 }",
    `$i = Get-ScheduledTaskInfo -TaskName '${spec.label}'`,
    "$f = { param($d) if ($d -and $d.Year -gt 1999) { $d.ToString('yyyy-MM-dd HH:mm') } else { 'never' } }",
    "\"state: $($t.State)\"",
    "\"last run: $(& $f $i.LastRunTime) (result 0x$('{0:X}' -f $i.LastTaskResult))\"",
    "\"next run: $(& $f $i.NextRunTime)\"",
  ].join("; ");
  const r = await sh(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps]);
  if (!r.ok) {
    log(`not installed (no scheduled task named ${spec.label})`);
    return false;
  }
  for (const line of r.out.split(/\r?\n/).filter(Boolean)) log(line.trim());
  log(`log: ${spec.logPath}`);
  return true;
}

/** True when this module is the right backend for the running platform. */
export function isWindows(): boolean {
  return process.platform === "win32";
}
