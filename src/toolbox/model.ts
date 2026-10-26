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

/** 「1」: three kinds. 작업 = a job (cron / 실행 요청), 도구 = called by words, 운영 = a working contract. */
export const SKILL_KINDS = ["작업", "도구", "운영"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];
/** The view's / registry's order, top to bottom. */
export const KIND_ORDER: readonly SkillKind[] = ["운영", "도구", "작업"];

export function isKind(v: string): v is SkillKind {
	return (SKILL_KINDS as readonly string[]).includes(v);
}
/** `kind` as written; missing (or unknown) → 작업 (files from before v2.0 are all 작업). */
export function parseKind(v: unknown): SkillKind {
	const s = valueToString(v).trim();
	return isKind(s) ? s : "작업";
}

/** 「3」 (작업): 사용 | 시험 | 멈춤 | 폐기. 시험 = not on cron, runs only via 「실행 요청」. */
export const SKILL_STATUSES = ["멈춤", "시험", "사용", "폐기"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];
/** 「4-1」 2-1: the order a 작업 moves through (the row's 3-way control). */
export const LIVE_STATUSES = ["멈춤", "시험", "사용"] as const;
export type LiveStatus = (typeof LIVE_STATUSES)[number];

/** 「3」: the status set of each kind. */
export const STATUSES_BY_KIND: Record<SkillKind, readonly string[]> = {
	작업: SKILL_STATUSES,
	도구: ["멈춤", "사용", "폐기"],
	운영: ["사용", "폐기"],
};
/** The row's status control: 작업 3-way, 도구 2-way, 운영 none (always applied; a badge only). */
export function liveStatuses(kind: SkillKind): readonly string[] {
	return kind === "작업" ? LIVE_STATUSES : kind === "도구" ? ["멈춤", "사용"] : [];
}
export function validStatus(kind: SkillKind, status: string): boolean {
	return STATUSES_BY_KIND[kind].includes(status);
}
/** 「4-1」 2: the status a new skill starts with. */
export function initialStatus(kind: SkillKind): string {
	return kind === "운영" ? "사용" : "멈춤";
}
/** The status a skill gets when it moves to `kind` (kept when still valid). */
export function statusForKind(kind: SkillKind, status: string): string {
	return validStatus(kind, status) ? status : initialStatus(kind);
}

/** 「4-4」 1: a 「실행 요청」 runs only for 사용·시험 (and only 작업 runs at all). */
export function canRequestRun(status: string, kind: SkillKind = "작업"): boolean {
	return kind === "작업" && (status === "사용" || status === "시험");
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
/** 도구: 「트리거」 holds the 부르는 말 (its first line = the registry cell). */
export const PHRASE_SECTION = "트리거";
/** 운영: 「범위」 (its first line = the registry cell). */
export const SCOPE_SECTION = "범위";
export const CHANGELOG_SECTION = "변경 기록";

/** 「4-9」: `last_run` (작업) / `last_reviewed` (all) this old asks "아직도 쓰나요?". */
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
	kind: SkillKind;
	/** Hermes stub folder name (「4-7」). */
	slug: string;
	description: string;
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
	/** 도구: first line of 「트리거」 (부르는 말). */
	phrase: string;
	/** 운영: first line of 「범위」. */
	scope: string;
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
		kind: parseKind(fm.kind),
		slug: s("slug"),
		description: s("description"),
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
		phrase: firstLine(findSectionText(secs, PHRASE_SECTION)),
		scope: firstLine(findSectionText(secs, SCOPE_SECTION)),
	};
}

// ───────────────────────── badges ─────────────────────────

/** 작업 only: `last_run` missing or ≥ 90 days ago (폐기 skills never ask; 도구·운영 have no runs). */
export function isStaleSkill(s: Pick<Skill, "status" | "lastRun"> & { kind?: SkillKind }, today: string, days = STALE_DAYS): boolean {
	if (s.status === "폐기" || (s.kind ?? "작업") !== "작업") return false;
	const d = s.lastRun.slice(0, 10);
	if (!isIsoDate(d)) return true;
	return daysBetween(d, today) >= days;
}

