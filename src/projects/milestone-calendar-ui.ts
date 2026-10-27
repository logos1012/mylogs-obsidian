import { scheduleSource, type ScheduleItem } from "./schedule-dnd.ts";
import { parseFrontmatterText } from "../pinboard/model.ts";
import { activeRoot, archiveRoot, type ProjectsHost } from "./actions.ts";
import { hubLocation, parseProject } from "./model.ts";
import { milestoneMarkers, markerState, type MilestoneMarker } from "./milestone-calendar.ts";

export interface MilestoneCalendar { markers: MilestoneMarker[]; issues: { path: string; message: string }[] }
export function watchesMilestoneProjects(host: ProjectsHost, path: string): boolean {
	return [activeRoot(host), archiveRoot(host)].some(root => path === root || path.startsWith(root + "/"));
}
export async function loadMilestoneCalendar(host: ProjectsHost): Promise<MilestoneCalendar> {
	const projects = [], issues: MilestoneCalendar["issues"] = [];
	for (const f of host.app.vault.getMarkdownFiles()) {
		const loc = hubLocation(f.path, activeRoot(host), archiveRoot(host));
		if (!loc) continue;
		try {
			const raw = parseFrontmatterText(await host.app.vault.read(f)), p = parseProject(raw.data, raw.body, loc, f.path);
			if (!p) continue;
			if (p.milestoneError) issues.push({ path: p.path, message: p.milestoneError });
			for (const m of p.milestones ?? []) if (m.dueIssue) issues.push({ path: p.path, message: `${m.text}: ${m.dueIssue}` });
			projects.push(p);
		} catch { issues.push({ path: f.path, message: "프로젝트를 읽지 못했어요. 동기화·파일 상태를 확인해 주세요." }); }
	}
	return { markers: milestoneMarkers(projects), issues };
}

/** Color + diamond + label, separate from checkbox lists and their counters/drag handlers. */
export function renderMilestoneMarkers(parent: HTMLElement, markers: MilestoneMarker[], today: string, open: (path: string) => void, showDate = false, host?: ProjectsHost): void {
	if (!markers.length) return;
	const list = parent.createDiv({ cls: "ml-milestone-markers", attr: { role: "list", "aria-label": "프로젝트 마일스톤" } });
	for (const m of markers) {
		const state = markerState(m, today), status = state === "archived" ? "보관" : state === "done" ? "달성" : state === "overdue" ? "기한 지남" : "목표일";
		const row = list.createDiv({ attr: { role: "listitem" } });
		const button = row.createEl("button", { cls: `ml-milestone-marker is-${state}`, attr: { type: "button", "aria-label": `${m.date} 마일스톤 ${m.title}, ${m.projectTitle}, ${status}. 프로젝트 열기`, title: `${m.projectTitle} · ${m.date} · ${status}` } });
		button.createSpan({ cls: "ml-milestone-symbol", text: "◆", attr: { "aria-hidden": "true" } });
		const content = button.createSpan({ cls: "ml-milestone-content" });
		content.createSpan({ cls: "ml-milestone-title", text: `${showDate ? m.date.slice(5).replace("-", "/") + " " : ""}${m.title}` });
		content.createSpan({ cls: "ml-milestone-meta", text: `마일스톤 · ${m.projectTitle}${state !== "planned" ? " · " + status : ""}` });
		if(host && !m.archived && m.source !== undefined) {
   const item: ScheduleItem = {kind:"milestone",projectPath:m.projectPath,projectId:m.projectId,line:m.line,title:m.title,source:m.source,date:m.date};
   // 날짜를 바꾸려면 끌어서 날짜 칸에 놓는다 (휴대폰은 살짝 길게 누른 뒤 끌기).
   scheduleSource(button,host,item);
   button.setAttr("title",`${m.projectTitle} · ${m.date} · ${status} · 끌어서 다른 날짜로 옮겨요`);
  }
  button.addEventListener("click", e => { e.stopPropagation(); open(m.projectPath); });
	}
}
export function renderMilestoneIssues(parent: HTMLElement, issues: MilestoneCalendar["issues"], open: (path: string) => void): void {
	if (!issues.length) return;
	const group = parent.createEl("details", { cls: "ml-milestone-issues" });
	group.createEl("summary", { text: `마일스톤 날짜 확인 필요 ${issues.length}` });
	for (const issue of issues) {
		const b = group.createEl("button", { text: `${issue.path.split("/").pop()} · ${issue.message}`, attr: { type: "button" } });
		b.addEventListener("click", () => open(issue.path));
	}
}
