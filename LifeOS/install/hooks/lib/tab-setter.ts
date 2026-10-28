/**
 * @version 1.9.7
 * tab-setter.ts - Unified tab state setter.
 *
 * Single function that:
 * 1. Sets Kitty tab title and color via remote control
 * 2. Persists per-window state for daemon recovery
 *
 * All hooks call setTabState() instead of directly running terminal commands.
 */

import { fitName, SURFACE_WIDTHS } from './fit-name';
import { existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync, execFileSync } from 'child_process';
import { TAB_COLORS, ACTIVE_TAB_BG, ACTIVE_TAB_FG, type TabState } from './tab-constants';
import {isPulseTerminal,readPulseTab,writePulseTab} from './pulse-tabs';
import { herdrStateKey, writeHerdrTab } from './herdr-tabs';
import {
  ASCENT,
  ASCENT_GERUNDS,
  PHASE_TO_ASCENT,
  defaultTabActivity,
  deriveAscent,
  stripAscentPrefix,
  tabGlyph,
  type AscentInput,
  type AscentState,
  type TabActivity,
} from '../../LIFEOS/TOOLS/ascent';

// Generic state gerunds that must never carry over as if they were task
// descriptions. Current gerunds come from the ascent table; the rest are
// retired station strings that may still sit in a stale tab-state file.
const GENERIC_PHASE_GERUNDS = new Set([
  ...ASCENT_GERUNDS,
  // Retired ascent gerunds (renamed 2026-08-13 — a tab read "Climbing" while
  // the official state is Ascending): strip forever from stale tab-state files.
  'Climbing.', 'Testing the hold.',
  'Observing.', 'Thinking.', 'Planning.', 'Building.', 'Executing.',
  'Verifying.', 'Learning.', 'Complete.', 'Starting.', 'Scoping.',
  'Observing the user request.', 'Analyzing the problem space.',
  'Planning the execution approach.', 'Building the solution artifacts.',
  'Executing the planned work.', 'Verifying ideal state criteria.',
  'Recording the session learnings.',
]);
import { lifeosPath } from './paths';
import { readRegistry, boundRowSlug } from './isa-utils';
import { getNotificationChannel } from './notification-channel';

const TAB_TITLES_DIR = lifeosPath('MEMORY', 'STATE', 'tab-titles');
const KITTY_SESSIONS_DIR = lifeosPath('MEMORY', 'STATE', 'kitty-sessions');

/**
 * Resolve the `kitten` binary path. When tab-setter runs from the Claude Code
 * process (inherits user PATH) `kitten` is on PATH. When it runs from the Pulse
 * daemon (launchd-restricted PATH) `kitten` is not on PATH and execSync fails
 * with "command not found". Fall back to the kitty.app location.
 */
let kittenBinCached: string | null = null;
function kittenBin(): string {
  if (kittenBinCached) return kittenBinCached;
  try {
    const path = execSync('command -v kitten', { windowsHide: true, encoding: 'utf-8', timeout: 1000 }).trim();
    if (path) { kittenBinCached = path; return path; }
  } catch { /* fall through */ }
  kittenBinCached = '/Applications/kitty.app/Contents/MacOS/kitten';
  return kittenBinCached;
}

/**
 * Get Kitty environment from env vars or persisted per-session file.
 *
 * Resolution order:
 * 1. Process env vars (direct terminal context — always correct)
 * 2. Per-session file: kitty-sessions/{sessionId}.json (no shared state, no races)
 * 3. Default socket at /tmp/kitty-$USER (fallback for socket-only configs)
 *
 * IMPORTANT: listenOn MUST be set for remote control to work safely.
 * Without it, kitten @ commands fall back to escape-sequence IPC which
 * leaks garbage text into the terminal output. See PR #493.
 */