/** All kinds: `last_reviewed` ≥ 90 days ago (「4-9」 1). A missing date asks too; 폐기 never. */
export function isReviewStale(s: Pick<Skill, "status" | "lastReviewed">, today: string, days = STALE_DAYS): boolean {
	if (s.status === "폐기") return false;
	if (!isIsoDate(s.lastReviewed)) return true;
	return daysBetween(s.lastReviewed, today) >= days;
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

/**
 * One row of a kind table — 「운영」, 「도구」, 「작업」 (or the legacy 「스킬」 = 작업). Cells as
 * text (`schedule` / `output` without backticks); a column the table doesn't have is "".
 */
export interface SkillRow {
	/** The table the row is in. */
	kind: SkillKind;
	id: string;
	/** The 이름 cell as written (a wikilink). */
	nameCell: string;
	slug: string;
	/** 운영 범위. */
	scope: string;
	/** 도구 부르는 말. */
	phrase: string;
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

/** `misplaced`: the row sits in another kind's table than the file's `kind` (「4-2」 1). */
export type Entry = { kind: "both"; skill: Skill; row: SkillRow; misplaced: boolean } | { kind: "file-only"; skill: Skill; row: null } | { kind: "row-only"; skill: null; row: SkillRow };

/** The kind an entry is shown under: the file's (canonical), else the row's table. */
export function entryKind(e: Entry): SkillKind {
	return e.skill ? e.skill.kind : e.row.kind;
}

function idKey(id: string): number {
	const m = /^T-(\d+)$/.exec(id);
	return m ? Number(m[1]) : 1e9;
}

/**
 * Files and registry rows (all kind tables) side by side, by id (a file without an id matches a
 * row by name). File-only → "등록부에 없음"; row-only → struck through; a row in another kind's
 * table than the file → `misplaced`. Sorted by id, then name.
 */
export function reconcile(skills: Skill[], rows: SkillRow[]): Entry[] {
	const out: Entry[] = [];
	const used = new Set<SkillRow>();
	for (const skill of skills) {
		const row = rows.find((r) => !used.has(r) && ((skill.id && r.id === skill.id) || (!skill.id && rowName(r.nameCell) === skill.name))) ?? null;
		if (row) used.add(row);
		out.push(row ? { kind: "both", skill, row, misplaced: row.kind !== skill.kind } : { kind: "file-only", skill, row: null });
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

/**
 * The new-skill form. Which fields matter depends on `kind` (「4-1」 받을 정보):
 * 작업 = 이름·slug·description·하는 일·트리거·schedule·출력·알림; 도구 = 이름·slug·description·
 * 부르는 말·담당; 운영 = 이름·slug·description·범위. A missing `kind` is 작업.
 */
export interface SkillInput {
	kind?: SkillKind;
	name: string;
	slug?: string;
	description?: string;
	/** 작업: 하는 일 한 줄 (→ 「목적」 first line, registry 하는 일). */
	purpose: string;
	/** 도구: 부르는 말 (→ 「트리거」, the description, the registry cell). */
	phrase?: string;
	/** 운영: 범위 (→ 「범위」, the registry cell). */
	scope?: string;
	/** 담당 (`owner`). Empty → the template's. */
	owner?: string;
	trigger: Trigger | string;
	/** Only meaningful when `trigger` is `cron`. */
	schedule: string;
	output: string;
	notify: string;
}

/** Fields the 수정 dialog changes (하는 일 is the file body: edited in the file). Absent = unchanged. */
export type SkillEdit = Omit<SkillInput, "purpose">;

export function inputKind(i: { kind?: SkillKind }): SkillKind {
	return i.kind ?? "작업";
}

/** 「3」: `slug` = 영문 소문자·숫자·하이픈. */
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function slugProblem(slug: string, taken: string[] = []): string | null {
	const s = slug.trim();
	if (!s) return "slug를 적어 주세요 (Hermes 스텁 폴더 이름). 예: ai-news-briefing";
	if (!SLUG_RE.test(s)) return "slug는 영문 소문자·숫자·하이픈만 써요 (하이픈으로 시작·끝나거나 두 번 이어지면 안 돼요). 예: ai-news-briefing";
	if (taken.includes(s)) return `이미 있는 slug예요: ${s}`;
	return null;
}

/** 도구: the description carries the 부르는 말 (「3」: 트리거 문장 포함) — appended, quoted, when missing. */
export function descriptionWithPhrase(description: string, phrase: string): string {
	const d = description.replace(/\s*\r?\n\s*/g, " ").trim();
	const p = phrase.replace(/\s*\r?\n\s*/g, " ").trim();
	if (!p || d.includes(p.replace(/^["“]|["”]$/g, ""))) return d;
	const q = /["“”]/.test(p) ? p : `"${p}"`;
	return d ? `${d} ${q}` : q;
}

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

export interface Taken {
	ids: string[];
	names: string[];
	slugs?: string[];
}

/** The kind-specific fields of a form (shared by 새 스킬 and 수정). */
export function kindFieldProblems(i: Omit<SkillInput, "purpose"> & { purpose?: string }, o: { requirePurpose: boolean; slugs: string[]; requireSlug: boolean }): string[] {
	const out: string[] = [];
	const kind = inputKind(i);
	if (o.requireSlug || (i.slug ?? "").trim()) {
		const sp = slugProblem(i.slug ?? "", o.slugs);
		if (sp) out.push(sp);
	}
	if (!(i.description ?? "").trim()) out.push("description을 한두 문장 적어 주세요 (언제 이 스킬을 쓰는지 · Hermes 스텁에 그대로 들어가요).");
	if (kind === "작업") {
		if (o.requirePurpose && !(i.purpose ?? "").trim()) out.push("하는 일을 한 줄 적어 주세요.");
		if (!(TRIGGERS as readonly string[]).includes(i.trigger)) out.push("트리거를 골라 주세요 (cron / 수동 / 이벤트).");
		const sp = scheduleProblem(i.trigger, i.schedule);
		if (sp) out.push(sp);
		if (!i.output.trim()) out.push("출력 위치를 적어 주세요.");
	} else if (kind === "도구") {
		if (!(i.phrase ?? "").trim()) out.push("부르는 말을 적어 주세요. 예: \"데일리로그 기록해 줘\"");
	} else if (!(i.scope ?? "").trim()) out.push("범위를 적어 주세요. 예: MyLogs 볼트 전체");
	return out;
}

/** All problems with a new skill (empty = ok). `taken` = names, ids and slugs on disk or in the registry. */
export function validateSkillInput(i: SkillInput, id: string, taken: Taken): string[] {
	const out: string[] = [];
	const np = nameProblem(i.name);
	if (np) out.push(np);
	else if (taken.names.includes(i.name.trim())) out.push(`이미 있는 스킬 이름이에요: ${i.name.trim()}`);
	// A form without `kind` (before v2.0) has no slug / description: only 작업 fields are checked.
	if (i.kind) out.push(...kindFieldProblems(i, { requirePurpose: true, slugs: taken.slugs ?? [], requireSlug: true }));
	else out.push(...kindFieldProblems({ ...i, description: i.description ?? "-" }, { requirePurpose: true, slugs: taken.slugs ?? [], requireSlug: false }));
	if (!SKILL_ID_RE.test(id)) out.push(`id 형식이 아니에요: ${id}`);
	else if (taken.ids.includes(id)) out.push(`이미 있는 id예요: ${id}`);
	return out;
}

/** A 수정 normalised against the skill: absent fields = unchanged; 작업-only fields only for 작업. */
export interface EditDelta {
	kind: SkillKind;
	name: string;
	slug: string;
	description: string;
	owner: string;
	phrase: string;
	scope: string;
	trigger: string;
	schedule: string;
	output: string;
	notify: string;
	/** The status after the move (`statusForKind`). */
	status: string;
}

export function editDelta(s: Skill, e: SkillEdit): EditDelta {
	const kind = e.kind ?? s.kind;
	const job = kind === "작업";
	const trigger = job ? e.trigger : s.trigger;
	return {
		kind,
		name: e.name.trim(),
		slug: (e.slug ?? s.slug).trim(),
		description: (e.description ?? s.description).replace(/\s*\r?\n\s*/g, " ").trim(),
		owner: (e.owner ?? s.owner).trim(),
		phrase: kind === "도구" ? (e.phrase ?? s.phrase).trim() : s.phrase,
		scope: kind === "운영" ? (e.scope ?? s.scope).trim() : s.scope,
		trigger,
		schedule: job ? (trigger === "cron" ? e.schedule.trim() : "") : s.schedule,
		output: job ? e.output.trim() : s.output,
		notify: job ? e.notify.trim() : s.notify,
		status: statusForKind(kind, s.status),
	};
}

/** What a 수정 changes, for the logs (empty = nothing). Cron-less triggers drop the schedule. */
export function skillEditChanges(s: Skill, e: SkillEdit): string[] {
	const out: string[] = [];
	const d = editDelta(s, e);
	if (d.kind !== s.kind) out.push(`종류 ${s.kind} → ${d.kind}${d.status !== s.status ? ` (${s.status} → ${d.status})` : ""}`);
	if (d.name !== s.name) out.push(`이름 「${s.name}」 → 「${d.name}」`);
	if (d.slug !== s.slug) out.push(`slug ${s.slug || "—"} → ${d.slug || "—"}`);
	if (d.description !== s.description) out.push("description");
	if (d.owner !== s.owner) out.push(`담당 ${s.owner || "—"} → ${d.owner || "—"}`);
	if (d.phrase !== s.phrase) out.push(`부르는 말 ${s.phrase || "—"} → ${d.phrase || "—"}`);
	if (d.scope !== s.scope) out.push(`범위 ${s.scope || "—"} → ${d.scope || "—"}`);
	if (d.trigger !== s.trigger) out.push(`트리거 ${s.trigger || "—"} → ${d.trigger}`);
	if (d.schedule !== s.schedule) out.push(`schedule ${s.schedule || "—"} → ${d.schedule || "—"}`);
	if (d.output !== s.output) out.push(`출력 ${s.output || "—"} → ${d.output || "—"}`);
	if (d.notify !== s.notify) out.push("알림");
	return out;
}

/** 「4-7」: slug or description changed → the Hermes stub must be re-synced. */
export function stubAffected(s: Skill, e: SkillEdit): boolean {
	const d = editDelta(s, e);
	return d.slug !== s.slug || d.description !== s.description || d.kind !== s.kind || d.status !== s.status;
}

/** 「4-2」 1: the registry row changes only when a registry column (종류·이름·slug·트리거·schedule·출력·담당·부르는 말·범위) did. */
export function registryAffected(s: Skill, e: SkillEdit): boolean {
	const d = editDelta(s, e);
	return d.kind !== s.kind || d.name !== s.name || d.slug !== s.slug || d.trigger !== s.trigger || d.schedule !== s.schedule || d.output !== s.output || d.owner !== s.owner || d.phrase !== s.phrase || d.scope !== s.scope;
}
