/**
 * Mobile kit (MyLogs Plugin 계획 「11. 모바일」). Same plugin, same logic: views branch on
 * `Platform.isMobile` at render time and use these pieces instead of desktop-only gestures.
 *
 * - drag and drop → `pickTarget` (tap → choose where it goes → the same move op the drop calls)
 * - right click   → long press (`onLongPress`, `enableTouchMenus`) opening the same `Menu`
 * - columns       → `tabBar` (one column + segmented tabs)
 * - keyboard      → `trackKeyboard` (bottom room for the on-screen keyboard)
 *
 * Desktop never calls into this module. Pure parts live in `mobile-core.ts`.
 */

import { type App, Platform, setIcon, SuggestModal } from "obsidian";
import { filterPickItems, keyboardInset, LongPress, type PickItem, SHEET_MAX, SUPPRESS_MS } from "./mobile-core.ts";

export type { PickItem } from "./mobile-core.ts";

export function isMobile(): boolean {
	return Platform.isMobile;
}

// ───────────────────────── picker / action sheet ─────────────────────────

class PickModal<T extends PickItem> extends SuggestModal<T> {
	private chosen = false;

	private readonly items: T[];
	private readonly done: (v: T | null) => void;

	constructor(app: App, title: string, items: T[], done: (v: T | null) => void) {
		super(app);
		this.items = items;
		this.done = done;
		this.setPlaceholder(title);
		this.emptyStateText = "고를 것이 없어요";
		this.limit = 200;
		this.modalEl.addClass("mylogs-pick-modal");
		const head = createDiv({ cls: "mylogs-pick-title", text: title });
		this.modalEl.prepend(head);
		if (items.length <= SHEET_MAX) this.modalEl.addClass("is-sheet");
	}

	onOpen(): void {
		super.onOpen();
		if (this.items.length > SHEET_MAX) return;
		// An action sheet: no search field, so no keyboard popping up over the choices.
		const blur = () => this.inputEl.blur();
		blur();
		window.setTimeout(blur, 0);
	}

	getSuggestions(query: string): T[] {
		return filterPickItems(this.items, query);
	}

	renderSuggestion(it: T, el: HTMLElement): void {
		el.addClass("mylogs-pick-item");
		if (it.icon) setIcon(el.createSpan({ cls: "mylogs-pick-icon" }), it.icon);
		const t = el.createDiv({ cls: "mylogs-pick-text" });
		t.createDiv({ cls: "mylogs-pick-label", text: it.label });
		if (it.sub) t.createDiv({ cls: "mylogs-pick-sub", text: it.sub });
	}

	onChooseSuggestion(it: T): void {
		this.chosen = true;
		this.done(it);
	}

	onClose(): void {
		super.onClose();
		// `selectSuggestion` closes first, then calls `onChooseSuggestion`: decide after it.
		window.setTimeout(() => {
			if (!this.chosen) this.done(null);
		}, 0);
	}
}

/**
 * Choose one of `targets` (where an item goes, or an action). Resolves null when dismissed.
 * Short lists show as an action sheet; long ones get a search field.
 */
export function pickTarget<T extends PickItem>(app: App, title: string, targets: T[]): Promise<T | null> {
	return new Promise((resolve) => {
		let settled = false;
		new PickModal(app, title, targets, (v) => {
			if (settled) return;
			settled = true;
			resolve(v);
		}).open();
	});
}

/** An action-sheet entry that runs something. */
export interface SheetAction extends PickItem {
	run: () => unknown;
}

/** Show `actions` as an action sheet and run the chosen one. */
export async function actionSheet(app: App, title: string, actions: SheetAction[]): Promise<void> {
	if (!actions.length) return;
	const a = await pickTarget(app, title, actions);
	if (a) await a.run();
}

// ───────────────────────── long press ─────────────────────────

/** A synthetic right-click at (x, y): desktop `contextmenu` handlers and `Menu.showAtMouseEvent` take it as is. */
export function menuEventAt(x: number, y: number): MouseEvent {
	return new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
}

interface PressTracker {
	lp: LongPress;
	timer: number | null;
	/** Time the last long press fired (the click / native contextmenu right after it are ours). */
	firedAt: number;
}

