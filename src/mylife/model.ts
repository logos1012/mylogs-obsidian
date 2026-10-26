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

import { fromIsoDate, pad2 } from "../parser.ts";
import { parseFrontmatterText } from "../pinboard/model.ts";
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
	daily: ["하루", "한 일", "결정", INSIGHT_SECTION, "열린 질문", "보낸 곳", "놓아준 일", LOG_SECTION, "끼적임", DIARY_LINKS_SECTION, "세션"],
	weekly: ["한 주", "진전 (Pinboard 대조)", "한 일", "결정", INSIGHT_SECTION, "계획과 실제", "놓아준 일", "반복 주제", USER_NOTE_SECTION, "날짜"],
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
