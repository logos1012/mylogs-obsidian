import { type App, Modal, Setting } from "obsidian";
import { toIsoDate } from "../parser.ts";
import { initialStatus, isKind, kindFieldProblems, nameProblem, OWNERS, SKILL_KINDS, type Skill, type SkillEdit, type SkillInput, type SkillKind, statusForKind, type Taken, TRIGGERS, validateSkillInput } from "./model.ts";

const TRIGGER_HINT: Record<string, string> = { cron: "정해진 시각에 (Asia/Seoul)", 수동: "「지금 실행」을 누를 때만", 이벤트: "다른 일이 일어났을 때 (절차에 적음)" };

abstract class ToolboxModal<T> extends Modal {
	private done = false;
	constructor(
		app: App,
		private resolve: (v: T | null) => void,
	) {
		super(app);
	}
	protected finish(v: T | null): void {
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

// ───────────────────────── 새 스킬 / 수정 ─────────────────────────

export interface SkillFormOptions {
	/** Existing skill → 수정 (name rename allowed; id fixed). Absent → 새 스킬. */
	skill?: Skill;
	/** The id the new skill gets (「4-1」 1). */
	id?: string;
	/** Names / ids / slugs already used (for 수정: without this skill's own). */
	taken: Taken;
}

const KIND_HINT: Record<SkillKind, string> = {
	작업: "정해진 일 하나, 출력 한 곳. cron 또는 「지금 실행」으로 돌아요. 멈춤 → 시험 → 사용.",
	도구: "사용자가 말로 부르는 능력. 대화 중 「부르는 말」이 오면 Hermes가 써요. 멈춤 / 사용.",
	운영: "일하는 방식의 계약 (어느 AGENTS를 먼저 읽고, 무엇을 묻고, 언제 완료인지). 항상 적용돼요.",
};
const STUB_NOTE = "description·slug를 바꾸면 Hermes 스텁을 다시 맞춰야 합니다 (AGENTS 4-7).";

/**
 * 종류 first, then the kind's fields (「4-1」 받을 정보): 작업 = 이름·slug·description·하는 일·트리거·
 * schedule·출력·알림; 도구 = 이름·slug·description·부르는 말·담당; 운영 = 이름·slug·description·범위.
 * Resolves null when cancelled.
 */
export function askSkillForm(app: App, o: SkillFormOptions): Promise<SkillInput | null> {
	return new Promise((resolve) => new SkillFormModal(app, o, resolve).open());
}

class SkillFormModal extends ToolboxModal<SkillInput> {
	private v: Required<SkillInput>;

	constructor(
		app: App,
		private o: SkillFormOptions,
		resolve: (v: SkillInput | null) => void,
	) {
		super(app, resolve);
		const s = o.skill;
		this.v = s
			? { kind: s.kind, name: s.name, slug: s.slug, description: s.description, purpose: s.purpose, phrase: s.phrase, scope: s.scope, owner: s.owner || "hermes", trigger: s.trigger || "cron", schedule: s.schedule, output: s.output, notify: s.notify }
			: { kind: "작업", name: "", slug: "", description: "", purpose: "", phrase: "", scope: "", owner: "hermes", trigger: "cron", schedule: "", output: "", notify: "" };
	}

	onOpen(): void {
		this.modalEl.addClass("mylogs-modal", "mylogs-toolbox-modal");
		this.setTitle(this.o.skill ? `「${this.o.skill.name}」 수정` : "새 스킬");
		this.draw();
	}

	/** (Re)build the form for the current kind; typed values are kept in `this.v`. */
	private draw(): void {
		const el = this.contentEl;
		el.empty();
		const edit = !!this.o.skill;
		const kind = this.v.kind;
		el.createEl("p", {
			cls: "mylogs-modal-desc",
			text: edit
				? "frontmatter와 등록부 행을 같이 고쳐요. 이름을 바꾸면 파일 이름도 바뀌어요. id는 그대로예요. 절차 같은 본문은 파일에서 고쳐 주세요."
				: `_Templates/스킬.md로 11 Toolbox에 파일을 만들고 등록부 「${kind}」 표에 행을 올려요. id는 ${this.o.id ?? "T-NN"}, 처음엔 ${initialStatus(kind)}이에요.${kind === "운영" ? "" : " 본문은 파일을 열어 채워 주세요."}`,
		});

		let first: HTMLElement | null = null;
		const errors = createEl("ul", { cls: "mylogs-form-errors" });
		const text = (name: string, key: "name" | "slug" | "description" | "purpose" | "phrase" | "scope" | "schedule" | "output" | "notify", o: { desc?: string; placeholder?: string } = {}) => {
			const s = new Setting(el).setName(name);
			if (o.desc) s.setDesc(o.desc);
			s.addText((t) => {
				t.setValue(this.v[key]).onChange((x) => (this.v[key] = x));
				if (o.placeholder) t.setPlaceholder(o.placeholder);
				t.inputEl.addClass("mylogs-form-wide");
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter" && !e.isComposing) {
						e.preventDefault();
						this.submit(errors);
					}
				});
				first ??= t.inputEl;
			});
			return s;
		};

