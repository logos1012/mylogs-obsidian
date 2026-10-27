import { MarkdownRenderer, type App, type Component } from "obsidian";
import type { Project } from "./model.ts";
import type { Goal } from "../pinboard/model.ts";
import { type FlywheelElement } from "../flywheel/model.ts";
import { projectGoalLinks, sharedFlywheel, workspaceFiles, workspaceSections } from "./workspace.ts";

export interface WorkspaceHost {
	app: App; component: Component; goals: Goal[]; elements: FlywheelElement[]; paths: string[]; text: string;
	back(): void; raw(): void; edit(): void; status(): void; remove(): void;
	goal(id: string): void; link(): void; unlink(g: Goal): void; repair(g: Goal): void;
	file(path: string): void; wheel(e: FlywheelElement): void;
	milestones(parent: HTMLElement): void;
	schedule?(parent: HTMLElement): void;
}

/** One management screen; existing theme tokens and no dashboard-within-a-dashboard. */
export function renderWorkspace(root: HTMLElement, p: Project, h: WorkspaceHost): void {
	const page = root.createDiv({ cls: "pf-workspace" });
	const button = (el: HTMLElement, text: string, action: () => void, cls = "") => {
		const b = el.createEl("button", { cls: `pf-btn ${cls}`, text, attr: { type: "button" } }); b.addEventListener("click", action); return b;
	};
	const nav = page.createDiv({ cls: "pf-workspace-nav" });
	button(nav, "← 프로젝트 목록", h.back);
	button(nav, "원문 열기", h.raw);
	const head = page.createDiv({ cls: "pf-workspace-head" });
	head.createDiv({ cls: "pf-workspace-meta", text: [p.scope, p.area, p.kind].filter(Boolean).join(" · ") });
	head.createEl("h1", { text: p.title, attr: { tabindex: "-1" } });
	if (p.summary) head.createEl("p", { text: p.summary });
	const actions = head.createDiv({ cls: "pf-workspace-actions" });
	if (p.archived) actions.createSpan({ text: `보관됨 · ${p.completed || "완료일 미정"} · 읽기 전용` });
	else { button(actions, `상태: ${p.status}`, h.status); button(actions, "정보·다음 행동 수정", h.edit); }
	const layout = page.createDiv({ cls: "pf-workspace-layout" });
	const main = layout.createDiv({ cls: "pf-workspace-main" });
	const action = main.createDiv({ cls: "pf-workspace-action" });
	action.createDiv({ cls: "pf-action-k", text: "지금 가장 효과적인 한 가지 행동" });
	action.createDiv({ cls: "pf-action-v", text: p.action || "미확인" });
	if (p.actionDraft) action.createSpan({ text: "AI 초안", cls: "pf-draft" });
	h.milestones(main);
	h.schedule?.(main);
	for (const [n, s] of workspaceSections(h.text).entries()) {
		const section = main.createEl("details", { cls: "pf-workspace-section" }); section.open = n < 2;
		section.createEl("summary", { text: s.title });
		const body = section.createDiv({ cls: "pf-workspace-markdown" });
		if (!s.text) body.setText("아직 적지 않았어요.");
		else void MarkdownRenderer.render(h.app, s.text, body, p.path, h.component).then(() => {
			// Read-only projection: only the milestone controls write task state.
			body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(c => { c.disabled = true; });
		}).catch(() => { body.setText(s.text); });
	}
	const side = layout.createDiv({ cls: "pf-workspace-side" });
	const goals = side.createDiv({ cls: "pf-workspace-group" }); goals.createEl("h2", { text: "연결 목표" });
	const links = projectGoalLinks(p, h.goals);
	if (!links.length) goals.createEl("p", { text: "연결된 목표가 없어요.", cls: "pf-workspace-muted" });
	for (const link of links) {
		const row = goals.createDiv({ cls: "pf-workspace-goal" });
		if (!link.goal) { row.createDiv({ text: `${link.id} · 목표를 찾을 수 없음` }); continue; }
		const g = link.goal;
		button(row, g.title, () => h.goal(g.id), "pf-workspace-link");
		row.createDiv({ cls: "pf-workspace-muted", text: `${g.id}${link.oneSided ? " · 한쪽만 연결" : ""}` });
		if (!p.archived) {
			const controls = row.createDiv({ cls: "pf-workspace-actions" });
			if (link.oneSided) button(controls, "양쪽 연결 맞추기", () => h.repair(g));
			button(controls, "연결 해제", () => h.unlink(g));
		}
	}
	if (!p.archived) button(goals, "+ 목표 연결", h.link);
	goals.createEl("p", { cls: "pf-workspace-muted", text: "마일스톤은 실행 진척, 목표는 결과입니다. 자동 합산하지 않아요." });
	const wheels = sharedFlywheel(p, h.goals, h.elements);
	if (wheels.length) {
		const group = side.createDiv({ cls: "pf-workspace-group" }); group.createEl("h2", { text: "같은 목표의 Flywheel" });
		for (const e of wheels) button(group, `${e.id} ${e.name}`, () => h.wheel(e), "pf-workspace-link");
		group.createEl("p", { cls: "pf-workspace-muted", text: "목표를 통해 함께 보이는 요소예요. 프로젝트에 직접 연결된 것은 아니에요." });
	}
	const files = side.createDiv({ cls: "pf-workspace-group" }); files.createEl("h2", { text: "작업 자료" });
	for (const relative of ["01 초안", "02 산출물", "99 작업실"]) {
		const items = workspaceFiles(h.paths, p.folder, relative);
		const group = files.createEl("details", { cls: "pf-workspace-files" });
		group.createEl("summary", { text: `${relative} · ${items.length}` });
		if (!items.length) group.createDiv({ cls: "pf-workspace-muted", text: "아직 파일이 없어요. 빈 파일은 만들지 않아요." });
		for (const f of items) button(group, f.label, () => h.file(f.path), "pf-workspace-link");
	}
	const logs = h.paths.filter(path => path.startsWith(`${p.folder}/99 작업실/로그/`) && path.endsWith(".md")).sort().reverse();
	if (logs[0]) button(files, "최근 작업 로그", () => h.file(logs[0]));
	button(files, "프로젝트 운영 지침", () => h.file(`${p.folder}/AGENTS.md`));
	if (!p.archived) {
		const more = side.createEl("details", { cls: "pf-workspace-section" }); more.createEl("summary", { text: "프로젝트 관리" });
		button(more, "삭제 또는 종료…", h.remove);
	}
}
