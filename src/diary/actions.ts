/**
 * Diary vault operations: the 「4-1」 / 「4-2」 / 「4-4」 / 「4-5」 procedures of `09 Diary/AGENTS.md`,
 * executed with the pure transforms of `model.ts` and `ops.ts`. Each file is changed with
 * `vault.process` (atomic read-modify-write). The entry file is written first; the registry
 * follows it (file = canonical). The plugin never writes body text: it saves what the user typed.
 */

import { type App, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { addDays, toIsoDate } from "../parser.ts";
import { cleanFolder, type MyLogsSettings } from "../settings.ts";
import { getSectionContent } from "../writer.ts";
import { aggregateDiary, dailyMonthFolder, dailyPath as myLifeDailyPath, dateOfDailyName, type DiaryMonth, type DiarySource, INSIGHT_SECTION, monthlyPath } from "../mylife/model.ts";
import {
	addFromLink,
	applyMetaEdit,
	attachmentFolderOf,
	attachmentPath,
	attachmentsOf,
	bodyOf,
	type DiaryEntry,
	diaryRoot,
	displayTitle,
	entryPathOf,
	isEntryPath,
	type MetaEdit,
	newEntryText,
	nextAttachmentNo,
	parseEntry,
	parsePrompts,
	promptsPathOf,
	registryPathOf,
	setPinned,
	setStarred,
	templatePathOf,
	withBody,
} from "./model.ts";
import { registerEntry, unregisterEntry } from "./ops.ts";
import { DEFAULT_ENTRY_TEMPLATE } from "./templates.ts";

export interface DiaryHost {
	app: App;
	settings: MyLogsSettings;
}

export function root(host: DiaryHost): string {
	return diaryRoot(cleanFolder(host.settings.diaryPath));
}
export function registryPath(host: DiaryHost): string {
	return normalizePath(registryPathOf(root(host)));
}

function fileAt(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
}

function today(): string {
	return toIsoDate(new Date());
}

// ───────────────────────── read ─────────────────────────

export interface DiaryData {
	entries: DiaryEntry[];
	prompts: string[];
	hasRegistry: boolean;
	hasTemplate: boolean;
}

/** Every entry under `{root}/{YYYY}/{YYYY-MM}/`, the prompt list, and whether the registry / template exist. */
export async function loadDiary(host: DiaryHost): Promise<DiaryData> {
	const { app } = host;
	const r = root(host);
	const entries: DiaryEntry[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		if (!isEntryPath(r, f.path)) continue;
		const e = parseEntry(await app.vault.cachedRead(f), f.path);
		if (e) entries.push(e);
	}
	const promptsFile = fileAt(app, promptsPathOf(r));
	const prompts = promptsFile ? parsePrompts(await app.vault.cachedRead(promptsFile)) : [];
	return { entries, prompts, hasRegistry: !!fileAt(app, registryPath(host)), hasTemplate: !!fileAt(app, templatePathOf(r)) };
}

/** Re-read one entry from disk (after a save). */
export async function readEntry(host: DiaryHost, path: string): Promise<DiaryEntry | null> {
	const f = fileAt(host.app, path);
	return f ? parseEntry(await host.app.vault.read(f), f.path) : null;
}

// ───────────────────────── registry (「4-4」) ─────────────────────────

/** Upsert the entry's row and recompute 「월별」. Silent when the registry is missing (the view shows a hint). */
export async function syncRegistry(host: DiaryHost, e: DiaryEntry): Promise<string | null> {
	const f = fileAt(host.app, registryPath(host));
	if (!f) return "등록부(Diary Index.md)가 없어요";
	let problem: string | null = null;
	try {
		await host.app.vault.process(f, (text) => {
			const r = registerEntry(text, e, today());
			if (!r.ok) {
				problem = r.reason;
				return text;
			}
			return r.text;
		});
	} catch (err) {
		console.error("[MyLogs] Diary registry write failed", err);
		return "등록부에 쓰지 못했어요";
	}
	return problem;
}

// ───────────────────────── 「4-1」 오늘 쓰기 ─────────────────────────

async function ensureFolder(app: App, path: string): Promise<void> {
	const p = normalizePath(path);
	if (app.vault.getAbstractFileByPath(p)) return;
	const parent = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
	if (parent) await ensureFolder(app, parent);
	try {
		await app.vault.createFolder(p);
	} catch (err) {
		// Another writer may have created it meanwhile.
		if (!app.vault.getAbstractFileByPath(p)) throw err;
	}
}

async function loadTemplate(host: DiaryHost): Promise<string> {
	const f = fileAt(host.app, templatePathOf(root(host)));
	if (f) return host.app.vault.read(f);
	console.warn("[MyLogs] Diary template 엔트리.md not found; using the built-in copy");
	return DEFAULT_ENTRY_TEMPLATE;
}

/**
 * A new, empty entry at `now` from `_Templates/엔트리.md` (「4-1」): `date`·`time`·`created` filled,
 * `title` empty, body empty (or `> 질문` when answering a prompt). Returns the file, or null.
 */
export async function createEntry(host: DiaryHost, prompt = ""): Promise<TFile | null> {
	const { app } = host;
	const now = new Date();
	const r = root(host);
	const folderPath = normalizePath(`${r}/${toIsoDate(now).slice(0, 4)}/${toIsoDate(now).slice(0, 7)}`);
	try {
		await ensureFolder(app, folderPath);
	} catch (err) {
		console.error("[MyLogs] Diary folder create failed", err);
		new Notice(`MyLogs: 폴더를 만들지 못했어요 (${folderPath}).`);
		return null;
	}
	const folder = app.vault.getAbstractFileByPath(folderPath);
	const taken = folder instanceof TFolder ? folder.children.filter((c): c is TFile => c instanceof TFile).map((c) => c.basename) : [];
	const path = normalizePath(entryPathOf(r, now, taken));
	const text = newEntryText(await loadTemplate(host), now, prompt);
	try {
		return await app.vault.create(path, text);
	} catch (err) {
		console.error("[MyLogs] Diary create failed", err);
		new Notice(`MyLogs: 엔트리를 만들지 못했어요 (${path}).`);
		return null;
	}
}

// ───────────────────────── save ─────────────────────────

export type SaveResult = { ok: true; entry: DiaryEntry | null } | { ok: false; conflict: true } | { ok: false; conflict: false };

/**
 * Save the editor text as the body (title synced into frontmatter, `updated` bumped), then the
 * registry row. `expectBody` is what the editor last synced with: when the file's body differs,
 * nothing is written and `conflict` is reported (someone else changed the file).
 */
export async function saveBody(host: DiaryHost, path: string, body: string, expectBody: string | null, force = false): Promise<SaveResult> {
	const f = fileAt(host.app, path);
	if (!f) return { ok: false, conflict: false };
	let conflict = false;
	let out = "";
	try {
		await host.app.vault.process(f, (text) => {
			if (!force && expectBody !== null && bodyOf(text) !== expectBody) {
				conflict = true;
				return text;
			}
			out = withBody(text, body, new Date());
			return out;
		});
	} catch (err) {
		console.error("[MyLogs] Diary save failed", err);
		return { ok: false, conflict: false };
	}
	if (conflict) return { ok: false, conflict: true };
	const entry = parseEntry(out, f.path);
	if (entry) await syncRegistry(host, entry);
	return { ok: true, entry };
}

/** One frontmatter-only edit on the entry file, then the registry row. */
async function editFrontmatter(host: DiaryHost, path: string, edit: (text: string) => string, label: string): Promise<DiaryEntry | null> {
	const f = fileAt(host.app, path);
	if (!f) {
		new Notice(`엔트리 파일을 찾지 못했어요: ${path}`);
		return null;
	}
	let out = "";
	try {
		await host.app.vault.process(f, (text) => (out = edit(text)));
	} catch (err) {
		console.error(`[MyLogs] Diary ${label} failed`, err);
		new Notice(`MyLogs: ${label}에 실패했어요.`);
		return null;
	}
	const entry = parseEntry(out, f.path);
	if (entry) await syncRegistry(host, entry);
	return entry;
}

export function toggleStarred(host: DiaryHost, e: DiaryEntry): Promise<DiaryEntry | null> {
	return editFrontmatter(host, e.path, (t) => setStarred(t, !e.starred), "별 표시");
}
export function togglePinned(host: DiaryHost, e: DiaryEntry): Promise<DiaryEntry | null> {
	return editFrontmatter(host, e.path, (t) => setPinned(t, !e.pinned), "고정");
}
export function editMeta(host: DiaryHost, e: DiaryEntry, m: MetaEdit): Promise<DiaryEntry | null> {
	return editFrontmatter(host, e.path, (t) => applyMetaEdit(t, m, new Date()), "메타데이터 수정");
}
/** 「4-2」 5: the material's wikilink joins `from`; the body is never touched. */
export function addFrom(host: DiaryHost, e: DiaryEntry, link: string): Promise<DiaryEntry | null> {
	return editFrontmatter(host, e.path, (t) => addFromLink(t, link), "재료 링크 추가");
}

// ───────────────────────── attachments ─────────────────────────

/** Save a pasted / dropped image under `99 작업실/첨부/{YYYY-MM}/{entry} {NN}.{ext}` (「3」). Returns the vault path. */
export async function saveAttachment(host: DiaryHost, e: Pick<DiaryEntry, "name">, file: File): Promise<string | null> {
	const { app } = host;
	const r = root(host);
	const folderPath = normalizePath(attachmentFolderOf(r, e.name));
	try {
		await ensureFolder(app, folderPath);
	} catch (err) {
		console.error("[MyLogs] Diary attachment folder failed", err);
		new Notice("MyLogs: 첨부 폴더를 만들지 못했어요.");
		return null;
	}
	const folder = app.vault.getAbstractFileByPath(folderPath);
	const existing = folder instanceof TFolder ? folder.children.map((c) => c.name) : [];
	const ext = (file.name.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? file.type.split("/")[1] ?? "png").toLowerCase();
	const path = normalizePath(attachmentPath(r, e.name, nextAttachmentNo(e.name, existing), ext));
	try {
		await app.vault.createBinary(path, await file.arrayBuffer());
		return path;
	} catch (err) {
		console.error("[MyLogs] Diary attachment save failed", err);
		new Notice("MyLogs: 사진을 저장하지 못했어요.");
		return null;
	}
}

/** Files this entry owns (named `{entry} NN.*` or embedded from 첨부). */
export function attachmentFiles(host: DiaryHost, e: DiaryEntry): TFile[] {
	const r = root(host);
	const folder = host.app.vault.getAbstractFileByPath(normalizePath(attachmentFolderOf(r, e.name)));
	const names = folder instanceof TFolder ? folder.children.map((c) => c.name) : [];
	return attachmentsOf(r, e, names)
		.map((p) => fileAt(host.app, p))
		.filter((f): f is TFile => !!f);
}

// ───────────────────────── 「4-5」 삭제 ─────────────────────────

/** Trash the entry and its attachments, remove the row, recompute 「월별」, one 변경 기록 line. */
export async function deleteEntry(host: DiaryHost, e: DiaryEntry): Promise<boolean> {
	const { app } = host;
	const f = fileAt(app, e.path);
	if (!f) {
		new Notice(`엔트리 파일을 찾지 못했어요: ${e.path}`);
		return false;
	}
	const attachments = attachmentFiles(host, e);
	try {
		await app.vault.trash(f, true);
		for (const a of attachments) await app.vault.trash(a, true);
	} catch (err) {
		console.error("[MyLogs] Diary trash failed", err);
		new Notice("MyLogs: 휴지통으로 옮기지 못했어요. 등록부는 바꾸지 않았어요.");
		return false;
	}
	const reg = fileAt(app, registryPath(host));
	if (reg) {
		try {
			await app.vault.process(reg, (text) => {
				const r = unregisterEntry(text, e, today());
				return r.ok ? r.text : text;
			});
		} catch (err) {
			console.error("[MyLogs] Diary registry write failed", err);
			new Notice("MyLogs: 파일은 지웠지만 등록부를 고치지 못했어요.");
		}
	}
	new Notice(`「${displayTitle(e)}」을(를) 휴지통으로 옮겼어요${attachments.length ? ` (첨부 ${attachments.length}개 포함)` : ""}.`);
	return true;
}

// ───────────────────────── material (「4-2」) ─────────────────────────

export interface MaterialSection {
	/** Source file path. */
	path: string;
	section: string;
	/** Verbatim content. */
	content: string;
}

export interface Material {
	/** 오늘 Daily Pad `## 끼적임` / `## 메모` / `## 로그` (only sections with content). */
	todayPad: MaterialSection[];
	todayPadPath: string;
	/** 어제 My Life Daily `## 깨달음·감상` / `## 열린 질문`. */
	yesterdayLife: MaterialSection[];
	yesterdayLifePath: string;
}

async function sectionsOf(app: App, path: string, names: string[]): Promise<MaterialSection[]> {
	const f = fileAt(app, path);
	if (!f) return [];
	const text = await app.vault.cachedRead(f);
	const out: MaterialSection[] = [];
	for (const section of names) {
		const content = getSectionContent(text, section);
		if (content && content.replace(/<!--[\s\S]*?-->/g, "").trim()) out.push({ path: f.path, section, content });
	}
	return out;
}

/** 「4-2」 1-2: today's Daily Pad sections and yesterday's My Life Daily sections, verbatim. */
export async function loadMaterial(host: DiaryHost, date: string): Promise<Material> {
	const { app, settings } = host;
	const pad = normalizePath(`${cleanFolder(settings.dailyPadFolder) || "04 Daily Pad"}/${date.slice(0, 4)}/${date}.md`);
	const yesterday = addDays(date, -1);
	const life = normalizePath(myLifeDailyPath(settings.myLifePath, yesterday));
	const s = settings.sections;
	return {
		todayPad: await sectionsOf(app, pad, [s.scribble, s.memo, s.log]),
		todayPadPath: pad,
		yesterdayLife: await sectionsOf(app, life, [INSIGHT_SECTION, "열린 질문"]),
		yesterdayLifePath: life,
	};
}

/** 「My Life에서」: the former My Life Diary tab aggregation (깨달음·감상 + 로그 of a month). */
export async function loadMyLifeMonth(host: DiaryHost, month: string): Promise<DiaryMonth> {
	const { app, settings } = host;
	const folder = app.vault.getAbstractFileByPath(normalizePath(dailyMonthFolder(settings.myLifePath, month)));
	const dailies: DiarySource[] = [];
	if (folder instanceof TFolder) {
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			const date = dateOfDailyName(child.basename);
			if (!date) continue;
			dailies.push({ path: child.path, date, text: await app.vault.cachedRead(child) });
		}
	}
	const mPath = normalizePath(monthlyPath(settings.myLifePath, `${month}-01`));
	const mFile = fileAt(app, mPath);
	const monthly = mFile ? { path: mPath, date: month, text: await app.vault.cachedRead(mFile) } : null;
	return aggregateDiary(month, dailies, monthly);
}
