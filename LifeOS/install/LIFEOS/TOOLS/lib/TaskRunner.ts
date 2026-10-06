#!/usr/bin/env bun
/**
 * TaskRunner.ts — what every Windows scheduled task actually runs.
 *
 *   conhost.exe --headless bun.exe TaskRunner.ts <label>.json
 *
 * Task Scheduler can start a program, but it cannot do three things launchd
 * and systemd do for every LifeOS job: append stdout/stderr to a log file,
 * set environment variables, and run without a visible console. conhost
 * --headless covers the console; this file covers the rest. It reads the
 * RunnerSpec that lib/SchtasksUser.ts wrote beside the task and:
 *
 *   - one-shot jobs: runs `exec` once, appending output to the log, and exits
 *     with the job's exit code so Task Scheduler's "last result" is accurate.
 *   - WatchPaths jobs (`watchPaths` set): stays resident, and runs `exec`
 *     whenever a watched directory changes — Task Scheduler has no file-change
 *     trigger, so this is the launchd WatchPaths / systemd .path equivalent.
 *
 * Uses node:child_process and node:fs only, so it runs under Bun (in
 * production) and Node (in tests) alike.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, watch, writeSync, type FSWatcher } from "fs";
import { spawn } from "child_process";
import { delimiter, dirname, join } from "path";
import type { RunnerSpec } from "./SchtasksUser";

/**
 * The environment a job runs with. Task Scheduler does not set HOME (pulse.ts
 * and the tools it spawns resolve paths from it — see #1729) and does not pick
 * up PATH additions made by shells. PATH order matters:
 *
 *   1. the directory of exec[0] (bun), so jobs can spawn `bun`;
 *   2. Git's bin\ (bash.exe, sh.exe, git.exe only), ahead of System32, so a
 *      job looking up `bash` gets Git Bash instead of WSL's System32\bash.exe
 *      stub (see #2225);
 *   3. the inherited PATH;
 *   4. Git's usr\bin\ last: it supplies POSIX tools for hooks, but its
 *      find.exe/sort.exe must not shadow the Windows ones (same rule as
 *      PULSE/PulseStart.ps1).
 *
 * The spec's own `environment` entries win over all of this.
 */
export function jobEnv(spec: RunnerSpec, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;

  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const gitBin = join(programFiles, "Git", "bin");
  const gitUsrBin = join(programFiles, "Git", "usr", "bin");
  // Windows env keys are case-insensitive; reuse whichever spelling exists.
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const inherited = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const parts = [dirname(spec.exec[0])];
  if (existsSync(gitBin)) parts.push(gitBin);
  parts.push(...inherited);
  if (existsSync(gitUsrBin)) parts.push(gitUsrBin);
  env[pathKey] = [...new Set(parts)].join(delimiter);

  return { ...env, ...(spec.environment ?? {}) };
}

/** Run the job once with output appended to its log(s); resolve to its exit code. */
export function runOnce(spec: RunnerSpec): Promise<number> {
  mkdirSync(dirname(spec.logPath), { recursive: true });
  const out = openSync(spec.logPath, "a");
  const err = spec.errLogPath && spec.errLogPath !== spec.logPath ? openSync(spec.errLogPath, "a") : out;
  return new Promise((resolve) => {
    // A failed spawn can emit both "error" and "exit"; settle exactly once.
    let settled = false;
    const finish = (code: number, note?: string) => {
      if (settled) return;
      settled = true;
      // Surface spawn failures (missing bun, bad path) in the job's own log.
      if (note) writeSync(err, note);
      closeSync(out);
      if (err !== out) closeSync(err);
      resolve(code);
    };
    const child = spawn(spec.exec[0], spec.exec.slice(1), {
      cwd: spec.workingDirectory,
      env: jobEnv(spec),
      stdio: ["ignore", out, err],
      windowsHide: true,
    });
    child.on("error", (e) => finish(1, `[TaskRunner] failed to start ${spec.exec[0]}: ${e.message}\n`));
    child.on("exit", (code) => finish(code ?? 1));
  });
}

/**
 * Stay resident and run the job on every change under `watchPaths`. Changes
 * are debounced, runs never overlap, and a change that lands mid-run causes
 * exactly one follow-up run — the same coalescing launchd gives WatchPaths.
 * Returns a stop function (used by tests).
 */
export function watchAndRun(spec: RunnerSpec, debounceMs = 2000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;

  const fire = async () => {
    timer = null;
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      await runOnce(spec);
    } while (again);
    running = false;
  };
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
  };

  const watchers: FSWatcher[] = [];
  for (const p of spec.watchPaths ?? []) {
    mkdirSync(p, { recursive: true });
    watchers.push(watch(p, onChange));
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}

export function loadSpec(jsonPath: string): RunnerSpec {
  const spec = JSON.parse(readFileSync(jsonPath, "utf-8")) as RunnerSpec;
  if (!Array.isArray(spec.exec) || spec.exec.length === 0 || !spec.logPath) {
    throw new Error(`TaskRunner: ${jsonPath} is missing exec or logPath`);
  }
  return spec;
}

async function main(): Promise<void> {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("usage: TaskRunner.ts <task.json>");
    process.exit(2);
  }
  const spec = loadSpec(jsonPath);
  if (spec.watchPaths?.length) {
    watchAndRun(spec);
    return; // the watchers keep the process alive
  }
  process.exit(await runOnce(spec));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[TaskRunner] Fatal: ${err}`);
    process.exit(1);
  });
}
