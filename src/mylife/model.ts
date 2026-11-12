/**
 * My Life model: the read-only record files of `08 My Life/` (`08 My Life/AGENTS.md` 「2」「4」).
 *
 *   01 Daily/{YYYY}/{YYYY-MM}/{YYYY-MM-DD}.md
 *   02 Weekly/{GGGG}/{GGGG-Www}.md          ISO week; the folder is the ISO week-year
 *   03 Monthly/{YYYY}/{YYYY-MM}.md
 *   04 Yearly/{YYYY}.md
 *
 * A file is frontmatter + `# title` + `## section` cards in template order (`_Templates/`). Hermes
 * writes everything; the plugin only shows it, except `## 사용자 한마디` (Weekly and up), which the
 * user writes (「1」, 「6」). `aggregateDiary` (깨달음·감상 + 로그 across a month) feeds the Diary view's
 * 「My Life에서」 material section (「4-6」); the My Life view itself has no Diary tab any more.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { addDays, fromIsoDate, pad2 } from "../parser.ts";
import { parseFrontmatterText } from "../pinboard/model.ts";
import { hasWorkTag } from "../side.ts";
import { detectEol, findSection, getSectionContent, listSections, setFrontmatterScalar, splitBody } from "../writer.ts";

export const MY_LIFE_UNITS = ["daily", "weekly", "monthly", "yearly"] as const;
export type MyLifeUnit = (typeof MY_LIFE_UNITS)[number];
export type MyLifeTab = MyLifeUnit;
export const MY_LIFE_TABS: readonly MyLifeTab[] = MY_LIFE_UNITS;

export const DEFAULT_MY_LIFE_PATH = "08 My Life";
export const USER_NOTE_SECTION = "사용자 한마디";
export const INSIGHT_SECTION = "깨달음·감상";
export const LOG_SECTION = "로그";
/** Daily's links to that day's Diary entries (Hermes writes them; `09 Diary/AGENTS.md` 「4-3」). */
export const DIARY_LINKS_SECTION = "Diary";
/** Yearly's counterpart of 깨달음·감상 (「4-6」). Not aggregated by `aggregateDiary` (it is a month view). */
export const YEAR_SENTENCES_SECTION = "해의 문장들";
/** Weekly's running summary of the week so far; Tear-off rewrites it each evening (AGENTS 「4-2-1」). */
export const WEEK_FLOW_SECTION = "이번 주 흐름";
/** Weekly's per-day 개인/회사 lines (`### YYYY-MM-DD (요일)` + `- 개인:` / `- 회사:`), right after 「이번 주 흐름」. */
export const DAY_FLOW_SECTION = "요일별 흐름";
/** Daily's list of what got done (`#회사` lines are 회사, the rest 개인). */
export const DONE_SECTION = "한 일";
/** Daily's opening paragraph (the 「이번 주 흐름」 card shows all of it on the day header: `dayText`). */
export const DAY_SECTION = "하루";

export const UNIT_FOLDER: Record<MyLifeUnit, string> = {
	daily: "01 Daily",
	weekly: "02 Weekly",
	monthly: "03 Monthly",
	yearly: "04 Yearly",
};

export const UNIT_LABEL: Record<MyLifeUnit, string> = {
	daily: "오늘",
	weekly: "이번 주",
	monthly: "이번 달",
	yearly: "올해",
};

