/**
 * Pinboard 수정 / 삭제 as pure text transforms (`01 Pinboard/AGENTS.md`):
 * - goal note: frontmatter fields shown on the card, the H1, the user's 「왜 이 목표인가」 /
 *   「달성한 모습」, `progress` recomputed, `updated` (「6. 속성」);
 * - Main Goal after a Sub Goal is deleted: its link line and `sub_total` / `sub_achieved` /
 *   `progress` (「3-4」 3);
 * - `Pinboard Index.md`: title / due / path / progress cells, row removal, 「미정·확인 필요」 lines
 *   of a removed id (「8. 인덱스 규칙」);
 * - `## 진척 기록` lines: edit / delete one entry.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { spliceLine } from "../line-edit.ts";
import { splitLinesKeepEol, stripEol } from "../parser.ts";
import { getFmList, getFmValue, setFmList, setFmValue, yamlScalar } from "../projects/ops.ts";
import { findSection, getSectionContent, locateLine, replaceSectionContent, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { PROGRESS_SECTION } from "./index-writer.ts";
import { computeSubProgress, type Goal, parseFrontmatterText, parseGoal, type Rollup } from "./model.ts";

export const WHY_SECTION = "왜 이 목표인가";
export const VISION_SECTION = "달성한 모습";
export const SUBS_SECTION = "Sub Goal (측정 기준)";
export const UNDECIDED_SECTION = "미정·확인 필요";

/** Fields of a goal the card shows and the 수정 dialog edits. `undefined` = keep. */
export interface GoalChange {
	title?: string;
	area?: string;
	/** Main Goal body sections: one item per line. */
	why?: string;
	vision?: string;
	measure?: string;
	kind?: string;
	baseline?: string;
	target?: string;
	unit?: string;
	/** `YYYY-MM-DD` or "". */
	due?: string;
}

/** Frontmatter value: numbers stay numbers, the rest is YAML-quoted when needed, "" = empty. */
export function fmScalar(v: string): string {
	const s = v.trim();
	if (/^-?\d+(\.\d+)?$/.test(s)) return s;
	return yamlScalar(s);
}

/** Lines typed in a textarea → `- item` lines (existing bullets kept, blanks dropped). */
export function toBullets(s: string): string {
	return s
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => (/^[-*+]\s/.test(l) ? l : `- ${l}`))
		.join("\n");
}

/** Section items as editable text (one per line, bullet markers removed). */
export function sectionAsLines(text: string, name: string): string {
	const c = getSectionContent(text, name) ?? "";
	return c
		.replace(/<!--[\s\S]*?-->/g, "")
		.split("\n")
		.map((l) => l.replace(/^\s*[-*+]\s?/, "").trim())
		.filter(Boolean)
		.join("\n");
}

/** Replace the `# title` line when it is the old title. */
function setH1(text: string, oldTitle: string, title: string): string {
	const lines = splitLinesKeepEol(text);
	for (let i = 0; i < lines.length; i++) {
		const s = stripEol(lines[i]);
		if (s.trim() === `# ${oldTitle}`) {
			lines[i] = `# ${title}` + lines[i].slice(s.length);
			return lines.join("");
		}
	}
	return text;
}

const FM_KEYS: [keyof GoalChange, string][] = [
	["title", "title"],
	["area", "area"],
	["measure", "measure"],
	["kind", "kind"],
	["baseline", "baseline"],
	["target", "target"],
	["unit", "unit"],
	["due", "due"],
];

/**
 * Apply a 수정 to a goal note. Only the changed keys / sections are rewritten; a Sub Goal's
 * `progress` is recomputed when its numbers or measure change (never invented: kept when not
 * computable). Returns the new text and the goal as it is now.
 */
export function editGoalNote(text: string, path: string, c: GoalChange, today: string): { text: string; goal: Goal | null } {
	const before = parseGoal(parseFrontmatterText(text).data, path);
	let out = text;
	for (const [k, key] of FM_KEYS) {
		const v = c[k];
		if (v === undefined || v.trim() === getFmValue(out, key)) continue;
		out = setFmValue(out, key, fmScalar(v));
	}
	if (c.title !== undefined && before && c.title.trim() !== before.title) out = setH1(out, before.title, c.title.trim());
	if (c.why !== undefined && c.why.trim() !== sectionAsLines(out, WHY_SECTION)) out = replaceSectionContent(out, WHY_SECTION, toBullets(c.why));
	if (c.vision !== undefined && c.vision.trim() !== sectionAsLines(out, VISION_SECTION)) out = replaceSectionContent(out, VISION_SECTION, toBullets(c.vision));
	let goal = parseGoal(parseFrontmatterText(out).data, path);
	if (goal?.type === "sub-goal") {
		const p = computeSubProgress(goal);
		if (p !== null && p !== goal.progress) {
			out = setFmValue(out, "progress", String(p));
			goal = parseGoal(parseFrontmatterText(out).data, path);
		}
	}
	if (out !== text) out = setFmValue(out, "updated", today);
	return { text: out, goal: parseGoal(parseFrontmatterText(out).data, path) ?? goal };
}

