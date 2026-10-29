/**
 * @version 1.6.3
 * Centralized Path Resolution — canonical home is LIFEOS/TOOLS.
 *
 * Moved here from hooks/lib/paths.ts on 2026-09-03 (hooks/lib/paths.ts now
 * re-exports this file). LIFEOS/TOOLS lands at install step 4.5 (DeployCore)
 * while hooks/lib lands at step 7 (InstallHooks), so any TOOLS file that
 * imported the resolver from hooks/lib broke a fresh install between those
 * steps — GenerateKnowledgeSchemaDoc.ts did exactly that after the config-root
 * fix. TOOLS never depends on the hooks tree; hooks may depend on TOOLS.
 * Surfaced by the config-root class reports (public issues #1974 @sabo961,
 * #1968 @bytebyrobert, #1955 @pybe).
 *
 * Two root directories:
 * - LIFEOS_DIR (~/.claude/LIFEOS) — LifeOS data: MEMORY, Algorithm, Tools, USER
 * - Claude home (~/.claude) — Claude Code: settings, skills, hooks, commands, agents
 *
 * Usage:
 *   import { getLifeosDir, getClaudeDir, lifeosPath } from "../../LIFEOS/TOOLS/Paths";  // or "./Paths" inside LIFEOS/TOOLS
 */

import { existsSync, mkdtempSync, realpathSync } from 'fs';
import { homedir, tmpdir, userInfo } from 'os';
import { dirname, isAbsolute, join, relative, sep } from 'path';

/** expandPath against an explicit home directory, for callers that must not read the process's own. */
export function expandPathFrom(path: string, home: string): string {
  return path
    .replace(/^\$HOME(?=\/|$)/, () => home)
    .replace(/^\$\{HOME\}(?=\/|$)/, () => home)
    .replace(/^~(?=\/|$)/, () => home);
}

/**
 * Expand shell variables in a path string
 * Supports: $HOME, ${HOME}, ~
 */
