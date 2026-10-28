import { toggleLinkedProjectTask } from "./projects/task-actions.ts";
import { mountAppNav } from "./ui/nav.ts";
import { tip } from "./ui/tip.ts";
import { ItemPopover } from "./ui/popover.ts";
import { choosePending, chooseToday, pendingSide, togglePending } from "./pending/actions.ts";
import { type PendingChoice, sourceDateOf } from "./pending/ops.ts";
import { extractCandidates } from "./drawer/candidates.ts";
import { acceptCandidate, removeCandidateLine } from "./drawer/actions.ts";
import { askWhen } from "./drawer/modals.ts";
import {
	Component,
	ItemView,
	Keymap,
	MarkdownRenderer,
	moment,
	normalizePath,
	Notice,
	Platform,
	setIcon,
	TAbstractFile,
	TFile,
	type ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import type MyLogsPlugin from "./main.ts";
import { loadMilestoneCalendar, renderMilestoneMarkers, renderMilestoneIssues, watchesMilestoneProjects } from "./projects/milestone-calendar-ui.ts";
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
import { asSide, lineSide, type ScopeLookup, shows } from "./side.ts";
import { MAIN_SECTION_KEYS, type MainSectionKey } from "./settings.ts";
import { flywheelIdOf, isFlywheelLine, missedCount, weeklyDone } from "./flywheel/model.ts";
import { weekMonday } from "./mylife/model.ts";
import { AutoGrow } from "./ui/autogrow.ts";
import { trackKeyboard } from "./ui/mobile.ts";
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

const PENDING_MIME = "application/x-mylogs-pending";

const SECTION_HINT: Record<MainSectionKey, string> = {
	today: "오늘 새로 생긴 개인 일",
	work: "오늘 새로 생긴 회사 일 · 칸이 곧 구분이라 #회사는 붙이지 않아요",
	memo: "떠오른 것, 긴 생각도 여기에",
	log: "그날의 기록",
	refs: "링크, 파일, 참고 자료",
};

const SECTION_PLACEHOLDER: Record<MainSectionKey, string> = {
	today: "- [ ] 할 일",
	work: "- [ ] 회사 할 일",
	memo: "- 떠오른 것",
	log: "- 09:00 있었던 일",
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
	/** Add actions to an item's detail popover (click on the item). */
	menu?: (sl: SourceLine, pop: ItemPopover, li: HTMLElement) => void;
	/** Extra controls at the end of the row (e.g. 「갈 곳 정하기」). */
	decorate?: (sl: SourceLine, li: HTMLElement) => void;
	openGoal?: (id: string) => void;
	openProject?: (id: string) => void;
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
		}
	} else {
		li.createSpan({ cls: "ml-sym", attr: { "aria-hidden": "true" } });
	}

	const body = li.createDiv({ cls: "ml-body" });
	const main = body.createSpan({ cls: "ml-main" });
	if (it.time) main.createSpan({ cls: "ml-time", text: it.time });
	main.createSpan({ cls: "ml-txt", text: it.text });

	// The row shows what to read: time, text, tags. Fields (출처, 목표, 미룸, 이유, →) are in the
	// detail popover (click the item).
	const meta: HTMLElement[] = [];
	const metaEl = createSpan({ cls: "ml-meta" });
	for (const tag of it.tags) meta.push(metaEl.createSpan({ cls: "ml-tag", text: `#${tag}` }));
	const flywheel = kind === "task" && isFlywheelLine(sl.line);
	if (it.test && opts.showTest) meta.push(tip(metaEl.createSpan({ cls: "ml-test", text: "test" }), "#test 테스트 데이터"));
	if (meta.length) body.appendChild(metaEl);
	const detailRows = (pop: ItemPopover) => {
		pop.title = it.text;
		pop.badge = `${kind === "task" ? "할 일" : kind === "event" ? "행사" : "메모"}${kind === "task" ? ` · ${STATUS_LABEL[it.status]}` : ""}`;
		if (it.time) pop.row("시각", it.time);
		if (it.movedTo) pop.row("보낸 곳", it.movedTo);
		const assigned = [...it.assignRaw.map(([m, d]) => `${m}/${d}`), ...it.assignWeek.map((w) => `W${w}`)];
		if (assigned.length) pop.row("배정", assigned.join(", "));
		if (it.goal) pop.row("목표", it.goal, opts.openGoal ? () => opts.openGoal!(it.goal) : undefined);
		for (const [k, v] of it.fields) {
			if (!v || k === "goal" || k === "task" || (flywheel && (k === "flywheel" || k === "missed"))) continue;
			if (k === "project") pop.row("프로젝트", v, opts.openProject ? () => opts.openProject!(v) : undefined);
			else pop.row(FIELD_LABEL[k] ?? k, k === "moved" ? `${v}번` : v);
		}
		if (it.problems.length) pop.row("형식 확인", it.problems.join(" · "));
	};
	li.addClass("is-openable");
	li.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).closest("button, a, input")) return;
		const pop = new ItemPopover();
		detailRows(pop);
		opts.menu?.(sl, pop, li);
		pop.show(body);
	});
	li.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		const pop = new ItemPopover();
		detailRows(pop);
		opts.menu?.(sl, pop, li);
		pop.show(body);
	});
	// A Flywheel line is checked or left; it never gets the 못 한 일 menu (`isFlywheelLine`).
	if (flywheel) decorateFlywheelLine(li, body, sl.line, opts.flywheelWeek);
	if (it.problems.length) tip(body.createSpan({ cls: "ml-problems", text: "형식 확인" }), it.problems.join(" · "));
	opts.decorate?.(sl, li);
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
	/** Auto-grow + caret follow for the mounted textarea (`src/ui/autogrow.ts`). */
	private grow: AutoGrow | null = null;
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
		tip(titles.createEl("h3", { cls: "ml-panel-title", text: this.name }), SECTION_HINT[this.key]);
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
		if (this.key === "today" || this.key === "work") this.mountQuickAdd();
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
		this.grow?.dispose();
		this.grow = null;
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
		this.grow?.dispose();
		this.grow = new AutoGrow(ta, { minHeight: 96 });
		ta.addEventListener("input", () => {
			this.dirty = normalizeContent(ta.value) !== (this.base ?? "");
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
		ta.focus();
		ta.selectionStart = ta.selectionEnd = ta.value.length;
	}

	/** Refit the height after a programmatic value change (no caret follow). */
	private autosize(): void {
		this.grow?.fit();
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
	private milestoneEl!: HTMLElement;
	private milestoneSeq = 0;
	/** The 결정 대기 line being dragged onto 개인 / 회사 할 일. */
	private draggingPending: SourceLine | null = null;
	/** Project id → 개인 / 회사, for project-linked Desk lines (from the milestone load). */
	private scopeOf: ScopeLookup | undefined;
	private pendingEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private panels: SectionPanel[] = [];
	private padExists = false;
	private loadSeq = 0;
	/** This ISO week's Flywheel completions per element id (`n/7` badges). */
	flywheelWeek: Map<string, number> = new Map();
	/** 결정 대기: show the lines already checked done (to uncheck a mistake). */
	private showDonePending = false;

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
		mountAppNav(this);
		if (Platform.isMobile) this.register(trackKeyboard(this.contentEl));
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
		this.milestoneEl = this.rootEl.createDiv({ cls: "ml-panel ml-day-milestones" });
		this.deskEl = this.rootEl.createDiv({ cls: "ml-panel ml-desk" });
		this.pendingEl = this.rootEl.createDiv({ cls: "ml-panel ml-pending" });
		this.gridEl = this.rootEl.createDiv({ cls: "ml-grid" });
		const mode = this.plugin.settings.sideMode;
		for (const key of MAIN_SECTION_KEYS) {
			// 개인 / 회사 mode: only that side's task section (전체: both).
			if ((key === "today" && mode === "회사") || (key === "work" && mode === "개인")) continue;
			const p = new SectionPanel(this, key);
			p.mount(this.gridEl);
			this.panels.push(p);
			if (key === "today" || key === "work") this.pendingDropZone(p.el, key === "work" ? "회사" : "개인");
		}
	}

	/** 개인 / 회사 할 일 take a 결정 대기 line dropped on them (desktop drag). */
	private pendingDropZone(el: HTMLElement, side: "개인" | "회사"): void {
		const ok = (e: DragEvent) => !!this.draggingPending && !!e.dataTransfer?.types.includes(PENDING_MIME);
		el.addEventListener("dragover", (e) => {
			if (!ok(e)) return;
			e.preventDefault();
			el.addClass("is-drop-target");
		});
		el.addEventListener("dragleave", (e) => {
			if (!el.contains(e.relatedTarget as Node | null)) el.removeClass("is-drop-target");
		});
		el.addEventListener("drop", (e) => {
			if (!ok(e)) return;
			e.preventDefault();
			el.removeClass("is-drop-target");
			const sl = this.draggingPending!;
			this.draggingPending = null;
			void this.decideToday(this.date, sl, side);
		});
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
		await this.refreshMilestones();
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
		if (paths.some(path => path && watchesMilestoneProjects(this.plugin, path))) void this.refreshMilestones();
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

	private async refreshMilestones(): Promise<void> {
		const seq = ++this.milestoneSeq, date = this.date;
		const result = await loadMilestoneCalendar(this.plugin);
		if (seq !== this.milestoneSeq || date !== this.date || !this.milestoneEl) return;
		const mode = this.plugin.settings.sideMode;
		const markers = result.markers.filter(m => m.date === date && shows(asSide(m.scope), mode)), el = this.milestoneEl;
		if (this.scopeOf === undefined && result.scopeOf) {
			// Project-linked Desk lines follow their project's side: redraw now that it is known.
			this.scopeOf = result.scopeOf;
			void this.readDesk().then((t) => this.renderDesk(t));
		}
		this.scopeOf = result.scopeOf;
		el.empty(); el.toggle(!!(markers.length || result.issues.length));
		if (markers.length) {
			tip(el.createDiv({ cls: "ml-panel-head" }).createEl("h3", { cls: "ml-panel-title", text: date === todayIso() ? "오늘의 마일스톤" : "이날의 마일스톤" }), "프로젝트의 목표일 · 할 일 체크와는 별개예요");
			const body = el.createDiv({ cls: "ml-panel-body" });
			renderMilestoneMarkers(body, markers, todayIso(), path => void this.plugin.openProjectAt(path));
		}
		renderMilestoneIssues(el, result.issues, path => void this.plugin.openProjectAt(path));
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
			// Flywheel is checked in the Flywheel view (수행 표), not as Daily Pad lines (12 Flywheel AGENTS 「4-2」, 2026-10-28).
			const content = dailyPadSkeleton({
				isoDate: this.date,
				weekday: moment(this.date, "YYYY-MM-DD").format("ddd"),
				deskCalendarFolder: s.deskCalendarFolder,
				sections: MAIN_SECTION_KEYS.map((k) => s.sections[k]),
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
		tip(titles.createEl("h3", { cls: "ml-panel-title", text: "Desk Calendar에서 온 일" }), "정본은 Desk Calendar · 체크하면 그 파일에 저장돼요");
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
		// 개인 / 회사 mode: the other side folds to its count (`./side.ts`).
		const mode = this.plugin.settings.sideMode;
		let parentShown = true;
		const lines = sec.lines.filter((sl) => {
			// A nested line goes with its parent.
			if (sl.indent > 0) return parentShown;
			parentShown = !sl.item || shows(lineSide(sl.line, this.scopeOf), mode);
			return parentShown;
		});
		const folded = sec.lines.filter((sl) => sl.item && sl.item.status === "scheduled" && !lines.includes(sl)).length;
		if (folded) {
			const other = mode === "개인" ? "회사" : "개인";
			tip(tools.createSpan({ cls: `ml-side-hidden is-${other === "회사" ? "work" : "personal"}`, text: `${other} ${folded}` }), `${other} 일 ${folded}개는 ${mode} 모드에서 접어 두었어요`);
		}
		if (!lines.length) {
			this.gentle(body, `이 날 ${mode} 일이 없어요.`);
			return;
		}
		renderItemList(body, lines, {
			showTest: this.plugin.settings.showTestMarkers,
			onToggle: (sl, li) => void this.toggleDeskLine(sl, li),
			openGoal: (id) => void this.plugin.openPinboardGoal(id),
			openProject: (id) => void this.plugin.openProjectAt(id),
			menu: (sl, pop) => {
				const f = this.deskFile();
				if (!f) return;
				pop.addSeparator();
				pop.addItem((i) => i.setTitle("Desk Calendar에서 보기").setIcon("calendar-days").onClick(() => void this.app.workspace.getLeaf(false).openFile(f, { eState: { line: sl.index } })));
			},
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
  try { if (await toggleLinkedProjectTask(this.plugin, file.path, sl.index, sl.line, todayIso())) { this.renderDesk(await this.readDesk()); return; } }
  catch(e) { new Notice(e instanceof Error ? e.message : String(e)); this.renderDesk(await this.readDesk()); return; }
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
		tip(
			titles.createEl("h3", { cls: "ml-panel-title", text: name }),
			"지난날 못 한 일이에요. 항목마다 갈 곳을 하나 골라 주세요 — 다른 날 · 미래로 · 서랍에 · 쪼개기 · 놓아주기. 고를 때까지 여기 남아요.",
		);
		const open = lines.filter((sl) => sl.indent === 0 && sl.item?.kind === "task" && sl.item.status === "scheduled").length;
		// Done here stays in the file (`[x]`, and done on its original day too) but leaves the screen;
		// 「완료 n · 보기」 brings it back to uncheck a mistake.
		const isDone = (sl: SourceLine) => sl.indent === 0 && sl.item?.kind === "task" && sl.item.status === "done";
		const done = lines.filter(isDone).length;
		if (open) titles.createSpan({ cls: "ml-pending-count", text: String(open) });
		el.toggleClass("is-all-done", !open && done > 0);
		if (done) {
			const t = head.createEl("button", { cls: "ml-btn ml-btn-ghost ml-pending-done", text: this.showDonePending ? `완료 ${done} · 숨기기` : `완료 ${done} · 보기`, attr: { type: "button" } });
			tip(t, "결정 대기에서 완료한 일이에요. 펼쳐서 체크를 풀 수 있어요.");
			t.addEventListener("click", () => {
				this.showDonePending = !this.showDonePending;
				this.renderPending(padText);
			});
		}
		if (!open && !done) {
			el.toggle(false);
			return;
		}
		if (!open && !this.showDonePending) return;
		const body = el.createDiv({ cls: "ml-panel-body" });
		const candidates = new Map(extractCandidates(padText, name).map((c) => [c.index, c]));
		const date = this.date;
		const missedOn = (sl: SourceLine) => {
			const d = sourceDateOf(sl.line);
			return d ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}에 못 한 일` : "지난날 못 한 일";
		};
		const decidable = (sl: SourceLine) => sl.indent === 0 && sl.item?.kind === "task" && sl.item.status === "scheduled" && !isFlywheelLine(sl.line);
		const addChoices = (sl: SourceLine, pop: ItemPopover) => {
			if (!decidable(sl)) return;
			const cand = candidates.get(sl.index);
			if (cand) {
				// 「3-6」 0: a 후보 is not a 못 한 일 — 넣기 / 놓아주기 only.
				pop.addSeparator();
				pop.addItem((i) =>
					i.setTitle(cand.kind === "project" ? "Drawer 프로젝트 후보로 넣기…" : "서랍에 넣기…").setIcon("archive").setHint("다시 꺼낼 조건을 붙여 Drawer에 넣어요").onClick(() => void this.acceptCandidate(cand)),
				);
				pop.addItem((i) => i.setTitle("놓아주기").setIcon("circle-slash").setHint("넣지 않아요. 기록 없이 지워요").onClick(() => void this.dropCandidate(cand)));
				return;
			}
			const choose = (kind: PendingChoice["kind"]) => void this.decide(date, sl, kind);
			pop.addSeparator();
			pop.addItem((i) => i.setTitle("오늘 · 개인 할 일").setIcon("sun").onClick(() => void this.decideToday(date, sl, "개인")));
			pop.addItem((i) => i.setTitle("오늘 · 회사 할 일").setIcon("briefcase").onClick(() => void this.decideToday(date, sl, "회사")));
			pop.addSeparator();
			pop.addItem((i) => i.setTitle("다른 날…").setIcon("calendar").onClick(() => choose("day")));
			pop.addItem((i) => i.setTitle("먼 달로…").setIcon("calendar-clock").onClick(() => choose("future")));
			pop.addItem((i) => i.setTitle("서랍에…").setIcon("archive").onClick(() => choose("drawer")));
			pop.addItem((i) => i.setTitle("쪼개기…").setIcon("scissors").onClick(() => choose("split")));
			pop.addItem((i) => i.setTitle("놓아주기…").setIcon("circle-slash").onClick(() => choose("letgo")));
		};
		renderItemList(body, lines, {
			showTest: this.plugin.settings.showTestMarkers,
			flywheelWeek: this.flywheelWeek,
			openGoal: (id) => void this.plugin.openPinboardGoal(id),
			openProject: (id) => void this.plugin.openProjectAt(id),
			menu: (sl, pop) => {
				pop.sub = decidable(sl) ? missedOn(sl) : "";
				addChoices(sl, pop);
			},
			decorate: (sl, li) => {
				if (isDone(sl) && !this.showDonePending) li.addClass("ml-hidden-done");
				if (!decidable(sl)) return;
				// One tap: today, into the 할 일 section it came from. ⋯ for the rest. Or drag it onto 개인 / 회사 할 일.
				const acts = li.createSpan({ cls: "ml-decide-acts" });
				if (!candidates.get(sl.index)) {
					const t = acts.createEl("button", { cls: "ml-btn ml-decide ml-decide-today", text: "오늘로", attr: { type: "button" } });
					tip(t, "오늘 할 일로 옮겨요 (원래 있던 개인 / 회사 칸으로). 끌어서 개인 · 회사 할 일 칸에 놓아도 돼요");
					t.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						t.disabled = true;
						void pendingSide(this.plugin, date, sl).then((side) => this.decideToday(date, sl, side));
					});
					li.draggable = true;
					li.addClass("ml-pending-draggable");
					li.addEventListener("dragstart", (e) => {
						this.draggingPending = sl;
						e.dataTransfer?.setData(PENDING_MIME, "1");
						if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
						this.rootEl.addClass("is-dragging-pending");
					});
					li.addEventListener("dragend", () => {
						this.rootEl.removeClass("is-dragging-pending");
						window.setTimeout(() => (this.draggingPending = null), 0);
					});
				}
				const b = acts.createEl("button", { cls: "ml-btn ml-btn-ghost ml-decide-more", text: "⋯", attr: { type: "button", "aria-label": "다른 곳으로" } });
				b.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					const pop = new ItemPopover();
					pop.title = sl.item!.text;
					pop.sub = missedOn(sl);
					addChoices(sl, pop);
					pop.show(b);
				});
			},
			onToggle: (sl, li) => {
				li.addClass("is-pending");
				// Done here = done on the day it came from too (its Desk Calendar cell and Daily Pad).
				void togglePending(this.plugin, date, sl, todayIso())
					.catch((err) => {
						new Notice(err instanceof Error ? err.message : String(err));
						return null;
					})
					.then(async (state) => {
						if (!state) {
							new Notice("Daily Pad에서 이 줄을 찾지 못했어요. 파일이 바뀌어서 다시 불러왔어요.");
							this.renderPending(await this.readPad());
							return;
						}
						if (state === "done") this.undoNotice(date, { ...sl, line: sl.line.replace(/\[ \]/, "[x]") });
					});
			},
		});
	}

	/** 「완료했어요 · 되돌리기」 for 8 s after a 결정 대기 check (the original day is reopened too). */
	private undoNotice(date: string, doneLine: SourceLine): void {
		const frag = createFragment();
		frag.appendText(`「${doneLine.item?.text ?? ""}」 완료했어요 `);
		const b = frag.createEl("button", { cls: "ml-undo-btn", text: "되돌리기", attr: { type: "button" } });
		const n = new Notice(frag, 8000);
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			n.hide();
			void togglePending(this.plugin, date, doneLine, todayIso()).then((s) => {
				if (s !== "open") new Notice("되돌리지 못했어요. 결정 대기의 「완료 · 보기」에서 체크를 풀어 주세요.");
			});
		});
	}

	/** 결정 대기 → today's 개인 / 회사 할 일 (the 「오늘로」 button, ⋯, or a drop on that section). */
	async decideToday(date: string, sl: SourceLine, side: "개인" | "회사"): Promise<void> {
		await this.flushAll();
		const ok = await chooseToday(this.plugin, date, sl, side, todayIso());
		if (!ok) this.renderPending(await this.readPad());
	}

	private async decide(date: string, sl: SourceLine, kind: PendingChoice["kind"]): Promise<void> {
		await this.flushAll();
		const ok = await choosePending(this.plugin, date, sl, kind, todayIso());
		if (!ok) this.renderPending(await this.readPad());
	}

	private async acceptCandidate(cand: ReturnType<typeof extractCandidates>[number]): Promise<void> {
		const pad = this.padFile();
		if (!pad) return;
		const a = await askWhen(this.app, cand.text);
		if (!a) return;
		if (a.kind === "letgo") return this.dropCandidate(cand);
		if (await acceptCandidate(this.plugin, pad, cand, cand.kind === "project" ? "프로젝트 후보" : "보류", a.when)) new Notice(`「${cand.text}」을(를) Drawer에 넣었어요.`);
	}

	private async dropCandidate(cand: ReturnType<typeof extractCandidates>[number]): Promise<void> {
		const pad = this.padFile();
		if (pad && (await removeCandidateLine(this.plugin, pad, cand))) new Notice(`「${cand.text}」을(를) 놓아줬어요.`);
	}
}
