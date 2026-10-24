/**
 * Pure text transforms for the Wall Calendar view (and its "send to Desk Calendar").
 *
 * Every function takes the full current file text and returns the new text (or a failure
 * reason). Only the affected lines change; everything else stays byte-for-byte identical.
 * The view wraps them in `app.vault.process`.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { findDaySection, LIST_LINE_RE, pad2, splitLinesKeepEol, stripEol, TASK_LINE_RE } from "../parser.ts";
import { detectEol, findSection, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { itemSortKey, type MonthSection, parseWallItem, parseWallYear, safeDate, splitWallBody, type WallItem } from "./parse.ts";

export type EditResult = { ok: true; text: string; line?: string } | { ok: false; reason: string };

/** Where a rendered line was: its month and exact content (index is a hint). */
export interface WallTarget {
	month: number;
	index: number;
	line: string;
}

// ───────────────────────── helpers ─────────────────────────

/** The month section, or null when its heading is missing. */
export function monthSection(text: string, year: number, month: number): MonthSection | null {
	const sec = parseWallYear(text, year).months[month - 1];
	return sec.headingIndex === -1 ? null : sec;
}

/** Find the target line inside its month section (index first, then nearest identical line). */
export function locateInMonth(lines: string[], sec: MonthSection, t: WallTarget): number {
	if (t.index >= sec.start && t.index < sec.end && stripEol(lines[t.index] ?? "") === t.line) return t.index;
	let best = -1;
	for (let i = sec.start; i < sec.end; i++) {
		if (stripEol(lines[i]) === t.line && (best === -1 || Math.abs(i - t.index) < Math.abs(best - t.index))) best = i;
	}
	return best;
}

