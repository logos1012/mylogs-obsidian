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
	/** 흐름 = this month's flow week by week (default); 달력 = the month grid + chosen day. */
	mode: "flow" | "grid";
}

const states = new WeakMap<HTMLElement, State>();

/** Inline targets in the tap sheet up to this many; more go behind 「이동…」. */
const INLINE_TARGETS = 7;

/**
 * Phone Desk Calendar. Two views of the same month:
 *
 *   흐름 (default)  이달(초점 · 이달 중 · Wall에서) on top, then one card per week — the week column
 *                   of the desktop: that week's ◆ milestones, events and dated tasks in date order,
 *                   its 이번 주 할 일 and how much is done. Past weeks fold to a summary. An 이달 중
 *                   item is long-pressed and dropped on a week card to assign it (or tapped).
 *   달력            the month grid; tap a day for its cell and its week's 이번 주 할 일.
 *
 * Tapping an item opens where it can go (the desktop drop zones), as before.
 */
export function renderDeskMobile(h: DeskMobileHost): void {
	const { cur, today } = h.begin();
	let s = states.get(h.rootEl);
	if (!s) {
		s = { day: defaultDay(h.month, today), installed: false, mode: "flow" };
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
	const seg = root.createDiv({ cls: "dc-m-seg", attr: { role: "tablist" } });
	for (const [mode, label] of [["flow", "흐름"], ["grid", "달력"]] as const) {
		const b = seg.createEl("button", { cls: `dc-m-seg-btn${st.mode === mode ? " is-active" : ""}`, text: label, attr: { type: "button", role: "tab", "aria-selected": String(st.mode === mode) } });
		b.addEventListener("click", () => {
			if (st.mode === mode) return;
			st.mode = mode;
			renderDeskMobile(h);
		});
	}
	tip(seg, "흐름: 이달과 주차별로 무엇이 이어지는지 · 달력: 날짜별로");

	if (st.mode === "flow") {
		monthBand(h, root, cur);
		for (const w of h.weekSlots()) weekCard(h, root, st, w, today);
	} else {
		monthGrid(h, root, st, today);
		const monday = addDays(st.day, -weekdayMon0(st.day));
		const dayBox = root.createDiv({ cls: "dc-m-cell dc-m-day" });
		h.renderDayCell(dayBox, st.day);
		wire(h, dayBox.querySelector<HTMLElement>(".dc-items"), h.dayItems(st.day), "day");
		const weekBox = root.createDiv({ cls: "dc-m-cell dc-m-week" });
		// The chosen day's ◆ are in its cell; the rest of the week shows ◆ on the grid (no second list).
		h.renderAllocCell(weekBox, monday);
		wire(h, weekBox.querySelector<HTMLElement>(".dc-items"), h.allocItems(monday), "alloc");
		monthBand(h, root, cur);
	}
	h.contentEl.scrollTop = scrollTop;
}

/** 이달: 이달의 초점 · 이달 중 · Wall Calendar에서 — always open. 이달 중 items drag onto week cards. */
function monthBand(h: DeskMobileHost, root: HTMLElement, cur: MonthData): void {
	const month = root.createDiv({ cls: "dc-m-month" });
	tip(month.createDiv({ cls: "dc-m-sec-title", text: "이달" }), "이달 중 항목을 길게 눌러 주차 카드에 놓으면 그 주에 배정돼요. 눌러서 보낼 곳을 골라도 돼요.");
	h.renderBands(month);
	// On a phone ◆ are shown per day / per week: no month list.
	month.querySelector(".dc-milestone-month")?.remove();
	const ul = month.querySelector<HTMLElement>(".dc-during ul");
	wire(h, ul, cur.during, "during");
	if (ul && ul.children.length === cur.during.length) {
		Array.from(ul.children).forEach((li, i) => {
			const it = cur.during[i];
			if (h.isOpenTask(it)) dragToWeek(h, li as HTMLElement, it);
		});
	}
}

/** One week of the month: what happens in it, in date order, then its 이번 주 할 일. */
function weekCard(h: DeskMobileHost, root: HTMLElement, s: State, w: WeekSlot, today: string): void {
	const sunday = addDays(w.monday, 6);
	const past = sunday < today;
	const now = w.monday <= today && today <= sunday;
	const card = root.createEl("details", { cls: `dc-m-wk${now ? " is-now" : ""}${past ? " is-past" : ""}`, attr: { "data-monday": w.monday } });
	card.open = !past;
	const days = Array.from({ length: 7 }, (_, i) => addDays(w.monday, i)).filter((d) => d.slice(0, 7) === h.month);
	const dayItems = days.flatMap((d) => h.dayItems(d).map((it) => ({ d, it })));
	const tasks = dayItems.filter((x) => x.it.item.kind === "task");
	const done = tasks.filter((x) => x.it.item.status === "done").length;
	const alloc = w.hasAlloc ? h.allocItems(w.monday) : [];
	const unassigned = alloc.filter((a) => h.isOpenTask(a) && !a.assign.length).length;

	const head = card.createEl("summary", { cls: "dc-m-wk-head" });
	head.createSpan({ cls: "dc-m-wk-no", text: `W${String(w.no).padStart(2, "0")}` });
	head.createSpan({ cls: "dc-m-wk-range", text: `${+w.monday.slice(5, 7)}/${+w.monday.slice(8, 10)} – ${+sunday.slice(5, 7)}/${+sunday.slice(8, 10)}` });
	if (now) head.createSpan({ cls: "dc-m-wk-now", text: "이번 주" });
	const stat = head.createSpan({ cls: "dc-m-wk-stat" });
	if (tasks.length) stat.appendText(`${done}/${tasks.length}`);
	if (unassigned) tip(stat.createSpan({ cls: "dc-m-wk-un", text: ` · 미배정 ${unassigned}` }), "이번 주 할 일 중 날짜를 아직 정하지 않은 일");

	const body = card.createDiv({ cls: "dc-m-wk-body" });
	h.renderMilestones(body, days[0] ?? w.monday, days[days.length - 1] ?? sunday);
	const flow = dayItems.filter((x) => x.it.item.kind === "event" || x.it.item.kind === "task");
	if (flow.length) {
		const ul = body.createEl("ul", { cls: "dc-m-flow" });
		for (const { d, it } of flow) {
			const li = ul.createEl("li", { cls: `dc-m-flow-it k-${it.item.kind} s-${it.item.status}` });
			li.createSpan({ cls: "dc-m-flow-d", text: `${+d.slice(5, 7)}/${+d.slice(8, 10)}` });
			li.createSpan({ cls: "dc-m-flow-sym" });
			const t = li.createSpan({ cls: "dc-m-flow-t" });
			if (it.item.time) t.createSpan({ cls: "dc-m-flow-tm", text: it.item.time });
			t.appendText(it.item.text);
			li.addEventListener("click", () => {
				s.day = d;
				s.mode = "grid";
				renderDeskMobile(h);
			});
		}
	} else if (!body.childElementCount) body.createDiv({ cls: "dc-m-muted", text: "날짜가 정해진 일이 없어요" });
	if (w.hasAlloc) {
		const box = body.createDiv({ cls: "dc-m-wk-alloc" });
		h.renderAllocCell(box, w.monday);
		wire(h, box.querySelector<HTMLElement>(".dc-items"), alloc, "alloc");
	}
}

/** Long-press an 이달 중 item, drag it onto a week card, lift: assigned to that week. */
function dragToWeek(h: DeskMobileHost, li: HTMLElement, it: DeskItem): void {
	let timer: number | null = null, ghost: HTMLElement | null = null, over: HTMLElement | null = null, sx = 0, sy = 0, dropped = 0;
	const weekAt = (x: number, y: number) => (li.doc.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(".dc-m-wk") ?? null;
	const end = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = null;
		ghost?.remove();
		ghost = null;
		over?.removeClass("is-drop");
		over = null;
		li.removeClass("is-dragging");
	};
	li.addEventListener("touchstart", (e) => {
		if (e.touches.length !== 1) return;
		e.stopPropagation(); // a long press here picks the item up instead of opening the menu
		sx = e.touches[0].clientX;
		sy = e.touches[0].clientY;
		timer = window.setTimeout(() => {
			timer = null;
			li.addClass("is-dragging");
			ghost = li.doc.body.createDiv({ cls: "ml-touch-ghost", text: it.item.text });
			ghost.style.left = `${sx}px`;
			ghost.style.top = `${sy}px`;
			navigator.vibrate?.(10);
		}, 350);
	}, { passive: true });
	li.addEventListener("touchmove", (e) => {
		const p = e.touches[0];
		if (!p) return;
		if (!ghost) {
			if (Math.abs(p.clientX - sx) > 8 || Math.abs(p.clientY - sy) > 8) end();
			return;
		}
		e.preventDefault();
		ghost.style.left = `${p.clientX}px`;
		ghost.style.top = `${p.clientY}px`;
		const w = weekAt(p.clientX, p.clientY);
		if (w !== over) {
			over?.removeClass("is-drop");
			over = w;
			over?.addClass("is-drop");
		}
		// Near the screen edges, scroll so far-away weeks can be reached.
		const vh = li.doc.documentElement.clientHeight;
		if (p.clientY > vh - 90) h.contentEl.scrollTop += 12;
		else if (p.clientY < 160) h.contentEl.scrollTop -= 12;
	}, { passive: false });
	li.addEventListener("touchend", (e) => {
		if (!ghost) {
			end();
			return;
		}
		const p = e.changedTouches[0];
		const w = p ? weekAt(p.clientX, p.clientY) : null;
		end();
		dropped = Date.now();
		const monday = w?.getAttr("data-monday");
		if (!monday) return;
		const t = deskMoveTargets({ kind: "during", open: true, assignWeek: it.item.assignWeek, assign: it.assign, monday: null, date: null }, h.weekSlots(), []).find((x) => x.op === "assignWeek" && x.monday === monday);
		if (t) void h.move(t, it);
	});
	li.addEventListener("touchcancel", end);
	li.addEventListener("click", (e) => {
		if (Date.now() - dropped < 600) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}, { capture: true });
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
