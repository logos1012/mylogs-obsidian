/**
 * Toolbox write operations, following `11 Toolbox/AGENTS.md`:
 * - 「4-1」 스킬 만들기: the file from `_Templates/스킬.md` (`status: 멈춤`), a registry row, 「변경 기록」 `만듦`.
 * - 「4-2」 스킬 고치기: frontmatter + `updated`; the registry row when schedule·output·status·이름 changed.
 * - 「4-4」 6 / plan 「지금 실행」: `- [ ] T-NN (requested:: YYYY-MM-DDTHH:MM)` under 「실행 요청」.
 * - 「4-5」 멈춤·폐기: `status`, the row (폐기 → 「폐기」 table), one 「변경 기록」 line.
 *
 * Every function is a pure `text → text` transform for ONE file and leaves the bytes it isn't
 * about as they were. Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { splitLinesKeepEol, stripEol } from "../parser.ts";
import { prependChangeLog } from "../pinboard/index-writer.ts";
import { getFmValue, setFmValue, yamlScalar } from "../projects/ops.ts";
import { appendToSection, detectEol, findSection, getSectionContent, listSections, replaceSectionContent, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { CHANGELOG_SECTION, type DiscardRow, nameLink, PURPOSE_SECTION, type RunRequest, type Skill, type SkillEdit, type SkillInput, type SkillRow, skillEditChanges } from "./model.ts";

export const SKILLS_TABLE = "스킬";
export const DISCARD_TABLE = "폐기";
export const REQUESTS_SECTION = "실행 요청";
export const PLUGIN_MARK = "(플러그인)";

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

// ───────────────────────── template placeholders ─────────────────────────

/** `{{date:FORMAT}}` (YYYY MM DD HH mm ss), `{{date}}`, `{{title}}` — the Obsidian core-template tokens. */
export function fillPlaceholders(text: string, o: { date: Date; title: string }): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const d = o.date;
	const fmt = (f: string) =>
		f
			.replace(/YYYY/g, String(d.getFullYear()))
			.replace(/MM/g, p(d.getMonth() + 1))
			.replace(/DD/g, p(d.getDate()))
			.replace(/HH/g, p(d.getHours()))
			.replace(/mm/g, p(d.getMinutes()))
			.replace(/ss/g, p(d.getSeconds()));
	return text
		.replace(/\{\{\s*date(?::([^}]*))?\s*\}\}/g, (_m, f: string | undefined) => fmt(f ?? "YYYY-MM-DD"))
		.replace(/\{\{\s*title\s*\}\}/g, o.title);
}

/** Template placeholders left over (empty = clean). */
export function leftoverPlaceholders(text: string): string[] {
	const out: string[] = [];
	if (text.includes("{{")) out.push("{{…}}");
	if (/^id:\s*T-00\s*$/m.test(text)) out.push("id: T-00");
	return out;
}

// ───────────────────────── skill file ─────────────────────────

/** `schedule` is always quoted (「3」 example); empty when the trigger isn't cron. */
function scheduleScalar(trigger: string, schedule: string): string {
	return JSON.stringify(trigger === "cron" ? schedule.trim() : "");
}

/** 「4-1」 2: a new skill file from `_Templates/스킬.md`. `status: 멈춤`; 「목적」 = 하는 일. */
export function fillSkillTemplate(template: string, i: SkillInput, id: string, now: Date): string {
	const name = i.name.trim();
	const today = fillPlaceholders("{{date}}", { date: now, title: name });
	let t = fillPlaceholders(template, { date: now, title: name });
	t = setFmValue(t, "id", id);
	t = setFmValue(t, "name", yamlScalar(name));
	t = setFmValue(t, "trigger", i.trigger);
	t = setFmValue(t, "schedule", scheduleScalar(i.trigger, i.schedule));
	t = setFmValue(t, "output", yamlScalar(i.output));
	t = setFmValue(t, "notify", yamlScalar(i.notify));
	t = setFmValue(t, "status", "멈춤");
	for (const k of ["last_reviewed", "created", "updated"]) t = setFmValue(t, k, today);
	t = replaceSectionContent(t, PURPOSE_SECTION, oneLine(i.purpose));
	return t;
}

/** 「4-5」 / status toggle: `status` and `updated`. */
export function setSkillStatus(text: string, status: string, today: string): string {
	return setFmValue(setFmValue(text, "status", status), "updated", today);
}

/** A skill's own 「변경 기록」 line (`- YYYY-MM-DD: …`, appended at the end — the file's order). */
export function appendSkillLog(text: string, today: string, entry: string): string {
	return appendToSection(text, CHANGELOG_SECTION, `- ${today}: ${oneLine(entry)}`);
}

/**
 * 「4-2」: frontmatter `name` / `trigger` / `schedule` / `output` / `notify`, the H1, `updated`, and
 * one 「변경 기록」 line. Returns the text unchanged when nothing differs.
 */
