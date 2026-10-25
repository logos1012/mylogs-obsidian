/**
 * Toolbox view (`mylogs-toolbox`): the registry as one table — 이름 · 하는 일 · 트리거/schedule ·
 * 출력 · 상태 · 마지막 실행(결과) · 마지막 검토 — read from the skill files (`type: skill`) with the
 * registry rows beside them (file = canonical; a file without a row says 등록부에 없음, a row
 * without a file is struck through).
 *
 * Writes (status toggle, 폐기, 지금 실행, 새 스킬, 수정) go through `actions.ts`; running a skill
 * is Hermes' job (the plugin only queues a 실행 요청 line).
 */

import { debounce, ItemView, Keymap, Menu, normalizePath, Notice, setIcon, type TAbstractFile, TFile, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { toIsoDate } from "../parser.ts";
import { createSkill, discardSkill, editSkill, loadToolbox, nextId, registerSkill, registryPath, requestRun, setStatus, takenIdsAndNames, toolboxRoot, type ToolboxData } from "./actions.ts";
import { askDiscard, askSkillForm, confirmEnable, toEdit } from "./modals.ts";
import { canRequestRun, daysSinceRun, type Entry, failure, isStaleSkill, LIVE_STATUSES, type LiveStatus, MAX_SKILLS, needsConfirm, pendingRequests, recentDoneRequests, type RunRequest, rowName, type Skill, type SkillRow, STALE_DAYS, tooMany, truncate } from "./model.ts";

export const VIEW_TYPE_TOOLBOX = "mylogs-toolbox";

const STATUS_HINT: Record<string, string> = { 사용: "cron으로 돌아요", 시험: "cron 없이 「지금 실행」으로만", 멈춤: "파일은 그대로, cron은 없음", 폐기: "등록부 「폐기」 표" };

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
		await this.run(async () => {
			const path = await createSkill(this.plugin, input, id);
			const f = path ? this.app.vault.getAbstractFileByPath(normalizePath(path)) : null;
			if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
		});
	}

	/** 멈춤 / 시험 / 사용 (「4-1」 2-1). 시험·사용 ask first (「6」: the click is the confirmation, but show what turns on). */
	private async setStatus(s: Skill, to: LiveStatus): Promise<void> {
		if (s.status === "폐기") {
			new Notice("폐기한 스킬은 여기서 되살리지 않아요. 파일의 status를 직접 고쳐 주세요.");
			return;
		}
		if (to === s.status) return;
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
		await this.run(() => editSkill(this.plugin, s, toEdit(input)));
	}

	private async addRow(s: Skill): Promise<void> {
		await this.run(() => registerSkill(this.plugin, s));
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
		if (stale && d.skills.length) this.notice(root, "hourglass", `${STALE_DAYS}일 넘게 돌지 않았거나 한 번도 돌지 않은 스킬이 ${stale}개 있어요. 아직도 쓰나요?`);

		if (!d.entries.length) return this.renderEmpty(root);
		this.renderTable(root, d, today);

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
		e.createEl("p", { text: "스킬 = AI가 반복해서 하는 일 하나의 지시서. 새 스킬을 만들면 템플릿으로 파일이 생기고 등록부에 올라가요. 등록부에 없으면 돌지 않아요." });
		this.btn(e, "새 스킬", () => void this.newSkill(), { icon: "plus", cls: "tb-btn-primary" });
	}

	private renderTable(root: HTMLElement, d: ToolboxData, today: string): void {
		const wrap = root.createDiv({ cls: "tb-table-wrap" });
		const table = wrap.createEl("table", { cls: "tb-table" });
		const tr = table.createEl("thead").createEl("tr");
		for (const [h, cls] of [
			["이름", "c-name"],
			["하는 일", "c-purpose"],
			["트리거 / schedule", "c-trigger"],
			["출력", "c-output"],
			["상태", "c-status"],
			["마지막 실행 · 결과", "c-run"],
			["마지막 검토", "c-reviewed"],
			["", "c-actions"],
		]) {
			tr.createEl("th", { text: h, cls });
		}
		const body = table.createEl("tbody");
		for (const e of d.entries) {
			if (e.kind === "row-only") this.renderGhostRow(body, e.row);
			else this.renderRow(body, e, d.requests, today);
		}
	}

	private renderRow(body: HTMLElement, e: Extract<Entry, { kind: "both" | "file-only" }>, requests: RunRequest[], today: string): void {
		const s = e.skill;
		const stale = isStaleSkill(s, today);
		const fail = failure(s);
		const discarded = s.status === "폐기";
		const tr = body.createEl("tr", { cls: `tb-row st-${s.status}${stale ? " is-stale" : ""}${discarded ? " is-discarded" : ""}${e.kind === "file-only" ? " is-unregistered" : ""}` });

		// 이름
		const name = tr.createEl("td", { cls: "c-name" });
		const link = name.createEl("a", { cls: "tb-name", text: s.name, attr: { href: "#", title: "스킬 파일 열기" } });
		link.addEventListener("click", (ev) => {
			ev.preventDefault();
			this.openFile(s.path, ev);
		});
		const meta = name.createDiv({ cls: "tb-meta" });
		meta.createSpan({ cls: "tb-id", text: s.id || "id 없음" });
		if (s.owner) meta.createSpan({ cls: "tb-owner", text: s.owner });
		if (e.kind === "file-only") {
			const badge = meta.createSpan({ cls: "tb-badge is-warn", text: "등록부에 없음" });
			badge.setAttr("title", "스킬 파일은 있는데 등록부에 행이 없어요. 등록부에 없으면 돌지 않아요.");
			const reg = meta.createEl("button", { cls: "tb-link-btn", text: "등록", attr: { type: "button", title: "파일 내용으로 등록부에 행을 추가해요" } });
			reg.addEventListener("click", () => void this.addRow(s));
		}
		if (stale) meta.createSpan({ cls: "tb-badge is-stale", text: "아직도 쓰나요?", attr: { title: s.lastRun ? `마지막 실행 ${daysSinceRun(s, today)}일 전` : "한 번도 돌지 않았어요" } });

		// 하는 일
		tr.createEl("td", { cls: "c-purpose", text: truncate(s.purpose, 60) || "—", attr: { title: s.purpose } });

		// 트리거 / schedule
		const trig = tr.createEl("td", { cls: "c-trigger" });
		trig.createSpan({ cls: `tb-trigger is-${s.trigger || "none"}`, text: s.trigger || "—" });
		if (s.trigger === "cron") trig.createEl("code", { cls: "tb-code", text: s.schedule || "(schedule 없음)" });

		// 출력
		const out = tr.createEl("td", { cls: "c-output" });
		if (s.output) out.createEl("code", { cls: "tb-code tb-output", text: s.output, attr: { title: s.output } });
		else out.appendText("—");

		// 상태: 멈춤 / 시험 / 사용 (3-way); 폐기 is shown, not changed here
		const st = tr.createEl("td", { cls: "c-status" });
		if (discarded) st.createSpan({ cls: "tb-status is-static st-폐기", text: "폐기", attr: { title: STATUS_HINT.폐기 } });
		else {
			const seg = st.createDiv({ cls: "tb-seg", attr: { role: "group", "aria-label": `${s.name} 상태` } });
			for (const v of LIVE_STATUSES) {
				const b = seg.createEl("button", { cls: `tb-status st-${v}${v === s.status ? " is-active" : ""}`, text: v, attr: { type: "button", title: v === s.status ? STATUS_HINT[v] : `${v}으로 · ${STATUS_HINT[v]}`, "aria-pressed": String(v === s.status) } });
				b.addEventListener("click", () => void this.setStatus(s, v));
			}
			if (!(LIVE_STATUSES as readonly string[]).includes(s.status)) st.createSpan({ cls: "tb-badge is-warn", text: `status: ${s.status || "없음"}`, attr: { title: "사용 | 시험 | 멈춤 | 폐기 중 하나가 아니에요" } });
		}
		const pend = pendingRequests(requests, s.id);
		if (pend.length) st.createSpan({ cls: "tb-badge is-pending", text: `실행 요청 ${pend.length}`, attr: { title: pend.map((r) => r.requested).join(", ") + " · Hermes가 처리하면 [x]로 바뀌어요" } });
		for (const r of recentDoneRequests(requests, s.id, today)) st.createSpan({ cls: "tb-badge is-done", text: `처리됨 ${shortStamp(r.requested)}`, attr: { title: `실행 요청 ${r.requested} 처리됨` } });

		// 마지막 실행 · 결과
		const run = tr.createEl("td", { cls: "c-run" });
		run.createSpan({ cls: "tb-run", text: s.lastRun ? shortStamp(s.lastRun) : "아직 없음" });
		if (fail.failed) {
			const dot = run.createSpan({ cls: "tb-fail", attr: { title: fail.reason ? `실패: ${fail.reason}` : "실패 (이유 없음)" } });
			dot.createSpan({ cls: "tb-fail-dot" });
			dot.appendText(fail.reason ? truncate(fail.reason, 30) : "실패");
		} else if (s.lastResult) run.createSpan({ cls: "tb-result", text: truncate(s.lastResult, 30), attr: { title: s.lastResult } });

		// 마지막 검토
		tr.createEl("td", { cls: "c-reviewed", text: s.lastReviewed ? shortStamp(s.lastReviewed) : "—" });

		// actions
		const act = tr.createEl("td", { cls: "c-actions" });
		const why = discarded ? "폐기한 스킬이에요" : !canRequestRun(s.status) ? "멈춤 상태 — 시험이나 사용으로 바꾸면 요청할 수 있어요 (AGENTS 「4-4」 1)" : !s.id ? "id가 없어요" : "";
		this.btn(act, "지금 실행", () => void this.request(s), { icon: "play", label: `${s.name} 지금 실행 요청`, disabled: why || undefined });
		this.btn(act, "", (): void => undefined, { icon: "more-horizontal", cls: "tb-btn-icon", label: "더 보기" }).addEventListener("click", (ev) => this.menu(ev, e));
		tr.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			this.menu(ev, e);
		});
	}

	/** A registry row with no skill file. */
	private renderGhostRow(body: HTMLElement, row: SkillRow): void {
		const tr = body.createEl("tr", { cls: "tb-row is-ghost", attr: { title: "등록부에는 있는데 스킬 파일이 없어요" } });
		const name = tr.createEl("td", { cls: "c-name" });
		name.createSpan({ cls: "tb-name is-struck", text: rowName(row.nameCell) });
		const meta = name.createDiv({ cls: "tb-meta" });
		meta.createSpan({ cls: "tb-id", text: row.id });
		meta.createSpan({ cls: "tb-badge is-warn", text: "파일 없음" });
		tr.createEl("td", { cls: "c-purpose", text: truncate(row.purpose, 60) || "—" });
		const trig = tr.createEl("td", { cls: "c-trigger" });
		trig.createSpan({ cls: "tb-trigger", text: row.trigger || "—" });
		if (row.schedule) trig.createEl("code", { cls: "tb-code", text: row.schedule });
		const out = tr.createEl("td", { cls: "c-output" });
		if (row.output) out.createEl("code", { cls: "tb-code tb-output", text: row.output });
		tr.createEl("td", { cls: "c-status" }).createSpan({ cls: `tb-status is-static st-${row.status}`, text: row.status || "—" });
		tr.createEl("td", { cls: "c-run", text: row.lastRun ? shortStamp(row.lastRun) : "—" });
		tr.createEl("td", { cls: "c-reviewed", text: row.lastReviewed ? shortStamp(row.lastReviewed) : "—" });
		const act = tr.createEl("td", { cls: "c-actions" });
		this.btn(act, "등록부 열기", () => this.openFile(registryPath(this.plugin)), { icon: "file-text" });
	}

	private menu(ev: MouseEvent, e: Extract<Entry, { kind: "both" | "file-only" }>): void {
		const s = e.skill;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("스킬 파일 열기").setIcon("file-text").onClick(() => this.openFile(s.path)));
		if (e.kind === "file-only") menu.addItem((i) => i.setTitle("등록부에 행 추가").setIcon("list-plus").onClick(() => void this.addRow(s)));
		if (s.status !== "폐기") {
			menu.addItem((i) => i.setTitle("수정…").setIcon("pencil").onClick(() => void this.edit(s)));
			menu.addSeparator();
			for (const v of LIVE_STATUSES) {
				if (v === s.status) continue;
				menu.addItem((i) =>
					i
						.setTitle(needsConfirm(v) ? `${v}으로…` : `${v}으로`)
						.setIcon(v === "멈춤" ? "pause" : v === "시험" ? "flask-conical" : "play")
						.onClick(() => void this.setStatus(s, v)),
				);
			}
			if (canRequestRun(s.status) && s.id) menu.addItem((i) => i.setTitle("지금 실행 요청").setIcon("send").onClick(() => void this.request(s)));
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
