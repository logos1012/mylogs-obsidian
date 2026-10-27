/**
 * Pinboard goal model.
 *
 * A TypeScript port of the parsing and calculation parts of
 * `01 Pinboard/_build/build_pinboard.py` (the reference implementation), following
 * `01 Pinboard/AGENTS.md` (OKR: Main Goal = Objective, Sub Goal = Key Result).
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 * Values are kept language-neutral (ISO dates, ids); only the view adds display text.
 */

export type GoalType = "main-goal" | "sub-goal";
/** 진행 중: `active` / `paused`. 종료 (사용자만 확정): `achieved` / `partial` / `missed` / `dropped`. */
export const GOAL_STATUSES = ["active", "paused", "achieved", "partial", "missed", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const ENDED_STATUSES: readonly string[] = ["achieved", "partial", "missed", "dropped"];

export const STATUS_KO: Record<string, string> = {
	active: "진행 중",
	paused: "멈춤",
	achieved: "달성",
	partial: "부분 달성",
	missed: "미달성",
	dropped: "중단",
};

/** A finished goal (its `health` is empty, its 종료 회고 is due). */
export function isEnded(status: string): boolean {
	return ENDED_STATUSES.includes(status);
}

/** `health`: a person's judgement, separate from progress. `""` = 판단 없음. */
export const HEALTHS = ["on-track", "at-risk", "off-track"] as const;
export type Health = (typeof HEALTHS)[number] | "";
export const HEALTH_KO: Record<string, string> = { "on-track": "순항", "at-risk": "주의", "off-track": "이탈", "": "판단 없음" };
export const HEALTH_ICON: Record<string, string> = { "on-track": "🟢", "at-risk": "🟡", "off-track": "🔴", "": "⚪" };

/** A known health value, else `""` (unknown words are not guessed into a colour). */
export function normalizeHealth(v: string): Health {
	const s = v.trim().toLowerCase();
	return (HEALTHS as readonly string[]).includes(s) ? (s as Health) : "";
}
export const KIND_KO: Record<string, string> = { outcome: "결과", performance: "수행" };
export const MEASURE_KO: Record<string, string> = { metric: "수치", milestone: "이정표" };

export const NEED = "입력 필요";
export const UNDECIDED = "미정";

/** One goal note's frontmatter, normalised. Empty values are `""` (never invented). */
export interface Goal {
	path: string;
	id: string;
	type: GoalType;
	title: string;
	parent: string;
	period: string;
	area: string;
	status: string;
	/** `on-track` / `at-risk` / `off-track` / `""` (판단 없음). */
	health: Health;
	/** Sub Goal weight in its Main's average; null = not set (counts as 1). */
	weight: number | null;
	measure: string;
	kind: string;
	baseline: string;
	current: string;
	target: string;
	unit: string;
	/** `YYYY-MM-DD` or "". */
	due: string;
	subTotal: number | null;
	subAchieved: number | null;
	progress: number | null;
	projects: string[];
	projectIds: string[];
	progressSource?: "projects" | "manual";
	projectWeights?: string[];
	from: string;
	updated: string;
}

// ───────────────────────── value helpers ─────────────────────────

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Any frontmatter value → string ("" when empty). Dates become ISO `YYYY-MM-DD`. */
export function valueToString(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (v instanceof Date) {
		if (isNaN(v.getTime())) return "";
		return `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}`;
	}
	if (Array.isArray(v)) return v.map(valueToString).filter(Boolean).join(", ");
	return String(v).trim();
}

function valueToList(v: unknown): string[] {
	if (v === null || v === undefined || v === "") return [];
	if (Array.isArray(v)) return v.map(valueToString).filter(Boolean);
	const s = valueToString(v);
	return s ? [s] : [];
}

/** Number or null (`"5,000"` → 5000; text → null). */
export function toNum(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	const s = valueToString(v).replace(/,/g, "");
	if (s === "") return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

export function isIsoDate(s: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`));
}

// ───────────────────────── frontmatter → model ─────────────────────────

/** Normalise one note's frontmatter. Returns null when it isn't a goal note. */
export function parseGoal(fm: Record<string, unknown> | null | undefined, path: string): Goal | null {
	if (!fm) return null;
	const type = valueToString(fm.type);
	if (type !== "main-goal" && type !== "sub-goal") return null;
	const s = (k: string) => valueToString(fm[k]);
	const base = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
	const due = s("due").slice(0, 10);
	const weight = toNum(fm.weight);
	return {
		path,
		id: s("id"),
		type,
		title: s("title") || base,
		parent: s("parent"),
		period: s("period"),
		area: s("area"),
		status: s("status") || "active",
		health: normalizeHealth(s("health")),
		weight: weight !== null && weight > 0 ? weight : null,
		measure: s("measure"),
		kind: s("kind"),
		baseline: s("baseline"),
		current: s("current"),
		target: s("target"),
		unit: s("unit"),
		due: isIsoDate(due) ? due : "",
		subTotal: toNum(fm.sub_total),
		subAchieved: toNum(fm.sub_achieved),
		progress: toNum(fm.progress),
		projects: valueToList(fm.projects),
		projectIds: valueToList(fm.project_ids),
		progressSource: s("progress_source") === "manual" ? "manual" : s("progress_source") === "projects" || valueToList(fm.project_ids).length ? "projects" : "manual",
		projectWeights: valueToList(fm.project_weights),
		from: s("from"),
		updated: s("updated"),
	};
}

/**
 * Minimal YAML frontmatter reader (port of `parse_frontmatter` in build_pinboard.py) that
 * types scalars the way Obsidian's metadata cache does: numbers → number, empty → null.
 * The view reads `metadataCache`; this is for tests and fallbacks.
 */
export function parseFrontmatterText(text: string): { data: Record<string, unknown>; body: string } {
	const t = text.replace(/^﻿/, "");
	const lines = t.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { data: {}, body: t };
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end === -1) return { data: {}, body: t };
	const scalar = (raw: string): unknown => {
		let v = raw.trim();
		if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")) return v.slice(1, -1);
		// `key:   # comment` is an empty value; a trailing `  # comment` on an unquoted scalar is dropped (as YAML and Obsidian read it).
		if (v.startsWith("#")) return null;
		const c = /\s+#/.exec(v);
		if (c) v = v.slice(0, c.index).trim();
		if (v === "" || v === "~" || v === "null") return null;
		if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
		if (v === "true" || v === "false") return v === "true";
		return v;
	};
	const data: Record<string, unknown> = {};
	let lastKey: string | null = null;
	for (const line of lines.slice(1, end)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && lastKey) {
			const cur = data[lastKey];
			const list = Array.isArray(cur) ? cur : [];
			const v = scalar(item[1]);
			if (v !== null) list.push(v);
			data[lastKey] = list;
			continue;
		}
		const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const raw = m[2].trim();
		if (raw.startsWith("[") && raw.endsWith("]")) {
			const inner = raw.slice(1, -1).trim();
			data[m[1]] = inner ? inner.split(",").map((x) => scalar(x)).filter((x) => x !== null) : [];
		} else data[m[1]] = scalar(raw);
		lastKey = m[1];
	}
	return { data, body: lines.slice(end + 1).join("\n") };
}

