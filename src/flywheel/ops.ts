/**
 * Flywheel view edits and reads (`12 Flywheel/AGENTS.md` 「3」「4-1」「4-4」「5」, 계획 「10-1」).
 * Line edits only: a field line, the purpose paragraph, a new block before 「변경 기록」.
 *
 * Pure module (no Obsidian imports).
 */

import { TASK_LINE_RE } from "../parser.ts";
import { flywheelIdOf, type FlywheelElement } from "./model.ts";

export const MAX_ELEMENTS = 6;
export const CHANGELOG = "변경 기록";
/** Change-log words that mark a 요소 교체 (추가·폐기), limited to once a quarter (「1」). */
export const REPLACEMENT_MARK = "요소 교체";

/** Empty, or the template's `(채우기 …)` prompt: the user has not written this yet. */
export function isPlaceholder(v: string | undefined): boolean {
	const s = (v ?? "").trim();
	return !s || /^\(채우기/.test(s);
}

function eolOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The one-sentence purpose under `# Flywheel` (before the first `## `), or "". */
export function purposeOf(text: string): string {
	const lines = text.split(/\r?\n/);
	const h1 = lines.findIndex((l) => /^#\s/.test(l));
	if (h1 === -1) return "";
	const out: string[] = [];
	for (let i = h1 + 1; i < lines.length && !lines[i].startsWith("## "); i++) if (lines[i].trim()) out.push(lines[i].trim());
	return out.join(" ");
}

/** Replace the purpose paragraph (between `# Flywheel` and the first `## `). */
export function setPurpose(text: string, purpose: string): string {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	const h1 = lines.findIndex((l) => /^#\s/.test(l));
	if (h1 === -1) return text;
	let end = h1 + 1;
	while (end < lines.length && !lines[end].startsWith("## ")) end++;
	const body = purpose.trim() ? ["", purpose.trim().replace(/[\r\n]+/g, " "), ""] : [""];
	lines.splice(h1 + 1, end - (h1 + 1), ...body);
	return lines.join(eol);
}

/** [start, end) line range of the `## F-N …` block (end = next `## ` or EOF). */
function blockRange(lines: string[], id: string): { start: number; end: number } | null {
	const start = lines.findIndex((l) => l === `## ${id}` || l.startsWith(`## ${id} `));
	if (start === -1) return null;
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith("## ")) end++;
	return { start, end };
}

/**
 * Set `- key:: value` inside the element block (the line is replaced; a missing field is added after
 * the block's last field line). Returns null when the element is gone.
 */
export function setElementField(text: string, id: string, key: string, value: string): string | null {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	const r = blockRange(lines, id);
	if (!r) return null;
	const clean = value.replace(/[\r\n]+/g, " ").trim();
	let last = r.start;
	for (let i = r.start + 1; i < r.end; i++) {
		const m = /^- ([^:]+)::/.exec(lines[i]);
		if (!m) continue;
		last = i;
		if (m[1].trim() === key) {
			lines[i] = `- ${key}:: ${clean}`;
			return lines.join(eol);
		}
	}
	lines.splice(last + 1, 0, `- ${key}:: ${clean}`);
	return lines.join(eol);
}

/** Rename `## F-N old` → `## F-N new` (the id stays). */
export function renameElement(text: string, id: string, name: string): string | null {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	const r = blockRange(lines, id);
	if (!r) return null;
	lines[r.start] = `## ${id} ${name.replace(/[\r\n]+/g, " ").trim()}`;
	return lines.join(eol);
}

/** Next id: the largest `F-N` anywhere in the file (폐기 and change log included) + 1 — never reused. */
export function nextId(text: string): string {
	let max = 0;
	for (const m of text.matchAll(/\bF-(\d+)\b/g)) max = Math.max(max, parseInt(m[1], 10));
	return `F-${max + 1}`;
}

export interface NewElement {
	name: string;
	identity: string;
	min: string;
	normal: string;
	next: string;
}

/** Append a new 사용 block before 「변경 기록」 (or at the end). */
export function addElement(text: string, id: string, e: NewElement, today: string): string {
	const eol = eolOf(text);
	const block = [
		`## ${id} ${e.name.trim()}`,
		`- 정체성:: ${e.identity.trim()}`,
		`- 최소:: ${e.min.trim()}`,
		`- 보통:: ${e.normal.trim()}`,
		`- 다음:: ${e.next.trim()}`,
		"- 선행지표:: 매일 최소 행동 수행",
		"- goal:: ",
		"- status:: 사용",
		`- since:: ${today}`,
		"",
	];
	const lines = text.split(/\r?\n/);
	const at = lines.findIndex((l) => l === `## ${CHANGELOG}`);
	if (at === -1) {
		while (lines.length && lines[lines.length - 1] === "") lines.pop();
		lines.push("", ...block);
	} else lines.splice(at, 0, ...block);
	return lines.join(eol);
}

/** frontmatter `elements:` = elements not 폐기. */
export function countActive(elements: FlywheelElement[]): number {
	return elements.filter((e) => e.status !== "폐기").length;
}

/** 요소 교체 entries in the change log within `today`'s quarter. */
export function replacementsThisQuarter(text: string, today: string): number {
	const y = today.slice(0, 4);
	const q = Math.floor((+today.slice(5, 7) - 1) / 3);
	let n = 0;
	for (const m of text.matchAll(/^- (\d{4})-(\d{2})-\d{2}: (.*)$/gm)) {
		if (m[1] === y && Math.floor((+m[2] - 1) / 3) === q && m[3].includes(REPLACEMENT_MARK)) n++;
	}
	return n;
}

// ───────────────────────── 수행 ─────────────────────────

/** x 했음 · - 못 함 · 쉼 · "" 기록 없음 · out 운영 전/후 (분모에서 제외). */
export type DayMark = "x" | "-" | "쉼" | "" | "out";

/** `99 작업실/수행/{YYYY-MM}.md` → day (`DD`) → id → cell. */
export function parseLogTable(text: string | null): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	if (!text) return out;
	let cols: string[] | null = null;
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim().startsWith("|")) {
			cols = null;
			continue;
		}
		const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
		if (!cols) {
			cols = cells;
			continue;
		}
		if (/^-+$/.test(cells[0] ?? "") || !/^\d{1,2}$/.test(cells[0] ?? "")) continue;
		const row = new Map<string, string>();
		cols.forEach((c, i) => {
			if (/^F-\d+$/.test(c)) row.set(c, cells[i] ?? "");
		});
		out.set(cells[0].padStart(2, "0"), row);
	}
	return out;
}

