#!/usr/bin/env bun
/**
 * @version 1.2.2
 * CheckpointPerISC.hook.ts — auto git commit on every ISC `[ ]`->`[x]` transition
 *
 * TRIGGER: PostToolUse (Write, Edit) on ISA.md (or legacy PRD.md) under
 * MEMORY/WORK/<slug>/.
 *
 * For each newly-checked ISC, iterates through the allowlist of opted-in repos
 * (~/.claude/checkpoint-repos.txt per spec) and creates one git commit per
 * repo that has uncommitted changes. Commit subject:
 *   "<ISC-id> (<slug>): <sanitized description>"
 *
 * Idempotent via sidecar state file: MEMORY/WORK/<slug>/.checkpoint-state.json.
 * Allowlist is empty by default; repos must be opted in explicitly by the principal.
 *
 * Fails closed: any error path logs to stderr and emits `{continue:true}` with
 * exit 0 — never crashes the session, never commits without an allowlist,
 * never executes any destructive git op (no working-tree reset/revert/checkout/
 * branch -D/clean -fd/push --force; the one reset is index-only, for paths it
 * just committed that nobody had staged).
 */

import { readFileSync, existsSync, writeFileSync, statSync, realpathSync, mkdirSync, renameSync, lstatSync, readlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parseFrontmatter, parseCriteriaList, ARTIFACT_FILENAME, LEGACY_ARTIFACT_FILENAME } from './lib/isa-utils';
import { isForeignToSystemRepo, looksLikePersonalTranscript } from '../LIFEOS/TOOLS/lib/ForeignDataCheck';
import { GUARDED } from '../LIFEOS/TOOLS/LayerOneCount';
import { invariant, InvariantViolation } from '../LIFEOS/TOOLS/Invariant';
import { getClaudeDir, lifeosPath } from './lib/paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord

// Allowlist path: top of ~/.claude per spec. One absolute repo path per line;
// '#' comments and blank
// lines are ignored. Tilde and $HOME prefixes are expanded as a quality-of-
// life feature so users can write `~/Projects/foo` instead of the long form.
const ALLOWLIST_PATH = join(getClaudeDir(), 'checkpoint-repos.txt');
const GIT_TIMEOUT_MS = 5000;

interface CheckpointState {
  committed_iscs: string[];
  last_commit_sha: Record<string, string>;
}

function expandPath(p: string): string {
  let s = p.trim();
  if (!s) return s;
  if (s.startsWith('~/')) s = join(homedir(), s.slice(2));
  else if (s === '~') s = homedir();
  // Function replacer: a home path holding `$&` or `$1` must not be read as a replacement pattern.
  s = s.replace(/^\$HOME(\/|$)/, (_m, sep: string) => homedir() + sep);
  return s;
}

