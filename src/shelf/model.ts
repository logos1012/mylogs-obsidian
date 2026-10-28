/**
 * Shelf (`07 Shelf/`): the knowledge store drawn as a bookcase. Pure helpers, no Obsidian.
 *
 *   칸 (row)   one wiki (`07 Shelf/{위키}/`, listed in `Shelf.md` 「위키」 table)
 *   책 (book)  one domain MOC (`{위키}/wiki/domains/{slug}.md`)
 *   글         articles under `{위키}/wiki/{concepts|sources|entities|analyses}/{slug}/`
 *
 * Book width follows the article count, colours follow the wiki (one "publisher series" per row).
 */

export type ArticleKind = "concepts" | "sources" | "entities" | "analyses";

export const KIND_ORDER: ArticleKind[] = ["concepts", "sources", "entities", "analyses"];
export const KIND_LABEL: Record<ArticleKind, string> = {
	concepts: "개념",
	sources: "자료",
	entities: "인물·조직",
	analyses: "분석",
};

export interface ShelfArticle {
	title: string;
	path: string;
	kind: ArticleKind;
	/** YYYY-MM-DD from frontmatter `updated` (or `created`), "" if none. */
	updated: string;
}

export interface ShelfBook {
	wiki: string;
	slug: string;
	label: string;
	summary: string;
	/** The domain MOC file. */
	path: string;
	tags: string[];
	articles: ShelfArticle[];
	/** Latest `updated` of the MOC and its articles. */
	updated: string;
}

export interface ShelfWiki {
	name: string;
	scope: string;
	keywords: string;
	books: ShelfBook[];
	/** Pieces received (`Shelf.md` 「받은 자료」) and not yet ingested. */
	inbox: number;
}

export interface MapRow {
	name: string;
	scope: string;
	keywords: string;
}

const strip = (s: string) =>
	s
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, (_m, p: string) => p.split("/").pop() ?? p)
		.replace(/\*\*|__|`/g, "")
		.trim();

/** `Shelf.md` 「## 위키」 table → rows in order. */
export function parseShelfMap(text: string | null): MapRow[] {
	if (!text) return [];
	const out: MapRow[] = [];
	let inSection = false;
	let header = true;
	for (const line of text.split("\n")) {
		if (/^##\s/.test(line)) {
			inSection = /^##\s+위키\s*$/.test(line);
			header = true;
			continue;
		}
		if (!inSection || !line.trim().startsWith("|")) continue;
		const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
		if (header) {
			header = false;
			continue;
		}
		if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
		if (!cells[0]) continue;
		out.push({ name: strip(cells[0]), scope: strip(cells[1] ?? ""), keywords: strip(cells[2] ?? "") });
	}
	return out;
}

/** Lines in 「받은 자료」 marked `— {wiki} · 미인제스트`. */
export function countInbox(text: string | null, wiki: string): number {
	if (!text) return 0;
	const esc = wiki.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`—\\s*${esc}\\s*·\\s*미인제스트`);
	return text.split("\n").filter((l) => re.test(l)).length;
}

const ACRONYM: Record<string, string> = { ai: "AI", b2b: "B2B", kpop: "K-pop", etc: "Etc.", vp: "VP", ui: "UI", ux: "UX", llm: "LLM", it: "IT" };

/** Frontmatter `label` wins; else `ai-economics` → `AI Economics`. */
export function bookLabel(slug: string, label?: unknown): string {
	if (typeof label === "string" && label.trim()) return label.trim();
	return slug
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => ACRONYM[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/** `생산성-단절-disconnect` → `생산성 단절 disconnect`. */
export function articleTitle(basename: string, title?: unknown): string {
	if (typeof title === "string" && title.trim()) return title.trim();
	return basename.replace(/[-_]+/g, " ").trim();
}

/** Frontmatter `summary`, else the first prose paragraph after the H1 (links and marks stripped). */
export function summaryOf(body: string, summary?: unknown, max = 180): string {
	let s = typeof summary === "string" ? summary.trim() : "";
	if (!s) {
		const text = body.replace(/^---\n[\s\S]*?\n---\n?/, "");
		const paras = text.split(/\n\s*\n/).map((p) => p.trim());
		s = paras.find((p) => p && !/^(#|\||-|\*|>|!\[|```|---)/.test(p)) ?? "";
	}
	s = strip(s.replace(/\n/g, " "));
	return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** A YAML date or string → YYYY-MM-DD ("" if not a date). */
