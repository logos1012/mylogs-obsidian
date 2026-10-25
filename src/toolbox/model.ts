/**
 * Toolbox model.
 *
 * Follows `11 Toolbox/AGENTS.md` 「2. 구조」 and 「3. 스킬 문서 형식」: a skill = one file
 * `<folder>/<이름>.md` with frontmatter `type: skill`; the registry is `<folder>/Toolbox Index.md`.
 * The file is canonical; the registry row follows it (「8」 of the plan: 등록부 동기화).
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { cleanInline, daysBetween, findSectionText, isIsoDate, parseSections, valueToString } from "../pinboard/model.ts";

/** 「3」: 사용 | 시험 | 멈춤 | 폐기. 시험 = not on cron, runs only via 「실행 요청」. */
export const SKILL_STATUSES = ["멈춤", "시험", "사용", "폐기"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];
/** 「4-1」 2-1: the order a skill moves through (the row's 3-way control). */
export const LIVE_STATUSES = ["멈춤", "시험", "사용"] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

/** 「4-4」 1: a 「실행 요청」 runs only for 사용·시험. */
export function canRequestRun(status: string): boolean {
	return status === "사용" || status === "시험";
}
/** 「6」: 시험·사용 need the user's confirmation (멈춤 doesn't). */
export function needsConfirm(to: string): to is "시험" | "사용" {
	return to === "시험" || to === "사용";
}
export const TRIGGERS = ["cron", "수동", "이벤트"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const OWNERS = ["hermes", "claude-code", "codex"] as const;

export const REGISTRY_FILE = "Toolbox Index.md";
export const TEMPLATE_REL = "_Templates/스킬.md";
export const PURPOSE_SECTION = "목적";
export const CHANGELOG_SECTION = "변경 기록";

/** 「4-6」: `last_run` this old (or missing) asks "아직도 쓰나요?". */
export const STALE_DAYS = 90;
/** 「2」: more skills than this → tell the user. */
export const MAX_SKILLS = 20;
/** Processed 실행 요청 lines stay visible (faded) this long. */
export const DONE_REQUEST_DAYS = 7;

export interface Skill {
	path: string;
	/** File basename (= 이름, 「3」: `name` 파일 이름과 같게). */
	name: string;
	id: string;
	owner: string;
	trigger: string;
	schedule: string;
	output: string;
	notify: string;
	status: string;
	/** `YYYY-MM-DDTHH:MM` as written (may be empty). */
	lastRun: string;
	lastResult: string;
	lastReviewed: string;
	created: string;
	updated: string;
	/** First line of 「목적」 (하는 일). */
	purpose: string;
}

// ───────────────────────── paths ─────────────────────────

function trimSlashes(p: string): string {
	return p.trim().replace(/^\/+|\/+$/g, "");
}

/** The skill name when `path` is exactly `<folder>/<이름>.md` (templates and deeper files: null). */
export function skillName(path: string, folder: string): string | null {
	const root = trimSlashes(folder);
	if (!root || !path.startsWith(`${root}/`) || !path.endsWith(".md")) return null;
	const rest = path.slice(root.length + 1);
	if (rest.includes("/")) return null;
	const name = rest.slice(0, -3);
	return name && name !== REGISTRY_FILE.slice(0, -3) && name !== "AGENTS" ? name : null;
}

export function skillPath(folder: string, name: string): string {
	return `${trimSlashes(folder)}/${name}.md`;
}
export function registryPathOf(folder: string): string {
	return `${trimSlashes(folder)}/${REGISTRY_FILE}`;
}
export function templatePathOf(folder: string): string {
	return `${trimSlashes(folder)}/${TEMPLATE_REL}`;
}
/** The registry's 이름 cell: `[[<folder>/<이름>\|<이름>]]` (pipe escaped for the table). */
export function nameLink(folder: string, name: string): string {
	return `[[${trimSlashes(folder)}/${name}\\|${name}]]`;
}

// ───────────────────────── file → model ─────────────────────────

/** The first real line of a section (comments and empty bullets dropped), as plain text. */
export function firstLine(section: string): string {
	for (const line of section.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
		const t = cleanInline(line.trim().replace(/^([-*+]|\d+\.)\s*(\[[ xX]\]\s*)?/, ""));
		if (t) return t;
	}
	return "";
}

export function truncate(s: string, max = 60): string {
	const t = s.trim();
	return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function isoOrEmpty(v: unknown): string {
	const s = valueToString(v).slice(0, 10);
	return isIsoDate(s) ? s : "";
}

/** Normalise a skill file. Returns null when it isn't one (`type: skill`). */
export function parseSkill(fm: Record<string, unknown> | null | undefined, body: string, path: string, folder: string): Skill | null {
	if (!fm || valueToString(fm.type) !== "skill") return null;
	const name = skillName(path, folder);
	if (!name) return null;
	const s = (k: string) => valueToString(fm[k]);
	const secs = parseSections(body);
	return {
		path,
		name,
		id: s("id"),
		owner: s("owner"),
		trigger: s("trigger"),
		schedule: s("schedule"),
		output: s("output"),
		notify: s("notify"),
		status: s("status") || "멈춤",
		lastRun: s("last_run"),
		lastResult: s("last_result"),
		lastReviewed: isoOrEmpty(fm.last_reviewed),
		created: isoOrEmpty(fm.created),
		updated: isoOrEmpty(fm.updated),
		purpose: firstLine(findSectionText(secs, PURPOSE_SECTION)),
	};
}

// ───────────────────────── badges ─────────────────────────

/** `last_run` missing or ≥ 90 days ago (폐기 skills never ask). */
export function isStaleSkill(s: Pick<Skill, "status" | "lastRun">, today: string, days = STALE_DAYS): boolean {
	if (s.status === "폐기") return false;
	const d = s.lastRun.slice(0, 10);
	if (!isIsoDate(d)) return true;
	return daysBetween(d, today) >= days;
}

export function daysSinceRun(s: Pick<Skill, "lastRun">, today: string): number | null {
	const d = s.lastRun.slice(0, 10);
	return isIsoDate(d) ? daysBetween(d, today) : null;
}

/** `last_result` starting with `실패`; the reason after `실패:`. */
export function failure(s: Pick<Skill, "lastResult">): { failed: boolean; reason: string } {
	const r = s.lastResult.trim();
	if (!/^실패/.test(r)) return { failed: false, reason: "" };
	return { failed: true, reason: r.replace(/^실패\s*[:：]?\s*/, "").trim() };
}

export function tooMany(count: number, max = MAX_SKILLS): boolean {
	return count > max;
}

// ───────────────────────── ids ─────────────────────────

export const SKILL_ID_RE = /^T-\d{2,}$/;

/** 「4-1」 1: the next `T-NN` = max of the known ids + 1 (two digits at least). */
export function nextSkillId(ids: string[]): string {
	let max = 0;
	for (const id of ids) {
		const m = /^T-(\d+)$/.exec(id.trim());
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `T-${String(max + 1).padStart(2, "0")}`;
}

// ───────────────────────── registry rows & reconciliation ─────────────────────────

/** One row of the 「스킬」 table (cells as text; `schedule` / `output` without backticks). */
export interface SkillRow {
	id: string;
	/** The 이름 cell as written (a wikilink). */
	nameCell: string;
	purpose: string;
	trigger: string;
	schedule: string;
	output: string;
	owner: string;
	status: string;
	lastRun: string;
	lastResult: string;
	lastReviewed: string;
}

export interface DiscardRow {
	id: string;
	nameCell: string;
	date: string;
	reason: string;
}

/** A 「실행 요청」 line: `- [ ] T-01 (requested:: YYYY-MM-DDTHH:MM)`. */
export interface RunRequest {
	id: string;
	requested: string;
	done: boolean;
	/** The line as written. */
	line: string;
}

/** The display name of a 이름 cell (`[[a/b\|b]]` → `b`). */
export function rowName(cell: string): string {
	return cleanInline(cell.replace(/\\\|/g, "|"));
}

export type Entry = { kind: "both"; skill: Skill; row: SkillRow } | { kind: "file-only"; skill: Skill; row: null } | { kind: "row-only"; skill: null; row: SkillRow };

function idKey(id: string): number {
	const m = /^T-(\d+)$/.exec(id);
	return m ? Number(m[1]) : 1e9;
}

/**
 * Files and 「스킬」 rows side by side, by id (a file without an id matches a row by name).
 * File-only → "등록부에 없음"; row-only → struck through. Sorted by id, then name.
 */
export function reconcile(skills: Skill[], rows: SkillRow[]): Entry[] {
	const out: Entry[] = [];
	const used = new Set<SkillRow>();
	for (const skill of skills) {
		const row = rows.find((r) => !used.has(r) && ((skill.id && r.id === skill.id) || (!skill.id && rowName(r.nameCell) === skill.name))) ?? null;
		if (row) used.add(row);
		out.push(row ? { kind: "both", skill, row } : { kind: "file-only", skill, row: null });
	}
	for (const row of rows) if (!used.has(row)) out.push({ kind: "row-only", skill: null, row });
	const key = (e: Entry) => e.skill?.id || e.row?.id || "";
	const name = (e: Entry) => e.skill?.name || (e.row ? rowName(e.row.nameCell) : "");
	return out.sort((a, b) => idKey(key(a)) - idKey(key(b)) || name(a).localeCompare(name(b), "ko"));
}

/** Pending (unchecked) requests for a skill, oldest first. */
export function pendingRequests(reqs: RunRequest[], id: string): RunRequest[] {
	return reqs.filter((r) => r.id === id && !r.done);
}

/** Processed requests still shown (faded): checked and requested within the last 7 days. */
export function recentDoneRequests(reqs: RunRequest[], id: string, today: string, days = DONE_REQUEST_DAYS): RunRequest[] {
	return reqs.filter((r) => {
		if (r.id !== id || !r.done) return false;
		const d = r.requested.slice(0, 10);
		return isIsoDate(d) && daysBetween(d, today) <= days && daysBetween(d, today) >= 0;
	});
}

/** `YYYY-MM-DDTHH:MM` in local time (the 실행 요청 stamp). */
export function requestStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ───────────────────────── new / edited skill input ─────────────────────────

export interface SkillInput {
	name: string;
	/** 하는 일 한 줄 (→ 「목적」 first line, registry 하는 일). */
	purpose: string;
	trigger: Trigger | string;
	/** Only meaningful when `trigger` is `cron`. */
	schedule: string;
	output: string;
	notify: string;
}

/** Fields the 수정 dialog changes (하는 일 is the file body: edited in the file). */
export type SkillEdit = Omit<SkillInput, "purpose">;

export function nameProblem(name: string): string | null {
	const n = name.trim();
	if (!n) return "이름을 적어 주세요.";
	if (/[\\/:*?"<>|#^[\]]/.test(n)) return "이름에 \\ / : * ? \" < > | # ^ [ ] 는 쓸 수 없어요.";
	if (n.startsWith(".") || n.startsWith("_")) return "이름은 점(.)이나 밑줄(_)로 시작할 수 없어요.";
	if (n === "AGENTS" || n === REGISTRY_FILE.slice(0, -3)) return "그 이름은 쓸 수 없어요.";
	return null;
}

/** Five fields of a cron expression (loose check). */
export function scheduleProblem(trigger: string, schedule: string): string | null {
	if (trigger !== "cron") return null;
	const s = schedule.trim();
	if (!s) return "cron이면 schedule을 적어 주세요. 예: 0 4 * * *";
	if (s.split(/\s+/).length !== 5 || !/^[\d*,\-/]+(\s[\d*,\-/]+){4}$/.test(s)) return "schedule은 cron 다섯 칸이에요. 예: 0 4 * * * (Asia/Seoul)";
	return null;
}

/** All problems with a new skill (empty = ok). `taken` = names and ids on disk or in the registry. */
export function validateSkillInput(i: SkillInput, id: string, taken: { ids: string[]; names: string[] }): string[] {
	const out: string[] = [];
	const np = nameProblem(i.name);
	if (np) out.push(np);
	else if (taken.names.includes(i.name.trim())) out.push(`이미 있는 스킬 이름이에요: ${i.name.trim()}`);
	if (!i.purpose.trim()) out.push("하는 일을 한 줄 적어 주세요.");
	if (!(TRIGGERS as readonly string[]).includes(i.trigger)) out.push("트리거를 골라 주세요 (cron / 수동 / 이벤트).");
	const sp = scheduleProblem(i.trigger, i.schedule);
	if (sp) out.push(sp);
	if (!i.output.trim()) out.push("출력 위치를 적어 주세요.");
	if (!SKILL_ID_RE.test(id)) out.push(`id 형식이 아니에요: ${id}`);
	else if (taken.ids.includes(id)) out.push(`이미 있는 id예요: ${id}`);
	return out;
}

/** What a 수정 changes, for the logs (empty = nothing). Cron-less triggers drop the schedule. */
export function skillEditChanges(s: Skill, e: SkillEdit): string[] {
	const out: string[] = [];
	const name = e.name.trim();
	const schedule = e.trigger === "cron" ? e.schedule.trim() : "";
	if (name !== s.name) out.push(`이름 「${s.name}」 → 「${name}」`);
	if (e.trigger !== s.trigger) out.push(`트리거 ${s.trigger || "—"} → ${e.trigger}`);
	if (schedule !== s.schedule) out.push(`schedule ${s.schedule || "—"} → ${schedule || "—"}`);
	if (e.output.trim() !== s.output) out.push(`출력 ${s.output || "—"} → ${e.output.trim() || "—"}`);
	if (e.notify.trim() !== s.notify) out.push("알림");
	return out;
}

/** 「4-2」 1: the registry row changes only when a registry column (이름·트리거·schedule·출력) did. */
export function registryAffected(s: Skill, e: SkillEdit): boolean {
	const schedule = e.trigger === "cron" ? e.schedule.trim() : "";
	return e.name.trim() !== s.name || e.trigger !== s.trigger || schedule !== s.schedule || e.output.trim() !== s.output;
}
