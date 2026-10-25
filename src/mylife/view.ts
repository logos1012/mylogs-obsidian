/**
 * My Life view (`mylogs-my-life`): one screen, a date picker and five tabs
 * (오늘 / 이번 주 / 이번 달 / 올해 / Diary) over the `08 My Life/` record files.
 *
 * Read-only by design (Hermes writes the files: `08 My Life/AGENTS.md` 「1」「6」). The one
 * exception is `## 사용자 한마디` (Weekly and up), which the user writes here; the save touches only
 * that section (model `setUserNote`). Missing files are shown, never created.
 */

import {
	Component,
	ItemView,
	Keymap,
	MarkdownRenderer,
	moment,
	normalizePath,
	Notice,
	setIcon,
	type TAbstractFile,
	TFile,
	TFolder,
	type ViewStateResult,
	type WorkspaceLeaf,
} from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { addDays, fromIsoDate } from "../parser.ts";
import { todayIsoLocal } from "../desk/model.ts";
import {
	aggregateDiary,
	dailyMonthFolder,
	dateOfDailyName,
	type DiaryEntry,
	type DiaryMonth,
	type DiarySource,
	hasUserNote,
	isMonthKey,
	MY_LIFE_TABS,
	type MyLifeFile,
	type MyLifeTab,
	type MyLifeUnit,
	monthlyPath,
	normalizeNote,
	parseMyLifeFile,
	setUserNote,
	shiftMonthKey,
	UNIT_LABEL,
	unitPath,
	unitTitle,
	USER_NOTE_SECTION,
	userNoteOf,
} from "./model.ts";

export const VIEW_TYPE_MY_LIFE = "mylogs-my-life";

const UNIT_HINT: Record<MyLifeUnit, string> = {
	daily: "Tear-off가 끝나면 Hermes가 그날을 쓴다",
	weekly: "일요일 자정이 지나면 Hermes가 끝난 ISO 주를 쓴다",
	monthly: "말일 자정이 지나면 Hermes가 초안을 쓰고, Desk Reset·Drawer 리뷰 뒤에 채운다",
	yearly: "12월 31일 자정이 지나면 Hermes가 초안을 쓴다",
};

function isUnit(tab: MyLifeTab): tab is MyLifeUnit {
	return tab !== "diary";
}

function isTab(s: unknown): s is MyLifeTab {
	return typeof s === "string" && (MY_LIFE_TABS as readonly string[]).includes(s);
}

// ───────────────────────── 사용자 한마디 editor ─────────────────────────

/**
 * The one writable spot. Lives across re-renders of the same file so unsaved text is never lost;
 * saves on a debounce and on blur, into exactly `## 사용자 한마디`.
 */
class UserNoteEditor {
	readonly path: string;
	private readonly view: MyLifeView;
	/** Section content as last synced with the file (null = section missing). */
	base: string | null;
	dirty = false;
	conflict = false;
	private textarea: HTMLTextAreaElement | null = null;
	private statusEl: HTMLElement | null = null;
	private barEl: HTMLElement | null = null;
	private saveTimer: number | null = null;
	private saving: Promise<void> = Promise.resolve();
	private pending: string | null = null;

	constructor(view: MyLifeView, path: string, text: string) {
		this.view = view;
		this.path = path;
		this.base = userNoteOf(text);
	}