function getKittyEnv(sessionId?: string): { listenOn: string | null; windowId: string | null } {
  // Try environment first (direct terminal calls)
  let listenOn = process.env.KITTY_LISTEN_ON || null;
  let windowId = process.env.KITTY_WINDOW_ID || null;
  if (listenOn && windowId) return { listenOn, windowId };

  // Per-session file lookup (preferred — no shared mutable state)
  if (sessionId) {
    try {
      const sessionPath = join(KITTY_SESSIONS_DIR, `${sessionId}.json`);
      if (existsSync(sessionPath)) {
        const entry = JSON.parse(readFileSync(sessionPath, 'utf-8'));
        listenOn = listenOn || entry.listenOn || null;
        windowId = windowId || entry.windowId || null;
        if (listenOn && windowId) return { listenOn, windowId };
      }
    } catch { /* silent */ }
  }

  // Fallback: check default socket path used by kitty's listen_on config.
  // This prevents escape-sequence IPC when KITTY_LISTEN_ON isn't propagated
  // to subprocess contexts (the root cause of terminal garbage in #493).
  if (!listenOn) {
    const defaultSocket = `/tmp/kitty-${process.env.USER}`;
    try {
      if (existsSync(defaultSocket)) {
        listenOn = `unix:${defaultSocket}`;
      }
    } catch { /* silent */ }
  }

  // Log when kitty env lookup fails with a session ID (diagnostic for compaction issues)
  if (sessionId && !listenOn && !windowId) {
    console.error(`[tab-setter] getKittyEnv: no kitty env found for session ${sessionId.slice(0, 8)} (no env vars, no session file, no default socket)`);
  }

  return { listenOn, windowId };
}

/**
 * Persist a session's Kitty environment for later hook lookups.
 * Called by KittyEnvPersist at session start.
 *
 * Each session gets its own file: kitty-sessions/{sessionId}.json
 * - No shared mutable state (concurrent session starts are safe)
 * - No unbounded growth (files cleaned up on session end)
 * - Simple atomic write (no read-modify-write cycle)
 *
 */
export function persistKittySession(sessionId: string, listenOn: string, windowId: string): void {
  try {
    if (!existsSync(KITTY_SESSIONS_DIR)) mkdirSync(KITTY_SESSIONS_DIR, { recursive: true });
    writeFileSync(
      join(KITTY_SESSIONS_DIR, `${sessionId}.json`),
      JSON.stringify({ listenOn, windowId }),
      'utf-8'
    );
  } catch { /* silent */ }
}

/**
 * Remove a session's persisted Kitty environment file.
 * Called by SessionSummary at session end.
 */
export function cleanupKittySession(sessionId: string): void {
  try {
    const sessionPath = join(KITTY_SESSIONS_DIR, `${sessionId}.json`);
    if (existsSync(sessionPath)) unlinkSync(sessionPath);
  } catch { /* silent */ }
}

interface SetTabOptions {
  title: string;
  state: TabState;
  previousTitle?: string;
  /** Ascent state to carry across a transient stamp (e.g. question), so the
   * restore path can return to the run's real state instead of a generic one. */
  previousAscent?: AscentState;
  /** Marks a permission-blocked stamp so the wildcard PostToolUse restore path
   * can tell "blocked on approval" apart from every other transient state. */
  blocked?: boolean;
  sessionId?: string;
}

/**
 * Clean up state files for kitty windows that no longer exist.
 * Runs opportunistically on each setTabState call (lightweight).
 */
