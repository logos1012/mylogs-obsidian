/**
 * Diary registry (`Diary Index.md`) transforms, following `09 Diary/AGENTS.md` 「4-4」「4-5」:
 * - on save / create: upsert the entry's 「엔트리」 row (date · time · title · tags · starred · 파일)
 *   and recompute 「월별」 (달 · 엔트리 · 쓴 날). No 「변경 기록」 line (매일 쓰는 것이라 늘어난다).
 * - on delete: remove the row, recompute 「월별」, one 「변경 기록」 line `삭제 「제목」 (날짜)`.
 *
 * Every function is a pure `text → text` transform and leaves the bytes it isn't about as they
 * were. Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { splitLinesKeepEol, stripEol } from "../parser.ts";
import { prependChangeLog } from "../pinboard/index-writer.ts";
import { detectEol, findSection, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { type DiaryEntry, displayTitle } from "./model.ts";

export const ENTRIES_TABLE = "엔트리";
export const MONTHS_TABLE = "월별";
export const STAR = "★";

export interface EntryRow {
	date: string;
	time: string;
	title: string;
	/** `a, b`. */
	tags: string;
	/** `★` or "". */
	starred: string;
	/** The 파일 cell as written (`[[path\|name]]`). */
	fileCell: string;
	/** Link target of the 파일 cell (path without `.md`). */
	target: string;
}

export interface MonthRow {
	month: string;
	entries: number;
	days: number;
}

// ───────────────────────── table helpers ─────────────────────────

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n\s*/g, " ").trim();
}
export function cellText(v: string): string {
	return oneLine(v).replace(/(?<!\\)\|/g, "\\|");
}
function splitRow(line: string): string[] {
	const parts = line.split(/(?<!\\)\|/);
	return parts.slice(1, parts.length - 1).map((c) => c.trim());
}
function isTableLine(s: string): boolean {
	return /^\s*\|/.test(s);
}
function isSeparator(s: string): boolean {
	return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(s);
}

interface TableInfo {
	headers: string[];
	sep: number;
	rows: number[];
}

function readTable(lines: string[], start: number, end: number): TableInfo | null {
	let header = -1;
	for (let i = start; i < end; i++) {
		const s = stripEol(lines[i]);
		if (header === -1) {
			if (isTableLine(s)) header = i;
			continue;
		}
		if (!isSeparator(s)) return null;
		const info: TableInfo = { headers: splitRow(stripEol(lines[header])), sep: i, rows: [] };
		for (let j = i + 1; j < end && isTableLine(stripEol(lines[j])); j++) info.rows.push(j);
		return info;
	}
	return null;
}

function tableOf(text: string, name: string): { lines: string[]; t: TableInfo } | null {
	const sec = findSection(text, name);
	if (!sec) return null;
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const t = readTable(lines, range.start, range.end);
	return t ? { lines, t } : null;
}

/** Link target of a `[[target\|alias]]` / `[[target]]` cell ("" when it is not a link). */
export function linkTarget(cell: string): string {
	const m = /\[\[([^\]|\\]+)(?:\\?\|[^\]]*)?\]\]/.exec(cell);
	return m ? m[1].trim() : "";
}

/** The 파일 cell of an entry: `[[09 Diary/2026/2026-01/2026-01-09 2210\|2026-01-09 2210]]`. */
export function fileCellOf(path: string): string {
	const target = path.replace(/\.md$/i, "");
	return `[[${target}\\|${target.replace(/^.*\//, "")}]]`;
}

// ───────────────────────── read ─────────────────────────

const ENTRY_COLS = ["date", "time", "title", "tags", "starred", "파일"] as const;

export function parseEntryRows(text: string): EntryRow[] {
	const tb = tableOf(text, ENTRIES_TABLE);
	if (!tb) return [];
	const idx = (h: string) => tb.t.headers.indexOf(h);
	const col = Object.fromEntries(ENTRY_COLS.map((c) => [c, idx(c)])) as Record<(typeof ENTRY_COLS)[number], number>;
	const get = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? "").replace(/\\\|/g, "|") : "");
	return tb.t.rows.map((i) => {
		const cells = splitRow(stripEol(tb.lines[i]));
		const fileCell = col.파일 >= 0 ? (cells[col.파일] ?? "") : "";
		return {
			date: get(cells, col.date),
			time: get(cells, col.time),
			title: get(cells, col.title),
			tags: get(cells, col.tags),
			starred: get(cells, col.starred),
			fileCell,
			target: linkTarget(fileCell),
		};
	});
}

export function parseMonthRows(text: string): MonthRow[] {
	const tb = tableOf(text, MONTHS_TABLE);
	if (!tb) return [];
	return tb.t.rows.map((i) => {
		const c = splitRow(stripEol(tb.lines[i]));
		return { month: c[0] ?? "", entries: +(c[1] ?? 0) || 0, days: +(c[2] ?? 0) || 0 };
	});
}

/** The row an entry file says it should have. */
export function entryRowOf(e: DiaryEntry): EntryRow {
	const fileCell = fileCellOf(e.path);
	return { date: e.date, time: e.time, title: e.title, tags: e.tags.join(", "), starred: e.starred ? STAR : "", fileCell, target: linkTarget(fileCell) };
}

// ───────────────────────── write ─────────────────────────

export type RegistryResult = { ok: true; text: string; added: boolean } | { ok: false; reason: string };

