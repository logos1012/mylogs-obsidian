/**
 * Desk Calendar write operations (drag & drop allocation, let-go choices, index, Wall/Drawer).
 *
 * Every function is a pure `text → text` transform for ONE file. They touch only the lines they
 * are about and leave every other byte as it was. Lines are located by the index and content they
 * had when the view rendered them (inside the section they belong to); if the line is gone or
 * different, the transform fails instead of guessing, and the view re-renders.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { replaceContent, setFields, setLead, strikeContent, TIME_LEAD_RE } from "../line-edit.ts";
import { frontmatterEnd, splitLinesKeepEol, stripEol, TASK_LINE_RE } from "../parser.ts";
import { detectEol, findSection, locateLine, setFrontmatterScalar } from "../writer.ts";
import { type DeskItem, isoWeekNo, mmdd, mondayOf, monthKey, type MonthData, parseMonthFile } from "./model.ts";

export type EditResult = { ok: true; text: string } | { ok: false; reason: string };

const fail = (reason: string): EditResult => ({ ok: false, reason });

// ───────────────────────── single-line transforms ─────────────────────────

const LIST_PREFIX_RE = /^(\s*[-*+]\s+)(.*)$/;
const CHECKBOX_BODY_RE = /^\[(.)\](?:\s+(.*))?$/;
const WEEK_LIST_RE = /(\s*)(→|->)(\s*)(W\d{1,2}(?:\s*,\s*W\d{1,2})*)/;
const DATE_LIST_RE = /(\s*)(→|->)(\s*)(\d{1,2}\/\d{1,2}(?:\s*,\s*\d{1,2}\/\d{1,2})*)/;
const MOVED_FIELD_RE = /\(\s*moved\s*::\s*(\d*)\s*\)/;
/** Trailing tags and `(key:: value)` fields at the end of a body. */
const DECOR_RE = /^([\s\S]*?)((?:\s+(?:#[^\s#()[\],.]+|\(\s*[A-Za-z_][\w-]*\s*::[^)]*\)))*)(\s*)$/;

/** Split a body into content and its trailing tags/fields (`decor`). */
export function splitDecor(body: string): { head: string; decor: string; trail: string } {
	const m = DECOR_RE.exec(body)!;
	return { head: m[1], decor: m[2], trail: m[3] };
}

/** Insert `piece` (e.g. ` → W44`) at the end of the content, before the trailing tags/fields. */
export function insertBeforeDecor(body: string, piece: string): string {
	const { head, decor, trail } = splitDecor(body);
	return head.replace(/\s+$/, "") + piece + decor + trail;
}

function splitLine(line: string): { prefix: string; body: string } | null {
	const m = LIST_PREFIX_RE.exec(line);
	return m ? { prefix: m[1], body: m[2] } : null;
}

/** Apply a body transform to a list line, keeping its indentation and marker. */
function mapBody(line: string, fn: (body: string) => string): string {
	const p = splitLine(line);
	return p ? p.prefix + fn(p.body) : line;
}

export function setCheckbox(line: string, ch: string): string {
	const m = TASK_LINE_RE.exec(line);
	return m ? m[1] + ch + m[3] : line;
}

/** The text after the checkbox, e.g. `강의 1강 촬영 → 10/06 #test`. */
export function taskRest(line: string): string {
	const p = splitLine(line);
	if (!p) return line.trim();
	const cm = CHECKBOX_BODY_RE.exec(p.body);
	return cm ? (cm[2] ?? "") : p.body;
}

function collapse(s: string): string {
	return s.replace(/[ \t]{2,}/g, " ").trim();
}

/** Remove `→ W..` and `→ MM/DD, …` assignments from a body. */
export function stripAssign(body: string): string {
	return collapse(body.replace(WEEK_LIST_RE, " ").replace(DATE_LIST_RE, " "));
}

/** Add a week to `→ W..` (or append ` → Wnn`). Week numbers are written zero-padded. */
export function addWeekAssign(line: string, weekNo: number): string {
	const w = `W${String(weekNo).padStart(2, "0")}`;
	return mapBody(line, (body) => {
		const m = WEEK_LIST_RE.exec(body);
		if (m) {
			const list = m[4].split(",").map((x) => x.trim());
			if (list.some((x) => +x.slice(1) === weekNo)) return body;
			const next = [...list, w].join(", ");
			return body.slice(0, m.index) + m[1] + m[2] + m[3] + next + body.slice(m.index + m[0].length);
		}
		return insertBeforeDecor(body, ` → ${w}`);
	});
}

function sortDates(list: string[]): string[] {
	const months = new Set(list.map((x) => +x.split("/")[0]));
	const wrap = months.has(12) && months.has(1);
	const key = (x: string) => {
		const [m, d] = x.split("/").map((n) => +n);
		return (wrap && m === 1 ? 13 : m) * 100 + d;
	};
	return [...list].sort((a, b) => key(a) - key(b));
}

function sameMd(a: string, b: string): boolean {
	const [am, ad] = a.split("/").map((n) => +n);
	const [bm, bd] = b.split("/").map((n) => +n);
	return am === bm && ad === bd;
}

/** Rewrite the `→ MM/DD, …` list of a line. `fn` gets and returns the list (MM/DD strings). */
function editDateList(line: string, fn: (list: string[]) => string[]): string {
	return mapBody(line, (body) => {
		const m = DATE_LIST_RE.exec(body);
		const list = m ? m[4].split(",").map((x) => x.trim()) : [];
		const next = fn(list);
		if (m) {
			if (!next.length) return collapseEnds(body.slice(0, m.index) + body.slice(m.index + m[0].length));
			return body.slice(0, m.index) + m[1] + m[2] + m[3] + next.join(", ") + body.slice(m.index + m[0].length);
		}
		if (!next.length) return body;
		return insertBeforeDecor(body, ` → ${next.join(", ")}`);
	});
}

function collapseEnds(s: string): string {
	return s.replace(/[ \t]{2,}/g, " ").replace(/\s+$/, "");
}

/** Remove a week from `→ W..`; the arrow goes too when the list becomes empty. */
export function removeWeekAssign(line: string, weekNo: number): string {
	return mapBody(line, (body) => {
		const m = WEEK_LIST_RE.exec(body);
		if (!m) return body;
		const list = m[4].split(",").map((x) => x.trim()).filter((x) => +x.slice(1) !== weekNo);
		if (!list.length) return collapseEnds(body.slice(0, m.index) + body.slice(m.index + m[0].length));
		return body.slice(0, m.index) + m[1] + m[2] + m[3] + list.join(", ") + body.slice(m.index + m[0].length);
	});
}

/** Add a date (ISO) to an allocation line's `→ MM/DD` list, keeping it in date order. */
export function addDateAssign(line: string, iso: string): string {
	const md = mmdd(iso);
	return editDateList(line, (list) => (list.some((x) => sameMd(x, md)) ? list : sortDates([...list, md])));
}

/** Remove a date from the `→` list; the arrow goes too when the list becomes empty. */
export function removeDateAssign(line: string, iso: string): string {
	const md = mmdd(iso);
	return editDateList(line, (list) => list.filter((x) => !sameMd(x, md)));
}

/** Replace one date with another in the `→` list. */
export function replaceDateAssign(line: string, oldIso: string, newIso: string): string {
	const o = mmdd(oldIso);
	const n = mmdd(newIso);
	return editDateList(line, (list) => {
		const out = list.filter((x) => !sameMd(x, o));
		return out.some((x) => sameMd(x, n)) ? sortDates(out) : sortDates([...out, n]);
	});
}

/** The current `(moved:: n)` count of a line (0 if none). */
export function movedCount(line: string): number {
	const m = MOVED_FIELD_RE.exec(line);
	return m && m[1] ? parseInt(m[1], 10) : 0;
}

/** Set `(moved:: n)` in place, or add it at the end of the content. */
export function setMoved(line: string, n: number): string {
	return mapBody(line, (body) => {
		if (MOVED_FIELD_RE.test(body)) return body.replace(MOVED_FIELD_RE, `(moved:: ${n})`);
		return insertBeforeDecor(body, ` (moved:: ${n})`);
	});
}

/** `- [ ] X #t` → `- [>] X → target #t`, optionally with `(moved:: n)`. */
export function markMoved(line: string, target: string, moved?: number): string {
	let out = setCheckbox(line, ">");
	out = mapBody(out, (body) => insertBeforeDecor(stripAssignKeepCheckbox(body), ` → ${target}`));
	if (moved !== undefined) out = setMoved(out, moved);
	return out;
}

function stripAssignKeepCheckbox(body: string): string {
	const cm = CHECKBOX_BODY_RE.exec(body);
	if (!cm) return stripAssign(body);
	return `[${cm[1]}] ${stripAssign(cm[2] ?? "")}`;
}

/** Clean a free-text field value so it can't break the `(key:: value)` syntax. */
export function cleanFieldValue(s: string): string {
	return s.replace(/[\r\n]+/g, " ").replace(/[()]/g, "").replace(/\s{2,}/g, " ").trim();
}

/** `- [ ] X #t` → `- [-] X (why:: reason) #t`. */
export function markCancelled(line: string, why: string): string {
	const out = setCheckbox(line, "-");
	const w = cleanFieldValue(why);
	return w ? mapBody(out, (body) => insertBeforeDecor(body, ` (why:: ${w})`)) : out;
}

/** A fresh copy `- [ ] text #tags (fields)` of a task line, without any `→` assignment. */
export function copyTask(line: string, moved?: number): string {
	let out = `- [ ] ${stripAssign(taskRest(line))}`;
	if (moved !== undefined) out = setMoved(out, moved);
	return out;
}

// ───────────────────────── file structure ─────────────────────────

export type Where = { kind: "during" } | { kind: "alloc"; monday: string } | { kind: "day"; date: string };

export interface LineRef {
	/** 0-based index when rendered. */
	index: number;
	/** The line (no terminator) when rendered. */
	line: string;
	where: Where;
}

export function refOf(it: DeskItem): LineRef {
	const where: Where =
		it.section === "during" ? { kind: "during" } : it.section === "alloc" ? { kind: "alloc", monday: it.monday! } : { kind: "day", date: it.date! };
	return { index: it.index, line: it.line, where };
}

function isHeadingLine(s: string): boolean {
	return /^#{1,6}\s/.test(s.trim());
}

interface Range {
	heading: number;
	start: number;
	end: number;
}

/** The [start, end) body range under a section heading (until the next heading). */
function bodyRange(lines: string[], heading: number): Range {
	let end = lines.length;
	for (let j = heading + 1; j < lines.length; j++) {
		if (isHeadingLine(stripEol(lines[j]))) {
			end = j;
			break;
		}
	}
	return { heading, start: heading + 1, end };
}

function monthOfText(year: number, month: number) {
	return { year, month };
}

function findRange(text: string, lines: string[], ym: { year: number; month: number }, where: Where): Range | null {
	const data = parseMonthFile(text, ym.year, ym.month);
	let heading = -1;
	if (where.kind === "during") heading = data.duringHeadingIndex;
	else if (where.kind === "alloc") heading = data.weeks.get(where.monday)?.allocHeadingIndex ?? -1;
	else heading = data.dayHeadingIndex.get(where.date) ?? -1;
	return heading < 0 ? null : bodyRange(lines, heading);
}

/** Replace one rendered line, verifying it is still there (inside its section). */
export function editLine(text: string, year: number, month: number, ref: LineRef, fn: (line: string) => string): EditResult {
	const lines = splitLinesKeepEol(text);
	const r = findRange(text, lines, monthOfText(year, month), ref.where);
	if (!r) return fail("section-missing");
	const idx = locateLine(lines, { index: ref.index, line: ref.line, scope: { start: r.start, end: r.end } });
	if (idx === -1) return fail("line-changed");
	const cur = stripEol(lines[idx]);
	const next = fn(cur);
	lines[idx] = next + lines[idx].slice(cur.length);
	return { ok: true, text: lines.join("") };
}

/** Delete one rendered line (verified like `editLine`). */
export function removeLine(text: string, year: number, month: number, ref: LineRef): EditResult {
	const lines = splitLinesKeepEol(text);
	const r = findRange(text, lines, monthOfText(year, month), ref.where);
	if (!r) return fail("section-missing");
	const idx = locateLine(lines, { index: ref.index, line: ref.line, scope: { start: r.start, end: r.end } });
	if (idx === -1) return fail("line-changed");
	const hadEol = /\n$/.test(lines[idx]);
	lines.splice(idx, 1);
	// Removing the last line of a file without a final newline: drop the newline before it.
	if (!hadEol && idx > 0 && idx === lines.length) lines[idx - 1] = stripEol(lines[idx - 1]);
	return { ok: true, text: lines.join("") };
}

/** Insert `newLines` after the last non-blank line of a body range (or right after its heading). */
function insertInRange(text: string, lines: string[], r: Range, newLines: string[]): string {
	const eol = detectEol(text);
	let at = r.heading;
	for (let i = r.end - 1; i >= r.start; i--) {
		if (stripEol(lines[i]).trim()) {
			at = i;
			break;
		}
	}
	const prevHasEol = /\n$/.test(lines[at]);
	if (!prevHasEol) lines[at] = lines[at] + eol;
	const block = newLines.map((l, k) => (k === newLines.length - 1 && !prevHasEol ? l : l + eol));
	lines.splice(at + 1, 0, ...block);
	return lines.join("");
}

/** Append lines at the end of the 이번 주 box or a day section. */
export function appendLines(text: string, year: number, month: number, where: Where, newLines: string[]): EditResult {
	const lines = splitLinesKeepEol(text);
	const r = findRange(text, lines, monthOfText(year, month), where);
	if (!r) return fail("section-missing");
	return { ok: true, text: insertInRange(text, lines, r, newLines) };
}

/** Items (with current indices) of a section, for duplicate/pair checks inside a transform. */
export function sectionItems(text: string, year: number, month: number, where: Where): DeskItem[] {
	const data = parseMonthFile(text, year, month);
	if (where.kind === "during") return data.during;
	if (where.kind === "alloc") return data.weeks.get(where.monday)?.alloc ?? [];
	return data.days.get(where.date) ?? [];
}

/** Chain transforms; stops at the first failure. */
export function chain(text: string, ...steps: ((t: string) => EditResult)[]): EditResult {
	let cur = text;
	for (const s of steps) {
		const r = s(cur);
		if (!r.ok) return r;
		cur = r.text;
	}
	return { ok: true, text: cur };
}

export function touchUpdated(text: string, today: string): EditResult {
	return { ok: true, text: setFrontmatterScalar(text, "updated", today) };
}

// ───────────────────────── plans (one edit per file) ─────────────────────────

/** One file's part of an operation. `file` is a month key (`2026-10`) or a vault path for other files. */
export interface FileEdit {
	file: string;
	/** True when `file` is a month key of a Desk Calendar month file. */
	month: boolean;
	/** Create the file with this content when it doesn't exist (non-month files only). */
	create?: () => string;
	apply: (text: string) => EditResult;
}

export interface Plan {
	/** Human-readable summary for the index change log. */
	what: string;
	edits: FileEdit[];
}

function ymOf(key: string): { year: number; month: number } {
	return { year: +key.slice(0, 4), month: +key.slice(5, 7) };
}

/** Merge edits for the same file into one sequential edit (one atomic write per file). */
export function mergeEdits(edits: FileEdit[]): FileEdit[] {
	const out: FileEdit[] = [];
	for (const e of edits) {
		const prev = out.find((x) => x.file === e.file && x.month === e.month);
		if (!prev) {
			out.push({ ...e });
			continue;
		}
		const a = prev.apply;
		const b = e.apply;
		prev.apply = (t) => chain(t, a, b);
		prev.create = prev.create ?? e.create;
	}
	return out;
}

function monthEdit(key: string, today: string, ...steps: ((t: string, y: number, m: number) => EditResult)[]): FileEdit {
	const { year, month } = ymOf(key);
	return {
		file: key,
		month: true,
		apply: (t) => chain(t, ...steps.map((s) => (x: string) => s(x, year, month)), (x) => touchUpdated(x, today)),
	};
}

function finish(what: string, edits: FileEdit[]): Plan {
	return { what, edits: mergeEdits(edits) };
}

/**
 * DnD 1: 이달 중 item → a week's 이번 주 할 일. Adds `→ Wnn` to the original and appends a copy
 * (without the arrow) to the week's `### 이번 주` in `allocFile` (the file of the week's Monday).
 */
export function planAssignWeek(src: DeskItem, monday: string, weekNo: number, allocFile: string, today: string): Plan {
	const ref = refOf(src);
	const copy = copyTask(src.line);
	return finish(`이달 중 「${src.item.text}」 → W${String(weekNo).padStart(2, "0")} 배정`, [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => addWeekAssign(l, weekNo))),
		monthEdit(allocFile, today, (t, y, m) => {
			// Already in the box (same text): only the arrow is needed.
			if (sectionItems(t, y, m, { kind: "alloc", monday }).some((x) => x.key === src.key)) return { ok: true, text: t };
			return appendLines(t, y, m, { kind: "alloc", monday }, [copy]);
		}),
	]);
}

/** DnD 2: 이번 주 할 일 item → a day of the same week. Adds the date and appends a copy to the day. */
export function planAssignDay(src: DeskItem, date: string, today: string): Plan {
	const ref = refOf(src);
	const copy = copyTask(src.line);
	const dayFile = date.slice(0, 7);
	return finish(`이번 주 할 일 「${src.item.text}」 → ${mmdd(date)} 배정`, [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => addDateAssign(l, date))),
		monthEdit(dayFile, today, (t, y, m) => {
			const items = sectionItems(t, y, m, { kind: "day", date });
			if (items.some((x) => x.key === src.key && x.item.kind === "task" && x.item.status === "scheduled")) return { ok: true, text: t };
			return appendLines(t, y, m, { kind: "day", date }, [copy]);
		}),
	]);
}

