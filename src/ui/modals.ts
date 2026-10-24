import { type App, Modal, Setting } from "obsidian";

// ───────────────────────── delete confirmation ─────────────────────────

export type ConfirmAnswer = "delete" | "alt" | null;

export interface ConfirmDeleteOptions {
	/** e.g. `할 일 삭제`. */
	title: string;
	/** What will be removed, one entry per line / file / row. Shown as a list. */
	removes: string[];
	/** Other things that change or point at it (references, back-links). */
	notes?: string[];
	/** Where it goes, e.g. "파일은 휴지통으로 가서 되살릴 수 있어요." */
	footer?: string;
	/** Offer a record-keeping alternative next to 삭제 (e.g. `놓아주기 (기록 남김)`). */
	alt?: { label: string; desc: string };
	/** Label of the delete button (default `삭제`). */
	cta?: string;
}

/**
 * "Delete" is for mistakes, duplicates and test data. Always names what will be removed; when a
 * record-keeping choice fits (취소·놓아주기), it is offered as a separate, non-destructive button.
 */
export function confirmDelete(app: App, o: ConfirmDeleteOptions): Promise<ConfirmAnswer> {
	return new Promise((resolve) => new ConfirmDeleteModal(app, o, resolve).open());
}

class ConfirmDeleteModal extends Modal {
	private done = false;
	constructor(
		app: App,
		private o: ConfirmDeleteOptions,
		private resolve: (v: ConfirmAnswer) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const el = this.contentEl;
		this.modalEl.addClass("mylogs-modal", "mylogs-delete-modal");
		this.setTitle(this.o.title);
		el.createEl("p", { cls: "mylogs-modal-desc", text: "아래 항목을 지워요. 기록으로 남기지 않아요." });
		const ul = el.createEl("ul", { cls: "mylogs-delete-list" });
		for (const r of this.o.removes) ul.createEl("li").createEl("code", { text: r });
		if (this.o.notes?.length) {
			const box = el.createDiv({ cls: "mylogs-delete-notes" });
			for (const n of this.o.notes) box.createEl("p", { text: n });
		}
		if (this.o.footer) el.createEl("p", { cls: "mylogs-modal-desc", text: this.o.footer });
		if (this.o.alt) el.createEl("p", { cls: "mylogs-modal-desc mylogs-delete-alt", text: this.o.alt.desc });
		const s = new Setting(el).addButton((b) => b.setButtonText("닫기").onClick(() => this.finish(null)));
		if (this.o.alt) s.addButton((b) => b.setButtonText(this.o.alt!.label).onClick(() => this.finish("alt")));
		s.addButton((b) =>
			b
				.setButtonText(this.o.cta ?? "삭제")
				.setWarning()
				.onClick(() => this.finish("delete")),
		);
	}

	private finish(v: ConfirmAnswer): void {
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

// ───────────────────────── edit form ─────────────────────────

export type FormField =
	| { key: string; label: string; type: "text"; value: string; desc?: string; placeholder?: string; list?: string[] }
	| { key: string; label: string; type: "textarea"; value: string; desc?: string; placeholder?: string }
	| { key: string; label: string; type: "select"; value: string; desc?: string; options: [string, string][] }
	| { key: string; label: string; type: "date"; value: string; desc?: string };

export interface FormOptions {
	title: string;
	desc?: string;
	fields: FormField[];
	cta?: string;
	/** Problems with the values (empty = ok). */
	validate?: (v: Record<string, string>) => string[];
}

/** A small edit form. Resolves the values (trimmed) or null when cancelled. */
export function askForm(app: App, o: FormOptions): Promise<Record<string, string> | null> {
	return new Promise((resolve) => new FormModal(app, o, resolve).open());
}

class FormModal extends Modal {
	private done = false;
	private v: Record<string, string> = {};

	constructor(
		app: App,
		private o: FormOptions,
		private resolve: (v: Record<string, string> | null) => void,
	) {
		super(app);
		for (const f of o.fields) this.v[f.key] = f.value;
	}

	onOpen(): void {
		const el = this.contentEl;
		this.modalEl.addClass("mylogs-modal", "mylogs-form-modal");
		this.setTitle(this.o.title);
		if (this.o.desc) el.createEl("p", { cls: "mylogs-modal-desc", text: this.o.desc });
		let first: HTMLElement | null = null;
		for (const f of this.o.fields) {
			const s = new Setting(el).setName(f.label);
			if (f.desc) s.setDesc(f.desc);
			if (f.type === "text") {
				s.addText((t) => {
					t.setValue(f.value).onChange((x) => (this.v[f.key] = x));
					if (f.placeholder) t.setPlaceholder(f.placeholder);
					t.inputEl.addClass("mylogs-form-wide");
					if (f.list?.length) {
						const id = `mylogs-form-${f.key}-${Date.now()}`;
						const dl = el.createEl("datalist", { attr: { id } });
						for (const x of f.list) dl.createEl("option", { attr: { value: x } });
						t.inputEl.setAttr("list", id);
					}
					t.inputEl.addEventListener("keydown", (e) => {
						if (e.key === "Enter" && !e.isComposing) {
							e.preventDefault();
							this.submit(errors);
						}
					});
					first ??= t.inputEl;
				});
			} else if (f.type === "textarea") {
				s.addTextArea((t) => {
					t.setValue(f.value).onChange((x) => (this.v[f.key] = x));
					if (f.placeholder) t.setPlaceholder(f.placeholder);
					t.inputEl.rows = 4;
					t.inputEl.addClass("mylogs-form-wide");
					first ??= t.inputEl;
				});
			} else if (f.type === "select") {
				s.addDropdown((d) => {
					for (const [val, label] of f.options) d.addOption(val, label);
					d.setValue(f.value).onChange((x) => (this.v[f.key] = x));
				});
			} else {
				s.controlEl.createEl("input", { attr: { type: "date" } }, (input) => {
					input.value = f.value;
					input.addEventListener("change", () => (this.v[f.key] = input.value));
				});
			}
		}
		const errors = el.createEl("ul", { cls: "mylogs-form-errors" });
		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText(this.o.cta ?? "저장")
					.setCta()
					.onClick(() => this.submit(errors)),
			);
		window.setTimeout(() => first?.focus(), 0);
	}

	private submit(errors: HTMLElement): void {
		const out: Record<string, string> = {};
		for (const [k, x] of Object.entries(this.v)) out[k] = x.trim();
		const problems = this.o.validate?.(out) ?? [];
		errors.empty();
		if (problems.length) {
			for (const p of problems) errors.createEl("li", { text: p });
			return;
		}
		this.finish(out);
	}

	private finish(v: Record<string, string> | null): void {
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
