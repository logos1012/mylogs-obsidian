/**
 * Desk Calendar month-file model.
 *
 * A TypeScript port of `parse_month_file`, `resolve_alloc`, `resolve_during`, `week_alloc_stats`,
 * `count_items` and the issue checks in `03 Desk Calendar/_build/build_desk_calendar.py`, plus
 * `render()` from `_build/new_month.py`.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { addDays, cleanInline, fromIsoDate, pad2, type ParsedItem, parseItem, splitLinesKeepEol, stripEol, toIsoDate } from "../parser.ts";

export const WEEK_HEAD_RE = /^##\s+W(\d{1,2})\s*\(\s*(\d{1,2})\/(\d{1,2})\s*~\s*(\d{1,2})\/(\d{1,2})\s*\)\s*$/;
export const DAY_HEAD_RE = /^###\s+(\d{4})-(\d{2})-(\d{2})\s*$/;
const OLD_DAY_HEAD_RE = /^###\s+\d{1,2}\/\d{1,2}/;
export const ALLOC_LINK_RE = /^\(\s*분배\s*칸\s*:\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*\)$/;
const GOAL_ID_RE = /^(G-\d{4}-\d{2}(?:\.\d+)?)\s*(.*)$/;
const LIST_BODY_RE = /^[-*+]\s+(.*)$/;
export const ALLOC_HEADING = "이번 주";
export const FOCUS_HEADING = "이달의 초점";
export const DURING_HEADING = "이달 중";

// ───────────────────────── calendar helpers ─────────────────────────

export function monthKey(year: number, month: number): string {
	return `${year}-${pad2(month)}`;
}

export function parseMonthKey(key: string): { year: number; month: number } | null {
	const m = /^(\d{4})-(\d{1,2})$/.exec(key.trim());
	if (!m) return null;
	const month = +m[2];
	if (month < 1 || month > 12) return null;
	return { year: +m[1], month };
}

export function shiftMonth(key: string, n: number): string {
	const p = parseMonthKey(key);
	if (!p) return key;
	const idx = p.year * 12 + (p.month - 1) + n;
	return monthKey(Math.floor(idx / 12), (idx % 12) + 1);
}

/** 0 = Monday … 6 = Sunday (Python's `date.weekday()`). */
export function weekdayMon0(iso: string): number {
	const d = fromIsoDate(iso);
	return d ? (d.getDay() + 6) % 7 : 0;
}

/** ISO-8601 week number. */
export function isoWeekNo(iso: string): number {
	const d = fromIsoDate(iso);
	if (!d) return 0;
	const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const day = (t.getUTCDay() + 6) % 7;
	t.setUTCDate(t.getUTCDate() - day + 3); // Thursday of this week decides the year
	const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
	return Math.floor((t.getTime() - yearStart) / 86400000 / 7) + 1;
}

export function mondayOf(iso: string): string {
	return addDays(iso, -weekdayMon0(iso));
}

export function monthDays(year: number, month: number): string[] {
	const out: string[] = [];
	let d = `${year}-${pad2(month)}-01`;
	while (d.slice(0, 7) === monthKey(year, month)) {
		out.push(d);
		d = addDays(d, 1);
	}
	return out;
}

/** Mondays of every week that overlaps the month. */
export function weekMondays(year: number, month: number): string[] {
	const days = monthDays(year, month);
	const out: string[] = [];
	let monday = mondayOf(days[0]);
	const last = days[days.length - 1];
	while (monday <= last) {
		out.push(monday);
		monday = addDays(monday, 7);
	}
	return out;
}

/** The year of an `MM/DD` written in a file of `fileMonth` (12월 파일의 01/03 → 다음 해). */
export function nearYear(y: number, fileMonth: number, m: number): number {
	if (fileMonth === 12 && m === 1) return y + 1;
	if (fileMonth === 1 && m === 12) return y - 1;
	return y;
}

export function safeDate(y: number, m: number, d: number): string | null {
	const iso = `${y}-${pad2(m)}-${pad2(d)}`;
	return fromIsoDate(iso) ? iso : null;
}

