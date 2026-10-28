import { renderProjectSchedule, type ScheduleState } from "./schedule-ui.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { loadProjectTasks } from "./task-actions.ts";
import type { ProjectTask } from "./tasks.ts";
import { scheduleSource, type ScheduleItem } from "./schedule-dnd.ts";
import { Component, debounce, ItemView, Keymap, Menu, normalizePath, Notice, Platform, setIcon, type TAbstractFile, TFile, TFolder, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { toIsoDate } from "../parser.ts";
import { valueToString, parseFrontmatterText } from "../pinboard/model.ts";
import { renderMilestones, type MilestoneUIState } from "./milestone-ui.ts";
import { saveMilestone } from "./milestone-actions.ts";
import { renderWorkspace } from "./workspace-ui.ts";
import { projectGoalLinks } from "./workspace.ts";
import { connectProject, readGoals } from "../pinboard/create-actions.ts";
import { flywheelPath, parseFlywheel, type FlywheelElement } from "../flywheel/model.ts";
import type { Goal } from "../pinboard/model.ts";
import { pickTarget } from "../ui/mobile.ts";
import { cleanFolder } from "../settings.ts";
import { activeRoot, aliasesOf, archiveRoot, changeStatus, completeProject, createProject, deleteProject, editProject, takenIdsAndNames } from "./actions.ts";
import { askForm, confirmDelete } from "../ui/modals.ts";
import { goalIdProblems, parseGoalIds } from "./edit.ts";
import { askComplete, askNewProject } from "./modals.ts";
import { withRo } from "./ops.ts";
import { type ProjectsMobileHost, renderProjectsMobile } from "./mobile.ts";
import { runProjectTarget } from "./mobile-targets.ts";
import {
	buildKanban,
	columnOf,
	daysSinceUpdate,
	groupByArea,
	hubLocation,
	isStale,
	KINDS,
	nameProblem,
	parseProject,
	type Project,
	PROJECT_STATUSES,
	type ProjectStatus,
	type Scope,
	SCOPES,
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
	texts: Map<string, string>;
	tasks: Map<string, ProjectTask[]>;
	goals: Goal[];
	elements: FlywheelElement[];
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
	private scheduleStates = new Map<string, ScheduleState>();
	private milestoneStates = new Map<string, MilestoneUIState>();
	private selectedId: string | null = null;
	private workspaceComponent: Component | null = null;

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
		return { ...super.getState(), mode: this.mode, filter: this.filter, year: this.year, projectId: this.selectedId };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (!this.canNavigate()) return;
		const s = (state ?? {}) as { mode?: unknown; filter?: unknown; year?: unknown; projectId?: unknown };
		if (typeof s.projectId === "string") this.selectedId = s.projectId;
		else if (s.projectId === null) this.selectedId = null;
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
		if (!this.canNavigate()) return;
		this.selectedId = null;
		this.mode = mode;
		if (mode !== "timeline") this.boardMode = mode;
		this.render();
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		this.app.workspace.requestSaveLayout();
	}

	// ── paths ──

	private watched(path: string): boolean {
		const roots = [activeRoot(this.plugin), archiveRoot(this.plugin), cleanFolder(this.plugin.settings.deskCalendarFolder), cleanFolder(this.plugin.settings.wallCalendarFolder), cleanFolder(this.plugin.settings.pinboardFolder), cleanFolder(this.plugin.settings.flywheelPath)];
		return roots.some((r) => path === r || path.startsWith(`${r}/`));
	}

	// ── lifecycle ──

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-projects-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-projects" });
		mountAppNav(this);
		const viewport = this.contentEl.ownerDocument.defaultView?.visualViewport;
		if (viewport) {
			const keepEditorVisible = () => this.rootEl.querySelector(".pf-ms-editor:focus-within")?.scrollIntoView({ block: "nearest" });
			viewport.addEventListener("resize", keepEditorVisible);
			this.register(() => viewport.removeEventListener("resize", keepEditorVisible));
		}
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
		this.registerEvent(this.app.vault.on("modify", (f) => onFile(f)));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.rootEl?.empty();
	}

	/** Re-read the hubs and re-render (waits while a write or a drag is in progress). */
	async refresh(): Promise<void> {
		if (!this.rootEl) return;
		if (this.scheduleLocked() || this.busy || this.dragging || this.rootEl.querySelector(".pf-ms-editor, .pf-ms-remove") || [...this.milestoneStates.values()].some(s => s.busy)) {
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
		const texts = new Map<string, string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const loc = hubLocation(f.path, act, arc);
			if (!loc) continue;
			const text = await this.app.vault.read(f);
			const fm = parseFrontmatterText(text);
			const p = parseProject(fm.data, fm.body, loc, f.path);
			if (p) { projects.push(p); texts.set(p.id, text); }
		}
		const pin = cleanFolder(this.plugin.settings.pinboardFolder);
		const pinAreas: string[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(`${pin}/`)) continue;
			const a = valueToString(this.app.metadataCache.getFileCache(f)?.frontmatter?.area);
			if (a && !pinAreas.includes(a)) pinAreas.push(a);
		}
		const goals = (await readGoals(this.plugin)).map(x => x.goal);
		const wheel = this.app.vault.getAbstractFileByPath(flywheelPath(this.plugin.settings.flywheelPath));
		const elements = parseFlywheel(wheel instanceof TFile ? await this.app.vault.read(wheel) : null);
		const tasks = new Map<string, ProjectTask[]>();
		for (const p of projects) if (p.id === this.selectedId) tasks.set(p.id, await loadProjectTasks(this.plugin, p, texts.get(p.id)!));
		return { projects, pinAreas, texts, goals, elements, tasks };
	}

	private async run(fn: () => Promise<unknown>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.rootEl.addClass("is-busy");
		try {
			await fn();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		} finally {
			this.busy = false;
			this.rootEl.removeClass("is-busy");
			await this.refresh();
		}
	}

	// ── actions ──

	async newProject(): Promise<void> {
		if (!this.canNavigate()) return;
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
			if (f instanceof TFile) { const fm = parseFrontmatterText(await this.app.vault.read(f)); this.selectedId = valueToString(fm.data.id); }
		});
	}

	private async moveTo(p: Project, to: ProjectStatus, review = false): Promise<void> {
		if (!this.canNavigate()) return;
		if (p.archived || (columnOf(p) === to && !review)) return;
		if (to === "완료") return this.complete(p, false);
		await this.run(() => changeStatus(this.plugin, p, to, { review }));
	}

	private async complete(p: Project, ending: boolean): Promise<void> {
		const ans = await askComplete(this.app, { title: p.title, started: p.started, ending });
		if (!ans) return;
		await this.run(() => completeProject(this.plugin, p, ans));
	}

	/** Sub Goal ids in Pinboard (for the goals field). */
	private subGoalIds(): string[] {
		const pin = cleanFolder(this.plugin.settings.pinboardFolder);
		const out: string[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(`${pin}/`)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (valueToString(fm?.type) === "sub-goal" && valueToString(fm?.id)) out.push(valueToString(fm?.id));
		}
		return out.sort();
	}

	private async editInfo(p: Project): Promise<void> {
		if (!this.canNavigate()) return;
		if (p.archived) return;
		const projects = this.data?.projects ?? [];
		const taken = await takenIdsAndNames(this.plugin, projects.filter((x) => x.id !== p.id));
		const areas = [...new Set([...(this.data?.pinAreas ?? []), ...projects.map((x) => x.area).filter(Boolean)])];
		const known = this.subGoalIds();
		const v = await askForm(this.app, {
			title: `「${p.title}」 정보 수정`,
			desc: "허브, 등록부 행, updated를 함께 고치고 월별 로그·로그 인덱스에 기록해요. 이름이나 개인/회사를 바꾸면 폴더와 파일 이름도 옮겨요. id는 그대로예요.",
			fields: [
				{ key: "name", label: "이름", type: "text", value: p.title },
				{ key: "aliases", label: "별칭", type: "text", value: await aliasesOf(this.plugin, p), desc: "쉼표로 구분" },
				{ key: "summary", label: "한 문장 설명", type: "text", value: p.summary },
				{ key: "scope", label: "개인 / 회사", type: "select", value: p.scope, options: SCOPES.map((x) => [x, x] as [string, string]) },
				{ key: "area", label: "area", type: "text", value: p.area, list: areas },
				{ key: "kind", label: "유형", type: "select", value: p.kind, options: [["", "고르기"], ...KINDS.map((k) => [k, k] as [string, string])] },
				{ key: "action", label: "지금 가장 효과적인 한 가지 행동", type: "text", value: p.action, desc: p.actionDraft ? "지금은 AI 초안이에요. 고치면 사용자 행동으로 적어요." : undefined },
				{ key: "goals", label: "목표 (Sub Goal id)", type: "text", value: p.goals.join(", "), desc: `쉼표로 구분. Pinboard Sub Goal에도 연결을 적어요.${known.length ? ` 있는 id: ${known.join(", ")}` : ""}` },
			],
			validate: (x) => {
				const out: string[] = [];
				const np = nameProblem(x.name);
				if (np) out.push(np);
				if (x.name !== p.title && x.name !== p.name && taken.names.includes(x.name)) out.push(`이미 있는 프로젝트 이름이에요: ${x.name}`);
				if (!x.summary) out.push("한 문장 설명을 적어 주세요.");
				if (!x.area) out.push("area를 적어 주세요.");
				if (!(KINDS as readonly string[]).includes(x.kind)) out.push("유형을 골라 주세요.");
				out.push(...goalIdProblems(parseGoalIds(x.goals), known.length ? known : null));
				return out;
			},
		});
		if (!v) return;
		await this.run(() => editProject(this.plugin, p, { name: v.name, aliases: v.aliases, summary: v.summary, scope: v.scope as Scope, area: v.area, kind: v.kind, action: v.action, goals: v.goals }));
	}

	private async remove(p: Project): Promise<void> {
		if (!this.canNavigate()) return;
		if (p.archived) return;
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(p.folder));
		let count = 0;
		const walk = (f: TAbstractFile) => {
			if (f instanceof TFile) count++;
			else if (f instanceof TFolder) f.children.forEach(walk);
		};
		if (folder) walk(folder);
		const notes = [`등록부(Project Folders Index.md)의 ${p.id} 행을 지우고 「변경 기록」에 남겨요.`];
		if (p.goals.length) notes.push(`Pinboard Sub Goal ${p.goals.join(", ")}의 projects·project_ids에서 이 프로젝트를 빼요.`);
		notes.push("Desk Calendar·Wall Calendar·Daily Pad의 (project:: …) 줄은 바꾸지 않아요.");
		const ans = await confirmDelete(this.app, {
			title: "프로젝트 삭제",
			removes: [`${p.folder}/ (폴더째, 파일 ${count}개)`, `등록부 행: ${p.id} · ${p.title}`],
			notes,
			footer: "폴더는 휴지통으로 가서 되살릴 수 있어요. 잘못 만든 프로젝트, 중복, 테스트 데이터를 지울 때 써요.",
			alt: { label: "종료하고 보관 (기록 남김)", desc: "그만두기로 한 프로젝트면 지우지 말고 종료해서 Archive Box에 보관할 수 있어요." },
		});
		if (ans === "alt") return this.complete(p, true);
		if (ans === "delete") await this.run(() => deleteProject(this.plugin, p));
	}

	private openHub(p: Project, e?: MouseEvent): void {
		if (!this.canNavigate()) return;
		const f = this.app.vault.getAbstractFileByPath(p.path);
		if (f instanceof TFile) void this.app.workspace.getLeaf(e ? Keymap.isModEvent(e) : false).openFile(f);
	}

	// ── rendering ──

	private scheduleLocked(): boolean { return [...this.scheduleStates.values()].some(s => s.busy || !!s.draft || !!s.editing); }

	canNavigate(): boolean {
		if (this.scheduleLocked() || this.busy || [...this.milestoneStates.values()].some(s => s.busy || s.editor || s.removing)) {
			new Notice("편집 중인 할 일·마일스톤을 먼저 저장하거나 취소해 주세요.");
			this.rootEl?.querySelector<HTMLTextAreaElement>(".pf-ms-editor textarea")?.focus();
			return false;
		}
		return true;
	}

	/** Resolve by stable id first; paths may change when a project is renamed or archived. */
	async openProject(idOrPath: string): Promise<boolean> {
		if (!this.canNavigate()) return false;
		await this.refresh();
		const matches = this.data?.projects.filter(p => p.id === idOrPath || p.path === idOrPath) ?? [];
		if (matches.length !== 1 || !matches[0].id) { new Notice("프로젝트를 하나로 찾지 못했어요. 등록부와 허브 id를 확인해 주세요."); return false; }
		this.selectedId = matches[0].id;
		this.milestoneStates.set(matches[0].path, { open: true });
		await this.refresh(); this.contentEl.scrollTop = 0;
		this.rootEl.querySelector<HTMLElement>(".pf-workspace h1")?.focus();
		this.app.workspace.requestSaveLayout();
		return true;
	}

	private async connectGoal(p: Project, g?: Goal, link = true): Promise<void> {
		if (!this.canNavigate() || p.archived) return;
		if (!g) {
			const connected = projectGoalLinks(p, this.data!.goals);
			const options = this.data!.goals.filter(g => g.type === "sub-goal" && !connected.some(l => l.id === g.id && !l.oneSided));
			if (!options.length) { new Notice("연결할 하위 목표가 없어요. Pinboard에서 먼저 만들어 주세요."); return; }
			const picked = await pickTarget(this.app, "연결할 하위 목표", options.map(goal => ({ label: goal.title, sub: goal.id, goal })));
			if (!picked) return; g = picked.goal;
		} else if (!link) {
			const answer = await askForm(this.app, { title: "목표 연결 해제", desc: `「${g.title}」와 연결만 해제합니다. 목표·프로젝트·자료는 지우지 않아요.`, fields: [], cta: "연결 해제" });
			if (!answer) return;
		}
		const goal = g;
		await this.run(() => connectProject(this.plugin, goal, p.path, link, todayIso()));
	}

	/** 루미: the project open in the workspace. */
	lumiItem(): string | undefined {
		return this.selectedId ? this.data?.projects.find((p) => p.id === this.selectedId)?.title : undefined;
	}

	private renderProject(root: HTMLElement, p: Project, d: Loaded): void {
		root.empty();
		this.workspaceComponent = this.addChild(new Component());
		let schedule = this.scheduleStates.get(p.id);
		if (!schedule) { schedule = { month: todayIso().slice(0, 7), draft: "" }; this.scheduleStates.set(p.id, schedule); }
		const choose = (item: ScheduleItem) => schedule?.select?.(item);
		const navigate = (fn: () => void) => { if (this.canNavigate()) fn(); };
		renderWorkspace(root, p, {
			app: this.app, component: this.workspaceComponent, goals: d.goals, elements: d.elements, paths: this.app.vault.getFiles().map(f => f.path), text: d.texts.get(p.id) ?? "",
			back: () => navigate(() => { this.selectedId = null; this.render(); this.app.workspace.requestSaveLayout(); }),
			raw: () => this.openHub(p), edit: () => void this.editInfo(p), remove: () => void this.remove(p),
			status: () => navigate(() => { void (async () => { const picked = await pickTarget(this.app, "프로젝트 상태", PROJECT_STATUSES.map(status => ({ label: status === "완료" ? "완료하고 보관…" : status, status }))); if (picked) await this.moveTo(p, picked.status); })(); }),
			goal: id => navigate(() => { void this.plugin.openPinboardGoal(id); }),
			link: () => void this.connectGoal(p), unlink: g => void this.connectGoal(p, g, false), repair: g => void this.connectGoal(p, g),
			file: path => navigate(() => { const f = this.app.vault.getAbstractFileByPath(path); if (f instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(f); else new Notice(`파일을 찾지 못했어요: ${path}`); }),
			wheel: e => navigate(() => { void this.app.workspace.openLinkText(`${flywheelPath(this.plugin.settings.flywheelPath)}#${e.id} ${e.name}`, p.path, "tab"); }),
			milestones: el => { let ms = this.milestoneStates.get(p.path); if (!ms) { ms = { open: true }; this.milestoneStates.set(p.path, ms); } renderMilestones(el, p, ms, (change, expected) => saveMilestone(this.plugin, p, expected, change, todayIso()), () => this.refresh(), m => choose({kind:"milestone",projectPath:p.path,projectId:p.id,line:m.line,title:m.text,source:p.milestoneSource??"",date:m.due}), (el,m) => scheduleSource(el,this.plugin,{kind:"milestone",projectPath:p.path,projectId:p.id,line:m.line,title:m.text,source:p.milestoneSource??"",date:m.due})); },
			schedule: el => renderProjectSchedule(el, this.plugin, p, d.tasks.get(p.id) ?? [], schedule!, () => this.refresh(), d.texts.get(p.id) ?? ""),
		});
	}

	private render(): void {
		if (!this.rootEl) return;
		if (this.scheduleLocked() || this.rootEl.querySelector(".pf-ms-editor, .pf-ms-remove") || [...this.milestoneStates.values()].some(s => s.busy)) return;
		if (this.workspaceComponent) { this.removeChild(this.workspaceComponent); this.workspaceComponent = null; }
		if (this.selectedId && this.data) {
			const matches = this.data.projects.filter(p => p.id === this.selectedId);
			if (matches.length === 1) return this.renderProject(this.rootEl, matches[0], this.data);
			this.selectedId = null; new Notice("프로젝트가 삭제되었거나 현재 경로에서 찾을 수 없어요.");
		}
		if (Platform.isMobile) return renderProjectsMobile(this.mobileHost());
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

	/** What the mobile layout (`./mobile.ts`) may use: the desktop pieces, and the kanban drop's call. */
	private mobileHost(): ProjectsMobileHost {
		const d = (): Loaded => this.data!;
		return {
			app: this.app,
			contentEl: this.contentEl,
			rootEl: this.rootEl,
			mode: this.mode,
			loaded: () => !!this.data,
			projectCount: () => d().projects.length,
			kanban: () => buildKanban(d().projects, this.filter),
			groups: () => groupByArea(d().projects, this.filter, d().pinAreas),
			renderTop: (root) => this.renderTop(root, d()),
			renderEmpty: (root) => this.renderEmpty(root),
			renderList: (root) => this.renderList(root, d()),
			renderTimeline: (root) => this.renderTimeline(root, d()),
			renderCard: (parent, p, showStatus) => this.renderCard(parent, p, todayIso(), showStatus),
			showTimeline: () => this.setMode("timeline"),
			footText: () => `원본: ${activeRoot(this.plugin)}/<개인|회사>/ · 완료: ${archiveRoot(this.plugin)}/ · 허브 ${d().projects.length}개`,
			// The same call as the kanban column drop (dropZone).
			move: (t, p) => runProjectTarget(t, p, { moveTo: (x, st) => this.moveTo(x, st) }),
			register: (cb) => this.register(cb),
			canNavigate: () => this.canNavigate(),
		};
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
					if (!this.canNavigate()) return;
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
			tip(head.createSpan({ cls: "pf-col-name", text: col.status }), STATUS_HINT[col.status]);
			head.createSpan({ cls: "pf-col-count", text: String(col.total) });
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

		const name = card.createEl("h3", { cls: "pf-name" }).createEl("button", { text: p.title, attr: { type: "button", title: "프로젝트 관리" } });
		name.addEventListener("click", () => void this.openProject(p.id));

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
			for (const g of p.goals) { const chip = chips.createEl("button", { cls: "pf-chip", text: this.data?.goals.find(x => x.id === g)?.title ?? g, attr: { type: "button" } }); chip.addEventListener("click", () => { if (this.canNavigate()) void this.plugin.openPinboardGoal(g); }); }
		}

		let ms = this.milestoneStates.get(p.path);
		if (!ms) { ms = { open: false }; this.milestoneStates.set(p.path, ms); }
		renderMilestones(card, p, ms, (change, expected) => saveMilestone(this.plugin, p, expected, change, todayIso()), () => this.refresh(), m => { void this.openProject(p.id).then(ok => { if(ok)this.scheduleStates.get(p.id)?.select?.({kind:"milestone",projectPath:p.path,projectId:p.id,line:m.line,title:m.text,source:p.milestoneSource??"",date:m.due}); }); }, (el,m) => scheduleSource(el,this.plugin,{kind:"milestone",projectPath:p.path,projectId:p.id,line:m.line,title:m.text,source:p.milestoneSource??"",date:m.due}));

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
		menu.addItem(i => i.setTitle("프로젝트 관리").setIcon("folder-kanban").onClick(() => void this.openProject(p.id)));
		menu.addItem((i) =>
			i
				.setTitle("원문 열기")
				.setIcon("file-text")
				.onClick(() => this.openHub(p)),
		);
		if (!p.archived) {
			menu.addItem((i) => i.setTitle("정보 수정…").setIcon("pencil").onClick(() => void this.editInfo(p)));
			menu.addItem((i) =>
				i
					.setTitle("삭제…")
					.setIcon("trash-2")
					.setWarning(true)
					.onClick(() => void this.remove(p)),
			);
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
			const bar = row.createDiv({ cls: `pf-tl-bar${b.clippedStart ? " is-clip-start" : ""}${b.clippedEnd ? " is-clip-end" : ""}`, attr: { title: "프로젝트 관리", role: "button", tabindex: "0" } });
			bar.style.left = `${(b.from / 12) * 100}%`;
			bar.style.width = `${((b.to - b.from) / 12) * 100}%`;
			bar.addEventListener("click", () => void this.openProject(p.id));
			bar.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void this.openProject(p.id); } });
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