function cleanupStaleStateFiles(): void {
  try {
    if (!existsSync(TAB_TITLES_DIR)) return;
    const files = readdirSync(TAB_TITLES_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) return;

    // Get live window IDs from kitty via socket (prevents escape sequence leaks)
    const defaultSocket = `/tmp/kitty-${process.env.USER}`;
    const socketPath = process.env.KITTY_LISTEN_ON || (existsSync(defaultSocket) ? `unix:${defaultSocket}` : null);
    if (!socketPath) return; // No socket — skip cleanup to avoid escape sequence IPC
    // Validate socket path shape before passing to kitten (defense-in-depth even with execFileSync)
    // execFileSync with an argument array, never a shell string: GHSA-pv2m-jc3r-32fw, @Nosferatuvjr @turnerlk
    if (!/^[a-zA-Z0-9_\-]+:[a-zA-Z0-9/_\-.]+$/.test(socketPath)) return;
    let rawLs: string;
    try {
      rawLs = execFileSync('kitten', ['@', `--to=${socketPath}`, 'ls'], { windowsHide: true,
        encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return; }
    if (!rawLs) return;

    const liveIds = new Set<string>();
    try {
      const osWindows = JSON.parse(rawLs) as Array<{ tabs: Array<{ windows: Array<{ id: number }> }> }>;
      for (const os of osWindows) for (const tab of os.tabs) for (const win of tab.windows) liveIds.add(String(win.id));
    } catch { return; }
    if (liveIds.size === 0) return;

    for (const file of files) {
      const winId = file.replace('.json', '');
      if (winId.startsWith('herdr-')) continue; // keyed by herdr pane, not a kitty window
      if (!liveIds.has(winId)) {
        try { unlinkSync(join(TAB_TITLES_DIR, file)); } catch { /* silent */ }
      }
    }
  } catch { /* silent — cleanup is best-effort */ }
}

/** A headless process has no tab of its own. Its terminal env (or kitty's default
 *  socket) points at whoever spawned it, so painting would rename someone else's tab
 *  and write their tab-state file (2026-10-09: Bridge.test.ts renamed a live pane). */
function noTerminal(): boolean {
  return getNotificationChannel() === 'headless';
}

export function setTabState(opts: SetTabOptions): void {
  if (noTerminal()) return;
  const { state, previousTitle, previousAscent, sessionId } = opts;
  const title = opts.title;
  const colors = TAB_COLORS[state];
  if(writePulseTab({...opts,inactiveBg:colors.inactiveBg,inactiveFg:colors.inactiveFg,activeBg:ACTIVE_TAB_BG,activeFg:ACTIVE_TAB_FG},sessionId))return;


  const kittyEnv = getKittyEnv(sessionId);
  // Inside herdr the kitty tab is the hidden, shared herdr client: paint herdr instead.
  const herdrKey = herdrStateKey();

  paint: try {
    if (herdrKey) { writeHerdrTab(title, sessionId ? readCanonicalName(sessionId) : null); break paint; }
    // Need either TERM=xterm-kitty OR a valid KITTY_LISTEN_ON to proceed
    const isKitty = process.env.TERM === 'xterm-kitty' || kittyEnv.listenOn;
    if (!isKitty) return;

    // CRITICAL: Always use --to flag for socket-based remote control.
    // Without it, kitten @ falls back to escape-sequence IPC which leaks
    // garbage text (e.g. "P@kitty-cmd{...}") into terminal output when
    // running in subprocess contexts. See PR #493.
    if (!kittyEnv.listenOn) {
      console.error(`[tab-setter] No kitty socket available, skipping tab update to prevent escape sequence leaks`);
      return;
    }

    // Set BOTH tab title AND window title. Kitty's tab_title_template uses
    // {active_window.title} (the window title). OSC escape codes from Claude Code
    // reset set-tab-title overrides, so the template falls back to window title.
    // By setting both, our title survives OSC resets.
    const toArg = `--to=${kittyEnv.listenOn}`;
    // When called from a process without a focused kitty window (e.g. the Pulse
    // daemon) we must target by window id — otherwise kitten defaults to the
    // currently focused window, which may belong to a different session.
    //
    // CRITICAL: kitty has SEPARATE id-spaces for windows and tabs. `set-window-title`
    // matches windows, so `id:<windowId>` is correct. But `set-tab-title` and
    // `set-tab-color` match TABS, where `id:<n>` means TAB id — a different object.
    // Passing `id:<windowId>` to a tab command lands on whatever tab happens to hold
    // that id (tab-id ≠ window-id → off-by-one), painting our title onto another
    // session's tab. The right field for tab commands is `window_id:<windowId>`,
    // which selects the tab CONTAINING our window. This was the cross-session bleed.
    const { windowId: kWinId } = kittyEnv;
    const winMatch = kWinId ? `--match=id:${kWinId}` : null;              // window commands
    const tabMatch = kWinId ? `--match=window_id:${kWinId}` : null;       // tab commands
    const kitten = kittenBin();
    console.error(`[tab-setter] Setting tab: "${title}" via ${toArg} tab=${tabMatch ?? '(no match)'}`);
    const titleArgs = tabMatch
      ? ['@', toArg, 'set-tab-title', tabMatch, title]
      : ['@', toArg, 'set-tab-title', title];
    const winTitleArgs = winMatch
      ? ['@', toArg, 'set-window-title', winMatch, title]
      : ['@', toArg, 'set-window-title', title];
    // Argument arrays, never a shell string: GHSA-pv2m-jc3r-32fw, @Nosferatuvjr @turnerlk
    execFileSync(kitten, titleArgs, { windowsHide: true, stdio: 'ignore', timeout: 2000 });
    execFileSync(kitten, winTitleArgs, { windowsHide: true, stdio: 'ignore', timeout: 2000 });

    // set-tab-color is a TAB command: match the tab holding our window, or fall
    // back to --self when called from the tab's own process (no windowId resolved).
    const colorTargetArg = tabMatch ?? '--self';
    const colorArgs = state === 'idle'
      ? ['@', toArg, 'set-tab-color', colorTargetArg, 'active_bg=none', 'active_fg=none', 'inactive_bg=none', 'inactive_fg=none']
      : ['@', toArg, 'set-tab-color', colorTargetArg, `active_bg=${ACTIVE_TAB_BG}`, `active_fg=${ACTIVE_TAB_FG}`, `inactive_bg=${colors.inactiveBg}`, `inactive_fg=${colors.inactiveFg}`];
    execFileSync(kitten, colorArgs, { windowsHide: true, stdio: 'ignore', timeout: 2000 });
    console.error(`[tab-setter] Tab commands completed successfully`);
  } catch (err) {
    console.error(`[tab-setter] Error setting tab:`, err);
  }

  // Persist per-window state (or clean up on idle/session end)
  const windowId = herdrKey ?? kittyEnv.windowId;
  if (!windowId) return;

  try {
    if (state === 'idle') {
      // Session ended — remove state file so no stale data lingers
      const statePath = join(TAB_TITLES_DIR, `${windowId}.json`);
      if (existsSync(statePath)) unlinkSync(statePath);
    } else {
      if (!existsSync(TAB_TITLES_DIR)) mkdirSync(TAB_TITLES_DIR, { recursive: true });
      const stateData: Record<string, unknown> = {
        title,
        inactiveBg: colors.inactiveBg,
        state,
        timestamp: new Date().toISOString(),
      };
      if (previousTitle) stateData.previousTitle = previousTitle;
      if (previousAscent) stateData.previousAscent = previousAscent;
      if (opts.blocked) stateData.blocked = true;
      // The last painter owns the window: a reused kitty window keeps stale
      // kitty-sessions/ files behind it, so this is the only honest window→session map.
      if (opts.sessionId) stateData.sessionId = opts.sessionId;
      writeFileSync(join(TAB_TITLES_DIR, `${windowId}.json`), JSON.stringify(stateData), 'utf-8');
    }
  } catch { /* silent */ }

  // Opportunistic cleanup of stale state files for dead windows
  cleanupStaleStateFiles();
}


/**
 * Read per-window state file. Returns null if not found or invalid.
 */
export function readTabState(sessionId?: string): { title: string; state: TabState; previousTitle?: string; previousAscent?: AscentState; ascent?: AscentState; blocked?: boolean } | null {
  if(isPulseTerminal(sessionId))return readPulseTab(sessionId);
  const kittyEnv = getKittyEnv(sessionId);
  const windowId = herdrStateKey() ?? kittyEnv.windowId;
  if (!windowId) return null;
  try {
    const statePath = join(TAB_TITLES_DIR, `${windowId}.json`);
    if (!existsSync(statePath)) return null;
    const raw = JSON.parse(readFileSync(statePath, 'utf-8'));
    return {
      title: raw.title || '',
      state: raw.state || 'idle',
      previousTitle: raw.previousTitle,
      previousAscent: raw.previousAscent as AscentState | undefined,
      blocked: raw.blocked === true,
      // `phase` is the pre-2026-07-27 key; map it forward so a tab written by
      // the old code still re-stamps correctly on the next prompt.
      ascent: (raw.ascent || PHASE_TO_ASCENT[String(raw.phase || '').toLowerCase()]) as AscentState | undefined,
    };
  } catch { return null; }
}

/**
 * Strip the emoji prefix from a tab title to get raw text.
 * Covers every current ascent glyph plus the retired station emoji — the glyph
 * list lives in the ascent table, so a new icon is strippable the moment it ships.
 */
export function stripPrefix(title: string): string {
  return stripAscentPrefix(title);
}

/** Decode a saved display title before passing its activity back to composition.
 * Remove exactly the known display label; null means an unnamed session.
 * Activity text is opaque, even when it repeats the label or contains pipes.
 */
export function tabTitleActivity(title: string, label?: string | null): string {
  let activity = stripPrefix(title);
  if (label === null) return activity;
  const separator = activity.indexOf(' | ');
  if (separator !== -1) {
    const prefix = label ? `${label} | ` : activity.slice(0, separator + 3);
    if (activity.startsWith(prefix)) activity = activity.slice(prefix.length);
  }
  return activity;
}


// Noise words to skip when extracting the session label
const SESSION_NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'of', 'with',
  'my', 'our', 'new', 'old', 'fix', 'add', 'update', 'set', 'get',
]);