		new Setting(el)
			.setName("종류")
			.setDesc(KIND_HINT[kind])
			.addDropdown((d) => {
				for (const k of SKILL_KINDS) d.addOption(k, k);
				d.setValue(kind).onChange((x) => {
					if (!isKind(x)) return;
					this.v.kind = x;
					this.draw();
				});
				if (!edit) first = d.selectEl;
			});
		if (edit && kind !== this.o.skill!.kind) el.createEl("p", { cls: "mylogs-form-errors", text: `종류를 ${this.o.skill!.kind} → ${kind}로 바꾸면 등록부 행이 「${kind}」 표로 옮겨져요${statusForKind(kind, this.o.skill!.status) !== this.o.skill!.status ? ` (상태 ${this.o.skill!.status} → ${statusForKind(kind, this.o.skill!.status)})` : ""}. 본문 섹션은 파일에서 맞춰 주세요 (AGENTS 「3」).` });

		text("이름", "name", { desc: "파일 이름과 같아요.", placeholder: kind === "작업" ? "예: 볼트 링크 점검" : kind === "도구" ? "예: 데일리로그 기록" : "예: MyLogs 운영" });
		text("slug", "slug", { desc: "Hermes 스텁 폴더 이름. 영문 소문자·숫자·하이픈. 한 번 정하면 바꾸지 않아요.", placeholder: kind === "작업" ? "vault-link-check" : kind === "도구" ? "daily-log" : "mylogs-ops" });
		text("description", "description", { desc: kind === "도구" ? "언제 이 스킬을 쓰는지 한두 문장. 부르는 말이 뒤에 붙어요. Hermes 스텁에 그대로 들어가요." : "언제 이 스킬을 쓰는지 한두 문장. Hermes 스텁에 그대로 들어가요.", placeholder: "예: 매주 월요일 볼트의 깨진 위키링크를 찾아 목록으로 만든다." });
		if (edit) el.createEl("p", { cls: "mylogs-modal-desc", text: STUB_NOTE });

		if (kind === "작업") {
			if (!edit) text("하는 일 한 줄", "purpose", { desc: "「목적」의 첫 줄이자 등록부의 「하는 일」.", placeholder: "예: 매주 깨진 위키링크를 찾아 목록으로" });
			let scheduleRow: Setting | null = null;
			const showSchedule = () => scheduleRow?.settingEl.toggle(this.v.trigger === "cron");
			new Setting(el)
				.setName("트리거")
				.setDesc(TRIGGER_HINT[this.v.trigger] ?? "")
				.addDropdown((d) => {
					for (const t of TRIGGERS) d.addOption(t, t);
					d.setValue((TRIGGERS as readonly string[]).includes(this.v.trigger) ? this.v.trigger : "cron").onChange((x) => {
						this.v.trigger = x;
						d.selectEl.closest(".setting-item")?.querySelector(".setting-item-description")?.setText(TRIGGER_HINT[x] ?? "");
						showSchedule();
					});
				});
			scheduleRow = text("schedule", "schedule", { desc: "cron 다섯 칸, Asia/Seoul. 예: 0 4 * * * (매일 04:00)", placeholder: "0 4 * * *" });
			showSchedule();
			text("출력", "output", { desc: "볼트 기준 상대 경로. {YYYY-MM-DD} 같은 자리표시 가능. 결과물은 Toolbox에 두지 않아요.", placeholder: "예: 07 Shelf/99 작업실/받은 자료/{YYYY-MM-DD}_링크 점검.md" });
			text("알림", "notify", { desc: "예: 04 Daily Pad `## 자료`에 링크 한 줄 / Slack", placeholder: "04 Daily Pad `## 자료`에 링크 한 줄" });
		} else if (kind === "도구") {
			text("부르는 말", "phrase", { desc: "사용자가 이렇게 말하면 써요. 「트리거」 첫 줄, description, 등록부 「부르는 말」에 들어가요.", placeholder: "예: 데일리로그 기록해 줘" });
			new Setting(el)
				.setName("담당")
				.setDesc("이 도구를 쓰는 AI")
				.addDropdown((d) => {
					for (const x of OWNERS) d.addOption(x, x);
					if (this.v.owner && !(OWNERS as readonly string[]).includes(this.v.owner)) d.addOption(this.v.owner, this.v.owner);
					d.setValue(this.v.owner || "hermes").onChange((x) => (this.v.owner = x));
				});
		} else {
			text("범위", "scope", { desc: "이 계약이 적용되는 작업의 범위. 「범위」 첫 줄과 등록부 「범위」에 들어가요.", placeholder: "예: MyLogs 볼트 전체" });
		}

