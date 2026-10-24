import { type App, Modal, Setting } from "obsidian";
import { askForm } from "../ui/modals.ts";
import { DRAWER_SECTIONS, type DrawerSection, WHEN_UNDECIDED } from "./model.ts";
import type { NewDrawerItem } from "./ops.ts";

export type WhenAnswer = { kind: "put"; when: string } | { kind: "letgo" } | null;

/**
 * 「4-1」 1: an item without `when::` is not put in. Ask for the condition; "그냥 언젠가" is not one,
 * so 놓아주기 is offered first. The user can still insist → `(when:: 미정)`.
 */
export function askWhen(app: App, text: string): Promise<WhenAnswer> {
	return new Promise((resolve) => new WhenModal(app, text, resolve).open());
}

class WhenModal extends Modal {
	private done = false;
	private when = "";

	constructor(
		app: App,
		private text: string,
		private resolve: (v: WhenAnswer) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const el = this.contentEl;
		this.modalEl.addClass("mylogs-modal", "mylogs-drawer-modal");
		this.setTitle("다시 꺼낼 조건이 없어요");
		el.createEl("p", { cls: "mylogs-modal-desc", text: `「${this.text}」을(를) Drawer에 넣으려면 다시 꺼낼 조건이 있어야 해요. "언젠가", "시간 날 때"는 조건이 아니에요.` });
		el.createEl("p", { cls: "mylogs-modal-desc", text: "조건을 쓸 수 없다면 놓아주기를 권해요. 보내지 않은 항목은 잃는 것이 아니에요 — 원문은 세션에 남아요." });
		let input: HTMLInputElement | null = null;
		new Setting(el)
			.setName("다시 꺼낼 조건 (when::)")
			.setDesc("예: 강의 첫 판매 후 · 95kg 도달 시 · G-2026-01.2")
			.addText((t) => {
				input = t.inputEl;
				t.inputEl.addClass("mylogs-form-wide");
				t.onChange((x) => (this.when = x));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing && this.when.trim()) {
						e.preventDefault();
						this.finish({ kind: "put", when: this.when.trim() });
					}
				});
			});
		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) => b.setButtonText("놓아주기 (권함)").setCta().onClick(() => this.finish({ kind: "letgo" })))
			.addButton((b) => b.setButtonText(`그래도 넣기 (when:: ${WHEN_UNDECIDED})`).onClick(() => this.finish({ kind: "put", when: WHEN_UNDECIDED })))
			.addButton((b) =>
				b.setButtonText("조건과 함께 넣기").onClick(() => {
					if (this.when.trim()) this.finish({ kind: "put", when: this.when.trim() });
					else input?.focus();
				}),
			);
		window.setTimeout(() => input?.focus(), 0);
	}

	private finish(v: WhenAnswer): void {
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

const SECTION_OPTIONS = DRAWER_SECTIONS.map((s) => [s, s] as [string, string]);

/** 「+ 넣기」 (manual add, 「4-1」): 내용, when::, 섹션, 출처, 맥락. */
export async function askNewItem(app: App, today: string, defaults: Partial<NewDrawerItem> = {}): Promise<NewDrawerItem | null> {
	const v = await askForm(app, {
		title: "Drawer에 넣기",
		desc: "하기로 했는데 지금은 아닌 것을 날짜 없이 둬요. 날짜 대신 다시 꺼낼 조건을 붙여요.",
		cta: "넣기",
		fields: [
			{ key: "text", label: "내용", type: "text", value: defaults.text ?? "", placeholder: "한 줄 요약 (원문을 옮기지 않아요)" },
			{ key: "when", label: "다시 꺼낼 조건 (when::)", type: "text", value: defaults.when ?? "", placeholder: "예: 강의 첫 판매 후 · G-2026-01.2", desc: `날짜를 쓰지 않아요. 조건을 쓸 수 없으면 놓아주기를 권해요. 그래도 넣으려면 「${WHEN_UNDECIDED}」.` },
			{ key: "section", label: "섹션", type: "select", value: defaults.section ?? "보류", options: SECTION_OPTIONS },
			{ key: "from", label: "출처 (from::)", type: "text", value: defaults.from?.join(", ") ?? `대화 ${today}`, desc: "세션 링크, 다른 파일 링크, 또는 대화 YYYY-MM-DD. 쉼표로 구분" },
			{ key: "context", label: "맥락 (선택)", type: "text", value: defaults.context ?? "", placeholder: "왜 넣었는지 한 줄" },
		],
		validate: (x) => {
			const out: string[] = [];
			if (!x.text) out.push("내용을 적어 주세요.");
			if (!x.when) out.push(`다시 꺼낼 조건을 적어 주세요. 조건이 없으면 놓아주기를 권해요 (그래도 넣으려면 「${WHEN_UNDECIDED}」).`);
			if (/^\d{4}-\d{2}(-\d{2})?$/.test(x.when)) out.push("when::에 날짜를 쓰지 않아요. Drawer는 달력이 아니에요.");
			return out;
		},
	});
	if (!v) return null;
	return {
		text: v.text,
		when: v.when,
		section: v.section as DrawerSection,
		from: v.from
			.split(/,(?![^[]*\]\])/)
			.map((s) => s.trim())
			.filter(Boolean),
		context: v.context || undefined,
		tags: defaults.tags,
		test: defaults.test,
	};
}
