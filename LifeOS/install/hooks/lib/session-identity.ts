/**
 * session-identity.ts — the ONE writer for a session's name and tab label.
 *
 * @version 1.2.2
 *
 * A session's identity lives in three places that every surface reads:
 *   - work.json row `sessionName`      — Pulse board, tab color
 *   - MEMORY/STATE/session-names.json  — status line header, ContextSearch, LoadContext
 *   - MEMORY/STATE/session-labels.json — the tab label: the name fitted to the label width (kitty tab, status line)
 *
 * Before 2026-09-11 those were written by four different callers with three
 * different precedences, and the kitty tab and the status line disagreed on
 * most sessions (first-prompt namer painted the tab before storing the name;
 * ISA frontmatter updated work.json and never session-names.json; a label
 * change nested the old label into the description). Every writer now routes
 * through `setSessionName` / `projectSessionIdentity`, which write all three
 * projections in one motion and repaint the tab. Readers never compute a
 * label the writer did not store.
 *
 * A native session's name is not permanent (2026-10-10): PromptProcessing
 * re-checks it against the whole session at most every RECALIBRATION_INTERVAL_MS
 * and renames it through `setSessionName` when the main subject moved. The
 * schedule and the pins live here, in MEMORY/STATE/session-name-recalibration.json:
 * a principal rename (`/rename` adopted by `reconcileHarnessTitle`, or
 * SessionRename.ts) pins the name, and an ISA-bound session is never due.
 *
 * CLI (diagnostics):
 *   bun hooks/lib/session-identity.ts audit     — cross-table of live kitty tabs vs stores; exit 1 on drift
 *   bun hooks/lib/session-identity.ts sync-all  — project every live row's name and repaint its tab
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, statSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { lifeosPath, getClaudeDir } from './paths';
import {
  readTabState, setAscentTab, resolveSessionRow, readCanonicalName, tabTitleActivity,
  shortenNameToLabel, readSessionLabel,
} from './tab-setter';
import { updateSessionNameInWorkJson, clampSessionName } from './isa-utils';
import { ASCENT_STATES, type AscentState } from '../../LIFEOS/TOOLS/ascent';
import { invariant } from '../../LIFEOS/TOOLS/Invariant';

export type SessionNames = Record<string, string>;
export type SessionLabels = Record<string, string>;

const NAMES_PATH = () => lifeosPath('MEMORY', 'STATE', 'session-names.json');
const LABELS_PATH = () => lifeosPath('MEMORY', 'STATE', 'session-labels.json');
const LOCK_TIMEOUT = 3000;
const LOCK_STALE = 10000;

// ── Lock (one lock for both projection files) ────────────────────────────────

function acquireLock(): boolean {
  const lockPath = NAMES_PATH() + '.lock';
  const deadline = Date.now() + LOCK_TIMEOUT;
  while (Date.now() < deadline) {
    try { mkdirSync(lockPath, { recursive: false }); return true; }
    catch {
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE) { try { rmdirSync(lockPath); } catch {} continue; }
      } catch {}
      Bun.sleepSync(50);
    }
  }
  return false;
}
function releaseLock(): void { try { rmdirSync(NAMES_PATH() + '.lock'); } catch {} }

// ── Projection files ─────────────────────────────────────────────────────────
// Plain JSON the status line parses, replacing the shell-sourced
// session-name-cache.sh. GHSA-wv93-rfpp-c2wq, @elhoim

export function readSessionNames(): SessionNames {
  const p = NAMES_PATH();
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    try { if (existsSync(p + '.bak')) return JSON.parse(readFileSync(p + '.bak', 'utf-8')); } catch {}
  }
  return {};
}

export function writeSessionNames(names: SessionNames): void {
  const p = NAMES_PATH();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try { if (existsSync(p)) writeFileSync(p + '.bak', readFileSync(p), 'utf-8'); } catch {}
  const tmp = p + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(names, null, 2), 'utf-8');
  renameSync(tmp, p);
}

export function readSessionLabels(): SessionLabels {
  try {
    const p = LABELS_PATH();
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {}
  return {};
}

function writeSessionLabels(labels: SessionLabels): void {
  const p = LABELS_PATH();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(labels, null, 2), 'utf-8');
  renameSync(tmp, p);
}

/** Labels are a projection of names: a label whose session has no name is an
 *  orphan (crashed session, probe, bench run) and is dropped on every write. */
