/**
 * Shelf 읽기 화면: a wiki note read like a book page, inside the Shelf view.
 *   breadcrumb · 목차 (the book's articles) · page (kicker, title, rendered body, 출처 · 관련 글, 이전 / 다음)
 * Markdown rendering and link resolution come from the view (Obsidian), so this file stays DOM only.
 */

import { KIND_LABEL, KIND_ORDER, seriesOf, spineLook, splitTitle, type ShelfArticle, type ShelfBook, type ShelfWiki } from "./model.ts";

export interface ReaderDoc {
	path: string;
	title: string;
	/** 개념 · 자료 · 목차 · 원본 자료 … */
	kicker: string;
	updated: string;
	body: string;
}

export interface RefGroup {
	label: string;
	items: { title: string; path: string }[];
}

export interface ReaderCtx {
	wiki: ShelfWiki;
	wikiIndex: number;
	book: ShelfBook | null;
	order: ShelfArticle[];
	doc: ReaderDoc;
	refs: RefGroup[];
	tocOpen: boolean;
}

export interface ReaderHandlers {
	read(path: string): void;
	back(): void;
	openSource(path: string): void;
	toggleToc(): void;
	/** Internal link clicked in the body (`data-href` of Obsidian's rendered links). */
	follow(href: string, from: string): void;
	renderMarkdown(md: string, el: HTMLElement, sourcePath: string): Promise<void>;
	tip(el: HTMLElement, text: string): void;
}

function fmtDate(iso: string): string {
	return iso ? iso.replace(/-/g, ". ") : "";
}

