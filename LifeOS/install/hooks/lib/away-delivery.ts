/**
 * away-delivery.ts — a file handed to the principal in Downloads or Desktop reaches him when he is not at this Mac.
 *
 * Why: a deliverable written to ~/Downloads on the home machine never reached the principal while they were away.
 * The <principal-reach> prompt block that should have said so never reached the model's context, and the location
 * service was not checked. A notice the model must read fails whenever the notice goes missing, so the
 * delivery itself now acts: the output-record hook (maintainer-side; not in the public release) passes every file that landed in a delivery root here, and when Location
 * says he is on another device, each one is uploaded through the share service and its link handed back as context.
 * Silent at this Mac. Fails open: any error is a note naming what did not upload, never a blocked turn.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { nowRecord } from "../../LIFEOS/LOCATION/Location";
import { getPrincipalName } from "./identity";

/** Files above this stay put and are named in the note: the share service is for hand-offs, not bulk media. */
export const MAX_SHARE_BYTES = 200 * 1024 * 1024;
/** Names that look like credentials never leave the machine, away or not. */
const CREDENTIAL_WORDS = /(^|[._-])(env|secrets?|credentials?|id_rsa|id_ed25519)([._-]|$)/i;
const SECRETISH = new RegExp(`${CREDENTIAL_WORDS.source}|\\.(pem|key|p12|pfx|age)$`, "i");
const ARCHIVE_WINDOW = 128 * 1024;
/** Names of Keynote's own parts inside its zip: the Index folder or archive, and the Metadata folder. */
const KEYNOTE_PART = /Index\/|Index\.zip|Metadata\//;