function pruneOrphanLabels(labels: SessionLabels, names: SessionNames): SessionLabels {
  const out: SessionLabels = {};
  for (const [id, label] of Object.entries(labels)) if (id in names) out[id] = label;
  return out;
}

// ── Label derivation (the one place it happens at write time) ────────────────

/** The label every surface will show for `name`: the name fitted to the label
 *  width, a whole-word prefix so it reads as the name (2026-09-16; width,
 *  not three words, since 2026-10-09). The `authored` argument is accepted for caller
 *  compatibility and ignored — a model-picked subject cannot be guaranteed to
 *  match the name Pulse shows. */
export function resolveLabel(name: string, _authored?: string | null): string | null {
  return shortenNameToLabel(name.toUpperCase());
}

// ── JSONL custom-title (keeps `claude --resume` / /sessions in step) ─────────

function findSessionJsonl(sessionId: string): string | null {
  try {
    for (const dir of [join(getClaudeDir(), 'projects'), join(getClaudeDir(), 'Projects')]) {
      if (!existsSync(dir)) continue;
      const r = Bun.spawnSync(['find', dir, '-maxdepth', '2', '-name', `${sessionId}.jsonl`], { windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 2000 });
      const p = r.stdout.toString().trim().split('\n')[0];
      if (p && existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/** The last custom-title the harness recorded for this session (`/rename`). */
export function getCustomTitle(sessionId: string): string | null {
  const jsonlPath = findSessionJsonl(sessionId);
  if (!jsonlPath) return null;
  try {
    let last: string | null = null;
    for (const line of readFileSync(jsonlPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.type === 'custom-title' && e.customTitle) last = e.customTitle; } catch {}
    }
    return last;
  } catch {}
  return null;
}

function syncNameToJsonl(sessionId: string, title: string): void {
  const jsonlPath = findSessionJsonl(sessionId);
  if (!jsonlPath) return;
  try { appendFileSync(jsonlPath, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }) + '\n', 'utf-8'); } catch {}
}

// ── Uniqueness (first-prompt names only) ─────────────────────────────────────

/** If another session owns this exact name, append " 2".." 9", then a short
 *  hash. Ignores `sessionId` itself so re-fires are idempotent. */
export function disambiguateName(sessionId: string, name: string, names: SessionNames): string {
  const taken = (c: string) => Object.entries(names).some(([id, v]) => id !== sessionId && v === c);
  if (!taken(name)) return name;
  for (let n = 2; n <= 9; n++) { const c = `${name} ${n}`; if (!taken(c)) return c; }
  return `${name} #${sessionId.replace(/-/g, '').slice(0, 6)}`;
}

// ── The writer ───────────────────────────────────────────────────────────────

export interface SetSessionNameOptions {
  /** Who is naming — for the log line. */
  source: string;
  /** The namer's authored 1-2 word tab label; ignored when it no longer fits the name. */
  label?: string | null;
  /** Suffix the name when another live session already owns it (first-prompt names only). Default true. */
  disambiguate?: boolean;
  /** Repaint the kitty tab with the new label. Default true; PromptProcessing passes false because it stamps itself right after. */
  repaint?: boolean;
  /** Also append a custom-title to the harness JSONL. Default true. */
  syncJsonl?: boolean;
}

export interface SetSessionNameResult {
  name: string;
  label: string | null;
  changed: boolean;
}

/**
 * Set a session's name everywhere it lives, in one motion:
 * session-names.json, session-labels.json, the native work.json row, and the
 * harness JSONL custom-title. Then repaint the tab so the label on screen is
 * the label on disk.
 */
export function setSessionName(sessionId: string, rawName: string, opts: SetSessionNameOptions): SetSessionNameResult {
  const name0 = clampSessionName(rawName);
  if (!sessionId || !name0) return { name: name0, label: null, changed: false };
  const locked = acquireLock();
  if (!locked) console.error('[SessionIdentity] Lock timeout — writing anyway');
  let name = name0;
  let label: string | null = null;
  let changed = false;
  let prevLabel: string | null = null;
  try {
    const names = readSessionNames();
    if (opts.disambiguate !== false) name = disambiguateName(sessionId, name, names);
    label = resolveLabel(name, opts.label ?? readSessionLabel(sessionId));
    const labels = pruneOrphanLabels(readSessionLabels(), { ...names, [sessionId]: name });
    prevLabel = labels[sessionId] ?? null;
    changed = names[sessionId] !== name || labels[sessionId] !== (label ?? undefined);
    names[sessionId] = name;
    if (label) labels[sessionId] = label; else delete labels[sessionId];
    writeSessionNames(names);
    writeSessionLabels(labels);
  } finally {
    if (locked) releaseLock();
  }
  updateSessionNameInWorkJson(sessionId, name);
  if (opts.syncJsonl !== false) syncNameToJsonl(sessionId, name);
  console.error(`[SessionIdentity] ${changed ? 'Named' : 'Confirmed'} "${name}" label=${label ?? '∅'} (${opts.source})`);
  if (changed && opts.repaint !== false) repaintTab(sessionId, prevLabel);
  return { name, label, changed };
}

/**
 * Push the work.json row's `sessionName` (ISA frontmatter, reconcile, rename)
 * into the projections. The row is authoritative — no disambiguation, so
 * names.json equals work.json byte for byte. Repaints only when something moved.
 */
export function projectSessionIdentity(sessionId: string, opts: { source: string; repaint?: boolean } = { source: 'work.json' }): SetSessionNameResult | null {
  const row = resolveSessionRow(sessionId);
  if (!row?.sessionName) return null;
  const names = readSessionNames();
  const labels = readSessionLabels();
  const wantLabel = resolveLabel(row.sessionName, labels[sessionId]);
  if (names[sessionId] === row.sessionName && labels[sessionId] === (wantLabel ?? undefined)) {
    return { name: row.sessionName, label: wantLabel, changed: false };
  }
  return setSessionName(sessionId, row.sessionName, { source: opts.source, disambiguate: false, repaint: opts.repaint, syncJsonl: false });
}

// ── Claude Code's own title ──────────────────────────────────────────────────
// The harness keeps its session title in memory and re-appends it to the JSONL
// every turn, so our appended custom-title never sticks; the only way in is a
// UserPromptSubmit hook's `hookSpecificOutput.sessionTitle`. Reading that
// re-appended title back as a `/rename` copied a stale harness title over the
// ISA's name on every prompt (a session kept its first, unrelated title for
// days, so the status line and Claude Code said one thing and Pulse and herdr another).
// A title counts as a rename only when it changed since the last prompt.

const SEEN_PATH = () => lifeosPath('MEMORY', 'STATE', 'session-titles-seen.json');

/**
 * Reconcile Claude Code's title with our stores, once per prompt. Adopts a
 * genuine rename on a native session; otherwise projects the work.json row into
 * the projections. Returns the canonical name the harness should show, or null
 * when the session has no name yet.
 */
export function reconcileHarnessTitle(sessionId: string, harnessTitle: string | null): string | null {
  if (!sessionId) return null;
  const title = harnessTitle && harnessTitle.trim() ? harnessTitle.trim() : null;
  let seen: Record<string, string> = {};
  try { if (existsSync(SEEN_PATH())) seen = JSON.parse(readFileSync(SEEN_PATH(), 'utf-8')); } catch { seen = {}; }
  const prev = seen[sessionId];
  const row = resolveSessionRow(sessionId);
  const renamed = !!title && prev !== undefined && title !== prev && title !== readCanonicalName(sessionId);
  if (renamed && !row?.namedByIsa) {
    setSessionName(sessionId, title!, { source: 'harness-rename', disambiguate: false, syncJsonl: false });
    // The principal chose this name; recalibration never overrides it.
    pinSessionName(sessionId);
  } else {
    if (renamed) console.error(`[SessionIdentity] Rename to "${title}" ignored: the ISA names this session`);
    projectSessionIdentity(sessionId, { source: 'harness-title' });
  }
  const canonical = readCanonicalName(sessionId);
  const record = canonical ?? title;
  if (record && seen[sessionId] !== record) {
    seen[sessionId] = record;
    try {
      const tmp = SEEN_PATH() + '.tmp';
      writeFileSync(tmp, JSON.stringify(seen, null, 2), 'utf-8');
      renameSync(tmp, SEEN_PATH());
    } catch (err) { console.error(`[SessionIdentity] seen-title write failed: ${err}`); }
  }
  return canonical;
}

// ── Name recalibration schedule (2026-10-10) ─────────────────────────────────
// A long session drifts away from the subject its first prompt named. The
// follow-up namer in PromptProcessing asks the model, at most once per
// interval, whether the main subject moved; this file holds when it last asked
// and which names a person pinned. Every rename itself still goes through
// setSessionName, so every surface moves together.
//
// It also keeps the names a session has already had (2026-10-15, ISA F9). The
// namer sees only the first message and the last few turns, so on its own it
// took each new sub-step for a new subject and the name chased the latest
// thread. The earlier names are the session's plot in a few words each.

/** Ten minutes: the two-minute check renamed a session twice in two minutes (2026-10-11). */
export const RECALIBRATION_INTERVAL_MS = 600_000;
/** Earlier names kept per session, oldest dropped first. */
export const NAME_HISTORY_MAX = 8;

interface RecalibrationRow { lastAt?: number; pinned?: boolean; history?: string[] }
type RecalibrationState = Record<string, RecalibrationRow>;

const RECALIBRATION_PATH = () => lifeosPath('MEMORY', 'STATE', 'session-name-recalibration.json');

function readRecalibrationState(): RecalibrationState {
  try {
    const p = RECALIBRATION_PATH();
    if (!existsSync(p)) return {};
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as RecalibrationState) : {};
  } catch { return {}; }
}

