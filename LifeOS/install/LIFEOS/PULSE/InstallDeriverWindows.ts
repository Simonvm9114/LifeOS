#!/usr/bin/env bun
/**
 * InstallDeriverWindows.ts — the Windows counterpart of manage-deriver.sh.
 *
 *   bun ~/.claude/LIFEOS/PULSE/InstallDeriverWindows.ts              # install
 *   bun ~/.claude/LIFEOS/PULSE/InstallDeriverWindows.ts --uninstall  # remove
 *   bun ~/.claude/LIFEOS/PULSE/InstallDeriverWindows.ts --status     # check
 *
 * Same job as com.lifeos.deriver.plist: LearningPatternSynthesis.ts
 * --hypothesize daily at 03:00, logging to MEMORY/OBSERVABILITY/deriver.log,
 * registered as a current-user Task Scheduler task through
 * TOOLS/lib/SchtasksUser.ts (no admin rights; a run missed while the machine
 * slept fires once on wake). manage-deriver.sh stays the macOS path; this file
 * refuses to run anywhere but Windows.
 */

import { dirname, join } from "node:path";
import { installVerb } from "../TOOLS/lib/InstallVerb";
import * as schtasks from "../TOOLS/lib/SchtasksUser";

const LABEL = "com.lifeos.deriver";

if (!schtasks.isWindows()) {
  console.error("InstallDeriverWindows.ts: Windows only — use PULSE/manage-deriver.sh on macOS.");
  process.exit(2);
}

const verb = installVerb(process.argv, "InstallDeriverWindows");
const lifeos = schtasks.lifeosRoot();
const bun = schtasks.whichSync("bun") || process.execPath;
const spec: schtasks.UnitSpec = {
  label: LABEL,
  description: "LifeOS deriver — nightly LearningPatternSynthesis --hypothesize (Pulse /hypotheses)",
  exec: [bun, "run", join(lifeos, "TOOLS", "LearningPatternSynthesis.ts"), "--hypothesize"],
  logPath: join(lifeos, "MEMORY", "OBSERVABILITY", "deriver.log"),
  workingDirectory: dirname(lifeos),
  environment: schtasks.installEnv(),
  schedule: { kind: "calendar", hour: 3, minute: 0 },
};
const log = (m: string) => console.log(`[InstallDeriverWindows] ${m}`);

if (verb === "--status") process.exit(schtasks.statusSync(spec, log) ? 0 : 1);
if (verb === "--uninstall") { schtasks.uninstallSync(spec, log); process.exit(0); }
if (!schtasks.installSync(spec, log)) process.exit(1);
console.log(`LifeOS deriver installed (bun: ${bun}, schedule: daily 03:00)`);