/** True only for a Keynote document: a zip (starts "PK\x03\x04") whose first or last 128 KiB names Keynote's own parts. Any other zip is not one. */
function isKeynoteArchive(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const read = (at: number): string => {
      const b = Buffer.alloc(Math.min(ARCHIVE_WINDOW, size - at));
      readSync(fd!, b, 0, b.length, at);
      return b.toString("latin1");
    };
    const head = read(0);
    if (!head.startsWith("PK\x03\x04")) return false;
    return KEYNOTE_PART.test(head) || KEYNOTE_PART.test(read(Math.max(0, size - ARCHIVE_WINDOW)));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * A credential-looking name stays held. The one exemption is a Keynote deck: it is also `.key`, but it is a zip
 * archive with Keynote's own parts inside, and the rest of its name carries no credential word
 * (2026-10-20: a delivered deck was held as a credential).
 */
function looksLikeCredential(path: string, name: string): boolean {
  if (!SECRETISH.test(name)) return false;
  if (!/\.key$/i.test(name) || CREDENTIAL_WORDS.test(name)) return true;
  return !isKeynoteArchive(path);
}

export type Presence = { away: boolean; device: string; where: string };
export type AwayDeps = {
  /** Presence override (tests); default reads Location's nowRecord(). */
  presence?: () => Presence | null;
  /** Upload override (tests); returns the share URL. Default runs the `share` CLI. */
  upload?: (path: string) => string | Promise<string>;
  /** Wall-clock budget for all uploads of one call together (tests). */
  budgetMs?: number;
};

/**
 * All uploads of one call run at once and share this budget. Serial uploads held the tool call for each file in turn
 * (2026-10-23: 7–21 s per Bash call while screenshots landed in Downloads, the hook's whole p99). One share upload
 * takes ~6 s however small the file (it runs wrangler), and three at once ~8 s (measured 2026-10-24), so the budget
 * leaves room for a handful. A file still uploading at the deadline is named in the note for the DA to upload itself,
 * the same way a too-big file is.
 */
export const UPLOAD_BUDGET_MS = 15_000;

/** Away when the device in use is anything but this Mac. Null when Location cannot say (fails open: no upload). */
export function livePresence(): Presence | null {
  try {
    const r = nowRecord() as { name?: string | null; fallback?: boolean; device?: { name: string; kind: string } };
    if (!r.device) return null;
    return { away: r.device.kind !== "this-mac", device: r.device.name, where: r.fallback ? "location unknown" : (r.name ?? "unknown place") };
  } catch { return null; }
}

/** One `share` upload. The child is killed when the signal fires, so no upload outlives the hook. */
async function shareUpload(path: string, signal?: AbortSignal): Promise<string> {
  const proc = Bun.spawn(["share", path], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(signal?.aborted ? "aborted" : `share exited ${code}`);
  const url = /https:\/\/\S+/.exec(out)?.[0];
  if (!url) throw new Error("no link in share output");
  return url;
}

const TIMED_OUT = Symbol("timed out");

/**
 * The context line for files that landed in Downloads/Desktop this call: null at this Mac or with nothing to deliver;
 * otherwise each file uploaded through share with its link, plus any that were held back and why.
 */
export async function awayDelivery(paths: string[], deps: AwayDeps = {}): Promise<string | null> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return null;
  const p = (deps.presence ?? livePresence)();
  if (!p || !p.away) return null;
  const abort = new AbortController();
  const upload = deps.upload ?? ((path: string) => shareUpload(path, abort.signal));
  const shared: string[] = [];
  const held: string[] = [];
  const big: string[] = [];
  const pending: { name: string; path: string; size: number; url: Promise<string | typeof TIMED_OUT> }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((ok) => { timer = setTimeout(() => ok(TIMED_OUT), deps.budgetMs ?? UPLOAD_BUDGET_MS); });
  for (const path of unique) {
    const name = basename(path);
    if (looksLikeCredential(path, name)) { held.push(`${name} (looks like a credential; never uploaded)`); continue; }
    // The upload follows symlinks, so the file it would open is judged too: an innocent name aliasing a credential stays held.
    let real: string;
    try { real = realpathSync(path); } catch { held.push(`${name} (gone before upload)`); continue; }
    if (real !== path && looksLikeCredential(real, basename(real))) { held.push(`${name} (links to a credential; never uploaded)`); continue; }
    let size = 0;
    try { size = statSync(path).size; } catch { held.push(`${name} (gone before upload)`); continue; }
    if (size > MAX_SHARE_BYTES) { big.push(`${name} (${Math.round(size / 1048576)} MB)`); continue; }
    pending.push({ name, path, size, url: Promise.race([Promise.resolve().then(() => upload(path)), deadline]) });
  }
  for (const p of pending) {
    try {
      const url = await p.url;
      if (url === TIMED_OUT) big.push(`${p.name} (${Math.max(1, Math.round(p.size / 1048576))} MB, still uploading when the hook's ${Math.round((deps.budgetMs ?? UPLOAD_BUDGET_MS) / 1000)} s budget ran out)`);
      else shared.push(`${p.name} → ${url}`);
    } catch (e) { held.push(`${p.name} (upload failed: ${e instanceof Error ? e.message.split("\n")[0] : "error"})`); }
  }
  clearTimeout(timer);
  abort.abort(); // ends any upload still running past the budget
  return [
    `AWAY-DELIVERY: ${getPrincipalName()} is NOT at this Mac (on ${p.device}, ${p.where}); they cannot open ~/Downloads or ~/Desktop here.`,
    ...(shared.length ? ["Uploaded to share. Give them these links in the answer, never the local path:", ...shared.map((s) => `- ${s}`)] : []),
    ...(big.length ? ["Not uploaded inside this hook (too big, or still uploading at its budget). Upload each now with `share --name <name> <path>` (large files work) and give them the link in this answer; a deliverable they asked for is never left out:", ...big.map((s) => `- ${s}`)] : []),
    ...(held.length ? ["Not uploaded, so tell them plainly and offer another way:", ...held.map((s) => `- ${s}`)] : []),
  ].join("\n");
}
