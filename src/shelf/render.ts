/**
 * Shelf bookcase DOM. Uses only Obsidian's element helpers (`createDiv`, `createEl`, …) so it
 * renders the same outside Obsidian (design preview). Paths and fields stay off the screen.
 */

import { bookMatches, isFresh, KIND_LABEL, KIND_ORDER, seriesOf, sortArticles, spineLook, type ShelfBook, type ShelfWiki } from "./model.ts";

export interface ShelfState {
	query: string;
	/** `${wiki}/${slug}` of the pulled-out book. */
	open: string | null;
	/** The pulled-out book lists every article. */
	all: boolean;
}

export interface ShelfHandlers {
	openFile(path: string): void;
	openMap(): void;
	setState(patch: Partial<ShelfState>): void;
	tip(el: HTMLElement, text: string): void;
}

const key = (b: ShelfBook) => `${b.wiki}/${b.slug}`;
const RECENT = 5;

function fmtDate(iso: string): string {
	return iso ? iso.slice(2).replace(/-/g, ".") : "";
}

export function renderShelf(root: HTMLElement, wikis: ShelfWiki[], state: ShelfState, today: string, h: ShelfHandlers): void {
	root.empty();
	const books = wikis.reduce((n, w) => n + w.books.length, 0);
	const articles = wikis.reduce((n, w) => n + w.books.reduce((m, b) => m + b.articles.length, 0), 0);

	const head = root.createDiv({ cls: "mls-head" });
	const title = head.createDiv({ cls: "mls-title" });
	title.createEl("h1", { text: "Shelf" });
	const stats = title.createDiv({ cls: "mls-stats" });
	stats.createSpan({ text: `${wikis.length}칸` });
	stats.createSpan({ text: `${books}권` });
	stats.createSpan({ text: `${articles.toLocaleString()}편` });
	const search = head.createEl("input", { cls: "mls-search", attr: { type: "search", placeholder: "책 찾기", "aria-label": "책 찾기" } });
	search.value = state.query;
	search.addEventListener("input", () => h.setState({ query: search.value }));

	const q = state.query.trim();
	const caseEl = root.createDiv({ cls: "mls-case" });
	if (!wikis.length) {
		const empty = caseEl.createDiv({ cls: "mls-empty" });
		empty.createDiv({ text: "아직 꽂힌 책이 없어요" });
		empty.createEl("button", { text: "Shelf 지도 열기", attr: { type: "button" } }).addEventListener("click", () => h.openMap());
		return;
	}

	wikis.forEach((w, i) => {
		const s = seriesOf(i);
		const row = caseEl.createDiv({ cls: "mls-row" });
		row.style.setProperty("--mls-ink", s.ink);
		row.style.setProperty("--mls-accent", s.accent);
		s.tones.forEach((t, j) => row.style.setProperty(`--mls-t${j}`, t));

		const label = row.createDiv({ cls: "mls-label" });
		label.createDiv({ cls: "mls-label-no", text: String(i + 1).padStart(2, "0") });
		label.createDiv({ cls: "mls-label-name", text: w.name });
		if (w.scope) label.createDiv({ cls: "mls-label-scope", text: w.scope });
		const n = w.books.reduce((m, b) => m + b.articles.length, 0);
		label.createDiv({ cls: "mls-label-count", text: `${w.books.length}권 · ${n}편` });
		if (w.inbox > 0) {
			const box = label.createEl("button", { cls: "mls-inbox", attr: { type: "button" } });
			box.createSpan({ cls: "mls-inbox-dot" });
			box.createSpan({ text: `받은 자료 ${w.inbox}` });
			h.tip(box, "아직 위키에 정리하지 않은 자료예요. Shelf 지도에서 볼 수 있어요");
			box.addEventListener("click", () => h.openMap());
		}

		const bay = row.createDiv({ cls: "mls-bay" });
		const shelf = bay.createDiv({ cls: "mls-books" });
		let opened: ShelfBook | null = null;
		let hits = 0;
		for (const b of w.books) {
			const look = spineLook(b.slug, b.articles.length);
			const match = bookMatches(b, q);
			if (match) hits++;
			const isOpen = state.open === key(b);
			if (isOpen) opened = b;
			const sp = shelf.createEl("button", {
				cls: `mls-spine mls-${look.style} mls-mark-${look.mark}`,
				attr: { type: "button", "aria-label": `${b.label} · ${b.articles.length}편`, "aria-expanded": String(isOpen) },
			});
			sp.style.width = `${look.width}px`;
			sp.style.height = `${look.height}%`;
			sp.style.setProperty("--mls-bg", `var(--mls-t${look.tone})`);
			sp.toggleClass("is-open", isOpen);
			sp.toggleClass("is-long", b.label.length > 16 || (look.style === "caps" && b.label.length > 12));
			sp.toggleClass("is-dim", !!q && !match);
			sp.toggleClass("is-hit", !!q && match);
			if (isFresh(b.updated, today)) {
				sp.addClass("is-fresh");
				sp.createSpan({ cls: "mls-ribbon" });
			}
			sp.createSpan({ cls: "mls-spine-title", text: b.label });
			sp.createSpan({ cls: "mls-spine-foot", text: String(b.articles.length) });
			h.tip(sp, b.summary ? `${b.label} — ${b.summary}` : b.label);
			sp.addEventListener("click", () => h.setState({ open: isOpen ? null : key(b), all: false }));
		}
		if (w.books.length) shelf.createSpan({ cls: "mls-bookend", attr: { "aria-hidden": "true" } });
		if (!w.books.length) shelf.createDiv({ cls: "mls-bare", text: "빈 칸" });
		bay.createDiv({ cls: "mls-plank" });
		row.toggleClass("is-quiet", !!q && hits === 0);

		if (opened) renderOpen(row.createDiv({ cls: "mls-open" }), opened, w, state, h);
	});
}

