/**
 * Flywheel view (`mylogs-flywheel`, v3 — 「Flywheel 화면 설계 v2」).
 *
 *   오늘     요소 카드 여러 열: 어떻게 기록됐나 · 최소 행동 · 최근 기록 · 최근 7일 · 「했음」 · ✎ 한 줄
 *   4주      요소 × 28일, 칸을 눌러 지난날 고치기
 *
 * (0.39: 「바퀴」 · 「재료함」 탭은 뺐다. SNS 글감은 퍼스널 브랜딩의 콘텐츠 스튜디오가 맡는다.)
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
import { addRecordLine, coverSrc, createElement, migrateFolders, nowHm, setDay, wheelRoot } from "./actions.ts";
import { activateStudio } from "../studio/view.ts";
import { loadScreen, markOf, type ElementStats, type ScreenData } from "./screen-data.ts";
import { SOURCE_LABEL } from "./wheel.ts";
import { openElementModal } from "./element-modal.ts";
import type { FlywheelElement } from "./model.ts";

export const VIEW_TYPE_FLYWHEEL = "mylogs-flywheel";

type Tab = "today" | "weeks";
const TABS: [Tab, string][] = [["today", "오늘"], ["weeks", "4주"]];
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
		add.appendText("플라이휠");
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
			root.createDiv({ cls: "fw3-empty", text: "아직 없어요. 「＋ 플라이휠」로 시작해요." });
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
		const card = grid.createDiv({ cls: `fw3-card${s.today === "x" ? " is-done" : ""}${resting ? " is-rest" : ""}${notStarted ? " is-soon" : ""}${this.writing.has(e.id) ? " is-writing" : ""}` });
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
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") {
				this.writing.delete(e.id);
				card.removeClass("is-writing");
			}
			if (ev.key !== "Enter" || ev.isComposing || !input.value.trim()) return;
			const text = input.value.trim();
			input.value = "";
			this.writing.delete(e.id);
			void this.run(() => addRecordLine(this.plugin, e, d.today, text));
		});

		if (e.workspace === "studio") {
			const st = card.createEl("button", { cls: "fw3-studio-btn", attr: { type: "button" } });
			setIcon(st.createSpan({ cls: "fw3-ic" }), "pen-tool");
			st.appendText("콘텐츠 스튜디오");
			st.createSpan({ cls: "fw3-faint", text: " 글감 · 보드 · 예약 →" });
			st.addEventListener("click", () => void activateStudio(this.plugin, this.leaf));
		}
		const foot = card.createDiv({ cls: "fw3-foot" });
		const dots = foot.createDiv({ cls: "fw3-dots" });
		for (const x of s.last7) tip(dots.createSpan({ cls: `fw3-c c-${MARK_CLS[x.mark]}${x.iso === d.today ? " is-today" : ""}` }), `${moment(x.iso, "YYYY-MM-DD").format("M/D (dd)")}`);
		foot.createSpan({ cls: "fw3-meta", text: `기록 ${s.recDays}일` });
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
			title: "플라이휠 추가",
			desc: "요소 교체(추가·폐기)는 분기에 한 번 이하가 좋아요. 폴더와 허브를 함께 만들어요.",
			fields: [
				{ key: "strong", label: "반복할수록 내가 강해지나요?", type: "select", value: "", options: [["", "골라 주세요"], ["yes", "예"], ["no", "아니오"]], desc: "아니면 프로젝트나 할 일이 맞아요." },
				{ key: "name", label: "이름", type: "text", value: "", placeholder: "예: 운동" },
				{ key: "identity", label: "정체성", type: "text", value: "", placeholder: "나는 매일 ~하는 사람이다" },
				{ key: "min", label: "최소", type: "text", value: "", desc: "바쁜 날에도 2분이면 되는 버전", placeholder: "예: 걷기 15분" },
				{ key: "normal", label: "보통", type: "text", value: "", placeholder: "예: 달리기 5km" },
				{ key: "next", label: "다음", type: "text", value: "", placeholder: "이게 돌면 무엇이 좋아지나요?" },
				{ key: "since", label: "시작", type: "date", value: moment().format("YYYY-MM-DD") },
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