/**
 * DnD 3 and 「다른 날」: the original becomes `[>] … → MM/DD (moved:: n+1)`, a copy with the same
 * count goes to the new day, and the paired allocation (if any, same week) swaps the old date for
 * the new one.
 */
export function planMoveDay(src: DeskItem, newDate: string, alloc: DeskItem | null, today: string): Plan {
	const ref = refOf(src);
	const n = movedCount(src.line) + 1;
	const copy = copyTask(src.line, n);
	const oldDate = src.date!;
	const edits: FileEdit[] = [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => markMoved(l, mmdd(newDate), n))),
		monthEdit(newDate.slice(0, 7), today, (t, y, m) => appendLines(t, y, m, { kind: "day", date: newDate }, [copy])),
	];
	if (alloc) {
		const aref = refOf(alloc);
		edits.push(monthEdit(alloc.file, today, (t, y, m) => editLine(t, y, m, aref, (l) => replaceDateAssign(l, oldDate, newDate))));
	}
	return finish(`「${src.item.text}」 ${mmdd(oldDate)} → ${mmdd(newDate)} 옮김 (moved:: ${n})`, edits);
}

/**
 * DnD 4: a day item back onto its week's 이번 주 할 일. Removes the day line and that date from the
 * paired allocation. A day-only item (no pair) is moved into the box as an unassigned item.
 */
