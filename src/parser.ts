/**
 * MyLogs line grammar parser.
 *
 * A TypeScript port of `parse_item` / `clean_inline` / `move_target` in
 * `03 Desk Calendar/_build/build_desk_calendar.py` (the reference implementation),
 * following the root `AGENTS.md` section 「줄 형식 (모든 폴더 공통)」.
 *
 *   - [ ] 내용            task · scheduled      - [x] 내용   task · done (X accepted)
 *   - [>] 내용 → 보낸 곳  task · moved          - [-] 내용 (why:: 이유)   task · cancelled
 *   - 14:00 내용          event (starts with a time)   - 내용 #행사  event (no time)
 *   - 내용                note                  - ~~행사~~   cancelled event · - 행사 → 곳  moved event
 *   assignment: → 11/04, → 11/05, 11/07 · → W44 / tags #회사 · fields (goal:: …)
 *
 * This module is pure (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

export type ItemKind = "task" | "event" | "note";
export type ItemStatus = "scheduled" | "done" | "moved" | "cancelled";

export interface ParsedItem {
	/** The text after the list marker (`- `). */
	raw: string;
	ok: boolean;
	kind: ItemKind | null;
	status: ItemStatus;
	/** The character inside `[ ]`, or null for plain list items. */
	checkbox: string | null;
	time: string;
	text: string;
	tags: string[];
	fields: [string, string][];
	/** `→ MM/DD` assignments as [month, day]. */
	assignRaw: [number, number][];
	/** `→ W44` assignments as week numbers. */
	assignWeek: number[];
	movedTo: string;
	/** Has `#test`. */
	test: boolean;
	/** Has `#행사`. */
	eventTag: boolean;
	goal: string;
	problems: string[];
}

export const CHECK_STATUS: Record<string, ItemStatus> = {
	" ": "scheduled",
	x: "done",
	X: "done",
	">": "moved",
	"-": "cancelled",
};

export const EVENT_TAG = "행사";
const OLD_FORMAT_MSG = "옛 기호 형식이에요. 체크박스 형식으로 바꿔 주세요";

