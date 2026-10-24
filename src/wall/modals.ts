import { type App, Modal, Setting } from "obsidian";

/** A one-line text prompt. Resolves to the text, or null when dismissed. */
export class TextPromptModal extends Modal {
	private value: string;
	private done = false;
	private resolve!: (v: string | null) => void;

	constructor(
		app: App,
		private readonly opts: { title: string; desc?: string; placeholder?: string; value?: string; cta?: string; allowEmpty?: boolean },
	) {
		super(app);
		this.value = opts.value ?? "";
	}

	ask(): Promise<string | null> {
		return new Promise((res) => {
			this.resolve = res;
			this.open();
		});
	}

	onOpen(): void {
		this.modalEl.addClass("mylogs-wall-modal");
		this.titleEl.setText(this.opts.title);
		if (this.opts.desc) this.contentEl.createEl("p", { cls: "mylogs-wall-modal-desc", text: this.opts.desc });
		let input: HTMLInputElement | null = null;
		new Setting(this.contentEl).addText((t) => {
			input = t.inputEl;
			t.setPlaceholder(this.opts.placeholder ?? "").setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(this.opts.cta ?? "확인")
					.setCta()
					.onClick(() => this.submit()),
			);
		window.setTimeout(() => (input as HTMLInputElement | null)?.focus(), 0);
	}

	private submit(): void {
		if (!this.opts.allowEmpty && !this.value.trim()) return;
		this.done = true;
		this.resolve(this.value.trim());
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) this.resolve(null);
	}
}

/** Pick a month (1–12). Disabled months can't be chosen. */
export class MonthPickerModal extends Modal {
	private done = false;
	private resolve!: (m: number | null) => void;

	constructor(
		app: App,
		private readonly opts: { title: string; year: number; disabled: (m: number) => boolean },
	) {
		super(app);
	}

	ask(): Promise<number | null> {
		return new Promise((res) => {
			this.resolve = res;
			this.open();
		});
	}

	onOpen(): void {
		this.modalEl.addClass("mylogs-wall-modal");
		this.titleEl.setText(this.opts.title);
		const grid = this.contentEl.createDiv({ cls: "mylogs-wall-monthpick" });
		for (let m = 1; m <= 12; m++) {
			const b = grid.createEl("button", { text: `${m}월`, attr: { type: "button" } });
			if (this.opts.disabled(m)) b.disabled = true;
			else
				b.addEventListener("click", () => {
					this.done = true;
					this.resolve(m);
					this.close();
				});
		}
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) this.resolve(null);
	}
}
