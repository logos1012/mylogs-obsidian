/**
 * Pinboard 수정 / 삭제 as pure text transforms (`01 Pinboard/AGENTS.md`):
 * - goal note: frontmatter fields shown on the card, the H1, the user's 「왜 이 목표인가」 /
 *   「달성한 모습」, `progress` recomputed, `updated` (「6. 속성」);
 * - Main Goal after a Sub Goal is deleted: its link line and `sub_total` / `sub_achieved` /
 *   `progress` (「3-4」 3);
 * - `Pinboard Index.md`: title / due / path / progress cells, row removal, 「미정·확인 필요」 lines
 *   of a removed id (「8. 인덱스 규칙」);
 * - `## 진척 기록` lines: edit / delete one entry;
 * - 상태 / health / current / 진척 기록 from the goal panel (`applyGoalChange`, SPEC 1): Sub
 *   `progress` recomputed, `health` cleared when the goal ends, `## 종료 회고` added (SPEC 1-4).
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { spliceLine } from "../line-edit.ts";
import { splitLinesKeepEol, stripEol } from "../parser.ts";
import { getFmList, getFmValue, setFmList, setFmValue, yamlScalar } from "../projects/ops.ts";
import { detectEol, findSection, getSectionContent, locateLine, replaceSectionContent, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { appendProgressLog, PROGRESS_SECTION, type ProgressLineInput } from "./index-writer.ts";
import { computeSubProgress, type Goal, isEnded, parseFrontmatterText, parseGoal, parseInputValue, type Rollup } from "./model.ts";

export const WHY_SECTION = "왜 이 목표인가";
export const VISION_SECTION = "달성한 모습";
export const SUBS_SECTION = "Sub Goal (측정 기준)";
export const UNDECIDED_SECTION = "미정·확인 필요";
export const RETRO_SECTION = "종료 회고";

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
	/** Sub Goal weight (positive number) or "" (= 1). */
	weight?: string;
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
	["weight", "weight"],
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
		out = key === "weight" ? setFmValueAfter(out, key, fmScalar(v), "due") : setFmValue(out, key, fmScalar(v));
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

// ───────────────────────── 상태 · health · current · 진척 기록 ─────────────────────────

/** A change made from the goal panel. `undefined` = keep. */
export interface GoalFieldChange {
	/** Sub Goal `current` as typed (numbers are stored as numbers). */
	current?: string;
	status?: string;
	/** `on-track` / `at-risk` / `off-track` / "" (판단 없음). */
	health?: string;
	/** One 진척 기록 line to append. */
	log?: ProgressLineInput;
}

/**
 * Set a frontmatter scalar; a key the note doesn't have yet goes right after `after` (so `health`
 * sits next to `status`), else before the closing `---`. An empty value for a missing key adds nothing.
 */
export function setFmValueAfter(text: string, key: string, value: string, after: string): string {
	if (hasFmKey(text, key)) return setFmValue(text, key, value);
	if (!value) return text;
	const lines = splitLinesKeepEol(text);
	const end = frontmatterEndLine(lines);
	const re = new RegExp(`^${after.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
	for (let i = 1; i < end; i++) {
		if (re.test(stripEol(lines[i]))) {
			// Skip a block list under `after`.
			let j = i + 1;
			while (j < end && /^\s+-\s|^\s*-\s/.test(stripEol(lines[j]))) j++;
			lines.splice(j, 0, `${key}: ${value}${detectEol(text)}`);
			return lines.join("");
		}
	}
	return setFrontmatterScalar(text, key, value);
}

function frontmatterEndLine(lines: string[]): number {
	if (stripEol(lines[0] ?? "").trim() !== "---") return 0;
	for (let i = 1; i < lines.length; i++) if (stripEol(lines[i]).trim() === "---") return i;
	return 0;
}

function hasFmKey(text: string, key: string): boolean {
	const lines = splitLinesKeepEol(text);
	const end = frontmatterEndLine(lines);
	const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
	for (let i = 1; i < end; i++) if (re.test(stripEol(lines[i]))) return true;
	return false;
}

/** `current` as it goes into YAML: `1,500` → `1500`, text quoted when needed. */
export function currentScalar(raw: string): string {
	const v = parseInputValue(raw);
	return typeof v === "number" ? String(v) : fmScalar(v);
}

/** The empty `## 종료 회고` of SPEC 1-4 with 결과 filled in. */
export function retroSkeleton(status: string): string {
	return [`- 결과: ${status}`, "- 영향: ", "- 계획에서 벗어난 부분: ", "- 이루지 못한 이유: "].join("\n");
}

/**
 * A goal that ends gets `## 종료 회고` (at the bottom). When the section is there, only its
 * `- 결과:` line follows the new status; what the user wrote stays.
 */
export function ensureRetro(text: string, status: string): string {
	const sec = findSection(text, RETRO_SECTION);
	if (!sec) {
		const eol = detectEol(text);
		let base = text;
		if (base.length && !base.endsWith("\n")) base += eol;
		return `${base}${eol}## ${RETRO_SECTION}${eol}${retroSkeleton(status).split("\n").join(eol)}${eol}`;
	}
	const r = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	for (let i = r.start; i < r.end; i++) {
		const s = stripEol(lines[i]);
		const m = /^(\s*[-*+]\s+결과\s*:)(.*)$/.exec(s);
		if (!m) continue;
		const next = `${m[1]} ${status}`;
		if (next !== s) lines[i] = next + lines[i].slice(s.length);
		return lines.join("");
	}
	return text;
}

/**
 * Apply a panel change to one goal note (SPEC 1-1 … 1-4): `current` / `status` / `health`,
 * the Sub Goal's `progress` recomputed (kept when not computable), `health` emptied when the
 * status is a finished one, `## 종료 회고` added, the 진척 기록 line appended, `updated`.
 * Only the touched keys / lines change.
 */
export function applyGoalChange(text: string, path: string, c: GoalFieldChange, today: string): { text: string; before: Goal | null; goal: Goal | null } {
	const before = parseGoal(parseFrontmatterText(text).data, path);
	let out = text;
	if (c.current !== undefined && before?.type === "sub-goal") out = setFmValue(out, "current", currentScalar(c.current));
	if (c.status !== undefined && c.status !== before?.status) out = setFmValue(out, "status", c.status);
	let goal = parseGoal(parseFrontmatterText(out).data, path);
	const ended = goal ? isEnded(goal.status) : false;
	const health = ended ? "" : c.health;
	if (health !== undefined) out = setFmValueAfter(out, "health", health, "status");
	if (goal?.type === "sub-goal") {
		const p = computeSubProgress(goal);
		if (p !== null && p !== goal.progress) out = setFmValue(out, "progress", String(p));
	}
	if (c.status !== undefined && ended && c.status !== before?.status) out = ensureRetro(out, c.status);
	if (c.log) out = appendProgressLog(out, c.log);
	if (out !== text) out = setFmValue(out, "updated", today);
	goal = parseGoal(parseFrontmatterText(out).data, path);
	return { text: out, before, goal };
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
	let out = setFmList(text, "project_ids", [...new Set([...ids, projectId])]);
	const base = hubLink.replace(/^\[\[|\]\]$/g, "").split("/").pop()!;
	const has = links.some((l) => l === hubLink || l.endsWith(`/${base}]]`) || l === `[[${base}]]`);
	if (ids.includes(projectId) && has) return text;
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
	health?: string;
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
		set("health", u.health === undefined ? undefined : u.health || "—");
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