/** Read-modify-write one session's row under the projection lock, pruned to
 *  sessions that still have a name (the file is a projection of names.json). */
function updateRecalibrationRow(sessionId: string, patchOrFn: RecalibrationRow | ((row: RecalibrationRow) => RecalibrationRow)): void {
  invariant(typeof sessionId === 'string' && sessionId.length > 0, 'recalibration state needs a session id');
  const locked = acquireLock();
  if (!locked) console.error('[SessionIdentity] Lock timeout — writing recalibration state anyway');
  try {
    const names = readSessionNames();
    const state = readRecalibrationState();
    const out: RecalibrationState = {};
    for (const [id, row] of Object.entries(state)) if (id in names) out[id] = row;
    const current = out[sessionId] ?? {};
    const patch = typeof patchOrFn === 'function' ? patchOrFn(current) : patchOrFn;
    invariant(patch.lastAt === undefined || (Number.isFinite(patch.lastAt) && patch.lastAt >= 0), `recalibration time must be a finite epoch ms, got ${patch.lastAt}`);
    invariant(patch.history === undefined || (Array.isArray(patch.history) && patch.history.length <= NAME_HISTORY_MAX), `name history must be an array of at most ${NAME_HISTORY_MAX}`);
    if (sessionId in names) out[sessionId] = { ...current, ...patch };
    const p = RECALIBRATION_PATH();
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf-8');
    renameSync(tmp, p);
  } finally {
    if (locked) releaseLock();
  }
}

