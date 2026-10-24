import { ItemView, Keymap, Menu, moment, normalizePath, Notice, setIcon, type TAbstractFile, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { addDays } from "../parser.ts";
import {
	allocFileOf,
	type DayIndex,
	dayIndex,
	type DeskItem,
	type DeskWeek,
	findPairAlloc,
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
import { askThirdMove, pickDate, pickMonth, promptText } from "./modals.ts";
import {
	movedCount,
	type Plan,
	planAssignDay,
	planAssignWeek,
	planDrawer,
	planFuture,
	planLetGo,
	planMoveDay,
	planSplit,
	planToggle,
	planUnassign,
	runPlan,
} from "./ops.ts";

export const VIEW_TYPE_DESK_CALENDAR = "mylogs-desk-calendar";
export const DRAWER_PATH = "06 Drawer/Drawer.md";
const PINBOARD_VIEW = "mylogs-pinboard";
const PINBOARD_COMMAND = "mylogs:open-pinboard";
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
	private busy = false;
	private pendingReload = false;
	private reloadTimer: number | null = null;
	private loadSeq = 0;

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
		return [-1, 0, 1].map((n) => this.monthPath(shiftMonth(this.month, n)));
	}

	// ── lifecycle ──

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-desk-calendar-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-desk-calendar" });
		const onFile = (f: TAbstractFile, old?: string) => {
			const paths = this.watchedPaths();
			if (paths.includes(f.path) || (old && paths.includes(old))) this.scheduleReload();
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
		if (seq !== this.loadSeq) return;
		this.months = loaded;
		this.render();
	}

	// ── rendering ──

	private render(): void {
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
		btn("", "마크다운 파일 열기", (e) => void this.openAt(this.month, 0, e), "file-text");
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
		lg.createSpan({ cls: "dc-sep" });
		const a = lg.createSpan();
		a.createEl("b", { text: "→" });
		a.appendText("분배 칸에서 배정한 날짜·주");
		lg.createSpan({ text: "끌어다 놓기: 이달 중 → 이번 주 할 일 → 날짜 칸 · ⋯ 또는 오른쪽 클릭: 못 한 일 처리" });
	}

	private renderEmpty(root: HTMLElement): void {
		const card = root.createDiv({ cls: "dc-empty" });
		card.createDiv({ cls: "dc-empty-title", text: "이 달의 Desk Calendar 파일이 아직 없어요" });
		card.createEl("code", { text: this.monthPath(this.month) });
		const b = card.createEl("button", { cls: "dc-btn dc-btn-primary", text: `${this.month} 새 달 만들기`, attr: { type: "button" } });
		b.addEventListener("click", () => void createDeskMonth(this.plugin, this.month));
	}

	private renderBands(root: HTMLElement, cur: MonthData, ctx: Ctx): void {
		const focus = root.createEl("section", { cls: "dc-band" });
		focus.createDiv({ cls: "dc-lbl", text: "이달의 초점" });
		const fl = focus.createEl("ul", { cls: "dc-focuslist" });
		if (!cur.focus.length) fl.createEl("li", { cls: "dc-focus dc-none", text: "이달의 초점이 아직 없어요" });
		for (const f of cur.focus) {
			const li = fl.createEl("li", { cls: "dc-focus" });
			const fid = li.createSpan({ cls: "dc-fid", text: f.id || "?" });
			if (f.id) {
				li.addClass("is-link");
				li.setAttr("title", `목표 ${f.id} 열기`);
				li.addEventListener("click", () => this.openGoal(f.id));
			} else fid.addClass("dc-miss");
			li.createSpan({ cls: "dc-ftitle", text: f.title });
			if (f.note) li.createSpan({ cls: "dc-fnote", text: f.note });
			if (f.test && this.plugin.settings.showTestMarkers) this.testDot(li);
		}

		const during = root.createEl("section", { cls: "dc-band dc-during" });
		during.createDiv({ cls: "dc-lbl", text: "이달 중" });
		const ul = during.createEl("ul");
		if (!cur.during.length) ul.createEl("li", { cls: "dc-it dc-none", text: "없음" });
		for (const it of cur.during) this.renderDuringItem(ul, it, ctx);
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
				cell.createEl("p", { cls: "dc-away", text: `분배: ${where}` });
				return;
			}
			label.createSpan({ cls: "dc-where", text: where });
		}
		if (!week) {
			cell.createEl("p", { cls: "dc-away", text: "분배 칸 없음" });
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
		const inMonth = iso.slice(0, 7) === cur.key;
		const data = ctx.months.find((m) => m.key === iso.slice(0, 7));
		const items = data?.days.get(iso) ?? [];
		if (!inMonth) cell.addClass("dc-out");
		if (iso === ctx.today) cell.addClass("dc-today");
		else if (iso < ctx.today) cell.addClass("dc-past");
		if (!items.length) cell.addClass("dc-blank");
		const head = cell.createDiv({ cls: "dc-dhead" });
		const m = moment(iso, "YYYY-MM-DD");
		head.createSpan({ cls: "dc-dnum", text: String(m.date()) });
		head.createSpan({ cls: "dc-dwd", text: m.format("dd") });
		if (iso === ctx.today) head.createSpan({ cls: "dc-todaytag", text: "오늘" });
		if (items.length) {
			const ul = cell.createEl("ul", { cls: "dc-items" });
			for (const it of items) this.renderDayItem(ul, it, ctx);
		}
		if (!dayExists(ctx, iso)) return;
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
		if (it.item.goal) {
			const g = meta.createSpan({ cls: "dc-gchip", text: it.item.goal, attr: { title: `목표 ${it.item.goal} 열기` } });
			g.addEventListener("click", (e) => {
				e.stopPropagation();
				this.openGoal(it.item.goal);
			});
		}
		for (const t of it.item.tags) meta.createSpan({ cls: "dc-tag", text: `#${t}` });
		if (it.item.test && this.plugin.settings.showTestMarkers) this.testDot(meta);
		if (warn) meta.createSpan({ cls: "dc-warnmark", text: "?", attr: { title: warn } });
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
		if (it.item.movedTo) meta.createSpan({ cls: "dc-fld dc-mto", text: `→ ${it.item.movedTo}` });
		for (const [k, v] of it.item.fields) if (k !== "goal") meta.createSpan({ cls: "dc-fld", text: `${FIELD_LABEL[k] ?? k} ${v}` });
		this.finishMeta(body, meta, it, it.problems.length ? it.problems.join(" · ") : null);
		const st = it.item.status === "cancelled" && it.item.kind === "task" ? "놓아줌" : STATUS_LABEL[it.item.status];
		li.setAttr("title", `${st} · ${KIND_LABEL[it.item.kind ?? "note"]}`);

		const toggleable = it.item.kind === "task" && (it.item.status === "scheduled" || it.item.status === "done");
		if (toggleable) {
			const sym = li.querySelector(".dc-sym") as HTMLElement;
			sym.addClass("is-clickable");
			sym.setAttrs({ role: "checkbox", tabindex: "0", "aria-checked": String(it.item.status === "done"), "aria-label": `${it.item.text} 완료 표시` });
			const toggle = (e: Event) => {
				e.preventDefault();
				e.stopPropagation();
				li.addClass("is-pending");
				void this.exec(planToggle(it, ctx.today));
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
		li.createSpan({ cls: "dc-warnmark", text: "?", attr: { title: it.problems.join(" · ") || "형식 확인 필요" } });
	}

	/** Drag source + item menu (⋯ button and right-click). */
	private decorate(li: HTMLElement, it: DeskItem, kind: Drag["kind"], hint: string): void {
		if (isOpenTask(it)) {
			li.addClass("dc-draggable");
			li.draggable = true;
			if (hint && !li.getAttr("title")) li.setAttr("title", hint);
			li.addEventListener("dragstart", (e) => this.onDragStart(e, { kind, item: it }, li));
			li.addEventListener("dragend", () => this.onDragEnd());
		}
		const more = li.createEl("button", { cls: "dc-more", text: "⋯", attr: { type: "button", "aria-label": "항목 메뉴" } });
		more.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openMenu(e, it, kind);
		});
		li.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.openMenu(e, it, kind);
		});
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

	private openMenu(e: MouseEvent, it: DeskItem, kind: Drag["kind"]): void {
		const menu = new Menu();
		const ctx = this.ctx!;
		if (kind === "day" && it.item.kind === "task" && (it.item.status === "scheduled" || it.item.status === "done")) {
			menu.addItem((i) =>
				i
					.setTitle(it.item.status === "done" ? "완료 취소" : "완료")
					.setIcon("check")
					.onClick(() => void this.exec(planToggle(it, ctx.today))),
			);
		}
		if (kind === "day" && isOpenTask(it)) {
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("다른 날…").setIcon("calendar").onClick(() => void this.chooseOtherDay(it)));
			menu.addItem((i) => i.setTitle("미래로 (Wall Calendar)…").setIcon("calendar-clock").onClick(() => void this.chooseFuture(it)));
			menu.addItem((i) => i.setTitle("서랍에").setIcon("archive").onClick(() => void this.exec(planDrawer(it, DRAWER_PATH, ctx.today))));
			menu.addItem((i) => i.setTitle("쪼개기…").setIcon("scissors").onClick(() => void this.chooseSplit(it)));
			menu.addItem((i) => i.setTitle("놓아주기…").setIcon("circle-slash").onClick(() => void this.chooseLetGo(it)));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("파일에서 보기").setIcon("file-text").onClick(() => void this.openAt(it.file, it.index)));
		menu.showAtMouseEvent(e);
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
		const cmds = (this.app as unknown as { commands?: { commands?: Record<string, unknown>; executeCommandById?: (id: string) => boolean } }).commands;
		if (cmds?.commands?.[PINBOARD_COMMAND] && cmds.executeCommandById) {
			cmds.executeCommandById(PINBOARD_COMMAND);
			return;
		}
		const leaf = this.app.workspace.getLeavesOfType(PINBOARD_VIEW)[0];
		if (leaf) {
			void this.app.workspace.revealLeaf(leaf);
			return;
		}
		new Notice(`목표 ${id}`);
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
