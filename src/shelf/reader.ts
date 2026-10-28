/**
 * Shelf 읽기 화면 (e-book): a wiki note laid out in pages that turn sideways, inside the Shelf view.
 *
 *   stage    CSS columns over a fixed-height box; one page (narrow) or a two-page spread (wide)
 *   turning  ← → / PageUp PageDown / Space, the outer edges of the page, a swipe. Past the last page
 *            the next article of the book opens on its first page (and back, on its last page).
 *   chrome   the top bar shows near the top edge or on a tap in the middle, and hides while reading
 *   panels   ☰ 목차 (left) and ⓘ 정보 (right: kind, date, 출처 · 원본 자료 · 관련 글, 원본 열기), each
 *            on or off and remembered. 본문만 is the default.
 *   theme    자동 (follows Obsidian) · 종이 · 밤, three text sizes, 넘김 책장 (page curl, the default) or
 *            밀기 (slide; also when the system asks for reduced motion), remembered.
 *
 * Markdown rendering and link resolution come from the view (Obsidian), so this file stays DOM only.
 */

import { PageFlip } from "page-flip/dist/js/page-flip.module.js";
import { KIND_LABEL, KIND_ORDER, seriesOf, spineLook, splitTitle, type ShelfArticle, type ShelfBook, type ShelfWiki } from "./model.ts";

export type ReaderTheme = "auto" | "paper" | "night";
/** 책장: the page curls under the finger (StPageFlip). 밀기: the spread slides. */
export type ReaderFlip = "curl" | "slide";

export interface ReaderPrefs {
	theme: ReaderTheme;
	/** 0 작게 · 1 보통 · 2 크게 */
	size: number;
	toc: boolean;
	info: boolean;
	flip: ReaderFlip;
}

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
	prefs: ReaderPrefs;
	/** Obsidian is in dark mode (the 자동 theme). */
	dark: boolean;
	/** Open on the first page, the last (turning back from the next article), or at a fraction (re-layout). */
	startAt: "first" | "last" | number;
}

export interface ReaderHandlers {
	read(path: string, startAt?: "first" | "last"): void;
	back(): void;
	openSource(path: string): void;
	setPrefs(patch: Partial<ReaderPrefs>): void;
	/** Internal link clicked in the body (`data-href` of Obsidian's rendered links). */
	follow(href: string, from: string): void;
	renderMarkdown(md: string, el: HTMLElement, sourcePath: string): Promise<void>;
	tip(el: HTMLElement, text: string): void;
}

export interface ReaderControl {
	/** Keyboard turning; returns true when the key was used. */
	key(e: KeyboardEvent): boolean;
	/** Re-measure (view resized). */
	layout(): void;
	/** Where the reader is, 0–1 (kept across a re-render). */
	fraction(): number;
	destroy(): void;
}

const SIZES = [16, 17.5, 19];
const THEME_LABEL: Record<ReaderTheme, string> = { auto: "자동", paper: "종이", night: "밤" };
const SPREAD_MIN = 880;

function fmtDate(iso: string): string {
	return iso ? iso.replace(/-/g, ". ") : "";
}

