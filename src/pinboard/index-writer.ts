/**
 * Pure text transforms for Pinboard writes:
 * - `Pinboard Index.md`: rewrite single table cells of known rows, prepend a 변경 기록 line,
 *   set `updated` (AGENTS.md 「인덱스 규칙」); add the `health` column (after `status`) to a
 *   year table written before it existed.
 * - goal note body: append a line under `## 진척 기록` (SPEC 1-3 format).
 *
 * Everything outside the touched cells / lines stays byte-for-byte identical.
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { splitLinesKeepEol, stripEol } from "../parser.ts";
import { appendToSection, detectEol, findSection, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { type Goal, toNum, type Verify } from "./model.ts";

export const INDEX_FILE = "Pinboard Index.md";
export const PROGRESS_SECTION = "진척 기록";
export const CHANGELOG_SECTION = "변경 기록";

/** New values for one index row. Omitted fields are left as they are. */
export interface RowUpdate {
	id: string;
	status?: string;
	/** `on-track` / `at-risk` / `off-track`, or "" (written as `—`). */
	health?: string;
	/** Full `progress` cell, e.g. `40%` or `50% (1/2)`. */
	progress?: string;
	/** New `current` token; replaces the middle of `a → b → c` and keeps the rest as written. */
	current?: string;
	/** Full `baseline → current → target` cell, used when the existing cell can't be split. */
	path?: string;
}

export interface IndexEdit {
	year: string;
	rows: RowUpdate[];
	/** One 변경 기록 line without the `- date: ` prefix, e.g. `G-2026-02.1 current 100 → 98 (플러그인)`. */
	log?: string;
	today: string;
}

export interface IndexResult {
	text: string;
	/** Ids whose row wasn't found in the year table. */
	missing: string[];
}

const ARROW = " → ";

/** Index token for a value: raw number/text, or `?` (metric) / `—` (milestone) when empty. */
export function indexToken(v: string, measure: string): string {
	const s = v.trim();
	if (s) return s;
	return measure === "metric" ? "?" : "—";
}

/** The full `baseline → current → target unit` cell for a Sub Goal. */
export function indexPathCell(g: Pick<Goal, "baseline" | "current" | "target" | "unit" | "measure">): string {
	const unit = g.unit.trim() && toNum(g.target) !== null ? ` ${g.unit.trim()}` : "";
	return [indexToken(g.baseline, g.measure), indexToken(g.current, g.measure), indexToken(g.target, g.measure) + unit].join(ARROW);
}

/** The `health` cell: the value, or `—` when there is no judgement. */
export function indexHealthCell(health: string): string {
	return health.trim() || "—";
}

export function indexProgressCell(progress: number, rollup?: { subAchieved: number; subTotal: number }): string {
	const p = `${Math.round(progress)}%`;
	return rollup ? `${p} (${rollup.subAchieved}/${rollup.subTotal})` : p;
}

/** Split a markdown table line on unescaped pipes. */
function splitCells(line: string): string[] {
	return line.split(/(?<!\\)\|/);
}

function isTableLine(s: string): boolean {
	return /^\s*\|/.test(s);
}

/** Column positions (in `splitCells` parts) of the cells we rewrite, from the header row. */
function headerColumns(header: string): { status: number; health: number; path: number; progress: number } {
	const parts = splitCells(header).map((c) => c.trim().toLowerCase());
	return {
		status: parts.indexOf("status"),
		health: parts.indexOf("health"),
		path: parts.findIndex((c) => c.startsWith("baseline") || /→/.test(c)),
		progress: parts.indexOf("progress"),
	};
}

function setCell(parts: string[], idx: number, value: string): void {
	if (idx < 0 || idx >= parts.length) return;
	const old = parts[idx];
	const lead = /^\s*/.exec(old)?.[0] || " ";
	const trail = /\s*$/.exec(old)?.[0] || " ";
	parts[idx] = lead + value + trail;
}

function rewritePath(old: string, u: RowUpdate): string | null {
	const cur = old.trim();
	if (u.current !== undefined) {
		const segs = cur.split(/\s*→\s*/);
		if (segs.length === 3) return [segs[0], u.current, segs[2]].join(ARROW);
	}
	return u.path ?? null;
}

/** Rewrite the cells of the given rows inside `## {year}`. */
export function updateIndexRows(text: string, year: string, rows: RowUpdate[]): IndexResult {
	const sec = findSection(text, year);
	if (!sec) return { text, missing: rows.map((r) => r.id) };
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	let cols: ReturnType<typeof headerColumns> | null = null;
	const found = new Set<string>();
	for (let i = range.start; i < range.end; i++) {
		const s = stripEol(lines[i]);
		if (!isTableLine(s)) continue;
		if (!cols) {
			cols = headerColumns(s);
			continue;
		}
		const parts = splitCells(s);
		const id = parts[1]?.trim();
		const u = rows.find((r) => r.id === id);
		if (!u || found.has(u.id)) continue;
		found.add(u.id);
		if (u.status !== undefined) setCell(parts, cols.status, u.status);
		if (u.health !== undefined) setCell(parts, cols.health, indexHealthCell(u.health));
		if (u.progress !== undefined) setCell(parts, cols.progress, u.progress);
		if ((u.current !== undefined || u.path !== undefined) && cols.path >= 0) {
			const next = rewritePath(parts[cols.path] ?? "", u);
			if (next !== null) setCell(parts, cols.path, next);
		}
		const next = parts.join("|");
		if (next !== s) lines[i] = next + lines[i].slice(s.length);
	}
	return { text: lines.join(""), missing: rows.map((r) => r.id).filter((id) => !found.has(id)) };
}