/** Trailing run of tags / inline fields (` #회사 (goal:: x) #test`) at the end of a body. */
const TRAILING_META_RE = /(?:\s+(?:#[^\s#()[\],.]+|\(\s*[A-Za-z_][\w-]*\s*::[^)]*\)))+\s*$/;

/** Split a body into [content, trailing tags/fields]. */
export function splitTrailingMeta(body: string): [string, string] {
	const m = TRAILING_META_RE.exec(body);
	if (!m || m.index === 0) return [body.replace(/\s+$/, ""), ""];
	return [body.slice(0, m.index), body.slice(m.index).replace(/\s+$/, "")];
}

const TRAILING_TAGS_RE = /(?:\s+#[^\s#()[\],.]+)+\s*$/;

/** Insert ` piece` before the trailing tags (after any inline fields). */
export function insertBeforeMeta(body: string, piece: string): string {
	const m = TRAILING_TAGS_RE.exec(body);
	if (!m || m.index === 0) return `${body.replace(/\s+$/, "")} ${piece}`;
	return `${body.slice(0, m.index)} ${piece}${body.slice(m.index).replace(/\s+$/, "")}`;
}

interface Located {
	lines: string[];
	sec: MonthSection;
	idx: number;
	indent: string;
	marker: string;
	body: string;
	eol: string;
}

function locate(text: string, year: number, t: WallTarget): Located | { reason: string } {
	const sec = monthSection(text, year, t.month);
	if (!sec) return { reason: "no-month" };
	const lines = splitLinesKeepEol(text);
	const idx = locateInMonth(lines, sec, t);
	if (idx === -1) return { reason: "not-found" };
	const s = stripEol(lines[idx]);
	const lm = LIST_LINE_RE.exec(s);
	if (!lm) return { reason: "not-found" };
	return { lines, sec, idx, indent: lm[1], marker: lm[2], body: lm[3], eol: lines[idx].slice(s.length) };
}

function replaceLine(l: Located, body: string): EditResult {
	const line = `${l.indent}${l.marker} ${body}`;
	l.lines[l.idx] = line + l.eol;
	return { ok: true, text: l.lines.join(""), line };
}

/** Line index right after the last non-blank line of a body range (or after its heading). */
function afterLastNonBlank(lines: string[], headingIndex: number, r: { start: number; end: number }): number {
	for (let i = r.end - 1; i >= r.start; i--) if (stripEol(lines[i]).trim()) return i + 1;
	return headingIndex + 1;
}

// ───────────────────────── format a new line ─────────────────────────

export type NewKind = "task" | "event" | "note";

export interface NewItem {
	kind: NewKind;
	/** `MM/DD`, `MM/DD~MM/DD`, `MM/DD~DD`, optionally followed by ` HH:MM`. Empty = 이달 중. */
	date?: string;
	text: string;
}

const DATE_INPUT_RE = /^(\d{1,2})\/(\d{1,2})(?:\s*~\s*(?:(\d{1,2})\/)?(\d{1,2}))?(?:\s+(\d{1,2}:\d{2}(?:\s*~\s*\d{1,2}:\d{2})?))?$/;

/** Normalize a typed date to `MM/DD[~MM/DD][ HH:MM]`, checking it falls in year-month. */
export function normalizeDateInput(input: string, year: number, month: number): { ok: true; date: string } | { ok: false; reason: string } {
	const m = DATE_INPUT_RE.exec(input.trim());
	if (!m) return { ok: false, reason: "날짜는 MM/DD 형식으로 적어 주세요 (예: 11/14, 11/03~11/07)" };
	const sm = parseInt(m[1], 10);
	const sd = parseInt(m[2], 10);
	if (sm !== month) return { ok: false, reason: `${month}월 칸에는 ${month}월 날짜만 적을 수 있어요` };
	if (!safeDate(year, sm, sd)) return { ok: false, reason: `없는 날짜예요 (${sm}/${sd})` };
	let out = `${pad2(sm)}/${pad2(sd)}`;
	if (m[4]) {
		const em = m[3] ? parseInt(m[3], 10) : sm;
		const ed = parseInt(m[4], 10);
		const ey = em < sm ? year + 1 : year;
		if (!safeDate(ey, em, ed)) return { ok: false, reason: "기간의 끝 날짜가 올바르지 않아요" };
		out += `~${pad2(em)}/${pad2(ed)}`;
	}
	if (m[5]) out += ` ${m[5].replace(/\s+/g, "")}`;
	return { ok: true, date: out };
}

/** `- [ ] 11/14 text`, `- 11/03~11/07 text`, `- text #행사` (undated event), `- text` (note). */
export function formatNewLine(n: NewItem): string {
	const text = n.text.trim().replace(/\s+/g, " ");
	const date = n.kind === "note" ? "" : (n.date ?? "").trim();
	const head = date ? `${date} ` : "";
	if (n.kind === "task") return `- [ ] ${head}${text}`;
	if (n.kind === "event") return date || /(?:^|\s)#행사(?=\s|$)/.test(text) ? `- ${head}${text}` : `- ${text} #행사`;
	return `- ${text}`;
}

// ───────────────────────── insert in date order ─────────────────────────

/**
 * Insert a list line into `## YYYY-MM` in date order: before the first item that sorts after
 * it (undated items sort last), so an undated line goes at the very end of the month.
 */
export function insertIntoMonth(text: string, year: number, month: number, line: string): EditResult {
	const sec = monthSection(text, year, month);
	if (!sec) return { ok: false, reason: "no-month" };
	const lines = splitLinesKeepEol(text);
	const eol = detectEol(text);
	const lm = LIST_LINE_RE.exec(line);
	const key = itemSortKey(parseWallItem(lm ? lm[3].trim() : line, year, month));
	const listLines = sec.lines.filter((l) => LIST_LINE_RE.test(l.line) && !/^\s/.test(l.line));
	let at = -1;
	for (const l of listLines) {
		if (itemSortKey(l.item) > key) {
			at = l.index;
			break;
		}
	}
	if (at === -1) at = afterLastNonBlank(lines, sec.headingIndex, sec);
	// The line before the insertion point must end with a terminator.
	if (at > 0 && !/\n$/.test(lines[at - 1])) lines[at - 1] += eol;
	lines.splice(at, 0, line + eol);
	return { ok: true, text: lines.join(""), line };
}

// ───────────────────────── toggle / cancel ─────────────────────────

/** `[ ]` ↔ `[x]` on a Wall line (one character). */
export function toggleWallTask(text: string, year: number, t: WallTarget): EditResult {
	const l = locate(text, year, t);
	if ("reason" in l) return { ok: false, reason: l.reason };
	const s = stripEol(l.lines[l.idx]);
	const m = TASK_LINE_RE.exec(s);
	if (!m) return { ok: false, reason: "not-task" };
	const next = m[2] === " " ? "x" : m[2] === "x" || m[2] === "X" ? " " : null;
	if (next === null) return { ok: false, reason: "not-toggleable" };
	const line = m[1] + next + m[3];
	l.lines[l.idx] = line + l.eol;
	return { ok: true, text: l.lines.join(""), line };
}

/** Task: `[ ]`→`[-]` + `(why:: reason)`. */
export function cancelWallTask(text: string, year: number, t: WallTarget, why: string): EditResult {
	const l = locate(text, year, t);
	if ("reason" in l) return { ok: false, reason: l.reason };
	const cm = /^\[(.)\](\s+.*)?$/.exec(l.body);
	if (!cm) return { ok: false, reason: "not-task" };
	if (cm[1] !== " " && cm[1] !== "x" && cm[1] !== "X") return { ok: false, reason: "not-cancellable" };
	const reason = why.trim().replace(/[()]/g, "").replace(/\s+/g, " ");
	let body = "[-]" + (cm[2] ?? "");
	if (reason) body = insertBeforeMeta(body, `(why:: ${reason})`);
	return replaceLine(l, body);
}

/** Event: wrap the date + text (before trailing tags/fields) in `~~ ~~`. */
export function cancelWallEvent(text: string, year: number, t: WallTarget): EditResult {
	const l = locate(text, year, t);
	if ("reason" in l) return { ok: false, reason: l.reason };
	const it = parseWallItem(l.body.trim(), year, t.month);
	if (it.kind !== "event" || it.status !== "scheduled") return { ok: false, reason: "not-cancellable" };
	const [content, meta] = splitTrailingMeta(l.body);
	return replaceLine(l, `~~${content.trim()}~~${meta}`);
}

// ───────────────────────── move between months ─────────────────────────

/**
 * Change the leading date of a body to the target month (same day). Returns the new body,
 * the body unchanged when it has no date, or null when the day doesn't exist there
 * (then ask the user for a new date and use `replaceLeadingDate`).
 */
export function retargetDate(body: string, year: number, toMonth: number): string | null {
	const p = splitWallBody(body);
	if (!p.match) return body;
	const m = p.match;
	const sm = parseInt(m[1], 10);
	const sd = parseInt(m[2], 10);
	if (!safeDate(year, toMonth, sd)) return null;
	let date = `${pad2(toMonth)}/${pad2(sd)}`;
	if (m[4]) {
		const em0 = m[3] ? parseInt(m[3], 10) : sm;
		const em = ((((em0 - sm + toMonth - 1) % 12) + 12) % 12) + 1;
		const ed = parseInt(m[4], 10);
		const ey = em < toMonth ? year + 1 : year;
		if (!safeDate(ey, em, ed)) return null;
		date += `~${pad2(em)}/${pad2(ed)}`;
	}
	if (m[5]) date += ` ${m[5]}`;
	return rebuild(p, date);
}

/** Replace (or add) the leading date of a body. `date` is a normalized `MM/DD…` or "" to drop it. */
export function replaceLeadingDate(body: string, date: string): string {
	const p = splitWallBody(body);
	if (!p.match) {
		if (!date) return body;
		// Insert after the checkbox (and inside a leading strike).
		const cm = /^\[(.)\]\s+/.exec(body);
		const pre = cm ? cm[0] : "";
		const rest = body.slice(pre.length);
		if (rest.startsWith("~~")) return `${pre}~~${date} ${rest.slice(2)}`;
		return `${pre}${date} ${rest}`;
	}
	return rebuild(p, date);
}

function rebuild(p: ReturnType<typeof splitWallBody>, date: string): string {
	const trailing = /\s*$/.exec(p.match![0])?.[0] || " ";
	const head = date ? date + trailing : "";
	return p.checkbox + (p.strike ? "~~" : "") + head + p.rest;
}

/**
 * Move a line from its month to `toMonth` (same year file): remove it from the old section
 * and insert it into the new one in date order. `newDate` overrides the date (normalized
 * `MM/DD…`); otherwise the leading `MM/DD` month is adjusted. Fails with "need-date" when
 * the same day doesn't exist in the target month.
 */
export function moveWallItem(text: string, year: number, t: WallTarget, toMonth: number, newDate?: string): EditResult {
	if (toMonth === t.month && newDate === undefined) return { ok: false, reason: "same-month" };
	const l = locate(text, year, t);
	if ("reason" in l) return { ok: false, reason: l.reason };
	const body = newDate !== undefined ? replaceLeadingDate(l.body, newDate) : retargetDate(l.body, year, toMonth);
	if (body === null) return { ok: false, reason: "need-date" };
	const line = `${l.indent}${l.marker} ${body}`;
	l.lines.splice(l.idx, 1);
	let rest = l.lines.join("");
	// Removing the file's last line: drop the now-dangling terminator of the previous line.
	if (!l.eol && l.idx > 0 && l.idx === l.lines.length) rest = rest.replace(/\r?\n$/, "");
	return insertIntoMonth(rest, year, toMonth, line);
}

// ───────────────────────── send to Desk Calendar ─────────────────────────

export function deskLink(deskFolder: string, year: number, month: number): string {
	return `${deskFolder.replace(/\/+$/, "")}/${year}/${year}-${pad2(month)}`;
}

/** Mark a Wall line as sent: task `[ ]`→`[>]`, event stays plain; append `→ [[link]]`. */
export function markSentToDesk(text: string, year: number, t: WallTarget, link: string): EditResult {
	const l = locate(text, year, t);
	if ("reason" in l) return { ok: false, reason: l.reason };
	const it = parseWallItem(l.body.trim(), year, t.month);
	if (it.status !== "scheduled") return { ok: false, reason: "not-scheduled" };
	let body = l.body;
	if (it.kind === "task") body = body.replace(/^\[ \]/, "[>]");
	return replaceLine(l, insertBeforeMeta(body, `→ [[${link}]]`));
}

/**
 * The Desk Calendar line for a Wall item: date prefix dropped, time kept.
 * `- [ ] 10:00 text #tags (fields)` for a task, `- 14:00 text …` for an event. An event with
 * no time gets `#행사` so it stays an event. A range keeps its end as `(~MM/DD)`.
 * `(from:: Wall Calendar)` records the source (Wall Calendar `AGENTS.md`).
 */
export function deskLineFor(body: string, it: WallItem): string {
	const p = splitWallBody(body.trim());
	let rest = p.match ? (p.match[5] ? p.match[5] + " " : "") + p.rest : p.rest;
	const [content, meta] = splitTrailingMeta(rest.trim());
	let main = content.trim();
	if (it.end && it.end !== it.start) main += ` (~${it.end.slice(5, 7)}/${it.end.slice(8, 10)})`;
	if (it.kind === "event" && !it.time && !it.eventTag) main += " #행사";
	rest = insertBeforeMeta(main + meta, "(from:: Wall Calendar)");
	return it.kind === "task" ? `- [ ] ${rest}` : `- ${rest}`;
}

/**
 * Insert a line into a Desk Calendar month file: under `### YYYY-MM-DD` when `isoDate` is
 * given (after the day's last line), else at the end of `## 이달 중`.
 */
export function insertIntoDesk(text: string, line: string, isoDate: string | null, undatedSection = "이달 중"): EditResult {
	const lines = splitLinesKeepEol(text);
	const eol = detectEol(text);
	let at: number;
	if (isoDate) {
		const day = findDaySection(text, isoDate);
		if (!day.found) return { ok: false, reason: "no-day" };
		at = afterLastNonBlank(lines, day.headingIndex, { start: day.start, end: day.end });
	} else {
		const r = findSection(text, undatedSection);
		if (!r) return { ok: false, reason: "no-section" };
		at = afterLastNonBlank(lines, r.headingIndex, sectionLineRange(text, r));
	}
	if (at > 0 && !/\n$/.test(lines[at - 1])) lines[at - 1] += eol;
	lines.splice(at, 0, line + eol);
	return { ok: true, text: lines.join(""), line };
}

// ───────────────────────── index ─────────────────────────

/**
 * `Wall Calendar Index.md`: prepend `- YYYY-MM-DD: {what} (플러그인)` to `## 변경 기록` and set
 * frontmatter `updated`.
 * TODO(MyLogs Plugin 계획.md 「결정할 것」 1): regenerate the summary tables (연도별 요약,
 * 다가오는 일) — not attempted in v0.2.
 */
export function addIndexChange(text: string, today: string, what: string): string {
	const eol = detectEol(text);
	const entry = `- ${today}: ${what.replace(/\s+/g, " ").trim()} (플러그인)`;
	let out: string;
	const r = findSection(text, "변경 기록");
	if (r) {
		const lines = splitLinesKeepEol(text);
		const range = sectionLineRange(text, r);
		let first = -1;
		for (let i = range.start; i < range.end; i++) {
			if (stripEol(lines[i]).trim()) {
				first = i;
				break;
			}
		}
		if (first !== -1) lines.splice(first, 0, entry + eol);
		else {
			if (!/\n$/.test(lines[r.headingIndex])) lines[r.headingIndex] += eol;
			lines.splice(r.headingIndex + 1, 0, eol, entry + eol);
		}
		out = lines.join("");
	} else {
		out = text;
		if (out.length && !out.endsWith("\n")) out += eol;
		out += `${eol}## 변경 기록${eol}${eol}${entry}${eol}`;
	}
	return setFrontmatterScalar(out, "updated", today);
}