export function renderReader(root: HTMLElement, c: ReaderCtx, h: ReaderHandlers): ReaderControl {
	root.empty();
	const s = seriesOf(c.wikiIndex);
	const theme = c.prefs.theme === "auto" ? (c.dark ? "night" : "paper") : c.prefs.theme;
	const wrap = root.createDiv({ cls: `mls-reader mls-theme-${theme}` });
	wrap.style.setProperty("--mls-ink", s.ink);
	wrap.style.setProperty("--mls-accent", s.accent);
	s.tones.forEach((t, j) => wrap.style.setProperty(`--mls-t${j}`, t));
	wrap.style.setProperty("--mls-text", `${SIZES[c.prefs.size] ?? SIZES[1]}px`);
	wrap.toggleClass("has-toc", c.prefs.toc && !!c.book);
	wrap.toggleClass("has-info", c.prefs.info);

	const i = c.order.findIndex((a) => a.path === c.doc.path);
	const isMoc = !!c.book && c.book.path === c.doc.path;
	const prevDoc = i > 0 ? c.order[i - 1] : null;
	const nextDoc = isMoc ? c.order[0] ?? null : i >= 0 && i < c.order.length - 1 ? c.order[i + 1] : null;

	// ── top bar ──
	const top = wrap.createDiv({ cls: "mls-rtop" });
	const crumbs = top.createDiv({ cls: "mls-crumbs" });
	const crumb = (text: string, fn: () => void) => crumbs.createEl("button", { cls: "mls-crumb", text, attr: { type: "button" } }).addEventListener("click", fn);
	crumb("Shelf", () => h.back());
	crumbs.createSpan({ cls: "mls-crumb-sep", text: "/" });
	crumbs.createSpan({ cls: "mls-crumb-here mls-crumb-wiki", text: c.wiki.name });
	if (c.book) {
		crumbs.createSpan({ cls: "mls-crumb-sep", text: "/" });
		crumb(c.book.label, () => h.read(c.book!.path));
	}
	const tools = top.createDiv({ cls: "mls-rtools" });
	const tool = (text: string, on: boolean, hint: string, fn: () => void) => {
		const b = tools.createEl("button", { cls: "mls-tool", text, attr: { type: "button", "aria-pressed": String(on) } });
		b.toggleClass("is-on", on);
		h.tip(b, hint);
		b.addEventListener("click", fn);
		return b;
	};
	if (c.book) tool("목차", c.prefs.toc, "왼쪽에 이 책의 글 목록", () => h.setPrefs({ toc: !c.prefs.toc }));
	tool("정보", c.prefs.info, "오른쪽에 출처 · 관련 글", () => h.setPrefs({ info: !c.prefs.info }));
	const aa = tool("Aa", false, "테마 · 글자 크기", () => menu.toggleClass("is-open", !menu.hasClass("is-open")));
	aa.addClass("mls-tool-aa");
	const close = tools.createEl("button", { cls: "mls-close", text: "×", attr: { type: "button", "aria-label": "책장으로" } });
	close.addEventListener("click", () => h.back());

	const menu = top.createDiv({ cls: "mls-aa" });
	const seg = (label: string, opts: { text: string; on: boolean; fn: () => void }[]) => {
		const row = menu.createDiv({ cls: "mls-aa-row" });
		row.createDiv({ cls: "mls-aa-label", text: label });
		const g = row.createDiv({ cls: "mls-aa-seg" });
		for (const o of opts) {
			const b = g.createEl("button", { cls: "mls-aa-btn", text: o.text, attr: { type: "button" } });
			b.toggleClass("is-on", o.on);
			b.addEventListener("click", o.fn);
		}
	};
	seg("테마", (["auto", "paper", "night"] as ReaderTheme[]).map((t) => ({ text: THEME_LABEL[t], on: c.prefs.theme === t, fn: () => h.setPrefs({ theme: t }) })));
	seg("글자", ["작게", "보통", "크게"].map((t, n) => ({ text: t, on: c.prefs.size === n, fn: () => h.setPrefs({ size: n }) })));
	seg("넘김", (["curl", "slide"] as ReaderFlip[]).map((f) => ({ text: f === "curl" ? "책장" : "밀기", on: c.prefs.flip === f, fn: () => h.setPrefs({ flip: f }) })));

	// ── panels ──
	const body = wrap.createDiv({ cls: "mls-rbody" });
	if (c.book && c.prefs.toc) renderToc(body.createEl("nav", { cls: "mls-panel mls-toc", attr: { "aria-label": "목차" } }), c, h);

	const stage = body.createDiv({ cls: "mls-stage" });
	if (c.prefs.info) renderInfo(body.createEl("aside", { cls: "mls-panel mls-info", attr: { "aria-label": "정보" } }), c, h, prevDoc, nextDoc);

	const viewport = stage.createDiv({ cls: "mls-viewport" });
	const flow = viewport.createDiv({ cls: "mls-flow" });
	const head = flow.createDiv({ cls: "mls-chapter" });
	const kick = head.createDiv({ cls: "mls-page-kicker" });
	kick.createSpan({ text: c.doc.kicker });
	if (c.doc.updated) kick.createSpan({ text: fmtDate(c.doc.updated) });
	const t = splitTitle(c.doc.title);
	head.createEl("h1", { cls: "mls-page-title", text: t.main });
	if (t.sub) head.createDiv({ cls: "mls-page-sub", text: t.sub });
	head.createDiv({ cls: "mls-page-rule" });
	const text = flow.createDiv({ cls: "mls-page-body markdown-rendered" });
	const end = flow.createDiv({ cls: "mls-end" });
	end.createDiv({ cls: "mls-end-mark", text: "◆" });
	if (nextDoc) {
		const nb = end.createEl("button", { cls: "mls-end-next", attr: { type: "button", "data-read": nextDoc.path } });
		nb.createSpan({ cls: "mls-end-k", text: "다음 글" });
		nb.createSpan({ cls: "mls-end-t", text: nextDoc.title });
	} else if (c.book) {
		end.createDiv({ cls: "mls-end-k", text: `「${c.book.label}」 끝` });
	}
	// Links and 「다음 글」 by delegation: the 책장 mode shows clones of the text.
	stage.addEventListener("click", (e) => {
		const el = e.target as HTMLElement;
		const r = el.closest<HTMLElement>("[data-read]");
		if (r?.dataset.read) {
			e.preventDefault();
			e.stopPropagation();
			return h.read(r.dataset.read);
		}
		const a = el.closest("a.internal-link");
		if (!a) return;
		e.preventDefault();
		e.stopPropagation();
		h.follow(a.getAttribute("data-href") ?? a.getAttribute("href") ?? "", c.doc.path);
	}, true);

	const folio = stage.createDiv({ cls: "mls-folio" });
	const folioL = folio.createSpan({ cls: "mls-folio-l" });
	const folioR = folio.createSpan({ cls: "mls-folio-r" });
	const bar = stage.createDiv({ cls: "mls-progress" });
	const fill = bar.createDiv({ cls: "mls-progress-fill" });
	const count = stage.createDiv({ cls: "mls-count" });
	const edgeL = stage.createEl("button", { cls: "mls-edge mls-edge-l", attr: { type: "button", "aria-label": "이전 쪽" } });
	const edgeR = stage.createEl("button", { cls: "mls-edge mls-edge-r", attr: { type: "button", "aria-label": "다음 쪽" } });

	const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	const curl = c.prefs.flip === "curl" && !reduce;
	wrap.toggleClass("is-curl", curl);

	// ── paging ──
	let per = 1;
	let pages = 1;
	/** 밀기: the spread shown. 책장: the page index (left page of a spread). */
	let at = 0;
	let ready = false;
	let book: PageFlip | null = null;
	let bookEl: HTMLElement | null = null;
	let lastSize = "";
	const total = () => (curl ? Math.max(1, book?.getPageCount() ?? pages) : Math.max(1, Math.ceil(pages / per)));
	const fraction = () => {
		const n = total();
		return n <= 1 ? 0 : (curl ? Math.min(at, n - 1) : at) / (n - 1);
	};
	const atStart = () => at <= 0;
	const atEnd = () => (curl ? at + per >= total() : at >= total() - 1);
	const show = () => {
		const first = curl ? at + 1 : at * per + 1;
		const last = Math.min(pages, first + per - 1);
		fill.style.width = `${Math.round(fraction() * 100)}%`;
		count.setText(`${Math.min(pages, last)} / ${pages}`);
		edgeL.toggleClass("is-off", atStart() && !prevDoc);
		edgeR.toggleClass("is-off", atEnd() && !nextDoc);
		if (!curl) {
			flow.style.transform = `translateX(${-at * stepPx}px)`;
			folioL.setText(String(first));
			folioR.setText(per === 2 && first + 1 <= pages ? String(first + 1) : "");
		}
	};
	/** Columns the text fills at this page box (the end block's right edge). */
	const countPages = (pageW: number, gap: number) => {
		const keep = flow.style.transform;
		flow.style.transform = "none";
		const f = flow.getBoundingClientRect();
		const e = end.getBoundingClientRect();
		flow.style.transform = keep;
		return Math.max(1, Math.round((e.right - f.left + gap) / (pageW + gap)));
	};
	const startIndex = (keep: "first" | "last" | "same" | number, n: number, before: number) => {
		const frac = typeof keep === "number" ? keep : before;
		return keep === "first" ? 0 : keep === "last" ? n - 1 : Math.min(n - 1, Math.round(frac * (n - 1)) || 0);
	};

	// 밀기: one flow box, translated by a spread.
	let stepPx = 0;
	const measureSlide = (keep: "first" | "last" | "same" | number) => {
		const w = stage.clientWidth;
		const hgt = stage.clientHeight;
		const narrow = w < SPREAD_MIN;
		per = narrow ? 1 : 2;
		const gap = narrow ? 48 : 112;
		const padX = narrow ? 24 : 56;
		const pageW = Math.min(narrow ? 620 : 520, Math.floor((w - padX * 2 - gap * (per - 1)) / per));
		const vw = pageW * per + gap * (per - 1);
		const vh = Math.max(240, hgt - (narrow ? 120 : 150));
		wrap.style.setProperty("--mls-page-h", `${vh}px`);
		wrap.style.setProperty("--mls-vw", `${vw}px`);
		wrap.style.setProperty("--mls-gutter", `${gap}px`);
		wrap.toggleClass("is-spread", per === 2);
		viewport.style.width = `${vw}px`;
		viewport.style.height = `${vh}px`;
		flow.style.width = `${vw}px`;
		flow.style.height = `${vh}px`;
		flow.style.columnCount = String(per);
		flow.style.columnGap = `${gap}px`;
		stepPx = vw + gap;
		const before = fraction();
		pages = countPages(Math.floor((vw - gap * (per - 1)) / per), gap);
		at = startIndex(keep, total(), before);
		show();
	};

	// 책장: the text cut into page leaves; StPageFlip turns them (drag a corner, swipe, or a key).
	const buildCurl = (keep: "first" | "last" | "same" | number) => {
		const w = stage.clientWidth;
		const hgt = stage.clientHeight;
		const narrow = w < SPREAD_MIN;
		per = narrow ? 1 : 2;
		const outerW = narrow ? Math.min(w, 640) : Math.min(600, Math.floor((w - 96) / 2));
		const outerH = narrow ? hgt - 30 : Math.min(hgt - 64, Math.round(outerW * 1.5));
		const padX = narrow ? 26 : 50;
		const padT = narrow ? 38 : 54;
		const padB = narrow ? 54 : 64;
		const pageW = outerW - padX * 2;
		const pageH = Math.max(200, outerH - padT - padB);
		const gap = 64;
		wrap.style.setProperty("--mls-page-h", `${pageH}px`);
		wrap.toggleClass("is-spread", per === 2);
		// Measure in the hidden flow, one page per column.
		viewport.addClass("is-measure");
		viewport.style.width = `${pageW}px`;
		viewport.style.height = `${pageH}px`;
		flow.style.width = `${pageW}px`;
		flow.style.height = `${pageH}px`;
		flow.style.columnCount = "1";
		flow.style.columnGap = `${gap}px`;
		flow.style.transform = "none";
		const before = fraction();
		pages = countPages(pageW, gap);
		const n = per === 2 && pages % 2 ? pages + 1 : pages;

		book?.destroy();
		bookEl?.remove();
		bookEl = stage.createDiv({ cls: "mls-book" });
		bookEl.style.width = `${outerW * per}px`;
		const leaves: HTMLElement[] = [];
		for (let k = 0; k < n; k++) {
			const leaf = bookEl.createDiv({ cls: `mls-leaf${per === 2 ? (k % 2 ? " is-right" : " is-left") : ""}` });
			const box = leaf.createDiv({ cls: "mls-leaf-box" });
			box.style.cssText = `left:${padX}px;top:${padT}px;width:${pageW}px;height:${pageH}px;`;
			if (k < pages) {
				const copy = flow.cloneNode(true) as HTMLElement;
				copy.style.transform = `translateX(${-k * (pageW + gap)}px)`;
				copy.style.transition = "none";
				box.appendChild(copy);
				leaf.createDiv({ cls: "mls-leaf-folio", text: String(k + 1) });
			}
			leaves.push(leaf);
		}
		book = new PageFlip(bookEl, {
			width: outerW,
			height: outerH,
			size: "fixed",
			minWidth: outerW,
			maxWidth: outerW,
			minHeight: outerH,
			maxHeight: outerH,
			usePortrait: true,
			showCover: false,
			drawShadow: true,
			maxShadowOpacity: 0.32,
			flippingTime: 780,
			mobileScrollSupport: false,
			swipeDistance: 24,
			disableFlipByClick: true,
			showPageCorners: true,
			clickEventForward: true,
			startPage: 0,
			startZIndex: 0,
			autoSize: true,
			useMouseEvents: true,
		} as never);
		book.loadFromHTML(leaves);
		const idx = startIndex(keep, n, before);
		at = per === 2 ? idx - (idx % 2) : idx;
		if (at) book.turnToPage(at);
		book.on("flip", (e) => {
			at = Number(e.data) || 0;
			show();
		});
		const margin = (w - outerW * per) / 2;
		edgeL.style.width = edgeR.style.width = `${Math.max(0, margin)}px`;
		wrap.toggleClass("no-edges", margin < 40);
		show();
	};

	const measure = (keep: "first" | "last" | "same" | number) => {
		const w = stage.clientWidth;
		const hgt = stage.clientHeight;
		if (!w || !hgt) return;
		lastSize = `${w}x${hgt}`;
		if (curl) buildCurl(keep);
		else measureSlide(keep);
	};
	const go = (d: number) => {
		if (!ready) return;
		if (d < 0 && atStart()) return void (prevDoc && h.read(prevDoc.path, "last"));
		if (d > 0 && atEnd()) return void (nextDoc && h.read(nextDoc.path, "first"));
		if (curl) {
			if (d > 0) book?.flipNext("top" as never);
			else book?.flipPrev("top" as never);
			return;
		}
		at += d;
		show();
	};
	edgeL.addEventListener("click", () => go(-1));
	edgeR.addEventListener("click", () => go(1));

	// 가운데 탭: 위 막대 보이기 / 숨기기 (끌어서 넘긴 뒤의 클릭은 빼고). 위쪽 가장자리에 마우스가 오면 보인다.
	let hideT = 0;
	const chrome = (on: boolean) => {
		wrap.toggleClass("is-chrome", on);
		window.clearTimeout(hideT);
		if (on) hideT = window.setTimeout(() => {
			if (!top.matches(":hover") && !menu.hasClass("is-open")) wrap.removeClass("is-chrome");
		}, 2600);
	};
	let px = 0;
	let py = 0;
	stage.addEventListener("pointerdown", (e) => {
		px = e.clientX;
		py = e.clientY;
	});
	stage.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).closest("a, button")) return;
		if (Math.hypot(e.clientX - px, e.clientY - py) > 6) return;
		const r = stage.getBoundingClientRect();
		const x = (e.clientX - r.left) / r.width;
		if (curl && (x < 0.2 || x > 0.8)) return;
		chrome(!wrap.hasClass("is-chrome"));
	});
	wrap.addEventListener("mousemove", (e) => {
		if (e.clientY - wrap.getBoundingClientRect().top < 72) chrome(true);
	});
	top.addEventListener("mouseleave", () => chrome(true));

	// 밀기 mode swipe (책장 mode: the page follows the finger).
	let sx = 0;
	let sy = 0;
	stage.addEventListener("touchstart", (e) => {
		sx = e.touches[0].clientX;
		sy = e.touches[0].clientY;
	}, { passive: true });
	stage.addEventListener("touchend", (e) => {
		const dx = e.changedTouches[0].clientX - sx;
		const dy = e.changedTouches[0].clientY - sy;
		if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
		if (!curl) return go(dx < 0 ? 1 : -1);
		// At the first / last page the book does not turn: go on to the neighbour article.
		if (dx < 0 && atEnd() && nextDoc) h.read(nextDoc.path, "first");
		else if (dx > 0 && atStart() && prevDoc) h.read(prevDoc.path, "last");
	}, { passive: true });

	let rt = 0;
	const ro = new ResizeObserver(() => {
		if (!ready || `${stage.clientWidth}x${stage.clientHeight}` === lastSize) return;
		window.clearTimeout(rt);
		rt = window.setTimeout(() => measure("same"), 180);
	});
	ro.observe(stage);
	chrome(true);
	void h.renderMarkdown(c.doc.body, text, c.doc.path).then(async () => {
		await document.fonts?.ready;
		const imgs = [...text.querySelectorAll("img")].filter((i) => !i.complete);
		await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => i.addEventListener("load", r, { once: true })))), new Promise((r) => window.setTimeout(r, 1500))]);
		ready = true;
		measure(c.startAt);
	});

	return {
		key: (e) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return false;
			if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) go(1);
			else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) go(-1);
			else if (e.key === "Escape") {
				if (menu.hasClass("is-open")) menu.removeClass("is-open");
				else h.back();
			} else return false;
			return true;
		},
		layout: () => ready && measure("same"),
		fraction,
		destroy: () => {
			ro.disconnect();
			window.clearTimeout(hideT);
			window.clearTimeout(rt);
			book?.destroy();
			book = null;
		},
	};
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

