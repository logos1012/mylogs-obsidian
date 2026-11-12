/**
 * Session-only compact / expand state for the My Life 「이번 주 흐름」 card.
 * Not written to settings or the vault; a new view starts fresh.
 */

export type WeekCompactMode = "wide" | "narrow";

/** Matches the `@container (max-width: 720px)` stacked layout. */
export const WEEK_FLOW_NARROW_MAX = 720;

export interface WeekCompactState {
	/** ISO date of the one expanded day, or null when all days are compact. */
	expandedDay: string | null;
	/** 「오늘까지 흐름」 rows are fully open (both personal and company). */
	summaryOpen: boolean;
}

export type WeekCompactAction =
	| { type: "toggle-day"; date: string }
	| { type: "close-day" }
	| { type: "toggle-summary" };

export function weekFlowModeOf(width: number): WeekCompactMode {
	return width <= WEEK_FLOW_NARROW_MAX ? "narrow" : "wide";
}

/**
 * Content-box width of a `container-type: inline-size` element, so JS mode matches
 * the CSS `@container (max-width: 720px)` query.
 */
export function weekFlowContentWidth(el: HTMLElement): number {
	const s = getComputedStyle(el);
	const pl = Number.parseFloat(s.paddingLeft) || 0;
	const pr = Number.parseFloat(s.paddingRight) || 0;
	return Math.max(0, el.clientWidth - pl - pr);
}

export function initialWeekCompact(mode: WeekCompactMode, today: string | null): WeekCompactState {
	return {
		expandedDay: mode === "narrow" && today ? today : null,
		summaryOpen: false,
	};
}

export function reduceWeekCompact(state: WeekCompactState, action: WeekCompactAction): WeekCompactState {
	switch (action.type) {
		case "toggle-day":
			return { ...state, expandedDay: state.expandedDay === action.date ? null : action.date };
		case "close-day":
			return state.expandedDay === null ? state : { ...state, expandedDay: null };
		case "toggle-summary":
			return { ...state, summaryOpen: !state.summaryOpen };
	}
}

/**
 * Reuse session state across re-renders. A first paint seeds defaults (narrow: today,
 * if that date is in this week). A day that is no longer in the visible week is dropped;
 * today is not auto-expanded again once the user has a session.
 */
export function adoptWeekCompact(
	prev: WeekCompactState | null,
	mode: WeekCompactMode,
	dates: readonly string[],
	today: string,
): WeekCompactState {
	if (!prev) {
		const todayInWeek = today && dates.includes(today) ? today : null;
		return initialWeekCompact(mode, todayInWeek);
	}
	const expanded = prev.expandedDay && dates.includes(prev.expandedDay) ? prev.expandedDay : null;
	return expanded === prev.expandedDay ? prev : { ...prev, expandedDay: expanded };
}