export function applySkillEdit(text: string, s: Skill, e: SkillEdit, today: string): string {
	const changes = skillEditChanges(s, e);
	if (!changes.length) return text;
	const name = e.name.trim();
	let out = text;
	if (name !== s.name) {
		out = setFmValue(out, "name", yamlScalar(name));
		const lines = splitLinesKeepEol(out);
		const i = lines.findIndex((l) => stripEol(l).trim() === `# ${s.name}`);
		if (i !== -1) {
			lines[i] = `# ${name}` + lines[i].slice(stripEol(lines[i]).length);
			out = lines.join("");
		}
	}
	if (e.trigger !== s.trigger) out = setFmValue(out, "trigger", e.trigger);
	const schedule = e.trigger === "cron" ? e.schedule.trim() : "";
	if (schedule !== getFmValue(out, "schedule")) out = setFmValue(out, "schedule", JSON.stringify(schedule));
	if (e.output.trim() !== s.output) out = setFmValue(out, "output", yamlScalar(e.output));
	if (e.notify.trim() !== s.notify) out = setFmValue(out, "notify", yamlScalar(e.notify));
	out = setFmValue(out, "updated", today);
	return appendSkillLog(out, today, `수정: ${changes.join(", ")} ${PLUGIN_MARK}`);
}

// ───────────────────────── tables ─────────────────────────

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
/** `` `x` `` → `x`. */
function unbacktick(s: string): string {
	return s.replace(/^`(.*)`$/, "$1");
}
function backtick(s: string): string {
	const t = oneLine(s);
	return t ? `\`${t}\`` : "";
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

function sectionByPrefix(text: string, prefix: string): string | null {
	return listSections(text).find((n) => n === prefix || n.startsWith(`${prefix} `) || n.startsWith(`${prefix}(`)) ?? null;
}

function tableOf(text: string, prefix: string): { lines: string[]; t: TableInfo } | null {
	const name = sectionByPrefix(text, prefix);
	const sec = name ? findSection(text, name) : null;
	if (!sec) return null;
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const t = readTable(lines, range.start, range.end);
	return t ? { lines, t } : null;
}

/** Header label → row field (「Toolbox Index.md」 columns). Cell writers / readers per field. */
const SKILL_COLS: Record<string, keyof SkillRow> = {
	id: "id",
	이름: "nameCell",
	"하는 일": "purpose",
	트리거: "trigger",
	schedule: "schedule",
	출력: "output",
	담당: "owner",
	상태: "status",
	"마지막 실행": "lastRun",
	결과: "lastResult",
	"마지막 검토": "lastReviewed",
};
const CODE_COLS: (keyof SkillRow)[] = ["schedule", "output"];
const DISCARD_COLS: Record<string, keyof DiscardRow> = { id: "id", 이름: "nameCell", 폐기일: "date", 이유: "reason" };

function readRows<T>(text: string, prefix: string, cols: Record<string, keyof T>, code: (keyof T)[] = []): T[] {
	const tb = tableOf(text, prefix);
	if (!tb) return [];
	return tb.t.rows.map((i) => {
		const cells = splitRow(stripEol(tb.lines[i]));
		const row = {} as Record<string, string>;
		for (const k of Object.values(cols)) row[k as string] = "";
		tb.t.headers.forEach((h, j) => {
			const k = cols[h];
			if (k === undefined) return;
			const raw = cells[j] ?? "";
			// The 이름 cell keeps its escaped pipe (it is a wikilink alias).
			row[k as string] = k === "nameCell" ? raw : code.includes(k) ? unbacktick(raw.replace(/\\\|/g, "|")) : raw.replace(/\\\|/g, "|");
		});
		return row as T;
	});
}

function rowLine<T>(headers: string[], cols: Record<string, keyof T>, row: Partial<T>, code: (keyof T)[], base: string[] = []): string {
	const cells = headers.map((h, i) => {
		const k = cols[h];
		const v = k !== undefined ? row[k] : undefined;
		if (v === undefined) return base[i] ?? "";
		if (k === "nameCell") return oneLine(String(v));
		return code.includes(k!) ? backtick(String(v)) : cellText(String(v));
	});
	return `| ${cells.join(" | ")} |`;
}

/** Parse the whole registry: 「스킬」 rows, 「폐기」 rows, 「실행 요청」 lines. */
export function parseToolboxRegistry(text: string): { skills: SkillRow[]; discarded: DiscardRow[]; requests: RunRequest[] } {
	return {
		skills: readRows<SkillRow>(text, SKILLS_TABLE, SKILL_COLS, CODE_COLS),
		discarded: readRows<DiscardRow>(text, DISCARD_TABLE, DISCARD_COLS),
		requests: parseRunRequests(text),
	};
}

export type RegistryResult = { ok: true; text: string; added: boolean } | { ok: false; reason: string };

function upsertRow<T extends { id: string }>(text: string, prefix: string, cols: Record<string, keyof T>, code: (keyof T)[], row: Partial<T> & { id: string }, full?: T): RegistryResult {
	const tb = tableOf(text, prefix);
	if (!tb) return { ok: false, reason: `등록부에 「${prefix}」 표가 없어요` };
	const { lines, t } = tb;
	const idCol = t.headers.indexOf("id");
	const eol = detectEol(text);
	for (const i of t.rows) {
		const s = stripEol(lines[i]);
		const cells = splitRow(s);
		if (cells[idCol] !== row.id) continue;
		const next = rowLine(t.headers, cols, row, code, cells);
		if (next !== s) lines[i] = next + lines[i].slice(s.length);
		return { ok: true, text: lines.join(""), added: false };
	}
	const after = t.rows.length ? t.rows[t.rows.length - 1] : t.sep;
	const line = rowLine(t.headers, cols, { ...(full ?? {}), ...row } as Partial<T>, code);
	if (!/\n$/.test(lines[after])) lines[after] += eol;
	lines.splice(after + 1, 0, line + eol);
	return { ok: true, text: lines.join(""), added: true };
}

function removeRow(text: string, prefix: string, id: string): { text: string; removed: boolean } {
	const tb = tableOf(text, prefix);
	if (!tb) return { text, removed: false };
	const idCol = tb.t.headers.indexOf("id");
	const i = tb.t.rows.find((j) => splitRow(stripEol(tb.lines[j]))[idCol] === id);
	if (i === undefined) return { text, removed: false };
	tb.lines.splice(i, 1);
	return { text: tb.lines.join(""), removed: true };
}

/** Update (or add, with `full`) one 「스킬」 row; only the given cells change. */
export function upsertSkillRow(text: string, row: Partial<SkillRow> & { id: string }, full?: SkillRow): RegistryResult {
	return upsertRow<SkillRow>(text, SKILLS_TABLE, SKILL_COLS, CODE_COLS, row, full);
}

/** 「4-5」 폐기: the row leaves 「스킬」 and lands in 「폐기」 (폐기일, 이유). */
export function moveRowToDiscarded(text: string, d: DiscardRow): RegistryResult {
	const r = removeRow(text, SKILLS_TABLE, d.id);
	return upsertRow<DiscardRow>(r.text, DISCARD_TABLE, DISCARD_COLS, [], d, d);
}

/** The registry row a skill file says it should have (file = canonical). */
export function skillRowOf(s: Skill, folder: string): SkillRow {
	return {
		id: s.id,
		nameCell: nameLink(folder, s.name),
		purpose: s.purpose,
		trigger: s.trigger,
		schedule: s.trigger === "cron" ? s.schedule : "",
		output: s.output,
		owner: s.owner,
		status: s.status,
		lastRun: s.lastRun,
		lastResult: s.lastResult,
		lastReviewed: s.lastReviewed,
	};
}

/** `- {today}: {entry}` at the top of 「변경 기록」 (newest first, like the other registries) + `updated`. */
export function logToolboxChange(text: string, today: string, entry: string): string {
	return setFrontmatterScalar(prependChangeLog(text, today, oneLine(entry)), "updated", today);
}

// ───────────────────────── 실행 요청 ─────────────────────────

const REQUEST_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(T-\d+)\s*\(requested::\s*([^)]*)\)\s*$/;