/** The day's `(flywheel:: id)` task line state in a Daily Pad, or null when the line is not there. */
export function padMark(padText: string | null, id: string): "x" | "-" | null {
	if (padText === null) return null;
	for (const line of padText.split(/\r?\n/)) {
		if (flywheelIdOf(line) !== id) continue;
		const m = TASK_LINE_RE.exec(line);
		if (m) return m[2].toLowerCase() === "x" ? "x" : "-";
	}
	return null;
}

/** One day for one element: the Daily Pad line wins, then the 수행 표 cell; before `since` = out. */
export function dayMark(e: FlywheelElement, iso: string, padText: string | null, cell: string | undefined, resting = false): DayMark {
	const since = e.fields["since"] ?? "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(since) && iso < since) return "out";
	const p = padMark(padText, e.id);
	if (p) return p;
	const c = (cell ?? "").trim();
	if (c === "x" || c === "-" || c === "쉼") return c;
	// A resting element is left out of new Daily Pads (「4-2」 1): a pad without its line is a 쉼 day.
	if (resting && padText !== null) return "쉼";
	return "";
}

/** 「4-4」 1: n = 했음, 분모 = 운영 대상일 − 쉼 (기록 없음은 분모에 남고 따로 센다). */
export function weekRate(marks: DayMark[]): { done: number; denom: number; blank: number } {
	const live = marks.filter((m) => m !== "out" && m !== "쉼");
	return { done: live.filter((m) => m === "x").length, denom: live.length, blank: live.filter((m) => m === "").length };
}

/** Toggle `[ ]` ↔ `[x]` on the day's `(flywheel:: id)` line. Null when the line is not there. */
export function togglePadLine(padText: string, id: string): string | null {
	const lines = padText.split(/(?<=\n)/);
	for (let i = 0; i < lines.length; i++) {
		if (flywheelIdOf(lines[i]) !== id) continue;
		const m = TASK_LINE_RE.exec(lines[i].replace(/\r?\n$/, ""));
		if (!m) continue;
		const next = m[2].toLowerCase() === "x" ? " " : "x";
		lines[i] = lines[i].replace(/\[(.)\]/, `[${next}]`);
		return lines.join("");
	}
	return null;
}

