/**
 * Toolbox write operations, following `11 Toolbox/AGENTS.md`:
 * - 「4-1」 스킬 만들기: the file from `_Templates/스킬.md` with the kind's body sections (「3」;
 *   `status` 작업·도구 멈춤 / 운영 사용), a row in the kind's table, 「변경 기록」 `만듦`.
 * - 「4-2」 스킬 고치기: frontmatter + `updated`; the registry row when schedule·output·status·이름 changed.
 * - 「4-4」 6 / plan 「지금 실행」: `- [ ] T-NN (requested:: YYYY-MM-DDTHH:MM)` under 「실행 요청」.
 * - 「4-5」 멈춤·폐기: `status`, the row (폐기 → 「폐기」 table), one 「변경 기록」 line.
 *
 * Every function is a pure `text → text` transform for ONE file and leaves the bytes it isn't
 * about as they were. Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { frontmatterEnd, splitLinesKeepEol, stripEol } from "../parser.ts";
import { prependChangeLog } from "../pinboard/index-writer.ts";
import { getFmValue, setFmValue, yamlScalar } from "../projects/ops.ts";
import { appendToSection, detectEol, findSection, getSectionContent, listSections, replaceSectionContent, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { CHANGELOG_SECTION, type DiscardRow, descriptionWithPhrase, editDelta, firstLine, initialStatus, inputKind, KIND_ORDER, nameLink, PHRASE_SECTION, PURPOSE_SECTION, type RunRequest, SCOPE_SECTION, type Skill, type SkillEdit, type SkillInput, type SkillKind, type SkillRow, skillEditChanges } from "./model.ts";

/** Before v2.0 the registry had one 「스킬」 table: read (and written) as 작업 when 「작업」 is missing. */
export const LEGACY_JOB_TABLE = "스킬";
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

/** Frontmatter keys only 작업 has (「3」: 작업만). */
export const JOB_ONLY_KEYS = ["trigger", "schedule", "output", "notify", "last_run", "last_result"] as const;

function mapFrontmatter(text: string, f: (line: string) => string | null): string {
	const lines = splitLinesKeepEol(text);
	const end = frontmatterEnd(lines);
	if (end === 0) return text;
	const out: string[] = [lines[0]];
	for (let i = 1; i < end - 1; i++) {
		const s = stripEol(lines[i]);
		const next = f(s);
		if (next !== null) out.push(next + lines[i].slice(s.length));
	}
	return [...out, ...lines.slice(end - 1)].join("");
}

/** The template's guidance comments (`key: value   # …`, `key:   # …`) dropped; quoted values kept whole. */
export function stripFrontmatterComments(text: string): string {
	return mapFrontmatter(text, (s) => {
		const m = /^([A-Za-z0-9_-]+\s*:)(.*)$/.exec(s);
		if (!m) return s;
		const v = m[2].trim();
		if (v.startsWith("#")) return m[1];
		if (v[0] === '"' || v[0] === "'") return s;
		const c = /\s+#/.exec(m[2]);
		return c ? (m[1] + m[2].slice(0, c.index)).replace(/\s+$/, "") : s;
	});
}

export function removeFrontmatterKeys(text: string, keys: readonly string[]): string {
	return mapFrontmatter(text, (s) => {
		const m = /^([A-Za-z0-9_-]+)\s*:/.exec(s);
		return m && keys.includes(m[1]) ? null : s;
	});
}

