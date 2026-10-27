/**
 * Toolbox view (`mylogs-toolbox`): the registry as three sections, top to bottom — 운영 (이름 · slug ·
 * 범위 · 상태 · 마지막 검토), 도구 (이름 · slug · 부르는 말 · 담당 · 상태 · 마지막 검토), 작업 (이름 ·
 * 하는 일 · 트리거/schedule · 출력 · 상태 · 마지막 실행(결과) · 마지막 검토) — read from the skill
 * files (`type: skill`, `kind`) with the registry rows beside them (file = canonical; a file without
 * a row says 등록부에 없음, a row in another kind's table says so, a row without a file is struck
 * through).
 *
 * Writes (status toggle, 폐기, 지금 실행, 새 스킬, 수정) go through `actions.ts`; running a skill
 * is Hermes' job (the plugin only queues a 실행 요청 line).
 */

import { debounce, ItemView, Keymap, Menu, normalizePath, Notice, Platform, setIcon, type TAbstractFile, TFile, type WorkspaceLeaf } from "obsidian";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import type MyLogsPlugin from "../main.ts";
import { toIsoDate } from "../parser.ts";
import { createSkill, discardSkill, editSkill, fixRowTable, loadToolbox, nextId, registerSkill, registryPath, requestRun, setStatus, takenIdsAndNames, toolboxRoot, type ToolboxData } from "./actions.ts";
import { askDiscard, askSkillForm, confirmAsk, confirmEnable, toEdit } from "./modals.ts";
import { renderToolboxSectionMobile, type ToolboxMobileHost } from "./mobile.ts";
import { canRequestRun, daysSinceRun, type Entry, entryKind, failure, inputKind, isReviewStale, isStaleSkill, KIND_ORDER, liveStatuses, MAX_SKILLS, needsConfirm, pendingRequests, recentDoneRequests, type RunRequest, rowName, type Skill, type SkillKind, type SkillRow, STALE_DAYS, statusForKind, tooMany, truncate, validStatus } from "./model.ts";

export const VIEW_TYPE_TOOLBOX = "mylogs-toolbox";

const STATUS_HINT: Record<SkillKind, Record<string, string>> = {
	작업: { 사용: "cron으로 돌아요", 시험: "cron 없이 「지금 실행」으로만", 멈춤: "파일은 그대로, cron은 없음", 폐기: "등록부 「폐기」 표" },
	도구: { 사용: "Hermes 스텁이 있어 대화에서 불러요", 멈춤: "파일은 그대로, 스텁은 없음", 폐기: "등록부 「폐기」 표" },
	운영: { 사용: "항상 적용 — 범위의 작업을 시작할 때마다 읽어요", 폐기: "등록부 「폐기」 표" },
};

const KIND_LEAD: Record<SkillKind, string> = {
	운영: "일하는 방식의 계약. 해당 범위의 작업을 시작할 때마다 먼저 읽어요.",
	도구: "사용자가 말로 부를 때 쓰는 스킬. cron 없음.",
	작업: "정해진 때 도는 일 하나. cron 또는 「지금 실행」.",
};

type Col = "name" | "slug" | "scope" | "phrase" | "owner" | "purpose" | "trigger" | "output" | "status" | "run" | "reviewed" | "actions";
const COL_LABEL: Record<Col, string> = { name: "이름", slug: "slug", scope: "범위", phrase: "부르는 말", owner: "담당", purpose: "하는 일", trigger: "트리거 / schedule", output: "출력", status: "상태", run: "마지막 실행 · 결과", reviewed: "마지막 검토", actions: "" };
/** Columns per kind, as in the registry tables. */
const KIND_COLS: Record<SkillKind, Col[]> = {
	운영: ["name", "slug", "scope", "status", "reviewed", "actions"],
	도구: ["name", "slug", "phrase", "owner", "status", "reviewed", "actions"],
	작업: ["name", "purpose", "trigger", "output", "status", "run", "reviewed", "actions"],
};

