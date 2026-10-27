/**
 * Desk Calendar on a phone (계획 「11. 모바일」): the month grid becomes one day per screen with
 * ◀ ▶ buttons, plus tabs 「하루 / 이번 주 할 일 / 이달 중」. Cells and items are the desktop ones
 * (`renderDayCell`, `renderAllocCell`, `renderBands`); drag and drop is replaced by a tap → where
 * to (`deskMoveTargets` → the same plan the drop runs). The item menu (못 한 일 · 수정 · 삭제) opens
 * from ⋯ or a long press.
 *
 * Reached only through `DeskCalendarView.render()`'s `Platform.isMobile` dispatch.
 */

import type { App } from "obsidian";
import { addDays } from "../parser.ts";
import { tip } from "../ui/tip.ts";
import { actionSheet, enableTouchMenus, menuEventAt, pickTarget, type SheetAction, tabBar } from "../ui/mobile.ts";
import { type DeskItem, type MonthData, weekdayMon0 } from "./model.ts";
import { type DaySlot, dayInMonth, dayLabel, defaultDay, type DeskDragKind, type DeskTarget, deskMoveTargets, type WeekSlot } from "./mobile-targets.ts";

export type DeskMobileTab = "day" | "week" | "month";

export interface DeskMobileHost {
	app: App;
	contentEl: HTMLElement;
	rootEl: HTMLElement;
	month: string;
	/** Desktop `render()` prologue: clear the root and drop zones, build and keep the context. */
	begin(): { cur: MonthData | null; today: string };
	goTo(month: string): Promise<void>;
	renderHeader(root: HTMLElement): void;
	renderEmpty(root: HTMLElement): void;
	renderBands(root: HTMLElement): void;
	renderDayCell(row: HTMLElement, iso: string): void;
	renderAllocCell(row: HTMLElement, monday: string): void;
	/** Items of a date / a week's box in the order the cells draw them. */
	dayItems(iso: string): DeskItem[];
	allocItems(monday: string): DeskItem[];
	weekSlots(): WeekSlot[];
	daySlots(): DaySlot[];
	isOpenTask(it: DeskItem): boolean;
	/** Run a target with the call its desktop drop zone makes (`runDeskTarget`). */
	move(t: DeskTarget, it: DeskItem): Promise<unknown>;
	register(cb: () => void): void;
	renderMilestones(parent: HTMLElement, from: string, to: string): void;
}

interface State {
	tab: DeskMobileTab;
	day: string;
	installed: boolean;
}

const states = new WeakMap<HTMLElement, State>();

const TABS: { id: DeskMobileTab; label: string }[] = [
	{ id: "day", label: "하루" },
	{ id: "week", label: "이번 주 할 일" },
	{ id: "month", label: "이달 중" },
];

/** Inline targets in the tap sheet up to this many; more go behind 「이동…」. */
const INLINE_TARGETS = 7;

export function renderDeskMobile(h: DeskMobileHost): void {
	const { cur, today } = h.begin();
	let s = states.get(h.rootEl);
	if (!s) {
		s = { tab: "day", day: defaultDay(h.month, today), installed: false };
		states.set(h.rootEl, s);
	}
	if (!s.installed) {
		s.installed = true;
		h.rootEl.addClass("dc-m");
		h.register(enableTouchMenus(h.contentEl));
	}
	s.day = dayInMonth(h.month, s.day);
	const st = s;
	const root = h.rootEl;
	const scrollTop = h.contentEl.scrollTop;
	h.renderHeader(root);
	if (!cur) {
		h.renderEmpty(root);
		return;
	}
	tip(
		tabBar(root, TABS, s.tab, (t) => {
			st.tab = t;
			renderDeskMobile(h);
		}),
		"항목을 누르면 보낼 곳을 골라요 · 길게 누르면 자세한 내용과 못 한 일 처리·수정·삭제",
	);

	if (s.tab === "month") {
		h.renderBands(root);
		wire(h, root.querySelector<HTMLElement>(".dc-during ul"), cur.during, "during");
	} else {
		dayNav(h, root, s, today);
		const row = root.createDiv({ cls: `dc-m-cell dc-m-${s.tab}` });
		if (s.tab === "day") {
			h.renderDayCell(row, s.day);
			wire(h, row.querySelector<HTMLElement>(".dc-items"), h.dayItems(s.day), "day");
		} else {
			const monday = addDays(s.day, -weekdayMon0(s.day));
			h.renderMilestones(row, monday, addDays(monday, 6));
			h.renderAllocCell(row, monday);
			wire(h, row.querySelector<HTMLElement>(".dc-items"), h.allocItems(monday), "alloc");
		}
	}
	h.contentEl.scrollTop = scrollTop;
}

