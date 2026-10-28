/**
 * Shelf view (`mylogs-shelf`): `07 Shelf/` as a bookcase. 칸 = wiki, 책 = domain MOC, width = 글 수.
 * Read only: a book pulls out to its summary, article counts and recent articles; titles open notes.
 * Creating 칸 / 책 is not decided yet (계획 「Shelf」).
 */

import { debounce, ItemView, moment, normalizePath, type TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { articlePlace, articleTitle, bookLabel, countInbox, isoDate, parseShelfMap, type ShelfArticle, type ShelfBook, type ShelfWiki, summaryOf, tagList } from "./model.ts";
import { renderShelf, type ShelfState } from "./render.ts";

export const VIEW_TYPE_SHELF = "mylogs-shelf";

export class ShelfView extends ItemView {
	plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private wikis: ShelfWiki[] = [];
	private state: ShelfState = { query: "", open: null, all: false };
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
		mountAppNav(this);
		const later = debounce(() => void this.refresh(), 500, true);
		const watch = (f: TAbstractFile, old?: string) => {
			if ([f.path, old ?? ""].some((p) => p.startsWith(this.folder() + "/"))) later();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("create", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => watch(f, old)));
		await this.refresh();
		// Frontmatter is not indexed yet on a cold start.
		this.app.workspace.onLayoutReady(() => later());
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		const seq = ++this.seq;
		const wikis = await this.readShelf();
		if (seq !== this.seq) return;
		this.wikis = wikis;
		this.draw();
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
		const focused = document.activeElement?.classList.contains("mls-search") ?? false;
		renderShelf(this.rootEl, this.wikis, this.state, moment().format("YYYY-MM-DD"), {
			openFile: (p) => void this.openFile(p),
			openMap: () => void this.openFile(this.mapPath()),
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

	private async openFile(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
	}
}
