import { type ProjectsHost, registryPath, loadTemplates } from "./actions.ts";
import { readProject, vaultIO, exclusive } from "../pinboard/create-actions.ts";
import { commitBatch } from "../pinboard/batch.ts";
import { type Project, monthlyLogPath, logIndexPath } from "./model.ts";
import { changeMilestones, readMilestones, milestoneSummary, type MilestoneChange } from "./milestones.ts";
import { applyHubChange, appendLogEntry, formatLogEntry, newMonthlyLog, updateLogIndex, updateProjectAgents, upsertActiveRow, logRegistryChange, setFmValue } from "./ops.ts";

/** Save the hub and its four operational records together; never touch goal metrics. */
export async function saveMilestone(host: ProjectsHost, displayed: Project, expected: string, change: MilestoneChange, today: string): Promise<void> {
	return exclusive(host, async () => {
		const io = vaultIO(host.app), { p, text } = await readProject(host, displayed.path);
		if (p.id !== displayed.id || p.archived) throw new Error("프로젝트가 바뀌었거나 보관됐어요. 다시 열어 주세요.");
		const edited = changeMilestones(text, expected, change);
		if (edited === text) return;
		const old = readMilestones(text).items.find(i => change.kind !== "add" && i.line === change.line);
		const verb = change.kind === "add" ? "추가" : change.kind === "edit" ? "수정" : change.kind === "remove" ? "삭제" : change.done ? "달성 확인" : "달성 취소";
		const dateChange = (change.kind === "add" || change.kind === "edit") && change.due !== undefined ? ` · 목표일 ${old?.due || (old?.dueIssue ? "형식 오류" : "미정")} → ${change.due || "미정"}` : "";
		const description = (change.kind === "add" ? change.text.trim() : change.kind === "edit" ? `${old?.text} → ${change.text.trim()}` : old?.text ?? "") + dateChange;
		const summary = milestoneSummary(readMilestones(edited).items);
		const title = `마일스톤 ${verb}`, detail = `${title}: ${description}`;
		const after = applyHubChange(edited, { today, decision: `${detail} (사용자 확인)` });
		const ym = today.slice(0, 7), mp = monthlyLogPath(p.folder, p.name, ym), lp = logIndexPath(p.folder, p.name), ap = p.folder + "/AGENTS.md", rp = registryPath(host);
		const required = async (path: string) => { const t = await io.read(path); if (t === null) throw new Error(`필수 기록 파일이 없어요: ${path}`); return t; };
		const m = await io.read(mp), l = await required(lp), a = await required(ap), r = await required(rp);
		const entry = formatLogEntry({ date: today, title, context: `「${p.title}」 마일스톤 관리`, done: detail, result: summary.label, decision: "사용자 확인. 목표 진척·프로젝트 상태는 변경하지 않음", open: "", next: p.action || "미확인", evidence: "사용자 입력 (프로젝트 화면)" });
		const rr = upsertActiveRow(r, { id: p.id, updated: today });
		if (!rr.ok) throw new Error(rr.reason);
		const templates = m === null ? await loadTemplates(host) : null;
		await commitBatch(io, [
			{ path: p.path, before: text, after },
			{ path: mp, before: m, after: m === null ? newMonthlyLog(templates!.monthlyLog, p.name, ym, entry) : appendLogEntry(m, entry) },
			{ path: lp, before: l, after: updateLogIndex(l, { name: p.name, ym, today, recent: `${detail} · ${summary.label}` }) },
			{ path: ap, before: a, after: setFmValue(updateProjectAgents(a, { name: p.name, ym, today }), "updated", today) },
			{ path: rp, before: r, after: logRegistryChange(rr.text, today, `${p.id} ${detail} · ${summary.label} (플러그인)`) },
		]);
	});
}
