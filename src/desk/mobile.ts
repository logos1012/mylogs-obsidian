/**
 * Desk Calendar on a phone (계획 「11. 모바일」): a compact month grid, then the chosen day, its week's
 * 이번 주 할 일, and 이달의 초점 · 이달 중 (see `renderDeskMobile`). Cells and items are the desktop ones
 * (`renderDayCell`, `renderAllocCell`, `renderBands`); drag and drop is replaced by a tap → where
 * to (`deskMoveTargets` → the same plan the drop runs). The item menu (못 한 일 · 수정 · 삭제) opens
 * from ⋯ or a long press.
 *
 * Reached only through `DeskCalendarView.render()`'s `Platform.isMobile` dispatch.
 */

import type { App } from "obsidian";
import { addDays } from "../parser.ts";
import { tip } from "../ui/tip.ts";
import { actionSheet, enableTouchMenus, menuEventAt, pickTarget, type SheetAction } from "../ui/mobile.ts";
import { type DeskItem, type MonthData, weekdayMon0 } from "./model.ts";
import { type DaySlot, dayInMonth, dayLabel, defaultDay, type DeskDragKind, type DeskTarget, deskMoveTargets, type WeekSlot } from "./mobile-targets.ts";


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
	/** Dates (ISO) that carry a project milestone ◆. */
	milestoneDays(): Set<string>;
}

interface State {
	day: string;
	installed: boolean;
}

const states = new WeakMap<HTMLElement, State>();

/** Inline targets in the tap sheet up to this many; more go behind 「이동…」. */
const INLINE_TARGETS = 7;

/**
 * Phone layout that still reads as a desk calendar: the month grid on top (each day shows dots for
 * its items, ◆ for milestones, today and the chosen day marked), then the chosen day's cell, its
 * week's 이번 주 할 일, and the month's 초점 · 이달 중 folded at the bottom. Tapping an item opens
 * where it can go (the desktop drop zones), as before.
 */
export function renderDeskMobile(h: DeskMobileHost): void {
	const { cur, today } = h.begin();
	let s = states.get(h.rootEl);
	if (!s) {
		s = { day: defaultDay(h.month, today), installed: false };
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
	monthGrid(h, root, st, today);

	const monday = addDays(st.day, -weekdayMon0(st.day));
	const dayBox = root.createDiv({ cls: "dc-m-cell dc-m-day" });
	h.renderDayCell(dayBox, st.day);
	wire(h, dayBox.querySelector<HTMLElement>(".dc-items"), h.dayItems(st.day), "day");

	const weekBox = root.createDiv({ cls: "dc-m-cell dc-m-week" });
	// The chosen day's ◆ are in its cell; the rest of the week shows ◆ on the grid (no second list).
	h.renderAllocCell(weekBox, monday);
	wire(h, weekBox.querySelector<HTMLElement>(".dc-items"), h.allocItems(monday), "alloc");

	const month = root.createEl("details", { cls: "dc-m-month" });
	const sum = month.createEl("summary");
	sum.createSpan({ text: "이달의 초점 · 이달 중" });
	if (cur.during.length) sum.createSpan({ cls: "dc-m-count", text: String(cur.during.length) });
	h.renderBands(month);
	// On a phone the grid already marks every ◆ day and the chosen day lists its own: no month list.
	month.querySelector(".dc-milestone-month")?.remove();
	wire(h, month.querySelector<HTMLElement>(".dc-during ul"), cur.during, "during");
	// Wall Calendar lines waiting to come into this month: keep them in sight.
	if (month.querySelector(".dc-wallin")) month.open = true;
	tip(sum, "항목을 누르면 보낼 곳을 골라요 · 길게 누르면 자세한 내용과 못 한 일 처리·수정·삭제");
	h.contentEl.scrollTop = scrollTop;
}

/** 월~일 grid of the month; tap a day to show it (and its week) below. */
function monthGrid(h: DeskMobileHost, root: HTMLElement, s: State, today: string): void {
	const grid = root.createDiv({ cls: "dc-m-grid", attr: { role: "grid", "aria-label": `${h.month} 달력` } });
	for (const w of ["월", "화", "수", "목", "금", "토", "일"]) grid.createDiv({ cls: "dc-m-wd", text: w });
	const ms = h.milestoneDays();
	const first = `${h.month}-01`;
	let d = addDays(first, -weekdayMon0(first));
	const selMonday = addDays(s.day, -weekdayMon0(s.day));
	while (d.slice(0, 7) <= h.month) {
		const monday = d;
		for (let i = 0; i < 7; i++, d = addDays(d, 1)) {
			const iso = d;
			const inMonth = iso.slice(0, 7) === h.month;
			const c = grid.createEl("button", { cls: "dc-m-day-btn", attr: { type: "button", "aria-label": dayLabel(iso) } });
			if (!inMonth) c.addClass("is-out");
			if (iso === today) c.addClass("is-today");
			if (iso === s.day) c.addClass("is-selected");
			if (monday === selMonday) c.addClass("is-week");
			c.createSpan({ cls: "dc-m-num", text: String(+iso.slice(8, 10)) });
			const dots = c.createSpan({ cls: "dc-m-dots" });
			const items = inMonth ? h.dayItems(iso) : [];
			for (const it of items.slice(0, 4)) dots.createSpan({ cls: `dc-m-dot k-${it.item.kind ?? "note"} s-${it.item.status}` });
			if (items.length > 4) dots.createSpan({ cls: "dc-m-more", text: "+" });
			if (inMonth && ms.has(iso)) c.createSpan({ cls: "dc-m-ms", text: "◆" });
			c.addEventListener("click", () => {
				s.day = iso;
				if (!inMonth) void h.goTo(iso.slice(0, 7));
				else renderDeskMobile(h);
			});
		}
		if (d.slice(0, 7) > h.month) break;
	}
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