function entryLine(headers: string[], r: EntryRow): string {
	const v: Record<string, string> = { date: r.date, time: r.time, title: cellText(r.title), tags: cellText(r.tags), starred: r.starred, 파일: r.fileCell };
	return `| ${headers.map((h) => v[h] ?? "").join(" | ")} |`;
}

function rowKey(r: Pick<EntryRow, "date" | "time" | "target">): string {
	return `${r.date} ${r.time} ${r.target}`;
}

/**
 * Update the entry's 「엔트리」 row (matched by the 파일 link target), or insert it in date·time
 * order. Only that line changes.
 */
export function upsertEntryRow(text: string, row: EntryRow): RegistryResult {
	const tb = tableOf(text, ENTRIES_TABLE);
	if (!tb) return { ok: false, reason: `등록부에 「${ENTRIES_TABLE}」 표가 없어요` };
	const { lines, t } = tb;
	const fileCol = t.headers.indexOf("파일");
	if (fileCol === -1) return { ok: false, reason: "「엔트리」 표에 파일 열이 없어요" };
	const eol = detectEol(text);
	const line = entryLine(t.headers, row);
	for (const i of t.rows) {
		const s = stripEol(lines[i]);
		if (linkTarget(splitRow(s)[fileCol] ?? "") !== row.target) continue;
		if (line !== s) lines[i] = line + lines[i].slice(s.length);
		return { ok: true, text: lines.join(""), added: false };
	}
	// Insert before the first row that sorts after it (rows kept in date·time order).
	let at = t.rows.length ? t.rows[t.rows.length - 1] : t.sep;
	for (const i of t.rows) {
		const cells = splitRow(stripEol(lines[i]));
		const other = { date: cells[t.headers.indexOf("date")] ?? "", time: cells[t.headers.indexOf("time")] ?? "", target: linkTarget(cells[fileCol] ?? "") };
		if (rowKey(other) > rowKey(row)) {
			at = i - 1;
			break;
		}
	}
	if (!/\n$/.test(lines[at])) lines[at] += eol;
	lines.splice(at + 1, 0, line + eol);
	return { ok: true, text: lines.join(""), added: true };
}

/** Remove the row whose 파일 link points at `path` (with or without `.md`). */
export function removeEntryRow(text: string, path: string): { text: string; removed: boolean } {
	const tb = tableOf(text, ENTRIES_TABLE);
	if (!tb) return { text, removed: false };
	const fileCol = tb.t.headers.indexOf("파일");
	const target = path.replace(/\.md$/i, "");
	const i = tb.t.rows.find((j) => linkTarget(splitRow(stripEol(tb.lines[j]))[fileCol] ?? "") === target);
	if (i === undefined) return { text, removed: false };
	tb.lines.splice(i, 1);
	return { text: tb.lines.join(""), removed: true };
}

/** 「월별」 from the 「엔트리」 rows: 달 · 엔트리 · 쓴 날 (distinct dates), oldest month first. */
export function monthRowsOf(rows: Pick<EntryRow, "date">[]): MonthRow[] {
	const m = new Map<string, { n: number; days: Set<string> }>();
	for (const r of rows) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
		const k = r.date.slice(0, 7);
		const v = m.get(k) ?? { n: 0, days: new Set<string>() };
		v.n++;
		v.days.add(r.date);
		m.set(k, v);
	}
	return [...m]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([month, v]) => ({ month, entries: v.n, days: v.days.size }));
}

/** Rewrite the 「월별」 table body from the current 「엔트리」 rows (header and separator kept). */
export function recomputeMonths(text: string): RegistryResult {
	const tb = tableOf(text, MONTHS_TABLE);
	if (!tb) return { ok: false, reason: `등록부에 「${MONTHS_TABLE}」 표가 없어요` };
	const { lines, t } = tb;
	const eol = detectEol(text);
	const want = monthRowsOf(parseEntryRows(text)).map((r) => `| ${r.month} | ${r.entries} | ${r.days} |`);
	const have = t.rows.map((i) => stripEol(lines[i]));
	if (want.join("\n") === have.join("\n")) return { ok: true, text, added: false };
	if (!/\n$/.test(lines[t.sep])) lines[t.sep] += eol;
	lines.splice(t.sep + 1, t.rows.length, ...want.map((l) => l + eol));
	return { ok: true, text: lines.join(""), added: want.length > have.length };
}

/** 「4-4」 on save / create: the row and the 「월별」 counts; `updated` only when something changed. No 변경 기록. */
export function registerEntry(text: string, e: DiaryEntry, today: string): RegistryResult {
	const r = upsertEntryRow(text, entryRowOf(e));
	if (!r.ok) return r;
	const m = recomputeMonths(r.text);
	if (!m.ok) return m;
	const out = m.text === text ? text : setFrontmatterScalar(m.text, "updated", today);
	return { ok: true, text: out, added: r.added };
}

/** 「4-5」: the row leaves, 「월별」 is recomputed, one `삭제 「제목」 (날짜)` line goes to 「변경 기록」. */
export function unregisterEntry(text: string, e: Pick<DiaryEntry, "path" | "title" | "date">, today: string): RegistryResult {
	const r = removeEntryRow(text, e.path);
	const m = recomputeMonths(r.text);
	const base = m.ok ? m.text : r.text;
	const out = setFrontmatterScalar(prependChangeLog(base, today, deleteLogText(e)), "updated", today);
	return { ok: true, text: out, added: false };
}

export function deleteLogText(e: Pick<DiaryEntry, "title" | "date">): string {
	return `삭제 「${oneLine(displayTitle(e))}」 (${e.date})`;
}
