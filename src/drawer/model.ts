/**
 * Drawer model: `06 Drawer/Drawer.md` as described in `06 Drawer/AGENTS.md` 「3. 파일 형식」.
 *
 *   ## 보류 / ## 아이디어 / ## 프로젝트 후보      one line = one item
 *   - [ ] 내용 (when:: 조건) (from:: 출처) (added:: YYYY-MM-DD) (reviewed:: YYYY-MM-DD)
 *     - 맥락: 한두 줄 (선택)
 *   - [>] 내용 … → [[보낸 곳]]                   꺼냄 (departed, kept until the monthly review)
 *   - [-] 내용 … (why:: 이유)                    놓아줌
 *   ## 변경 기록                                  the registry (one line per write)
 *
 * The lifecycle stage is not stored; it is computed from the dates (「3」 생애 단계).
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { daysBetween } from "../pinboard/model.ts";
import { LIST_LINE_RE, type ParsedItem, parseBodyLines, splitLinesKeepEol, stripEol } from "../parser.ts";
import { findSection, sectionLineRange } from "../writer.ts";

export const DRAWER_SECTIONS = ["보류", "아이디어", "프로젝트 후보"] as const;
export type DrawerSection = (typeof DRAWER_SECTIONS)[number];
export const CHANGELOG_SECTION = "변경 기록";
export const CONTEXT_LABEL = "맥락";
/** `when::` value when the user insists on putting an item without a condition (「4-1」 1). */
export const WHEN_UNDECIDED = "미정";
/** `reviewed` this many days ago (or more) → "아직도 원하나요?" (「3」 오래됨). */
export const STALE_DAYS = 90;
/** Above this many active items the entrance has become loose (「1」, 「4-6」 5). */
export const TOO_MANY = 50;

export const CANDIDATE_TAGS = { drawer: "서랍후보", project: "프로젝트후보" } as const;

const GOAL_ID_RE = /^G-\d{4}-\d{2}(?:\.\d+)?$/;

export function isSection(s: string): s is DrawerSection {
	return (DRAWER_SECTIONS as readonly string[]).includes(s);
}

/** `G-2026-01.2` → a Pinboard goal id (「3」 조건 충족 is detected from it). */
export function goalIdOf(when: string): string | null {
	const w = when.trim();
	return GOAL_ID_RE.test(w) ? w : null;
}

export interface DrawerItem {
	section: DrawerSection;
	/** 0-based line index of the item line. */
	index: number;
	/** The item line as written (no terminator). */
	line: string;
	item: ParsedItem;
	text: string;
	/** Duplicate key: text without whitespace, lowercased. */
	key: string;
	when: string;
	/** `from::` sources as written, split on top-level commas. */
	from: string[];
	added: string;
	reviewed: string;
	/** `[ ]` active, `[>]` 꺼냄, `[-]` 놓아줌, `[x]` (not a Drawer state, shown as departed). */
	status: ParsedItem["status"];
	movedTo: string;
	why: string;
	/** The `- 맥락: …` sub-bullet (first one), or null. */
	context: { index: number; line: string; text: string } | null;
	/** Indices of every indented line that belongs to this item (sub-bullets). */
	subLines: number[];
	tags: string[];
	test: boolean;
	problems: string[];
}

export interface DrawerData {
	updated: string;
	items: DrawerItem[];
	/** Section → whether its `## heading` exists. */
	sections: Record<DrawerSection, boolean>;
	changelog: string[];
	hasChangelog: boolean;
}

/** Split `[[a]], [[b]], 대화 2026-10-24` on commas outside `[[ ]]` / `( )`. */
export function splitSources(s: string): string[] {
	const out: string[] = [];
	let cur = "";
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "[" || ch === "(") depth++;
		else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}

/** Pair key for duplicates (「4-1」 2: 같은 내용의 줄). */
export function normKey(text: string): string {
	return text.replace(/\s+/g, "").toLowerCase();
}

function field(it: ParsedItem, key: string): string {
	return it.fields.find(([k]) => k === key)?.[1].trim() ?? "";
}

function contextText(body: string): string | null {
	const m = new RegExp(`^${CONTEXT_LABEL}\\s*[:：]\\s*(.*)$`).exec(body.trim());
	return m ? m[1].trim() : null;
}

