#!/usr/bin/env bun
/**
 * InstallWorkSweep.ts — Materialize the WorkSweep scheduler unit(s) and bootstrap them.
 *
 *   bun ~/.claude/LIFEOS/TOOLS/InstallWorkSweep.ts             # install
 *   bun ~/.claude/LIFEOS/TOOLS/InstallWorkSweep.ts --uninstall # remove
 *   bun ~/.claude/LIFEOS/TOOLS/InstallWorkSweep.ts --status    # check
 *
 * Two backends, chosen by process.platform — the same split PULSE/manage.sh
 * already uses for Pulse itself (public PR #1692, @takanorinishida):
 *
 *   darwin: substitutes {{HOME}}/{{BUN}}/{{BUN_DIR}} into
 *     com.lifeos.worksweep.plist.template, writes
 *     ~/Library/LaunchAgents/com.lifeos.worksweep.plist, runs `launchctl bootstrap`.
 *   linux: substitutes the same placeholders into
 *     com.lifeos.worksweep.{service,timer}.template, writes them to
 *     ~/.config/systemd/user/, and enables the timer with `systemctl --user`.
 *     Needs `loginctl enable-linger` to survive logout — the same requirement
 *     PULSE/manage.sh documents for com.lifeos.pulse.
 *
 *   win32: registers a current-user Task Scheduler task via lib/SchtasksUser.ts
 *     (no admin rights). Runs while the user is logged on; a run missed during
 *     sleep fires once on wake.
 *
 * The darwin path is unchanged: linux and win32 support are branches beside it,
 * not replacements. All are idempotent — install tears down the prior unit first.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "node:os";
import * as schtasks from "./lib/SchtasksUser";

declare const Bun: { spawn: (cmd: string[], opts?: any) => any };

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LABEL = "com.lifeos.worksweep";
const IS_LINUX = process.platform === "linux";

// darwin (launchd)
const TEMPLATE_PATH = join(HOME, ".claude", "LIFEOS", "TOOLS", "com.lifeos.worksweep.plist.template");
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const TARGET_PLIST = join(LAUNCH_AGENTS_DIR, "com.lifeos.worksweep.plist");

// linux (systemd --user)
const SERVICE_TEMPLATE_PATH = join(HOME, ".claude", "LIFEOS", "TOOLS", "com.lifeos.worksweep.service.template");
const TIMER_TEMPLATE_PATH = join(HOME, ".claude", "LIFEOS", "TOOLS", "com.lifeos.worksweep.timer.template");
const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");
const TARGET_SERVICE = join(SYSTEMD_USER_DIR, `${LABEL}.service`);
const TARGET_TIMER = join(SYSTEMD_USER_DIR, `${LABEL}.timer`);
const TIMER_UNIT = `${LABEL}.timer`;

async function uid(): Promise<string> {
  const proc = Bun.spawn(["id", "-u"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function username(): Promise<string> {
  // `id -un` rather than process.env.USER — USER isn't guaranteed to be set in a
  // non-interactive shell, and `loginctl enable-linger ""` fails on the empty string.
  const proc = Bun.spawn(["id", "-un"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

async function run(cmd: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { ok: exit === 0, out, err };
}

function materialize(templatePath: string, bunPath: string, bunDir: string): string {
  return readFileSync(templatePath, "utf-8")
    .replace(/\{\{HOME\}\}/g, HOME)
    .replace(/\{\{BUN\}\}/g, bunPath)
    .replace(/\{\{BUN_DIR\}\}/g, bunDir);
}

async function launchctl(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { ok: exit === 0, out, err };
}

async function detectBun(): Promise<string> {
  // Detect bun via `which bun` — survives different install paths (homebrew, ~/.bun, asdf).
  const proc = Bun.spawn(["which", "bun"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const path = out.trim();
  if (!path) throw new Error("bun not found in PATH — install bun first");
  return path;
}

async function install(): Promise<void> {
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`[InstallWorkSweep] template missing at ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  const bunPath = await detectBun();
  const bunDir = bunPath.replace(/\/bun$/, "");
  console.log(`[InstallWorkSweep] detected bun at ${bunPath}`);
  const materialized = materialize(TEMPLATE_PATH, bunPath, bunDir);
  if (!existsSync(LAUNCH_AGENTS_DIR)) mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

  // Idempotent bootout (ignore failures — first install has nothing to remove)
  const u = await uid();
  if (existsSync(TARGET_PLIST)) {
    await launchctl(["bootout", `gui/${u}`, TARGET_PLIST]);
  }

  writeFileSync(TARGET_PLIST, materialized);
  console.log(`[InstallWorkSweep] wrote ${TARGET_PLIST}`);

  const r = await launchctl(["bootstrap", `gui/${u}`, TARGET_PLIST]);
  if (!r.ok) {
    console.error(`[InstallWorkSweep] bootstrap failed: ${r.err.trim()}`);
    process.exit(1);
  }
  console.log(`[InstallWorkSweep] launchd bootstrap OK — ${LABEL} active`);

  const status = await launchctl(["print", `gui/${u}/${LABEL}`]);
  if (status.ok) {
    const stateLine = status.out.split("\n").find((l) => l.includes("state ="));
    console.log(`[InstallWorkSweep] ${stateLine?.trim() ?? "state unknown"}`);
  }
}

async function uninstall(): Promise<void> {
  const u = await uid();
  if (existsSync(TARGET_PLIST)) {
    const r = await launchctl(["bootout", `gui/${u}`, TARGET_PLIST]);
    console.log(`[InstallWorkSweep] bootout ${r.ok ? "OK" : "FAILED: " + r.err.trim()}`);
    try { unlinkSync(TARGET_PLIST); console.log(`[InstallWorkSweep] removed ${TARGET_PLIST}`); } catch {}
  } else {
    console.log(`[InstallWorkSweep] no plist at ${TARGET_PLIST} — nothing to do`);
  }
}

async function status(): Promise<void> {
  const u = await uid();
  const r = await launchctl(["print", `gui/${u}/${LABEL}`]);
  if (!r.ok) {
    console.log(`[InstallWorkSweep] ${LABEL} not loaded`);
    process.exit(1);
  }
  console.log(r.out);
}

// ── linux (systemd --user) ──

async function installLinux(): Promise<void> {
  if (!existsSync(SERVICE_TEMPLATE_PATH) || !existsSync(TIMER_TEMPLATE_PATH)) {
    console.error(`[InstallWorkSweep] template missing — expected ${SERVICE_TEMPLATE_PATH} and ${TIMER_TEMPLATE_PATH}`);
    process.exit(1);
  }
  const bunPath = await detectBun();
  const bunDir = bunPath.replace(/\/bun$/, "");
  console.log(`[InstallWorkSweep] detected bun at ${bunPath}`);

  if (!existsSync(SYSTEMD_USER_DIR)) mkdirSync(SYSTEMD_USER_DIR, { recursive: true });

  // Idempotent teardown (ignore failures — first install has nothing to remove)
  await run(["systemctl", "--user", "disable", "--now", TIMER_UNIT]);

  writeFileSync(TARGET_SERVICE, materialize(SERVICE_TEMPLATE_PATH, bunPath, bunDir));
  writeFileSync(TARGET_TIMER, materialize(TIMER_TEMPLATE_PATH, bunPath, bunDir));
  console.log(`[InstallWorkSweep] wrote ${TARGET_SERVICE}`);
  console.log(`[InstallWorkSweep] wrote ${TARGET_TIMER}`);

  await run(["systemctl", "--user", "daemon-reload"]);
  await run(["loginctl", "enable-linger", await username()]);

  const r = await run(["systemctl", "--user", "enable", "--now", TIMER_UNIT]);
  if (!r.ok) {
    console.error(`[InstallWorkSweep] enable --now failed: ${r.err.trim()}`);
    process.exit(1);
  }
  console.log(`[InstallWorkSweep] systemd timer enabled — ${TIMER_UNIT} active`);

  const list = await run(["systemctl", "--user", "list-timers", TIMER_UNIT, "--no-pager"]);
  if (list.ok) console.log(list.out.trim());
}

async function uninstallLinux(): Promise<void> {
  await run(["systemctl", "--user", "disable", "--now", TIMER_UNIT]);
  let removed = false;
  for (const f of [TARGET_SERVICE, TARGET_TIMER]) {
    if (existsSync(f)) {
      try { unlinkSync(f); console.log(`[InstallWorkSweep] removed ${f}`); removed = true; } catch {}
    }
  }
  if (!removed) console.log(`[InstallWorkSweep] no unit files found — nothing to do`);
  await run(["systemctl", "--user", "daemon-reload"]);
}

async function statusLinux(): Promise<void> {
  const r = await run(["systemctl", "--user", "status", TIMER_UNIT, "--no-pager"]);
  console.log(r.out || r.err);
  const list = await run(["systemctl", "--user", "list-timers", TIMER_UNIT, "--no-pager"]);
  if (list.ok) console.log(list.out.trim());
  if (!r.ok) process.exit(1);
}

/* ── Windows Task Scheduler backend (win32 only) ────────────────────────────
 * Strictly additive. The launchd and systemd paths above are unchanged; on
 * darwin and linux nothing in this section executes. Same job as the plist:
 * WorkSweep.ts hourly, first run shortly after install, catch-up after sleep,
 * logging to the same file. Translation rules live in lib/SchtasksUser.ts.
 * ------------------------------------------------------------------------- */

