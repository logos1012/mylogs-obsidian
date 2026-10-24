/**
 * Project Folders write operations, following `05 Project Folders/AGENTS.md`:
 * - 「3-4. 작업 기록」: monthly log entry, hub (`updated`, …), log index (`latest_log`, `updated`,
 *   최근 작업), registry row (상태, 다음 행동, 갱신).
 * - 「3-5. 상태 바꾸기 · 완료하기」: hub `status` / `completed` / 한 줄 결과, registry row
 *   「진행 중」 → 「완료」 with the new path.
 * - 「4. 등록부 형식」: `99 작업실/Project Folders Index.md` tables and 「변경 기록」.
 *
 * Every function is a pure `text → text` transform for ONE file and leaves the bytes it isn't
 * about as they were. Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { frontmatterEnd, splitLinesKeepEol, stripEol } from "../parser.ts";
import { prependChangeLog } from "../pinboard/index-writer.ts";
import { appendToSection, detectEol, findSection, getSectionContent, listSections, replaceSectionContent, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { AI_DRAFT, DECISIONS_SECTION, monthlyLogRel, type Project, STATE_SECTION } from "./model.ts";

export const REGISTRY_FILE = "Project Folders Index.md";
export const TEMPLATE_DIR = "템플릿";
export const ACTIVE_TABLE = "진행 중";
export const DONE_TABLE = "완료";
export const PLUGIN_MARK = "(플러그인)";

// ───────────────────────── frontmatter helpers ─────────────────────────

/** YAML scalar: plain when safe, otherwise double-quoted. */
export function yamlScalar(v: string): string {
	const s = v.trim();
	if (s === "") return "";
	if (/^[^\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/:\s|\s#|:$/.test(s) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s)) return s;
	return JSON.stringify(s);
}

function fmLineIndex(lines: string[], key: string): number {
	const end = frontmatterEnd(lines);
	const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
	for (let i = 1; i < end - 1; i++) if (re.test(stripEol(lines[i]))) return i;
	return -1;
}

/** Split `value   # comment` (quotes respected). */
function splitComment(raw: string): { value: string; comment: string } {
	const r = raw.replace(/^\s+/, "");
	if (r[0] === '"' || r[0] === "'") {
		const close = r.indexOf(r[0], 1);
		if (close > 0) return { value: r.slice(0, close + 1), comment: r.slice(close + 1).replace(/^\s*$/, "") };
	}
	const m = /\s+#/.exec(r);
	return m ? { value: r.slice(0, m.index), comment: r.slice(m.index) } : { value: r.replace(/\s+$/, ""), comment: "" };
}

/** The raw scalar of a frontmatter key, unquoted, without a trailing `# comment` ("" when absent). */
export function getFmValue(text: string, key: string): string {
	const lines = splitLinesKeepEol(text);
	const i = fmLineIndex(lines, key);
	if (i === -1) return "";
	const raw = stripEol(lines[i]).replace(/^[^:]*:/, "");
	return splitComment(raw)
		.value.trim()
		.replace(/^(["'])(.*)\1$/, "$2");
}

/** Like `setFrontmatterScalar`, but keeps a trailing `# comment` on the line. `value` is written as given. */
export function setFmValue(text: string, key: string, value: string): string {
	const lines = splitLinesKeepEol(text);
	const i = fmLineIndex(lines, key);
	if (i === -1) return setFrontmatterScalar(text, key, value);
	const s = stripEol(lines[i]);
	const keyPart = /^[^:]*:/.exec(s)![0];
	const { value: old, comment } = splitComment(s.slice(keyPart.length));
	if (old === value) return text;
	lines[i] = `${keyPart}${value ? ` ${value}` : ""}${comment}${lines[i].slice(s.length)}`;
	return lines.join("");
}

// ───────────────────────── hub ─────────────────────────

export interface HubChange {
	today: string;
	status?: string;
	/** Set `started` (only written when given). */
	started?: string;
	completed?: string;
	/** 한 줄 결과 → `- **결과:** …` in 「현재 상태」. */
	result?: string;
	/** A 「주요 결정」 line `- {today} — {decision}`. */
	decision?: string;
}

/**
 * Status change on a hub (「3-5」): `status`, `updated`; `started` the day it becomes `진행`
 * (only if still empty, 「3-2」 4); for 완료 also `completed` and the 한 줄 결과.
 */
export function applyHubChange(text: string, c: HubChange): string {
	let out = text;
	if (c.status !== undefined) out = setFmValue(out, "status", yamlScalar(c.status));
	const startedNow = getFmValue(out, "started");
	if (c.started !== undefined) out = setFmValue(out, "started", c.started);
	else if (c.status === "진행" && !startedNow) out = setFmValue(out, "started", c.today);
	if (c.completed !== undefined) out = setFmValue(out, "completed", c.completed);
	if (c.result) out = setResultLine(out, c.result);
	if (c.decision) out = appendToSection(out, DECISIONS_SECTION, `- ${c.today} — ${oneLine(c.decision)}`);
	out = setFmValue(out, "updated", c.today);
	return out;
}

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** Replace `- **결과:** …` in 「현재 상태」, or add it at the end of the section. */
export function setResultLine(text: string, result: string): string {
	const line = `- **결과:** ${oneLine(result)}`;
	const cur = getSectionContent(text, STATE_SECTION);
	if (cur === null) return replaceSectionContent(text, STATE_SECTION, line);
	const lines = cur.split("\n");
	const i = lines.findIndex((l) => /^\s*[-*+]\s+(\*\*)?결과\s*:/.test(l));
	if (i >= 0) lines[i] = line;
	else lines.push(line);
	return replaceSectionContent(text, STATE_SECTION, lines.join("\n"));
}

/** The text for 「지금 가장 효과적인 한 가지 행동」 as written in the registry (with `(AI 초안)`). */
export function actionCell(p: Pick<Project, "action" | "actionDraft">): string {
	if (!p.action) return "";
	return p.actionDraft ? `${p.action} ${AI_DRAFT}` : p.action;
}

// ───────────────────────── monthly log ─────────────────────────

export interface LogEntry {
	date: string;
	title: string;
	context: string;
	done: string;
	result: string;
	decision: string;
	open: string;
	next: string;
	evidence: string;
}

/** One entry in the monthly-log format (`맥락 / 수행 / 결과 / 결정 / 미해결 / 다음 / 근거`). */
export function formatLogEntry(e: LogEntry): string {
	const f = (k: string, v: string) => `- **${k}:** ${oneLine(v)}`.replace(/\s+$/, "");
	return [
		`## ${e.date} — ${oneLine(e.title)}`,
		"",
		f("맥락", e.context),
		f("수행", e.done),
		f("결과", e.result),
		f("결정", e.decision),
		f("미해결", e.open),
		f("다음", e.next),
		f("근거", e.evidence),
	].join("\n");
}

/** Append an entry at the end of an existing monthly log. */
export function appendLogEntry(text: string, entry: string): string {
	const eol = detectEol(text);
	return text.replace(/\s*$/, "") + eol + eol + entry.split("\n").join(eol) + eol;
}

function fillNames(template: string, name: string, ym: string): string {
	return template.split("{{프로젝트명}}").join(name).replace(/YYYY-MM(?!-DD)/g, ym);
}

/** A new monthly log from `템플릿/월별 로그.md`: the template's sample entry is replaced by `entry`. */
export function newMonthlyLog(template: string, name: string, ym: string, entry: string): string {
	const lines = template.split(/\r?\n/);
	const fmEnd = frontmatterEnd(lines.map((l) => l + "\n"));
	let cut = lines.findIndex((l, i) => i >= fmEnd && /^##\s/.test(l));
	if (cut === -1) cut = lines.length;
	const head = fillNames(lines.slice(0, cut).join("\n"), name, ym).replace(/\s*$/, "");
	return `${head}\n\n${entry}\n`;
}

// ───────────────────────── log index ─────────────────────────

export const RECENT_SECTION = "최근 작업";
export const PERIODS_SECTION = "기간별 로그";

function isEmptyBullet(l: string): boolean {
	return /^\s*[-*+]\s*$/.test(l);
}

/** Log index update (「3-4」 3): `latest_log`, `updated`, 최근 작업 (newest first), 기간별 로그 link. */
export function updateLogIndex(text: string, o: { name: string; ym: string; today: string; recent: string }): string {
	let out = setFmValue(text, "latest_log", JSON.stringify(monthlyLogRel(o.name, o.ym)));
	out = setFmValue(out, "updated", o.today);
	const recent = (getSectionContent(out, RECENT_SECTION) ?? "").split("\n").filter((l) => l.trim() && !isEmptyBullet(l));
	out = replaceSectionContent(out, RECENT_SECTION, [`- ${o.today}: ${oneLine(o.recent)}`, ...recent].join("\n"));
	const link = `[[${o.name} 로그 ${o.ym}]]`;
	const periods = getSectionContent(out, PERIODS_SECTION) ?? "";
	if (!periods.includes(link)) {
		const kept = periods.split("\n").filter((l) => l.trim() && !isEmptyBullet(l));
		out = replaceSectionContent(out, PERIODS_SECTION, [...kept, `- ${link}`].join("\n"));
	}
	return out;
}

/** A new log index from `템플릿/로그 인덱스.md`. */
export function newLogIndex(template: string, o: { name: string; ym: string; today: string; recent: string }): string {
	const filled = fillNames(template, o.name, o.ym);
	return updateLogIndex(filled, o);
}

/** Project `AGENTS.md`: keep `latest_log` and the 「문서 지도」 line pointing at the newest monthly log. */
export function updateProjectAgents(text: string, o: { name: string; ym: string; today: string }): string {
	const rel = monthlyLogRel(o.name, o.ym);
	if (getFmValue(text, "latest_log") === rel) return text;
	let out = setFmValue(text, "latest_log", JSON.stringify(rel));
	out = out.replace(/(최신 월별 로그:\s*`)[^`]*(`)/, `$1${rel}$2`);
	return setFmValue(out, "updated", o.today);
}

// ───────────────────────── registry (Project Folders Index.md) ─────────────────────────

export interface ActiveRow {
	id: string;
	name: string;
	aliases: string;
	scope: string;
	area: string;
	kind: string;
	status: string;
	action: string;
	goals: string;
	path: string;
	updated: string;
}

export interface DoneRow {
	id: string;
	name: string;
	scope: string;
	started: string;
	completed: string;
	result: string;
	path: string;
}

/** Header label → row field. Labels follow 「4. 등록부 형식」. */
const ACTIVE_COLS: Record<string, keyof ActiveRow> = {
	id: "id",
	프로젝트: "name",
	별칭: "aliases",
	"개인/회사": "scope",
	area: "area",
	유형: "kind",
	상태: "status",
	"지금 가장 효과적인 한 가지 행동": "action",
	목표: "goals",
	경로: "path",
	갱신: "updated",
};
const DONE_COLS: Record<string, keyof DoneRow> = {
	id: "id",
	프로젝트: "name",
	"개인/회사": "scope",
	시작: "started",
	완료: "completed",
	"한 줄 결과": "result",
	경로: "path",
};

/** Escape a value for one table cell. */
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

/** Section whose `##` name equals or starts with `prefix` (e.g. `완료` matches `완료 (Archive Box)`). */
function sectionByPrefix(text: string, prefix: string): string | null {
	return listSections(text).find((n) => n === prefix || n.startsWith(`${prefix} `) || n.startsWith(`${prefix}(`)) ?? null;
}

interface TableInfo {
	headers: string[];
	/** Line index of the separator row. */
	sep: number;
	/** Line indexes of data rows. */
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
		if (i === header + 1) {
			if (!isSeparator(s)) return null;
			const info: TableInfo = { headers: splitRow(stripEol(lines[header])), sep: i, rows: [] };
			for (let j = i + 1; j < end && isTableLine(stripEol(lines[j])); j++) info.rows.push(j);
			return info;
		}
	}
	return null;
}

function rowLine<T>(headers: string[], cols: Record<string, keyof T>, row: Partial<T>, base: string[] = []): string {
	const cells = headers.map((h, i) => {
		const k = cols[h];
		const v = k !== undefined ? row[k] : undefined;
		return v !== undefined ? cellText(String(v)) : (base[i] ?? "");
	});
	return `| ${cells.join(" | ")} |`;
}

/** Parse both tables (for 「3-1」 lookup and duplicate checks). */
export function parseRegistry(text: string): { active: ActiveRow[]; done: DoneRow[] } {
	const read = <T>(prefix: string, cols: Record<string, keyof T>): T[] => {
		const name = sectionByPrefix(text, prefix);
		const sec = name ? findSection(text, name) : null;
		if (!sec) return [];
		const range = sectionLineRange(text, sec);
		const lines = splitLinesKeepEol(text);
		const t = readTable(lines, range.start, range.end);
		if (!t) return [];
		return t.rows.map((i) => {
			const cells = splitRow(stripEol(lines[i]));
			const row = {} as Record<string, string>;
			t.headers.forEach((h, j) => {
				const k = cols[h];
				if (k !== undefined) row[k as string] = (cells[j] ?? "").replace(/\\\|/g, "|");
			});
			return row as T;
		});
	};
	return { active: read<ActiveRow>(ACTIVE_TABLE, ACTIVE_COLS), done: read<DoneRow>(DONE_TABLE, DONE_COLS) };
}

export type RegistryResult = { ok: true; text: string; added: boolean } | { ok: false; reason: string };

/**
 * Update the row `row.id` in one table, setting only the given fields (others keep their text).
 * When the row is absent it is appended (with `full` when given, 「3-6」: add the row from the hub).
 */
function upsertRow<T extends { id: string }>(text: string, prefix: string, cols: Record<string, keyof T>, row: Partial<T> & { id: string }, full?: T): RegistryResult {
	const name = sectionByPrefix(text, prefix);
	const sec = name ? findSection(text, name) : null;
	if (!sec) return { ok: false, reason: `등록부에 「${prefix}」 표가 없어요` };
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const t = readTable(lines, range.start, range.end);
	if (!t) return { ok: false, reason: `등록부 「${prefix}」 표를 읽지 못했어요` };
	const idCol = t.headers.indexOf("id");
	const eol = detectEol(text);
	for (const i of t.rows) {
		const s = stripEol(lines[i]);
		const cells = splitRow(s);
		if (cells[idCol] !== row.id) continue;
		const next = rowLine(t.headers, cols, row, cells);
		if (next !== s) lines[i] = next + lines[i].slice(s.length);
		return { ok: true, text: lines.join(""), added: false };
	}
	const after = t.rows.length ? t.rows[t.rows.length - 1] : t.sep;
	const line = rowLine(t.headers, cols, { ...(full ?? {}), ...row } as Partial<T>);
	if (!/\n$/.test(lines[after])) lines[after] += eol;
	lines.splice(after + 1, 0, line + eol);
	return { ok: true, text: lines.join(""), added: true };
}

/** Remove the row with `id` from a table. */
function removeRow(text: string, prefix: string, id: string): { text: string; removed: boolean } {
	const name = sectionByPrefix(text, prefix);
	const sec = name ? findSection(text, name) : null;
	if (!sec) return { text, removed: false };
	const range = sectionLineRange(text, sec);
	const lines = splitLinesKeepEol(text);
	const t = readTable(lines, range.start, range.end);
	if (!t) return { text, removed: false };
	const idCol = t.headers.indexOf("id");
	const i = t.rows.find((j) => splitRow(stripEol(lines[j]))[idCol] === id);
	if (i === undefined) return { text, removed: false };
	lines.splice(i, 1);
	return { text: lines.join(""), removed: true };
}

/** 「3-4」 4 / 「3-2」 7: update (or add) a 「진행 중」 row. */
export function upsertActiveRow(text: string, row: Partial<ActiveRow> & { id: string }, full?: ActiveRow): RegistryResult {
	return upsertRow<ActiveRow>(text, ACTIVE_TABLE, ACTIVE_COLS, row, full);
}

/** 「3-5」 완료 3: move the row from 「진행 중」 to 「완료」 with the new path. */
export function moveRowToDone(text: string, done: DoneRow): RegistryResult {
	const r = removeRow(text, ACTIVE_TABLE, done.id);
	return upsertRow<DoneRow>(r.text, DONE_TABLE, DONE_COLS, done, done);
}

/** `- {today}: {entry}` at the top of 「변경 기록」, and frontmatter `updated`. */
export function logRegistryChange(text: string, today: string, entry: string): string {
	return setFrontmatterScalar(prependChangeLog(text, today, entry), "updated", today);
}

/** Registry row for a project, from its hub (aliases are kept from the existing row). */
export function activeRowOf(p: Project, aliases = ""): ActiveRow {
	return {
		id: p.id,
		name: p.title,
		aliases,
		scope: p.scope,
		area: p.area,
		kind: p.kind,
		status: p.status,
		action: actionCell(p),
		goals: p.goals.join(", "),
		path: p.folder,
		updated: p.updated,
	};
}

// ───────────────────────── 「3-4」 texts for a status change ─────────────────────────

export interface StatusChangeTexts {
	entry: LogEntry;
	/** 로그 인덱스 「최근 작업」 line (without date). */
	recent: string;
	/** 허브 「주요 결정」 line (without date). */
	decision: string;
	/** 등록부 「변경 기록」 line (without date). */
	change: string;
}

/** `진행` → `진행으로`, `대기` → `대기로` (받침 없거나 ㄹ이면 「로」). */
export function withRo(word: string): string {
	const c = word.charCodeAt(word.length - 1);
	if (c < 0xac00 || c > 0xd7a3) return `${word}(으)로`;
	const jong = (c - 0xac00) % 28;
	return `${word}${jong === 0 || jong === 8 ? "로" : "으로"}`;
}

/** What the log, hub, index and registry say about a status change made on the board. */
export function statusChangeTexts(p: Project, to: string, today: string, opts: { result?: string; review?: boolean } = {}): StatusChangeTexts {
	const from = p.status;
	const same = from === to;
	const title = same ? `리뷰: ${to} 유지` : `상태 변경: ${from} → ${to}`;
	const next = to === "완료" ? "없음 (완료, Archive Box로 옮김)" : actionCell(p) || "미확인";
	const decision = same ? `${to} 상태를 계속 유지한다. 사용자 확인 (${STALE_DAYS_LABEL} 리뷰)` : `상태를 ${from}에서 ${withRo(to)} 바꾼다. 사용자 결정`;
	return {
		entry: {
			date: today,
			title,
			context: opts.review ? `${STALE_DAYS_LABEL} 넘게 갱신이 없어 "계속 / 보류 / 종료"를 물음` : "MyLogs Project Folders 화면에서 사용자가 상태를 바꿈",
			done: same ? "허브 `updated` 갱신" : `허브 \`status\`를 ${withRo(to)} 변경${to === "완료" ? ", 폴더를 Archive Box로 옮김" : ""}`,
			result: to === "완료" && opts.result ? `완료. ${opts.result}` : `status: ${to}`,
			decision: `${decision}`,
			open: "없음",
			next,
			evidence: "MyLogs 플러그인, 사용자 조작",
		},
		recent: title,
		decision,
		change: `${p.id} ${same ? `${to} 유지 확인` : `상태 ${from} → ${to}`}${to === "완료" && !same ? ", 「완료」 표로 옮김" : ""} ${PLUGIN_MARK}`,
	};
}

const STALE_DAYS_LABEL = "14일";

/** `## 지금 가장 효과적인 한 가지 행동` body for a new hub. */
export function actionSectionBody(action: string): string {
	return `- [ ] ${action.trim() || "미확인"}`;
}

