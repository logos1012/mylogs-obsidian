import {
	Component,
	ItemView,
	Keymap,
	MarkdownRenderer,
	moment,
	normalizePath,
	Notice,
	setIcon,
	TAbstractFile,
	TFile,
	type ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import type MyLogsPlugin from "./main.ts";
import {
	addDays,
	findDaySection,
	fromIsoDate,
	parseBodyLines,
	type ParsedItem,
	type SourceLine,
	splitLinesKeepEol,
	stripEol,
	TASK_LINE_RE,
	toIsoDate,
} from "./parser.ts";
import { MAIN_SECTION_KEYS, type MainSectionKey } from "./settings.ts";
import { flywheelIdOf, flywheelLines, flywheelPath, isFlywheelLine, missedCount, parseFlywheel, weeklyDone } from "./flywheel/model.ts";
import { weekMonday } from "./mylife/model.ts";
import {
	appendToSection,
	dailyPadSkeleton,
	findSection,
	getSectionContent,
	replaceSectionContent,
	sectionLineRange,
	setFrontmatterScalar,
	toggleCheckbox,
	type ToggleTarget,
} from "./writer.ts";

export const VIEW_TYPE_DAILY_PAD = "mylogs-daily-pad";

const FIELD_LABEL: Record<string, string> = {
	why: "이유",
	moved: "미룸",
	from: "출처",
	project: "프로젝트",
};

const STATUS_LABEL: Record<string, string> = {
	scheduled: "예정",
	done: "완료",
	moved: "옮김",
	cancelled: "놓아줌",
};

const SECTION_HINT: Record<MainSectionKey, string> = {
	today: "오늘 새로 생긴 일",
	memo: "짧게 떠오른 것",
	log: "그날의 기록",
	scribble: "긴 생각, 자유 형식",
	refs: "링크, 파일, 참고 자료",
};

const SECTION_PLACEHOLDER: Record<MainSectionKey, string> = {
	today: "- [ ] 할 일",
	memo: "- 떠오른 것",
	log: "- 09:00 있었던 일",
	scribble: "생각나는 대로 적어요",
	refs: "- [제목](https://…) 한 줄 설명",
};

function todayIso(): string {
	return toIsoDate(new Date());
}

/** Normalize textarea content the same way the writer does, so comparisons are fair. */
function normalizeContent(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\s+$/, "").replace(/^(?:[ \t]*\n)+/, "");
}

// ───────────────────────── item rendering (Desk Calendar + 결정 대기) ─────────────────────────

interface ItemRenderOptions {
	showTest: boolean;
	onToggle?: (sl: SourceLine, el: HTMLElement) => void;
	/** This ISO week's completions per Flywheel element (for the `n/7` badge). */
	flywheelWeek?: Map<string, number>;
}

/**
 * Decorate a rendered `(flywheel:: F-N)` task line (12 Flywheel AGENTS 「4-2」「4-3」, 계획 「10」):
 * `is-flywheel` class, a small `n/7` badge for this ISO week's completions, and a red dot when
 * Tear-off has marked `(missed:: N)`. Returns the element id, or null for an ordinary line.
 */
function decorateFlywheelLine(li: HTMLElement, host: HTMLElement, line: string, week: Map<string, number> | undefined): string | null {
	const id = flywheelIdOf(line);
	if (!id) return null;
	li.addClass("is-flywheel");
	const n = week?.get(id) ?? 0;
	const badge = host.createSpan({ cls: "ml-fw-week", text: `${n}/7`, attr: { title: `${id} 이번 주 수행 ${n}/7` } });
	const missed = missedCount(line);
	if (missed !== null) {
		badge.addClass("is-missed");
		host.createSpan({ cls: "ml-fw-missed", attr: { title: `${missed}일 연속 못 했어요 (missed:: ${missed})`, "aria-label": `${missed}일 연속 못 함` } });
	}
	return id;
}

function renderItemList(parent: HTMLElement, lines: SourceLine[], opts: ItemRenderOptions): void {
	const ul = parent.createEl("ul", { cls: "ml-items" });
	for (const sl of lines) {
		const li = ul.createEl("li", { cls: "ml-item" });
		if (sl.indent > 0) li.style.setProperty("--ml-indent", String(Math.min(sl.indent, 12)));
		if (!sl.item) {
			li.addClass("ml-raw");
			li.createSpan({ cls: "ml-sym" });
			li.createSpan({ cls: "ml-txt", text: sl.line.trim() });
			continue;
		}
		renderItem(li, sl, sl.item, opts);
	}
}