		el.appendChild(errors);
		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText(edit ? "저장" : "만들기")
					.setCta()
					.onClick(() => this.submit(errors)),
			);
		window.setTimeout(() => first?.focus(), 0);
	}

	private submit(errors: HTMLElement): void {
		const t = (x: string) => x.trim();
		const v: SkillInput = { ...this.v, name: t(this.v.name), slug: t(this.v.slug), description: t(this.v.description), purpose: t(this.v.purpose), phrase: t(this.v.phrase), scope: t(this.v.scope), schedule: t(this.v.schedule), output: t(this.v.output), notify: t(this.v.notify) };
		let problems: string[];
		const sk = this.o.skill;
		if (sk) {
			problems = [];
			const np = nameProblem(v.name);
			if (np) problems.push(np);
			else if (v.name !== sk.name && this.o.taken.names.includes(v.name)) problems.push(`이미 있는 스킬 이름이에요: ${v.name}`);
			// An old file may have no slug yet: required only once it is written.
			problems.push(...kindFieldProblems(v, { requirePurpose: false, slugs: this.o.taken.slugs ?? [], requireSlug: !!sk.slug }));
		} else problems = validateSkillInput(v, this.o.id ?? "", this.o.taken);
		errors.empty();
		if (problems.length) {
			for (const p of problems) errors.createEl("li", { text: p });
			return;
		}
		this.finish(v);
	}
}

export function toEdit(i: SkillInput): SkillEdit {
	const { purpose: _p, ...rest } = i;
	return rest;
}

// ───────────────────────── 확인 (종류 바꾸기 · 운영 만들기) ─────────────────────────

export function confirmAsk(app: App, o: { title: string; text: string[]; ok: string; warning?: boolean }): Promise<boolean | null> {
	return new Promise((resolve) => new ConfirmModal(app, o, resolve).open());
}

class ConfirmModal extends ToolboxModal<boolean> {
	constructor(
		app: App,
		private o: { title: string; text: string[]; ok: string; warning?: boolean },
		resolve: (v: boolean | null) => void,
	) {
		super(app, resolve);
	}
	onOpen(): void {
		this.modalEl.addClass("mylogs-modal", "mylogs-toolbox-modal");
		this.setTitle(this.o.title);
		for (const p of this.o.text) this.contentEl.createEl("p", { cls: "mylogs-modal-desc", text: p });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) => {
				b.setButtonText(this.o.ok).onClick(() => this.finish(true));
				if (this.o.warning) b.setWarning();
				else b.setCta();
			});
	}
}

// ───────────────────────── 사용으로 바꾸기 확인 (「6」) ─────────────────────────

/**
 * AGENTS 「6」: 사용자 확인 없이 `시험`·`사용`으로 바꾸지 않는다 — show what will run, then confirm.
 * 「4-1」 2-1: 멈춤 → 시험 → 사용; 사용 without a 시험 run is flagged (the user decides).
 */
export function confirmEnable(app: App, s: Skill, to: "시험" | "사용"): Promise<boolean | null> {
	return new Promise((resolve) => new EnableModal(app, s, to, resolve).open());
}

