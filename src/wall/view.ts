import { loadProjectBacklog, type BacklogGroup } from "../projects/backlog.ts";
import { scheduleSource, scheduleTarget, selectSchedule, selectedSchedule, type ScheduleItem } from "../projects/schedule-dnd.ts";
import { taskLabel } from "../projects/tasks.ts";
import { asSide, inputSide, lineSide, projectRef, setSide, shows, type Side } from "../side.ts";
import { toggleLinkedProjectTask } from "../projects/task-actions.ts";
import { mountAppNav } from "../ui/nav.ts";
import { ItemPopover } from "../ui/popover.ts";
import { tip } from "../ui/tip.ts";
import { debounce, ItemView, Keymap, normalizePath, Notice, Platform, TAbstractFile, TFile, TFolder, type ViewStateResult, WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { loadMilestoneCalendar, renderMilestoneMarkers, renderMilestoneIssues, watchesMilestoneProjects, type MilestoneCalendar } from "../projects/milestone-calendar-ui.ts";
import { pad2, toIsoDate } from "../parser.ts";
import { setFrontmatterScalar } from "../writer.ts";
import {
	addIndexChange,
	cancelWallEvent,
	cancelWallTask,
	deleteWallItem,
	deskLineFor,
	deskLink,
	editWallItem,
	type EditResult,
	formatNewLine,
	insertIntoDesk,
	insertIntoMonth,
	setWallSide,
	markSentToDesk,
	moveWallItem,
	type NewKind,
	normalizeDateInput,
	toggleWallTask,
	type WallTarget,
} from "./edit.ts";
import { MonthPickerModal, TextPromptModal } from "./modals.ts";
import { askForm, confirmDelete } from "../ui/modals.ts";
import { enableTouchMenus } from "../ui/mobile.ts";
import { contentText, getField } from "../line-edit.ts";
import { itemSortKey, parseWallYear, splitWallBody, WALL_DATE_RE, type WallItem, type WallLine, wallYearSkeleton } from "./parse.ts";

/** Wall is month planning: 후보 projects' tasks count too (Desk 주 보기: 진행 · 대기). */
const WALL_BACKLOG = ["후보", "진행", "대기"];

export const VIEW_TYPE_WALL_CALENDAR = "mylogs-wall-calendar";
export const INDEX_FILE = "Wall Calendar Index.md";
const DRAG_MIME = "application/x-mylogs-wall-item";

const KIND_LABEL: Record<string, string> = { task: "할 일", event: "행사", note: "메모" };
const WEEKDAYS = "일월화수목금토"; // Date.getDay() order; display only (TODO i18n)
const TAG_HUES: Record<string, number> = { 회사: 215, 가족: 350, 건강: 150 };
const FALLBACK_HUES = [30, 270, 190, 95, 320, 50];

function tagHue(tag: string): number {
	if (tag in TAG_HUES) return TAG_HUES[tag];
	let s = 0;
	for (const ch of tag) s += ch.codePointAt(0) ?? 0;
	return FALLBACK_HUES[s % FALLBACK_HUES.length];
}

function todayIso(): string {
	return toIsoDate(new Date());
}

function isoToDate(iso: string): Date {
	return new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 12);
}

function weekday(iso: string): string {
	return WEEKDAYS[isoToDate(iso).getDay()];
}

type MonthState = "past" | "now" | "upcoming" | "later";

export class WallCalendarView extends ItemView {
	readonly plugin: MyLogsPlugin;
	year: number = new Date().getFullYear();
	private rootEl!: HTMLElement;
	private text: string | null = null;
	private loadSeq = 0;
	private busy = false;
	private milestones: MilestoneCalendar = { markers: [], issues: [] };
	/** 개인 / 회사 of each line (by index), and per month how many 예정 lines the mode folded away. */
	private sides = new Map<number, Side>();
	/** 배정 안 된 프로젝트 할 일 (to put on a month). */
	private backlog: BacklogGroup[] = [];
	/** Tasks of the other side's projects (개인 / 회사 mode), shown as a count. */
	private backlogFolded = 0;

	private hidden = new Map<number, number>();
	/** Month whose inline add form is open (kept across re-renders). */
	private addOpen: number | null = null;

