/**
 * Auto-growing textarea that never scrolls itself, with a typewriter-style caret follow.
 *
 * Shared by the Diary editor and the Daily Pad section editors. The textarea's height tracks its
 * content (so the surrounding pane is the only scroller) and, while typing, the pane is scrolled
 * so the caret line never sits at the bottom edge.
 *
 * Why this exists: a plain "height = scrollHeight on input" fights the browser. On each keystroke
 * Chromium first reveals the caret by scrolling the (still too short) textarea internally, then
 * our resize snaps that scroll back to 0 — the caret line hops between two positions. Here the
 * resize runs once per animation frame, only when the height really changes, undoes the internal
 * scroll and moves the pane by the same amount instead, so the caret stays put on screen.
 *
 * This module touches the DOM only inside the class; `planCaretScroll` is pure and tested.
 */

export interface AutoGrowOptions {
	/** Minimum height in px (the textarea's CSS `min-height`). */
	minHeight: number;
	/** Added to `scrollHeight` when setting the height (border compensation). Default 2. */
	extra?: number;
	/** Scroll the pane so the caret stays comfortable while typing. Default true. */
	followCaret?: boolean;
}

/** Zone of the visible pane (fraction of its height) below which the caret triggers a scroll. */
export const BOTTOM_ZONE = 0.7;
/** Where the caret line lands after a follow scroll (fraction of the pane height from the top). */
export const REST_AT = 0.6;
/** Lines of breathing room kept below a line created by Enter at the end of the text. */
export const ENTER_ROOM_LINES = 3;

export interface CaretScrollInput {
	/** Pane's current `scrollTop`. */
	scrollTop: number;
	/** Pane's visible height. */
	paneHeight: number;
	/** Caret line's top, relative to the pane's visible top (0 = at the top edge). */
	caretTop: number;
	/** Height of one text line. */
	lineHeight: number;
	/** The input was Enter with the caret at the very end of the text. */
	enterAtEnd: boolean;
}

/**
 * Decide where the pane should scroll after an input. `null` means: leave it alone.
 *
 * - Caret in the bottom 30% of the pane → scroll so its line sits at 60% from the top.
 * - Enter at the end of the text → the new line plus ~3 lines beneath it must be visible.
 * - Otherwise (caret already in the comfortable zone) never scroll.
 */
export function planCaretScroll(i: CaretScrollInput): number | null {
	if (i.paneHeight <= 0) return null;
	const caretBottom = i.caretTop + i.lineHeight;
	if (i.caretTop >= i.paneHeight * BOTTOM_ZONE) {
		return Math.max(0, Math.round(i.scrollTop + i.caretTop - i.paneHeight * REST_AT));
	}
	if (i.enterAtEnd) {
		const need = caretBottom + i.lineHeight * ENTER_ROOM_LINES;
		if (need > i.paneHeight) return Math.max(0, Math.round(i.scrollTop + need - i.paneHeight));
	}
	return null;
}

/** Computed-style properties copied to the mirror so it wraps exactly like the textarea. */
const MIRROR_PROPS = [
	"fontFamily",
	"fontSize",
	"fontWeight",
	"fontStyle",
	"fontVariant",
	"fontKerning",
	"letterSpacing",
	"lineHeight",
	"textIndent",
	"textTransform",
	"wordSpacing",
	"wordBreak",
	"overflowWrap",
	"tabSize",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
] as const;

/** Nearest ancestor that actually scrolls (overflow not visible and content taller than the box). */
export function findScroller(el: HTMLElement): HTMLElement | null {
	let node: HTMLElement | null = el.parentElement;
	while (node && node !== document.body) {
		const oy = getComputedStyle(node).overflowY;
		if (oy !== "visible" && oy !== "clip" && node.scrollHeight > node.clientHeight + 1) return node;
		node = node.parentElement;
	}
	return null;
}

export class AutoGrow {
	private readonly ta: HTMLTextAreaElement;
	private readonly minHeight: number;
	private readonly extra: number;
	private readonly follow: boolean;
	private frame: number | null = null;
	private mirror: HTMLDivElement | null = null;
	private mirrorSpan: HTMLSpanElement | null = null;
	/** Length of the value at the last resize — a shorter value is the only time a shrink is possible. */
	private lastLen: number;
	private lastKey = "";
	private disposed = false;

	constructor(ta: HTMLTextAreaElement, opts: AutoGrowOptions) {
		this.ta = ta;
		this.minHeight = opts.minHeight;
		this.extra = opts.extra ?? 2;
		this.follow = opts.followCaret ?? true;
		this.lastLen = ta.value.length;
		this.onKeydown = this.onKeydown.bind(this);
		this.onInput = this.onInput.bind(this);
		ta.addEventListener("keydown", this.onKeydown);
		ta.addEventListener("input", this.onInput);
		this.fit();
	}