// ───────────────────────── body sections ─────────────────────────

/** `## heading` → content (trimmed). HTML comments removed. Port of `parse_sections`. */
export function parseSections(body: string): Map<string, string> {
	const clean = body.replace(/<!--[\s\S]*?-->/g, "");
	const out = new Map<string, string[]>();
	let cur: string[] | null = null;
	let inFence = false;
	for (const line of clean.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const m = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);
		if (m) {
			cur = [];
			out.set(m[1].trim(), cur);
		} else if (cur) {
			if (!inFence && /^#\s/.test(line)) {
				cur = null;
				continue;
			}
			cur.push(line);
		}
	}
	const res = new Map<string, string>();
	for (const [k, v] of out) res.set(k, v.join("\n").trim());
	return res;
}

/** First section whose name equals or starts with one of the prefixes. */
export function findSectionText(sections: Map<string, string>, ...prefixes: string[]): string {
	for (const p of prefixes) {
		for (const [k, v] of sections) if (k === p || k.startsWith(p)) return v;
	}
	return "";
}

/** Wikilinks and markdown emphasis → readable text. */
export function cleanInline(s: string): string {
	return s
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
}

/** List items of a section as plain text (empty bullets dropped). */
export function bulletItems(section: string): string[] {
	const out: string[] = [];
	for (const line of section.split(/\r?\n/)) {
		const t = line.trim();
		if (!t) continue;
		const item = cleanInline(t.replace(/^([-*+]|\d+\.)\s*(\[[ xX]\]\s*)?/, ""));
		if (item) out.push(item);
	}
	return out;
}

