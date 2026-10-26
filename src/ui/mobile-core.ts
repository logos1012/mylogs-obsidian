/**
 * Pure helpers behind the mobile kit (`src/ui/mobile.ts`). No DOM, no Obsidian: tested in
 * `test/mobile.test.ts`.
 *
 * - `LongPress`: the long-press state machine (press → hold `LONG_PRESS_MS` without moving more
 *   than `MOVE_SLOP_PX` → fire). The DOM wrapper feeds it pointer/touch events and a timer.
 * - `keyboardInset` / `visibleWindow`: how much of the layout viewport the on-screen keyboard hides,
 *   from `window.visualViewport`.
 */

/** Hold time before a press counts as a long press (ms). */
export const LONG_PRESS_MS = 450;
/** A finger that moves farther than this (px, either axis) is scrolling, not pressing. */
export const MOVE_SLOP_PX = 10;
/** After a long press fired, the click / native contextmenu that follow within this window are swallowed (ms). */
export const SUPPRESS_MS = 700;

export type LongPressState = "idle" | "pressing" | "fired" | "cancelled";

/**
 * Long-press state machine.
 *
 *   idle --down--> pressing --timer(≥ delay)--> fired --up--> idle   (up returns "long")
 *                  pressing --move(> slop) / cancel--> cancelled --up--> idle
 *                  pressing --up (before delay)--> idle               (up returns "tap")
 */
export class LongPress {
	state: LongPressState = "idle";
	private x = 0;
	private y = 0;
	private start = 0;

	readonly delay: number;
	readonly slop: number;

	constructor(delay = LONG_PRESS_MS, slop = MOVE_SLOP_PX) {
		this.delay = delay;
		this.slop = slop;
	}

	/** A finger went down at (x, y), time `t` (ms). */
	down(x: number, y: number, t: number): void {
		this.state = "pressing";
		this.x = x;
		this.y = y;
		this.start = t;
	}

	/** The finger moved. Returns true when this move cancelled the press (scroll / drag). */
	move(x: number, y: number): boolean {
		if (this.state !== "pressing") return false;
		if (Math.abs(x - this.x) > this.slop || Math.abs(y - this.y) > this.slop) {
			this.state = "cancelled";
			return true;
		}
		return false;
	}

	/** The timer ticked at `t`. Returns true exactly once, when the press becomes a long press. */
	tick(t: number): boolean {
		if (this.state !== "pressing" || t - this.start < this.delay) return false;
		this.state = "fired";
		return true;
	}

	/** Scroll, second finger, pointercancel. */
	cancel(): void {
		if (this.state === "pressing") this.state = "cancelled";
	}

	/** The finger lifted. "long" after a fired press, "tap" for a short clean press, else "none". */
	up(): "long" | "tap" | "none" {
		const s = this.state;
		this.state = "idle";
		return s === "fired" ? "long" : s === "pressing" ? "tap" : "none";
	}

	/** Where the press started (menus open there). */
	get origin(): { x: number; y: number } {
		return { x: this.x, y: this.y };
	}
}

/**
 * Height (px) of the layout viewport hidden below the visual viewport — the on-screen keyboard
 * when the web view does not resize for it. 0 when nothing is hidden (or the web view already
 * resized, so `innerHeight` equals the visual height). Small differences (< 1 px) are rounding.
 */
export function keyboardInset(layoutHeight: number, vvHeight: number, vvOffsetTop: number): number {
	const hidden = layoutHeight - vvHeight - vvOffsetTop;
	return hidden >= 1 ? Math.round(hidden) : 0;
}

/**
 * The part of a scroll pane that is actually on screen, in layout-viewport coordinates: the pane's
 * rect clipped to the visual viewport (the keyboard covers the rest). Used by the caret follow
 * (`src/ui/autogrow.ts`) on mobile so the caret stays above the keyboard.
 */
export function visibleWindow(paneTop: number, paneBottom: number, vvTop: number, vvHeight: number): { top: number; height: number } {
	const top = Math.max(paneTop, vvTop);
	const bottom = Math.min(paneBottom, vvTop + vvHeight);
	return { top, height: Math.max(0, bottom - top) };
}

/** A choice in a mobile picker / action sheet (`pickTarget`). */
export interface PickItem {
	label: string;
	/** Second, muted line. */
	sub?: string;
	/** Lucide icon id. */
	icon?: string;
}

/** Case-insensitive filter of picker items by label + sub (empty query → all). */
export function filterPickItems<T extends PickItem>(items: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter((i) => `${i.label} ${i.sub ?? ""}`.toLowerCase().includes(q));
}

/** Lists this short are shown as an action sheet (no search field, no keyboard popping up). */
export const SHEET_MAX = 12;
