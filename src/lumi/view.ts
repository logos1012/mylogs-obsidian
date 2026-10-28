/**
 * 루미 panel (`mylogs-lumi`, right sidebar).
 *
 *   머리   루미 · 부른 화면 · 「지난 대화」 · 「+ 새 대화」
 *   탭     open conversations (each runs on its own; a dot while it answers); double-click renames
 *   도구   this tab's engine (Claude Code / Codex) and model · ⋯ (전체 복사, 이름 바꾸기, 닫기)
 *   대화   bubbles (copy on hover), 루미's 선택지 as quick replies
 *   입력   Enter 보내기 · Shift+Enter 줄바꿈 · ■ 멈추기
 */

import { type App, Component, ItemView, MarkdownRenderer, Menu, Modal, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { LUMI_SVG } from "./icon.ts";
import type { LumiChat, LumiMessage } from "./controller.ts";
import { tip } from "../ui/tip.ts";
import { splitChoices } from "./session.ts";

export const VIEW_TYPE_LUMI = "mylogs-lumi";

const CLAUDE_MODELS: [string, string][] = [
	["", "기본 모델"],
	["opus", "Opus"],
	["sonnet", "Sonnet"],
	["haiku", "Haiku"],
];

async function copy(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		new Notice("복사했어요");
	} catch {
		new Notice("복사하지 못했어요");
	}
}

