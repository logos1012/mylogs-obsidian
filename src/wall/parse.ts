/**
 * Wall Calendar year-file parser.
 *
 * A TypeScript port of `load_year` / `parse_item` in
 * `02 Wall Calendar/_build/build_wall_calendar.py` (the reference implementation).
 * The line grammar itself is `parseItem` from `../parser.ts` (root `AGENTS.md`
 * 「줄 형식」); this module only adds what the Wall Calendar puts in front of it:
 * a leading date (`10/15`, `10/15~10/17`, `10/15 14:00`) and the `## YYYY-MM` month sections.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import {
	frontmatterEnd,
	LIST_LINE_RE,
	pad2,
	parseItem,
	type ParsedItem,
	splitLinesKeepEol,
	stripEol,
} from "../parser.ts";

export interface WallItem extends ParsedItem {
	/** Start date (ISO), or null when only the month is known (이달 중). */
	start: string | null;
	/** End date (ISO) of a range, or null. */
	end: string | null;
	/** The date prefix exactly as written (e.g. `10/15~10/17`), or "". */
	dateRaw: string;
}

export interface WallLine {
	/** 0-based line index in the file. */
	index: number;
	/** The line without its terminator. */
	line: string;
	/** Parsed item; `ok:false` when the line is not a list line. */
	item: WallItem;
	month: number;
}

export interface MonthSection {
	month: number;
	/** 0-based index of the `## YYYY-MM` heading line, or -1 when missing. */
	headingIndex: number;
	/** [start, end) line range of the body (end = next heading or EOF). */
	start: number;
	end: number;
	lines: WallLine[];
}

export interface WallIssue {
	line: number;
	raw: string;
	why: string;
	month?: number;
}

export interface WallYear {
	year: number;
	months: MonthSection[]; // index 0 = January
	issues: WallIssue[];
}

/** Port of `DATE_RE`: `10/15`, `10/15~10/17`, `10/15~17`, `10/15 14:00`. */
export const WALL_DATE_RE =
	/^(\d{1,2})\/(\d{1,2})(?:\s*~\s*(?:(\d{1,2})\/)?(\d{1,2}))?(?:\s+(\d{1,2}:\d{2}(?:\s*~\s*\d{1,2}:\d{2})?))?(?=\s|$)\s*/;
export const MONTH_HEAD_RE = /^##\s+(\d{4})-(\d{1,2})\s*$/;
const MONTH_PHRASE_RE = /^(\d{1,2})\s*월\s*중\s*/;
const CHECKBOX_PREFIX_RE = /^\[(.)\](?:\s+|$)/;