/**
 * The year table without a `health` column gets one right after `status` (header `health`,
 * separator `---`, each row its goal's health from `healthOf`, `—` when unknown). Other cells and
 * lines stay byte-identical. No-op when the column is there or the table has no `status`.
 */
export function ensureHealthColumn(text: string, year: string, healthOf: (id: string) => string = () => ""): string {
	const sec = findSection(text, year);
	if (!sec) return text;
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	let col = -1;
	let row = 0;
	for (let i = range.start; i < range.end; i++) {
		const s = stripEol(lines[i]);
		if (!isTableLine(s)) {
			if (row > 0) break;
			continue;
		}
		const parts = splitCells(s);
		if (row === 0) {
			const names = parts.map((c) => c.trim().toLowerCase());
			if (names.includes("health")) return text;
			col = names.indexOf("status");
			if (col < 0) return text;
		}
		const cell = row === 0 ? " health " : row === 1 && /^\s*:?-+:?\s*$/.test(parts[col] ?? "") ? "---" : ` ${indexHealthCell(healthOf(parts[1]?.trim() ?? ""))} `;
		parts.splice(col + 1, 0, cell);
		lines[i] = parts.join("|") + lines[i].slice(s.length);
		row++;
	}
	return lines.join("");
}

/** Insert `- {date}: {entry}` as the first list item of `## 변경 기록` (most recent first). */
export function prependChangeLog(text: string, date: string, entry: string): string {
	const line = `- ${date}: ${entry}`;
	const sec = findSection(text, CHANGELOG_SECTION);
	if (!sec) return appendToSection(text, CHANGELOG_SECTION, line);
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const eol = /\r\n/.test(text) ? "\r\n" : "\n";
	for (let i = range.start; i < range.end; i++) {
		if (/^[-*+]\s/.test(stripEol(lines[i]))) {
			lines.splice(i, 0, line + eol);
			return lines.join("");
		}
	}
	return appendToSection(text, CHANGELOG_SECTION, line);
}

/** Apply the whole index update: rows, 변경 기록, frontmatter `updated`. */
export function applyIndexEdit(text: string, edit: IndexEdit): IndexResult {
	const r = updateIndexRows(text, edit.year, edit.rows);
	let out = r.text;
	if (edit.log) out = prependChangeLog(out, edit.today, edit.log);
	if (out !== text) out = setFrontmatterScalar(out, "updated", edit.today);
	return { text: out, missing: r.missing };
}

/** What the 「업데이트 추가」 form (or an AI) writes as one 진척 기록 line. */
export interface ProgressLineInput {
	date: string;
	text: string;
	/** The current value at that time (metric); "" = none. */
	value?: string;
	/** `on-track` / `at-risk` / `off-track`; "" = none. */
	health?: string;
	verify: Verify;
	/** "" → `사용자 보고 (대화, {date})` (root AGENTS 「5」 10). */
	evidence?: string;
}

/** The default 근거 when nothing is linked. */
export function defaultEvidence(date: string): string {
	return `사용자 보고 (대화, ${date})`;
}

/** `- YYYY-MM-DD: 내용 (value:: N) (health:: …) (보고됨) — 근거: …` (SPEC 1-3). */
export function progressLogLine(e: ProgressLineInput): string {
	const one = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();
	const value = (e.value ?? "").trim().replace(/,/g, "");
	const health = (e.health ?? "").trim();
	let line = `- ${e.date}: ${one(e.text)}`;
	if (value) line += ` (value:: ${value})`;
	if (health) line += ` (health:: ${health})`;
	return `${line} (${e.verify}) — 근거: ${one(e.evidence ?? "") || defaultEvidence(e.date)}`;
}

/** Sections a new `## 진척 기록` goes in front of (Main Goal notes made before the section existed). */
const LOG_BEFORE = ["리뷰 메모", "종료 회고", "메모"];

/**
 * Append a line at the end of `## 진척 기록`, touching nothing else. A note without the section
 * (an older Main Goal) gets it in front of 「리뷰 메모」 / 「종료 회고」 / 「메모」, else at the end.
 */
export function appendProgressLog(text: string, entry: ProgressLineInput): string {
	const line = progressLogLine(entry);
	if (findSection(text, PROGRESS_SECTION)) return appendToSection(text, PROGRESS_SECTION, line);
	for (const name of LOG_BEFORE) {
		const sec = findSection(text, name);
		if (!sec) continue;
		const eol = detectEol(text);
		const lines = splitLinesKeepEol(text);
		lines.splice(sec.headingIndex, 0, `## ${PROGRESS_SECTION}${eol}`, `${line}${eol}`, eol);
		return lines.join("");
	}
	return appendToSection(text, PROGRESS_SECTION, line);
}