function renderItem(li: HTMLElement, sl: SourceLine, it: ParsedItem, opts: ItemRenderOptions): void {
	const kind = it.kind ?? "note";
	li.addClass(`k-${kind}`, `s-${it.status}`);
	if (!it.ok) li.addClass("ml-problem");
	if (it.test) li.addClass("ml-is-test");

	const toggleable = kind === "task" && (it.status === "scheduled" || it.status === "done") && !!opts.onToggle;
	if (kind === "task") {
		const box = li.createEl(toggleable ? "button" : "span", {
			cls: "ml-check",
			attr: {
				role: "checkbox",
				"aria-checked": it.status === "done" ? "true" : it.status === "scheduled" ? "false" : "mixed",
				"aria-label": `${it.text} · ${STATUS_LABEL[it.status]}`,
			},
		});
		if (toggleable) {
			box.setAttr("type", "button");
			box.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				opts.onToggle?.(sl, li);
			});
		} else {
			box.addClass("is-readonly");
			box.setAttr(
				"title",
				it.status === "moved" ? "옮긴 일이에요 (v0.1에서는 읽기 전용)" : "놓아준 일이에요 (v0.1에서는 읽기 전용)",
			);
		}
	} else {
		li.createSpan({ cls: "ml-sym", attr: { "aria-hidden": "true" } });
	}

	const body = li.createDiv({ cls: "ml-body" });
	const main = body.createSpan({ cls: "ml-main" });
	if (it.time) main.createSpan({ cls: "ml-time", text: it.time });
	main.createSpan({ cls: "ml-txt", text: it.text });

	const meta: HTMLElement[] = [];
	const metaEl = createSpan({ cls: "ml-meta" });
	if (it.movedTo) meta.push(metaEl.createSpan({ cls: "ml-moved", text: `→ ${it.movedTo}` }));
	for (const [m, d] of it.assignRaw) {
		meta.push(metaEl.createSpan({ cls: "ml-assign", text: `→ ${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}` }));
	}
	for (const w of it.assignWeek) meta.push(metaEl.createSpan({ cls: "ml-assign", text: `→ W${w}` }));
	if (it.goal) meta.push(metaEl.createSpan({ cls: "ml-goal", text: it.goal, attr: { title: `목표 ${it.goal}` } }));
	// TODO(MyLogs Plugin 계획.md 「화면 사이의 연결」): goal chip → open the Pinboard goal.
	for (const tag of it.tags) meta.push(metaEl.createSpan({ cls: "ml-tag", text: `#${tag}` }));
	const flywheel = kind === "task" && isFlywheelLine(sl.line);
	for (const [k, v] of it.fields) {
		if (k === "goal") continue;
		if (flywheel && (k === "flywheel" || k === "missed")) continue; // shown as the badge / red dot below
		const label = FIELD_LABEL[k] ?? k;
		const text = k === "moved" ? `${label} ${v}` : `${label}: ${v}`;
		meta.push(metaEl.createSpan({ cls: `ml-field ml-field-${k}`, text }));
	}
	if (it.test && opts.showTest) meta.push(metaEl.createSpan({ cls: "ml-test", text: "test", attr: { title: "#test 테스트 데이터" } }));
	if (meta.length) body.appendChild(metaEl);
	// A Flywheel line is checked or left; it never gets the 못 한 일 menu (`isFlywheelLine`).
	if (flywheel) decorateFlywheelLine(li, body, sl.line, opts.flywheelWeek);
	if (it.problems.length) body.createDiv({ cls: "ml-problems", text: it.problems.join(" · ") });
}

// ───────────────────────── section panel ─────────────────────────

class SectionPanel {
	readonly key: MainSectionKey;
	readonly view: DailyPadView;
	el!: HTMLElement;
	private bodyEl!: HTMLElement;
	private barEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private editBtn!: HTMLElement;
	private textarea: HTMLTextAreaElement | null = null;
	private renderChild: Component | null = null;

	/** Section content as last synced with the file (null = section missing). */
	base: string | null = null;
	editing = false;
	dirty = false;
	/** Set when the file changed under unsaved local edits. */
	conflict = false;
	private saveTimer: number | null = null;
	private saving: Promise<void> = Promise.resolve();

	constructor(view: DailyPadView, key: MainSectionKey) {
		this.view = view;
		this.key = key;
	}

	get name(): string {
		return this.view.plugin.settings.sections[this.key];
	}