export function wikilinkName(s: string): string {
	const m = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(s);
	return m ? (m[2] ?? m[1]).trim() : cleanInline(s);
}

// ───────────────────────── progress math (AGENTS.md 「속성」) ─────────────────────────

function clamp(n: number): number {
	return Math.max(0, Math.min(100, n));
}

/** Metric: `(current - baseline) / (target - baseline)`, clamped 0–100. Null when not computable. */
export function metricProgress(baseline: unknown, current: unknown, target: unknown): number | null {
	const b = toNum(baseline);
	const c = toNum(current);
	const t = toNum(target);
	if (b === null || c === null || t === null || t === b) return null;
	return clamp(((c - b) / (t - b)) * 100);
}

/**
 * The `progress` value to store for a Sub Goal (integer 0–100), SPEC 1-2:
 * `achieved` → 100; metric → formula (null if a number is missing: keep what's there, never
 * invent); milestone → 0 until achieved.
 */
export function computeSubProgress(g: Pick<Goal, "measure" | "status" | "baseline" | "current" | "target"> & Partial<Pick<Goal, "progressSource" | "progress">>): number | null {
	if (g.progressSource === "projects") return g.progress ?? 0;
	if (g.status === "achieved") return 100;
	if (g.measure === "milestone") return 0;
	if (g.measure === "metric") {
		const p = metricProgress(g.baseline, g.current, g.target);
		return p === null ? null : Math.round(p);
	}
	return null;
}

export interface Rollup {
	subTotal: number;
	subAchieved: number;
	progress: number;
}

/** What a Sub Goal contributes to its Main: its progress, or 0 while it is 미정. */
export type RollupSub = Pick<Goal, "status"> & Partial<Pick<Goal, "measure" | "baseline" | "current" | "target" | "weight" | "progressSource" | "progress">>;

function rollupProgressOf(s: RollupSub): number {
	return computeSubProgress({ progressSource: s.progressSource, progress: s.progress, measure: s.measure ?? "", status: s.status, baseline: s.baseline ?? "", current: s.current ?? "", target: s.target ?? "" }) ?? 0;
}

/**
 * Main Goal (SPEC 1-2): `sub_total` (dropped excluded), `sub_achieved`, and `progress` = the
 * weighted average `Σ(progress_i × w_i) / Σ w_i` of the Sub Goals that aren't dropped (a missing
 * weight counts as 1, a 미정 Sub as 0, no Sub → 0). Each Sub counts with its rounded progress
 * (`computeSubProgress`), the integer stored in its note.
 */
export function rollupMain(subs: RollupSub[]): Rollup {
	const live = subs.filter((s) => s.status !== "dropped");
	const subAchieved = live.filter((s) => s.status === "achieved").length;
	let sum = 0;
	let wsum = 0;
	for (const s of live) {
		const w = s.weight && s.weight > 0 ? s.weight : 1;
		sum += rollupProgressOf(s) * w;
		wsum += w;
	}
	return { subTotal: live.length, subAchieved, progress: wsum ? Math.round(sum / wsum) : 0 };
}

/** Progress shown for a Sub Goal: computed from the note (null = 미정; the stored value isn't shown). */
export function displaySubProgress(g: Goal): number | null {
	if (g.progressSource === "projects") return g.progress ?? 0;
	if (g.status === "achieved") return 100;
	if (g.measure === "milestone") return 0;
	if (g.measure === "metric") return metricProgress(g.baseline, g.current, g.target);
	return null;
}

