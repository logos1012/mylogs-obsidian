import { toggleLinkedProjectTask } from "../projects/task-actions.ts";
import { mountAppNav } from "../ui/nav.ts";
import { parseWallYear, type WallLine } from "../wall/parse.ts";
import { deskLineFor, deskLink, insertIntoDesk, markSentToDesk, type WallTarget } from "../wall/edit.ts";
import { commitBatch } from "../pinboard/batch.ts";
import { setFrontmatterScalar } from "../writer.ts";
import { vaultIO } from "../pinboard/create-actions.ts";
import { actionSheet } from "../ui/mobile.ts";
import { ItemPopover } from "../ui/popover.ts";
import { tip } from "../ui/tip.ts";
import { scheduleTarget } from "../projects/schedule-dnd.ts";
import { ItemView, Keymap, moment, normalizePath, Notice, Platform, setIcon, type TAbstractFile, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { loadMilestoneCalendar, renderMilestoneMarkers, renderMilestoneIssues, watchesMilestoneProjects, type MilestoneCalendar } from "../projects/milestone-calendar-ui.ts";
import { addDays } from "../parser.ts";
import {
	allocFileOf,
	type DayIndex,
	dayIndex,
	type DeskItem,
	type DeskWeek,
	findPairAlloc,
	isoWeekNo,
	type MonthData,
	parseMonthFile,
	parseMonthKey,
	resolveAlloc,
	resolveDuring,
	shiftMonth,
	summarizeMonth,
	todayIsoLocal,
	type WeekAllocIndex,
	weekAllocIndex,
	weekAllocStats,
	weekdayMon0,
	weekMondays,
} from "./model.ts";
import { createDeskMonth, deskMonthPath, logDeskChange } from "./actions.ts";
import { type DeskMobileHost, renderDeskMobile } from "./mobile.ts";
import { runDeskTarget } from "./mobile-targets.ts";
import { askThirdMove, pickDate, pickMonth, promptText } from "./modals.ts";
import { askForm, confirmDelete } from "../ui/modals.ts";
import { askWhen } from "../drawer/modals.ts";
import { contentText, getField, normalizeTime, splitContent, TIME_LEAD_RE } from "../line-edit.ts";
import {
	movedCount,
	pairedCopies,
	type Plan,
	planAssignDay,
	planAssignWeek,
	planCancelEvent,
	planDelete,
	planDrawer,
	planEdit,
	planFuture,
	planLetGo,
	planMoveDay,
	planSplit,
	planToggle,
	planUnassign,
	runPlan,
} from "./ops.ts";

export const VIEW_TYPE_DESK_CALENDAR = "mylogs-desk-calendar";
const CHANGED_NOTICE = "파일이 바뀌었어요. 다시 그렸어요";

const FIELD_LABEL: Record<string, string> = { project: "프로젝트", from: "출처", why: "이유", moved: "미룸" };
const STATUS_LABEL: Record<string, string> = { scheduled: "예정", done: "완료", moved: "옮김", cancelled: "취소" };
const KIND_LABEL: Record<string, string> = { event: "행사", task: "할 일", note: "메모" };

type Drag = { kind: "during" | "alloc" | "day"; item: DeskItem };

interface DropZone {
	el: HTMLElement;
	accepts: (d: Drag) => boolean;
	drop: (d: Drag) => void;
}

interface Ctx {
	cur: MonthData | null;
	months: MonthData[];
	didx: DayIndex;
	widx: WeekAllocIndex;
	today: string;
}

/** Where a week's 이번 주 box lives (possibly the previous month's file). */
function allocWeek(ctx: Ctx, monday: string): DeskWeek | null {
	const key = allocFileOf(monday);
	const data = ctx.months.find((m) => m.key === key);
	const w = data?.weeks.get(monday);
	return w && w.alloc !== null ? w : null;
}

function dayExists(ctx: Ctx, iso: string): boolean {
	const data = ctx.months.find((m) => m.key === iso.slice(0, 7));
	return !!data?.days.has(iso);
}

function isOpenTask(it: DeskItem): boolean {
	return it.item.kind === "task" && it.item.status === "scheduled";
}

function isKo(): boolean {
	return moment.locale().startsWith("ko");
}

export class DeskCalendarView extends ItemView {
	plugin: MyLogsPlugin;
	month: string;
	private rootEl!: HTMLElement;
	private months = new Map<string, MonthData>();
	private ctx: Ctx | null = null;
	private zones: DropZone[] = [];
	private drag: Drag | null = null;
	/** This month's Wall Calendar year file (its open lines can be dragged into the month). */
	private wallText: string | null = null;
	/** A Wall line being dragged onto a day or 이달 중. */
	private wallDrag: WallLine | null = null;
	private busy = false;
	private pendingReload = false;
	private reloadTimer: number | null = null;
	private loadSeq = 0;
	private milestones: MilestoneCalendar = { markers: [], issues: [] };

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.month = todayIsoLocal().slice(0, 7);
	}

	getViewType(): string {
		return VIEW_TYPE_DESK_CALENDAR;
	}

	getDisplayText(): string {
		return `Desk Calendar ${this.month}`;
	}

	getIcon(): string {
		return "calendar-days";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), month: this.month };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const m = (state as { month?: unknown } | null)?.month;
		if (typeof m === "string" && parseMonthKey(m)) {
			this.month = m;
			if (this.rootEl) await this.reload();
		}
		await super.setState(state, result);
	}

	// ── paths ──

	monthPath(key: string): string {
		return deskMonthPath(this.plugin, key);
	}

	private wallPath(year: number): string {
		const folder = this.plugin.settings.wallCalendarFolder || "02 Wall Calendar";
		return normalizePath(`${folder}/${year}.md`);
	}

	private fileAt(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	private watchedPaths(): string[] {
		return [...[-1, 0, 1].map((n) => this.monthPath(shiftMonth(this.month, n))), this.wallPath(+this.month.slice(0, 4))];
	}

	// ── lifecycle ──

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-desk-calendar-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-desk-calendar" });
		mountAppNav(this);
		const onFile = (f: TAbstractFile, old?: string) => {
			const paths = this.watchedPaths();
			if (paths.includes(f.path) || (old && paths.includes(old)) || watchesMilestoneProjects(this.plugin, f.path) || (old && watchesMilestoneProjects(this.plugin, old))) this.scheduleReload();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile(f, old)));
		await this.reload();
	}

	async onClose(): Promise<void> {
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
	}

	private scheduleReload(): void {
		if (this.drag || this.busy) {
			this.pendingReload = true;
			return;
		}
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
		this.reloadTimer = window.setTimeout(() => {
			this.reloadTimer = null;
			void this.reload();
		}, 250);
	}

	async goTo(month: string): Promise<void> {
		if (month === this.month) return;
		this.month = month;
		await this.reload();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
	}

	async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		const keys = [-1, 0, 1].map((n) => shiftMonth(this.month, n));
		const loaded = new Map<string, MonthData>();
		for (const key of keys) {
			const f = this.fileAt(this.monthPath(key));
			if (!f) continue;
			const text = await this.app.vault.read(f);
			const ym = parseMonthKey(key)!;
			loaded.set(key, parseMonthFile(text, ym.year, ym.month));
		}
		const milestones = await loadMilestoneCalendar(this.plugin);
		const wf = this.fileAt(this.wallPath(+this.month.slice(0, 4)));
		const wallText = wf ? await this.app.vault.read(wf) : null;
		if (seq !== this.loadSeq) return;
		this.milestones = milestones;
		this.months = loaded;
		this.wallText = wallText;
		this.render();
	}

	// ── rendering ──

	private render(): void {
		if (Platform.isMobile) return renderDeskMobile(this.mobileHost());
		const root = this.rootEl;
		const scrollTop = this.contentEl.scrollTop;
		root.empty();
		this.zones = [];
		const months = [...this.months.values()];
		const cur = this.months.get(this.month) ?? null;
		const ctx: Ctx = { cur, months, didx: dayIndex(months), widx: weekAllocIndex(months), today: todayIsoLocal() };
		this.ctx = ctx;

		this.renderHeader(root, ctx);
		if (!cur) {
			this.renderEmpty(root);
			return;
		}
		this.renderBands(root, cur, ctx);
		const summary = summarizeMonth(cur, ctx.didx);
		if (summary.counts.test && this.plugin.settings.showTestMarkers) {
			const bar = root.createDiv({ cls: "dc-testbar" });
			bar.createSpan({ cls: "dc-tst", text: "test" });
			bar.createSpan({ text: `이 달에는 화면 확인용 테스트 데이터(#test) ${summary.counts.test}줄이 있어요. 실제 일정을 넣을 때 지웁니다.` });
		}
		this.renderCalendar(root, cur, ctx);
		this.renderLegend(root);
		if (summary.issues.length) {
			const sec = root.createEl("section", { cls: "dc-fmt" });
			const h = sec.createEl("h2", { text: "형식 확인 필요 " });
			h.createSpan({ text: String(summary.issues.length) });
			sec.createEl("p", { text: "아래 줄은 해석하지 못해 글자 그대로 보여 주었어요. 달 파일에서 고치면 바로 반영됩니다." });
			const ul = sec.createEl("ul");
			for (const i of summary.issues) {
				const li = ul.createEl("li");
				const loc = li.createEl("a", { cls: "dc-loc", text: `${i.file}${i.line ? ":" + i.line : ""}`, href: "#" });
				loc.addEventListener("click", (e) => {
					e.preventDefault();
					void this.openAt(i.file, i.line ? i.line - 1 : 0, e);
				});
				li.createEl("code", { text: i.raw });
				li.createSpan({ cls: "dc-why", text: i.why });
			}
		}
		this.contentEl.scrollTop = scrollTop;
	}

	/** What the mobile layout (`./mobile.ts`) may use: the desktop cells, and the drop zones' calls. */
	private mobileHost(): DeskMobileHost {
		const ctx = (): Ctx => this.ctx!;
		const cur = (): MonthData => this.ctx!.cur!;
		return {
			app: this.app,
			contentEl: this.contentEl,
			rootEl: this.rootEl,
			month: this.month,
			begin: () => {
				this.rootEl.empty();
				this.zones = [];
				const months = [...this.months.values()];
				const c = this.months.get(this.month) ?? null;
				this.ctx = { cur: c, months, didx: dayIndex(months), widx: weekAllocIndex(months), today: todayIsoLocal() };
				return { cur: c, today: this.ctx.today };
			},
			goTo: (m) => this.goTo(m),
			renderHeader: (root) => this.renderHeader(root, ctx()),
			renderEmpty: (root) => this.renderEmpty(root),
			renderBands: (root) => this.renderBands(root, cur(), ctx()),
			renderDayCell: (row, iso) => this.renderDayCell(row, iso, cur(), ctx()),
			renderAllocCell: (row, monday) => this.renderAllocCell(row, monday, cur(), ctx()),
			dayItems: (iso) => ctx().months.find((m) => m.key === iso.slice(0, 7))?.days.get(iso) ?? [],
			allocItems: (monday) => allocWeek(ctx(), monday)?.alloc ?? [],
			weekSlots: () => weekMondays(cur().year, cur().month).map((monday) => ({ monday, no: isoWeekNo(monday), fileKey: allocFileOf(monday), hasAlloc: !!allocWeek(ctx(), monday) })),
			daySlots: () => weekMondays(cur().year, cur().month).flatMap((monday) => Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((iso) => ({ iso, exists: dayExists(ctx(), iso) }))),
			isOpenTask,
			// The same calls as the drop zones in renderAllocCell / renderDayCell.
			move: (t, it) =>
				runDeskTarget(t, it, {
					assignWeek: (x, monday, no, fileKey) => this.exec(planAssignWeek(x, monday, no, fileKey, ctx().today)),
					unassign: (x, monday, fileKey) => this.exec(planUnassign(x, findPairAlloc(x, ctx().months), monday, fileKey, ctx().today)),
					assignDay: (x, iso) => this.exec(planAssignDay(x, iso, ctx().today)),
					moveToDay: (x, iso) => this.moveToDay(x, iso),
				}),
			register: (cb) => this.register(cb),
			renderMilestones: (parent, from, to) => this.renderMilestoneRange(parent, from, to, true),
			milestoneDays: () => new Set(this.milestones.markers.map((m) => m.date)),
		};
	}

	private renderHeader(root: HTMLElement, ctx: Ctx): void {
		const top = root.createEl("header", { cls: "dc-top" });
		const title = top.createDiv({ cls: "dc-title" });
		title.createDiv({ cls: "dc-eyebrow", text: "Desk Calendar" });
		const m = moment(`${this.month}-01`, "YYYY-MM-DD");
		const h1 = title.createEl("h1");
		h1.createSpan({ cls: "dc-y", text: isKo() ? `${m.format("YYYY")}년` : m.format("YYYY") });
		h1.appendText(m.format("MMMM"));

		const right = top.createDiv({ cls: "dc-right" });
		const t = moment(ctx.today, "YYYY-MM-DD");
		const wk = `W${String(t.isoWeek()).padStart(2, "0")}`;
		right.createDiv({ cls: "dc-todaylbl", text: `오늘 ${isKo() ? t.format("MMMM D일 (dd)") : t.format("MMM D (dd)")} · ${wk}` });
		// 개수 표시는 쓰지 않음 (사용자 요청)
		const nav = right.createDiv({ cls: "dc-nav" });
		const btn = (label: string, aria: string, onClick: (e: MouseEvent) => void, icon?: string) => {
			const b = nav.createEl("button", { cls: "dc-btn", attr: { type: "button", "aria-label": aria } });
			if (icon) setIcon(b, icon);
			else b.setText(label);
			b.addEventListener("click", onClick);
			return b;
		};
		btn("◀", "이전 달", () => void this.goTo(shiftMonth(this.month, -1)));
		const now = btn("이번 달", "이번 달", () => void this.goTo(ctx.today.slice(0, 7)));
		now.toggleClass("is-active", this.month === ctx.today.slice(0, 7));
		btn("▶", "다음 달", () => void this.goTo(shiftMonth(this.month, 1)));
		const hide = this.plugin.settings.deskHideClosed;
		const hb = btn(hide ? "완료 숨김" : "모두 보기", "완료 · 옮김 · 놓아줌 항목 보이기/숨기기", () => {
			this.plugin.settings.deskHideClosed = !this.plugin.settings.deskHideClosed;
			void this.plugin.saveSettings();
			this.rootEl.toggleClass("dc-hide-closed", this.plugin.settings.deskHideClosed);
			this.render();
		}, hide ? "eye-off" : "eye");
		hb.addClass("dc-hide-toggle");
		hb.createSpan({ cls: "dc-hide-label", text: hide ? "완료 숨김" : "모두 보기" });
		hb.toggleClass("is-active", hide);
		tip(hb, hide ? "완료 · 옮김 · 놓아줌 항목을 숨겼어요. 누르면 모두 보여요." : "누르면 완료 · 옮김 · 놓아줌 항목을 숨겨요. 파일은 그대로예요.");
		btn("", "마크다운 파일 열기", (e) => void this.openAt(this.month, 0, e), "file-text");
		this.rootEl.toggleClass("dc-hide-closed", hide);
		renderMilestoneIssues(root, this.milestones.issues, path => void this.plugin.openProjectAt(path));
	}

	private renderLegend(root: HTMLElement): void {
		const lg = root.createDiv({ cls: "dc-legend" });
		const sym = (cls: string, label: string, strike = false) => {
			const s = lg.createSpan({ cls: `dc-lg dc-it ${cls}` });
			s.createSpan({ cls: "dc-sym" });
			s.createSpan({ cls: strike ? "dc-x" : "", text: label });
		};
		sym("dc-k-task dc-s-scheduled", "할 일");
		sym("dc-k-task dc-s-done", "완료");
		sym("dc-k-task dc-s-moved", "옮김 (→)");
		sym("dc-k-task dc-s-cancelled", "놓아줌", true);
		lg.createSpan({ cls: "dc-sep" });
		sym("dc-k-event", "행사");
		sym("dc-k-note", "메모");
		lg.createSpan({ cls: "ml-milestone-legend", text: "◆ 마일스톤 · 프로젝트의 목표일" });
		lg.createSpan({ cls: "dc-sep" });
		const a = lg.createSpan();
		a.createEl("b", { text: "→" });
		a.appendText("분배 칸에서 배정한 날짜·주");
		tip(lg, "끌어다 놓기: 이달 중 → 이번 주 할 일 → 날짜 칸 · 항목을 누르면 자세한 내용과 못 한 일 처리·수정·삭제");
	}

	private renderEmpty(root: HTMLElement): void {
		const card = root.createDiv({ cls: "dc-empty" });
		card.createDiv({ cls: "dc-empty-title", text: "이 달의 Desk Calendar 파일이 아직 없어요" });
		card.createEl("code", { text: this.monthPath(this.month) });
		const b = card.createEl("button", { cls: "dc-btn dc-btn-primary", text: `${this.month} 새 달 만들기`, attr: { type: "button" } });
		b.addEventListener("click", () => void createDeskMonth(this.plugin, this.month));
		this.renderMilestoneRange(card, `${this.month}-01`, `${this.month}-31`, true);
	}

	private renderMilestoneRange(parent: HTMLElement, from: string, to: string, showDate = false): void {
		renderMilestoneMarkers(parent, this.milestones.markers.filter(m => m.date >= from && m.date <= to), todayIsoLocal(), path => void this.plugin.openProjectAt(path), showDate, this.plugin);
	}

	private renderBands(root: HTMLElement, cur: MonthData, ctx: Ctx): void {
		const focus = root.createEl("section", { cls: "dc-band" });
		focus.createDiv({ cls: "dc-lbl", text: "이달의 초점" });
		const fl = focus.createEl("ul", { cls: "dc-focuslist" });
		if (!cur.focus.length) fl.createEl("li", { cls: "dc-focus dc-none", text: "이달의 초점이 아직 없어요" });
		for (const f of cur.focus) {
			const li = fl.createEl("li", { cls: "dc-focus" });
			li.createSpan({ cls: "dc-fid", text: "◎" });
			if (f.id) {
				li.addClass("is-link");
				tip(li, "목표 열기");
				li.addEventListener("click", () => this.openGoal(f.id));
			}
			li.createSpan({ cls: "dc-ftitle", text: f.title });
			if (f.note) li.createSpan({ cls: "dc-fnote", text: f.note });
			if (f.test && this.plugin.settings.showTestMarkers) this.testDot(li);
		}

		const during = root.createEl("section", { cls: "dc-band dc-during" });
		during.createDiv({ cls: "dc-lbl", text: "이달 중" });
		const ul = during.createEl("ul");
		if (!cur.during.length) ul.createEl("li", { cls: "dc-it dc-none", text: "없음" });
		for (const it of cur.during) this.renderDuringItem(ul, it, ctx);
		this.wallDropZone(during, null);
		this.renderWallItems(during);
		const markers = this.milestones.markers.filter(m => m.date.startsWith(this.month + "-"));
		if (markers.length) {
			const list = root.createEl("details", { cls: "dc-milestone-month" });
			list.createEl("summary", { text: `◆ 이달의 마일스톤 ${markers.length}` });
			renderMilestoneMarkers(list, markers, ctx.today, path => void this.plugin.openProjectAt(path), true);
		}
	}

	private renderCalendar(root: HTMLElement, cur: MonthData, ctx: Ctx): void {
		const cal = root.createDiv({ cls: "dc-cal" });
		const cols = cal.createDiv({ cls: "dc-cols", attr: { "aria-hidden": "true" } });
		cols.createDiv({ cls: "dc-c-alloc", text: "이번 주 할 일" });
		for (let i = 0; i < 7; i++) {
			cols.createDiv({ cls: i === 5 ? "dc-c5" : i === 6 ? "dc-c6" : "", text: moment().isoWeekday(i + 1).format("dd") });
		}
		for (const monday of weekMondays(cur.year, cur.month)) {
			const sunday = addDays(monday, 6);
			const row = cal.createEl("section", { cls: "dc-week" });
			if (monday <= ctx.today && ctx.today <= sunday) row.addClass("dc-now");
			this.renderAllocCell(row, monday, cur, ctx);
			for (let i = 0; i < 7; i++) this.renderDayCell(row, addDays(monday, i), cur, ctx);
		}
	}

	private renderAllocCell(row: HTMLElement, monday: string, cur: MonthData, ctx: Ctx): void {
		const cell = row.createDiv({ cls: "dc-cell dc-alloc" });
		const no = moment(monday, "YYYY-MM-DD").isoWeek();
		const head = cell.createDiv({ cls: "dc-wk-head" });
		head.createSpan({ cls: "dc-wk-no", text: `W${String(no).padStart(2, "0")}` });
		const sun = addDays(monday, 6);
		head.createSpan({ cls: "dc-wk-range", text: `${+monday.slice(5, 7)}/${+monday.slice(8, 10)} – ${+sun.slice(5, 7)}/${+sun.slice(8, 10)}` });

		const fileKey = allocFileOf(monday);
		const elsewhere = fileKey !== cur.key;
		const week = allocWeek(ctx, monday);
		const label = cell.createDiv({ cls: "dc-wk-label", text: "이번 주 할 일" });

		if (elsewhere) {
			cell.addClass("dc-elsewhere");
			const link = cur.weeks.get(monday)?.allocLink ?? fileKey;
			const p = parseMonthKey(link);
			const where = p ? (isKo() ? `${p.month}월 파일` : link) : link;
			if (!week) {
				tip(cell.createEl("p", { cls: "dc-away", text: "앞 달에서 정리한 주" }), `이 주의 ‘이번 주 할 일’은 ${where}에 있어요`);
				return;
			}
			tip(label, `이 주의 ‘이번 주 할 일’은 ${where}에 있어요`);
		}
		if (!week) {
			cell.createEl("p", { cls: "dc-away", text: "이번 주 칸 없음" });
			return;
		}
		this.addZone(cell, {
			accepts: (d) =>
				(d.kind === "during" && isOpenTask(d.item) && !d.item.item.assignWeek.includes(no)) ||
				(d.kind === "day" && isOpenTask(d.item) && d.item.monday === monday),
			drop: (d) => {
				if (d.kind === "during") void this.exec(planAssignWeek(d.item, monday, no, fileKey, ctx.today));
				else void this.exec(planUnassign(d.item, findPairAlloc(d.item, ctx.months), monday, fileKey, ctx.today));
			},
		});
		const alloc = week.alloc ?? [];
		if (!alloc.length) {
			cell.createEl("p", { cls: "dc-empty-note", text: "아직 적은 일이 없어요" });
			return;
		}
		const [, un] = weekAllocStats(week);
		if (un) label.createSpan({ cls: "dc-badge dc-warn", text: `미배정 ${un}` });
		else label.createSpan({ cls: "dc-badge dc-ok", text: "✓ 모두 배정" });
		const ul = cell.createEl("ul", { cls: "dc-items" });
		for (const it of alloc) this.renderAllocItem(ul, it, ctx);
	}

	private renderDayCell(row: HTMLElement, iso: string, cur: MonthData, ctx: Ctx): void {
		const wd = weekdayMon0(iso);
		const cell = row.createDiv({ cls: `dc-cell dc-day dc-wd${wd}` });
		scheduleTarget(cell, this.plugin, {kind:"day",date:iso}, () => this.reload());
		cell.setAttr("tabindex", "0"); cell.setAttr("aria-label", `${iso} 날짜 칸`);
		const inMonth = iso.slice(0, 7) === cur.key;
		const data = ctx.months.find((m) => m.key === iso.slice(0, 7));
		const items = data?.days.get(iso) ?? [];
		if (!inMonth) cell.addClass("dc-out");
		if (iso === ctx.today) cell.addClass("dc-today");
		else if (iso < ctx.today) cell.addClass("dc-past");
		if (!items.length && !this.milestones.markers.some(m => m.date === iso)) cell.addClass("dc-blank");
		const head = cell.createDiv({ cls: "dc-dhead" });
		const m = moment(iso, "YYYY-MM-DD");
		head.createSpan({ cls: "dc-dnum", text: String(m.date()) });
		head.createSpan({ cls: "dc-dwd", text: m.format("dd") });
		if (iso === ctx.today) head.createSpan({ cls: "dc-todaytag", text: "오늘" });
		this.renderMilestoneRange(cell, iso, iso);
		if (items.length) {
			const ul = cell.createEl("ul", { cls: "dc-items" });
			for (const it of items) this.renderDayItem(ul, it, ctx);
		}
		if (!dayExists(ctx, iso)) return;
		if (inMonth) this.wallDropZone(cell, iso);
		const monday = addDays(iso, -wd);
		this.addZone(cell, {
			accepts: (d) =>
				(d.kind === "alloc" && isOpenTask(d.item) && d.item.monday === monday && !d.item.assign.includes(iso)) ||
				(d.kind === "day" && isOpenTask(d.item) && d.item.date !== iso),
			drop: (d) => {
				if (d.kind === "alloc") void this.exec(planAssignDay(d.item, iso, ctx.today));
				else void this.moveToDay(d.item, iso);
			},
		});
	}

	// ── items ──

	private itemShell(ul: HTMLElement, it: DeskItem, stateCls: string, extra = ""): { li: HTMLElement; body: HTMLElement; meta: HTMLElement } {
		const kind = it.item.kind ?? "note";
		const li = ul.createEl("li", { cls: `dc-it dc-k-${kind} dc-s-${stateCls}${extra}` });
		if (it.item.kind === null) li.addClass("dc-raw");
		li.createSpan({ cls: "dc-sym", attr: { "aria-hidden": "true" } });
		const body = li.createSpan({ cls: "dc-body" });
		const meta = createSpan({ cls: "dc-meta" });
		return { li, body, meta };
	}

	private finishMeta(body: HTMLElement, meta: HTMLElement, it: DeskItem, warn: string | null): void {
		for (const t of it.item.tags) meta.createSpan({ cls: "dc-tag", text: `#${t}` });
		if (it.item.test && this.plugin.settings.showTestMarkers) this.testDot(meta);
		if (warn) tip(meta.createSpan({ cls: "dc-warnmark", text: "?" }), warn);
		if (meta.childElementCount) body.appendChild(meta);
	}

	private testDot(parent: HTMLElement): void {
		parent.createSpan({ cls: "dc-tdot", attr: { title: "#test 테스트 데이터" } });
	}

	private renderDuringItem(ul: HTMLElement, it: DeskItem, ctx: Ctx): void {
		if (it.item.kind === null) return this.renderRaw(ul, it);
		const res = resolveDuring(it, ctx.widx, ctx.didx);
		const { li, body, meta } = this.itemShell(ul, it, res.state, " dc-ai");
		body.createSpan({ cls: "dc-txt", text: it.item.text });
		if (it.item.assignWeek.length) {
			const to = body.createSpan({ cls: "dc-to", text: "→ " });
			for (const [no, x] of res.targets) {
				const chip = to.createSpan({ cls: "dc-dt", text: `W${String(no).padStart(2, "0")}` });
				if (!x) chip.addClass("dc-miss");
				else if (resolveAlloc(x, ctx.didx).state === "done") chip.addClass("dc-ok");
			}
		} else if (res.state === "unassigned") {
			body.createSpan({ cls: "dc-to" }).createSpan({ cls: "dc-dt dc-un", text: "미배정" });
		}
		const warn = res.missing.length ? "배정한 주의 이번 주 할 일에 같은 항목이 없어요" : it.problems.length ? it.problems.join(" · ") : null;
		this.finishMeta(body, meta, it, warn);
		this.decorate(li, it, "during", `${STATUS_LABEL[it.item.status]} · 이번 주 할 일 칸으로 끌어 주에 배정`);
	}

	private renderAllocItem(ul: HTMLElement, it: DeskItem, ctx: Ctx): void {
		if (it.item.kind === null) return this.renderRaw(ul, it);
		const res = resolveAlloc(it, ctx.didx);
		const { li, body, meta } = this.itemShell(ul, it, res.state, " dc-ai");
		body.createSpan({ cls: "dc-txt", text: it.item.text });
		if (it.assign.length) {
			const to = body.createSpan({ cls: "dc-to", text: "→ " });
			for (const [d, x] of res.targets) {
				const chip = to.createSpan({ cls: "dc-dt", text: `${+d.slice(5, 7)}/${+d.slice(8, 10)}` });
				if (!x) chip.addClass("dc-miss");
				else if (x.item.status === "done") chip.addClass("dc-ok");
				else if (x.item.status === "moved" || x.item.status === "cancelled") chip.addClass("dc-off");
			}
		} else if (res.state === "unassigned") {
			body.createSpan({ cls: "dc-to" }).createSpan({ cls: "dc-dt dc-un", text: "미배정" });
		}
		const warn = res.missing.length ? "배정한 날짜 칸에 같은 항목이 없어요" : it.problems.length ? it.problems.join(" · ") : null;
		this.finishMeta(body, meta, it, warn);
		this.decorate(li, it, "alloc", "날짜 칸으로 끌어 배정");
	}

	private renderDayItem(ul: HTMLElement, it: DeskItem, ctx: Ctx): void {
		if (it.item.kind === null) return this.renderRaw(ul, it);
		const { li, body, meta } = this.itemShell(ul, it, it.item.status);
		if (it.item.time) body.createSpan({ cls: "dc-tm", text: it.item.time });
		body.createSpan({ cls: "dc-txt", text: it.item.text });
		this.finishMeta(body, meta, it, it.problems.length ? it.problems.join(" · ") : null);

		const toggleable = it.item.kind === "task" && (it.item.status === "scheduled" || it.item.status === "done");
		if (toggleable) {
			const sym = li.querySelector(".dc-sym") as HTMLElement;
			sym.addClass("is-clickable");
			sym.setAttrs({ role: "checkbox", tabindex: "0", "aria-checked": String(it.item.status === "done"), "aria-label": `${it.item.text} 완료 표시` });
			const toggle = (e: Event) => {
				e.preventDefault();
				e.stopPropagation();
				li.addClass("is-pending");
				void this.toggleProjectAware(it, ctx.today);
			};
			sym.addEventListener("click", toggle);
			sym.addEventListener("keydown", (e) => {
				if (e.key === " " || e.key === "Enter") toggle(e);
			});
		}
		this.decorate(li, it, "day", isOpenTask(it) ? "다른 날로 끌어 옮기기 · 이번 주 할 일 칸으로 끌어 배정 취소" : "");
	}

	private renderRaw(ul: HTMLElement, it: DeskItem): void {
		const li = ul.createEl("li", { cls: "dc-it dc-raw" });
		li.createSpan({ cls: "dc-txt", text: it.line.trim() });
		tip(li.createSpan({ cls: "dc-warnmark", text: "?" }), it.problems.join(" · ") || "형식 확인 필요");
	}

	/** Drag source + item menu (⋯ button and right-click). */
	private decorate(li: HTMLElement, it: DeskItem, kind: Drag["kind"], hint: string): void {
		if (isOpenTask(it)) {
			li.addClass("dc-draggable");
			li.draggable = true;
			li.addEventListener("dragstart", (e) => this.onDragStart(e, { kind, item: it }, li));
			li.addEventListener("dragend", () => this.onDragEnd());
		}
		const more = li.createEl("button", { cls: "dc-more", text: "⋯", attr: { type: "button", "aria-label": "항목 메뉴" } });
		more.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openMenu(e, it, kind, li);
		});
		// Phone: a tap opens the move sheet (`./mobile.ts`); the popover is the long press.
		if (!Platform.isMobile) li.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest("button, a, [role='checkbox']")) return;
			this.openMenu(e, it, kind, li);
		});
		li.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.openMenu(e, it, kind, li);
		});
	}

	private async toggleProjectAware(it: DeskItem, today: string): Promise<void> {
  if(this.busy)return; this.busy=true; let handled=false;
  try { handled=await toggleLinkedProjectTask(this.plugin,this.monthPath(it.file),it.index,it.line,today); }
  catch(e){handled=true;new Notice(e instanceof Error?e.message:String(e));}
  finally{this.busy=false;}
  if(handled)await this.reload();else await this.exec(planToggle(it,today));
 }

	// ── Wall Calendar → this month ──

	/** Open Wall Calendar lines of this month that are not in the Desk Calendar yet. */
	private wallLines(): WallLine[] {
		if (this.wallText === null) return [];
		const ym = parseMonthKey(this.month);
		if (!ym) return [];
		const sec = parseWallYear(this.wallText, ym.year).months[ym.month - 1];
		return (sec?.lines ?? []).filter((l) => l.item.ok && l.item.status === "scheduled" && (l.item.kind === "task" || l.item.kind === "event"));
	}

	private renderWallItems(band: HTMLElement): void {
		const lines = this.wallLines();
		if (!lines.length) return;
		const box = band.createDiv({ cls: "dc-wallin" });
		tip(box.createDiv({ cls: "dc-lbl dc-wallin-lbl", text: `Wall Calendar에서 · ${lines.length}` }), Platform.isMobile ? "Wall Calendar에 적은 이달의 일이에요. 누르면 이달 중이나 날짜에 넣어요." : "Wall Calendar에 적은 이달의 일이에요. 날짜 칸이나 이달 중으로 끌어 넣어요.");
		const ul = box.createEl("ul", { cls: "dc-wallin-items" });
		for (const l of lines) {
			const li = ul.createEl("li", { cls: `dc-it dc-k-${l.item.kind} dc-s-scheduled dc-wallin-it` });
			li.createSpan({ cls: "dc-sym", attr: { "aria-hidden": "true" } });
			const body = li.createSpan({ cls: "dc-body" });
			if (l.item.start) body.createSpan({ cls: "dc-tm", text: `${+l.item.start.slice(5, 7)}/${+l.item.start.slice(8, 10)}` });
			body.createSpan({ cls: "dc-txt", text: l.item.text });
			if (Platform.isMobile) {
				li.addEventListener("click", () => void this.chooseWallTarget(l));
				continue;
			}
			li.draggable = true;
			li.addClass("dc-draggable");
			li.addEventListener("dragstart", (e) => {
				this.wallDrag = l;
				e.dataTransfer?.setData("text/plain", l.line.trim());
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				li.addClass("dc-dragging");
				this.rootEl.addClass("dc-is-dragging", "dc-wall-dragging");
			});
			li.addEventListener("dragend", () => {
				this.wallDrag = null;
				li.removeClass("dc-dragging");
				this.rootEl.removeClass("dc-is-dragging", "dc-wall-dragging");
				this.rootEl.querySelectorAll(".dc-drop-hover").forEach((x) => x.removeClass("dc-drop-hover"));
			});
		}
	}

	/** Day cell (`iso`) or 이달 중 (`null`) accepts a dragged Wall line. */
	private wallDropZone(el: HTMLElement, iso: string | null): void {
		el.addEventListener("dragover", (e) => {
			if (!this.wallDrag) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			el.addClass("dc-drop-hover");
		});
		el.addEventListener("dragleave", (e) => {
			if (this.wallDrag && !el.contains(e.relatedTarget as Node | null)) el.removeClass("dc-drop-hover");
		});
		el.addEventListener("drop", (e) => {
			const l = this.wallDrag;
			if (!l) return;
			e.preventDefault();
			e.stopPropagation();
			el.removeClass("dc-drop-hover");
			this.wallDrag = null;
			void this.takeFromWall(l, iso);
		});
	}

	private async chooseWallTarget(l: WallLine): Promise<void> {
		const first = `${this.month}-01`;
		await actionSheet(this.app, l.item.text, [
			{ label: "이달 중에 넣기", icon: "inbox", run: () => this.takeFromWall(l, null) },
			{
				label: "날짜 고르기…",
				icon: "calendar",
				run: async () => {
					const d = await pickDate(this.app, "어느 날에 넣을까요?", l.item.start?.startsWith(this.month) ? l.item.start : todayIsoLocal().startsWith(this.month) ? todayIsoLocal() : first);
					if (d && d.startsWith(this.month)) await this.takeFromWall(l, d);
					else if (d) new Notice("이 달 안의 날짜를 골라 주세요.");
				},
			},
		]);
	}

	/** Wall line → this Desk month (a day or 이달 중); the Wall line becomes `→ [[Desk]]`. One checked batch. */
	private async takeFromWall(l: WallLine, iso: string | null): Promise<void> {
		if (this.busy) return;
		const ym = parseMonthKey(this.month);
		if (!ym) return;
		this.busy = true;
		try {
			const io = vaultIO(this.app);
			const wallPath = this.wallPath(ym.year), deskPath = this.monthPath(this.month);
			const wall = await io.read(wallPath), desk = await io.read(deskPath);
			if (wall === null || desk === null) throw new Error("Wall Calendar나 Desk Calendar 파일이 없어요.");
			const target: WallTarget = { month: ym.month, index: l.index, line: l.line };
			const today = todayIsoLocal();
			const put = insertIntoDesk(desk, deskLineFor(l.line.replace(/^\s*[-*+]\s+/, ""), l.item), iso);
			if (!put.ok) throw new Error(iso ? `Desk Calendar에 ${iso} 칸이 없어요.` : "Desk Calendar에 이달 중 섹션이 없어요.");
			const sent = markSentToDesk(wall, ym.year, target, deskLink(this.plugin.settings.deskCalendarFolder, ym.year, ym.month));
			if (!sent.ok) throw new Error("Wall Calendar 줄이 그새 바뀌었어요. 다시 그렸어요.");
			await commitBatch(io, [
				{ path: deskPath, before: desk, after: setFrontmatterScalar(put.text, "updated", today) },
				{ path: wallPath, before: wall, after: setFrontmatterScalar(sent.text, "updated", today) },
			]);
			await logDeskChange(this.plugin, `Wall Calendar에서 「${l.item.text}」 → ${iso ?? "이달 중"}`);
			new Notice(`「${l.item.text}」을(를) ${iso ? `${+iso.slice(5, 7)}월 ${+iso.slice(8, 10)}일` : "이달 중"}에 넣었어요.`);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		} finally {
			this.busy = false;
			await this.reload();
		}
	}

	// ── drag and drop ──

	private addZone(el: HTMLElement, z: Omit<DropZone, "el">): void {
		const zone: DropZone = { el, ...z };
		this.zones.push(zone);
		el.addEventListener("dragover", (e) => {
			if (!this.drag || !zone.accepts(this.drag)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			el.addClass("dc-drop-hover");
		});
		el.addEventListener("dragleave", (e) => {
			const to = e.relatedTarget as Node | null;
			if (!to || !el.contains(to)) el.removeClass("dc-drop-hover");
		});
		el.addEventListener("drop", (e) => {
			const d = this.drag;
			el.removeClass("dc-drop-hover");
			if (!d || !zone.accepts(d)) return;
			e.preventDefault();
			e.stopPropagation();
			this.onDragEnd();
			zone.drop(d);
		});
	}

	private onDragStart(e: DragEvent, d: Drag, li: HTMLElement): void {
		if (this.busy) {
			e.preventDefault();
			return;
		}
		this.drag = d;
		e.dataTransfer?.setData("text/plain", d.item.line.trim());
		if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		li.addClass("dc-dragging");
		this.rootEl.addClass("dc-is-dragging");
		for (const z of this.zones) if (z.accepts(d)) z.el.addClass("dc-drop-ok");
	}

	private onDragEnd(): void {
		this.drag = null;
		this.rootEl.removeClass("dc-is-dragging");
		this.rootEl.querySelectorAll(".dc-drop-ok, .dc-drop-hover, .dc-dragging").forEach((el) => el.removeClass("dc-drop-ok", "dc-drop-hover", "dc-dragging"));
		if (this.pendingReload && !this.busy) {
			this.pendingReload = false;
			this.scheduleReload();
		}
	}

	// ── item menu (let-go choices) ──

	private openMenu(_e: MouseEvent, it: DeskItem, kind: Drag["kind"], anchor: HTMLElement): void {
		const menu = new ItemPopover();
		const ctx = this.ctx!;
		const st = it.item.status === "cancelled" && it.item.kind === "task" ? "놓아줌" : STATUS_LABEL[it.item.status];
		menu.title = it.item.text || it.line.trim();
		menu.badge = `${KIND_LABEL[it.item.kind ?? "note"]} · ${st}`;
		menu.row("자리", it.section === "day" ? `${it.date}${it.item.time ? ` ${it.item.time}` : ""}` : it.section === "alloc" ? `W${String(isoWeekNo(it.monday!)).padStart(2, "0")} 이번 주 할 일` : "이달 중");
		if (it.item.movedTo) menu.row("보낸 곳", it.item.movedTo);
		if (it.item.goal) menu.row("목표", it.item.goal, () => this.openGoal(it.item.goal));
		for (const [k, v] of it.item.fields) {
			if (!v || k === "goal" || k === "task") continue;
			if (k === "project") menu.row("프로젝트", v, () => void this.plugin.openProjectAt(v));
			else menu.row(FIELD_LABEL[k] ?? k, k === "moved" ? `${v}번` : v);
		}
		if (it.problems.length) menu.row("형식 확인", it.problems.join(" · "));
		if (kind === "day" && it.item.kind === "task" && (it.item.status === "scheduled" || it.item.status === "done")) {
			menu.addItem((i) =>
				i
					.setTitle(it.item.status === "done" ? "완료 취소" : "완료")
					.setIcon("check")
					.onClick(() => void this.toggleProjectAware(it, ctx.today)),
			);
		}
		if (kind === "day" && isOpenTask(it)) {
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("다른 날…").setIcon("calendar").setHint("이번 달 안에서 할 날을 다시 정해요").onClick(() => void this.chooseOtherDay(it)));
			menu.addItem((i) => i.setTitle("미래로…").setIcon("calendar-clock").setHint("아직 Desk Calendar가 없는 먼 달로 보내요 (Wall Calendar)").onClick(() => void this.chooseFuture(it)));
			menu.addItem((i) => i.setTitle("서랍에…").setIcon("archive").setHint("하기로 했지만 지금은 아니에요. 다시 꺼낼 조건을 붙여 Drawer에 둬요").onClick(() => void this.chooseDrawer(it)));
			menu.addItem((i) => i.setTitle("쪼개기…").setIcon("scissors").setHint("너무 커서 못 했다면 작은 다음 행동으로 나눠요").onClick(() => void this.chooseSplit(it)));
			menu.addItem((i) => i.setTitle("놓아주기…").setIcon("circle-slash").setHint("하지 않기로 해요. 이유를 한 줄 남겨요").onClick(() => void this.chooseLetGo(it)));
		}
		if (it.item.kind === "event" && it.item.status === "scheduled") {
			menu.addItem((i) => i.setTitle("행사 취소 (취소선)").setIcon("x").onClick(() => void this.exec(planCancelEvent(it, ctx.today))));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("수정…").setIcon("pencil").onClick(() => void this.editItem(it)));
		menu.addItem((i) =>
			i
				.setTitle("삭제…")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void this.deleteItem(it)),
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("파일에서 보기").setIcon("file-text").onClick(() => void this.openAt(it.file, it.index)));
		menu.show(anchor);
	}

	// ── 수정 / 삭제 ──

	private sectionLabel(it: DeskItem): string {
		if (it.section === "during") return "이달 중";
		if (it.section === "alloc") return "이번 주 할 일";
		return it.date ?? "";
	}

	private async editItem(it: DeskItem): Promise<void> {
		const ctx = this.ctx!;
		const body = it.line.replace(/^\s*[-*+]\s+/, "");
		const copies = pairedCopies(it, ctx.months);
		const hasWhy = it.item.status === "cancelled" || !!getField(body, "why");
		const isDay = it.section === "day";
		const v = await askForm(this.app, {
			title: `${KIND_LABEL[it.item.kind ?? "note"]} 수정 · ${this.sectionLabel(it)}`,
			desc: copies.length
				? `배정된 다른 칸(${copies.map((x) => this.sectionLabel(x)).join(", ")})도 같이 고쳐요.`
				: undefined,
			fields: [
				{ key: "text", label: "내용", type: "text", value: contentText(body, TIME_LEAD_RE) },
				{ key: "time", label: "시각", type: "text", value: splitContent(body, TIME_LEAD_RE).lead.trim(), placeholder: "14:00 (비우면 없음)" },
				...(isDay ? [{ key: "date", label: "날짜", type: "date" as const, value: it.date!, desc: "잘못 적은 날을 고칠 때. 미루는 것은 「다른 날…」이에요." }] : []),
				{ key: "goal", label: "목표", type: "text", value: getField(body, "goal"), placeholder: "연결할 목표 (선택)" },
				{ key: "project", label: "프로젝트", type: "text", value: getField(body, "project"), placeholder: "연결할 프로젝트 (선택)" },
				...(hasWhy ? [{ key: "why", label: "이유", type: "text" as const, value: getField(body, "why") }] : []),
			],
			validate: (x) => {
				const out: string[] = [];
				if (!x.text) out.push("내용을 적어 주세요.");
				if (normalizeTime(x.time) === null) out.push("시각은 HH:MM 형식이에요 (예: 09:30, 14:00~15:00).");
				if (isDay && !/^\d{4}-\d{2}-\d{2}$/.test(x.date)) out.push("날짜를 골라 주세요.");
				if (hasWhy && it.item.status === "cancelled" && it.item.kind === "task" && !x.why) out.push("놓아준 할 일에는 이유가 있어야 해요.");
				return out;
			},
		});
		if (!v) return;
		const fields: Record<string, string> = { goal: v.goal, project: v.project };
		if (hasWhy) fields.why = v.why;
		const time = normalizeTime(v.time) ?? undefined;
		const date = isDay && v.date !== it.date ? v.date : undefined;
		if (date && !dayExists(ctx, date) && !this.fileAt(this.monthPath(date.slice(0, 7)))) {
			new Notice(`${date.slice(0, 7)} Desk Calendar 파일이 없어요. 먼저 새 달을 만들어 주세요.`);
			return;
		}
		const alloc = date ? findPairAlloc(it, ctx.months) : null;
		const change = {
			text: v.text !== contentText(body, TIME_LEAD_RE) ? v.text : undefined,
			time: time !== splitContent(body, TIME_LEAD_RE).lead.trim() ? time : undefined,
			fields,
			date,
		};
		await this.exec(planEdit(it, change, copies, alloc, ctx.today));
	}

	private async deleteItem(it: DeskItem): Promise<void> {
		const ctx = this.ctx!;
		const notes: string[] = [];
		const copies = pairedCopies(it, ctx.months);
		if (it.section === "day") {
			const alloc = findPairAlloc(it, ctx.months);
			if (alloc) notes.push(`이번 주 할 일 「${alloc.item.text}」의 → ${+it.date!.slice(5, 7)}/${+it.date!.slice(8, 10)} 배정도 지워요.`);
			const pad = normalizePath(`${this.plugin.settings.dailyPadFolder}/${it.date!.slice(0, 4)}/${it.date}.md`);
			if (this.fileAt(pad)) notes.push(`${it.date} Daily Pad가 이 날짜 칸을 embed로 보여 줘요. 거기서도 사라져요.`);
		} else if (it.section === "alloc") {
			const parents = copies.filter((x) => x.section === "during");
			if (parents.length) notes.push(`이달 중 「${parents[0].item.text}」의 → W${String(isoWeekNo(it.monday!)).padStart(2, "0")} 배정도 지워요.`);
			const days = copies.filter((x) => x.section === "day");
			if (days.length) notes.push(`날짜 칸에 옮겨 적은 줄 ${days.length}개(${days.map((x) => x.date).join(", ")})는 지우지 않고 남겨요.`);
		} else {
			const down = copies.filter((x) => x.section !== "during");
			if (down.length) notes.push(`이번 주 할 일·날짜 칸에 옮겨 적은 줄 ${down.length}개는 지우지 않고 남겨요.`);
		}
		if (getField(it.line, "from") === "Wall Calendar") notes.push("Wall Calendar에서 온 줄이에요. Wall Calendar의 원래 줄(→ [[…]] 표시)은 기록으로 남아요.");
		const task = isOpenTask(it) && it.section === "day";
		const event = it.item.kind === "event" && it.item.status === "scheduled";
		const ans = await confirmDelete(this.app, {
			title: `${KIND_LABEL[it.item.kind ?? "note"]} 삭제`,
			removes: [`${this.monthPath(it.file)} · ${this.sectionLabel(it)}`, it.line.trim()],
			notes,
			footer: "잘못 넣은 줄, 중복, 테스트 데이터를 지울 때 써요.",
			alt: task
				? { label: "놓아주기 (기록 남김)", desc: "하지 않기로 한 일이면 지우지 말고 이유와 함께 놓아주기로 남길 수 있어요." }
				: event
					? { label: "행사 취소 (취소선)", desc: "취소된 행사면 지우지 말고 취소 표시로 남길 수 있어요." }
					: undefined,
		});
		if (ans === "delete") await this.exec(planDelete(it, ctx.months, ctx.today));
		else if (ans === "alt" && task) await this.chooseLetGo(it);
		else if (ans === "alt" && event) await this.exec(planCancelEvent(it, ctx.today));
	}

	/** The third-postpone check. Returns false when the move should not go ahead. */
	private async thirdMoveGate(it: DeskItem): Promise<boolean> {
		const n = movedCount(it.line);
		if (n < 2) return true;
		const a = await askThirdMove(this.app, it.item.text, n);
		if (a === "proceed") return true;
		if (a === "letgo") await this.chooseLetGo(it);
		else if (a === "split") await this.chooseSplit(it);
		return false;
	}

	private async moveToDay(it: DeskItem, date: string): Promise<void> {
		if (!(await this.thirdMoveGate(it))) return;
		const ctx = this.ctx!;
		// Swap the allocation's date only when the new day is in the same week.
		const pair = it.monday && addDays(date, -weekdayMon0(date)) === it.monday ? findPairAlloc(it, ctx.months) : null;
		await this.exec(planMoveDay(it, date, pair, ctx.today));
	}

	private async chooseOtherDay(it: DeskItem): Promise<void> {
		if (!(await this.thirdMoveGate(it))) return;
		const date = await pickDate(this.app, "다른 날로 옮기기", addDays(it.date!, 1), `「${it.item.text}」을(를) 옮길 날을 골라요.`);
		if (!date || date === it.date) return;
		if (!this.fileAt(this.monthPath(date.slice(0, 7)))) {
			new Notice(`${date.slice(0, 7)} Desk Calendar 파일이 없어요. 먼저 새 달을 만들어 주세요.`);
			return;
		}
		const ctx = this.ctx!;
		const pair = it.monday && addDays(date, -weekdayMon0(date)) === it.monday ? findPairAlloc(it, ctx.months) : null;
		await this.exec(planMoveDay(it, date, pair, ctx.today));
	}

	private async chooseFuture(it: DeskItem): Promise<void> {
		if (!(await this.thirdMoveGate(it))) return;
		const ym = await pickMonth(this.app, "미래로 (Wall Calendar)", shiftMonth(it.file, 1), `「${it.item.text}」을(를) 보낼 달을 골라요.`);
		if (!ym || !parseMonthKey(ym)) return;
		await this.exec(planFuture(it, ym, this.wallPath(+ym.slice(0, 4)), this.ctx!.today));
	}

	/** 「서랍에」: a Drawer line needs a `when::` condition (Drawer AGENTS 「4-1」 1); 놓아주기 is offered first. */
	private async chooseDrawer(it: DeskItem): Promise<void> {
		const a = await askWhen(this.app, it.item.text);
		if (!a) return;
		if (a.kind === "letgo") return this.chooseLetGo(it);
		await this.exec(planDrawer(it, normalizePath(this.plugin.settings.drawerPath), this.ctx!.today, a.when));
	}

	private async chooseSplit(it: DeskItem): Promise<void> {
		const v = await promptText(this.app, "쪼개기", {
			desc: `「${it.item.text}」을(를) 더 작은 다음 행동으로 나눠요. 한 줄에 하나씩 적어요.`,
			placeholder: "예: 자료 목록 만들기\n첫 단락 쓰기",
			multiline: true,
			okText: "쪼개기",
		});
		if (!v) return;
		const parts = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
		if (parts.length) await this.exec(planSplit(it, parts, this.ctx!.today));
	}

	private async chooseLetGo(it: DeskItem): Promise<void> {
		const why = await promptText(this.app, "놓아주기", {
			desc: `「${it.item.text}」을(를) 하지 않기로 해요. 이유를 한 줄로 남겨요.`,
			placeholder: "예: 지금 목표와 관계없음",
			okText: "놓아주기",
		});
		if (why) await this.exec(planLetGo(it, why, this.ctx!.today));
	}

	// ── links ──

	private openGoal(id: string): void {
		void this.plugin.openPinboardGoal(id);
	}

	private async openAt(fileKey: string, line: number, e?: MouseEvent): Promise<void> {
		const f = this.fileAt(this.monthPath(fileKey));
		if (!f) {
			new Notice("이 달의 Desk Calendar 파일이 없어요.");
			return;
		}
		await this.app.workspace.getLeaf(e ? Keymap.isModEvent(e) : "tab").openFile(f, { eState: { line } });
	}

	// ── writing ──

	private pathOf(file: string, month: boolean): string {
		return month ? this.monthPath(file) : normalizePath(file);
	}

	/**
	 * Run a plan: dry-run every edit against the current file contents (so a stale view never writes
	 * half an operation), then one `vault.process` per file, then the index change log.
	 */
	async exec(plan: Plan): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		try {
			const texts: Record<string, string | undefined> = {};
			for (const e of plan.edits) {
				const f = this.fileAt(this.pathOf(e.file, e.month));
				if (!f) {
					if (e.month) {
						new Notice(`${e.file} Desk Calendar 파일이 없어요. 먼저 새 달을 만들어 주세요.`);
						return false;
					}
					continue;
				}
				texts[e.file] = await this.app.vault.read(f);
			}
			const dry = runPlan(plan, texts);
			if (!dry.ok) {
				new Notice(CHANGED_NOTICE);
				return false;
			}
			for (const e of plan.edits) {
				const path = this.pathOf(e.file, e.month);
				const f = this.fileAt(path);
				if (!f) {
					const base = e.create!();
					const r = e.apply(base);
					if (!r.ok) throw new Error(r.reason);
					await this.ensureFolder(path);
					await this.app.vault.create(path, r.text);
					continue;
				}
				let failed: string | null = null;
				await this.app.vault.process(f, (data) => {
					const r = e.apply(data);
					if (!r.ok) {
						failed = r.reason;
						return data;
					}
					return r.text;
				});
				if (failed) {
					new Notice(CHANGED_NOTICE);
					return false;
				}
			}
			await logDeskChange(this.plugin, plan.what);
			return true;
		} catch (err) {
			console.error("[MyLogs] Desk Calendar write failed", err);
			new Notice("MyLogs: 파일에 쓰지 못했어요. 콘솔을 확인해 주세요.");
			return false;
		} finally {
			this.busy = false;
			this.pendingReload = false;
			await this.reload();
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const folder = path.slice(0, path.lastIndexOf("/"));
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				// created concurrently
			}
		}
	}
}
