import { ItemView, Keymap, Menu, Notice, setIcon, type TAbstractFile, TFile, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { addDays } from "../parser.ts";
import { todayIsoLocal, shiftMonth } from "../desk/model.ts";
import { pickMonth, promptText } from "../desk/modals.ts";
import { askForm, confirmDelete } from "../ui/modals.ts";
import { valueToString } from "../pinboard/model.ts";
import { cleanFolder } from "../settings.ts";
import { createProject, takenIdsAndNames } from "../projects/actions.ts";
import { askNewProject } from "../projects/modals.ts";
import { type Candidate, defaultSection, extractCandidates } from "./candidates.ts";
import {
	acceptCandidate,
	createDrawerFile,
	dailyPadPath,
	deleteDrawerItem,
	drawerPath,
	editDrawerItem,
	fileAt,
	letGoItem,
	markTakenOutTo,
	moveToSection,
	putIntoDrawer,
	removeCandidateLine,
	takeOutMonth,
	takeOutToday,
} from "./actions.ts";
import { askNewItem, askWhen } from "./modals.ts";
import {
	activeCount,
	CANDIDATE_TAGS,
	type ColumnData,
	columns,
	daysSinceReview,
	DRAWER_SECTIONS,
	type DrawerData,
	type DrawerItem,
	type DrawerSection,
	goalIdOf,
	isActive,
	isNew,
	isStale,
	parseDrawer,
	TOO_MANY,
	WHEN_UNDECIDED,
} from "./model.ts";

export const VIEW_TYPE_DRAWER = "mylogs-drawer";
const PINBOARD_COMMAND = "mylogs:open-pinboard";
const PINBOARD_VIEW = "mylogs-pinboard";

const SECTION_HINT: Record<DrawerSection, string> = {
	보류: "하기로 했지만 미룬 일. 꺼내면 할 일이 된다",
	아이디어: "해 보고 싶은 것. 꺼내면 할 일이나 프로젝트가 된다",
	"프로젝트 후보": "세 세션 이상 반복된 주제. 꺼내면 프로젝트가 된다",
};

type TakeTarget = "today" | "month" | "wall" | "project";
type Drag = { kind: "item"; item: DrawerItem } | { kind: "cand"; cand: Candidate };

interface DropZone {
	el: HTMLElement;
	accepts: (d: Drag) => boolean;
	drop: (d: Drag) => void;
}

interface Cands {
	date: string;
	pad: TFile;
	list: Candidate[];
}

function dotDate(iso: string): string {
	return iso.replace(/-/g, ".");
}

/** `[[path|alias]]` → { target, label }, or null for plain text sources (`대화 YYYY-MM-DD`). */
function linkOf(src: string): { target: string; label: string } | null {
	const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(src.trim());
	if (!m) return null;
	return { target: m[1].trim(), label: (m[2] || m[1].split("/").pop() || m[1]).trim() };
}

export class DrawerView extends ItemView {
	readonly plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private data: DrawerData | null = null;
	private exists = false;
	private cands: Cands | null = null;
	private expanded = new Set<string>();
	private zones: DropZone[] = [];
	private drag: Drag | null = null;
	private busy = false;
	private pendingReload = false;
	private reloadTimer: number | null = null;
	private loadSeq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DRAWER;
	}

	getDisplayText(): string {
		return "Drawer";
	}

	getIcon(): string {
		return "archive";
	}

	// ── lifecycle ──

	private watchedPaths(): string[] {
		const today = todayIsoLocal();
		return [drawerPath(this.plugin), dailyPadPath(this.plugin, today), dailyPadPath(this.plugin, addDays(today, -1))];
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-drawer-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-drawer" });
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

	async reload(): Promise<void> {
		const seq = ++this.loadSeq;
		const f = fileAt(this.app, drawerPath(this.plugin));
		const data = f ? parseDrawer(await this.app.vault.read(f)) : null;
		const cands = await this.loadCandidates();
		if (seq !== this.loadSeq) return;
		this.exists = !!f;
		this.data = data;
		this.cands = cands;
		this.render();
	}

	/** Today's `## 결정 대기` 후보, or yesterday's when today has none (the user may not have opened today yet). */
	private async loadCandidates(): Promise<Cands | null> {
		const today = todayIsoLocal();
		for (const date of [today, addDays(today, -1)]) {
			const pad = fileAt(this.app, dailyPadPath(this.plugin, date));
			if (!pad) continue;
			const list = extractCandidates(await this.app.vault.read(pad), this.plugin.settings.sections.pending);
			if (list.length) return { date, pad, list };
		}
		return null;
	}

	/** Run a write; re-render afterwards. */
	private async run(fn: () => Promise<unknown>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.rootEl.addClass("is-busy");
		try {
			await fn();
		} catch (err) {
			console.error("[MyLogs] Drawer action failed", err);
			new Notice("MyLogs: 작업을 끝내지 못했어요. 콘솔을 확인해 주세요.");
		} finally {
			this.busy = false;
			this.pendingReload = false;
			this.rootEl.removeClass("is-busy");
			await this.reload();
		}
	}

	// ── rendering ──

	private render(): void {
		const root = this.rootEl;
		const scrollTop = this.contentEl.scrollTop;
		root.empty();
		this.zones = [];
		const today = todayIsoLocal();
		this.renderHeader(root, today);
		if (!this.exists || !this.data) {
			this.renderEmpty(root);
			return;
		}
		this.renderCandidates(root);
		this.renderBoard(root, this.data, today);
		this.renderDock(root);
		const foot = root.createDiv({ cls: "dr-foot" });
		foot.appendText("끌어다 놓기: 카드 → 다른 열(섹션 옮김) · 아래 꺼내기 칸(오늘 / 이달 / Wall / 프로젝트로) · 놓아주기 칸 · 후보 → 열(넣기와 분류를 한 번에). ⋯ 또는 오른쪽 클릭: 수정, 삭제. 나간 줄([>], [-])은 월간 리뷰가 지워요.");
		this.contentEl.scrollTop = scrollTop;
	}

	private btn(parent: HTMLElement, text: string, onClick: (e: MouseEvent) => void, o: { icon?: string; cls?: string; label?: string } = {}): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `dr-btn${o.cls ? ` ${o.cls}` : ""}`, attr: { type: "button" } });
		if (o.label) b.setAttr("aria-label", o.label);
		if (o.icon) setIcon(b.createSpan({ cls: "dr-btn-icon" }), o.icon);
		if (text) b.appendText(text);
		b.addEventListener("click", onClick);
		return b;
	}

	private renderHeader(root: HTMLElement, today: string): void {
		const top = root.createEl("header", { cls: "dr-top" });
		const left = top.createDiv();
		left.createDiv({ cls: "dr-eyebrow", text: "Drawer · 서랍" });
		left.createEl("h1", { text: "하기로 했는데 지금은 아닌 것" });
		left.createDiv({ cls: "dr-sub", text: "날짜 대신 다시 꺼낼 조건을 붙여 둔다. 들어오고, 분류되고, 나간다." });
		const right = top.createDiv({ cls: "dr-right" });
		const n = this.data ? activeCount(this.data) : 0;
		const cnt = right.createDiv({ cls: "dr-count" });
		cnt.createSpan({ cls: "dr-count-n", text: String(n) });
		cnt.appendText(" 항목");
		if (n > TOO_MANY) cnt.createSpan({ cls: "dr-badge dr-warn", text: `${TOO_MANY}개 초과 · 입구가 느슨해졌어요`, attr: { title: "보통 10~30개를 유지해요. 결정 대기와 못 한 일의 「서랍에」가 너무 쉽게 열려 있지 않은지 봐요." } });
		else if (this.data) cnt.createSpan({ cls: "dr-count-hint", text: "보통 10~30개" });
		cnt.createSpan({ cls: "dr-today", text: `오늘 ${dotDate(today)}` });
		const row = right.createDiv({ cls: "dr-controls" });
		if (this.exists) {
			this.btn(row, "넣기", () => void this.addManually(), { icon: "plus", cls: "dr-btn-primary" });
			this.btn(row, "", (e) => void this.openAt(0, e), { icon: "file-text", label: "Drawer.md 열기" });
		}
	}

	private renderEmpty(root: HTMLElement): void {
		const card = root.createDiv({ cls: "dr-empty" });
		card.createDiv({ cls: "dr-empty-title", text: "Drawer 파일이 아직 없어요" });
		card.createEl("code", { text: drawerPath(this.plugin) });
		card.createEl("p", { text: "보류 · 아이디어 · 프로젝트 후보 세 섹션과 변경 기록이 있는 빈 틀을 만들어요. 06 Drawer/AGENTS.md 「3. 파일 형식」과 같아요." });
		this.btn(card, "Drawer.md 만들기", () => void this.run(() => createDrawerFile(this.plugin)), { icon: "plus", cls: "dr-btn-primary" });
	}

	// ── 후보 띠 ──

	private renderCandidates(root: HTMLElement): void {
		const sec = root.createEl("section", { cls: "dr-cands" });
		const head = sec.createDiv({ cls: "dr-cands-head" });
		const c = this.cands;
		const today = todayIsoLocal();
		head.createSpan({ cls: "dr-lbl", text: c && c.date !== today ? "어제 들어온 후보" : "오늘 들어온 후보" });
		head.createSpan({ cls: "dr-cands-hint", text: c ? `Daily Pad ${dotDate(c.date)} · 결정 대기 · 넣기 / 놓아주기 둘 중 하나` : "Daily Pad 결정 대기의 #서랍후보 · #프로젝트후보가 여기에 보여요" });
		if (!c) {
			sec.createDiv({ cls: "dr-cands-none", text: "오늘은 들어온 후보가 없어요." });
			return;
		}
		const ul = sec.createEl("ul", { cls: "dr-cand-list" });
		for (const cand of c.list) {
			const li = ul.createEl("li", { cls: `dr-cand is-${cand.kind}` });
			li.draggable = true;
			li.setAttr("title", "열로 끌어 넣기와 분류를 한 번에");
			li.addEventListener("dragstart", (e) => this.onDragStart(e, { kind: "cand", cand }, li));
			li.addEventListener("dragend", () => this.onDragEnd());
			li.createSpan({ cls: "dr-cand-tag", text: `#${cand.kind === "project" ? CANDIDATE_TAGS.project : CANDIDATE_TAGS.drawer}` });
			const body = li.createDiv({ cls: "dr-cand-body" });
			body.createDiv({ cls: "dr-cand-text", text: cand.text });
			const meta = body.createDiv({ cls: "dr-meta" });
			if (cand.when) meta.createSpan({ cls: "dr-when", text: cand.when, attr: { title: "다시 꺼낼 조건 (when::)" } });
			else meta.createSpan({ cls: "dr-when is-missing", text: "조건 없음", attr: { title: "넣을 때 다시 꺼낼 조건을 물어요" } });
			this.renderSources(meta, cand.from);
			if (cand.test && this.plugin.settings.showTestMarkers) meta.createSpan({ cls: "dr-tdot", attr: { title: "#test 테스트 데이터" } });
			const btns = li.createDiv({ cls: "dr-cand-btns" });
			this.btn(btns, "넣기", () => void this.acceptCand(cand, null), { icon: "archive", cls: "dr-btn-primary", label: `${defaultSection(cand.kind)}에 넣기` });
			this.btn(btns, "놓아주기", () => void this.dropCand(cand), { icon: "circle-slash" });
		}
	}

	private renderSources(parent: HTMLElement, from: string[]): void {
		if (!from.length) return;
		const wrap = parent.createSpan({ cls: "dr-from" });
		wrap.createSpan({ cls: "dr-from-k", text: "from" });
		for (const s of from) {
			const l = linkOf(s);
			if (l) {
				const a = wrap.createEl("a", { cls: "dr-link", text: l.label, href: "#", attr: { title: l.target } });
				a.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					void this.app.workspace.openLinkText(l.target, drawerPath(this.plugin), Keymap.isModEvent(e));
				});
			} else wrap.createSpan({ cls: "dr-src", text: s });
		}
	}

	// ── 세 열 ──

	private renderBoard(root: HTMLElement, data: DrawerData, today: string): void {
		const board = root.createDiv({ cls: "dr-board" });
		for (const col of columns(data)) this.renderColumn(board, col, data, today);
	}

	private renderColumn(board: HTMLElement, col: ColumnData, data: DrawerData, today: string): void {
		const c = board.createDiv({ cls: `dr-col sec-${DRAWER_SECTIONS.indexOf(col.section)}` });
		const head = c.createDiv({ cls: "dr-col-head" });
		head.createSpan({ cls: "dr-col-name", text: col.section });
		head.createSpan({ cls: "dr-col-count", text: String(col.active.length) });
		c.createDiv({ cls: "dr-col-hint", text: SECTION_HINT[col.section] });
		if (!data.sections[col.section]) c.createDiv({ cls: "dr-col-missing", text: `파일에 「## ${col.section}」 제목이 없어요. 넣을 때 만들어요.` });
		this.addZone(c, {
			accepts: (d) => (d.kind === "item" ? isActive(d.item) && d.item.section !== col.section : true),
			drop: (d) => {
				if (d.kind === "item") void this.run(() => moveToSection(this.plugin, d.item, col.section));
				else void this.acceptCand(d.cand, col.section);
			},
		});
		const list = c.createDiv({ cls: "dr-col-list" });
		for (const it of col.active) this.renderCard(list, it, today);
		if (!col.active.length) list.createDiv({ cls: "dr-col-empty", text: "비어 있음" });
		if (col.departed.length) {
			const dep = c.createDiv({ cls: "dr-departed" });
			dep.createDiv({ cls: "dr-departed-lbl", text: `나간 줄 ${col.departed.length} · 월간 리뷰에서 지워요` });
			for (const it of col.departed) this.renderCard(dep, it, today);
		}
	}

	private keyOf(it: DrawerItem): string {
		return `${it.section}:${it.key}`;
	}

	private renderCard(parent: HTMLElement, it: DrawerItem, today: string): void {
		const active = isActive(it);
		const stale = isStale(it, today);
		const fresh = isNew(it, today);
		const goal = goalIdOf(it.when);
		const card = parent.createDiv({ cls: `dr-card st-${it.status}${active ? "" : " is-departed"}${stale ? " is-stale" : ""}${it.problems.length ? " has-problems" : ""}` });
		const key = this.keyOf(it);
		const open = this.expanded.has(key);
		card.toggleClass("is-open", open);

		const head = card.createDiv({ cls: "dr-card-head" });
		if (fresh) head.createSpan({ cls: "dr-dot", attr: { title: `이번 달 들어옴 (added ${dotDate(it.added)})` } });
		const text = head.createDiv({ cls: "dr-text", text: it.text });
		text.addEventListener("click", () => {
			if (open) this.expanded.delete(key);
			else this.expanded.add(key);
			this.render();
		});
		const more = head.createEl("button", { cls: "dr-more", text: "⋯", attr: { type: "button", "aria-label": "항목 메뉴" } });
		more.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openMenu(e, it);
		});

		const meta = card.createDiv({ cls: "dr-meta" });
		if (it.when) {
			const chip = meta.createSpan({ cls: `dr-when${goal ? " is-goal" : ""}${it.when === WHEN_UNDECIDED ? " is-undecided" : ""}`, text: goal ? `목표 ${goal}` : it.when, attr: { title: goal ? `Pinboard 목표 ${goal} 열기 · 달성되면 꺼낼 때예요` : "다시 꺼낼 조건 (when::)" } });
			if (goal) {
				chip.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.openGoal(goal, e);
				});
			}
			// TODO(0.5.x, 계획 §7): read the goal's Pinboard `status`; when 달성, mark the chip ✔ and float the card to the column top (조건 충족).
		} else if (active) meta.createSpan({ cls: "dr-when is-missing", text: "when:: 없음" });
		if (it.status === "moved") meta.createSpan({ cls: "dr-gone", text: `꺼냄 → ${it.movedTo || "?"}` });
		if (it.status === "cancelled") meta.createSpan({ cls: "dr-gone", text: `놓아줌${it.why ? ` · ${it.why}` : ""}` });
		if (it.status === "done") meta.createSpan({ cls: "dr-gone", text: "완료 표시 ([x])" });
		for (const t of it.tags) meta.createSpan({ cls: "dr-tag", text: `#${t}` });
		if (it.test && this.plugin.settings.showTestMarkers) meta.createSpan({ cls: "dr-tdot", attr: { title: "#test 테스트 데이터" } });
		if (it.problems.length) meta.createSpan({ cls: "dr-warnmark", text: "?", attr: { title: it.problems.join(" · ") } });

		if (stale) {
			const ask = card.createDiv({ cls: "dr-stale" });
			ask.createSpan({ cls: "dr-stale-q", text: "아직도 원하나요?" });
			ask.createSpan({ cls: "dr-stale-d", text: `마지막으로 본 지 ${daysSinceReview(it, today)}일` });
		}

		if (open) {
			const body = card.createDiv({ cls: "dr-card-body" });
			if (it.context) {
				const ctx = body.createDiv({ cls: "dr-ctx" });
				ctx.createSpan({ cls: "dr-ctx-k", text: "맥락" });
				ctx.createSpan({ text: it.context.text });
			}
			if (it.from.length) this.renderSources(body.createDiv({ cls: "dr-from-row" }), it.from);
			const dates = body.createDiv({ cls: "dr-dates" });
			if (it.added) dates.createSpan({ text: `넣음 ${dotDate(it.added)}` });
			if (it.reviewed) dates.createSpan({ text: `마지막으로 봄 ${dotDate(it.reviewed)}` });
		}

		if (active) {
			card.draggable = true;
			card.addClass("dr-draggable");
			card.addEventListener("dragstart", (e) => this.onDragStart(e, { kind: "item", item: it }, card));
			card.addEventListener("dragend", () => this.onDragEnd());
		}
		card.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.openMenu(e, it);
		});
	}

	// ── 꺼내기 / 놓아주기 dock ──

	private renderDock(root: HTMLElement): void {
		const dock = root.createEl("section", { cls: "dr-dock" });
		const take = dock.createDiv({ cls: "dr-dock-group dr-take" });
		take.createDiv({ cls: "dr-lbl", text: "꺼내기" });
		take.createDiv({ cls: "dr-dock-hint", text: "카드를 끌어다 놓으면 보낸 곳에 (from:: Drawer) 줄을 만들고 Drawer 줄은 [>]로 남겨요" });
		const targets = take.createDiv({ cls: "dr-targets" });
		const target = (id: TakeTarget, icon: string, label: string, sub: string) => {
			const t = targets.createDiv({ cls: `dr-target tg-${id}` });
			setIcon(t.createSpan({ cls: "dr-target-icon" }), icon);
			t.createDiv({ cls: "dr-target-name", text: label });
			t.createDiv({ cls: "dr-target-sub", text: sub });
			this.addZone(t, {
				accepts: (d) => d.kind === "item" && isActive(d.item),
				drop: (d) => {
					if (d.kind === "item") void this.takeOut(d.item, id);
				},
			});
		};
		const ym = todayIsoLocal().slice(0, 7);
		target("today", "sun", "오늘", "Daily Pad 오늘 할 일");
		target("month", "calendar-days", "이달 Desk", `${ym} 이달 중 (Desk 파일이 없으면 Wall)`);
		target("wall", "calendar-range", "Wall · 달 선택", "미래의 달 (그 달 Desk 파일이 있으면 Desk)");
		target("project", "folder-kanban", "프로젝트로", "새 프로젝트 창을 이름·출처로 채워 열기");

		const letgo = dock.createDiv({ cls: "dr-dock-group dr-letgo" });
		letgo.createDiv({ cls: "dr-lbl", text: "놓아주기" });
		letgo.createDiv({ cls: "dr-dock-hint", text: "이유를 한 줄 적으면 [-] … (why::)로 남겨요" });
		const t = letgo.createDiv({ cls: "dr-target tg-letgo" });
		setIcon(t.createSpan({ cls: "dr-target-icon" }), "circle-slash");
		t.createDiv({ cls: "dr-target-name", text: "놓아주기" });
		t.createDiv({ cls: "dr-target-sub", text: "하지 않기로 한다" });
		this.addZone(t, {
			accepts: (d) => d.kind === "item" && isActive(d.item),
			drop: (d) => {
				if (d.kind === "item") void this.chooseLetGo(d.item);
			},
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
			el.addClass("dr-drop-hover");
		});
		el.addEventListener("dragleave", (e) => {
			const to = e.relatedTarget as Node | null;
			if (!to || !el.contains(to)) el.removeClass("dr-drop-hover");
		});
		el.addEventListener("drop", (e) => {
			const d = this.drag;
			el.removeClass("dr-drop-hover");
			if (!d || !zone.accepts(d)) return;
			e.preventDefault();
			e.stopPropagation();
			this.onDragEnd();
			zone.drop(d);
		});
	}

	private onDragStart(e: DragEvent, d: Drag, el: HTMLElement): void {
		if (this.busy) {
			e.preventDefault();
			return;
		}
		this.drag = d;
		e.dataTransfer?.setData("text/plain", d.kind === "item" ? d.item.line.trim() : d.cand.line.trim());
		if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		el.addClass("dr-dragging");
		this.rootEl.addClass("dr-is-dragging");
		for (const z of this.zones) if (z.accepts(d)) z.el.addClass("dr-drop-ok");
	}

	private onDragEnd(): void {
		this.drag = null;
		this.rootEl.removeClass("dr-is-dragging");
		this.rootEl.querySelectorAll(".dr-drop-ok, .dr-drop-hover, .dr-dragging").forEach((el) => el.removeClass("dr-drop-ok", "dr-drop-hover", "dr-dragging"));
		if (this.pendingReload && !this.busy) {
			this.pendingReload = false;
			this.scheduleReload();
		}
	}

	// ── item menu ──

	private openMenu(e: MouseEvent, it: DrawerItem): void {
		const menu = new Menu();
		if (isActive(it)) {
			menu.addItem((i) => i.setTitle("수정…").setIcon("pencil").onClick(() => void this.editItem(it)));
			menu.addSeparator();
			for (const s of DRAWER_SECTIONS) {
				if (s === it.section) continue;
				menu.addItem((i) => i.setTitle(`${s}(으)로 옮기기`).setIcon("arrow-right-left").onClick(() => void this.run(() => moveToSection(this.plugin, it, s))));
			}
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("꺼내기: 오늘").setIcon("sun").onClick(() => void this.takeOut(it, "today")));
			menu.addItem((i) => i.setTitle("꺼내기: 이달 Desk").setIcon("calendar-days").onClick(() => void this.takeOut(it, "month")));
			menu.addItem((i) => i.setTitle("꺼내기: Wall · 달 선택…").setIcon("calendar-range").onClick(() => void this.takeOut(it, "wall")));
			menu.addItem((i) => i.setTitle("꺼내기: 프로젝트로…").setIcon("folder-kanban").onClick(() => void this.takeOut(it, "project")));
			menu.addItem((i) => i.setTitle("놓아주기…").setIcon("circle-slash").onClick(() => void this.chooseLetGo(it)));
			menu.addSeparator();
		}
		menu.addItem((i) =>
			i
				.setTitle("삭제…")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => void this.deleteItem(it)),
		);
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("파일에서 보기").setIcon("file-text").onClick(() => void this.openAt(it.index)));
		menu.showAtMouseEvent(e);
	}

	// ── actions ──

	/** 「+ 넣기」: the user types an item directly (「4-1」). */
	async addManually(): Promise<void> {
		if (!this.exists) {
			new Notice("Drawer 파일을 먼저 만들어 주세요.");
			return;
		}
		const input = await askNewItem(this.app, todayIsoLocal());
		if (!input) return;
		await this.run(() => putIntoDrawer(this.plugin, input));
	}

	/** 후보 넣기 (+ 분류 when dropped on a column). Asks for `when::` when the line has none. */
	private async acceptCand(cand: Candidate, section: DrawerSection | null): Promise<void> {
		const c = this.cands;
		if (!c) return;
		let when = cand.when;
		if (!when) {
			const a = await askWhen(this.app, cand.text);
			if (!a) return;
			if (a.kind === "letgo") return this.dropCand(cand, true);
			when = a.when;
		}
		await this.run(() => acceptCandidate(this.plugin, c.pad, cand, section ?? defaultSection(cand.kind), when));
	}

	/** 후보 놓아주기: the line goes, no record (「7-5」 3). */
	private async dropCand(cand: Candidate, confirmed = false): Promise<void> {
		const c = this.cands;
		if (!c) return;
		if (!confirmed) {
			const ans = await confirmDelete(this.app, {
				title: "후보 놓아주기",
				removes: [`${c.pad.path} · ${this.plugin.settings.sections.pending}`, cand.line.trim()],
				footer: "Drawer에 들어간 적이 없으므로 기록을 남기지 않아요. 원문은 세션에 그대로 있어요.",
				cta: "놓아주기",
			});
			if (ans !== "delete") return;
		}
		await this.run(() => removeCandidateLine(this.plugin, c.pad, cand));
	}

	private async takeOut(it: DrawerItem, target: TakeTarget): Promise<void> {
		if (target === "today") return this.run(() => takeOutToday(this.plugin, it));
		if (target === "month") return this.run(() => takeOutMonth(this.plugin, it, todayIsoLocal().slice(0, 7)));
		if (target === "wall") {
			const ym = await pickMonth(this.app, "Wall Calendar · 달 고르기", shiftMonth(todayIsoLocal().slice(0, 7), 1), `「${it.text}」을(를) 보낼 달을 골라요. 그 달의 Desk Calendar 파일이 있으면 거기 「이달 중」에 적어요.`);
			if (!ym) return;
			return this.run(() => takeOutMonth(this.plugin, it, ym));
		}
		return this.takeOutProject(it);
	}

	/** 프로젝트로: the Project Folders new-project modal, prefilled (name, `from` sessions); then mark the Drawer line. */
	private async takeOutProject(it: DrawerItem): Promise<void> {
		const input = await askNewProject(this.app, {
			areas: this.pinboardAreas(),
			taken: await takenIdsAndNames(this.plugin, []),
			prefill: { name: it.text, from: it.from, action: "" },
			note: `Drawer 「${it.section}」의 「${it.text}」에서 시작해요. 만들면 Drawer 줄은 [>] … → [[허브]]로 남고 변경 기록에 「꺼냄」이 적혀요.`,
		});
		if (!input) return;
		await this.run(async () => {
			const hub = await createProject(this.plugin, input);
			if (!hub) return;
			const ok = await markTakenOutTo(this.plugin, it, `[[${hub.replace(/\.md$/, "")}]]`);
			if (!ok) new Notice("프로젝트는 만들었지만 Drawer 줄을 [>]로 바꾸지 못했어요. Drawer.md를 확인해 주세요.");
			const f = fileAt(this.app, hub);
			if (f) await this.app.workspace.getLeaf("tab").openFile(f);
		});
	}

	private pinboardAreas(): string[] {
		const pin = cleanFolder(this.plugin.settings.pinboardFolder);
		const out: string[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(`${pin}/`)) continue;
			const a = valueToString(this.app.metadataCache.getFileCache(f)?.frontmatter?.area);
			if (a && !out.includes(a)) out.push(a);
		}
		return out;
	}

	private async chooseLetGo(it: DrawerItem): Promise<void> {
		const why = await promptText(this.app, "놓아주기", {
			desc: `「${it.text}」을(를) 하지 않기로 해요. 이유를 한 줄로 남겨요. 줄은 [-] … (why:: 이유)로 남고 지우지 않아요.`,
			placeholder: "예: 지금 목표와 관계없음",
			okText: "놓아주기",
		});
		if (why) await this.run(() => letGoItem(this.plugin, it, why));
	}

	private async editItem(it: DrawerItem): Promise<void> {
		const v = await askForm(this.app, {
			title: `항목 수정 · ${it.section}`,
			desc: "내용 · 조건 · 맥락 · 섹션을 고쳐요. reviewed는 오늘로 바뀌고, from·added·태그는 그대로예요. 섹션이 바뀔 때만 변경 기록에 적어요.",
			fields: [
				{ key: "text", label: "내용", type: "text", value: it.text },
				{ key: "when", label: "다시 꺼낼 조건 (when::)", type: "text", value: it.when, desc: "날짜를 쓰지 않아요. Pinboard 목표 id(G-2026-01.2)면 달성 시 꺼낼 때예요." },
				{ key: "context", label: "맥락", type: "text", value: it.context?.text ?? "", placeholder: "비우면 맥락 줄을 지워요" },
				{ key: "section", label: "섹션", type: "select", value: it.section, options: DRAWER_SECTIONS.map((s) => [s, s] as [string, string]) },
			],
			validate: (x) => {
				const out: string[] = [];
				if (!x.text) out.push("내용을 적어 주세요.");
				if (!x.when) out.push(`다시 꺼낼 조건을 적어 주세요 (없으면 「${WHEN_UNDECIDED}」).`);
				if (/^\d{4}-\d{2}(-\d{2})?$/.test(x.when)) out.push("when::에 날짜를 쓰지 않아요.");
				return out;
			},
		});
		if (!v) return;
		const change = {
			text: v.text !== it.text ? v.text : undefined,
			when: v.when !== it.when ? v.when : undefined,
			context: v.context !== (it.context?.text ?? "") ? v.context : undefined,
			section: v.section !== it.section ? (v.section as DrawerSection) : undefined,
		};
		if (Object.values(change).every((x) => x === undefined)) {
			new Notice("바뀐 것이 없어요.");
			return;
		}
		await this.run(() => editDrawerItem(this.plugin, it, change));
	}

	private async deleteItem(it: DrawerItem): Promise<void> {
		const removes = [`${drawerPath(this.plugin)} · ${it.section}`, it.line.trim()];
		if (it.context) removes.push(it.context.line.trim());
		const ans = await confirmDelete(this.app, {
			title: "Drawer 항목 삭제",
			removes,
			notes: ["변경 기록에는 「삭제」 한 줄이 남아요."],
			footer: "잘못 넣은 줄, 중복, 테스트 데이터를 지울 때 써요.",
			alt: isActive(it) ? { label: "놓아주기 (기록 남김)", desc: "하지 않기로 한 일이면 지우지 말고 놓아주기로 남길 수 있어요: [-] … (why:: 이유)." } : undefined,
		});
		if (ans === "delete") await this.run(() => deleteDrawerItem(this.plugin, it));
		else if (ans === "alt") await this.chooseLetGo(it);
	}

	// ── links ──

	/** Open the Pinboard goal note with this id (any year), else the Pinboard view. */
	private async openGoal(id: string, e?: MouseEvent): Promise<void> {
		const pin = cleanFolder(this.plugin.settings.pinboardFolder);
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(`${pin}/`)) continue;
			if (valueToString(this.app.metadataCache.getFileCache(f)?.frontmatter?.id) === id) {
				await this.app.workspace.getLeaf(e ? Keymap.isModEvent(e) : "tab").openFile(f);
				return;
			}
		}
		const cmds = (this.app as unknown as { commands?: { commands?: Record<string, unknown>; executeCommandById?: (id: string) => boolean } }).commands;
		if (cmds?.commands?.[PINBOARD_COMMAND] && cmds.executeCommandById) {
			cmds.executeCommandById(PINBOARD_COMMAND);
			return;
		}
		const leaf = this.app.workspace.getLeavesOfType(PINBOARD_VIEW)[0];
		if (leaf) void this.app.workspace.revealLeaf(leaf);
		else new Notice(`목표 ${id}를 Pinboard에서 찾지 못했어요.`);
	}

	private async openAt(line: number, e?: MouseEvent): Promise<void> {
		const f = fileAt(this.app, drawerPath(this.plugin));
		if (!f) {
			new Notice("Drawer 파일이 없어요.");
			return;
		}
		await this.app.workspace.getLeaf(e ? Keymap.isModEvent(e) : "tab").openFile(f, { eState: { line } });
	}
}