/** Progress shown for a Main Goal: always computed from its Sub Goals (never typed in). */
export function displayMainProgress(_m: Goal, subs: Goal[]): Rollup {
	return rollupMain(subs);
}

// ───────────────────────── board ─────────────────────────

export interface MainCard {
	main: Goal;
	subs: Goal[];
}

export interface Board {
	cards: MainCard[];
	/** Sub Goals whose parent isn't a Main Goal of this year. */
	orphans: Goal[];
	/** Areas in first-appearance order (cards are grouped by them). */
	areas: string[];
	mains: Goal[];
	subs: Goal[];
}

export function idKey(id: string): (number | string)[] {
	return id.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}

export function compareIds(a: string, b: string): number {
	const ka = idKey(a);
	const kb = idKey(b);
	for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
		const x = ka[i];
		const y = kb[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		if (typeof x === "number" && typeof y === "number") return x - y;
		return String(x) < String(y) ? -1 : 1;
	}
	return 0;
}

export function buildBoard(goals: Goal[]): Board {
	const byId = (a: Goal, b: Goal) => compareIds(a.id, b.id);
	const mains = goals.filter((g) => g.type === "main-goal").sort(byId);
	const subs = goals.filter((g) => g.type === "sub-goal").sort(byId);
	const mainIds = new Set(mains.map((m) => m.id));
	const byParent = new Map<string, Goal[]>();
	const orphans: Goal[] = [];
	for (const s of subs) {
		if (mainIds.has(s.parent)) {
			const list = byParent.get(s.parent) ?? [];
			list.push(s);
			byParent.set(s.parent, list);
		} else orphans.push(s);
	}
	const areas: string[] = [];
	for (const m of mains) {
		const a = m.area || "기타";
		if (!areas.includes(a)) areas.push(a);
	}
	const ordered = [...mains].sort((a, b) => areas.indexOf(a.area || "기타") - areas.indexOf(b.area || "기타") || byId(a, b));
	if (orphans.length && !areas.includes("기타")) areas.push("기타");
	return { cards: ordered.map((m) => ({ main: m, subs: byParent.get(m.id) ?? [] })), orphans, areas, mains, subs };
}

// ───────────────────────── 채워 넣을 칸 ─────────────────────────

export interface MissingField {
	id: string;
	title: string;
	field: string;
}

/** Empty values the user still has to fill in (same rules as the reference). */
export function missingFields(board: Board, sectionsOf: (path: string) => Map<string, string>): MissingField[] {
	const out: MissingField[] = [];
	const add = (g: Goal, field: string) => out.push({ id: g.id, title: g.title, field });
	const subMissing = (s: Goal) => {
		if (!s.due) add(s, "기한");
		const fields: [keyof Goal, string][] =
			s.measure === "metric"
				? [
						["baseline", "시작 값"],
						["current", "현재 값"],
						["target", "목표 값"],
					]
				: [
						["current", "현재 상태"],
						["target", "달성 조건"],
					];
		for (const [k, label] of fields) if (!String(s[k]).trim()) add(s, label);
	};
	for (const { main, subs } of board.cards) {
		const secs = sectionsOf(main.path);
		if (!bulletItems(findSectionText(secs, "왜 이 목표인가", "왜")).length) add(main, "왜 이 목표인가");
		if (!bulletItems(findSectionText(secs, "달성한 모습")).length) add(main, "달성한 모습");
		subs.forEach(subMissing);
		if (!subs.length) add(main, "Sub Goal");
		if (!bulletItems(findSectionText(secs, "수단")).length) add(main, "수단 (프로젝트·습관)");
	}
	board.orphans.forEach(subMissing);
	return out;
}

// ───────────────────────── display formatting ─────────────────────────

