/**
 * Flywheel view (`mylogs-flywheel`, v3 — 「Flywheel 화면 설계 v2」).
 *
 *   오늘     요소 카드 여러 열: 어떻게 기록됐나 · 최소 행동 · 최근 기록 · 최근 7일 · 「했음」 · ✎ 한 줄
 *   바퀴     등록부 순서의 카드, 사이 화살표는 `다음::`
 *   재료함   모든 요소 기록의 `#재료`
 *   4주      요소 × 28일, 칸을 눌러 지난날 고치기
 *
 * A card opens the element popup (`element-modal.ts`, like the project workspace). Ids stay in the
 * files only. Nothing here moves a Pinboard goal.
 */

import { debounce, ItemView, Menu, moment, Notice, setIcon, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { askForm } from "../ui/modals.ts";
import { prependChangeLog } from "../desk/ops.ts";
import { vaultIO } from "../pinboard/create-actions.ts";
import { commitBatch } from "../pinboard/batch.ts";
import { isPlaceholder } from "./ops.ts";
import { addRecordLine, coverSrc, createElement, createOutput, migrateFolders, nowHm, setDay, wheelRoot } from "./actions.ts";
import { loadScreen, markOf, type ElementStats, type ScreenData } from "./screen-data.ts";
import { MATERIAL_TAG, nextText, orderRegistry, SOURCE_LABEL } from "./wheel.ts";
import { openElementModal } from "./element-modal.ts";
import type { FlywheelElement } from "./model.ts";
import { addDays } from "../parser.ts";

export const VIEW_TYPE_FLYWHEEL = "mylogs-flywheel";

type Tab = "today" | "wheel" | "mats" | "weeks";
const TABS: [Tab, string][] = [["today", "오늘"], ["wheel", "바퀴"], ["mats", "재료함"], ["weeks", "4주"]];
const MARK_CLS: Record<string, string> = { x: "x", "-": "m", 쉼: "r", "": "", out: "o" };

const err = (e: unknown) => new Notice(`MyLogs: ${e instanceof Error ? e.message : String(e)}`, 10000);

export class FlywheelView extends ItemView {
	plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private data: ScreenData | null = null;
	private tab: Tab = "today";
	private seq = 0;
	private busy = false;
	private writing = new Set<string>();
	private matFilter = "";
	private showUsed = false;

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

	private root(): string {
		return wheelRoot(this.plugin.settings);
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-flywheel-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-flywheel fw3" });
		mountAppNav(this);
		const later = debounce(() => void this.refresh(), 400, true);
		const watch = (f: TAbstractFile, old?: string) => {
			const r = this.root() + "/";
			if ([f.path, old ?? ""].some((p) => p.startsWith(r) || p.startsWith(this.plugin.settings.pinboardFolder + "/"))) later();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("create", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => watch(f, old)));
		this.registerEvent(this.app.metadataCache.on("changed", (f) => watch(f)));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		if (this.busy) return;
		const seq = ++this.seq;
		try {
			const d = await loadScreen(this.plugin);
			if (seq !== this.seq) return;
			this.data = d;
			this.render();
		} catch (e) {
			console.error("[MyLogs] Flywheel load failed", e);
			this.rootEl.empty();
			this.rootEl.createDiv({ cls: "fw3-empty", text: "Flywheel을 읽지 못했어요. 콘솔을 확인해 주세요." });
		}
	}

	/** Run a write, then redraw; errors become a Notice. */
	private async run(fn: () => Promise<unknown>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await fn();
		} catch (e) {
			err(e);
		} finally {
			this.busy = false;
		}
		await this.refresh();
	}

	openElement(id: string): void {
		const d = this.data;
		const s = d?.stats.get(id);
		if (!d || !s) return;
		openElementModal(this.plugin, id, () => void this.refresh());
	}

	// ── render ──

	private render(): void {
		const d = this.data;
		const root = this.rootEl;
		const scroll = this.contentEl.scrollTop;
		root.empty();
		if (!d) return;
		if (d.wheel.text === null) {
			const empty = root.createDiv({ cls: "fw3-empty" });
			empty.createEl("h2", { text: "아직 바퀴가 없어요" });
			empty.createEl("p", { text: "매일 조금이라도 반복하면 내가 강해지는 일을 골라 둬요." });
			return;
		}
		this.renderHead(root, d);
		if (!d.wheel.registry || d.wheel.elements.some((e) => e.folder && e.folder.slice(e.folder.lastIndexOf("/") + 1) !== e.name)) this.renderMigrate(root, d);
		if (this.tab === "today") this.renderToday(root, d);
		else if (this.tab === "wheel") this.renderWheel(root, d);
		else if (this.tab === "mats") this.renderMaterials(root, d);
		else this.renderWeeks(root, d);
		this.contentEl.scrollTop = scroll;
	}

	private renderHead(root: HTMLElement, d: ScreenData): void {
		const head = root.createDiv({ cls: "fw3-head" });
		const left = head.createDiv();
		left.createDiv({ cls: "fw3-eyebrow", text: "Flywheel" });
		const purpose = d.wheel.purpose;
		const p = left.createEl("button", { cls: `fw3-purpose${isPlaceholder(purpose) ? " is-empty" : ""}`, text: isPlaceholder(purpose) ? "이 바퀴가 돌면 무엇이 되나요? 한 문장으로 적어 주세요" : purpose, attr: { type: "button" } });
		tip(p, "누르면 고쳐요");
		p.addEventListener("click", () => void this.editPurpose(isPlaceholder(purpose) ? "" : purpose));
		const live = d.wheel.elements.filter((e) => e.status === "사용" && (!e.since || e.since <= d.today));
		const done = live.filter((e) => d.stats.get(e.id)?.today === "x").length;
		const resting = d.wheel.elements.filter((e) => e.status === "쉼").length;
		const week = live.reduce(
			(acc, e) => {
				for (const x of d.stats.get(e.id)?.last7 ?? []) if (x.mark !== "out" && x.mark !== "쉼") (acc.n++, x.mark === "x" && acc.x++);
				return acc;
			},
			{ x: 0, n: 0 },
		);
		const lines = [...d.stats.values()].reduce((n, s) => n + s.recLines, 0);
		const left2 = d.materials.filter((m) => !d.used.has(m.anchor)).length;
		const stats = left.createDiv({ cls: "fw3-stats" });
		const stat = (k: string, v: string, hint?: string) => {
			const s = stats.createSpan();
			s.appendText(`${k} `);
			s.createEl("b", { text: v });
			if (hint) s.createSpan({ cls: "fw3-faint", text: ` ${hint}` });
		};
		stat("오늘", `${done}/${live.length}`, resting ? `(쉼 ${resting})` : "");
		stat("최근 7일", `${week.x}/${week.n}`);
		stat("이달 기록", `${lines}줄`);
		stat("남은 재료", String(left2));

		const right = head.createDiv({ cls: "fw3-head-right" });
		const seg = right.createDiv({ cls: "fw3-seg" });
		for (const [k, label] of TABS) {
			const b = seg.createEl("button", { cls: k === this.tab ? "is-on" : "", text: label, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.tab = k;
				this.render();
			});
		}
		const add = right.createEl("button", { cls: "fw3-btn", attr: { type: "button" } });
		setIcon(add.createSpan({ cls: "fw3-ic" }), "plus");
		add.appendText("요소");
		add.addEventListener("click", () => void this.addElementFlow());
		const more = right.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Flywheel 메뉴" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (ev) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("Flywheel.md 열기").setIcon("file-text").onClick(() => void this.app.workspace.openLinkText(d.wheel.path, "", "tab")));
			m.addItem((i) => i.setTitle("새 구조로 정리…").setIcon("folder-sync").onClick(() => void this.migrate()));
			m.showAtMouseEvent(ev);
		});
	}

	private renderMigrate(root: HTMLElement, d: ScreenData): void {
		const bar = root.createDiv({ cls: "fw3-banner" });
		bar.createSpan({ text: d.wheel.registry ? "요소 폴더 이름에 번호가 남아 있어요. 정리하면 폴더·허브·기록 파일 이름에서 번호를 빼고 링크도 함께 고쳐요." : "Flywheel.md가 옛 형식이에요." });
		if (d.wheel.registry) {
			const b = bar.createEl("button", { cls: "mod-cta", text: "정리하기", attr: { type: "button" } });
			b.addEventListener("click", () => void this.migrate());
		}
	}

	private renderCheckin(root: HTMLElement, d: ScreenData): void {
		const live = d.wheel.elements.filter((e) => e.status === "사용" && (!e.since || e.since <= d.today));
		if (!live.length) return;
		const agent = live.filter((e) => d.stats.get(e.id)?.source === "agent");
		const notYet = live.filter((e) => d.stats.get(e.id)?.today !== "x");
		const band = root.createDiv({ cls: "fw3-checkin" });
		setIcon(band.createSpan({ cls: "fw3-bot" }), "sparkles");
		const txt = band.createDiv({ cls: "fw3-grow" });
		txt.createEl("b", { text: "에이전트 체크인" });
		txt.createSpan({ cls: "fw3-muted", text: " · 하루 한 번 물어보고 답을 기록해요" });
		const sub = txt.createDiv({ cls: "fw3-small fw3-muted" });
		sub.setText(
			[agent.length ? `오늘 에이전트가 기록: ${agent.map((e) => e.name).join(" · ")}` : "오늘 에이전트 기록 없음", notYet.length ? `아직: ${notYet.map((e) => e.name).join(" · ")}` : "오늘 모두 기록됨"].join("  ·  "),
		);
	}

	private renderToday(root: HTMLElement, d: ScreenData): void {
		this.renderCheckin(root, d);
		const shown = d.wheel.elements.filter((e) => e.status !== "폐기");
		if (!shown.length) {
			root.createDiv({ cls: "fw3-empty", text: "요소가 없어요. 「＋ 요소」로 시작해요." });
			return;
		}
		const grid = root.createDiv({ cls: "fw3-grid" });
		for (const e of shown) {
			const s = d.stats.get(e.id);
			if (s) this.renderCard(grid, d, s);
		}
	}

	private renderCard(grid: HTMLElement, d: ScreenData, s: ElementStats): void {
		const e = s.e;
		const notStarted = !!e.since && e.since > d.today;
		const resting = e.status === "쉼";
		const card = grid.createDiv({ cls: `fw3-card${s.today === "x" ? " is-done" : ""}${resting || notStarted ? " is-rest" : ""}${this.writing.has(e.id) ? " is-writing" : ""}` });
		card.addEventListener("click", (ev) => {
			if ((ev.target as HTMLElement).closest("button, input, a")) return;
			this.openElement(e.id);
		});
		const cover = coverSrc(this.app, e);
		if (cover) {
			card.addClass("has-cover");
			card.createDiv({ cls: "fw3-card-cover" }).createEl("img", { attr: { src: cover, alt: "", loading: "lazy", draggable: "false" } });
		}
		const top = card.createDiv({ cls: "fw3-card-top" });
		top.createEl("h3", { text: e.name });
		if (s.missed2) tip(top.createSpan({ cls: "fw3-dot" }), "이틀 연속 못 했어요. 보충할 필요는 없어요. 최소 행동이 충분히 작은지 봐요.");
		const src = notStarted ? "none" : resting ? "rest" : s.source;
		const badge = top.createSpan({ cls: `fw3-src s-${src}`, text: notStarted ? `${moment(e.since, "YYYY-MM-DD").format("M/D")}부터` : SOURCE_LABEL[src] + (s.time ? ` · ${s.time}` : "") });
		if (src === "agent") tip(badge, d.evidence.get(`${d.today}|${e.id}`) ?? "");
		const min = card.createDiv({ cls: "fw3-min" });
		min.createSpan({ cls: "fw3-k", text: "최소" });
		const mv = e.fields["최소"];
		min.createEl("b", { cls: isPlaceholder(mv) ? "is-empty" : "", text: isPlaceholder(mv) ? "정해 주세요" : mv });
		const last = card.createDiv({ cls: `fw3-last${s.quote ? " is-agent" : ""}` });
		if (resting) last.setText("쉬는 중");
		else if (s.quote) last.setText(`“${s.quote}”`);
		else if (s.lastLine) last.setText(`${s.lastLine.date === d.today ? "" : moment(s.lastLine.date, "YYYY-MM-DD").format("M/D") + " · "}${s.lastLine.text}`);
		else last.createSpan({ cls: "fw3-faint", text: "아직 기록이 없어요" });

		const line = card.createDiv({ cls: "fw3-oneline" });
		const input = line.createEl("input", { attr: { type: "text", placeholder: "오늘 한 것 한 줄 (Enter)", enterkeyhint: "done" } });
		const star = line.createEl("button", { cls: "fw3-star", text: "☆", attr: { type: "button", "aria-label": "재료로 표시" } });
		tip(star, "재료로 표시 (#재료)");
		star.addEventListener("click", () => {
			star.toggleClass("is-on", !star.hasClass("is-on"));
			star.setText(star.hasClass("is-on") ? "★" : "☆");
		});
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") {
				this.writing.delete(e.id);
				card.removeClass("is-writing");
			}
			if (ev.key !== "Enter" || ev.isComposing || !input.value.trim()) return;
			const text = input.value.trim() + (star.hasClass("is-on") ? ` ${MATERIAL_TAG}` : "");
			input.value = "";
			this.writing.delete(e.id);
			void this.run(() => addRecordLine(this.plugin, e, d.today, text));
		});

		const foot = card.createDiv({ cls: "fw3-foot" });
		const dots = foot.createDiv({ cls: "fw3-dots" });
		for (const x of s.last7) tip(dots.createSpan({ cls: `fw3-c c-${MARK_CLS[x.mark]}${x.iso === d.today ? " is-today" : ""}` }), `${moment(x.iso, "YYYY-MM-DD").format("M/D (dd)")}`);
		foot.createSpan({ cls: "fw3-meta", text: `기록 ${s.recDays}일 · 산출물 ${s.outputs.length + s.drafts.length}` });
		if (resting || notStarted || e.status === "폐기") return;
		const pen = foot.createEl("button", { cls: "clickable-icon fw3-pen", attr: { type: "button", "aria-label": "한 줄 남기기" } });
		setIcon(pen, "pencil");
		pen.addEventListener("click", () => {
			if (this.writing.has(e.id)) this.writing.delete(e.id);
			else this.writing.add(e.id);
			card.toggleClass("is-writing", this.writing.has(e.id));
			if (this.writing.has(e.id)) input.focus();
		});
		const did = foot.createEl("button", { cls: "fw3-did", text: s.today === "x" ? "✓ 했음" : "했음", attr: { type: "button", "aria-pressed": String(s.today === "x") } });
		tip(did, s.today === "x" ? "누르면 오늘 체크를 풀어요" : "오늘 최소 행동을 했으면 눌러요");
		did.addEventListener("click", () => {
			const undo = s.today === "x";
			if (!undo) this.writing.add(e.id);
			void this.run(() => setDay(this.plugin, e, d.today, undo ? "" : "x", undo ? null : undefined));
		});
	}

	private renderWheel(root: HTMLElement, d: ScreenData): void {
		root.createDiv({ cls: "fw3-hint", text: "등록부 순서대로. 화살표는 「다음」 — 이게 돌면 무엇이 좋아지나. 카드를 누르면 요소를 열어요." });
		const ring = root.createDiv({ cls: "fw3-ring" });
		const live = d.wheel.elements.filter((e) => e.status !== "폐기");
		live.forEach((e, i) => {
			const c = ring.createDiv({ cls: `fw3-rcard${e.status === "쉼" ? " is-rest" : ""}` });
			c.addEventListener("click", (ev) => {
				if ((ev.target as HTMLElement).closest("button")) return;
				this.openElement(e.id);
			});
			const rc = coverSrc(this.app, e);
			if (rc) {
				c.addClass("has-cover");
				c.createDiv({ cls: "fw3-card-cover" }).createEl("img", { attr: { src: rc, alt: "", loading: "lazy", draggable: "false" } });
			}
			const top = c.createDiv({ cls: "fw3-card-top" });
			top.createEl("h3", { text: e.name });
			if (e.status === "쉼") top.createSpan({ cls: "fw3-src s-rest", text: "쉼" });
			const mv = top.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "순서" } });
			setIcon(mv, "arrow-up-down");
			mv.addEventListener("click", (ev) => {
				const m = new Menu();
				if (i > 0) m.addItem((it) => it.setTitle("앞으로").setIcon("arrow-left").onClick(() => void this.reorder(live, i, i - 1)));
				if (i < live.length - 1) m.addItem((it) => it.setTitle("뒤로").setIcon("arrow-right").onClick(() => void this.reorder(live, i, i + 1)));
				m.showAtMouseEvent(ev);
			});
			const id = e.fields["정체성"];
			c.createDiv({ cls: `fw3-ident${isPlaceholder(id) ? " is-empty" : ""}`, text: isPlaceholder(id) ? "정체성 — 채워 주세요" : id });
			const min = c.createDiv({ cls: "fw3-min" });
			min.createSpan({ cls: "fw3-k", text: "최소" });
			min.createEl("b", { text: isPlaceholder(e.fields["최소"]) ? "정해 주세요" : e.fields["최소"] });
			if (!isPlaceholder(e.fields["보통"])) min.createSpan({ cls: "fw3-faint", text: ` · 보통 ${e.fields["보통"]}` });
			const chips = c.createDiv({ cls: "fw3-chips" });
			for (const g of e.goals) chips.createSpan({ cls: "fw3-pill is-goal", text: `◎ ${d.goals.get(g) ?? g}` });
			for (const ch of e.channels) chips.createSpan({ cls: "fw3-pill is-ch", text: ch });
			const nx = e.fields["다음"];
			c.createDiv({ cls: `fw3-next${isPlaceholder(nx) ? " is-empty" : ""}`, text: isPlaceholder(nx) ? "다음 — 이게 돌면 무엇이 좋아지나요?" : `→ ${nextText(nx, d.wheel.elements)}` });
			if (i < live.length - 1) c.createSpan({ cls: "fw3-arrow", text: "→" });
		});
		const gone = d.wheel.elements.filter((e) => e.status === "폐기");
		if (gone.length) {
			const det = root.createEl("details", { cls: "fw3-gone" });
			det.createEl("summary", { text: `폐기한 요소 ${gone.length}` });
			for (const e of gone) det.createDiv({ cls: "fw3-muted", text: e.name });
		}
	}

	private async reorder(live: FlywheelElement[], from: number, to: number): Promise<void> {
		const ids = live.map((e) => e.id);
		const [x] = ids.splice(from, 1);
		ids.splice(to, 0, x);
		await this.run(async () => {
			const io = vaultIO(this.app);
			const path = this.data!.wheel.path;
			const before = await io.read(path);
			if (before === null) return;
			await commitBatch(io, [{ path, before, after: prependChangeLog(orderRegistry(before, ids), moment().format("YYYY-MM-DD"), "바퀴 순서 바꿈") }]);
		});
	}

	private renderMaterials(root: HTMLElement, d: ScreenData): void {
		const bar = root.createDiv({ cls: "fw3-matbar" });
		const filters = bar.createDiv({ cls: "fw3-filters" });
		const names = [...new Set(d.materials.map((m) => m.elementName))];
		for (const n of ["", ...names]) {
			const b = filters.createEl("button", { cls: n === this.matFilter ? "is-on" : "", text: n || "전체", attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.matFilter = n;
				this.render();
			});
		}
		const lab = bar.createEl("label", { cls: "fw3-small fw3-muted" });
		const cb = lab.createEl("input", { attr: { type: "checkbox" } });
		cb.checked = this.showUsed;
		lab.appendText(" 쓴 재료도 보기");
		cb.addEventListener("change", () => {
			this.showUsed = cb.checked;
			this.render();
		});
		const list = root.createDiv({ cls: "fw3-mats" });
		const shown = d.materials.filter((m) => (!this.matFilter || m.elementName === this.matFilter) && (this.showUsed || !d.used.has(m.anchor)));
		if (!shown.length) {
			list.createDiv({ cls: "fw3-empty", text: d.materials.length ? "남은 재료가 없어요." : "아직 재료가 없어요. 기록에 ☆를 누르면 여기에 모여요." });
			return;
		}
		for (const m of shown) {
			const c = list.createDiv({ cls: `fw3-mat${d.used.has(m.anchor) ? " is-used" : ""}` });
			const meta = c.createDiv({ cls: "fw3-mat-meta" });
			meta.createSpan({ cls: "fw3-pill", text: m.elementName });
			meta.createSpan({ text: moment(m.date, "YYYY-MM-DD").format("M/D") });
			if (m.embed) meta.createSpan({ cls: "fw3-faint", text: "· Daily Pad 메모" });
			const usedIn = d.used.get(m.anchor);
			if (usedIn) meta.createSpan({ cls: "fw3-pill is-pub", text: `「${usedIn.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")}」에 씀` });
			c.createDiv({ cls: "fw3-mat-body", text: m.embed ? `↙ ${m.embed}` : m.text });
			const acts = c.createDiv({ cls: "fw3-mat-acts" });
			const b = acts.createEl("button", { cls: "fw3-btn is-sm", text: "게시물로", attr: { type: "button" } });
			b.addEventListener("click", () => void this.postFromMaterial(d, m.anchor));
			const o = acts.createEl("button", { cls: "fw3-btn is-sm is-ghost", text: "원문", attr: { type: "button" } });
			o.addEventListener("click", () => void this.app.workspace.openLinkText(m.anchor, "", "tab"));
		}
	}

	private async postFromMaterial(d: ScreenData, anchor: string): Promise<void> {
		const els = d.wheel.elements.filter((e) => e.status !== "폐기");
		const opts: [string, string][] = [];
		for (const e of els) {
			for (const ch of e.channels) opts.push([`${e.id}|${ch}`, `${e.name} · ${ch}`]);
			opts.push([`${e.id}|`, `${e.name} · 채널 없음`]);
		}
		const v = await askForm(this.app, {
			title: "재료로 게시물 만들기",
			desc: "재료 글은 복사하지 않고 게시물 frontmatter `from`에 링크만 둬요.",
			fields: [
				{ key: "where", label: "어디에", type: "select", value: opts[0]?.[0] ?? "", options: opts },
				{ key: "title", label: "제목", type: "text", value: "", placeholder: "파일 이름이 돼요" },
			],
			cta: "만들기",
			validate: (x) => (x.title ? [] : ["제목을 적어 주세요."]),
		});
		if (!v) return;
		const [id, ch] = v.where.split("|");
		const e = els.find((x) => x.id === id);
		if (!e) return;
		await this.run(async () => {
			const f = await createOutput(this.plugin, e, ch, v.title, [anchor]);
			await this.app.workspace.getLeaf("tab").openFile(f);
		});
	}

	private renderWeeks(root: HTMLElement, d: ScreenData): void {
		const head = root.createDiv({ cls: "fw3-weeks-head" });
		head.createSpan({ cls: "fw3-small fw3-muted", text: "칸을 누르면 그날을 고칠 수 있어요. 고치면 수행 표에 「사용자 수정」 근거가 남아요." });
		const lg = head.createDiv({ cls: "fw3-legend" });
		for (const [m, label] of [["x", "했음"], ["-", "못 함"], ["쉼", "쉼"], ["", "기록 없음"]] as const) {
			const s = lg.createSpan();
			s.createSpan({ cls: `fw3-c c-${MARK_CLS[m]}` });
			s.appendText(label);
		}
		const grid = root.createDiv({ cls: "fw3-g4" });
		grid.createDiv();
		for (let w = 0; w < 4; w++) grid.createDiv({ cls: "fw3-wk", text: `${moment(d.dates[w * 7], "YYYY-MM-DD").format("M/D")}~` });
		for (const e of d.wheel.elements.filter((x) => x.status !== "폐기")) {
			grid.createDiv({ cls: "fw3-g4-name", text: e.name });
			for (let w = 0; w < 4; w++) {
				const row = grid.createDiv({ cls: "fw3-days" });
				for (let k = 0; k < 7; k++) {
					const iso = d.dates[w * 7 + k];
					const mark = markOf(d, e, iso);
					const c = row.createEl("button", { cls: `fw3-c c-${MARK_CLS[mark]}${iso === d.today ? " is-today" : ""}`, attr: { type: "button", "aria-label": `${e.name} ${iso}` } });
					const ev = d.evidence.get(`${iso}|${e.id}`);
					tip(c, `${moment(iso, "YYYY-MM-DD").format("M/D (dd)")}${ev ? ` · ${ev}` : ""}`);
					if (mark === "out") continue;
					c.addEventListener("click", (event) => this.dayMenu(event, e, iso, mark));
				}
			}
		}
	}

	private dayMenu(ev: MouseEvent, e: FlywheelElement, iso: string, cur: string): void {
		const m = new Menu();
		const label = moment(iso, "YYYY-MM-DD").format("M/D (dd)");
		m.addItem((i) => i.setTitle(`${e.name} · ${label}`).setDisabled(true));
		const set = (value: string, title: string, icon: string) =>
			m.addItem((i) =>
				i
					.setTitle(title)
					.setIcon(icon)
					.setChecked(cur === value)
					.onClick(() => void this.run(() => setDay(this.plugin, e, iso, value, value === "" ? null : `사용자 수정 (${moment().format("YYYY-MM-DD")} ${nowHm()})`))),
			);
		set("x", "했음", "check");
		set("-", "못 함", "x");
		set("쉼", "쉼", "pause");
		set("", "비우기 (기록 없음)", "eraser");
		m.addSeparator();
		m.addItem((i) => i.setTitle("요소 열기").setIcon("panel-top-open").onClick(() => this.openElement(e.id)));
		m.showAtMouseEvent(ev);
	}

	// ── actions ──

	private async editPurpose(cur: string): Promise<void> {
		const v = await askForm(this.app, {
			title: "바퀴 한 문장",
			fields: [{ key: "p", label: "이 바퀴가 돌면 무엇이 되나요?", type: "text", value: cur, placeholder: "예: 매일 몸을 쓰고, 배운 걸 쓰고, 쓴 걸 판다" }],
		});
		if (!v) return;
		await this.run(async () => {
			const io = vaultIO(this.app);
			const path = this.data!.wheel.path;
			const before = await io.read(path);
			if (before === null) return;
			const lines = before.split("\n");
			const h1 = lines.findIndex((l) => /^#\s/.test(l));
			let end = h1 + 1;
			while (end < lines.length && !lines[end].startsWith("## ")) end++;
			lines.splice(h1 + 1, end - h1 - 1, "", v.p.replace(/[\r\n]+/g, " "), "");
			await commitBatch(io, [{ path, before, after: prependChangeLog(lines.join("\n"), moment().format("YYYY-MM-DD"), "바퀴 한 문장 고침") }]);
		});
	}

	private async addElementFlow(): Promise<void> {
		const v = await askForm(this.app, {
			title: "요소 추가",
			desc: "요소 교체(추가·폐기)는 분기에 한 번 이하가 좋아요. 폴더와 허브를 함께 만들어요.",
			fields: [
				{ key: "strong", label: "반복할수록 내가 강해지나요?", type: "select", value: "", options: [["", "골라 주세요"], ["yes", "예"], ["no", "아니오"]], desc: "아니면 프로젝트나 할 일이 맞아요." },
				{ key: "name", label: "이름", type: "text", value: "", placeholder: "예: 운동" },
				{ key: "identity", label: "정체성", type: "text", value: "", placeholder: "나는 매일 ~하는 사람이다" },
				{ key: "min", label: "최소", type: "text", value: "", desc: "바쁜 날에도 2분이면 되는 버전", placeholder: "예: 걷기 15분" },
				{ key: "normal", label: "보통", type: "text", value: "", placeholder: "예: 달리기 5km" },
				{ key: "next", label: "다음", type: "text", value: "", placeholder: "이게 돌면 무엇이 좋아지나요?" },
				{ key: "since", label: "시작", type: "date", value: addDays(moment().format("YYYY-MM-DD"), 1) },
			],
			cta: "추가",
			validate: (x) => {
				const out: string[] = [];
				if (x.strong !== "yes") out.push("반복해도 나에게 쌓이지 않는 일은 프로젝트나 할 일로 보내요.");
				if (!x.name) out.push("이름을 적어 주세요.");
				if (!x.min) out.push("최소 행동을 적어 주세요.");
				return out;
			},
		});
		if (!v) return;
		await this.run(async () => {
			await createElement(this.plugin, { name: v.name, identity: v.identity, min: v.min, normal: v.normal, next: v.next ? `→ ${v.next.replace(/^→\s*/, "")}` : "", since: v.since || moment().format("YYYY-MM-DD") });
			new Notice(`「${v.name}」을(를) 바퀴에 넣었어요.`);
		});
	}

	private async migrate(): Promise<void> {
		const ok = await askForm(this.app, {
			title: "새 구조로 정리",
			desc: "요소 폴더·허브·기록 파일 이름에서 번호(F-N)를 빼고, 옛 요소 폴더에 남은 채널 폴더를 그 채널을 가진 요소의 「02 산출물」로 옮겨요. Obsidian으로 옮기므로 링크가 따라가요. 빈 옛 폴더는 휴지통으로 가요.",
			fields: [],
			cta: "정리하기",
		});
		if (!ok) return;
		await this.run(async () => {
			const log = await migrateFolders(this.plugin);
			new Notice(`Flywheel 정리:\n${log.join("\n")}`, 15000);
		});
	}
}