function todayIso(): string {
	return toIsoDate(new Date());
}

/** `2026-10-26T04:30` → `10.26 04:30`; a bare date → `10.26`. */
function shortStamp(s: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(s);
	if (!m) return s;
	return `${m[2]}.${m[3]}${m[4] ? ` ${m[4]}` : ""}`;
}

export class ToolboxView extends ItemView {
	readonly plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private data: ToolboxData | null = null;
	private loadSeq = 0;
	private busy = false;
	private scheduleRefresh = debounce(() => void this.refresh(), 300, true);

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_TOOLBOX;
	}
	getDisplayText(): string {
		return "Toolbox";
	}
	getIcon(): string {
		return "wrench";
	}

	private watched(path: string): boolean {
		const root = toolboxRoot(this.plugin);
		return path === root || path.startsWith(`${root}/`);
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-toolbox-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-toolbox" });
		mountAppNav(this);
		this.registerEvent(
			this.app.metadataCache.on("changed", (f) => {
				if (this.watched(f.path)) this.scheduleRefresh();
			}),
		);
		const onFile = (f: TAbstractFile, old?: string) => {
			if (this.watched(f.path) || (old && this.watched(old))) this.scheduleRefresh();
		};
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => onFile(f, old)));
		this.registerEvent(this.app.vault.on("create", (f) => onFile(f)));
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.rootEl?.empty();
	}

	/** Re-read the files and re-render (skipped while a write is in progress). */
	async refresh(): Promise<void> {
		if (!this.rootEl || this.busy) return;
		const seq = ++this.loadSeq;
		const data = await loadToolbox(this.plugin);
		if (seq !== this.loadSeq) return;
		this.data = data;
		this.render();
	}

	private async run(fn: () => Promise<unknown>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.rootEl.addClass("is-busy");
		try {
			await fn();
		} finally {
			this.busy = false;
			this.rootEl.removeClass("is-busy");
			await this.refresh();
		}
	}

	// ── actions ──

	async newSkill(): Promise<void> {
		const d = this.data ?? (await loadToolbox(this.plugin));
		if (!d.hasRegistry) {
			new Notice(`등록부(${registryPath(this.plugin)})가 없어요. 먼저 만들어 주세요 (11 Toolbox/AGENTS.md 「2」).`);
			return;
		}
		const id = await nextId(this.plugin, d);
		const input = await askSkillForm(this.app, { id, taken: takenIdsAndNames(d) });
		if (!input) return;
		if (inputKind(input) === "운영") {
			const ok = await confirmAsk(this.app, {
				title: `운영 스킬 「${input.name}」 만들기`,
				text: ["운영 스킬은 바로 적용됩니다. 상태 사용으로 만들어져, 범위에 드는 작업을 시작할 때마다 AI가 이 파일을 먼저 읽어요.", "AGENTS 「4-1」: 운영은 사용자가 초안을 확인한 뒤에만 만들어요."],
				ok: "만들기",
			});
			if (!ok) return;
		}
		await this.run(async () => {
			const path = await createSkill(this.plugin, input, id);
			const f = path ? this.app.vault.getAbstractFileByPath(normalizePath(path)) : null;
			if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
		});
	}

	/** 작업 멈춤 / 시험 / 사용, 도구 멈춤 / 사용 (「4-1」 2-1). 시험·사용 ask first (「6」: the click is the confirmation, but show what turns on). */
	private async setStatus(s: Skill, to: string): Promise<void> {
		if (s.status === "폐기") {
			new Notice("폐기한 스킬은 여기서 되살리지 않아요. 파일의 status를 직접 고쳐 주세요.");
			return;
		}
		if (to === s.status || !liveStatuses(s.kind).includes(to)) return;
		if (needsConfirm(to)) {
			const ok = await confirmEnable(this.app, s, to);
			if (!ok) return;
		}
		await this.run(() => setStatus(this.plugin, s, to));
	}

	private async discard(s: Skill): Promise<void> {
		if (s.status === "폐기") return;
		const ans = await askDiscard(this.app, s);
		if (ans) await this.run(() => discardSkill(this.plugin, s, ans));
	}

	private async request(s: Skill): Promise<void> {
		await this.run(() => requestRun(this.plugin, s));
	}

	private async edit(s: Skill): Promise<void> {
		const d = this.data ?? (await loadToolbox(this.plugin));
		const input = await askSkillForm(this.app, { skill: s, taken: takenIdsAndNames({ skills: d.skills.filter((x) => x.path !== s.path), rows: d.rows.filter((r) => r.id !== s.id) }) });
		if (!input) return;
		const to = inputKind(input);
		if (to !== s.kind) {
			const st = statusForKind(to, s.status);
			const ok = await confirmAsk(this.app, {
				title: `「${s.name}」 종류 바꾸기`,
				text: [
					`종류를 ${s.kind} → ${to}로 바꿔요. 등록부 행이 「${s.kind}」 표에서 「${to}」 표로 옮겨져요.${st !== s.status ? ` 상태는 ${s.status} → ${st}.` : ""}`,
					"본문 섹션(AGENTS 「3」)은 바꾸지 않아요. 파일을 열어 맞춰 주세요. Hermes 스텁·cron도 다시 맞춰야 해요 (AGENTS 4-3, 4-7).",
				],
				ok: "바꾸기",
			});
			if (!ok) return;
		}
		await this.run(() => editSkill(this.plugin, s, toEdit(input)));
	}

	private async addRow(s: Skill): Promise<void> {
		await this.run(() => registerSkill(this.plugin, s));
	}

	private async fixTable(s: Skill, from: string): Promise<void> {
		await this.run(() => fixRowTable(this.plugin, s, from));
	}

	private openFile(path: string, e?: MouseEvent): void {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (f instanceof TFile) void this.app.workspace.getLeaf(e ? Keymap.isModEvent(e) : false).openFile(f);
		else new Notice(`파일이 없어요: ${path}`);
	}

	// ── rendering ──

	private btn(parent: HTMLElement, text: string, onClick: () => void, o: { icon?: string; cls?: string; label?: string; disabled?: string } = {}): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `tb-btn${o.cls ? ` ${o.cls}` : ""}`, attr: { type: "button" } });
		if (o.label) b.setAttr("aria-label", o.label);
		if (o.icon) setIcon(b.createSpan({ cls: "tb-btn-icon" }), o.icon);
		if (text) b.appendText(text);
		if (o.disabled) {
			b.disabled = true;
			b.setAttr("title", o.disabled);
		} else b.addEventListener("click", onClick);
		return b;
	}

	private render(): void {
		const root = this.rootEl;
		if (!root) return;
		root.empty();
		const d = this.data;
		if (!d) return;
		const today = todayIso();

		const top = root.createDiv({ cls: "tb-top" });
		const left = top.createDiv();
		left.createDiv({ cls: "tb-eyebrow", text: "Toolbox · 스킬 등록부" });
		left.createEl("h1", { text: "Toolbox" });
		const controls = top.createDiv({ cls: "tb-controls" });
		this.btn(controls, "등록부 열기", () => this.openFile(registryPath(this.plugin)), { icon: "file-text" });
		this.btn(controls, "새 스킬", () => void this.newSkill(), { icon: "plus", cls: "tb-btn-primary" });

		const live = d.skills.filter((s) => s.status !== "폐기").length;
		if (tooMany(live)) this.notice(root, "alert-triangle", `스킬이 ${live}개예요 (${MAX_SKILLS}개 넘음). 안 쓰는 것은 멈추거나 폐기해 주세요 (AGENTS 「2」).`);
		if (!d.hasRegistry) this.notice(root, "alert-triangle", `등록부가 없어요: ${registryPath(this.plugin)}. 등록부에 없는 스킬은 돌지 않아요.`);
		const stale = d.skills.filter((s) => isStaleSkill(s, today)).length;
		if (stale) this.notice(root, "hourglass", `${STALE_DAYS}일 넘게 돌지 않았거나 한 번도 돌지 않은 작업이 ${stale}개 있어요. 아직도 쓰나요?`);
		const unreviewed = d.skills.filter((s) => isReviewStale(s, today)).length;
		if (unreviewed) this.notice(root, "eye", `마지막 검토가 ${STALE_DAYS}일 넘은 스킬이 ${unreviewed}개 있어요 (AGENTS 「4-9」).`);

		if (!d.entries.length) return this.renderEmpty(root);
		for (const kind of KIND_ORDER) this.renderSection(root, kind, d, today);

		const foot = root.createDiv({ cls: "tb-foot" });
		foot.appendText(`원본: ${toolboxRoot(this.plugin)}/<이름>.md · 등록부: ${registryPath(this.plugin)} · 스킬 ${d.skills.length}개`);
		const pending = d.requests.filter((r) => !r.done).length;
		if (pending) foot.appendText(` · 실행 요청 대기 ${pending}건`);
	}

	private notice(root: HTMLElement, icon: string, text: string): void {
		const bar = root.createDiv({ cls: "tb-notice" });
		setIcon(bar.createSpan({ cls: "tb-notice-icon" }), icon);
		bar.appendText(text);
	}

	private renderEmpty(root: HTMLElement): void {
		const e = root.createDiv({ cls: "tb-empty" });
		e.createDiv({ cls: "tb-empty-title", text: "아직 스킬이 없어요" });
		e.createEl("p", { text: "스킬은 세 종류예요: 운영(일하는 방식의 계약), 도구(말로 부르는 능력), 작업(정해진 때 도는 일). 새 스킬을 만들면 템플릿으로 파일이 생기고 등록부의 그 종류 표에 올라가요. 등록부에 없으면 쓰지 않아요." });
		this.btn(e, "새 스킬", () => void this.newSkill(), { icon: "plus", cls: "tb-btn-primary" });
	}

	private renderSection(root: HTMLElement, kind: SkillKind, d: ToolboxData, today: string): void {
		if (Platform.isMobile) return renderToolboxSectionMobile(this.mobileHost(d), root, kind, d, today);
		const entries = d.entries.filter((e) => entryKind(e) === kind);
		const sec = root.createDiv({ cls: `tb-section kind-${kind}` });
		const head = sec.createDiv({ cls: "tb-section-head" });
		tip(head.createEl("h2", { text: kind }), KIND_LEAD[kind]);
		head.createSpan({ cls: "tb-section-count", text: `${entries.length}` });
		if (!entries.length) {
			sec.createDiv({ cls: "tb-section-empty", text: `${kind} 스킬이 없어요.` });
			return;
		}
		const cols = KIND_COLS[kind];
		const wrap = sec.createDiv({ cls: "tb-table-wrap" });
		const table = wrap.createEl("table", { cls: "tb-table" });
		const tr = table.createEl("thead").createEl("tr");
		for (const c of cols) tr.createEl("th", { text: COL_LABEL[c], cls: `c-${c}` });
		const body = table.createEl("tbody");
		for (const e of entries) {
			if (e.kind === "row-only") this.renderGhostRow(body, cols, e.row);
			else this.renderRow(body, cols, e, d.requests, today);
		}
	}

	/** What the mobile layout (`./mobile.ts`) may use: the desktop rows and the status buttons' call. */
	private mobileHost(d: ToolboxData): ToolboxMobileHost<Col> {
		return {
			app: this.app,
			contentEl: this.contentEl,
			cols: (kind) => KIND_COLS[kind],
			colLabel: (c) => COL_LABEL[c],
			lead: (kind) => KIND_LEAD[kind],
			statusHint: (kind, v) => STATUS_HINT[kind][v] ?? "",
			renderRow: (body, cols, e, today) => this.renderRow(body, cols, e, d.requests, today),
			renderGhostRow: (body, cols, e) => {
				if (e.kind === "row-only") this.renderGhostRow(body, cols, e.row);
			},
			setStatus: (s, to) => this.setStatus(s, to),
			register: (cb) => this.register(cb),
		};
	}

	private renderRow(body: HTMLElement, cols: Col[], e: Extract<Entry, { kind: "both" | "file-only" }>, requests: RunRequest[], today: string): void {
		const s = e.skill;
		const job = s.kind === "작업";
		const stale = isStaleSkill(s, today);
		const unreviewed = isReviewStale(s, today);
		const fail = job ? failure(s) : { failed: false, reason: "" };
		const discarded = s.status === "폐기";
		const tr = body.createEl("tr", { cls: `tb-row st-${s.status}${stale ? " is-stale" : ""}${discarded ? " is-discarded" : ""}${e.kind === "file-only" ? " is-unregistered" : ""}` });
		const hint = STATUS_HINT[s.kind];

		for (const c of cols) {
			const td = tr.createEl("td", { cls: `c-${c}` });
			switch (c) {
				case "name": {
					const link = td.createEl("a", { cls: "tb-name", text: s.name, attr: { href: "#", title: s.description || "스킬 파일 열기" } });
					link.addEventListener("click", (ev) => {
						ev.preventDefault();
						this.openFile(s.path, ev);
					});
					const meta = td.createDiv({ cls: "tb-meta" });
					meta.createSpan({ cls: "tb-id", text: s.id || "id 없음" });
					if (job && s.owner) meta.createSpan({ cls: "tb-owner", text: s.owner });
					if (e.kind === "file-only") {
						const badge = meta.createSpan({ cls: "tb-badge is-warn", text: "등록부에 없음" });
						badge.setAttr("title", "스킬 파일은 있는데 등록부에 행이 없어요. 등록부에 없으면 쓰지 않아요.");
						const reg = meta.createEl("button", { cls: "tb-link-btn", text: "등록", attr: { type: "button", title: `파일 내용으로 등록부 「${s.kind}」 표에 행을 추가해요` } });
						reg.addEventListener("click", () => void this.addRow(s));
					} else if (e.misplaced) {
						const from = e.row.kind;
						meta.createSpan({ cls: "tb-badge is-warn", text: `등록부 「${from}」 표에 있음`, attr: { title: `파일의 kind는 ${s.kind}인데 등록부 행은 「${from}」 표에 있어요.` } });
						const fix = meta.createEl("button", { cls: "tb-link-btn", text: "옮기기", attr: { type: "button", title: `행을 「${s.kind}」 표로 옮겨요 (파일 기준)` } });
						fix.addEventListener("click", () => void this.fixTable(s, from));
					}
					if (stale) meta.createSpan({ cls: "tb-badge is-stale", text: "아직도 쓰나요?", attr: { title: s.lastRun ? `마지막 실행 ${daysSinceRun(s, today)}일 전` : "한 번도 돌지 않았어요" } });
					else if (unreviewed) meta.createSpan({ cls: "tb-badge is-stale", text: "검토할 때", attr: { title: s.lastReviewed ? `마지막 검토 ${s.lastReviewed} (${STALE_DAYS}일 넘음)` : "마지막 검토 날짜가 없어요" } });
					break;
				}
				case "slug":
					if (s.slug) td.createEl("code", { cls: "tb-code", text: s.slug });
					else td.createSpan({ cls: "tb-badge is-warn", text: "slug 없음", attr: { title: "Hermes 스텁을 만들 수 없어요. 수정에서 적어 주세요." } });
					break;
				case "scope":
					td.setText(truncate(s.scope, 60) || "—");
					td.setAttr("title", s.scope);
					break;
				case "phrase":
					td.setText(truncate(s.phrase, 50) || "—");
					td.setAttr("title", s.phrase);
					break;
				case "owner":
					td.setText(s.owner || "—");
					break;
				case "purpose":
					td.setText(truncate(s.purpose, 60) || "—");
					td.setAttr("title", s.purpose);
					break;
				case "trigger":
					td.createSpan({ cls: `tb-trigger is-${s.trigger || "none"}`, text: s.trigger || "—" });
					if (s.trigger === "cron") td.createEl("code", { cls: "tb-code", text: s.schedule || "(schedule 없음)" });
					break;
				case "output":
					if (s.output) td.createEl("code", { cls: "tb-code tb-output", text: s.output, attr: { title: s.output } });
					else td.appendText("—");
					break;
				case "status": {
					// 작업 멈춤 / 시험 / 사용 (3-way), 도구 멈춤 / 사용 (2-way), 운영 a badge; 폐기 is shown, not changed here
					const live = liveStatuses(s.kind);
					if (discarded || !live.length) td.createSpan({ cls: `tb-status is-static st-${s.status}`, text: s.status || "—", attr: { title: hint[s.status] ?? "" } });
					else {
						const seg = td.createDiv({ cls: "tb-seg", attr: { role: "group", "aria-label": `${s.name} 상태` } });
						for (const v of live) {
							const b = seg.createEl("button", { cls: `tb-status st-${v}${v === s.status ? " is-active" : ""}`, text: v, attr: { type: "button", title: v === s.status ? hint[v] : `${v}으로 · ${hint[v]}`, "aria-pressed": String(v === s.status) } });
							b.addEventListener("click", () => void this.setStatus(s, v));
						}
					}
					if (!validStatus(s.kind, s.status)) td.createSpan({ cls: "tb-badge is-warn", text: `status: ${s.status || "없음"}`, attr: { title: `${s.kind}의 상태는 ${Object.keys(hint).join(" | ")} 중 하나예요` } });
					if (job) {
						const pend = pendingRequests(requests, s.id);
						if (pend.length) td.createSpan({ cls: "tb-badge is-pending", text: `실행 요청 ${pend.length}`, attr: { title: pend.map((r) => r.requested).join(", ") + " · Hermes가 처리하면 [x]로 바뀌어요" } });
						for (const r of recentDoneRequests(requests, s.id, today)) td.createSpan({ cls: "tb-badge is-done", text: `처리됨 ${shortStamp(r.requested)}`, attr: { title: `실행 요청 ${r.requested} 처리됨` } });
					}
					break;
				}
				case "run":
					td.createSpan({ cls: "tb-run", text: s.lastRun ? shortStamp(s.lastRun) : "아직 없음" });
					if (fail.failed) {
						const dot = td.createSpan({ cls: "tb-fail", attr: { title: fail.reason ? `실패: ${fail.reason}` : "실패 (이유 없음)" } });
						dot.createSpan({ cls: "tb-fail-dot" });
						dot.appendText(fail.reason ? truncate(fail.reason, 30) : "실패");
					} else if (s.lastResult) td.createSpan({ cls: "tb-result", text: truncate(s.lastResult, 30), attr: { title: s.lastResult } });
					break;
				case "reviewed":
					td.setText(s.lastReviewed ? shortStamp(s.lastReviewed) : "—");
					if (unreviewed) td.addClass("is-overdue");
					break;
				case "actions": {
					if (job) {
						const why = discarded ? "폐기한 스킬이에요" : !canRequestRun(s.status, s.kind) ? "멈춤 상태 — 시험이나 사용으로 바꾸면 요청할 수 있어요 (AGENTS 「4-4」 1)" : !s.id ? "id가 없어요" : "";
						this.btn(td, "지금 실행", () => void this.request(s), { icon: "play", label: `${s.name} 지금 실행 요청`, disabled: why || undefined });
					}
					this.btn(td, "", (): void => undefined, { icon: "more-horizontal", cls: "tb-btn-icon", label: "더 보기" }).addEventListener("click", (ev) => this.menu(ev, e));
					break;
				}
			}
		}
		tr.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			this.menu(ev, e);
		});
	}

	/** A registry row with no skill file. */
	private renderGhostRow(body: HTMLElement, cols: Col[], row: SkillRow): void {
		const tr = body.createEl("tr", { cls: "tb-row is-ghost", attr: { title: "등록부에는 있는데 스킬 파일이 없어요" } });
		for (const c of cols) {
			const td = tr.createEl("td", { cls: `c-${c}` });
			switch (c) {
				case "name": {
					td.createSpan({ cls: "tb-name is-struck", text: rowName(row.nameCell) });
					const meta = td.createDiv({ cls: "tb-meta" });
					meta.createSpan({ cls: "tb-id", text: row.id });
					meta.createSpan({ cls: "tb-badge is-warn", text: "파일 없음" });
					break;
				}
				case "slug":
					if (row.slug) td.createEl("code", { cls: "tb-code", text: row.slug });
					else td.setText("—");
					break;
				case "scope":
					td.setText(truncate(row.scope, 60) || "—");
					break;
				case "phrase":
					td.setText(truncate(row.phrase, 50) || "—");
					break;
				case "owner":
					td.setText(row.owner || "—");
					break;
				case "purpose":
					td.setText(truncate(row.purpose, 60) || "—");
					break;
				case "trigger":
					td.createSpan({ cls: "tb-trigger", text: row.trigger || "—" });
					if (row.schedule) td.createEl("code", { cls: "tb-code", text: row.schedule });
					break;
				case "output":
					if (row.output) td.createEl("code", { cls: "tb-code tb-output", text: row.output });
					break;
				case "status":
					td.createSpan({ cls: `tb-status is-static st-${row.status}`, text: row.status || "—" });
					break;
				case "run":
					td.setText(row.lastRun ? shortStamp(row.lastRun) : "—");
					break;
				case "reviewed":
					td.setText(row.lastReviewed ? shortStamp(row.lastReviewed) : "—");
					break;
				case "actions":
					this.btn(td, "등록부 열기", () => this.openFile(registryPath(this.plugin)), { icon: "file-text" });
					break;
			}
		}
	}

	private menu(ev: MouseEvent, e: Extract<Entry, { kind: "both" | "file-only" }>): void {
		const s = e.skill;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("스킬 파일 열기").setIcon("file-text").onClick(() => this.openFile(s.path)));
		if (e.kind === "file-only") menu.addItem((i) => i.setTitle("등록부에 행 추가").setIcon("list-plus").onClick(() => void this.addRow(s)));
		if (e.kind === "both" && e.misplaced) menu.addItem((i) => i.setTitle(`등록부 행을 「${s.kind}」 표로 옮기기`).setIcon("arrow-right-left").onClick(() => void this.fixTable(s, e.row.kind)));
		if (s.status !== "폐기") {
			menu.addItem((i) => i.setTitle("수정…").setIcon("pencil").onClick(() => void this.edit(s)));
			menu.addSeparator();
			for (const v of liveStatuses(s.kind)) {
				if (v === s.status) continue;
				menu.addItem((i) =>
					i
						.setTitle(needsConfirm(v) ? `${v}으로…` : `${v}으로`)
						.setIcon(v === "멈춤" ? "pause" : v === "시험" ? "flask-conical" : "play")
						.onClick(() => void this.setStatus(s, v)),
				);
			}
			if (canRequestRun(s.status, s.kind) && s.id) menu.addItem((i) => i.setTitle("지금 실행 요청").setIcon("send").onClick(() => void this.request(s)));
			menu.addItem((i) =>
				i
					.setTitle("폐기…")
					.setIcon("archive-x")
					.setWarning(true)
					.onClick(() => void this.discard(s)),
			);
		}
		menu.showAtMouseEvent(ev);
	}
}
