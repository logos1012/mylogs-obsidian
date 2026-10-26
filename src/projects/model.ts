/**
 * Project Folders model.
 *
 * Follows `05 Project Folders/AGENTS.md` (「5. 프로젝트 하나의 구조」, 「6. 허브 형식」):
 * a project = one folder `<root>/<개인|회사>/<프로젝트명>/` whose hub note has
 * frontmatter `type: project`. Completed projects live in `10 Archive Box/Projects/<개인|회사>/`.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { bulletItems, daysBetween, findSectionText, isIsoDate, parseSections, valueToString } from "../pinboard/model.ts";
import { readMilestones, type Milestone } from "./milestones.ts";

export const PROJECT_STATUSES = ["후보", "진행", "대기", "보류", "완료"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SCOPES = ["개인", "회사"] as const;
export type Scope = (typeof SCOPES)[number];
export type ScopeFilter = Scope | "전체";

/** 「5. 유형」 (`kind`). */
export const KINDS = ["글쓰기", "데이터·통계", "콘텐츠 제작", "마케팅", "개발·자동화", "회사 업무"] as const;

/** Places inside a project (「5」 table). Optional ones (`99 작업실/NN …`) are created only when needed. */
export const DRAFT_DIR = "01 초안";
export const OUTPUT_DIR = "02 산출물";
export const WORK_DIR = "99 작업실";
export const LOG_DIR = "로그";
export const OPTIONAL_DIRS = ["10 자료", "20 지식", "30 실험", "40 회의", "50 데이터", "60 에셋", "70 프롬프트", "80 스크립트"] as const;

/** 「유형별로 주로 쓰는 자리」: kind → places (as written in the project AGENTS.md 폴더 지도). */
export const KIND_PLACES: Record<string, string[]> = {
	글쓰기: [DRAFT_DIR, OUTPUT_DIR, "10 자료", "20 지식"],
	"데이터·통계": ["10 자료", "50 데이터", "30 실험", "80 스크립트", OUTPUT_DIR],
	"콘텐츠 제작": [DRAFT_DIR, OUTPUT_DIR, "60 에셋", "70 프롬프트", "30 실험"],
	마케팅: ["50 데이터", "30 실험", "60 에셋", DRAFT_DIR, OUTPUT_DIR],
	"개발·자동화": ["80 스크립트", "30 실험", "20 지식"],
	"회사 업무": ["40 회의", "10 자료", DRAFT_DIR, OUTPUT_DIR],
};

/** A `진행` project untouched for more than this many days asks "계속 / 보류 / 종료" (「3-5」). */
export const STALE_DAYS = 14;
/** The 완료 column shows only this many (most recently completed). */
export const DONE_COLUMN_LIMIT = 3;

export const ACTION_SECTION = "지금 가장 효과적인 한 가지 행동";
export const SUMMARY_SECTION = "한 문장 설명";
export const STATE_SECTION = "현재 상태";
export const DECISIONS_SECTION = "주요 결정";
export const AI_DRAFT = "(AI 초안)";
export const UNCONFIRMED = "미확인";

export interface Project {
	/** Hub note path. */
	path: string;
	/** Project folder path (vault-relative). */
	folder: string;
	/** Folder name = 프로젝트명 (file names inside the project use it). */
	name: string;
	/** True when the folder is under the Archive Box. */
	archived: boolean;
	id: string;
	title: string;
	scope: string;
	area: string;
	kind: string;
	status: string;
	started: string;
	completed: string;
	/** As written (relative to the project folder), e.g. `99 작업실/cover.png`. */
	cover: string;
	goals: string[];
	updated: string;
	/** First item of 「지금 가장 효과적인 한 가지 행동」, without `(AI 초안)`. */
	action: string;
	actionDraft: boolean;
	actionDone: boolean;
	summary: string;
	/** 한 줄 결과 (`- **결과:** …` in 「현재 상태」), for completed projects. */
	result: string;
	milestones?: Milestone[];
	milestoneSource?: string;
	milestoneError?: string;
}

// ───────────────────────── paths ─────────────────────────

export interface HubLocation {
	scope: Scope;
	/** Project folder path. */
	folder: string;
	name: string;
	archived: boolean;
}