async function windowsSpec(): Promise<schtasks.UnitSpec> {
  const bunPath = await schtasks.which("bun");
  if (!bunPath) throw new Error("bun not found in PATH - install bun first");
  return {
    label: LABEL,
    description: "LifeOS Work Sweep — periodic Work System capture (session catch-up, stale flagging, project checks, TELOS goals)",
    exec: [bunPath, join(HOME, ".claude", "LIFEOS", "TOOLS", "WorkSweep.ts")],
    logPath: join(HOME, ".claude", "LIFEOS", "MEMORY", "STATE", "com.lifeos.worksweep.log"),
    workingDirectory: join(HOME, ".claude"),
    environment: { HOME },
    schedule: { kind: "interval", seconds: 3600 },
  };
}

async function windowsMain(arg: string | undefined): Promise<void> {
  const spec = await windowsSpec();
  const log = (m: string) => console.log(`[InstallWorkSweep] ${m}`);
  if (arg === "--uninstall") { await schtasks.uninstall(spec, log); return; }
  if (arg === "--status") { if (!(await schtasks.status(spec, log))) process.exit(1); return; }
  if (!(await schtasks.install(spec, log))) process.exit(1);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (schtasks.isWindows()) return windowsMain(arg);
  if (arg === "--uninstall") return IS_LINUX ? uninstallLinux() : uninstall();
  if (arg === "--status") return IS_LINUX ? statusLinux() : status();
  return IS_LINUX ? installLinux() : install();
}

if (import.meta.main) {
  main().catch((err) => { console.error(`[InstallWorkSweep] Fatal: ${err}`); process.exit(1); });
}