/** `MM/DD` (zero padded), as written in assignment lists. */
export function mmdd(iso: string): string {
	return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/** Pair key: text with all whitespace removed, lowercased (port of `norm_key`). */
export function normKey(text: string): string {
	return text.replace(/\s+/g, "").toLowerCase();
}

// ───────────────────────── model ─────────────────────────

export type DeskSection = "during" | "alloc" | "day";

export interface DeskItem {
	/** Month key of the file the line lives in, e.g. `2026-10`. */
	file: string;
	/** 0-based line index. */
	index: number;
	/** The line as written (no terminator, not trimmed). */
	line: string;
	item: ParsedItem;
	key: string;
	/** Problems from the parser plus the month-context checks. */
	problems: string[];
	section: DeskSection;
	/** Monday (ISO) of the week, for alloc and day items. */
	monday?: string;
	/** Day (ISO), for day items. */
	date?: string;
	/** Assigned dates (ISO), for alloc items. */
	assign: string[];
}

export interface FocusItem {
	index: number;
	raw: string;
	test: boolean;
	id: string;
	title: string;
	note: string;
}

export interface DeskWeek {
	no: number;
	monday: string;
	headingIndex: number;
	/** `### 이번 주` items, or null when the week has no allocation box in this file. */
	alloc: DeskItem[] | null;
	allocHeadingIndex: number;
	/** `(분배 칸: [[YYYY-MM]])` target. */
	allocLink: string | null;
}

export interface DeskIssue {
	file: string;
	/** 1-based line number (0 = not a specific line). */
	line: number;
	raw: string;
	why: string;
}

export interface MonthData {
	year: number;
	month: number;
	key: string;
	focus: FocusItem[];
	during: DeskItem[];
	duringHeadingIndex: number;
	focusHeadingIndex: number;
	weeks: Map<string, DeskWeek>;
	days: Map<string, DeskItem[]>;
	dayHeadingIndex: Map<string, number>;
	issues: DeskIssue[];
}

/** Port of `parse_month_file`. */
export function parseMonthFile(text: string, year: number, month: number): MonthData {
	const lines = splitLinesKeepEol(text).map(stripEol);
	let start = 0;
	if (lines.length && lines[0].replace(/^﻿/, "").trim() === "---") {
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") {
				start = i + 1;
				break;
			}
		}
	}
	const key = monthKey(year, month);
	const data: MonthData = {
		year,
		month,
		key,
		focus: [],
		during: [],
		duringHeadingIndex: -1,
		focusHeadingIndex: -1,
		weeks: new Map(),
		days: new Map(),
		dayHeadingIndex: new Map(),
		issues: [],
	};
	let section: "focus" | "during" | "week" | null = null;
	let week: DeskWeek | null = null;
	let sub: "alloc" | string | null = null;
	let inComment = false;
	const issue = (idx: number, raw: string, why: string) => data.issues.push({ file: key, line: idx + 1, raw, why });

	for (let idx = start; idx < lines.length; idx++) {
		const s = lines[idx].trim();
		if (inComment) {
			if (s.includes("-->")) inComment = false;
			continue;
		}
		if (s.startsWith("<!--")) {
			inComment = !s.includes("-->");
			continue;
		}
		if (!s) continue;
		if (/^#\s/.test(s)) continue;
		if (s.startsWith("## ")) {
			sub = null;
			week = null;
			const title = s.slice(3).trim();
			if (title === FOCUS_HEADING) {
				section = "focus";
				data.focusHeadingIndex = idx;
			} else if (title === DURING_HEADING) {
				section = "during";
				data.duringHeadingIndex = idx;
			} else {
				const wm = WEEK_HEAD_RE.exec(s);
				if (!wm) {
					section = null;
					issue(idx, s, "알 수 없는 ## 제목이에요 (이달의 초점 / 이달 중 / W주차 만 씁니다)");
					continue;
				}
				const sm = +wm[2];
				const sd = +wm[3];
				const monday = safeDate(nearYear(year, month, sm), sm, sd);
				if (monday === null || weekdayMon0(monday) !== 0) {
					section = null;
					issue(idx, s, "주 제목의 시작 날짜가 월요일이 아니에요");
					continue;
				}
				section = "week";
				const no = +wm[1];
				const real = isoWeekNo(monday);
				if (no !== real) issue(idx, s, `주차 번호가 달라요 (W${pad2(real)})`);
				week = { no: real, monday, headingIndex: idx, alloc: null, allocHeadingIndex: -1, allocLink: null };
				data.weeks.set(monday, week);
			}
			continue;
		}
		if (s.startsWith("### ")) {
			if (section !== "week" || !week) {
				issue(idx, s, "주(## W..) 아래에 있지 않은 ### 제목이에요");
				sub = null;
				continue;
			}
			if (s.slice(4).trim() === ALLOC_HEADING) {
				if (+week.monday.slice(5, 7) !== month) issue(idx, s, "월요일이 다른 달인 주예요. 분배 칸은 월요일이 속한 달 파일에 둡니다");
				week.alloc = [];
				week.allocHeadingIndex = idx;
				sub = "alloc";
				continue;
			}
			const dm = DAY_HEAD_RE.exec(s);
			if (!dm) {
				if (OLD_DAY_HEAD_RE.test(s)) issue(idx, s, "옛 날짜 제목이에요. `### YYYY-MM-DD` 형식으로 바꿔 주세요 (요일은 쓰지 않아요)");
				else issue(idx, s, "날짜 제목은 `### YYYY-MM-DD` 형식이에요");
				sub = null;
				continue;
			}
			const d = safeDate(+dm[1], +dm[2], +dm[3]);
			if (d === null) {
				issue(idx, s, "없는 날짜예요");
				sub = null;
				continue;
			}
			if (!(week.monday <= d && d <= addDays(week.monday, 6))) issue(idx, s, "이 주에 속하지 않는 날짜예요");
			if (+d.slice(5, 7) !== month) issue(idx, s, "다른 달의 날짜예요. 그 달 파일에 둡니다");
			if (data.days.has(d)) issue(idx, s, "같은 날짜 칸이 두 번 있어요");
			if (!data.days.has(d)) data.days.set(d, []);
			if (!data.dayHeadingIndex.has(d)) data.dayHeadingIndex.set(d, idx);
			sub = d;
			continue;
		}
		if (s.startsWith("#")) {
			issue(idx, s, "알 수 없는 제목이에요");
			continue;
		}

		const lm = ALLOC_LINK_RE.exec(s);
		if (lm && section === "week" && week && sub === null) {
			week.allocLink = lm[1].trim();
			continue;
		}
		const bm = LIST_BODY_RE.exec(s);
		const body = bm ? bm[1].trim() : s;
		if (section === "focus") {
			const text = cleanInline(body.replace(/#test\b/g, "")).trim();
			const gm = GOAL_ID_RE.exec(text);
			const f: FocusItem = { index: idx, raw: s, test: body.includes("#test"), id: "", title: text, note: "" };
			if (gm) {
				f.id = gm[1];
				const rest = gm[2].trim();
				const colon = rest.indexOf(":");
				if (colon !== -1) {
					f.title = rest.slice(0, colon).trim();
					f.note = rest.slice(colon + 1).trim();
				} else {
					f.title = rest;
				}
			} else {
				issue(idx, s, "이달의 초점은 `G-` id로 시작해요");
			}
			data.focus.push(f);
			continue;
		}
		if ((section !== "during" && section !== "week") || (section === "week" && sub === null)) {
			issue(idx, s, "어느 칸에도 속하지 않는 줄이에요");
			continue;
		}
		const parsed = parseItem(body);
		const it: DeskItem = {
			file: key,
			index: idx,
			line: lines[idx],
			item: parsed,
			key: normKey(parsed.text),
			problems: [...parsed.problems],
			section: section === "during" ? "during" : sub === "alloc" ? "alloc" : "day",
			assign: [],
		};
		if (!bm) {
			parsed.ok = false;
			it.problems.unshift("목록 줄(- )이 아니에요");
		}
		if (section !== "during" && parsed.assignWeek.length) it.problems.push("주 배정(→ W주차)은 이달 중에서만 써요");
		if (section === "during") {
			if (parsed.assignRaw.length) it.problems.push("이달 중 항목은 날짜가 아니라 주에 배정해요 (→ W44)");
			data.during.push(it);
		} else if (sub === "alloc" && week) {
			it.monday = week.monday;
			const wk = Array.from({ length: 7 }, (_, i) => addDays(week!.monday, i));
			for (const [mm, dd] of parsed.assignRaw) {
				let hit: string | null = wk.find((x) => +x.slice(5, 7) === mm && +x.slice(8, 10) === dd) ?? null;
				if (hit === null) {
					hit = safeDate(nearYear(year, month, mm), mm, dd);
					it.problems.push(`${pad2(mm)}/${pad2(dd)} 은(는) 이 주 밖의 날짜예요`);
				}
				if (hit !== null) it.assign.push(hit);
			}
			week.alloc!.push(it);
		} else if (sub) {
			if (parsed.assignRaw.length) it.problems.push("배정(→)은 분배 칸에서만 써요");
			it.date = sub;
			it.monday = week?.monday;
			data.days.get(sub)!.push(it);
		}
		if (it.problems.length) issue(idx, s, it.problems.join(" · "));
	}

	for (const d of monthDays(year, month)) {
		if (!data.days.has(d)) data.issues.push({ file: key, line: 0, raw: `### ${d}`, why: "날짜 칸이 빠져 있어요 (빈 칸으로 표시)" });
	}
	for (const monday of weekMondays(year, month)) {
		const w = data.weeks.get(monday);
		const inMonth = +monday.slice(5, 7) === month;
		if (!w) data.issues.push({ file: key, line: 0, raw: `## W${pad2(isoWeekNo(monday))}`, why: "주 제목이 빠져 있어요" });
		else if (inMonth && w.alloc === null) data.issues.push({ file: key, line: w.headingIndex + 1, raw: `## W${pad2(w.no)}`, why: "`### 이번 주` 분배 칸이 없어요" });
		else if (!inMonth && w.alloc === null && !w.allocLink)
			data.issues.push({ file: key, line: w.headingIndex + 1, raw: `## W${pad2(w.no)}`, why: "다른 달 분배 칸 링크 `(분배 칸: [[YYYY-MM]])`가 없어요" });
	}
	return data;
}

// ───────────────────────── resolution ─────────────────────────

export type AllocState = "scheduled" | "done" | "moved" | "cancelled" | "unassigned";

export type DayIndex = Map<string, DeskItem[]>;
export type WeekAllocIndex = Map<number, DeskItem[]>;

export function dayIndex(months: Iterable<MonthData>): DayIndex {
	const idx: DayIndex = new Map();
	for (const data of months) {
		for (const [d, items] of data.days) {
			if (!idx.has(d)) idx.set(d, []);
			idx.get(d)!.push(...items);
		}
	}
	return idx;
}

export interface AllocResolution {
	targets: [string, DeskItem | null][];
	missing: string[];
	state: AllocState;
}

/** Port of `resolve_alloc`: an allocation item's state from its assigned day items. */
export function resolveAlloc(it: DeskItem, idx: DayIndex): AllocResolution {
	const targets: [string, DeskItem | null][] = it.assign.map((d) => [d, (idx.get(d) ?? []).find((x) => x.key === it.key) ?? null]);
	const missing = targets.filter(([, x]) => x === null).map(([d]) => d);
	let state: AllocState;
	const st = it.item.status;
	if (st !== "scheduled") state = st;
	else if (!it.assign.length) state = "unassigned";
	else if (targets.every(([, x]) => x !== null && x.item.status === "done")) state = "done";
	else if (targets.some(([, x]) => x !== null && x.item.status === "moved")) state = "moved";
	else if (targets.every(([, x]) => x !== null && x.item.status === "cancelled")) state = "cancelled";
	else state = "scheduled";
	return { targets, missing, state };
}

/** ISO week number → that week's allocation items (from every loaded month file). */
export function weekAllocIndex(months: Iterable<MonthData>): WeekAllocIndex {
	const out: WeekAllocIndex = new Map();
	for (const data of months) {
		for (const w of data.weeks.values()) {
			if (w.alloc && w.alloc.length) {
				if (!out.has(w.no)) out.set(w.no, []);
				out.get(w.no)!.push(...w.alloc);
			}
		}
	}
	return out;
}

export interface DuringResolution {
	targets: [number, DeskItem | null][];
	missing: number[];
	state: AllocState;
}

/** Port of `resolve_during`: a 이달 중 item's state from the allocation boxes of its weeks. */
export function resolveDuring(it: DeskItem, widx: WeekAllocIndex, didx: DayIndex): DuringResolution {
	const targets: [number, DeskItem | null][] = it.item.assignWeek.map((no) => [no, (widx.get(no) ?? []).find((x) => x.key === it.key) ?? null]);
	const missing = targets.filter(([, x]) => x === null).map(([no]) => no);
	let state: AllocState;
	const st = it.item.status;
	if (st !== "scheduled") state = st;
	else if (!it.item.assignWeek.length) state = "unassigned";
	else if (targets.length && targets.every(([, x]) => x !== null && resolveAlloc(x, didx).state === "done")) state = "done";
	else state = "scheduled";
	return { targets, missing, state };
}

/** [total, unassigned] of a week's allocation box (port of `week_alloc_stats`). */
export function weekAllocStats(week: DeskWeek | undefined | null): [number, number] {
	const alloc = week?.alloc ?? [];
	const live = alloc.filter((a) => a.item.status === "scheduled");
	return [alloc.length, live.filter((a) => !a.assign.length).length];
}

export interface MonthCounts {
	scheduled: number;
	done: number;
	moved: number;
	cancelled: number;
	test: number;
	total: number;
}

/** Port of `count_items`. */
export function countItems(data: MonthData): MonthCounts {
	const c: MonthCounts = { scheduled: 0, done: 0, moved: 0, cancelled: 0, test: 0, total: 0 };
	const pools = [data.during, ...data.days.values()];
	for (const pool of pools) {
		for (const it of pool) {
			if (it.item.test) c.test++;
			if (it.item.kind === null) continue;
			c.total++;
			c[it.item.status]++;
		}
	}
	for (const w of data.weeks.values()) for (const a of w.alloc ?? []) if (a.item.test) c.test++;
	c.test += data.focus.filter((f) => f.test).length;
	return c;
}

export interface MonthSummary {
	counts: MonthCounts;
	unassigned: number;
	issues: DeskIssue[];
}

/**
 * What the Python build prints: counts, the 미배정 total over this month's own allocation boxes,
 * and every issue (parse issues + "날짜 칸에 같은 항목이 없어요" for missing pairs).
 */
export function summarizeMonth(data: MonthData, idx: DayIndex): MonthSummary {
	const issues = [...data.issues];
	let unassigned = 0;
	for (const monday of weekMondays(data.year, data.month)) {
		const w = data.weeks.get(monday);
		if (+monday.slice(5, 7) !== data.month || +monday.slice(0, 4) !== data.year) continue;
		if (!w || w.alloc === null) continue;
		unassigned += weekAllocStats(w)[1];
		for (const it of w.alloc) {
			for (const d of resolveAlloc(it, idx).missing) {
				issues.push({ file: it.file, line: it.index + 1, raw: it.line.trim(), why: `${mmdd(d)} 날짜 칸에 같은 항목이 없어요` });
			}
		}
	}
	return { counts: countItems(data), unassigned, issues };
}

/**
 * The ISO week a `→ Wnn` points at, in the context of a month file: the overlapping week with
 * that number, else the week with that number in the file's year.
 */
export function mondayOfWeekNo(year: number, month: number, no: number): string | null {
	for (const m of weekMondays(year, month)) if (isoWeekNo(m) === no) return m;
	// Fallback: walk the year's Mondays.
	let m = mondayOf(`${year}-01-04`);
	for (let i = 0; i < 54; i++) {
		if (isoWeekNo(m) === no) return m;
		m = addDays(m, 7);
	}
	return null;
}

// ───────────────────────── new month skeleton ─────────────────────────

/** Exactly `render()` from `03 Desk Calendar/_build/new_month.py`. */
export function newMonthSkeleton(year: number, month: number, todayIso: string): string {
	const key = monthKey(year, month);
	const lines = ["---", "type: desk-calendar", `month: ${key}`, `updated: ${todayIso}`, "---", "", `# ${key} Desk Calendar`, "", `## ${FOCUS_HEADING}`, "", `## ${DURING_HEADING}`, ""];
	for (const monday of weekMondays(year, month)) {
		const sunday = addDays(monday, 6);
		lines.push(`## W${pad2(isoWeekNo(monday))} (${mmdd(monday)}~${mmdd(sunday)})`);
		lines.push("");
		if (monday.slice(0, 7) === key) {
			lines.push(`### ${ALLOC_HEADING}`);
			lines.push("");
		} else {
			lines.push(`(분배 칸: [[${monday.slice(0, 7)}]])`);
			lines.push("");
		}
		for (let i = 0; i < 7; i++) {
			const d = addDays(monday, i);
			if (d.slice(0, 7) === key) {
				lines.push(`### ${d}`);
				lines.push("");
			}
		}
	}
	return lines.join("\n").replace(/\s+$/, "") + "\n";
}

export function todayIsoLocal(): string {
	return toIsoDate(new Date());
}

/**
 * The allocation item paired with a day item: same week (by Monday), same text key, and the
 * day's date in its `→` list. Searches every loaded month (the box may live in the previous month).
 */
export function findPairAlloc(it: DeskItem, months: Iterable<MonthData>): DeskItem | null {
	if (!it.date || !it.monday) return null;
	for (const data of months) {
		const w = data.weeks.get(it.monday);
		const hit = w?.alloc?.find((a) => a.key === it.key && a.assign.includes(it.date!));
		if (hit) return hit;
	}
	return null;
}

/** Month key of the file that holds a week's `### 이번 주` box (the month of its Monday). */
export function allocFileOf(monday: string): string {
	return monday.slice(0, 7);
}