export class LumiView extends ItemView {
	plugin: MyLogsPlugin;
	private listEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private screenEl!: HTMLElement;
	private tabsEl!: HTMLElement;
	private toolsEl!: HTMLElement;
	private renderChild: Component | null = null;
	/** Codex models from `~/.codex/models_cache.json` (read once, lazily). */
	private codexModels: [string, string][] | null = null;
	/** Unsent text per tab. */
	private drafts = new Map<string, string>();
	private shownTab = "";

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_LUMI;
	}
	getDisplayText(): string {
		return "루미";
	}
	getIcon(): string {
		return "sparkles";
	}

	private get lumi() {
		return this.plugin.lumi;
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("mylogs-lumi");
		const head = root.createDiv({ cls: "lumi-head" });
		const avatar = head.createDiv({ cls: "lumi-avatar" });
		avatar.innerHTML = LUMI_SVG;
		const title = head.createDiv({ cls: "lumi-title" });
		title.createDiv({ cls: "lumi-name", text: "루미" });
		this.screenEl = title.createDiv({ cls: "lumi-screen" });
		const hist = head.createEl("button", { cls: "lumi-head-btn", attr: { type: "button" } });
		setIcon(hist.createSpan({ cls: "lumi-btn-icon" }), "history");
		hist.createSpan({ text: "지난 대화" });
		tip(hist, "저장된 루미 대화를 다시 열어 이어서 말해요");
		hist.addEventListener("click", () => new HistoryModal(this.app, this.plugin).open());
		const fresh = head.createEl("button", { cls: "lumi-head-btn is-primary", attr: { type: "button" } });
		setIcon(fresh.createSpan({ cls: "lumi-btn-icon" }), "plus");
		fresh.createSpan({ text: "새 대화" });
		tip(fresh, "새 탭에서 대화를 시작해요. 지금 대화는 그대로 남아요");
		fresh.addEventListener("click", () => this.lumi.addTab());

		this.tabsEl = root.createDiv({ cls: "lumi-tabs", attr: { role: "tablist" } });
		this.toolsEl = root.createDiv({ cls: "lumi-tools" });
		this.listEl = root.createDiv({ cls: "lumi-list" });
		const box = root.createDiv({ cls: "lumi-input" });
		this.inputEl = box.createEl("textarea", { attr: { rows: "2", placeholder: "루미에게 말하기…" } });
		tip(this.inputEl, "Enter 보내기 · Shift+Enter 줄바꿈");
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
		this.inputEl.addEventListener("input", () => this.drafts.set(this.lumi.active.id, this.inputEl.value));
		this.sendBtn = box.createEl("button", { cls: "lumi-send mod-cta", attr: { type: "button", "aria-label": "보내기" } });
		this.sendBtn.addEventListener("click", () => (this.lumi.active.busy ? this.lumi.active.stop() : this.submit()));
		this.register(this.lumi.on(() => this.render()));
		this.render();
		window.setTimeout(() => this.inputEl.focus(), 50);
	}

	async onClose(): Promise<void> {
		this.renderChild?.unload();
	}

	focusInput(): void {
		this.inputEl?.focus();
	}

	private submit(): void {
		const v = this.inputEl.value;
		if (!v.trim()) return;
		const chat = this.lumi.active;
		this.inputEl.value = "";
		this.drafts.delete(chat.id);
		void chat.send(v);
	}

	private render(): void {
		const c = this.lumi;
		const chat = c.active;
		const s = c.screen;
		this.screenEl.setText(s ? `${s.label}${s.item ? ` · ${s.item}` : ""}` : "MyLogs");
		if (this.shownTab !== chat.id) {
			this.inputEl.value = this.drafts.get(chat.id) ?? "";
			this.shownTab = chat.id;
		}
		this.renderTabs();
		this.renderTools(chat);
		this.sendBtn.empty();
		setIcon(this.sendBtn, chat.busy ? "square" : "arrow-up");
		this.sendBtn.setAttr("aria-label", chat.busy ? "멈추기" : "보내기");

		const stick = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 60;
		this.renderChild?.unload();
		this.renderChild = this.addChild(new Component());
		this.listEl.empty();
		chat.messages.forEach((m, i) => this.renderMessage(chat, m, i === chat.messages.length - 1));
		if (stick || chat.busy) this.listEl.scrollTop = this.listEl.scrollHeight;
	}

	private renderTabs(): void {
		const c = this.lumi;
		this.tabsEl.empty();
		for (const chat of c.chats) {
			const t = this.tabsEl.createDiv({ cls: `lumi-tab${chat.id === c.active.id ? " is-active" : ""}${chat.busy ? " is-busy" : ""}`, attr: { role: "tab", tabindex: "0" } });
			if (chat.busy) t.createSpan({ cls: "lumi-tab-dot" });
			t.createSpan({ cls: "lumi-tab-title", text: chat.title });
			tip(t, `${chat.title} · ${chat.engine === "claude" ? "Claude Code" : "Codex"} · 더블클릭해서 이름 바꾸기`);
			t.addEventListener("click", () => c.select(chat.id));
			t.addEventListener("dblclick", () => this.renameTab(chat));
			if (c.chats.length > 1) {
				const x = t.createEl("button", { cls: "lumi-tab-close", attr: { type: "button", "aria-label": `${chat.title} 닫기` } });
				setIcon(x, "x");
				x.addEventListener("click", (e) => {
					e.stopPropagation();
					c.close(chat.id);
				});
			}
		}
	}

	private renderTools(chat: LumiChat): void {
		this.toolsEl.empty();
		const seg = this.toolsEl.createDiv({ cls: "lumi-engine", attr: { role: "radiogroup", "aria-label": "엔진" } });
		for (const [id, label] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
			const b = seg.createEl("button", { cls: `lumi-engine-btn${chat.engine === id ? " is-active" : ""}`, text: label, attr: { type: "button", role: "radio", "aria-checked": String(chat.engine === id) } });
			b.disabled = chat.busy;
			tip(b, id === "claude" ? "내 Claude 구독으로 Claude Code 실행" : "내 ChatGPT 구독으로 Codex 실행");
			b.addEventListener("click", () => {
				if (chat.engine === id) return;
				const s = this.plugin.settings;
				chat.setEngine(id, id === "claude" ? s.lumiClaudeModel : s.lumiCodexModel);
			});
		}
		const options = chat.engine === "claude" ? CLAUDE_MODELS : this.codexOptions(chat);
		const sel = this.toolsEl.createEl("select", { cls: "dropdown lumi-model", attr: { "aria-label": "모델" } });
		for (const [v, l] of options) sel.createEl("option", { text: l, attr: { value: v } });
		if (!options.some(([v]) => v === chat.model)) sel.createEl("option", { text: chat.model, attr: { value: chat.model } });
		sel.value = chat.model;
		sel.disabled = chat.busy;
		tip(sel, "이 대화에서 쓸 모델");
		sel.addEventListener("change", () => chat.setEngine(chat.engine, sel.value));
		const more = this.toolsEl.createEl("button", { cls: "clickable-icon lumi-more", attr: { type: "button", "aria-label": "대화 메뉴" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (e) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("대화 전체 복사").setIcon("copy").onClick(() => void copy(chat.copyAll())));
			m.addItem((i) => i.setTitle("이름 바꾸기…").setIcon("pencil").onClick(() => this.renameTab(chat)));
			if (chat.path) m.addItem((i) => i.setTitle("세션 파일 열기").setIcon("file-text").onClick(() => void this.app.workspace.openLinkText(chat.path!, "", "tab")));
			m.addSeparator();
			m.addItem((i) => i.setTitle("이 탭 닫기").setIcon("x").onClick(() => this.lumi.close(chat.id)));
			m.showAtMouseEvent(e);
		});
	}

	private codexOptions(chat: LumiChat): [string, string][] {
		if (!this.codexModels) {
			this.codexModels = [["", "기본 모델"]];
			void import("./engines.ts").then(({ listCodexModels }) => {
				this.codexModels = [["", "기본 모델"], ...listCodexModels().map((m) => [m.id, m.label] as [string, string])];
				if (this.lumi.active === chat) this.render();
			});
		}
		return this.codexModels;
	}

	private renameTab(chat: LumiChat): void {
		new RenameModal(this.app, chat.title, (v) => this.lumi.rename(chat.id, v)).open();
	}

	private renderMessage(chat: LumiChat, m: LumiMessage, last: boolean): void {
		const row = this.listEl.createDiv({ cls: `lumi-msg is-${m.role}` });
		if (m.role === "lumi") {
			const a = row.createDiv({ cls: "lumi-msg-avatar" });
			a.innerHTML = LUMI_SVG;
		}
		const bubble = row.createDiv({ cls: "lumi-bubble" });
		const streaming = last && chat.busy && m.role === "lumi";
		const { body, choices } = m.role === "lumi" && !streaming ? splitChoices(m.text) : { body: m.text, choices: [] as string[] };
		if (m.role === "lumi" && !streaming && body) void MarkdownRenderer.render(this.app, body, bubble.createDiv({ cls: "lumi-md" }), "", this.renderChild!);
		else if (body) bubble.createDiv({ cls: "lumi-plain", text: body });
		if (streaming && !body) bubble.createDiv({ cls: "lumi-thinking", text: "생각하는 중…" });
		if (m.activity?.length && (streaming || !body)) {
			const act = bubble.createDiv({ cls: "lumi-activity" });
			for (const a of m.activity) act.createDiv({ text: a });
		}
		if (m.error) bubble.createDiv({ cls: "lumi-error", text: m.error });
		if (!streaming && m.text.trim()) {
			const cp = row.createEl("button", { cls: "lumi-copy clickable-icon", attr: { type: "button", "aria-label": "복사" } });
			setIcon(cp, "copy");
			cp.addEventListener("click", () => void copy(m.text));
		}
		if (last && !chat.busy && choices.length) {
			const row2 = this.listEl.createDiv({ cls: "lumi-choices" });
			for (const ch of choices) {
				const b = row2.createEl("button", { cls: "lumi-choice", text: ch, attr: { type: "button" } });
				b.addEventListener("click", () => void chat.send(ch));
			}
		}
	}
}