const OLD_SYMBOL_RE = /^(?:\[.\]\s*)?(?:[xX>✕×✗]\s+)?[○◯•∙–—](?=\s|$)/;
const CHECKBOX_RE = /^\[(.)\](?:\s+(.*))?$/;
const STRIKE_RE = /^~~(.+?)~~/;
const TIME_RE = /^(\d{1,2}:\d{2}(?:\s*~\s*\d{1,2}:\d{2})?)(?=\s|$)\s*/;
const ARROW_RE = /\s*(?:→|->)\s*(.*)$/;
const WEEK_ASSIGN_RE = /(?:→|->)\s*(W\d{1,2}(?:\s*,\s*W\d{1,2})*)/;
const ASSIGN_RE = /(?:→|->)\s*(\d{1,2}\/\d{1,2}(?:\s*,\s*\d{1,2}\/\d{1,2})*)/;
const FIELD_RE = /\(\s*([A-Za-z_][\w-]*)\s*::\s*([^)]*?)\s*\)/g;
const TAG_RE = /(?:(?<=\s)|^)#([^\s#()[\],.]+)/g;
/** A markdown list line: indentation, marker, body. */
export const LIST_LINE_RE = /^(\s*)([-*+])\s+(.*)$/;
/** A list line with a checkbox: captures prefix up to `[`, the char, and the rest. */
export const TASK_LINE_RE = /^(\s*[-*+]\s+\[)(.)(\].*)$/;
export const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Wikilinks and markdown emphasis to human-readable text (port of `clean_inline`). */
export function cleanInline(s: string): string {
	s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
	s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, p1: string) => p1.split("/").pop() ?? p1);
	s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
	s = s.replace(/\*\*(.+?)\*\*/g, "$1");
	s = s.replace(/`([^`]+)`/g, "$1");
	s = s.split("~~").join("");
	return s.replace(/\s{2,}/g, " ").trim();
}

/** '→ [[03 Desk Calendar/2026/2026-11]]' → '2026-11', '→ Drawer' → 'Drawer'. */
export function moveTarget(t: string): string {
	t = t.trim();
	const lm = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(t);
	if (lm) return (lm[2] || lm[1].split("/").pop() || "").trim();
	return cleanInline(t);
}

/** Parse the body of one list item (the part after `- `). Never throws. */
export function parseItem(body: string): ParsedItem {
	const item: ParsedItem = {
		raw: body,
		ok: true,
		kind: null,
		status: "scheduled",
		checkbox: null,
		time: "",
		text: "",
		tags: [],
		fields: [],
		assignRaw: [],
		assignWeek: [],
		movedTo: "",
		test: false,
		eventTag: false,
		goal: "",
		problems: [],
	};
	const old = OLD_SYMBOL_RE.test(body);
	let plain = false;
	let rest: string;
	if (old) {
		item.ok = false;
		item.problems.push(OLD_FORMAT_MSG);
		rest = body;
	} else {
		const cm = CHECKBOX_RE.exec(body);
		if (cm) {
			item.kind = "task";
			const cb = cm[1];
			item.checkbox = cb;
			if (cb in CHECK_STATUS) item.status = CHECK_STATUS[cb];
			else item.problems.push(`체크박스 안에는 공백, x, >, - 만 써요 ([${cb}])`);
			rest = cm[2] ?? "";
		} else {
			plain = true;
			rest = body;
		}
		const sm = STRIKE_RE.exec(rest);
		if (sm) {
			// ~~취소한 행사~~ : strip the strike and keep it as a status
			rest = sm[1] + " " + rest.slice(sm[0].length);
			if (plain) item.status = "cancelled";
		}
		rest = rest.trim();
		const tm = TIME_RE.exec(rest);
		if (tm) {
			item.time = tm[1].replace(/\s+/g, "");
			rest = rest.slice(tm[0].length);
		}
	}
	// Strip fields and tags first, then read the arrow from what remains.
	for (const fm of rest.matchAll(FIELD_RE)) item.fields.push([fm[1], fm[2]]);
	rest = rest.replace(FIELD_RE, " ");
	for (const tg of rest.matchAll(TAG_RE)) {
		const tag = tg[1];
		if (tag.toLowerCase() === "test") item.test = true;
		else if (tag === EVENT_TAG) item.eventTag = true;
		else if (!item.tags.includes(tag)) item.tags.push(tag);
	}
	rest = rest.replace(TAG_RE, " ");
	if (!old) {
		if (plain) item.kind = item.time || item.eventTag ? "event" : "note";
		if (item.kind === "task" && item.status !== "moved") {
			// A task's arrow is an assignment: → W44 (이달 중), → 11/05, 11/07 (분배 칸)
			const wm = WEEK_ASSIGN_RE.exec(rest);
			if (wm) {
				item.assignWeek = wm[1].split(",").map((x) => parseInt(x.trim().slice(1), 10));
				rest = rest.slice(0, wm.index) + " " + rest.slice(wm.index + wm[0].length);
			}
			const am = ASSIGN_RE.exec(rest);
			if (am) {
				for (const part of am[1].split(",")) {
					const [mm, dd] = part.trim().split("/").map((x) => parseInt(x, 10));
					item.assignRaw.push([mm, dd]);
				}
				rest = rest.slice(0, am.index) + " " + rest.slice(am.index + am[0].length);
			} else if (!wm && (rest.includes("→") || rest.includes("->"))) {
				item.problems.push("→ 뒤를 배정(MM/DD, W주차)으로 읽지 못했어요. 옮긴 일이면 [>]로 바꿔 주세요");
			}
		} else {
			// The arrow of a [>] task or a plain item is "where it went".
			const am = ARROW_RE.exec(rest);
			if (am) {
				item.movedTo = moveTarget(am[1]);
				rest = rest.slice(0, am.index);
				if (plain && item.status === "scheduled") item.status = "moved";
			}
		}
	}
	item.text = cleanInline(rest);
	if (!old && !item.text) {
		item.ok = false;
		item.problems.push("내용이 비어 있어요");
	}
	if (!item.text) item.text = cleanInline(body) || body;
	item.goal = item.fields.find(([k]) => k === "goal")?.[1] ?? "";
	return item;
}

// ───────────────────────── lines & sections ─────────────────────────

/** Split text into lines, keeping the exact line terminators so we can rebuild byte-for-byte. */
export function splitLinesKeepEol(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		const j = text.indexOf("\n", i);
		if (j === -1) {
			out.push(text.slice(i));
			break;
		}
		out.push(text.slice(i, j + 1));
		i = j + 1;
	}
	return out;
}

/** Strip a trailing `\n` / `\r\n`. */
export function stripEol(line: string): string {
	return line.replace(/\r?\n$/, "");
}

/** Index of the first line after the frontmatter block (0 if none). */
export function frontmatterEnd(lines: string[]): number {
	if (lines.length && stripEol(lines[0]).replace(/^﻿/, "").trim() === "---") {
		for (let i = 1; i < lines.length; i++) {
			if (stripEol(lines[i]).trim() === "---") return i + 1;
		}
	}
	return 0;
}

export interface SourceLine {
	/** 0-based line index in the file. */
	index: number;
	/** The line without its terminator. */
	line: string;
	/** Parsed item, if it is a list line. */
	item: ParsedItem | null;
	/** Indentation depth in characters (for nested items). */
	indent: number;
}

export interface DaySection {
	found: boolean;
	/** 0-based index of the `### YYYY-MM-DD` heading line, or -1. */
	headingIndex: number;
	/** 0-based index range [start, end) of the body lines. */
	start: number;
	end: number;
	lines: SourceLine[];
}