/** `5000000` → `500만`, `1234` → `1,234`, `2.50` → `2.5`. */
export function fmtNum(n: number): string {
	if (Number.isInteger(n)) {
		if (Math.abs(n) >= 10000 && n % 10000 === 0) return `${(n / 10000).toLocaleString("en-US")}만`;
		return n.toLocaleString("en-US");
	}
	return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** `[value, unit]` for display, or null when empty. Text values drop the unit. */
export function fmtVal(v: string, unit: string): [string, string] | null {
	const s = v.trim();
	if (!s) return null;
	const n = toNum(s);
	return n !== null ? [fmtNum(n), unit] : [s, ""];
}

export function daysBetween(fromIso: string, toIso: string): number {
	return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

export interface DDay {
	big: string;
	small: string;
	cls: "" | "none" | "soon" | "over";
}

export function dday(due: string, today: string): DDay {
	if (!due) return { big: "기한 미정", small: "", cls: "none" };
	const d = daysBetween(today, due);
	const small = due.replace(/-/g, ".");
	if (d > 0) return { big: `D-${d}`, small, cls: d <= 14 ? "soon" : "" };
	if (d === 0) return { big: "D-DAY", small, cls: "soon" };
	return { big: `D+${-d}`, small: `${small} 지남`, cls: "over" };
}

export interface YearInfo {
	daysLeft: number;
	label: string;
	/** 0–100. */
	pct: number;
}

export function yearInfo(year: number, today: string): YearInfo {
	const start = `${year}-01-01`;
	const end = `${year}-12-31`;
	const total = daysBetween(start, end) + 1;
	if (today < start) return { daysLeft: daysBetween(today, start), label: "일 뒤 시작", pct: 0 };
	if (today > end) return { daysLeft: 0, label: "일 남음 · 한 해 마감", pct: 100 };
	return { daysLeft: daysBetween(today, end), label: "올해 남은 날", pct: ((daysBetween(start, today) + 1) / total) * 100 };
}

/** "목표까지 N unit · 남은 W주 동안 주 X unit씩" — only from numbers in the note. */
export function paceHint(g: Goal, today: string): { remain: string; perWeek: string; weeks: number } | null {
	if (g.measure !== "metric" || g.status !== "active") return null;
	const c = toNum(g.current);
	const t = toNum(g.target);
	if (c === null || t === null) return null;
	const remain = Math.abs(t - c);
	if (remain <= 0) return null;
	const out = { remain: fmtNum(remain), perWeek: "", weeks: 0 };
	if (g.due && daysBetween(today, g.due) > 0) {
		const weeks = daysBetween(today, g.due) / 7;
		if (weeks >= 1) {
			const per = remain / weeks;
			out.perWeek = per < 100 ? fmtNum(Math.round(per * 100) / 100) : fmtNum(Math.round(per));
			out.weeks = Math.round(weeks);
		}
	}
	return out;
}

/** Area colours (accent, accent2). Unknown areas take the palette in order. */
const AREA_COLORS: Record<string, [string, string]> = {
	사업: ["#f0642e", "#ffb02e"],
	건강: ["#11a87a", "#7bd88f"],
	브랜드: ["#9b4dff", "#ff5fa2"],
};
const PALETTE: [string, string][] = [
	["#2f7cf6", "#41d1ff"],
	["#e0436b", "#ff9a62"],
	["#0e9fa8", "#6ee0c4"],
	["#c2410c", "#facc15"],
	["#6d5dfc", "#c084fc"],
];

export function areaColor(area: string, order: string[]): [string, string] {
	if (AREA_COLORS[area]) return AREA_COLORS[area];
	const unknown = order.filter((a) => !AREA_COLORS[a]);
	const idx = Math.max(0, unknown.indexOf(area));
	return PALETTE[idx % PALETTE.length];
}

/** User input for `current`: numbers are stored as numbers, everything else as text. */
export function parseInputValue(raw: string): string | number {
	const s = raw.trim();
	const n = toNum(s);
	return n !== null && /^-?[\d,]+(\.\d+)?$/.test(s) ? n : s;
}

// ───────────────────────── 진척 기록 (SPEC 1-3) ─────────────────────────

export type Verify = "보고됨" | "확인됨";
export const VERIFIES: readonly Verify[] = ["보고됨", "확인됨"];

/**
 * One `## 진척 기록` line, read:
 * `YYYY-MM-DD: 내용 (value:: 98) (health:: at-risk) (보고됨) — 근거: [[…]]`.
 * Old lines without fields stay valid (their fields are empty).
 */
export interface ProgressLine {
	/** `YYYY-MM-DD` or "". */
	date: string;
	/** 내용 without the fields, the 보고됨/확인됨 mark and the 근거. */
	text: string;
	/** `(value:: N)` as a number (null when absent or not a number). */
	value: number | null;
	valueRaw: string;
	health: Health;
	verify: Verify | "";
	/** After `— 근거:`, as written. */
	evidence: string;
}

/** Parse the text of a 진척 기록 list item (without the `- `). */
export function parseProgressLine(raw: string): ProgressLine {
	let s = raw.trim();
	let date = "";
	const dm = /^(\d{4}-\d{2}-\d{2})\s*:?\s*/.exec(s);
	if (dm && isIsoDate(dm[1])) {
		date = dm[1];
		s = s.slice(dm[0].length);
	}
	let evidence = "";
	const em = /\s*[—–]\s*근거\s*:\s*(.*)$/.exec(s);
	if (em) {
		evidence = em[1].trim();
		s = s.slice(0, em.index);
	}
	let valueRaw = "";
	s = s.replace(/\s*\(\s*value\s*::\s*([^)]*?)\s*\)/, (_m, v: string) => {
		valueRaw = v.trim();
		return "";
	});
	let health: Health = "";
	s = s.replace(/\s*\(\s*health\s*::\s*([^)]*?)\s*\)/, (_m, v: string) => {
		health = normalizeHealth(v);
		return "";
	});
	let verify: Verify | "" = "";
	s = s.replace(/\s*\((보고됨|확인됨)\)/, (_m, v: Verify) => {
		verify = v;
		return "";
	});
	return { date, text: s.replace(/\s{2,}/g, " ").trim(), value: valueRaw ? toNum(valueRaw) : null, valueRaw, health, verify, evidence };
}