	/** Size the textarea to its content now (mount, programmatic value change). No caret follow. */
	fit(): void {
		const ta = this.ta;
		const pane = findScroller(ta);
		const paneTop = pane ? pane.scrollTop : 0;
		ta.style.height = "auto";
		this.setHeight(ta.scrollHeight);
		ta.scrollTop = 0;
		this.lastLen = ta.value.length;
		if (pane) pane.scrollTop = paneTop;
	}

	dispose(): void {
		this.disposed = true;
		this.ta.removeEventListener("keydown", this.onKeydown);
		this.ta.removeEventListener("input", this.onInput);
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.mirror?.remove();
		this.mirror = null;
		this.mirrorSpan = null;
	}

	private onKeydown(e: KeyboardEvent): void {
		this.lastKey = e.key;
	}

	private onInput(): void {
		if (this.disposed || this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			if (this.disposed || !this.ta.isConnected) return;
			try {
				this.tick();
			} catch (err) {
				console.error("[MyLogs] autogrow failed", err);
			}
		});
	}

	/** One frame: resize if needed, keep the pane stable, then follow the caret. */
	private tick(): void {
		const ta = this.ta;
		const key = this.lastKey;
		this.lastKey = "";
		const pane = findScroller(ta);
		const paneTop = pane ? pane.scrollTop : 0;
		// The browser already scrolled the textarea internally to reveal the caret; undo that below
		// and move the pane by the same amount so the caret does not move on screen.
		const internal = ta.scrollTop;
		const len = ta.value.length;
		const shrinkPossible = len < this.lastLen;
		this.lastLen = len;

		if (shrinkPossible) {
			ta.style.height = "auto";
			this.setHeight(ta.scrollHeight);
		} else if (ta.scrollHeight > ta.clientHeight) {
			// Grow only: no `auto` pass, no layout flash.
			this.setHeight(ta.scrollHeight);
		}
		if (ta.scrollTop !== 0) ta.scrollTop = 0;
		if (!pane) return;
		// Only touch the pane when something moved (an untouched pane keeps a smooth scroll in flight).
		if (internal > 0 || pane.scrollTop !== paneTop) pane.scrollTop = paneTop + internal;

		if (!this.follow) return;
		const caret = this.caretTop();
		if (caret === null) return;
		const paneRect = pane.getBoundingClientRect();
		const enterAtEnd = key === "Enter" && ta.selectionStart === len && ta.selectionEnd === len;
		const target = planCaretScroll({
			scrollTop: pane.scrollTop,
			paneHeight: paneRect.height,
			caretTop: caret.top - paneRect.top,
			lineHeight: caret.lineHeight,
			enterAtEnd,
		});
		if (target === null || Math.abs(target - pane.scrollTop) < 1) return;
		const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
		pane.scrollTo({ top: target, behavior: reduce ? "auto" : "smooth" });
	}

	private setHeight(scrollHeight: number): void {
		const h = Math.max(scrollHeight + this.extra, this.minHeight);
		const cur = parseFloat(this.ta.style.height); // NaN after an `auto` pass → always set
		if (Number.isFinite(cur) && Math.abs(cur - h) < 1) return;
		this.ta.style.height = `${h}px`;
	}

	/**
	 * Caret line's top in viewport coordinates, measured with a mirror div: the text before the
	 * caret followed by a zero-width marker, laid out with the textarea's width and typography.
	 */
	private caretTop(): { top: number; lineHeight: number } | null {
		const ta = this.ta;
		const cs = getComputedStyle(ta);
		if (!this.mirror || !this.mirrorSpan) {
			const m = document.createElement("div");
			m.setAttribute("aria-hidden", "true");
			m.style.position = "fixed";
			m.style.top = "0";
			m.style.left = "0";
			m.style.height = "0";
			m.style.overflow = "hidden";
			m.style.visibility = "hidden";
			m.style.pointerEvents = "none";
			m.style.whiteSpace = "pre-wrap";
			m.style.boxSizing = "border-box";
			m.style.border = "0";
			m.style.margin = "0";
			this.mirrorSpan = document.createElement("span");
			document.body.appendChild(m);
			this.mirror = m;
		}
		const m = this.mirror;
		const span = this.mirrorSpan;
		for (const p of MIRROR_PROPS) m.style[p] = cs[p];
		m.style.width = `${ta.clientWidth}px`;
		m.textContent = ta.value.slice(0, ta.selectionStart);
		span.textContent = "​";
		m.appendChild(span);
		const fontSize = parseFloat(cs.fontSize) || 16;
		const lh = parseFloat(cs.lineHeight);
		const lineHeight = Number.isFinite(lh) ? lh : fontSize * 1.2;
		const rect = ta.getBoundingClientRect();
		const borderTop = parseFloat(cs.borderTopWidth) || 0;
		return { top: rect.top + borderTop + span.offsetTop - ta.scrollTop, lineHeight };
	}
}
