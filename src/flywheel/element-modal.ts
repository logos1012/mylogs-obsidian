/**
 * Element popup — the project workspace for a Flywheel element (「Flywheel 화면 설계 v2」 ②).
 *
 *   머리      ← 바퀴 · 이름 + 상태 · 정체성 · ⋯ (이름 바꾸기, 쉼/사용, 폐기, 허브 원문)
 *   오늘      최소 행동(크게) · 보통 · 어떻게 기록됐나 · 「했음」
 *   기록      한 줄 쓰기(☆ 재료) + 날짜별 기록
 *   초안·산출물  채널 탭, ＋ 게시물 / ＋ 산출물
 *   요소 정보  방법 · 지금 다듬는 것 · 주요 결정
 *   옆        연결 목표 · 이달 수행 · 나온 프로젝트 · 작업 자료(기록/초안/산출물/작업실)
 */

import { type App, FuzzySuggestModal, Menu, Modal, moment, Notice, setIcon, TFile } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { tip } from "../ui/tip.ts";
import { askForm } from "../ui/modals.ts";
import { pickTarget } from "../ui/mobile.ts";
import { vaultIO } from "../pinboard/create-actions.ts";
import { commitBatch } from "../pinboard/batch.ts";
import { isPlaceholder } from "./ops.ts";
import { addRecordLine, changeElement, coverSrc, createOutput, IMAGE_EXT, renameElement, setCover, setDay, setElementGoals, todayIso } from "./actions.ts";
import { type ElementStats, loadScreen, markOf, type ScreenData } from "./screen-data.ts";
import type { FlywheelElement } from "./model.ts";
import {
	DECISIONS_SECTION,
	type ElementFile,
	hubSection,
	MATERIAL_TAG,
	METHOD_KEYS,
	nextText,
	recordPath,
	setHubFm,
	setHubMethod,
	setHubSection,
	SOURCE_LABEL,
	toggleMaterial,
	TUNING_SECTION,
} from "./wheel.ts";

const err = (e: unknown) => new Notice(`MyLogs: ${e instanceof Error ? e.message : String(e)}`, 10000);

export function openElementModal(plugin: MyLogsPlugin, id: string, onChange?: () => void): void {
	new ElementModal(plugin.app, plugin, id, onChange).open();
}

class ElementModal extends Modal {
	private plugin: MyLogsPlugin;
	private id: string;
	private onChange?: () => void;
	private d: ScreenData | null = null;
	private hubText = "";
	private channel = "";
	private busy = false;
	private unwatch: (() => void) | null = null;

	constructor(app: App, plugin: MyLogsPlugin, id: string, onChange?: () => void) {
		super(app);
		this.plugin = plugin;
		this.id = id;
		this.onChange = onChange;
	}

	onOpen(): void {
		this.modalEl.addClass("mylogs-fw-modal");
		this.contentEl.addClass("fw3", "fw3-ws");
		const ref = this.app.metadataCache.on("changed", () => {
			if (!this.busy) void this.load();
		});
		this.unwatch = () => this.app.metadataCache.offref(ref);
		void this.load();
	}

	onClose(): void {
		this.unwatch?.();
		this.contentEl.empty();
		this.onChange?.();
	}

	private async load(): Promise<void> {
		try {
			this.d = await loadScreen(this.plugin);
			const s = this.d.stats.get(this.id);
			const f = s && this.app.vault.getAbstractFileByPath(s.e.hubPath);
			this.hubText = f instanceof TFile ? await this.app.vault.cachedRead(f) : "";
			this.render();
		} catch (e) {
			err(e);
		}
	}

