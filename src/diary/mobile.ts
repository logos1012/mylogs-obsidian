/**
 * Diary on a phone (계획 「11. 모바일」): the three panes become one column with tabs
 * 「타임라인 / 쓰기 / 재료」. The panes are the desktop ones, drawn by the same functions; only one
 * is shown at a time. Selecting an entry (timeline row, 그날의 기록, calendar day) switches to 쓰기;
 * 「오늘 쓰기」 is a floating button; the calendar is a modal; images come from a file picker
 * (paste / drop may not exist on mobile).
 *
 * Reached only through `DiaryView.render()`'s `Platform.isMobile` dispatch.
 */

import { type App, Modal, setIcon } from "obsidian";
import { addDays, fromIsoDate } from "../parser.ts";
import { shiftMonthKey } from "../mylife/model.ts";
import { todayIsoLocal } from "../desk/model.ts";
import { chooseFiles, enableTouchMenus, fab, pickTarget, tabBar, trackKeyboard } from "../ui/mobile.ts";
import { calendarDays, type DiaryEntry, displayTitle, monthLabel } from "./model.ts";

export type DiaryTab = "timeline" | "write" | "material";

export interface DiaryMobileHost {
	app: App;
	contentEl: HTMLElement;
	rootEl: HTMLElement;
	/** Fresh render scope for markdown (the desktop `render()` prologue). */
	beginRender(): void;
	renderTimeline(): void;
	renderEditor(): void;
	renderMaterial(): void;
	entries(): DiaryEntry[];
	hasSelection(): boolean;
	select(path: string): Promise<void>;
	writeToday(): Promise<void>;
	/** Insert image files at the editor's cursor (the paste / drop path). */
	insertImages(files: FileList): Promise<void>;
	register(cb: () => void): void;
}

interface State {
	tab: DiaryTab;
	installed: boolean;
}

const states = new WeakMap<HTMLElement, State>();

function stateOf(h: DiaryMobileHost): State {
	let s = states.get(h.rootEl);
	if (!s) {
		s = { tab: h.hasSelection() ? "write" : "timeline", installed: false };
		states.set(h.rootEl, s);
	}
	return s;
}

const TABS: { id: DiaryTab; label: string }[] = [
	{ id: "timeline", label: "타임라인" },
	{ id: "write", label: "쓰기" },
	{ id: "material", label: "재료" },
];

/** Clicks that open an entry in the editor: switch to 쓰기 first (capture), so focus lands on a visible textarea. */
const OPENS_EDITOR = ".dy-row, .dy-mat-entry-open, .dy-tl-tools .dy-btn-primary, .dy-sheet-empty .dy-btn-primary, .dy-prompt ~ .dy-btn-primary";

export function renderDiaryMobile(h: DiaryMobileHost): void {
	const s = stateOf(h);
	if (!s.installed) install(h, s);
	h.beginRender();
	for (const [name, draw] of [
		["timeline", () => h.renderTimeline()],
		["editor", () => h.renderEditor()],
		["material", () => h.renderMaterial()],
	] as const) {
		try {
			draw();
		} catch (err) {
			console.error(`[MyLogs] Diary ${name} render failed`, err);
		}
	}
	drawBar(h, s);
}

function install(h: DiaryMobileHost, s: State): void {
	s.installed = true;
	h.rootEl.addClass("dy-m");
	h.register(enableTouchMenus(h.contentEl));
	h.register(trackKeyboard(h.contentEl));
	const onClick = (e: MouseEvent) => {
		const t = e.target as HTMLElement | null;
		if (t?.closest(OPENS_EDITOR)) setTab(h, s, "write");
	};
	h.rootEl.addEventListener("click", onClick, { capture: true });
	h.register(() => h.rootEl.removeEventListener("click", onClick, { capture: true }));
	const write = fab(h.contentEl, "오늘 쓰기", "pen-line", () => {
		setTab(h, s, "write");
		void h.writeToday();
	});
	write.addClass("dy-m-fab");
	h.register(() => write.remove());
}

function setTab(h: DiaryMobileHost, s: State, tab: DiaryTab): void {
	if (s.tab === tab) return;
	s.tab = tab;
	drawBar(h, s);
}