export function isoDate(v: unknown): string {
	if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
	const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()) : null;
	return m ? m[1] : "";
}

/** Tags as plain strings (frontmatter list or single value). */
export function tagList(v: unknown): string[] {
	const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
	return arr.map((t) => String(t).replace(/^#/, "").trim()).filter((t) => t && !/^(moc|domain|MOC)$/.test(t));
}

/** `wiki/{kind}/{slug}/…` → kind + slug (the misspelt `entitys` folder counts as entities). */
export function articlePlace(relToWiki: string): { kind: ArticleKind; slug: string } | null {
	const [k, slug, ...rest] = relToWiki.split("/");
	if (!slug || !rest.length) return null;
	const kind = k === "entitys" ? "entities" : k;
	return (KIND_ORDER as string[]).includes(kind) ? { kind: kind as ArticleKind, slug } : null;
}

export function daysBetween(a: string, b: string): number {
	return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** Updated within `days` of today: the book wears a ribbon. */
export function isFresh(updated: string, today: string, days = 7): boolean {
	if (!updated) return false;
	const d = daysBetween(updated, today);
	return d >= 0 && d < days;
}

function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

export type SpineStyle = "serif" | "caps" | "italic";

export interface SpineLook {
	/** px */
	width: number;
	/** % of the bay height */
	height: number;
	/** 0–2: tone inside the series */
	tone: number;
	style: SpineStyle;
	/** 0 none, 1 top band, 2 twin rules, 3 bottom block */
	mark: number;
}

/** Deterministic per book: width from the article count, the rest from the slug. */
export function spineLook(slug: string, count: number): SpineLook {
	const h = hash(slug);
	const width = Math.round(Math.min(68, Math.max(24, 20 + 5.2 * Math.sqrt(count))));
	const styles: SpineStyle[] = ["serif", "caps", "serif", "italic"];
	return { width, height: 76 + (h % 23), tone: (h >>> 5) % 3, style: styles[(h >>> 9) % styles.length], mark: (h >>> 13) % 4 };
}

export interface Series {
	tones: [string, string, string];
	ink: string;
	accent: string;
}

/** One publisher series per row, in `Shelf.md` order; new wikis take the next. */
export const SERIES: Series[] = [
	{ tones: ["#ECE4D3", "#E2D6BE", "#D6C7A9"], ink: "#2A251E", accent: "#C0502A" },
	{ tones: ["#1E2A45", "#26355A", "#30426C"], ink: "#F1ECE0", accent: "#D9A441" },
	{ tones: ["#5A1E24", "#6C292E", "#7C3934"], ink: "#F2E8DA", accent: "#D2B27A" },
	{ tones: ["#22402F", "#2C503A", "#3A5E46"], ink: "#EEEADB", accent: "#E38B5C" },
	{ tones: ["#212121", "#2D2D2C", "#3A3A37"], ink: "#ECECE6", accent: "#72B6A9" },
	{ tones: ["#3F4C63", "#4B5A74", "#5A6A85"], ink: "#F1EFE8", accent: "#E7C36A" },
	{ tones: ["#C9A24A", "#BE933A", "#D4B262"], ink: "#2A2213", accent: "#5A2A1C" },
	{ tones: ["#4A2F4E", "#5A3A5F", "#6A4870"], ink: "#F3EAF0", accent: "#E5A57B" },
];

export function seriesOf(index: number): Series {
	return SERIES[((index % SERIES.length) + SERIES.length) % SERIES.length];
}

/** Search: label, slug, summary, tags (case-insensitive, all words). */
export function bookMatches(b: ShelfBook, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const hay = [b.label, b.slug, b.summary, b.wiki, ...b.tags].join(" ").toLowerCase();
	return q.split(/\s+/).every((w) => hay.includes(w));
}

/** Newest first, then by title. */
export function sortArticles(a: ShelfArticle[]): ShelfArticle[] {
	return [...a].sort((x, y) => (y.updated || "").localeCompare(x.updated || "") || x.title.localeCompare(y.title, "ko"));
}
