/**
 * SystemIntegrity.ts - Automatic system integrity maintenance handler
 *
 * Detects LifeOS system changes from the transcript and spawns background
 * IntegrityMaintenance.ts to update references and document changes.
 *
 * TRIGGER: SessionEnd hook (via IntegrityCheck.hook.ts)
 *
 * SIDE EFFECTS:
 * - Spawns background IntegrityMaintenance.ts process
 * - Updates MEMORY/STATE/integrity-state.json
 *
 * THROTTLING:
 * - 5-minute cooldown between runs
 * - Deduplicates identical change sets
 */

import { writeFileSync, mkdirSync, existsSync, openSync, closeSync, statSync, renameSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { lifeosPath } from '../lib/paths';

import {
  parseToolUseBlocks,
  isSignificantChange,
  isInCooldown,
  isDuplicateRun,
  hashChanges,
  getCooldownEndTime,
  determineSignificance,
  inferChangeType,
  generateDescriptiveTitle,
  type FileChange,
} from '../lib/change-detection';
import type { ParsedTranscript } from '../../LIFEOS/TOOLS/TranscriptParser';

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
}

const STATE_DIR = lifeosPath('MEMORY', 'STATE');
const STATE_FILE = join(STATE_DIR, 'integrity-state.json');
const INTEGRITY_SCRIPT = lifeosPath("TOOLS", 'IntegrityMaintenance.ts');
const INTEGRITY_LOG_DIR = lifeosPath('MEMORY', 'OBSERVABILITY');
export const INTEGRITY_LOG = join(INTEGRITY_LOG_DIR, 'integrity-maintenance.log');
/** Where the change list waits for the child. A stdin pipe lost it every time: the hook calls process.exit(0)
 *  straight after spawning, before the pipe write flushes, so all 15 logged runs read "No input received" (2026-10-10). */
export const INTEGRITY_INPUT_DIR = join(STATE_DIR, 'integrity-inputs');

/** Write the child's input to its own file and return the path; the child deletes it after reading. */
export function writeIntegrityInput(data: string, sessionId: string, dir: string = INTEGRITY_INPUT_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_') || 'session'}-${process.pid}-${Date.now()}.json`);
  writeFileSync(path, data);
  return path;
}
/** Past this size the log rolls to `.1` (one prior generation kept). ObservabilityPrune
 *  only trims timestamped .jsonl rows, so this plain-text log bounds itself. */
export const INTEGRITY_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Open the child's append-only log fd, rolling it first when it outgrows
 * INTEGRITY_LOG_MAX_BYTES. Returns null when the log cannot be opened; the
 * caller then discards the child's output rather than skip the maintenance run.
 */
export function openIntegrityLog(logPath: string = INTEGRITY_LOG): number | null {
  try {
    mkdirSync(join(logPath, '..'), { recursive: true });
    if (existsSync(logPath) && statSync(logPath).size > INTEGRITY_LOG_MAX_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
    return openSync(logPath, 'a');
  } catch (error) {
    console.error('[SystemIntegrity] Integrity log unavailable, child output discarded:', error);
    return null;
  }
}


/**
 * Update the integrity state file.
 */
function updateIntegrityState(changes: FileChange[]): void {
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }

    const state = {
      last_run: new Date().toISOString(),
      last_changes_hash: hashChanges(changes),
      cooldown_until: getCooldownEndTime(),
    };

    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.error('[SystemIntegrity] Updated state file');
  } catch (error) {
    console.error('[SystemIntegrity] Failed to update state:', error);
  }
}

/**
 * Spawn the IntegrityMaintenance script in the background.
 */