export function parseRunRequests(text: string): RunRequest[] {
	const content = getSectionContent(text, REQUESTS_SECTION);
	if (content === null) return [];
	const out: RunRequest[] = [];
	for (const line of content.split("\n")) {
		const m = REQUEST_RE.exec(line);
		if (m) out.push({ id: m[2], requested: m[3].trim(), done: m[1] !== " ", line: line.trim() });
	}
	return out;
}

export function requestLine(id: string, stamp: string): string {
	return `- [ ] ${id} (requested:: ${stamp})`;
}

/**
 * Append `- [ ] T-NN (requested:: stamp)` under 「실행 요청」. The section's HTML comment (format
 * hint) is kept; the section is created when missing. Frontmatter `updated` is set (no 「변경 기록」
 * line: a request is not a change, 「4-4」 4).
 */
export function appendRunRequest(text: string, id: string, stamp: string, today: string): string {
	const out = appendToSection(text, REQUESTS_SECTION, requestLine(id, stamp));
	return setFrontmatterScalar(out, "updated", today);
}

// ───────────────────────── 「변경 기록」 texts ─────────────────────────

export const changeText = {
	status: (status: string, name: string) => `${status} 「${name}」 ${PLUGIN_MARK}`,
	discard: (name: string, reason: string) => `폐기 「${name}」${reason.trim() ? `: ${oneLine(reason)}` : ""} ${PLUGIN_MARK}`,
	create: (id: string, name: string, i: Pick<SkillInput, "trigger" | "schedule">) => `${id} 「${name}」 만듦 (멈춤, ${i.trigger}${i.trigger === "cron" && i.schedule.trim() ? ` ${i.schedule.trim()}` : ""}) ${PLUGIN_MARK}`,
	edit: (id: string, name: string, changes: string[]) => `${id} 「${name}」 수정: ${changes.join(", ")} ${PLUGIN_MARK}`,
	register: (id: string, name: string) => `${id} 「${name}」 등록부에 행 추가 (파일은 있었음) ${PLUGIN_MARK}`,
};