/** Section names of `_Templates/{Daily,Weekly,Monthly,Yearly}.md`, in template order. */
export const TEMPLATE_SECTIONS: Record<MyLifeUnit, readonly string[]> = {
	daily: [DAY_SECTION, DONE_SECTION, "결정", INSIGHT_SECTION, "열린 질문", "보낸 곳", "놓아준 일", LOG_SECTION, "메모", DIARY_LINKS_SECTION, "세션"],
	weekly: [WEEK_FLOW_SECTION, DAY_FLOW_SECTION, "한 주", "진전 (Pinboard 대조)", "한 일", "결정", INSIGHT_SECTION, "계획과 실제", "놓아준 일", "반복 주제", USER_NOTE_SECTION, "날짜"],
	monthly: [
		"한 달",
		"목표 대조 (Pinboard)",
		"한 일 (주별)",
		"결정",
		INSIGHT_SECTION,
		"계획과 실제",
		"서랍",
		"놓아준 일",
		"반복 주제 · 프로젝트 후보",
		"다음 달로",
		USER_NOTE_SECTION,
		"주",
	],
	yearly: ["한 해", "목표 결산 (Pinboard)", "달별 한 줄", "큰 결정", YEAR_SENTENCES_SECTION, "놓아준 것", "숫자", "다음 해로", USER_NOTE_SECTION, "달"],
};

/** Frontmatter `type` of each unit. */
export const UNIT_TYPE: Record<MyLifeUnit, string> = {
	daily: "my-life-daily",
	weekly: "my-life-weekly",
	monthly: "my-life-monthly",
	yearly: "my-life-yearly",
};

// ───────────────────────── dates ─────────────────────────

