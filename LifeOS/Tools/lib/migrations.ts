/**
 * The USER-tree migration ledger, run by `Tools/Migrate.ts`.
 *
 * Each entry is one change an older install's USER tree needs to reach the shape the current release reads. An entry
 * runs when its `introducedIn` is newer than the install's from-version and its id is not yet recorded as applied.
 * Entries run in ledger order, and the order never changes: append new entries at the end.
 *
 * A migration never writes a file directly. It asks the effects object to write or retire a path, and the effects
 * object backs up any existing file first (Migrate.ts). In a dry run the same calls only record what would happen, so
 * the plan a dry run prints is exactly what an apply does.
 *
 * Imports stay inside the skill: this runs from the download directory before ../../../LIFEOS exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** What a migration may do to the USER tree. Paths are relative to the USER root. */
export interface Effects {
  /** Create or replace a file; an existing file is backed up first. */
  write(rel: string, content: string): void;
  /** Move a file out of the USER tree into the backup. */
  retire(rel: string): void;
}

export interface MigrationContext {
  /** The real (symlink-resolved) USER root. */
  userDir: string;
  /** The shipped USER template tree, when this install has one. */
  templateDir: string | null;
  /** ISO timestamp of this run. */
  now: string;
  effects: Effects;
}

export interface MigrationOutcome {
  /** False when the tree already had the target shape: nothing was (or would be) written. */
  changed: boolean;
  /** One plain line per thing done, for the report. */
  notes: string[];
}

export interface Migration {
  id: string;
  /** The release that introduced this migration; installs at or past it never need it. */
  introducedIn: string;
  title: string;
  run(ctx: MigrationContext): MigrationOutcome;
}

// ── shared text helpers ──────────────────────────────────────────────

export function splitFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length) };
}

/** The section key GenerateTelosSummary derives from an H2 title: dash suffix and trailing parentheticals dropped, lowercased. */
export function sectionKey(title: string): string {
  return title.replace(/\s*[—–-].*$/, "").replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
}

/** True when two section keys name the same section (GenerateTelosSummary's plural fallback). */
export function sameSection(a: string, b: string): boolean {
  return a === b || a + "s" === b || a === b + "s";
}

export interface Section { title: string; key: string; body: string }

/** Split markdown into its preamble (before the first H2) and H2 sections. */
export function h2Sections(text: string): { preamble: string; sections: Section[] } {
  const lines = text.split("\n");
  const pre: string[] = [];
  const sections: Section[] = [];
  let cur: { title: string; body: string[] } | null = null;
  let fence = false;
  const flush = () => { if (cur) sections.push({ title: cur.title, key: sectionKey(cur.title), body: cur.body.join("\n").replace(/\s+$/, "") }); };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : line.match(/^##\s+(.+?)\s*$/);
    if (m) { flush(); cur = { title: m[1], body: [] }; continue; }
    (cur ? cur.body : pre).push(line);
  }
  flush();
  return { preamble: pre.join("\n"), sections };
}

/**
 * The lines of a TELOS text the principal wrote: comments, scaffolding (rules, ID-less headings, emphasis-wrapped
 * footnotes), `(sample` placeholders, the SAMPLE TEMPLATE banner, and every line the shipped template itself carries
 * are dropped. What is left is the user's own content.
 */
