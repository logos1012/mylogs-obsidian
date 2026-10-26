/**
 * Diary model: the user's own writing in `09 Diary/` (`09 Diary/AGENTS.md` 「2」「3」).
 *
 *   {YYYY}/{YYYY-MM}/{YYYY-MM-DD HHMM}.md     one entry = one file; the name is the writing time
 *   _Templates/엔트리.md                       new entries come from here (「4-1」)
 *   99 작업실/프롬프트.md                      오늘의 질문 (one bullet = one prompt)
 *   99 작업실/첨부/{YYYY-MM}/                 pasted / dropped images
 *   Diary Index.md                            registry (ops.ts)
 *
 * The plugin never writes body text (「1」「5」): it creates empty entries, shows material, and
 * saves what the user typed. Everything here is about reading entries and the small frontmatter
 * edits the screen makes (title sync, `updated`, `starred`, `pinned`, `from`).
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { addDays, fromIsoDate, frontmatterEnd, pad2, splitLinesKeepEol, toIsoDate } from "../parser.ts";
import { parseFrontmatterText, valueToString } from "../pinboard/model.ts";
import { getFmList, getFmValue, setFmList, setFmValue, yamlScalar } from "../projects/ops.ts";
import { fillPlaceholders } from "../toolbox/ops.ts";

export const DEFAULT_DIARY_PATH = "09 Diary";
export const REGISTRY_FILE = "Diary Index.md";
export const TEMPLATE_REL = "_Templates/엔트리.md";
export const PROMPTS_REL = "99 작업실/프롬프트.md";
export const ATTACH_REL = "99 작업실/첨부";
/** A prompt already answered this many days ago (or less) is not offered again (「4-2」 4). */
export const PROMPT_COOLDOWN_DAYS = 90;
export const UNTITLED = "(제목 없음)";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|heic|avif)$/i;

// ───────────────────────── paths ─────────────────────────

export function diaryRoot(folder: string): string {
	const r = folder.trim().replace(/^\/+|\/+$/g, "");
	return r || DEFAULT_DIARY_PATH;
}

export function registryPathOf(folder: string): string {
	return `${diaryRoot(folder)}/${REGISTRY_FILE}`;
}
export function templatePathOf(folder: string): string {
	return `${diaryRoot(folder)}/${TEMPLATE_REL}`;
}
export function promptsPathOf(folder: string): string {
	return `${diaryRoot(folder)}/${PROMPTS_REL}`;
}

/** `09 Diary/2026/2026-01` for a `YYYY-MM-DD` (or `YYYY-MM`). */
export function monthFolderOf(folder: string, date: string): string {
	return `${diaryRoot(folder)}/${date.slice(0, 4)}/${date.slice(0, 7)}`;
}

/** `2026-01-09 2210` (+ `-2` when the minute is taken, 「4-1」 1). */
export function entryBaseName(now: Date, taken: Iterable<string>): string {
	const base = `${toIsoDate(now)} ${pad2(now.getHours())}${pad2(now.getMinutes())}`;
	const set = new Set([...taken].map((n) => n.toLowerCase()));
	if (!set.has(base.toLowerCase())) return base;
	for (let i = 2; ; i++) {
		const name = `${base}-${i}`;
		if (!set.has(name.toLowerCase())) return name;
	}
}

/** The full path of a new entry written at `now`. */
export function entryPathOf(folder: string, now: Date, taken: Iterable<string>): string {
	return `${monthFolderOf(folder, toIsoDate(now))}/${entryBaseName(now, taken)}.md`;
}

/** `date` and `time` encoded in an entry file name, or null when it is not one (`YYYY-MM-DD HHMM[-N]`). */
export function entryStamp(basename: string): { date: string; time: string } | null {
	const m = /^(\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})(?:-\d+)?$/.exec(basename.trim());
	if (!m || !fromIsoDate(m[1])) return null;
	return { date: m[1], time: `${m[2]}:${m[3]}` };
}

/** Is `path` an entry file of the Diary folder (`{root}/{YYYY}/{YYYY-MM}/{name}.md`)? */
export function isEntryPath(folder: string, path: string): boolean {
	const root = diaryRoot(folder);
	if (!path.startsWith(`${root}/`)) return false;
	const rel = path.slice(root.length + 1);
	return /^\d{4}\/\d{4}-\d{2}\/[^/]+\.md$/.test(rel);
}