/** Newest first: by date (undated last), later lines first within a day. */
export function newestFirst<T extends { date: string }>(lines: T[]): T[] {
	return lines
		.map((l, i) => ({ l, i }))
		.sort((a, b) => (a.l.date === b.l.date ? b.i - a.i : !a.l.date ? 1 : !b.l.date ? -1 : a.l.date < b.l.date ? 1 : -1))
		.map((x) => x.l);
}

export interface ChartPoint {
	date: string;
	value: number;
	health: Health;
	/** The `baseline` point (first point of the line). */
	baseline?: boolean;
}

/**
 * Points of the 시간 흐름 chart (SPEC 1-3): `baseline` first (dated at the earliest 진척 기록 line,
 * or `start` when there is none), then every dated line with a numeric `(value::)` in date order.
 */
export function chartSeries(g: Pick<Goal, "baseline" | "target">, lines: ProgressLine[], start: string): { points: ChartPoint[]; target: number | null } {
	const dated = lines.filter((l) => l.date);
	const first = dated.map((l) => l.date).sort()[0] ?? start;
	const points: ChartPoint[] = [];
	const b = toNum(g.baseline);
	if (b !== null) points.push({ date: first, value: b, health: "", baseline: true });
	const vals = dated
		.map((l, i) => ({ l, i }))
		.filter((x) => x.l.value !== null)
		.sort((x, y) => (x.l.date === y.l.date ? x.i - y.i : x.l.date < y.l.date ? -1 : 1));
	for (const { l } of vals) points.push({ date: l.date, value: l.value!, health: l.health });
	return { points, target: toNum(g.target) };
}

// ───────────────────────── 관련 업무 (SPEC 1-5) ─────────────────────────

/** A project hub, as far as the Pinboard needs it. */
export interface ProjectRef {
	id: string;
	title: string;
	/** Hub note path. */
	path: string;
	status: string;
	/** The hub's `goals` (goal ids). */
	goals: string[];
	/** Completed and moved to the Archive Box (not offered for new links). */
	archived?: boolean;
}

/** A Flywheel element (`12 Flywheel/Flywheel.md`) with its `goal::` ids. */
export interface HabitRef {
	id: string;
	name: string;
	status: string;
	goals: string[];
}