export function planUnassign(src: DeskItem, alloc: DeskItem | null, monday: string, allocFile: string, today: string): Plan {
	const ref = refOf(src);
	const date = src.date!;
	const edits: FileEdit[] = [monthEdit(src.file, today, (t, y, m) => removeLine(t, y, m, ref))];
	if (alloc) {
		const aref = refOf(alloc);
		edits.push(monthEdit(alloc.file, today, (t, y, m) => editLine(t, y, m, aref, (l) => removeDateAssign(l, date))));
	} else {
		const copy = copyTask(src.line);
		edits.push(monthEdit(allocFile, today, (t, y, m) => appendLines(t, y, m, { kind: "alloc", monday }, [copy])));
	}
	return finish(`「${src.item.text}」 ${mmdd(date)} 배정 취소`, edits);
}

/** 「놓아주기」: `[-]` + `(why:: …)`. */
export function planLetGo(src: DeskItem, why: string, today: string): Plan {
	const ref = refOf(src);
	return finish(`「${src.item.text}」 놓아줌 (why:: ${cleanFieldValue(why)})`, [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => markCancelled(l, why))),
	]);
}

/** 「쪼개기」: `[>] … → 쪼갬` and the smaller tasks appended to the same day. */
export function planSplit(src: DeskItem, parts: string[], today: string): Plan {
	const ref = refOf(src);
	const date = src.date!;
	const lines = parts.map((p) => p.trim().replace(/^[-*+]\s+(\[.\]\s+)?/, "")).filter(Boolean).map((p) => `- [ ] ${p}`);
	return finish(`「${src.item.text}」 쪼갬 → ${lines.length}개`, [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => markMoved(l, "쪼갬")), (t, y, m) => appendLines(t, y, m, { kind: "day", date }, lines)),
	]);
}