	mount(parent: HTMLElement): void {
		this.el = parent.createDiv({ cls: `ml-panel ml-section ml-section-${this.key}` });
		const head = this.el.createDiv({ cls: "ml-panel-head" });
		const titles = head.createDiv({ cls: "ml-panel-titles" });
		titles.createEl("h3", { cls: "ml-panel-title", text: this.name });
		titles.createSpan({ cls: "ml-panel-hint", text: SECTION_HINT[this.key] });
		const tools = head.createDiv({ cls: "ml-panel-tools" });
		this.statusEl = tools.createSpan({ cls: "ml-save-status" });
		this.editBtn = tools.createEl("button", { cls: "ml-btn ml-btn-ghost ml-edit-btn", text: "편집", attr: { type: "button" } });
		this.editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this.editing) void this.exitEdit();
			else this.enterEdit();
		});
		this.barEl = this.el.createDiv({ cls: "ml-conflict-bar" });
		this.barEl.hide();
		this.bodyEl = this.el.createDiv({ cls: "ml-panel-body" });
		this.bodyEl.addEventListener("click", (e) => this.onBodyClick(e));
		if (this.key === "today") this.mountQuickAdd();
	}

	private mountQuickAdd(): void {
		const wrap = this.el.createDiv({ cls: "ml-quick-add" });
		const icon = wrap.createSpan({ cls: "ml-quick-add-icon" });
		setIcon(icon, "plus");
		const input = wrap.createEl("input", {
			cls: "ml-quick-add-input",
			attr: { type: "text", placeholder: "할 일 추가", "aria-label": "할 일 추가", enterkeyhint: "done" },
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				const text = input.value.trim();
				if (!text) return;
				input.value = "";
				void this.addTask(text);
			} else if (e.key === "Escape") {
				input.value = "";
				input.blur();
			}
		});
	}

	/** Called with fresh file text (initial load or a modify event). */
	sync(text: string): void {
		const fresh = getSectionContent(text, this.name);
		if (this.editing) {
			if (fresh === this.base) return;
			if (this.dirty) {
				this.showConflict();
				return;
			}
			// Clean edit mode: follow the file, keeping the caret roughly where it was.
			this.base = fresh;
			if (this.textarea) {
				const pos = this.textarea.selectionStart;
				this.textarea.value = fresh ?? "";
				this.textarea.selectionStart = this.textarea.selectionEnd = Math.min(pos, this.textarea.value.length);
				this.autosize();
			}
			return;
		}
		if (fresh === this.base && this.bodyEl.childElementCount) return;
		this.base = fresh;
		void this.renderView();
	}

	async renderView(): Promise<void> {
		this.textarea = null;
		this.el.removeClass("is-editing");
		this.editBtn.setText("편집");
		this.bodyEl.empty();
		if (this.renderChild) this.view.removeChild(this.renderChild);
		this.renderChild = this.view.addChild(new Component());
		const content = this.base ?? "";
		if (!content.trim()) {
			const empty = this.bodyEl.createDiv({ cls: "ml-panel-empty" });
			empty.setText(this.base === null ? `파일에 '## ${this.name}' 섹션이 없어요. 쓰기 시작하면 만들어요.` : "눌러서 쓰기");
			return;
		}
		const md = this.bodyEl.createDiv({ cls: "ml-md markdown-rendered" });
		await MarkdownRenderer.render(this.view.app, content, md, this.view.padPath(), this.renderChild);
		this.wireCheckboxes(md, content);
	}

	/** Make rendered task checkboxes write `[ ]`↔`[x]` into the Daily Pad file. */
	private wireCheckboxes(md: HTMLElement, content: string): void {
		const boxes = Array.from(md.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox"));
		if (!boxes.length) return;
		// Task lines in the section content, in order, outside code fences.
		const taskLines: { offset: number; line: string; ch: string }[] = [];
		let fence = false;
		content.split("\n").forEach((line, i) => {
			if (/^\s*(```|~~~)/.test(line)) fence = !fence;
			if (fence) return;
			const m = TASK_LINE_RE.exec(line);
			if (m) taskLines.push({ offset: i, line, ch: m[2] });
		});
		boxes.forEach((box, n) => {
			const tl = taskLines.length === boxes.length ? taskLines[n] : undefined;
			const li = box.closest("li");
			if (tl && li) decorateFlywheelLine(li, li, tl.line, this.view.flywheelWeek);
			box.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (!tl) {
					new Notice("이 체크박스의 줄을 찾지 못했어요. 편집으로 바꿔 주세요.");
					return;
				}
				if (tl.ch !== " " && tl.ch.toLowerCase() !== "x") {
					new Notice("옮김·놓아줌 상태는 v0.1에서 화면에서 바꿀 수 없어요.");
					return;
				}
				void this.view.togglePadLine(this.name, tl.offset, tl.line);
			});
		});
	}

	private onBodyClick(e: MouseEvent): void {
		const t = e.target as HTMLElement;
		const a = t.closest("a");
		if (a) {
			if (a.hasClass("internal-link")) {
				e.preventDefault();
				const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
				void this.view.app.workspace.openLinkText(href, this.view.padPath(), Keymap.isModEvent(e));
			}
			return;
		}
		if (t.closest("input, button, .internal-embed, img, video, audio, iframe")) return;
		if (window.getSelection()?.toString()) return; // the user is selecting text
		if (!this.editing) this.enterEdit();
	}

	enterEdit(): void {
		if (this.editing) return;
		this.editing = true;
		this.dirty = false;
		this.el.addClass("is-editing");
		this.editBtn.setText("완료");
		if (this.renderChild) {
			this.view.removeChild(this.renderChild);
			this.renderChild = null;
		}
		this.bodyEl.empty();
		const ta = this.bodyEl.createEl("textarea", {
			cls: "ml-editor",
			attr: { spellcheck: "false", placeholder: SECTION_PLACEHOLDER[this.key], "aria-label": `${this.name} 편집` },
		});
		ta.value = this.base ?? "";
		this.textarea = ta;
		ta.addEventListener("input", () => {
			this.dirty = normalizeContent(ta.value) !== (this.base ?? "");
			this.autosize();
			this.setStatus(this.dirty ? "입력 중" : "");
			this.scheduleSave();
		});
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				void this.exitEdit();
			}
		});
		ta.addEventListener("blur", () => {
			window.setTimeout(() => {
				if (!this.editing) return;
				if (this.el.contains(document.activeElement)) return;
				void this.exitEdit();
			}, 120);
		});
		this.autosize();
		ta.focus();
		ta.selectionStart = ta.selectionEnd = ta.value.length;
	}

	private autosize(): void {
		const ta = this.textarea;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.max(ta.scrollHeight + 2, 96)}px`;
	}

	async exitEdit(): Promise<void> {
		await this.flush();
		if (this.conflict) return; // keep the local text visible until the user decides
		this.editing = false;
		this.dirty = false;
		await this.renderView();
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, this.view.plugin.settings.autosaveDelayMs);
	}

	/** Save pending local edits now. Serialised per panel. */
	flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.saving = this.saving.then(() => this.doSave()).catch((err) => {
			console.error("[MyLogs] save failed", err);
			this.setStatus("저장 실패", true);
			new Notice(`MyLogs: '${this.name}' 저장에 실패했어요.`);
		});
		return this.saving;
	}

	private async doSave(force = false): Promise<void> {
		if (!this.textarea || !this.dirty) return;
		if (this.conflict && !force) return;
		const file = this.view.padFile();
		if (!file) return;
		const name = this.name;
		this.setStatus("저장 중");
		let conflict = false;
		await this.view.app.vault.process(file, (data) => {
			const cur = getSectionContent(data, name);
			if (!force && cur !== this.base) {
				conflict = true;
				return data;
			}
			const value = this.textarea ? this.textarea.value : "";
			let out = replaceSectionContent(data, name, value);
			if (out !== data) out = setFrontmatterScalar(out, "updated", todayIso());
			// Update our sync point before the write lands, so our own modify event is a no-op.
			this.base = getSectionContent(out, name);
			this.dirty = this.textarea ? normalizeContent(this.textarea.value) !== (this.base ?? "") : false;
			return out;
		});
		if (conflict) {
			this.showConflict();
			return;
		}
		this.hideConflict();
		this.setStatus("저장됨");
		window.setTimeout(() => {
			if (this.statusEl.getText() === "저장됨") this.setStatus("");
		}, 1600);
	}

	private setStatus(text: string, error = false): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-error", error);
	}

	private showConflict(): void {
		this.conflict = true;
		this.barEl.empty();
		this.barEl.show();
		const icon = this.barEl.createSpan({ cls: "ml-conflict-icon" });
		setIcon(icon, "refresh-cw");
		this.barEl.createSpan({ cls: "ml-conflict-text", text: "파일에 새 내용이 있어요" });
		this.barEl.createSpan({ cls: "ml-conflict-sep", text: "·" });
		const reload = this.barEl.createEl("button", { cls: "ml-link-btn", text: "다시 불러오기", attr: { type: "button" } });
		reload.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.reloadFromFile();
		});
		const keep = this.barEl.createEl("button", { cls: "ml-link-btn ml-link-btn-quiet", text: "내 내용으로 저장", attr: { type: "button" } });
		keep.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.keepMine();
		});
		this.setStatus("저장 안 됨", true);
	}

	private hideConflict(): void {
		this.conflict = false;
		this.barEl.hide();
		this.barEl.empty();
	}

	/** Discard local edits and show the file's content. */
	async reloadFromFile(): Promise<void> {
		const text = await this.view.readPad();
		this.hideConflict();
		this.dirty = false;
		this.setStatus("");
		this.base = text === null ? null : getSectionContent(text, this.name);
		if (this.editing && this.textarea) {
			this.textarea.value = this.base ?? "";
			this.autosize();
			this.textarea.focus();
		} else {
			await this.renderView();
		}
	}

	/** Overwrite the file's section with the local text. */
	private async keepMine(): Promise<void> {
		this.hideConflict();
		this.dirty = true;
		this.saving = this.saving.then(() => this.doSave(true));
		await this.saving;
		this.textarea?.focus();
	}

	private async addTask(text: string): Promise<void> {
		const line = `- [ ] ${text.replace(/\s*\n\s*/g, " ")}`;
		if (this.editing && this.textarea) {
			const v = this.textarea.value.replace(/\s+$/, "");
			this.textarea.value = v ? `${v}\n${line}` : line;
			this.dirty = true;
			this.autosize();
			await this.flush();
			return;
		}
		const file = this.view.padFile();
		if (!file) return;
		await this.view.app.vault.process(file, (data) => {
			const out = appendToSection(data, this.name, line);
			return out === data ? data : setFrontmatterScalar(out, "updated", todayIso());
		});
	}

	destroy(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		if (this.renderChild) this.view.removeChild(this.renderChild);
	}
}

