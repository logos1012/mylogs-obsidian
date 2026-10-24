import { type App, Modal, Setting } from "obsidian";

/** Pick a date (`<input type=date>`). Resolves null when cancelled. */
export function pickDate(app: App, title: string, initial: string, desc?: string): Promise<string | null> {
	return new Promise((resolve) => new PickModal(app, title, "date", initial, desc, resolve).open());
}

/** Pick a month (`<input type=month>`, YYYY-MM). Resolves null when cancelled. */
export function pickMonth(app: App, title: string, initial: string, desc?: string): Promise<string | null> {
	return new Promise((resolve) => new PickModal(app, title, "month", initial, desc, resolve).open());
}

class PickModal extends Modal {
	private done = false;
	constructor(
		app: App,
		private title: string,
		private kind: "date" | "month",
		private initial: string,
		private desc: string | undefined,
		private resolve: (v: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("mylogs-desk-calendar-modal");
		this.setTitle(this.title);
		if (this.desc) contentEl.createEl("p", { cls: "mylogs-desk-calendar-modal-desc", text: this.desc });
		const input = contentEl.createEl("input", { attr: { type: this.kind } });
		input.value = this.initial;
		const ok = (): void => {
			const v = input.value.trim();
			const valid = this.kind === "date" ? /^\d{4}-\d{2}-\d{2}$/.test(v) : /^\d{4}-\d{2}$/.test(v);
			if (!valid) return;
			this.finish(v);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") ok();
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) => b.setButtonText("확인").setCta().onClick(ok));
		window.setTimeout(() => input.focus(), 0);
	}

	private finish(v: string | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(v);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.resolve(null);
		}
	}
}

/** Ask for one line (or several, `multiline`). Resolves null when cancelled or empty. */
export function promptText(app: App, title: string, opts: { desc?: string; placeholder?: string; multiline?: boolean; okText?: string } = {}): Promise<string | null> {
	return new Promise((resolve) => new TextModal(app, title, opts, resolve).open());
}

class TextModal extends Modal {
	private done = false;
	constructor(
		app: App,
		private title: string,
		private opts: { desc?: string; placeholder?: string; multiline?: boolean; okText?: string },
		private resolve: (v: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("mylogs-desk-calendar-modal");
		this.setTitle(this.title);
		if (this.opts.desc) contentEl.createEl("p", { cls: "mylogs-desk-calendar-modal-desc", text: this.opts.desc });
		const input = this.opts.multiline
			? contentEl.createEl("textarea", { attr: { rows: "5", placeholder: this.opts.placeholder ?? "" } })
			: contentEl.createEl("input", { attr: { type: "text", placeholder: this.opts.placeholder ?? "" } });
		input.addClass("mylogs-desk-calendar-modal-input");
		const ok = (): void => {
			const v = input.value.trim();
			if (v) this.finish(v);
		};
		(input as HTMLElement).addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && (!this.opts.multiline || e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				ok();
			}
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) => b.setButtonText(this.opts.okText ?? "확인").setCta().onClick(ok));
		window.setTimeout(() => input.focus(), 0);
	}

	private finish(v: string | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(v);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.resolve(null);
		}
	}
}

export type ThirdMoveAnswer = "proceed" | "letgo" | "split" | "cancel";

/**
 * The third-postpone questions (`04 Daily Pad/AGENTS.md` 「못 한 일 처리」): 의무 and 가치.
 * Both "아니오" → 놓아주기 is recommended (highlighted), but the user can still proceed.
 */
export function askThirdMove(app: App, itemText: string, moved: number): Promise<ThirdMoveAnswer> {
	return new Promise((resolve) => new ThirdMoveModal(app, itemText, moved, resolve).open());
}

class ThirdMoveModal extends Modal {
	private done = false;
	private duty: boolean | null = null;
	private value: boolean | null = null;

	constructor(
		app: App,
		private itemText: string,
		private moved: number,
		private resolve: (v: ThirdMoveAnswer) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("세 번째로 미루기 전에");
		this.contentEl.addClass("mylogs-desk-calendar-modal", "mylogs-desk-calendar-third");
		this.draw();
	}

	private draw(): void {
		const el = this.contentEl;
		el.empty();
		el.createEl("p", { cls: "mylogs-desk-calendar-modal-desc", text: `「${this.itemText}」은(는) 이미 ${this.moved}번 미뤘어요.` });
		const q = (label: string, sub: string, get: () => boolean | null, set: (v: boolean) => void) => {
			const row = el.createDiv({ cls: "mylogs-desk-calendar-q" });
			const t = row.createDiv({ cls: "mylogs-desk-calendar-q-text" });
			t.createDiv({ text: label });
			t.createDiv({ cls: "mylogs-desk-calendar-q-sub", text: sub });
			const btns = row.createDiv({ cls: "mylogs-desk-calendar-q-btns" });
			for (const [txt, v] of [
				["예", true],
				["아니오", false],
			] as const) {
				const b = btns.createEl("button", { text: txt, attr: { type: "button", "aria-pressed": String(get() === v) } });
				if (get() === v) b.addClass("is-active");
				b.addEventListener("click", () => {
					set(v);
					this.draw();
				});
			}
		};
		q("반드시 해야 하는 일인가?", "의무", () => this.duty, (v) => (this.duty = v));
		q("나나 내 사람에게 정말 중요한 일인가?", "가치", () => this.value, (v) => (this.value = v));

		const bothNo = this.duty === false && this.value === false;
		const anyYes = this.duty === true || this.value === true;
		if (bothNo) el.createDiv({ cls: "mylogs-desk-calendar-recommend", text: "둘 다 아니라면 놓아주기를 권해요. 놓아주는 것도 결정이에요." });
		else if (anyYes) el.createDiv({ cls: "mylogs-desk-calendar-recommend is-soft", text: "왜 못 했는지 생각해 봐요. 너무 크다면 쪼개기가 나을 수 있어요." });

		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish("cancel")))
			.addButton((b) => b.setButtonText("쪼개기").onClick(() => this.finish("split")))
			.addButton((b) => {
				b.setButtonText("놓아주기").onClick(() => this.finish("letgo"));
				if (bothNo) b.setCta();
			})
			.addButton((b) => {
				b.setButtonText("그래도 옮기기").onClick(() => this.finish("proceed"));
				if (!bothNo && this.duty !== null && this.value !== null) b.setCta();
			});
	}

	private finish(v: ThirdMoveAnswer): void {
		if (this.done) return;
		this.done = true;
		this.resolve(v);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.resolve("cancel");
		}
	}
}