/** ISO-8601 week and week-year (the Thursday of the week decides the year). */
export function isoWeek(iso: string): { year: number; week: number } {
	const d = fromIsoDate(iso);
	if (!d) return { year: 0, week: 0 };
	const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const day = (t.getUTCDay() + 6) % 7;
	t.setUTCDate(t.getUTCDate() - day + 3);
	const year = t.getUTCFullYear();
	const week = Math.floor((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 / 7) + 1;
	return { year, week };
}

/** `2026-W01` */
export function isoWeekKey(iso: string): string {
	const { year, week } = isoWeek(iso);
	return `${year}-W${pad2(week)}`;
}

/** Monday of the ISO week containing `iso`. */
export function weekMonday(iso: string): string {
	const d = fromIsoDate(iso);
	if (!d) return iso;
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * The 7 ISO dates, Monday..Sunday, of the ISO week containing `iso`
 * (2025-12-29 → 2025-12-29..2026-01-04, i.e. 2026-W01). An invalid date gives `[]`.
 */
export function weekDates(iso: string): string[] {
	if (!fromIsoDate(iso)) return [];
	const mon = weekMonday(iso);
	return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

/** `YYYY-MM` → the same key `n` months later (negative = earlier). */
export function shiftMonthKey(key: string, n: number): string {
	const m = /^(\d{4})-(\d{2})$/.exec(key);
	if (!m) return key;
	const idx = +m[1] * 12 + (+m[2] - 1) + n;
	return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

// ───────────────────────── paths ─────────────────────────

function root(folder: string): string {
	const r = folder.trim().replace(/^\/+|\/+$/g, "");
	return r || DEFAULT_MY_LIFE_PATH;
}

export function dailyPath(folder: string, iso: string): string {
	return `${root(folder)}/${UNIT_FOLDER.daily}/${iso.slice(0, 4)}/${iso.slice(0, 7)}/${iso}.md`;
}

export function weeklyPath(folder: string, iso: string): string {
	const key = isoWeekKey(iso);
	return `${root(folder)}/${UNIT_FOLDER.weekly}/${key.slice(0, 4)}/${key}.md`;
}

export function monthlyPath(folder: string, iso: string): string {
	return `${root(folder)}/${UNIT_FOLDER.monthly}/${iso.slice(0, 4)}/${iso.slice(0, 7)}.md`;
}

export function yearlyPath(folder: string, iso: string): string {
	return `${root(folder)}/${UNIT_FOLDER.yearly}/${iso.slice(0, 4)}.md`;
}

export function unitPath(folder: string, unit: MyLifeUnit, iso: string): string {
	switch (unit) {
		case "daily":
			return dailyPath(folder, iso);
		case "weekly":
			return weeklyPath(folder, iso);
		case "monthly":
			return monthlyPath(folder, iso);
		case "yearly":
			return yearlyPath(folder, iso);
	}
}

/** The folder that holds a month's Daily files (for the Diary view's 「My Life에서」). */
export function dailyMonthFolder(folder: string, monthKey: string): string {
	return `${root(folder)}/${UNIT_FOLDER.daily}/${monthKey.slice(0, 4)}/${monthKey}`;
}

/** `YYYY-MM-DD` from a Daily file name, or null. */
export function dateOfDailyName(basename: string): string | null {
	const m = /^(\d{4}-\d{2}-\d{2})$/.exec(basename.trim());
	return m && fromIsoDate(m[1]) ? m[1] : null;
}

/** What the heading of each tab shows for a date: `2026-W02 (01/05~01/11)`, `2026-01`, `2026`. */
export function unitTitle(unit: MyLifeUnit, iso: string): string {
	switch (unit) {
		case "daily":
			return iso;
		case "weekly": {
			const mon = weekMonday(iso);
			const d = fromIsoDate(mon);
			if (!d) return isoWeekKey(iso);
			const sun = new Date(d);
			sun.setDate(sun.getDate() + 6);
			const mmdd = (x: Date) => `${pad2(x.getMonth() + 1)}/${pad2(x.getDate())}`;
			return `${isoWeekKey(iso)} (${mmdd(d)}~${mmdd(sun)})`;
		}
		case "monthly":
			return iso.slice(0, 7);
		case "yearly":
			return iso.slice(0, 4);
	}
}

// ───────────────────────── 이번 주 흐름 (daily tab card) ─────────────────────────

/** Markdown → plain text for a one-line preview: links to their labels, emphasis/list marks dropped. */
function plainText(md: string): string {
	return stripComments(md)
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[.\]\s+)?|\d+[.)]\s+)/gm, "")
		.replace(/(\*\*|__|~~|`)/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The preview of a Daily: the first sentence of `## 하루` as plain text (comments and link syntax
 * removed, whitespace collapsed), or the first paragraph when no sentence end is found, or null
 * when the section is missing or empty. A sentence ends at `.` `?` `!` `。` `…` (closing quotes or
 * brackets may follow) and then whitespace or the end, so `5.5km` and `1/22~23` do not split.
 */
export function dayLine(text: string): string | null {
	const content = getSectionContent(text, DAY_SECTION);
	if (content === null) return null;
	const paragraphs = stripComments(content)
		.split(/\n\s*\n/)
		.map(plainText)
		.filter(Boolean);
	const first = paragraphs[0];
	if (!first) return null;
	const m = /^.*?[.?!。…]+["'”’」』)\]]*(?=\s|$)/u.exec(first);
	return m ? m[0].trim() : first;
}

/**
 * `## 이번 주 흐름` of a Weekly, verbatim (trimmed), or null when the section is missing or holds
 * nothing but HTML comments and whitespace (a mid-week `status: 초안` file keeps the template comment).
 */
export function flowOf(weeklyText: string): string | null {
	const content = getSectionContent(weeklyText, WEEK_FLOW_SECTION);
	if (content === null || !stripComments(content).trim()) return null;
	return content.trim();
}

/** The whole `## 하루` of a Daily (comments stripped, trimmed) for the day header's tooltip, or null. */
export function dayText(text: string): string | null {
	const content = getSectionContent(text, DAY_SECTION);
	if (content === null) return null;
	const t = stripComments(content).trim();
	return t || null;
}

/** One day's lines of `## 요일별 흐름`: the value written after `- 개인:` / `- 회사:`, or null when no such line. */
export interface DayFlow {
	personal: string | null;
	company: string | null;
}

/** The explicit "nothing" a writer puts in a scope (`- 회사: —`): shown as 「—」, no Daily fallback. */
export const NONE_MARK = "—";

/**
 * Shared walker for `- 개인:` / `- 회사:` bullets (Weekly `## 요일별 흐름` and `## 이번 주 흐름`).
 *
 * HTML comments (also multi-line) are removed first, so template examples never count. A value runs
 * until the next bullet or heading; continuation lines are trimmed and joined with `\n`, the result
 * trimmed (inner markdown kept). Fullwidth `：` is accepted. `onHeading` gets each heading's text and
 * returns the target that following bullets fill (null → ignore them until the next heading).
 * `onValue` gets every bullet found, even a blank one ("" — the caller decides what that means).
 */
function walkScopeBullets(
	text: string,
	start: DayFlow | null,
	onHeading: (title: string) => DayFlow | null,
	onValue: (target: DayFlow, key: keyof DayFlow, value: string) => void,
): void {
	let target = start;
	let key: keyof DayFlow | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (target && key) onValue(target, key, buf.join("\n").trim());
		key = null;
		buf = [];
	};
	for (const line of stripComments(text).split("\n")) {
		const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
		if (h) {
			flush();
			target = onHeading(h[1].trim());
			continue;
		}
		const b = /^\s*[-*+]\s+(.*)$/.exec(line);
		if (b) {
			flush();
			const s = /^(개인|회사)\s*[:：]\s?(.*)$/.exec(b[1]);
			if (s && target) {
				key = s[1] === "회사" ? "company" : "personal";
				buf = [s[2]];
			}
			continue;
		}
		if (key) buf.push(line.trim());
	}
	flush();
}

/**
 * Parse Weekly `## 요일별 흐름` into ISO date → {personal, company}.
 *
 *   ### 2026-11-09 (월)
 *   - 개인: 한두 문장
 *     이어지는 줄
 *   - 회사: —
 *
 * Bullet rules: {@link walkScopeBullets}. The weekday label after the date is optional and ignored.
 * A blank value counts as no line (null). Headings with an invalid date are skipped (and their lines
 * ignored). A valid heading without 개인/회사 lines still appears, with nulls.
 * Missing or comment-only section → empty map.
 */
export function parseDayFlow(weeklyText: string): Map<string, DayFlow> {
	const out = new Map<string, DayFlow>();
	const content = getSectionContent(weeklyText, DAY_FLOW_SECTION);
	if (content === null) return out;
	walkScopeBullets(
		content,
		null,
		(title) => {
			const d = /^(\d{4}-\d{2}-\d{2})(?:\s|$)/.exec(title);
			if (!d || !fromIsoDate(d[1])) return null;
			const day = out.get(d[1]) ?? { personal: null, company: null };
			out.set(d[1], day);
			return day;
		},
		(day, key, value) => {
			day[key] = value ? value : null;
		},
	);
	return out;
}

/**
 * The 「오늘까지 흐름」 block, from Weekly `## 이번 주 흐름` (AGENTS.md v2.3 「4-2-1」):
 * - `rows`: at least one `- 개인:` / `- 회사:` bullet (comments stripped first). A scope is null when
 *   its bullet is missing, blank or exactly `—` — shown as a quiet 「—」.
 * - `legacy`: no such bullet but other text (the older paragraph format) — the section as {@link flowOf}.
 * - null: section missing, or only comments / whitespace (placeholder).
 */
export type FlowSummary =
	| { kind: "rows"; personal: string | null; company: string | null }
	| { kind: "legacy"; text: string };

export function flowSummary(weeklyText: string): FlowSummary | null {
	const legacy = flowOf(weeklyText);
	if (legacy === null) return null;
	const content = getSectionContent(weeklyText, WEEK_FLOW_SECTION) ?? "";
	const rows: DayFlow = { personal: null, company: null };
	let found = false;
	walkScopeBullets(
		content,
		rows,
		() => rows,
		(t, key, value) => {
			found = true;
			t[key] = value && value !== NONE_MARK ? value : null;
		},
	);
	return found ? { kind: "rows", ...rows } : { kind: "legacy", text: legacy };
}

/** A `## 한 일` line → short display text: link labels, no tags, no trailing `(…)` fields. */
function itemText(body: string): string {
	let t = body
		.replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(^|\s)#[^\s#()[\],.]+/gu, "$1")
		.replace(/\(\s*[\w가-힣-]+\s*::[^)]*\)/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	// Trailing source parens: (세션: …), (Daily Pad), (발송·실행 미확인) stays only if mid-line.
	for (;;) {
		const m = /\s*\((?:세션\s*[:：][^)]*|Daily Pad)\)\s*$/.exec(t);
		if (!m) break;
		t = t.slice(0, m.index).trim();
	}
	return t;
}

/**
 * `## 한 일` of a Daily split by side: a line with `#회사` is company, any other is personal
 * (`side.ts`). Top-level list items only (nested lines are ignored); comments stripped.
 */
export function dailyItemsByScope(dailyText: string): { personal: string[]; company: string[] } {
	const out = { personal: [] as string[], company: [] as string[] };
	const content = getSectionContent(dailyText, DONE_SECTION);
	if (content === null) return out;
	for (const line of stripComments(content).split("\n")) {
		const m = /^[-*+]\s+(?:\[.\]\s+)?(.*)$/.exec(line);
		if (!m) continue;
		const text = itemText(m[1]);
		if (!text) continue;
		(hasWorkTag(m[1]) ? out.company : out.personal).push(text);
	}
	return out;
}

export type WeekFlowScopeCell =
	| { kind: "flow"; text: string }
	| { kind: "items"; items: string[]; more: number }
	| { kind: "empty" };

export interface WeekFlowCell {
	personal: WeekFlowScopeCell;
	company: WeekFlowScopeCell;
}

/** How many Daily 「한 일」 lines a cell shows before 「외 N건」. */
export const WEEK_FLOW_ITEMS_MAX = 3;

/**
 * What a day's 개인/회사 cell shows, per scope: the Weekly 「요일별 흐름」 value first (`—` means
 * an explicit none: empty, no fallback); else up to 3 Daily 「한 일」 lines (+ more count); else empty.
 */
export function weekFlowCell(dayFlow: DayFlow | null | undefined, items: { personal: string[]; company: string[] } | null | undefined): WeekFlowCell {
	const one = (flow: string | null | undefined, list: string[] | undefined): WeekFlowScopeCell => {
		if (typeof flow === "string" && flow.trim()) {
			return flow.trim() === NONE_MARK ? { kind: "empty" } : { kind: "flow", text: flow.trim() };
		}
		if (list && list.length) {
			return { kind: "items", items: list.slice(0, WEEK_FLOW_ITEMS_MAX), more: Math.max(0, list.length - WEEK_FLOW_ITEMS_MAX) };
		}
		return { kind: "empty" };
	};
	return { personal: one(dayFlow?.personal, items?.personal), company: one(dayFlow?.company, items?.company) };
}

/**
 * Frontmatter `flow_updated_at` → `HH:mm 기준` in KST (Asia/Seoul, UTC+9, no DST).
 * `2026-11-12T22:05:00+09:00` → `22:05 기준`; `…T13:05:00Z` → `22:05 기준`. A value without an
 * offset is read as KST already. Missing, empty, whitespace or unparseable → null (show no time).
 */
export function flowUpdatedLabel(value: unknown): string | null {
	if (value instanceof Date) value = value.toISOString();
	if (typeof value !== "string") return null;
	const v = value.trim();
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v);
	if (!m) return null;
	const [, y, mo, d, hh, mm, ss, tz] = m;
	if (+hh > 23 || +mm > 59) return null;
	if (!tz) return `${hh}:${mm} 기준`;
	let offsetMin = 0;
	if (tz.toUpperCase() !== "Z") {
		const t = /^([+-])(\d{2}):?(\d{2})$/.exec(tz)!;
		offsetMin = (t[1] === "-" ? -1 : 1) * (+t[2] * 60 + +t[3]);
	}
	const utc = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +(ss ?? 0)) - offsetMin * 60000;
	if (Number.isNaN(utc)) return null;
	const kst = new Date(utc + 9 * 3600000);
	return `${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())} 기준`;
}