export function renderReader(root: HTMLElement, c: ReaderCtx, h: ReaderHandlers): void {
	root.empty();
	const s = seriesOf(c.wikiIndex);
	const wrap = root.createDiv({ cls: "mls-reader" });
	wrap.style.setProperty("--mls-ink", s.ink);
	wrap.style.setProperty("--mls-accent", s.accent);
	s.tones.forEach((t, j) => wrap.style.setProperty(`--mls-t${j}`, t));
	wrap.toggleClass("is-toc-open", c.tocOpen);

	// 위: Shelf › 위키 › 책 · 목차(폰) · 원본 열기 · ×
	const bar = wrap.createDiv({ cls: "mls-rbar" });
	const crumbs = bar.createDiv({ cls: "mls-crumbs" });
	const crumb = (text: string, fn: () => void) => crumbs.createEl("button", { cls: "mls-crumb", text, attr: { type: "button" } }).addEventListener("click", fn);
	crumb("Shelf", () => h.back());
	crumbs.createSpan({ cls: "mls-crumb-sep", text: "/" });
	crumbs.createSpan({ cls: "mls-crumb-here", text: c.wiki.name });
	if (c.book) {
		crumbs.createSpan({ cls: "mls-crumb-sep", text: "/" });
		crumb(c.book.label, () => h.read(c.book!.path));
	}
	const tools = bar.createDiv({ cls: "mls-rtools" });
	if (c.book) {
		const t = tools.createEl("button", { cls: "mls-btn mls-toc-btn", text: "목차", attr: { type: "button" } });
		t.addEventListener("click", () => h.toggleToc());
	}
	const src = tools.createEl("button", { cls: "mls-btn", text: "원본 열기", attr: { type: "button" } });
	h.tip(src, "편집기에서 이 글을 열어요");
	src.addEventListener("click", () => h.openSource(c.doc.path));
	const close = tools.createEl("button", { cls: "mls-close", text: "×", attr: { type: "button", "aria-label": "책장으로" } });
	close.addEventListener("click", () => h.back());

	const grid = wrap.createDiv({ cls: "mls-rgrid" });
	if (c.book) renderToc(grid.createEl("nav", { cls: "mls-toc", attr: { "aria-label": "목차" } }), c, h);

	const page = grid.createEl("article", { cls: "mls-page" });
	const kick = page.createDiv({ cls: "mls-page-kicker" });
	kick.createSpan({ text: c.doc.kicker });
	if (c.doc.updated) kick.createSpan({ text: fmtDate(c.doc.updated) });
	const t = splitTitle(c.doc.title);
	page.createEl("h1", { cls: "mls-page-title", text: t.main });
	if (t.sub) page.createDiv({ cls: "mls-page-sub", text: t.sub });
	page.createDiv({ cls: "mls-page-rule" });

	const body = page.createDiv({ cls: "mls-page-body markdown-rendered" });
	body.addEventListener("click", (e) => {
		const a = (e.target as HTMLElement).closest("a.internal-link");
		if (!a) return;
		e.preventDefault();
		e.stopPropagation();
		h.follow(a.getAttribute("data-href") ?? a.getAttribute("href") ?? "", c.doc.path);
	});
	void h.renderMarkdown(c.doc.body, body, c.doc.path);

	const refs = c.refs.filter((g) => g.items.length);
	if (refs.length) {
		const foot = page.createDiv({ cls: "mls-refs" });
		for (const g of refs) {
			const row = foot.createDiv({ cls: "mls-ref-row" });
			row.createDiv({ cls: "mls-ref-label", text: g.label });
			const list = row.createDiv({ cls: "mls-ref-list" });
			for (const it of g.items) list.createEl("button", { cls: "mls-ref", text: it.title, attr: { type: "button" } }).addEventListener("click", () => h.read(it.path));
		}
	}

	const i = c.order.findIndex((a) => a.path === c.doc.path);
	const prev = i > 0 ? c.order[i - 1] : null;
	const next = i >= 0 && i < c.order.length - 1 ? c.order[i + 1] : c.book && i < 0 && c.order.length ? c.order[0] : null;
	if (prev || next) {
		const pager = page.createDiv({ cls: "mls-pager" });
		const cell = (a: ShelfArticle | null, dir: "prev" | "next") => {
			if (!a) return pager.createDiv({ cls: "mls-pager-gap" });
			const b = pager.createEl("button", { cls: `mls-pager-${dir}`, attr: { type: "button" } });
			b.createSpan({ cls: "mls-pager-dir", text: dir === "prev" ? "← 이전 글" : "다음 글 →" });
			b.createSpan({ cls: "mls-pager-title", text: a.title });
			b.addEventListener("click", () => h.read(a.path));
			return b;
		};
		cell(prev, "prev");
		cell(next, "next");
	}
}

function renderToc(nav: HTMLElement, c: ReaderCtx, h: ReaderHandlers): void {
	const b = c.book!;
	const look = spineLook(b.slug, b.articles.length);
	const head = nav.createEl("button", { cls: `mls-toc-book mls-mark-${look.mark}`, attr: { type: "button" } });
	head.style.setProperty("--mls-bg", `var(--mls-t${look.tone})`);
	head.toggleClass("is-current", c.doc.path === b.path);
	head.createSpan({ cls: "mls-toc-book-series", text: c.wiki.name });
	head.createSpan({ cls: "mls-toc-book-title", text: b.label });
	head.createSpan({ cls: "mls-toc-book-foot", text: `${b.articles.length}편 · 목차` });
	head.addEventListener("click", () => h.read(b.path));
	for (const k of KIND_ORDER) {
		const group = c.order.filter((a) => a.kind === k);
		if (!group.length) continue;
		nav.createDiv({ cls: "mls-toc-head", text: `${KIND_LABEL[k]} ${group.length}` });
		for (const a of group) {
			const it = nav.createEl("button", { cls: "mls-toc-item", text: a.title, attr: { type: "button" } });
			if (a.path === c.doc.path) {
				it.addClass("is-current");
				it.setAttr("aria-current", "page");
			}
			it.addEventListener("click", () => h.read(a.path));
		}
	}
	window.requestAnimationFrame(() => nav.querySelector<HTMLElement>(".mls-toc-item.is-current")?.scrollIntoView({ block: "nearest" }));
}
