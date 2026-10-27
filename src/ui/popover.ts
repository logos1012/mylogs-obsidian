import { Platform, setIcon } from "obsidian";
import { tip } from "./tip.ts";

/**
 * Item detail popover: what an item is (title + a few readable detail rows) and what you can do
 * with it (actions). Lists show only the essentials; fields, sources, links and file details live
 * here, one click away. Desktop: a small card next to the item. Phone: a bottom sheet.
 *
 * The action half mirrors Obsidian's `Menu` builder (`addItem(i => i.setTitle(…).onClick(…))`,
 * `addSeparator()`), so existing menu code moves over unchanged.
 */

export interface DetailRow {
	label: string;
	value: string;
	/** Makes the value a link-like button (open goal / project / file). */
	onClick?: () => void;
}

interface Action {
	title: string;
	icon?: string;
	hint?: string;
	warning?: boolean;
	disabled?: boolean;
	click?: () => void;
}

/** The subset of Obsidian's `MenuItem` the views use. */
export class PopItem {
	constructor(private a: Action) {}
	setTitle(t: string): this {
		this.a.title = t;
		return this;
	}
	setIcon(i: string | null): this {
		this.a.icon = i ?? undefined;
		return this;
	}
	setWarning(w: boolean): this {
		this.a.warning = w;
		return this;
	}
	setDisabled(d: boolean): this {
		this.a.disabled = d;
		return this;
	}
	/** Sections only order Obsidian menus; the popover keeps insertion order. */
	setSection(_s: string): this {
		return this;
	}
	/** Help shown on hover / long press of the action. */
	setHint(h: string): this {
		this.a.hint = h;
		return this;
	}
	onClick(cb: () => void): this {
		this.a.click = cb;
		return this;
	}
}

let open: { off: () => void } | null = null;

export function closeItemPopover(): void {
	open?.off();
	open = null;
}

export class ItemPopover {
	private groups: Action[][] = [[]];
	title = "";
	sub = "";
	rows: DetailRow[] = [];
	/** A one-line state chip under the title (예정 · 완료 · 옮김 …). */
	badge = "";

	addItem(cb: (i: PopItem) => unknown): this {
		const a: Action = { title: "" };
		cb(new PopItem(a));
		this.groups[this.groups.length - 1].push(a);
		return this;
	}

	addSeparator(): this {
		if (this.groups[this.groups.length - 1].length) this.groups.push([]);
		return this;
	}

	row(label: string, value: string | null | undefined, onClick?: () => void): this {
		if (value) this.rows.push({ label, value, onClick });
		return this;
	}

	/** Show next to `anchor` (desktop) or as a bottom sheet (phone). */
	show(anchor: HTMLElement): void {
		closeItemPopover();
		const doc = anchor.doc;
		const sheet = Platform.isMobile;
		const scrim = sheet ? doc.body.createDiv({ cls: "mylogs-pop-scrim" }) : null;
		const el = doc.body.createDiv({ cls: `mylogs-pop${sheet ? " is-sheet" : ""}`, attr: { role: "dialog", "aria-label": this.title || "항목" } });
		const head = el.createDiv({ cls: "mylogs-pop-head" });
		const t = head.createDiv({ cls: "mylogs-pop-title" });
		t.createSpan({ text: this.title });
		if (this.badge) head.createSpan({ cls: "mylogs-pop-badge", text: this.badge });
		if (this.sub) head.createDiv({ cls: "mylogs-pop-sub", text: this.sub });
		const close = head.createEl("button", { cls: "mylogs-pop-close clickable-icon", attr: { type: "button", "aria-label": "닫기" } });
		setIcon(close, "x");
		close.addEventListener("click", () => closeItemPopover());

		if (this.rows.length) {
			const dl = el.createEl("dl", { cls: "mylogs-pop-rows" });
			for (const r of this.rows) {
				dl.createEl("dt", { text: r.label });
				const dd = dl.createEl("dd");
				if (r.onClick) {
					const b = dd.createEl("button", { cls: "mylogs-pop-link", text: r.value, attr: { type: "button" } });
					b.addEventListener("click", () => {
						closeItemPopover();
						r.onClick!();
					});
				} else dd.setText(r.value);
			}
		}

		const groups = this.groups.filter((g) => g.length);
		for (const g of groups) {
			const ul = el.createDiv({ cls: "mylogs-pop-actions" });
			for (const a of g) {
				const b = ul.createEl("button", { cls: `mylogs-pop-act${a.warning ? " is-warning" : ""}`, attr: { type: "button" } });
				if (a.icon) setIcon(b.createSpan({ cls: "mylogs-pop-act-icon" }), a.icon);
				b.createSpan({ text: a.title });
				if (a.hint) tip(b, a.hint);
				if (a.disabled || !a.click) {
					b.disabled = true;
					continue;
				}
				b.addEventListener("click", () => {
					closeItemPopover();
					a.click!();
				});
			}
		}

		if (!sheet) this.place(el, anchor);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") closeItemPopover();
		};
		const onDown = (e: Event) => {
			const target = e.target as Node | null;
			if (target && (el.contains(target) || anchor.contains(target))) return;
			closeItemPopover();
		};
		const onScroll = (e: Event) => {
			if (!el.contains(e.target as Node)) closeItemPopover();
		};
		const arm = window.setTimeout(() => {
			doc.addEventListener("mousedown", onDown, { capture: true });
			doc.addEventListener("touchstart", onDown, { capture: true, passive: true });
			if (!sheet) doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
		}, 0);
		doc.addEventListener("keydown", onKey);
		open = {
			off: () => {
				window.clearTimeout(arm);
				doc.removeEventListener("mousedown", onDown, { capture: true });
				doc.removeEventListener("touchstart", onDown, { capture: true });
				doc.removeEventListener("scroll", onScroll, { capture: true });
				doc.removeEventListener("keydown", onKey);
				el.remove();
				scrim?.remove();
			},
		};
		el.querySelector<HTMLButtonElement>(".mylogs-pop-act:not([disabled])")?.focus({ preventScroll: true });
	}

	private place(el: HTMLElement, anchor: HTMLElement): void {
		const doc = anchor.doc;
		const vw = doc.documentElement.clientWidth;
		const vh = doc.documentElement.clientHeight;
		const r = anchor.getBoundingClientRect();
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		let left = r.left;
		if (left + w > vw - 12) left = Math.max(12, vw - w - 12);
		let top = r.bottom + 6;
		if (top + h > vh - 12) top = r.top - h - 6 >= 12 ? r.top - h - 6 : Math.max(12, vh - h - 12);
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}
}