/** `flow_updated_at` of a Weekly file's frontmatter as `HH:mm 기준`, or null. */
export function flowUpdatedOf(weeklyText: string): string | null {
	return flowUpdatedLabel(parseFrontmatterText(weeklyText).data.flow_updated_at);
}

// ───────────────────────── file → model ─────────────────────────

export interface MyLifeSection {
	name: string;
	/** Content as written (no leading/trailing blank lines, `\n` line endings). */
	content: string;
	/** True when the content is blank once HTML comments are removed. */
	empty: boolean;
	/** True when the name is in the unit's template. */
	inTemplate: boolean;
}

export interface MyLifeStat {
	key: string;
	label: string;
	value: string;
}

export interface MyLifeFile {
	unit: MyLifeUnit;
	frontmatter: Record<string, unknown>;
	/** The `# …` title line, or "" when missing. */
	title: string;
	sections: MyLifeSection[];
	stats: MyLifeStat[];
	sample: boolean;
	/** Frontmatter `status` (초안 | 작성됨 | 다시 씀 | 샘플), "" when missing. */
	status: string;
}

const STAT_LABEL: Record<string, string> = {
	sessions: "세션",
	items: "항목",
	let_go: "놓아줌",
	filtered: "걸러냄",
	status: "상태",
};
/** The compact stat row: sessions · items · let_go · filtered · status (「4-1」 5). */
export const STAT_KEYS = ["sessions", "items", "let_go", "filtered", "status"] as const;

