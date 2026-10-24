import { debounce, ItemView, Keymap, Menu, normalizePath, setIcon, type TAbstractFile, TFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { toIsoDate } from "../parser.ts";
import { valueToString } from "../pinboard/model.ts";
import { cleanFolder } from "../settings.ts";
import { activeRoot, archiveRoot, changeStatus, completeProject, createProject, takenIdsAndNames } from "./actions.ts";
import { askComplete, askNewProject } from "./modals.ts";
import { withRo } from "./ops.ts";
import {
	buildKanban,
	columnOf,
	daysSinceUpdate,
	groupByArea,
	hubLocation,
	isStale,
	parseProject,
	type Project,
	PROJECT_STATUSES,
	type ProjectStatus,
	type Scope,
	type ScopeFilter,
	STALE_DAYS,
	timelineBars,
	timelineYears,
} from "./model.ts";

export const VIEW_TYPE_PROJECT_FOLDERS = "mylogs-project-folders";

export type ProjectsMode = "kanban" | "list" | "timeline";
const FILTERS: ScopeFilter[] = ["전체", "개인", "회사"];
const STATUS_HINT: Record<ProjectStatus, string> = {
	후보: "해 볼까 하는 것",
	진행: "지금 하는 것",
	대기: "남의 답·조건을 기다림",
	보류: "잠시 내려 둠",
	완료: "Archive Box",
};

function todayIso(): string {
	return toIsoDate(new Date());
}

function dotDate(iso: string): string {
	return iso.replace(/-/g, ".");
}

interface Loaded {
	projects: Project[];
	/** Pinboard areas (for list order and the new-project suggestions). */
	pinAreas: string[];
}

export class ProjectFoldersView extends ItemView {
	readonly plugin: MyLogsPlugin;
	mode: ProjectsMode = "kanban";
	/** Mode to go back to from the timeline. */
	private boardMode: "kanban" | "list" = "kanban";
	filter: ScopeFilter = "전체";
	/** Timeline year; null = the latest year with a completed project (else this year). */
	year: number | null = null;

	private rootEl!: HTMLElement;
	private data: Loaded | null = null;
	private loadSeq = 0;
	private busy = false;
	private dragging: Project | null = null;
	private pending = false;

	private scheduleRefresh = debounce(() => void this.refresh(), 300, true);

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PROJECT_FOLDERS;
	}

	getDisplayText(): string {
		return this.mode === "timeline" ? "Project Folders · 완료 타임라인" : "Project Folders";
	}

	getIcon(): string {
		return "folder-kanban";
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode, filter: this.filter, year: this.year };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { mode?: unknown; filter?: unknown; year?: unknown };
		if (s.mode === "kanban" || s.mode === "list" || s.mode === "timeline") this.mode = s.mode;
		if (this.mode !== "timeline") this.boardMode = this.mode;
		if (typeof s.filter === "string" && (FILTERS as string[]).includes(s.filter)) this.filter = s.filter as ScopeFilter;
		if (typeof s.year === "number") this.year = s.year;
		await super.setState(state, result);
		this.render();
	}

	/** Switch screens (used by the commands). */
	async show(mode: ProjectsMode): Promise<void> {
		this.setMode(mode);
	}

	private setMode(mode: ProjectsMode): void {
		this.mode = mode;
		if (mode !== "timeline") this.boardMode = mode;
		this.render();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
	}

	// ── paths ──

	private watched(path: string): boolean {
		const roots = [activeRoot(this.plugin), archiveRoot(this.plugin), cleanFolder(this.plugin.settings.pinboardFolder)];
		return roots.some((r) => path === r || path.startsWith(`${r}/`));
	}

	// ── lifecycle ──

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-projects-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-projects" });
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (this.watched(f.path)) this.scheduleRefresh();
			}),
		);
		const onFile = (f: TAbstractFile, old?: string) => {
			if (this.watched(f.path) || (old && this.watched(old))) this.scheduleRefresh();
		};
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile(f, old)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile(f)));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.rootEl?.empty();
	}

	/** Re-read the hubs and re-render (waits while a write or a drag is in progress). */
	async refresh(): Promise<void> {
		if (!this.rootEl) return;
		if (this.busy || this.dragging) {
			this.pending = true;
			return;
		}
		this.pending = false;
		const seq = ++this.loadSeq;
		const data = await this.loadData();
		if (seq !== this.loadSeq) return;
		this.data = data;
		this.render();
	}

	private async loadData(): Promise<Loaded> {
		const act = activeRoot(this.plugin);
		const arc = archiveRoot(this.plugin);
		const projects: Project[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const loc = hubLocation(f.path, act, arc);
			if (!loc) continue;
			const cache = this.app.metadataCache.getFileCache(f);
			if (valueToString(cache?.frontmatter?.type) !== "project") continue;
			const text = await this.app.vault.cachedRead(f);
			const body = text.slice(cache?.frontmatterPosition?.end.offset ?? 0);
			const p = parseProject(cache?.frontmatter, body, loc, f.path);
			if (p) projects.push(p);
		}
		const pin = cleanFolder(this.plugin.settings.pinboardFolder);
		const pinAreas: string[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(`${pin}/`)) continue;
			const a = valueToString(this.app.metadataCache.getFileCache(f)?.frontmatter?.area);
			if (a && !pinAreas.includes(a)) pinAreas.push(a);
		}
		return { projects, pinAreas };
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

	// ── actions ──

	async newProject(): Promise<void> {
		const projects = this.data?.projects ?? [];
		const areas = [...new Set([...(this.data?.pinAreas ?? []), ...projects.map((p) => p.area).filter(Boolean)])];
		const input = await askNewProject(this.app, {
			areas,
			taken: await takenIdsAndNames(this.plugin, projects),
			scope: this.filter === "전체" ? undefined : (this.filter as Scope),
		});
		if (!input) return;
		await this.run(async () => {
			const hub = await createProject(this.plugin, input);
			const f = hub ? this.app.vault.getAbstractFileByPath(normalizePath(hub)) : null;
			if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
		});
	}

	private async moveTo(p: Project, to: ProjectStatus, review = false): Promise<void> {
		if (p.archived || (columnOf(p) === to && !review)) return;
		if (to === "완료") return this.complete(p, false);
		await this.run(() => changeStatus(this.plugin, p, to, { review }));
	}

	private async complete(p: Project, ending: boolean): Promise<void> {
		const ans = await askComplete(this.app, { title: p.title, started: p.started, ending });
		if (!ans) return;
		await this.run(() => completeProject(this.plugin, p, ans));
	}

	private openHub(p: Project, e?: MouseEvent): void {
		const f = this.app.vault.getAbstractFileByPath(p.path);
		if (f instanceof TFile) void this.app.workspace.getLeaf(e ? Keymap.isModEvent(e) : false).openFile(f);
	}

	// ── rendering ──

	private render(): void {
		const root = this.rootEl;
		if (!root) return;
		root.empty();
		const d = this.data;
		if (!d) return;
		this.renderTop(root, d);
		if (this.mode === "timeline") this.renderTimeline(root, d);
		else if (this.mode === "list") this.renderList(root, d);
		else this.renderKanban(root, d);
		const foot = root.createDiv({ cls: "pf-foot" });
		foot.appendText(`원본: ${activeRoot(this.plugin)}/<개인|회사>/ · 완료: ${archiveRoot(this.plugin)}/ · 허브 ${d.projects.length}개`);
	}

	private btn(parent: HTMLElement, text: string, onClick: () => void, o: { icon?: string; cls?: string; active?: boolean; label?: string } = {}): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `pf-btn${o.cls ? ` ${o.cls}` : ""}${o.active ? " is-active" : ""}`, attr: { type: "button" } });
		if (o.label) b.setAttr("aria-label", o.label);
		if (o.active !== undefined) b.setAttr("aria-pressed", String(o.active));
		if (o.icon) setIcon(b.createSpan({ cls: "pf-btn-icon" }), o.icon);
		if (text) b.appendText(text);
		b.addEventListener("click", onClick);
		return b;
	}

	private renderTop(root: HTMLElement, d: Loaded): void {
		const top = root.createDiv({ cls: "pf-top" });
		const left = top.createDiv();
		left.createDiv({ cls: "pf-eyebrow", text: this.mode === "timeline" ? "Projects · 완료 타임라인" : "Projects · 프로젝트 폴더" });
		left.createEl("h1", { text: this.mode === "timeline" ? "완료한 프로젝트" : "Project Folders" });
		const right = top.createDiv({ cls: "pf-right" });
		const row = right.createDiv({ cls: "pf-controls" });

		if (this.mode === "timeline") {
			this.btn(row, "보드로", () => this.setMode(this.boardMode), { icon: "arrow-left" });
		} else {
			const seg = row.createDiv({ cls: "pf-seg", attr: { role: "group", "aria-label": "보기" } });
			this.btn(seg, "칸반", () => this.setMode("kanban"), { icon: "columns-3", active: this.mode === "kanban" });
			this.btn(seg, "리스트", () => this.setMode("list"), { icon: "list", active: this.mode === "list" });
		}
		const seg2 = row.createDiv({ cls: "pf-seg", attr: { role: "group", "aria-label": "개인 / 회사" } });
		for (const f of FILTERS) {
			this.btn(
				seg2,
				f,
				() => {
					this.filter = f;
					this.render();
					this.app.workspace.requestSaveLayout();
				},
				{ active: this.filter === f },
			);
		}
		const row2 = right.createDiv({ cls: "pf-controls" });
		if (this.mode !== "timeline") this.btn(row2, "완료 타임라인", () => this.setMode("timeline"), { icon: "gantt-chart" });
		this.btn(row2, "새 프로젝트", () => void this.newProject(), { icon: "plus", cls: "pf-btn-primary" });

		if (this.mode !== "timeline") {
			const live = d.projects.filter((p) => !p.archived && (this.filter === "전체" || p.scope === this.filter));
			const stale = live.filter((p) => isStale(p, todayIso())).length;
			if (stale) {
				const bar = root.createDiv({ cls: "pf-notice" });
				setIcon(bar.createSpan({ cls: "pf-notice-icon" }), "hourglass");
				bar.appendText(`진행 중인데 ${STALE_DAYS}일 넘게 갱신이 없는 프로젝트가 ${stale}개 있어요. 카드에서 계속 / 보류 / 종료를 골라 주세요.`);
			}
		}
	}

	private renderEmpty(parent: HTMLElement): void {
		const e = parent.createDiv({ cls: "pf-empty" });
		e.createDiv({ cls: "pf-empty-title", text: "아직 프로젝트가 없어요" });
		e.createEl("p", { text: "새 프로젝트를 만들면 템플릿으로 폴더가 생기고 등록부에 올라가요." });
		this.btn(e, "새 프로젝트", () => void this.newProject(), { icon: "plus", cls: "pf-btn-primary" });
	}

	// ── kanban ──

	private renderKanban(root: HTMLElement, d: Loaded): void {
		if (!d.projects.length) this.renderEmpty(root);
		const board = root.createDiv({ cls: "pf-board" });
		const today = todayIso();
		for (const col of buildKanban(d.projects, this.filter)) {
			const c = board.createDiv({ cls: `pf-col st-${col.status}` });
			const head = c.createDiv({ cls: "pf-col-head" });
			head.createSpan({ cls: "pf-col-name", text: col.status });
			head.createSpan({ cls: "pf-col-count", text: String(col.total) });
			c.createDiv({ cls: "pf-col-hint", text: STATUS_HINT[col.status] });
			const list = c.createDiv({ cls: "pf-col-list" });
			this.dropZone(c, col.status);
			for (const p of col.cards) this.renderCard(list, p, today, false);
			if (!col.cards.length) list.createDiv({ cls: "pf-col-empty", text: col.status === "완료" ? "완료한 프로젝트가 없어요" : "비어 있음" });
			if (col.status === "완료" && col.total) {
				const more = c.createEl("button", { cls: "pf-more", attr: { type: "button" } });
				more.appendText(col.total > col.cards.length ? `완료 전체 보기 (${col.total})` : "완료 전체 보기");
				setIcon(more.createSpan({ cls: "pf-btn-icon" }), "arrow-right");
				more.addEventListener("click", () => this.setMode("timeline"));
			}
		}
	}

	private dropZone(el: HTMLElement, status: ProjectStatus): void {
		const accepts = (p: Project | null) => !!p && !p.archived && columnOf(p) !== status;
		el.addEventListener("dragover", (e) => {
			if (!accepts(this.dragging)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			el.addClass("pf-drop-hover");
		});
		el.addEventListener("dragleave", (e) => {
			const to = e.relatedTarget as Node | null;
			if (!to || !el.contains(to)) el.removeClass("pf-drop-hover");
		});
		el.addEventListener("drop", (e) => {
			const p = this.dragging;
			el.removeClass("pf-drop-hover");
			if (!accepts(p)) return;
			e.preventDefault();
			this.endDrag();
			void this.moveTo(p!, status);
		});
	}

	private endDrag(): void {
		this.dragging = null;
		this.rootEl.removeClass("pf-is-dragging");
		this.rootEl.querySelectorAll(".pf-drop-ok, .pf-drop-hover, .pf-dragging").forEach((el) => el.removeClass("pf-drop-ok", "pf-drop-hover", "pf-dragging"));
		if (this.pending) this.scheduleRefresh();
	}

	// ── card ──

	private coverUrl(p: Project): string | null {
		if (!p.cover) return null;
		const f = this.app.vault.getAbstractFileByPath(normalizePath(`${p.folder}/${p.cover}`));
		return f instanceof TFile ? this.app.vault.getResourcePath(f) : null;
	}

	private renderCard(parent: HTMLElement, p: Project, today: string, showStatus: boolean): void {
		const stale = isStale(p, today);
		const card = parent.createDiv({ cls: `pf-card${stale ? " is-stale" : ""}${p.archived ? " is-archived" : ""}` });
		const cover = this.coverUrl(p);
		if (cover) card.createDiv({ cls: "pf-cover" }).createEl("img", { attr: { src: cover, alt: "", loading: "lazy" } });

		const meta = card.createDiv({ cls: "pf-meta" });
		meta.createSpan({ cls: `pf-scope is-${p.scope === "회사" ? "work" : "personal"}`, text: p.scope || "?" });
		if (showStatus) meta.createSpan({ cls: `pf-status st-${columnOf(p)}`, text: columnOf(p) });
		if (p.kind) meta.createSpan({ cls: "pf-kind", text: p.kind });

		const name = card.createEl("h3", { cls: "pf-name", text: p.title, attr: { title: "허브 열기" } });
		name.addEventListener("click", (e) => this.openHub(p, e));

		if (p.archived) {
			if (p.result) card.createDiv({ cls: "pf-result", text: p.result });
		} else {
			const act = card.createDiv({ cls: `pf-action${p.action ? "" : " is-empty"}${p.actionDone ? " is-done" : ""}` });
			act.createSpan({ cls: "pf-action-k", text: "지금 가장 효과적인 한 가지 행동" });
			act.createDiv({ cls: "pf-action-v", text: p.action || "미확인" });
			if (p.actionDraft) act.createSpan({ cls: "pf-draft", text: "AI 초안" });
		}

		if (p.goals.length) {
			const chips = card.createDiv({ cls: "pf-chips" });
			for (const g of p.goals) chips.createSpan({ cls: "pf-chip", text: g });
		}

		const foot = card.createDiv({ cls: "pf-card-foot" });
		if (p.archived && p.completed) foot.createSpan({ text: `완료 ${dotDate(p.completed)}` });
		else {
			const days = daysSinceUpdate(p, today);
			foot.createSpan({ text: p.updated ? `갱신 ${dotDate(p.updated)}` : "갱신 기록 없음" });
			if (days !== null && days > 0) foot.createSpan({ cls: "pf-ago", text: `${days}일 전` });
		}

		if (stale) {
			const ask = card.createDiv({ cls: "pf-stale" });
			ask.createDiv({ cls: "pf-stale-q", text: `${daysSinceUpdate(p, today)}일째 갱신이 없어요. 어떻게 할까요?` });
			const btns = ask.createDiv({ cls: "pf-stale-btns" });
			this.btn(btns, "계속", () => void this.moveTo(p, "진행", true), { label: "계속 진행 (갱신일 기록)" });
			this.btn(btns, "보류", () => void this.moveTo(p, "보류", true));
			this.btn(btns, "종료", () => void this.complete(p, true), { label: "종료하고 보관" });
		}

		card.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.cardMenu(e, p);
		});
		if (!p.archived && this.mode === "kanban") {
			card.draggable = true;
			card.addClass("pf-draggable");
			card.addEventListener("dragstart", (e) => {
				if (this.busy) return e.preventDefault();
				this.dragging = p;
				e.dataTransfer?.setData("text/plain", p.title);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				card.addClass("pf-dragging");
				this.rootEl.addClass("pf-is-dragging");
				this.rootEl.querySelectorAll(".pf-col").forEach((c) => {
					if (!c.hasClass(`st-${columnOf(p)}`)) c.addClass("pf-drop-ok");
				});
			});
			card.addEventListener("dragend", () => this.endDrag());
		}
	}

	private cardMenu(e: MouseEvent, p: Project): void {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("허브 열기")
				.setIcon("file-text")
				.onClick(() => this.openHub(p)),
		);
		if (!p.archived) {
			menu.addSeparator();
			for (const st of PROJECT_STATUSES) {
				menu.addItem((i) =>
					i
						.setTitle(st === "완료" ? "완료하고 보관…" : `${withRo(st)}`)
						.setChecked(columnOf(p) === st)
						.onClick(() => void this.moveTo(p, st)),
				);
			}
		}
		menu.showAtMouseEvent(e);
	}

	// ── list ──

	private renderList(root: HTMLElement, d: Loaded): void {
		if (!d.projects.length) return this.renderEmpty(root);
		const today = todayIso();
		const groups = groupByArea(d.projects, this.filter, d.pinAreas);
		if (!groups.length) root.createDiv({ cls: "pf-empty" }).createDiv({ cls: "pf-empty-title", text: `${this.filter} 프로젝트가 없어요` });
		for (const g of groups) {
			const sec = root.createDiv({ cls: "pf-area" });
			const h = sec.createEl("h2", { cls: "pf-area-name" });
			h.appendText(g.area);
			h.createSpan({ cls: "pf-col-count", text: String(g.projects.length) });
			const grid = sec.createDiv({ cls: "pf-grid" });
			for (const p of g.projects) this.renderCard(grid, p, today, true);
		}
	}

	// ── 완료 타임라인 ──

	private renderTimeline(root: HTMLElement, d: Loaded): void {
		const years = timelineYears(d.projects);
		const thisYear = new Date().getFullYear();
		const year = this.year ?? (years.length ? years[years.length - 1] : thisYear);
		const nav = root.createDiv({ cls: "pf-tl-nav" });
		this.btn(nav, "", () => this.goYear(year - 1), { icon: "chevron-left", label: "이전 해" });
		nav.createSpan({ cls: "pf-tl-year", text: `${year}` });
		this.btn(nav, "", () => this.goYear(year + 1), { icon: "chevron-right", label: "다음 해" });
		if (years.length) nav.createSpan({ cls: "pf-tl-years", text: `완료가 있는 해: ${years.join(", ")}` });

		const tl = root.createDiv({ cls: "pf-tl" });
		const axis = tl.createDiv({ cls: "pf-tl-axis" });
		for (let m = 1; m <= 12; m++) axis.createDiv({ cls: "pf-tl-month", text: `${m}월` });
		const body = tl.createDiv({ cls: "pf-tl-body" });
		const grid = body.createDiv({ cls: "pf-tl-grid" });
		for (let m = 0; m < 12; m++) grid.createDiv();
		const today = todayIso();
		if (Number(today.slice(0, 4)) === year) {
			const [, mm, dd] = today.split("-").map(Number);
			const pos = mm - 1 + (dd - 1) / new Date(year, mm, 0).getDate();
			const now = body.createDiv({ cls: "pf-tl-now", attr: { title: `오늘 ${dotDate(today)}` } });
			now.style.left = `${(pos / 12) * 100}%`;
		}
		const bars = timelineBars(d.projects, year, this.filter);
		if (!bars.length) {
			body.createDiv({ cls: "pf-tl-empty", text: `${year}년에 완료한 프로젝트가 없어요` });
			return;
		}
		for (const b of bars) {
			const p = b.project;
			const row = body.createDiv({ cls: "pf-tl-row" });
			const bar = row.createDiv({ cls: `pf-tl-bar${b.clippedStart ? " is-clip-start" : ""}${b.clippedEnd ? " is-clip-end" : ""}`, attr: { title: "허브 열기" } });
			bar.style.left = `${(b.from / 12) * 100}%`;
			bar.style.width = `${((b.to - b.from) / 12) * 100}%`;
			bar.addEventListener("click", (e) => this.openHub(p, e));
			const cover = this.coverUrl(p);
			if (cover) bar.createEl("img", { cls: "pf-tl-cover", attr: { src: cover, alt: "", loading: "lazy" } });
			const txt = bar.createDiv({ cls: "pf-tl-txt" });
			const name = txt.createDiv({ cls: "pf-tl-name" });
			name.createSpan({ cls: `pf-scope is-${p.scope === "회사" ? "work" : "personal"}`, text: p.scope });
			name.appendText(p.title);
			txt.createDiv({ cls: "pf-tl-result", text: p.result || "한 줄 결과 없음" });
			txt.createDiv({ cls: "pf-tl-dates", text: `${p.started ? dotDate(p.started) : "?"} ~ ${dotDate(p.completed)}` });
		}
	}

	private goYear(y: number): void {
		this.year = y;
		this.render();
		this.app.workspace.requestSaveLayout();
	}
}
