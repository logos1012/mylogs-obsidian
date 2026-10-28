/**
 * Phone Desk Calendar 주 보기 (계획 「할 일의 레벨」): every piece of work in one week.
 *
 *   배정 안 된 일   이번 주 할 일 without a date · 이달 중 · 진행 중 프로젝트의 날짜 없는 할 일
 *                  (long-press and drop on a day, or tap → which day)
 *   월 … 일        the desktop day cell (◆, events, dated tasks: project tasks included) and that
 *                  day's Daily Pad 「오늘 할 일」 (checked there; it stays the Daily Pad's line)
 *
 * The month level (흐름 · 달력) shows milestones · events · #마감; this is where all tasks are.
 * Reached from a week card in `./mobile.ts`.
 */

import { setIcon } from "obsidian";
import { addDays } from "../parser.ts";
import { tip } from "../ui/tip.ts";
import { actionSheet, type SheetAction } from "../ui/mobile.ts";
import { isoWeekNo, type DeskItem } from "./model.ts";
import { dayLabel, type DeskTarget } from "./mobile-targets.ts";
import type { DeskMobileHost } from "./mobile.ts";
import type { ProjectTask } from "../projects/tasks.ts";
import { touchDrag } from "./touch-drag.ts";

/** A Daily Pad 「오늘 할 일」 line of one day. */
export interface PadTask {
	index: number;
	line: string;
	text: string;
	done: boolean;
}

/** One project's undated tasks (주 보기 배정 안 된 일). */
export interface BacklogGroup {
	project: string;
	tasks: ProjectTask[];
}

type Loose =
	| { kind: "alloc"; it: DeskItem }
	| { kind: "during"; it: DeskItem }
	| { kind: "project"; task: ProjectTask; project: string };

function looseText(x: Loose): string {
	return x.kind === "project" ? x.task.title : x.it.item.text;
}

/** Drop / pick a day for an unassigned item: the same writes as the desktop and project screens. */
async function assign(h: DeskMobileHost, x: Loose, iso: string): Promise<void> {
	if (x.kind === "alloc") await h.move({ op: "assignDay", iso, label: "", sub: "", icon: "" } as DeskTarget, x.it);
	else if (x.kind === "during") await h.assignDuringToDay(x.it, iso);
	else await h.scheduleProjectTask(x.task, iso);
}

export interface WeekState {
	week: string;
	seq: number;
}