/** `99 작업실/첨부/{YYYY-MM}/{YYYY-MM-DD HHMM} {NN}.{ext}` (「3」). `nn` is 1-based. */
export function attachmentPath(folder: string, entryName: string, nn: number, ext: string): string {
	const date = entryName.slice(0, 10);
	return `${diaryRoot(folder)}/${ATTACH_REL}/${date.slice(0, 7)}/${entryName.replace(/-\d+$/, "")} ${pad2(nn)}.${ext.toLowerCase().replace(/^\./, "")}`;
}

/** The attachment folder of an entry's month. */
export function attachmentFolderOf(folder: string, entryName: string): string {
	return `${diaryRoot(folder)}/${ATTACH_REL}/${entryName.slice(0, 7)}`;
}

/** Next free `NN` for an entry's attachments (names already in the month folder). */
export function nextAttachmentNo(entryName: string, existing: Iterable<string>): number {
	const stem = entryName.replace(/-\d+$/, "");
	let max = 0;
	for (const n of existing) {
		const m = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d{2})\\.`).exec(n);
		if (m) max = Math.max(max, +m[1]);
	}
	return max + 1;
}

/** Attachments that belong to an entry: the named ones (`{name} NN.*`) and every image it embeds under 첨부. */
export function attachmentsOf(folder: string, e: Pick<DiaryEntry, "name" | "body">, monthFiles: Iterable<string>): string[] {
	const stem = e.name.replace(/-\d+$/, "");
	const dir = attachmentFolderOf(folder, e.name);
	const out = new Set<string>();
	for (const n of monthFiles) if (n.startsWith(`${stem} `)) out.add(`${dir}/${n}`);
	const prefix = `${diaryRoot(folder)}/${ATTACH_REL}/`;
	for (const link of embedsOf(e.body)) if (link.startsWith(prefix)) out.add(link);
	return [...out];
}

// ───────────────────────── entry ─────────────────────────

export interface DiaryEntry {
	path: string;
	/** File base name (`2026-01-09 2210`). */
	name: string;
	date: string;
	/** `HH:MM`. */
	time: string;
	/** Frontmatter `title`, else the first `# ` line, else "" (the screen shows `UNTITLED`). */
	title: string;
	tags: string[];
	location: string;
	weather: string;
	starred: boolean;
	pinned: boolean;
	prompt: string;
	from: string[];
	created: string;
	updated: string;
	/** Text after the frontmatter, as written. */
	body: string;
	/** Up to two lines of body text (no H1, embeds, comments, markup). */
	preview: string;
	/** Vault path of the first embedded image, or "". */
	firstImage: string;
	/** Characters of body text (without the H1 line). */
	chars: number;
}

function bool(v: unknown): boolean {
	return v === true || String(v ?? "").trim().toLowerCase() === "true";
}

function list(v: unknown): string[] {
	if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
	const s = valueToString(v).trim();
	return s ? [s] : [];
}

/** First `# ` heading of a body, "" when none. */
export function h1Of(body: string): string {
	let fence = false;
	for (const raw of body.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
		if (fence) continue;
		const m = /^#\s+(.*?)\s*#*\s*$/.exec(raw);
		if (m) return m[1].trim();
	}
	return "";
}

/** `![[target]]` and `![alt](target)` targets, in order (alias / size suffix removed). */
export function embedsOf(body: string): string[] {
	const out: string[] = [];
	const re = /!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]|!\[[^\]]*\]\(([^)\s]+)\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body))) out.push((m[1] ?? m[2]).trim());
	return out;
}

/** The first embedded image (by extension), "" when none. */
export function firstImageOf(body: string): string {
	return embedsOf(body).find((t) => IMAGE_EXT.test(t)) ?? "";
}

function stripMarkup(s: string): string {
	return s
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
		.replace(/\[\[([^\]]+)\]\]/g, (_m, p: string) => p.split("/").pop() ?? p)
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[.\]\s*)?/, "")
		.replace(/^\s*>\s?/, "")
		.replace(/^\s*#{1,6}\s+/, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(\*|_)(.+?)\1/g, "$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** Body text lines without the H1, embeds, comments and markup. */
export function textLinesOf(body: string): string[] {
	const clean = body.replace(/<!--[\s\S]*?-->/g, "");
	const out: string[] = [];
	let fence = false;
	let h1Seen = false;
	for (const raw of clean.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(raw)) {
			fence = !fence;
			continue;
		}
		if (fence) continue;
		if (!h1Seen && /^#\s/.test(raw)) {
			h1Seen = true;
			continue;
		}
		const s = stripMarkup(raw);
		if (s) out.push(s);
	}
	return out;
}

