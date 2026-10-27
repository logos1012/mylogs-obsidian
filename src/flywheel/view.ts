/**
 * Flywheel view (`mylogs-flywheel`, 계획 「10-1」): the wheel on one page.
 *
 *   오늘     사용 중인 요소의 최소 행동과 체크 (정본: 오늘 Daily Pad의 `(flywheel:: F-N)` 줄)
 *   최근 4주  요소별 했음 · 못 함 · 쉼 · 기록 없음, 주마다 수행률 (「4-4」)
 *   바퀴     요소 카드와 `다음::` 화살표. ⋯: 방법 고치기 · 쉼 ↔ 사용 · 폐기 · 결과물 폴더
 *   추가     본질 질문 두 개를 거쳐 새 요소 (6개, 분기 한 번 교체 「1」)
 *
 * Ids, field names and file paths stay off the screen. Results (체중·구독자) belong to Pinboard:
 * nothing here changes a goal (「1」, 「6」).
 */

import { debounce, ItemView, moment, normalizePath, Notice, setIcon, type TAbstractFile, TFile, TFolder, type WorkspaceLeaf, Menu } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { askForm } from "../ui/modals.ts";
import { addDays } from "../parser.ts";
import { prependChangeLog } from "../desk/ops.ts";
import { setFrontmatterScalar } from "../writer.ts";
import { activeElements, type FlywheelElement, flywheelPath, missedCount, parseFlywheel } from "./model.ts";
import {
	addElement,
	countActive,
	type DayMark,
	dayMark,
	isPlaceholder,
	MAX_ELEMENTS,
	nextId,
	parseLogTable,
	purposeOf,
	renameElement,
	REPLACEMENT_MARK,
	replacementsThisQuarter,
	setElementField,
	setPurpose,
	togglePadLine,
	weekRate,
} from "./ops.ts";

export const VIEW_TYPE_FLYWHEEL = "mylogs-flywheel";

/** `→ F-2 이유` → `글쓰기 · 이유` (ids stay off the screen). */
function nextText(v: string, elements: FlywheelElement[]): string {
	const s = v.replace(/^→\s*/, "").trim();
	const m = /^(F-\d+)\b\s*(.*)$/.exec(s);
	if (!m) return s;
	const to = elements.find((e) => e.id === m[1]);
	return to ? `${to.name} · ${m[2]}`.replace(/ · $/, "") : m[2] || s;
}

const WEEKS = 4;
const MARK_LABEL: Record<DayMark, string> = { x: "했음", "-": "못 함", 쉼: "쉼", "": "기록 없음", out: "시작 전" };

function todayIso(): string {
	return moment().format("YYYY-MM-DD");
}

interface Loaded {
	text: string | null;
	elements: FlywheelElement[];
	/** ISO date → Daily Pad text (null = no file). */
	pads: Map<string, string | null>;
	/** YYYY-MM → 수행 표. */
	tables: Map<string, Map<string, Map<string, string>>>;
	/** id → 결과물 파일 수. */
	outputs: Map<string, number>;
	goals: Map<string, string>;
}

