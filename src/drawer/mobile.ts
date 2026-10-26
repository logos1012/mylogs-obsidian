/**
 * Drawer on a phone (계획 「11. 모바일」): the three columns become tabs 「보류 / 아이디어 /
 * 프로젝트 후보」, the 후보 strip stays on top, and the bottom dock (꺼내기 / 놓아주기) becomes each
 * card's action sheet. Cards and 후보 are the desktop renderers; every sheet entry runs what the
 * matching desktop drop runs (`runDrawerTarget`, `runCandidateTarget`). 수정 / 삭제 stay in the
 * card menu (⋯ or a long press).
 *
 * Reached only through `DrawerView.render()`'s `Platform.isMobile` dispatch.
 */

import { type App, setIcon } from "obsidian";
import { todayIsoLocal } from "../desk/model.ts";
import { actionSheet, enableTouchMenus, menuEventAt, type SheetAction, tabBar } from "../ui/mobile.ts";
import type { Candidate } from "./candidates.ts";
import { type ColumnData, DRAWER_SECTIONS, type DrawerItem, type DrawerSection } from "./model.ts";
import { type CandidateTarget, candidateTargets, type DrawerTarget, drawerItemTargets } from "./mobile-targets.ts";

export interface DrawerMobileHost {
	app: App;
	contentEl: HTMLElement;
	rootEl: HTMLElement;
	/** Desktop `render()` prologue: clear the root and drop zones; today's date. */
	begin(): string;
	exists(): boolean;
	columns(): ColumnData[] | null;
	candidates(): Candidate[];
	defaultSection(c: Candidate): DrawerSection;
	renderHeader(root: HTMLElement, today: string): void;
	renderEmpty(root: HTMLElement): void;
	renderCandidates(root: HTMLElement): void;
	renderColumn(board: HTMLElement, col: ColumnData, today: string): void;
	moveItem(t: DrawerTarget, it: DrawerItem): Promise<unknown>;
	moveCandidate(t: CandidateTarget, c: Candidate): Promise<unknown>;
	register(cb: () => void): void;
}

interface State {
	tab: DrawerSection;
	installed: boolean;
}

const states = new WeakMap<HTMLElement, State>();

export function renderDrawerMobile(h: DrawerMobileHost): void {
	let s = states.get(h.rootEl);
	if (!s) {
		s = { tab: DRAWER_SECTIONS[0], installed: false };
		states.set(h.rootEl, s);
	}
	if (!s.installed) {
		s.installed = true;
		h.rootEl.addClass("dr-m");
		h.register(enableTouchMenus(h.contentEl));
	}
	const st = s;
	const root = h.rootEl;
	const scrollTop = h.contentEl.scrollTop;
	const today = h.begin();
	h.renderHeader(root, today);
	const cols = h.columns();
	if (!h.exists() || !cols) {
		h.renderEmpty(root);
		return;
	}
	h.renderCandidates(root);
	wireCandidates(h, root);

	tabBar(
		root,
		cols.map((c) => ({ id: c.section, label: c.section, count: c.active.length })),
		s.tab,
		(t) => {
			st.tab = t;
			renderDrawerMobile(h);
		},
	);
	const col = cols.find((c) => c.section === s.tab) ?? cols[0];
	const board = root.createDiv({ cls: "dr-board dr-m-board" });
	h.renderColumn(board, col, today);
	wireCards(h, board, col);
	root.createDiv({ cls: "dr-foot", text: "카드의 「보내기」: 다른 섹션 · 꺼내기(오늘 / 이달 / Wall / 프로젝트) · 놓아주기. 길게 누르거나 ⋯: 수정, 삭제. 후보를 누르면 넣을 섹션을 골라요." });
	h.contentEl.scrollTop = scrollTop;
}

/** Each active card gets a visible 「보내기」 button → the dock as a sheet. */
function wireCards(h: DrawerMobileHost, board: HTMLElement, col: ColumnData): void {
	const cards = Array.from(board.querySelectorAll<HTMLElement>(".dr-col-list > .dr-card"));
	if (cards.length !== col.active.length) return;
	cards.forEach((card, i) => {
		const it = col.active[i];
		const head = card.querySelector<HTMLElement>(".dr-card-head");
		if (!head) return;
		const b = createEl("button", { cls: "dr-m-send", attr: { type: "button", "aria-label": "보내기" } });
		setIcon(b.createSpan({ cls: "dr-m-send-icon" }), "send");
		b.createSpan({ text: "보내기" });
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			void itemSheet(h, card, it, e);
		});
		head.insertBefore(b, head.querySelector(".dr-more"));
	});
}

async function itemSheet(h: DrawerMobileHost, card: HTMLElement, it: DrawerItem, e: MouseEvent): Promise<void> {
	const ym = todayIsoLocal().slice(0, 7);
	const actions: SheetAction[] = drawerItemTargets({ section: it.section, active: true }, ym).map((t) => ({ label: t.label, sub: t.sub, icon: t.icon, run: () => h.moveItem(t, it) }));
	actions.push({ label: "메뉴…", sub: "수정 · 삭제 · 파일에서 보기", icon: "more-horizontal", run: () => card.dispatchEvent(menuEventAt(e.clientX, e.clientY)) });
	await actionSheet(h.app, it.text, actions);
}

/** Tapping a 후보 (outside its 넣기 / 놓아주기 buttons) asks which section it goes into. */
function wireCandidates(h: DrawerMobileHost, root: HTMLElement): void {
	const list = h.candidates();
	const lis = Array.from(root.querySelectorAll<HTMLElement>(".dr-cand-list > li"));
	if (lis.length !== list.length) return;
	lis.forEach((li, i) => {
		const c = list[i];
		li.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("button, a")) return;
			const actions: SheetAction[] = candidateTargets(h.defaultSection(c)).map((t) => ({ label: t.label, sub: t.sub, icon: t.icon, run: () => h.moveCandidate(t, c) }));
			void actionSheet(h.app, c.text, actions);
		});
	});
}