function loadAllowlist(): string[] {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  try {
    return readFileSync(ALLOWLIST_PATH, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#'))
      .map(expandPath);
  } catch (err) {
    console.error('[CheckpointPerISC] failed to read allowlist:', err);
    return [];
  }
}

function loadState(stateFile: string): CheckpointState {
  if (!existsSync(stateFile)) return { committed_iscs: [], last_commit_sha: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
    return {
      committed_iscs: Array.isArray(parsed.committed_iscs) ? parsed.committed_iscs : [],
      last_commit_sha: parsed.last_commit_sha && typeof parsed.last_commit_sha === 'object' ? parsed.last_commit_sha : {},
    };
  } catch (err) {
    console.error('[CheckpointPerISC] malformed state file, resetting:', err);
    return { committed_iscs: [], last_commit_sha: {} };
  }
}

/**
 * Write the sidecar through a temp file and rename (2026-10-13 audit, finding 9). A
 * plain writeFileSync follows a symlink planted at the sidecar path and writes
 * wherever it points; rename replaces the link itself. The directory is checked
 * by realpath against the allowed root first, never by lexical prefix.
 */
export function saveState(stateFile: string, state: CheckpointState, allowedRoot: string): void {
  try {
    const realDir = realpathSync(dirname(stateFile));
    const realRoot = realpathSync(allowedRoot);
    invariant(realDir === realRoot || realDir.startsWith(realRoot + '/'), `checkpoint state dir ${realDir} is outside ${realRoot}`);
    const target = join(realDir, basename(stateFile));
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    if (err instanceof InvariantViolation) throw err; // impossible state: fail loud, never swallow
    console.error('[CheckpointPerISC] failed to write state:', err);
  }
}

function gitRun(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { windowsHide: true,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isGitRepo(repo: string): boolean {
  try {
    gitRun(repo, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

function sanitizeMessage(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[`$]/g, '').trim().slice(0, 200);
}

/** Pathspecs per git call; keeps the argv far below the OS limit. */
const PATHSPEC_CHUNK = 500;

/**
 * Dirty paths in `repo`, repo-relative, among `candidates` only. Handles rename entries
 * ("R  old -> new") and git's quoted form for paths with unusual bytes.
 *
 * Speed (2026-10-09): the old form ran a whole-tree `git status` twice per repo per ISC. On
 * the USER data repo (22k tracked files, large untracked trees) each run cost 0.8-1.3s, so an
 * Edit that closed an ISC took 2s+ and sometimes tens of seconds under load. The only paths a
 * checkpoint can ever stage are the ISA, its sidecar and what this session wrote, so git is
 * asked about exactly those (literal pathspecs); the staged set is unchanged.
 */
function dirtyPaths(repo: string, candidates: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < candidates.length; i += PATHSPEC_CHUNK) {
    paths.push(...dirtyPathsChunk(repo, candidates.slice(i, i + PATHSPEC_CHUNK)));
  }
  return [...new Set(paths)];
}

function dirtyPathsChunk(repo: string, candidates: string[]): string[] {
  let out: string;
  // -uall lists untracked files INDIVIDUALLY instead of collapsing a fully-
  // untracked directory to one `dir/` entry. Without it, staging that single
  // collapsed entry would `git add` the whole subtree — carrying any foreign
  // file inside it straight past the per-file boundary filter below.
  try { out = gitRun(repo, ['--literal-pathspecs', 'status', '--porcelain', '-z', '-uall', '--', ...candidates]); } catch { return []; }
  const entries = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    paths.push(e.slice(3));
    // A rename entry is followed by its source path as the next NUL-delimited field.
    if (code.includes('R') || code.includes('C')) { if (entries[i + 1]) paths.push(entries[i + 1]); i++; }
  }
  return paths;
}

/**
 * Paths this RUN touched: dirty AND modified at or after the run started.
 *
 * `git add -A` cannot be used here. ~/.claude runs concurrent sessions, so a whole-tree
 * stage silently adopts another session's in-flight work and buries it under an unrelated
 * subject — which also destroys the provenance the Algorithm depends on, since
 * `git log -- <path>` is the authoritative change record. Residual: a file another session
 * dirties mid-run still has a fresh mtime and can be swept; this closes the common case,
 * not every case.
 */
function runTouchedPaths(repo: string, startedMs: number, candidates: string[]): string[] {
  return dirtyPaths(repo, candidates).filter((rel) => {
    try { return statSync(join(repo, rel)).mtimeMs >= startedMs; }
    catch { return true; } // deleted in-run — the deletion is ours to record
  });
}

const SYSTEM_REPO = getClaudeDir();

function isSystemRepo(repo: string): boolean {
  try { return realpathSync(repo) === realpathSync(SYSTEM_REPO); }
  catch { return false; }
}

/**
 * Foreign-data boundary (2026-08-11 lifelog incident): a concurrent session's
 * relative-write bug put personal transcripts at LIFEOS/Users/<name>/... inside
 * ~/.claude, and THIS hook's checkpoint commit is what git-tracked them. In the
 * system repo, a path that is foreign by shape (absolute-fs mirror, personal
 * filename signature) or by content (transcript structure) is NEVER staged —
 * skipped loudly on stderr, present in the next `git status` for a human.
 * A foreign path's DELETION is also skipped (the filter is lexical, it cannot
 * tell add from delete) — safe direction: the deletion stays pending for a
 * human commit rather than being buried under a checkpoint subject.
 * Shared detector: LIFEOS/TOOLS/lib/ForeignDataCheck.ts.
 */
export function filterForeignPaths(repo: string, paths: string[]): string[] {
  if (!isSystemRepo(repo)) return paths; // USER_DATA repo legitimately holds personal data
  return paths.filter((rel) => {
    const fc = isForeignToSystemRepo(rel);
    if (fc.foreign) {
      console.error(`[CheckpointPerISC] BOUNDARY: refusing to stage foreign path ${rel} — ${fc.reason}`);
      return false;
    }
    // Every candidate is inspected by content, whatever its extension (2026-10-13 audit,
    // finding 7): a transcript saved as notes.md or log.txt is the same personal data.
    if (looksLikePersonalTranscript(join(repo, rel))) {
      console.error(`[CheckpointPerISC] BOUNDARY: refusing to stage ${rel} — personal transcript content signature (transcript[] with speaker + spoken_at/text)`);
      return false;
    }
    return true;
  });
}

/**
 * Layer-one surfaces never ride a checkpoint (2026-09-18). This hook commits with
 * --no-verify, so the commit-msg guard that holds layer-one rule counts monotone never
 * sees its commits: checkpoint 1a50af6b3 carried an unverified PreToolGuard change, deleted
 * lines included, under an unrelated criterion subject. In the system repo the four guarded
 * files are left dirty for a human-authored commit that runs the guard.
 */
export function filterGuardedPaths(repo: string, paths: string[]): string[] {
  if (!isSystemRepo(repo)) return paths;
  const guarded = new Set<string>(GUARDED);
  return paths.filter((rel) => {
    if (!guarded.has(rel)) return true;
    console.error(`[CheckpointPerISC] GUARDED: leaving ${rel} for a commit that runs the layer-one guard`);
    return false;
  });
}

/**
 * Paths THIS SESSION wrote, read from its own transcript (Write/Edit/NotebookEdit
 * tool_use blocks). The mtime heuristic in runTouchedPaths cannot tell two
 * concurrent sessions apart — on 2026-08-31 eight retrofit agents in one tree
 * had their ISAs and unrelated dirty files swept under each other's criterion
 * subjects. The transcript is the exact record of what this session authored;
 * intersecting with it closes the sweep. Bash-driven file edits are invisible
 * here by design (they are banned as an edit lane). Returns null when the
 * transcript is unreadable so the caller can fail SAFE (ISA-only), never open.
 */
export function sessionTouchedPaths(transcriptPath: string | undefined): Set<string> | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const out = new Set<string>();
  try {
    for (const line of readFileSync(transcriptPath, 'utf-8').split('\n')) {
      if (!line.includes('"file_path"')) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const blocks = entry?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue;
        if (!['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(b.name)) continue;
        const fp = b.input?.file_path ?? b.input?.notebook_path;
        if (typeof fp === 'string') {
          try { out.add(realpathSync(fp)); } catch { out.add(fp); }
        }
      }
    }
  } catch { return null; }
  return out;
}

/** Repo-relative form of every path a checkpoint in `repo` could stage: the ISA, its sidecar, and this session's writes. */
export function candidatePaths(repo: string, isaPath: string, sidecar: string, mine: Set<string> | null): string[] {
  let realRepo = repo;
  try { realRepo = realpathSync(repo); } catch { /* keep the given form */ }
  const out = new Set<string>();
  for (const p of [isaPath, sidecar, ...(mine ?? [])]) {
    for (const base of new Set([realRepo, repo])) {
      const rel = relative(base, p);
      if (rel && rel !== '..' && !rel.startsWith('..' + '/') && !isAbsolute(rel)) { out.add(rel); break; }
    }
  }
  return [...out];
}

function gitIn(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', repo, ...args], { windowsHide: true,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

/**
 * Commit exactly the bytes that were inspected (2026-10-13 audit, finding 8). Each path is
 * read once into a private snapshot, the snapshot is what the transcript check reads, and
 * the snapshot's blob is what lands, through a private index (GIT_INDEX_FILE), so a file
 * rewritten between the check and the commit cannot swap uninspected content in. HEAD moves
 * by compare-and-swap; the shared index is then reset only for the committed paths whose
 * entry still matched the old HEAD, so anything staged for a path, by a peer or by hand,
 * stays as it was. No hooks run and nothing is signed, as before.
 */
/** `mode sha` per path at stage 0 of the shared index (`conflict` for an unmerged path); `-z` reads any name exactly. */
function indexEntries(repo: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rec of gitRun(repo, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths]).split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    const rel = rec.slice(tab + 1);
    out.set(rel, stage === '0' && !out.has(rel) ? `${mode} ${sha}` : 'conflict');
  }
  return out;
}

/** `mode sha` per path in a commit's tree; empty when there is no commit yet. */
function treeEntries(repo: string, commit: string | null, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!commit) return out;
  for (const rec of gitRun(repo, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', ...paths]).split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , sha] = rec.slice(0, tab).split(' ');
    out.set(rec.slice(tab + 1), `${mode} ${sha}`);
  }
  return out;
}

export function commitSnapshot(repo: string, subject: string, paths: string[]): string | null {
  let head: string | null = null;
  try { head = gitRun(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim() || null; } catch { head = null; }
  const snapDir = mkdtempSync(join(tmpdir(), 'ckpt-snap-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(snapDir, 'index') };
  try {
    gitIn(repo, head ? ['read-tree', head] : ['read-tree', '--empty'], env);
    const committed: string[] = [];
    for (const rel of paths) {
      const abs = join(repo, rel);
      let st;
      try { st = lstatSync(abs); } catch {
        gitIn(repo, ['update-index', '--force-remove', '--', rel], env); // deleted by this session
        committed.push(rel);
        continue;
      }
      let bytes: Buffer;
      let mode: string;
      if (st.isSymbolicLink()) { bytes = Buffer.from(readlinkSync(abs)); mode = '120000'; }
      else if (st.isFile()) { bytes = readFileSync(abs); mode = st.mode & 0o111 ? '100755' : '100644'; }
      else { console.error(`[CheckpointPerISC] skipping ${rel}: not a file or symlink`); continue; }
      const snap = join(snapDir, 'blob');
      writeFileSync(snap, bytes);
      if (isSystemRepo(repo) && st.isFile() && looksLikePersonalTranscript(snap)) {
        console.error(`[CheckpointPerISC] BOUNDARY: refusing to stage ${rel} — personal transcript content signature in the committed bytes`);
        continue;
      }
      const sha = gitIn(repo, ['hash-object', '-w', '--no-filters', '--', snap], env).trim();
      invariant(/^[0-9a-f]{40,64}$/.test(sha), `git hash-object returned no object id for ${rel}`);
      gitIn(repo, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`], env);
      committed.push(rel);
    }
    if (committed.length === 0) return null;
    const tree = gitIn(repo, ['write-tree'], env).trim();
    if (head && tree === gitRun(repo, ['rev-parse', `${head}^{tree}`]).trim()) return null; // nothing changed
    const commit = gitIn(repo, ['commit-tree', tree, ...(head ? ['-p', head] : []), '--no-gpg-sign', '-m', subject], process.env).trim();
    invariant(/^[0-9a-f]{40,64}$/.test(commit), 'git commit-tree returned no commit id');
    // A path whose shared-index entry differs from the old HEAD was staged by someone; its entry is left alone.
    const staged = indexEntries(repo, committed);
    const before = treeEntries(repo, head, committed);
    const unstaged = committed.filter((rel) => (staged.get(rel) ?? null) === (before.get(rel) ?? null));
    // Compare-and-swap: a peer commit landing in between fails this, and nothing is overwritten.
    gitRun(repo, ['update-ref', '-m', `checkpoint: ${subject}`, 'HEAD', commit, ...(head ? [head] : [])]);
    if (unstaged.length) gitRun(repo, ['--literal-pathspecs', 'reset', '-q', commit, '--', ...unstaged]);
    return commit;
  } finally {
    rmSync(snapDir, { recursive: true, force: true });
  }
}

export function commitInRepo(repo: string, iscId: string, slug: string, description: string, startedMs: number, isaPath: string, mine: Set<string> | null): string | null {
  try {
    const sidecar = join(dirname(isaPath), '.checkpoint-state.json');
    const touched = runTouchedPaths(repo, startedMs, candidatePaths(repo, isaPath, sidecar, mine));
    const isMine = (rel: string): boolean => {
      const abs = join(repo, rel);
      let real = abs;
      try { real = realpathSync(abs); } catch { /* deleted — keep the join form */ }
      if (real === isaPath || abs === isaPath || real === sidecar || abs === sidecar) return true;
      if (mine === null) return false; // no transcript → ISA + sidecar only, never the tree
      return mine.has(real) || mine.has(abs);
    };
    const skipped = touched.filter((rel) => !isMine(rel));
    if (skipped.length) console.error(`[CheckpointPerISC] leaving ${skipped.length} path(s) another session touched: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`);
    const paths = filterGuardedPaths(repo, filterForeignPaths(repo, touched.filter(isMine)));
    if (paths.length === 0) return null;
    // iscId already has the canonical "ISC-<N>" form (or "ISC-<N>-A-<M>" for
    // anti-criteria) per parseCriteriaList — use it verbatim, do not re-prefix.
    const subject = `${iscId} (${slug}): ${sanitizeMessage(description)}`;
    return commitSnapshot(repo, subject, paths);
  } catch (err: unknown) {
    const e = err as { stderr?: { toString?: () => string }; message?: string };
    const detail = e?.stderr?.toString?.() || e?.message || String(err);
    console.error(`[CheckpointPerISC] commit failed in ${repo} for ${iscId}: ${detail}`);
    return null;
  }
}

// Guarded so filterForeignPaths can be imported by a test without the module
// consuming stdin and exiting the test process. Hook execution (`bun
// CheckpointPerISC.hook.ts` with the harness's JSON on stdin) is unchanged.
/** Commit newly-closed ISCs in opted-in repos. Never emits model context. */
export async function run(input: any): Promise<null> {
  try { await main(input); } catch (err) { console.error('[CheckpointPerISC] uncaught error:', err); }
  return null;
}

async function main(input: any) {
  const filePath: string = input?.tool_input?.file_path || '';
  // Both sanctioned ISA homes, not just MEMORY/WORK — project ISAs
  // (<project>/ISA.md) checkpoint too; the repo allowlist below still gates
  // which trees ever get a commit (public issue #1807, @mhaisham).
  // Basename equality, so fooISA.md is not an ISA.
  const isISA = basename(filePath) === ARTIFACT_FILENAME;
  const isLegacyPRD = basename(filePath) === LEGACY_ARTIFACT_FILENAME;
  if (!isISA && !isLegacyPRD) return;
  if (!existsSync(filePath)) return;

  const slugDir = dirname(filePath);
  const slug = basename(slugDir);
  // Skill-homed ISAs (skills/<Name>/ISA.md) keep their sidecar OUT of the skill
  // dir — skill trees must stay publishable-clean and the sidecar carries
  // absolute paths + SHAs, which trips SkillHygieneGate (found 2026-08-11,
  // interview-evidence upgrade). Everything else keeps the beside-the-ISA path.
  // Checkpoint state files for anything NOT under MEMORY/WORK go to MEMORY/STATE/checkpoints/
  // Realpath on both sides: a lexical prefix would let a symlinked slug dir under
  // MEMORY/WORK steer the sidecar write out of the tree (2026-10-13 audit, finding 9).
  const workDir = lifeosPath('MEMORY', 'WORK');
  let realSlugDir = slugDir;
  let realWorkDir = workDir;
  try { realSlugDir = realpathSync(slugDir); } catch { /* existence checked above; keep lexical */ }
  try { realWorkDir = realpathSync(workDir); } catch { /* no WORK dir: nothing is inside it */ }
  const isInWorkDir = realSlugDir.startsWith(realWorkDir + '/');
  const stateDir = lifeosPath('MEMORY', 'STATE', 'checkpoints');
  if (!isInWorkDir) mkdirSync(stateDir, { recursive: true });
  const stateFile = isInWorkDir
    ? join(realSlugDir, '.checkpoint-state.json')
    : join(stateDir, `${slug}.checkpoint-state.json`);

  const content = readFileSync(filePath, 'utf-8');
  const fm = parseFrontmatter(content);
  if (!fm) return;
  const criteria = parseCriteriaList(content);
  if (criteria.length === 0) return;

  // Only files touched at or after the run started get staged (see runTouchedPaths).
  // No parseable `started` means no way to tell this run's work from another session's,
  // so checkpointing stands down rather than guessing — silence beats a bad commit.
  const startedMs = Date.parse(String((fm as Record<string, unknown>).started ?? ''));
  if (!Number.isFinite(startedMs)) {
    console.error(`[CheckpointPerISC] ${slug}: no parseable 'started' in frontmatter — skipping (will not stage a whole tree)`);
    return;
  }

  const state = loadState(stateFile);
  const alreadyCommitted = new Set(state.committed_iscs);
  const newlyChecked = criteria.filter(c => c.status === 'completed' && !alreadyCommitted.has(c.id));
  if (newlyChecked.length === 0) return;

  const allowlist = loadAllowlist();
  if (allowlist.length === 0) {
    console.error('[CheckpointPerISC] no repos configured, skipping');
    return;
  }

  // One transcript read per run, not one per criterion per repo.
  let mine: Set<string> | null | undefined;
  const sessionPaths = (): Set<string> | null => (mine === undefined ? (mine = sessionTouchedPaths(input?.transcript_path)) : mine);

  for (const isc of newlyChecked) {
    for (const repo of allowlist) {
      if (!existsSync(repo)) {
        console.error(`[CheckpointPerISC] repo not found: ${repo}`);
        continue;
      }
      if (!isGitRepo(repo)) {
        console.error(`[CheckpointPerISC] not a git repo: ${repo}`);
        continue;
      }
      const sha = commitInRepo(repo, isc.id, slug, isc.description, startedMs, realpathSync(filePath), sessionPaths());
      if (sha) state.last_commit_sha[repo] = sha;
    }
    state.committed_iscs.push(isc.id);
  }

  saveState(stateFile, state, isInWorkDir ? realWorkDir : stateDir);
}

if (import.meta.main) {
  let input: any = null;
  try { input = JSON.parse(readFileSync(0, 'utf-8')); } catch { process.exit(0); }
  await run(input);
  process.exit(0);
}