export class FlywheelView extends ItemView {
	plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private data: Loaded | null = null;
	private busy = false;
	private seq = 0;

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_FLYWHEEL;
	}
	getDisplayText(): string {
		return "Flywheel";
	}
	getIcon(): string {
		return "repeat";
	}

	private folder(): string {
		return (this.plugin.settings.flywheelPath || "12 Flywheel").replace(/^\/+|\/+$/g, "");
	}
	private wheelPath(): string {
		return normalizePath(flywheelPath(this.folder()));
	}
	private padPath(iso: string): string {
		return normalizePath(`${this.plugin.settings.dailyPadFolder}/${iso.slice(0, 4)}/${iso}.md`);
	}
	private file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}
	private async read(path: string): Promise<string | null> {
		const f = this.file(path);
		return f ? this.app.vault.cachedRead(f) : null;
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-flywheel-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-flywheel" });
		mountAppNav(this);
		const later = debounce(() => void this.refresh(), 400, true);
		const watch = (f: TAbstractFile, old?: string) => {
			const paths = [f.path, old ?? ""];
			if (paths.some((p) => p.startsWith(this.folder() + "/") || p.startsWith(this.plugin.settings.dailyPadFolder + "/"))) later();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("create", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => watch(f, old)));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		if (this.busy) return;
		const seq = ++this.seq;
		const text = await this.read(this.wheelPath());
		const elements = parseFlywheel(text);
		const today = todayIso();
		const days: string[] = [];
		for (let d = this.weekStart(addDays(today, -(WEEKS - 1) * 7)); d <= today; d = addDays(d, 1)) days.push(d);
		const pads = new Map<string, string | null>();
		await Promise.all(days.map(async (d) => pads.set(d, await this.read(this.padPath(d)))));
		const tables = new Map<string, Map<string, Map<string, string>>>();
		for (const ym of new Set(days.map((d) => d.slice(0, 7)))) tables.set(ym, parseLogTable(await this.read(normalizePath(`${this.folder()}/99 작업실/수행/${ym}.md`))));
		const outputs = new Map<string, number>();
		for (const e of elements) {
			const dir = this.app.vault.getAbstractFileByPath(normalizePath(`${this.folder()}/${e.id} ${e.name}`));
			outputs.set(e.id, dir instanceof TFolder ? this.countFiles(dir) : 0);
		}
		const goals = new Map<string, string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(this.plugin.settings.pinboardFolder + "/")) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (fm && typeof fm.id === "string") goals.set(fm.id, String(fm.title ?? fm.id));
		}
		if (seq !== this.seq) return;
		this.data = { text, elements, pads, tables, outputs, goals };
		this.render();
	}

	private countFiles(dir: TFolder): number {
		let n = 0;
		for (const c of dir.children) n += c instanceof TFolder ? this.countFiles(c) : 1;
		return n;
	}

	private weekStart(iso: string): string {
		return addDays(iso, -((moment(iso, "YYYY-MM-DD").isoWeekday() + 6) % 7));
	}

	// ── render ──

	private render(): void {
		const root = this.rootEl;
		const scroll = this.contentEl.scrollTop;
		root.empty();
		const d = this.data;
		if (!d) return;
		if (d.text === null) {
			const empty = root.createDiv({ cls: "fw-empty" });
			empty.createEl("h2", { text: "아직 바퀴가 없어요" });
			tip(empty.createEl("p", { text: "매일 조금이라도 반복하면 내가 강해지는 일을 몇 개 골라 둬요." }), "요소는 6개 이하. 바쁜 날에도 2분이면 되는 최소 버전이 있어야 해요.");
			const b = empty.createEl("button", { cls: "mod-cta", text: "바퀴 만들기", attr: { type: "button" } });
			b.addEventListener("click", () => void this.createWheel());
			return;
		}
		const live = d.elements.filter((e) => e.status !== "폐기");
		this.renderHead(root, d, live.length);
		this.renderToday(root, d);
		this.renderWeeks(root, d);
		this.renderWheel(root, d);
		this.contentEl.scrollTop = scroll;
	}

	private renderHead(root: HTMLElement, d: Loaded, count: number): void {
		const head = root.createEl("header", { cls: "fw-head" });
		const left = head.createDiv();
		left.createDiv({ cls: "fw-eyebrow", text: "Flywheel · 나를 키우는 바퀴" });
		left.createEl("h1", { text: "Flywheel" });
		const purpose = purposeOf(d.text ?? "");
		const p = left.createEl("button", { cls: `fw-purpose${isPlaceholder(purpose) ? " is-empty" : ""}`, text: isPlaceholder(purpose) ? "이 바퀴가 돌면 무엇이 되나요? 한 문장으로 적어 주세요" : purpose, attr: { type: "button" } });
		tip(p, "누르면 고쳐요");
		p.addEventListener("click", () => void this.editPurpose(isPlaceholder(purpose) ? "" : purpose));
		const right = head.createDiv({ cls: "fw-head-right" });
		tip(right.createSpan({ cls: "fw-count", text: `요소 ${count}/${MAX_ELEMENTS}` }), "톱니는 6개 이하. 넘으면 합쳐요.");
		const add = right.createEl("button", { cls: "fw-btn", attr: { type: "button" } });
		setIcon(add.createSpan({ cls: "fw-btn-icon" }), "plus");
		add.appendText("요소 추가");
		add.disabled = count >= MAX_ELEMENTS;
		tip(add, count >= MAX_ELEMENTS ? "이미 6개예요. 기존 요소와 합칠 수 있는지 먼저 봐요." : "반복할수록 내가 강해지는 일을 하나 더해요");
		add.addEventListener("click", () => void this.addElementFlow());
		const raw = right.createEl("button", { cls: "clickable-icon fw-icon", attr: { type: "button", "aria-label": "Flywheel 메뉴" } });
		setIcon(raw, "more-horizontal");
		raw.addEventListener("click", (e) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("원문 열기").setIcon("file-text").onClick(() => void this.openFile(this.wheelPath())));
			m.showAtMouseEvent(e);
		});
	}

	private renderToday(root: HTMLElement, d: Loaded): void {
		const today = todayIso();
		const sec = root.createEl("section", { cls: "fw-today" });
		const h = sec.createDiv({ cls: "fw-sec-head" });
		tip(h.createEl("h2", { text: "오늘" }), "최소 행동을 했으면 체크해요. 못 했으면 그대로 두세요. 못 한 분량을 내일로 넘기지 않아요.");
		h.createSpan({ cls: "fw-date", text: moment(today, "YYYY-MM-DD").format("M월 D일 (dd)") });
		const active = activeElements(d.elements);
		const pad = d.pads.get(today) ?? null;
		if (!active.length) {
			sec.createDiv({ cls: "fw-muted", text: "지금 돌고 있는 요소가 없어요." });
			return;
		}
		const grid = sec.createDiv({ cls: "fw-today-grid" });
		let missingLine = false;
		for (const e of active) {
			const mark = dayMark(e, today, pad, undefined);
			const card = grid.createDiv({ cls: `fw-today-card${mark === "x" ? " is-done" : ""}` });
			const box = card.createEl("button", { cls: "fw-check", attr: { type: "button", role: "checkbox", "aria-checked": String(mark === "x"), "aria-label": `${e.name} 오늘 했음` } });
			if (mark === "x") setIcon(box, "check");
			const body = card.createDiv({ cls: "fw-today-body" });
			body.createDiv({ cls: "fw-today-name", text: e.name });
			const min = e.fields["최소"];
			body.createDiv({ cls: `fw-today-min${isPlaceholder(min) ? " is-empty" : ""}`, text: isPlaceholder(min) ? "최소 행동을 정해 주세요" : min });
			const missed = pad ? this.missedOf(pad, e.id) : null;
			if (missed) tip(card.createSpan({ cls: "fw-missed" }), `${missed}일 연속 못 했어요. 보충할 필요는 없어요. 최소 행동이 충분히 작은지 봐요.`);
			const line = mark === "x" || mark === "-";
			if (!line) {
				missingLine = true;
				box.disabled = true;
				tip(box, "오늘 Daily Pad에 이 줄이 없어요");
			} else box.addEventListener("click", () => void this.toggleToday(e));
			if (isPlaceholder(min)) body.addEventListener("click", () => void this.editMethod(e));
		}
		if (missingLine) {
			const row = sec.createDiv({ cls: "fw-today-missing" });
			row.createSpan({ text: pad === null ? "오늘 Daily Pad가 아직 없어요." : "오늘 Daily Pad에 없는 요소가 있어요." });
			const b = row.createEl("button", { cls: "fw-btn", text: "Daily Pad 열기", attr: { type: "button" } });
			b.addEventListener("click", () => void this.plugin.openDailyPadAt(today));
		}
	}

	private missedOf(pad: string, id: string): number | null {
		for (const line of pad.split(/\r?\n/)) if (line.includes(`flywheel:: ${id}`)) return missedCount(line);
		return null;
	}

	private renderWeeks(root: HTMLElement, d: Loaded): void {
		const today = todayIso();
		const shown = d.elements.filter((e) => e.status !== "폐기");
		if (!shown.length) return;
		const sec = root.createEl("section", { cls: "fw-weeks" });
		const h = sec.createDiv({ cls: "fw-sec-head" });
		tip(h.createEl("h2", { text: "최근 4주" }), "주마다 했음 / 운영한 날. 쉰 날은 빼고, Daily Pad가 없는 날은 ‘기록 없음’으로 따로 봐요. 연속 일수는 세지 않아요.");
		const lg = h.createDiv({ cls: "fw-legend" });
		for (const m of ["x", "-", "쉼", ""] as DayMark[]) {
			const s = lg.createSpan({ cls: "fw-lg" });
			s.createSpan({ cls: `fw-cell m-${m === "" ? "blank" : m === "-" ? "miss" : m === "쉼" ? "rest" : m}` });
			s.createSpan({ text: MARK_LABEL[m] });
		}
		const weeks: string[][] = [];
		for (let w = WEEKS - 1; w >= 0; w--) {
			const mon = this.weekStart(addDays(today, -w * 7));
			weeks.push(Array.from({ length: 7 }, (_, i) => addDays(mon, i)));
		}
		const table = sec.createDiv({ cls: "fw-grid", attr: { style: `--weeks:${WEEKS}` } });
		table.createDiv({ cls: "fw-grid-corner" });
		for (const wk of weeks) {
			const hd = table.createDiv({ cls: "fw-grid-week" });
			hd.setText(`${+wk[0].slice(5, 7)}/${+wk[0].slice(8, 10)}~`);
		}
		for (const e of shown) {
			const name = table.createDiv({ cls: "fw-grid-name", text: e.name });
			if (e.status !== "사용") name.createSpan({ cls: "fw-pill is-rest", text: e.status || "쉼" });
			for (const wk of weeks) {
				const cell = table.createDiv({ cls: "fw-grid-cell" });
				const marks: DayMark[] = [];
				const row = cell.createDiv({ cls: "fw-days" });
				for (const iso of wk) {
					if (iso > today) {
						row.createSpan({ cls: "fw-cell m-future" });
						continue;
					}
					const tableCell = d.tables.get(iso.slice(0, 7))?.get(iso.slice(8, 10))?.get(e.id);
					const m = dayMark(e, iso, d.pads.get(iso) ?? null, tableCell, e.status !== "사용");
					// Today is not judged until the day is over (Tear-off counts it at midnight).
					const pending = iso === today && m === "-";
					if (!pending) marks.push(m);
					const c = row.createEl("button", { cls: `fw-cell m-${pending ? "today" : m === "" ? "blank" : m === "-" ? "miss" : m === "쉼" ? "rest" : m}`, attr: { type: "button", "aria-label": `${iso} ${pending ? "오늘" : MARK_LABEL[m]}` } });
					tip(c, `${moment(iso, "YYYY-MM-DD").format("M/D (dd)")} · ${pending ? "오늘 (아직)" : MARK_LABEL[m]}`);
					c.addEventListener("click", () => void this.plugin.openDailyPadAt(iso));
				}
				const r = weekRate(marks);
				const rate = cell.createDiv({ cls: "fw-rate" });
				if (!r.denom) rate.setText("—");
				else {
					rate.setText(`${r.done}/${r.denom}`);
					if (r.blank) tip(rate, `기록 없음 ${r.blank}일`);
				}
			}
		}
	}

	private renderWheel(root: HTMLElement, d: Loaded): void {
		const sec = root.createEl("section", { cls: "fw-wheel" });
		const h = sec.createDiv({ cls: "fw-sec-head" });
		tip(h.createEl("h2", { text: "바퀴" }), "요소마다 ‘이게 돌면 무엇이 좋아지나’를 화살표로 이어요. 방법(최소·보통·다음)은 언제든 고칠 수 있어요.");
		const list = sec.createDiv({ cls: "fw-cards" });
		const live = d.elements.filter((e) => e.status !== "폐기");
		if (!live.length) list.createDiv({ cls: "fw-muted", text: "요소가 없어요. 「요소 추가」로 시작해요." });
		for (const e of live) this.renderCard(list, e, d);
		const gone = d.elements.filter((e) => e.status === "폐기");
		if (gone.length) {
			const det = sec.createEl("details", { cls: "fw-gone" });
			det.createEl("summary", { text: `폐기한 요소 ${gone.length}` });
			for (const e of gone) det.createDiv({ cls: "fw-muted", text: e.name });
		}
	}

	private renderCard(list: HTMLElement, e: FlywheelElement, d: Loaded): void {
		const f = e.fields;
		const card = list.createDiv({ cls: `fw-card st-${e.status || "none"}` });
		const top = card.createDiv({ cls: "fw-card-top" });
		top.createEl("h3", { text: e.name });
		if (e.status !== "사용") tip(top.createSpan({ cls: "fw-pill is-rest", text: e.status || "상태 없음" }), e.status ? "쉬는 중이에요. Daily Pad에 넣지 않아요." : "상태가 없어 쉼으로 봐요");
		const more = top.createEl("button", { cls: "clickable-icon fw-icon", attr: { type: "button", "aria-label": `${e.name} 메뉴` } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (ev) => this.cardMenu(ev, e));
		const field = (label: string, key: string, cls = "") => {
			const v = f[key];
			const row = card.createDiv({ cls: `fw-field ${cls}` });
			row.createDiv({ cls: "fw-field-k", text: label });
			const shown = key === "다음" ? nextText(v ?? "", d.elements) : (v ?? "");
			const val = row.createEl("button", { cls: `fw-field-v${isPlaceholder(v) ? " is-empty" : ""}`, text: isPlaceholder(v) ? "채워 주세요" : shown, attr: { type: "button" } });
			val.addEventListener("click", () => void this.editMethod(e));
		};
		if (!isPlaceholder(f["정체성"])) card.createDiv({ cls: "fw-identity", text: `“${f["정체성"]}”` });
		field("최소", "최소", "is-min");
		field("보통", "보통");
		field("다음", "다음");
		const foot = card.createDiv({ cls: "fw-card-foot" });
		const goal = (f["goal"] ?? "").trim();
		if (goal) {
			const g = foot.createEl("button", { cls: "fw-goal", attr: { type: "button" } });
			setIcon(g.createSpan({ cls: "fw-btn-icon" }), "target");
			g.appendText(d.goals.get(goal) ?? "연결된 목표");
			tip(g, "목표 열기 · 목표 연결은 Pinboard에서 바꿔요");
			g.addEventListener("click", () => void this.plugin.openPinboardGoal(goal));
		}
		const n = d.outputs.get(e.id) ?? 0;
		if (n) {
			const o = foot.createEl("button", { cls: "fw-outputs", text: `결과물 ${n}`, attr: { type: "button" } });
			o.addEventListener("click", () => this.revealFolder(e));
		}
	}

	private cardMenu(ev: MouseEvent, e: FlywheelElement): void {
		const m = new Menu();
		m.addItem((i) => i.setTitle("방법 고치기…").setIcon("pencil").onClick(() => void this.editMethod(e)));
		if (e.status === "사용") m.addItem((i) => i.setTitle("잠시 쉬기").setIcon("pause").onClick(() => void this.setStatus(e, "쉼")));
		else m.addItem((i) => i.setTitle("다시 돌리기").setIcon("play").onClick(() => void this.setStatus(e, "사용")));
		if ((this.data?.outputs.get(e.id) ?? 0) > 0) m.addItem((i) => i.setTitle("결과물 폴더 보기").setIcon("folder").onClick(() => this.revealFolder(e)));
		m.addSeparator();
		m.addItem((i) => i.setTitle("폐기…").setIcon("trash-2").setWarning(true).onClick(() => void this.retire(e)));
		m.showAtMouseEvent(ev);
	}

	// ── actions ──

	private async openFile(path: string): Promise<void> {
		const f = this.file(path);
		if (f) await this.app.workspace.getLeaf("tab").openFile(f);
	}

	private revealFolder(e: FlywheelElement): void {
		const dir = this.app.vault.getAbstractFileByPath(normalizePath(`${this.folder()}/${e.id} ${e.name}`));
		const first = dir instanceof TFolder ? dir.children.find((c): c is TFile => c instanceof TFile) : null;
		if (first) void this.app.workspace.getLeaf("tab").openFile(first);
	}

	/**
	 * Edit `Flywheel.md`: `fn` returns the new text or null (element gone). Adds the change-log line,
	 * `updated` and `elements`.
	 */
	private async writeWheel(what: string, fn: (t: string) => string | null): Promise<boolean> {
		const f = this.file(this.wheelPath());
		if (!f || this.busy) return false;
		this.busy = true;
		let ok = false;
		try {
			const today = todayIso();
			await this.app.vault.process(f, (t) => {
				const next = fn(t);
				if (next === null) return t;
				ok = true;
				const counted = setFrontmatterScalar(next, "elements", String(countActive(parseFlywheel(next))));
				return prependChangeLog(counted, today, what);
			});
			if (!ok) new Notice("Flywheel이 그새 바뀌었어요. 다시 그렸어요.");
		} catch (err) {
			console.error("[MyLogs] Flywheel write failed", err);
			new Notice("MyLogs: Flywheel에 쓰지 못했어요.");
		} finally {
			this.busy = false;
			await this.refresh();
		}
		return ok;
	}

	private async editPurpose(cur: string): Promise<void> {
		const v = await askForm(this.app, {
			title: "바퀴 한 문장",
			fields: [{ key: "p", label: "이 바퀴가 돌면 무엇이 되나요?", type: "text", value: cur, placeholder: "예: 매일 몸을 쓰고, 배운 걸 쓰고, 쓴 걸 판다" }],
		});
		if (v) await this.writeWheel("바퀴 한 문장 고침", (t) => setPurpose(t, v.p));
	}

	private async editMethod(e: FlywheelElement): Promise<void> {
		const f = e.fields;
		const val = (k: string) => (isPlaceholder(f[k]) ? "" : (f[k] ?? "").replace(/^→\s*/, ""));
		const v = await askForm(this.app, {
			title: `${e.name} 방법 고치기`,
			desc: "방법은 언제든 고칠 수 있어요.",
			fields: [
				{ key: "name", label: "이름", type: "text", value: e.name },
				{ key: "identity", label: "정체성", type: "text", value: val("정체성"), placeholder: "나는 매일 ~하는 사람이다" },
				{ key: "min", label: "최소", type: "text", value: val("최소"), desc: "바쁜 날 버전. 2분이면 되는 것. 이걸 하면 했음으로 세요.", placeholder: "예: 걷기 15분" },
				{ key: "normal", label: "보통", type: "text", value: val("보통"), placeholder: "예: 달리기 5km" },
				{ key: "next", label: "다음", type: "text", value: val("다음"), desc: "이게 돌면 무엇이 좋아지나요? 한 줄.", placeholder: "예: 체력이 있어야 저녁에 공부가 된다" },
			],
			validate: (x) => (x.name ? [] : ["이름을 적어 주세요."]),
		});
		if (!v) return;
		const changed: string[] = [];
		await this.writeWheel(`${e.id} ${v.name} 방법 갱신`, (t) => {
			let out: string | null = t;
			const set = (k: string, value: string) => {
				if (out === null || value === val(k)) return;
				changed.push(k);
				out = setElementField(out, e.id, k, k === "다음" && value && !value.startsWith("→") ? `→ ${value}` : value);
			};
			if (v.name !== e.name) out = renameElement(out, e.id, v.name);
			set("정체성", v.identity);
			set("최소", v.min);
			set("보통", v.normal);
			set("다음", v.next);
			return out;
		});
		if (v.name !== e.name) new Notice("이름을 바꿨어요. 결과물 폴더가 있으면 같은 이름으로 바꿔 주세요.");
	}

	private async setStatus(e: FlywheelElement, status: "사용" | "쉼"): Promise<void> {
		await this.writeWheel(`${e.id} ${e.name} ${status === "쉼" ? "쉼" : "다시 사용"}`, (t) => setElementField(t, e.id, "status", status));
		new Notice(status === "쉼" ? `「${e.name}」을(를) 쉬어요. 내일부터 Daily Pad에 넣지 않아요.` : `「${e.name}」을(를) 다시 돌려요. 내일부터 Daily Pad에 들어가요.`);
	}

	private async retire(e: FlywheelElement): Promise<void> {
		const again = this.data?.text && replacementsThisQuarter(this.data.text, todayIso()) > 0 ? "이번 분기에 이미 요소를 바꿨어요. " : "";
		const ok = await askForm(this.app, {
			title: `「${e.name}」 폐기`,
			desc: `${again}요소 교체(추가·폐기)는 분기에 한 번 이하로 해요. 잠시 멈추는 거라면 「잠시 쉬기」가 맞아요. 결과물과 지난 기록은 그대로 남아요.`,
			fields: [],
			cta: "폐기",
		});
		if (!ok) return;
		await this.writeWheel(`${REPLACEMENT_MARK}: ${e.id} ${e.name} 폐기`, (t) => setElementField(t, e.id, "status", "폐기"));
	}

	private async addElementFlow(): Promise<void> {
		const d = this.data;
		if (!d?.text) return;
		const today = todayIso();
		const used = replacementsThisQuarter(d.text, today);
		const v = await askForm(this.app, {
			title: "요소 추가",
			desc: used ? "이번 분기에 이미 요소를 바꿨어요. 요소 교체는 분기에 한 번 이하가 좋아요." : "내일부터 Daily Pad 맨 위에 들어가요.",
			fields: [
				{ key: "strong", label: "반복할수록 내가 강해지나요?", type: "select", value: "", options: [["", "골라 주세요"], ["yes", "예"], ["no", "아니오"]], desc: "아니면 프로젝트나 할 일이 맞아요." },
				{ key: "tiny", label: "바쁜 날에도 2분이면 되는 버전이 있나요?", type: "select", value: "", options: [["", "골라 주세요"], ["yes", "예"], ["no", "아니오"]], desc: "매일 못 하는 일은 요소가 아니에요." },
				{ key: "name", label: "이름", type: "text", value: "", placeholder: "예: 몸 만들기" },
				{ key: "identity", label: "정체성", type: "text", value: "", placeholder: "나는 매일 ~하는 사람이다" },
				{ key: "min", label: "최소", type: "text", value: "", placeholder: "예: 걷기 15분" },
				{ key: "normal", label: "보통", type: "text", value: "", placeholder: "예: 달리기 5km" },
				{ key: "next", label: "다음", type: "text", value: "", placeholder: "이게 돌면 무엇이 좋아지나요?" },
			],
			cta: "추가",
			validate: (x) => {
				const out: string[] = [];
				if (x.strong !== "yes") out.push("반복해도 나에게 쌓이지 않는 일은 프로젝트나 할 일로 보내요.");
				if (x.tiny !== "yes") out.push("바쁜 날 버전(최소)을 먼저 정해 주세요.");
				if (!x.name) out.push("이름을 적어 주세요.");
				if (!x.min) out.push("최소 행동을 적어 주세요.");
				return out;
			},
		});
		if (!v) return;
		const id = nextId(d.text);
		const ok = await this.writeWheel(`${REPLACEMENT_MARK}: ${id} ${v.name} 추가`, (t) => {
			if (countActive(parseFlywheel(t)) >= MAX_ELEMENTS) return null;
			return addElement(t, nextId(t), { name: v.name, identity: v.identity, min: v.min, normal: v.normal, next: v.next ? `→ ${v.next.replace(/^→\s*/, "")}` : "" }, today);
		});
		if (ok) new Notice(`「${v.name}」을(를) 바퀴에 넣었어요. 내일부터 Daily Pad에 들어가요.`);
	}

	private async toggleToday(e: FlywheelElement): Promise<void> {
		const today = todayIso();
		const f = this.file(this.padPath(today));
		if (!f || this.busy) return;
		this.busy = true;
		let ok = false;
		try {
			await this.app.vault.process(f, (t) => {
				const next = togglePadLine(t, e.id);
				if (next === null) return t;
				ok = true;
				return setFrontmatterScalar(next, "updated", today);
			});
		} finally {
			this.busy = false;
		}
		if (!ok) new Notice("오늘 Daily Pad에서 이 줄을 찾지 못했어요.");
		await this.refresh();
	}

	private async createWheel(): Promise<void> {
		const today = todayIso();
		const path = this.wheelPath();
		const text = `---\ntype: flywheel\nelements: 0\nupdated: ${today}\n---\n# Flywheel\n\n\n## 변경 기록\n- ${today}: 바퀴 만듦 (플러그인)\n`;
		try {
			const folder = path.slice(0, path.lastIndexOf("/"));
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			if (!this.file(path)) await this.app.vault.create(path, text);
		} catch (err) {
			console.error(err);
			new Notice("MyLogs: Flywheel.md를 만들지 못했어요.");
		}
		await this.refresh();
		await this.addElementFlow();
	}
}