	private async run(fn: () => Promise<unknown>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await fn();
		} catch (e) {
			err(e);
		} finally {
			this.busy = false;
		}
		await this.load();
	}

	private render(): void {
		const el = this.contentEl;
		const scroll = this.modalEl.scrollTop;
		el.empty();
		const d = this.d;
		const s = d?.stats.get(this.id);
		if (!d || !s) {
			el.createDiv({ cls: "fw3-empty", text: "요소를 찾지 못했어요." });
			return;
		}
		const e = s.e;
		const nav = el.createDiv({ cls: "fw3-ws-nav" });
		const back = nav.createEl("button", { cls: "fw3-btn", text: "← 바퀴", attr: { type: "button" } });
		back.addEventListener("click", () => this.close());
		nav.createDiv({ cls: "fw3-grow" });
		const more = nav.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "요소 메뉴" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (ev) => this.menu(ev, e));

		const head = el.createDiv({ cls: "fw3-ws-head" });
		const cover = coverSrc(this.app, e);
		if (cover) {
			const b = head.createDiv({ cls: "fw3-ws-cover" });
			b.createEl("img", { attr: { src: cover, alt: "", draggable: "false" } });
			tip(b, "누르면 커버 이미지를 바꿔요");
			b.addEventListener("click", () => this.pickCover(e));
		}
		head.createDiv({ cls: "fw3-ws-meta", text: ["매일", e.since ? `${moment(e.since, "YYYY-MM-DD").format("YYYY-MM-DD")}부터` : "", ...e.channels].filter(Boolean).join(" · ") });
		const title = head.createDiv({ cls: "fw3-ws-title" });
		title.createEl("h1", { text: e.name });
		const pill = title.createEl("button", { cls: `fw3-status st-${e.status || "none"}`, text: `${e.status || "상태 없음"} ▾`, attr: { type: "button" } });
		tip(pill, "누르면 상태를 바꿔요");
		pill.addEventListener("click", (ev) => this.statusMenu(ev, e));
		const ident = e.fields["정체성"];
		const ip = head.createEl("p", { cls: `fw3-ws-ident${isPlaceholder(ident) ? " is-empty" : ""}`, text: isPlaceholder(ident) ? "정체성 — 「나는 매일 ~하는 사람이다」를 적어 주세요" : ident });
		ip.addEventListener("click", () => void this.editMethod(e));
		if (!e.hasHub) head.createDiv({ cls: "fw3-banner", text: `요소 허브가 없어요: ${e.hubPath}` });

		const layout = el.createDiv({ cls: "fw3-ws-layout" });
		const main = layout.createDiv({ cls: "fw3-ws-main" });
		const side = layout.createDiv({ cls: "fw3-ws-side" });
		this.renderAction(main, d, s);
		this.renderRecords(main, d, s);
		this.renderOutputs(main, s);
		this.renderInfo(main, e);
		this.renderGoals(side, d, e);
		this.renderMonth(side, d, e);
		this.renderProjects(side, s);
		this.renderFiles(side, s);
		this.modalEl.scrollTop = scroll;
	}

	private renderAction(main: HTMLElement, d: ScreenData, s: ElementStats): void {
		const e = s.e;
		const box = main.createDiv({ cls: "fw3-ws-action" });
		const k = box.createDiv({ cls: "fw3-ws-k" });
		k.createSpan({ text: "오늘의 최소 행동" });
		k.createDiv({ cls: "fw3-grow" });
		k.createSpan({ cls: `fw3-src s-${s.source}`, text: SOURCE_LABEL[s.source] + (s.time ? ` · ${s.time}` : "") });
		const min = e.fields["최소"];
		const v = box.createDiv({ cls: `fw3-ws-v${isPlaceholder(min) ? " is-empty" : ""}`, text: isPlaceholder(min) ? "최소 행동을 정해 주세요" : min });
		v.addEventListener("click", () => void this.editMethod(e));
		if (!isPlaceholder(e.fields["보통"])) box.createDiv({ cls: "fw3-ws-sub", text: `보통: ${e.fields["보통"]}` });
		const how = box.createDiv({ cls: "fw3-ws-how" });
		if (e.status !== "사용" || (e.since && e.since > d.today)) {
			how.createSpan({ cls: "fw3-muted", text: e.status === "쉼" ? "쉬는 중이에요." : e.since > d.today ? `${e.since}부터 시작해요.` : "" });
			return;
		}
		const did = how.createEl("button", { cls: `fw3-did${s.today === "x" ? " is-on" : ""}`, text: s.today === "x" ? "✓ 했음" : "했음", attr: { type: "button" } });
		did.addEventListener("click", () => void this.run(() => setDay(this.plugin, e, d.today, s.today === "x" ? "" : "x", s.today === "x" ? null : undefined)));
		const ev = d.evidence.get(`${d.today}|${e.id}`);
		if (ev) how.createSpan({ cls: "fw3-muted", text: ev });
	}

	private renderRecords(main: HTMLElement, d: ScreenData, s: ElementStats): void {
		const e = s.e;
		const sec = main.createDiv({ cls: "fw3-ws-sec" });
		const h = sec.createEl("h2");
		h.appendText("기록");
		h.createDiv({ cls: "fw3-grow" });
		h.createSpan({ cls: "fw3-small fw3-muted", text: `이달 ${s.recDays}일 · ${s.recLines}줄` });
		const write = sec.createDiv({ cls: "fw3-write" });
		const input = write.createEl("input", { attr: { type: "text", placeholder: "오늘 한 것, 떠오른 생각 (Enter = 오늘 기록에)", enterkeyhint: "done" } });
		const star = write.createEl("button", { cls: "fw3-btn fw3-star", text: "☆ 재료", attr: { type: "button" } });
		star.addEventListener("click", () => {
			star.toggleClass("is-on", !star.hasClass("is-on"));
			star.setText(star.hasClass("is-on") ? "★ 재료" : "☆ 재료");
		});
		const save = write.createEl("button", { cls: "fw3-btn mod-cta", text: "남기기", attr: { type: "button" } });
		const submit = () => {
			const t = input.value.trim();
			if (!t) return;
			void this.run(() => addRecordLine(this.plugin, e, d.today, t + (star.hasClass("is-on") ? ` ${MATERIAL_TAG}` : "")));
		};
		save.addEventListener("click", submit);
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" && !ev.isComposing) submit();
		});
		tip(sec.createDiv({ cls: "fw3-small fw3-faint", text: "기록은 체크와 따로예요. 남겨도 수행으로 세지 않아요." }), "저장만으로 체크하지 않아요 (지침 「4-2」).");

		const list = sec.createDiv({ cls: "fw3-rdays" });
		const shown = s.days.filter((x) => x.day.lines.length).slice(0, 10);
		if (!shown.length) list.createDiv({ cls: "fw3-faint fw3-small", text: "아직 기록이 없어요." });
		for (const { ym, day } of shown) {
			const row = list.createDiv({ cls: "fw3-rday" });
			const dd = row.createDiv({ cls: "fw3-rday-d" });
			const mark = markOf(d, e, day.date);
			dd.createSpan({ cls: `fw3-ok${mark === "x" ? "" : " is-no"}` });
			dd.appendText(moment(day.date, "YYYY-MM-DD").format("M/D (dd)"));
			const lines = row.createDiv({ cls: "fw3-rday-l" });
			const ev = d.evidence.get(`${day.date}|${e.id}`);
			for (const l of day.lines) {
				const li = lines.createDiv({ cls: `fw3-rline${l.embed ? " is-embed" : ""}` });
				const t = li.createSpan({ cls: "fw3-rtext", text: l.embed ? "…" : l.text });
				if (l.embed) void this.embedText(l.embed).then((x) => t.setText(x ?? l.embed!));
				if (l.embed) li.createSpan({ cls: "fw3-tiny fw3-faint", text: " ↙ Daily Pad 메모" });
				if (l.material || day.material) li.createSpan({ cls: "fw3-pill is-mat", text: "재료" });
				const used = d.used.get(`${recordPath(e, ym).split("/").pop()!.replace(/\.md$/, "")}#${day.date}`);
				if (used && (l.material || day.material)) li.createSpan({ cls: "fw3-used", text: ` → 「${used.replace(/^\d{4}-\d{2}-\d{2}\s+/, "")}」에 씀` });
				const st = li.createEl("button", { cls: `fw3-icon-btn${l.material ? " is-on" : ""}`, text: l.material ? "★" : "☆", attr: { type: "button", "aria-label": "재료 표시" } });
				tip(st, l.material ? "재료 표시 빼기" : "재료로 표시");
				st.addEventListener("click", () => void this.run(() => this.toggleMat(e, ym, l.raw)));
			}
			if (ev && !ev.includes("사용자 수정")) lines.createDiv({ cls: "fw3-who", text: ev });
		}
		const open = sec.createEl("button", { cls: "fw3-link", text: "이달 기록 원문 열기 →", attr: { type: "button" } });
		open.addEventListener("click", () => void this.openPath(recordPath(e, d.today.slice(0, 7))));
	}

	private async toggleMat(e: FlywheelElement, ym: string, raw: string): Promise<void> {
		const io = vaultIO(this.app);
		const path = recordPath(e, ym);
		const before = await io.read(path);
		if (before === null) return;
		await commitBatch(io, [{ path, before, after: toggleMaterial(before, raw) }]);
	}

	/** `04 Daily Pad/…/2026-01-14#^fw-1` → that memo line's text. */
	private async embedText(target: string): Promise<string | null> {
		const [path, block] = target.split("#^");
		const f = this.app.metadataCache.getFirstLinkpathDest(path, "");
		if (!f || !block) return null;
		const line = (await this.app.vault.cachedRead(f)).split(/\r?\n/).find((l) => l.endsWith(`^${block}`));
		return line ? line.replace(/^\s*[-*+]\s+/, "").replace(/\s*\(record::[^)]*\)/, "").replace(/\s*\^[\w-]+$/, "") : null;
	}

	private renderOutputs(main: HTMLElement, s: ElementStats): void {
		const e = s.e;
		const sec = main.createDiv({ cls: "fw3-ws-sec" });
		const h = sec.createEl("h2");
		h.appendText("초안 · 산출물");
		h.createDiv({ cls: "fw3-grow" });
		const np = h.createEl("button", { cls: "fw3-btn is-sm", text: "＋ 게시물", attr: { type: "button" } });
		np.addEventListener("click", () => void this.newOutput(e, true));
		const no = h.createEl("button", { cls: "fw3-btn is-sm is-ghost", text: "＋ 산출물", attr: { type: "button" } });
		no.addEventListener("click", () => void this.newOutput(e, false));
		const items = [...s.drafts, ...s.outputs].sort((a, b) => b.date.localeCompare(a.date));
		const channels = [...new Set([...e.channels, ...items.map((f) => f.channel).filter(Boolean)])];
		if (channels.length) {
			const seg = sec.createDiv({ cls: "fw3-seg" });
			const tab = (key: string, label: string, n: number) => {
				const b = seg.createEl("button", { cls: key === this.channel ? "is-on" : "", text: `${label} ${n}`, attr: { type: "button" } });
				b.addEventListener("click", () => {
					this.channel = key;
					this.render();
				});
			};
			tab("", "전체", items.length);
			for (const c of channels) tab(c, c, items.filter((f) => f.channel === c).length);
			if (items.some((f) => !f.channel)) tab("-", "기타", items.filter((f) => !f.channel).length);
		}
		const shown = items.filter((f) => !this.channel || (this.channel === "-" ? !f.channel : f.channel === this.channel));
		const list = sec.createDiv({ cls: "fw3-plist" });
		if (!shown.length) list.createDiv({ cls: "fw3-faint fw3-small fw3-pad", text: "아직 없어요." });
		for (const f of shown.slice(0, 30)) {
			const row = list.createEl("button", { cls: "fw3-prow", attr: { type: "button" } });
			row.createSpan({ cls: "fw3-pdate", text: f.date ? moment(f.date, "YYYY-MM-DD").format("M/D") : "" });
			row.createSpan({ cls: "fw3-ptitle", text: f.title });
			if (f.channel) row.createSpan({ cls: "fw3-pill is-ch", text: f.channel });
			const draft = s.drafts.includes(f);
			row.createSpan({ cls: `fw3-pill${draft ? "" : " is-pub"}`, text: f.kind === "output" ? "산출물" : draft ? "초안" : "발행" });
			row.addEventListener("click", () => void this.openPath(f.path));
		}
	}

	private renderInfo(main: HTMLElement, e: FlywheelElement): void {
		const sec = main.createDiv({ cls: "fw3-ws-sec" });
		sec.createEl("h2", { text: "요소 정보" });
		const method = sec.createEl("details", { cls: "fw3-details" });
		method.open = true;
		const ms = method.createEl("summary");
		ms.appendText("방법");
		const mb = method.createDiv({ cls: "fw3-kv" });
		for (const k of METHOD_KEYS) {
			mb.createSpan({ cls: "fw3-k", text: k });
			const v = e.fields[k];
			mb.createSpan({ cls: isPlaceholder(v) ? "is-empty" : "", text: isPlaceholder(v) ? "채워 주세요" : k === "다음" ? `→ ${nextText(v, this.d?.wheel.elements ?? [])}` : v });
		}
		const edit = method.createEl("button", { cls: "fw3-btn is-sm", text: "방법 고치기", attr: { type: "button" } });
		edit.addEventListener("click", () => void this.editMethod(e));

		const tune = sec.createEl("details", { cls: "fw3-details" });
		tune.open = true;
		tune.createEl("summary", { text: TUNING_SECTION });
		const tt = hubSection(this.hubText, TUNING_SECTION);
		tune.createDiv({ cls: `fw3-pre${tt ? "" : " is-empty"}`, text: tt || "비어 있어요" });
		const te = tune.createEl("button", { cls: "fw3-btn is-sm", text: "고치기", attr: { type: "button" } });
		te.addEventListener("click", () => void this.editSection(e, TUNING_SECTION, tt));

		const dec = sec.createEl("details", { cls: "fw3-details" });
		dec.createEl("summary", { text: DECISIONS_SECTION });
		const dt = hubSection(this.hubText, DECISIONS_SECTION);
		dec.createDiv({ cls: `fw3-pre${dt ? "" : " is-empty"}`, text: dt || "비어 있어요" });
		const de = dec.createEl("button", { cls: "fw3-btn is-sm", text: "＋ 결정 남기기", attr: { type: "button" } });
		de.addEventListener("click", () => void this.addDecision(e, dt));
	}

	private renderGoals(side: HTMLElement, d: ScreenData, e: FlywheelElement): void {
		const g = side.createDiv({ cls: "fw3-side-g" });
		tip(g.createEl("h2", { text: "연결 목표" }), "이 요소가 돕는 목표예요. 수행 횟수는 목표 진행률을 바꾸지 않아요.");
		if (!e.goals.length) g.createDiv({ cls: "fw3-faint fw3-small", text: "연결된 목표가 없어요." });
		for (const id of e.goals) {
			const row = g.createDiv({ cls: "fw3-goal" });
			const b = row.createEl("button", { cls: "fw3-link", text: d.goals.get(id) ?? `${id} (찾을 수 없음)`, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.close();
				void this.plugin.openPinboardGoal(id);
			});
			const x = row.createEl("button", { cls: "fw3-icon-btn", text: "×", attr: { type: "button", "aria-label": "연결 해제" } });
			x.addEventListener("click", () => void this.run(() => setElementGoals(this.plugin, e, e.goals.filter((y) => y !== id), `${e.id} 목표 연결 해제: ${id}`)));
		}
		const add = g.createEl("button", { cls: "fw3-btn is-sm is-ghost", text: "＋ 목표 연결", attr: { type: "button" } });
		add.addEventListener("click", () => void this.linkGoal(d, e));
	}

	private async linkGoal(d: ScreenData, e: FlywheelElement): Promise<void> {
		const subs = [...d.goals.entries()].filter(([id]) => /^G-\d{4}-\d{2}\.\d+$/.test(id) && !e.goals.includes(id));
		const it = await pickTarget(this.app, "연결할 하위 목표", subs.map(([id, title]) => ({ label: title, sub: id, id })));
		if (!it) return;
		await this.run(() => setElementGoals(this.plugin, e, [...e.goals, it.id], `${e.id} 목표 연결: ${it.id}`));
		await this.refreshPinboardIndex([it.id]);
	}

	private async refreshPinboardIndex(ids: string[]): Promise<void> {
		try {
			const { refreshRelatedIndex } = await import("../pinboard/create-actions.ts");
			await refreshRelatedIndex(this.plugin, ids, todayIso());
		} catch (e) {
			console.warn("[MyLogs] Pinboard Index not refreshed", e);
		}
	}

	private renderMonth(side: HTMLElement, d: ScreenData, e: FlywheelElement): void {
		const g = side.createDiv({ cls: "fw3-side-g" });
		const h = g.createEl("h2");
		h.appendText(`${moment(d.today, "YYYY-MM-DD").format("M")}월 수행`);
		const first = moment(d.today, "YYYY-MM-DD").startOf("month");
		const days = first.daysInMonth();
		let done = 0;
		let live = 0;
		const cal = g.createDiv({ cls: "fw3-mcal" });
		for (const w of ["월", "화", "수", "목", "금", "토", "일"]) cal.createSpan({ cls: "fw3-mcal-h", text: w });
		for (let i = 0; i < (first.isoWeekday() + 6) % 7; i++) cal.createSpan();
		for (let n = 1; n <= days; n++) {
			const iso = first.clone().date(n).format("YYYY-MM-DD");
			const future = iso > d.today;
			const mark = future ? "" : markOf(d, e, iso);
			if (!future && mark !== "out" && mark !== "쉼") (live++, mark === "x" && done++);
			const ev = d.evidence.get(`${iso}|${e.id}`) ?? "";
			const c = cal.createSpan({ cls: `fw3-mday m-${mark === "x" ? "x" : mark === "-" ? "m" : mark === "쉼" ? "r" : future ? "f" : "b"}${iso === d.today ? " is-today" : ""}${ev && !ev.includes("사용자 수정") && !ev.includes("Vision") ? " is-agent" : ""}`, text: String(n) });
			if (ev) tip(c, ev);
		}
		h.createDiv({ cls: "fw3-grow" });
		h.createSpan({ cls: "fw3-small fw3-faint", text: `${done}/${live}` });
		g.createDiv({ cls: "fw3-tiny fw3-faint", text: "초록 = 했음 · 파란 점 = 에이전트가 기록" });
	}

	private renderProjects(side: HTMLElement, s: ElementStats): void {
		if (!s.projects.length) return;
		const g = side.createDiv({ cls: "fw3-side-g" });
		tip(g.createEl("h2", { text: "나온 프로젝트" }), "프로젝트 허브의 `flywheel`에 이 요소가 적힌 프로젝트예요.");
		for (const p of s.projects) {
			const b = g.createEl("button", { cls: "fw3-link", text: `${p.title}${p.status ? ` · ${p.status}` : ""}`, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.close();
				void this.plugin.openProjectAt(p.path);
			});
		}
	}

	private renderFiles(side: HTMLElement, s: ElementStats): void {
		const g = side.createDiv({ cls: "fw3-side-g is-last" });
		g.createEl("h2", { text: "작업 자료" });
		const group = (label: string, files: ElementFile[], open: boolean, sub?: (f: ElementFile) => string) => {
			const det = g.createEl("details", { cls: "fw3-files" });
			det.open = open && files.length > 0;
			det.createEl("summary", { text: files.length ? `${label} ${files.length}` : label });
			if (!files.length) det.createDiv({ cls: "fw3-faint fw3-small", text: "비어 있어요" });
			let last = "\u0000";
			for (const f of files.slice(0, 40)) {
				const k = sub?.(f) ?? "";
				if (sub && k !== last) {
					det.createDiv({ cls: "fw3-files-sub", text: k || "(바로 아래)" });
					last = k;
				}
				const b = det.createEl("button", { cls: "fw3-link", text: f.kind === "record" ? f.name.replace(/^.* 기록 /, "기록 ") : f.title, attr: { type: "button" } });
				b.addEventListener("click", () => void this.openPath(f.path));
			}
		};
		group("기록", s.files.filter((f) => f.kind === "record"), true);
		group("초안", s.drafts, true);
		group("산출물", s.outputs, false);
		group(
			"작업실",
			s.files.filter((f) => f.kind === "work" || f.kind === "doc" || f.kind === "weekly").sort((a, b) => (a.group + a.kind).localeCompare(b.group + b.kind) || b.name.localeCompare(a.name)),
			true,
			(f) => (f.kind === "weekly" ? `${f.group} · 주간` : f.group),
		);
	}

	// ── actions ──

	private async openPath(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) {
			new Notice("아직 파일이 없어요.");
			return;
		}
		this.close();
		await this.app.workspace.getLeaf("tab").openFile(f);
	}

	private menu(ev: MouseEvent, e: FlywheelElement): void {
		const m = new Menu();
		m.addItem((i) => i.setTitle("방법 고치기…").setIcon("pencil").onClick(() => void this.editMethod(e)));
		m.addItem((i) => i.setTitle("이름 바꾸기…").setIcon("text-cursor-input").onClick(() => void this.rename(e)));
		m.addItem((i) => i.setTitle("허브 원문 열기").setIcon("file-text").onClick(() => void this.openPath(e.hubPath)));
		m.addItem((i) => i.setTitle("커버 이미지 바꾸기…").setIcon("image").onClick(() => this.pickCover(e)));
		if (e.cover) m.addItem((i) => i.setTitle("커버 이미지 빼기").setIcon("image-off").onClick(() => void this.run(() => setCover(this.plugin, e, ""))));
		m.addSeparator();
		m.addItem((i) => i.setTitle("폐기…").setIcon("trash-2").setWarning(true).onClick(() => void this.retire(e)));
		m.showAtMouseEvent(ev);
	}

	private pickCover(e: FlywheelElement): void {
		new CoverPicker(this.app, (f) => void this.run(() => setCover(this.plugin, e, f.path))).open();
	}

	private statusMenu(ev: MouseEvent, e: FlywheelElement): void {
		const m = new Menu();
		for (const st of ["사용", "쉼"] as const) {
			m.addItem((i) =>
				i
					.setTitle(st === "사용" ? "사용 — 매일 돌림" : "쉼 — 잠시 멈춤")
					.setChecked(e.status === st)
					.onClick(() => void this.run(() => changeElement(this.plugin, e, `${e.id} ${e.name} ${st === "쉼" ? "쉼" : "다시 사용"}`, { hub: (t) => setHubFm(t, "status", st, todayIso()) }))),
			);
		}
		m.showAtMouseEvent(ev);
	}

	private async editMethod(e: FlywheelElement): Promise<void> {
		const val = (k: string) => (isPlaceholder(e.fields[k]) ? "" : (e.fields[k] ?? "").replace(/^→\s*/, ""));
		const v = await askForm(this.app, {
			title: `${e.name} 방법`,
			desc: "방법은 언제든 고칠 수 있어요.",
			fields: [
				{ key: "정체성", label: "정체성", type: "text", value: val("정체성"), placeholder: "나는 매일 ~하는 사람이다" },
				{ key: "최소", label: "최소", type: "text", value: val("최소"), desc: "바쁜 날 버전. 2분이면 되는 것. 이걸 하면 했음이에요.", placeholder: "예: 걷기 15분" },
				{ key: "보통", label: "보통", type: "text", value: val("보통"), placeholder: "예: 달리기 5km" },
				{ key: "다음", label: "다음", type: "text", value: val("다음"), desc: "이게 돌면 무엇이 좋아지나요? 다른 요소면 그 이름부터.", placeholder: "예: 책 읽기 · 체력이 있어야 저녁에 읽는다" },
			],
		});
		if (!v) return;
		const els = this.d?.wheel.elements ?? [];
		await this.run(() =>
			changeElement(this.plugin, e, `${e.id} ${e.name} 방법 갱신`, {
				hub: (t) => {
					let out = t;
					for (const k of METHOD_KEYS) {
						if (v[k] === val(k)) continue;
						let value = v[k];
						if (k === "다음" && value) {
							const to = els.find((x) => value.startsWith(x.name));
							value = to ? `→ ${to.id} ${value.slice(to.name.length).replace(/^\s*[·:-]?\s*/, "")}` : `→ ${value}`;
						}
						out = setHubMethod(out, k, value);
					}
					return setHubFm(out, "updated", todayIso(), todayIso());
				},
			}),
		);
	}

	private async editSection(e: FlywheelElement, heading: string, cur: string): Promise<void> {
		const v = await askForm(this.app, { title: heading, fields: [{ key: "t", label: heading, type: "textarea", value: cur }] });
		if (!v) return;
		await this.run(() => changeElement(this.plugin, e, `${e.id} ${heading} 고침`, { hub: (t) => setHubFm(setHubSection(t, heading, v.t), "updated", todayIso(), todayIso()) }));
	}

	private async addDecision(e: FlywheelElement, cur: string): Promise<void> {
		const v = await askForm(this.app, {
			title: "주요 결정 남기기",
			fields: [{ key: "t", label: "결정. 이유", type: "text", value: "", placeholder: "예: 뉴스레터는 격주로. 매주는 최소 행동이 너무 커진다" }],
			validate: (x) => (x.t ? [] : ["내용을 적어 주세요."]),
		});
		if (!v) return;
		const line = `- ${todayIso()} — ${v.t.replace(/[\r\n]+/g, " ")}`;
		await this.run(() => changeElement(this.plugin, e, `${e.id} 주요 결정`, { hub: (t) => setHubFm(setHubSection(t, DECISIONS_SECTION, [line, cur].filter(Boolean).join("\n")), "updated", todayIso(), todayIso()) }));
	}

	private async rename(e: FlywheelElement): Promise<void> {
		const v = await askForm(this.app, {
			title: "이름 바꾸기",
			desc: "폴더·허브·기록 파일 이름이 함께 바뀌고 링크도 따라가요.",
			fields: [{ key: "n", label: "새 이름", type: "text", value: e.name }],
			validate: (x) => (x.n ? [] : ["이름을 적어 주세요."]),
		});
		if (!v || v.n === e.name) return;
		await this.run(() => renameElement(this.plugin, e, v.n));
	}

	private async retire(e: FlywheelElement): Promise<void> {
		const ok = await askForm(this.app, {
			title: `「${e.name}」 폐기`,
			desc: "요소 교체(추가·폐기)는 분기에 한 번 이하로 해요. 잠시 멈추는 거라면 「쉼」이 맞아요. 폴더·기록·산출물은 그대로 남고 목표 연결은 풀려요.",
			fields: [],
			cta: "폐기",
		});
		if (!ok) return;
		const goals = e.goals;
		await this.run(() =>
			changeElement(this.plugin, e, `요소 교체: ${e.id} ${e.name} 폐기`, { hub: (t) => setHubFm(setHubFm(t, "status", "폐기", todayIso()), "goals", [], todayIso()) }),
		);
		if (goals.length) await this.refreshPinboardIndex(goals);
	}

	private async newOutput(e: FlywheelElement, post: boolean): Promise<void> {
		const fields: Parameters<typeof askForm>[1]["fields"] = [];
		if (post) {
			fields.push({ key: "ch", label: "채널", type: "text", value: this.channel && this.channel !== "-" ? this.channel : (e.channels[0] ?? ""), list: e.channels, placeholder: "예: 인스타그램" });
		}
		fields.push({ key: "title", label: "제목", type: "text", value: "", placeholder: "파일 이름이 돼요" });
		const v = await askForm(this.app, {
			title: post ? "새 게시물" : "새 산출물",
			desc: post ? "「02 산출물/채널/」에 만들어요. 발행하면 published와 url을 채워요." : "「02 산출물/」에 만들어요.",
			fields,
			cta: "만들기",
			validate: (x) => [...(x.title ? [] : ["제목을 적어 주세요."]), ...(post && !x.ch ? ["채널을 적어 주세요."] : [])],
		});
		if (!v) return;
		await this.run(async () => {
			const f = await createOutput(this.plugin, e, post ? v.ch : "", v.title, []);
			this.close();
			await this.app.workspace.getLeaf("tab").openFile(f);
		});
	}
}

/** Any image in the vault; the Flywheel image folder first. */
class CoverPicker extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly onPick: (f: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("커버로 쓸 이미지 (12 Flywheel/99 작업실/images 먼저)");
	}
	getItems(): TFile[] {
		const own = (f: TFile) => (f.path.startsWith("12 Flywheel/") ? 0 : 1);
		return this.app.vault
			.getFiles()
			.filter((f) => IMAGE_EXT.includes(f.extension.toLowerCase()))
			.sort((a, b) => own(a) - own(b) || a.path.localeCompare(b.path));
	}
	getItemText(f: TFile): string {
		return f.path;
	}
	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}
