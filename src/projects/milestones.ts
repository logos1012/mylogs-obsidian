/** Milestones live only in the hub's level-two section; never count next actions. */
export type MilestoneKind = "milestone" | "metric";
export interface Milestone {
	line: number; text: string; done: boolean; due?: string; dueIssue?: string;
	/** `(kind:: 성과)` (or the older `결과`): a 성과 지표. Unset = 마일스톤 (see `milestoneKind`). */
	kind?: "metric";
	/** 성과 지표 values: `(current::)` `(target::)` `(unit::)` `(period::)` `(as_of::)`. */
	current?: number; target?: number; unit?: string; period?: string; asOf?: string;
	/** 0.51.0 links, read and kept as written: `(ms::)` `(aim::)` `(start::)`. */
	ms?: string; aim?: string; start?: number;
	/** A value field that could not be read (the line still shows; nothing crashes). */
	fieldIssue?: string;
}
export interface Milestones { source: string; items: Milestone[]; start: number; end: number }
export type MetricChange = { current?: string; asOf?: string; target?: string; unit?: string; period?: string };
export type MilestoneChange =
	| { kind: "add"; text: string; due?: string }
	| { kind: "edit"; line: number; text: string; due?: string }
	| { kind: "check"; line: number; done: boolean }
	| { kind: "remove"; line: number }
	/** Only `(kind:: 성과)` goes in or out; value fields stay. */
	| { kind: "setKind"; line: number; to: MilestoneKind }
	/** The item (and the indented lines right under it) goes before / after another item. */
	| { kind: "move"; line: number; target: number; place: "before" | "after" }
	/** `current` (with `asOf`, the day it was checked) and / or `target` · `unit` · `period` ("" = remove). */
	| ({ kind: "setMetric"; line: number } & MetricChange);

export const milestoneKind = (m: Pick<Milestone, "kind">): MilestoneKind => m.kind ?? "milestone";

export function validMilestoneDate(date: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01" || date > "2999-12-31") return false;
	const d = new Date(`${date}T12:00:00Z`);
	return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
}
const duePattern = () => /\(due::\s*([^)]*)\)/g;
/** Every Dataview inline field `(key:: value)` on a line. */
const fieldPattern = () => /\(\s*([A-Za-z_][\w-]*)\s*::\s*([^)]*?)\s*\)/g;
/** The order the plugin writes fields in (others keep their place). */
const ORDER = ["due", "kind", "ms", "aim", "start", "current", "target", "unit", "period", "as_of"];
const METRIC_KINDS = new Set(["성과", "결과"]);

/** `1,000,000`, `-3`, `2.5` → number; anything else → undefined. */
export function parseMetricNumber(value: string): number | undefined {
	const v = value.trim();
	if (!/^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(v)) return undefined;
	const n = Number(v.replace(/,/g, ""));
	return Number.isFinite(n) ? n : undefined;
}

function milestoneContent(raw: string): Omit<Milestone, "line" | "done"> {
	const out: Omit<Milestone, "line" | "done"> = { text: raw.replace(/\s*\(\s*[A-Za-z_][\w-]*\s*::[^)]*\)/g, "").trim() };
	const issues: string[] = [];
	const first = new Map<string, string>();
	for (const m of raw.matchAll(fieldPattern())) if (!first.has(m[1])) first.set(m[1], m[2].trim());
	const dues = [...raw.matchAll(duePattern())];
	if (dues.length) {
		const due = dues[0][1].trim();
		if (dues.length !== 1 || !validMilestoneDate(due)) out.dueIssue = "목표일 형식을 확인해 주세요. YYYY-MM-DD 날짜 하나만 쓸 수 있어요.";
		else out.due = due;
	}
	if (METRIC_KINDS.has(first.get("kind") ?? "")) out.kind = "metric";
	const num = (key: "current" | "target" | "start", label: string) => {
		const v = first.get(key);
		if (v === undefined) return;
		const n = parseMetricNumber(v);
		if (n === undefined) issues.push(`${label}을 숫자로 적어 주세요 (${v || "빈 값"}).`);
		else out[key] = n;
	};
	num("current", "현재 값"); num("target", "목표 값"); num("start", "시작 값");
	if (first.get("unit")) out.unit = first.get("unit");
	if (first.get("period")) out.period = first.get("period");
	if (first.get("ms")) out.ms = first.get("ms");
	if (first.get("aim")) out.aim = first.get("aim");
	const asOf = first.get("as_of");
	if (asOf !== undefined) { if (validMilestoneDate(asOf)) out.asOf = asOf; else issues.push(`확인한 날을 YYYY-MM-DD로 적어 주세요 (${asOf || "빈 값"}).`); }
	if (issues.length) out.fieldIssue = issues.join(" ");
	return out;
}