class RenameModal extends Modal {
	constructor(
		app: App,
		private value: string,
		private done: (v: string) => void,
	) {
		super(app);
	}
	onOpen(): void {
		this.setTitle("대화 이름");
		const input = this.contentEl.createEl("input", { attr: { type: "text" }, cls: "lumi-rename" });
		input.value = this.value;
		const ok = () => {
			this.done(input.value);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) ok();
		});
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: "취소", attr: { type: "button" } }).addEventListener("click", () => this.close());
		row.createEl("button", { text: "바꾸기", cls: "mod-cta", attr: { type: "button" } }).addEventListener("click", ok);
		window.setTimeout(() => input.select(), 0);
	}
	onClose(): void {
		this.contentEl.empty();
	}
}

/** 지난 대화: 루미's saved sessions, newest first; one opens in a tab to continue. */
class HistoryModal extends Modal {
	constructor(
		app: App,
		private plugin: MyLogsPlugin,
	) {
		super(app);
	}
	onOpen(): void {
		this.setTitle("지난 대화");
		this.modalEl.addClass("lumi-history-modal");
		const items = this.plugin.lumi.history();
		const filter = this.contentEl.createEl("input", { attr: { type: "search", placeholder: "제목으로 찾기" }, cls: "lumi-history-filter" });
		const list = this.contentEl.createDiv({ cls: "lumi-history" });
		const draw = () => {
			list.empty();
			const q = filter.value.trim();
			const shown = items.filter((i) => !q || i.title.includes(q));
			if (!shown.length) list.createDiv({ cls: "lumi-history-empty", text: items.length ? "찾는 대화가 없어요" : "아직 저장된 루미 대화가 없어요" });
			for (const i of shown.slice(0, 200)) {
				const b = list.createEl("button", { cls: "lumi-history-item", attr: { type: "button" } });
				b.createDiv({ cls: "lumi-history-title", text: i.title });
				b.createDiv({ cls: "lumi-history-meta", text: `${i.date} · ${i.engine}` });
				b.addEventListener("click", () => {
					void this.plugin.lumi.openSession(i.path);
					this.close();
				});
			}
		};
		filter.addEventListener("input", draw);
		draw();
		window.setTimeout(() => filter.focus(), 0);
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
