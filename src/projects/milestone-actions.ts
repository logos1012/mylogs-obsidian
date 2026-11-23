import { withProjectRollup } from "../pinboard/project-rollup.ts";
import { type ProjectsHost, registryPath, loadTemplates } from "./actions.ts";
import { readProject, vaultIO, exclusive } from "../pinboard/create-actions.ts";
import { commitBatch } from "../pinboard/batch.ts";
import { type Project, monthlyLogPath, logIndexPath } from "./model.ts";
import { changeMilestones, readMilestones, milestoneSummary, milestoneKind, formatMetricValue, type Milestone, type MilestoneChange, type MilestoneKind } from "./milestones.ts";
import { applyLinkChange, type LinkChange } from "./milestone-links.ts";
import { applyHubChange, appendLogEntry, formatLogEntry, newMonthlyLog, updateLogIndex, updateProjectAgents, upsertActiveRow, logRegistryChange, setFmValue } from "./ops.ts";

/** Save the hub and its four operational records together; never touch goal metrics. */
export async function saveMilestone(host: ProjectsHost, displayed: Project, expected: string, change: MilestoneChange, today: string): Promise<void> {
	return exclusive(host, async () => {
		const io = vaultIO(host.app), { p, text } = await readProject(host, displayed.path);
		if (p.id !== displayed.id || p.archived) throw new Error("프로젝트가 바뀌었거나 보관됐어요. 다시 열어 주세요.");
		// The day a current value was checked is today unless the caller says otherwise.
		if (change.kind === "setMetric" && change.current !== undefined && !change.asOf) change = { ...change, asOf: today };
		const edited = changeMilestones(text, expected, change);
		if (edited === text) return;
		const before = readMilestones(text).items, old = before.find(i => change.kind !== "add" && i.line === change.line);
		const after = readMilestones(edited).items, now = change.kind === "setMetric" ? after.find(i => i.line === old?.line) : undefined;
		const kindName = (k: MilestoneKind) => (k === "metric" ? "성과 지표" : "마일스톤");
		const verb = change.kind === "add" ? "추가" : change.kind === "edit" ? "수정" : change.kind === "remove" ? "삭제" : change.kind === "check" ? (change.done ? "달성 확인" : "달성 취소")
			: change.kind === "setKind" ? "종류 변경" : change.kind === "move" ? "순서 변경" : change.current !== undefined ? "지표 값 수정" : "지표 설정";
		const dateChange = (change.kind === "add" || change.kind === "edit") && change.due !== undefined ? ` · 목표일 ${old?.due || (old?.dueIssue ? "형식 오류" : "미정")} → ${change.due || "미정"}` : "";
		const value = (m: Milestone | undefined, n: number | undefined) => (n === undefined ? "없음" : formatMetricValue(n, m?.unit));
		const description = (change.kind === "add" ? change.text.trim()
			: change.kind === "edit" ? `${old?.text} → ${change.text.trim()}`
			: change.kind === "setKind" ? `${old?.text} · ${kindName(milestoneKind(old ?? {}))} → ${kindName(change.to)}`
			: change.kind === "move" ? `${old?.text} · ${before.indexOf(old!) + 1}번째 → ${after.findIndex(i => i.text === old?.text) + 1}번째`
			: change.kind === "setMetric" ? `${old?.text} · ${[
				change.current !== undefined ? `현재 ${value(old, old?.current)} → ${value(now, now?.current)} (${change.asOf} 기준)` : "",
				change.target !== undefined ? `목표 ${value(old, old?.target)} → ${value(now, now?.target)}` : "",
				change.unit !== undefined ? `단위 ${old?.unit || "없음"} → ${now?.unit || "없음"}` : "",
				change.period !== undefined ? `기간 ${old?.period || "없음"} → ${now?.period || "없음"}` : "",
			].filter(Boolean).join(" · ")}`
			: old?.text ?? "") + dateChange;
		const summary = milestoneSummary(after);
		const title = change.kind === "setMetric" ? verb : `마일스톤 ${verb}`, detail = `${title}: ${description}`;
		await commitBatch(io, await withProjectRollup(host, await projectRecordWrites(host, p, text, edited, title, detail, summary.label, today), today));
	});
}

/**
 * 마일스톤 ↔ 할 일 / 성과 지표 links: the hub's line edits (ids given in the same save) and the
 * usual five records, one batch. A section changed since it was shown cancels everything.
 */
export async function saveMilestoneLink(host: ProjectsHost, displayed: Project, expected: string, change: LinkChange, today: string): Promise<void> {
	return exclusive(host, async () => {
		const io = vaultIO(host.app), { p, text } = await readProject(host, displayed.path);
		if (p.id !== displayed.id || p.archived) throw new Error("프로젝트가 바뀌었거나 보관됐어요. 다시 열어 주세요.");
		if (change.kind === "addGroup" && change.projectId !== p.id) throw new Error("프로젝트가 바뀌었어요. 다시 열어 주세요.");
		const { text: edited, detail } = applyLinkChange(text, expected, change);
		if (edited === text) return;
		const summary = milestoneSummary(readMilestones(edited).items);
		const title = "마일스톤 연결";
		await commitBatch(io, await withProjectRollup(host, await projectRecordWrites(host, p, text, edited, title, `${title}: ${detail}`, summary.label, today), today));
	});
}

/** Shared audit writes, included in the same batch as calendar task edits. */
export async function projectRecordWrites(host: ProjectsHost, p: Project, text: string, edited: string, title: string, detail: string, result: string, today: string): Promise<import("../pinboard/batch.ts").Write[]> {
	const io = vaultIO(host.app);
	const after = applyHubChange(edited, { today, decision: `${detail} (사용자 확인)` });
	const ym = today.slice(0, 7), mp = monthlyLogPath(p.folder, p.name, ym), lp = logIndexPath(p.folder, p.name), ap = p.folder + "/AGENTS.md", rp = registryPath(host);
	const required = async (path: string) => { const t = await io.read(path); if (t === null) throw new Error(`필수 기록 파일이 없어요: ${path}`); return t; };
	const m = await io.read(mp), l = await required(lp), a = await required(ap), r = await required(rp);
	const entry = formatLogEntry({ date: today, title, context: `「${p.title}」 ${title}`, done: detail, result, decision: "사용자 확인. 실제 목표 결과값·프로젝트 상태 보존; 자동 진척은 마일스톤에서 집계", open: "", next: p.action || "미확인", evidence: "사용자 입력 (프로젝트 화면)" });
	const rr = upsertActiveRow(r, { id: p.id, updated: today });
	if (!rr.ok) throw new Error(rr.reason);
	const templates = m === null ? await loadTemplates(host) : null;
	return [
		{ path: p.path, before: text, after },
		{ path: mp, before: m, after: m === null ? newMonthlyLog(templates!.monthlyLog, p.name, ym, entry) : appendLogEntry(m, entry) },
		{ path: lp, before: l, after: updateLogIndex(l, { name: p.name, ym, today, recent: `${detail} · ${result}` }) },
		{ path: ap, before: a, after: setFmValue(updateProjectAgents(a, { name: p.name, ym, today }), "updated", today) },
		{ path: rp, before: r, after: logRegistryChange(rr.text, today, `${p.id} ${detail} · ${result} (플러그인)`) },
	];
}
