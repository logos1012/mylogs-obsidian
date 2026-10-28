/**
 * Vision Board view (`mylogs-vision-board`, 계획 「Vision Board」): the morning ritual, before Pinboard.
 * Miracle Morning's V (시각화) and A (확언) on one deck.
 *
 *   카드 덱   비전 카드(이미지 + 짧은 문장)가 살짝 겹쳐 쌓여 있다. 앞 카드를 옆으로 밀면 날아가고
 *             뒤 카드가 앞으로 올라온다. 데스크탑은 끌기 · 방향키 · ‹ › 버튼.
 *   확언      덱의 마지막 카드. 전문을 끝까지 읽어야 밀 수 있고, 밀면 오늘 읽음.
 *   읽음      연결된 Flywheel 요소(`flywheel:`)의 그달 수행 표 칸에 `x` (12 Flywheel AGENTS 「4-2」).
 *             다른 곳에 따로 기록하지 않는다. 체크를 푸는 곳은 Flywheel 화면.
 *
 * Editing (카드 추가 · 고치기 · 이미지 · 순서 · 확언) sits behind ⋯ menus; ids and paths stay off the screen.
 */

import { debounce, ItemView, MarkdownRenderer, Menu, moment, normalizePath, Notice, setIcon, type TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { askForm } from "../ui/modals.ts";
import { addDays } from "../parser.ts";
import { setFrontmatterScalar } from "../writer.ts";
import { type FlywheelElement, flywheelPath, parseFlywheel } from "../flywheel/model.ts";
import { parseLogTable, setLogCell } from "../flywheel/ops.ts";
import { editVisionBoard } from "./actions.ts";
import { IMAGES_DIR, imageName, moveCard, parseVisionBoard, setAffirmation, setCards, streak, type VisionBoard, type VisionCard, visionPath, visionSkeleton } from "./model.ts";

export const VIEW_TYPE_VISION = "mylogs-vision-board";

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "avif", "heic"];
/** How far (share of the card width) a drag must go to send the card away. */
const THROW = 0.28;

function todayIso(): string {
	return moment().format("YYYY-MM-DD");
}

