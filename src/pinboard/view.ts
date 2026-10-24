import {
	debounce,
	ItemView,
	Keymap,
	Menu,
	moment,
	normalizePath,
	Notice,
	setIcon,
	TAbstractFile,
	TFile,
	TFolder,
	type ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { toIsoDate } from "../parser.ts";
import { cleanFolder } from "../settings.ts";
import {
	applyIndexEdit,
	appendProgressLog,
	INDEX_FILE,
	indexPathCell,
	indexProgressCell,
	indexToken,
	PROGRESS_SECTION,
	type RowUpdate,
} from "./index-writer.ts";
import {
	areaColor,
	type Board,
	buildBoard,
	bulletItems,
	computeSubProgress,
	dday,
	displayMainProgress,
	displaySubProgress,
	findSectionText,
	fmtNum,
	fmtVal,
	type Goal,
	GOAL_STATUSES,
	KIND_KO,
	MEASURE_KO,
	missingFields,
	NEED,
	paceHint,
	parseGoal,
	parseInputValue,
	parseSections,
	rollupMain,
	STATUS_KO,
	valueToString,
	wikilinkName,
	yearInfo,
} from "./model.ts";

export const VIEW_TYPE_PINBOARD = "mylogs-pinboard";

const EXCLUDE_DIRS = new Set(["_Templates", "_build"]);

function todayIso(): string {
	return toIsoDate(new Date());
}

interface Loaded {
	year: number | null;
	years: number[];
	goals: Goal[];
	files: Map<string, TFile>;
	sections: Map<string, Map<string, string>>;
	board: Board;
}

export class PinboardView extends ItemView {
	readonly plugin: MyLogsPlugin;
	/** The year shown; null = default (this year, else the latest year folder). */
	year: number | null = null;

	private rootEl!: HTMLElement;
	private data: Loaded | null = null;
	private loadSeq = 0;
	/** An inline editor is open; refreshes wait until it closes. */
	private editing = 0;
	private refreshPending = false;
	private animateNext = true;

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
			this.animateNext = true;
			await this.refresh();
		}
		await super.setState(state, result);
	}

	// ── paths ──

	folder(): string {
		return cleanFolder(this.plugin.settings.pinboardFolder);
	}

	private inFolder(path: string): boolean {
		const f = this.folder();
		return path === f || path.startsWith(`${f}/`);
	}

	private yearFolders(): number[] {
		const root = this.app.vault.getAbstractFileByPath(normalizePath(this.folder()));
		if (!(root instanceof TFolder)) return [];
		return root.children
			.filter((c): c is TFolder => c instanceof TFolder && /^\d{4}$/.test(c.name))
			.map((c) => Number(c.name))
			.sort((a, b) => a - b);
	}

	private goalFiles(year: number): TFile[] {
		const prefix = normalizePath(`${this.folder()}/${year}`) + "/";
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).split("/").some((p) => EXCLUDE_DIRS.has(p)));
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
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (this.inFolder(f.path)) this.scheduleRefresh();
			}),
		);
		const onFile = (f: TAbstractFile, old?: string) => {
			if (this.inFolder(f.path) || (old && this.inFolder(old))) this.scheduleRefresh();
		};
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile(f, old)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile(f)));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.rootEl?.empty();
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

	private async loadData(): Promise<Loaded> {
		const years = this.yearFolders();
		const thisYear = new Date().getFullYear();
		let year: number | null = this.year;
		if (year === null || !years.includes(year)) {
			year = years.includes(thisYear) ? thisYear : years.length ? years[years.length - 1] : null;
		}
		const goals: Goal[] = [];
		const files = new Map<string, TFile>();
		const sections = new Map<string, Map<string, string>>();
		if (year !== null) {
			for (const f of this.goalFiles(year)) {
				const g = parseGoal(this.app.metadataCache.getFileCache(f)?.frontmatter, f.path);
				if (!g) continue;
				goals.push(g);
				files.set(f.path, f);
				const text = await this.app.vault.cachedRead(f);
				const fmEnd = this.app.metadataCache.getFileCache(f)?.frontmatterPosition?.end.offset ?? 0;
				sections.set(f.path, parseSections(text.slice(fmEnd)));
			}
		}
		return { year, years, goals, files, sections, board: buildBoard(goals) };
	}

	private beginEdit(): void {
		this.editing++;
	}

	private endEdit(): void {
		this.editing = Math.max(0, this.editing - 1);
		if (this.editing === 0 && this.refreshPending) this.scheduleRefresh();
	}

	// ── rendering ──

	private render(): void {
		const root = this.rootEl;
		const d = this.data;
		root.empty();
		root.toggleClass("pb-animate", this.animateNext);
		this.animateNext = false;
		if (!d) return;
		const today = todayIso();

		if (d.year === null) {
			const empty = root.createDiv({ cls: "pb-empty" });
			empty.createDiv({ cls: "pb-empty-title", text: "Pinboard 연도 폴더가 없어요" });
			empty.createEl("code", { text: `${this.folder()}/<YYYY>/` });
			return;
		}
		const sectionsOf = (p: string) => d.sections.get(p) ?? new Map<string, string>();
		const missing = missingFields(d.board, sectionsOf);

		this.renderHero(root, d, today, missing.length);

		const legend = root.createDiv({ cls: "pb-legend" });
		legend.createSpan({ cls: "pb-ttl", text: "영역" });
		for (const a of d.board.areas) {
			const [a1, a2] = areaColor(a, d.board.areas);
			const dot = legend.createSpan({ cls: "pb-dot", text: a });
			dot.style.setProperty("--a", a1);
			dot.style.setProperty("--a2", a2);
		}

		const grid = root.createDiv({ cls: "pb-grid" });
		d.board.cards.forEach((c, i) => this.renderMain(grid, c.main, c.subs, i, today, d));
		if (d.board.orphans.length) this.renderOrphans(grid, d.board.orphans, d.board.cards.length, today, d);
		if (!d.board.cards.length && !d.board.orphans.length) {
			const g = grid.createDiv({ cls: "pb-goal" });
			g.style.setProperty("--a", "#f0642e");
			g.style.setProperty("--a2", "#ffb02e");
			g.createDiv({ cls: "pb-goal-head" }).createEl("h2", { text: `${d.year}년 목표가 아직 없어요` });
			g.createDiv({ cls: "pb-goal-foot" });
		}

		const todo = root.createDiv({ cls: "pb-todo" });
		if (missing.length) {
			todo.createEl("h2", { text: `채워 넣을 칸 ${missing.length}개` });
			todo.createEl("p", { cls: "pb-sub", text: "비어 있는 값은 지어내지 않고 그대로 비워 두었습니다. 노트에 적으면 바로 반영됩니다." });
			const ul = todo.createEl("ul");
			for (const m of missing) {
				const li = ul.createEl("li");
				li.createSpan({ cls: "pb-gid", text: m.id });
				li.appendText(`${m.title} — `);
				li.createEl("b", { text: m.field });
			}
		} else {
			todo.addClass("is-clear");
			todo.createEl("h2", { text: "모든 칸이 채워져 있어요" });
		}

		const updated = d.goals.map((g) => g.updated).filter((u) => /^\d{4}-\d{2}-\d{2}/.test(u)).sort();
		const foot = root.createDiv({ cls: "pb-foot" });
		foot.appendText("노트 최종 갱신 ");
		foot.createEl("b", { text: updated[updated.length - 1] ?? "미정" });
		foot.createEl("br");
		foot.appendText(`원본: ${this.folder()}/${d.year}/ 노트 ${d.goals.length}개`);
	}

	private renderHero(root: HTMLElement, d: Loaded, today: string, missingCount: number): void {
		const year = d.year!;
		const hero = root.createDiv({ cls: "pb-hero" });
		hero.createDiv({ cls: "pb-rays" });
		hero.createDiv({ cls: "pb-sun" });
		hero.createDiv({ cls: "pb-horizon" });

		const top = hero.createDiv({ cls: "pb-hero-top" });
		const left = top.createDiv();
		const eyebrow = left.createDiv({ cls: "pb-eyebrow" });
		eyebrow.createSpan({ text: "Goals · 매일 보는 방향" });
		const h1 = left.createEl("h1");
		if (d.years.length > 1) {
			const sel = h1.createEl("select", { cls: "pb-year-select", attr: { "aria-label": "연도 고르기" } });
			for (const y of d.years) sel.createEl("option", { text: String(y), value: String(y) });
			sel.value = String(year);
			sel.addEventListener("change", () => {
				this.year = Number(sel.value);
				this.animateNext = true;
				void this.refresh();
				this.app.workspace.requestSaveLayout();
			});
		} else h1.createSpan({ cls: "pb-yr", text: String(year) });
		h1.appendText(" Pinboard");
		left.createEl("p", { cls: "pb-tagline", text: "오늘의 한 걸음이 올해의 나를 바꾼다. 해는 이미 떠오르고 있다." });

		const yi = yearInfo(year, today);
		const cd = top.createDiv({ cls: "pb-countdown" });
		cd.createSpan({ cls: "pb-num", text: String(yi.daysLeft) });
		cd.createSpan({ cls: "pb-lbl", text: yi.label });

		const track = hero.createDiv({ cls: "pb-yeartrack" });
		track.style.setProperty("--p", `${yi.pct.toFixed(2)}%`);
		const bar = track.createDiv({ cls: "pb-bar" });
		bar.createDiv({ cls: "pb-fill" });
		bar.createDiv({ cls: "pb-now" });
		const marks = track.createDiv({ cls: "pb-marks" });
		marks.createSpan({ text: `${year}.01.01` });
		marks.createSpan({ text: `오늘 ${moment().format("LL")} · 올해 ${Math.round(yi.pct)}% 지남` });
		marks.createSpan({ text: `${year}.12.31` });

		const b = d.board;
		const stats = hero.createDiv({ cls: "pb-stats" });
		const stat = (n: string, label: string, warm = false) => {
			const s = stats.createDiv({ cls: `pb-stat${warm ? " is-warm" : ""}` });
			s.createEl("b", { text: n });
			s.appendText(label);
		};
		stat(String(b.mains.length), "핵심 목표");
		stat(String(b.subs.length), "측정 기준");
		stat(String(b.subs.filter((s) => s.status === "achieved").length), "달성");
		const upcoming = b.subs
			.filter((s) => s.due && s.due >= today && s.status === "active")
			.sort((x, y) => (x.due < y.due ? -1 : x.due > y.due ? 1 : 0))[0];
		if (upcoming) stat(dday(upcoming.due, today).big.replace("D-DAY", "D-0"), `다음 기한 · ${upcoming.title}`, true);
		if (missingCount) stat(String(missingCount), "채울 칸");
	}

	private goalSection(parent: HTMLElement, area: string, idx: number, areas: string[]): HTMLElement {
		const [a1, a2] = areaColor(area, areas);
		const sec = parent.createDiv({ cls: "pb-goal" });
		sec.style.setProperty("--a", a1);
		sec.style.setProperty("--a2", a2);
		sec.style.setProperty("--i", String(idx));
		return sec;
	}

	private renderMain(grid: HTMLElement, m: Goal, subs: Goal[], idx: number, today: string, d: Loaded): void {
		const area = m.area || "기타";
		const sec = this.goalSection(grid, area, idx, d.board.areas);
		const secs = d.sections.get(m.path) ?? new Map<string, string>();

		const head = sec.createDiv({ cls: "pb-goal-head" });
		const txt = head.createDiv({ cls: "pb-txt" });
		const tagrow = txt.createDiv({ cls: "pb-tagrow" });
		tagrow.createSpan({ cls: "pb-area", text: area });
		this.statusChip(tagrow, m, d);
		tagrow.createSpan({ cls: "pb-gid", text: m.id });
		const h2 = txt.createEl("h2", { cls: "pb-title", text: m.title });
		this.linkToNote(h2, m);

		const r = displayMainProgress(m, subs);
		const ring = head.createDiv({ cls: "pb-ring" });
		ring.style.setProperty("--p", r.progress.toFixed(1));
		const rs = ring.createSpan();
		rs.createEl("b", { text: `${Math.round(r.progress)}%` });
		rs.createEl("small", { text: `${fmtNum(r.subAchieved)}/${fmtNum(r.subTotal)} 달성` });

		const story = sec.createDiv({ cls: "pb-story" });
		const why = bulletItems(findSectionText(secs, "왜 이 목표인가", "왜"));
		const vision = bulletItems(findSectionText(secs, "달성한 모습"));
		this.storyBox(story, "왜 이 목표인가", why, "why", "아직 비어 있어요. 이 목표가 왜 중요한지 한 줄 적어 주세요.");
		this.storyBox(story, "달성한 모습", vision, "vision", "아직 비어 있어요. 이루어진 날의 장면을 적어 주세요.");

		sec.createDiv({ cls: "pb-sec-label", text: `측정 기준 · ${subs.length}개` });
		const krs = sec.createDiv({ cls: "pb-krs" });
		if (subs.length) subs.forEach((s) => this.renderSub(krs, s, today, d));
		else krs.createDiv({ cls: "pb-kr" }).createSpan({ cls: "pb-chip is-need", text: "측정 기준(Sub Goal) 입력 필요" });

		sec.createDiv({ cls: "pb-sec-label", text: "수단 · 프로젝트와 습관" });
		const chips = sec.createDiv({ cls: "pb-chips" });
		const means = bulletItems(findSectionText(secs, "수단 (프로젝트·습관)", "수단"));
		if (means.length) means.forEach((x) => chips.createSpan({ cls: "pb-chip", text: x }));
		else chips.createSpan({ cls: "pb-chip is-need", text: `수단 ${NEED}` });
		sec.createDiv({ cls: "pb-goal-foot" });
	}

	private renderOrphans(grid: HTMLElement, orphans: Goal[], idx: number, today: string, d: Loaded): void {
		const sec = this.goalSection(grid, "기타", idx, d.board.areas);
		const head = sec.createDiv({ cls: "pb-goal-head" });
		head.createDiv({ cls: "pb-txt" }).createEl("h2", { cls: "pb-title", text: "상위 목표를 찾지 못한 Sub Goal" });
		const story = sec.createDiv({ cls: "pb-story" });
		this.storyBox(story, "확인", ["parent 값이 Main Goal id와 맞지 않습니다. parent를 고치면 해당 카드로 옮겨집니다."], "why", "");
		const krs = sec.createDiv({ cls: "pb-krs" });
		orphans.forEach((s) => this.renderSub(krs, s, today, d));
		sec.createDiv({ cls: "pb-goal-foot" });
	}

	private storyBox(parent: HTMLElement, label: string, items: string[], cls: string, emptyText: string): void {
		const q = parent.createDiv({ cls: `pb-q ${items.length ? `is-${cls}` : "is-empty"}` });
		q.createSpan({ cls: "pb-k", text: label });
		const p = q.createEl("p");
		if (!items.length) {
			p.setText(emptyText);
			return;
		}
		items.forEach((x, i) => {
			if (i) p.createEl("br");
			p.appendText(x);
		});
	}

	private renderSub(parent: HTMLElement, s: Goal, today: string, d: Loaded): void {
		const secs = d.sections.get(s.path) ?? new Map<string, string>();
		const kr = parent.createDiv({ cls: `pb-kr st-${s.status}` });
		const top = kr.createDiv({ cls: "pb-kr-top" });
		const left = top.createDiv();
		const h3 = left.createEl("h3", { cls: "pb-title", text: s.title });
		this.linkToNote(h3, s);
		const meta = left.createDiv({ cls: "pb-meta" });
		this.statusChip(meta, s, d);
		if (MEASURE_KO[s.measure]) meta.createSpan({ cls: "pb-pill", text: MEASURE_KO[s.measure] });
		if (KIND_KO[s.kind]) meta.createSpan({ cls: "pb-pill", text: KIND_KO[s.kind] });
		const dd = dday(s.due, today);
		const ddEl = top.createDiv({ cls: `pb-dday${dd.cls ? ` is-${dd.cls}` : ""}` });
		ddEl.createEl("b", { text: dd.big });
		if (dd.small) ddEl.createEl("small", { text: dd.small });

		const prog = displaySubProgress(s);
		const pr = kr.createDiv({ cls: `pb-prog${prog === null ? " is-unknown" : ""}` });
		const bar = pr.createDiv({ cls: "pb-bar" });
		const cap = pr.createDiv({ cls: "pb-pcap" });
		if (prog === null) {
			cap.createSpan({ text: "진척률" });
			cap.createEl("b", { text: "미정" });
		} else {
			pr.style.setProperty("--p", `${prog.toFixed(1)}%`);
			bar.createDiv({ cls: "pb-fill" });
			bar.createDiv({ cls: "pb-spark" });
			cap.createSpan({ text: prog === 0 ? "출발선에 섰다" : prog >= 100 ? "달성!" : "진행 중" });
			cap.createEl("b", { text: `${Math.round(prog)}%` });
		}

		const metric = s.measure === "metric";
		const path = kr.createDiv({ cls: `pb-path${metric ? "" : " is-two"}` });
		const arrow = () => path.createSpan({ cls: "pb-arr", text: "→" });
		if (metric) {
			this.node(path, "시작", s.baseline, s.unit, "base");
			arrow();
			this.currentNode(path, "현재", s, d);
			arrow();
			this.node(path, "목표", s.target, s.unit, "tgt");
		} else {
			this.currentNode(path, "현재", s, d);
			arrow();
			this.node(path, "달성 조건", s.target, s.unit, "tgt");
		}

		const hint = paceHint(s, today);
		if (hint) {
			const p = kr.createEl("p", { cls: "pb-hint" });
			p.appendText("목표까지 ");
			p.createEl("b", { text: `${hint.remain}${s.unit}` });
			if (hint.perWeek) {
				p.appendText(` · 남은 ${hint.weeks}주 동안 주 `);
				p.createEl("b", { text: `${hint.perWeek}${s.unit}` });
				p.appendText("씩");
			}
		}

		const chipsList: [string, boolean][] = [
			...s.projects.map((p) => [wikilinkName(p), true] as [string, boolean]),
			...bulletItems(findSectionText(secs, "수단")).map((x) => [x, false] as [string, boolean]),
		];
		if (chipsList.length) {
			const chips = kr.createDiv({ cls: "pb-chips" });
			for (const [t, link] of chipsList) chips.createSpan({ cls: `pb-chip${link ? " is-link" : ""}`, text: t });
		}

		// 진척 기록
		const log = bulletItems(findSectionText(secs, PROGRESS_SECTION));
		const logEl = kr.createDiv({ cls: "pb-log" });
		if (log.length) {
			const ul = logEl.createEl("ul");
			for (const l of log) ul.createEl("li", { text: l });
		}
		const add = logEl.createEl("button", { cls: "pb-log-add", attr: { type: "button" } });
		setIcon(add.createSpan({ cls: "pb-log-add-icon" }), "plus");
		add.appendText("진척 기록 추가");
		add.addEventListener("click", () => this.openLogInput(logEl, add, s, d));
	}

	private node(parent: HTMLElement, label: string, value: string, unit: string, cls: string): HTMLElement {
		const fv = fmtVal(value, unit);
		const n = parent.createDiv({ cls: `pb-node is-${cls}${fv ? "" : " is-need"}` });
		n.createSpan({ cls: "pb-k", text: label });
		const v = n.createSpan({ cls: "pb-v" });
		if (!fv) v.setText(NEED);
		else {
			v.setText(fv[0]);
			if (fv[1]) v.createEl("small", { text: fv[1] });
		}
		return n;
	}

	/** The `current` node, editable in place. */
	private currentNode(parent: HTMLElement, label: string, s: Goal, d: Loaded): void {
		const n = this.node(parent, label, s.current, s.unit, "cur");
		n.addClass("is-editable");
		n.setAttr("role", "button");
		n.setAttr("tabindex", "0");
		n.setAttr("aria-label", `${s.title} 현재 값 고치기`);
		n.setAttr("title", "눌러서 현재 값 고치기");
		const open = () => {
			if (n.hasClass("is-editing")) return;
			n.addClass("is-editing");
			this.beginEdit();
			const v = n.querySelector(".pb-v") as HTMLElement;
			v.hide();
			const input = n.createEl("input", {
				cls: "pb-input",
				attr: { type: "text", inputmode: s.measure === "metric" ? "decimal" : "text", "aria-label": `${s.title} 현재 값`, enterkeyhint: "done" },
			});
			input.value = s.current;
			let done = false;
			const close = async (save: boolean) => {
				if (done) return;
				done = true;
				const val = input.value.trim();
				input.remove();
				v.show();
				n.removeClass("is-editing");
				if (save && val && val !== s.current) {
					v.setText(val);
					await this.setCurrent(s, val, d);
				}
				this.endEdit();
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					void close(true);
				} else if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					void close(false);
				}
			});
			input.addEventListener("blur", () => void close(true));
			input.focus();
			input.select();
		};
		n.addEventListener("click", open);
		n.addEventListener("keydown", (e) => {
			if ((e.key === "Enter" || e.key === " ") && e.target === n) {
				e.preventDefault();
				open();
			}
		});
	}

	private statusChip(parent: HTMLElement, g: Goal, d: Loaded): void {
		const chip = parent.createEl("button", {
			cls: `pb-status is-${g.status}`,
			text: STATUS_KO[g.status] ?? g.status,
			attr: { type: "button", "aria-label": `상태: ${STATUS_KO[g.status] ?? g.status} · 바꾸기` },
		});
		chip.addEventListener("click", (e) => {
			e.stopPropagation();
			const menu = new Menu();
			for (const st of GOAL_STATUSES) {
				menu.addItem((it) =>
					it
						.setTitle(STATUS_KO[st])
						.setChecked(st === g.status)
						.onClick(() => {
							if (st !== g.status) void this.setStatus(g, st, d);
						}),
				);
			}
			menu.showAtMouseEvent(e);
		});
	}

	private linkToNote(el: HTMLElement, g: Goal): void {
		el.addClass("is-link");
		el.setAttr("title", "노트 열기");
		el.addEventListener("click", (e) => {
			const f = this.data?.files.get(g.path);
			if (f) void this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f);
		});
	}

	private openLogInput(logEl: HTMLElement, btn: HTMLElement, s: Goal, d: Loaded): void {
		if (logEl.querySelector(".pb-log-input")) return;
		this.beginEdit();
		btn.hide();
		const input = logEl.createEl("input", {
			cls: "pb-input pb-log-input",
			attr: { type: "text", placeholder: "무엇이 달라졌나요?", "aria-label": "진척 기록", enterkeyhint: "done" },
		});
		let done = false;
		const close = async (save: boolean) => {
			if (done) return;
			done = true;
			const val = input.value.trim();
			input.remove();
			btn.show();
			if (save && val) await this.addProgressLog(s, val, d);
			this.endEdit();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				void close(true);
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				void close(false);
			}
		});
		input.addEventListener("blur", () => void close(false));
		input.focus();
	}

	// ── writes ──

	private fileOf(g: Goal, d: Loaded): TFile | null {
		const f = d.files.get(g.path) ?? this.app.vault.getAbstractFileByPath(g.path);
		return f instanceof TFile ? f : null;
	}

	/** Set a Sub Goal's `current`, recompute its `progress`, then update the index. */
	private async setCurrent(s: Goal, raw: string, d: Loaded): Promise<void> {
		const file = this.fileOf(s, d);
		if (!file) return;
		const today = todayIso();
		const value = parseInputValue(raw);
		let old = "";
		let next: Goal | null = null;
		try {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				old = valueToString(fm.current);
				fm.current = value;
				const g = parseGoal(fm, file.path);
				const p = g ? computeSubProgress(g) : null;
				if (p !== null) fm.progress = p;
				fm.updated = today;
				next = parseGoal(fm, file.path);
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard save failed", err);
			new Notice(`MyLogs: ${s.id} 저장에 실패했어요.`);
			return;
		}
		const g = next as Goal | null;
		if (!g) return;
		const row: RowUpdate = { id: g.id, current: indexToken(g.current, g.measure), path: indexPathCell(g) };
		if (g.progress !== null) row.progress = indexProgressCell(g.progress);
		await this.updateIndex(d, [row], `${g.id} current ${indexToken(old, g.measure)} → ${indexToken(g.current, g.measure)} (플러그인)`);
	}

	/** Change a goal's status; for a Sub Goal, also roll up its Main Goal. */
	private async setStatus(g: Goal, status: string, d: Loaded): Promise<void> {
		const file = this.fileOf(g, d);
		if (!file) return;
		const today = todayIso();
		const old = g.status;
		let progress: number | null = null;
		try {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				fm.status = status;
				if (g.type === "sub-goal") {
					const cur = parseGoal(fm, file.path);
					const p = cur ? computeSubProgress(cur) : null;
					if (p !== null) fm.progress = p;
				}
				progress = parseGoal(fm, file.path)?.progress ?? null;
				fm.updated = today;
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard save failed", err);
			new Notice(`MyLogs: ${g.id} 저장에 실패했어요.`);
			return;
		}

		const rows: RowUpdate[] = [];
		let log = `${g.id} status ${old} → ${status}`;
		if (g.type === "main-goal") {
			rows.push({ id: g.id, status });
		} else {
			const row: RowUpdate = { id: g.id, status };
			if (progress !== null) row.progress = indexProgressCell(progress);
			rows.push(row);
			const main = d.board.mains.find((m) => m.id === g.parent);
			const mainFile = main ? this.fileOf(main, d) : null;
			if (main && mainFile) {
				const siblings = d.board.subs.filter((x) => x.parent === main.id).map((x) => (x.path === g.path ? { ...x, status } : x));
				const r = rollupMain(siblings);
				try {
					await this.app.fileManager.processFrontMatter(mainFile, (fm: Record<string, unknown>) => {
						fm.sub_total = r.subTotal;
						fm.sub_achieved = r.subAchieved;
						fm.progress = r.progress;
						fm.updated = today;
					});
					rows.push({ id: main.id, progress: indexProgressCell(r.progress, r) });
					log += `, ${main.id} ${r.subAchieved}/${r.subTotal} 달성 ${r.progress}%`;
				} catch (err) {
					console.error("[MyLogs] Pinboard save failed", err);
					new Notice(`MyLogs: ${main.id}의 달성 수를 저장하지 못했어요.`);
				}
			}
		}
		await this.updateIndex(d, rows, `${log} (플러그인)`);
	}

	private async addProgressLog(s: Goal, text: string, d: Loaded): Promise<void> {
		const file = this.fileOf(s, d);
		if (!file) return;
		const today = todayIso();
		try {
			await this.app.vault.process(file, (data) => appendProgressLog(data, today, text));
		} catch (err) {
			console.error("[MyLogs] Pinboard save failed", err);
			new Notice(`MyLogs: ${s.id} 진척 기록을 저장하지 못했어요.`);
			return;
		}
		await this.updateIndex(d, [], `${s.id} 진척 기록 추가 (플러그인)`);
	}

	/** AGENTS.md 「인덱스 규칙」: rows of the affected ids, 변경 기록, `updated`. */
	private async updateIndex(d: Loaded, rows: RowUpdate[], log: string): Promise<void> {
		const file = this.indexFile();
		if (!file) {
			new Notice(`MyLogs: ${INDEX_FILE}을 찾지 못해 인덱스를 갱신하지 못했어요. 목표 노트는 저장됐어요.`);
			return;
		}
		let missing: string[] = [];
		try {
			await this.app.vault.process(file, (data) => {
				const r = applyIndexEdit(data, { year: String(d.year), rows, log, today: todayIso() });
				missing = r.missing;
				return r.text;
			});
		} catch (err) {
			console.error("[MyLogs] Pinboard index update failed", err);
			new Notice(`MyLogs: ${INDEX_FILE} 갱신에 실패했어요. 목표 노트는 저장됐어요.`);
			return;
		}
		if (missing.length) {
			new Notice(`MyLogs: ${INDEX_FILE}의 ${d.year} 표에서 ${missing.join(", ")} 행을 찾지 못했어요. 목표 노트는 저장됐어요.`);
		}
	}
}
