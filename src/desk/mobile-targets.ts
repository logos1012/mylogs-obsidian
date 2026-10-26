/**
 * Where a Desk Calendar item can go on a phone, where drag and drop does not exist (계획 「11」).
 *
 * `deskMoveTargets` lists exactly the drop zones of the desktop week view that accept the item
 * (the `accepts` predicates of `renderAllocCell` / `renderDayCell` in `view.ts`), and
 * `runDeskTarget` maps each one to the call that zone's `drop` makes. Pure; tested in
 * `test/mobile-targets.test.ts`.
 */

import { addDays, fromIsoDate } from "../parser.ts";
import { weekdayMon0 } from "./model.ts";

export type DeskDragKind = "during" | "alloc" | "day";

/** A week row of the shown month (its 이번 주 할 일 box). */
export interface WeekSlot {
	monday: string;
	/** ISO week number (`W05`). */
	no: number;
	/** Month file holding that week's box (`allocFileOf`). */
	fileKey: string;
	/** The box exists (desktop: `allocWeek(ctx, monday)` non-null → the cell is a drop zone). */
	hasAlloc: boolean;
}

/** A day cell of the shown month's weeks. */
export interface DaySlot {
	iso: string;
	/** Its `### YYYY-MM-DD` section exists (desktop: `dayExists` → the cell is a drop zone). */
	exists: boolean;
}

/** What is being moved: the fields the desktop `accepts` predicates read. */
export interface DeskMoveItem {
	kind: DeskDragKind;
	/** `isOpenTask(it)`: a scheduled task. */
	open: boolean;
	/** `it.item.assignWeek` (이달 중 → weeks). */
	assignWeek: number[];
	/** `it.assign` (이번 주 할 일 → dates). */
	assign: string[];
	/** Week of an alloc / day line. */
	monday: string | null;
	/** Date of a day line. */
	date: string | null;
}

export type DeskTarget =
	| { op: "assignWeek"; monday: string; no: number; fileKey: string; label: string; sub: string; icon: string }
	| { op: "unassign"; monday: string; fileKey: string; label: string; sub: string; icon: string }
	| { op: "assignDay"; iso: string; label: string; sub: string; icon: string }
	| { op: "moveDay"; iso: string; label: string; sub: string; icon: string };

const WD = ["월", "화", "수", "목", "금", "토", "일"];

export function dayLabel(iso: string): string {
	return `${+iso.slice(5, 7)}월 ${+iso.slice(8, 10)}일 (${WD[weekdayMon0(iso)]})`;
}

function weekRange(monday: string): string {
	const sun = addDays(monday, 6);
	return `${+monday.slice(5, 7)}/${+monday.slice(8, 10)} – ${+sun.slice(5, 7)}/${+sun.slice(8, 10)}`;
}

function wk(no: number): string {
	return `W${String(no).padStart(2, "0")}`;
}

/** Drop zones of the shown month that accept `it`, in screen order (week box, then its days). */
export function deskMoveTargets(it: DeskMoveItem, weeks: WeekSlot[], days: DaySlot[]): DeskTarget[] {
	if (!it.open) return [];
	const out: DeskTarget[] = [];
	for (const w of weeks) {
		// renderAllocCell: during → week (not already assigned to it); day → its own week (배정 취소).
		if (w.hasAlloc) {
			if (it.kind === "during" && !it.assignWeek.includes(w.no)) {
				out.push({ op: "assignWeek", monday: w.monday, no: w.no, fileKey: w.fileKey, label: `${wk(w.no)} 이번 주 할 일`, sub: weekRange(w.monday), icon: "calendar-range" });
			}
			if (it.kind === "day" && it.monday === w.monday) {
				out.push({ op: "unassign", monday: w.monday, fileKey: w.fileKey, label: `${wk(w.no)} 이번 주 할 일로 (배정 취소)`, sub: weekRange(w.monday), icon: "undo-2" });
			}
		}
		for (const d of days) {
			if (!d.exists || addDays(d.iso, -weekdayMon0(d.iso)) !== w.monday) continue;
			// renderDayCell: alloc → a day of its week not yet assigned; day → any other day.
			if (it.kind === "alloc" && it.monday === w.monday && !it.assign.includes(d.iso)) {
				out.push({ op: "assignDay", iso: d.iso, label: dayLabel(d.iso), sub: "날짜에 배정", icon: "calendar-check" });
			}
			if (it.kind === "day" && it.date !== d.iso) {
				out.push({ op: "moveDay", iso: d.iso, label: dayLabel(d.iso), sub: "이 날로 옮기기", icon: "calendar" });
			}
		}
	}
	return out;
}

/** The calls the desktop drop zones make (`view.ts`), one per target op. */
export interface DeskMoveApi<I> {
	/** `exec(planAssignWeek(item, monday, no, fileKey, today))` */
	assignWeek(item: I, monday: string, no: number, fileKey: string): Promise<unknown>;
	/** `exec(planUnassign(item, findPairAlloc(item, months), monday, fileKey, today))` */
	unassign(item: I, monday: string, fileKey: string): Promise<unknown>;
	/** `exec(planAssignDay(item, iso, today))` */
	assignDay(item: I, iso: string): Promise<unknown>;
	/** `moveToDay(item, iso)` (third-postpone check, then `planMoveDay`) */
	moveToDay(item: I, iso: string): Promise<unknown>;
}

export function runDeskTarget<I>(t: DeskTarget, item: I, api: DeskMoveApi<I>): Promise<unknown> {
	switch (t.op) {
		case "assignWeek":
			return api.assignWeek(item, t.monday, t.no, t.fileKey);
		case "unassign":
			return api.unassign(item, t.monday, t.fileKey);
		case "assignDay":
			return api.assignDay(item, t.iso);
		case "moveDay":
			return api.moveToDay(item, t.iso);
	}
}

/** Day shown on the mobile day page when entering a month: today if inside it, else the 1st. */
export function defaultDay(month: string, today: string): string {
	return today.startsWith(`${month}-`) ? today : `${month}-01`;
}

/** Clamp a day into `month` (after navigating months), keeping the day number when possible. */
export function dayInMonth(month: string, day: string): string {
	if (day.startsWith(`${month}-`)) return day;
	const want = +day.slice(8, 10) || 1;
	for (let d = want; d >= 1; d--) {
		const iso = `${month}-${String(d).padStart(2, "0")}`;
		if (fromIsoDate(iso)) return iso;
	}
	return `${month}-01`;
}