export type RelatedKind = "project" | "habit" | "memo";

export interface RelatedItem {
	kind: RelatedKind;
	label: string;
	/** Hub path (projects). */
	path?: string;
	id?: string;
	status?: string;
	/** Linked from one side only (goal → hub or hub → goal). */
	oneSided?: boolean;
	/** The goal names a project that wasn't found. */
	broken?: boolean;
}

/** Goal ids in a Flywheel `goal::` value (`G-2026-02.1`, `[[G-2026-02.1 …]]`, comma-separated). */
export function goalIdsIn(value: string): string[] {
	const out: string[] = [];
	for (const m of value.matchAll(/G-\d{4}-\d+(?:\.\d+)?/g)) if (!out.includes(m[0])) out.push(m[0]);
	return out;
}

function linkTarget(link: string): string {
	const m = /\[\[([^\]|#]+)/.exec(link);
	return (m ? m[1] : link).trim().replace(/\.md$/, "");
}

function baseOf(path: string): string {
	return path.replace(/\.md$/, "").split("/").pop() ?? path;
}

/**
 * 관련 업무 of one goal: its projects (`project_ids` / `projects`, plus hubs whose `goals` list it;
 * one-sided links are marked), Flywheel elements whose `goal::` names it, and the 수단 text items
 * as 메모. Nothing here moves progress (SPEC 1-5).
 */
export function relatedOf(g: Pick<Goal, "id" | "projects" | "projectIds">, projects: ProjectRef[], habits: HabitRef[], means: string[]): RelatedItem[] {
	const out: RelatedItem[] = [];
	const seen = new Set<string>();
	const addProject = (p: ProjectRef, fromGoal: boolean) => {
		if (seen.has(p.path)) return;
		seen.add(p.path);
		out.push({ kind: "project", label: p.title || baseOf(p.path), path: p.path, id: p.id, status: p.status, oneSided: fromGoal ? !p.goals.includes(g.id) : true });
	};
	for (const id of g.projectIds) {
		const p = projects.find((x) => x.id && x.id === id);
		if (p) addProject(p, true);
		else out.push({ kind: "project", label: id, id, broken: true });
	}
	for (const link of g.projects) {
		const t = linkTarget(link);
		const p = projects.find((x) => x.path.replace(/\.md$/, "") === t || baseOf(x.path) === baseOf(t));
		if (p) addProject(p, true);
		else if (!out.some((x) => x.broken && x.label === wikilinkName(link))) out.push({ kind: "project", label: wikilinkName(link), broken: true });
	}
	for (const p of projects) if (p.goals.includes(g.id)) addProject(p, false);
	for (const h of habits) if (h.goals.includes(g.id)) out.push({ kind: "habit", label: h.name ? `${h.id} ${h.name}` : h.id, id: h.id, status: h.status });
	for (const m of means) out.push({ kind: "memo", label: m });
	return out;
}

/** A Main Goal's 관련 업무: its own, plus its Sub Goals' projects and habits (each once). */
export function mergeRelated(own: RelatedItem[], fromSubs: RelatedItem[][]): RelatedItem[] {
	const out = [...own];
	const key = (r: RelatedItem) => `${r.kind}:${r.path ?? r.id ?? r.label}`;
	const keys = new Set(out.map(key));
	for (const list of fromSubs) {
		for (const r of list) {
			if (r.kind === "memo" || keys.has(key(r))) continue;
			keys.add(key(r));
			out.push({ ...r, oneSided: false });
		}
	}
	return out;
}

// ───────────────────────── summary ─────────────────────────

export interface HealthCounts {
	"on-track": number;
	"at-risk": number;
	"off-track": number;
	/** Live goals without a judgement. */
	none: number;
}

/** Health of the goals still running (active / paused); finished goals have none. */
export function healthCounts(goals: Pick<Goal, "status" | "health">[]): HealthCounts {
	const c: HealthCounts = { "on-track": 0, "at-risk": 0, "off-track": 0, none: 0 };
	for (const g of goals) {
		if (isEnded(g.status)) continue;
		if (g.health) c[g.health]++;
		else c.none++;
	}
	return c;
}