function trimSlashes(p: string): string {
	return p.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Where a hub may live: exactly `<root>/<개인|회사>/<프로젝트명>/<file>.md`.
 * Returns null for anything else (deeper files, `99 작업실`, the registry, …).
 */
export function hubLocation(path: string, activeRoot: string, archiveRoot: string): HubLocation | null {
	if (!path.endsWith(".md")) return null;
	for (const [root, archived] of [
		[trimSlashes(activeRoot), false],
		[trimSlashes(archiveRoot), true],
	] as const) {
		if (!root || !path.startsWith(`${root}/`)) continue;
		const parts = path.slice(root.length + 1).split("/");
		if (parts.length !== 3) continue;
		const [scope, name] = parts;
		if (!(SCOPES as readonly string[]).includes(scope) || !name) continue;
		return { scope: scope as Scope, folder: `${root}/${scope}/${name}`, name, archived };
	}
	return null;
}

export function hubPath(folder: string, name: string): string {
	return `${folder}/${name}.md`;
}
export function logIndexPath(folder: string, name: string): string {
	return `${folder}/${WORK_DIR}/${name} 로그.md`;
}
/** Relative to the project folder (AGENTS 「경로 기준」). */
export function monthlyLogRel(name: string, ym: string): string {
	return `${WORK_DIR}/${LOG_DIR}/${name} 로그 ${ym}.md`;
}
export function monthlyLogPath(folder: string, name: string, ym: string): string {
	return `${folder}/${monthlyLogRel(name, ym)}`;
}
export function archiveFolder(archiveRoot: string, scope: string, name: string): string {
	return `${trimSlashes(archiveRoot)}/${scope}/${name}`;
}

// ───────────────────────── hub → model ─────────────────────────

function valueToList(v: unknown): string[] {
	if (v === null || v === undefined || v === "") return [];
	if (Array.isArray(v)) return v.map(valueToString).filter(Boolean);
	return valueToString(v)
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
}

function isoOrEmpty(v: unknown): string {
	const s = valueToString(v).slice(0, 10);
	return isIsoDate(s) ? s : "";
}

/** The first list item of 「지금 가장 효과적인 한 가지 행동」. */
export function parseAction(section: string): { text: string; draft: boolean; done: boolean } {
	for (const line of section.split(/\r?\n/)) {
		const m = /^\s*[-*+]\s+(?:\[([ xX])\]\s*)?(.*)$/.exec(line);
		if (!m) continue;
		const done = m[1] === "x" || m[1] === "X";
		let text = bulletItems(m[2])[0] ?? "";
		const draft = text.includes(AI_DRAFT);
		text = text.replace(AI_DRAFT, "").trim();
		if (text) return { text, draft, done };
	}
	return { text: "", draft: false, done: false };
}

/** `- **결과:** …` inside 「현재 상태」 (the line the completion procedure writes). */
export function parseResult(section: string): string {
	for (const item of bulletItems(section)) {
		const m = /^결과\s*:\s*(.+)$/.exec(item);
		if (m) return m[1].trim();
	}
	return "";
}

/** Normalise a hub. Returns null when the note isn't a project hub (`type: project`). */
export function parseProject(fm: Record<string, unknown> | null | undefined, body: string, loc: HubLocation, path: string): Project | null {
	if (!fm || valueToString(fm.type) !== "project") return null;
	const s = (k: string) => valueToString(fm[k]);
	const secs = parseSections(body);
	const action = parseAction(findSectionText(secs, ACTION_SECTION));
	const summary = bulletItems(findSectionText(secs, SUMMARY_SECTION)).join(" ");
	let milestones: Milestone[] = [], milestoneSource = "", milestoneError = "";
	try { const m = readMilestones(body); milestones = m.items; milestoneSource = m.source; }
	catch (e) { milestoneError = String(e instanceof Error ? e.message : e); }
	return {
		path,
		folder: loc.folder,
		name: loc.name,
		archived: loc.archived,
		id: s("id"),
		title: s("title") || loc.name,
		scope: s("scope") || loc.scope,
		area: s("area"),
		kind: s("kind"),
		status: s("status") || "후보",
		started: isoOrEmpty(fm.started),
		completed: isoOrEmpty(fm.completed),
		cover: s("cover"),
		goals: valueToList(fm.goals),
		updated: isoOrEmpty(fm.updated),
		action: action.text,
		actionDraft: action.draft,
		actionDone: action.done,
		summary,
		result: parseResult(findSectionText(secs, STATE_SECTION)),
		milestones, milestoneSource, milestoneError,
	};
}

// ───────────────────────── board ─────────────────────────

/** `진행` and not updated for more than 14 days (falls back to `started`; unknown → not stale). */
export function isStale(p: Pick<Project, "status" | "updated" | "started">, today: string, days = STALE_DAYS): boolean {
	if (p.status !== "진행") return false;
	const ref = p.updated || p.started;
	if (!ref) return false;
	return daysBetween(ref, today) > days;
}

export function daysSinceUpdate(p: Pick<Project, "updated" | "started">, today: string): number | null {
	const ref = p.updated || p.started;
	return ref ? daysBetween(ref, today) : null;
}

export function matchesScope(p: Pick<Project, "scope">, filter: ScopeFilter): boolean {
	return filter === "전체" || p.scope === filter;
}

/** Recently updated first; ties by name. */
export function byRecent(a: Project, b: Project): number {
	if (a.updated !== b.updated) return a.updated < b.updated ? 1 : -1;
	return a.title.localeCompare(b.title, "ko");
}

/** Recently completed first. */
export function byCompleted(a: Project, b: Project): number {
	const x = a.completed || a.updated;
	const y = b.completed || b.updated;
	if (x !== y) return x < y ? 1 : -1;
	return a.title.localeCompare(b.title, "ko");
}

export interface KanbanColumn {
	status: ProjectStatus;
	cards: Project[];
	/** Number of projects in this status (the 완료 column shows only the latest few). */
	total: number;
}

/** One column per status. Archived projects always go to 완료; unknown statuses to 후보. */
export function columnOf(p: Pick<Project, "status" | "archived">): ProjectStatus {
	if (p.archived) return "완료";
	return (PROJECT_STATUSES as readonly string[]).includes(p.status) ? (p.status as ProjectStatus) : "후보";
}

export function buildKanban(projects: Project[], filter: ScopeFilter = "전체", doneLimit = DONE_COLUMN_LIMIT): KanbanColumn[] {
	const shown = projects.filter((p) => matchesScope(p, filter));
	return PROJECT_STATUSES.map((status) => {
		const all = shown.filter((p) => columnOf(p) === status);
		if (status === "완료") return { status, cards: [...all].sort(byCompleted).slice(0, doneLimit), total: all.length };
		return { status, cards: [...all].sort(byRecent), total: all.length };
	});
}

export interface AreaGroup {
	area: string;
	projects: Project[];
}

export const NO_AREA = "기타";

/** List view: grouped by `area` (like Pinboard). Areas follow `order` first, then by name; 기타 last. */
export function groupByArea(projects: Project[], filter: ScopeFilter = "전체", order: string[] = []): AreaGroup[] {
	const map = new Map<string, Project[]>();
	for (const p of projects.filter((x) => matchesScope(x, filter))) {
		const a = p.area || NO_AREA;
		const list = map.get(a) ?? [];
		list.push(p);
		map.set(a, list);
	}
	const rank = (a: string) => (a === NO_AREA ? 1e9 : order.includes(a) ? order.indexOf(a) : 1e6);
	const statusRank = (p: Project) => PROJECT_STATUSES.indexOf(columnOf(p));
	return [...map.keys()]
		.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "ko"))
		.map((area) => ({ area, projects: map.get(area)!.sort((x, y) => statusRank(x) - statusRank(y) || byRecent(x, y)) }));
}