export class VisionBoardView extends ItemView {
	plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private text: string | null = null;
	private board: VisionBoard = { flywheel: "", cards: [], affirmation: "" };
	private element: FlywheelElement | null = null;
	private doneToday = false;
	private streakDays = 0;
	/** Front card of the deck; `== cards.length + 1` once the affirmation is thrown. */
	private index = 0;
	private readToEnd = false;
	private busy = false;
	private seq = 0;
	private cardEls: HTMLElement[] = [];
	private deckEl: HTMLElement | null = null;
	private ambientEl: HTMLElement | null = null;
	private progressEl: HTMLElement | null = null;
	private chipEl: HTMLElement | null = null;
	private finishEl: HTMLElement | null = null;
	private nudged = false;

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_VISION;
	}
	getDisplayText(): string {
		return "Vision Board";
	}
	getIcon(): string {
		return "sparkles";
	}

	private folder(): string {
		return (this.plugin.settings.visionBoardPath || "00 Vision Board").replace(/^\/+|\/+$/g, "");
	}
	private boardPath(): string {
		return normalizePath(visionPath(this.folder()));
	}
	private wheelFolder(): string {
		return (this.plugin.settings.flywheelPath || "12 Flywheel").replace(/^\/+|\/+$/g, "");
	}
	private logPath(month: string): string {
		return normalizePath(`${this.wheelFolder()}/99 작업실/수행/${month}.md`);
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
		this.contentEl.addClass("mylogs-vision-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-vision", attr: { tabindex: "0" } });
		mountAppNav(this);
		const later = debounce(() => void this.refresh(), 400, true);
		const watch = (f: TAbstractFile, old?: string) => {
			const paths = [f.path, old ?? ""];
			if (paths.some((p) => p.startsWith(this.folder() + "/") || p.startsWith(this.wheelFolder() + "/"))) later();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("create", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => watch(f, old)));
		this.registerDomEvent(this.rootEl, "keydown", (e) => this.onKey(e));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		if (this.busy) return;
		const seq = ++this.seq;
		const text = await this.read(this.boardPath());
		const board = parseVisionBoard(text);
		const wheel = await this.read(normalizePath(flywheelPath(this.wheelFolder())));
		const element = board.flywheel ? (parseFlywheel(wheel).find((e) => e.id === board.flywheel) ?? null) : null;
		// 오늘 읽음 and the streak from the 수행 표 (this month and the two before).
		const today = todayIso();
		const tables = new Map<string, Map<string, Map<string, string>>>();
		if (element) {
			for (let k = 0; k < 3; k++) {
				const ym = moment(today, "YYYY-MM-DD").subtract(k, "months").format("YYYY-MM");
				tables.set(ym, parseLogTable(await this.read(this.logPath(ym))));
			}
		}
		const done = (iso: string) => !!element && tables.get(iso.slice(0, 7))?.get(iso.slice(8, 10))?.get(element.id)?.trim() === "x";
		if (seq !== this.seq) return;
		const changed = text !== this.text;
		this.text = text;
		this.board = board;
		this.element = element;
		this.doneToday = done(today);
		this.streakDays = element ? streak(done, today, addDays, 90) : 0;
		if (changed || !this.deckEl) this.render();
		else this.renderChip();
	}

	// ── render ──

	private render(): void {
		const root = this.rootEl;
		root.empty();
		this.cardEls = [];
		this.deckEl = this.ambientEl = this.progressEl = this.finishEl = null;
		if (this.text === null) {
			this.renderEmpty(root);
			return;
		}
		const total = this.board.cards.length + 1;
		this.index = Math.min(this.index, total);
		this.renderHead(root);
		const stage = root.createDiv({ cls: "vb-stage" });
		this.ambientEl = stage.createDiv({ cls: "vb-ambient" });
		this.progressEl = stage.createDiv({ cls: "vb-progress" });
		for (let i = 0; i < total; i++) this.progressEl.createSpan({ cls: "vb-seg" });
		const deck = (this.deckEl = stage.createDiv({ cls: "vb-deck" }));
		this.board.cards.forEach((c, i) => this.cardEls.push(this.renderCard(deck, c, i)));
		this.cardEls.push(this.renderAffirmation(deck));
		if (!this.board.cards.length) this.renderFirstCardHint(stage);
		this.finishEl = stage.createDiv({ cls: "vb-finish" });
		this.renderFoot(root);
		this.layout(false);
		this.renderChip();
		window.requestAnimationFrame(() => this.checkRead());
		if (!this.nudged && !this.doneToday && this.index === 0 && total > 1) {
			this.nudged = true;
			window.setTimeout(() => this.cardEls[0]?.addClass("is-nudge"), 700);
		}
	}

	private renderEmpty(root: HTMLElement): void {
		const empty = root.createDiv({ cls: "vb-empty" });
		setIcon(empty.createDiv({ cls: "vb-empty-icon" }), "sparkles");
		empty.createEl("h2", { text: "이루고 싶은 모습을 그려 둘까요?" });
		empty.createEl("p", { text: "비전 카드를 넘기며 그 모습을 보고, 마지막에 확언을 끝까지 읽어요. 매일 아침 한 번." });
		const b = empty.createEl("button", { cls: "mod-cta", text: "비전 보드 만들기", attr: { type: "button" } });
		b.addEventListener("click", () => void this.createBoard());
	}

	private renderHead(root: HTMLElement): void {
		const head = root.createEl("header", { cls: "vb-head" });
		const left = head.createDiv({ cls: "vb-head-left" });
		left.createDiv({ cls: "vb-eyebrow", text: moment().format("M월 D일 dddd") });
		left.createEl("h1", { cls: "vb-title", text: "Vision Board" });
		const right = head.createDiv({ cls: "vb-head-right" });
		this.chipEl = right.createDiv({ cls: "vb-chip" });
		const more = right.createEl("button", { cls: "clickable-icon vb-icon", attr: { type: "button", "aria-label": "Vision Board 메뉴" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (e) => this.headMenu(e));
	}

	private renderChip(): void {
		const chip = this.chipEl;
		if (!chip) return;
		chip.empty();
		chip.toggleClass("is-done", this.doneToday);
		if (!this.element) {
			chip.setText("Flywheel 연결 전");
			tip(chip, "읽음을 Flywheel 요소에 남기려면 ⋯ → Flywheel 잇기");
			return;
		}
		if (this.doneToday) {
			setIcon(chip.createSpan({ cls: "vb-chip-icon" }), "check");
			chip.createSpan({ text: this.streakDays > 1 ? `오늘 읽음 · ${this.streakDays}일째` : "오늘 읽음" });
		} else chip.createSpan({ text: this.streakDays ? `${this.streakDays}일 이어 가는 중` : "오늘 아직" });
		tip(chip, `Flywheel 「${this.element.name}」에 기록돼요`);
	}

	private renderCard(deck: HTMLElement, c: VisionCard, i: number): HTMLElement {
		const card = deck.createDiv({ cls: "vb-card is-vision" });
		const src = this.imageSrc(c.image);
		if (src) {
			card.createEl("img", { cls: "vb-img", attr: { src, alt: c.title, draggable: "false" } });
			card.dataset.img = src;
		} else {
			const ph = card.createDiv({ cls: "vb-noimg" });
			const up = ph.createEl("button", { cls: "vb-noimg-btn", attr: { type: "button" } });
			setIcon(up.createSpan(), "image-plus");
			up.appendText("이미지 올리기");
			this.guard(up);
			up.addEventListener("click", () => this.pickImage(i));
		}
		card.createDiv({ cls: "vb-shade" });
		const body = card.createDiv({ cls: "vb-card-body" });
		body.createDiv({ cls: "vb-card-num", text: `${String(i + 1).padStart(2, "0")} / ${String(this.board.cards.length).padStart(2, "0")}` });
		body.createEl("h2", { cls: "vb-card-title", text: c.title });
		if (c.text) body.createEl("p", { cls: "vb-card-text", text: c.text });
		const more = card.createEl("button", { cls: "vb-card-more", attr: { type: "button", "aria-label": `${c.title} 메뉴` } });
		setIcon(more, "more-horizontal");
		this.guard(more);
		more.addEventListener("click", (e) => this.cardMenu(e, i));
		this.bindDrag(card, i);
		return card;
	}

	private renderAffirmation(deck: HTMLElement): HTMLElement {
		const i = this.board.cards.length;
		const card = deck.createDiv({ cls: "vb-card is-affirm" });
		const head = card.createDiv({ cls: "vb-affirm-head" });
		head.createSpan({ cls: "vb-affirm-eyebrow", text: "오늘의 확언" });
		const edit = head.createEl("button", { cls: "vb-card-more is-inline", attr: { type: "button", "aria-label": "확언 고치기" } });
		setIcon(edit, "pencil");
		this.guard(edit);
		edit.addEventListener("click", () => void this.editAffirmation());
		const body = card.createDiv({ cls: "vb-affirm-body" });
		if (this.board.affirmation) {
			void MarkdownRenderer.render(this.app, this.board.affirmation, body.createDiv({ cls: "vb-affirm-text" }), this.boardPath(), this);
			this.registerDomEvent(body, "scroll", () => this.checkRead());
		} else {
			const e = body.createDiv({ cls: "vb-affirm-empty" });
			e.createEl("p", { text: "매일 읽을 확언을 적어 두세요. 이루고 싶은 내가 지금 이미 그렇다고 말하는 글이에요." });
			const b = e.createEl("button", { cls: "mod-cta", text: "확언 쓰기", attr: { type: "button" } });
			this.guard(b);
			b.addEventListener("click", () => void this.editAffirmation());
		}
		const foot = card.createDiv({ cls: "vb-affirm-foot" });
		foot.createSpan({ cls: "vb-affirm-hint" });
		this.bindDrag(card, i);
		return card;
	}

	private renderFirstCardHint(stage: HTMLElement): void {
		const b = stage.createEl("button", { cls: "vb-add-first", attr: { type: "button" } });
		setIcon(b.createSpan(), "plus");
		b.appendText("첫 비전 카드 만들기");
		b.addEventListener("click", () => void this.addCard());
	}

	private renderFoot(root: HTMLElement): void {
		const foot = root.createDiv({ cls: "vb-foot" });
		const prev = foot.createEl("button", { cls: "vb-nav-btn", attr: { type: "button", "aria-label": "이전 카드" } });
		setIcon(prev, "chevron-left");
		prev.addEventListener("click", () => this.back());
		foot.createDiv({ cls: "vb-foot-hint" });
		const next = foot.createEl("button", { cls: "vb-nav-btn", attr: { type: "button", "aria-label": "다음 카드" } });
		setIcon(next, "chevron-right");
		next.addEventListener("click", () => this.throwFront(1));
	}

	/** Where every card sits for the current `index`; `animate` false = jump without transitions. */
	private layout(animate = true): void {
		const total = this.cardEls.length;
		this.cardEls.forEach((el, i) => {
			const rel = i - this.index;
			el.toggleClass("no-anim", !animate);
			el.style.zIndex = String(total - Math.abs(rel));
			el.toggleClass("is-front", rel === 0);
			el.toggleClass("is-gone", rel < 0);
			if (rel < 0) {
				const side = el.dataset.side === "-1" ? -1 : 1;
				el.style.transform = `translate3d(${side * 130}%, 4%, 0) rotate(${side * 16}deg)`;
				el.style.opacity = "0";
			} else {
				const d = Math.min(rel, 3);
				const tilt = d === 0 ? 0 : d % 2 ? 2.4 : -2;
				el.style.transform = `translate3d(0, ${d * 12}px, 0) scale(${1 - d * 0.045}) rotate(${tilt}deg)`;
				el.style.opacity = rel > 2 ? "0" : "1";
			}
			el.setAttr("aria-hidden", String(rel !== 0));
			if (!animate) void el.offsetWidth;
		});
		this.progressEl?.querySelectorAll(".vb-seg").forEach((s, i) => {
			s.toggleClass("is-past", i < this.index);
			s.toggleClass("is-now", i === this.index);
		});
		const front = this.cardEls[this.index];
		const img = front?.dataset.img;
		if (this.ambientEl) {
			this.ambientEl.style.backgroundImage = img ? `url("${img}")` : "";
			this.ambientEl.toggleClass("is-warm", !img);
		}
		const finished = this.index >= total;
		this.rootEl.toggleClass("is-finished", finished);
		if (finished) this.renderFinish();
		this.renderHint();
	}

	private renderHint(): void {
		const hint = this.rootEl.querySelector<HTMLElement>(".vb-foot-hint");
		const affirmAt = this.board.cards.length;
		const text = this.index >= this.cardEls.length ? "" : this.index < affirmAt ? "옆으로 넘겨요" : !this.board.affirmation ? "확언을 적어 주세요" : this.readToEnd ? "옆으로 밀어 오늘을 마쳐요" : "끝까지 읽어 주세요";
		hint?.setText(text);
		const inCard = this.cardEls[affirmAt]?.querySelector<HTMLElement>(".vb-affirm-hint");
		if (inCard) {
			inCard.setText(!this.board.affirmation ? "" : this.readToEnd ? "← 밀어서 오늘 완료 →" : "↓ 끝까지 읽어 주세요");
			inCard.toggleClass("is-ready", this.readToEnd);
		}
		this.cardEls[affirmAt]?.toggleClass("is-ready", this.readToEnd);
	}

	private renderFinish(): void {
		const f = this.finishEl;
		if (!f) return;
		f.empty();
		const mark = f.createDiv({ cls: "vb-finish-mark" });
		mark.innerHTML = `<svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="24"/><path d="M15 27 l7 7 l15 -16"/></svg>`;
		f.createEl("h2", { text: "오늘의 비전을 마음에 새겼어요" });
		f.createEl("p", { text: this.element ? (this.streakDays > 1 ? `${this.streakDays}일째 이어 가고 있어요` : "오늘도 그 모습에 한 걸음") : "Flywheel에 이으면 매일 기록이 남아요" });
		const again = f.createEl("button", { cls: "vb-again", attr: { type: "button" } });
		setIcon(again.createSpan(), "rotate-ccw");
		again.appendText("처음부터 다시 보기");
		again.addEventListener("click", () => {
			this.index = 0;
			this.cardEls.forEach((el) => delete el.dataset.side);
			this.layout();
		});
	}

	// ── deck motion ──

	/** Buttons inside a card must not start a drag. */
	private guard(el: HTMLElement): void {
		el.addEventListener("pointerdown", (e) => e.stopPropagation());
	}

	private canThrow(i: number): boolean {
		if (i < this.board.cards.length) return true;
		return !!this.board.affirmation && this.readToEnd;
	}

	private bindDrag(card: HTMLElement, i: number): void {
		let x0 = 0;
		let y0 = 0;
		let t0 = 0;
		let dx = 0;
		let axis: "x" | "y" | null = null;
		let id = -1;
		const move = (e: PointerEvent) => {
			if (e.pointerId !== id) return;
			const mx = e.clientX - x0;
			const my = e.clientY - y0;
			if (!axis) {
				if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
				axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
				if (axis === "x") {
					card.setPointerCapture(id);
					card.addClass("is-dragging");
					card.removeClass("is-nudge");
				}
			}
			if (axis !== "x") return;
			e.preventDefault();
			// Not yet read to the end: the card resists.
			dx = this.canThrow(i) ? mx : mx * 0.25;
			card.style.transform = `translate3d(${dx}px, ${Math.abs(dx) * 0.04}px, 0) rotate(${dx / 18}deg)`;
			const p = Math.min(1, Math.abs(dx) / (card.offsetWidth * THROW));
			this.liftNext(p);
		};
		const up = (e: PointerEvent) => {
			if (e.pointerId !== id) return;
			card.removeEventListener("pointermove", move);
			card.removeEventListener("pointerup", up);
			card.removeEventListener("pointercancel", up);
			id = -1;
			if (axis !== "x") return;
			card.removeClass("is-dragging");
			const v = Math.abs(dx) / Math.max(1, performance.now() - t0);
			const far = Math.abs(dx) > card.offsetWidth * THROW || (v > 0.6 && Math.abs(dx) > 40);
			if (far && this.canThrow(i)) this.throwFront(dx < 0 ? -1 : 1);
			else {
				if (far) this.shakeHint();
				this.layout();
			}
		};
		card.addEventListener("pointerdown", (e) => {
			if (i !== this.index || this.busy || (e.pointerType === "mouse" && e.button !== 0)) return;
			x0 = e.clientX;
			y0 = e.clientY;
			t0 = performance.now();
			dx = 0;
			axis = null;
			id = e.pointerId;
			card.addEventListener("pointermove", move);
			card.addEventListener("pointerup", up);
			card.addEventListener("pointercancel", up);
		});
	}

	/** While dragging, the card behind rises toward the front (`p` 0 → 1). */
	private liftNext(p: number): void {
		const next = this.cardEls[this.index + 1];
		if (!next) return;
		next.addClass("no-anim");
		next.style.transform = `translate3d(0, ${12 * (1 - p)}px, 0) scale(${1 - 0.045 * (1 - p)}) rotate(${2.4 * (1 - p)}deg)`;
	}

	private shakeHint(): void {
		const card = this.cardEls[this.index];
		card?.removeClass("is-shake");
		void card?.offsetWidth;
		card?.addClass("is-shake");
		if (this.board.affirmation && !this.readToEnd) new Notice("확언을 끝까지 읽으면 넘길 수 있어요.");
	}

	/** Send the front card away to `dir` (−1 left, 1 right). The affirmation card completes today. */
	private throwFront(dir: number): void {
		const i = this.index;
		const card = this.cardEls[i];
		if (!card) return;
		if (!this.canThrow(i)) {
			this.shakeHint();
			return;
		}
		card.dataset.side = String(dir);
		this.index = i + 1;
		this.layout();
		if (i === this.board.cards.length) void this.complete();
	}

	private back(): void {
		if (this.index === 0) return;
		this.index--;
		this.layout();
		window.requestAnimationFrame(() => this.checkRead());
	}

	private onKey(e: KeyboardEvent): void {
		if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
		if (e.key === "ArrowRight") this.throwFront(1);
		else if (e.key === "ArrowLeft") this.back();
		else return;
		e.preventDefault();
	}

	/** The affirmation counts as read once its text has been scrolled to the end (or fits). */
	private checkRead(): void {
		const body = this.cardEls[this.board.cards.length]?.querySelector<HTMLElement>(".vb-affirm-body");
		if (!body || !this.board.affirmation || this.readToEnd) return;
		if (body.scrollTop + body.clientHeight >= body.scrollHeight - 12) {
			this.readToEnd = true;
			this.renderHint();
		}
	}

	// ── 오늘 읽음 → Flywheel 수행 표 ──

	private async complete(): Promise<void> {
		navigator.vibrate?.(12);
		const e = this.element;
		if (!e || this.doneToday) return;
		if (e.status !== "사용") {
			new Notice(`Flywheel 「${e.name}」이(가) 쉬는 중이라 기록하지 않았어요.`);
			return;
		}
		const today = todayIso();
		const month = today.slice(0, 7);
		const path = this.logPath(month);
		const wheel = await this.read(normalizePath(flywheelPath(this.wheelFolder())));
		const ids = parseFlywheel(wheel).filter((x) => x.status !== "폐기").map((x) => x.id);
		this.busy = true;
		try {
			const f = this.file(path);
			if (f) await this.app.vault.process(f, (t) => setLogCell(t, month, today.slice(8, 10), e.id, "x", ids));
			else {
				await this.ensureFolder(path.slice(0, path.lastIndexOf("/")));
				await this.app.vault.create(path, setLogCell(null, month, today.slice(8, 10), e.id, "x", ids));
			}
			this.doneToday = true;
			this.streakDays += 1;
		} catch (err) {
			console.error("[MyLogs] Vision Board log write failed", err);
			new Notice("MyLogs: 수행 표에 쓰지 못했어요.");
		} finally {
			this.busy = false;
		}
		this.renderChip();
		this.renderFinish();
	}

	// ── edits ──

	private imageSrc(link: string): string | null {
		if (!link) return null;
		const f = this.app.metadataCache.getFirstLinkpathDest(link, this.boardPath()) ?? this.file(normalizePath(link));
		return f ? this.app.vault.getResourcePath(f) : null;
	}

	private images(): string[] {
		const dir = this.app.vault.getAbstractFileByPath(normalizePath(`${this.folder()}/${IMAGES_DIR}`));
		if (!(dir instanceof TFolder)) return [];
		return dir.children.filter((c): c is TFile => c instanceof TFile && IMAGE_EXT.includes(c.extension.toLowerCase())).map((f) => f.path).sort();
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/");
		for (let k = 1; k <= parts.length; k++) {
			const p = parts.slice(0, k).join("/");
			if (p && !this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
		}
	}

	/** Edit `Vision Board.md` (`./actions.ts`), then redraw. */
	private async writeBoard(what: string, fn: (t: string, b: VisionBoard) => string): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		try {
			await editVisionBoard(this.app, this.folder(), todayIso(), what, fn);
			return true;
		} catch (err) {
			console.error("[MyLogs] Vision Board write failed", err);
			new Notice("MyLogs: Vision Board에 쓰지 못했어요.");
			return false;
		} finally {
			this.busy = false;
			await this.refresh();
		}
	}

	private headMenu(ev: MouseEvent): void {
		const m = new Menu();
		m.addItem((i) => i.setTitle("비전 카드 추가…").setIcon("plus").onClick(() => void this.addCard()));
		m.addItem((i) => i.setTitle("확언 고치기…").setIcon("pencil").onClick(() => void this.editAffirmation()));
		m.addItem((i) => i.setTitle(this.element ? `Flywheel 바꾸기 (지금: ${this.element.name})…` : "Flywheel 잇기…").setIcon("repeat").onClick(() => void this.linkFlywheel()));
		m.addSeparator();
		m.addItem((i) => i.setTitle("원문 열기").setIcon("file-text").onClick(() => void this.openRaw()));
		m.showAtMouseEvent(ev);
	}

	private cardMenu(ev: MouseEvent, i: number): void {
		const n = this.board.cards.length;
		const m = new Menu();
		m.addItem((x) => x.setTitle("고치기…").setIcon("pencil").onClick(() => void this.editCard(i)));
		m.addItem((x) => x.setTitle("이미지 올리기…").setIcon("image-plus").onClick(() => this.pickImage(i)));
		if (i > 0) m.addItem((x) => x.setTitle("앞으로").setIcon("arrow-left").onClick(() => void this.reorder(i, i - 1)));
		if (i < n - 1) m.addItem((x) => x.setTitle("뒤로").setIcon("arrow-right").onClick(() => void this.reorder(i, i + 1)));
		m.addSeparator();
		m.addItem((x) => x.setTitle("지우기…").setIcon("trash-2").setWarning(true).onClick(() => void this.removeCard(i)));
		m.showAtMouseEvent(ev);
	}

	private cardForm(title: string, c: VisionCard, cta: string): Promise<Record<string, string> | null> {
		const imgs = this.images();
		const options: [string, string][] = [["", imgs.length ? "(이미지 없음 · 나중에 올리기)" : "(나중에 카드 ⋯에서 올리기)"], ...imgs.map((p): [string, string] => [p, p.slice(p.lastIndexOf("/") + 1)])];
		if (c.image && !imgs.includes(c.image)) options.push([c.image, c.image.slice(c.image.lastIndexOf("/") + 1)]);
		return askForm(this.app, {
			title,
			fields: [
				{ key: "title", label: "장면", type: "text", value: c.title, placeholder: "예: 어머니와 알프스" },
				{ key: "text", label: "문장", type: "textarea", value: c.text, desc: "이미 이룬 것처럼, 짧게.", placeholder: "예: 어머니 손을 잡고 알프스를 걷는다." },
				{ key: "image", label: "이미지", type: "select", value: c.image, options },
			],
			cta,
			validate: (v) => (v.title ? [] : ["장면 이름을 적어 주세요."]),
		});
	}

	private async addCard(): Promise<void> {
		const v = await this.cardForm("비전 카드 추가", { title: "", text: "", image: "" }, "추가");
		if (!v) return;
		const card = { title: v.title, text: v.text, image: v.image };
		const ok = await this.writeBoard(`비전 카드 추가: ${card.title}`, (t, b) => setCards(t, [...b.cards, card]));
		if (ok && !card.image) new Notice("카드 ⋯ → 이미지 올리기로 사진을 넣어요.");
	}

	private async editCard(i: number): Promise<void> {
		const c = this.board.cards[i];
		if (!c) return;
		const v = await this.cardForm("비전 카드 고치기", c, "저장");
		if (!v) return;
		await this.writeBoard(`비전 카드 고침: ${v.title}`, (t, b) => setCards(t, b.cards.map((x, k) => (k === i ? { title: v.title, text: v.text, image: v.image } : x))));
	}

	private async reorder(from: number, to: number): Promise<void> {
		const c = this.board.cards[from];
		if (c && (await this.writeBoard(`비전 카드 순서: ${c.title}`, (t, b) => setCards(t, moveCard(b.cards, from, to))))) {
			this.index = to;
			this.layout(false);
		}
	}

	private async removeCard(i: number): Promise<void> {
		const c = this.board.cards[i];
		if (!c) return;
		const ok = await askForm(this.app, { title: `「${c.title}」 지우기`, desc: "카드만 지워요. 이미지 파일은 images 폴더에 남아요.", fields: [], cta: "지우기" });
		if (ok) await this.writeBoard(`비전 카드 지움: ${c.title}`, (t, b) => setCards(t, b.cards.filter((_, k) => k !== i)));
	}

	private async editAffirmation(): Promise<void> {
		const v = await askForm(this.app, {
			title: "확언",
			desc: "매일 끝까지 읽는 글이에요. 이루고 싶은 내가 지금 이미 그렇다고, 내 말로.",
			fields: [{ key: "text", label: "전문", type: "textarea", value: this.board.affirmation, placeholder: "나는 …" }],
			cta: "저장",
		});
		if (!v) return;
		this.readToEnd = false;
		await this.writeBoard("확언 고침", (t) => setAffirmation(t, v.text));
	}

	private async linkFlywheel(): Promise<void> {
		const wheel = await this.read(normalizePath(flywheelPath(this.wheelFolder())));
		const els = parseFlywheel(wheel).filter((e) => e.status !== "폐기");
		if (!els.length) {
			new Notice("Flywheel 요소가 없어요. Flywheel 화면에서 먼저 만들어 주세요.");
			return;
		}
		const v = await askForm(this.app, {
			title: "Flywheel 잇기",
			desc: "확언을 끝까지 읽고 넘기면 이 요소의 오늘 칸이 체크돼요.",
			fields: [{ key: "id", label: "요소", type: "select", value: this.board.flywheel, options: [["", "(잇지 않음)"], ...els.map((e): [string, string] => [e.id, e.name])] }],
			cta: "저장",
		});
		if (!v) return;
		const name = els.find((e) => e.id === v.id)?.name;
		await this.writeBoard(name ? `Flywheel 연결: ${v.id} ${name}` : "Flywheel 연결 끊음", (t) => setFrontmatterScalar(t, "flywheel", v.id));
	}

	/** File picker → `<folder>/images/YYYY-MM-DD 장면.ext` → that card's image. */
	private pickImage(i: number): void {
		const input = document.body.createEl("input", { attr: { type: "file", accept: "image/*" } });
		input.style.display = "none";
		input.addEventListener("change", async () => {
			const file = input.files?.[0];
			input.remove();
			const c = this.board.cards[i];
			if (!file || !c) return;
			try {
				const dir = normalizePath(`${this.folder()}/${IMAGES_DIR}`);
				await this.ensureFolder(dir);
				const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : "png";
				let path = normalizePath(`${dir}/${imageName(todayIso(), c.title, ext)}`);
				for (let k = 2; this.app.vault.getAbstractFileByPath(path); k++) path = path.replace(/(?: \d+)?(\.[^.]+)$/, ` ${k}$1`);
				await this.app.vault.createBinary(path, await file.arrayBuffer());
				await this.writeBoard(`비전 카드 이미지: ${c.title}`, (t, b) => setCards(t, b.cards.map((x, k) => (k === i ? { ...x, image: path } : x))));
			} catch (err) {
				console.error("[MyLogs] Vision Board image upload failed", err);
				new Notice("MyLogs: 이미지를 저장하지 못했어요.");
			}
		});
		input.click();
	}

	private async openRaw(): Promise<void> {
		const f = this.file(this.boardPath());
		if (f) await this.app.workspace.getLeaf("tab").openFile(f);
	}

	private async createBoard(): Promise<void> {
		const path = this.boardPath();
		try {
			await this.ensureFolder(normalizePath(`${this.folder()}/${IMAGES_DIR}`));
			if (!this.file(path)) await this.app.vault.create(path, visionSkeleton(todayIso()));
		} catch (err) {
			console.error(err);
			new Notice("MyLogs: Vision Board.md를 만들지 못했어요.");
		}
		await this.refresh();
		await this.addCard();
	}
}