function renderInfo(el: HTMLElement, c: ReaderCtx, h: ReaderHandlers, prev: ShelfArticle | null, next: ShelfArticle | null): void {
	const facts = el.createDiv({ cls: "mls-info-facts" });
	const fact = (k: string, v: string) => {
		if (!v) return;
		const r = facts.createDiv({ cls: "mls-info-fact" });
		r.createSpan({ cls: "mls-info-k", text: k });
		r.createSpan({ cls: "mls-info-v", text: v });
	};
	fact("종류", c.doc.kicker);
	fact("갱신", fmtDate(c.doc.updated));
	fact("책", c.book ? `${c.wiki.name} · ${c.book.label}` : c.wiki.name);
	const i = c.order.findIndex((a) => a.path === c.doc.path);
	if (i >= 0) fact("순서", `${i + 1} / ${c.order.length}`);

	for (const g of c.refs.filter((x) => x.items.length)) {
		el.createDiv({ cls: "mls-info-head", text: `${g.label} ${g.items.length}` });
		const list = el.createDiv({ cls: "mls-info-list" });
		for (const it of g.items) list.createEl("button", { cls: "mls-info-ref", text: it.title, attr: { type: "button" } }).addEventListener("click", () => h.read(it.path));
	}
	const nav = el.createDiv({ cls: "mls-info-nav" });
	if (prev) nav.createEl("button", { cls: "mls-info-ref", text: `← ${prev.title}`, attr: { type: "button" } }).addEventListener("click", () => h.read(prev.path));
	if (next) nav.createEl("button", { cls: "mls-info-ref", text: `${next.title} →`, attr: { type: "button" } }).addEventListener("click", () => h.read(next.path));
	el.createEl("button", { cls: "mls-btn mls-info-src", text: "원본 열기", attr: { type: "button" } }).addEventListener("click", () => h.openSource(c.doc.path));
}