/** 「3」 본문 섹션 for 도구 and 운영 (작업 uses the template's own body). */
export function kindBody(kind: Exclude<SkillKind, "작업">, o: { title: string; today: string; phrase?: string; scope?: string }): string {
	const sec = (name: string, body: string) => `## ${name}\n\n${body}\n`;
	const parts =
		kind === "도구"
			? [
					sec("목적", "<!-- 한 문단. 사용자가 이 말을 하면 무엇이 하나 나오는가. -->"),
					sec("트리거", `${oneLine(o.phrase ?? "")}\n\n<!-- 사용자가 이렇게 말하면 쓴다. 같은 말이 description에도 들어간다. -->`),
					sec("절차", "1. \n2. \n3. \n\n<!-- 실행 AI가 판단 없이 따를 수 있게. 결과물을 쓰는 폴더의 AGENTS 규칙을 반영한다. -->"),
					sec("금지", "- "),
					sec("완료 조건", "- [ ] "),
				]
			: [
					sec("목적", "<!-- 이 범위에서 일하는 방식의 계약. 볼트 AGENTS의 절차를 복사하지 않는다. -->"),
					sec("범위", oneLine(o.scope ?? "")),
					sec("시작할 때", "1. \n\n<!-- 어느 AGENTS를 먼저 읽는가. -->"),
					sec("경계", "- \n\n<!-- 무엇을 묻고, 무엇을 혼자 하지 않는가. -->"),
					sec("완료 보고", "- \n\n<!-- 언제 완료라고 말하는가. -->"),
				];
	return `# ${o.title}\n\n${parts.join("\n")}\n${sec(CHANGELOG_SECTION, `- ${o.today}: 만듦.`)}`;
}

/**
 * 「4-1」 2: a new skill file from `_Templates/스킬.md`. The template's frontmatter comments go;
 * `status` 작업·도구 멈춤 / 운영 사용. 작업 keeps the template body (「목적」 = 하는 일) and its
 * 작업-only keys; 도구·운영 get their own body sections (「3」) and lose the 작업-only keys.
 */
export function fillSkillTemplate(template: string, i: SkillInput, id: string, now: Date): string {
	const kind = inputKind(i);
	const name = i.name.trim();
	const today = fillPlaceholders("{{date}}", { date: now, title: name });
	let t = stripFrontmatterComments(fillPlaceholders(template, { date: now, title: name }));
	t = setFmValue(t, "id", id);
	t = setFmValue(t, "name", yamlScalar(name));
	t = setFmValue(t, "kind", kind);
	if (i.slug !== undefined) t = setFmValue(t, "slug", i.slug.trim());
	const description = kind === "도구" ? descriptionWithPhrase(i.description ?? "", i.phrase ?? "") : oneLine(i.description ?? "");
	if (i.description !== undefined || kind !== "작업") t = setFmValue(t, "description", yamlScalar(description));
	if (i.owner?.trim()) t = setFmValue(t, "owner", i.owner.trim());
	t = setFmValue(t, "status", initialStatus(kind));
	for (const k of ["last_reviewed", "created", "updated"]) t = setFmValue(t, k, today);
	if (kind === "작업") {
		t = setFmValue(t, "trigger", i.trigger);
		t = setFmValue(t, "schedule", scheduleScalar(i.trigger, i.schedule));
		t = setFmValue(t, "output", yamlScalar(i.output));
		t = setFmValue(t, "notify", yamlScalar(i.notify));
		return replaceSectionContent(t, PURPOSE_SECTION, oneLine(i.purpose));
	}
	t = removeFrontmatterKeys(t, JOB_ONLY_KEYS);
	const lines = splitLinesKeepEol(t);
	const head = lines.slice(0, frontmatterEnd(lines)).join("");
	return head + kindBody(kind, { title: name, today, phrase: i.phrase, scope: i.scope });
}

/**
 * The first real line of `## section` set to `value` (도구 「트리거」 = 부르는 말, 운영 「범위」).
 * When that line is `old` it is replaced, otherwise `value` goes on top. A missing section is
 * inserted before 「변경 기록」 (or at the end).
 */