/** True when the follow-up namer should re-check this session's name now:
 *  not pinned by a person, not named by an ISA, and the interval has passed
 *  since the last check (a session never checked is due). */
export function recalibrationDue(sessionId: string, now: number): boolean {
  if (!sessionId) return false;
  const row = readRecalibrationState()[sessionId];
  if (row?.pinned) return false;
  // projectSessionIdentity copies a WORK ISA row's name in on every prompt and
  // would undo any recalibration; that ISA names this session. A project ISA does not.
  if (resolveSessionRow(sessionId)?.namedByIsa) return false;
  if (typeof row?.lastAt === 'number' && now - row.lastAt < RECALIBRATION_INTERVAL_MS) return false;
  return true;
}

/** Take this interval's slot. Called before the model request goes out, so a
 *  second prompt inside the interval never asks again while the first is in flight. */
export function markRecalibrated(sessionId: string, now: number): void {
  invariant(Number.isFinite(now), `recalibration time must be finite, got ${now}`);
  updateRecalibrationRow(sessionId, { lastAt: now });
}

/** A person named this session; recalibration leaves it alone from now on. */
export function pinSessionName(sessionId: string): void {
  updateRecalibrationRow(sessionId, { pinned: true });
}

/** The names this session had before its current one, oldest first. */
export function readNameHistory(sessionId: string): string[] {
  const history = readRecalibrationState()[sessionId]?.history;
  return Array.isArray(history) ? history.filter((n): n is string => typeof n === 'string' && !!n.trim()) : [];
}