function isFenceToggle(s: string): boolean {
	return /^\s*(```|~~~)/.test(s);
}

/** Parse body lines (skipping blanks, HTML comments) into SourceLines. */
export function parseBodyLines(allLines: string[], start: number, end: number): SourceLine[] {
	const out: SourceLine[] = [];
	let inComment = false;
	for (let i = start; i < end; i++) {
		const line = stripEol(allLines[i]);
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
		const lm = LIST_LINE_RE.exec(line);
		out.push({
			index: i,
			line,
			item: lm ? parseItem(lm[3].trim()) : null,
			indent: lm ? lm[1].replace(/\t/g, "    ").length : 0,
		});
	}
	return out;
}

/**
 * Find the `### YYYY-MM-DD` day section in a Desk Calendar month file. The body runs
 * until the next heading of any level (`## W..`, `### ...`).
 */
export function findDaySection(text: string, isoDate: string): DaySection {
	const lines = splitLinesKeepEol(text);
	const startAt = frontmatterEnd(lines);
	const headRe = new RegExp(`^###\\s+${isoDate.replace(/-/g, "\\-")}\\s*$`);
	let inFence = false;
	for (let i = startAt; i < lines.length; i++) {
		const s = stripEol(lines[i]);
		if (isFenceToggle(s)) inFence = !inFence;
		if (inFence) continue;
		if (headRe.test(s.trim())) {
			let end = lines.length;
			let fence = false;
			for (let j = i + 1; j < lines.length; j++) {
				const t = stripEol(lines[j]);
				if (isFenceToggle(t)) fence = !fence;
				if (!fence && HEADING_RE.test(t)) {
					end = j;
					break;
				}
			}
			return { found: true, headingIndex: i, start: i + 1, end, lines: parseBodyLines(lines, i + 1, end) };
		}
	}
	return { found: false, headingIndex: -1, start: -1, end: -1, lines: [] };
}

// ───────────────────────── dates ─────────────────────────

export function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

/** Local-time ISO date (YYYY-MM-DD). */
export function toIsoDate(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse YYYY-MM-DD into a local Date at noon (avoids DST edge cases). */
export function fromIsoDate(s: string): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
	if (!m) return null;
	const d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
	if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
	return d;
}

export function addDays(iso: string, n: number): string {
	const d = fromIsoDate(iso);
	if (!d) return iso;
	d.setDate(d.getDate() + n);
	return toIsoDate(d);
}