export function expandPath(path: string): string {
  const home = homedir();

  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

/**
 * Get the LifeOS data directory (expanded).
 *
 * Priority:
 *   1. CLAUDE_PLUGIN_ROOT (plugin install) → <root>/LIFEOS
 *   2. LIFEOS_DIR env var (expanded)
 *   3. ~/.claude/LIFEOS  (live default — byte-identical to pre-plugin behavior)
 *
 * The CLAUDE_PLUGIN_ROOT guard MUST precede the LIFEOS_DIR check: in a packed
 * plugin, the launcher exports LIFEOS_DIR equal to CLAUDE_PLUGIN_ROOT (the flattened
 * claude-home root), so trusting LIFEOS_DIR first would drop the trailing /LIFEOS
 * segment and mis-resolve lifeosPath() to ROOT/MEMORY instead of ROOT/LIFEOS/MEMORY.
 * Resolving via getClaudeDir() + 'LifeOS' keeps the live ~/.claude/LIFEOS →
 * plugin ${ROOT}/LIFEOS mapping that the packer's ~/.claude/ → ${LIFEOS_DIR} rewrite assumes.
 */
export function getLifeosDir(): string {
  return lifeosDirFor(process.env, homedir());
}

/** getLifeosDir against an explicit environment and home, for callers (and tests) that must not read process.env. */
export function lifeosDirFor(env: Record<string, string | undefined>, home: string): string {
  if (env.CLAUDE_PLUGIN_ROOT) {
    return join(claudeDirFor(env, home), 'LIFEOS');
  }

  // CLAUDE_CONFIG_DIR outranks LIFEOS_DIR deliberately. Isolating the config
  // root is the explicit act of separating profiles; LIFEOS_DIR's job is
  // relocating LIFEOS *within* an install. With the old order, a shell that
  // exports LIFEOS_DIR (the default dev setup does) sent every isolated
  // install's writes back into the home profile — the same cross-profile leak
  // as discussion #1900 finding 2, wearing a different env var. Caught by
  // probe, not by report: the first fix here still wrote to ~/.claude.
  const envLifeosDir = env.LIFEOS_DIR;

  // LIFEOS_SKILLS_DIR is the same kind of isolation signal as CLAUDE_CONFIG_DIR
  // (install.sh's only root marker), so it gets the same precedence over
  // LIFEOS_DIR — otherwise a dev shell exporting LIFEOS_DIR would split one
  // install across two profiles (public issue #1968, @bytebyrobert).
  if (envLifeosDir && !env.CLAUDE_CONFIG_DIR && !env.LIFEOS_SKILLS_DIR) {
    return expandPathFrom(envLifeosDir, home);
  }

  // Derive from claudeDirFor(env, home) rather than re-deriving homedir here, so
  // CLAUDE_CONFIG_DIR is honored in exactly one place (public issue #1665).
  return join(claudeDirFor(env, home), 'LIFEOS');
}

/**
 * Get the Claude Code home directory.
 *
 * Plugin install: CLAUDE_PLUGIN_ROOT is the flattened plugin root that plays the
 * live ~/.claude role (skills/ and hooks/ sit directly under it, matching live
 * .claude/skills and .claude/hooks). Live default: ~/.claude — byte-identical to
 * pre-plugin behavior, since CLAUDE_PLUGIN_ROOT is unset on a normal install.
 */
export function getClaudeDir(): string {
  return claudeDirFor(process.env, homedir());
}

/** The default Claude home under a given home directory, before any override. */
export function defaultClaudeDir(home: string): string {
  return join(home, '.claude');
}

/** getClaudeDir against an explicit environment and home, for callers (and tests) that must not read process.env. */
export function claudeDirFor(env: Record<string, string | undefined>, home: string): string {
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT;

  if (pluginRoot) {
    return expandPathFrom(pluginRoot, home);
  }

  // Isolated/project-scoped installs set CLAUDE_CONFIG_DIR. Install-time tooling
  // honored it; this resolver did not, so every hook that routes through here
  // wrote into ~/.claude regardless — the seam both #1665 and #1584 need, and
  // the reason a scratch profile could touch the default one
  // (public issues #1665 @rogdex24, #1584 @ramazanpolat, #1896 @maer).
  const configDir = env.CLAUDE_CONFIG_DIR;

  if (configDir) {
    return expandPathFrom(configDir, home);
  }

  // install.sh derives the config root as dirname(LIFEOS_SKILLS_DIR) and never
  // exports CLAUDE_CONFIG_DIR, so an install placed via LIFEOS_SKILLS_DIR alone
  // had every runtime path (and Doctor) resolving back to ~/.claude
  // (public issue #1968, @bytebyrobert). Below CLAUDE_CONFIG_DIR by design.
  const skillsDir = env.LIFEOS_SKILLS_DIR;

  if (skillsDir) {
    return dirname(expandPathFrom(skillsDir, home));
  }

  return defaultClaudeDir(home);
}

/**
 * Get the settings.json path (lives in Claude home)
 */
export function getSettingsPath(): string {
  return join(getClaudeDir(), 'settings.json');
}

/**
 * Get the authoritative .env path (~/.claude/.env).
 * All credentials live here; LIFEOS/.env is deprecated.
 */
export function getEnvPath(): string {
  return join(getClaudeDir(), '.env');
}

/**
 * Get a path relative to LIFEOS_DIR
 */
export function lifeosPath(...segments: string[]): string {
  const rel = join(...segments);
  if (rel === OBSERVABILITY_REL || rel.startsWith(OBSERVABILITY_REL + sep)) {
    const testDir = testObservabilityDir();
    if (testDir) return join(testDir, rel.slice(OBSERVABILITY_REL.length));
  }
  return join(getLifeosDir(), ...segments);
}

const OBSERVABILITY_REL = join('MEMORY', 'OBSERVABILITY');

/**
 * Under `bun test`, an OBSERVABILITY path that resolves into the live install goes to one temp dir
 * for the whole test run instead (2026-10-09: judge.test.ts wrote rows into the live assay.jsonl and
 * eval-judge read as 100% errors). A test that isolated its root keeps that root. The dir is shared
 * through LIFEOS_TEST_OBSERVABILITY_DIR so hooks a test spawns write beside it. Same rule as OutputLedger.
 */
function testObservabilityDir(): string | null {
  if (process.env.NODE_ENV !== 'test') return null;
  if (realOr(getLifeosDir()) !== realOr(join(userInfo().homedir, '.claude', 'LIFEOS'))) return null;
  return process.env.LIFEOS_TEST_OBSERVABILITY_DIR ??= mkdtempSync(join(tmpdir(), 'lifeos-obs-test-'));
}

function realOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * The Assay skill's USER folder under a LIFEOS root. The skill was named Evals until
 * 2026-09-28 and the install overlay never moves USER data, so a USER tree that
 * predates the rename keeps working from its old folder until the principal moves it.
 */
export function assayUserDir(lifeosDir: string = getLifeosDir()): string {
  const skills = join(lifeosDir, 'USER', 'CUSTOMIZATIONS', 'SKILLS');
  const current = join(skills, 'Assay');
  const legacy = join(skills, 'Evals');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/**
 * Get the hooks directory (lives in Claude home)
 */
export function getHooksDir(): string {
  return join(getClaudeDir(), 'hooks');
}

/**
 * Get the skills directory (lives in Claude home)
 */
export function getSkillsDir(): string {
  return join(getClaudeDir(), 'skills');
}

/**
 * Get the MEMORY directory
 */
export function getMemoryDir(): string {
  return lifeosPath('MEMORY');
}

/**
 * Whether this filesystem has POSIX mode bits. NTFS does not: stat reports 0666 (0444 when
 * read-only) whatever chmod set, so owner-only checks can never pass on Windows. Every such
 * check goes through this one flag, so a new one is easy to find and keep Windows-safe.
 */
export const HAS_POSIX_MODES = process.platform !== 'win32';

/**
 * Ledger key for a path under the Claude home: root-relative with forward slashes, the shape the
 * Cortex fold and `CortexLedger verify` compare against. path.relative copes with mixed separators
 * and drive-letter case; a plain prefix strip left absolute Windows paths in ledger rows.
 * Paths outside the root stay as given.
 */
export function claudeRel(abs: string, root: string = getClaudeDir()): string {
  if (!isAbsolute(abs)) return abs; // already a key; relative() would resolve it against the cwd
  const rel = relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return abs;
  return rel.split(sep).join('/');
}
