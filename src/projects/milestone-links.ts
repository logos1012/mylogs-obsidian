/**
 * 마일스톤 ↔ 할 일 연결 (0.51.0, 계획 「확정 계획」 §2–§5). Pure: no Obsidian imports.
 *
 *   `(ms:: M-xxxxxxxx)` on a 마일스톤 / 성과 지표 line = its id (given only when a link needs it).
 *   `(ms:: M-…)` on a top-level `## 할 일` row = the 마일스톤 it serves (하위 rows follow their 묶음).
 *   `(aim:: M-a, M-b)` on a 마일스톤 = the 성과 지표 it aims at; `(start:: n)` on a 성과 지표 = its
 *   value when it was first aimed at (the 「다시 검토」 baseline; missing = 0).
 *
 * Nothing here checks a 마일스톤 or a 성과 지표: achievement stays the user's call (rule 「6-1」).
 */
import { readMilestones, setMilestoneFields, milestoneKind, type Milestone, type MilestoneFieldEdit } from "./milestones.ts";
import { appendHubTask, hubTopRows, insertTaskAfter, setTopRowField, taskTitle, type HubTopRow, type ProjectTask } from "./tasks.ts";

export const MS_ID_RE = /^M-[0-9a-f]{8}$/;

function randomHex8(): string {
	const b = new Uint8Array(4);
	globalThis.crypto.getRandomValues(b);
	return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
/** `M-` + 8 lowercase hex, not one of `taken`. */
export function newMilestoneId(taken: Iterable<string> = [], rand: () => string = randomHex8): string {
	const used = new Set(taken);
	for (let i = 0; i < 100; i++) { const id = `M-${rand()}`; if (MS_ID_RE.test(id) && !used.has(id)) return id; }
	throw new Error("마일스톤 id를 만들지 못했어요. 다시 시도해 주세요.");
}

/** `(aim:: M-a, M-b)` → ids. */
export function aimIds(m: Pick<Milestone, "aim">): string[] {
	return (m.aim ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

/** Top-level `## 할 일` rows linked to the milestone id `ms`. */
export function linkedRows(text: string, ms: string | undefined): HubTopRow[] {
	return ms ? hubTopRows(text).filter(r => r.ms === ms) : [];
}

/**
 * Top-level `## 할 일` rows (keys) shown under a 마일스톤 row (its 「할 일 n/m」 panel): linked by
 * `(ms:: …)` to a 마일스톤 that exists and is not a 성과 지표 (those show no linked 할 일). The
 * 「할 일」 list leaves these out, so each 묶음 shows once. A link to no 마일스톤 counts for nothing.
 */
export function linkedGroupKeys(text: string, milestones: Pick<Milestone, "ms" | "kind">[]): Set<string> {
	const ids = new Set(milestones.filter(m => m.ms && milestoneKind(m) !== "metric").map(m => m.ms!));
	return new Set(hubTopRows(text).filter(r => r.ms && ids.has(r.ms)).map(r => r.key));
}

export type TaskState = ProjectTask["state"];
/** A reference row's state from its calendar copies (done if any is done; let go if all are). */
export function calendarStateOf(tasks: ProjectTask[]): (id: string) => TaskState | undefined {
	return id => {
		const c = tasks.filter(t => t.kind !== "hub" && t.id === id && t.state !== "moved");
		if (!c.length) return undefined;
		return c.some(t => t.state === "done") ? "done" : c.every(t => t.state === "cancelled") ? "cancelled" : "scheduled";
	};
}

/**
 * 「할 일 n/m」: a linked 묶음 counts its 하위 할 일, a linked 단독 할 일 counts itself. A checkbox row
 * reads its own box; an assigned (reference) row reads its calendar copy. 놓아줌 (`[-]` / cancelled)
 * counts in neither n nor m.
 */
export function milestoneTaskProgress(rows: HubTopRow[], refState: (id: string) => TaskState | undefined = () => undefined): { done: number; total: number } {
	let done = 0, total = 0;
	const count = (u: { id: string; line: string; ref: boolean }) => {
		let st: TaskState | undefined;
		if (!u.ref) { const box = /^\s*[-*+]\s+\[(.)\]/.exec(u.line)?.[1] ?? " "; st = box === "x" || box === "X" ? "done" : box === "-" ? "cancelled" : "scheduled"; }
		else st = u.id ? refState(u.id) : undefined;
		if (st === "cancelled") return;
		total++; if (st === "done") done++;
	};
	for (const r of rows) { if (r.children.length) r.children.forEach(count); else count(r); }
	return { done, total };
}

/**
 * The linked-할 일 panel under a 마일스톤 starts open whenever it has linked 묶음; it closes only
 * for the ids the user folded this session (`collapsed`). No id or nothing linked → no panel.
 */
export function milestonePanelOpen(ms: string | undefined, linkedCount: number, collapsed: ReadonlySet<string> = new Set()): boolean {
	return !!ms && linkedCount > 0 && !collapsed.has(ms);
}

/** No automatic achievement: only a button, when every linked 할 일 is done and the 마일스톤 is open. */
export function readyToConfirm(m: Pick<Milestone, "done" | "kind">, progress: { done: number; total: number }): boolean {
	return milestoneKind(m) === "milestone" && !m.done && progress.total > 0 && progress.done === progress.total;
}

/**
 * 다시 검토: a 마일스톤 that is done, aiming at a 성과 지표 that is not, whose current value has not
 * moved above its start (missing current / start = 0). Shown only; never written.
 */
export function reviewNotes(items: Milestone[]): { milestone: Milestone; metric: Milestone }[] {
	const out: { milestone: Milestone; metric: Milestone }[] = [];
	for (const m of items) {
		if (milestoneKind(m) !== "milestone" || !m.done) continue;
		for (const id of aimIds(m)) {
			const metric = items.find(i => i.ms === id && milestoneKind(i) === "metric");
			if (metric && !metric.done && (metric.current ?? 0) <= (metric.start ?? 0)) out.push({ milestone: m, metric });
		}
	}
	return out;
}

/** A `## 할 일` row as shown: its key and the exact line it had (re-checked before saving). */
export interface RowRef { key: string; line: string }
export type LinkChange =
	/** Link these top-level rows to the 마일스톤 (it gets its id now if it has none). */
	| { kind: "link"; line: number; rows: RowRef[] }
	/** Take `(ms::)` off these rows. */
	| { kind: "unlink"; line: number; rows: RowRef[] }
	/** A new 묶음 at the end of `## 할 일`, linked to the 마일스톤. */
	| { kind: "addGroup"; line: number; title: string; taskId: string; projectId: string }
	/** `(aim::)` = these 성과 지표 (by line; none = remove); each gets an id and a `(start::)` if missing. */
	| { kind: "aim"; line: number; metrics: number[] }
	/** 「추천 연결 · 한 번에 연결」: several 마일스톤 ↔ row pairs at once. */
	| { kind: "pairs"; pairs: { line: number; row: RowRef }[] };

/**
 * The hub after `change`, in one piece: line-level edits in `## 마일스톤` (must still read
 * `expected`) and `## 할 일` (each row must still read as shown). Throws 「다른 곳에서 변경됐어요」
 * otherwise. `detail` is the log line.
 */
export function applyLinkChange(text: string, expected: string, change: LinkChange, newId: (taken: Set<string>) => string = t => newMilestoneId(t)): { text: string; detail: string } {
	const ms = readMilestones(text);
	if (ms.source !== expected) throw new Error("마일스톤이 다른 곳에서 변경됐어요. 취소한 뒤 최신 목록에서 다시 수정해 주세요.");
	const taken = new Set(ms.items.map(i => i.ms).filter((x): x is string => !!x));
	const edits: MilestoneFieldEdit[] = [];
	const itemAt = (line: number) => {
		const m = ms.items.find(i => i.line === line);
		if (!m) throw new Error("마일스톤을 찾지 못했어요. 목록을 새로 열어 주세요.");
		return m;
	};
	/** The item's id, given now (in this same save) if it has none. */
	const idOf = (m: Milestone): string => {
		if (m.ms) return m.ms;
		const pending = edits.find(e => e.line === m.line && e.key === "ms");
		if (pending) return pending.value!;
		const id = newId(taken); taken.add(id);
		edits.push({ line: m.line, key: "ms", value: id });
		return id;
	};
	const onlyMilestone = (m: Milestone) => { if (milestoneKind(m) !== "milestone") throw new Error("성과 지표에는 할 일을 달지 않아요. 마일스톤에 연결해 주세요."); };
	const titles = (rows: RowRef[]) => rows.map(r => hubTopRows(text).find(x => x.key === r.key)?.title ?? r.key).join(", ");
	let tasks: (t: string) => string = t => t, detail = "";
	if (change.kind === "link" || change.kind === "unlink") {
		const m = itemAt(change.line);
		if (!change.rows.length) return { text, detail: "" };
		if (change.kind === "link") {
			onlyMilestone(m);
			const id = idOf(m);
			tasks = t => change.rows.reduce((acc, r) => setTopRowField(acc, r.key, r.line, "ms", id), t);
			detail = `할 일 연결: ${titles(change.rows)} → ${m.text}`;
		} else {
			tasks = t => change.rows.reduce((acc, r) => setTopRowField(acc, r.key, r.line, "ms", null), t);
			detail = `할 일 연결 풀기: ${titles(change.rows)} ↛ ${m.text}`;
		}
	} else if (change.kind === "addGroup") {
		const m = itemAt(change.line); onlyMilestone(m);
		const title = taskTitle(change.title);
		if (!/^T-[a-zA-Z0-9-]+$/.test(change.taskId)) throw new Error("할 일 식별자를 확인해 주세요.");
		const id = idOf(m);
		const row = `- [ ] ${title} (task:: ${change.taskId}) (project:: ${change.projectId}) (ms:: ${id})`;
		// Right after the last row of `## 할 일` (its 하위 rows included), else at the section's end.
		tasks = t => { const last = hubTopRows(t).pop(); return last ? insertTaskAfter(t, last.key, row, false) : appendHubTask(t, row); };
		detail = `할 일 추가: ${title} (◆ ${m.text})`;
	} else if (change.kind === "aim") {
		const m = itemAt(change.line); onlyMilestone(m);
		const metrics = change.metrics.map(itemAt);
		for (const x of metrics) if (milestoneKind(x) !== "metric") throw new Error("노리는 성과 지표는 성과 지표 중에서 골라 주세요.");
		const ids = metrics.map(x => {
			const id = idOf(x);
			if (x.start === undefined) edits.push({ line: x.line, key: "start", value: String(x.current ?? 0) });
			return id;
		});
		const same = ids.join(", ") === aimIds(m).join(", ");
		if (same && !edits.length) return { text, detail: "" };
		if (!same) edits.push({ line: m.line, key: "aim", value: ids.length ? ids.join(", ") : null });
		detail = `노리는 성과 지표: ${m.text} → ${metrics.map(x => x.text).join(", ") || "없음"}`;
	} else {
		if (!change.pairs.length) return { text, detail: "" };
		const plan = change.pairs.map(p => { const m = itemAt(p.line); onlyMilestone(m); return { m, row: p.row, id: idOf(m) }; });
		tasks = t => plan.reduce((acc, p) => setTopRowField(acc, p.row.key, p.row.line, "ms", p.id), t);
		detail = `추천 연결 ${plan.length}건: ${plan.map(p => `${titles([p.row])} → ${p.m.text}`).join(" · ")}`;
	}
	// Field edits keep every line in place, so the row keys of `## 할 일` still hold afterwards.
	const out = tasks(setMilestoneFields(text, expected, edits));
	return { text: out, detail };
}

// ───────────────────────── 추천 연결 ─────────────────────────

/**
 * A deliberately small table of intents that the same plan reads in different words. Two titles
 * that share an intent count as related even with no word in common (e.g. a 묶음 「… 판매 시작」 is
 * the work behind the 마일스톤 「첫 광고 집행」). Each phrase is a run of normalised words.
 * Outcomes (첫 주문, 순이익) are not here on purpose: they are 성과 지표, not work to link.
 */
export const LINK_INTENTS: { name: string; phrases: string[][] }[] = [
	{ name: "판매 시작", phrases: [["판매", "시작"], ["판매", "개시"], ["판매", "오픈"], ["광고", "집행"], ["광고", "시작"], ["첫", "광고"], ["런칭"], ["출시"]] },
	{ name: "정하기", phrases: [["정하기"], ["정하"], ["확정"], ["선정"], ["결정"], ["고르기"]] },
	{ name: "세팅·오픈", phrases: [["세팅"], ["셋업"], ["구축"], ["개설"], ["오픈"]] },
];
/** Words too common in plans to say two titles are about the same thing. */
const STOP = new Set(["첫", "및", "등", "완료", "하기", "것", "준비", "확인", "통과", "시작", "개", "번"]);
const PARTICLE = /(?:으로|에서|까지|부터|을|를|이|가|은|는|의|에|로|도|과|와)$/;

interface Word { w: string; weight: number }
/** Words of a title: the main part weighs 1, a `(…)` note or the detail after `:` weighs ½. */
function words(title: string): Word[] {
	const out: Word[] = [];
	const colon = title.indexOf(":");
	const push = (s: string, weight: number) => {
		for (let w of s.split(/[\s,.·/()[\]:;!?~"'「」『』…-]+/)) {
			if (!w) continue;
			if (w.length >= 3) w = w.replace(PARTICLE, "");
			out.push({ w: w.toLowerCase(), weight });
		}
	};
	const main = colon >= 0 ? title.slice(0, colon) : title, rest = colon >= 0 ? title.slice(colon + 1) : "";
	for (const [part, weight] of [[main, 1], [rest, 0.5]] as const) {
		let at = 0;
		for (const m of part.matchAll(/\([^)]*\)/g)) { push(part.slice(at, m.index), weight); push(m[0], weight / 2); at = m.index! + m[0].length; }
		push(part.slice(at), weight);
	}
	return out;
}
function intents(ws: Word[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const it of LINK_INTENTS) for (const ph of it.phrases) for (let i = 0; i + ph.length <= ws.length; i++) {
		if (ph.every((w, k) => ws[i + k].w === w)) out.set(it.name, Math.max(out.get(it.name) ?? 0, Math.min(...ws.slice(i, i + ph.length).map(x => x.weight))));
	}
	return out;
}
/** How much a 묶음 title and a 마일스톤 title say the same thing (0 = nothing). */
export function linkScore(task: string, milestone: string): number {
	const a = words(task), b = words(milestone);
	const content = (w: string) => !STOP.has(w) && !/\d/.test(w) && w.length >= 2;
	let score = 0;
	const seen = new Set<string>();
	for (const x of a) {
		if (!content(x.w) || seen.has(x.w)) continue;
		const best = Math.max(0, ...b.filter(y => y.w === x.w).map(y => y.weight));
		if (best) { seen.add(x.w); score += x.weight * best; }
	}
	const ia = intents(a), ib = intents(b);
	for (const [name, wa] of ia) if (ib.has(name)) score += wa * ib.get(name)!;
	return score;
}

/** A pair is shown only when it scores at least this… */
export const LINK_MIN_SCORE = 1;
/** …and beats every other choice, on both sides, by this much and by this factor. */
export const LINK_MARGIN = 1, LINK_RATIO = 2;

/**
 * 추천 연결: open, unlinked 마일스톤 (not 성과 지표) ↔ unlinked top-level `## 할 일` rows, by title.
 * Conservative: a pair counts only if each is the other's clear first choice (score ≥ 1 and ahead
 * of the runner-up on both sides by ≥ 1 point and 2×). Nothing is written here.
 */
export function recommendLinks(text: string): { line: number; milestone: string; row: RowRef; title: string; score: number }[] {
	const items = readMilestones(text).items, rows = hubTopRows(text);
	const linked = new Set(rows.map(r => r.ms).filter(Boolean));
	const ms = items.filter(m => milestoneKind(m) === "milestone" && !m.done && !(m.ms && linked.has(m.ms)));
	const groups = rows.filter(r => !r.ms && !r.ref && !/^[-*+]\s+\[[xX-]\]/.test(r.line));
	const score = groups.map(g => ms.map(m => linkScore(g.title, m.text)));
	const clear = (xs: number[], i: number) => {
		const best = xs[i], second = Math.max(0, ...xs.filter((_, k) => k !== i));
		return best >= LINK_MIN_SCORE && best - second >= LINK_MARGIN && best >= LINK_RATIO * second;
	};
	const out: { line: number; milestone: string; row: RowRef; title: string; score: number }[] = [];
	groups.forEach((g, gi) => {
		const row = score[gi];
		const mi = row.indexOf(Math.max(0, ...row));
		if (mi < 0 || !clear(row, mi)) return;
		const col = score.map(r => r[mi]);
		if (!clear(col, gi)) return;
		out.push({ line: ms[mi].line, milestone: ms[mi].text, row: { key: g.key, line: g.line }, title: g.title, score: row[mi] });
	});
	return out;
}
