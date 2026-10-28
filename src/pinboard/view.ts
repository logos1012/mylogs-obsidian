import { goalIdYear, isGoalNotePath } from "./model.ts";
import { asSide, inputSide, shows, type Side, type SideMode } from "../side.ts";
import { loadProjectProgress, saveProgressSettings } from "./project-rollup.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { applyProjectProgress, contributions, projectWeight, type ProjectProgress } from "./project-progress.ts";
import {
	debounce,
	ItemView,
	Keymap,
	Menu,
	normalizePath,
	Notice,
	type PaneType,
	Platform,
	setIcon,
	TAbstractFile,
	TFile,
	type ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { enableTouchMenus, pickTarget, type PickItem } from "../ui/mobile.ts";
import { toIsoDate } from "../parser.ts";
import { cleanFolder } from "../settings.ts";
import { askForm, confirmDelete } from "../ui/modals.ts";
import { hubLocation, parseProject } from "../projects/model.ts";
import { activeRoot, archiveRoot, removeGoalsFromProjects, takenIdsAndNames, completeProject, deleteProject } from "../projects/actions.ts";
import { askNewProject } from "../projects/modals.ts";
import { flywheelPath, parseFlywheel } from "../flywheel/model.ts";
import { setFrontmatterScalar } from "../writer.ts";
import {
	applyGoalChange,
	applyMainRollup,
	deleteProgressEntry,
	unlinkProject,
	editProgressEntry,
	type GoalFieldChange,
	progressEntries,
	type ProgressEntry,
	removeIndexRows,
	removeUndecidedLines,
	setIndexCells,
} from "./goal-edit.ts";
import {
	applyIndexEdit,
	defaultEvidence,
	ensureHealthColumn,
	INDEX_FILE,
	indexPathCell,
	indexProgressCell,
	indexToken,
	prependChangeLog,
	type ProgressLineInput,
	type RowUpdate,
} from "./index-writer.ts";
import {
	type Board,
	buildBoard,
	bulletItems,
	chartSeries,
	dday,
	displayMainProgress,
	displaySubProgress,
	findSectionText,
	fmtNum,
	fmtVal,
	type Goal,
	goalIdsIn,
	type HabitRef,
	HEALTH_ICON,
	HEALTH_KO,
	healthCounts,
	HEALTHS,
	isEnded,
	isIsoDate,
	KIND_KO,
	MEASURE_KO,
	mergeRelated,
	missingFields,
	type MissingField,
	newestFirst,
	paceHint,
	parseGoal,
	parseProgressLine,
	parseSections,
	type ProgressLine,
	type ProjectRef,
	type RelatedItem,
	relatedOf,
	rollupMain,
	STATUS_KO,
	toNum,
	type Verify,
	VERIFIES,
	yearInfo,
} from "./model.ts";
import { type MapInput, type MapSub, renderStrategyMap } from "./map.ts";
import { askCreateGoal, askDeleteGoals } from "./create-modal.ts";
import { saveGoalScope, createGoalFlow, connectFlywheel, connectProject, createProjectForGoal, unlinkDeletedFlywheel, readProject, readGoals, refreshRelatedIndex } from "./create-actions.ts";
import { parseFrontmatterText } from "./model.ts";
import { INLINE_LABELS, inlineToken, inlineValue, type InlineGoalField } from "./inline-edit.ts";
import { saveInlineGoal } from "./inline-actions.ts";

export const VIEW_TYPE_PINBOARD = "mylogs-pinboard";

const EXCLUDE_DIRS = new Set(["_Templates", "_build"]);
const SVG_NS = "http://www.w3.org/2000/svg";

type Tab = "list" | "map";

function todayIso(): string {
	return toIsoDate(new Date());
}

/** A 진척 기록 entry with its parsed fields. */
interface LogItem {
	entry: ProgressEntry;
	line: ProgressLine;
}

interface Loaded {
	year: number | null;
	years: number[];
	goals: Goal[];
	files: Map<string, TFile>;
	sections: Map<string, Map<string, string>>;
	texts: Map<string, string>;
	board: Board;
	projects: ProjectRef[];
	projectProgress: ProjectProgress[];
	/** 관련 업무 by goal id (a Main's includes its Sub Goals' projects and habits). */
	related: Map<string, RelatedItem[]>;
	/** 진척 기록 by goal path, in file order. */
	logs: Map<string, LogItem[]>;
	missing: MissingField[];
}

export class PinboardView extends ItemView {
	readonly plugin: MyLogsPlugin;
	/** The year shown; null = default (this year, else the latest year folder). */
	year: number | null = null;

	private rootEl!: HTMLElement;
	private layerEl!: HTMLElement;
	private data: Loaded | null = null;
	private loadSeq = 0;
	/** An inline editor is open; refreshes wait until it closes. */
	private editing = 0;
	private refreshPending = false;
	/** The goal shown in the detail panel. */
	private openId: string | null = null;
	/** Main Goals folded in the list. */
	private collapsed = new Set<string>();
	private showMissing = false;
	private creating = false;
	/** The sun rises on the first render and after a year change. */
	private animateNext = true;
	private map: { destroy(): void } | null = null;

	private scheduleRefresh = debounce(() => void this.refresh(), 250, true);

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PINBOARD;
	}

	getDisplayText(): string {
		return this.data?.year ? `Pinboard · ${this.data.year}` : "Pinboard";
	}

	getIcon(): string {
		return "target";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), year: this.year };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const y = (state as { year?: unknown } | null)?.year;
		if (typeof y === "number" && y !== this.year) {
			this.year = y;
			await this.refresh();
		}
		await super.setState(state, result);
	}

	/** 목록 or 전략 맵 — the last choice, kept in the plugin settings. */
	private get tab(): Tab {
		return this.plugin.settings.pinboardTab === "map" ? "map" : "list";
	}

	private setTab(t: Tab): void {
		if (this.plugin.settings.pinboardTab === t) return;
		this.plugin.settings.pinboardTab = t;
		// Remember the choice without refreshing every other MyLogs view.
		void this.plugin.saveData(this.plugin.settings);
	}

	// ── paths ──

	folder(): string {
		return cleanFolder(this.plugin.settings.pinboardFolder);
	}

	private inFolder(path: string): boolean {
		const f = this.folder();
		return path === f || path.startsWith(`${f}/`);
	}

	/** Files whose change shows up on the board: goal notes, project hubs, `Flywheel.md`. */
	private watches(path: string): boolean {
		if (this.inFolder(path)) return true;
		if (path === normalizePath(flywheelPath(this.plugin.settings.flywheelPath))) return true;
		return hubLocation(path, activeRoot(this.plugin), archiveRoot(this.plugin)) !== null;
	}

	/** Every goal note: `Goals/` (and older year folders). Goals are not cut by year. */
	private goalFiles(): TFile[] {
		const prefix = normalizePath(this.folder()) + "/";
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix) && isGoalNotePath(f.path.slice(prefix.length)) && !f.path.slice(prefix.length).split("/").some((p) => EXCLUDE_DIRS.has(p)));
	}

	private indexFile(): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(`${this.folder()}/${INDEX_FILE}`));
		return f instanceof TFile ? f : null;
	}

	// ── lifecycle ──

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-pinboard-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-pinboard" });
		mountAppNav(this);
		this.layerEl = this.contentEl.createDiv({ cls: "pb-detail-layer" });
		const viewport = this.contentEl.ownerDocument.defaultView?.visualViewport;
		if (viewport) {
			const keepVisible = () => this.layerEl.querySelector(".pb-inline-editor:focus-within")?.scrollIntoView({ block: "nearest" });
			viewport.addEventListener("resize", keepVisible);
			this.register(() => viewport.removeEventListener("resize", keepVisible));
		}
		if (Platform.isMobile) this.register(enableTouchMenus(this.contentEl));
		this.registerDomEvent(this.contentEl, "keydown", (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !this.openId) return;
			const t = e.target as HTMLElement | null;
			if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
			e.preventDefault();
			this.closeDetail();
		});
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (this.watches(f.path)) this.scheduleRefresh();
			}),
		);
		const onFile = (f: TAbstractFile, old?: string) => {
			if (this.watches(f.path) || (old && this.watches(old))) this.scheduleRefresh();
		};
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile(f, old)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile(f)));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.destroyMap();
		this.rootEl?.empty();
		this.layerEl?.empty();
	}

	/** Re-read the notes and re-render (unless an inline editor is open). */
	async refresh(): Promise<void> {
		if (!this.rootEl) return;
		if (this.editing > 0) {
			this.refreshPending = true;
			return;
		}
		this.refreshPending = false;
		const seq = ++this.loadSeq;
		const data = await this.loadData();
		if (seq !== this.loadSeq) return;
		this.data = data;
		this.render();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private loadProjects(): ProjectRef[] {
		const act = activeRoot(this.plugin);
		const arc = archiveRoot(this.plugin);
		const out: ProjectRef[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const loc = hubLocation(f.path, act, arc);
			if (!loc) continue;
			const p = parseProject(this.app.metadataCache.getFileCache(f)?.frontmatter, "", loc, f.path);
			if (p) out.push({ id: p.id, title: p.title, path: p.path, status: p.archived ? "완료" : p.status, goals: p.goals, archived: p.archived });
		}
		return out;
	}

	private async loadHabits(): Promise<HabitRef[]> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(flywheelPath(this.plugin.settings.flywheelPath)));
		if (!(f instanceof TFile)) return [];
		try {
			const els = parseFlywheel(await this.app.vault.cachedRead(f));
			return els.map((e) => ({ id: e.id, name: e.name, status: e.status, goals: goalIdsIn(e.fields["goal"] ?? "") }));
		} catch (err) {
			console.error("[MyLogs] Pinboard: Flywheel read failed", err);
			return [];
		}
	}

	private async loadData(): Promise<Loaded> {
		// The year is only the calendar's (the 「올해」 bar, new ids); goals run until they end.
		const year: number | null = new Date().getFullYear();
		const years: number[] = [];
		const goals: Goal[] = [];
		const files = new Map<string, TFile>();
		const sections = new Map<string, Map<string, string>>();
		const texts = new Map<string, string>();
		const logs = new Map<string, LogItem[]>();
		if (year !== null) {
			for (const f of this.goalFiles()) {
				const text = await this.app.vault.read(f);
				const parsed = parseFrontmatterText(text);
				const g = parseGoal(parsed.data, f.path);
				if (!g) continue;
				goals.push(g);
				files.set(f.path, f);
				sections.set(f.path, parseSections(parsed.body));
				texts.set(f.path, text);
				logs.set(
					f.path,
					progressEntries(text).map((entry) => ({ entry, line: parseProgressLine(entry.text) })),
				);
			}
		}
		const projectProgress = await loadProjectProgress(this.plugin);
		applyProjectProgress(goals, projectProgress);
		// 개인 / 회사 핀보드: a Sub Goal is on its Main's board.
		const mode = this.plugin.settings.sideMode;
		const mainScope = new Map(goals.filter((g) => g.type === "main-goal").map((g) => [g.id, g.scope]));
		const sideOf = (g: Goal) => asSide(g.type === "sub-goal" && mainScope.has(g.parent) ? mainScope.get(g.parent) : g.scope);
		// 끝난 목표: a Main that ended takes its Subs with it (unless 「끝난 목표」 is on).
		const mainEnded = new Map(goals.filter((g) => g.type === "main-goal").map((g) => [g.id, isEnded(g.status)]));
		const endedOf = (g: Goal) => (g.type === "main-goal" ? isEnded(g.status) : !!mainEnded.get(g.parent));
		const showEnded = this.plugin.settings.pinboardShowEnded;
		const board = buildBoard(goals.filter((g) => shows(sideOf(g), mode) && (showEnded || !endedOf(g))));
		const projects = this.loadProjects();
		const habits = await this.loadHabits();
		const related = new Map<string, RelatedItem[]>();
		const secsOf = (p: string) => sections.get(p) ?? new Map<string, string>();
		for (const s of board.subs) related.set(s.id, relatedOf(s, projects, habits, bulletItems(findSectionText(secsOf(s.path), "수단"))));
		for (const { main, subs } of board.cards) {
			const own = relatedOf(main, projects, habits, bulletItems(findSectionText(secsOf(main.path), "수단 (프로젝트·습관)", "수단")));
			related.set(
				main.id,
				mergeRelated(
					own,
					subs.map((s) => related.get(s.id) ?? []),
				),
			);
		}
		const missing = missingFields(board, secsOf);
		return { year, years, goals, files, sections, texts, board, projects, projectProgress, related, logs, missing };
	}

	private beginEdit(): void {
		this.editing++;
	}

	private endEdit(): void {
		this.editing = Math.max(0, this.editing - 1);
		if (this.editing === 0 && this.refreshPending) this.scheduleRefresh();
	}

	private goalById(id: string): Goal | null {
		return this.data?.goals.find((g) => g.id === id) ?? null;
	}

	// ── rendering ──

	private destroyMap(): void {
		if (!this.map) return;
		try {
			this.map.destroy();
		} catch (err) {
			console.error("[MyLogs] Pinboard map destroy failed", err);
		}
		this.map = null;
	}

	private render(): void {
		if (this.editing > 0) { this.refreshPending = true; return; }
		const root = this.rootEl;
		const d = this.data;
		const scroll = root.scrollTop;
		this.destroyMap();
		root.empty();
		root.toggleClass("is-map", this.tab === "map");
		root.toggleClass("pb-animate", this.animateNext);
		this.animateNext = false;
		if (!d) return;
		const page = root.createDiv({ cls: "pb-page" });
		if (d.year === null) {
			const empty = page.createDiv({ cls: "pb-empty" });
			empty.createDiv({ cls: "pb-empty-title", text: "Pinboard 연도 폴더가 없어요" });
			empty.createEl("code", { text: `${this.folder()}/<YYYY>/` });
			this.smallBtn(empty, "첫 목표 만들기", "템플릿으로 목표를 만들어요", () => this.createGoal(), "plus");
			this.renderDetail();
			return;
		}
		this.renderHeader(page, d);
		if (this.tab === "map") {
			const host = page.createDiv({ cls: "pb-map-host" });
			this.renderMap(host, d);
		} else {
			this.renderList(page, d);
			root.scrollTop = scroll;
		}
		this.renderDetail();
	}

	private renderHeader(page: HTMLElement, d: Loaded): void {
		const year = d.year!;
		const today = todayIso();
		const head = page.createDiv({ cls: "pb-header pb-hero" });
		head.createDiv({ cls: "pb-rays" });
		head.createDiv({ cls: "pb-sun" });
		head.createDiv({ cls: "pb-horizon" });
		const top = head.createDiv({ cls: "pb-head-top" });
		const titleEl = top.createDiv({ cls: "pb-head-title" });
		const mode = this.plugin.settings.sideMode;
		titleEl.createEl("h1", { text: mode === "전체" ? "Pinboard" : `${mode} 핀보드` });
		// The other board in one tap (the same switch as the top bar: Wall · Desk follow).
		const other: SideMode = mode === "회사" ? "개인" : "회사";
		const sw = titleEl.createEl("button", { cls: `pb-board-switch is-${other === "회사" ? "work" : "personal"}`, text: `${other} 핀보드 →`, attr: { type: "button" } });
		tip(sw, `${other} 모드로 바꿔요. Wall · Desk도 같이 바뀌어요`);
		sw.addEventListener("click", () => {
			if (this.canNavigate()) void this.plugin.setSideMode(other);
		});
		// 끝난 목표 (달성 · 부분 · 미달성 · 중단): hidden unless asked for.
		const ended = d.goals.filter((g) => g.type === "main-goal" && isEnded(g.status)).length;
		if (ended) {
			const on = this.plugin.settings.pinboardShowEnded;
			const b = titleEl.createEl("button", { cls: `pb-ended-toggle${on ? " is-on" : ""}`, text: `끝난 목표 ${ended}`, attr: { type: "button", "aria-pressed": String(on) } });
			tip(b, on ? "끝난 목표를 숨겨요" : "끝난 목표도 보여요");
			b.addEventListener("click", () => {
				if (!this.canNavigate()) return;
				this.plugin.settings.pinboardShowEnded = !on;
				void this.plugin.saveSettingsQuiet();
				void this.refresh();
			});
		}

		const tabs = top.createDiv({ cls: "pb-tabs", attr: { role: "tablist" } });
		const tabBtn = (id: Tab, label: string, icon: string) => {
			const b = tabs.createEl("button", {
				cls: `pb-tab${this.tab === id ? " is-active" : ""}`,
				attr: { type: "button", role: "tab", "aria-selected": String(this.tab === id) },
			});
			setIcon(b.createSpan({ cls: "pb-tab-icon" }), icon);
			b.createSpan({ text: label });
			b.addEventListener("click", () => {
				if (this.tab === id) return;
				this.setTab(id);
				this.render();
			});
		};
		tabBtn("list", "목록", "list");
		tabBtn("map", "전략 맵", "network");
		this.smallBtn(top, "목표 추가", "새 목표를 만들어요", () => this.createGoal(), "plus");

		const yi = yearInfo(year, today);
		const yb = head.createDiv({ cls: "pb-yearbar", attr: { title: `${year}.01.01 – ${year}.12.31` } });
		const track = yb.createDiv({ cls: "pb-yearbar-track" });
		track.createDiv({ cls: "pb-yearbar-fill" }).style.width = `${yi.pct.toFixed(2)}%`;
		let label: string;
		if (today < `${year}-01-01`) label = `${yi.daysLeft}일 뒤 시작`;
		else if (today > `${year}-12-31`) label = "한 해 마감";
		else label = `올해 ${Math.round(yi.pct)}% 지남 · ${yi.daysLeft}일 남음`;
		yb.createSpan({ cls: "pb-yearbar-label", text: label });

		const c = healthCounts(d.goals);
		const sum = head.createDiv({ cls: "pb-summary" });
		const chip = (cls: string, icon: string, text: string, n: number) => {
			const s = sum.createSpan({ cls: `pb-sum ${cls}`, attr: { title: `${text} ${n}개 (진행 중인 목표)` } });
			s.createSpan({ cls: "pb-sum-icon", text: icon });
			s.createEl("b", { text: String(n) });
			s.createSpan({ cls: "pb-sum-label", text });
		};
		chip("is-on-track", HEALTH_ICON["on-track"], HEALTH_KO["on-track"], c["on-track"]);
		chip("is-at-risk", HEALTH_ICON["at-risk"], HEALTH_KO["at-risk"], c["at-risk"]);
		chip("is-off-track", HEALTH_ICON["off-track"], HEALTH_KO["off-track"], c["off-track"]);
		chip("is-none", HEALTH_ICON[""], HEALTH_KO[""], c.none);
		sum.createSpan({ cls: "pb-sum-sep" });
		sum.createSpan({ cls: "pb-sum is-plain", text: `목표 ${d.board.mains.length} · 측정 기준 ${d.board.subs.length}` });
		const miss = sum.createEl("button", {
			cls: `pb-sum pb-sum-missing${d.missing.length ? " is-warn" : ""}${this.showMissing ? " is-open" : ""}`,
			attr: { type: "button", "aria-expanded": String(this.showMissing) },
		});
		miss.createSpan({ text: "채울 칸 " });
		miss.createEl("b", { text: String(d.missing.length) });
		miss.addEventListener("click", () => {
			this.showMissing = !this.showMissing;
			if (this.showMissing) this.setTab("list");
			this.render();
		});
	}

	// ── 목록 ──

	private renderList(page: HTMLElement, d: Loaded): void {
		const today = todayIso();
		if (this.showMissing) this.renderMissing(page, d);
		const list = page.createDiv({ cls: "pb-list", attr: { role: "treegrid", "aria-label": "목표" } });
		const head = list.createDiv({ cls: "pb-row is-head", attr: { role: "row" } });
		for (const [cls, label] of [
			["pb-c-title", "목표"],
			["pb-c-prog", "진행"],
			["pb-c-val", "현재 → 목표"],
			["pb-c-due", "기한"],
			["pb-c-rel", "관련"],
		]) head.createDiv({ cls: `pb-cell ${cls}`, text: label, attr: { role: "columnheader" } });

		for (const { main, subs } of d.board.cards) {
			this.mainRow(list, main, subs, d);
			if (this.collapsed.has(main.id)) continue;
			subs.forEach((s) => this.subRow(list, s, d, today, true));
			if (!subs.length) list.createDiv({ cls: "pb-row is-sub is-placeholder" }).createDiv({ cls: "pb-cell pb-c-title pb-muted", text: "측정 기준(Sub Goal)이 아직 없어요" });
		}
		if (d.board.orphans.length) {
			list.createDiv({ cls: "pb-row is-group" }).createDiv({ cls: "pb-cell pb-c-title", text: "상위 목표를 찾지 못한 Sub Goal — parent가 Main Goal id와 맞지 않아요" });
			d.board.orphans.forEach((s) => this.subRow(list, s, d, today, false));
		}
		if (!d.board.cards.length && !d.board.orphans.length) {
			list.createDiv({ cls: "pb-row is-placeholder" }).createDiv({
				cls: "pb-cell pb-c-title pb-muted",
				text: "진행 중인 목표가 없어요. 위의 「목표 추가」에서 시작하세요.",
			});
		}

		const updated = d.goals.map((g) => g.updated).filter((u) => /^\d{4}-\d{2}-\d{2}/.test(u)).sort();
		page.createDiv({ cls: "pb-foot", text: `마지막 갱신 ${updated[updated.length - 1] ?? "미정"}` });
	}

	private renderMissing(page: HTMLElement, d: Loaded): void {
		const box = page.createDiv({ cls: "pb-missing" });
		if (!d.missing.length) {
			box.createDiv({ cls: "pb-missing-title", text: "모든 칸이 채워져 있어요" });
			return;
		}
		tip(box.createDiv({ cls: "pb-missing-title", text: `채워 넣을 칸 ${d.missing.length}개` }), "비어 있는 값은 지어내지 않고 그대로 비워 두었어요. 적으면 바로 반영돼요.");
		const ul = box.createEl("ul");
		for (const m of d.missing) {
			const b = ul.createEl("li").createEl("button", { cls: "pb-linkish", attr: { type: "button" } });
			b.createSpan({ cls: "pb-gid", text: m.id });
			b.appendText(` ${m.title} — `);
			b.createEl("b", { text: m.field });
			b.addEventListener("click", () => this.openGoal(m.id));
		}
	}

	private rowShell(list: HTMLElement, g: Goal, cls: string): HTMLElement {
		const row = list.createDiv({
			cls: `pb-row ${cls} st-${g.status}${this.openId === g.id ? " is-open" : ""}`,
			attr: { role: "row", tabindex: "0", "data-goal": g.id, "aria-label": g.title },
		});
		row.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".pb-fold")) return;
			this.openGoal(g.id);
		});
		row.addEventListener("keydown", (e) => {
			if ((e.key === "Enter" || e.key === " ") && e.target === row) {
				e.preventDefault();
				this.openGoal(g.id);
			}
		});
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.goalMenu(e, g);
		});
		return row;
	}

	private mainRow(list: HTMLElement, m: Goal, subs: Goal[], d: Loaded): void {
		const row = this.rowShell(list, m, "is-main");
		const t = row.createDiv({ cls: "pb-cell pb-c-title", attr: { role: "gridcell" } });
		const folded = this.collapsed.has(m.id);
		const fold = t.createEl("button", {
			cls: "pb-fold clickable-icon",
			attr: { type: "button", "aria-label": folded ? "펼치기" : "접기", "aria-expanded": String(!folded) },
		});
		setIcon(fold, folded ? "chevron-right" : "chevron-down");
		fold.addEventListener("click", (e) => {
			e.stopPropagation();
			if (folded) this.collapsed.delete(m.id);
			else this.collapsed.add(m.id);
			this.render();
		});
		this.hdot(t, m);
		t.createSpan({ cls: "pb-row-title", text: m.title });
		if (m.area) t.createSpan({ cls: "pb-area-tag", text: m.area });
		this.statusBadge(t, m);
		const r = displayMainProgress(m, subs);
		this.progressCell(row, r.progress);
		row.createDiv({ cls: "pb-cell pb-c-val pb-muted", text: `${r.subAchieved}/${r.subTotal} 달성`, attr: { role: "gridcell" } });
		row.createDiv({ cls: "pb-cell pb-c-due pb-muted", text: m.period || "", attr: { role: "gridcell" } });
		this.relCell(row, d.related.get(m.id) ?? []);
	}

	private subRow(list: HTMLElement, s: Goal, d: Loaded, today: string, nested: boolean): void {
		const row = this.rowShell(list, s, `is-sub${nested ? "" : " is-orphan"}`);
		const t = row.createDiv({ cls: "pb-cell pb-c-title", attr: { role: "gridcell" } });
		this.hdot(t, s);
		t.createSpan({ cls: "pb-row-title", text: s.title });
		this.statusBadge(t, s);
		this.progressCell(row, displaySubProgress(s));
		row.createDiv({ cls: "pb-cell pb-c-val", text: this.curTarget(s), attr: { role: "gridcell" } });
		const dd = dday(s.due, today);
		const ended = isEnded(s.status);
		row.createDiv({
			cls: `pb-cell pb-c-due${!ended && dd.cls ? ` is-${dd.cls}` : ""}`,
			text: ended ? (s.due ? s.due.replace(/-/g, ".") : "—") : dd.big,
			attr: { role: "gridcell", title: dd.small },
		});
		this.relCell(row, d.related.get(s.id) ?? []);
	}

	private progressCell(row: HTMLElement, p: number | null): void {
		const c = row.createDiv({ cls: "pb-cell pb-c-prog", attr: { role: "gridcell" } });
		this.bar(c, p);
		c.createSpan({ cls: "pb-pct", text: p === null ? "미정" : `${Math.round(p)}%` });
	}

	private relCell(row: HTMLElement, rel: RelatedItem[]): void {
		const c = row.createDiv({ cls: "pb-cell pb-c-rel", attr: { role: "gridcell" } });
		const n = (k: RelatedItem["kind"]) => rel.filter((r) => r.kind === k).length;
		c.setAttr("title", `프로젝트 ${n("project")} · 습관 ${n("habit")} · 메모 ${n("memo")}`);
		if (!rel.length) {
			c.createSpan({ cls: "pb-muted", text: "—" });
			return;
		}
		const b = c.createSpan({ cls: "pb-rel-count" });
		setIcon(b.createSpan({ cls: "pb-rel-icon" }), "link-2");
		b.createSpan({ text: String(rel.length) });
		if (rel.some((r) => r.oneSided || r.broken)) c.createSpan({ cls: "pb-warn-dot", attr: { "aria-label": "한쪽만 연결된 항목이 있어요" } });
	}

	// ── 전략 맵 ──

	private mapInput(d: Loaded): MapInput {
		const toSub = (s: Goal): MapSub => {
			const p = displaySubProgress(s);
			return {
				id: s.id,
				title: s.title,
				status: s.status,
				health: s.health,
				progress: p === null ? null : Math.round(p),
				current: s.current,
				target: s.target,
				unit: s.unit,
				due: s.due,
				related: (d.related.get(s.id) ?? []).map((r) => ({ kind: r.kind, contributes: s.progressSource === "projects" && r.kind === "project" && !!r.id && s.projectIds.includes(r.id) && projectWeight(s, r.id) > 0, label: r.label, path: r.path, oneSided: r.oneSided || r.broken || undefined })),
			};
		};
		return {
			year: d.year!,
			title: this.plugin.settings.sideMode === "전체" ? "내 목표" : `${this.plugin.settings.sideMode} 목표`,
			mains: d.board.cards.map(({ main, subs }) => ({
				id: main.id,
				title: main.title,
				area: main.area,
				status: main.status,
				health: main.health,
				progress: displayMainProgress(main, subs).progress,
				subs: subs.map(toSub),
			})),
			orphans: d.board.orphans.map(toSub),
		};
	}

	private renderMap(host: HTMLElement, d: Loaded): void {
		try {
			this.map = renderStrategyMap(host, this.mapInput(d), {
				openGoal: (id) => this.openGoal(id),
				openFile: (path) => this.openPath(path),
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard strategy map failed", err);
			host.createDiv({ cls: "pb-empty", text: "전략 맵을 그리지 못했어요. 목록에서 볼 수 있어요." });
		}
	}

	// ── small pieces ──

	private hdot(parent: HTMLElement, g: Goal): HTMLElement {
		const ended = isEnded(g.status);
		const label = ended ? (STATUS_KO[g.status] ?? g.status) : HEALTH_KO[g.health];
		return parent.createSpan({ cls: `pb-hdot ${ended ? `is-ended st-${g.status}` : `is-${g.health || "none"}`}`, attr: { "aria-label": label, title: label } });
	}

	private statusBadge(parent: HTMLElement, g: Goal): void {
		if (g.status === "active") return;
		parent.createSpan({ cls: `pb-badge st-${g.status}`, text: STATUS_KO[g.status] ?? g.status });
	}

	private bar(parent: HTMLElement, p: number | null): HTMLElement {
		const b = parent.createDiv({ cls: `pb-pbar${p === null ? " is-unknown" : ""}` });
		if (p !== null) b.createDiv({ cls: "pb-pbar-fill" }).style.width = `${Math.max(0, Math.min(100, p)).toFixed(1)}%`;
		return b;
	}

	/** `100 → 95 kg`, `베타 사용자 5명 → 첫 결제` (empty values as `?` / `—`). */
	private curTarget(s: Goal): string {
		if (s.measure === "metric") {
			const c = fmtVal(s.current, "")?.[0] ?? "?";
			const t = fmtVal(s.target, "")?.[0] ?? "?";
			return `${c} → ${t}${s.unit ? ` ${s.unit}` : ""}`;
		}
		return `${s.current || "—"} → ${s.target || "—"}`;
	}

	private openPath(path: string, newLeaf: PaneType | boolean = false): void {
		if (!this.canNavigate()) return;
		if (hubLocation(path, activeRoot(this.plugin), archiveRoot(this.plugin))) {
			void this.plugin.openProjectAt(path); return;
		}
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (f instanceof TFile) void this.app.workspace.getLeaf(newLeaf).openFile(f);
		else new Notice(`MyLogs: ${path}을 찾지 못했어요.`);
	}

	/** Plain text with `[[wikilinks]]` as clickable links (resolved from `source`). */
	private inline(parent: HTMLElement, text: string, source: string): void {
		let last = 0;
		for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
			if (m.index! > last) parent.appendText(text.slice(last, m.index));
			const target = m[1].trim();
			const a = parent.createEl("a", { cls: "internal-link", text: (m[2] ?? target.split("/").pop() ?? target).trim(), href: "#" });
			a.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				void this.app.workspace.openLinkText(target, source, Keymap.isModEvent(e));
			});
			last = m.index! + m[0].length;
		}
		if (last < text.length) parent.appendText(text.slice(last));
	}

	// ── 상세 패널 ──

	async openGoalAt(id: string): Promise<boolean> {
		if (!this.canNavigate()) return false;
		await this.refresh();
		if (!this.goalById(id)) return false;
		this.openGoal(id); return true;
	}

	openGoal(id: string): void {
		if (!this.canNavigate()) return;
		if (!this.goalById(id)) return;
		this.openId = id;
		this.rootEl.querySelectorAll(".pb-row.is-open").forEach((el) => el.removeClass("is-open"));
		this.rootEl.querySelector(`.pb-row[data-goal="${CSS.escape(id)}"]`)?.addClass("is-open");
		this.renderDetail(true);
	}

	/** 루미: the goal open in the detail panel. */
	lumiItem(): string | undefined {
		return this.openId ? this.goalById(this.openId)?.title : undefined;
	}

	private closeDetail(): void {
		if (!this.canNavigate()) return;
		this.openId = null;
		this.rootEl.querySelectorAll(".pb-row.is-open").forEach((el) => el.removeClass("is-open"));
		this.layerEl.removeClass("is-open");
		this.layerEl.empty();
	}

	private renderDetail(fresh = false): void {
		if (this.editing > 0) { this.refreshPending = true; return; }
		const layer = this.layerEl;
		const prevScroll = fresh ? 0 : (layer.querySelector(".pb-d-scroll")?.scrollTop ?? 0);
		const wasOpen = layer.hasClass("is-open");
		layer.empty();
		const d = this.data;
		const g = this.openId ? this.goalById(this.openId) : null;
		if (!d || !g) {
			this.openId = null;
			layer.removeClass("is-open");
			return;
		}
		layer.addClass("is-open");
		layer.toggleClass("is-entering", !wasOpen);
		const scrim = layer.createDiv({ cls: "pb-scrim" });
		scrim.addEventListener("click", () => this.closeDetail());
		const panel = layer.createDiv({ cls: "pb-detail", attr: { role: "dialog", "aria-label": g.title, tabindex: "-1" } });
		const today = todayIso();
		const main = g.type === "main-goal";
		const parent = main ? null : (d.board.mains.find((m) => m.id === g.parent) ?? null);
		const subs = main ? d.board.subs.filter((s) => s.parent === g.id) : [];

		// top bar
		const topBar = panel.createDiv({ cls: "pb-d-bar" });
		const crumb = topBar.createDiv({ cls: "pb-d-crumb" });
		crumb.createSpan({ cls: "pb-d-kind", text: main ? "Main Goal" : "Sub Goal" });
		if (parent) {
			crumb.createSpan({ cls: "pb-d-sep", text: "·" });
			const a = crumb.createEl("button", { cls: "pb-linkish", text: parent.title, attr: { type: "button" } });
			a.addEventListener("click", () => this.openGoal(parent.id));
		}
		const acts = topBar.createDiv({ cls: "pb-d-acts" });
		const more = acts.createEl("button", { cls: "clickable-icon pb-d-btn", attr: { type: "button", "aria-label": "메뉴" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (e) => this.goalMenu(e, g));
		const close = acts.createEl("button", { cls: "clickable-icon pb-d-btn", attr: { type: "button", "aria-label": "닫기 (Esc)" } });
		setIcon(close, "x");
		close.addEventListener("click", () => this.closeDetail());

		const scroll = panel.createDiv({ cls: "pb-d-scroll" });
		const grid = scroll.createDiv({ cls: "pb-d-grid" });
		const body = grid.createDiv({ cls: "pb-d-main" });
		const side = grid.createDiv({ cls: "pb-d-side" });

		// title + pickers
		const h = body.createDiv({ cls: "pb-d-title", attr: { role: "heading", "aria-level": "2" } });
		this.hdot(h, g);
		this.inlineField(h, g, "title", { display: g.title });
		const pickers = body.createDiv({ cls: "pb-d-pickers" });
		this.statusPicker(pickers, g);
		this.healthPicker(pickers, g);

		const logs = d.logs.get(g.path) ?? [];
		const newest = newestFirst(logs.map((l) => ({ ...l, date: l.line.date })));

		// latest update
		if (newest.length) this.updateView(this.card(body, "최근 업데이트"), newest[0].line, g, true);

		// progress
		const pc = this.card(body, "진행");
		if (main) this.mainProgress(pc, g, subs);
		else
			this.subProgress(
				pc,
				g,
				logs.map((l) => l.line),
				today,
			);
		if(!main){
			// 수치 목표의 결과 기록은 「진척 기록 · 업데이트 추가」 하나로 (같은 입력 폼).
			if(g.measure==="milestone"&&!isEnded(g.status)) this.smallBtn(pc,"달성 확인","조건을 실제로 달성했으면 눌러요. 진척 기록에도 한 줄 남아요.",async()=>{
				const ok=await askForm(this.app,{title:"하위 목표 달성 확인",desc:`「${g.target||g.title}」 조건을 실제로 달성했나요? 연결된 프로젝트 완료와는 별도로 기록해요.`,fields:[],cta:"달성으로 기록"});
				if(ok)await this.writeGoal(g,{status:"achieved",log:{date:todayIso(),text:"사용자가 달성 조건 충족을 확인",verify:"보고됨",evidence:"MyLogs 플러그인, 사용자 확인"}});
			},"check");
		}

		// description
		const secs = d.sections.get(g.path) ?? new Map<string, string>();
		const desc = this.card(body, "설명");
		const descPart = (field: InlineGoalField, label: string) => {
			const box = desc.createDiv({ cls: "pb-d-desc" });
			box.createDiv({ cls: "pb-d-label", text: label });
			this.inlineField(box, g, field, { multiline: true, label });
		};
		if (main) {
			descPart("why", "왜 이 목표인가");
			descPart("vision", "달성한 모습");
		} else {
			descPart("criteria", "달성 기준");
			descPart("memo", "메모");
		}
		const retro = bulletItems(findSectionText(secs, "종료 회고")).filter((x) => !/^[^:]+:\s*$/.test(x));
		if (retro.length || isEnded(g.status)) descPart("retro", "종료 회고");

		// 개인 / 회사 (Main and its Subs together): the goal moves to the other board.
		if (main) {
			const now = asSide(g.scope);
			const to: Side = now === "회사" ? "개인" : "회사";
			const sw = this.card(body, `${now} 목표`);
			this.smallBtn(sw, `${to} 목표로 바꾸기`, `하위 목표도 함께 ${to} 핀보드로 옮겨요`, async () => {
				if (!this.canNavigate()) return;
				try {
					await saveGoalScope(this.plugin, g.id, to, todayIso());
					new Notice(`「${g.title}」을(를) ${to} 목표로 바꿨어요.`);
					await this.refresh();
				} catch (e) {
					new Notice(e instanceof Error ? e.message : String(e));
				}
			}, "arrow-left-right");
		}

		// Sub list
		if (main) {
			const sc = this.card(body, `Sub Goal · ${subs.length}`);
			if (!isEnded(g.status)) this.smallBtn(sc, "하위 목표 추가", "측정 기준과 실행 공간을 함께 만들어요", () => this.createGoal(g), "plus");
			if (!subs.length) sc.createDiv({ cls: "pb-muted", text: "측정 기준(Sub Goal)이 아직 없어요." });
			for (const s of subs) {
				const r = sc.createDiv({ cls: `pb-d-subrow st-${s.status}`, attr: { role: "button", tabindex: "0" } });
				this.hdot(r, s);
				r.createSpan({ cls: "pb-row-title", text: s.title });
				this.statusBadge(r, s);
				if (s.weight !== null) r.createSpan({ cls: "pb-weight", text: `×${fmtNum(s.weight)}`, attr: { title: "가중치" } });
				const p = displaySubProgress(s);
				const pw = r.createDiv({ cls: "pb-d-subprog" });
				this.bar(pw, p);
				pw.createSpan({ cls: "pb-pct", text: p === null ? "미정" : `${Math.round(p)}%` });
				r.addEventListener("click", () => this.openGoal(s.id));
				r.addEventListener("keydown", (e) => {
					if (e.key === "Enter") this.openGoal(s.id);
				});
			}
		}

		// 관련 업무
		this.relatedCard(body, d.related.get(g.id) ?? [], g);

		// 진척 기록
		const lc = this.card(body, "진척 기록");
		const addBtn = lc.createEl("button", { cls: "pb-add-update", attr: { type: "button" } });
		setIcon(addBtn.createSpan({ cls: "pb-btn-icon" }), "plus");
		addBtn.appendText("업데이트 추가");
		const formHost = lc.createDiv();
		addBtn.addEventListener("click", () => {
			if (!this.canNavigate()) return;
			addBtn.hide();
			this.updateForm(formHost, g, () => addBtn.show());
		});
		if (!newest.length) lc.createDiv({ cls: "pb-muted", text: "기록이 없어요." });
		const tl = lc.createDiv({ cls: "pb-timeline" });
		for (const it of newest) {
			const item = tl.createDiv({ cls: "pb-tl-item", attr: { title: "오른쪽 클릭: 수정 · 삭제" } });
			this.updateView(item, it.line, g, false);
			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.logMenu(e, g, it.entry);
			});
		}

		// side: what the goal is about. Settings and record details fold away under 「세부 설정」.
		const prop = (into: HTMLElement, k: string, fill: (dd: HTMLElement) => void) => {
			into.createEl("dt", { text: k });
			fill(into.createEl("dd"));
		};
		if (main) {
			// 기간·영역 rarely change and say little at a glance: folded away.
			const more = side.createEl("details", { cls: "pb-d-more" });
			more.createEl("summary", { text: "세부 설정" });
			const dlm = more.createEl("dl", { cls: "pb-d-props" });
			prop(dlm, "기간", (x) => this.inlineField(x, g, "period"));
			prop(dlm, "영역", (x) => this.inlineField(x, g, "area"));
		}
		const dl = main ? null : side.createEl("dl", { cls: "pb-d-props" });
		if (dl)
			prop(dl, "기한", (x) => {
				this.inlineField(x, g, "due", { type: "date" });
				if (!g.due) return;
				const dd = dday(g.due, today);
				if (!isEnded(g.status)) x.createSpan({ cls: `pb-dd${dd.cls ? ` is-${dd.cls}` : ""}`, text: ` ${dd.big}` });
			});
		if (dl && parent)
			prop(dl, "상위 목표", (x) => {
				const a = x.createEl("button", { cls: "pb-linkish", text: parent.title, attr: { type: "button" } });
				a.addEventListener("click", () => this.openGoal(parent.id));
			});
		if (dl) prop(dl, "영역", (x) => this.inlineField(x, g, "area"));
		if (!main) {
			const more = side.createEl("details", { cls: "pb-d-more" });
			more.createEl("summary", { text: "세부 설정" });
			const dl2 = more.createEl("dl", { cls: "pb-d-props" });
			prop(dl2, "측정", (x) => this.inlineField(x, g, "measure", { display: MEASURE_KO[g.measure] ?? g.measure, choices: [["", "미정"], ["metric", "수치"], ["milestone", "이정표"]] }));
			prop(dl2, "종류", (x) => this.inlineField(x, g, "kind", { display: KIND_KO[g.kind] ?? g.kind, choices: [["", "미정"], ["outcome", "결과"], ["performance", "수행"]] }));
			prop(dl2, "단위", (x) => this.inlineField(x, g, "unit"));
			prop(dl2, "가중치", (x) => this.inlineField(x, g, "weight", { display: g.weight === null ? "1 (기본)" : fmtNum(g.weight) }));
			this.progressSettings(more, g);
		}

		scroll.scrollTop = prevScroll;
		if (fresh) panel.focus({ preventScroll: true });
	}

	private card(parent: HTMLElement, title: string): HTMLElement {
		const c = parent.createDiv({ cls: "pb-card" });
		c.createDiv({ cls: "pb-card-title", text: title });
		return c;
	}

	/** One 진척 기록 line: health · date · value · 보고됨/확인됨, the text, then 근거. */
	private updateView(parent: HTMLElement, l: ProgressLine, g: Goal, big: boolean): void {
		const wrap = parent.createDiv({ cls: `pb-upd${big ? " is-big" : ""}` });
		const meta = wrap.createDiv({ cls: "pb-upd-meta" });
		if (l.health) {
			const hs = meta.createSpan({ cls: `pb-hpill is-${l.health}` });
			hs.createSpan({ cls: `pb-hdot is-${l.health}` });
			hs.appendText(HEALTH_KO[l.health]);
		}
		meta.createSpan({ cls: "pb-upd-date", text: l.date ? l.date.replace(/-/g, ".") : "날짜 없음" });
		if (l.valueRaw) meta.createSpan({ cls: "pb-upd-val", text: `${l.value !== null ? fmtNum(l.value) : l.valueRaw}${g.unit ? ` ${g.unit}` : ""}` });
		if (l.verify) meta.createSpan({ cls: `pb-verify${l.verify === "확인됨" ? " is-checked" : ""}`, text: l.verify });
		this.inline(wrap.createDiv({ cls: "pb-upd-text" }), l.text || "(내용 없음)", g.path);
		if (l.evidence) {
			const ev = wrap.createDiv({ cls: "pb-upd-ev" });
			ev.appendText("근거: ");
			this.inline(ev, l.evidence, g.path);
		}
	}

	private statusPicker(parent: HTMLElement, g: Goal): void {
		const b = parent.createEl("button", {
			cls: `pb-status-btn st-${g.status}`,
			attr: { type: "button", "aria-label": `상태: ${STATUS_KO[g.status] ?? g.status} · 바꾸기` },
		});
		b.createSpan({ text: STATUS_KO[g.status] ?? g.status });
		setIcon(b.createSpan({ cls: "pb-caret" }), "chevron-down");
		b.addEventListener("click", (e) => {
			if (!this.canNavigate()) return;
			const menu = new Menu();
			const add = (st: string) =>
				menu.addItem((it) =>
					it
						.setTitle(STATUS_KO[st])
						.setChecked(st === g.status)
						.onClick(() => {
							if (st !== g.status) void this.writeGoal(g, { status: st });
						}),
				);
			add("active");
			add("paused");
			menu.addSeparator();
			for (const st of ["achieved", "partial", "missed", "dropped"]) add(st);
			menu.showAtMouseEvent(e);
		});
	}

	private healthPicker(parent: HTMLElement, g: Goal): void {
		const seg = parent.createDiv({ cls: "pb-health-seg", attr: { role: "radiogroup", "aria-label": "health" } });
		if (isEnded(g.status)) {
			seg.addClass("is-disabled");
			seg.createSpan({ cls: "pb-muted", text: "종료된 목표는 health를 비워요" });
			return;
		}
		for (const h of [...HEALTHS, ""] as string[]) {
			const on = g.health === h;
			const b = seg.createEl("button", { cls: `pb-hseg is-${h || "none"}${on ? " is-active" : ""}`, attr: { type: "button", role: "radio", "aria-checked": String(on) } });
			b.createSpan({ cls: `pb-hdot is-${h || "none"}` });
			b.createSpan({ text: HEALTH_KO[h] });
			b.addEventListener("click", () => {
				if (!this.canNavigate()) return;
				if (!on) void this.writeGoal(g, { health: h });
			});
		}
	}

	private mainProgress(pc: HTMLElement, g: Goal, subs: Goal[]): void {
		const r = displayMainProgress(g, subs);
		const top = pc.createDiv({ cls: "pb-bignum" });
		top.createEl("b", { text: `${r.progress}%` });
		top.createSpan({ cls: "pb-muted", text: `${r.subAchieved}/${r.subTotal} 달성` });
		this.bar(pc, r.progress).addClass("is-big");
		const weighted = subs.some((s) => s.weight !== null);
		tip(top, `Sub Goal 진행률의 ${weighted ? "가중 " : ""}평균 (중단 제외, 미정은 0)`);
	}

	private subProgress(pc: HTMLElement, s: Goal, lines: ProgressLine[], today: string): void {
		const p = displaySubProgress(s);
		const top = pc.createDiv({ cls: "pb-bignum" });
		top.createEl("b", { text: p === null ? "미정" : `${Math.round(p)}%` });
		if (s.progressSource === "projects") {
			tip(top.createSpan({ cls: "pb-src-chip", text: "프로젝트 기준" }), "연결된 프로젝트의 마일스톤 달성으로 자동 계산해요. 아래 실제 값과는 따로예요. 계산 방식은 오른쪽 「세부 설정」에서 바꿔요.");
		} else tip(top, "현재 값으로 계산해요");
		const path = pc.createDiv({ cls: "pb-inline-metrics" });
		const metric = (field: InlineGoalField, label: string) => {
			const box = path.createDiv({ cls: "pb-inline-metric" });
			box.createDiv({ cls: "pb-d-label", text: label });
			this.inlineField(box, s, field, { label });
		};
		if (s.measure === "metric") metric("baseline", "시작 값");
		metric("current", "현재 값");
		metric("target", s.measure === "metric" ? "목표 값" : "달성 조건");
		this.bar(pc, p).addClass("is-big");
		const hint = paceHint(s, today);
		if (hint) {
			const n = pc.createDiv({ cls: "pb-note" });
			n.appendText(`목표까지 ${hint.remain}${s.unit}`);
			if (hint.perWeek) n.appendText(` · 남은 ${hint.weeks}주 동안 주 ${hint.perWeek}${s.unit}씩`);
		}
		if (s.measure === "metric") this.chart(pc, s, lines, today);
	}

 private progressSettings(parent: HTMLElement, g: Goal): void {
  const box = parent.createDiv({ cls: "pb-rollup" });
  tip(box.createDiv({ cls: "pb-rollup-mode", text: g.progressSource === "projects" ? "프로젝트 마일스톤으로 자동 계산" : "실제 결과값으로 계산" }), g.progressSource === "projects" ? "프로젝트 마일스톤 달성을 비중대로 합쳐 진척을 계산해요. 실제 결과와 달성 확정은 따로예요." : "현재 값으로 진척을 계산해요.");
  const rows = contributions(g, this.data?.projectProgress ?? []);
  for (const row of rows) box.createDiv({ cls: "pb-rollup-row", text: `${row.title} · ${row.done}/${row.total} · ${Math.round(row.progress)}% × 비중 ${Math.round(row.share * 10) / 10}%${row.issue ? ` · ⚠ ${row.issue}` : ""}` });
  if (g.progressSource === "projects" && !rows.length) box.createDiv({ cls: "pb-note", text: "연결된 프로젝트가 없어 0%예요. 아래에서 프로젝트를 연결해 주세요." });
  this.smallBtn(box, "집계 방식·비중 수정", "기본은 동일 비중, 중요할수록 큰 숫자를 입력해요", async () => {
   if (!this.canNavigate()) return;
   this.beginEdit(); box.empty();
   const form = box.createEl("form", { cls: "pb-inline-editor" });
   const select = form.createEl("select", { attr: { "aria-label": "진척 집계 방식" } });
   select.createEl("option", { attr: { value: "projects" }, text: "프로젝트 마일스톤 자동 집계" });
   select.createEl("option", { attr: { value: "manual" }, text: "실제 결과값으로 계산" });
   select.value = g.progressSource ?? "manual";
   tip(select, "비중: 모두 1이면 같은 비중 · 3과 1이면 75%와 25% · 0은 기여 제외");
   const inputs = rows.map(row => {
    const label = form.createEl("label", { cls: "pb-rollup-weight" }); label.createSpan({ text: row.title });
    const input = label.createEl("input", { attr: { type: "number", value: String(row.weight), min: "0", step: "any", inputmode: "decimal", "aria-label": `${row.title} 비중` } });
    return { id: row.id, input };
   });
   const error = form.createDiv({ cls: "pb-inline-error", attr: { role: "alert" } });
   const save = form.createEl("button", { text: "저장", attr: { type: "submit" } });
   const cancel = form.createEl("button", { text: "취소", attr: { type: "button" } });
   let saving = false;
   const close = () => { if (saving) return; this.endEdit(); void this.refresh(); };
   cancel.onclick = close;
   form.onkeydown = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };
   form.onsubmit = async e => {
    e.preventDefault(); if (saving) return;
    saving = true; save.disabled = true; cancel.disabled = true;
    try {
     if (inputs.some(x => !x.input.value.trim())) throw new Error("비중을 입력해 주세요.");
     await saveProgressSettings(this.plugin, g, this.data!.texts.get(g.path)!, select.value, inputs.map(x => `${x.id}=${x.input.value}`), todayIso());
     saving = false; this.endEdit(); await this.refresh();
    } catch (e) { error.setText(String(e)); saving = false; save.disabled = false; cancel.disabled = false; }
   };
   select.focus();
  });
 }

	private canNavigate(): boolean {
		if (this.editing === 0) return true;
		new Notice("입력 중인 항목을 먼저 저장하거나 취소해 주세요.");
		this.layerEl?.querySelector<HTMLElement>(".pb-inline-editor input, .pb-inline-editor textarea, .pb-inline-editor select")?.focus({ preventScroll: true });
		return false;
	}

	/** Click the displayed value; edit in exactly that place, with explicit save/cancel. */
	private inlineField(parent: HTMLElement, g: Goal, field: InlineGoalField, o: { label?: string; display?: string; multiline?: boolean; type?: string; choices?: [string, string][] } = {}): void {
		const text = this.data?.texts.get(g.path) ?? "", initial = inlineValue(text, field), expected = inlineToken(text, field);
		const label = o.label ?? INLINE_LABELS[field];
		const host = parent.createDiv({ cls: `pb-inline-field pb-field-${field}`, attr: { "data-field": field } });
		const trigger = host.createEl("button", { cls: `pb-inline-value${o.multiline ? " is-multiline" : ""}${!initial ? " is-empty" : ""}`, text: o.display || initial || (o.multiline ? "내용 추가" : "미정"), attr: { type: "button", "aria-label": `${label} 수정`, title: `${label} · 눌러서 수정` } });
		trigger.addEventListener("click", () => {
			if (!this.canNavigate()) return;
			this.beginEdit(); host.addClass("is-editing"); trigger.hide();
			const form = host.createEl("form", { cls: "pb-inline-editor", attr: { "aria-label": `${label} 편집` } });
			const lab = form.createEl("label");
			lab.createSpan({ cls: "pb-inline-caption", text: label });
			let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
			if (o.choices) {
				input = lab.createEl("select");
				for (const [value, name] of o.choices) input.createEl("option", { text: name, attr: { value } });
			} else if (o.multiline) input = lab.createEl("textarea", { attr: { rows: "4" } });
			else input = lab.createEl("input", { attr: { type: o.type ?? "text", inputmode: field === "weight" || (g.measure === "metric" && ["baseline", "current", "target"].includes(field)) ? "decimal" : "text", enterkeyhint: "done" } });
			input.value = initial; input.setAttr("aria-label", label);
			const error = form.createDiv({ cls: "pb-inline-error", attr: { role: "alert" } });
			const actions = form.createDiv({ cls: "pb-inline-actions" });
			const submit = actions.createEl("button", { cls: "mod-cta", text: "저장", attr: { type: "submit" } });
			const cancel = actions.createEl("button", { text: "취소", attr: { type: "button" } });
			let closed = false, saving = false;
			const finish = async () => {
				if (closed) return; closed = true;
				form.remove(); host.removeClass("is-editing"); trigger.show(); this.endEdit();
				await this.refresh();
				this.layerEl.querySelector<HTMLButtonElement>(`[data-field="${field}"] > button`)?.focus({ preventScroll: true });
			};
			cancel.addEventListener("click", () => { if (!saving) void finish(); });
			form.addEventListener("keydown", e => {
				if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!saving) void finish(); }
				else if (e.key === "Enter" && !e.isComposing && (!o.multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
			});
			form.addEventListener("submit", async e => {
				e.preventDefault(); if (saving || closed) return;
				saving = true; submit.disabled = true; cancel.disabled = true; input.disabled = true; submit.setText("저장 중…"); error.empty();
				try { await saveInlineGoal(this.plugin, g, field, expected, input.value, todayIso()); await finish(); }
				catch (err) { error.setText(err instanceof Error ? err.message : String(err)); }
				finally { saving = false; if (!closed) { submit.disabled = false; cancel.disabled = false; input.disabled = false; submit.setText("저장"); input.focus(); } }
			});
			input.addEventListener("focus", () => form.scrollIntoView({ block: "nearest" }));
			input.focus(); if (input instanceof HTMLInputElement && input.type !== "date") input.select();
		});
	}

	/** 시간 흐름 line chart: baseline first, then the `(value::)` points; health colours the dots. */
	private chart(parent: HTMLElement, s: Goal, lines: ProgressLine[], today: string): void {
		const { points, target } = chartSeries(s, lines, today);
		const box = parent.createDiv({ cls: "pb-chart" });
		if (points.length < 2) {
			box.remove();
			return;
		}
		const W = 600;
		const H = 190;
		const L = 52;
		const R = 16;
		const T = 16;
		const B = 26;
		const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
		const x0 = day(points[0].date);
		let x1 = Math.max(...points.map((p) => day(p.date)));
		if (s.due && isIsoDate(s.due)) x1 = Math.max(x1, day(s.due));
		if (x1 - x0 < 7) x1 = x0 + 7;
		const vals = points.map((p) => p.value);
		if (target !== null) vals.push(target);
		let lo = Math.min(...vals);
		let hi = Math.max(...vals);
		if (hi === lo) {
			lo -= 1;
			hi += 1;
		}
		const pad = (hi - lo) * 0.12;
		const y0 = lo - pad;
		const y1 = hi + pad;
		const X = (iso: string) => L + ((day(iso) - x0) / (x1 - x0)) * (W - L - R);
		const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
		const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, p: Element): SVGElementTagNameMap[K] => {
			const n = document.createElementNS(SVG_NS, tag);
			for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
			p.appendChild(n);
			return n;
		};
		const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "pb-chart-svg", role: "img", "aria-label": `${s.title} 시간 흐름` }, box);
		const unit = s.unit ? ` ${s.unit}` : "";
		for (let i = 0; i <= 2; i++) {
			const v = lo + ((hi - lo) * i) / 2;
			const y = Y(v);
			el("line", { x1: L, x2: W - R, y1: y, y2: y, class: "pb-ch-grid" }, svg);
			el("text", { x: L - 8, y: y + 4, class: "pb-ch-label", "text-anchor": "end" }, svg).textContent = fmtNum(Math.round(v * 100) / 100);
		}
		if (target !== null) {
			const y = Y(target);
			el("line", { x1: L, x2: W - R, y1: y, y2: y, class: "pb-ch-target" }, svg);
			el("text", { x: W - R, y: y - 5, class: "pb-ch-label is-target", "text-anchor": "end" }, svg).textContent = `목표 ${fmtNum(target)}${unit}`;
		}
		const tx = day(today);
		if (tx >= x0 && tx <= x1) {
			const x = X(today);
			el("line", { x1: x, x2: x, y1: T, y2: H - B, class: "pb-ch-today" }, svg);
		}
		const endIso = new Date(x1 * 86400000).toISOString().slice(0, 10);
		el("text", { x: L, y: H - 6, class: "pb-ch-label", "text-anchor": "start" }, svg).textContent = points[0].date.slice(5).replace("-", ".");
		el("text", { x: W - R, y: H - 6, class: "pb-ch-label", "text-anchor": "end" }, svg).textContent = endIso.slice(5).replace("-", ".");
		el("polyline", { points: points.map((p) => `${X(p.date).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" "), class: "pb-ch-line" }, svg);
		for (const p of points) {
			const c = el("circle", { cx: X(p.date).toFixed(1), cy: Y(p.value).toFixed(1), r: p.baseline ? 3.5 : 5, class: `pb-ch-pt ${p.baseline ? "is-base" : `is-${p.health || "none"}`}` }, svg);
			el("title", {}, c).textContent = `${p.baseline ? "시작 값" : p.date}: ${fmtNum(p.value)}${unit}${p.health ? ` · ${HEALTH_KO[p.health]}` : ""}`;
		}
	}

	private relatedCard(parent: HTMLElement, rel: RelatedItem[], g: Goal): void {
		const main = g.type === "main-goal";
		const c = this.card(parent, "관련 업무");
		const ct = c.querySelector<HTMLElement>(".pb-card-title");
		if (ct) tip(ct, main ? "이 목표와 Sub Goal에 연결된 일이에요. 진행률은 바꾸지 않아요. 프로젝트는 Sub Goal에서 연결해요." : "이 목표를 움직이는 일이에요. 진행률은 바꾸지 않아요 (진행률은 현재 값으로만).");
		const group = (kind: RelatedItem["kind"], label: string, icon: string) => {
			const items = rel.filter((r) => r.kind === kind);
			if (!items.length) return;
			const grp = c.createDiv({ cls: `pb-rel-group is-${kind}` });
			const h = grp.createDiv({ cls: "pb-d-label" });
			setIcon(h.createSpan({ cls: "pb-rel-icon" }), icon);
			h.appendText(label);
			const ul = grp.createEl("ul");
			for (const r of items) {
				const li = ul.createEl("li", { cls: "pb-rel-item" });
				if (r.path) {
					const a = li.createEl("a", { cls: "internal-link", text: r.label, href: "#" });
					a.addEventListener("click", (e) => {
						e.preventDefault();
						if (kind === "project") void this.plugin.openProjectAt(r.path!);
						else this.openPath(r.path!, Keymap.isModEvent(e));
					});
				} else li.createSpan({ text: r.label });
				if (r.status) li.createSpan({ cls: "pb-rel-status", text: r.status });
				if (r.broken) tip(li.createSpan({ cls: "pb-rel-warn", text: "⚠" }), "프로젝트를 찾을 수 없어요. ⋯에서 목록에서 뺄 수 있어요.");
				else if (r.oneSided) tip(li.createSpan({ cls: "pb-rel-warn", text: "⚠" }), "연결이 한쪽에만 기록돼 있어요. ⋯에서 고칠 수 있어요.");
				if (main || kind === "memo") continue;
				const more = li.createEl("button", { cls: "clickable-icon pb-rel-more", attr: { type: "button", "aria-label": "연결 메뉴" } });
				setIcon(more, "more-horizontal");
				more.addEventListener("click", (e) => {
					e.stopPropagation();
					if (!this.canNavigate()) return;
					const m = new Menu();
					const run = (fn: () => Promise<void>) => () => void fn().catch((err) => new Notice(`MyLogs: ${err instanceof Error ? err.message : String(err)}`, 12000));
					if (kind === "habit" && r.id) m.addItem((i) => i.setTitle("연결 해제").setIcon("unlink").onClick(run(() => this.pickFlywheel(g, r.id!))));
					if (kind === "project") {
						if (r.oneSided && r.path) m.addItem((i) => i.setTitle("연결 고치기").setIcon("link").onClick(run(() => this.linkProject(g, r.path!, true))));
						if (r.path) m.addItem((i) => i.setTitle("연결 해제").setIcon("unlink").onClick(run(() => this.linkProject(g, r.path!, false))));
						else m.addItem((i) => i.setTitle("목록에서 빼기").setIcon("x").onClick(run(() => this.dropBrokenLink(g, r))));
					}
					m.showAtMouseEvent(e);
				});
			}
		};
		group("project", "프로젝트", "folder-kanban");
		group("habit", "Flywheel", "repeat");
		group("memo", "메모", "sticky-note");
		if (!rel.length) c.createDiv({ cls: "pb-muted", text: main ? "Sub Goal에서 프로젝트나 Flywheel을 연결해요." : "아직 연결된 일이 없어요." });
		if (!main) {
			const add = c.createEl("button", { cls: "pb-small-btn pb-rel-addbtn", attr: { type: "button" } });
			setIcon(add.createSpan({ cls: "pb-btn-icon" }), "plus");
			add.appendText("연결");
			add.addEventListener("click", (e) => {
				if (!this.canNavigate()) return;
				const m = new Menu();
				const run = (fn: () => Promise<void>) => () => void fn().catch((err) => new Notice(`MyLogs: ${err instanceof Error ? err.message : String(err)}`, 12000));
				m.addItem((i) => i.setTitle("기존 프로젝트 연결…").setIcon("link").onClick(run(() => this.pickProject(g))));
				m.addItem((i) => i.setTitle("새 프로젝트 만들고 연결…").setIcon("folder-plus").onClick(run(() => this.newProjectFor(g))));
				m.addItem((i) => i.setTitle("Flywheel 연결…").setIcon("repeat").onClick(run(() => this.pickFlywheel(g))));
				m.showAtMouseEvent(e);
			});
		}
	}

	private smallBtn(parent: HTMLElement, text: string, title: string, run: () => Promise<void>, icon?: string): void {
		const b = parent.createEl("button", { cls: "pb-small-btn", attr: { type: "button", title } });
		if (icon) setIcon(b.createSpan({ cls: "pb-btn-icon" }), icon);
		b.appendText(text);
		b.addEventListener("click", async (e) => {
			e.stopPropagation();
			if (!this.canNavigate()) return;
			if (b.disabled) return;
			b.disabled = true;
			try {
				await run();
			} catch (err) {
				new Notice(`MyLogs: ${err instanceof Error ? err.message : String(err)}`, 12000);
			} finally {
				b.disabled = false;
			}
		});
	}

	// ── 프로젝트 연결 (Pinboard 「3-6」, both sides) ──

	private async createGoal(parent?: Goal): Promise<void> {
		if (this.creating) return;
		this.creating = true; this.beginEdit();
		try {
			const f = this.app.vault.getAbstractFileByPath(normalizePath(flywheelPath(this.plugin.settings.flywheelPath)));
			const year = this.data?.year ?? Number(todayIso().slice(0,4));
			const answer = await askCreateGoal(this.app, { year, parent, projects: this.data?.projects ?? [], flywheel: parseFlywheel(f instanceof TFile ? await this.app.vault.read(f) : null), taken: await takenIdsAndNames(this.plugin, []), today: todayIso(), areas: [...new Set(this.data?.goals.map(g => g.area) ?? [])] });
			if (!answer) return;
			if (!parent) answer.input.scope = inputSide(this.plugin.settings.sideMode);
			const goal = await createGoalFlow(this.plugin, answer, year, parent?.id, todayIso());
			this.year = year; this.openId = goal.id;
			new Notice(parent ? "하위 목표와 실행 공간을 저장했어요." : "목표를 만들었어요. 하위 목표를 추가해 보세요.");
		} finally { this.creating=false; this.endEdit(); await this.refresh(); }
	}

	private async pickFlywheel(g:Goal, unlinkId?:string):Promise<void> {
		const file=this.app.vault.getAbstractFileByPath(normalizePath(flywheelPath(this.plugin.settings.flywheelPath)));
		if(!(file instanceof TFile))throw new Error("Flywheel.md를 먼저 만들어 주세요.");
		const elements=parseFlywheel(await this.app.vault.read(file));
		let id=unlinkId;
		if(!id){const it=await pickTarget(this.app,"연결할 Flywheel 요소",elements.filter(e=>e.status!=="폐기"&&e.fields.goal!==g.id).map(e=>({label:`${e.id} ${e.name}`,sub:e.fields.goal?`현재 연결: ${e.fields.goal}`:"연결 없음",id:e.id})));if(!it)return;id=it.id;}
		const e=elements.find(e=>e.id===id);if(!e)return;
		if(unlinkId&&e.fields.goal!==g.id)throw new Error("연결이 바뀌었어요. 다시 열어 주세요.");
		if(!unlinkId&&e.fields.goal){const v=await askForm(this.app,{title:"Flywheel 목표 연결 교체",desc:`${e.fields.goal} 연결을 ${g.id}로 바꿉니다. 요소와 결과물은 그대로 둡니다.`,fields:[],cta:"연결 교체"});if(!v)return;}
		await connectFlywheel(this.plugin,g,e.id,e.fields.goal??"",!unlinkId,todayIso());await this.refresh();
	}

	private async linkProject(g: Goal, hub: string, link: boolean): Promise<void> {
		await connectProject(this.plugin, g, hub, link, todayIso());
		const name = this.data?.projects.find((p) => p.path === hub)?.title ?? hub.split("/").pop()?.replace(/\.md$/, "");
		new Notice(`${g.id} ↔ 「${name}」 ${link ? "연결했어요" : "연결을 해제했어요"}.`);
		await this.refresh();
	}

	private async pickProject(g: Goal): Promise<void> {
		const d = this.data;
		if (!d) return;
		const linked = new Set((d.related.get(g.id) ?? []).filter((r) => r.kind === "project" && !r.oneSided).map((r) => r.path));
		const items: (PickItem & { path: string })[] = d.projects
			.filter((p) => !p.archived && !linked.has(p.path))
			.sort((a, b) => a.title.localeCompare(b.title, "ko"))
			.map((p) => ({ label: p.title, sub: [p.id, p.status].filter(Boolean).join(" · "), icon: "folder", path: p.path }));
		if (!items.length) {
			new Notice("연결할 프로젝트가 없어요. 「새 프로젝트 만들고 연결」을 써 보세요.");
			return;
		}
		const it = await pickTarget(this.app, `${g.id}에 연결할 프로젝트`, items);
		if (it) await this.linkProject(g, it.path, true);
	}

	private async newProjectFor(g: Goal): Promise<void> {
		const d = this.data;
		const input = await askNewProject(this.app, {
			areas: [...new Set((d?.goals ?? []).map((x) => x.area).filter(Boolean))],
			taken: await takenIdsAndNames(this.plugin, []),
			prefill: { area: g.area },
			autoId: true,
			note: `만들면 ${g.id} 「${g.title}」에 연결해요 (허브 goals와 목표의 projects·project_ids 양쪽).`,
		});
		if (!input) return;
		await createProjectForGoal(this.plugin, g, input, todayIso());
		new Notice("프로젝트를 만들고 목표에 연결했어요.");await this.refresh();
	}

	/** A `project_ids` / `projects` entry whose hub doesn't exist: drop it from the Sub Goal only. */
	private async dropBrokenLink(g: Goal, r: RelatedItem): Promise<void> {
		const file = this.fileOf(g);
		if (!file) return;
		const today = todayIso();
		try {
			await this.app.vault.process(file, (t) => unlinkProject(t, r.id ?? r.label, r.label, today));
		} catch (err) {
			console.error("[MyLogs] Pinboard save failed", err);
			new Notice(`MyLogs: ${g.id} 저장에 실패했어요.`);
			return;
		}
		await this.updateIndexWith((t) => ({ text: t, missing: [] }), `${g.id} 찾을 수 없는 프로젝트 연결 ${r.label} 제거 (플러그인)`);
		await this.refresh();
	}

	/** 「업데이트 추가」: value (metric Sub), health, 내용, 보고됨/확인됨, 근거. */
	private updateForm(host: HTMLElement, g: Goal, onClose: () => void): void {
		if (!this.canNavigate()) return;
		host.empty();
		this.beginEdit();
		const today = todayIso();
		const form = host.createEl("form", { cls: "pb-form" });
		const metric = g.type === "sub-goal" && g.measure === "metric";
		const field = (label: string) => {
			const f = form.createDiv({ cls: "pb-form-field" });
			f.createEl("label", { text: label });
			return f;
		};
		let value: HTMLInputElement | null = null;
		if (metric) {
			value = field(`값 (지금 ${g.current || "?"}${g.unit ? ` ${g.unit}` : ""})`).createEl("input", {
				cls: "pb-input",
				attr: { type: "text", inputmode: "decimal", placeholder: "적으면 현재 값도 바꿔요" },
			});
		}
		let health: HTMLSelectElement | null = null;
		if (!isEnded(g.status)) {
			health = field("health").createEl("select", { cls: "dropdown" });
			health.createEl("option", { text: "적지 않음", value: "" });
			for (const h of HEALTHS) health.createEl("option", { text: `${HEALTH_ICON[h]} ${HEALTH_KO[h]}`, value: h });
			health.value = g.health;
		}
		const text = field("내용").createEl("textarea", { cls: "pb-input", attr: { rows: "2", placeholder: "무엇이 달라졌나요?" } });
		const vf = field("근거 확인");
		const seg = vf.createDiv({ cls: "pb-verify-seg" });
		let verify: Verify = "보고됨";
		const vbtns: HTMLButtonElement[] = [];
		for (const v of VERIFIES) {
			const b = seg.createEl("button", { cls: `pb-vseg${v === verify ? " is-active" : ""}`, text: v, attr: { type: "button" } });
			b.addEventListener("click", () => {
				verify = v;
				vbtns.forEach((x) => x.toggleClass("is-active", x === b));
			});
			vbtns.push(b);
		}
		tip(seg, "보고됨: 말로 전한 것 · 확인됨: 산출물·실행 결과로 확인한 것");
		const ev = field("근거 (선택)").createEl("input", { cls: "pb-input", attr: { type: "text", placeholder: `비우면: ${defaultEvidence(today)}` } });
		const err = form.createDiv({ cls: "pb-form-err" });
		const btns = form.createDiv({ cls: "pb-form-btns" });
		const cancel = btns.createEl("button", { text: "취소", attr: { type: "button" } });
		btns.createEl("button", { cls: "mod-cta", text: "저장", attr: { type: "submit" } });
		let closed = false;
		const finish = () => {
			if (closed) return;
			closed = true;
			host.empty();
			onClose();
			this.endEdit();
		};
		cancel.addEventListener("click", finish);
		form.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				finish();
			}
		});
		form.addEventListener("submit", (e) => {
			e.preventDefault();
			const raw = value?.value.trim() ?? "";
			if (raw && toNum(raw) === null) return void err.setText("값은 숫자로 적어 주세요.");
			let t = text.value.replace(/\s+/g, " ").trim();
			if (!t && raw) t = `현재 ${raw}${g.unit ? ` ${g.unit}` : ""}`;
			if (!t) return void err.setText("내용을 적어 주세요.");
			const h = health?.value ?? "";
			const log: ProgressLineInput = { date: today, text: t, value: raw, health: h, verify, evidence: ev.value.trim() };
			const change: GoalFieldChange = { log };
			if (raw) change.current = raw;
			if (h && h !== g.health) change.health = h;
			finish();
			void this.writeGoal(g, change);
		});
		(value ?? text).focus();
	}

	// ── menus ──

	private goalMenu(e: MouseEvent, g: Goal): void {
		if (!this.canNavigate()) return;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("자세히 보기").setIcon("panel-right-open").onClick(() => this.openGoal(g.id)));
		menu.addItem((i) => i.setTitle("화면에서 편집").setIcon("pencil").onClick(() => { this.openGoal(g.id); this.layerEl.querySelector<HTMLButtonElement>('[data-field="title"] > button')?.focus(); }));
		menu.addItem((i) =>
			i
				.setTitle("삭제…")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void this.deleteGoal(g)),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("노트 열기")
				.setIcon("file-text")
				.onClick(() => this.openPath(g.path)),
		);
		menu.showAtMouseEvent(e);
	}

	private logMenu(e: MouseEvent, s: Goal, l: ProgressEntry): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("진척 기록 수정…").setIcon("pencil").onClick(() => void this.editLog(s, l)));
		menu.addItem((i) =>
			i
				.setTitle("진척 기록 삭제…")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void this.deleteLog(s, l)),
		);
		menu.showAtMouseEvent(e);
	}

	// ── 수정 / 삭제 ──

	private async deleteGoal(g: Goal): Promise<void> {
		if(this.creating)return;
		this.creating=true;this.beginEdit();
		try { await this.deleteGoalFlow(g); }
		catch(err){new Notice(`MyLogs: ${err instanceof Error?err.message:String(err)}`,15000);}
		finally{this.creating=false;this.endEdit();await this.refresh();}
	}
	private async deleteGoalFlow(g: Goal): Promise<void> {
		const d = this.data;
		if (!d) return;
		const main = g.type === "main-goal";
		const targets = main ? [...d.board.subs.filter((x) => x.parent === g.id), g] : [g];
		const parent = main ? null : (d.board.mains.find((m) => m.id === g.parent) ?? null);
		const ids=targets.map(t=>t.id);
		const allGoals=await readGoals(this.plugin);
		const connected=d.projects.map(p=>({...p,goals:[...new Set([...p.goals,...allGoals.filter(x=>x.goal.projectIds.includes(p.id)||x.goal.projects.some(l=>l.includes(p.path.replace(/\.md$/,"")))).map(x=>x.goal.id)])]})).filter(p=>p.goals.some(id=>ids.includes(id)));
		const snapshots=new Map<string,string>();
		for(const t of targets){const f=this.fileOf(t);if(!f)throw new Error(`목표가 없어졌어요: ${t.id}`);snapshots.set(f.path,await this.app.vault.read(f));}
		if(parent){const f=this.fileOf(parent);if(f)snapshots.set(f.path,await this.app.vault.read(f));}
		for(const p of connected){const f=this.app.vault.getAbstractFileByPath(p.path);if(!(f instanceof TFile))throw new Error(`프로젝트가 없어졌어요: ${p.title}`);snapshots.set(p.path,await this.app.vault.read(f));}
		const choices=await askDeleteGoals(this.app,targets,connected);
		if(!choices)return;
		for(const [path,text]of snapshots){const f=this.app.vault.getAbstractFileByPath(path);if(!(f instanceof TFile)||await this.app.vault.read(f)!==text)throw new Error(`파일이 바뀌었어요. 다시 확인해 주세요: ${path}`);}
		const today = todayIso();
		const done: string[] = [], failures:string[]=[];
		for (const t of targets) {
			if(main&&t.id===g.id&&done.length<targets.length-1){failures.push("하위 목표 삭제 실패로 상위 목표 유지");continue;}
			const f = this.fileOf(t);
			if (!f) continue;
			try {
				await this.app.vault.trash(f, true);
				done.push(t.id);
			} catch (err) {
				console.error("[MyLogs] Pinboard trash failed", err);
				new Notice(`MyLogs: ${t.id} 노트를 휴지통으로 옮기지 못했어요.`);
				failures.push(`${t.id} 목표 휴지통`);
			}
		}
		if (!done.length) return;
		if (this.openId && done.includes(this.openId)) this.closeDetail();
		let mainRow: { id: string; progress: string } | null = null;
		const survivingParent=parent??(main&&!done.includes(g.id)?g:null);
		if (survivingParent) {
			const pf = this.fileOf(survivingParent);
			const r = rollupMain(d.board.subs.filter((x) => x.parent === survivingParent.id && !done.includes(x.id)));
			if (pf) {
				try {
					await this.app.vault.process(pf, (t) => {
						let out=applyMainRollup(t,r,today);
						for(const child of targets.filter(x=>x.parent===survivingParent.id&&done.includes(x.id)))out=applyMainRollup(out,r,today,child.path.split("/").pop()!.replace(/\.md$/,""));
						return out;
					});
					mainRow = { id: survivingParent.id, progress: indexProgressCell(r.progress, r) };
				} catch (err) {
					console.error("[MyLogs] Pinboard save failed", err);
					new Notice(`MyLogs: ${survivingParent.id}의 링크와 진행률을 고치지 못했어요.`);
					failures.push(`${survivingParent.id} 집계`);
				}
			}else failures.push(`${survivingParent.id} 파일 없음`);
		}
		const indexOK = await this.updateIndexWith(
			(t) => {
				const y = String(goalIdYear(done[0]));
				let out = removeIndexRows(t, y, done).text;
				out = removeUndecidedLines(out, done);
				return mainRow ? setIndexCells(out, y, [mainRow]) : { text: out, missing: [] };
			},
			`${done.join(", ")} 삭제 (휴지통)${mainRow ? `, ${mainRow.id} ${mainRow.progress}` : ""} (플러그인)`,
		);
		if(!indexOK)failures.push("Pinboard 등록부");
		await this.afterGoalsDeleted(done,failures);
		try { await unlinkDeletedFlywheel(this.plugin,done,today); }catch(err){failures.push(`Flywheel 연결 해제: ${String(err)}`);}
		// Only apply destructive choices when every selected goal was removed and links were updated.
		if(done.length===targets.length&&!failures.length)for(const ref of connected){
			const choice=choices[ref.id];if(choice==="keep"||ref.archived)continue;
			try {const {p}=await readProject(this.plugin,ref.path);
				const currentGoals=await readGoals(this.plugin);
				const sharedNow=[...new Set([...p.goals,...currentGoals.filter(x=>x.goal.projectIds.includes(p.id)).map(x=>x.goal.id)])];
				if(sharedNow.some(id=>!ref.goals.includes(id))){failures.push(`${p.title}: 새 목표 연결이 생겨 유지`);continue;}
				if(choice==="archive")await completeProject(this.plugin,p,{result:"종료: 목표 삭제에 따라 보관",started:p.started,completed:today},failures);
				else if(choice==="trash")await deleteProject(this.plugin,p,failures);
			}catch(err){failures.push(`${ref.title}: ${String(err)}`);}
		}
		try{await refreshRelatedIndex(this.plugin,connected.flatMap(p=>p.goals).filter(id=>!done.includes(id)),today);}catch(err){failures.push(`남은 목표 관련 업무 등록부: ${String(err)}`);}
		await this.refresh();
		new Notice(failures.length?`부분 처리: ${failures.join(", ")}. 프로젝트 보관·삭제가 남았는지 확인해 주세요.`:`${done.join(", ")} 삭제와 선택한 프로젝트 처리를 마쳤어요.`,12000);
	}

	/** Pinboard 「10. 연결 규칙」: project hubs that listed the deleted goals drop the ids. */
	private async afterGoalsDeleted(ids: string[],failures:string[]=[]): Promise<void> {
		try {
			await removeGoalsFromProjects(this.plugin, ids,failures);
		} catch (err) {
			console.error("[MyLogs] Pinboard → Project Folders unlink failed", err);
			new Notice("MyLogs: 프로젝트 허브의 goals에서 목표 id를 빼지 못했어요.");
			failures.push("프로젝트 목표 연결 해제");
		}
	}

	private async editLog(s: Goal, l: ProgressEntry): Promise<void> {
		const file = this.fileOf(s);
		if (!file) return;
		const v = await askForm(this.app, {
			title: `${s.id} 진척 기록 수정`,
			desc: "형식: YYYY-MM-DD: 내용 (value:: N) (health:: on-track|at-risk|off-track) (보고됨/확인됨) — 근거: [[…]]",
			fields: [{ key: "text", label: "기록", type: "text", value: l.text }],
			validate: (x) => (x.text ? [] : ["내용을 적어 주세요."]),
		});
		if (!v || v.text === l.text) return;
		await this.writeLog(s, file, (t) => editProgressEntry(t, l, v.text), `${s.id} 진척 기록 수정: ${v.text}`);
	}

	private async deleteLog(s: Goal, l: ProgressEntry): Promise<void> {
		const file = this.fileOf(s);
		if (!file) return;
		const ans = await confirmDelete(this.app, {
			title: "진척 기록 삭제",
			removes: [file.path, `- ${l.text}`],
			notes: ["current·progress·health 값은 바꾸지 않아요. 값이 틀렸다면 따로 고쳐 주세요."],
			footer: "잘못 적은 기록, 중복, 테스트 데이터를 지울 때 써요.",
		});
		if (ans !== "delete") return;
		await this.writeLog(s, file, (t) => deleteProgressEntry(t, l), `${s.id} 진척 기록 삭제: ${l.text}`);
	}

	private async writeLog(s: Goal, file: TFile, fn: (t: string) => { ok: true; text: string } | { ok: false; reason: string }, log: string): Promise<void> {
		let failed: string | null = null;
		try {
			await this.app.vault.process(file, (t) => {
				const r = fn(t);
				if (!r.ok) {
					failed = r.reason;
					return t;
				}
				return setFrontmatterScalar(r.text, "updated", todayIso());
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard save failed", err);
			new Notice(`MyLogs: ${s.id} 진척 기록을 저장하지 못했어요.`);
			return;
		}
		if (failed) {
			new Notice("이 기록을 찾지 못했어요. 노트가 바뀌어서 다시 불러왔어요.");
			void this.refresh();
			return;
		}
		await this.updateIndexWith((t) => ({ text: t, missing: [] }), `${log} (플러그인)`);
		await this.refresh();
	}

	// ── writes ──

	private fileOf(g: Goal): TFile | null {
		const f = this.data?.files.get(g.path) ?? this.app.vault.getAbstractFileByPath(g.path);
		return f instanceof TFile ? f : null;
	}

	/**
	 * A Sub Goal changed: recompute its Main (SPEC 1-2 weighted average, `sub_total`,
	 * `sub_achieved`) and write it when it differs. Returns the Main's index progress cell.
	 */
	private async rollupParent(sub: Goal, today: string): Promise<{ id: string; progress: string } | null> {
		const d = this.data;
		const main = d?.board.mains.find((m) => m.id === sub.parent);
		const mainFile = main ? this.fileOf(main) : null;
		if (!d || !main || !mainFile) return null;
		const siblings = d.board.subs.filter((x) => x.parent === main.id).map((x) => (x.path === sub.path || x.id === sub.id ? sub : x));
		if (!siblings.includes(sub)) siblings.push(sub);
		const r = rollupMain(siblings);
		if (main.progress === r.progress && main.subTotal === r.subTotal && main.subAchieved === r.subAchieved) return null;
		try {
			await this.app.vault.process(mainFile, (t) => applyMainRollup(t, r, today));
		} catch (err) {
			console.error("[MyLogs] Pinboard save failed", err);
			new Notice(`MyLogs: ${main.id}의 진행률을 저장하지 못했어요.`);
			return null;
		}
		return { id: main.id, progress: indexProgressCell(r.progress, r) };
	}

	/**
	 * current / status / health / 진척 기록 from the panel (SPEC 2 「쓰기」): the goal note, its
	 * Main's rollup, then `Pinboard Index.md` (row cells, 변경 기록, `updated`).
	 */
	private async writeGoal(g: Goal, c: GoalFieldChange): Promise<void> {
		const file = this.fileOf(g);
		if (!file) return;
		const today = todayIso();
		let res: { before: Goal | null; goal: Goal | null } | null = null;
		try {
			await this.app.vault.process(file, (t) => {
				const r = applyGoalChange(t, file.path, c, today);
				res = r;
				return r.text;
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard save failed", err);
			new Notice(`MyLogs: ${g.id} 저장에 실패했어요.`);
			return;
		}
		const r = res as { before: Goal | null; goal: Goal | null } | null;
		const ng = r?.goal;
		if (!r || !ng) return;
		const og = r.before ?? g;
		const row: RowUpdate = { id: ng.id };
		const parts: string[] = [];
		if (ng.status !== og.status) {
			row.status = ng.status;
			parts.push(`status ${og.status} → ${ng.status}`);
		}
		if (ng.health !== og.health) {
			row.health = ng.health;
			parts.push(`health ${og.health || "—"} → ${ng.health || "—"}`);
		}
		if (ng.type === "sub-goal") {
			if (ng.current !== og.current) {
				row.current = indexToken(ng.current, ng.measure);
				row.path = indexPathCell(ng);
				parts.push(`current ${indexToken(og.current, og.measure)} → ${indexToken(ng.current, ng.measure)}`);
			}
			if (ng.progress !== null && (ng.progress !== og.progress || row.status !== undefined)) row.progress = indexProgressCell(ng.progress);
		}
		if (c.log) parts.push(`진척 기록 추가${c.log.value ? ` (value ${c.log.value})` : ""}`);
		const rows: RowUpdate[] = [row];
		if (ng.type === "sub-goal") {
			const m = await this.rollupParent(ng, today);
			if (m) {
				rows.push({ id: m.id, progress: m.progress });
				parts.push(`${m.id} ${m.progress}`);
			}
		}
		if (parts.length) await this.updateIndex(rows, `${ng.id} ${parts.join(", ")} (플러그인)`, ng);
		await this.refresh();
	}

	/** Health per id for a year table that still lacks the column (the changed goal as it is now). */
	private healthOf(changed?: Goal): (id: string) => string {
		const goals = this.data?.goals ?? [];
		return (id) => (changed && changed.id === id ? changed.health : (goals.find((g) => g.id === id)?.health ?? ""));
	}

	/** Index write with any transform, then 변경 기록 and `updated` (「8. 인덱스 규칙」). */
	private async updateIndexWith(fn: (t: string) => { text: string; missing: string[] }, log: string, changed?: Goal): Promise<boolean> {
		const d = this.data;
		const file = this.indexFile();
		if (!d || !file) {
			new Notice(`MyLogs: ${INDEX_FILE}을 찾지 못해 인덱스를 갱신하지 못했어요. 목표 노트는 저장됐어요.`);
			return false;
		}
		let missing: string[] = [];
		const today = todayIso();
		try {
			await this.app.vault.process(file, (t) => {
				const r = fn(ensureHealthColumn(t, String(goalIdYear(changed?.id)), this.healthOf(changed)));
				missing = r.missing;
				return setFrontmatterScalar(prependChangeLog(r.text, today, log), "updated", today);
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard index update failed", err);
			new Notice(`MyLogs: ${INDEX_FILE} 갱신에 실패했어요. 목표 노트는 저장됐어요.`);
			return false;
		}
		if (missing.length) new Notice(`MyLogs: ${INDEX_FILE}의 ${d.year} 표에서 ${missing.join(", ")} 행을 찾지 못했어요. 목표 노트는 저장됐어요.`);
		return !missing.length;
	}

	/** AGENTS.md 「인덱스 규칙」: rows of the affected ids, 변경 기록, `updated`. */
	private async updateIndex(rows: RowUpdate[], log: string, changed?: Goal): Promise<void> {
		const d = this.data;
		const file = this.indexFile();
		if (!d || !file) {
			new Notice(`MyLogs: ${INDEX_FILE}을 찾지 못해 인덱스를 갱신하지 못했어요. 목표 노트는 저장됐어요.`);
			return;
		}
		let missing: string[] = [];
		try {
			await this.app.vault.process(file, (data) => {
				// Index tables are by the year in the id (when the goal was made).
				const year = String(goalIdYear(rows[0]?.id ?? changed?.id));
				const r = applyIndexEdit(ensureHealthColumn(data, year, this.healthOf(changed)), { year, rows, log, today: todayIso() });
				missing = r.missing;
				return r.text;
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard index update failed", err);
			new Notice(`MyLogs: ${INDEX_FILE} 갱신에 실패했어요. 목표 노트는 저장됐어요.`);
			return;
		}
		if (missing.length) new Notice(`MyLogs: ${INDEX_FILE}의 ${d.year} 표에서 ${missing.join(", ")} 행을 찾지 못했어요. 목표 노트는 저장됐어요.`);
	}
}
