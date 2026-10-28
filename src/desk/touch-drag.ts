/**
 * Long-press → drag → drop on a phone (Desk 흐름 week cards, 주 보기 days). A 350 ms press picks the
 * item up (a ghost follows the finger), the element under the finger matching `selector` is
 * highlighted, and lifting over one calls `onDrop` with it. Near the screen edges `scroller`
 * scrolls so far targets can be reached. A tap right after a drop is swallowed.
 */
export function touchDrag(scroller: HTMLElement, li: HTMLElement, label: string, selector: string, onDrop: (target: HTMLElement) => void): void {
	let timer: number | null = null, ghost: HTMLElement | null = null, over: HTMLElement | null = null, sx = 0, sy = 0, dropped = 0;
	const targetAt = (x: number, y: number) => (li.doc.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(selector) ?? null;
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
			ghost = li.doc.body.createDiv({ cls: "ml-touch-ghost", text: label });
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
		const t = targetAt(p.clientX, p.clientY);
		if (t !== over) {
			over?.removeClass("is-drop");
			over = t;
			over?.addClass("is-drop");
		}
		const vh = li.doc.documentElement.clientHeight;
		if (p.clientY > vh - 90) scroller.scrollTop += 12;
		else if (p.clientY < 160) scroller.scrollTop -= 12;
	}, { passive: false });
	li.addEventListener("touchend", (e) => {
		if (!ghost) {
			end();
			return;
		}
		const p = e.changedTouches[0];
		const t = p ? targetAt(p.clientX, p.clientY) : null;
		end();
		dropped = Date.now();
		if (t) onDrop(t);
	});
	li.addEventListener("touchcancel", end);
	li.addEventListener("click", (e) => {
		if (Date.now() - dropped < 600) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	}, { capture: true });
}
