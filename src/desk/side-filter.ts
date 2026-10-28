/**
 * Desk Calendar by 개인 / 회사 mode (`../side.ts`): the month data with the other side's lines
 * taken out, and how many were taken out per day (shown folded, not silently gone).
 *
 * Lines keep their file indexes, so every write still goes to the right line. A pair (이번 주 ↔
 * 날짜 칸) has the same text, so both halves are on the same side.
 */

import { lineSide, type ScopeLookup, shows, type Side, type SideMode } from "../side.ts";
import type { DeskItem, MonthData } from "./model.ts";

export interface SideCounts {
	개인: number;
	회사: number;
}

export interface FilteredMonth {
	data: MonthData;
	/** Per day (ISO): lines of both sides (open tasks and events), before filtering. */
	counts: Map<string, SideCounts>;
}

export function itemSide(it: DeskItem, scopeOf?: ScopeLookup): Side {
	return it.side ?? lineSide(it.item.raw, scopeOf);
}

export function filterMonth(md: MonthData, mode: SideMode, scopeOf?: ScopeLookup): FilteredMonth {
	const counts = new Map<string, SideCounts>();
	const keep = (it: DeskItem): boolean => {
		it.side = lineSide(it.item.raw, scopeOf);
		return shows(it.side, mode);
	};
	const days = new Map<string, DeskItem[]>();
	for (const [iso, items] of md.days) {
		const c: SideCounts = { 개인: 0, 회사: 0 };
		const kept = items.filter((it) => {
			const k = keep(it);
			if (it.item.kind === "event" || (it.item.kind === "task" && it.item.status === "scheduled")) c[it.side!]++;
			return k;
		});
		counts.set(iso, c);
		days.set(iso, kept);
	}
	const weeks = new Map(md.weeks);
	for (const [m, w] of md.weeks) weeks.set(m, { ...w, alloc: w.alloc === null ? null : w.alloc.filter(keep) });
	return { data: { ...md, during: md.during.filter(keep), weeks, days }, counts };
}