export function safeDate(y: number, m: number, d: number): string | null {
	if (m < 1 || m > 12 || d < 1) return null;
	const dt = new Date(y, m - 1, d, 12);
	if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
	return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Split a list body into checkbox prefix, strike flag, date prefix and the rest. */
export interface BodyPartsWall {
	/** `[ ] ` etc. (with its trailing space), or "". */
	checkbox: string;
	/** True when the content after the checkbox starts with `~~`. */
	strike: boolean;
	/** Date prefix including the trailing whitespace, or "". (Inside the strike when `strike`.) */
	date: string;
	/** Everything after the date (for `strike`, after the date inside the `~~`). */
	rest: string;
	match: RegExpExecArray | null;
}

export function splitWallBody(body: string): BodyPartsWall {
	let checkbox = "";
	let rest = body;
	const cm = CHECKBOX_PREFIX_RE.exec(rest);
	if (cm) {
		checkbox = cm[0];
		rest = rest.slice(cm[0].length);
	}
	let strike = false;
	if (rest.startsWith("~~")) {
		strike = true;
		rest = rest.slice(2);
	}
	const lead = /^\s*/.exec(rest)?.[0] ?? "";
	const m = WALL_DATE_RE.exec(rest.slice(lead.length));
	if (!m) return { checkbox, strike, date: "", rest: strike ? "~~" + rest : rest, match: null };
	// `~~10/15~~` (only a date inside the strike) is not a date prefix.
	return { checkbox, strike, date: lead + m[0], rest: rest.slice(lead.length + m[0].length), match: m };
}

/**
 * Parse the body of one Wall Calendar list item (the part after `- `) in `year`-`month`.
 * Never throws. Mirrors `parse_item(body, year, month)` of the Python build.
 */
export function parseWallItem(body: string, year: number, month: number): WallItem {
	const parts = splitWallBody(body);
	let datePart: RegExpExecArray | null = parts.match;
	let stripped: string;
	if (datePart) {
		const time = datePart[5] ? datePart[5] + " " : "";
		stripped = parts.checkbox + (parts.strike ? "~~" + time + parts.rest : time + parts.rest);
		// `~~10/15~~ …`: the strike would be empty — keep the original body then.
		if (parts.strike && !parts.rest.trim()) {
			datePart = null;
			stripped = body;
		}
	} else {
		stripped = body;
	}
	const base = parseItem(stripped);
	const item: WallItem = { ...base, raw: body, start: null, end: null, dateRaw: "" };
	if (datePart) {
		item.dateRaw = datePart[0].trim();
		const sm = parseInt(datePart[1], 10);
		const sd = parseInt(datePart[2], 10);
		let start = safeDate(year, sm, sd);
		if (start === null) {
			item.problems.push(`없는 날짜예요 (${datePart[1]}/${datePart[2]})`);
			item.ok = false;
		} else {
			// 12월 칸에 01/03 처럼 쓴 경우는 다음 해로 본다
			if (month === 12 && sm === 1) start = safeDate(year + 1, sm, sd);
			item.start = start;
			if (sm !== month) item.problems.push(`날짜(${sm}/${sd})의 달이 ${year}-${pad2(month)} 칸과 달라요`);
		}
		if (datePart[4] && item.start) {
			const sy = parseInt(item.start.slice(0, 4), 10);
			const em = datePart[3] ? parseInt(datePart[3], 10) : parseInt(item.start.slice(5, 7), 10);
			const ed = parseInt(datePart[4], 10);
			let end = safeDate(sy, em, ed);
			if (end !== null && end < item.start) end = safeDate(sy + 1, em, ed);
			if (end === null) {
				item.problems.push("기간의 끝 날짜가 올바르지 않아요");
				item.ok = false;
			} else item.end = end;
		}
		if (base.checkbox === null && item.kind === "note") item.kind = "event";
		if (datePart[5]) item.time = datePart[5].replace(/\s+/g, "");
	}
	// Python reads `→` on a `[ ]` task as "moved to" and flags it; parseItem reads it as an
	// assignment. Either way it is a problem on the Wall Calendar.
	if (item.kind === "task" && item.status !== "moved" && (item.assignRaw.length || item.assignWeek.length)) {
		item.problems.push("옮긴 곳(→)이 있지만 체크박스가 [>]가 아니에요");
	}
	// 날짜 없이 "3월 중 ..." 으로 쓴 경우: 그 달 중이라는 뜻이므로 앞말을 뗀다
	if (item.start === null) {
		const pm = MONTH_PHRASE_RE.exec(item.text);
		if (pm && parseInt(pm[1], 10) === month && item.text.slice(pm[0].length)) item.text = item.text.slice(pm[0].length);
	}
	return item;
}

function emptyMonths(): MonthSection[] {
	return Array.from({ length: 12 }, (_, i) => ({ month: i + 1, headingIndex: -1, start: -1, end: -1, lines: [] }));
}

/** Parse a whole `<year>.md` file. Port of `load_year`. */
export function parseWallYear(text: string, year: number): WallYear {
	const lines = splitLinesKeepEol(text);
	const months = emptyMonths();
	const issues: WallIssue[] = [];
	let current: MonthSection | null = null;
	let inComment = false;
	const close = (i: number) => {
		if (current) current.end = i;
		current = null;
	};
	for (let i = frontmatterEnd(lines); i < lines.length; i++) {
		const line = stripEol(lines[i]);
		const s = line.trim();
		if (inComment) {
			if (s.includes("-->")) inComment = false;
			continue;
		}
		if (s.startsWith("<!--")) {
			inComment = !s.includes("-->");
			continue;
		}
		if (!s) continue;
		const hm = MONTH_HEAD_RE.exec(s);
		if (hm) {
			close(i);
			const hy = parseInt(hm[1], 10);
			const hmn = parseInt(hm[2], 10);
			if (hy === year && hmn >= 1 && hmn <= 12 && months[hmn - 1].headingIndex === -1) {
				current = months[hmn - 1];
				current.headingIndex = i;
				current.start = i + 1;
			} else {
				issues.push({ line: i + 1, raw: s, why: `${year}년 파일에 맞지 않는 달 제목이에요` });
			}
			continue;
		}
		if (s.startsWith("#")) {
			// Like the Python build: another `## …` ends the month; other `#` lines are skipped.
			if (s.startsWith("## ")) {
				issues.push({ line: i + 1, raw: s, why: "`## YYYY-MM` 형식이 아닌 제목이에요" });
				close(i);
			}
			continue;
		}
		const sec = current as MonthSection | null;
		if (!sec) {
			if (/^[-*+]/.test(s)) issues.push({ line: i + 1, raw: s, why: "달 제목 아래에 있지 않아 화면에 넣지 못했어요" });
			continue;
		}
		const lm = LIST_LINE_RE.exec(line);
		const item = parseWallItem(lm ? lm[3].trim() : s, year, sec.month);
		if (!lm) {
			item.ok = false;
			item.problems.unshift("목록 줄(- )이 아니에요");
		}
		sec.lines.push({ index: i, line, item, month: sec.month });
		if (item.problems.length) issues.push({ line: i + 1, raw: s, why: item.problems.join(" · "), month: sec.month });
	}
	close(lines.length);
	const missing = months.filter((m) => m.headingIndex === -1).map((m) => `${year}-${pad2(m.month)}`);
	if (missing.length) {
		issues.push({ line: 0, raw: missing.map((m) => `## ${m}`).join(", "), why: `달 제목 ${missing.length}개가 빠져 있어요 (빈 달로 표시)` });
	}
	return { year, months, issues };
}

/** Sort key used for "date order within a month": [start or max, time, line]. */
export function itemSortKey(it: WallItem): string {
	return `${it.start ?? "9999-99-99"}|${it.time || ""}`;
}

export type WallCounts = Record<"scheduled" | "done" | "moved" | "cancelled", number>;

export function countStatuses(y: WallYear): WallCounts {
	const c: WallCounts = { scheduled: 0, done: 0, moved: 0, cancelled: 0 };
	for (const m of y.months) for (const l of m.lines) c[l.item.status]++;
	return c;
}

/** Skeleton for a new year file: frontmatter + twelve month headings. */
export function wallYearSkeleton(year: number, today: string): string {
	let s = `---\ntype: wall-calendar\nyear: ${year}\nupdated: ${today}\n---\n\n# ${year} Wall Calendar\n`;
	for (let m = 1; m <= 12; m++) s += `\n## ${year}-${pad2(m)}\n`;
	return s;
}

