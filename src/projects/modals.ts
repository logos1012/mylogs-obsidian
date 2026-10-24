import { type App, Modal, Setting } from "obsidian";
import { toIsoDate } from "../parser.ts";
import { KINDS, type NewProjectInput, type Scope, SCOPES, suggestId, validateInput } from "./model.ts";

/** 「3-2」: 이름, 한 문장 설명, 개인/회사, area, 유형 (+ id, 별칭, 한 가지 행동). Resolves null when cancelled. */
export function askNewProject(
	app: App,
	opts: { areas: string[]; taken: { ids: string[]; names: string[] }; scope?: Scope },
): Promise<NewProjectInput | null> {
	return new Promise((resolve) => new NewProjectModal(app, opts, resolve).open());
}

class NewProjectModal extends Modal {
	private done = false;
	private v: NewProjectInput;
	/** The id follows the name until the user edits it. */
	private idTouched = false;

	constructor(
		app: App,
		private opts: { areas: string[]; taken: { ids: string[]; names: string[] }; scope?: Scope },
		private resolve: (v: NewProjectInput | null) => void,
	) {
		super(app);
		this.v = { name: "", summary: "", scope: opts.scope ?? "개인", area: "", kind: "", id: "P-", aliases: "", action: "" };
	}

	onOpen(): void {
		const el = this.contentEl;
		this.modalEl.addClass("mylogs-projects-modal");
		this.setTitle("새 프로젝트");
		el.createEl("p", {
			cls: "mylogs-projects-modal-desc",
			text: "템플릿으로 폴더를 만들고 등록부에 올려요. 보이는 것은 01 초안, 02 산출물, 허브, AGENTS.md뿐이고 나머지는 99 작업실 안에 둬요.",
		});

		let idInput: HTMLInputElement | null = null;
		new Setting(el).setName("이름").addText((t) => {
			t.setPlaceholder("예: 혼팀 브랜드").onChange((x) => {
				this.v.name = x;
				if (!this.idTouched && idInput) {
					this.v.id = suggestId(x);
					idInput.value = this.v.id;
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(el).setName("한 문장 설명").addText((t) => t.setPlaceholder("무엇을, 왜").onChange((x) => (this.v.summary = x)));
		new Setting(el).setName("개인 / 회사").addDropdown((d) => {
			for (const s of SCOPES) d.addOption(s, s);
			d.setValue(this.v.scope).onChange((x) => (this.v.scope = x as Scope));
		});
		new Setting(el)
			.setName("area")
			.setDesc("Pinboard와 같은 분류")
			.addText((t) => {
				const listId = `mylogs-projects-areas-${Date.now()}`;
				const dl = el.createEl("datalist", { attr: { id: listId } });
				for (const a of this.opts.areas) dl.createEl("option", { attr: { value: a } });
				t.inputEl.setAttr("list", listId);
				t.setPlaceholder(this.opts.areas.slice(0, 3).join(", ") || "예: 사업").onChange((x) => (this.v.area = x));
			});
		new Setting(el).setName("유형").addDropdown((d) => {
			d.addOption("", "고르기");
			for (const k of KINDS) d.addOption(k, k);
			d.onChange((x) => (this.v.kind = x));
		});
		new Setting(el)
			.setName("id")
			.setDesc("P- 뒤에 영문 소문자·숫자·하이픈. 바꾸지 않는 값이에요.")
			.addText((t) => {
				idInput = t.inputEl;
				t.setValue(this.v.id).onChange((x) => {
					this.idTouched = true;
					this.v.id = x;
				});
			});
		new Setting(el)
			.setName("별칭")
			.setDesc("선택. 쉼표로 구분")
			.addText((t) => t.onChange((x) => (this.v.aliases = x)));
		new Setting(el)
			.setName("지금 가장 효과적인 한 가지 행동")
			.setDesc("선택. 비우면 「미확인」으로 둬요")
			.addText((t) => t.onChange((x) => (this.v.action = x)));
		// TODO(계획 §6 「후보」): Drawer 「프로젝트 후보」를 후보 열에 보여 주고 여기로 미리 채우기 (Drawer 형식 미정).

		const errors = el.createEl("ul", { cls: "mylogs-projects-modal-errors" });
		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("만들기")
					.setCta()
					.onClick(() => {
						const problems = validateInput(this.v, this.opts.taken);
						errors.empty();
						if (problems.length) {
							for (const p of problems) errors.createEl("li", { text: p });
							return;
						}
						this.finish({ ...this.v, name: this.v.name.trim(), id: this.v.id.trim(), area: this.v.area.trim(), summary: this.v.summary.trim() });
					}),
			);
	}

	private finish(v: NewProjectInput | null): void {
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

export interface CompleteAnswer {
	result: string;
	started: string;
	completed: string;
}

/**
 * 「3-5」 완료: the 한 줄 결과 (required), plus `started` (when the hub has none) and `completed`.
 * `ending` = the "종료" choice for a stale project (same procedure, different wording).
 */
export function askComplete(app: App, o: { title: string; started: string; ending?: boolean }): Promise<CompleteAnswer | null> {
	return new Promise((resolve) => new CompleteModal(app, o, resolve).open());
}

class CompleteModal extends Modal {
	private done = false;

	constructor(
		app: App,
		private o: { title: string; started: string; ending?: boolean },
		private resolve: (v: CompleteAnswer | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const el = this.contentEl;
		this.modalEl.addClass("mylogs-projects-modal");
		this.setTitle(this.o.ending ? `「${this.o.title}」 종료하기` : `「${this.o.title}」 완료하기`);
		el.createEl("p", {
			cls: "mylogs-projects-modal-desc",
			text: "허브에 완료일과 한 줄 결과를 적고, 폴더째 Archive Box로 옮기고, 등록부의 행을 「완료」 표로 옮겨요.",
		});
		const today = toIsoDate(new Date());
		const v: CompleteAnswer = { result: "", started: this.o.started || today, completed: today };
		new Setting(el).setName(this.o.ending ? "끝내는 이유 / 결과 한 줄" : "한 줄 결과").addText((t) => {
			t.setPlaceholder(this.o.ending ? "예: 우선순위가 바뀌어 여기서 마무리" : "예: 강의 첫 판매 12건").onChange((x) => (v.result = x));
			t.inputEl.addClass("mylogs-projects-modal-wide");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					ok();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		const date = (name: string, key: "started" | "completed", desc?: string) => {
			const s = new Setting(el).setName(name);
			if (desc) s.setDesc(desc);
			s.controlEl.createEl("input", { attr: { type: "date" } }, (input) => {
				input.value = v[key];
				input.addEventListener("change", () => (v[key] = input.value));
			});
		};
		date("시작일", "started", this.o.started ? undefined : "허브에 시작일이 없어요. 타임라인 막대의 시작이에요.");
		date("완료일", "completed");
		const err = el.createDiv({ cls: "mylogs-projects-modal-errors" });
		const ok = (): void => {
			const r = v.result.trim();
			if (!r) return void err.setText("한 줄 결과를 적어 주세요.");
			if (!/^\d{4}-\d{2}-\d{2}$/.test(v.completed) || !/^\d{4}-\d{2}-\d{2}$/.test(v.started)) return void err.setText("날짜를 골라 주세요.");
			if (v.started > v.completed) return void err.setText("시작일이 완료일보다 늦어요.");
			this.finish({ ...v, result: this.o.ending ? `종료: ${r}` : r });
		};
		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText(this.o.ending ? "종료하고 보관" : "완료하고 보관")
					.setCta()
					.onClick(ok),
			);
	}

	private finish(v: CompleteAnswer | null): void {
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