/** Parse `Drawer.md`. Never throws; unreadable lines get `problems`. */
export function parseDrawer(text: string): DrawerData {
	const lines = splitLinesKeepEol(text);
	const data: DrawerData = {
		updated: /^updated:\s*(\S+)/m.exec(text.slice(0, 400))?.[1] ?? "",
		items: [],
		sections: { 보류: false, 아이디어: false, "프로젝트 후보": false },
		changelog: [],
		hasChangelog: false,
	};
	for (const section of DRAWER_SECTIONS) {
		const r = findSection(text, section);
		if (!r) continue;
		data.sections[section] = true;
		const range = sectionLineRange(text, r);
		let cur: DrawerItem | null = null;
		for (const sl of parseBodyLines(lines, range.start, range.end)) {
			if (sl.indent > 0 && cur) {
				cur.subLines.push(sl.index);
				const lm = LIST_LINE_RE.exec(sl.line);
				const ctx = lm ? contextText(lm[3]) : null;
				if (ctx !== null && !cur.context) cur.context = { index: sl.index, line: sl.line, text: ctx };
				continue;
			}
			if (!sl.item) {
				cur = null;
				continue;
			}
			const it = sl.item;
			const problems = [...it.problems];
			if (it.kind !== "task") problems.push("Drawer 항목은 체크박스 줄이어야 해요");
			const when = field(it, "when");
			const added = field(it, "added");
			const reviewed = field(it, "reviewed");
			if (it.status === "scheduled") {
				if (!when) problems.push("when:: 조건이 없어요");
				if (!added) problems.push("added:: 날짜가 없어요");
				if (!reviewed) problems.push("reviewed:: 날짜가 없어요");
				if (/^\d{4}-\d{2}(-\d{2})?$/.test(when)) problems.push("when::에 날짜를 쓰지 않아요 (Drawer는 달력이 아니에요)");
			}
			cur = {
				section,
				index: sl.index,
				line: sl.line,
				item: it,
				text: it.text,
				key: normKey(it.text),
				when,
				from: splitSources(field(it, "from")),
				added,
				reviewed,
				status: it.status,
				movedTo: it.movedTo,
				why: field(it, "why"),
				context: null,
				subLines: [],
				tags: it.tags,
				test: it.test,
				problems,
			};
			data.items.push(cur);
		}
	}
	const log = findSection(text, CHANGELOG_SECTION);
	if (log) {
		data.hasChangelog = true;
		const range = sectionLineRange(text, log);
		for (let i = range.start; i < range.end; i++) {
			const s = stripEol(lines[i]).trim();
			if (s) data.changelog.push(s);
		}
	}
	return data;
}

// ───────────────────────── lifecycle (「3」 생애 단계) ─────────────────────────

export function isActive(it: Pick<DrawerItem, "status">): boolean {
	return it.status === "scheduled";
}

/** Departed lines (`[>]`, `[-]`) stay in place until the monthly review (「3」 나간 줄). */
export function isDeparted(it: Pick<DrawerItem, "status">): boolean {
	return it.status !== "scheduled";
}

/** 새로 들어옴: `added` is this month. */
export function isNew(it: Pick<DrawerItem, "added">, today: string): boolean {
	return !!it.added && it.added.slice(0, 7) === today.slice(0, 7);
}

/** Days since `reviewed` (null when unknown). */
export function daysSinceReview(it: Pick<DrawerItem, "reviewed" | "added">, today: string): number | null {
	const ref = it.reviewed || it.added;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(ref)) return null;
	return daysBetween(ref, today);
}

/** 오래됨: 90 days since `reviewed` → "아직도 원하나요?". */
export function isStale(it: Pick<DrawerItem, "reviewed" | "added" | "status">, today: string, days = STALE_DAYS): boolean {
	if (!isActive(it)) return false;
	const n = daysSinceReview(it, today);
	return n !== null && n >= days;
}

export interface ColumnData {
	section: DrawerSection;
	active: DrawerItem[];
	departed: DrawerItem[];
}

/** Items per section, active first (file order), departed at the bottom. */
export function columns(data: DrawerData): ColumnData[] {
	return DRAWER_SECTIONS.map((section) => {
		const all = data.items.filter((i) => i.section === section);
		return { section, active: all.filter(isActive), departed: all.filter(isDeparted) };
	});
}

export function activeCount(data: DrawerData): number {
	return data.items.filter(isActive).length;
}

/** The active item with the same text (「4-1」 2), if any. */
export function findDuplicate(data: DrawerData, text: string): DrawerItem | null {
	const k = normKey(text);
	return data.items.find((i) => isActive(i) && i.key === k) ?? null;
}
