/**
 * Shelf view (`mylogs-shelf`): `07 Shelf/` as a bookcase. 칸 = wiki, 책 = domain MOC, width = 글 수.
 * Read only: a book pulls out to its summary, article counts and recent articles; titles open the
 * 읽기 화면 (`reader.ts`) inside this view — 「원본 열기」 is the only way to the editor.
 * Creating 칸 / 책 is not decided yet (계획 「Shelf」).
 */

import { Component, debounce, ItemView, MarkdownRenderer, moment, normalizePath, type TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { articlePlace, articleTitle, bookLabel, countInbox, isoDate, KIND_LABEL, nameList, parseShelfMap, readerBody, readingOrder, type ShelfArticle, type ShelfBook, type ShelfWiki, summaryOf, tagList } from "./model.ts";
import { type ReaderControl, type ReaderPrefs, type ReaderTheme, renderReader, type RefGroup } from "./reader.ts";
import { renderShelf, type ShelfState } from "./render.ts";

export const VIEW_TYPE_SHELF = "mylogs-shelf";

/** The book face (Noto Serif KR). Offline, the stack falls back to the system serif. */
function loadSerif(): void {
	if (document.getElementById("mylogs-shelf-serif")) return;
	document.head.createEl("link", {
		attr: { id: "mylogs-shelf-serif", rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;500;600;700&display=swap" },
	});
}

export class ShelfView extends ItemView {
	plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private wikis: ShelfWiki[] = [];
	private state: ShelfState = { query: "", open: null, all: false };
	/** The note in the 읽기 화면 (null = the bookcase). */
	private reading: string | null = null;
	/** The book the reader came from (a link to a note outside it keeps this 목차). */
	private readingBook: ShelfBook | null = null;
	private startAt: "first" | "last" = "first";
	private md: Component | null = null;
	private reader: ReaderControl | null = null;
	private seq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_SHELF;
	}
	getDisplayText(): string {
		return "Shelf";
	}
	getIcon(): string {
		return "library";
	}

	private folder(): string {
		return (this.plugin.settings.shelfPath || "07 Shelf").replace(/^\/+|\/+$/g, "");
	}
	private mapPath(): string {
		return normalizePath(`${this.folder()}/Shelf.md`);
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-shelf-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-shelf" });
		loadSerif();
		mountAppNav(this);
		const later = debounce(() => void this.refresh(), 500, true);
		const watch = (f: TAbstractFile, old?: string) => {
			if (![f.path, old ?? ""].some((p) => p.startsWith(this.folder() + "/"))) return;
			if (this.reading && f.path === this.reading) void this.drawReader(true);
			later();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("create", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => watch(f, old)));
		// 쪽 넘기기: arrows / PageUp PageDown / Space while this view is the active one.
		this.registerDomEvent(window, "keydown", (e) => {
			if (!this.reader || this.app.workspace.getActiveViewOfType(ShelfView) !== this) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
			if (this.reader.key(e)) e.preventDefault();
		});
		// 자동 테마 follows Obsidian's light / dark.
		this.registerEvent(this.app.workspace.on("css-change", () => {
			if (this.reading && this.prefs().theme === "auto") void this.drawReader();
		}));
		await this.refresh();
		// Frontmatter is not indexed yet on a cold start.
		this.app.workspace.onLayoutReady(() => later());
	}

	async onClose(): Promise<void> {
		this.stopReader();
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		const seq = ++this.seq;
		const wikis = await this.readShelf();
		if (seq !== this.seq) return;
		this.wikis = wikis;
		// While reading, the bookcase updates quietly (no jump); it shows on 「Shelf」.
		if (!this.reading) this.draw();
	}

	private fm(f: TFile): Record<string, unknown> {
		return (this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) ?? {};
	}

	private async readShelf(): Promise<ShelfWiki[]> {
		const root = this.folder();
		const mapFile = this.app.vault.getAbstractFileByPath(this.mapPath());
		const mapText = mapFile instanceof TFile ? await this.app.vault.cachedRead(mapFile) : null;
		const rows = parseShelfMap(mapText);

		// Wikis = folders with a `wiki/` inside; `Shelf.md` order first, the rest after.
		const top = this.app.vault.getAbstractFileByPath(root);
		const folders = top instanceof TFolder ? top.children.filter((c): c is TFolder => c instanceof TFolder && c.children.some((g) => g instanceof TFolder && g.name === "wiki")) : [];
		const names = folders.map((f) => f.name);
		const ordered = [...rows.filter((r) => names.includes(r.name)), ...names.filter((n) => !rows.some((r) => r.name === n)).map((n) => ({ name: n, scope: "", keywords: "" }))];

		const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(root + "/"));
		const out: ShelfWiki[] = [];
		for (const r of ordered) {
			const base = `${root}/${r.name}/wiki/`;
			const books = new Map<string, ShelfBook>();
			const articles: { slug: string; a: ShelfArticle }[] = [];
			for (const f of files) {
				if (!f.path.startsWith(base)) continue;
				const rel = f.path.slice(base.length);
				const fm = this.fm(f);
				if (rel.startsWith("domains/") && rel.split("/").length === 2) {
					const slug = f.basename;
					const body = await this.app.vault.cachedRead(f);
					books.set(slug, {
						wiki: r.name,
						slug,
						label: bookLabel(slug, fm.label),
						summary: summaryOf(body, fm.summary),
						path: f.path,
						tags: tagList(fm.tags),
						articles: [],
						updated: isoDate(fm.updated) || isoDate(fm.created),
					});
					continue;
				}
				const place = articlePlace(rel);
				if (!place) continue;
				articles.push({ slug: place.slug, a: { title: articleTitle(f.basename, fm.title), path: f.path, kind: place.kind, updated: isoDate(fm.updated) || isoDate(fm.created) } });
			}
			for (const { slug, a } of articles) {
				const b = books.get(slug);
				if (!b) continue;
				b.articles.push(a);
				if (a.updated > b.updated) b.updated = a.updated;
			}
			const list = [...books.values()].sort((x, y) => y.articles.length - x.articles.length || x.label.localeCompare(y.label));
			out.push({ name: r.name, scope: r.scope, keywords: r.keywords, books: list, inbox: countInbox(mapText, r.name) });
		}
		return out;
	}

	private draw(): void {
		if (this.reading) {
			void this.drawReader();
			return;
		}
		this.stopReader();
		this.contentEl.removeClass("is-reading");
		this.rootEl.removeClass("is-reading");
		const focused = document.activeElement?.classList.contains("mls-search") ?? false;
		renderShelf(this.rootEl, this.wikis, this.state, moment().format("YYYY-MM-DD"), {
			read: (p) => void this.read(p),
			resume: this.resume(),
			openMap: () => void this.openSource(this.mapPath()),
			setState: (patch) => {
				this.state = { ...this.state, ...patch };
				this.draw();
			},
			tip: (el, text) => void tip(el, text),
		});
		if (focused) {
			const s = this.rootEl.querySelector<HTMLInputElement>(".mls-search");
			s?.focus();
			s?.setSelectionRange(s.value.length, s.value.length);
		}
	}

	/** 이어 읽기: the last note read, if it still exists. */
	private resume(): { title: string; path: string } | null {
		const p = this.plugin.settings.shelfLastRead;
		const f = p ? this.app.vault.getAbstractFileByPath(p) : null;
		if (!(f instanceof TFile)) return null;
		const a = this.findArticle(p);
		return { path: p, title: a?.title ?? this.bookOf(p)?.label ?? articleTitle(f.basename, this.fm(f).title) };
	}

	private findArticle(path: string): ShelfArticle | null {
		for (const w of this.wikis) for (const b of w.books) for (const a of b.articles) if (a.path === path) return a;
		return null;
	}

	/** The book whose MOC or article is `path`. */
	private bookOf(path: string): ShelfBook | null {
		for (const w of this.wikis) for (const b of w.books) if (b.path === path || b.articles.some((a) => a.path === path)) return b;
		return null;
	}

	private wikiOf(path: string): { wiki: ShelfWiki; index: number } | null {
		const i = this.wikis.findIndex((w) => path.startsWith(`${this.folder()}/${w.name}/`));
		return i >= 0 ? { wiki: this.wikis[i], index: i } : null;
	}

	private stopReader(): void {
		this.reader?.destroy();
		this.reader = null;
		this.md?.unload();
		this.md = null;
	}

	private prefs(): ReaderPrefs {
		const st = this.plugin.settings;
		const theme: ReaderTheme = st.shelfReaderTheme === "paper" || st.shelfReaderTheme === "night" ? st.shelfReaderTheme : "auto";
		return { theme, size: [0, 1, 2].includes(st.shelfReaderSize) ? st.shelfReaderSize : 1, toc: !!st.shelfReaderToc, info: !!st.shelfReaderInfo };
	}

	private setPrefs(p: Partial<ReaderPrefs>): void {
		const st = this.plugin.settings;
		if (p.theme !== undefined) st.shelfReaderTheme = p.theme;
		if (p.size !== undefined) st.shelfReaderSize = p.size;
		if (p.toc !== undefined) st.shelfReaderToc = p.toc;
		if (p.info !== undefined) st.shelfReaderInfo = p.info;
		void this.plugin.saveSettingsQuiet();
		void this.drawReader(true);
	}

	async read(path: string, startAt: "first" | "last" = "first"): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile) || !this.wikiOf(path)) return void this.openSource(path);
		this.reading = path;
		this.readingBook = this.bookOf(path) ?? (this.readingBook && this.wikiOf(this.readingBook.path)?.wiki === this.wikiOf(path)?.wiki ? this.readingBook : null);
		this.startAt = startAt;
		this.plugin.settings.shelfLastRead = path;
		void this.plugin.saveSettingsQuiet();
		await this.drawReader();
	}

	private back(): void {
		if (this.readingBook) this.state = { ...this.state, open: `${this.readingBook.wiki}/${this.readingBook.slug}`, all: false };
		this.reading = null;
		this.draw();
		this.contentEl.scrollTop = 0;
	}

	private async drawReader(keepPlace = false): Promise<void> {
		const path = this.reading;
		const f = path ? this.app.vault.getAbstractFileByPath(path) : null;
		const place = path ? this.wikiOf(path) : null;
		if (!path || !(f instanceof TFile) || !place) {
			this.reading = null;
			return this.draw();
		}
		const text = await this.app.vault.cachedRead(f);
		if (this.reading !== path) return;
		const fm = this.fm(f);
		const { title, body } = readerBody(text);
		const book = this.readingBook;
		const rel = path.slice(`${this.folder()}/${place.wiki.name}/`.length);
		const art = this.findArticle(path);
		const kicker = book && book.path === path ? "목차" : art ? KIND_LABEL[art.kind] : rel.startsWith("raw/") ? "원본 자료" : "위키";
		const startAt = keepPlace && this.reader ? this.reader.fraction() : this.startAt;
		this.stopReader();
		const md = (this.md = this.addChild(new Component()));
		this.contentEl.addClass("is-reading");
		this.rootEl.addClass("is-reading");
		this.contentEl.scrollTop = 0;
		this.reader = renderReader(
			this.rootEl,
			{
				wiki: place.wiki,
				wikiIndex: place.index,
				book,
				order: book ? readingOrder(book) : [],
				doc: { path, title: title || articleTitle(f.basename, fm.title), kicker, updated: isoDate(fm.updated) || isoDate(fm.created), body },
				refs: this.refs(place.wiki, fm),
				prefs: this.prefs(),
				dark: document.body.hasClass("theme-dark"),
				startAt,
			},
			{
				read: (p, at) => void this.read(p, at),
				back: () => this.back(),
				openSource: (p) => void this.openSource(p),
				setPrefs: (p) => this.setPrefs(p),
				follow: (href, from) => {
					const target = this.resolve(place.wiki, href.split("#")[0], from);
					if (target) void this.read(target.path);
				},
				renderMarkdown: (m, el, src) => MarkdownRenderer.render(this.app, m, el, src, md),
				tip: (el, t) => void tip(el, t),
			},
		);
	}

	/** `wiki/concepts/x/y`, a bare name, or a vault path → the note (this wiki first). */
	private resolve(wiki: ShelfWiki, link: string, from: string): TFile | null {
		const name = link.replace(/\.md$/, "").trim();
		if (!name) return null;
		const base = `${this.folder()}/${wiki.name}/`;
		for (const p of [`${base}${name}.md`, `${base}wiki/${name}.md`]) {
			const f = this.app.vault.getAbstractFileByPath(normalizePath(p));
			if (f instanceof TFile) return f;
		}
		const short = name.split("/").pop()!;
		const inWiki = this.app.vault.getMarkdownFiles().find((f) => f.path.startsWith(base + "wiki/") && f.basename === short);
		return inWiki ?? this.app.metadataCache.getFirstLinkpathDest(name, from);
	}

	/** 출처 · 원본 · 관련 글 from frontmatter (only notes that exist). */
	private refs(wiki: ShelfWiki, fm: Record<string, unknown>): RefGroup[] {
		const title = (f: TFile) => this.findArticle(f.path)?.title ?? articleTitle(f.basename, this.fm(f).title);
		const group = (label: string, names: string[]): RefGroup => {
			const seen = new Set<string>();
			const items: RefGroup["items"] = [];
			for (const n of names) {
				const f = this.resolve(wiki, n, "");
				if (f && !seen.has(f.path)) {
					seen.add(f.path);
					items.push({ title: title(f), path: f.path });
				}
			}
			return { label, items };
		};
		return [group("출처", nameList(fm.sources)), group("원본 자료", nameList(fm.raw_paths)), group("관련 글", nameList(fm.related))];
	}

	private async openSource(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
	}
}