/** 「서랍에」: `[>] … → Drawer` and `- [ ] text (from:: Desk Calendar YYYY-MM-DD) #tags` in the Drawer. */
export function planDrawer(src: DeskItem, drawerPath: string, today: string): Plan {
	const ref = refOf(src);
	const tags = src.item.tags.map((t) => ` #${t}`).join("") + (src.item.test ? " #test" : "");
	const line = `- [ ] ${src.item.text} (from:: Desk Calendar ${src.date})${tags}`;
	return finish(`「${src.item.text}」 서랍으로 (→ Drawer)`, [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => markMoved(l, "Drawer"))),
		{
			file: drawerPath,
			month: false,
			create: () => drawerSkeleton(today),
			apply: (t) => ({ ok: true, text: setFrontmatterScalar(appendAtEnd(t, line), "updated", today) }),
		},
	]);
}

/** 「미래로」: `[>] … → Wall Calendar (moved:: n+1)` and the line under `## YYYY-MM` in the Wall Calendar. */
export function planFuture(src: DeskItem, targetMonth: string, wallPath: string, today: string): Plan {
	const ref = refOf(src);
	const n = movedCount(src.line) + 1;
	const copy = copyTask(src.line, n);
	const year = +targetMonth.slice(0, 4);
	return finish(`「${src.item.text}」 미래로 → Wall Calendar ${targetMonth} (moved:: ${n})`, [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => markMoved(l, "Wall Calendar", n))),
		{
			file: wallPath,
			month: false,
			create: () => wallYearSkeleton(year, today),
			apply: (t) => ({ ok: true, text: setFrontmatterScalar(appendUnderWallMonth(t, targetMonth, copy), "updated", today) }),
		},
	]);
}