export function setSectionFirstLine(text: string, section: string, old: string, value: string): string {
	const v = oneLine(value);
	const content = getSectionContent(text, section);
	if (content === null) {
		if (!v) return text;
		const log = findSection(text, CHANGELOG_SECTION);
		if (!log) return replaceSectionContent(text, section, v);
		const eol = detectEol(text);
		const lines = splitLinesKeepEol(text);
		lines.splice(log.headingIndex, 0, `## ${section}${eol}`, eol, `${v}${eol}`, eol);
		return lines.join("");
	}
	const ls = content.split("\n");
	const i = ls.findIndex((l) => firstLine(l) !== "");
	if (i !== -1 && old && firstLine(ls[i]) === old) ls[i] = v;
	else if (v) ls.unshift(v);
	return replaceSectionContent(text, section, ls.join("\n"));
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
 * 「4-2」: frontmatter `kind` / `name` / `slug` / `description` / `owner` (and 작업's `trigger` /
 * `schedule` / `output` / `notify`), `status` when the new kind doesn't have it, 도구 「트리거」 /
 * 운영 「범위」 first line, the H1, `updated`, and one 「변경 기록」 line. Returns the text unchanged
 * when nothing differs. Body sections are not restructured on a kind change (the user does that).
 */
export function applySkillEdit(text: string, s: Skill, e: SkillEdit, today: string): string {
	const changes = skillEditChanges(s, e);
	if (!changes.length) return text;
	const d = editDelta(s, e);
	const name = d.name;
	let out = text;
	if (d.kind !== s.kind) out = setFmValue(out, "kind", d.kind);
	if (d.status !== s.status) out = setFmValue(out, "status", d.status);
	if (d.slug !== s.slug) out = setFmValue(out, "slug", d.slug);
	if (d.description !== s.description) out = setFmValue(out, "description", yamlScalar(d.description));
	if (d.owner !== s.owner) out = setFmValue(out, "owner", d.owner);
	if (d.phrase !== s.phrase) out = setSectionFirstLine(out, PHRASE_SECTION, s.phrase, d.phrase);
	if (d.scope !== s.scope) out = setSectionFirstLine(out, SCOPE_SECTION, s.scope, d.scope);
	if (name !== s.name) {
		out = setFmValue(out, "name", yamlScalar(name));
		const lines = splitLinesKeepEol(out);
		const i = lines.findIndex((l) => stripEol(l).trim() === `# ${s.name}`);
		if (i !== -1) {
			lines[i] = `# ${name}` + lines[i].slice(stripEol(lines[i]).length);
			out = lines.join("");
		}
	}
	if (d.kind === "작업") {
		if (d.trigger !== s.trigger) out = setFmValue(out, "trigger", d.trigger);
		if (d.schedule !== getFmValue(out, "schedule")) out = setFmValue(out, "schedule", JSON.stringify(d.schedule));
		if (d.output !== s.output) out = setFmValue(out, "output", yamlScalar(d.output));
		if (d.notify !== s.notify) out = setFmValue(out, "notify", yamlScalar(d.notify));
	}
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
	slug: "slug",
	범위: "scope",
	"부르는 말": "phrase",
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
/** Read without backticks but written plain. */
const SOFT_CODE_COLS: (keyof SkillRow)[] = ["slug"];
const DISCARD_COLS: Record<string, keyof DiscardRow> = { id: "id", 이름: "nameCell", 폐기일: "date", 이유: "reason" };

function readRows<T>(text: string, prefix: string, cols: Record<string, keyof T>, code: (keyof T)[] = [], soft: (keyof T)[] = []): T[] {
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
			row[k as string] = k === "nameCell" ? raw : code.includes(k) || soft.includes(k) ? unbacktick(raw.replace(/\\\|/g, "|")) : raw.replace(/\\\|/g, "|");
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

/** The section name of `kind`'s table in this registry (작업 falls back to the legacy 「스킬」). */
export function kindTable(text: string, kind: SkillKind): string {
	if (kind === "작업" && !sectionByPrefix(text, "작업") && sectionByPrefix(text, LEGACY_JOB_TABLE)) return LEGACY_JOB_TABLE;
	return kind;
}

/** The registry has a table for `kind` (작업 also accepts the legacy 「스킬」). */
export function hasKindTable(text: string, kind: SkillKind): boolean {
	return tableOf(text, kindTable(text, kind)) !== null;
}

/** Every table a kind's rows may be in (작업: 「작업」 and the legacy 「스킬」). */
function tablesOf(kind: SkillKind): string[] {
	return kind === "작업" ? ["작업", LEGACY_JOB_TABLE] : [kind];
}

/** Rows of one kind's table(s), each tagged with that kind. */
function readKindRows(text: string, kind: SkillKind): SkillRow[] {
	const out: SkillRow[] = [];
	for (const t of tablesOf(kind)) {
		if (!sectionByPrefix(text, t)) continue;
		for (const r of readRows<SkillRow>(text, t, SKILL_COLS, CODE_COLS, SOFT_CODE_COLS)) out.push({ ...r, kind });
	}
	return out;
}

/** Parse the whole registry: 「운영」·「도구」·「작업」 rows (in that order), 「폐기」 rows, 「실행 요청」 lines. */
export function parseToolboxRegistry(text: string): { skills: SkillRow[]; discarded: DiscardRow[]; requests: RunRequest[] } {
	return {
		skills: KIND_ORDER.flatMap((k) => readKindRows(text, k)),
		discarded: readRows<DiscardRow>(text, DISCARD_TABLE, DISCARD_COLS),
		requests: parseRunRequests(text),
	};
}

/** The table the row `id` is in now (null = in none). */
export function tableOfId(text: string, id: string): string | null {
	for (const k of KIND_ORDER)
		for (const t of tablesOf(k)) {
			const tb = tableOf(text, t);
			if (!tb) continue;
			const idCol = tb.t.headers.indexOf("id");
			if (tb.t.rows.some((j) => splitRow(stripEol(tb.lines[j]))[idCol] === id)) return t;
		}
	return null;
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

/**
 * Update one row where it is (any kind table); only the given cells change. A missing row is
 * added (with `full`) to the table of `full.kind` (or `row.kind`, else 작업).
 */
export function upsertSkillRow(text: string, row: Partial<SkillRow> & { id: string }, full?: SkillRow): RegistryResult {
	const table = tableOfId(text, row.id) ?? kindTable(text, full?.kind ?? row.kind ?? "작업");
	const { kind: _k, ...cells } = row;
	return upsertRow<SkillRow>(text, table, SKILL_COLS, CODE_COLS, cells as Partial<SkillRow> & { id: string }, full);
}

function removeFromKindTables(text: string, id: string): string {
	const t = tableOfId(text, id);
	return t ? removeRow(text, t, id).text : text;
}

/** 「4-2」 1: kind changed → the row leaves its table and is written (from `full`) into `full.kind`'s. */
export function moveRowToKind(text: string, full: SkillRow): RegistryResult {
	const target = kindTable(text, full.kind);
	if (!tableOf(text, target)) return { ok: false, reason: `등록부에 「${target}」 표가 없어요` };
	return upsertRow<SkillRow>(removeFromKindTables(text, full.id), target, SKILL_COLS, CODE_COLS, full, full);
}

/** 「4-6」 폐기: the row leaves its kind table and lands in 「폐기」 (폐기일, 이유). */
export function moveRowToDiscarded(text: string, d: DiscardRow): RegistryResult {
	return upsertRow<DiscardRow>(removeFromKindTables(text, d.id), DISCARD_TABLE, DISCARD_COLS, [], d, d);
}

/** The registry row a skill file says it should have (file = canonical). */
export function skillRowOf(s: Skill, folder: string): SkillRow {
	return {
		kind: s.kind,
		id: s.id,
		nameCell: nameLink(folder, s.name),
		slug: s.slug,
		scope: s.scope,
		phrase: s.phrase,
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
	create: (id: string, name: string, i: Pick<SkillInput, "kind" | "trigger" | "schedule">) => {
		const kind = inputKind(i);
		const how = kind === "작업" ? `, ${i.trigger}${i.trigger === "cron" && i.schedule.trim() ? ` ${i.schedule.trim()}` : ""}` : "";
		return `${id} 「${name}」 만듦 (${kind}, ${initialStatus(kind)}${how}) ${PLUGIN_MARK}`;
	},
	move: (id: string, name: string, from: string, to: string) => `${id} 「${name}」 등록부 행을 「${from}」 표에서 「${to}」 표로 옮김 ${PLUGIN_MARK}`,
	edit: (id: string, name: string, changes: string[]) => `${id} 「${name}」 수정: ${changes.join(", ")} ${PLUGIN_MARK}`,
	register: (id: string, name: string) => `${id} 「${name}」 등록부에 행 추가 (파일은 있었음) ${PLUGIN_MARK}`,
};