/** Two lines of preview, each cut to `max` characters. */
export function previewOf(body: string, max = 90): string {
	return textLinesOf(body)
		.slice(0, 2)
		.map((l) => (l.length > max ? l.slice(0, max - 1).trimEnd() + "…" : l))
		.join("\n");
}

/** Parse one entry file. Returns null when the name is not an entry name and the frontmatter has no `date`. */
export function parseEntry(text: string, path: string): DiaryEntry | null {
	const name = path.replace(/^.*\//, "").replace(/\.md$/i, "");
	const { data, body } = parseFrontmatterText(text);
	const stamp = entryStamp(name);
	const date = valueToString(data.date).trim() || stamp?.date || "";
	if (!fromIsoDate(date)) return null;
	const timeRaw = valueToString(data.time).trim();
	const time = /^\d{1,2}:\d{2}$/.test(timeRaw) ? timeRaw.padStart(5, "0") : stamp?.time || "";
	const h1 = h1Of(body);
	const lines = textLinesOf(body);
	return {
		path,
		name,
		date,
		time,
		title: valueToString(data.title).trim() || h1,
		tags: list(data.tags),
		location: valueToString(data.location).trim(),
		weather: valueToString(data.weather).trim(),
		starred: bool(data.starred),
		pinned: bool(data.pinned),
		prompt: valueToString(data.prompt).trim(),
		from: list(data.from),
		created: valueToString(data.created).trim(),
		updated: valueToString(data.updated).trim(),
		body,
		preview: previewOf(body),
		firstImage: firstImageOf(body),
		chars: lines.join("").replace(/\s/g, "").length,
	};
}

/** What the screen calls an entry. */
export function displayTitle(e: Pick<DiaryEntry, "title">): string {
	return e.title || UNTITLED;
}

// ───────────────────────── timeline ─────────────────────────

/** Newest first: by date, then time, then name (the `-2` suffix after its sibling). */
export function compareNewest(a: DiaryEntry, b: DiaryEntry): number {
	return b.date.localeCompare(a.date) || b.time.localeCompare(a.time) || b.name.localeCompare(a.name);
}

export interface TimelineRow {
	entry: DiaryEntry;
	/** The first row of its day inside the group shows the weekday + day label. */
	showDate: boolean;
}

export interface TimelineGroup {
	/** `"pinned"` or `YYYY-MM`. */
	key: string;
	rows: TimelineRow[];
}

export interface TimelineFilter {
	starred?: boolean;
	tag?: string;
	year?: string;
}

export function filterEntries(entries: DiaryEntry[], f: TimelineFilter): DiaryEntry[] {
	return entries.filter((e) => (!f.starred || e.starred) && (!f.tag || e.tags.includes(f.tag)) && (!f.year || e.date.startsWith(`${f.year}-`)));
}

/** Pinned entries first (own group), then month groups newest first; each group's rows newest first. */
export function groupTimeline(entries: DiaryEntry[]): TimelineGroup[] {
	const sorted = [...entries].sort(compareNewest);
	const groups: TimelineGroup[] = [];
	const pinned = sorted.filter((e) => e.pinned);
	if (pinned.length) groups.push({ key: "pinned", rows: pinned.map((entry) => ({ entry, showDate: true })) });
	let cur: TimelineGroup | null = null;
	let lastDate = "";
	for (const entry of sorted) {
		const key = entry.date.slice(0, 7);
		if (!cur || cur.key !== key) {
			cur = { key, rows: [] };
			groups.push(cur);
			lastDate = "";
		}
		cur.rows.push({ entry, showDate: entry.date !== lastDate });
		lastDate = entry.date;
	}
	return groups;
}

/** Tags over all entries with counts, most used first. */
export function tagCounts(entries: DiaryEntry[]): [string, number][] {
	const m = new Map<string, number>();
	for (const e of entries) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
	return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Years with entries, newest first. */
export function yearsOf(entries: DiaryEntry[]): string[] {
	return [...new Set(entries.map((e) => e.date.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
}

// ───────────────────────── calendar · streak ─────────────────────────

export interface CalendarDay {
	date: string;
	count: number;
	/** First image of the day's first (newest) entry with one, "". */
	image: string;
}

/** Day cells of `YYYY-MM` (only days with entries are present). */
export function calendarDays(entries: DiaryEntry[], month: string): Map<string, CalendarDay> {
	const out = new Map<string, CalendarDay>();
	for (const e of [...entries].sort(compareNewest)) {
		if (!e.date.startsWith(`${month}-`)) continue;
		const d = out.get(e.date) ?? { date: e.date, count: 0, image: "" };
		d.count++;
		if (!d.image && e.firstImage) d.image = e.firstImage;
		out.set(e.date, d);
	}
	return out;
}

/**
 * Consecutive days with at least one entry, ending today or yesterday (today without an entry does
 * not break a streak that is still alive). 0 when neither day has one.
 */
export function streakOf(dates: Iterable<string>, today: string): number {
	const set = new Set(dates);
	let day = set.has(today) ? today : addDays(today, -1);
	let n = 0;
	while (set.has(day)) {
		n++;
		day = addDays(day, -1);
	}
	return n;
}

// ───────────────────────── material (「4-2」) ─────────────────────────

/** Entries of earlier years written on the same month-day as `date` (「4-2」 3), newest year first. */
export function onThisDay(entries: DiaryEntry[], date: string): DiaryEntry[] {
	const mmdd = date.slice(5);
	const year = date.slice(0, 4);
	return entries.filter((e) => e.date.slice(5) === mmdd && e.date.slice(0, 4) !== year).sort(compareNewest);
}

/** Prompt lines of `프롬프트.md`: one bullet = one prompt (comments and headings ignored). */
export function parsePrompts(text: string): string[] {
	const { body } = parseFrontmatterText(text);
	const out: string[] = [];
	for (const raw of body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
		const m = /^\s*[-*+]\s+(.+?)\s*$/.exec(raw);
		if (m) out.push(m[1]);
	}
	return out;
}

/** Small deterministic hash of a string (FNV-1a, 32-bit). */
export function seedOf(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** Prompts answered (frontmatter `prompt`) within the last `days` days before `today` (inclusive). */
export function recentlyAnswered(entries: Pick<DiaryEntry, "date" | "prompt">[], today: string, days = PROMPT_COOLDOWN_DAYS): Set<string> {
	const since = addDays(today, -days);
	const out = new Set<string>();
	for (const e of entries) if (e.prompt && e.date >= since && e.date <= today) out.add(e.prompt.trim());
	return out;
}

/**
 * 오늘의 질문 (「4-2」 4): the same prompt all day (seeded by the date), skipping the ones answered in
 * the last 90 days. Null when every prompt is on cooldown or the list is empty.
 */
export function promptForDate(prompts: string[], date: string, answered: Set<string>): string | null {
	const pool = prompts.filter((p) => !answered.has(p.trim()));
	if (!pool.length) return null;
	return pool[seedOf(date) % pool.length];
}

// ───────────────────────── text transforms (frontmatter only) ─────────────────────────

/** `YYYY-MM-DDTHH:mm` in local time. */
export function stampOf(d: Date): string {
	return `${toIsoDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Index of the first body line and the frontmatter text (`""` when the file has none). */
export function splitFrontmatter(text: string): { head: string; body: string } {
	const lines = splitLinesKeepEol(text);
	const end = frontmatterEnd(lines);
	const head = lines.slice(0, end).join("");
	return { head, body: text.slice(head.length) };
}

/** 「4-1」 1-3: a new entry from `_Templates/엔트리.md`; `prompt` set and `> 질문` as the first body line when answering. */
export function newEntryText(template: string, now: Date, prompt = ""): string {
	let t = fillPlaceholders(template, { date: now, title: "" });
	if (!/^type:\s*diary\s*$/m.test(t)) t = setFmValue(t, "type", "diary");
	if (prompt) {
		t = setFmValue(t, "prompt", yamlScalar(prompt));
		const { head, body } = splitFrontmatter(t);
		const h1 = /^# [^\n]*\n?/.exec(body.replace(/^\s*\n/, ""));
		const rest = body.replace(/^\s*\n/, "").slice(h1 ? h1[0].length : 0).replace(/^\s*\n/, "");
		t = `${head}# \n\n> ${prompt}\n\n${rest}`;
	}
	return t;
}

/** The body as the editor shows it: everything after the frontmatter. */
export function bodyOf(text: string): string {
	return splitFrontmatter(text).body;
}

/** CRLF → LF: the editor's line endings. */
export function normalizeBody(s: string): string {
	return s.replace(/\r\n/g, "\n");
}

/**
 * Two bodies are the same text when they differ only in line endings or trailing whitespace
 * (`withBody` adds the final newline the textarea does not have). Conflict detection and the
 * editor's dirty check compare with this, never with `===` on raw file text.
 */
export function bodiesEqual(a: string, b: string): boolean {
	return normalizeBody(a).replace(/\s+$/, "") === normalizeBody(b).replace(/\s+$/, "");
}

/**
 * Save the editor text: replace the body, sync the first `# ` line into `title` (「2」: 제목은 frontmatter
 * `title`과 본문 첫 줄), and bump `updated`. Nothing else in the frontmatter changes.
 */
export function withBody(text: string, body: string, now: Date): string {
	const { head } = splitFrontmatter(text);
	const next = body.replace(/\r\n/g, "\n");
	const nextWithNl = next && !next.endsWith("\n") ? next + "\n" : next;
	let out = head + nextWithNl;
	if (!head) return out;
	out = syncTitle(out);
	return setFmValue(out, "updated", stampOf(now));
}

/** `title` ← first `# ` line of the body (empty when the line is empty or missing). */
export function syncTitle(text: string): string {
	const { body } = splitFrontmatter(text);
	const h1 = h1Of(body);
	if (getFmValue(text, "title") === h1) return text;
	return setFmValue(text, "title", h1 ? yamlScalar(h1) : "");
}

export interface MetaEdit {
	time?: string;
	location?: string;
	weather?: string;
	tags?: string[];
}

/** The metadata strip edit: time / location / weather / tags. `updated` follows. */
export function applyMetaEdit(text: string, m: MetaEdit, now: Date): string {
	let out = text;
	if (m.time !== undefined) out = setFmValue(out, "time", JSON.stringify(m.time.trim()));
	if (m.location !== undefined) out = setFmValue(out, "location", yamlScalar(m.location));
	if (m.weather !== undefined) out = setFmValue(out, "weather", yamlScalar(m.weather));
	if (m.tags !== undefined) out = setFmValue(out, "tags", `[${m.tags.map((t) => yamlScalar(t)).join(", ")}]`);
	return out === text ? text : setFmValue(out, "updated", stampOf(now));
}

export function setStarred(text: string, on: boolean): string {
	return setFmValue(text, "starred", on ? "true" : "false");
}
export function setPinned(text: string, on: boolean): string {
	return setFmValue(text, "pinned", on ? "true" : "false");
}

/** `[[a, b]]` → `a, b` (tags typed in the edit form). */
export function splitTags(s: string): string[] {
	return s
		.split(/[,\s]+/)
		.map((t) => t.replace(/^#/, "").trim())
		.filter(Boolean);
}

/** 「4-2」 5: a material link joins `from` (once); the body is untouched. */
export function addFromLink(text: string, link: string): string {
	const l = link.trim();
	if (!l) return text;
	const cur = getFmList(text, "from");
	if (cur.includes(l)) return text;
	return setFmList(text, "from", [...cur, l]);
}

/** `[[path#섹션]]` for a vault file (extension dropped). */
export function wikilink(path: string, section = ""): string {
	const p = path.replace(/\.md$/i, "");
	return `[[${p}${section ? `#${section}` : ""}]]`;
}

/** Insert `![[path]]` at a cursor position of an editor text (its own line). */
export function insertEmbed(text: string, pos: number, path: string): { text: string; pos: number } {
	const embed = `![[${path}]]`;
	const before = text.slice(0, pos);
	const after = text.slice(pos);
	const lead = before && !before.endsWith("\n") ? "\n" : "";
	const tail = after && !after.startsWith("\n") ? "\n" : "";
	const ins = `${lead}${embed}${tail}`;
	return { text: before + ins + after, pos: pos + lead.length + embed.length };
}

/** `2026-01` → `2026년 1월`. */
export function monthLabel(month: string): string {
	const [y, m] = month.split("-");
	return `${y}년 ${+m}월`;
}

/** Korean weekday letter of a `YYYY-MM-DD`. */
export function weekdayKo(date: string): string {
	const d = fromIsoDate(date);
	return d ? "일월화수목금토"[d.getDay()] : "";
}