/** Toggle `[ ]` ↔ `[x]` of a day item (verified like the other edits). */
export function planToggle(src: DeskItem, today: string): Plan {
	const ref = refOf(src);
	const to = src.item.status === "done" ? " " : "x";
	return finish(`「${src.item.text}」 ${to === "x" ? "완료" : "완료 취소"}`, [
		monthEdit(src.file, today, (t, y, m) =>
			editLine(t, y, m, ref, (l) => {
				const mm = TASK_LINE_RE.exec(l);
				return mm && (mm[2] === " " || mm[2] === "x" || mm[2] === "X") ? setCheckbox(l, to) : l;
			}),
		),
	]);
}

// ───────────────────────── 수정 / 삭제 ─────────────────────────

/**
 * The copies paired with an item by the 3-step allocation (「3-3」: 짝은 내용 글자가 같은지로 맞춘다):
 * 이달 중 `→ Wnn` ↔ that week's 이번 주 line ↔ its `→ MM/DD` day lines. Excludes `src`.
 */
export function pairedCopies(src: DeskItem, months: Iterable<MonthData>): DeskItem[] {
	const all: DeskItem[] = [];
	for (const m of months) {
		all.push(...m.during);
		for (const w of m.weeks.values()) all.push(...(w.alloc ?? []));
		for (const d of m.days.values()) all.push(...d);
	}
	const same = (a: DeskItem, b: DeskItem) => a.file === b.file && a.index === b.index;
	const linked = (a: DeskItem, b: DeskItem): boolean => {
		if (a.key !== b.key) return false;
		const pair = (x: DeskItem, y: DeskItem) =>
			(x.section === "during" && y.section === "alloc" && !!y.monday && x.item.assignWeek.includes(isoWeekNo(y.monday))) ||
			(x.section === "alloc" && y.section === "day" && !!y.date && x.monday === y.monday && x.assign.includes(y.date));
		return pair(a, b) || pair(b, a);
	};
	const seen: DeskItem[] = [src];
	const queue = [src];
	while (queue.length) {
		const cur = queue.shift()!;
		for (const x of all) {
			if (seen.some((s) => same(s, x)) || !linked(cur, x)) continue;
			seen.push(x);
			queue.push(x);
		}
	}
	return seen.slice(1);
}