function spawnIntegrityMaintenance(
  changes: FileChange[],
  hookInput: HookInput
): void {
  try {
    // Check if script exists
    if (!existsSync(INTEGRITY_SCRIPT)) {
      console.error('[SystemIntegrity] IntegrityMaintenance.ts not found:', INTEGRITY_SCRIPT);
      return;
    }

    // Pre-compute title and metadata for logging
    const filteredChanges = changes.filter(c => c.category !== null);
    const title = generateDescriptiveTitle(filteredChanges);
    const significance = determineSignificance(filteredChanges);
    const changeType = inferChangeType(filteredChanges);

    console.error(`[SystemIntegrity] Title: ${title}`);
    console.error(`[SystemIntegrity] Significance: ${significance}`);
    console.error(`[SystemIntegrity] Change type: ${changeType}`);

    // Prepare input data
    const inputData = JSON.stringify({
      session_id: hookInput.session_id,
      transcript_path: hookInput.transcript_path,
      changes: filteredChanges.map(c => ({
        tool: c.tool,
        path: c.path,
        category: c.category,
        isPhilosophical: c.isPhilosophical,
        isStructural: c.isStructural,
      })),
    });

    // An inherited stderr pipe held SessionEnd open until the child exited;
    // a log fd lets the hook return at once (public issue #2210, @corobis).
    const inputPath = writeIntegrityInput(inputData, hookInput.session_id ?? '');
    const logFd = openIntegrityLog();
    const child = spawn('bun', [INTEGRITY_SCRIPT, '--input', inputPath], { windowsHide: true,
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      env: { ...process.env },
    });
    if (logFd !== null) closeSync(logFd); // the child holds its own copy

    // Detach from parent
    child.unref();

    console.error(`[SystemIntegrity] Spawned IntegrityMaintenance (pid: ${child.pid})`);
  } catch (error) {
    console.error('[SystemIntegrity] Failed to spawn IntegrityMaintenance:', error);
  }
}

/**
 * Handle system integrity check with pre-parsed transcript data.
 *
 * This handler:
 * 1. Parses the transcript for file modification tool_use blocks
 * 2. Filters for LifeOS system paths (excludes WORK/, LEARNING/)
 * 3. Checks throttle cooldown (max once per 5 min)
 * 4. Spawns background IntegrityMaintenance.ts if changes detected
 */
export async function handleSystemIntegrity(
  parsed: ParsedTranscript,
  hookInput: HookInput
): Promise<void> {
  console.error('[SystemIntegrity] Checking for system changes...');

  // Check cooldown
  if (isInCooldown()) {
    console.error('[SystemIntegrity] In cooldown period, skipping');
    return;
  }

  // Parse changes from transcript
  const changes = parseToolUseBlocks(hookInput.transcript_path);
  console.error(`[SystemIntegrity] Found ${changes.length} file changes in transcript`);

  // Filter to only LifeOS system changes
  const systemChanges = changes.filter(c => c.category !== null);
  console.error(`[SystemIntegrity] ${systemChanges.length} are LifeOS system changes`);

  if (systemChanges.length === 0) {
    console.error('[SystemIntegrity] No system changes detected, skipping');
    return;
  }

  // Check if significant
  if (!isSignificantChange(systemChanges)) {
    console.error('[SystemIntegrity] Changes not significant enough, skipping');
    return;
  }

  // Check for duplicate run
  if (isDuplicateRun(changes)) {
    console.error('[SystemIntegrity] Duplicate change set, skipping');
    return;
  }

  // Log what we found
  console.error('[SystemIntegrity] Significant changes detected:');
  for (const change of systemChanges.slice(0, 5)) {
    console.error(`  - [${change.category}] ${change.path}`);
  }
  if (systemChanges.length > 5) {
    console.error(`  ... and ${systemChanges.length - 5} more`);
  }

  // Update state before spawning
  updateIntegrityState(systemChanges);

  // Voice notification removed — the "documenting" message from IntegrityMaintenance
  // already implies the check happened. No need for a separate "checking" announcement.

  // Spawn background process
  spawnIntegrityMaintenance(systemChanges, hookInput);
  console.error('[SystemIntegrity] Background integrity check started');
}