class EnableModal extends ToolboxModal<boolean> {
	constructor(
		app: App,
		private s: Skill,
		private to: "시험" | "사용",
		resolve: (v: boolean | null) => void,
	) {
		super(app, resolve);
	}
	onOpen(): void {
		const el = this.contentEl;
		this.modalEl.addClass("mylogs-modal", "mylogs-toolbox-modal");
		this.setTitle(`「${this.s.name}」 ${this.to}으로 바꾸기`);
		el.createEl("p", {
			cls: "mylogs-modal-desc",
			text:
				this.s.kind === "도구"
					? "이 도구가 켜져요. Hermes가 등록부를 읽고 스텁을 맞추면 대화에서 아래 말로 불러 쓸 수 있어요 (AGENTS 「4-7」)."
					: this.to === "시험"
						? "cron에는 걸지 않고 「지금 실행」(실행 요청)으로만 돌아요. 결과물을 보고 괜찮으면 사용으로 바꿔 주세요."
						: "이 스킬이 켜져요. Hermes가 등록부를 읽고 cron을 맞추면 아래대로 돌아요.",
		});
		if (this.s.kind === "도구") {
			const dl = el.createEl("dl", { cls: "mylogs-toolbox-facts" });
			for (const [k, v] of [
				["id", this.s.id],
				["slug", this.s.slug],
				["부르는 말", this.s.phrase],
				["description", this.s.description],
				["담당", this.s.owner],
			]) {
				dl.createEl("dt", { text: k });
				dl.createEl("dd", { text: v || "—" });
			}
			if (!this.s.slug) el.createEl("p", { cls: "mylogs-form-errors", text: "slug가 비어 있어요. 스텁을 만들 수 없어요. 먼저 수정에서 적어 주세요." });
			new Setting(el)
				.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
				.addButton((b) => b.setButtonText("사용으로 바꾸기").setCta().onClick(() => this.finish(true)));
			return;
		}
		if (this.to === "사용" && !this.s.lastRun) el.createEl("p", { cls: "mylogs-form-errors", text: "아직 한 번도 돌지 않았어요 (last_run 없음). 순서는 멈춤 → 시험 → 사용이에요. 시험으로 한 번 돌려 본 뒤 사용으로 가는 것이 규칙이에요 (AGENTS 「4-1」 2-1)." });
		const dl = el.createEl("dl", { cls: "mylogs-toolbox-facts" });
		const fact = (k: string, v: string) => {
			dl.createEl("dt", { text: k });
			dl.createEl("dd", { text: v || "—" });
		};
		fact("id", this.s.id);
		fact("트리거", this.s.trigger);
		if (this.s.trigger === "cron") fact("schedule", `${this.s.schedule || "(비어 있음)"} · Asia/Seoul`);
		fact("출력", this.s.output);
		fact("알림", this.s.notify);
		fact("담당", this.s.owner);
		if (this.s.trigger === "cron" && !this.s.schedule) el.createEl("p", { cls: "mylogs-form-errors", text: "schedule이 비어 있어요. 켜도 cron이 등록되지 않아요. 먼저 수정에서 적어 주세요." });
		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText(`${this.to}으로 바꾸기`)
					.setCta()
					.onClick(() => this.finish(true)),
			);
	}
}

// ───────────────────────── 폐기 (「4-5」) ─────────────────────────

export interface DiscardAnswer {
	date: string;
	reason: string;
}

export function askDiscard(app: App, s: Skill): Promise<DiscardAnswer | null> {
	return new Promise((resolve) => new DiscardModal(app, s, resolve).open());
}

class DiscardModal extends ToolboxModal<DiscardAnswer> {
	constructor(
		app: App,
		private s: Skill,
		resolve: (v: DiscardAnswer | null) => void,
	) {
		super(app, resolve);
	}
	onOpen(): void {
		const el = this.contentEl;
		this.modalEl.addClass("mylogs-modal", "mylogs-toolbox-modal");
		this.setTitle(`「${this.s.name}」 폐기`);
		el.createEl("p", { cls: "mylogs-modal-desc", text: "status를 폐기로 바꾸고 등록부 행을 「폐기」 표로 옮겨요. Hermes는 이 스킬의 cron을 지워요. 변경 기록에 한 줄 남겨요." });
		el.createEl("p", { cls: "mylogs-modal-desc", text: "파일은 11 Toolbox에 그대로 둬요 (Archive Box/Closed 형식이 아직 정해지지 않아서). 잘못 만든 스킬이나 테스트 데이터는 파일을 직접 지워 주세요." });
		const v: DiscardAnswer = { date: toIsoDate(new Date()), reason: "" };
		new Setting(el).setName("폐기일").controlEl.createEl("input", { attr: { type: "date" } }, (input) => {
			input.value = v.date;
			input.addEventListener("change", () => (v.date = input.value));
		});
		new Setting(el).setName("이유").addText((t) => {
			t.setPlaceholder("예: Hermes 자체 스킬로 대체").onChange((x) => (v.reason = x));
			t.inputEl.addClass("mylogs-form-wide");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					ok();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		const err = el.createDiv({ cls: "mylogs-form-errors" });
		const ok = (): void => {
			if (!v.reason.trim()) return void err.setText("이유를 한 줄 적어 주세요.");
			if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return void err.setText("폐기일을 골라 주세요.");
			this.finish({ date: v.date, reason: v.reason.trim() });
		};
		new Setting(el)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.finish(null)))
			.addButton((b) =>
				b
					.setButtonText("폐기")
					.setWarning()
					.onClick(ok),
			);
	}
}
