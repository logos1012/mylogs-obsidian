/**
 * Diary view (`mylogs-diary`): Day One-style, three panes over `09 Diary/`.
 *
 *   타임라인 (left)   every entry, newest first, grouped by month, pinned on top; filter chips;
 *                     calendar strip (days with entries, first image, streak).
 *   에디터 (center)   the selected entry: date header, faded metadata strip (click → edit), the body
 *                     in a textarea with debounced autosave (Daily Pad pattern) and a rendered
 *                     preview toggle. First `# ` line ↔ frontmatter `title`; `updated` on save;
 *                     paste / drop images → `99 작업실/첨부/`.
 *   재료 (right)      「4-2」 material: 오늘 Daily Pad, 어제 My Life Daily, 그날의 기록, 오늘의 질문,
 *                     My Life에서 (the former My Life Diary tab). Click → the link joins `from`.
 *
 * The plugin never writes body text (`09 Diary/AGENTS.md` 「1」「5」): it creates empty entries,
 * shows material and saves what the user typed. Vault writes live in `actions.ts`.
 */

import { Component, ItemView, Keymap, MarkdownRenderer, Menu, moment, normalizePath, Notice, Platform, setIcon, type TAbstractFile, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import type MyLogsPlugin from "../main.ts";
import { addDays, fromIsoDate } from "../parser.ts";
import { shiftMonthKey, type DiaryMonth, isMonthKey } from "../mylife/model.ts";
import { todayIsoLocal } from "../desk/model.ts";
import { askForm, confirmDelete } from "../ui/modals.ts";
import { AutoGrow } from "../ui/autogrow.ts";
import { addFrom, attachmentFiles, createEntry, deleteEntry, type DiaryData, editMeta, loadDiary, loadMaterial, loadMyLifeMonth, type Material, readEntry, registryPath, root, saveAttachment, saveBody, togglePinned, toggleStarred } from "./actions.ts";
import { isOwnWrite, lastWritten } from "./sync.ts";
import { type DiaryMobileHost, renderDiaryMobile } from "./mobile.ts";
import {
	bodiesEqual,
	bodyOf,
	calendarDays,
	type DiaryEntry,
	displayTitle,
	filterEntries,
	groupTimeline,
	insertEmbed,
	monthLabel,
	normalizeBody,
	onThisDay,
	promptForDate,
	recentlyAnswered,
	splitTags,
	streakOf,
	tagCounts,
	type TimelineFilter,
	weekdayKo,
	wikilink,
	yearsOf,
} from "./model.ts";

export const VIEW_TYPE_DIARY = "mylogs-diary";

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

/** How long a UI action (「오늘 쓰기」, 미리보기, selecting another entry) waits for a save before going on. */
const SAVE_WAIT_MS = 4000;

function timeout(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

interface DiaryViewState {
	selected?: string;
	filter?: TimelineFilter;
	calendarOpen?: boolean;
	preview?: boolean;
}

// ───────────────────────── editor ─────────────────────────

/**
 * The body editor of one entry. Lives across re-renders of the same file so unsaved text is never
 * lost; saves on a debounce, on blur and when the view moves on. The save is one frontmatter-aware
 * replace of the body (model `withBody`), then the registry row.
 */
class EntryEditor {
	readonly path: string;
	/** Body as last synced with the file. */
	base: string;
	dirty = false;
	conflict = false;
	private pending: string | null = null;
	/** The text a save in flight is writing (so a modify event carrying it is ours, not a conflict). */
	private inFlight: string | null = null;
	private textarea: HTMLTextAreaElement | null = null;
	/** Auto-grow + caret follow for the mounted textarea (`src/ui/autogrow.ts`). */
	private grow: AutoGrow | null = null;
	private statusEl: HTMLElement | null = null;
	private barEl: HTMLElement | null = null;
	private saveTimer: number | null = null;
	/** The save queue. Never left rejected: every link catches, so the next keystroke can save again. */
	private saving: Promise<void> = Promise.resolve();

	constructor(
		private readonly view: DiaryView,
		private entry: DiaryEntry,
	) {
		this.path = entry.path;
		this.base = normalizeBody(entry.body);
	}

	get current(): DiaryEntry {
		return this.entry;
	}

	/** Unsaved text in the textarea (differs from the file). */
	private get hasUnsaved(): boolean {
		return this.pending !== null && !bodiesEqual(this.pending, this.base);
	}

	/** Build the textarea inside `host`. Keeps unsaved text across rebuilds. */
	mount(host: HTMLElement, statusEl: HTMLElement): void {
		this.statusEl = statusEl;
		this.barEl = host.createDiv({ cls: "dy-conflict" });
		this.barEl.hide();
		const ta = host.createEl("textarea", {
			cls: "dy-editor",
			attr: { spellcheck: "false", placeholder: "# 제목\n\n오늘의 글. 형식은 자유다.", "aria-label": "엔트리 본문 편집" },
		});
		ta.value = this.pending ?? this.base;
		this.textarea = ta;
		this.grow?.dispose();
		this.grow = new AutoGrow(ta, { minHeight: 320 });
		ta.addEventListener("input", () => {
			this.pending = ta.value;
			this.dirty = !bodiesEqual(ta.value, this.base);
			if (!this.conflict) this.setStatus(this.dirty ? "입력 중" : "");
			this.scheduleSave();
		});
		ta.addEventListener("blur", () => void this.flush());
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				void this.flush();
				ta.blur();
			}
		});
		ta.addEventListener("paste", (e) => void this.onFiles(e.clipboardData?.files ?? null, e));
		ta.addEventListener("drop", (e) => void this.onFiles(e.dataTransfer?.files ?? null, e));
		ta.addEventListener("dragover", (e) => {
			if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
		});
		if (this.conflict) this.showConflict();
	}

	focusEnd(): void {
		const ta = this.textarea;
		if (!ta) return;
		ta.focus();
		ta.selectionStart = ta.selectionEnd = ta.value.length;
	}

	/** Focus with the cursor in the body (after the `# ` title line) of a fresh entry. */
	focusBody(): void {
		const ta = this.textarea;
		if (!ta) return;
		ta.focus();
		const m = /^# [^\n]*\n\n?/.exec(ta.value);
		const pos = m ? m[0].length : ta.value.length;
		ta.selectionStart = ta.selectionEnd = Math.min(pos, ta.value.length);
	}

	/** Refit the height after a programmatic value change (no caret follow). */
	private autosize(): void {
		this.grow?.fit();
	}

	/**
	 * Fresh file text arrived (a refresh / reload). Our own writes — the save in flight, the last
	 * text we wrote — only move `base`; they never touch the textarea and never raise the conflict
	 * bar. A real external change replaces the text only when nothing is typed and the textarea is
	 * not focused; otherwise the bar shows and typing goes on.
	 */
	sync(entry: DiaryEntry): void {
		this.entry = entry;
		const fresh = normalizeBody(entry.body);
		if (bodiesEqual(fresh, this.base)) {
			this.base = fresh;
			return;
		}
		const last = lastWritten(this.path);
		const ours = (this.inFlight !== null && bodiesEqual(fresh, this.inFlight)) || (last !== null && bodiesEqual(fresh, bodyOf(last)));
		if (ours) {
			this.base = fresh;
			this.dirty = this.hasUnsaved;
			if (!this.dirty) this.pending = null;
			if (this.conflict) {
				this.hideConflict();
				this.setStatus(this.dirty ? "입력 중" : "");
			}
			return;
		}
		if (this.hasUnsaved || this.isFocused()) {
			this.showConflict();
			return;
		}
		this.base = fresh;
		this.pending = null;
		this.dirty = false;
		this.hideConflict();
		if (this.textarea) {
			const pos = this.textarea.selectionStart;
			this.textarea.value = fresh;
			this.textarea.selectionStart = this.textarea.selectionEnd = Math.min(pos, fresh.length);
			this.autosize();
		}
	}

	private isFocused(): boolean {
		return !!this.textarea && document.activeElement === this.textarea;
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, this.view.plugin.settings.autosaveDelayMs);
	}

	/** Queue one save step; an error is logged and shown, and the queue stays usable. */
	private enqueue(step: () => Promise<void>): Promise<void> {
		this.saving = this.saving.then(step).catch((err) => {
			this.inFlight = null;
			console.error("[MyLogs] Diary save failed", err);
			this.setStatus("저장 실패", true);
			new Notice("MyLogs: 엔트리 저장에 실패했어요.");
		});
		return this.saving;
	}

	flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		return this.enqueue(() => this.doSave());
	}

	/** `flush`, but a UI action waits at most `SAVE_WAIT_MS`: a slow disk (Google Drive) must not freeze the buttons. */
	settle(ms = SAVE_WAIT_MS): Promise<void> {
		return Promise.race([this.flush(), timeout(ms)]);
	}

	/**
	 * Write the textarea to the file. A conflict is re-checked against the file on every save, so a
	 * bar raised in error clears itself once the file matches again; a real one keeps the user's text
	 * in the textarea until 「다시 불러오기」 or 「내 내용으로 저장」.
	 */
	private async doSave(force = false): Promise<void> {
		if (this.pending === null || (!force && !this.hasUnsaved)) {
			if (!this.conflict && this.pending !== null && !this.hasUnsaved) {
				this.dirty = false;
				this.pending = null;
				this.setStatus("");
			}
			return;
		}
		const value = this.pending;
		this.setStatus("저장 중");
		this.inFlight = value;
		let r: Awaited<ReturnType<typeof saveBody>>;
		try {
			r = await saveBody(this.view.plugin, this.path, value, force ? null : this.base, force);
		} finally {
			this.inFlight = null;
		}
		if (!r.ok) {
			if (r.conflict) this.showConflict();
			else this.setStatus("저장 실패", true);
			return;
		}
		if (r.entry) {
			this.entry = r.entry;
			this.base = normalizeBody(r.entry.body);
		} else this.base = normalizeBody(value);
		this.dirty = this.hasUnsaved;
		if (!this.dirty) this.pending = null;
		this.hideConflict();
		this.setStatus("저장됨");
		window.setTimeout(() => {
			if (this.statusEl?.getText() === "저장됨") this.setStatus("");
		}, 1600);
		if (r.entry) this.view.entrySaved(r.entry);
	}

	private setStatus(text: string, error = false): void {
		if (!this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-error", error);
	}

	private showConflict(): void {
		const first = !this.conflict;
		this.conflict = true;
		this.setStatus("저장 안 됨", true);
		const bar = this.barEl;
		if (!bar || (!first && bar.childElementCount)) return;
		bar.empty();
		bar.show();
		const icon = bar.createSpan({ cls: "dy-conflict-icon" });
		setIcon(icon, "refresh-cw");
		bar.createSpan({ text: "파일에 새 내용이 있어요" });
		bar.createSpan({ cls: "dy-sep", text: "·" });
		const reload = bar.createEl("button", { cls: "dy-link-btn", text: "다시 불러오기", attr: { type: "button" } });
		reload.addEventListener("click", () => void this.guard("다시 불러오기", () => this.reloadFromFile()));
		const keep = bar.createEl("button", { cls: "dy-link-btn is-quiet", text: "내 내용으로 저장", attr: { type: "button" } });
		keep.addEventListener("click", () => void this.guard("내 내용으로 저장", () => this.keepMine()));
	}

	private hideConflict(): void {
		this.conflict = false;
		this.barEl?.hide();
		this.barEl?.empty();
	}

	private async guard(label: string, fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (err) {
			console.error(`[MyLogs] Diary ${label} failed`, err);
			new Notice(`MyLogs: ${label}에 실패했어요.`);
		}
	}

	private async reloadFromFile(): Promise<void> {
		const e = await readEntry(this.view.plugin, this.path);
		this.hideConflict();
		this.dirty = false;
		this.pending = null;
		this.setStatus("");
		if (e) {
			this.entry = e;
			this.base = normalizeBody(e.body);
		}
		if (this.textarea) {
			this.textarea.value = this.base;
			this.autosize();
		}
	}

	private async keepMine(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.pending === null && this.textarea) this.pending = this.textarea.value;
		this.dirty = true;
		await this.enqueue(() => this.doSave(true));
	}

	/** Pasted / dropped images: save under 첨부 and insert `![[…]]` at the cursor. */
	private async onFiles(files: FileList | null, e: Event): Promise<void> {
		if (!files || !this.textarea) return;
		const images = [...files].filter((f) => f.type.startsWith("image/"));
		if (!images.length) return;
		e.preventDefault();
		const ta = this.textarea;
		for (const img of images) {
			const path = await saveAttachment(this.view.plugin, this.entry, img);
			if (!path) continue;
			const r = insertEmbed(ta.value, ta.selectionStart, path);
			ta.value = r.text;
			ta.selectionStart = ta.selectionEnd = r.pos;
		}
		ta.dispatchEvent(new Event("input"));
		ta.focus();
	}

	/** Mobile image button (no paste / drop there): the same path as a pasted image. */
	insertFiles(files: FileList): Promise<void> {
		return this.onFiles(files, new Event("mylogs-insert"));
	}

	destroy(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.grow?.dispose();
		this.grow = null;
	}
}