/** The work.json row's identity + run state for a session, resolved through the
 *  SAME source of record the Pulse board reads (`readRegistry`). This is what
 *  makes the tab, the dashboard, and the status line agree by construction: the
 *  tab label is a short form of the row's `sessionName`, and the tab color is
 *  the row's derived ascent — never the frozen first-prompt stores that drifted
 *  the moment a session became an ISA or was renamed (found 2026-09-07: a
 *  climbing ISA showed its first-prompt name and ⚡/🪨 on the tab while Pulse
 *  showed the ISA name and 🧗). One harness UUID can span multiple ISA rows
 *  (isa-utils note); `boundRowSlug` picks the ISA row it last worked in. Fail-open: null on
 *  any read error, so every caller falls back to its prior behavior. */
export interface ResolvedSessionRow {
  sessionName: string | null;
  ascent: AscentState | null;
  hasIsa: boolean;
  /** The ISA names this session: a WORK ISA, written for this one piece of work. A
   *  project ISA outlives every session on it, so the session keeps its own name
   *  and `sessionName` comes back null (2026-10-16: a session became "TEXTUS"). */
  namedByIsa: boolean;
}
export function resolveSessionRow(sessionId: string): ResolvedSessionRow | null {
  if (!sessionId) return null;
  try {
    const reg = readRegistry();
    const slug = boundRowSlug(reg.sessions, sessionId);
    if (!slug) return null;
    const best: Record<string, any> = reg.sessions[slug];
    const rawKey = best.ascent?.key ?? (typeof best.ascent === 'string' ? best.ascent : null);
    const ascent = rawKey && (ASCENT as any)[rawKey] ? (rawKey as AscentState) : null;
    // A WORK ISA names the session that created its row; a session that picks one up,
    // or works on a project ISA, keeps its own name. A row never re-synced since
    // `createdBy` landed falls back to its bound session.
    const creator = best.createdBy || best.sessionUUID;
    const namedByIsa = !!best.isa && String(best.isa).includes('MEMORY/WORK/') && creator === sessionId;
    const ownsName = !best.isa || namedByIsa;
    const name = ownsName && best.sessionName && String(best.sessionName).trim() ? String(best.sessionName).trim() : null;
    return { sessionName: name, ascent, hasIsa: !!best.isa, namedByIsa };
  } catch {
    return null;
  }
}