// ───────────────────────── view ─────────────────────────

export class DailyPadView extends ItemView {
	readonly plugin: MyLogsPlugin;
	date: string = todayIso();

	private rootEl!: HTMLElement;
	private headerEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private deskEl!: HTMLElement;
	private pendingEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private panels: SectionPanel[] = [];
	private padExists = false;
	private loadSeq = 0;
	/** This ISO week's Flywheel completions per element id (`n/7` badges). */
	flywheelWeek: Map<string, number> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DAILY_PAD;
	}

	getDisplayText(): string {
		return `Daily Pad · ${this.date}`;
	}

	getIcon(): string {
		return "notebook-pen";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), date: this.date };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const d = (state as { date?: string } | null)?.date;
		if (d && fromIsoDate(d) && d !== this.date) await this.goTo(d);
		await super.setState(state, result);
	}

	// ── paths ──

	padPath(date = this.date): string {
		const y = date.slice(0, 4);
		return normalizePath(`${this.plugin.settings.dailyPadFolder}/${y}/${date}.md`);
	}

	deskPath(date = this.date): string {
		const y = date.slice(0, 4);
		return normalizePath(`${this.plugin.settings.deskCalendarFolder}/${y}/${date.slice(0, 7)}.md`);
	}

	padFile(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.padPath());
		return f instanceof TFile ? f : null;
	}

	private deskFile(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.deskPath());
		return f instanceof TFile ? f : null;
	}

	async readPad(): Promise<string | null> {
		const f = this.padFile();
		return f ? this.app.vault.read(f) : null;
	}

	/** Text of any vault file by path, or null when it does not exist. */
	private async readVaultFile(path: string): Promise<string | null> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? this.app.vault.cachedRead(f) : null;
	}

	/**
	 * Completions per Flywheel element in this date's ISO week (Mon–Sun Daily Pad files, cached
	 * reads). Skipped — left empty — when the pad has no `(flywheel::)` line.
	 */
	private async readFlywheelWeek(padText: string | null): Promise<Map<string, number>> {
		if (padText === null || !padText.includes("flywheel")) return new Map();
		const monday = weekMonday(this.date);
		const texts = await Promise.all(
			Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((d) => (d === this.date ? Promise.resolve(padText) : this.readVaultFile(this.padPath(d)))),
		);
		return weeklyDone(texts);
	}

	// ── lifecycle ──

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-daily-pad-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-daily-pad" });
		this.buildSkeleton();

		this.registerEvent(this.app.vault.on("modify", (f) => this.onFileEvent(f)));
		this.registerEvent(this.app.vault.on("create", (f) => this.onFileEvent(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.onFileEvent(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => this.onFileEvent(f, old)));
		await this.reload();
	}

	async onClose(): Promise<void> {
		await this.flushAll();
		this.panels.forEach((p) => p.destroy());
		this.panels = [];
	}

	private buildSkeleton(): void {
		this.rootEl.empty();
		this.panels.forEach((p) => p.destroy());
		this.panels = [];
		this.headerEl = this.rootEl.createDiv({ cls: "ml-top" });
		this.emptyEl = this.rootEl.createDiv({ cls: "ml-empty-state" });
		this.deskEl = this.rootEl.createDiv({ cls: "ml-panel ml-desk" });
		this.pendingEl = this.rootEl.createDiv({ cls: "ml-panel ml-pending" });
		this.gridEl = this.rootEl.createDiv({ cls: "ml-grid" });
		for (const key of MAIN_SECTION_KEYS) {
			const p = new SectionPanel(this, key);
			p.mount(this.gridEl);
			this.panels.push(p);
		}
	}

	/** Re-render everything (settings changed). */
	async refreshAll(): Promise<void> {
		await this.flushAll();
		this.buildSkeleton();
		await this.reload();
	}

	async flushAll(): Promise<void> {
		await Promise.all(this.panels.map((p) => p.flush()));
	}

	async goTo(date: string): Promise<void> {
		if (date === this.date) return;
		await this.flushAll();
		this.date = date;
		this.buildSkeleton();
		await this.reload();
		// Update the tab title.
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
	}

	private async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		const padText = await this.readPad();
		const deskText = await this.readDesk();
		const week = await this.readFlywheelWeek(padText);
		if (seq !== this.loadSeq) return;
		this.flywheelWeek = week;
		this.renderHeader();
		this.padExists = padText !== null;
		this.renderEmptyState();
		this.renderDesk(deskText);
		this.renderPending(padText);
		this.gridEl.toggle(this.padExists);
		if (padText !== null) this.panels.forEach((p) => p.sync(padText));
	}

	private async readDesk(): Promise<string | null> {
		const f = this.deskFile();
		return f ? this.app.vault.read(f) : null;
	}

	private onFileEvent(f: TAbstractFile, oldPath?: string): void {
		const pad = this.padPath();
		const desk = this.deskPath();
		const paths = [f.path, oldPath].filter(Boolean);
		if (paths.includes(desk)) void this.readDesk().then((t) => this.renderDesk(t));
		if (paths.includes(pad)) void this.onPadChanged();
	}

	private async onPadChanged(): Promise<void> {
		const text = await this.readPad();
		const exists = text !== null;
		if (exists !== this.padExists) {
			// Created or deleted: rebuild unless the user has unsaved text somewhere.
			if (this.panels.some((p) => p.dirty)) return;
			this.buildSkeleton();
			await this.reload();
			return;
		}
		if (text === null) return;
		this.flywheelWeek = await this.readFlywheelWeek(text);
		this.renderPending(text);
		this.panels.forEach((p) => p.sync(text));
	}

	// ── header ──

	private renderHeader(): void {
		const h = this.headerEl;
		h.empty();
		const d = moment(this.date, "YYYY-MM-DD");
		const today = todayIso();
		const titles = h.createDiv({ cls: "ml-titles" });
		titles.createDiv({ cls: "ml-eyebrow", text: "Daily Pad" });
		const h1 = titles.createEl("h1", { cls: "ml-date" });
		h1.createSpan({ cls: "ml-date-main", text: d.format("LL") });
		const wd = d.isoWeekday();
		h1.createSpan({ cls: `ml-weekday wd-${wd}`, text: d.format("dddd") });
		const rel = this.date === today ? "오늘" : this.date === addDays(today, -1) ? "어제" : this.date === addDays(today, 1) ? "내일" : "";
		if (rel) h1.createSpan({ cls: `ml-rel${rel === "오늘" ? " is-today" : ""}`, text: rel });

		const nav = h.createDiv({ cls: "ml-nav" });
		const prev = nav.createEl("button", { cls: "ml-btn ml-btn-icon", attr: { type: "button", "aria-label": "이전 날" } });
		prev.setText("◀");
		prev.addEventListener("click", () => void this.goTo(addDays(this.date, -1)));
		const todayBtn = nav.createEl("button", { cls: "ml-btn", text: "오늘", attr: { type: "button" } });
		todayBtn.toggleClass("is-active", this.date === today);
		todayBtn.addEventListener("click", () => void this.goTo(todayIso()));
		const next = nav.createEl("button", { cls: "ml-btn ml-btn-icon", attr: { type: "button", "aria-label": "다음 날" } });
		next.setText("▶");
		next.addEventListener("click", () => void this.goTo(addDays(this.date, 1)));
		const picker = nav.createEl("input", { cls: "ml-date-input", attr: { type: "date", "aria-label": "날짜 고르기" } });
		picker.value = this.date;
		picker.addEventListener("change", () => {
			if (fromIsoDate(picker.value)) void this.goTo(picker.value);
		});
		const open = nav.createEl("button", { cls: "ml-btn ml-btn-icon ml-open-file", attr: { type: "button", "aria-label": "마크다운 파일 열기" } });
		setIcon(open, "file-text");
		open.addEventListener("click", (e) => {
			const f = this.padFile();
			if (f) void this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f);
			else new Notice("아직 이 날의 Daily Pad 파일이 없어요.");
		});
		const life = nav.createEl("button", { cls: "ml-btn ml-btn-icon ml-open-life", attr: { type: "button", "aria-label": "같은 날짜의 My Life 열기", title: "My Life 열기" } });
		setIcon(life, "book-open");
		life.addEventListener("click", () => void this.plugin.activateMyLife(this.date));
	}

	// ── empty state ──

	private renderEmptyState(): void {
		const el = this.emptyEl;
		el.empty();
		el.toggle(!this.padExists);
		if (this.padExists) return;
		const card = el.createDiv({ cls: "ml-empty-card" });
		const icon = card.createDiv({ cls: "ml-empty-icon" });
		setIcon(icon, "notebook-pen");
		const isToday = this.date === todayIso();
		card.createDiv({ cls: "ml-empty-title", text: isToday ? "오늘의 페이지가 아직 없어요" : "이 날의 페이지가 아직 없어요" });
		card.createDiv({ cls: "ml-empty-desc", text: "새 장을 만들면 섹션별로 바로 적을 수 있어요." });
		card.createDiv({ cls: "ml-empty-path", text: this.padPath() });
		const btn = card.createEl("button", { cls: "ml-btn ml-btn-primary", text: isToday ? "오늘 페이지 만들기" : `${this.date} 페이지 만들기`, attr: { type: "button" } });
		btn.addEventListener("click", () => void this.createPad(btn));
	}

	private async createPad(btn: HTMLButtonElement): Promise<void> {
		btn.disabled = true;
		const path = this.padPath();
		try {
			if (this.padFile()) return;
			const folder = path.slice(0, path.lastIndexOf("/"));
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
				try {
					await this.app.vault.createFolder(folder);
				} catch {
					// Created concurrently (e.g. by sync) — fine.
				}
			}
			const s = this.plugin.settings;
			// 12 Flywheel AGENTS 「4-2」: `status:: 사용` elements open 오늘 할 일. No Flywheel.md → plain skeleton.
			const content = dailyPadSkeleton({
				isoDate: this.date,
				weekday: moment(this.date, "YYYY-MM-DD").format("ddd"),
				deskCalendarFolder: s.deskCalendarFolder,
				sections: MAIN_SECTION_KEYS.map((k) => s.sections[k]),
				flywheelLines: flywheelLines(parseFlywheel(await this.readVaultFile(flywheelPath(s.flywheelPath)))),
			});
			await this.app.vault.create(path, content);
			// The create event triggers a rebuild; reload directly in case it fired early.
			this.buildSkeleton();
			await this.reload();
		} catch (err) {
			console.error("[MyLogs] create failed", err);
			new Notice(`MyLogs: 파일을 만들지 못했어요 (${path})`);
			btn.disabled = false;
		}
	}

	// ── Desk Calendar panel ──

	private renderDesk(deskText: string | null): void {
		const el = this.deskEl;
		el.empty();
		const head = el.createDiv({ cls: "ml-panel-head" });
		const titles = head.createDiv({ cls: "ml-panel-titles" });
		titles.createEl("h3", { cls: "ml-panel-title", text: "Desk Calendar에서 온 일" });
		titles.createSpan({ cls: "ml-panel-hint", text: "정본은 Desk Calendar · 체크하면 그 파일에 저장돼요" });
		const tools = head.createDiv({ cls: "ml-panel-tools" });
		const open = tools.createEl("button", { cls: "ml-btn ml-btn-ghost", text: "달력 열기", attr: { type: "button" } });
		open.addEventListener("click", (e) => {
			const f = this.deskFile();
			if (!f) {
				new Notice("이 달의 Desk Calendar 파일이 없어요.");
				return;
			}
			void this.app.workspace.openLinkText(`${f.path}#${this.date}`, "", Keymap.isModEvent(e));
		});
		const body = el.createDiv({ cls: "ml-panel-body" });
		if (deskText === null) {
			this.gentle(body, "이 달의 Desk Calendar 파일이 아직 없어요.", this.deskPath());
			return;
		}
		const sec = findDaySection(deskText, this.date);
		if (!sec.found) {
			this.gentle(body, "Desk Calendar에 이 날짜 칸이 없어요.", `### ${this.date}`);
			return;
		}
		if (!sec.lines.length) {
			this.gentle(body, "이 날 Desk Calendar에 적힌 일이 없어요.");
			return;
		}
		renderItemList(body, sec.lines, {
			showTest: this.plugin.settings.showTestMarkers,
			onToggle: (sl, li) => void this.toggleDeskLine(sl, li),
		});
	}

	private gentle(parent: HTMLElement, text: string, sub?: string): void {
		const g = parent.createDiv({ cls: "ml-gentle" });
		g.createSpan({ text });
		if (sub) g.createEl("code", { text: sub });
	}

	private async toggleDeskLine(sl: SourceLine, li: HTMLElement): Promise<void> {
		const file = this.deskFile();
		if (!file) return;
		li.addClass("is-pending");
		const date = this.date;
		const result = await this.processToggle(file, (data) => {
			const sec = findDaySection(data, date);
			if (!sec.found) return null;
			return { index: sl.index, line: sl.line, scope: { start: sec.start, end: sec.end } };
		});
		if (!result) {
			new Notice("Desk Calendar에서 이 줄을 찾지 못했어요. 파일이 바뀌어서 다시 불러왔어요.");
			this.renderDesk(await this.readDesk());
		}
	}

	/** Toggle a task line inside a Daily Pad section (`offset` = line offset within the content). */
	async togglePadLine(sectionName: string, offset: number, line: string): Promise<void> {
		const file = this.padFile();
		if (!file) return;
		const ok = await this.processToggle(
			file,
			(data) => {
				const r = findSection(data, sectionName);
				if (!r) return null;
				const range = sectionLineRange(data, r);
				// The content starts after the section's leading blank lines.
				const lines = splitLinesKeepEol(data);
				let first = range.start;
				while (first < range.end && !stripEol(lines[first]).trim()) first++;
				return { index: first + offset, line, scope: range };
			},
			true,
		);
		if (!ok) {
			new Notice("Daily Pad에서 이 줄을 찾지 못했어요. 파일이 바뀌어서 다시 불러왔어요.");
			await this.onPadChanged();
		}
	}

	/**
	 * Atomically toggle one checkbox. `locate` maps the current file text to a target
	 * (or null if its section is gone). Returns false when the line can't be found.
	 */
	private async processToggle(file: TFile, locate: (data: string) => ToggleTarget | null, touchUpdated = false): Promise<boolean> {
		let ok = false;
		try {
			await this.app.vault.process(file, (data) => {
				const target = locate(data);
				if (!target) return data;
				const r = toggleCheckbox(data, target);
				if (!r.ok) return data;
				ok = true;
				return touchUpdated ? setFrontmatterScalar(r.text, "updated", todayIso()) : r.text;
			});
		} catch (err) {
			console.error("[MyLogs] toggle failed", err);
			return false;
		}
		return ok;
	}

	// ── 결정 대기 ──

	private renderPending(padText: string | null): void {
		const el = this.pendingEl;
		el.empty();
		const name = this.plugin.settings.sections.pending;
		const r = padText === null || !name ? null : findSection(padText, name);
		el.toggle(!!r);
		if (!r || padText === null) return;
		const range = sectionLineRange(padText, r);
		const lines = parseBodyLines(splitLinesKeepEol(padText), range.start, range.end);
		const head = el.createDiv({ cls: "ml-panel-head" });
		const titles = head.createDiv({ cls: "ml-panel-titles" });
		titles.createEl("h3", { cls: "ml-panel-title", text: name });
		titles.createSpan({ cls: "ml-panel-hint", text: "지난날 못 한 일 · 갈 곳을 골라 주세요" });
		// TODO(MyLogs Plugin 계획.md §4 「못 한 일 버튼」): 다른 날 / 미래로 / 서랍에 / 쪼개기 / 놓아주기.
		// When it lands, skip `(flywheel:: F-N)` lines (`isFlywheelLine`, `li.is-flywheel`): they are checked or left (12 Flywheel AGENTS 「4-2」 3).
		const body = el.createDiv({ cls: "ml-panel-body" });
		if (!lines.length) {
			this.gentle(body, "결정을 기다리는 일이 없어요.");
			return;
		}
		renderItemList(body, lines, {
			showTest: this.plugin.settings.showTestMarkers,
			flywheelWeek: this.flywheelWeek,
			onToggle: (sl, li) => {
				li.addClass("is-pending");
				void this.processToggle(
					this.padFile()!,
					(data) => {
						const cur = findSection(data, name);
						return cur ? { index: sl.index, line: sl.line, scope: sectionLineRange(data, cur) } : null;
					},
					true,
				).then(async (ok) => {
					if (!ok) {
						new Notice("Daily Pad에서 이 줄을 찾지 못했어요. 파일이 바뀌어서 다시 불러왔어요.");
						this.renderPending(await this.readPad());
					}
				});
			},
		});
	}
}