function renderOpen(el: HTMLElement, b: ShelfBook, w: ShelfWiki, state: ShelfState, h: ShelfHandlers): void {
	const look = spineLook(b.slug, b.articles.length);
	const cover = el.createDiv({ cls: `mls-cover mls-mark-${look.mark}` });
	cover.style.setProperty("--mls-bg", `var(--mls-t${look.tone})`);
	cover.createDiv({ cls: "mls-cover-series", text: w.name });
	cover.createDiv({ cls: `mls-cover-title mls-${look.style}`, text: b.label });
	cover.createDiv({ cls: "mls-cover-rule" });
	cover.createDiv({ cls: "mls-cover-foot", text: `${b.articles.length}편` });

	const body = el.createDiv({ cls: "mls-open-body" });
	const kicker = body.createDiv({ cls: "mls-kicker" });
	kicker.createSpan({ text: w.name });
	if (b.updated) kicker.createSpan({ text: `${fmtDate(b.updated)} 갱신` });
	body.createEl("h2", { cls: "mls-open-title", text: b.label });
	if (b.summary) body.createEl("p", { cls: "mls-open-summary", text: b.summary });

	const kinds = body.createDiv({ cls: "mls-kinds" });
	for (const k of KIND_ORDER) {
		const c = b.articles.filter((a) => a.kind === k).length;
		if (!c) continue;
		const chip = kinds.createDiv({ cls: "mls-kind" });
		chip.createSpan({ cls: "mls-kind-n", text: String(c) });
		chip.createSpan({ cls: "mls-kind-t", text: KIND_LABEL[k] });
	}

	const sorted = sortArticles(b.articles);
	const list = body.createDiv({ cls: "mls-list" });
	if (!sorted.length) list.createDiv({ cls: "mls-list-empty", text: "아직 글이 없어요" });
	const item = (parent: HTMLElement, a: (typeof sorted)[number], withKind: boolean) => {
		const li = parent.createEl("button", { cls: "mls-item", attr: { type: "button" } });
		li.createSpan({ cls: "mls-item-title", text: a.title });
		if (withKind) li.createSpan({ cls: "mls-item-kind", text: KIND_LABEL[a.kind] });
		li.createSpan({ cls: "mls-item-date", text: fmtDate(a.updated) });
		li.addEventListener("click", () => h.openFile(a.path));
	};
	if (state.all) {
		for (const k of KIND_ORDER) {
			const group = sorted.filter((a) => a.kind === k);
			if (!group.length) continue;
			list.createDiv({ cls: "mls-list-head", text: `${KIND_LABEL[k]} ${group.length}` });
			for (const a of group) item(list, a, false);
		}
	} else if (sorted.length) {
		list.createDiv({ cls: "mls-list-head", text: "최근 글" });
		for (const a of sorted.slice(0, RECENT)) item(list, a, true);
	}

	const actions = body.createDiv({ cls: "mls-actions" });
	actions.createEl("button", { cls: "mls-btn mls-btn-primary", text: "목차 펼치기", attr: { type: "button" } }).addEventListener("click", () => h.openFile(b.path));
	if (sorted.length > RECENT || state.all) {
		actions
			.createEl("button", { cls: "mls-btn", text: state.all ? "최근 글만" : `모든 글 ${sorted.length}편`, attr: { type: "button" } })
			.addEventListener("click", () => h.setState({ all: !state.all }));
	}
	const close = el.createEl("button", { cls: "mls-close", text: "×", attr: { type: "button", "aria-label": "책 꽂기" } });
	close.addEventListener("click", () => h.setState({ open: null, all: false }));
}