	private scheduleReload = debounce(() => void this.reload(), 250, true);

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_WALL_CALENDAR;
	}

	getDisplayText(): string {
		return `Wall Calendar · ${this.year}`;
	}

	getIcon(): string {
		return "calendar-range";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), year: this.year };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const y = (state as { year?: number } | null)?.year;
		if (typeof y === "number" && y > 1900 && y < 3000 && y !== this.year) await this.goTo(y);
		await super.setState(state, result);
	}

	// ── paths ──

	private folder(): string {
		return this.plugin.settings.wallCalendarFolder;
	}

	yearPath(year = this.year): string {
		return normalizePath(`${this.folder()}/${year}.md`);
	}

	private indexPath(): string {
		return normalizePath(`${this.folder()}/${INDEX_FILE}`);
	}

	private file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	private availableYears(): number[] {
		const out = new Set<number>([new Date().getFullYear(), this.year]);
		for (const m of this.milestones.markers) out.add(Number(m.date.slice(0, 4)));
		const dir = this.app.vault.getAbstractFileByPath(normalizePath(this.folder()));
		if (dir instanceof TFolder) {
			for (const c of dir.children) {
				const m = /^(\d{4})\.md$/.exec(c.name);
				if (c instanceof TFile && m) out.add(parseInt(m[1], 10));
			}
		}
		return [...out].sort((a, b) => a - b);
	}

	// ── lifecycle ──

	/** Scroll to this month on the next render (open, back to this year). */
	private scrollToNow = true;

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-wall-calendar-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-wall-calendar" });
		mountAppNav(this);
		if (Platform.isMobile) this.register(enableTouchMenus(this.contentEl));
		const onFile = (f: TAbstractFile, old?: string) => {
			const p = this.yearPath();
			if (f.path === p || old === p || watchesMilestoneProjects(this.plugin, f.path) || (old && watchesMilestoneProjects(this.plugin, old))) this.scheduleReload();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile(f, old)));
		await this.reload();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refreshAll(): Promise<void> {
		await this.reload();
	}

	async goTo(year: number): Promise<void> {
		if (year === this.year) return;
		this.year = year;
		this.scrollToNow = year === new Date().getFullYear();
		this.addOpen = null;
		await this.reload();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
	}

	private async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		const f = this.file(this.yearPath());
		const text = f ? await this.app.vault.read(f) : null;
		const milestones = await loadMilestoneCalendar(this.plugin);
		// Both sides are read; the other side's tasks show as a count.
		const all = await loadProjectBacklog(this.plugin, WALL_BACKLOG, "전체", true);
		if (seq !== this.loadSeq) return;
		const mode = this.plugin.settings.sideMode;
		this.backlog = all.filter((g) => shows(g.scope, mode));
		this.backlogFolded = all.filter((g) => !this.backlog.includes(g)).reduce((n, g) => n + g.tasks.length, 0);
		this.text = text;
		this.milestones = { ...milestones, markers: milestones.markers.filter((m) => shows(asSide(m.scope), mode)) };
		// Project sync must not erase a calendar task the user is currently typing.
		if (this.addOpen !== null && this.rootEl.querySelector(".wc-addform")) return;
		this.render();
	}

	// ── state helpers ──

	private monthState(month: number): MonthState {
		const now = new Date();
		const diff = this.year * 12 + month - (now.getFullYear() * 12 + now.getMonth() + 1);
		if (diff < 0) return "past";
		if (diff === 0) return "now";
		return this.year === now.getFullYear() ? "upcoming" : "later";
	}

	/** Past months are a record: AGENTS.md 「흐름」 4 — 지난달 칸은 고치지 않는다. */
	private editable(month: number): boolean {
		return this.text !== null && this.monthState(month) !== "past";
	}

	// ── render ──

	private render(): void {
		const root = this.rootEl;
		const scroll = this.contentEl.scrollTop;
		root.empty();
		const sheet = root.createDiv({ cls: "wc-sheet" });
		const binding = sheet.createDiv({ cls: "wc-binding", attr: { "aria-hidden": "true" } });
		for (let i = 0; i < 30; i++) binding.createEl("i");
		this.renderHead(sheet);
		renderMilestoneIssues(sheet, this.milestones.issues, path => void this.plugin.openProjectAt(path));
		if (this.text !== null) this.renderBacklog(sheet);

		if (this.text === null) {
			const empty = sheet.createDiv({ cls: "wc-missing" });
			empty.createSpan({ text: `${this.year}년 Wall Calendar가 아직 없어요.` });
			const b = tip(empty.createEl("button", { cls: "mod-cta", text: `${this.year}년 달력 만들기`, attr: { type: "button" } }), "마일스톤은 프로젝트에서 읽어 표시해요. 달력 파일은 자동으로 만들지 않아요.");
			b.addEventListener("click", () => void this.createYearFile());
		}

		const wy = parseWallYear(this.text ?? wallYearSkeleton(this.year, todayIso()), this.year);
		const grid = sheet.createDiv({ cls: "wc-months" });
		const mode = this.plugin.settings.sideMode;
		const scopeOf = this.milestones.scopeOf;
		for (const sec of wy.months) {
			for (const l of sec.lines) this.sides.set(l.index, lineSide(l.line, scopeOf));
			const shown = sec.lines.filter((l) => shows(this.sides.get(l.index)!, mode));
			this.hidden.set(sec.month, sec.lines.filter((l) => l.item.status === "scheduled").length - shown.filter((l) => l.item.status === "scheduled").length);
			this.renderMonth(grid, sec.month, shown, sec.headingIndex !== -1);
		}

		const global = wy.issues.filter((x) => x.month === undefined);
		if (global.length) {
			const box = sheet.createDiv({ cls: "wc-issues" });
			box.createEl("h3", { text: `형식 확인 필요 ${global.length}` });
			const ul = box.createEl("ul");
			for (const x of global) {
				const li = ul.createEl("li");
				li.createSpan({ cls: "wc-ln", text: x.line ? `${x.line}번째 줄` : "빠진 제목" });
				li.createEl("code", { text: x.raw });
				li.createSpan({ cls: "wc-why", text: x.why });
			}
		}
		this.renderLegend(sheet);
		const foot = sheet.createDiv({ cls: "wc-foot" });
		const link = foot.createEl("a", { text: `원본: ${this.yearPath()}`, attr: { href: "#" } });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			const f = this.file(this.yearPath());
			if (f) void this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f);
		});
		this.contentEl.scrollTop = scroll;
		if (this.scrollToNow) {
			const now = sheet.querySelector<HTMLElement>(".wc-month.is-now");
			if (now) {
				this.scrollToNow = false;
				// Open on this month (most of all on a phone, where months stack in one column).
				window.requestAnimationFrame(() => {
					const top = now.getBoundingClientRect().top - this.contentEl.getBoundingClientRect().top + this.contentEl.scrollTop;
					this.contentEl.scrollTop = Math.max(0, top - 12);
				});
			}
		}
	}

	private renderHead(sheet: HTMLElement): void {
		const head = sheet.createDiv({ cls: "wc-masthead" });
		const yb = head.createDiv({ cls: "wc-yearblock" });
		yb.createDiv({ cls: "wc-eyebrow", text: "Wall Calendar · 미래 기록" });
		const row = yb.createDiv({ cls: "wc-yearrow" });
		const prev = row.createEl("button", { cls: "wc-navbtn", text: "‹", attr: { type: "button", "aria-label": "이전 해" } });
		prev.addEventListener("click", () => void this.goTo(this.year - 1));
		const h1 = row.createEl("h1");
		h1.createSpan({ text: String(this.year) });
		h1.createSpan({ cls: "wc-dot" });
		const next = row.createEl("button", { cls: "wc-navbtn", text: "›", attr: { type: "button", "aria-label": "다음 해" } });
		next.addEventListener("click", () => void this.goTo(this.year + 1));
		const sel = row.createEl("select", { cls: "dropdown wc-yearsel", attr: { "aria-label": "연도 고르기" } });
		for (const y of this.availableYears()) {
			const o = sel.createEl("option", { text: String(y), value: String(y) });
			if (y === this.year) o.selected = true;
		}
		sel.addEventListener("change", () => void this.goTo(parseInt(sel.value, 10)));

		const t = todayIso();
		const tb = head.createDiv({ cls: "wc-todaybox" });
		tb.createSpan({ cls: "wc-tl", text: "오늘" });
		tb.createSpan({ cls: "wc-td", text: `${+t.slice(0, 4)}년 ${+t.slice(5, 7)}월 ${+t.slice(8, 10)}일 (${weekday(t)})` });
		const thisYear = new Date().getFullYear();
		if (this.year !== thisYear) {
			const b = tb.createEl("button", { cls: "wc-linkbtn", text: "올해로", attr: { type: "button" } });
			b.addEventListener("click", () => void this.goTo(thisYear));
		}

	}

	/** Symbol legend, at the bottom of the sheet: reference, not something to read first. */
	private renderLegend(sheet: HTMLElement): void {
		const lg = sheet.createDiv({ cls: "wc-legend" });
		const leg = (cls: string, label: string) => {
			const s = lg.createSpan({ cls: `wc-lg ${cls}` });
			s.createSpan({ cls: "wc-sym" });
			s.createSpan({ text: label });
		};
		leg("k-task s-scheduled", "할 일");
		leg("k-task s-done", "완료");
		leg("k-task s-moved", "옮김 (→)");
		leg("k-task s-cancelled", "놓아줌");
		leg("k-event s-scheduled", "행사");
		leg("k-note s-scheduled", "메모");
		lg.createSpan({ cls: "ml-milestone-legend", text: "◆ 마일스톤 · 프로젝트의 목표일" });
		tip(lg, "항목을 누르면 자세한 내용과 할 수 있는 일(완료·옮기기·수정·삭제)이 나와요 · 다른 달로 끌어 옮길 수 있어요");
	}

	/**
	 * 배정 안 된 프로젝트 할 일: drag one onto a month, or tap it and then the month. It goes to that
	 * month's Desk 「이달 중」 when the Desk file exists, else to this Wall month (`changeProjectTask`).
	 */
	private renderBacklog(sheet: HTMLElement): void {
		if (!this.backlog.length && !this.backlogFolded) return;
		const box = sheet.createDiv({ cls: "wc-backlog" });
		const head = box.createDiv({ cls: "wc-backlog-head" });
		tip(head.createEl("h3", { text: "인박스" }), "후보 · 진행 · 대기 프로젝트에서 아직 달이 없는 할 일(첫 단계만). 달 칸으로 끌거나, 누른 뒤 달 칸을 눌러요. 묶음을 놓으면 하위 할 일이 모두 그 달로 가요. 휴대폰은 길게 눌러 끌어요");
		const mode = this.plugin.settings.sideMode;
		if (this.backlogFolded && mode !== "전체") {
			const other = mode === "개인" ? "회사" : "개인";
			tip(head.createSpan({ cls: `ml-side-hidden is-${other === "회사" ? "work" : "personal"}`, text: `${other} ${this.backlogFolded}` }), `${other} 프로젝트의 할 일 ${this.backlogFolded}개는 ${mode} 모드에서 접어 두었어요`);
		}
		if (!this.backlog.length) box.createDiv({ cls: "wc-backlog-empty", text: `${mode} 인박스가 비었어요.` });
		const chosen = selectedSchedule(this.plugin);
		if (chosen?.kind === "task") {
			const bar = head.createDiv({ cls: "wc-backlog-chosen" });
			bar.createSpan({ text: `「${chosen.title}」 — 달을 고르세요` });
			const x = bar.createEl("button", { text: "취소", attr: { type: "button" } });
			x.addEventListener("click", () => {
				selectSchedule(this.plugin, null);
				this.render();
			});
		}
		for (const g of this.backlog) {
			const row = box.createDiv({ cls: "wc-backlog-group" });
			const name = row.createEl("button", { cls: "wc-backlog-project", text: g.project, attr: { type: "button" } });
			name.addEventListener("click", () => void this.plugin.openProjectAt(g.projectPath));
			const list = row.createDiv({ cls: "wc-backlog-tasks" });
			for (const t of g.tasks) {
				const item: ScheduleItem = { kind: "task", projectPath: g.projectPath, projectId: g.projectId, title: taskLabel(t), task: t };
				const kids = t.group ? this.groupSize(g, t) : 0;
				const b = list.createEl("button", { cls: `wc-backlog-task${t.group ? " is-group" : ""}`, text: `□ ${taskLabel(t)}${kids ? ` · 하위 ${kids}` : ""}`, attr: { type: "button" } });
				if (chosen?.kind === "task" && chosen.task.id === t.id) b.addClass("is-chosen");
				b.addEventListener("click", () => {
					selectSchedule(this.plugin, chosen?.kind === "task" && chosen.task.id === t.id ? null : item);
					this.render();
				});
				scheduleSource(b, this.plugin, item);
			}
		}
	}

	/** How many 하위 할 일 a 묶음 in the 인박스 would take to the month. */
	private groupSize(g: BacklogGroup, t: { id: string }): number {
		return g.children?.[t.id] ?? 0;
	}

	private renderMonth(grid: HTMLElement, month: number, lines: WallLine[], hasHeading: boolean): void {
		const state = this.monthState(month);
		const cell = grid.createEl("section", { cls: `wc-month is-${state}`, attr: { "aria-label": `${this.year}년 ${month}월` } });
		if (state !== "past" && this.text !== null && this.backlog.length)
			scheduleTarget(cell, this.plugin, { kind: "month", month: this.ym(month) }, () => this.reload(), (it) => {
				const ym = this.ym(month);
				const desk = this.file(normalizePath(`${this.plugin.settings.deskCalendarFolder}/${ym.slice(0, 4)}/${ym}.md`));
				new Notice(`「${it.title}」 → ${month}월${desk ? " (Desk Calendar 이달 중)" : ""}`);
			});
		if (state === "now") cell.addClass("is-upcoming");
		const head = cell.createDiv({ cls: "wc-mhead" });
		const title = head.createDiv({ cls: "wc-mtitle" });
		title.createSpan({ cls: "wc-mnum", text: String(month) });
		title.createSpan({ cls: "wc-mwol", text: "월" });
		const meta = title.createDiv({ cls: "wc-mmeta" });
		if (state === "now") meta.createSpan({ cls: "wc-nowmark", text: "이번 달" });
		const live = lines.filter((l) => l.item.status === "scheduled").length;
		if (live) meta.createSpan({ cls: "wc-cnt", text: `예정 ${live}` });
		const folded = this.hidden.get(month) ?? 0;
		const mode = this.plugin.settings.sideMode;
		if (folded && mode !== "전체") {
			const other = mode === "개인" ? "회사" : "개인";
			tip(meta.createSpan({ cls: `ml-side-hidden is-${other === "회사" ? "work" : "personal"}`, text: `${other} ${folded}` }), `${other} 일 ${folded}개는 ${mode} 모드에서 접어 두었어요`);
		}
		if (this.editable(month) && hasHeading) {
			const add = meta.createEl("button", { cls: "wc-add", text: "+", attr: { type: "button", "aria-label": `${month}월에 추가`, title: "이 달에 추가" } });
			add.addEventListener("click", () => {
				this.addOpen = this.addOpen === month ? null : month;
				this.render();
			});
		}
		this.renderMini(head, month, lines);

		const body = cell.createDiv({ cls: "wc-mbody" });
		const milestones = this.milestones.markers.filter(m => m.date.startsWith(`${this.year}-${pad2(month)}-`));
		renderMilestoneMarkers(body, milestones, todayIso(), path => void this.plugin.openProjectAt(path), true, this.plugin);
		if (this.addOpen === month) this.renderAddForm(body, month);
		const dated = lines.filter((l) => l.item.start !== null && l.item.ok).sort((a, b) => (itemSortKey(a.item) < itemSortKey(b.item) ? -1 : itemSortKey(a.item) > itemSortKey(b.item) ? 1 : a.index - b.index));
		const undated = lines.filter((l) => l.item.start === null && l.item.ok);
		const broken = lines.filter((l) => !l.item.ok);
		if (!lines.length && !milestones.length && this.addOpen !== month) {
			const e = body.createDiv({ cls: "wc-empty" });
			e.createSpan({ text: !hasHeading ? `## ${this.year}-${pad2(month)} 제목이 없어요` : state === "past" ? "적힌 일이 없던 달" : "아직 비어 있어요" });
		}
		if (dated.length) this.renderItems(body.createEl("ol", { cls: "wc-items" }), month, dated);
		if (undated.length) {
			body.createDiv({ cls: "wc-sub" }).createSpan({ text: "이달 중" });
			this.renderItems(body.createEl("ol", { cls: "wc-items is-undated" }), month, undated);
		}
		if (broken.length) {
			body.createDiv({ cls: "wc-sub is-warn" }).createSpan({ text: "형식 확인 필요" });
			this.renderItems(body.createEl("ol", { cls: "wc-items is-undated" }), month, broken);
		}

		// Drop target (another month of this year).
		if (this.editable(month) && hasHeading) {
			cell.addEventListener("dragover", (e) => {
				if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				cell.addClass("is-drop");
			});
			cell.addEventListener("dragleave", (e) => {
				if (!cell.contains(e.relatedTarget as Node | null)) cell.removeClass("is-drop");
			});
			cell.addEventListener("drop", (e) => {
				cell.removeClass("is-drop");
				const raw = e.dataTransfer?.getData(DRAG_MIME);
				if (!raw) return;
				e.preventDefault();
				try {
					const t = JSON.parse(raw) as WallTarget & { year: number };
					if (t.year !== this.year || t.month === month) return;
					void this.moveItem(t, month);
				} catch {
					/* ignore foreign drops */
				}
			});
		}
	}

	private renderMini(head: HTMLElement, month: number, lines: WallLine[]): void {
		const marks = new Map<number, Set<string>>();
		for (const { item } of lines) {
			if (!item.start || item.status === "cancelled") continue;
			const s = isoToDate(item.start);
			const e = isoToDate(item.end ?? item.start);
			for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
				if (d.getFullYear() !== this.year || d.getMonth() + 1 !== month) continue;
				const set = marks.get(d.getDate()) ?? new Set<string>();
				set.add(`k-${item.kind}`);
				if (item.status === "scheduled") set.add("live");
				marks.set(d.getDate(), set);
			}
		}
		const mini = head.createDiv({ cls: "wc-mini", attr: { "aria-label": "날짜 배정 달력" } });
		const milestoneDays = new Set(this.milestones.markers.filter(m => m.date.startsWith(`${this.year}-${pad2(month)}-`)).map(m => Number(m.date.slice(8))));
		for (let i = 0; i < 7; i++) mini.createEl("i", { cls: i === 0 ? "sun" : i === 6 ? "sat" : "", text: WEEKDAYS[i] });
		const first = new Date(this.year, month - 1, 1, 12);
		for (let i = 0; i < first.getDay(); i++) mini.createSpan();
		const days = new Date(this.year, month, 0).getDate();
		const today = todayIso();
		for (let d = 1; d <= days; d++) {
			const wd = (first.getDay() + d - 1) % 7;
			const c = mini.createSpan({ text: String(d), attr: {tabindex:"0",role:"button","aria-label":`${this.year}-${pad2(month)}-${pad2(d)}에 배정`} });
			scheduleTarget(c, this.plugin, {kind:"day",date:`${this.year}-${pad2(month)}-${pad2(d)}`}, () => this.reload());
			if (wd === 0) c.addClass("sun");
			if (wd === 6) c.addClass("sat");
			const m = marks.get(d);
			if (m) c.addClass("has", ...m);
			if (milestoneDays.has(d)) c.addClass("has-milestone");
			if (`${this.year}-${pad2(month)}-${pad2(d)}` === today) c.addClass("today");
		}
	}

	private renderItems(ol: HTMLElement, month: number, lines: WallLine[]): void {
		for (const l of lines) this.renderItem(ol, month, l);
	}

	private renderItem(ol: HTMLElement, month: number, l: WallLine): void {
		const it = l.item;
		const kind = it.kind ?? "plain";
		const li = ol.createEl("li", { cls: `wc-item k-${kind} s-${it.status}` });
		if (this.sides.get(l.index) === "회사") li.addClass("is-work");
		if (it.problems.length) li.addClass("is-flag");
		const target: WallTarget = { month, index: l.index, line: l.line };
		const canEdit = this.editable(month);

		// Symbol / checkbox
		const toggleable = canEdit && kind === "task" && (it.status === "scheduled" || it.status === "done");
		const sym = li.createEl(toggleable ? "button" : "span", {
			cls: "wc-sym",
			attr: { title: KIND_LABEL[kind] ?? "형식 확인", "aria-label": KIND_LABEL[kind] ?? "형식 확인" },
		});
		if (toggleable) {
			sym.setAttr("type", "button");
			sym.setAttr("role", "checkbox");
			sym.setAttr("aria-checked", it.status === "done" ? "true" : "false");
			sym.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.toggleProjectAware(month, target);
			});
		}

		// Date
		if (it.start) {
			const [big, small] = this.dateLabel(it, month);
			const d = li.createSpan({ cls: "wc-d" });
			d.createEl("b", { text: big });
			d.createEl("small", { text: small });
		} else if (it.time) {
			const d = li.createSpan({ cls: "wc-d" });
			d.createEl("small", { text: it.time });
		}

		const body = li.createSpan({ cls: "wc-body" });
		body.createSpan({ cls: "wc-t", text: it.text });
		// Only what the user reads at a glance: date, text, tags. Fields (goal, project, from, why, →)
		// are in the item popover (click).
		if (it.problems.length) tip(body.createSpan({ cls: "wc-qmark", text: "형식 확인" }), it.problems.join(" · "));
		const chips = body.createSpan({ cls: "wc-chips" });
		for (const t of it.tags) {
			const c = chips.createSpan({ cls: "wc-chip is-tag", text: `#${t}` });
			c.style.setProperty("--h", String(tagHue(t)));
		}
		if (it.test && this.plugin.settings.showTestMarkers) chips.createSpan({ cls: "wc-testmark", text: "TEST", attr: { title: "#test 테스트 데이터" } });

		li.addEventListener("click", (e) => this.openMenu(e, month, l, target, li));
		li.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.openMenu(e, month, l, target, li);
		});
		if (canEdit) {
			li.draggable = true;
			li.addEventListener("dragstart", (e) => {
				e.dataTransfer?.setData(DRAG_MIME, JSON.stringify({ ...target, year: this.year }));
				e.dataTransfer?.setData("text/plain", l.line);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				li.addClass("is-dragging");
				this.rootEl.addClass("is-dragging");
			});
			li.addEventListener("dragend", () => {
				li.removeClass("is-dragging");
				this.rootEl.removeClass("is-dragging");
			});
		}
	}

	private dateLabel(it: WallItem, month: number): [string, string] {
		const s = it.start!;
		const sm = +s.slice(5, 7);
		const sd = +s.slice(8, 10);
		const sLabel = sm !== month ? `${sm}/${sd}` : String(sd);
		let big = sLabel;
		let small = weekday(s);
		if (it.end && it.end !== s) {
			const em = +it.end.slice(5, 7);
			const ed = +it.end.slice(8, 10);
			big = em === sm ? `${sLabel}–${ed}` : `${sLabel}–${em}/${ed}`;
			small = `${weekday(s)}–${weekday(it.end)}`;
		}
		if (it.time) small += ` ${it.time}`;
		return [big, small];
	}

	private ym(month: number): string {
		return `${this.year}-${pad2(month)}`;
	}

	// ── menu ──

	private openMenu(e: MouseEvent, month: number, l: WallLine, target: WallTarget, anchor: HTMLElement): void {
		if ((e.target as HTMLElement).closest("a")) return;
		const it = l.item;
		const menu = new ItemPopover();
		menu.title = it.text || l.line.trim();
		menu.badge = [KIND_LABEL[it.kind ?? "note"] ?? "형식 확인", it.status === "scheduled" ? "" : it.status === "cancelled" && it.kind === "task" ? "놓아줌" : it.status === "cancelled" ? "취소" : it.status === "done" ? "완료" : "옮김"].filter(Boolean).join(" · ");
		if (it.start) menu.row("날짜", `${it.start}${it.end && it.end !== it.start ? ` ~ ${it.end}` : ""}${it.time ? ` ${it.time}` : ""}`);
		else menu.row("날짜", `${month}월 중`);
		if (it.movedTo) menu.row("보낸 곳", /Desk Calendar|^\d{4}-\d{2}$/.test(it.movedTo) ? "Desk Calendar" : it.movedTo);
		const goal = getField(l.line, "goal");
		if (goal) menu.row("목표", goal, () => void this.plugin.openPinboardGoal(goal));
		const project = getField(l.line, "project");
		if (project) menu.row("프로젝트", project, () => void this.plugin.openProjectAt(project));
		menu.row("이유", getField(l.line, "why"));
		menu.row("출처", getField(l.line, "from"));
		if (it.problems.length) menu.row("형식 확인", it.problems.join(" · "));
		const canEdit = this.editable(month);
		const now = new Date();
		const isCurrent = this.year === now.getFullYear() && month === now.getMonth() + 1;
		if (canEdit && it.kind === "task" && (it.status === "scheduled" || it.status === "done")) {
			menu.addItem((m) =>
				m
					.setTitle(it.status === "done" ? "완료 취소" : "완료")
					.setIcon("check")
					.onClick(() => void this.toggleProjectAware(month, target)),
			);
		}
		if (canEdit && it.ok && !projectRef(l.line)) {
			const other: Side = this.sides.get(l.index) === "회사" ? "개인" : "회사";
			menu.addItem((m) => m.setTitle(`${other} 일로`).setIcon("arrow-left-right").onClick(() => void this.apply(`「${it.text}」 → ${other} 일`, (data) => setWallSide(data, this.year, target, other))));
		}
		if (canEdit && isCurrent && it.status === "scheduled" && it.ok) {
			menu.addItem((m) => m.setTitle("Desk Calendar로 보내기").setIcon("arrow-right").onClick(() => void this.sendToDesk(month, l, target)));
		}
		if (canEdit && it.ok && it.status !== "moved") {
			menu.addItem((m) =>
				m
					.setTitle("다른 달로 옮기기…")
					.setIcon("calendar-range")
					.onClick(async () => {
						const to = await new MonthPickerModal(this.app, {
							title: `${it.text} → 몇 월로?`,
							year: this.year,
							disabled: (mm) => mm === month || !this.editable(mm),
						}).ask();
						if (to) await this.moveItem({ ...target }, to);
					}),
			);
		}
		if (canEdit && it.status === "scheduled" && it.kind === "task") {
			menu.addItem((m) =>
				m
					.setTitle("놓아주기 (취소)…")
					.setIcon("x")
					.setSection("danger")
					.onClick(async () => {
						const why = await new TextPromptModal(this.app, {
							title: "놓아주는 이유",
							desc: `「${it.text}」을(를) 하지 않기로 해요. 이유를 한 줄로 남겨요.`,
							placeholder: "예: 지금 목표와 관계없음",
							cta: "놓아주기",
						}).ask();
						if (why === null) return;
						await this.apply(`${this.ym(month)} 할 일 놓아줌: ${it.text}`, (d) => cancelWallTask(d, this.year, target, why));
					}),
			);
		}
		if (canEdit && it.status === "scheduled" && it.kind === "event") {
			menu.addItem((m) =>
				m
					.setTitle("행사 취소 (취소선)")
					.setIcon("x")
					.setSection("danger")
					.onClick(() => void this.apply(`${this.ym(month)} 행사 취소: ${it.text}`, (d) => cancelWallEvent(d, this.year, target))),
			);
		}
		if (canEdit && it.kind !== null) {
			menu.addSeparator();
			menu.addItem((m) => m.setTitle("수정…").setIcon("pencil").onClick(() => void this.editItem(month, l, target)));
			menu.addItem((m) =>
				m
					.setTitle("삭제…")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => void this.deleteItem(month, l, target)),
			);
		}
		menu.addSeparator();
		menu.addItem((m) =>
			m
				.setTitle("파일에서 보기")
				.setIcon("file-text")
				.onClick(() => {
					const f = this.file(this.yearPath());
					if (!f) return;
					void this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f, { eState: { line: l.index } });
				}),
		);
		if (!canEdit) menu.sub = "지난 달은 기록으로 남겨요 (읽기 전용)";
		menu.show(anchor);
	}

	// ── edit / delete ──

	private async editItem(month: number, l: WallLine, target: WallTarget): Promise<void> {
		const it = l.item;
		const body = l.line.replace(/^\s*[-*+]\s+/, "");
		const months: [string, string][] = [];
		for (let m = 1; m <= 12; m++) if (this.editable(m)) months.push([String(m), `${m}월`]);
		const hasWhy = it.status === "cancelled" || !!getField(body, "why");
		const oldDate = splitWallBody(body).date.trim();
		const v = await askForm(this.app, {
			title: `${KIND_LABEL[it.kind ?? "note"] ?? "항목"} 수정`,
			desc: "날짜나 달을 바꾸면 그 자리로 옮겨요.",
			fields: [
				{ key: "text", label: "내용", type: "text", value: contentText(body, WALL_DATE_RE) },
				...(it.kind !== "note"
					? [{ key: "date", label: "날짜", type: "text" as const, value: oldDate, desc: "비우면 ‘이달 중’", placeholder: `${pad2(month)}/DD` }]
					: []),
				{ key: "month", label: "달", type: "select", value: String(month), options: months },
				{ key: "goal", label: "목표", type: "text", value: getField(body, "goal"), placeholder: "연결할 목표 (선택)" },
				{ key: "project", label: "프로젝트", type: "text", value: getField(body, "project"), placeholder: "연결할 프로젝트 (선택)" },
				...(hasWhy ? [{ key: "why", label: "이유", type: "text" as const, value: getField(body, "why") }] : []),
			],
			validate: (x) => {
				const out: string[] = [];
				if (!x.text) out.push("내용을 적어 주세요.");
				// An unchanged date follows a new month by itself (same day), like 「다른 달로 옮기기」.
				if (x.date && x.date !== oldDate) {
					const n = normalizeDateInput(x.date, this.year, +x.month);
					if (!n.ok) out.push(n.reason);
				}
				if (hasWhy && it.status === "cancelled" && it.kind === "task" && !x.why) out.push("놓아준 할 일에는 이유가 있어야 해요.");
				return out;
			},
		});
		if (!v) return;
		const toMonth = +v.month;
		let date: string | undefined;
		if (it.kind !== "note" && v.date !== oldDate) {
			if (v.date) {
				const n = normalizeDateInput(v.date, this.year, toMonth);
				if (!n.ok) return void new Notice(n.reason);
				date = n.date;
			} else date = "";
		}
		const fields: Record<string, string> = { goal: v.goal, project: v.project };
		if (hasWhy) fields.why = v.why;
		const what = `${this.ym(month)}${toMonth !== month ? ` → ${this.ym(toMonth)}` : ""} 수정: ${it.text}${v.text !== it.text ? ` → ${v.text}` : ""}`;
		const res = editWallItem(this.text ?? "", this.year, target, { text: v.text, date, month: toMonth, fields });
		if (!res.ok && res.reason === "need-date") {
			new Notice(`${toMonth}월에는 같은 날이 없어요. 날짜를 새로 적어 주세요.`);
			return;
		}
		await this.apply(what, (d) => editWallItem(d, this.year, target, { text: v.text, date, month: toMonth, fields }));
	}

	private async deleteItem(month: number, l: WallLine, target: WallTarget): Promise<void> {
		const it = l.item;
		const notes: string[] = [];
		if (it.movedTo) notes.push(`이 줄은 ${it.movedTo}(으)로 보낸 기록이에요. 보낸 곳에 옮겨 적은 줄은 지우지 않고 그대로 남아요.`);
		if (it.goal) notes.push(`목표 ${it.goal}에 연결된 줄이에요. 목표 노트는 바꾸지 않아요.`);
		const task = it.kind === "task" && it.status === "scheduled";
		const event = it.kind === "event" && it.status === "scheduled";
		const ans = await confirmDelete(this.app, {
			title: `${KIND_LABEL[it.kind ?? "note"] ?? "항목"} 삭제`,
			removes: [`${this.yearPath()} · ${this.ym(month)}`, l.line.trim()],
			notes,
			footer: "잘못 넣은 줄, 중복, 테스트 데이터를 지울 때 써요.",
			alt: task
				? { label: "놓아주기 (기록 남김)", desc: "하지 않기로 한 일이면 지우지 말고 이유와 함께 놓아주기로 남길 수 있어요." }
				: event
					? { label: "행사 취소 (취소선)", desc: "취소된 행사면 지우지 말고 취소 표시로 남길 수 있어요." }
					: undefined,
		});
		if (ans === "delete") {
			await this.apply(`${this.ym(month)} 삭제: ${l.line.trim()}`, (d) => deleteWallItem(d, this.year, target));
		} else if (ans === "alt" && task) {
			const why = await new TextPromptModal(this.app, { title: "놓아주는 이유", desc: `「${it.text}」을(를) 하지 않기로 해요. 이유를 한 줄로 남겨요.`, placeholder: "예: 지금 목표와 관계없음", cta: "놓아주기" }).ask();
			if (why === null) return;
			await this.apply(`${this.ym(month)} 할 일 놓아줌: ${it.text}`, (d) => cancelWallTask(d, this.year, target, why));
		} else if (ans === "alt" && event) {
			await this.apply(`${this.ym(month)} 행사 취소: ${it.text}`, (d) => cancelWallEvent(d, this.year, target));
		}
	}

	// ── add form ──

	private renderAddForm(body: HTMLElement, month: number): void {
		const form = body.createEl("form", { cls: "wc-addform" });
		let kind: NewKind = "task";
		const kinds = form.createDiv({ cls: "wc-kinds", attr: { role: "radiogroup" } });
		const btns: Record<NewKind, HTMLButtonElement> = {} as Record<NewKind, HTMLButtonElement>;
		const row = form.createDiv({ cls: "wc-addrow" });
		const date = row.createEl("input", { cls: "wc-addate", attr: { type: "text", placeholder: `${pad2(month)}/DD`, "aria-label": "날짜 (MM/DD, 비우면 이달 중)", inputmode: "numeric" } });
		tip(date, "비우면 ‘이달 중’ · 기간은 10/15~10/17 · 시각은 10/15 14:00");
		const text = row.createEl("input", { cls: "wc-addtext", attr: { type: "text", placeholder: "내용", "aria-label": "내용" } });
		const setKind = (k: NewKind) => {
			kind = k;
			for (const [kk, b] of Object.entries(btns)) {
				b.toggleClass("is-active", kk === k);
				b.setAttr("aria-checked", kk === k ? "true" : "false");
			}
			date.toggle(k !== "note");
		};
		for (const k of ["task", "event", "note"] as NewKind[]) {
			const b = kinds.createEl("button", { cls: `wc-kind k-${k}`, attr: { type: "button", role: "radio" } });
			b.createSpan({ cls: "wc-sym" });
			b.createSpan({ text: KIND_LABEL[k] });
			b.addEventListener("click", () => setKind(k));
			btns[k] = b;
		}
		setKind("task");
		// 개인 / 회사: the mode's side by default (전체 → 개인), changeable here.
		let side: Side = inputSide(this.plugin.settings.sideMode);
		const sideSeg = kinds.createDiv({ cls: "mylogs-side-switch wc-addside", attr: { role: "radiogroup", "aria-label": "개인 / 회사" } });
		const sideBtns = (["개인", "회사"] as Side[]).map((x) => {
			const b = sideSeg.createEl("button", { cls: "mylogs-side-btn", text: x, attr: { type: "button", role: "radio", "data-side": x } });
			b.addEventListener("click", () => {
				side = x;
				for (const o of sideBtns) o.toggleClass("is-active", o.dataset.side === x);
			});
			b.toggleClass("is-active", x === side);
			return b;
		});
		const actions = form.createDiv({ cls: "wc-addactions" });
		const cancel = actions.createEl("button", { text: "닫기", attr: { type: "button" } });
		cancel.addEventListener("click", () => {
			this.addOpen = null;
			this.render();
		});
		actions.createEl("button", { cls: "mod-cta", text: "추가", attr: { type: "submit" } });
		const close = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				this.addOpen = null;
				this.render();
			}
		};
		date.addEventListener("keydown", close);
		text.addEventListener("keydown", close);
		form.addEventListener("submit", (e) => {
			e.preventDefault();
			const t = text.value.trim();
			if (!t) {
				text.focus();
				return;
			}
			let d = "";
			if (kind !== "note" && date.value.trim()) {
				const n = normalizeDateInput(date.value, this.year, month);
				if (!n.ok) {
					new Notice(n.reason);
					date.focus();
					return;
				}
				d = n.date;
			}
			const line = setSide(formatNewLine({ kind, date: d, text: t }), side);
			this.addOpen = null;
			void this.apply(`${this.ym(month)}에 ${KIND_LABEL[kind]} 추가: ${t}`, (data) => insertIntoMonth(data, this.year, month, line));
		});
		window.setTimeout(() => text.focus(), 0);
	}

	private async toggleProjectAware(month: number, target: WallTarget): Promise<void> {
  if(this.busy)return; this.busy=true;let handled=false;
  try{handled=await toggleLinkedProjectTask(this.plugin,this.yearPath(),target.index,target.line,todayIso());}
  catch(e){handled=true;new Notice(e instanceof Error?e.message:String(e));}
  finally{this.busy=false;}
  if(handled)await this.reload();else await this.apply(`${this.ym(month)} 할 일 완료 표시`,d=>toggleWallTask(d,this.year,target));
 }

	// ── edits ──

	/**
	 * Apply one edit to the year file atomically (also bumps its frontmatter `updated`), then
	 * log it in the index. Returns false (and tells the user) when the line moved away.
	 */
	private async apply(what: string, fn: (data: string) => EditResult): Promise<boolean> {
		const f = this.file(this.yearPath());
		if (!f) {
			new Notice(`${this.yearPath()} 파일이 없어요.`);
			return false;
		}
		if (this.busy) return false;
		this.busy = true;
		let res: EditResult = { ok: false, reason: "not-run" };
		try {
			await this.app.vault.process(f, (data) => {
				res = fn(data);
				return res.ok ? setFrontmatterScalar(res.text, "updated", todayIso()) : data;
			});
		} catch (err) {
			console.error("[MyLogs] Wall Calendar edit failed", err);
			new Notice("MyLogs: Wall Calendar를 저장하지 못했어요.");
			this.busy = false;
			return false;
		}
		this.busy = false;
		const r = res as EditResult;
		if (!r.ok) {
			new Notice(this.reasonText(r.reason));
			await this.reload();
			return false;
		}
		await this.logIndex(what);
		await this.reload();
		return true;
	}

	private reasonText(reason: string): string {
		switch (reason) {
			case "not-found":
				return "이 줄을 찾지 못했어요. 파일이 바뀌어서 다시 불러왔어요.";
			case "no-month":
				return "이 달의 ## YYYY-MM 제목이 파일에 없어요.";
			case "not-toggleable":
			case "not-cancellable":
			case "not-scheduled":
				return "이 항목은 지금 상태에서 바꿀 수 없어요.";
			case "need-date":
				return "그 달에는 같은 날이 없어요. 날짜를 새로 적어 주세요.";
			case "empty-text":
				return "내용이 비어 있어요.";
			default:
				return `바꾸지 못했어요 (${reason}).`;
		}
	}

	private async logIndex(what: string): Promise<void> {
		const f = this.file(this.indexPath());
		if (!f) {
			console.warn(`[MyLogs] ${this.indexPath()} not found; index not updated.`);
			return;
		}
		try {
			await this.app.vault.process(f, (d) => addIndexChange(d, todayIso(), what));
		} catch (err) {
			console.error("[MyLogs] index update failed", err);
			new Notice("MyLogs: Wall Calendar Index.md를 갱신하지 못했어요.");
		}
	}

	private async moveItem(t: WallTarget, toMonth: number): Promise<void> {
		const text = this.text;
		if (text === null) return;
		const label = parseWallYear(text, this.year).months[t.month - 1].lines.find((l) => l.line === t.line)?.item.text ?? t.line;
		const what = `${this.ym(t.month)} → ${this.ym(toMonth)} 옮김: ${label}`;
		// Dry run to see whether a new date is needed.
		const dry = moveWallItem(text, this.year, t, toMonth);
		let newDate: string | undefined;
		if (!dry.ok && dry.reason === "need-date") {
			const ans = await new TextPromptModal(this.app, {
				title: `${toMonth}월의 새 날짜`,
				desc: `${toMonth}월에는 같은 날이 없어요. 새 날짜를 MM/DD로 적거나, 비워 두면 ‘이달 중’으로 옮겨요.`,
				placeholder: `${pad2(toMonth)}/DD`,
				cta: "옮기기",
				allowEmpty: true,
			}).ask();
			if (ans === null) return;
			if (ans) {
				const n = normalizeDateInput(ans, this.year, toMonth);
				if (!n.ok) {
					new Notice(n.reason);
					return;
				}
				newDate = n.date;
			} else newDate = "";
		}
		await this.apply(what, (d) => moveWallItem(d, this.year, t, toMonth, newDate));
	}

	private async sendToDesk(month: number, l: WallLine, t: WallTarget): Promise<void> {
		const deskFolder = this.plugin.settings.deskCalendarFolder;
		const link = deskLink(deskFolder, this.year, month);
		const deskFile = this.file(normalizePath(`${link}.md`));
		if (!deskFile) {
			new Notice(`${link}.md 파일이 없어요. Desk Calendar 달 파일을 먼저 만들어 주세요.`);
			return;
		}
		const it = l.item;
		const deskLine = deskLineFor(l.line.replace(/^\s*[-*+]\s+/, ""), it);
		const day = it.start && it.start.slice(0, 7) === this.ym(month) ? it.start : null;
		// Dry runs on the current texts so we never write half of the move.
		const deskNow = await this.app.vault.read(deskFile);
		const dryDesk = insertIntoDesk(deskNow, deskLine, day);
		if (!dryDesk.ok) {
			new Notice(dryDesk.reason === "no-day" ? `Desk Calendar에 ### ${day} 제목이 없어요.` : "Desk Calendar에 ## 이달 중 섹션이 없어요.");
			return;
		}
		if (this.text === null || !markSentToDesk(this.text, this.year, t, link).ok) {
			new Notice(this.reasonText("not-found"));
			await this.reload();
			return;
		}
		let deskOk = false;
		try {
			await this.app.vault.process(deskFile, (d) => {
				const r = insertIntoDesk(d, deskLine, day);
				deskOk = r.ok;
				return r.ok ? setFrontmatterScalar(r.text, "updated", todayIso()) : d;
			});
		} catch (err) {
			console.error("[MyLogs] Desk Calendar insert failed", err);
		}
		if (!deskOk) {
			new Notice("Desk Calendar에 넣지 못했어요.");
			return;
		}
		const ok = await this.apply(`${this.ym(month)} Desk Calendar로 보냄: ${it.text}`, (d) => markSentToDesk(d, this.year, t, link));
		if (ok) new Notice(`Desk Calendar ${this.ym(month)}에 넣었어요.`);
		else new Notice(`Desk Calendar에는 넣었지만 Wall Calendar 줄을 바꾸지 못했어요. ${this.yearPath()}을 확인해 주세요.`);
		// TODO(MyLogs Plugin 계획.md 「기본 방침」 5): Desk Calendar Index.md update (Desk Calendar view's job).
	}

	private async createYearFile(): Promise<void> {
		const path = this.yearPath();
		if (this.file(path)) return;
		try {
			const dir = normalizePath(this.folder());
			if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
			await this.app.vault.create(path, wallYearSkeleton(this.year, todayIso()));
		} catch (err) {
			console.error("[MyLogs] create year file failed", err);
			new Notice(`MyLogs: 파일을 만들지 못했어요 (${path})`);
			return;
		}
		await this.logIndex(`${this.year}.md 만듦`);
		await this.reload();
	}
}