export function ownLines(text: string, templateText?: string | null): string[] {
  const tpl = new Set((templateText ? splitFrontmatter(templateText).body : "").split("\n").map((l) => l.trim()).filter(Boolean));
  return splitFrontmatter(text).body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !tpl.has(l))
    .filter((l) => !/\(sample\b/i.test(l) && !/SAMPLE TEMPLATE/.test(l))
    .filter((l) => !/^-{3,}$/.test(l))
    .filter((l) => !(/^#{1,6}\s/.test(l) && !/^#{1,6}\s+[A-Z]+\d+\w?:/.test(l)))
    // Only a whole-line italic footnote (`*…*`, `_…_`), the shape every shipped hint takes. A bold line (`**…**`) or a
    // `* ` bullet that ends in emphasis is the principal's own writing and must count, or their TELOS reads as a sample.
    .filter((l) => !/^(?:\*(?![*\s]).*[^*\s]\*|_(?![_\s]).*[^_\s]_)$/.test(l));
}

/**
 * Did the principal write this file? A file still stamped `provenance: template` counts only when its own lines go
 * beyond the shipped template; with no template to compare against such a file is left alone, since leaving a file in
 * place loses nothing.
 */
export function isUserWritten(text: string, templateText?: string | null): boolean {
  const own = ownLines(text, templateText);
  if (own.length === 0) return false;
  const prov = splitFrontmatter(text).fm.provenance;
  if (prov === "template" && !templateText) return false;
  return true;
}

// ── 8.28.0: consolidate split TELOS files into one TELOS.md ──────────

/** The v7-era split TELOS files and the TELOS.md section each one became (GenerateTelosSummary's legacy map). */
export const SPLIT_TELOS_FILES: ReadonlyArray<readonly [file: string, key: string]> = [
  ["MISSION.md", "mission"], ["PROBLEMS.md", "problems"], ["GOALS.md", "goals"], ["CHALLENGES.md", "challenges"],
  ["RISKS.md", "risks"], ["STRATEGIES.md", "strategies"], ["PROJECTS.md", "projects"], ["NARRATIVES.md", "narratives"],
  ["WISDOM.md", "wisdom"], ["BELIEFS.md", "beliefs"], ["MODELS.md", "models"], ["FRAMES.md", "frames"],
  ["PREDICTIONS.md", "predictions"], ["WRONG.md", "wrong"], ["TRAUMAS.md", "traumas"],
];

/** The unified TELOS.md H2 headings, in order, used when this install has no shipped template to read them from. */
export const FALLBACK_TELOS_HEADINGS: readonly string[] = [
  "Current State (where you are now)",
  "Ideal State (where you want to be)",
  "Mission",
  "Problems (the problems in the world you're trying to solve)",
  "GOALS (measurable milestones toward the problems)",
  "Challenges (things stopping you from hitting your goals)",
  "Risks (RN) (the top scenarios that could take you off the path to your ideal state, each with the current state of prevent, detect, and respond)",
  "Strategies (how you'll overcome the challenges)",
  "Projects (what you're working on to pursue the strategies)",
  "Narratives (talking points for talks, panels, posts)",
  "Wisdom (favorite lessons and aphorisms)",
];

const readIf = (p: string | null): string | null => (p && existsSync(p) ? readFileSync(p, "utf8") : null);

/**
 * A split file's body as a TELOS.md section body: frontmatter, its own H1 and the template's lines dropped, its H2
 * subheadings demoted to H3 so they stay inside the section, and runs of blank lines collapsed.
 */
export function splitBodyAsSection(text: string, templateText: string | null): string {
  const tpl = new Set((templateText ? splitFrontmatter(templateText).body : "").split("\n").map((l) => l.trim()).filter(Boolean));
  const out: string[] = [];
  let sawH1 = false;
  for (const raw of splitFrontmatter(text).body.split("\n")) {
    const t = raw.trim();
    if (!sawH1 && /^#\s/.test(t)) { sawH1 = true; continue; }
    if (t && tpl.has(t)) continue;
    if (/\(sample\b/i.test(t) || /SAMPLE TEMPLATE/.test(t)) continue;
    out.push(/^##\s/.test(raw) ? "#" + raw : raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const titleFor = (key: string, headings: readonly string[]): string =>
  headings.find((h) => sameSection(sectionKey(h), key)) ?? key.charAt(0).toUpperCase() + key.slice(1);

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

export const telosConsolidate: Migration = {
  id: "8.28.0-telos-consolidate",
  introducedIn: "8.28.0",
  title: "Consolidate split TELOS files (MISSION.md, GOALS.md, …) into one TELOS.md",
  run(ctx) {
    const telosDir = join(ctx.userDir, "TELOS");
    const notes: string[] = [];
    if (!existsSync(telosDir)) return { changed: false, notes: ["no TELOS directory"] };
    const tplDir = ctx.templateDir ? join(ctx.templateDir, "TELOS") : null;
    const tplTelos = readIf(tplDir && join(tplDir, "TELOS.md"));
    const headings = tplTelos ? h2Sections(splitFrontmatter(tplTelos).body).sections.map((s) => s.title) : [...FALLBACK_TELOS_HEADINGS];

    const splits = SPLIT_TELOS_FILES
      .map(([file, key]) => ({ file, key, text: readIf(join(telosDir, file)), tpl: readIf(tplDir && join(tplDir, file)) }))
      .filter((s): s is { file: string; key: string; text: string; tpl: string | null } => s.text !== null && isUserWritten(s.text, s.tpl))
      .map((s) => ({ ...s, body: splitBodyAsSection(s.text, s.tpl) }))
      .filter((s) => s.body.length > 0);
    if (splits.length === 0) return { changed: false, notes: ["no split TELOS file carries the principal's own content"] };

    const telosPath = join(telosDir, "TELOS.md");
    const existing = readIf(telosPath);
    const keepExisting = existing !== null && isUserWritten(existing, tplTelos);

    let result: string;
    if (keepExisting) {
      // Merge into the principal's TELOS.md: fill a section that holds only samples, append to one that has content
      // (unless the split text is already there), and add a section the file lacks at the end.
      const { body } = splitFrontmatter(existing!);
      const fmBlock = existing!.match(/^---\n[\s\S]*?\n---\n?/)?.[0] ?? "";
      const parsed = h2Sections(body);
      for (const s of splits) {
        const sec = parsed.sections.find((x) => sameSection(x.key, s.key));
        if (!sec) {
          parsed.sections.push({ title: titleFor(s.key, headings), key: s.key, body: s.body });
          notes.push(`added section "${titleFor(s.key, headings)}" from TELOS/${s.file}`);
        } else if (ownLines(sec.body, tplTelos).length === 0) {
          sec.body = s.body;
          notes.push(`filled sample-only section "${sec.title}" from TELOS/${s.file}`);
        } else if (normalize(sec.body).includes(normalize(s.body))) {
          notes.push(`TELOS/${s.file} was already in section "${sec.title}"`);
        } else {
          sec.body = `${sec.body}\n\n<!-- merged from TELOS/${s.file} by migration ${telosConsolidate.id} -->\n${s.body}`;
          notes.push(`appended TELOS/${s.file} to section "${sec.title}"`);
        }
      }
      result = `${fmBlock}${parsed.preamble.replace(/\s+$/, "")}\n\n${parsed.sections.map((x) => `## ${x.title}\n\n${x.body}`.trimEnd()).join("\n\n")}\n`;
    } else {
      // Build TELOS.md from the split files: every shipped heading in order, the principal's content under each one
      // that has it, an empty body for the rest. No sample line survives.
      const byKey = new Map(splits.map((s) => [s.key, s] as const));
      const used = new Set<string>();
      const parts: string[] = [];
      for (const h of headings) {
        const s = [...byKey.values()].find((x) => !used.has(x.key) && sameSection(x.key, sectionKey(h)));
        if (s) { used.add(s.key); notes.push(`section "${h}" from TELOS/${s.file}`); }
        parts.push(s ? `## ${h}\n\n${s.body}` : `## ${h}`);
      }
      for (const s of splits) {
        if (used.has(s.key)) continue;
        parts.push(`## ${titleFor(s.key, headings)}\n\n${s.body}`);
        notes.push(`section "${titleFor(s.key, headings)}" from TELOS/${s.file}`);
      }
      const front = `---\nprovenance: customized\nlast_updated: ${ctx.now}\nlast_updated_by: ${telosConsolidate.id}\nconvention: lifeos-freshness-v1\n---\n`;
      result = `${front}\n# TELOS\n\n${parts.join("\n\n")}\n`;
      notes.push(existing === null ? "created TELOS.md" : "replaced the sample TELOS.md (kept in the backup)");
    }

    ctx.effects.write("TELOS/TELOS.md", result);
    for (const s of splits) {
      ctx.effects.retire(`TELOS/${s.file}`);
      notes.push(`moved TELOS/${s.file} into the backup`);
    }
    return { changed: true, notes };
  },
};

// ── 8.761.0: OPERATIONAL_RULES.md became OPERATIONAL_PREFERENCES.md ──

const RULES_REL = "CONFIG/OPERATIONAL_RULES.md";
const PREFS_REL = "CONFIG/OPERATIONAL_PREFERENCES.md";

/**
 * 7.x loaded the principal's rules from CONFIG/OPERATIONAL_RULES.md; 8.x's CLAUDE.md imports
 * CONFIG/OPERATIONAL_PREFERENCES.md instead, and ScaffoldUser places a stub there. Without this the
 * upgrade silently dropped every rule the principal wrote from session context. Their sections come
 * first in their own order; each shipped heading the file lacks follows with the template's guidance,
 * since other parts of the system cite those sections by name.
 */
export const operationalRulesRename: Migration = {
  id: "8.761.0-operational-rules-rename",
  introducedIn: "8.761.0",
  title: "Move CONFIG/OPERATIONAL_RULES.md into CONFIG/OPERATIONAL_PREFERENCES.md",
  run(ctx) {
    const rules = readIf(join(ctx.userDir, RULES_REL));
    if (rules === null) return { changed: false, notes: ["no OPERATIONAL_RULES.md"] };
    if (!isUserWritten(rules, null) && splitFrontmatter(rules).fm.provenance === "template") {
      return { changed: false, notes: ["OPERATIONAL_RULES.md is an unedited template; left in place"] };
    }
    const tpl = readIf(ctx.templateDir && join(ctx.templateDir, PREFS_REL));
    const existing = readIf(join(ctx.userDir, PREFS_REL));
    const keepExisting = existing !== null && isUserWritten(existing, tpl);
    const notes: string[] = [];

    const ruleParts = h2Sections(splitFrontmatter(rules).body);
    const base = keepExisting ? existing! : rules;
    const fmBlock = keepExisting
      ? existing!.match(/^---\n[\s\S]*?\n---\n?/)?.[0] ?? ""
      : `---\nprovenance: customized\nlast_updated: ${ctx.now}\nlast_updated_by: ${operationalRulesRename.id}\nconvention: lifeos-freshness-v1\n---\n`;
    const parsed = keepExisting ? h2Sections(splitFrontmatter(base).body) : ruleParts;
    const preamble = parsed.preamble.replace(/OPERATIONAL_RULES\.md/g, "OPERATIONAL_PREFERENCES.md").replace(/\s+$/, "");

    if (keepExisting) {
      for (const s of ruleParts.sections) {
        const sec = parsed.sections.find((x) => sameSection(x.key, s.key));
        if (!sec) { parsed.sections.push(s); notes.push(`added section "${s.title}"`); }
        else if (!normalize(sec.body).includes(normalize(s.body))) {
          sec.body = `${sec.body}\n\n<!-- merged from ${RULES_REL} by migration ${operationalRulesRename.id} -->\n${s.body}`;
          notes.push(`appended to section "${sec.title}"`);
        }
      }
    } else {
      notes.push(`moved ${ruleParts.sections.length} sections from OPERATIONAL_RULES.md`);
    }
    if (tpl) {
      for (const t of h2Sections(splitFrontmatter(tpl).body).sections) {
        if (parsed.sections.some((x) => sameSection(x.key, t.key))) continue;
        parsed.sections.push(t);
        notes.push(`added shipped section "${t.title}"`);
      }
    }

    const result = `${fmBlock}${preamble}\n\n${parsed.sections.map((x) => `## ${x.title}\n\n${x.body.replace(/^\n+/, "")}`.trimEnd()).join("\n\n")}\n`;
    ctx.effects.write(PREFS_REL, result);
    ctx.effects.retire(RULES_REL);
    notes.push(`moved ${RULES_REL} into the backup`);
    return { changed: true, notes };
  },
};

/** The ledger. Append only; never reorder or renumber an id that has shipped. */
export const MIGRATIONS: readonly Migration[] = [telosConsolidate, operationalRulesRename];