function lines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }
function visibleLines(text: string): { raw: string; index: number; offset: number }[] {
	let fence = "", length = 0, offset = 0, comment = false, fm = text.startsWith("---\n") || text.startsWith("---\r\n");
	const out: { raw: string; index: number; offset: number }[] = [];
	for (const [index, raw] of lines(text).entries()) {
		const here = offset; offset += raw.length;
		if (fm) { if (index > 0 && raw.trim() === "---") fm = false; continue; }
		if (!fence && (comment || raw.trimStart().startsWith("<!--"))) { comment = !raw.includes("-->"); continue; }
		const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
		if (f) { if (!fence) { fence = f[1][0]; length = f[1].length; } else if (f[1][0] === fence && f[1].length >= length) fence = ""; continue; }
		if (!fence) out.push({ raw, index, offset: here });
	}
	return out;
}

export function readMilestones(text: string): Milestones {
	const visible = visibleLines(text);
	const heads = visible.filter(l => /^## 마일스톤\s*$/.test(l.raw));
	if (heads.length > 1) throw new Error("마일스톤 섹션이 둘 이상이에요. 허브에서 하나로 정리해 주세요.");
	if (!heads.length) return { source: "", items: [], start: text.length, end: text.length };
	const head = heads[0], end = visible.find(l => l.offset > head.offset && /^#{1,2} /.test(l.raw))?.offset ?? text.length;
	const source = text.slice(head.offset, end);
	const items: Milestone[] = [];
	for (const l of visibleLines(source)) {
		const m = /^- \[([ xX])\][ \t]+(.+?)[ \t]*\r?\n?$/.exec(l.raw);
		if (m && m[2].trim()) {
			const content = milestoneContent(m[2].trim());
			if (content.text) items.push({ line: l.index, done: m[1].toLowerCase() === "x", ...content });
		}
	}
	return { source, items, start: head.offset, end };
}

/** Every top-level item counts (vault rule 「6-1」), 마일스톤 and 성과 지표 alike. */
export function milestoneSummary(items: Milestone[]): { done: number; total: number; label: string } {
	const done = items.filter(i => i.done).length, total = items.length;
	return { done, total, label: total ? `${done}/${total} 달성` : "미설정" };
}

/** The header label split by kind: `마일스톤 1/4 · 성과 지표 0/4` (no 성과 지표: the usual label). */
export function milestoneSplit(items: Milestone[]): { milestones: { done: number; total: number }; metrics: { done: number; total: number }; label: string } {
	const count = (xs: Milestone[]) => ({ done: xs.filter(i => i.done).length, total: xs.length });
	const milestones = count(items.filter(i => milestoneKind(i) === "milestone")), metrics = count(items.filter(i => milestoneKind(i) === "metric"));
	const label = metrics.total ? `마일스톤 ${milestones.done}/${milestones.total} · 성과 지표 ${metrics.done}/${metrics.total}` : milestoneSummary(items).label;
	return { milestones, metrics, label };
}

const plain = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** `1000000` 원 → `100만 원`, `120000000` → `1억 2,000만 원`, `3` 건 → `3건`. */
export function formatMetricValue(n: number, unit = ""): string {
	if (unit.trim() !== "원") return `${plain(n)}${unit.trim()}`;
	const sign = n < 0 ? "-" : "", abs = Math.abs(n);
	const eok = Math.floor(abs / 1e8), man = Math.floor((abs % 1e8) / 1e4), rest = Math.round((abs % 1e4) * 100) / 100;
	const parts = [eok ? `${plain(eok)}억` : "", man ? `${plain(man)}만` : "", rest ? plain(rest) : ""].filter(Boolean);
	if (!parts.length) return "0원";
	return sign + parts.join(" ") + (rest ? "원" : " 원");
}

/** `최근 30일 · 0원 / 100만 원 · 11/23 기준`; no target → asks for one. */
export function metricMeasure(m: Milestone): { text: string; ratio?: number; reached: boolean; missingTarget: boolean } {
	if (m.target === undefined) return { text: "목표 값을 적어 주세요", reached: false, missingTarget: true };
	const cur = m.current === undefined ? "—" : formatMetricValue(m.current, m.unit);
	const parts = [m.period ?? "", `${cur} / ${formatMetricValue(m.target, m.unit)}`, m.asOf ? `${+m.asOf.slice(5, 7)}/${+m.asOf.slice(8, 10)} 기준` : ""].filter(Boolean);
	const ratio = m.current !== undefined && m.target > 0 ? Math.max(0, Math.min(1, m.current / m.target)) : undefined;
	return { text: parts.join(" · "), ratio, reached: m.current !== undefined && m.current >= m.target, missingTarget: false };
}

interface Token { key: string; value: string; raw: string; start: number; end: number }
function tokens(body: string): Token[] {
	return [...body.matchAll(fieldPattern())].map(m => ({ key: m[1], value: m[2].trim(), raw: m[0], start: m.index!, end: m.index! + m[0].length }));
}
/** Remove a field (with the space before it) or set it in place; a new field goes in plugin order. */
function setLineField(body: string, key: string, value: string | null): string {
	const all = tokens(body), own = all.filter(t => t.key === key);
	if (value === null) {
		for (const t of [...own].reverse()) { const before = body.slice(0, t.start).replace(/[ \t]+$/, ""); body = before + body.slice(t.end); }
		return body;
	}
	const piece = `(${key}:: ${value})`;
	if (own.length) return body.slice(0, own[0].start) + piece + body.slice(own[0].end);
	const rank = ORDER.indexOf(key);
	const prev = [...all].reverse().find(t => ORDER.indexOf(t.key) >= 0 && ORDER.indexOf(t.key) < rank);
	if (prev) return `${body.slice(0, prev.end)} ${piece}${body.slice(prev.end)}`;
	const next = all.find(t => ORDER.indexOf(t.key) > rank);
	if (next) return `${body.slice(0, next.start)}${piece} ${body.slice(next.start)}`;
	return `${body.replace(/[ \t]+$/, "")} ${piece}`;
}
function fieldValue(value: string, label: string): string {
	const v = value.trim();
	if (/[()\r\n]/.test(v)) throw new Error(`${label}에는 괄호나 줄바꿈을 쓸 수 없어요.`);
	return v;
}
function numberValue(value: string, label: string): string {
	if (parseMetricNumber(value) === undefined) throw new Error(`${label}을 숫자로 적어 주세요. 예: 1,000,000`);
	return value.trim().replace(/,/g, "");
}

export function changeMilestones(text: string, expected: string, change: MilestoneChange): string {
	const current = readMilestones(text);
	if (current.source !== expected) throw new Error("마일스톤이 다른 곳에서 변경됐어요. 취소한 뒤 최신 목록에서 다시 수정해 주세요.");
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	if (change.kind === "add" || change.kind === "edit") {
		if (!change.text.trim() || /[\r\n]/.test(change.text)) throw new Error("도달할 상태를 한 줄로 적어 주세요.");
		if (change.due !== undefined && change.due !== "" && !validMilestoneDate(change.due)) throw new Error("목표일은 실제 날짜를 YYYY-MM-DD로 골라 주세요 (1900–2999).");
		if (/\(due::/.test(change.text)) throw new Error("목표일은 내용이 아닌 날짜 칸에 입력해 주세요.");
	}
	if (change.kind === "add") {
		const row = `- [ ] ${change.text.trim()}${change.due ? ` (due:: ${change.due})` : ""}${eol}`;
		if (!current.source) {
			const at = visibleLines(text).find(l => /^## 비목표\s*$/.test(l.raw))?.offset ?? text.length;
			const before = text.slice(0, at);
			return before + (before.endsWith(eol + eol) ? "" : before.endsWith(eol) ? eol : eol + eol) + `## 마일스톤${eol}${eol}${row}${eol}` + text.slice(at);
		}
		const body = current.source.replace(/(?:\r?\n)*$/, "") + eol + row + eol;
		return text.slice(0, current.start) + body + text.slice(current.end);
	}
	const item = current.items.find(i => i.line === change.line);
	if (!item) throw new Error("마일스톤을 찾지 못했어요. 목록을 새로 열어 주세요.");
	const rows = lines(current.source), old = rows[item.line], ending = old.endsWith("\r\n") ? "\r\n" : old.endsWith("\n") ? "\n" : "";
	const bare = old.slice(0, old.length - ending.length);
	const head = /^- \[[ xX]\][ \t]+/.exec(bare)![0], body = bare.slice(head.length);
	const rewrite = (next: string) => { rows[item.line] = head + next + ending; };
	if (change.kind === "remove") rows.splice(item.line, 1);
	else if (change.kind === "check") rows[item.line] = old.replace(/^- \[[ xX]\]/, `- [${change.done ? "x" : " "}]`);
	else if (change.kind === "edit") {
		// Every field on the line stays as written; only the date changes when one is given.
		let fields = tokens(body);
		if (change.due !== undefined) {
			// The new date takes the first date's place (or goes first); other dates go.
			const at = fields.findIndex(t => t.key === "due"), due = change.due ? [{ key: "due", value: change.due, raw: `(due:: ${change.due})`, start: 0, end: 0 }] : [];
			const notDue = (xs: Token[]) => xs.filter(t => t.key !== "due");
			fields = at < 0 ? [...due, ...fields] : [...notDue(fields.slice(0, at)), ...due, ...notDue(fields.slice(at + 1))];
		}
		const kept = fields.map(t => t.raw).join(" ");
		rows[item.line] = `- [${item.done ? "x" : " "}] ${change.text.trim()}${kept ? " " + kept : ""}${ending}`;
	} else if (change.kind === "setKind") {
		if (milestoneKind(item) === change.to) return text;
		if (change.to === "metric") rewrite(setLineField(body, "kind", "성과"));
		else {
			// Only the 성과 / 결과 mark goes (with the space before it).
			let next = body;
			for (const t of tokens(body).reverse()) if (t.key === "kind" && METRIC_KINDS.has(t.value)) next = next.slice(0, t.start).replace(/[ \t]+$/, "") + next.slice(t.end);
			rewrite(next);
		}
	} else if (change.kind === "setMetric") {
		if (milestoneKind(item) !== "metric") throw new Error("성과 지표에서만 값을 적을 수 있어요.");
		let next = body;
		if (change.current !== undefined) {
			if (!change.asOf || !validMilestoneDate(change.asOf)) throw new Error("현재 값을 확인한 날을 확인해 주세요.");
			next = setLineField(next, "current", numberValue(change.current, "현재 값"));
			next = setLineField(next, "as_of", change.asOf);
		}
		if (change.target !== undefined) next = setLineField(next, "target", change.target.trim() ? numberValue(change.target, "목표 값") : null);
		if (change.unit !== undefined) { const v = fieldValue(change.unit, "단위"); next = setLineField(next, "unit", v || null); }
		if (change.period !== undefined) { const v = fieldValue(change.period, "기간"); next = setLineField(next, "period", v || null); }
		if (next === body) return text;
		rewrite(next);
	} else {
		const target = current.items.find(i => i.line === change.target);
		if (!target) throw new Error("옮길 자리를 찾지 못했어요. 목록을 새로 열어 주세요.");
		if (target.line === item.line) return text;
		// The item carries the indented lines right under it; comments and blank lines stay put.
		const block = (at: number) => { let j = at + 1; while (j < rows.length && /^[ \t]+\S/.test(rows[j])) j++; return j; };
		const from = item.line, to = block(from);
		if (change.place === "after" && target.line > from && target.line < to) return text;
		const moving = rows.slice(from, to);
		if (!moving[moving.length - 1].endsWith("\n")) moving[moving.length - 1] += eol;
		const at = change.place === "before" ? target.line : block(target.line);
		if (at === from || at === to) return text;
		const rest = [...rows.slice(0, from), ...rows.slice(to)];
		const insert = at > from ? at - moving.length : at;
		if (insert > 0 && !rest[insert - 1].endsWith("\n")) rest[insert - 1] += eol;
		rest.splice(insert, 0, ...moving);
		// A section that ended without a newline (end of file) still does.
		const joined = rest.join("");
		return text.slice(0, current.start) + (current.source.endsWith("\n") ? joined : joined.replace(/\r?\n$/, "")) + text.slice(current.end);
	}
	return text.slice(0, current.start) + rows.join("") + text.slice(current.end);
}