/** `[[old]]`, `[[old|…]]`, `[[old#…]]` (also with a folder prefix) → the new base name. */
export function renameLinks(text: string, oldBase: string, newBase: string): string {
	if (oldBase === newBase) return text;
	const esc = oldBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`\\[\\[((?:[^\\]|#]*/)?)${esc}(?=[\\]|#])`, "g"), (_m, dir: string) => `[[${dir}${newBase}`);
}

/** Remove the list lines in `## section` that link to `base`. */
export function removeLinkLines(text: string, section: string, base: string): string {
	const sec = findSection(text, section);
	if (!sec) return text;
	const r = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^\\s*[-*+]\\s.*\\[\\[(?:[^\\]|#]*/)?${esc}[\\]|#]`);
	for (let i = r.end - 1; i >= r.start; i--) if (re.test(stripEol(lines[i]))) lines.splice(i, 1);
	return lines.join("");
}

/** Main Goal after its Sub Goals changed: link line removed (optional), rollup and `updated`. */
export function applyMainRollup(text: string, r: Rollup, today: string, removedBase?: string): string {
	let out = removedBase ? removeLinkLines(text, SUBS_SECTION, removedBase) : text;
	out = setFmValue(out, "sub_total", String(r.subTotal));
	out = setFmValue(out, "sub_achieved", String(r.subAchieved));
	out = setFmValue(out, "progress", String(r.progress));
	return setFmValue(out, "updated", today);
}

/** Drop a project link from a Sub Goal (`projects` wikilink and `project_ids`), set `updated`. */
export function unlinkProject(text: string, projectId: string, hubBase: string, today: string): string {
	const ids = getFmList(text, "project_ids");
	const links = getFmList(text, "projects");
	const keepLinks = links.filter((l) => !(l.includes(`/${hubBase}]]`) || l.includes(`[[${hubBase}]]`) || l.includes(`/${hubBase}|`) || l.includes(`[[${hubBase}|`)));
	if (!ids.includes(projectId) && keepLinks.length === links.length) return text;
	let out = setFmList(text, "project_ids", ids.filter((x) => x !== projectId));
	out = setFmList(out, "projects", keepLinks);
	return setFmValue(out, "updated", today);
}

/** Add a project link to a Sub Goal (「3-6」 2): `projects` wikilink, `project_ids`, `updated`. */
export function linkProject(text: string, projectId: string, hubLink: string, today: string): string {
	const ids = getFmList(text, "project_ids");
	const links = getFmList(text, "projects");
	if (ids.includes(projectId)) return text;
	let out = setFmList(text, "project_ids", [...ids, projectId]);
	const base = hubLink.replace(/^\[\[|\]\]$/g, "").split("/").pop()!;
	const has = links.some((l) => l === hubLink || l.endsWith(`/${base}]]`) || l === `[[${base}]]`);
	if (!has) out = setFmList(out, "projects", [...links, hubLink]);
	return setFmValue(out, "updated", today);
}

// ───────────────────────── index ─────────────────────────

function splitCells(line: string): string[] {
	return line.split(/(?<!\\)\|/);
}
function isTableLine(s: string): boolean {
	return /^\s*\|/.test(s);
}

/** Cells of one index row by header name (only the given ones change). */
export interface IndexCells {
	id: string;
	title?: string;
	parent?: string;
	status?: string;
	path?: string;
	due?: string;
	progress?: string;
}

/** Set cells of rows in the `## {year}` table by header (`제목`, `parent`, `due`, …). */
export function setIndexCells(text: string, year: string, rows: IndexCells[]): { text: string; missing: string[] } {
	const sec = findSection(text, year);
	if (!sec) return { text, missing: rows.map((r) => r.id) };
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	let header: string[] | null = null;
	const found = new Set<string>();
	for (let i = range.start; i < range.end; i++) {
		const s = stripEol(lines[i]);
		if (!isTableLine(s)) continue;
		if (!header) {
			header = splitCells(s).map((c) => c.trim().toLowerCase());
			continue;
		}
		const parts = splitCells(s);
		const u = rows.find((r) => r.id === parts[1]?.trim());
		if (!u) continue;
		found.add(u.id);
		const col = (name: string) => header!.findIndex((h) => h === name || (name === "path" && (h.startsWith("baseline") || h.includes("→"))));
		const set = (name: string, v: string | undefined) => {
			const j = col(name);
			if (v === undefined || j < 0 || j >= parts.length) return;
			parts[j] = ` ${v.replace(/(?<!\\)\|/g, "\\|")} `;
		};
		set("제목", u.title);
		set("parent", u.parent);
		set("status", u.status);
		set("path", u.path);
		set("due", u.due);
		set("progress", u.progress);
		const next = parts.join("|");
		if (next !== s) lines[i] = next + lines[i].slice(s.length);
	}
	return { text: lines.join(""), missing: rows.map((r) => r.id).filter((id) => !found.has(id)) };
}

/** Remove the rows of `ids` from the `## {year}` table. */
export function removeIndexRows(text: string, year: string, ids: string[]): { text: string; removed: string[] } {
	const sec = findSection(text, year);
	if (!sec) return { text, removed: [] };
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const removed: string[] = [];
	for (let i = range.end - 1; i >= range.start; i--) {
		const s = stripEol(lines[i]);
		if (!isTableLine(s)) continue;
		const id = splitCells(s)[1]?.trim();
		if (id && ids.includes(id)) {
			lines.splice(i, 1);
			removed.push(id);
		}
	}
	return { text: lines.join(""), removed: removed.reverse() };
}

/** Remove `- {id}: …` lines from 「미정·확인 필요」 for ids that no longer exist. */
export function removeUndecidedLines(text: string, ids: string[]): string {
	const sec = findSection(text, UNDECIDED_SECTION);
	if (!sec) return text;
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	for (let i = range.end - 1; i >= range.start; i--) {
		const m = /^\s*[-*+]\s+(G-[\d.-]+)\s*:/.exec(stripEol(lines[i]));
		if (m && ids.includes(m[1])) lines.splice(i, 1);
	}
	return lines.join("");
}

/** `updated` of the index. */
export function touchIndex(text: string, today: string): string {
	return setFrontmatterScalar(text, "updated", today);
}

// ───────────────────────── 진척 기록 ─────────────────────────

export interface LogEntryRef {
	/** 0-based line index when rendered. */
	index: number;
	/** The line (no terminator) when rendered. */
	line: string;
}

export interface ProgressEntry extends LogEntryRef {
	/** The text after `- `. */
	text: string;
}

/** The list lines of `## 진척 기록`. */
export function progressEntries(text: string): ProgressEntry[] {
	const sec = findSection(text, PROGRESS_SECTION);
	if (!sec) return [];
	const r = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const out: ProgressEntry[] = [];
	let inComment = false;
	for (let i = r.start; i < r.end; i++) {
		const s = stripEol(lines[i]);
		if (inComment) {
			if (s.includes("-->")) inComment = false;
			continue;
		}
		if (s.trim().startsWith("<!--")) {
			inComment = !s.includes("-->");
			continue;
		}
		const m = /^\s*[-*+]\s+(.*\S)\s*$/.exec(s);
		if (m) out.push({ index: i, line: s, text: m[1] });
	}
	return out;
}

export type EntryResult = { ok: true; text: string } | { ok: false; reason: string };

function locateEntry(text: string, ref: LogEntryRef): { lines: string[]; idx: number } | null {
	const sec = findSection(text, PROGRESS_SECTION);
	if (!sec) return null;
	const lines = splitLinesKeepEol(text);
	const idx = locateLine(lines, { index: ref.index, line: ref.line, scope: sectionLineRange(text, sec) });
	return idx === -1 ? null : { lines, idx };
}

/** Rewrite one 진척 기록 line (`- {newText}`), keeping its marker and indentation. */
export function editProgressEntry(text: string, ref: LogEntryRef, newText: string): EntryResult {
	const t = newText.replace(/\s*\r?\n\s*/g, " ").trim();
	if (!t) return { ok: false, reason: "empty-text" };
	const l = locateEntry(text, ref);
	if (!l) return { ok: false, reason: "not-found" };
	const s = stripEol(l.lines[l.idx]);
	const prefix = /^\s*[-*+]\s+/.exec(s)![0];
	l.lines[l.idx] = prefix + t + l.lines[l.idx].slice(s.length);
	return { ok: true, text: l.lines.join("") };
}

/** Remove one 진척 기록 line. */
export function deleteProgressEntry(text: string, ref: LogEntryRef): EntryResult {
	const l = locateEntry(text, ref);
	if (!l) return { ok: false, reason: "not-found" };
	return { ok: true, text: spliceLine(l.lines, l.idx) };
}

/** File base name of a goal note: `{id} {title}` (「4. 파일 규칙」). */
export function goalBaseName(id: string, title: string): string {
	return `${id} ${title.trim()}`;
}