/** Remember a name the session is leaving, so the next check sees the whole arc. */
export function recordReplacedName(sessionId: string, name: string): void {
  const clean = (name || '').trim();
  if (!clean) return;
  updateRecalibrationRow(sessionId, (row) => {
    const prior = (row.history ?? []).filter((n) => n !== clean);
    return { history: [...prior, clean].slice(-NAME_HISTORY_MAX) };
  });
}

/** Repaint the tab in its current run state so the new label lands on screen.
 *  The description is carried over, with the PREVIOUS label stripped off it:
 *  composeAscentTitle only knows the new label, so without this a label change
 *  nested the old one into the activity (`NEW | OLD | Fixing…`, live 2026-09-11). */
export function repaintTab(sessionId: string, prevLabel: string | null = null, activity?: string): void {
  try {
    const row = resolveSessionRow(sessionId);
    const tab = readTabState(sessionId);
    const prior = tab?.ascent && (ASCENT_STATES as readonly string[]).includes(tab.ascent) ? (tab.ascent as AscentState) : null;
    const state: AscentState = row?.hasIsa && row.ascent ? row.ascent : (prior ?? 'traverse');
    const carried = activity ?? (tab?.title && prevLabel ? tabTitleActivity(tab.title, prevLabel) : undefined);
    setAscentTab(state, sessionId, carried || undefined);
  } catch (err) {
    console.error(`[SessionIdentity] repaint failed: ${err}`);
  }
}