function wirePress(el: HTMLElement, accept: (target: HTMLElement) => HTMLElement | null, fire: (target: HTMLElement, x: number, y: number) => void): () => void {
	const s: PressTracker = { lp: new LongPress(), timer: null, firedAt: 0 };
	let target: HTMLElement | null = null;
	const clear = () => {
		if (s.timer !== null) window.clearTimeout(s.timer);
		s.timer = null;
	};
	const onStart = (e: TouchEvent) => {
		clear();
		if (e.touches.length !== 1) {
			s.lp.cancel();
			return;
		}
		const t = e.target as HTMLElement | null;
		target = t ? accept(t) : null;
		if (!target || !t || t.closest("input, textarea, select, [contenteditable='true']")) return;
		const p = e.touches[0];
		s.lp.down(p.clientX, p.clientY, Date.now());
		s.timer = window.setTimeout(() => {
			s.timer = null;
			if (!s.lp.tick(Date.now()) || !target) return;
			s.firedAt = Date.now();
			const o = s.lp.origin;
			fire(target, o.x, o.y);
		}, s.lp.delay);
	};
	const onMove = (e: TouchEvent) => {
		const p = e.touches[0];
		if (p && s.lp.move(p.clientX, p.clientY)) clear();
	};
	const onEnd = () => {
		clear();
		s.lp.up();
	};
	const onCancel = () => {
		clear();
		s.lp.cancel();
		s.lp.up();
	};
	const recent = () => Date.now() - s.firedAt < SUPPRESS_MS;
	// The tap that ends a long press must not also open / select what is under the finger.
	const onClick = (e: MouseEvent) => {
		if (!recent()) return;
		e.preventDefault();
		e.stopPropagation();
	};
	// Android fires its own contextmenu on a long press: one menu, ours.
	const onNativeMenu = (e: MouseEvent) => {
		if (!e.isTrusted) return;
		if (recent()) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (s.lp.state === "pressing" && target) {
			e.preventDefault();
			e.stopPropagation();
			clear();
			s.lp.cancel();
			s.firedAt = Date.now();
			fire(target, e.clientX, e.clientY);
		}
	};
	el.addEventListener("touchstart", onStart, { passive: true });
	el.addEventListener("touchmove", onMove, { passive: true });
	el.addEventListener("touchend", onEnd);
	el.addEventListener("touchcancel", onCancel);
	el.addEventListener("scroll", onCancel, { capture: true, passive: true });
	el.addEventListener("click", onClick, { capture: true });
	el.addEventListener("contextmenu", onNativeMenu, { capture: true });
	return () => {
		clear();
		el.removeEventListener("touchstart", onStart);
		el.removeEventListener("touchmove", onMove);
		el.removeEventListener("touchend", onEnd);
		el.removeEventListener("touchcancel", onCancel);
		el.removeEventListener("scroll", onCancel, { capture: true });
		el.removeEventListener("click", onClick, { capture: true });
		el.removeEventListener("contextmenu", onNativeMenu, { capture: true });
	};
}

/** Long press on `el` (~450 ms, cancelled by a move > 10 px or a scroll) → `cb` with where it started. */
export function onLongPress(el: HTMLElement, cb: (pos: { x: number; y: number }) => void): () => void {
	return wirePress(
		el,
		() => el,
		(_t, x, y) => cb({ x, y }),
	);
}

/**
 * Long press anywhere inside `root` = right click there: a synthetic `contextmenu` is dispatched on
 * the pressed element, so every desktop right-click handler (and the `Menu` it builds) runs
 * unchanged. Install once per view; survives re-renders (delegated). Returns a cleanup.
 */
export function enableTouchMenus(root: HTMLElement): () => void {
	root.addClass("mylogs-touch");
	const off = wirePress(
		root,
		(t) => t,
		(t, x, y) => {
			t.dispatchEvent(menuEventAt(x, y));
		},
	);
	return () => {
		off();
		root.removeClass("mylogs-touch");
	};
}

// ───────────────────────── small widgets ─────────────────────────

/** A visible 44 px "⋯" button (no hover-only affordance on touch). */
export function moreButton(parent: HTMLElement, onClick: (e: MouseEvent) => void, label = "항목 메뉴"): HTMLButtonElement {
	const b = parent.createEl("button", { cls: "mylogs-m-more", text: "⋯", attr: { type: "button", "aria-label": label } });
	b.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		onClick(e);
	});
	return b;
}

export interface TabDef<T extends string> {
	id: T;
	label: string;
	count?: number;
}

/** Segmented tab bar (horizontally scrollable when it does not fit). */
export function tabBar<T extends string>(parent: HTMLElement, tabs: TabDef<T>[], active: T, onSelect: (id: T) => void): HTMLElement {
	const bar = parent.createDiv({ cls: "mylogs-m-tabs", attr: { role: "tablist" } });
	for (const t of tabs) {
		const b = bar.createEl("button", { cls: `mylogs-m-tab${t.id === active ? " is-active" : ""}`, attr: { type: "button", role: "tab", "aria-selected": String(t.id === active) } });
		b.createSpan({ text: t.label });
		if (t.count !== undefined) b.createSpan({ cls: "mylogs-m-tab-n", text: String(t.count) });
		b.addEventListener("click", () => {
			if (t.id !== active) onSelect(t.id);
		});
	}
	return bar;
}

/** Floating action button, bottom right. */
export function fab(parent: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
	const b = parent.createEl("button", { cls: "mylogs-m-fab", attr: { type: "button", "aria-label": label } });
	setIcon(b.createSpan({ cls: "mylogs-m-fab-icon" }), icon);
	b.createSpan({ text: label });
	b.addEventListener("click", onClick);
	return b;
}

/** Ask the OS for files (photo library / camera on a phone). Resolves null when nothing is chosen. */
export function chooseFiles(accept: string, multiple = true): Promise<FileList | null> {
	return new Promise((resolve) => {
		const input = document.body.createEl("input", { attr: { type: "file", accept }, cls: "mylogs-m-file" });
		input.multiple = multiple;
		input.addEventListener("change", () => {
			resolve(input.files && input.files.length ? input.files : null);
			input.remove();
		});
		input.addEventListener("cancel", () => {
			resolve(null);
			input.remove();
		});
		input.click();
	});
}

// ───────────────────────── keyboard ─────────────────────────

/**
 * Keep the bottom of `el` reachable above the on-screen keyboard: sets `--mylogs-kb` (px of layout
 * viewport the keyboard hides) on `el`; mobile CSS adds it to the scroll containers' bottom padding.
 */
export function trackKeyboard(el: HTMLElement): () => void {
	const vv = window.visualViewport;
	if (!vv) return () => undefined;
	const update = () => {
		const inset = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
		el.style.setProperty("--mylogs-kb", `${inset}px`);
		el.toggleClass("mylogs-kb-open", inset > 0);
	};
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	update();
	return () => {
		vv.removeEventListener("resize", update);
		vv.removeEventListener("scroll", update);
		el.style.removeProperty("--mylogs-kb");
		el.removeClass("mylogs-kb-open");
	};
}