function stripComments(s: string): string {
	return s.replace(/<!--[\s\S]*?-->/g, "");
}

function titleOf(body: string): string {
	let inFence = false;
	for (const raw of body.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence;
		if (inFence) continue;
		const m = /^#\s+(.*?)\s*#*\s*$/.exec(raw);
		if (m) return m[1].trim();
		if (/^##\s/.test(raw)) break;
	}
	return "";
}

/** `sample: true`, `status: 샘플` or a `#sample` tag in the body (AGENTS 「7」 가상 데이터). */
export function isSample(fm: Record<string, unknown>, body: string): boolean {
	if (fm.sample === true || fm.sample === "true") return true;
	if (String(fm.status ?? "").trim() === "샘플") return true;
	return /(^|\s)#sample(?![\w가-힣-])/.test(stripComments(body));
}

export function statsOf(fm: Record<string, unknown>): MyLifeStat[] {
	const out: MyLifeStat[] = [];
	for (const key of STAT_KEYS) {
		const v = fm[key];
		if (v === undefined || v === null || v === "") continue;
		out.push({ key, label: STAT_LABEL[key], value: String(v) });
	}
	return out;
}

/**
 * Parse one My Life file. Sections come in template order first (only those present), then any
 * extra `##` sections in file order. Content is verbatim.
 */
export function parseMyLifeFile(text: string, unit: MyLifeUnit): MyLifeFile {
	const { data, body } = parseFrontmatterText(text);
	const names = listSections(text);
	const template = TEMPLATE_SECTIONS[unit];
	const ordered = [...template.filter((n) => names.includes(n)), ...names.filter((n) => !template.includes(n))];
	const seen = new Set<string>();
	const sections: MyLifeSection[] = [];
	for (const name of ordered) {
		if (seen.has(name)) continue;
		seen.add(name);
		const content = getSectionContent(text, name) ?? "";
		sections.push({ name, content, empty: !stripComments(content).trim(), inTemplate: template.includes(name) });
	}
	return {
		unit,
		frontmatter: data,
		title: titleOf(body),
		sections,
		stats: statsOf(data),
		sample: isSample(data, body),
		status: String(data.status ?? "").trim(),
	};
}

/** Whether the unit's template has a `## 사용자 한마디` (Weekly and up). */
export function hasUserNote(unit: MyLifeUnit): boolean {
	return TEMPLATE_SECTIONS[unit].includes(USER_NOTE_SECTION);
}

/** The user's note as it is in the file (comments kept; the editor shows them), or null when the section is missing. */
export function userNoteOf(text: string): string | null {
	return getSectionContent(text, USER_NOTE_SECTION);
}

/**
 * Write the user's note into exactly `## 사용자 한마디`. Everything else is byte-for-byte unchanged,
 * except an `updated` frontmatter key when the file already has one (never added). Returns the
 * input unchanged when the section is missing (the plugin does not create sections: 「6」) or equal.
 */
export function setUserNote(text: string, content: string, today: string): string {
	const r = findSection(text, USER_NOTE_SECTION);
	if (!r) return text;
	const eol = detectEol(text);
	const parts = splitBody(text.slice(r.bodyStart, r.bodyEnd));
	const core = normalizeNote(content).split("\n").join(eol);
	if (core === parts.core) return text;
	let head = text.slice(0, r.bodyStart);
	if (!/\n$/.test(head)) head += eol;
	// Template shape: one blank line after the heading, one before the next heading (「4-1」 5 "빈 줄 하나").
	const body = core ? eol + core + eol + (r.hasNext ? eol : "") : r.hasNext ? eol : "";
	const out = head + body + text.slice(r.bodyEnd);
	if (out === text) return text;
	return hasFrontmatterKey(out, "updated") ? setFrontmatterScalar(out, "updated", today) : out;
}

export function hasFrontmatterKey(text: string, key: string): boolean {
	const { data } = parseFrontmatterText(text);
	return Object.prototype.hasOwnProperty.call(data, key);
}

/** Normalise textarea text the way the writer stores it (for dirty checks). */
export function normalizeNote(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\s+$/, "").replace(/^(?:[ \t]*\n)+/, "");
}