	/** Build (or rebuild) the editor inside `card`. Keeps unsaved text across rebuilds. */
	mount(card: HTMLElement): void {
		const tools = card.querySelector<HTMLElement>(".mlf-card-tools");
		this.statusEl = tools ? tools.createSpan({ cls: "mlf-save-status" }) : null;
		const body = card.createDiv({ cls: "mlf-card-body mlf-note-body" });
		this.barEl = body.createDiv({ cls: "mlf-conflict" });
		this.barEl.hide();
		const ta = body.createEl("textarea", {
			cls: "mlf-note",
			attr: { spellcheck: "false", placeholder: "이번 단위에 남길 한마디. 나만 쓰는 칸이다.", "aria-label": `${USER_NOTE_SECTION} 편집`, rows: "3" },
		});
		ta.value = this.pending ?? this.base ?? "";
		this.textarea = ta;
		ta.addEventListener("input", () => {
			this.pending = ta.value;
			this.dirty = normalizeNote(ta.value) !== (this.base ?? "");
			this.autosize();
			this.setStatus(this.dirty ? "입력 중" : "");
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
		this.autosize();
		if (this.conflict) this.showConflict();
	}

	private autosize(): void {
		const ta = this.textarea;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.max(ta.scrollHeight + 2, 72)}px`;
	}

	/** Fresh file text (modify event / reload). */
	sync(text: string): void {
		const fresh = userNoteOf(text);
		if (fresh === this.base) return;
		if (this.dirty) {
			this.showConflict();
			return;
		}
		this.base = fresh;
		this.pending = null;
		if (this.textarea) {
			this.textarea.value = fresh ?? "";
			this.autosize();
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, this.view.plugin.settings.autosaveDelayMs);
	}

	flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.saving = this.saving.then(() => this.doSave()).catch((err) => {
			console.error("[MyLogs] My Life note save failed", err);
			this.setStatus("저장 실패", true);
			new Notice(`MyLogs: '${USER_NOTE_SECTION}' 저장에 실패했어요.`);
		});
		return this.saving;
	}

	private async doSave(force = false): Promise<void> {
		if (!this.dirty || this.pending === null) return;
		if (this.conflict && !force) return;
		const f = this.view.app.vault.getAbstractFileByPath(this.path);
		if (!(f instanceof TFile)) return;
		const value = this.pending;
		this.setStatus("저장 중");
		let conflict = false;
		await this.view.app.vault.process(f, (data) => {
			if (!force && userNoteOf(data) !== this.base) {
				conflict = true;
				return data;
			}
			const out = setUserNote(data, value, todayIsoLocal());
			this.base = userNoteOf(out);
			this.dirty = normalizeNote(value) !== (this.base ?? "");
			if (!this.dirty) this.pending = null;
			return out;
		});
		if (conflict) {
			this.showConflict();
			return;
		}
		this.hideConflict();
		this.setStatus("저장됨");
		window.setTimeout(() => {
			if (this.statusEl?.getText() === "저장됨") this.setStatus("");
		}, 1600);
	}

	private setStatus(text: string, error = false): void {
		if (!this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-error", error);
	}

	private showConflict(): void {
		this.conflict = true;
		const bar = this.barEl;
		if (!bar) return;
		bar.empty();
		bar.show();
		const icon = bar.createSpan({ cls: "mlf-conflict-icon" });
		setIcon(icon, "refresh-cw");
		bar.createSpan({ text: "파일에 새 내용이 있어요" });
		bar.createSpan({ cls: "mlf-conflict-sep", text: "·" });
		const reload = bar.createEl("button", { cls: "mlf-link-btn", text: "다시 불러오기", attr: { type: "button" } });
		reload.addEventListener("click", () => void this.reloadFromFile());
		const keep = bar.createEl("button", { cls: "mlf-link-btn is-quiet", text: "내 내용으로 저장", attr: { type: "button" } });
		keep.addEventListener("click", () => void this.keepMine());
		this.setStatus("저장 안 됨", true);
	}

	private hideConflict(): void {
		this.conflict = false;
		this.barEl?.hide();
		this.barEl?.empty();
	}

	private async reloadFromFile(): Promise<void> {
		const f = this.view.app.vault.getAbstractFileByPath(this.path);
		const text = f instanceof TFile ? await this.view.app.vault.read(f) : null;
		this.hideConflict();
		this.dirty = false;
		this.pending = null;
		this.setStatus("");
		this.base = text === null ? null : userNoteOf(text);
		if (this.textarea) {
			this.textarea.value = this.base ?? "";
			this.autosize();
		}
	}

	private async keepMine(): Promise<void> {
		this.hideConflict();
		this.dirty = true;
		this.saving = this.saving.then(() => this.doSave(true));
		await this.saving;
	}

	destroy(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
	}
}

// ───────────────────────── view ─────────────────────────

export class MyLifeView extends ItemView {
	readonly plugin: MyLogsPlugin;
	date: string = todayIsoLocal();
	tab: MyLifeTab = "daily";
	/** Diary month (`YYYY-MM`); follows the date until the tab's own ◀ ▶ moves it. */
	diaryMonth: string = this.date.slice(0, 7);

	private rootEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private tabsEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private renderChild: Component | null = null;
	private note: UserNoteEditor | null = null;
	private loadSeq = 0;
	private reloadTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_MY_LIFE;
	}

	getDisplayText(): string {
		return `My Life · ${this.date}`;
	}

	getIcon(): string {
		return "book-open";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), date: this.date, tab: this.tab, diaryMonth: this.diaryMonth };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state as { date?: string; tab?: string; diaryMonth?: string } | null) ?? {};
		let changed = false;
		if (s.date && fromIsoDate(s.date) && s.date !== this.date) {
			this.date = s.date;
			this.diaryMonth = s.date.slice(0, 7);
			changed = true;
		}
		if (isTab(s.tab) && s.tab !== this.tab) {
			this.tab = s.tab;
			changed = true;
		}
		if (s.diaryMonth && isMonthKey(s.diaryMonth) && s.diaryMonth !== this.diaryMonth) {
			this.diaryMonth = s.diaryMonth;
			changed = true;
		}
		if (changed && this.rootEl) await this.reload();
		await super.setState(state, result);
	}

	// ── paths ──

	folder(): string {
		return this.plugin.settings.myLifePath || "08 My Life";
	}

	pathOf(unit: MyLifeUnit, date = this.date): string {
		return normalizePath(unitPath(this.folder(), unit, date));
	}

	private fileAt(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	private async readAt(path: string): Promise<string | null> {
		const f = this.fileAt(path);
		return f ? this.app.vault.read(f) : null;
	}

	/** Does a vault event at `path` concern what is on screen? */
	private watches(path: string): boolean {
		if (isUnit(this.tab)) return path === this.pathOf(this.tab);
		const folder = normalizePath(dailyMonthFolder(this.folder(), this.diaryMonth));
		return path.startsWith(folder + "/") || path === normalizePath(monthlyPath(this.folder(), `${this.diaryMonth}-01`));
	}

	// ── lifecycle ──

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-my-life-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-my-life" });
		this.headerEl = this.rootEl.createDiv({ cls: "mlf-top" });
		this.tabsEl = this.rootEl.createDiv({ cls: "mlf-tabs", attr: { role: "tablist" } });
		this.bodyEl = this.rootEl.createDiv({ cls: "mlf-body" });
		const onFile = (f: TAbstractFile, old?: string) => {
			if (this.watches(f.path) || (old && this.watches(old))) this.scheduleReload();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile(f, old)));
		await this.reload();
	}

	async onClose(): Promise<void> {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		await this.note?.flush();
		this.note?.destroy();
		this.note = null;
		if (this.renderChild) this.removeChild(this.renderChild);
	}

	private scheduleReload(): void {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			void this.reload();
		}, 250);
	}

	/** Re-render everything (settings changed). */
	async refresh(): Promise<void> {
		await this.reload();
	}

	async goTo(date: string): Promise<void> {
		if (!fromIsoDate(date) || date === this.date) return;
		await this.note?.flush();
		this.date = date;
		this.diaryMonth = date.slice(0, 7);
		await this.reload();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
	}

	async showTab(tab: MyLifeTab): Promise<void> {
		if (tab === this.tab) return;
		await this.note?.flush();
		this.tab = tab;
		await this.reload();
		this.app.workspace.requestSaveLayout();
	}

	/** The 오늘 tab for `date` (from the Diary or another view). */
	async openDaily(date: string): Promise<void> {
		if (!fromIsoDate(date)) return;
		if (date === this.date && this.tab === "daily") return;
		await this.note?.flush();
		this.tab = "daily";
		this.date = date;
		this.diaryMonth = date.slice(0, 7);
		await this.reload();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
	}

	private async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		this.renderHeader();
		this.renderTabs();
		if (isUnit(this.tab)) {
			const path = this.pathOf(this.tab);
			const text = await this.readAt(path);
			if (seq !== this.loadSeq) return;
			this.resetBody();
			if (text === null) this.renderMissing(this.tab, path);
			else this.renderUnit(this.tab, path, text);
		} else {
			const diary = await this.readDiary();
			if (seq !== this.loadSeq) return;
			this.resetBody();
			this.renderDiary(diary);
		}
	}

	private resetBody(): void {
		this.bodyEl.empty();
		if (this.renderChild) this.removeChild(this.renderChild);
		this.renderChild = this.addChild(new Component());
	}

	// ── header ──

	private renderHeader(): void {
		const h = this.headerEl;
		h.empty();
		const today = todayIsoLocal();
		const d = moment(this.date, "YYYY-MM-DD");
		const titles = h.createDiv({ cls: "mlf-titles" });
		titles.createDiv({ cls: "mlf-eyebrow", text: "My Life" });
		const h1 = titles.createEl("h1", { cls: "mlf-title" });
		h1.createSpan({ cls: "mlf-title-main", text: d.format("LL") });
		const wd = d.isoWeekday();
		h1.createSpan({ cls: `mlf-weekday wd-${wd}`, text: d.format("dddd") });
		const rel = this.date === today ? "오늘" : this.date === addDays(today, -1) ? "어제" : this.date === addDays(today, 1) ? "내일" : "";
		if (rel) h1.createSpan({ cls: `mlf-rel${rel === "오늘" ? " is-today" : ""}`, text: rel });

		const nav = h.createDiv({ cls: "mlf-nav" });
		const prev = nav.createEl("button", { cls: "mlf-btn mlf-btn-icon", text: "◀", attr: { type: "button", "aria-label": "이전 날" } });
		prev.addEventListener("click", () => void this.goTo(addDays(this.date, -1)));
		const todayBtn = nav.createEl("button", { cls: "mlf-btn", text: "오늘", attr: { type: "button" } });
		todayBtn.toggleClass("is-active", this.date === today);
		todayBtn.addEventListener("click", () => void this.goTo(todayIsoLocal()));
		const next = nav.createEl("button", { cls: "mlf-btn mlf-btn-icon", text: "▶", attr: { type: "button", "aria-label": "다음 날" } });
		next.addEventListener("click", () => void this.goTo(addDays(this.date, 1)));
		const picker = nav.createEl("input", { cls: "mlf-date-input", attr: { type: "date", "aria-label": "날짜 고르기" } });
		picker.value = this.date;
		picker.addEventListener("change", () => {
			if (fromIsoDate(picker.value)) void this.goTo(picker.value);
		});
		const pad = nav.createEl("button", { cls: "mlf-btn mlf-pad-btn", attr: { type: "button", "aria-label": "같은 날짜의 Daily Pad 열기" } });
		const padIcon = pad.createSpan({ cls: "mlf-btn-ico" });
		setIcon(padIcon, "notebook-pen");
		pad.createSpan({ text: "Daily Pad 열기" });
		pad.addEventListener("click", () => void this.plugin.openDailyPadAt(this.date));
		if (isUnit(this.tab)) {
			const open = nav.createEl("button", { cls: "mlf-btn mlf-btn-icon mlf-open-file", attr: { type: "button", "aria-label": "마크다운 파일 열기" } });
			setIcon(open, "file-text");
			open.addEventListener("click", (e) => {
				const f = isUnit(this.tab) ? this.fileAt(this.pathOf(this.tab)) : null;
				if (f) void this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f);
				else new Notice("아직 이 단위의 My Life 파일이 없어요.");
			});
		}
	}

	private renderTabs(): void {
		const el = this.tabsEl;
		el.empty();
		for (const tab of MY_LIFE_TABS) {
			const b = el.createEl("button", {
				cls: `mlf-tab${tab === this.tab ? " is-active" : ""}`,
				attr: { type: "button", role: "tab", "aria-selected": tab === this.tab ? "true" : "false" },
			});
			b.createSpan({ cls: "mlf-tab-label", text: UNIT_LABEL[tab] });
			if (isUnit(tab)) b.createSpan({ cls: "mlf-tab-sub", text: unitTitle(tab, this.date) });
			else b.createSpan({ cls: "mlf-tab-sub", text: this.diaryMonth });
			b.addEventListener("click", () => void this.showTab(tab));
		}
	}

	// ── missing ──

	private renderMissing(unit: MyLifeUnit, path: string): void {
		this.dropNote();
		const card = this.bodyEl.createDiv({ cls: "mlf-empty" });
		card.createDiv({ cls: "mlf-empty-title", text: "아직 쓰지 않았다" });
		card.createEl("code", { cls: "mlf-empty-path", text: path });
		card.createDiv({ cls: "mlf-empty-hint", text: `${UNIT_HINT[unit]}. 이 화면은 파일을 만들지 않는다.` });
	}

	// ── unit (오늘 / 이번 주 / 이번 달 / 올해) ──

	private renderUnit(unit: MyLifeUnit, path: string, text: string): void {
		const file = parseMyLifeFile(text, unit);
		this.renderMeta(file, unit);
		const collapsed = new Set(this.plugin.settings.myLifeCollapsed[unit] ?? []);
		const cards = this.bodyEl.createDiv({ cls: "mlf-cards" });
		const writable = hasUserNote(unit);
		for (const s of file.sections) {
			if (writable && s.name === USER_NOTE_SECTION) {
				this.renderNoteCard(cards, path, text, collapsed.has(s.name), unit);
				continue;
			}
			const card = cards.createDiv({ cls: `mlf-card${collapsed.has(s.name) ? " is-collapsed" : ""}${s.empty ? " is-empty" : ""}` });
			this.renderCardHead(card, s.name, unit, s.empty ? "비어 있음" : "");
			const body = card.createDiv({ cls: "mlf-card-body" });
			if (s.empty) body.createDiv({ cls: "mlf-card-none", text: "아직 없음" });
			else {
				const md = body.createDiv({ cls: "mlf-md markdown-rendered" });
				void this.renderMarkdown(md, s.content, path);
			}
		}
		if (!writable) this.dropNote();
	}

	private renderMeta(file: MyLifeFile, unit: MyLifeUnit): void {
		const meta = this.bodyEl.createDiv({ cls: "mlf-meta" });
		const line = meta.createDiv({ cls: "mlf-meta-title" });
		line.createEl("h2", { cls: "mlf-file-title", text: file.title || unitTitle(unit, this.date) });
		if (file.sample) line.createSpan({ cls: "mlf-badge mlf-badge-sample", text: "샘플", attr: { title: "가상 데이터 (sample: true / #sample)" } });
		else if (file.status) line.createSpan({ cls: `mlf-badge mlf-badge-status is-${file.status === "초안" ? "draft" : "done"}`, text: file.status });
		const stats = file.stats.filter((s) => s.key !== "status"); // status is the badge above
		if (stats.length) {
			const row = meta.createDiv({ cls: "mlf-stats" });
			for (const s of stats) {
				const st = row.createDiv({ cls: "mlf-stat" });
				st.createSpan({ cls: "mlf-stat-value", text: s.value });
				st.createSpan({ cls: "mlf-stat-label", text: s.label });
			}
		}
		const by = String(file.frontmatter.written_by ?? "").trim();
		const at = String(file.frontmatter.written_at ?? "").trim();
		if (by || at) meta.createDiv({ cls: "mlf-written", text: [by, at].filter(Boolean).join(" · ") });
	}

	private renderCardHead(card: HTMLElement, name: string, unit: MyLifeUnit, hint: string): HTMLElement {
		const head = card.createDiv({ cls: "mlf-card-head" });
		const toggle = head.createEl("button", { cls: "mlf-card-toggle", attr: { type: "button", "aria-label": `${name} 접기/펼치기` } });
		const chev = toggle.createSpan({ cls: "mlf-chevron" });
		setIcon(chev, "chevron-down");
		toggle.createEl("h3", { cls: "mlf-card-title", text: name });
		if (hint) toggle.createSpan({ cls: "mlf-card-hint", text: hint });
		head.createDiv({ cls: "mlf-card-tools" });
		toggle.addEventListener("click", () => {
			const now = !card.hasClass("is-collapsed");
			card.toggleClass("is-collapsed", now);
			void this.rememberCollapsed(unit, name, now);
		});
		return head;
	}

	private async rememberCollapsed(unit: MyLifeUnit, name: string, collapsed: boolean): Promise<void> {
		const s = this.plugin.settings;
		const list = new Set(s.myLifeCollapsed[unit] ?? []);
		if (collapsed) list.add(name);
		else list.delete(name);
		s.myLifeCollapsed = { ...s.myLifeCollapsed, [unit]: [...list] };
		// Plain save: a settings refresh would redraw every view for a fold.
		await this.plugin.saveData(s);
	}

	private renderNoteCard(parent: HTMLElement, path: string, text: string, collapsed: boolean, unit: MyLifeUnit): void {
		const card = parent.createDiv({ cls: `mlf-card mlf-card-note${collapsed ? " is-collapsed" : ""}` });
		this.renderCardHead(card, USER_NOTE_SECTION, unit, "내가 쓰는 칸");
		if (this.note && this.note.path !== path) this.dropNote();
		if (!this.note) this.note = new UserNoteEditor(this, path, text);
		this.note.mount(card);
		this.note.sync(text);
	}

	private dropNote(): void {
		if (!this.note) return;
		void this.note.flush();
		this.note.destroy();
		this.note = null;
	}

	private async renderMarkdown(el: HTMLElement, content: string, sourcePath: string): Promise<void> {
		if (!this.renderChild) return;
		await MarkdownRenderer.render(this.app, content, el, sourcePath, this.renderChild);
		el.addEventListener("click", (e) => {
			const a = (e.target as HTMLElement).closest("a");
			if (!a || !a.hasClass("internal-link")) return;
			e.preventDefault();
			const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
			void this.app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(e));
		});
	}

	// ── Diary ──

	private async readDiary(): Promise<DiaryMonth> {
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(dailyMonthFolder(this.folder(), this.diaryMonth)));
		const dailies: DiarySource[] = [];
		if (folder instanceof TFolder) {
			for (const child of folder.children) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const date = dateOfDailyName(child.basename);
				if (!date) continue;
				dailies.push({ path: child.path, date, text: await this.app.vault.read(child) });
			}
		}
		const mPath = normalizePath(monthlyPath(this.folder(), `${this.diaryMonth}-01`));
		const mText = await this.readAt(mPath);
		const monthly = mText === null ? null : { path: mPath, date: this.diaryMonth, text: mText };
		return aggregateDiary(this.diaryMonth, dailies, monthly);
	}

	private async showDiaryMonth(month: string): Promise<void> {
		if (!isMonthKey(month) || month === this.diaryMonth) return;
		this.diaryMonth = month;
		await this.reload();
		this.app.workspace.requestSaveLayout();
	}

	private renderDiary(diary: DiaryMonth): void {
		this.dropNote();
		const m = moment(`${diary.month}-01`, "YYYY-MM-DD");
		const head = this.bodyEl.createDiv({ cls: "mlf-diary-head" });
		const nav = head.createDiv({ cls: "mlf-diary-nav" });
		const prev = nav.createEl("button", { cls: "mlf-btn mlf-btn-icon", text: "◀", attr: { type: "button", "aria-label": "이전 달" } });
		prev.addEventListener("click", () => void this.showDiaryMonth(shiftMonthKey(diary.month, -1)));
		nav.createEl("h2", { cls: "mlf-diary-month", text: m.format("YYYY년 M월") });
		const next = nav.createEl("button", { cls: "mlf-btn mlf-btn-icon", text: "▶", attr: { type: "button", "aria-label": "다음 달" } });
		next.addEventListener("click", () => void this.showDiaryMonth(shiftMonthKey(diary.month, 1)));
		if (diary.month !== this.date.slice(0, 7)) {
			const back = nav.createEl("button", { cls: "mlf-btn", text: `${this.date.slice(0, 7)}로`, attr: { type: "button", "aria-label": "고른 날짜의 달로" } });
			back.addEventListener("click", () => void this.showDiaryMonth(this.date.slice(0, 7)));
		}
		const sum = head.createDiv({ cls: "mlf-diary-sum" });
		sum.setText(
			diary.entries.length
				? `Daily ${diary.days.length}일 · 기록 ${diary.entries.length}개${diary.hasMonthly ? " · Monthly 있음" : ""}`
				: "Daily의 깨달음·감상과 로그, Monthly의 깨달음·감상을 날짜순으로 모은다",
		);

		if (!diary.entries.length) {
			const empty = this.bodyEl.createDiv({ cls: "mlf-empty" });
			empty.createDiv({ cls: "mlf-empty-title", text: "이 달의 기록이 아직 없다" });
			empty.createEl("code", { cls: "mlf-empty-path", text: dailyMonthFolder(this.folder(), diary.month) });
			empty.createDiv({ cls: "mlf-empty-hint", text: "Daily가 쓰이면 여기에 깨달음·감상과 로그가 모인다." });
			return;
		}

		const list = this.bodyEl.createDiv({ cls: "mlf-diary" });
		let group: HTMLElement | null = null;
		let groupKey = "";
		for (const e of diary.entries) {
			const key = `${e.unit}:${e.date}`;
			if (key !== groupKey) {
				groupKey = key;
				group = list.createDiv({ cls: `mlf-diary-day${e.unit === "monthly" ? " is-monthly" : ""}` });
				this.renderDiaryDate(group, e);
			}
			const item = group!.createDiv({ cls: "mlf-diary-entry" });
			item.createDiv({ cls: "mlf-diary-section", text: e.section });
			const md = item.createDiv({ cls: "mlf-md markdown-rendered" });
			void this.renderMarkdown(md, e.content, e.path);
		}
	}

	private renderDiaryDate(group: HTMLElement, e: DiaryEntry): void {
		const head = group.createDiv({ cls: "mlf-diary-date" });
		const label =
			e.unit === "monthly" ? `Monthly ${e.date}` : `${moment(e.date, "YYYY-MM-DD").format("M월 D일 (ddd)")}`;
		const link = head.createEl("a", { cls: "mlf-diary-link", text: label, attr: { href: "#", "aria-label": `${label} 파일 열기` } });
		link.addEventListener("click", (ev) => {
			ev.preventDefault();
			const f = this.fileAt(e.path);
			if (f) void this.app.workspace.getLeaf(Keymap.isModEvent(ev)).openFile(f);
		});
		if (e.unit === "daily") {
			const here = head.createEl("button", { cls: "mlf-link-btn is-quiet", text: "오늘 탭에서", attr: { type: "button", "aria-label": "이 날짜의 오늘 탭 열기" } });
			here.addEventListener("click", () => void this.openDaily(e.date));
		}
		head.createSpan({ cls: "mlf-diary-path", text: e.path });
	}
}