// ───────────────────────── view ─────────────────────────

export class DiaryView extends ItemView {
	readonly plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private timelineEl!: HTMLElement;
	private editorEl!: HTMLElement;
	private materialEl!: HTMLElement;
	private data: DiaryData | null = null;
	private material: Material | null = null;
	private myLife: DiaryMonth | null = null;
	private myLifeMonth = "";
	private selected: string | null = null;
	private filter: TimelineFilter = {};
	private calendarOpen = false;
	private calendarMonth: string = todayIsoLocal().slice(0, 7);
	/** Opening the view or another entry reads first (미리보기); 「쓰기」 or 「오늘 쓰기」 edits. */
	private preview = true;
	private editor: EntryEditor | null = null;
	private renderChild: Component | null = null;
	private loadSeq = 0;
	private refreshTimer: number | null = null;
	private busy = false;

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DIARY;
	}
	getDisplayText(): string {
		return "Diary";
	}
	getIcon(): string {
		return "feather";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), selected: this.selected, filter: this.filter, calendarOpen: this.calendarOpen, preview: this.preview };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state as DiaryViewState | null) ?? {};
		if (typeof s.selected === "string") this.selected = s.selected;
		if (s.filter && typeof s.filter === "object") this.filter = { ...s.filter };
		if (typeof s.calendarOpen === "boolean") this.calendarOpen = s.calendarOpen;
		if (this.rootEl) await this.refresh();
		await super.setState(state, result);
	}

	// ── lifecycle ──

	private watched(path: string): boolean {
		const r = root(this.plugin);
		if (path === r || path.startsWith(`${r}/`)) return true;
		if (!this.material) return false;
		return path === this.material.todayPadPath || path === this.material.yesterdayLifePath;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-diary-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-diary" });
		mountAppNav(this);
		this.timelineEl = this.rootEl.createDiv({ cls: "dy-timeline" });
		this.editorEl = this.rootEl.createDiv({ cls: "dy-center" });
		this.materialEl = this.rootEl.createDiv({ cls: "dy-material" });
		const onFile = (kind: "modify" | "create" | "delete" | "rename", f: TAbstractFile, old?: string) => {
			try {
				if (!(this.watched(f.path) || (old && this.watched(old)))) return;
				// A modify carrying our own write (entry file, Diary Index.md) — or Google Drive
				// re-touching it with the same content after a sync — is not an external change:
				// no reload of the open editor. Anything else (a real edit, create, delete, rename) refreshes.
				if (kind === "modify" && f instanceof TFile && lastWritten(f.path) !== null) {
					this.app.vault
						.cachedRead(f)
						.then((text) => {
							if (!isOwnWrite(f.path, text)) this.scheduleRefresh();
						})
						.catch(() => this.scheduleRefresh());
					return;
				}
				this.scheduleRefresh();
			} catch (err) {
				console.error("[MyLogs] Diary file event failed", err);
			}
		};
		this.registerEvent(this.app.vault.on("modify", (f) => onFile("modify", f)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile("create", f)));
		this.registerEvent(this.app.vault.on("delete", (f) => onFile("delete", f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile("rename", f, old)));
		await this.refresh();
	}

	/** Run a UI action; an error is logged as `[MyLogs] …` and shown, never left to kill the view. */
	private async guard(label: string, fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (err) {
			console.error(`[MyLogs] Diary ${label} failed`, err);
			new Notice(`MyLogs: ${label}에 실패했어요.`);
		}
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		await this.editor?.flush();
		this.editor?.destroy();
		this.editor = null;
		if (this.renderChild) this.removeChild(this.renderChild);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refresh().catch((err) => console.error("[MyLogs] Diary refresh failed", err));
		}, 300);
	}

	/** Re-read the folder and re-render the three panes (the editor keeps unsaved text). */
	async refresh(): Promise<void> {
		if (!this.rootEl || this.busy) return;
		const seq = ++this.loadSeq;
		const data = await loadDiary(this.plugin);
		if (seq !== this.loadSeq) return;
		this.data = data;
		if (this.selected && !data.entries.some((e) => e.path === this.selected)) this.selected = null;
		if (!this.selected && data.entries.length) this.selected = [...data.entries].sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time))[0].path;
		const sel = this.selectedEntry();
		const month = sel?.date.slice(0, 7) ?? todayIsoLocal().slice(0, 7);
		if (!this.myLifeMonth) this.myLifeMonth = month;
		const [material, myLife] = await Promise.all([loadMaterial(this.plugin, todayIsoLocal()), loadMyLifeMonth(this.plugin, this.myLifeMonth)]);
		if (seq !== this.loadSeq) return;
		this.material = material;
		this.myLife = myLife;
		this.render();
	}

	private async run(fn: () => Promise<unknown>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.rootEl.addClass("is-busy");
		try {
			await fn();
		} finally {
			this.busy = false;
			this.rootEl.removeClass("is-busy");
			await this.refresh();
		}
	}

	private selectedEntry(): DiaryEntry | null {
		return this.data?.entries.find((e) => e.path === this.selected) ?? null;
	}

	private fileAt(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? f : null;
	}

	/** Resolve an embed target (`09 Diary/…/x.jpg` or a bare name) to a resource URL. */
	private imageUrl(link: string, sourcePath: string): string | null {
		const f = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath) ?? this.fileAt(link);
		return f ? this.app.vault.getResourcePath(f) : null;
	}

	private render(): void {
		if (Platform.isMobile) return renderDiaryMobile(this.mobileHost());
		if (this.renderChild) this.removeChild(this.renderChild);
		this.renderChild = this.addChild(new Component());
		this.rootEl.toggleClass("is-material-collapsed", this.plugin.settings.diaryMaterialCollapsed);
		// One pane failing to draw must not take the others (and their buttons) with it.
		for (const [name, draw] of [
			["timeline", () => this.renderTimeline()],
			["editor", () => this.renderEditor()],
			["material", () => this.renderMaterial()],
		] as const) {
			try {
				draw();
			} catch (err) {
				console.error(`[MyLogs] Diary ${name} render failed`, err);
			}
		}
	}

	/** What the mobile layout (`./mobile.ts`) may use: the same pane renderers and actions. */
	private mobileHost(): DiaryMobileHost {
		return {
			app: this.app,
			contentEl: this.contentEl,
			rootEl: this.rootEl,
			beginRender: () => {
				if (this.renderChild) this.removeChild(this.renderChild);
				this.renderChild = this.addChild(new Component());
			},
			renderTimeline: () => this.renderTimeline(),
			renderEditor: () => this.renderEditor(),
			renderMaterial: () => this.renderMaterial(),
			entries: () => this.data?.entries ?? [],
			hasSelection: () => !!this.selectedEntry(),
			select: (path) => this.select(path),
			writeToday: () => this.writeToday(),
			insertImages: async (files) => {
				if (!this.editor || this.preview) {
					new Notice("쓰기 화면에서 엔트리를 연 뒤에 넣어 주세요.");
					return;
				}
				await this.editor.insertFiles(files);
			},
			register: (cb) => this.register(cb),
		};
	}

	// ── actions ──

	/** 「오늘 쓰기」: a new empty entry (optionally answering a prompt), opened with the cursor in the body. */
	async writeToday(prompt = ""): Promise<void> {
		await this.guard("오늘 쓰기", async () => {
			await this.editor?.settle();
			let created: TFile | null = null;
			await this.run(async () => {
				created = await createEntry(this.plugin, prompt);
				if (created) this.selected = created.path;
			});
			if (created) {
				this.preview = false;
				this.renderEditor();
				this.editor?.focusBody();
				this.app.workspace.requestSaveLayout();
			}
		});
	}

	/** 「미리보기」 ↔ 「쓰기」. */
	async togglePreview(): Promise<void> {
		await this.guard("미리보기", async () => {
			await this.editor?.settle();
			this.preview = !this.preview;
			this.renderEditor();
			this.app.workspace.requestSaveLayout();
		});
	}

	async select(path: string): Promise<void> {
		if (path === this.selected) return;
		await this.guard("엔트리 열기", async () => {
			await this.editor?.settle();
			this.selected = path;
			this.preview = true;
			const e = this.selectedEntry();
			if (e && e.date.slice(0, 7) !== this.myLifeMonth) {
				this.myLifeMonth = e.date.slice(0, 7);
				this.myLife = await loadMyLifeMonth(this.plugin, this.myLifeMonth);
			}
			this.renderTimeline();
			this.renderEditor();
			this.renderMaterial();
			this.app.workspace.requestSaveLayout();
		});
	}

	/** The editor saved: refresh the entry in the timeline without re-reading the folder. */
	entrySaved(e: DiaryEntry): void {
		if (!this.data) return;
		const i = this.data.entries.findIndex((x) => x.path === e.path);
		if (i !== -1) this.data.entries[i] = e;
		this.renderTimeline();
		this.renderMetaStrip();
	}

	private async star(e: DiaryEntry): Promise<void> {
		await this.run(() => toggleStarred(this.plugin, e));
	}
	private async pin(e: DiaryEntry): Promise<void> {
		await this.run(() => togglePinned(this.plugin, e));
	}

	private async remove(e: DiaryEntry): Promise<void> {
		const attachments = attachmentFiles(this.plugin, e);
		const ans = await confirmDelete(this.app, {
			title: "엔트리 삭제",
			removes: [e.path, ...attachments.map((a) => a.path)],
			notes: ["등록부(Diary Index.md)의 행을 지우고 변경 기록에 「삭제」 한 줄을 남겨요.", "My Life Daily의 링크는 그대로 둬요(기록)."],
			footer: "파일은 휴지통으로 가서 되살릴 수 있어요.",
		});
		if (ans !== "delete") return;
		if (this.editor?.path === e.path) {
			this.editor.destroy();
			this.editor = null;
		}
		await this.run(async () => {
			if (await deleteEntry(this.plugin, e)) this.selected = null;
		});
	}

	private async editMetaOf(e: DiaryEntry): Promise<void> {
		const v = await askForm(this.app, {
			title: "시각 · 장소 · 날씨 · 태그",
			desc: "frontmatter만 바꿔요. 본문은 그대로예요.",
			fields: [
				{ key: "time", label: "시각", type: "text", value: e.time, placeholder: "22:10", desc: "쓴 시각(HH:MM). 파일 이름은 바꾸지 않아요." },
				{ key: "location", label: "장소", type: "text", value: e.location, placeholder: "집, 제주 공항" },
				{ key: "weather", label: "날씨", type: "text", value: e.weather, placeholder: "맑음 3°C" },
				{ key: "tags", label: "태그", type: "text", value: e.tags.join(", "), placeholder: "사이드프로젝트, 달리기", list: tagCounts(this.data?.entries ?? []).map(([t]) => t) },
			],
			validate: (x) => (x.time && !/^\d{1,2}:\d{2}$/.test(x.time) ? ["시각은 HH:MM 형식으로 적어 주세요."] : []),
		});
		if (!v) return;
		await this.run(() => editMeta(this.plugin, e, { time: v.time.padStart(5, "0"), location: v.location, weather: v.weather, tags: splitTags(v.tags) }));
	}

	/** 「4-2」 5: a material link joins the current entry's `from`. */
	private async addMaterial(link: string): Promise<void> {
		const e = this.selectedEntry();
		if (!e) {
			new Notice("먼저 엔트리를 고르거나 「오늘 쓰기」로 하나 만들어 주세요.");
			return;
		}
		if (e.from.includes(link)) {
			new Notice("이미 from에 있어요.");
			return;
		}
		await this.run(() => addFrom(this.plugin, e, link));
		new Notice("from에 링크를 더했어요. 본문에는 넣지 않아요.");
	}

	private openFile(path: string, ev?: MouseEvent): void {
		const f = this.fileAt(path);
		if (f) void this.app.workspace.getLeaf(ev ? Keymap.isModEvent(ev) : "tab").openFile(f);
		else new Notice(`파일이 없어요: ${path}`);
	}

	private menu(ev: MouseEvent, e: DiaryEntry): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle(e.starred ? "별 빼기" : "별 표시 ★").setIcon("star").onClick(() => void this.star(e)));
		menu.addItem((i) => i.setTitle(e.pinned ? "고정 풀기" : "맨 위에 고정").setIcon("pin").onClick(() => void this.pin(e)));
		menu.addItem((i) => i.setTitle("시각·장소·날씨·태그…").setIcon("pencil").onClick(() => void this.editMetaOf(e)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("마크다운 파일 열기").setIcon("file-text").onClick(() => this.openFile(e.path)));
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("삭제…")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void this.remove(e)),
		);
		menu.showAtMouseEvent(ev);
	}

	// ── timeline ──

	private renderTimeline(): void {
		const el = this.timelineEl;
		el.empty();
		const d = this.data;
		if (!d) return;
		const today = todayIsoLocal();

		const head = el.createDiv({ cls: "dy-tl-head" });
		const titles = head.createDiv({ cls: "dy-titles" });
		titles.createDiv({ cls: "dy-eyebrow", text: "Diary" });
		const h1 = titles.createEl("h1", { cls: "dy-title", text: "일기" });
		const streak = streakOf(
			d.entries.map((e) => e.date),
			today,
		);
		if (streak) h1.createSpan({ cls: "dy-streak", text: `${streak}일째`, attr: { title: "오늘까지 이어서 쓴 날" } });
		const tools = head.createDiv({ cls: "dy-tl-tools" });
		const write = tools.createEl("button", { cls: "dy-btn dy-btn-primary", attr: { type: "button", "aria-label": "오늘 쓰기: 지금 시각으로 빈 엔트리를 만든다" } });
		setIcon(write.createSpan({ cls: "dy-btn-ico" }), "pen-line");
		write.createSpan({ text: "오늘 쓰기" });
		write.addEventListener("click", () => void this.writeToday());
		const cal = tools.createEl("button", { cls: `dy-btn dy-btn-icon${this.calendarOpen ? " is-active" : ""}`, attr: { type: "button", "aria-label": "캘린더 접기/펼치기", "aria-pressed": this.calendarOpen ? "true" : "false" } });
		setIcon(cal, "calendar-days");
		cal.addEventListener("click", () => {
			this.calendarOpen = !this.calendarOpen;
			this.renderTimeline();
			this.app.workspace.requestSaveLayout();
		});

		if (!d.hasRegistry) {
			const warn = el.createDiv({ cls: "dy-warn", attr: { title: "저장할 때 등록부 행을 갱신하지 못해요 (09 Diary/AGENTS.md 「4-4」)" } });
			setIcon(warn.createSpan({ cls: "dy-warn-ico" }), "alert-triangle");
			warn.createSpan({ text: "등록부 없음: " });
			warn.createEl("code", { text: registryPath(this.plugin) });
		}
		if (this.calendarOpen) this.renderCalendar(el.createDiv({ cls: "dy-cal" }));
		this.renderChips(el.createDiv({ cls: "dy-chips" }));

		if (!d.entries.length) {
			const empty = el.createDiv({ cls: "dy-empty" });
			tip(empty.createDiv({ cls: "dy-empty-title", text: "아직 쓴 글이 없어요" }), "「오늘 쓰기」가 지금 시각으로 빈 엔트리를 만들어요. 본문은 내가 써요.");
			return;
		}
		const shown = filterEntries(d.entries, this.filter);
		const list = el.createDiv({ cls: "dy-list" });
		if (!shown.length) {
			list.createDiv({ cls: "dy-none", text: "조건에 맞는 엔트리가 없다" });
			return;
		}
		for (const g of groupTimeline(shown)) {
			const group = list.createDiv({ cls: `dy-group${g.key === "pinned" ? " is-pinned" : ""}` });
			const gh = group.createDiv({ cls: "dy-group-head" });
			if (g.key === "pinned") {
				setIcon(gh.createSpan({ cls: "dy-group-ico" }), "pin");
				gh.createSpan({ text: "고정" });
			} else {
				gh.createSpan({ text: monthLabel(g.key) });
				gh.createSpan({ cls: "dy-group-n", text: `${g.rows.length}` });
			}
			for (const row of g.rows) this.renderRow(group, row.entry, row.showDate, g.key === "pinned");
		}
	}

	private renderRow(parent: HTMLElement, e: DiaryEntry, showDate: boolean, inPinned: boolean): void {
		const row = parent.createDiv({
			cls: `dy-row${e.path === this.selected ? " is-selected" : ""}${showDate ? "" : " is-same-day"}`,
			attr: { role: "button", tabindex: "0", "data-date": inPinned ? "" : e.date, "data-path": e.path },
		});
		const date = row.createDiv({ cls: "dy-row-date" });
		if (showDate) {
			date.createDiv({ cls: "dy-row-wd", text: weekdayKo(e.date) });
			date.createDiv({ cls: "dy-row-day", text: String(+e.date.slice(8, 10)) });
			if (inPinned || e.date.slice(0, 4) !== todayIsoLocal().slice(0, 4)) date.createDiv({ cls: "dy-row-ym", text: e.date.slice(0, 7) });
		}
		const main = row.createDiv({ cls: "dy-row-main" });
		const t = main.createDiv({ cls: `dy-row-title${e.title ? "" : " is-untitled"}` });
		if (e.pinned && !inPinned) setIcon(t.createSpan({ cls: "dy-row-pin" }), "pin");
		if (e.starred) t.createSpan({ cls: "dy-row-star", text: "★" });
		t.createSpan({ text: displayTitle(e) });
		if (e.preview) main.createDiv({ cls: "dy-row-preview", text: e.preview });
		const meta = main.createDiv({ cls: "dy-row-meta" });
		meta.createSpan({ cls: "dy-row-time", text: e.time });
		for (const tag of e.tags) meta.createSpan({ cls: "dy-row-tag", text: `#${tag}` });
		if (e.location) meta.createSpan({ cls: "dy-row-loc", text: e.location });
		if (e.firstImage) {
			const url = this.imageUrl(e.firstImage, e.path);
			const thumb = row.createDiv({ cls: "dy-row-thumb" });
			if (url) thumb.style.backgroundImage = `url("${url}")`;
			else thumb.addClass("is-missing");
		}
		row.addEventListener("click", () => void this.select(e.path));
		row.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				void this.select(e.path);
			}
		});
		row.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			this.menu(ev, e);
		});
	}

	private renderChips(el: HTMLElement): void {
		const d = this.data!;
		const f = this.filter;
		const chip = (label: string, active: boolean, onClick: () => void, cls = "") => {
			const b = el.createEl("button", { cls: `dy-chip${active ? " is-active" : ""} ${cls}`.trim(), text: label, attr: { type: "button", "aria-pressed": active ? "true" : "false" } });
			b.addEventListener("click", onClick);
			return b;
		};
		const apply = (next: TimelineFilter) => {
			this.filter = next;
			this.renderTimeline();
			this.app.workspace.requestSaveLayout();
		};
		chip("전체", !f.starred && !f.tag && !f.year, () => apply({}));
		chip("★", !!f.starred, () => apply({ ...f, starred: !f.starred }), "dy-chip-star");
		const tags = tagCounts(d.entries);
		if (tags.length) {
			const sel = el.createEl("select", { cls: `dy-chip dy-chip-select${f.tag ? " is-active" : ""}`, attr: { "aria-label": "태그 고르기" } });
			sel.createEl("option", { text: "태그", attr: { value: "" } });
			for (const [t, n] of tags) sel.createEl("option", { text: `#${t} (${n})`, attr: { value: t } });
			sel.value = f.tag ?? "";
			sel.addEventListener("change", () => apply({ ...f, tag: sel.value || undefined }));
		}
		const years = yearsOf(d.entries);
		if (years.length > 1) {
			const sel = el.createEl("select", { cls: `dy-chip dy-chip-select${f.year ? " is-active" : ""}`, attr: { "aria-label": "연도 고르기" } });
			sel.createEl("option", { text: "연도", attr: { value: "" } });
			for (const y of years) sel.createEl("option", { text: y, attr: { value: y } });
			sel.value = f.year ?? "";
			sel.addEventListener("change", () => apply({ ...f, year: sel.value || undefined }));
		}
	}

	// ── calendar ──

	private renderCalendar(el: HTMLElement): void {
		const d = this.data!;
		const month = this.calendarMonth;
		const nav = el.createDiv({ cls: "dy-cal-nav" });
		const prev = nav.createEl("button", { cls: "dy-btn dy-btn-icon", text: "◀", attr: { type: "button", "aria-label": "이전 달" } });
		prev.addEventListener("click", () => this.showCalendarMonth(shiftMonthKey(month, -1)));
		nav.createSpan({ cls: "dy-cal-month", text: monthLabel(month) });
		const next = nav.createEl("button", { cls: "dy-btn dy-btn-icon", text: "▶", attr: { type: "button", "aria-label": "다음 달" } });
		next.addEventListener("click", () => this.showCalendarMonth(shiftMonthKey(month, 1)));
		const todayKey = todayIsoLocal().slice(0, 7);
		if (month !== todayKey) {
			const back = nav.createEl("button", { cls: "dy-btn dy-btn-small", text: "이번 달", attr: { type: "button" } });
			back.addEventListener("click", () => this.showCalendarMonth(todayKey));
		}
		const grid = el.createDiv({ cls: "dy-cal-grid" });
		for (const w of WEEKDAYS) grid.createDiv({ cls: "dy-cal-wd", text: w });
		const first = fromIsoDate(`${month}-01`);
		if (!first) return;
		const lead = (first.getDay() + 6) % 7;
		for (let i = 0; i < lead; i++) grid.createDiv({ cls: "dy-cal-cell is-blank" });
		const days = calendarDays(d.entries, month);
		const today = todayIsoLocal();
		let cur = `${month}-01`;
		while (cur.startsWith(`${month}-`)) {
			const info = days.get(cur);
			const cell = grid.createEl("button", {
				cls: `dy-cal-cell${info ? " is-filled" : ""}${cur === today ? " is-today" : ""}${cur > today ? " is-future" : ""}`,
				attr: { type: "button", "aria-label": `${cur}${info ? ` · 엔트리 ${info.count}개` : ""}` },
			});
			if (!info) cell.setAttr("disabled", "true");
			if (info?.image) {
				const url = this.imageUrl(info.image, "");
				if (url) {
					cell.addClass("has-image");
					cell.style.backgroundImage = `url("${url}")`;
				}
			}
			cell.createSpan({ cls: "dy-cal-day", text: String(+cur.slice(8, 10)) });
			if (info && info.count > 1) cell.createSpan({ cls: "dy-cal-n", text: String(info.count) });
			const date = cur;
			if (info) cell.addEventListener("click", () => this.scrollToDay(date));
			cur = addDays(cur, 1);
		}
	}

	private showCalendarMonth(month: string): void {
		if (!isMonthKey(month)) return;
		this.calendarMonth = month;
		this.renderTimeline();
	}

	/** Calendar click: scroll the timeline to that day (clearing a filter that hides it) and select its newest entry. */
	private scrollToDay(date: string): void {
		const d = this.data;
		if (!d) return;
		const hidden = !filterEntries(d.entries, this.filter).some((e) => e.date === date);
		if (hidden) {
			this.filter = {};
			this.renderTimeline();
		}
		const row = this.timelineEl.querySelector<HTMLElement>(`.dy-row[data-date="${date}"]`);
		if (!row) return;
		row.scrollIntoView({ block: "start", behavior: "smooth" });
		const path = row.getAttr("data-path");
		if (path) void this.select(path);
	}

	// ── editor pane ──

	private metaEl: HTMLElement | null = null;
	private fromEl: HTMLElement | null = null;
	/** What the editor pane currently shows (`path|preview`), so a refresh keeps a mounted textarea. */
	private mounted = "";

	private renderEditor(): void {
		const el = this.editorEl;
		const e = this.selectedEntry();
		const key = e ? `${e.path}|${this.preview ? 1 : 0}` : "";
		if (e && this.editor && this.editor.path === e.path && key === this.mounted && !this.preview) {
			// Same entry, textarea already on screen (our own save's modify event, a registry write,
			// a material click): sync the text, redraw the strip and from links, keep focus and cursor.
			this.editor.sync(e);
			this.renderMetaStrip();
			this.renderFromLinks(e);
			return;
		}
		el.empty();
		this.mounted = key;
		this.fromEl = null;
		if (!e) {
			if (this.editor) {
				this.editor.destroy();
				this.editor = null;
			}
			const empty = el.createDiv({ cls: "dy-sheet dy-sheet-empty" });
			empty.createDiv({ cls: "dy-empty-title", text: this.data?.entries.length ? "왼쪽에서 엔트리를 고르세요" : "빈 화면과 커서" });
			const write = tip(empty.createEl("button", { cls: "dy-btn dy-btn-primary", text: "오늘 쓰기", attr: { type: "button" } }), "지금 시각으로 빈 엔트리를 만들어요. 재료는 오른쪽에, 글은 여기에.");
			write.addEventListener("click", () => void this.writeToday());
			this.renderMaterialToggle(el);
			return;
		}
		if (this.editor && this.editor.path !== e.path) {
			void this.editor.flush();
			this.editor.destroy();
			this.editor = null;
		}
		if (!this.editor) this.editor = new EntryEditor(this, e);
		else this.editor.sync(e);

		const bar = el.createDiv({ cls: "dy-sheet-bar" });
		const status = bar.createSpan({ cls: "dy-save-status" });
		const right = bar.createDiv({ cls: "dy-sheet-tools" });
		const pv = right.createEl("button", { cls: `dy-btn dy-btn-small${this.preview ? " is-active" : ""}`, text: this.preview ? "쓰기" : "미리보기", attr: { type: "button", "aria-pressed": this.preview ? "true" : "false" } });
		pv.addEventListener("click", () => void this.togglePreview());
		const open = right.createEl("button", { cls: "dy-btn dy-btn-icon", attr: { type: "button", "aria-label": "마크다운 파일 열기" } });
		setIcon(open, "file-text");
		open.addEventListener("click", (ev) => this.openFile(e.path, ev));
		const more = right.createEl("button", { cls: "dy-btn dy-btn-icon", attr: { type: "button", "aria-label": "더 보기" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (ev) => this.menu(ev, this.editor?.current ?? e));
		this.renderMaterialToggle(right);

		const sheet = el.createDiv({ cls: "dy-sheet" });
		const head = sheet.createDiv({ cls: "dy-sheet-head" });
		const m = moment(e.date, "YYYY-MM-DD");
		head.createDiv({ cls: "dy-sheet-date", text: m.format("YYYY년 M월 D일 dddd") });
		this.metaEl = head.createDiv({ cls: "dy-meta" });
		this.renderMetaStrip();

		const body = sheet.createDiv({ cls: "dy-sheet-body" });
		if (this.preview) {
			const md = body.createDiv({ cls: "dy-md markdown-rendered" });
			void this.renderMarkdown(md, (this.editor.current ?? e).body, e.path);
			md.addEventListener("dblclick", () => {
				this.preview = false;
				this.renderEditor();
				this.editor?.focusEnd();
			});
		} else this.editor.mount(body, status);
		this.fromEl = sheet.createDiv({ cls: "dy-from" });
		this.renderFromLinks(e);
	}

	/** The `from` links under the sheet (「4-2」 5: material is linked, never copied). */
	private renderFromLinks(e: DiaryEntry): void {
		const from = this.fromEl;
		if (!from) return;
		from.empty();
		from.toggleClass("is-empty", !e.from.length);
		if (!e.from.length) return;
		from.createSpan({ cls: "dy-from-label", text: "from" });
		for (const link of e.from) {
			const target = link.replace(/^\[\[|\]\]$/g, "").replace(/\|.*$/, "");
			const a = from.createEl("a", { cls: "dy-from-link", text: target, attr: { href: "#" } });
			a.addEventListener("click", (ev) => {
				ev.preventDefault();
				void this.app.workspace.openLinkText(target, e.path, Keymap.isModEvent(ev));
			});
		}
	}

	/** The faded `시각 · 장소 · 날씨 · 태그` line; click → the small edit form. */
	private renderMetaStrip(): void {
		const el = this.metaEl;
		const e = this.editor?.current ?? this.selectedEntry();
		if (!el || !e) return;
		el.empty();
		const btn = el.createEl("button", { cls: "dy-meta-btn", attr: { type: "button", "aria-label": "시각·장소·날씨·태그 편집" } });
		const parts: string[] = [e.time];
		if (e.location) parts.push(e.location);
		if (e.weather) parts.push(e.weather);
		for (const p of parts) btn.createSpan({ cls: "dy-meta-part", text: p });
		for (const t of e.tags) btn.createSpan({ cls: "dy-meta-tag", text: `#${t}` });
		if (!e.location && !e.weather && !e.tags.length) btn.createSpan({ cls: "dy-meta-hint", text: "장소 · 날씨 · 태그" });
		if (e.prompt) el.createDiv({ cls: "dy-meta-prompt", text: `질문: ${e.prompt}` });
		btn.addEventListener("click", () => void this.editMetaOf(e));
	}

	private renderMaterialToggle(parent: HTMLElement): void {
		const collapsed = this.plugin.settings.diaryMaterialCollapsed;
		const b = parent.createEl("button", { cls: `dy-btn dy-btn-icon dy-material-toggle${collapsed ? "" : " is-active"}`, attr: { type: "button", "aria-label": collapsed ? "재료 패널 펼치기" : "재료 패널 접기", "aria-pressed": collapsed ? "false" : "true" } });
		setIcon(b, "panel-right");
		b.addEventListener("click", () => void this.toggleMaterial());
	}

	private async toggleMaterial(): Promise<void> {
		await this.guard("재료 패널 접기/펼치기", async () => {
			const s = this.plugin.settings;
			s.diaryMaterialCollapsed = !s.diaryMaterialCollapsed;
			// Plain save: a settings refresh would redraw every view for a fold.
			await this.plugin.saveData(s);
			this.rootEl.toggleClass("is-material-collapsed", s.diaryMaterialCollapsed);
			await this.editor?.settle();
			this.mounted = ""; // the toggle button lives in the sheet bar: rebuild it
			this.renderEditor();
		});
	}

	private async renderMarkdown(el: HTMLElement, content: string, sourcePath: string): Promise<void> {
		if (!this.renderChild) return;
		await MarkdownRenderer.render(this.app, content, el, sourcePath, this.renderChild);
		el.addEventListener("click", (ev) => {
			const a = (ev.target as HTMLElement).closest("a");
			if (!a || !a.hasClass("internal-link")) return;
			ev.preventDefault();
			const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
			void this.app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(ev));
		});
	}

	// ── material pane (「4-2」) ──

	private renderMaterial(): void {
		const el = this.materialEl;
		el.empty();
		const d = this.data;
		if (!d) return;
		const today = todayIsoLocal();
		const sel = this.selectedEntry();
		const inFrom = (link: string) => !!sel?.from.includes(link);

		const head = el.createDiv({ cls: "dy-mat-head" });
		tip(head.createDiv({ cls: "dy-eyebrow", text: "재료" }), "보여 주기만 해요. 누르면 이 글의 출처로 링크가 남고, 본문에는 들어가지 않아요.");

		// ① 오늘 Daily Pad
		const m = this.material;
		const pad = this.section(el, "① 오늘 Daily Pad", m?.todayPadPath ?? "", today);
		if (!m?.todayPad.length) pad.createDiv({ cls: "dy-mat-none", text: "메모 · 로그가 비어 있다" });
		else for (const s of m.todayPad) this.materialCard(pad, s.section, s.content, s.path, wikilink(s.path, s.section), inFrom(wikilink(s.path, s.section)));

		// ② 어제 My Life Daily
		const yesterday = addDays(today, -1);
		const life = this.section(el, "② 어제 My Life", m?.yesterdayLifePath ?? "", yesterday);
		if (!m?.yesterdayLife.length) life.createDiv({ cls: "dy-mat-none", text: "어제 Daily가 없거나 깨달음·감상 · 열린 질문이 비어 있다" });
		else for (const s of m.yesterdayLife) this.materialCard(life, s.section, s.content, s.path, wikilink(s.path, s.section), inFrom(wikilink(s.path, s.section)));

		// ③ 그날의 기록
		const baseDate = sel?.date ?? today;
		const otd = onThisDay(d.entries, baseDate);
		const otdSec = this.section(el, "③ 그날의 기록", "", `${baseDate.slice(5, 7)}월 ${+baseDate.slice(8, 10)}일`);
		if (!otd.length) otdSec.createDiv({ cls: "dy-mat-none", text: "지난 해 같은 날의 글이 없다" });
		for (const e of otd) {
			const item = otdSec.createDiv({ cls: "dy-mat-entry" });
			const b = item.createEl("button", { cls: "dy-mat-entry-open", attr: { type: "button", "aria-label": `${displayTitle(e)} 열기` } });
			b.createDiv({ cls: "dy-mat-entry-year", text: e.date.slice(0, 4) });
			b.createDiv({ cls: "dy-mat-entry-title", text: displayTitle(e) });
			if (e.preview) b.createDiv({ cls: "dy-mat-entry-preview", text: e.preview });
			b.addEventListener("click", () => void this.select(e.path));
			this.fromButton(item, wikilink(e.path), inFrom(wikilink(e.path)));
		}

		// ④ 오늘의 질문
		const q = this.section(el, "④ 오늘의 질문", "", today);
		const prompt = d.prompts.length ? promptForDate(d.prompts, today, recentlyAnswered(d.entries, today)) : null;
		if (!d.prompts.length) q.createDiv({ cls: "dy-mat-none", text: "99 작업실/프롬프트.md에 질문이 없다" });
		else if (!prompt) q.createDiv({ cls: "dy-mat-none", text: "모든 질문에 90일 안에 답했다" });
		else {
			q.createDiv({ cls: "dy-prompt", text: prompt });
			const answer = q.createEl("button", { cls: "dy-btn dy-btn-primary dy-btn-small", text: "답하기", attr: { type: "button", "aria-label": "이 질문으로 새 엔트리 만들기" } });
			answer.addEventListener("click", () => void this.writeToday(prompt));
		}

		// My Life에서 (the former My Life Diary tab)
		this.renderMyLifeSection(el, inFrom);
	}

	private section(parent: HTMLElement, title: string, path: string, sub: string): HTMLElement {
		const sec = parent.createDiv({ cls: "dy-mat-sec" });
		const h = sec.createDiv({ cls: "dy-mat-sec-head" });
		h.createEl("h3", { cls: "dy-mat-sec-title", text: title });
		if (sub) h.createSpan({ cls: "dy-mat-sec-sub", text: sub });
		if (path) {
			const open = h.createEl("button", { cls: "dy-btn dy-btn-icon dy-btn-tiny", attr: { type: "button", "aria-label": `${path} 열기` } });
			setIcon(open, "file-text");
			open.addEventListener("click", (ev) => this.openFile(path, ev));
		}
		return sec;
	}

	/** One material card: section name, verbatim markdown, a from button. */
	private materialCard(parent: HTMLElement, name: string, content: string, sourcePath: string, link: string, added: boolean): void {
		const card = parent.createDiv({ cls: `dy-mat-card${added ? " is-added" : ""}` });
		const h = card.createDiv({ cls: "dy-mat-card-head" });
		h.createSpan({ cls: "dy-mat-card-name", text: name });
		this.fromButton(h, link, added);
		const md = card.createDiv({ cls: "dy-md dy-md-small markdown-rendered" });
		void this.renderMarkdown(md, content, sourcePath);
	}

	private fromButton(parent: HTMLElement, link: string, added: boolean): void {
		const b = parent.createEl("button", { cls: `dy-from-btn${added ? " is-added" : ""}`, attr: { type: "button", "aria-label": added ? "이미 from에 있음" : "from에 링크 추가", title: link } });
		setIcon(b.createSpan({ cls: "dy-from-ico" }), added ? "check" : "link");
		b.createSpan({ text: added ? "from" : "+ from" });
		if (!added) b.addEventListener("click", () => void this.addMaterial(link));
	}

	private renderMyLifeSection(parent: HTMLElement, inFrom: (link: string) => boolean): void {
		const ml = this.myLife;
		const month = this.myLifeMonth;
		const sec = parent.createDiv({ cls: "dy-mat-sec dy-mat-mylife" });
		const h = sec.createDiv({ cls: "dy-mat-sec-head" });
		h.createEl("h3", { cls: "dy-mat-sec-title", text: "My Life에서" });
		const nav = h.createDiv({ cls: "dy-mat-nav" });
		const prev = nav.createEl("button", { cls: "dy-btn dy-btn-icon dy-btn-tiny", text: "◀", attr: { type: "button", "aria-label": "이전 달" } });
		prev.addEventListener("click", () => void this.showMyLifeMonth(shiftMonthKey(month, -1)));
		nav.createSpan({ cls: "dy-mat-sec-sub", text: month });
		const next = nav.createEl("button", { cls: "dy-btn dy-btn-icon dy-btn-tiny", text: "▶", attr: { type: "button", "aria-label": "다음 달" } });
		next.addEventListener("click", () => void this.showMyLifeMonth(shiftMonthKey(month, 1)));
		tip(nav, "그 달 Daily의 깨달음·감상 · 로그와 Monthly의 깨달음·감상, 원문 그대로");
		if (!ml || !ml.entries.length) {
			sec.createDiv({ cls: "dy-mat-none", text: "이 달의 My Life 기록이 아직 없다" });
			return;
		}
		let groupKey = "";
		for (const e of ml.entries) {
			const key = `${e.unit}:${e.date}`;
			if (key !== groupKey) {
				groupKey = key;
				const gh = sec.createDiv({ cls: `dy-ml-date${e.unit === "monthly" ? " is-monthly" : ""}` });
				const a = gh.createEl("a", { cls: "dy-ml-link", text: e.unit === "monthly" ? `Monthly ${e.date}` : moment(e.date, "YYYY-MM-DD").format("M월 D일 (ddd)"), attr: { href: "#" } });
				a.addEventListener("click", (ev) => {
					ev.preventDefault();
					this.openFile(e.path, ev);
				});
				if (e.unit === "daily") {
					const here = gh.createEl("button", { cls: "dy-link-btn is-quiet", text: "My Life에서", attr: { type: "button", "aria-label": "이 날짜의 My Life 오늘 탭 열기" } });
					here.addEventListener("click", () => void this.plugin.activateMyLife(e.date));
				}
			}
			this.materialCard(sec, e.section, e.content, e.path, wikilink(e.path, e.section), inFrom(wikilink(e.path, e.section)));
		}
	}

	private async showMyLifeMonth(month: string): Promise<void> {
		if (!isMonthKey(month) || month === this.myLifeMonth) return;
		this.myLifeMonth = month;
		this.myLife = await loadMyLifeMonth(this.plugin, month);
		this.renderMaterial();
	}
}
