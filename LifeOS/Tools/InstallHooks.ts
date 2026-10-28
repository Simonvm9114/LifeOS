#!/usr/bin/env bun
/**
 * InstallHooks — Setup step 7 (trust-gated). Additively merges the payload's
 * `install/hooks/hooks.json` into the harness `settings.json`: per matcher
 * bucket, idempotent by normalized command (and url for http entries), never
 * touching foreign entries. Backs up settings.json before writing. REFUSES on a
 * dev tree (the author's live source) unless --allow-dev.
 *
 * The skill's Setup intent shows the user the exact change (from the dry-run
 * counts) and gets explicit permission BEFORE calling this with --apply.
 *
 * Usage:
 *   bun InstallHooks.ts [--config-root <dir>] [--skill-root <dir>] [--harness claude-code] [--apply] [--allow-dev]
 *   (dry-run by default — reports added/skipped without writing)
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { hookRootPath, mergeHooks, pruneRetiredHooks, refuseDevInstallWrites, repairWindowsHookRoots, repointHookRoots, rewriteHookRoots } from "./InstallEngine";
import { detectEnv } from "./DetectEnv";
import { atomicWriteText } from "./lib/atomic-write";

interface Args { configRoot: string; skillRoot: string; harness?: string; apply: boolean; allowDev: boolean; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const home = process.env.HOME || homedir(); // public issue #1729, @umair-a11y
  return {
    configRoot: resolve(get("--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")),
    skillRoot: get("--skill-root") || join(import.meta.dir, ".."),
    harness: get("--harness"),
    apply: a.includes("--apply"),
    allowDev: a.includes("--allow-dev"),
  };
}

function countFilesRec(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) n += countFilesRec(p);
    else n += 1;
  }
  return n;
}

/** Config-root registrations whose executed hook file is absent after the copy. */
export function wiredButMissingHooks(hooks: Record<string, unknown>, configRoot: string): string[] {
  const root = `${hookRootPath(resolve(configRoot))}/hooks/`;
  const missing = new Set<string>();
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      for (const hook of group.hooks) {
        if (typeof hook?.command !== "string") continue;
        const tokens = hook.command.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
        const first = tokens[0]?.replace(/^["']|["']$/g, "") ?? "";
        const script = (/^(?:bun|node|bash|sh)$/.test(first) ? tokens[1] : tokens[0])?.replace(/^["']|["']$/g, "") ?? "";
        const scriptPath = hookRootPath(script);
        if (scriptPath.startsWith(root) && /\.hook\.(?:ts|sh)$/.test(scriptPath) && !existsSync(scriptPath)) missing.add(scriptPath.slice(root.length));
      }
    }
  }
  return [...missing].sort();
}

function main(): void {
  const { configRoot, skillRoot, harness, apply, allowDev } = parseArgs();

  const detectedHarness = detectEnv().harness.name;
  const effectiveHarness = harness ?? detectedHarness;
  if (effectiveHarness !== "claude-code") {
    console.log(JSON.stringify({
      ok: false,
      refused: "non-claude-code-harness",
      apply,
      harness: detectedHarness,
      detail: "LifeOS hooks are Claude Code only. See INSTALL.md § Harness integration; non-Claude harnesses must not receive Claude hook files or settings registrations.",
    }, null, 2));
    process.exit(1);
  }

  refuseDevInstallWrites(configRoot, [join(configRoot, "hooks"), join(configRoot, "settings.json")], allowDev);

  const hooksJsonPath = join(skillRoot, "install", "hooks", "hooks.json");
  if (!existsSync(hooksJsonPath)) {
    console.log(JSON.stringify({ ok: false, error: `payload hooks.json not found at ${hooksJsonPath}` }, null, 2));
    process.exit(1);
  }
  const rawIncoming = JSON.parse(readFileSync(hooksJsonPath, "utf-8"))?.hooks ?? {};
  // Resolve the payload's $HOME/.claude literals to THIS install's root before
  // merging — without it, an isolated profile's settings.json wires commands
  // that expand to the default profile at fire time
  // (discussion #1900 finding 1, @Patrickraveaux).
  const incoming = rewriteHookRoots(rawIncoming, configRoot);

  // The hook SCRIPTS (*.hook.ts|sh + lib/**) live beside hooks.json in the payload.
  // Merging hooks.json into settings.json wires commands that point at these files,
  // so they MUST be copied onto disk too — else every hook resolves to a nonexistent
  // file (audit 20260702, RC2). Kept atomic with the settings merge (same opt-in +
  // trust-gate): decline hooks → neither scripts nor settings entries land.
  const hooksPayloadDir = join(skillRoot, "install", "hooks");
  const hooksDestDir = join(configRoot, "hooks");
  const hookFiles = countFilesRec(hooksPayloadDir);

  const settingsPath = join(configRoot, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (e) {
      // ABORT on an unparseable EXISTING settings.json — never reset to {}.
      // The prior `catch { settings = {} }` silently dropped model / permissions /
      // env / statusLine and wrote a file containing ONLY "hooks", destroying the
      // user's Claude Code config on the most common hand-edit error (a trailing
      // comma). Fresh-install data loss. (Forge cross-vendor audit 2026-08-11)
      console.log(JSON.stringify({
        ok: false, apply, settingsPath,
        error: `settings.json exists but is not valid JSON: ${e instanceof Error ? e.message : String(e)}. Refusing to write — fix the file (a trailing comma or a comment is the usual cause) and re-run. Your settings were NOT modified.`,
      }, null, 2));
      process.exit(1);
    }
  }
  const existingHooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Record<string, never>;

  const retirementsPath = join(skillRoot, "install", "RETIREMENTS.json");
  const retirements = existsSync(retirementsPath)
    ? (JSON.parse(readFileSync(retirementsPath, "utf-8")).retirements ?? []).map((entry: { path: string }) => entry.path)
    : [];
  const { hooks: retainedHooks, pruned } = pruneRetiredHooks(existingHooks as never, retirements, configRoot);
  // A custom-root profile installed before rewriteHookRoots still carries `$HOME/.claude` commands; the
  // dedup would keep them, so repoint our own entries at this root before merging.
  const { hooks: repairedHooks, repointed } = repointHookRoots(retainedHooks, incoming, configRoot, process.env.HOME || homedir());
  // Windows installs before hookRootPath wrote a bash-escaped root that never resolved; move them to forward slashes.
  const { hooks: slashedHooks, repaired: windowsPaths } = repairWindowsHookRoots(repairedHooks, configRoot);
  const { merged, added, skipped } = mergeHooks(slashedHooks, incoming, configRoot);

  const report = { ok: true, apply, settingsPath, added, skipped, pruned, repointed, windowsPaths, events: Object.keys(merged).length, hooksDestDir, hookFiles };

  if (!apply) {
    console.log(JSON.stringify({ ...report, dryRun: true, note: "no changes written; re-run with --apply after permission" }, null, 2));
    process.exit(0);
  }

  // Back up settings.json before writing (only if it exists).
  let backup: string | undefined;
  if (existsSync(settingsPath)) {
    backup = `${settingsPath}.lifeos-backup-${Date.now()}`;
    copyFileSync(settingsPath, backup);
  }
  // Deploy the hook scripts FIRST, THEN wire settings — the install is not
  // transactional across the two mutations, so ordering is the guard: a copy
  // failure must never leave settings.json pointing at hooks that aren't on
  // disk. The settings write below is the last mutation and is itself atomic
  // (temp+rename), so a kill leaves settings either fully-old or fully-new,
  // never wired-to-absent. (Forge cross-vendor audit 2026-08-11, [D])
  //
  // Recursive copy of the whole payload hooks/ tree (*.hook.ts|sh + lib/**) into
  // <configRoot>/hooks/. ADDITIVE, never clobbering (public issue #1491,
  // @donovan-sec): `force: false` skips any file that already exists on disk — a
  // pre-existing user hook with a colliding name is theirs, not ours. cpSync's
  // default (force: true) silently overwrote every collision.
  mkdirSync(hooksDestDir, { recursive: true });
  const preExisting = countFilesRec(hooksDestDir);
  cpSync(hooksPayloadDir, hooksDestDir, { recursive: true, force: false, errorOnExist: false });
  const hookFilesCopied = countFilesRec(hooksDestDir) - preExisting;
  const skippedExisting = hookFiles - hookFilesCopied;

  settings.hooks = merged;
  // Atomic — a kill mid-write would leave the user with no settings.json at all
  // (public PR #1643, @elhoim)
  atomicWriteText(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  // Copying hook scripts and merging the manifest are two independent operations;
  // a hook can land on disk without any settings entry naming it. Ask the shipped
  // reconciler whether every copied hook is actually reachable, so an unwired hook
  // is loud at install time rather than silent until someone runs Doctor by hand.
  // (public PR #1540 + issue #1539, @tzioup)
  const doctorPath = join(configRoot, "LIFEOS", "TOOLS", "Doctor.ts");
  let unwired: string[] | undefined;
  let reconcile: string | undefined;
  if (existsSync(doctorPath)) {
    try {
      const out = execFileSync("bun", [doctorPath, "--reconcile"], {
        encoding: "utf-8",
        env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot },
      });
      const reconciled = JSON.parse(out);
      unwired = reconciled.unwired ?? [];
    } catch (err) {
      reconcile = `reconciler failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    reconcile = `Doctor.ts not found at ${doctorPath} — hooks copied but not reconciled`;
  }

  const missing = wiredButMissingHooks(merged, configRoot);
  // A registration this payload ships whose script is still absent after the copy means the payload is
  // incomplete and the install is broken, so it fails and InstallAll stops. A registration the user already
  // had that points at a missing file is theirs: it is reported in `missing` and does not fail the step.
  const shippedMissing = wiredButMissingHooks(incoming, configRoot);
  const ok = shippedMissing.length === 0;
  const failure = ok ? {} : { shippedMissing, error: `payload hooks.json wires ${shippedMissing.length} hook file(s) the payload did not provide: ${shippedMissing.join(", ")}` };
  console.log(JSON.stringify({ ...report, ok, written: true, backup, hookFilesCopied, skippedExisting, unwired, missing, reconcile, ...failure }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) main();
