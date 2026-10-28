import { MarkdownRenderer, Menu, setIcon, type App, type Component } from "obsidian";
import { tip } from "../ui/tip.ts";
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
	schedule?(parent: HTMLElement, calendar?: HTMLElement): void;
}

/** Placeholder bodies the templates leave behind: nothing to show yet. */
function isEmptySection(text: string): boolean {
	const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*[-*+]\s*(\[.\]\s*)?/, "").trim()).filter((l) => l && !/^<!--.*-->$/.test(l));
	return !lines.length || lines.every((l) => /^(없음|미확인|미정|-)$/.test(l) || /^\*\*[^*]+:\*\*\s*$/.test(l));
}

/**
 * One management screen. The page shows what moves the project: the next action, milestones,
 * tasks, the goals it serves, and its files. Raw file, AI notes and destructive actions sit in ⋯;
 * empty template sections are not shown.
 */
export function renderWorkspace(root: HTMLElement, p: Project, h: WorkspaceHost): void {
	const page = root.createDiv({ cls: "pf-workspace" });
	const button = (el: HTMLElement, text: string, action: () => void, cls = "") => {
		const b = el.createEl("button", { cls: `pf-btn ${cls}`, text, attr: { type: "button" } }); b.addEventListener("click", action); return b;
	};
	const iconButton = (el: HTMLElement, icon: string, label: string, action: (e: MouseEvent) => void) => {
		const b = el.createEl("button", { cls: "clickable-icon pf-icon-btn", attr: { type: "button", "aria-label": label } });
		setIcon(b, icon);
		b.addEventListener("click", (e) => { e.stopPropagation(); action(e); });
		return b;
	};
	const logs = h.paths.filter(path => path.startsWith(`${p.folder}/99 작업실/로그/`) && path.endsWith(".md")).sort().reverse();

	const nav = page.createDiv({ cls: "pf-workspace-nav" });
	button(nav, "← 프로젝트 목록", h.back);
	iconButton(nav, "more-horizontal", "프로젝트 메뉴", (e) => {
		const m = new Menu();
		if (!p.archived) m.addItem((i) => i.setTitle("정보·다음 행동 수정").setIcon("pencil").onClick(h.edit));
		m.addItem((i) => i.setTitle("원문 열기").setIcon("file-text").onClick(h.raw));
		if (logs[0]) m.addItem((i) => i.setTitle("최근 작업 로그").setIcon("history").onClick(() => h.file(logs[0])));
		if (!p.archived) {
			m.addSeparator();
			m.addItem((i) => i.setTitle("삭제 또는 종료…").setIcon("trash-2").setWarning(true).onClick(h.remove));
		}
		m.showAtMouseEvent(e);
	});

	const head = page.createDiv({ cls: "pf-workspace-head" });
	head.createDiv({ cls: "pf-workspace-meta", text: [p.scope, p.area, p.kind].filter(Boolean).join(" · ") });
	const titleRow = head.createDiv({ cls: "pf-workspace-titlerow" });
	titleRow.createEl("h1", { text: p.title, attr: { tabindex: "-1" } });
	if (p.archived) titleRow.createSpan({ cls: "pf-status-pill is-archived", text: "보관됨" });
	else {
		const pill = titleRow.createEl("button", { cls: `pf-status-pill st-${p.status}`, text: `${p.status} ▾`, attr: { type: "button" } });
		tip(pill, "누르면 상태를 바꿔요");
		pill.addEventListener("click", h.status);
	}
	if (p.summary) head.createEl("p", { text: p.summary });

	const layout = page.createDiv({ cls: "pf-workspace-layout" });
	const main = layout.createDiv({ cls: "pf-workspace-main" });
	const side = layout.createDiv({ cls: "pf-workspace-side" });
	const goals = side.createDiv({ cls: "pf-workspace-group" });
	tip(goals.createEl("h2", { text: "연결 목표" }), "이 프로젝트가 돕는 목표예요. 마일스톤은 실행 진척, 목표는 결과라서 자동으로 합치지 않아요.");
	const links = projectGoalLinks(p, h.goals);
	if (!links.length) goals.createEl("p", { text: "연결된 목표가 없어요.", cls: "pf-workspace-muted" });
	for (const link of links) {
		const row = goals.createDiv({ cls: "pf-workspace-goal" });
		if (!link.goal) { tip(row.createDiv({ cls: "pf-workspace-muted", text: "⚠ 찾을 수 없는 목표" }), link.id); continue; }
		const g = link.goal;
		button(row, g.title, () => h.goal(g.id), "pf-workspace-link");
		if (link.oneSided) tip(row.createSpan({ cls: "pf-warn", text: "⚠" }), "연결이 한쪽에만 기록돼 있어요. ⋯에서 고칠 수 있어요.");
		if (!p.archived) iconButton(row, "more-horizontal", `${g.title} 연결 메뉴`, (e) => {
			const m = new Menu();
			if (link.oneSided) m.addItem((i) => i.setTitle("연결 고치기").setIcon("link").onClick(() => h.repair(g)));
			m.addItem((i) => i.setTitle("연결 해제").setIcon("unlink").onClick(() => h.unlink(g)));
			m.showAtMouseEvent(e);
		});
	}
	if (!p.archived) button(goals, "+ 목표 연결", h.link, "pf-btn-quiet");
	// 할 일·일정 달력 sits here, under 연결 목표 (wide enough; the task list keeps the main column).
	const calendarSlot = side.createDiv({ cls: "pf-workspace-calendar" });
	const action = main.createDiv({ cls: "pf-workspace-action" });
	const ak = action.createDiv({ cls: "pf-action-k", text: "지금 가장 효과적인 한 가지 행동" });
	action.createDiv({ cls: "pf-action-v", text: p.action || "아직 정하지 않았어요" });
	if (p.actionDraft) tip(action.createSpan({ text: "AI 초안", cls: "pf-draft" }), "AI가 제안한 행동이에요. 확인 후 수정해 주세요.");
	if (!p.archived) iconButton(ak, "pencil", "다음 행동 수정", () => h.edit());
	h.milestones(main);
	h.schedule?.(main, calendarSlot);
	// The calendar lines up with 할 일·일정 (its top level with the schedule's), not with the page top.
	const align = () => {
		const sched = main.querySelector<HTMLElement>(".pf-schedule");
		calendarSlot.style.marginTop = "0px";
		if (!sched || getComputedStyle(layout).gridTemplateColumns.split(" ").length < 2) return;
		const gap = sched.getBoundingClientRect().top - calendarSlot.getBoundingClientRect().top;
		if (gap > 0) calendarSlot.style.marginTop = `${Math.round(gap)}px`;
	};
	window.requestAnimationFrame(align);
	const ro = new ResizeObserver(() => {
		if (!calendarSlot.isConnected) return ro.disconnect();
		align();
	});
	ro.observe(main);
	h.component.register(() => ro.disconnect());
	const sections = workspaceSections(h.text).filter((s) => !isEmptySection(s.text));
	if (sections.length) {
		const info = main.createDiv({ cls: "pf-workspace-info" });
		info.createEl("h2", { text: "프로젝트 정보" });
		for (const s of sections) {
			const section = info.createEl("details", { cls: "pf-workspace-section" });
			section.open = s.title === "성공 기준" || s.title === "막힌 점";
			section.createEl("summary", { text: s.title });
			const body = section.createDiv({ cls: "pf-workspace-markdown" });
			void MarkdownRenderer.render(h.app, s.text, body, p.path, h.component).then(() => {
				// Read-only projection: only the milestone controls write task state.
				body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(c => { c.disabled = true; });
			}).catch(() => { body.setText(s.text); });
		}
	}

	const wheels = sharedFlywheel(p, h.goals, h.elements);
	if (wheels.length) {
		const group = side.createDiv({ cls: "pf-workspace-group" });
		tip(group.createEl("h2", { text: "같은 목표의 Flywheel" }), "목표를 통해 함께 보이는 매일의 행동이에요. 프로젝트에 직접 연결된 것은 아니에요.");
		for (const e of wheels) button(group, e.name, () => h.wheel(e), "pf-workspace-link");
	}
	const files = side.createDiv({ cls: "pf-workspace-group" }); files.createEl("h2", { text: "작업 자료" });
	for (const [relative, label] of [["01 초안", "초안"], ["02 산출물", "산출물"], ["99 작업실", "작업실"]] as const) {
		const items = workspaceFiles(h.paths, p.folder, relative).filter((f) => relative !== "99 작업실" || !/^(로그\/|AGENTS\.md$)/.test(f.label));
		const group = files.createEl("details", { cls: "pf-workspace-files" });
		group.createEl("summary", { text: items.length ? `${label} ${items.length}` : label });
		if (!items.length) group.createDiv({ cls: "pf-workspace-muted", text: "비어 있어요" });
		for (const f of items) button(group, f.label, () => h.file(f.path), "pf-workspace-link");
	}
}