/** The week screen under the header (`root` is already cleared and has the header). */
export function renderWeekScreen(h: DeskMobileHost, root: HTMLElement, w: WeekState, today: string, back: () => void, go: (monday: string) => void, wire: (ul: HTMLElement | null, items: DeskItem[]) => void): void {
	const monday = w.week;
	const sunday = addDays(monday, 6);
	const seq = ++w.seq;
	const bar = root.createDiv({ cls: "dc-wk-bar" });
	const backBtn = bar.createEl("button", { cls: "dc-wk-back", attr: { type: "button", "aria-label": "달로 돌아가기" } });
	setIcon(backBtn.createSpan(), "chevron-left");
	backBtn.createSpan({ text: "달" });
	backBtn.addEventListener("click", back);
	const nav = bar.createDiv({ cls: "dc-wk-nav" });
	const prev = nav.createEl("button", { cls: "dc-wk-arrow", attr: { type: "button", "aria-label": "이전 주" } });
	setIcon(prev, "chevron-left");
	prev.addEventListener("click", () => go(addDays(monday, -7)));
	const title = nav.createDiv({ cls: "dc-wk-title" });
	title.createSpan({ cls: "dc-wk-no", text: `W${String(isoWeekNo(monday)).padStart(2, "0")}` });
	title.createSpan({ text: `${+monday.slice(5, 7)}/${+monday.slice(8, 10)} – ${+sunday.slice(5, 7)}/${+sunday.slice(8, 10)}` });
	const next = nav.createEl("button", { cls: "dc-wk-arrow", attr: { type: "button", "aria-label": "다음 주" } });
	setIcon(next, "chevron-right");
	next.addEventListener("click", () => go(addDays(monday, 7)));

	const loose = root.createDiv({ cls: "dc-wk-loose" });
	const lhead = loose.createDiv({ cls: "dc-m-sec-title", text: "배정 안 된 일" });
	tip(lhead, "길게 눌러 아래 날짜에 놓으면 그날로 배정돼요. 눌러서 날짜를 골라도 돼요.");
	const looseBody = loose.createDiv({ cls: "dc-wk-loose-body" });

	const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
	const dayBoxes = new Map<string, HTMLElement>();
	for (const iso of days) {
		const box = root.createDiv({ cls: "dc-m-cell dc-wk-day", attr: { "data-iso": iso } });
		h.renderDayCell(box, iso);
		// A week crosses months: its other-month days are part of it here (the grid hides them).
		box.querySelector(".dc-out")?.removeClass("dc-out");
		wire(box.querySelector<HTMLElement>(".dc-items"), h.dayItems(iso));
		dayBoxes.set(iso, box);
	}

	const dropTo = (x: Loose) => (target: HTMLElement) => {
		const iso = target.getAttr("data-iso");
		if (iso) void assign(h, x, iso);
	};
	const pickDay = (x: Loose) => {
		const actions: SheetAction[] = days.map((iso) => ({ label: dayLabel(iso), sub: iso === today ? "오늘" : "", icon: "calendar-check", run: () => assign(h, x, iso) }));
		void actionSheet(h.app, looseText(x), actions);
	};
	const looseItem = (ul: HTMLElement, x: Loose, sub?: string) => {
		const li = ul.createEl("li", { cls: "dc-wk-loose-it" });
		li.createSpan({ cls: "dc-wk-loose-sym" });
		li.createSpan({ cls: "dc-wk-loose-t", text: looseText(x) });
		if (sub) li.createSpan({ cls: "dc-wk-loose-sub", text: sub });
		li.addEventListener("click", () => pickDay(x));
		touchDrag(h.contentEl, li, looseText(x), ".dc-wk-day", dropTo(x));
	};
	const group = (label: string, items: Loose[], hint?: string) => {
		if (!items.length) return;
		const g = looseBody.createDiv({ cls: "dc-wk-loose-group" });
		const gh = g.createDiv({ cls: "dc-wk-loose-label", text: `${label} ${items.length}` });
		if (hint) tip(gh, hint);
		const ul = g.createEl("ul");
		for (const x of items) looseItem(ul, x);
	};

	const alloc = h.allocItems(monday).filter((it) => h.isOpenTask(it) && !it.assign.length);
	group("이번 주 할 일", alloc.map((it) => ({ kind: "alloc" as const, it })), "이번 주에 하기로 한 일 중 날짜를 아직 정하지 않은 일");
	const during = h.duringItems().filter((it) => h.isOpenTask(it));
	group("이달 중", during.map((it) => ({ kind: "during" as const, it })), "이달 안에 할 일. 날짜에 놓으면 이번 주 할 일을 거쳐 그날로 배정돼요");
	const projectsBox = looseBody.createDiv({ cls: "dc-wk-loose-projects" });
	projectsBox.createDiv({ cls: "dc-m-muted", text: "프로젝트 할 일 불러오는 중…" });

	// Async parts: project backlog and each day's Daily Pad.
	void (async () => {
		const groups = await h.projectBacklog();
		if (seq !== w.seq) return;
		projectsBox.empty();
		for (const g of groups) {
			if (!g.tasks.length) continue;
			const el = projectsBox.createDiv({ cls: "dc-wk-loose-group" });
			tip(el.createDiv({ cls: "dc-wk-loose-label", text: `${g.project} ${g.tasks.length}` }), "프로젝트에서 만든, 날짜가 아직 없는 할 일");
			const ul = el.createEl("ul");
			for (const t of g.tasks) looseItem(ul, { kind: "project", task: t, project: g.project });
		}
		if (!looseBody.querySelector(".dc-wk-loose-it")) looseBody.createDiv({ cls: "dc-m-muted", text: "배정 안 된 일이 없어요" });
	})();
	void (async () => {
		for (const iso of days) {
			const tasks = await h.padTasks(iso);
			if (seq !== w.seq) return;
			if (!tasks.length) continue;
			const box = dayBoxes.get(iso)!;
			const cell = box.querySelector<HTMLElement>(".dc-day") ?? box;
			cell.removeClass("dc-blank");
			const sec = cell.createDiv({ cls: "dc-wk-pad" });
			tip(sec.createDiv({ cls: "dc-wk-pad-label", text: "Daily Pad" }), "그날 Daily Pad 「오늘 할 일」에 적은 일");
			const ul = sec.createEl("ul", { cls: "dc-items" });
			for (const t of tasks) {
				const li = ul.createEl("li", { cls: `dc-it dc-k-task dc-s-${t.done ? "done" : "scheduled"}` });
				const sym = li.createSpan({ cls: "dc-sym is-clickable", attr: { role: "checkbox", "aria-checked": String(t.done), tabindex: "0" } });
				li.createSpan({ cls: "dc-body", text: t.text });
				sym.addEventListener("click", (e) => {
					e.stopPropagation();
					li.addClass("is-pending");
					void h.togglePadTask(iso, t);
				});
			}
		}
	})();
}
