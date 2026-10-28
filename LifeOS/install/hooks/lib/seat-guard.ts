/**
 * SeatGuard — never hand the principal something on a screen they are not in front of.
 *
 * The principal often works this machine remotely from a laptop or phone. Anything a
 * command opens here (`open`, `open -R`, `open -a`, `qlmanage -p`) then lands on an
 * empty desk. The signal is this machine's own keyboard and mouse: when they have been
 * idle for longer than SEAT_IDLE_MIN while the principal is prompting, they are elsewhere,
 * and a hand-off must be a link that works anywhere (the share service, a public URL).
 */
import { spawnSync } from "node:child_process";

export const SEAT_IDLE_MIN = 10;

/**
 * Minutes since this machine last saw keyboard or mouse input, or null when unreadable.
 * LIFEOS_SEAT_IDLE_MIN replaces the reading: Assay's replay sets it to the idle time a past turn ran under
 * (STATVS ISA ISC-52). Only the process that starts the hook can set it; a tool call cannot.
 */
export function machineIdleMinutes(): number | null {
  const injected = process.env.LIFEOS_SEAT_IDLE_MIN;
  if (injected !== undefined && /^\d+$/.test(injected)) return Number(injected);
  return hardwareIdleMinutes();
}

/** The keyboard and mouse reading itself, never the replay override: what a record of the turn must hold. */
export function hardwareIdleMinutes(): number | null {
  if (process.platform !== "darwin") return null;
  const r = spawnSync("ioreg", ["-c", "IOHIDSystem"], { windowsHide: true, encoding: "utf8", timeout: 2000 });
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(r.stdout ?? "");
  return m ? Math.floor(Number(m[1]) / 1e9 / 60) : null;
}

/** A command that puts something on this machine's screen for a person to look at. */
export function opensOnScreen(command: string): boolean {
  // Quoted text is data (a script body, a table cell), never a command run here.
  const bare = command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // `open -g` launches in the background: nothing comes to the front for a person to look at.
  const background = /\bopen\s+(-[a-zA-Z]*g[a-zA-Z]*\s+)/.test(bare);
  return /(^|[;&|(`]\s*|\s&&\s*|\bthen\s+|\bdo\s+)(open|qlmanage)\s/.test(bare) && !/\bopen\s+(-h|--help)\b/.test(bare) && !background;
}

interface GuardInput { tool_name?: string; tool_input?: { command?: unknown } }

export function seatGuard(input: GuardInput, idle: () => number | null = machineIdleMinutes): { block: true; message: string } | null {
  if (input?.tool_name !== undefined && input.tool_name !== "Bash") return null;
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !opensOnScreen(command)) return null;
  const mins = idle();
  if (mins === null || mins < SEAT_IDLE_MIN) return null;
  return {
    block: true,
    message:
      `LifeOS: BLOCKED (SeatGuard). The principal is not at this machine: its keyboard and mouse have been idle ${mins} min while they are prompting, ` +
      `so anything opened here lands on an empty screen. Find where they are (bun LIFEOS/LOCATION/Location.ts now --json) and hand them a link that works on ` +
      `the device they are using: upload through the share service (the share skill, "sh") or give a public URL, and put the link in the answer.\n`,
  };
}