/** The identity every reader should agree on. */
export function readSessionIdentity(sessionId: string): { name: string | null; label: string | null } {
  const name = readCanonicalName(sessionId);
  const stored = readSessionLabels()[sessionId] ?? null;
  const label = name ? resolveLabel(name, stored) : stored;
  return { name, label };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface LiveTab { windowId: string; title: string; sessionId: string }

function liveKittyTabs(): LiveTab[] {
  const out: LiveTab[] = [];
  try {
    const ls = Bun.spawnSync(['kitty', '@', 'ls'], { windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 3000 });
    if (ls.exitCode !== 0) return out;
    const titleByWindow: Record<string, string> = {};
    for (const os of JSON.parse(ls.stdout.toString())) for (const t of os.tabs) for (const w of t.windows) titleByWindow[String(w.id)] = t.title;
    const ksDir = lifeosPath('MEMORY', 'STATE', 'kitty-sessions');
    if (!existsSync(ksDir)) return out;
    const { readdirSync } = require('fs') as typeof import('fs');
    // Newest file per window wins — a reused window keeps stale files behind it.
    const byWindow = new Map<string, { sessionId: string; mtime: number }>();
    for (const f of readdirSync(ksDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const full = join(ksDir, f);
        const j = JSON.parse(readFileSync(full, 'utf-8'));
        const w = String(j.windowId ?? j.KITTY_WINDOW_ID ?? '');
        if (!w || !titleByWindow[w]) continue;
        const m = statSync(full).mtimeMs;
        const prev = byWindow.get(w);
        if (!prev || m > prev.mtime) byWindow.set(w, { sessionId: f.replace(/\.json$/, ''), mtime: m });
      } catch {}
    }
    // The per-window tab-state file names the session that last painted the
    // window (tab-setter 1.8.5); it outranks the kitty-sessions guess because a
    // reused window keeps the old sessions' files behind it.
    const tabDir = lifeosPath('MEMORY', 'STATE', 'tab-titles');
    for (const windowId of Object.keys(titleByWindow)) {
      let painter: string | null = null;
      try { painter = JSON.parse(readFileSync(join(tabDir, `${windowId}.json`), 'utf-8')).sessionId ?? null; } catch {}
      const sessionId = painter ?? byWindow.get(windowId)?.sessionId;
      if (sessionId) out.push({ windowId, title: titleByWindow[windowId], sessionId });
    }
  } catch {}
  return out;
}

function tabLabelOf(title: string): string | null {
  const body = title.replace(/^\S+\s+/, '');
  const i = body.indexOf(' | ');
  return i === -1 ? null : body.slice(0, i);
}

/** A stale label nested into the activity (`NEW | OLD | Fixing…`): the
 *  activity opens with 1-3 upper-case words, a pipe, and every one of those
 *  words is in the session name. Happens when the label RULE changes under a
 *  live session (2026-09-16: the 2→3-word switch) — the session's own hook
 *  composes with the new label against a title still carrying the old one, and
 *  no setSessionName ran to strip it. Generic detection, so the next rule
 *  change is caught too. */
export function nestedStaleLabel(activity: string, name: string): string | null {
  const m = /^((?:[A-Z0-9][A-Z0-9.+-]*)(?: [A-Z0-9][A-Z0-9.+-]*){0,2}) \| /.exec(activity);
  if (!m) return null;
  const hay = name.toUpperCase();
  return m[1].split(' ').every((w) => hay.includes(w)) ? m[1] : null;
}

if (import.meta.main) {
  const cmd = process.argv[2] ?? 'audit';
  if (cmd === 'audit' || cmd === 'sync-all') {
    // This process runs in SOME terminal; tab-setter prefers the process env
    // window over the per-session file, so a repaint from here would land on
    // this window (2026-09-11: every live label stacked onto one tab). Drop
    // the env so each session resolves its own window through kitty-sessions/.
    delete process.env.KITTY_WINDOW_ID;
    delete process.env.KITTY_LISTEN_ON;
    let drift = 0;
    const rows = liveKittyTabs();
    for (const t of rows) {
      const names = readSessionNames();
      if (!names[t.sessionId] && !resolveSessionRow(t.sessionId)?.sessionName) continue; // unnamed session: nothing to agree on
      if (cmd === 'sync-all') {
        projectSessionIdentity(t.sessionId, { source: 'sync-all' });
        // A label rule change leaves the old label nested in the activity; strip and repaint.
        const ident0 = readSessionIdentity(t.sessionId);
        const live = liveKittyTabs().find((x) => x.windowId === t.windowId)?.title ?? t.title;
        if (ident0.label && ident0.name) {
          // Peel the current label, then every stale one nested behind it.
          let activity = tabTitleActivity(live, ident0.label);
          let peeled = false;
          for (let stale = nestedStaleLabel(activity, ident0.name); stale; stale = nestedStaleLabel(activity, ident0.name)) {
            activity = activity.slice(stale.length + 3);
            peeled = true;
          }
          if (peeled) repaintTab(t.sessionId, null, activity);
        }
      }
      const ident = readSessionIdentity(t.sessionId);
      const tabs = liveKittyTabs().find((x) => x.windowId === t.windowId)?.title ?? t.title;
      const onTab = tabLabelOf(tabs);
      const ok = !!ident.label && onTab === ident.label && readSessionNames()[t.sessionId] === ident.name;
      if (!ok) drift++;
      console.log(`${ok ? 'OK  ' : 'DRIFT'} win=${t.windowId} tab="${onTab ?? '∅'}" label="${ident.label ?? '∅'}" name="${ident.name ?? '∅'}" names.json="${readSessionNames()[t.sessionId] ?? '∅'}" ${t.sessionId.slice(0, 8)}`);
    }
    console.log(`${rows.length} live tabs, ${drift} drifting`);
    process.exit(drift === 0 ? 0 : 1);
  }
  console.error('usage: session-identity.ts audit|sync-all');
  process.exit(2);
}