/** Tab bar + per-tab tools, first child of the root; the root class shows one pane. */
function drawBar(h: DiaryMobileHost, s: State): void {
	h.rootEl.querySelector(":scope > .dy-m-bar")?.remove();
	const bar = createDiv({ cls: "dy-m-bar" });
	h.rootEl.prepend(bar);
	tabBar(bar, TABS, s.tab, (t) => setTab(h, s, t));
	const tools = bar.createDiv({ cls: "dy-m-tools" });
	if (s.tab === "timeline") {
		const cal = tools.createEl("button", { cls: "dy-m-tool", attr: { type: "button", "aria-label": "캘린더" } });
		setIcon(cal, "calendar-days");
		cal.addEventListener("click", () => void openCalendar(h, s));
	} else if (s.tab === "write") {
		const img = tools.createEl("button", { cls: "dy-m-tool", attr: { type: "button", "aria-label": "이미지 넣기" } });
		setIcon(img, "image-plus");
		img.addEventListener("click", () => void addImages(h));
	}
	for (const t of TABS) h.rootEl.toggleClass(`dy-m-tab-${t.id}`, t.id === s.tab);
}

async function addImages(h: DiaryMobileHost): Promise<void> {
	const files = await chooseFiles("image/*");
	if (files) await h.insertImages(files);
}

// ── calendar modal ──

/** Entries of one day, newest first. */
export function entriesOn(entries: DiaryEntry[], date: string): DiaryEntry[] {
	return entries.filter((e) => e.date === date).sort((a, b) => b.time.localeCompare(a.time) || b.name.localeCompare(a.name));
}

async function openCalendar(h: DiaryMobileHost, s: State): Promise<void> {
	const date = await new CalendarModal(h.app, h.entries()).ask();
	if (!date) return;
	const day = entriesOn(h.entries(), date);
	let target = day[0];
	if (day.length > 1) {
		const pick = await pickTarget(
			h.app,
			`${date} 엔트리`,
			day.map((e) => ({ label: displayTitle(e), sub: e.time, entry: e })),
		);
		if (!pick) return;
		target = pick.entry;
	}
	if (!target) return;
	setTab(h, s, "write");
	await h.select(target.path);
}

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

class CalendarModal extends Modal {
	private month = todayIsoLocal().slice(0, 7);
	private resolve: (v: string | null) => void = () => undefined;
	private chosen: string | null = null;
	private readonly entries: DiaryEntry[];

	constructor(app: App, entries: DiaryEntry[]) {
		super(app);
		this.entries = entries;
	}

	ask(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.modalEl.addClass("mylogs-modal", "dy-m-calmodal");
		this.setTitle("캘린더");
		this.draw();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.chosen);
	}

	private draw(): void {
		const el = this.contentEl;
		el.empty();
		const month = this.month;
		const nav = el.createDiv({ cls: "dy-m-cal-nav" });
		const prev = nav.createEl("button", { text: "◀", attr: { type: "button", "aria-label": "이전 달" } });
		prev.addEventListener("click", () => this.go(shiftMonthKey(month, -1)));
		nav.createSpan({ cls: "dy-m-cal-month", text: monthLabel(month) });
		const next = nav.createEl("button", { text: "▶", attr: { type: "button", "aria-label": "다음 달" } });
		next.addEventListener("click", () => this.go(shiftMonthKey(month, 1)));
		const grid = el.createDiv({ cls: "dy-m-cal-grid" });
		for (const w of WEEKDAYS) grid.createDiv({ cls: "dy-m-cal-wd", text: w });
		const first = fromIsoDate(`${month}-01`);
		if (!first) return;
		for (let i = 0; i < (first.getDay() + 6) % 7; i++) grid.createDiv();
		const days = calendarDays(this.entries, month);
		const today = todayIsoLocal();
		for (let cur = `${month}-01`; cur.startsWith(`${month}-`); cur = addDays(cur, 1)) {
			const info = days.get(cur);
			const cell = grid.createEl("button", { cls: `dy-m-cal-cell${info ? " is-filled" : ""}${cur === today ? " is-today" : ""}`, attr: { type: "button" } });
			cell.createSpan({ text: String(+cur.slice(8, 10)) });
			if (info && info.count > 1) cell.createSpan({ cls: "dy-m-cal-n", text: String(info.count) });
			if (!info) cell.disabled = true;
			const date = cur;
			cell.addEventListener("click", () => {
				this.chosen = date;
				this.close();
			});
		}
	}

	private go(month: string): void {
		this.month = month;
		this.draw();
	}
}
