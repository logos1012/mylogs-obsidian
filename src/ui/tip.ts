import { Platform, setTooltip } from "obsidian";
import { onLongPress } from "./mobile.ts";

/**
 * Hidden help text. Explanations are not printed on screen: desktop shows `text` on hover (Obsidian
 * tooltip), touch shows it in a small bubble on a long press. Returns `el`.
 *
 * Use on titles, legends and buttons — not on items, whose long press opens the item menu.
 */
export function tip<T extends HTMLElement>(el: T, text: string): T {
	if (!text) return el;
	el.addClass("ml-has-tip");
	el.setAttr("aria-description", text);
	if (!Platform.isMobile) {
		setTooltip(el, text, { delay: 250 });
		return el;
	}
	onLongPress(el, () => showTipBubble(el, text));
	// The view-wide long-press menu (`enableTouchMenus`) dispatches a contextmenu: the help wins here.
	el.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		e.stopPropagation();
	});
	return el;
}

let current: { el: HTMLElement; off: () => void } | null = null;

export function hideTipBubble(): void {
	current?.off();
	current = null;
}

/** A small bubble under (or above) `anchor`; any next touch, scroll or 5 s closes it. */
export function showTipBubble(anchor: HTMLElement, text: string): void {
	hideTipBubble();
	const doc = anchor.doc;
	const b = doc.body.createDiv({ cls: "mylogs-tip-bubble", text, attr: { role: "tooltip" } });
	const r = anchor.getBoundingClientRect();
	const vw = doc.documentElement.clientWidth;
	const vh = doc.documentElement.clientHeight;
	const w = Math.min(280, vw - 24);
	b.style.maxWidth = `${w}px`;
	const bw = Math.min(b.offsetWidth, w);
	const left = Math.max(12, Math.min(r.left + r.width / 2 - bw / 2, vw - bw - 12));
	const below = r.bottom + 8 + b.offsetHeight < vh - 12;
	b.style.left = `${left}px`;
	b.style.top = `${below ? r.bottom + 8 : Math.max(12, r.top - 8 - b.offsetHeight)}px`;
	b.addClass(below ? "is-below" : "is-above");
	const timer = window.setTimeout(hideTipBubble, 5000);
	const close = () => hideTipBubble();
	// Registered on the next tick so the lifting finger of this long press doesn't close it.
	const arm = window.setTimeout(() => {
		doc.addEventListener("touchstart", close, { capture: true, passive: true });
		doc.addEventListener("mousedown", close, { capture: true });
		doc.addEventListener("scroll", close, { capture: true, passive: true });
	}, 50);
	current = {
		el: b,
		off: () => {
			window.clearTimeout(timer);
			window.clearTimeout(arm);
			doc.removeEventListener("touchstart", close, { capture: true });
			doc.removeEventListener("mousedown", close, { capture: true });
			doc.removeEventListener("scroll", close, { capture: true });
			b.remove();
		},
	};
}