export interface DeskChange {
	/** New content text (copies follow: 한쪽 내용을 고치면 다른 쪽도 똑같이 고친다). */
	text?: string;
	/** New time (`HH:MM`, "" removes). This line only. */
	time?: string;
	/** goal / project follow to the copies; other fields (why, from, moved) stay on this line. */
	fields?: Record<string, string | undefined>;
	/** Day items only: move the line to another day (ISO). A correction, not a postponement: no `[>]`, no `moved`. */
	date?: string;
}

const SHARED_FIELDS = ["goal", "project"];

/** 수정: one line (and its paired copies' text / goal / project), every other part kept as written. */
export function planEdit(src: DeskItem, c: DeskChange, copies: DeskItem[], alloc: DeskItem | null, today: string): Plan {
	const ref = refOf(src);
	const shared: Record<string, string | undefined> = {};
	for (const k of SHARED_FIELDS) if (c.fields?.[k] !== undefined) shared[k] = c.fields[k];
	const own = (l: string) =>
		mapBody(l, (body) => {
			let b = body;
			if (c.text !== undefined) b = replaceContent(b, c.text, TIME_LEAD_RE);
			if (c.time !== undefined) b = setLead(b, c.time, TIME_LEAD_RE);
			if (c.fields) b = setFields(b, c.fields);
			return b;
		});
	const copy = (l: string) =>
		mapBody(l, (body) => {
			let b = body;
			if (c.text !== undefined) b = replaceContent(b, c.text, TIME_LEAD_RE);
			return setFields(b, shared);
		});
	const label = c.text !== undefined && c.text.trim() !== src.item.text ? `「${src.item.text}」 → 「${c.text.trim()}」` : `「${src.item.text}」`;
	const edits: FileEdit[] = [];
	const moving = c.date !== undefined && src.section === "day" && c.date !== src.date;
	if (c.text !== undefined && !c.text.trim()) edits.push({ file: src.file, month: true, apply: () => fail("empty-text") });
	if (moving) {
		const newLine = own(src.line);
		edits.push(monthEdit(src.file, today, (t, y, m) => removeLine(t, y, m, ref)));
		edits.push(monthEdit(c.date!.slice(0, 7), today, (t, y, m) => appendLines(t, y, m, { kind: "day", date: c.date! }, [newLine.replace(/^\s+/, "")])));
		if (alloc) {
			const aref = refOf(alloc);
			const sameWeek = alloc.monday === mondayOf(c.date!);
			edits.push(
				monthEdit(alloc.file, today, (t, y, m) => editLine(t, y, m, aref, (l) => (sameWeek ? replaceDateAssign(l, src.date!, c.date!) : removeDateAssign(l, src.date!)))),
			);
		}
	} else {
		edits.push(monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, own)));
	}
	if (c.text !== undefined || Object.keys(shared).length) {
		for (const x of copies) {
			if (moving && alloc && x.file === alloc.file && x.index === alloc.index) {
				// The allocation's date list is rewritten above; chain its text edit after that.
				const xref = refOf(x);
				edits.push(monthEdit(x.file, today, (t, y, m) => editLine(t, y, m, { ...xref, line: allocAfterMove(x.line, src.date!, c.date!, alloc) }, copy)));
				continue;
			}
			const xref = refOf(x);
			edits.push(monthEdit(x.file, today, (t, y, m) => editLine(t, y, m, xref, copy)));
		}
	}
	const more = copies.length && c.text !== undefined ? ` (짝 ${copies.length}줄도)` : "";
	const moved = moving ? `, ${mmdd(src.date!)} → ${mmdd(c.date!)}` : "";
	return finish(`${label} 수정${moved}${more}`, edits);
}