/** ◀ day ▶ (or week in the week tab) + 오늘; crossing a month boundary loads that month. */
function dayNav(h: DeskMobileHost, root: HTMLElement, s: State, today: string): void {
	const nav = root.createDiv({ cls: "dc-m-nav" });
	const step = s.tab === "week" ? 7 : 1;
	const go = (iso: string) => {
		s.day = iso;
		const m = iso.slice(0, 7);
		if (m !== h.month) void h.goTo(m);
		else renderDeskMobile(h);
	};
	const btn = (text: string, aria: string, fn: () => void) => {
		const b = nav.createEl("button", { cls: "dc-btn", text, attr: { type: "button", "aria-label": aria } });
		b.addEventListener("click", fn);
		return b;
	};
	btn("◀", step === 7 ? "이전 주" : "이전 날", () => go(addDays(s.day, -step)));
	const label = nav.createDiv({ cls: "dc-m-nav-label" });
	if (s.tab === "week") {
		const monday = addDays(s.day, -weekdayMon0(s.day));
		label.setText(`${dayLabel(monday)} 주`);
	} else label.setText(dayLabel(s.day));
	if (s.day === today) label.addClass("is-today");
	btn("▶", step === 7 ? "다음 주" : "다음 날", () => go(addDays(s.day, step)));
	const t = btn("오늘", "오늘로", () => go(today));
	t.toggleClass("is-active", s.day === today);
}

/** Tap an item → where it can go (the desktop drop zones that accept it) + the item menu. */
function wire(h: DeskMobileHost, ul: HTMLElement | null, items: DeskItem[], kind: DeskDragKind): void {
	if (!ul) return;
	const lis = Array.from(ul.children) as HTMLElement[];
	if (lis.length !== items.length) return; // something else drew here: leave the desktop behavior
	lis.forEach((li, i) => {
		const it = items[i];
		if (it.item.kind === null) return; // raw line, no menu
		li.addClass("dc-m-tappable");
		li.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("button, a, .dc-sym.is-clickable, .dc-gchip")) return;
			void itemSheet(h, li, it, kind, e);
		});
	});
}

async function itemSheet(h: DeskMobileHost, li: HTMLElement, it: DeskItem, kind: DeskDragKind, e: MouseEvent): Promise<void> {
	const targets = h.isOpenTask(it)
		? deskMoveTargets(
				{ kind, open: true, assignWeek: it.item.assignWeek, assign: it.assign, monday: it.monday ?? null, date: it.date ?? null },
				h.weekSlots(),
				h.daySlots(),
			)
		: [];
	const asAction = (t: DeskTarget): SheetAction => ({ label: t.label, sub: t.sub, icon: t.icon, run: () => h.move(t, it) });
	const actions: SheetAction[] = [];
	if (targets.length <= INLINE_TARGETS) actions.push(...targets.map(asAction));
	else {
		// 이번 주 할 일로 (배정 취소) stays one tap away; the many days go behind 이동….
		const days: DeskTarget[] = targets.filter((t) => t.op === "moveDay" || t.op === "assignDay");
		actions.push(...targets.filter((t) => !days.includes(t)).map(asAction));
		actions.push({
			label: "이동…",
			sub: `날짜 ${days.length}곳`,
			icon: "move",
			run: async () => {
				const t = await pickTarget(h.app, `「${it.item.text}」 → 어느 날로?`, days);
				if (t) await h.move(t, it);
			},
		});
	}
	actions.push({ label: "메뉴…", sub: kind === "day" ? "완료 · 못 한 일 처리 · 수정 · 삭제" : "수정 · 삭제", icon: "more-horizontal", run: () => li.dispatchEvent(menuEventAt(e.clientX, e.clientY)) });
	await actionSheet(h.app, it.item.text, actions);
}
