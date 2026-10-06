/**
 * Tests for the Windows Task Scheduler backend. Pure rendering and the runner
 * only — nothing here registers a task. Runs under Node and Bun:
 *
 *   node --test LIFEOS/TOOLS/lib/SchtasksUser.test.ts
 *   bun test LIFEOS/TOOLS/lib/SchtasksUser.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";
import { fileURLToPath } from "url";
import { argLine, encodeTaskXml, renderTaskXml, runnerSpec, RUNNER } from "./SchtasksUser.ts";
import type { UnitSpec } from "./SchtasksUser.ts";
import { jobEnv, runOnce, watchAndRun } from "./TaskRunner.ts";

const NOW = new Date(2026, 9, 6, 14, 30, 0); // 2026-10-06 14:30 local
const OPTS = { user: "PC\\simon", bun: "C:\\Users\\simon\\.bun\\bin\\bun.exe", jsonPath: "C:\\t\\job.json", now: NOW };

function spec(schedule: UnitSpec["schedule"], extra: Partial<UnitSpec> = {}): UnitSpec {
  return {
    label: "com.lifeos.test",
    description: "LifeOS test job",
    exec: ["C:\\Users\\simon\\.bun\\bin\\bun.exe", "C:\\Users\\simon\\.claude\\LIFEOS\\TOOLS\\Job.ts"],
    logPath: "C:\\Users\\simon\\.claude\\LIFEOS\\MEMORY\\STATE\\com.lifeos.test.log",
    workingDirectory: "C:\\Users\\simon\\.claude",
    schedule,
    ...extra,
  };
}

/* ── renderTaskXml ─────────────────────────────────────────────────────── */

test("interval → repeating TimeTrigger starting two minutes after install", () => {
  const xml = renderTaskXml(spec({ kind: "interval", seconds: 3600 }), OPTS);
  assert.match(xml, /<TimeTrigger>/);
  assert.match(xml, /<Interval>PT60M<\/Interval>/);
  assert.match(xml, /<StartBoundary>2026-10-06T14:32:00<\/StartBoundary>/);
  assert.match(xml, /<ExecutionTimeLimit>PT12H<\/ExecutionTimeLimit>/);
  assert.doesNotMatch(xml, /RestartOnFailure/);
});

test("interval below one minute is clamped to Task Scheduler's floor", () => {
  const xml = renderTaskXml(spec({ kind: "interval", seconds: 20 }), OPTS);
  assert.match(xml, /<Interval>PT1M<\/Interval>/);
});

test("calendar → daily CalendarTrigger, today when the slot is still ahead", () => {
  const xml = renderTaskXml(spec({ kind: "calendar", hour: 18, minute: 5 }), OPTS);
  assert.match(xml, /<CalendarTrigger>/);
  assert.match(xml, /<StartBoundary>2026-10-06T18:05:00<\/StartBoundary>/);
  assert.match(xml, /<DaysInterval>1<\/DaysInterval>/);
});

test("calendar → starts tomorrow when today's slot has passed", () => {
  const xml = renderTaskXml(spec({ kind: "calendar", hour: 3, minute: 30 }), OPTS);
  assert.match(xml, /<StartBoundary>2026-10-07T03:30:00<\/StartBoundary>/);
});

test("daemon → logon trigger for this user, restart on failure, no time limit", () => {
  const xml = renderTaskXml(spec({ kind: "daemon", restartSec: 120 }), OPTS);
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>PC\\simon<\/UserId>[\s\S]*<\/LogonTrigger>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT2M<\/Interval>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
});

test("watch → resident logon task, and the runner spec carries the paths", () => {
  const s = spec({ kind: "watch", paths: ["C:\\Users\\simon\\.claude\\LIFEOS\\USER"] });
  const xml = renderTaskXml(s, OPTS);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.deepEqual(runnerSpec(s).watchPaths, ["C:\\Users\\simon\\.claude\\LIFEOS\\USER"]);
});

test("every task: current user, no elevation, catch-up, no overlap, runs on battery", () => {
  const xml = renderTaskXml(spec({ kind: "interval", seconds: 3600 }), OPTS);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
});