function allocAfterMove(line: string, oldIso: string, newIso: string, alloc: DeskItem): string {
	return alloc.monday === mondayOf(newIso) ? replaceDateAssign(line, oldIso, newIso) : removeDateAssign(line, oldIso);
}

/**
 * 삭제: remove the line. The `→` that pointed at it goes too (a day line's date in its 이번 주 line;
 * an 이번 주 line's week in its 이달 중 line). Copies further down are left as they are: a day line
 * without an allocation is valid (「3-3」 3단계 2).
 */
export function planDelete(src: DeskItem, months: Iterable<MonthData>, today: string): Plan {
	const ref = refOf(src);
	const list = [...months];
	const edits: FileEdit[] = [monthEdit(src.file, today, (t, y, m) => removeLine(t, y, m, ref))];
	if (src.section === "day") {
		const alloc = findPairAllocIn(src, list);
		if (alloc) {
			const aref = refOf(alloc);
			edits.push(monthEdit(alloc.file, today, (t, y, m) => editLine(t, y, m, aref, (l) => removeDateAssign(l, src.date!))));
		}
	} else if (src.section === "alloc" && src.monday) {
		const no = isoWeekNo(src.monday);
		for (const m of list) {
			for (const d of m.during) {
				if (d.key !== src.key || !d.item.assignWeek.includes(no)) continue;
				const dref = refOf(d);
				edits.push(monthEdit(d.file, today, (t, y, mm) => editLine(t, y, mm, dref, (l) => removeWeekAssign(l, no))));
			}
		}
	}
	const at = src.section === "day" ? mmdd(src.date!) : src.section === "alloc" ? "이번 주 할 일" : "이달 중";
	return finish(`「${src.item.text}」 삭제 (${at})`, edits);
}