/** Raw canonical session name — the row's `sessionName` (source of record,
 *  updated by ISA frontmatter and SessionRename) first, then the first-prompt
 *  `session-names.json` entry. Everything the tab shows is derived from this so
 *  it can never disagree with Pulse. */
export function readCanonicalName(sessionId: string): string | null {
  const row = resolveSessionRow(sessionId);
  if (row?.sessionName) return row.sessionName;
  try {
    const namesPath = lifeosPath('MEMORY', 'STATE', 'session-names.json');
    let names: Record<string, string> | null = null;
    try {
      if (existsSync(namesPath)) names = JSON.parse(readFileSync(namesPath, 'utf-8'));
    } catch { names = null; }
    if (!names) {
      const bakPath = namesPath + '.bak';
      if (!existsSync(bakPath)) return null;
      names = JSON.parse(readFileSync(bakPath, 'utf-8'));
    }
    const n = names?.[sessionId];
    return n && n.trim() ? n.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extract up to 4 representative words from a session name.
 * "Reader Filter Bar Redesign" → "READER FILTER BAR REDESIGN"
 * "Voice Server Phase Announcements" → "VOICE SERVER PHASE ANNOUNCEMENTS"
 * Returns uppercase. Filters noise words but keeps up to 4 meaningful ones.
 * Source is the canonical name (work.json row first), so the idle/cairn
 * fallback identifies the SAME work Pulse names.
 */
export function getSessionOneWord(sessionId: string): string | null {
  try {
    const fullName = readCanonicalName(sessionId);
    if (!fullName) return null;

    const words = fullName.split(/\s+/).filter((w: string) => w.length > 0);
    if (words.length === 0) return null;

    // Collect up to 4 non-noise words
    const meaningful = words.filter((w: string) => !SESSION_NOISE.has(w.toLowerCase()));
    if (meaningful.length >= 2) {
      return meaningful.slice(0, 4).join(' ').toUpperCase();
    } else if (meaningful.length === 1) {
      // One meaningful word — grab surrounding words for context
      const idx = words.indexOf(meaningful[0]);
      const nearby = words.slice(Math.max(0, idx - 1), idx + 3).filter((w: string) => w.length > 0);
      return nearby.slice(0, 4).join(' ').toUpperCase();
    }
    // All noise — take first four
    return words.slice(0, 4).join(' ').toUpperCase();
  } catch {
    return null;
  }
}

const SESSION_LABELS_PATH = lifeosPath('MEMORY', 'STATE', 'session-labels.json');

/** A label is the session name fitted to the label width (see shortenNameToLabel),
 *  so any word the name carries is allowed. This validator only guards what the
 *  store will accept: one line, no title separator, nothing longer than a label. */
export function isValidSessionLabel(label: string): boolean {
  const l = (label || '').trim();
  if (!l || l.length > SHORT_LABEL_MAX) return false;
  return !l.includes('|') && !/[\u0000-\u001f\u007f]/.test(l);
}

/** Persist the label the namer authored for a session. Invalid input is dropped. */
export function storeSessionLabel(sessionId: string, label: string): boolean {
  if (!sessionId || !isValidSessionLabel(label)) return false;
  try {
    const dir = lifeosPath('MEMORY', 'STATE');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let labels: Record<string, string> = {};
    try {
      if (existsSync(SESSION_LABELS_PATH)) labels = JSON.parse(readFileSync(SESSION_LABELS_PATH, 'utf-8'));
    } catch { labels = {}; }
    labels[sessionId] = label.trim().toUpperCase();
    writeFileSync(SESSION_LABELS_PATH, JSON.stringify(labels, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

/** Read a stored label. Returns null when the session has none. */
export function readSessionLabel(sessionId: string): string | null {
  try {
    if (!existsSync(SESSION_LABELS_PATH)) return null;
    const labels = JSON.parse(readFileSync(SESSION_LABELS_PATH, 'utf-8')) as Record<string, string>;
    const label = labels?.[sessionId];
    return label && isValidSessionLabel(label) ? label.toUpperCase() : null;
  } catch { return null; }
}

/** Drop a session's label (session end). */
export function clearSessionLabel(sessionId: string): void {
  try {
    if (!existsSync(SESSION_LABELS_PATH)) return;
    const labels = JSON.parse(readFileSync(SESSION_LABELS_PATH, 'utf-8')) as Record<string, string>;
    if (!(sessionId in labels)) return;
    delete labels[sessionId];
    writeFileSync(SESSION_LABELS_PATH, JSON.stringify(labels, null, 2), 'utf-8');
  } catch { /* silent */ }
}

/**
 * Session label for the tab prefix — the canonical session name fitted to the
 * label width (shortenNameToLabel). The name is
 * the work.json row Pulse shows, so tab, status line and board read the same
 * words. The namer-authored 1-2 word label (2026-08-19) is retired: a model-
 * picked subject could never be guaranteed to match the name.
 */
export function getSessionShortLabel(sessionId: string): string | null {
  const canonical = readCanonicalName(sessionId);
  const full = canonical ? canonical.toUpperCase() : getSessionOneWord(sessionId);
  return shortenNameToLabel(full);
}

/** Does an authored short label still describe the canonical name? Every label
 *  word must appear in the name; if it doesn't, the label is stale (the session
 *  became an ISA or was renamed) and the tab must re-slice from the name. */
export function authoredFitsCanonical(authored: string, canonical: string): boolean {
  if (!authored || !canonical) return false;
  const haystack = canonical.toUpperCase();
  return authored.split(/\s+/).filter(Boolean).every((w) => haystack.includes(w.toUpperCase()));
}

/** The session name fitted to the label width, upper-cased — the label the tab,
 *  the status line and Pulse all agree on. It is a whole-word prefix of the name,
 *  so it READS AS the session name (principal, 2026-09-16); since 2026-10-09 its
 *  length is set by columns, not by a three-word count (fitName). Pure so the
 *  regression cases can pin it. */
export function shortenNameToLabel(fullUpper: string | null | undefined): string | null {
  if (!fullUpper) return null;
  return fitName(fullUpper.toUpperCase(), SURFACE_WIDTHS.label.cols) || null;
}

// Longest label the store accepts: the label width, with room for labels stored
// before the width table existed.
const SHORT_LABEL_MAX = 40;

/**
 * Bare state words and transient stamps are never task descriptions. A title
 * carrying one of these tells the user nothing ("🪨 WORKING" on a completed
 * tab, found live 2026-08-12) — filter it and fall back to something honest.
 */
export function isDegenerateDesc(desc: string): boolean {
  const d = (desc || '').trim();
  if (!d) return true;
  if (/^(APPROVE|FAILED):/i.test(d)) return true;
  return /^(working|done|thinking|blocked|completed|idle|task complete)[.…]?$/i.test(d);
}

/**
 * Pure title composition for setAscentTab — extracted so tests can replay the
 * exact shipping logic against regression cases (the 🪨 WORKING tab).
 *
 * Title shape: `{glyph} {LABEL} | {desc}` — ONE glyph (see `tabGlyph`): ⏳ when
 * The principal is the blocker, ⚡ for work with no ISA behind it, and the run's own
 * ascent icon otherwise. LABEL is the short session name so a glance says WHICH
 * session, and desc is the activity. A tab reading only the activity
 * ("posture") told the principal nothing about which session it belonged to
 * (2026-08-19). Defaults come from `defaultTabActivity`; only the
 * question/approval stamps override.
 */
export function composeAscentTitle(
  state: AscentState,
  opts: {
    summary?: string;
    oneWord?: string | null;
    /** Short session name for the tab prefix (see getSessionShortLabel). */
    sessionLabel?: string | null;
    currentTitle?: string | null;
    activity?: TabActivity | null;
    /** Use the summary verbatim as the description (approval stamps carry
     * `APPROVE: …`, which the degenerate filter rightly bans everywhere else). */
    literal?: boolean;
  },
): string {
  const config = ASCENT[state];
  const summary = opts.summary?.trim() || '';
  const activity = opts.activity !== undefined ? opts.activity : defaultTabActivity(state);
  const prefix = tabGlyph(state, activity ?? null);
  const label = opts.sessionLabel?.trim() || '';
  /** `{icon}{glyph} LABEL | desc`, or `{icon}{glyph} desc` when the session has
   * no name yet. The label never repeats itself into the desc. */
  const compose = (desc: string): string =>
    label && desc && desc !== label ? `${prefix} ${label} | ${desc}` : `${prefix} ${desc || label}`;
  if (state === 'cairn') {
    // No summary extracted — the session name at least identifies the work;
    // never a bare state word.
    return compose(summary || (label ? 'Done' : opts.oneWord || 'Done'));
  }
  if (state === 'idle') {
    return opts.oneWord || 'Idle';
  }
  if (opts.literal && summary) {
    return compose(summary);
  }
  // Preserve the working description carried in from PromptProcessing or a
  // prior phase — only the leading token+icon changes to show the new phase.
  // stripPrefix removes token+icon; tolerate the legacy "ONE_WORD | desc"
  // shape that may linger in pre-format-change state files.
  let existingDesc = '';
  if (opts.currentTitle) {
    existingDesc = tabTitleActivity(opts.currentTitle, label || null);
  }
  // Never carry over generic phase gerunds, state words, or approval stamps —
  // they're not real task descriptions.
  if (GENERIC_PHASE_GERUNDS.has(existingDesc) || isDegenerateDesc(existingDesc)) existingDesc = '';
  // An explicit summary (e.g. a fresh iteration's gerund from PromptProcessing)
  // overrides the carried-over desc; otherwise keep what the tab already shows.
  const override = summary && !GENERIC_PHASE_GERUNDS.has(summary) && !isDegenerateDesc(summary) ? summary : '';
  const desc = override || existingDesc || config.gerund;
  return compose(desc);
}

export interface AscentTabOptions {
  /** Override the state-implied activity glyph (question/approval → 'waiting'). */
  activity?: TabActivity | null;
  /** Use the summary verbatim as the description (approval stamps). */
  literal?: boolean;
  /** Carry the pre-stamp title so a transient stamp (question/approval) can restore it. */
  previousTitle?: string;
  /** Carry the pre-stamp ascent state for the same restore path. */
  previousAscent?: AscentState;
  /** Marks a permission-blocked stamp for the wildcard PostToolUse restore. */
  blocked?: boolean;
}

/**
 * Set tab title and color for an Algorithm run state.
 * Active format:   {ICON}{ACTIVITY} {SESSION LABEL} | {task description}
 * Cairn format:    🪨✅ {SESSION LABEL} | {summary}
 *
 * Called whenever the run's derived ascent state changes. Every glyph, color and
 * fallback gerund comes from `LIFEOS/TOOLS/ascent.ts` — the same table Pulse and
 * the status line read, so a tab can never disagree with the board. Since
 * 2026-08-12 the tab background IS the board color (ASCENT.tabBg === color),
 * and the question/approval stamps route through here too, so every painted
 * tab is one of the six run-state colors.
 */
export function setAscentTab(state: AscentState, sessionId: string, summary?: string, opts: AscentTabOptions = {}): void {
  if (noTerminal()) return;
  const config = ASCENT[state];
  if (!config) return;

  const currentState = readTabState(sessionId);
  const title = composeAscentTitle(state, {
    summary,
    oneWord: getSessionOneWord(sessionId),
    sessionLabel: getSessionShortLabel(sessionId),
    currentTitle: currentState?.title ?? null,
    activity: opts.activity,
    literal: opts.literal,
  });
  if(writePulseTab({...opts,title,state:state==='cairn'?'completed':'working',ascent:state,inactiveBg:config.tabBg,inactiveFg:config.tabFg,activeBg:ACTIVE_TAB_BG,activeFg:ACTIVE_TAB_FG},sessionId))return;
  const kittyEnv = getKittyEnv(sessionId);


  const herdrKey = herdrStateKey();
  paint: try {
    if (herdrKey) { writeHerdrTab(title, sessionId ? readCanonicalName(sessionId) : null); break paint; }
    const isKitty = process.env.TERM === 'xterm-kitty' || kittyEnv.listenOn;
    if (!isKitty) return;

    // CRITICAL: Require socket for remote control. See PR #493.
    if (!kittyEnv.listenOn) {
      console.error(`[tab-setter] No kitty socket available, skipping phase tab update`);
      return;
    }

    const toArg = `--to=${kittyEnv.listenOn}`;
    // See setTabState: tab commands (set-tab-title, set-tab-color) match TABS via
    // window_id:<id>; window commands (set-window-title) match WINDOWS via id:<id>.
    // Mixing them is the cross-session tab-title bleed.
    const { windowId: kWinId } = kittyEnv;
    const winMatch = kWinId ? `--match=id:${kWinId}` : null;
    const tabMatch = kWinId ? `--match=window_id:${kWinId}` : null;
    const colorTargetArg = tabMatch ?? '--self';
    const kitten = kittenBin();

    const titleArgs = tabMatch
      ? ['@', toArg, 'set-tab-title', tabMatch, title]
      : ['@', toArg, 'set-tab-title', title];
    const winTitleArgs = winMatch
      ? ['@', toArg, 'set-window-title', winMatch, title]
      : ['@', toArg, 'set-window-title', title];
    // Argument arrays, never a shell string: GHSA-pv2m-jc3r-32fw, @Nosferatuvjr @turnerlk
    execFileSync(kitten, titleArgs, { windowsHide: true, stdio: 'ignore', timeout: 2000 });
    execFileSync(kitten, winTitleArgs, { windowsHide: true, stdio: 'ignore', timeout: 2000 });

    const colorArgs = state === 'idle'
      ? ['@', toArg, 'set-tab-color', colorTargetArg, 'active_bg=none', 'active_fg=none', 'inactive_bg=none', 'inactive_fg=none']
      : ['@', toArg, 'set-tab-color', colorTargetArg, `active_bg=${ACTIVE_TAB_BG}`, `active_fg=${ACTIVE_TAB_FG}`, `inactive_bg=${config.tabBg}`, `inactive_fg=${config.tabFg}`];
    execFileSync(kitten, colorArgs, { windowsHide: true, stdio: 'ignore', timeout: 2000 });
    console.error(`[tab-setter] Ascent tab: "${title}" (${state}, bg=${config.tabBg})`);
  } catch (err) {
    console.error(`[tab-setter] Error setting ascent tab:`, err);
  }

  // Persist per-window state
  const windowId = herdrKey ?? kittyEnv.windowId;
  if (!windowId) return;

  try {
    if (!existsSync(TAB_TITLES_DIR)) mkdirSync(TAB_TITLES_DIR, { recursive: true });
    const stateData: Record<string, unknown> = {
      title,
      inactiveBg: config.tabBg,
      state: state === 'cairn' ? 'completed' : 'working',
      ascent: state,
      timestamp: new Date().toISOString(),
    };
    if (opts.activity !== undefined) stateData.activity = opts.activity;
    if (opts.previousTitle) stateData.previousTitle = opts.previousTitle;
    if (opts.previousAscent) stateData.previousAscent = opts.previousAscent;
    if (opts.blocked) stateData.blocked = true;
    if (sessionId) stateData.sessionId = sessionId;
    writeFileSync(join(TAB_TITLES_DIR, `${windowId}.json`), JSON.stringify(stateData), 'utf-8');
  } catch { /* silent */ }
}

/**
 * Convenience wrapper for callers that hold ISA/registry data rather than a
 * resolved state — derives through the same `deriveAscent` Pulse uses.
 */
export function setAscentTabFrom(input: AscentInput, sessionId: string, summary?: string): AscentState {
  const state = deriveAscent(input);
  setAscentTab(state, sessionId, summary);
  return state;
}
