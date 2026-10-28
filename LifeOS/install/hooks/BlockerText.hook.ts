#!/usr/bin/env bun
/**
 * @version 1.0.0
 * BlockerText.hook.ts — texts {{PRINCIPAL_NAME}} when a session is held on a critical blocker while he is away (Vigil ISA F19).
 *
 * TRIGGER: Notification (a `permission_prompt` is a gate holding a tool call) and Stop (a 🚨 item under ❓ OPEN), both
 * async, so it never delays or changes a turn. Logic and tests: lib/blocker-text.ts.
 *
 * MODE: USER/CONFIG/blocker-text.json `{ "mode": "dry-run" | "live" }`, dry-run when absent. Dry-run records an info
 * event and a log line only; live hands the text to Vigil as a decision-class job text with --now.
 *
 * REPORT: `bun hooks/BlockerText.hook.ts --report [--days N]` prints the would-send counts.
 *
 * SAFETY: silent in headless and texting sessions; fails open on every error.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readHookInput, parseTranscriptFromInput } from "./lib/hook-io";
import { getLifeosDir } from "./lib/paths";
import { writeStatvsEvent } from "./lib/handoff-state";
import { blockerFromNotification, criticalOpenItems, handle, report, type Blocker, type Mode } from "./lib/blocker-text";
import { getDAName } from "./lib/identity";

const LIFEOS_DIR = getLifeosDir();
const LOG_PATH = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY", "blocker-text.jsonl");
const STATE_PATH = join(LIFEOS_DIR, "MEMORY", "STATE", "blocker-text.json");
const CONFIG_PATH = join(LIFEOS_DIR, "USER", "CONFIG", "blocker-text.json");
const VIGIL = join(LIFEOS_DIR, "VIGIL", "Vigil.ts");
const SEEN_TTL_MS = 7 * 86_400_000;

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
}

function mode(): Mode {
  return readJson<{ mode?: string }>(CONFIG_PATH, {}).mode === "live" ? "live" : "dry-run";
}

function loadSeen(): Record<string, number> {
  const now = Date.now();
  return Object.fromEntries(Object.entries(readJson<Record<string, number>>(STATE_PATH, {})).filter(([, t]) => now - t < SEEN_TTL_MS));
}

function append(path: string, row: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
}

function emitLive(text: string, key: string): void {
  const dir = mkdtempSync(join(tmpdir(), "blocker-text-"));
  try {
    const file = join(dir, "text.txt");
    writeFileSync(file, text, { mode: 0o600 });
    execFileSync("bun", [VIGIL, "emit", "--text-file", file, "--source", "blocker-text", "--class", "decision", "--key", key, "--now"], { windowsHide: true, stdio: "ignore", timeout: 60_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function credentialRefusal(text: string): string | null {
  const { credentialRefusal: refuse } = require("../LIFEOS/STATVS/lib/refuse") as { credentialRefusal: (t: string) => string | null };
  return refuse(text);
}

async function main(): Promise<void> {
  if (process.argv.includes("--report")) {
    const i = process.argv.indexOf("--days");
    const days = i > 0 ? Math.max(1, Number(process.argv[i + 1]) || 7) : 7;
    const rows = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    const r = { mode: mode(), ...report(rows, days) };
    console.log(JSON.stringify(r));
    // --emit: the dry-run check-in workflow texts {{PRINCIPAL_NAME}} the count through Vigil (ISC-488).
    if (process.argv.includes("--emit")) {
      const text = `Blocker texts, ${r.days}-day ${r.mode}: ${r.total} would have gone out (${r.permission} approvals held, ${r.critical} critical decisions), about ${r.perDay} a day. Say "live" to ${getDAName()} to switch them on.`;
      const dir = mkdtempSync(join(tmpdir(), "blocker-text-"));
      try {
        const file = join(dir, "text.txt");
        writeFileSync(file, text, { mode: 0o600 });
        execFileSync("bun", [VIGIL, "emit", "--text-file", file, "--source", "followups", "--class", "prep", "--key", `followup:blocker-text-dry-run:${new Date().toISOString().slice(0, 10)}`], { windowsHide: true, stdio: "ignore", timeout: 60_000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return;
  }
  if (process.env.LIFEOS_TEXTING_SESSION || process.env.LIFEOS_NOTIFICATION_CHANNEL === "headless") return;
  const input = await readHookInput();
  if (!input) return;
  const raw = input as unknown as Record<string, unknown>;
  let blockers: Blocker[] = [];
  if (raw.hook_event_name === "Notification") {
    const b = blockerFromNotification(raw);
    if (b) blockers = [b];
  } else if (raw.hook_event_name === "Stop") {
    if (input.stop_hook_active === true) return;
    const parsed = await parseTranscriptFromInput(input);
    blockers = criticalOpenItems((parsed.lastMessage || "").trim());
  }
  if (blockers.length === 0) return;
  // Location.ts has top-level await, so require() throws on it; a dynamic import is the only way in.
  const loc = (await import("../LIFEOS/LOCATION/Location")) as { nowRecord: () => { device?: { kind?: string } }; localIdleMinutes: () => number | null };
  const seen = loadSeen();
  handle(blockers, {
    sessionId: input.session_id ?? "unknown",
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    mode: mode(),
    deviceKind: () => loc.nowRecord().device?.kind ?? null,
    idleMinutes: () => loc.localIdleMinutes(),
    credentialRefusal,
    seen: (k) => k in seen,
    markSeen: (k) => { seen[k] = Date.now(); mkdirSync(dirname(STATE_PATH), { recursive: true }); writeFileSync(STATE_PATH, JSON.stringify(seen)); },
    writeEvent: (e) => writeStatvsEvent(e),
    log: (row) => append(LOG_PATH, row),
    emitLive,
  });
}

if (import.meta.main) {
  // Fail open, but never silently: a crash is a log line, so a broken hook shows up in the report (2026-10-26: a require()
  // of Location.ts threw on every call and nothing noticed).
  main().catch((e) => { try { append(LOG_PATH, { ts: new Date().toISOString(), outcome: "error", reason: e instanceof Error ? e.message : String(e) }); } catch { /* best effort */ } }).finally(() => process.exit(0));
}