test("action runs bun + TaskRunner under a headless console", () => {
  const xml = renderTaskXml(spec({ kind: "interval", seconds: 3600 }), OPTS);
  assert.match(xml, /<Command>conhost\.exe<\/Command>/);
  const args = xml.match(/<Arguments>(.*)<\/Arguments>/)![1].replace(/&quot;/g, '"');
  assert.equal(args, `"--headless" "${OPTS.bun}" "${RUNNER}" "${OPTS.jsonPath}"`);
  assert.match(xml, /<WorkingDirectory>C:\\Users\\simon\\\.claude<\/WorkingDirectory>/);
});

test("free text is XML-escaped", () => {
  const xml = renderTaskXml(spec({ kind: "interval", seconds: 60 }, { description: "Sweep <inbox> & \"notes\"" }), OPTS);
  assert.match(xml, /Sweep &lt;inbox&gt; &amp; &quot;notes&quot;/);
});

test("control characters are refused rather than rendered", () => {
  assert.throws(() => renderTaskXml(spec({ kind: "interval", seconds: 60 }, { description: "a\nb" }), OPTS), /control character 0x0a/);
});

test("labels that could traverse paths are refused", () => {
  assert.throws(() => renderTaskXml(spec({ kind: "interval", seconds: 60 }, { label: "..\\evil" }), OPTS), /invalid task label/);
});

test("XML uses CRLF and is written as UTF-16LE with a BOM", () => {
  const xml = renderTaskXml(spec({ kind: "interval", seconds: 60 }), OPTS);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n'));
  const buf = encodeTaskXml(xml);
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(buf.subarray(2).toString("utf16le"), xml);
});

/* ── argLine ───────────────────────────────────────────────────────────── */

test("argLine quotes every argument and protects a trailing backslash", () => {
  assert.equal(argLine(["C:\\Program Files\\x.exe", "C:\\dir\\"]), '"C:\\Program Files\\x.exe" "C:\\dir\\\\"');
  assert.throws(() => argLine(['say "hi"']), /double quote/);
});

/* ── TaskRunner ────────────────────────────────────────────────────────── */

test("jobEnv sets HOME, puts bun first, and lets the spec's environment win", () => {
  const env = jobEnv(
    { label: "x", exec: ["C:\\bun\\bin\\bun.exe"], logPath: "C:\\l.log", environment: { FOO: "bar" } },
    { USERPROFILE: "C:\\Users\\simon", Path: "C:\\Windows\\System32" },
  );
  assert.equal(env.HOME, "C:\\Users\\simon");
  assert.equal(env.FOO, "bar");
  const parts = env.Path!.split(delimiter);
  assert.equal(parts[0], "C:\\bun\\bin");
  assert.ok(parts.includes("C:\\Windows\\System32"));
  assert.equal(env.PATH, undefined, "reuses the existing Path key instead of adding a second one");
});

test("runOnce appends stdout and stderr to the log and returns the exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifeos-runner-"));
  const log = join(dir, "nested", "job.log");
  const job = (code: number) => ({
    label: "t",
    exec: [process.execPath, "-e", `console.log('out ${code}'); console.error('err ${code}'); process.exit(${code})`],
    logPath: log,
  });
  assert.equal(await runOnce(job(0)), 0);
  assert.equal(await runOnce(job(3)), 3);
  const text = readFileSync(log, "utf-8");
  for (const line of ["out 0", "err 0", "out 3", "err 3"]) assert.ok(text.includes(line), `log has "${line}"`);
});

test("runOnce records a spawn failure in the log instead of crashing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifeos-runner-"));
  const log = join(dir, "job.log");
  const code = await runOnce({ label: "t", exec: [join(dir, "missing.exe")], logPath: log });
  assert.equal(code, 1);
  assert.match(readFileSync(log, "utf-8"), /\[TaskRunner\] failed to start/);
});

test("watchAndRun runs the job once per burst of changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lifeos-watch-"));
  const watched = join(dir, "watched");
  const log = join(dir, "job.log");
  const stop = watchAndRun(
    { label: "t", exec: [process.execPath, "-e", "console.log('ran')"], logPath: log, watchPaths: [watched] },
    200,
  );
  try {
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 5; i++) writeFileSync(join(watched, `f${i}.md`), "x");
    await new Promise((r) => setTimeout(r, 1500));
    const runs = readFileSync(log, "utf-8").split(/\r?\n/).filter((l) => l === "ran").length;
    assert.equal(runs, 1);
  } finally {
    stop();
  }
});

test("RUNNER points at TaskRunner.ts beside this module", () => {
  assert.equal(RUNNER, join(dirname(fileURLToPath(import.meta.url)), "TaskRunner.ts"));
});
