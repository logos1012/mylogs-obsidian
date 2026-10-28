/**
 * 루미 panel (`mylogs-lumi`, right sidebar): who 루미 is talking about (the screen she was called
 * from), the conversation, quick replies from her `선택지:` line, and the input. The conversation
 * lives in `LumiController`, so closing the panel loses nothing.
 */

import { Component, ItemView, MarkdownRenderer, setIcon, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { LUMI_SVG } from "./icon.ts";
import type { LumiMessage } from "./controller.ts";
import { tip } from "../ui/tip.ts";
import { splitChoices } from "./session.ts";

export const VIEW_TYPE_LUMI = "mylogs-lumi";

export class LumiView extends ItemView {
	plugin: MyLogsPlugin;
	private listEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private screenEl!: HTMLElement;
	private engineEl!: HTMLElement;
	private renderChild: Component | null = null;

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
		this.engineEl = head.createDiv({ cls: "lumi-engine", attr: { role: "tablist" } });
		const fresh = head.createEl("button", { cls: "clickable-icon lumi-new", attr: { type: "button", "aria-label": "새 대화" } });
		setIcon(fresh, "square-pen");
		tip(fresh, "새 대화 — 지금 대화는 세션으로 저장돼 있어요");
		fresh.addEventListener("click", () => this.plugin.lumi.newConversation());

		this.listEl = root.createDiv({ cls: "lumi-list" });
		const box = root.createDiv({ cls: "lumi-input" });
		this.inputEl = box.createEl("textarea", { attr: { rows: "2", placeholder: "루미에게 말하기…" } });
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
		this.sendBtn = box.createEl("button", { cls: "lumi-send mod-cta", attr: { type: "button", "aria-label": "보내기" } });
		this.sendBtn.addEventListener("click", () => (this.plugin.lumi.busy ? this.plugin.lumi.stop() : this.submit()));
		this.register(this.plugin.lumi.on(() => this.render()));
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
		this.inputEl.value = "";
		void this.plugin.lumi.send(v);
	}

	private render(): void {
		const c = this.plugin.lumi;
		const s = c.screen;
		this.screenEl.setText(s ? `${s.label}${s.item ? ` · ${s.item}` : ""}` : "MyLogs");
		this.engineEl.empty();
		for (const [id, label] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
			const b = this.engineEl.createEl("button", { cls: `lumi-engine-btn${this.plugin.settings.lumiEngine === id ? " is-active" : ""}`, text: label, attr: { type: "button", role: "tab" } });
			b.disabled = c.busy;
			tip(b, id === "claude" ? "내 Claude 구독으로 Claude Code 실행 (바꾸면 새 대화)" : "내 ChatGPT 구독으로 Codex 실행 (바꾸면 새 대화)");
			b.addEventListener("click", () => void c.setEngine(id));
		}
		this.sendBtn.empty();
		setIcon(this.sendBtn, c.busy ? "square" : "arrow-up");
		this.sendBtn.setAttr("aria-label", c.busy ? "멈추기" : "보내기");
		this.contentEl.toggleClass("is-busy", c.busy);

		const stick = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 60;
		this.renderChild?.unload();
		this.renderChild = this.addChild(new Component());
		this.listEl.empty();
		c.messages.forEach((m, i) => this.renderMessage(m, i === c.messages.length - 1));
		if (stick || c.busy) this.listEl.scrollTop = this.listEl.scrollHeight;
	}

	private renderMessage(m: LumiMessage, last: boolean): void {
		const c = this.plugin.lumi;
		const row = this.listEl.createDiv({ cls: `lumi-msg is-${m.role}` });
		if (m.role === "lumi") {
			const a = row.createDiv({ cls: "lumi-msg-avatar" });
			a.innerHTML = LUMI_SVG;
		}
		const bubble = row.createDiv({ cls: "lumi-bubble" });
		const streaming = last && c.busy && m.role === "lumi";
		const { body, choices } = m.role === "lumi" && !streaming ? splitChoices(m.text) : { body: m.text, choices: [] as string[] };
		if (m.role === "lumi" && !streaming && body) void MarkdownRenderer.render(this.app, body, bubble.createDiv({ cls: "lumi-md" }), "", this.renderChild!);
		else if (body) bubble.createDiv({ cls: "lumi-plain", text: body });
		if (streaming && !body) bubble.createDiv({ cls: "lumi-thinking", text: "생각하는 중…" });
		if (m.activity?.length && (streaming || !body)) {
			const act = bubble.createDiv({ cls: "lumi-activity" });
			for (const a of m.activity) act.createDiv({ text: a });
		}
		if (m.error) bubble.createDiv({ cls: "lumi-error", text: m.error });
		if (last && !c.busy && choices.length) {
			const row2 = this.listEl.createDiv({ cls: "lumi-choices" });
			for (const ch of choices) {
				const b = row2.createEl("button", { cls: "lumi-choice", text: ch, attr: { type: "button" } });
				b.addEventListener("click", () => void c.send(ch));
			}
		}
	}
}