// ───────────────────────── 깨달음·감상 + 로그 across a month (Diary view 「My Life에서」) ─────────────────────────

export interface DiarySource {
	/** Vault path of the file (link target). */
	path: string;
	/** `YYYY-MM-DD` for a Daily, `YYYY-MM` for the Monthly. */
	date: string;
	text: string;
}

export interface DiaryEntry {
	/** `YYYY-MM-DD` (Daily) or `YYYY-MM` (Monthly). */
	date: string;
	unit: "daily" | "monthly";
	section: string;
	path: string;
	/** Section content, verbatim. */
	content: string;
}

export interface DiaryMonth {
	month: string;
	entries: DiaryEntry[];
	/** Daily files that were read (dates), in order. */
	days: string[];
	hasMonthly: boolean;
}

function sectionEntry(src: DiarySource, unit: "daily" | "monthly", section: string): DiaryEntry | null {
	const content = getSectionContent(src.text, section);
	if (content === null || !stripComments(content).trim()) return null;
	return { date: src.date, unit, section, path: src.path, content };
}

/**
 * Collect the Diary of one month (「4-6」): every Daily's `## 깨달음·감상` and `## 로그` in date order,
 * then the Monthly's `## 깨달음·감상` when present. Content is verbatim; sections that are missing
 * or blank are skipped. Dailies outside `month` are ignored.
 */
export function aggregateDiary(month: string, dailies: DiarySource[], monthly: DiarySource | null): DiaryMonth {
	const days = dailies
		.filter((d) => d.date.startsWith(month + "-") && fromIsoDate(d.date))
		.sort((a, b) => a.date.localeCompare(b.date));
	const entries: DiaryEntry[] = [];
	for (const d of days) {
		for (const section of [INSIGHT_SECTION, LOG_SECTION]) {
			const e = sectionEntry(d, "daily", section);
			if (e) entries.push(e);
		}
	}
	if (monthly) {
		const e = sectionEntry(monthly, "monthly", INSIGHT_SECTION);
		if (e) entries.push(e);
	}
	return { month, entries, days: days.map((d) => d.date), hasMonthly: !!monthly };
}

/** Is `monthKey` a `YYYY-MM`? */
export function isMonthKey(s: string): boolean {
	return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}