// ───────────────────────── 완료 타임라인 ─────────────────────────

export interface TimelineBar {
	project: Project;
	/** Position on the year's month axis, 0 (Jan 1) … 12 (end of Dec). */
	from: number;
	to: number;
	/** The bar continues from the previous year / into the next year. */
	clippedStart: boolean;
	clippedEnd: boolean;
}

/** Month position of an ISO date within `year` (0–12, fractional by day). */
export function monthPos(iso: string, year: number): number {
	const [y, m, d] = iso.split("-").map(Number);
	if (y < year) return 0;
	if (y > year) return 12;
	const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return m - 1 + (d - 1) / dim;
}

/** Years that have at least one completed project bar (started..completed overlaps the year). */
export function timelineYears(projects: Project[]): number[] {
	const ys = new Set<number>();
	for (const p of projects) {
		if (columnOf(p) !== "완료" || !p.completed) continue;
		const a = Number((p.started || p.completed).slice(0, 4));
		const b = Number(p.completed.slice(0, 4));
		for (let y = Math.min(a, b); y <= Math.max(a, b); y++) ys.add(y);
	}
	return [...ys].sort((a, b) => a - b);
}

/** Completed projects as `started`~`completed` bars on `year`'s month axis, earliest first. */
export function timelineBars(projects: Project[], year: number, filter: ScopeFilter = "전체"): TimelineBar[] {
	const out: TimelineBar[] = [];
	const y0 = `${year}-01-01`;
	const y1 = `${year}-12-31`;
	for (const p of projects) {
		if (columnOf(p) !== "완료" || !p.completed || !matchesScope(p, filter)) continue;
		let start = p.started || p.completed;
		let end = p.completed;
		if (start > end) [start, end] = [end, start];
		if (end < y0 || start > y1) continue;
		const from = monthPos(start, year);
		// The end day counts as a whole day.
		const [ey, em] = end.split("-").map(Number);
		const to = ey > year ? 12 : monthPos(end, year) + 1 / new Date(Date.UTC(ey, em, 0)).getUTCDate();
		out.push({ project: p, from, to: Math.min(12, to), clippedStart: start < y0, clippedEnd: end > y1 });
	}
	return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

// ───────────────────────── new project input ─────────────────────────

export interface NewProjectInput {
	name: string;
	summary: string;
	scope: Scope;
	area: string;
	kind: string;
	id: string;
	/** Comma-separated, optional. */
	aliases: string;
	/** User's own 「지금 가장 효과적인 한 가지 행동」, optional. */
	action: string;
	/** Sources that led here (hub `from`), e.g. the Drawer item's `from::` sessions (Drawer 「4-3」 1). Optional. */
	from?: string[];
}

/** Folder/file-safe project name (no path separators or characters Obsidian rejects). */
export function nameProblem(name: string): string | null {
	const n = name.trim();
	if (!n) return "이름을 적어 주세요.";
	if (/[\\/:*?"<>|#^[\]]/.test(n)) return "이름에 \\ / : * ? \" < > | # ^ [ ] 는 쓸 수 없어요.";
	if (n.startsWith(".")) return "이름은 점(.)으로 시작할 수 없어요.";
	return null;
}

export const ID_RE = /^P-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** AGENTS 「3-2」 1: `P-` + 영문 소문자·하이픈. A suggestion from the ASCII part of the name (may be empty). */
export function suggestId(name: string): string {
	const slug = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug ? `P-${slug}` : "P-";
}

/** All problems with the input (empty = ok). `taken` = ids and names already registered or on disk. */
export function validateInput(i: NewProjectInput, taken: { ids: string[]; names: string[] }): string[] {
	const out: string[] = [];
	const np = nameProblem(i.name);
	if (np) out.push(np);
	if (!i.summary.trim()) out.push("한 문장 설명을 적어 주세요.");
	if (!(SCOPES as readonly string[]).includes(i.scope)) out.push("개인/회사를 골라 주세요.");
	if (!i.area.trim()) out.push("area를 적어 주세요.");
	if (!(KINDS as readonly string[]).includes(i.kind)) out.push("유형을 골라 주세요.");
	if (!ID_RE.test(i.id.trim())) out.push("id는 P- 뒤에 영문 소문자·숫자·하이픈으로 적어 주세요. 예: P-honteam");
	if (taken.ids.includes(i.id.trim())) out.push(`이미 있는 id예요: ${i.id.trim()}`);
	if (taken.names.includes(i.name.trim())) out.push(`이미 있는 프로젝트 이름이에요: ${i.name.trim()}`);
	return out;
}
