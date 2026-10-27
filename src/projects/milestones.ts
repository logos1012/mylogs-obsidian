/** Milestones live only in the hub's level-two section; never count next actions. */
export interface Milestone { line: number; text: string; done: boolean; due?: string; dueIssue?: string }
export interface Milestones { source: string; items: Milestone[]; start: number; end: number }
export type MilestoneChange = { kind: "add"; text: string; due?: string } | { kind: "edit"; line: number; text: string; due?: string } | { kind: "check"; line: number; done: boolean } | { kind: "remove"; line: number };

export function validMilestoneDate(date: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01" || date > "2999-12-31") return false;
	const d = new Date(`${date}T12:00:00Z`);
	return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date;
}
const duePattern = () => /\(due::\s*([^)]*)\)/g;
function milestoneContent(raw: string): Pick<Milestone, "text" | "due" | "dueIssue"> {
	const fields = [...raw.matchAll(duePattern())];
	const text = raw.replace(duePattern(), "").trim();
	if (!fields.length) return { text };
	const due = fields[0][1].trim();
	if (fields.length !== 1 || !validMilestoneDate(due)) return { text, dueIssue: "목표일 형식을 확인해 주세요. YYYY-MM-DD 날짜 하나만 쓸 수 있어요." };
	return { text, due };
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

export function milestoneSummary(items: Milestone[]): { done: number; total: number; label: string } {
	const done = items.filter(i => i.done).length, total = items.length;
	return { done, total, label: total ? `${done}/${total} 달성` : "미설정" };
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
	if (change.kind === "remove") rows.splice(item.line, 1);
	else if (change.kind === "check") rows[item.line] = old.replace(/^- \[[ xX]\]/, `- [${change.done ? "x" : " "}]`);
	else {
		// An older caller editing only the title must preserve even malformed date metadata.
		const fields = change.due === undefined ? [...old.matchAll(duePattern())].map(m => m[0]).join(" ") : change.due ? `(due:: ${change.due})` : "";
		rows[item.line] = `- [${item.done ? "x" : " "}] ${change.text.trim()}${fields ? " " + fields : ""}${ending}`;
	}
	return text.slice(0, current.start) + rows.join("") + text.slice(current.end);
}