function findPairAllocIn(it: DeskItem, months: MonthData[]): DeskItem | null {
	if (!it.date || !it.monday) return null;
	for (const data of months) {
		const hit = data.weeks.get(it.monday)?.alloc?.find((a) => a.key === it.key && a.assign.includes(it.date!));
		if (hit) return hit;
	}
	return null;
}

/** 행사 취소 (「3-4」): `- ~~14:00 회의~~ #회사`. */
export function planCancelEvent(src: DeskItem, today: string): Plan {
	const ref = refOf(src);
	return finish(`「${src.item.text}」 행사 취소`, [
		monthEdit(src.file, today, (t, y, m) => editLine(t, y, m, ref, (l) => mapBody(l, (b) => strikeContent(b, TIME_LEAD_RE)))),
	]);
}

/** Run a plan against in-memory texts (tests, and the view's dry run before writing). */
export function runPlan(plan: Plan, files: Record<string, string | undefined>): { ok: true; files: Record<string, string> } | { ok: false; file: string; reason: string } {
	const out: Record<string, string> = {};
	for (const e of plan.edits) {
		const cur = files[e.file] ?? (e.create ? e.create() : undefined);
		if (cur === undefined) return { ok: false, file: e.file, reason: "file-missing" };
		const r = e.apply(cur);
		if (!r.ok) return { ok: false, file: e.file, reason: r.reason };
		out[e.file] = r.text;
	}
	return { ok: true, files: out };
}

// ───────────────────────── other files ─────────────────────────

function appendAtEnd(text: string, line: string): string {
	const eol = detectEol(text);
	let base = text;
	if (base.length && !base.endsWith("\n")) base += eol;
	return base + line + eol;
}

export function drawerSkeleton(today: string): string {
	return `---\ntype: drawer\nupdated: ${today}\n---\n\n# Drawer\n\n`;
}

export function wallYearSkeleton(year: number, today: string): string {
	const months = Array.from({ length: 12 }, (_, i) => `## ${monthKey(year, i + 1)}\n`).join("\n");
	return `---\ntype: wall-calendar\nyear: ${year}\nupdated: ${today}\n---\n\n# ${year} Wall Calendar\n\n${months}`;
}

/** Append a line at the end of `## YYYY-MM` in a Wall Calendar year file (adding the heading in order if missing). */
export function appendUnderWallMonth(text: string, ym: string, line: string): string {
	const eol = detectEol(text);
	const lines = splitLinesKeepEol(text);
	const sec = findSection(text, ym);
	if (sec) {
		return insertInRange(text, lines, bodyRange(lines, sec.headingIndex), [line]);
	}
	// Insert a new `## ym` section before the first later month heading, else at the end.
	const fm = frontmatterEnd(lines);
	for (let i = fm; i < lines.length; i++) {
		const m = /^##\s+(\d{4}-\d{2})\s*$/.exec(stripEol(lines[i]));
		if (m && m[1] > ym) {
			lines.splice(i, 0, `## ${ym}${eol}`, `${line}${eol}`, eol);
			return lines.join("");
		}
	}
	let base = text;
	if (base.length && !base.endsWith("\n")) base += eol;
	return base + eol + `## ${ym}` + eol + line + eol;
}

// ───────────────────────── Desk Calendar Index ─────────────────────────

export const CHANGELOG_HEADING = "변경 기록";

/** Prepend `- YYYY-MM-DD: what (플러그인)` to `## 변경 기록` and set `updated`. */
export function prependChangeLog(text: string, today: string, what: string): string {
	const entry = `- ${today}: ${what.replace(/[\r\n]+/g, " ")} (플러그인)`;
	const eol = detectEol(text);
	const lines = splitLinesKeepEol(text);
	const sec = findSection(text, CHANGELOG_HEADING);
	let out: string;
	if (!sec) {
		let base = text;
		if (base.length && !base.endsWith("\n")) base += eol;
		out = base + eol + `## ${CHANGELOG_HEADING}` + eol + eol + entry + eol;
	} else {
		const r = bodyRange(lines, sec.headingIndex);
		let at = -1;
		for (let i = r.start; i < r.end; i++) {
			if (/^\s*[-*+]\s/.test(stripEol(lines[i]))) {
				at = i;
				break;
			}
		}
		if (at !== -1) {
			lines.splice(at, 0, entry + eol);
			out = lines.join("");
		} else {
			out = insertInRange(text, lines, r, [entry]);
		}
	}
	return setFrontmatterScalar(out, "updated", today);
}
