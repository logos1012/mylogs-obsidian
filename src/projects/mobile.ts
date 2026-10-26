/**
 * Project Folders on a phone (계획 「11. 모바일」): the kanban becomes status tabs with one column
 * of cards; the list view is the same cards full width; the timeline scrolls sideways (CSS).
 * Cards are the desktop renderer; status change is a picker (`projectStatusTargets` → `moveTo`,
 * the call the kanban drop makes), the card menu opens from ⋯ or a long press.
 *
 * Reached only through `ProjectFoldersView.render()`'s `Platform.isMobile` dispatch.
 */

import type { App } from "obsidian";
import { enableTouchMenus, menuEventAt, moreButton, pickTarget, tabBar } from "../ui/mobile.ts";
import type { AreaGroup, KanbanColumn, Project, ProjectStatus } from "./model.ts";
import { type ProjectTarget, projectStatusTargets } from "./mobile-targets.ts";

export interface ProjectsMobileHost {
	app: App;
	contentEl: HTMLElement;
	rootEl: HTMLElement;
	mode: "kanban" | "list" | "timeline";
	/** false while nothing is loaded yet. */
	loaded(): boolean;
	projectCount(): number;
	kanban(): KanbanColumn[];
	groups(): AreaGroup[];
	renderTop(root: HTMLElement): void;
	renderEmpty(root: HTMLElement): void;
	renderList(root: HTMLElement): void;
	renderTimeline(root: HTMLElement): void;
	renderCard(parent: HTMLElement, p: Project, showStatus: boolean): void;
	showTimeline(): void;
	footText(): string;
	move(t: ProjectTarget, p: Project): Promise<unknown>;
	register(cb: () => void): void;
}

interface State {
	tab: ProjectStatus;
	installed: boolean;
}

const states = new WeakMap<HTMLElement, State>();

export function renderProjectsMobile(h: ProjectsMobileHost): void {
	const root = h.rootEl;
	if (!root) return; // render() before onOpen (setState)
	root.empty();
	if (!h.loaded()) return;
	let s = states.get(root);
	if (!s) {
		s = { tab: "진행", installed: false };
		states.set(root, s);
	}
	if (!s.installed) {
		s.installed = true;
		root.addClass("pf-m");
		h.register(enableTouchMenus(h.contentEl));
	}
	const st = s;
	h.renderTop(root);
	if (h.mode === "timeline") h.renderTimeline(root);
	else if (h.mode === "list") {
		h.renderList(root);
		const cards = Array.from(root.querySelectorAll<HTMLElement>(".pf-grid > .pf-card"));
		const projects = h.groups().flatMap((g) => g.projects);
		if (cards.length === projects.length) cards.forEach((c, i) => wireCard(h, c, projects[i]));
	} else {
		if (!h.projectCount()) h.renderEmpty(root);
		const cols = h.kanban();
		tabBar(
			root,
			cols.map((c) => ({ id: c.status, label: c.status, count: c.total })),
			s.tab,
			(t) => {
				st.tab = t;
				renderProjectsMobile(h);
			},
		);
		const col = cols.find((c) => c.status === s.tab) ?? cols[0];
		const list = root.createDiv({ cls: `pf-col pf-m-col st-${col.status}` }).createDiv({ cls: "pf-col-list" });
		for (const p of col.cards) {
			h.renderCard(list, p, false);
			const card = list.lastElementChild as HTMLElement | null;
			if (card) wireCard(h, card, p);
		}
		if (!col.cards.length) list.createDiv({ cls: "pf-col-empty", text: col.status === "완료" ? "완료한 프로젝트가 없어요" : "비어 있음" });
		if (col.status === "완료" && col.total) {
			const more = list.createEl("button", { cls: "pf-more", text: col.total > col.cards.length ? `완료 전체 보기 (${col.total})` : "완료 전체 보기", attr: { type: "button" } });
			more.addEventListener("click", () => h.showTimeline());
		}
	}
	root.createDiv({ cls: "pf-foot", text: h.footText() });
}

/** 「상태」 (picker → the kanban drop's call) and ⋯ (the card menu) on a card. */
function wireCard(h: ProjectsMobileHost, card: HTMLElement, p: Project): void {
	const row = card.createDiv({ cls: "pf-m-actions" });
	const targets = projectStatusTargets(p);
	if (targets.length) {
		const b = row.createEl("button", { cls: "pf-m-status", text: "상태 바꾸기", attr: { type: "button" } });
		b.addEventListener("click", async (e) => {
			e.stopPropagation();
			const t = await pickTarget(h.app, `「${p.title}」 상태`, targets);
			if (t) await h.move(t, p);
		});
	}
	moreButton(row, (e) => card.dispatchEvent(menuEventAt(e.clientX, e.clientY)), "프로젝트 메뉴");
}
