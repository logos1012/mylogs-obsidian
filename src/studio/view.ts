/**
 * 콘텐츠 스튜디오 (`mylogs-studio`, 「콘텐츠 스튜디오 설계 v3」) — 퍼스널 브랜딩 only, opened from
 * its Flywheel card. Tabs: 글감 · 보드 · 예약 · 소스; a post opens the channel editor in place.
 *
 *   글감   후보 (소스를 훑음, 파일 안 생김) · ✦ 루미에게 찾기 · 글감함
 *   보드   글감 → 초안 → 다듬기 → 미디어 → 예약 → 발행 (끌어서 `stage`)
 *   예약   주 × 채널 표 + 목록 (보냄 · 발행 · 실패)
 *   소스   글감 소스 등록부
 */

import { debounce, ItemView, Menu, moment, Notice, setIcon, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { mountAppNav } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";
import { askForm, confirmDelete } from "../ui/modals.ts";
import { coverSrc } from "../flywheel/actions.ts";
import { openLumi } from "../lumi/register.ts";
import { lumiBus } from "./bus.ts";
import { AmpScreen } from "./amp-view.ts";
import { chooseFiles, dropZone, pickMedia, thumb, uploadFiles } from "./media.ts";
import {
	blocksNow,
	type Candidate,
	captionOut,
	type ChannelDef,
	channelByKey,
	CHANNELS,
	charCount,
	defaultSchedule,
	fastPollEvery,
	formatPollSummary,
	FORMATS,
	type GlgamLine,
	HASHTAG_MAX,
	isStage,
	type Post,
	postProblems,
	postState,
	type PostStateKind,
	scheduledInstant,
	PRIVATE_HINT,
	type Source,
	type SourceUnit,
	type Stage,
	STAGES,
	strategyPath,
	type ThreadPart,
	threadsTextLength,
	threadsUploadProblem,
} from "./model.ts";
import {
	addManualGlgam,
	cancelSchedule,
	channelEndpoint,
	createPost,
	deletePost,
	dropGlgam,
	ensureIds,
	linkKeyOf,
	loadStudio,
	markPublished,
	openPath,
	patchPost,
	pickCandidate,
	pickedLinks,
	pollResults,
	quoteOf,
	renamePost,
	saveSources,
	scanCandidates,
	sendNow,
	sendSchedule,
	type StudioData,
} from "./store.ts";
import { loadSecrets, s3Config } from "./settings.ts";
import { publicPrefix } from "./s3.ts";

export const VIEW_TYPE_STUDIO = "mylogs-studio";

type Tab = "glgam" | "board" | "sched" | "src";
const TABS: [Tab, string][] = [["glgam", "글감"], ["board", "보드"], ["sched", "예약"], ["src", "소스"]];
const SRC_LABEL: Record<string, string> = { daily: "Daily Pad", fw: "Flywheel 기록", news: "AI 뉴스", wiki: "LLM Wiki", diary: "Diary", session: "AI 대화", hand: "직접", lumi: "✦ 루미" };
const CH_MARK: Record<string, string> = { li: "in", th: "@", ig: "◎" };
const ROUTE: Record<string, string> = { li: "API Gateway → Lambda", th: "API Gateway → Threads", ig: "API Gateway → Lambda" };

const err = (e: unknown) => new Notice(`MyLogs: ${e instanceof Error ? e.message : String(e)}`, 10000);
const md = (iso: string) => (iso ? moment(iso, "YYYY-MM-DD").format("M/D") : "");

export class StudioView extends ItemView {
	plugin: MyLogsPlugin;
	private rootEl!: HTMLElement;
	private d: StudioData | null = null;
	private tab: Tab = "glgam";
	private editing: string | null = null;
	private draft: Post | null = null;
	private cands: Candidate[] = [];
	private srcFilter = "";
	private q = "";
	private boardCh = "";
	private boardKind: "all" | PostStateKind = "all";
	private week = moment().startOf("isoWeek").format("YYYY-MM-DD");
	private seq = 0;
	private busy = false;
	private quiet = 0;
	private idsChecked = false;
	private igSlide = 0;
	private saveBody = debounce(() => void this.flushBody(), 700, true);

	constructor(leaf: WorkspaceLeaf, plugin: MyLogsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_STUDIO;
	}
	getDisplayText(): string {
		return "콘텐츠 스튜디오";
	}
	getIcon(): string {
		return "pen-tool";
	}
	lumiItem(): string | undefined {
		return this.draft ? `${this.draft.channel.name} 게시물 「${this.draft.title}」` : "퍼스널 브랜딩 콘텐츠 스튜디오";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("mylogs-studio-container");
		this.rootEl = this.contentEl.createDiv({ cls: "mylogs-studio st" });
		mountAppNav(this);
		const later = debounce(() => void this.refresh(), 600, true);
		const watch = (f: TAbstractFile, old?: string) => {
			if (Date.now() < this.quiet) return;
			const root = this.d?.root;
			if (!root) {
				later();
				return;
			}
			if ([f.path, old ?? ""].some((p) => p.startsWith(`${root}/`) || p.startsWith(this.plugin.settings.flywheelPath + "/"))) later();
		};
		this.registerEvent(this.app.vault.on("modify", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("create", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => watch(f)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => watch(f, old)));
		this.register(lumiBus.on(() => this.tab === "glgam" && !this.editing && this.render()));
		this.register(() => this.stopFastPoll());
		this.registerInterval(window.setInterval(() => void this.poll(false), 10 * 60_000));
		await this.refresh(true);
		void this.poll(false);
	}

	async onClose(): Promise<void> {
		this.stopFastPoll();
		await this.amp?.flush();
		this.amp?.stop();
		await this.flushBody();
		this.contentEl.empty();
	}

	/** Our own writes should not redraw the editor under the cursor. */
	private hush(ms = 1500): void {
		this.quiet = Date.now() + ms;
	}

	async refresh(rescan = false): Promise<void> {
		const seq = ++this.seq;
		try {
			const d = await loadStudio(this.plugin);
			if (seq !== this.seq) return;
			if (d && !this.idsChecked) {
				this.idsChecked = true;
				if (await ensureIds(this.plugin, d)) return void this.refresh(rescan);
			}
			this.d = d;
			if (d && (rescan || !this.cands.length)) this.cands = await scanCandidates(this.plugin, d, this.plugin.settings.studioDays);
			if (this.editing) {
				const p = d?.posts.find((x) => x.path === this.editing);
				if (!p) this.editing = null;
				else this.draft = p;
			}
			if (this.amp) {
				if (!d?.posts.some((x) => x.path === this.amp!.path)) this.amp = null;
				else await this.amp.load();
			}
			this.render();
			this.syncFastPoll();
		} catch (e) {
			console.error("[MyLogs] studio load failed", e);
			this.rootEl.empty();
			this.rootEl.createDiv({ cls: "st-empty", text: "스튜디오를 읽지 못했어요. 콘솔을 확인해 주세요." });
		}
	}

	private fastPoll: number | null = null;

	private stopFastPoll(): void {
		if (this.fastPoll != null) window.clearInterval(this.fastPoll);
		this.fastPoll = null;
	}

	/** 90s while a sent post is past `scheduled` and still unpublished. Board, editor, and 글 증폭 share this view. */
	private syncFastPoll(): void {
		const every = this.d ? fastPollEvery(this.d.posts) : null;
		if (every && this.fastPoll == null) this.fastPoll = window.setInterval(() => void this.poll(false, true), every);
		else if (!every) this.stopFastPoll();
	}

	/** Command palette and the editor button. */
	async readResults(): Promise<void> {
		if (!this.d) await this.refresh();
		await this.poll(true);
	}

	private async poll(force: boolean, bypassThrottle = false): Promise<void> {
		if (!this.d) return;
		try {
			const r = await pollResults(this.plugin, this.d, force, { bypassThrottle: force || bypassThrottle });
			if (r.changed) await this.refresh();
			else this.syncFastPoll();
			if (force) announcePoll(r);
		} catch (e) {
			console.error("[MyLogs] studio results", e);
			if (force) err(e);
		}
	}

	private async run(fn: () => Promise<unknown>, rescan = false): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			await fn();
		} catch (e) {
			err(e);
		} finally {
			this.busy = false;
		}
		await this.refresh(rescan);
	}

	private amp: AmpScreen | null = null;

	async openAmp(path: string): Promise<void> {
		await this.flushBody();
		const a = new AmpScreen(
			{
				plugin: this.plugin,
				hush: (ms) => this.hush(ms),
				rerender: () => this.render(),
				readResults: () => void this.readResults(),
				exit: () => {
					this.amp = null;
					void this.refresh();
				},
			},
			path,
		);
		await a.load();
		this.amp = a;
		this.render();
		this.contentEl.scrollTop = 0;
	}

	openPost(path: string): void {
		this.amp = null;
		this.editing = path;
		this.draft = this.d?.posts.find((p) => p.path === path) ?? null;
		this.igSlide = 0;
		this.render();
		this.contentEl.scrollTop = 0;
	}

	// ── render ──

	private render(): void {
		const root = this.rootEl;
		const scroll = this.contentEl.scrollTop;
		root.empty();
		const d = this.d;
		if (!d) {
			const e = root.createDiv({ cls: "st-empty" });
			e.createEl("h2", { text: "스튜디오를 쓰는 Flywheel 요소가 없어요" });
			e.createEl("p", { text: "요소 허브 frontmatter에 `workspace: studio`를 적으면 그 요소의 스튜디오가 열려요." });
			return;
		}
		if (this.amp) {
			this.amp.render(root, d);
			this.contentEl.scrollTop = scroll;
			return;
		}
		if (this.editing && this.draft) {
			this.renderEditor(root, d, this.draft);
			this.contentEl.scrollTop = scroll;
			return;
		}
		this.renderHead(root, d);
		if (this.tab === "glgam") this.renderGlgam(root, d);
		else if (this.tab === "board") this.renderBoard(root, d);
		else if (this.tab === "sched") this.renderSched(root, d);
		else this.renderSources(root, d);
		this.contentEl.scrollTop = scroll;
	}

	private renderHead(root: HTMLElement, d: StudioData): void {
		const head = root.createDiv({ cls: "st-head" });
		const cover = coverSrc(this.app, d.e);
		const cv = head.createDiv({ cls: "st-cover" });
		if (cover) cv.createEl("img", { attr: { src: cover, alt: "", draggable: "false" } });
		const t = head.createDiv({ cls: "st-grow" });
		t.createEl("h1", { text: `${d.e.name} 스튜디오` });
		const sub = t.createDiv({ cls: "st-sub" });
		const back = sub.createEl("button", { cls: "st-link", text: "← Flywheel", attr: { type: "button" } });
		back.addEventListener("click", () => void this.leaf.setViewState({ type: "mylogs-flywheel", active: true }));
		const open = d.glgam.filter((g) => g.mark === " ").length;
		const wk = moment().startOf("isoWeek");
		const thisWeek = d.posts.filter((p) => p.scheduled && moment(p.scheduled, "YYYY-MM-DD HH:mm").isSame(wk, "isoWeek")).length;
		const kpis = head.createDiv({ cls: "st-kpis" });
		const kpi = (k: string, v: string) => {
			const b = kpis.createDiv({ cls: "st-kpi" });
			b.createDiv({ cls: "st-k", text: k });
			b.createDiv({ cls: "st-v", text: v });
		};
		kpi(`새 후보 (${this.plugin.settings.studioDays}일)`, String(this.visibleCands(d).length));
		kpi("글감", String(open));
		kpi("이번 주 예약", String(thisWeek));
		const tabs = root.createDiv({ cls: "st-tabs" });
		for (const [k, label] of TABS) {
			const b = tabs.createEl("button", { cls: k === this.tab ? "is-on" : "", attr: { type: "button" } });
			b.appendText(label);
			const n = k === "glgam" ? open : k === "board" ? d.posts.filter((p) => p.stage !== "발행").length : k === "src" ? d.sources.length : 0;
			if (n) b.createSpan({ cls: "st-n", text: String(n) });
			b.addEventListener("click", () => {
				this.tab = k;
				this.render();
			});
		}
		tabs.createDiv({ cls: "st-grow" });
		const more = tabs.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "스튜디오 메뉴" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (ev) => {
			const m = new Menu();
			m.addItem((i) => i.setTitle("발행 결과 지금 읽기").setIcon("refresh-cw").onClick(() => void this.poll(true)));
			m.addItem((i) => i.setTitle("후보 다시 훑기").setIcon("scan-search").onClick(() => void this.refresh(true)));
			m.addItem((i) => i.setTitle("요소 허브 열기").setIcon("file-text").onClick(() => void openPath(this.plugin, d.e.hubPath)));
			m.showAtMouseEvent(ev);
		});
	}

	// ── 글감 ──

	private visibleCands(d: StudioData): Candidate[] {
		const dismissed = new Set(this.plugin.settings.studioDismissed);
		return this.cands.filter((c) => !dismissed.has(c.key) && d.sources.some((s) => s.key === c.source && s.on));
	}

	private renderGlgam(root: HTMLElement, d: StudioData): void {
		const wrap = root.createDiv({ cls: "st-gl" });
		const left = wrap.createDiv();
		const right = wrap.createDiv();

		const bar = left.createDiv({ cls: "st-row st-wrap st-toolbar" });
		const seg = bar.createDiv({ cls: "st-seg" });
		for (const n of [7, 14, 30]) {
			const b = seg.createEl("button", { cls: n === this.plugin.settings.studioDays ? "is-on" : "", text: `${n}일`, attr: { type: "button" } });
			b.addEventListener("click", async () => {
				this.plugin.settings.studioDays = n;
				await this.plugin.saveSettings();
				await this.refresh(true);
			});
		}
		const q = bar.createEl("input", { cls: "st-search", attr: { type: "search", placeholder: "찾기…" } });
		q.value = this.q;
		q.addEventListener("input", () => {
			this.q = q.value;
			this.renderCands(grid, d);
		});
		bar.createDiv({ cls: "st-grow" });
		const hand = bar.createEl("button", { cls: "st-btn", text: "＋ 직접 적기", attr: { type: "button" } });
		hand.addEventListener("click", () => void this.addHand(d));

		this.renderLumi(left, d);

		const all = this.visibleCands(d);
		const chips = left.createDiv({ cls: "st-chips st-srcchips" });
		const chip = (key: string, label: string, n: number) => {
			const b = chips.createEl("button", { cls: key === this.srcFilter ? "is-on" : "", attr: { type: "button" } });
			if (key) b.createSpan({ cls: `st-sb s-${key}`, text: label });
			else b.appendText(label);
			b.createSpan({ cls: "st-n", text: String(n) });
			b.addEventListener("click", () => {
				this.srcFilter = key;
				this.render();
			});
		};
		chip("", "전체", all.length);
		for (const s of d.sources) if (s.on && s.unit !== "루미") chip(s.key, s.name, all.filter((c) => c.source === s.key).length);
		const grid = left.createDiv({ cls: "st-cands" });
		this.renderCands(grid, d);

		this.renderGlgamBox(right, d);
	}

	private renderLumi(left: HTMLElement, d: StudioData): void {
		const box = left.createDiv({ cls: "st-lumi" });
		const ic = box.createSpan({ cls: "st-lm" });
		setIcon(ic, "sparkles");
		const input = box.createEl("input", { attr: { type: "text", placeholder: "루미에게: 예) 지난 2주 AI 대화에서 독서 모임 운영하면서 내가 깨달은 것" } });
		input.value = lumiBus.query;
		const go = box.createEl("button", { cls: "st-btn mod-cta", text: lumiBus.waiting ? "찾는 중…" : "루미에게 찾기", attr: { type: "button" } });
		const ask = () => {
			const v = input.value.trim();
			if (!v) return;
			void this.askLumi(v);
		};
		go.addEventListener("click", ask);
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" && !ev.isComposing) ask();
		});
		if (!lumiBus.results.length && !lumiBus.waiting) return;
		const res = left.createDiv({ cls: "st-lumires" });
		const hd = res.createDiv({ cls: "st-row" });
		hd.createEl("b", { text: lumiBus.waiting ? "✦ 루미가 찾는 중…" : `✦ 루미가 찾은 후보 ${lumiBus.results.length}` });
		hd.createSpan({ cls: "st-grow st-tiny st-faint", text: " 고르기 전엔 어디에도 저장되지 않아요" });
		const x = hd.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "닫기" } });
		setIcon(x, "x");
		x.addEventListener("click", () => lumiBus.clear());
		const g = res.createDiv({ cls: "st-cands" });
		const picked = pickedLinks(d);
		for (const c of lumiBus.results) this.candCard(g, d, c, picked, true);
	}

	private async askLumi(query: string): Promise<void> {
		if (!this.plugin.lumi?.available) return void new Notice("루미는 데스크톱 앱에서만 쓸 수 있어요.");
		lumiBus.ask(query);
		const src = this.d?.sources.filter((s) => s.on).map((s) => `${s.name}(${s.path}/)`).join(", ");
		await openLumi(this.plugin, this);
		await this.plugin.lumi.active.send(
			[
				`[콘텐츠 스튜디오 · 글감 찾기] ${query}`,
				"",
				`볼트에서 위 조건에 맞는 글감 후보를 찾아 줘. 특히 10 Archive Box/Sessions/ 의 AI 대화 세션을 봐 줘. 다른 소스: ${src ?? ""}.`,
				"- 사용자(나)가 직접 한 말만, 원문 그대로 짧게(한두 문장) 인용해. AI가 한 말이나 요약은 넣지 마.",
				"- 최대 8개. 각 후보에 그 파일의 볼트 경로, 인용, 왜 골랐는지 한 줄, 날짜(YYYY-MM-DD).",
				"- 찾은 뒤 studio_candidates 도구 한 번으로 보내. 파일은 쓰지 마.",
			].join("\n"),
		);
	}

	private renderCands(grid: HTMLElement, d: StudioData): void {
		grid.empty();
		const q = this.q.trim().toLowerCase();
		const shown = this.visibleCands(d).filter((c) => (!this.srcFilter || c.source === this.srcFilter) && (!q || c.text.toLowerCase().includes(q)));
		if (!shown.length) {
			grid.createDiv({ cls: "st-faint st-pad", text: this.cands.length ? "맞는 후보가 없어요." : "이 기간에 새 후보가 없어요." });
			return;
		}
		const picked = pickedLinks(d);
		for (const c of shown.slice(0, 120)) this.candCard(grid, d, c, picked, false);
		if (shown.length > 120) grid.createDiv({ cls: "st-faint st-small", text: `… ${shown.length - 120}개 더 (찾기로 좁혀 주세요)` });
	}

	private candCard(grid: HTMLElement, d: StudioData, c: Candidate, picked: Set<string>, fromLumi: boolean): void {
		const lk = linkKeyOf(c);
		const isPicked = !!lk && picked.has(lk);
		const card = grid.createDiv({ cls: `st-cand${isPicked ? " is-picked" : ""}` });
		const meta = card.createDiv({ cls: "st-meta" });
		meta.createSpan({ cls: `st-sb s-${c.source}`, text: SRC_LABEL[c.source] ?? d.sources.find((s) => s.key === c.source)?.name ?? c.source });
		meta.createSpan({ text: `${md(c.date)}${c.where ? ` · ${c.where}` : ""}` });
		meta.createDiv({ cls: "st-grow" });
		const o = meta.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "원문" } });
		setIcon(o, "arrow-up-right");
		o.addEventListener("click", () => void openPath(this.plugin, c.path));
		card.createDiv({ cls: "st-txt", text: c.text });
		if (c.why) card.createDiv({ cls: fromLumi ? "st-why" : "st-ctx", text: c.why });
		if (PRIVATE_HINT.test(c.text)) card.createDiv({ cls: "st-flag", text: "채널 전략: 가족·사생활·회사 일은 소재로 쓰지 않음 — 확인" });
		const acts = card.createDiv({ cls: "st-acts" });
		if (isPicked) {
			acts.createSpan({ cls: "st-pill is-ok", text: "✓ 글감" });
			return;
		}
		const pick = acts.createEl("button", { cls: "st-btn mod-cta is-sm", text: "글감으로", attr: { type: "button" } });
		pick.addEventListener("click", () =>
			void this.run(async () => {
				await pickCandidate(this.plugin, d, c);
				if (fromLumi) lumiBus.drop(c.key);
			}, true),
		);
		const no = acts.createEl("button", { cls: "st-btn is-ghost is-sm", text: "안 씀", attr: { type: "button" } });
		no.addEventListener("click", async () => {
			if (fromLumi) return lumiBus.drop(c.key);
			const s = this.plugin.settings;
			s.studioDismissed = [...s.studioDismissed.filter((k) => k !== c.key), c.key].slice(-3000);
			await this.plugin.saveSettings();
			this.render();
		});
	}

	private renderGlgamBox(right: HTMLElement, d: StudioData): void {
		const box = right.createDiv({ cls: "st-box" });
		const h = box.createEl("h2");
		h.appendText("글감함 ");
		const open = d.glgam.filter((g) => g.mark === " ");
		h.createSpan({ cls: "st-pill", text: String(open.length) });
		box.createDiv({ cls: "st-tiny st-faint", text: `03 글감/글감 ${d.today.slice(0, 7)}.md` });
		if (!open.length) box.createDiv({ cls: "st-faint st-small st-pad", text: "왼쪽 후보에서 「글감으로」를 누르면 여기에 모여요." });
		for (const g of open) this.glgamItem(box, d, g);
		const done = d.glgam.filter((g) => g.mark === ">").slice(0, 8);
		if (done.length) {
			const det = box.createEl("details", { cls: "st-done" });
			det.createEl("summary", { text: `글로 쓴 글감 ${d.glgam.filter((g) => g.mark === ">").length}` });
			for (const g of done) this.glgamItem(det, d, g);
		}
	}

	private glgamItem(parent: HTMLElement, d: StudioData, g: GlgamLine): void {
		const it = parent.createDiv({ cls: `st-gitem${g.mark === ">" ? " is-done" : ""}` });
		it.createSpan({ cls: `st-cb${g.mark === ">" ? " is-moved" : ""}` });
		const body = it.createDiv({ cls: "st-grow" });
		body.createDiv({ cls: "st-t", text: g.text });
		const mk = body.createDiv({ cls: "st-mk" });
		mk.createSpan({ cls: `st-sb s-${g.src}`, text: SRC_LABEL[g.src] ?? g.src });
		if (g.from.length > 1) mk.createSpan({ cls: "st-faint st-tiny", text: `출처 ${g.from.length}` });
		for (const p of g.posts) {
			const post = d.posts.find((x) => x.path.replace(/\.md$/, "") === p);
			if (!post) continue;
			const b = mk.createEl("button", { cls: `st-ch c-${post.channel.key}`, text: `${post.channel.name} · ${post.stage}`, attr: { type: "button" } });
			b.addEventListener("click", () => this.openPost(post.path));
		}
		mk.createDiv({ cls: "st-grow" });
		if (g.mark === " ") {
			const draft = mk.createEl("button", { cls: "st-btn is-sm", text: "초안 ▾", attr: { type: "button" } });
			draft.addEventListener("click", (ev) => this.draftMenu(ev, d, g));
		}
		const more = mk.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "글감 메뉴" } });
		setIcon(more, "more-horizontal");
		more.addEventListener("click", (ev) => {
			const m = new Menu();
			if (g.mark === ">") m.addItem((i) => i.setTitle("다른 채널 초안 만들기").setIcon("plus").onClick(() => this.draftMenu(ev, d, g)));
			for (const f of g.from) m.addItem((i) => i.setTitle(`원문: ${f.split("/").pop()}`).setIcon("arrow-up-right").onClick(() => void this.app.workspace.openLinkText(f, g.file, "tab")));
			if (g.mark === " ")
				m.addItem((i) =>
					i
						.setTitle("버리기…")
						.setIcon("x")
						.onClick(async () => {
							const v = await askForm(this.app, { title: "글감 버리기", fields: [{ key: "why", label: "이유 (선택)", type: "text", value: "", placeholder: "예: 지금 주제와 안 맞음" }], cta: "버리기" });
							if (v) await this.run(() => dropGlgam(this.plugin, g, v.why || "안 씀"));
						}),
				);
			m.showAtMouseEvent(ev);
		});
	}

	private draftMenu(ev: MouseEvent, d: StudioData, g: GlgamLine): void {
		const m = new Menu();
		for (const ch of CHANNELS) m.addItem((i) => i.setTitle(`${ch.name} 초안`).onClick(() => void this.newPost(d, ch, g)));
		m.showAtMouseEvent(ev);
	}

	private async newPost(d: StudioData, ch: ChannelDef, g: GlgamLine | null, title?: string): Promise<void> {
		let t = title;
		if (!t) {
			const v = await askForm(this.app, { title: `${ch.name} 초안`, fields: [{ key: "t", label: "제목 (파일 이름)", type: "text", value: g ? g.text.slice(0, 40) : "", placeholder: "글의 가제" }], cta: "만들기", validate: (x) => (x.t ? [] : ["제목을 적어 주세요."]) });
			if (!v) return;
			t = v.t;
		}
		let path = "";
		await this.run(async () => {
			path = (await createPost(this.plugin, d, ch, t!, g)).path;
		});
		if (path) this.openPost(path);
	}

	private async addHand(d: StudioData): Promise<void> {
		const v = await askForm(this.app, { title: "글감 직접 적기", desc: "떠오른 것, 남의 글 링크. 글감함에 한 줄로 들어가요.", fields: [{ key: "t", label: "글감", type: "textarea", value: "" }], cta: "넣기" });
		if (v?.t) await this.run(() => addManualGlgam(this.plugin, d, v.t));
	}

	// ── 보드 ──

	private renderBoard(root: HTMLElement, d: StudioData): void {
		const chips = root.createDiv({ cls: "st-chips st-boardch" });
		for (const [k, label] of [["", "전체 채널"], ...CHANNELS.map((c) => [c.key, c.name])]) {
			const b = chips.createEl("button", { cls: k === this.boardCh ? "is-on" : "", text: label, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.boardCh = k;
				this.render();
			});
		}
		const kinds: ["all" | PostStateKind, string][] = [["all", "전체"], ["before", "예약 전"], ["scheduled", "예약됨"], ["going", "발행 중"], ["published", "발행됨"], ["failed", "실패"], ["cancelled", "취소됨"]];
		const stateRow = root.createDiv({ cls: "st-chips st-statechips" });
		for (const [k, label] of kinds) {
			const b = stateRow.createEl("button", { cls: k === this.boardKind ? "is-on" : "", text: label, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.boardKind = k;
				this.render();
			});
		}
		const inCh = d.posts.filter((p) => !this.boardCh || p.channel.key === this.boardCh);
		const nSched = inCh.filter((p) => postState(p).kind === "scheduled").length;
		const nFail = inCh.filter((p) => postState(p).kind === "failed").length;
		stateRow.createSpan({ cls: "st-statecount", text: `예약됨 ${nSched} · 실패 ${nFail}` });
		const board = root.createDiv({ cls: "st-board" });
		const weekAgo = moment().subtract(7, "days").format("YYYY-MM-DD");
		const posts = d.posts.filter((p) => (!this.boardCh || p.channel.key === this.boardCh) && (this.boardKind === "all" || postState(p).kind === this.boardKind));
		const col = (key: string, label: string, hint: string) => {
			const c = board.createDiv({ cls: "st-col" });
			const h = c.createEl("h3");
			h.appendText(label);
			const list = c.createDiv({ cls: "st-col-list" });
			c.dataset.stage = key;
			c.addEventListener("dragover", (ev) => {
				ev.preventDefault();
				c.addClass("is-drop");
			});
			c.addEventListener("dragleave", () => c.removeClass("is-drop"));
			c.addEventListener("drop", (ev) => {
				ev.preventDefault();
				c.removeClass("is-drop");
				const raw = ev.dataTransfer?.getData("text/x-studio") ?? "";
				void this.dropOn(ev, d, key, raw);
			});
			return { list, h, hint };
		};
		const gl = col("글감", "글감", "줄");
		const open = d.glgam.filter((g) => g.mark === " ");
		gl.h.createSpan({ cls: "st-n", text: String(open.length) });
		for (const g of open) {
			const card = gl.list.createDiv({ cls: "st-pc", attr: { draggable: "true" } });
			card.createDiv({ cls: "st-t", text: g.text });
			card.createDiv({ cls: "st-m" }).createSpan({ cls: `st-sb s-${g.src}`, text: SRC_LABEL[g.src] ?? g.src });
			card.addEventListener("dragstart", (ev) => ev.dataTransfer?.setData("text/x-studio", `g|${g.file}|${g.line}`));
			card.addEventListener("click", (ev) => this.draftMenu(ev, d, g));
			card.addEventListener("contextmenu", (ev) => {
				ev.preventDefault();
				const m = new Menu();
				m.addItem((i) => i.setTitle("초안 만들기…").setIcon("plus").onClick(() => this.draftMenu(ev, d, g)));
				m.addItem((i) =>
					i
						.setTitle("버리기…")
						.setIcon("x")
						.onClick(async () => {
							const v = await askForm(this.app, { title: "글감 버리기", fields: [{ key: "why", label: "이유 (선택)", type: "text", value: "", placeholder: "예: 지금 주제와 안 맞음" }], cta: "버리기" });
							if (v) await this.run(() => dropGlgam(this.plugin, g, v.why || "안 씀"));
						}),
				);
				m.showAtMouseEvent(ev);
			});
		}
		for (const st of STAGES) {
			const c = col(st, st, "");
			const list = posts.filter((p) => p.stage === st && (st !== "발행" || (p.published || "") >= weekAgo)).sort((a, b) => (a.scheduled || a.date).localeCompare(b.scheduled || b.date));
			c.h.createSpan({ cls: "st-n", text: String(list.length) });
			if (st === "발행") c.h.createSpan({ cls: "st-hint", text: "최근 7일" });
			if (st === "미디어") c.h.createSpan({ cls: "st-hint", text: "건너뛸 수 있음" });
			for (const p of list) this.postCard(c.list, p);
			if (st === "초안") c.list.createDiv({ cls: "st-pc is-ghost", text: "글감을 여기로 끌면 초안이 생겨요" });
		}
		root.createDiv({ cls: "st-small st-muted st-pad", text: "카드를 끌면 `stage` 한 칸만 바뀌어요. 「예약」으로 끌면 편집 화면에서 시각을 정해 보내요. 「발행」으로 끌면 주소를 물어요." });
	}

	private stateBadge(parent: HTMLElement, p: Post): HTMLElement {
		const s = postState(p);
		const el = parent.createSpan({ cls: `st-st s-${s.cls}` });
		if (p.now) el.createSpan({ cls: "st-nowmark", text: "⚡" });
		el.appendText(s.kind === "scheduled" && s.detail ? `${s.name} ${s.detail}` : s.name);
		if (s.kind === "failed" && s.detail) el.createSpan({ cls: "st-tiny", text: ` ${s.detail.split("\n")[0]}` });
		if (s.kind === "published" && p.url) {
			el.addClass("is-link");
			el.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				window.open(p.url, "_blank", "noopener");
			});
		}
		return el;
	}

	private postCard(list: HTMLElement, p: Post): void {
		const card = list.createDiv({ cls: `st-pc c-${p.channel.key}${p.error ? " is-fail" : ""}`, attr: { draggable: "true" } });
		if (p.media[0]) thumb(card, p.media[0], "st-pc-thumb");
		card.createDiv({ cls: "st-t", text: p.title });
		const m = card.createDiv({ cls: "st-m" });
		m.createSpan({ cls: `st-ch c-${p.channel.key}`, text: p.channel.name });
		this.stateBadge(m, p);
		if (p.channel.key === "th" && p.parts.length > 1) m.createSpan({ text: `타래 ${p.parts.length}` });
		if (p.media.length) m.createSpan({ text: `🖼 ${p.media.length}` });
		card.addEventListener("dragstart", (ev) => ev.dataTransfer?.setData("text/x-studio", `p|${p.path}`));
		card.addEventListener("click", () => this.openPost(p.path));
		card.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			this.postMenu(ev, p);
		});
	}

	/** Right-click on a post card: open · original · 삭제. */
	private postMenu(ev: MouseEvent, p: Post): void {
		const d = this.d;
		if (!d) return;
		const m = new Menu();
		m.addItem((i) => i.setTitle("열기").setIcon("pencil").onClick(() => this.openPost(p.path)));
		m.addItem((i) => i.setTitle("원문 열기").setIcon("file-text").onClick(() => void openPath(this.plugin, p.path)));
		if (p.stage !== "발행") m.addItem((i) => i.setTitle("발행했어요…").setIcon("check").onClick(() => void this.askPublished(p)));
		if (p.stage !== "발행" && channelEndpoint(this.plugin, p.channel.key) && !blocksNow(postProblems(p, { mediaPrefix: publicPrefix(s3Config(this.plugin)) }))) {
			m.addItem((i) => i.setTitle("지금 발행…").setIcon("zap").onClick(() => void this.confirmSendNow(p)));
		}
		m.addSeparator();
		m.addItem((i) =>
			i
				.setTitle("삭제…")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(async () => {
					const notes: string[] = [];
					if (p.stage === "예약" && p.sent) notes.push("이미 예약을 보낸 글이에요. 받은 쪽(Make·Buffer·Lambda) 예약은 따로 취소해야 해요.");
					if (d.glgam.some((g) => g.posts.includes(p.path.replace(/\.md$/, "")))) notes.push("이 글을 가리키던 글감은 다시 「대기」로 돌아가요.");
					const ok = await confirmDelete(this.app, { title: "게시물 삭제", removes: [`${p.channel.name} · ${p.title}`], notes, footer: "파일은 휴지통으로 가서 되살릴 수 있어요." });
					if (ok === "delete") await this.run(() => deletePost(this.plugin, d, p));
				}),
		);
		m.showAtMouseEvent(ev);
	}

	private async dropOn(ev: MouseEvent, d: StudioData, stage: string, raw: string): Promise<void> {
		const [kind, a, b] = raw.split("|");
		if (kind === "g") {
			if (stage !== "초안") return void new Notice("글감은 「초안」 칸으로 끌어 주세요.");
			const g = d.glgam.find((x) => x.file === a && String(x.line) === b);
			if (g) this.draftMenu(ev, d, g);
			return;
		}
		if (kind !== "p" || !isStage(stage)) return;
		const p = d.posts.find((x) => x.path === a);
		if (!p || p.stage === stage) return;
		if (stage === "예약") return this.openPost(p.path);
		if (stage === "발행") return void this.askPublished(p);
		if (p.stage === "예약" && p.sent) {
			const ok = await askForm(this.app, { title: "예약을 취소할까요?", desc: "이미 보낸 글이에요. 단계를 옮기면 받은 쪽에 취소를 보내요.", fields: [], cta: "취소하고 옮기기" });
			if (!ok) return;
			await this.run(async () => {
				await cancelSchedule(this.plugin, p);
				await patchPost(this.plugin, p.path, { stage });
			});
			return;
		}
		await this.run(() => patchPost(this.plugin, p.path, { stage: stage as Stage }));
	}

	private async askPublished(p: Post): Promise<void> {
		const v = await askForm(this.app, {
			title: "발행했어요",
			desc: "올라간 글 주소를 넣으면 「발행」으로 옮겨요. (studio/results 의 발행 결과가 오면 저절로 채워져요.)",
			fields: [
				{ key: "url", label: "주소", type: "text", value: p.url, placeholder: "https://…" },
				{ key: "date", label: "발행일", type: "date", value: p.scheduled.slice(0, 10) || moment().format("YYYY-MM-DD") },
			],
			cta: "발행으로",
		});
		if (v) await this.run(() => markPublished(this.plugin, p, v.url, v.date || moment().format("YYYY-MM-DD")));
	}

	// ── 예약 ──

	private renderSched(root: HTMLElement, d: StudioData): void {
		const nav = root.createDiv({ cls: "st-row st-schednav" });
		const prev = nav.createEl("button", { cls: "st-btn is-sm", text: "‹", attr: { type: "button" } });
		const wk = moment(this.week, "YYYY-MM-DD");
		nav.createEl("b", { text: wk.format("GGGG-[W]WW") });
		nav.createSpan({ cls: "st-muted st-small", text: `${wk.format("M/D")} – ${wk.clone().add(6, "days").format("M/D")}` });
		const next = nav.createEl("button", { cls: "st-btn is-sm", text: "›", attr: { type: "button" } });
		const now = nav.createEl("button", { cls: "st-btn is-sm is-ghost", text: "이번 주", attr: { type: "button" } });
		const go = (n: number) => {
			this.week = n ? wk.clone().add(n, "weeks").format("YYYY-MM-DD") : moment().startOf("isoWeek").format("YYYY-MM-DD");
			this.render();
		};
		prev.addEventListener("click", () => go(-1));
		next.addEventListener("click", () => go(1));
		now.addEventListener("click", () => go(0));

		const cal = root.createDiv({ cls: "st-cal" });
		cal.createDiv({ cls: "st-hd is-corner" });
		const days = [...Array(7)].map((_, i) => wk.clone().add(i, "days"));
		const today = moment().format("YYYY-MM-DD");
		for (const x of days) cal.createDiv({ cls: `st-hd${x.format("YYYY-MM-DD") === today ? " is-today" : ""}`, text: x.format("dd M/D") });
		for (const ch of CHANNELS) {
			cal.createDiv({ cls: "st-rl" }).createSpan({ cls: `st-ch c-${ch.key}`, text: ch.name });
			for (const x of days) {
				const iso = x.format("YYYY-MM-DD");
				const cell = cal.createDiv({ cls: "st-cell" });
				const list = d.posts.filter((p) => p.channel.key === ch.key && (p.scheduled.slice(0, 10) === iso || (!p.scheduled && p.published === iso))).sort((a, b) => a.scheduled.localeCompare(b.scheduled));
				for (const p of list) {
					const s = cell.createDiv({ cls: `st-slot s-${postState(p).cls}` });
					s.createSpan({ cls: "st-tm", text: p.scheduled.slice(11, 16) || "" });
					if (p.now) s.createSpan({ cls: "st-nowmark", text: "⚡" });
					s.appendText(` ${p.title}`);
					tip(s, `${postState(p).name}${p.error ? ` · ${p.error.split("\n")[0]}` : ""}`);
					s.addEventListener("click", () => this.openPost(p.path));
				}
				if (!list.length) cell.createDiv({ cls: "st-empty-cell", text: "" });
			}
		}
		const lg = root.createDiv({ cls: "st-legend" });
		for (const [k, t] of [["wait", "예약 전"], ["sent", "예약됨"], ["going", "발행 중"], ["pub", "발행됨"], ["fail", "실패"], ["cancel", "취소됨"]]) lg.createSpan({ cls: `st-st s-${k}`, text: t });

		const rows = d.posts
			.filter((p) => p.scheduled || p.sent || p.published)
			.sort((a, b) => (b.scheduled || b.published).localeCompare(a.scheduled || a.published))
			.slice(0, 40);
		const tbl = root.createEl("table", { cls: "st-tbl" });
		const hr = tbl.createEl("thead").createEl("tr");
		for (const h of ["예약", "채널", "제목", "보낸 곳", "상태", "링크", ""]) hr.createEl("th", { text: h });
		const tb = tbl.createEl("tbody");
		if (!rows.length) tb.createEl("tr").createEl("td", { attr: { colspan: "7" }, cls: "st-faint", text: "아직 예약한 글이 없어요." });
		const sec = loadSecrets(this.app);
		const hooked = (key: Post["channel"]["key"]) => (key === "th" ? sec.threadsIntake : sec.webhook[key]).trim();
		for (const p of rows) {
			const tr = tb.createEl("tr");
			tr.createEl("td", { text: p.scheduled ? moment(p.scheduled, "YYYY-MM-DD HH:mm").format("M/D HH:mm") : "—" });
			tr.createEl("td").createSpan({ cls: `st-ch c-${p.channel.key}`, text: p.channel.name });
			const t = tr.createEl("td").createEl("a", { text: p.title });
			t.addEventListener("click", () => this.openPost(p.path));
			tr.createEl("td", { cls: "st-muted", text: hooked(p.channel.key) ? ROUTE[p.channel.key] : "웹훅 없음" });
			const stc = tr.createEl("td");
			this.stateBadge(stc, p);
			const lc = tr.createEl("td");
			if (p.url) lc.createEl("a", { text: p.url.replace(/^https?:\/\//, "").slice(0, 28) + "…", href: p.url });
			else lc.setText("—");
			const ac = tr.createEl("td");
			if (p.error) {
				const b = ac.createEl("button", { cls: "st-btn is-sm", text: "다시 보내기", attr: { type: "button" } });
				b.addEventListener("click", () => void this.run(() => sendSchedule(this.plugin, p)));
			} else if (!p.published) {
				const b = ac.createEl("button", { cls: "st-btn is-sm is-ghost", text: "발행했어요…", attr: { type: "button" } });
				b.addEventListener("click", () => void this.askPublished(p));
			}
		}
	}

	// ── 소스 ──

	private renderSources(root: HTMLElement, d: StudioData): void {
		const bar = root.createDiv({ cls: "st-row" });
		bar.createSpan({ cls: "st-muted st-small st-grow", text: `99 작업실/글감 소스.md${d.sourcesExist ? "" : " — 아직 파일이 없어요 (기본값). 바꾸면 만들어져요."}` });
		const add = bar.createEl("button", { cls: "st-btn mod-cta", text: "＋ 소스", attr: { type: "button" } });
		add.addEventListener("click", () => void this.addSource(d));
		const tbl = root.createDiv({ cls: "st-srctbl" });
		const h = tbl.createDiv({ cls: "st-srow is-head" });
		for (const t of ["", "소스", "어디서", "단위", "고를 곳", `${this.plugin.settings.studioDays}일`, ""]) h.createSpan({ text: t });
		for (const s of d.sources) {
			const r = tbl.createDiv({ cls: "st-srow" });
			const tog = r.createEl("button", { cls: `st-tog${s.on ? " is-on" : ""}`, attr: { type: "button", "aria-label": s.on ? "끄기" : "켜기" } });
			tog.addEventListener("click", () => void this.run(() => saveSources(this.plugin, d, d.sources.map((x) => (x.key === s.key ? { ...x, on: !x.on } : x)), `${s.name} ${s.on ? "끔" : "켬"}`), true));
			r.createSpan().createSpan({ cls: `st-sb s-${s.key}`, text: s.name });
			r.createSpan().createEl("code", { text: `${s.path}/` });
			r.createSpan({ text: s.unit === "루미" ? "루미가 찾음" : s.unit });
			r.createSpan({ cls: "st-muted", text: s.unit === "루미" ? "자동으로 훑지 않음" : s.where.join(", ") || "전체" });
			r.createSpan({ text: s.unit === "루미" ? "—" : String(this.cands.filter((c) => c.source === s.key).length) });
			const more = r.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "소스 메뉴" } });
			setIcon(more, "more-horizontal");
			more.addEventListener("click", (ev) => {
				const m = new Menu();
				m.addItem((i) => i.setTitle("고치기…").setIcon("pencil").onClick(() => void this.addSource(d, s)));
				m.addItem((i) =>
					i
						.setTitle("빼기")
						.setIcon("trash")
						.onClick(() => void this.run(() => saveSources(this.plugin, d, d.sources.filter((x) => x.key !== s.key), `${s.name} 뺌`), true)),
				);
				m.showAtMouseEvent(ev);
			});
		}
		root.createDiv({ cls: "st-small st-muted st-pad", text: "단위 — 줄: 목록 한 줄이 후보 하나 · 섹션: 제목 아래 덩어리 · 파일: 파일 하나 · 루미: 자동으로 훑지 않고 「루미에게 찾기」로만. AI 대화(세션)는 루미로만 찾아요." });
	}

	private async addSource(d: StudioData, cur?: Source): Promise<void> {
		const v = await askForm(this.app, {
			title: cur ? `소스 고치기: ${cur.name}` : "새 글감 소스",
			desc: "볼트 안 폴더면 무엇이든 돼요. 하위 폴더까지 읽고, `*`는 아무 폴더 이름 하나와 맞아요.",
			fields: [
				{ key: "name", label: "이름", type: "text", value: cur?.name ?? "", placeholder: "예: 독서 모임 기록" },
				{ key: "path", label: "폴더", type: "text", value: cur?.path ?? "", placeholder: "예: 05 Project Folders/개인/독서 모임/01 회의록" },
				{ key: "unit", label: "무엇을 후보 하나로 볼까요", type: "select", value: cur?.unit ?? "줄", options: [["줄", "줄 — 목록 한 줄씩"], ["섹션", "섹션 — 제목 아래 덩어리"], ["파일", "파일 — 파일 한 개"], ["루미", "루미 — 자동으로 훑지 않음"]] },
				{ key: "where", label: "어느 제목 아래만 (선택)", type: "text", value: cur?.where.join(", ") ?? "", placeholder: "줄: ## 메모, ## 로그 · 섹션: ###" },
			],
			cta: cur ? "고치기" : "더하기",
			validate: (x) => {
				const out: string[] = [];
				if (!x.name) out.push("이름을 적어 주세요.");
				if (!x.path) out.push("폴더를 적어 주세요.");
				else if (!this.app.vault.getAbstractFileByPath(x.path.replace(/\/+$/, "").split("/*")[0])) out.push(`볼트에 없는 폴더예요: ${x.path}`);
				return out;
			},
		});
		if (!v) return;
		const src: Source = { key: cur?.key ?? (v.name.replace(/[^\w가-힣]/g, "").slice(0, 12) || `s${d.sources.length + 1}`), name: v.name, path: v.path.replace(/\/+$/, ""), unit: v.unit as SourceUnit, where: v.where ? v.where.split(",").map((w) => w.trim()).filter(Boolean) : [], on: cur?.on ?? true };
		if (!cur && d.sources.some((s) => s.key === src.key)) src.key = `${src.key}${d.sources.length + 1}`;
		const next = cur ? d.sources.map((s) => (s.key === cur.key ? src : s)) : [...d.sources, src];
		await this.run(() => saveSources(this.plugin, d, next, `${src.name} ${cur ? "고침" : "더함"} (${src.path}/ · ${src.unit})`), true);
		new Notice(`「${src.name}」 후보 ${this.cands.filter((c) => c.source === src.key).length}개 (최근 ${this.plugin.settings.studioDays}일)`);
	}

	// ── 편집 ──

	private async flushBody(): Promise<void> {
		const p = this.draft;
		if (!p || !this.dirtyBody) return;
		this.dirtyBody = false;
		this.hush();
		try {
			await patchPost(this.plugin, p.path, {}, p.channel.key === "th" ? { ch: p.channel, parts: p.parts } : { ch: p.channel, text: p.text });
			this.savedAt = moment().format("HH:mm");
			this.contentEl.querySelector(".st-saved")?.setText(`저장 ${this.savedAt}`);
		} catch (e) {
			err(e);
		}
	}
	private dirtyBody = false;
	private savedAt = "";

	private bodyChanged(): void {
		this.dirtyBody = true;
		this.contentEl.querySelector(".st-saved")?.setText("저장 중…");
		this.saveBody();
	}

	private async setFields(patch: Parameters<typeof patchPost>[2], redraw = true): Promise<void> {
		const p = this.draft;
		if (!p) return;
		await this.flushBody();
		this.hush();
		try {
			await patchPost(this.plugin, p.path, patch);
			Object.assign(p, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? (Array.isArray((p as unknown as Record<string, unknown>)[k]) ? [] : "")])));
		} catch (e) {
			err(e);
		}
		if (redraw) this.render();
	}

	private renderEditor(root: HTMLElement, d: StudioData, p: Post): void {
		const ed = root.createDiv({ cls: `st-ed is-${p.channel.key}` });
		const top = ed.createDiv({ cls: "st-row st-edtop" });
		top.createSpan({ cls: `st-mark c-${p.channel.key}`, text: CH_MARK[p.channel.key] });
		const back = top.createEl("button", { cls: "st-link", text: "← 보드", attr: { type: "button" } });
		back.addEventListener("click", async () => {
			await this.flushBody();
			this.editing = null;
			this.draft = null;
			this.tab = this.tab === "glgam" ? "board" : this.tab;
			await this.refresh();
		});
		top.createSpan({ cls: "st-faint st-small st-grow st-ellipsis", text: p.path.slice(d.root.length + 1) });
		top.createSpan({ cls: "st-faint st-small st-saved", text: this.savedAt ? `저장 ${this.savedAt}` : "" });
		if (p.channel.key === "li") {
			const amp = top.createEl("button", { cls: "st-btn is-sm mod-cta st-ampbtn", attr: { type: "button" } });
			setIcon(amp.createSpan({ cls: "st-ic" }), "sparkles");
			amp.appendText("글 증폭");
			tip(amp, "왜 → 질문 → 답 → 엮기 → 검토 → 보완 → 완료. 문장은 직접 쓰고, AI는 묻고 짚고 찾아요");
			amp.addEventListener("click", () => void this.openAmp(p.path));
		}
		const orig = top.createEl("button", { cls: "st-btn is-sm is-ghost", text: "원문 열기", attr: { type: "button" } });
		orig.addEventListener("click", () => void openPath(this.plugin, p.path));
		const read = top.createEl("button", { cls: "st-btn is-sm is-ghost", text: "발행 결과 지금 읽기", attr: { type: "button" } });
		read.addEventListener("click", () => void this.readResults());

		const layout = ed.createDiv({ cls: "st-edgrid" });
		const main = layout.createDiv({ cls: "st-edmain" });
		const side = layout.createDiv({ cls: "st-edside" });

		// same 글감, other channels
		const sw = main.createDiv({ cls: "st-chswitch" });
		const sib = p.from.length ? d.posts.filter((x) => x.from[0] === p.from[0]) : [p];
		sw.createSpan({ cls: "st-tiny st-faint", text: "같은 글감" });
		for (const ch of CHANNELS) {
			const x = sib.find((s) => s.channel.key === ch.key);
			const b = sw.createEl("button", { cls: `${x?.path === p.path ? "is-on" : ""}${x ? "" : " is-new"}`, attr: { type: "button" } });
			b.createSpan({ cls: `st-dot c-${ch.key}`, text: CH_MARK[ch.key] });
			b.appendText(`${ch.name} · ${x ? x.stage : "＋"}`);
			b.addEventListener("click", async () => {
				await this.flushBody();
				if (x) this.openPost(x.path);
				else void this.siblingPost(d, p, ch);
			});
		}

		const title = main.createEl("input", { cls: "st-edtitle", attr: { type: "text" } });
		title.value = p.title;
		const rename = async () => {
			const v = title.value.trim();
			if (!v || v === p.title) return;
			await this.flushBody();
			this.hush(2500);
			try {
				const to = await renamePost(this.plugin, p, v);
				this.editing = to;
				p.path = to;
				p.title = v;
			} catch (e) {
				err(e);
			}
			await this.refresh();
		};
		title.addEventListener("blur", () => void rename());
		title.addEventListener("keydown", (ev) => ev.key === "Enter" && title.blur());

		const sb = main.createDiv({ cls: "st-stagebar" });
		const at = STAGES.indexOf(p.stage);
		STAGES.forEach((s, i) => {
			const b = sb.createEl("button", { cls: i < at ? "is-past" : i === at ? "is-now" : "", text: s, attr: { type: "button" } });
			if (s === "초안" || s === "다듬기" || s === "미디어") b.addEventListener("click", () => p.stage !== "예약" && p.stage !== "발행" && void this.setFields({ stage: s }));
		});

		const stateLine = main.createDiv({ cls: "st-lock" });
		this.stateBadge(stateLine, p);
		stateLine.createSpan({ text: p.sent && p.scheduled ? ` ${moment(p.scheduled, "YYYY-MM-DD HH:mm").format("M/D HH:mm")}에 보낼 예약이에요.` : "" });
		if (p.warning) main.createDiv({ cls: "st-warn-banner", text: p.warning });
		if (p.error) main.createDiv({ cls: "st-banner is-bad", text: `발행 실패: ${p.error}` });

		if (p.channel.key === "li") this.editLinkedIn(main, side, p);
		else if (p.channel.key === "th") this.editThreads(main, side, p);
		else this.editInstagram(main, side, p);

		void this.renderSources1(side, d, p);
		this.renderStrategy(side, d, p);
		this.renderSchedule(side, p);
	}

	private async siblingPost(d: StudioData, p: Post, ch: ChannelDef): Promise<void> {
		const g = d.glgam.find((x) => p.from[0] && p.from[0].includes(`#^${x.block}`)) ?? null;
		await this.newPost(d, ch, g, p.title);
	}

	private counter(parent: HTMLElement, n: number, limit: number, extra = ""): HTMLElement {
		const c = parent.createDiv({ cls: `st-count${n > limit ? " is-over" : ""}` });
		c.setText(`${n.toLocaleString()} / ${limit.toLocaleString()}자${extra}`);
		return c;
	}

	private textarea(parent: HTMLElement, value: string, cls: string, onInput: (v: string) => void, placeholder = ""): HTMLTextAreaElement {
		const ta = parent.createEl("textarea", { cls, attr: { placeholder, spellcheck: "false" } });
		ta.value = value;
		const fit = () => {
			ta.style.height = "auto";
			ta.style.height = `${ta.scrollHeight + 4}px`;
		};
		ta.addEventListener("input", () => {
			fit();
			onInput(ta.value);
		});
		window.requestAnimationFrame(fit);
		return ta;
	}

	private formatSeg(parent: HTMLElement, p: Post): void {
		const seg = parent.createDiv({ cls: "st-seg" });
		for (const f of FORMATS[p.channel.key]) {
			const b = seg.createEl("button", { cls: f === p.format ? "is-on" : "", text: f === "피드" ? "피드 1장" : f === "문서" ? "문서(PDF)" : f, attr: { type: "button" } });
			b.addEventListener("click", () => void this.setFields({ format: f }));
		}
	}

	private editLinkedIn(main: HTMLElement, side: HTMLElement, p: Post): void {
		const row = main.createDiv({ cls: "st-row st-edrow" });
		row.createSpan({ cls: "st-small st-muted", text: "형식" });
		this.formatSeg(row, p);
		const paper = main.createDiv({ cls: "st-lipost" });
		const ph = paper.createDiv({ cls: "st-liph" });
		ph.createDiv({ cls: "st-liav" });
		const nm = ph.createDiv();
		nm.createEl("b", { text: "내 게시물" });
		nm.createDiv({ cls: "st-tiny st-faint", text: `본문 · ${p.format} · 🌐` });
		const textWrap = paper.createDiv({ cls: "st-libody" });
		const foot = paper.createDiv({ cls: "st-lifoot" });
		for (const a of ["👍 추천", "💬 댓글", "↻ 퍼가기"]) foot.createSpan({ text: a });
		foot.createDiv({ cls: "st-grow" });
		const fold = main.createDiv({ cls: "st-foldpv" });
		const showFold = () => {
			fold.empty();
			const lines = p.text.split("\n");
			let n = 0;
			const head: string[] = [];
			for (const l of lines) {
				if (head.length >= 3 || n + l.length > 210) break;
				head.push(l);
				n += l.length;
			}
			fold.createDiv({ cls: "st-tiny st-faint", text: "피드에 보이는 앞부분 (약 3줄) — 그 아래는 「…더 보기」" });
			fold.createDiv({ cls: "st-foldtext", text: head.join("\n") || "…" });
		};
		const cnt = this.counter(foot, charCount(p.text), p.channel.limit);
		this.textarea(textWrap, p.text, "st-body", (v) => {
			p.text = v;
			cnt.setText(`${charCount(v).toLocaleString()} / ${p.channel.limit.toLocaleString()}자`);
			cnt.toggleClass("is-over", charCount(v) > p.channel.limit);
			showFold();
			this.bodyChanged();
		}, "본문을 쓰세요");
		showFold();
		this.mediaPanel(side, p, "미디어");
	}

	private editThreads(main: HTMLElement, side: HTMLElement, p: Post): void {
		const row = main.createDiv({ cls: "st-row st-edrow" });
		row.createSpan({ cls: "st-small st-muted st-grow", text: `타래 ${p.parts.length}개 · 글마다 ${p.channel.limit}자` });
		row.createSpan({ cls: "st-small st-muted", text: "주제" });
		const topic = row.createEl("input", { cls: "st-search", attr: { type: "text", placeholder: "주제 하나 (선택)" } });
		topic.value = p.topic;
		topic.addEventListener("change", () => void this.setFields({ topic: topic.value.trim().replace(/^#/, "") || null }, false));
		const list = main.createDiv({ cls: "st-thread st-thcard" });
		p.parts.forEach((part, i) => {
			const tp = list.createDiv({ cls: `st-tp${i === p.parts.length - 1 ? " is-last" : ""}` });
			tp.createDiv({ cls: "st-av", text: String(i + 1) });
			const body = tp.createDiv({ cls: "st-grow" });
			const hd = body.createDiv({ cls: "st-thhd" });
			hd.createEl("b", { text: "내 계정" });
			if (i === 0) hd.createSpan({ text: "첫 글 · 멈추게 하는 한 줄" });
			else if (i === p.parts.length - 1) hd.createSpan({ text: "마지막 글" });
			const box = body.createDiv({ cls: "st-tbox" });
			const foot = body.createDiv({ cls: "st-tfoot" });
			const bar = foot.createSpan({ cls: "st-ring" });
			const n = foot.createSpan({ text: "" });
			const upd = (v: string) => {
				const c = threadsTextLength(v);
				bar.style.setProperty("--p", `${Math.min(100, (c / p.channel.limit) * 100)}%`);
				bar.toggleClass("is-warn", c > p.channel.limit * 0.9 && c <= p.channel.limit);
				bar.toggleClass("is-over", c > p.channel.limit);
				n.setText(`${c} / ${p.channel.limit}`);
				n.toggleClass("st-bad", c > p.channel.limit);
			};
			this.textarea(box, part.text, "st-tarea", (v) => {
				part.text = v;
				upd(v);
				this.bodyChanged();
			}, i ? "이어지는 글" : "첫 글");
			upd(part.text);
			if (part.media.length) {
				const ms = body.createDiv({ cls: "st-tmedia" });
				part.media.forEach((u, k) => {
					const t = thumb(ms, u);
					const x = t.createEl("button", { cls: "st-x", text: "✕", attr: { type: "button", "aria-label": "빼기" } });
					x.addEventListener("click", () => {
						part.media.splice(k, 1);
						this.dirtyBody = true;
						void this.flushBody().then(() => this.render());
					});
				});
			}
			const addm = foot.createEl("button", { cls: "st-btn is-sm is-ghost", text: "＋ 사진", attr: { type: "button" } });
			addm.addEventListener("click", (ev) => this.addMediaMenu(ev, (urls) => {
				part.media.push(...urls);
				this.dirtyBody = true;
				void this.flushBody().then(() => this.render());
			}, (f) => threadsUploadProblem(f.name, f.size)));
			dropZone(box, (files) => void uploadFiles(this.plugin, files, undefined, (f) => threadsUploadProblem(f.name, f.size)).then((urls) => {
				if (!urls.length) return;
				part.media.push(...urls);
				this.dirtyBody = true;
				void this.flushBody().then(() => this.render());
			}));
			if (p.parts.length > 1) {
				const del = foot.createEl("button", { cls: "st-btn is-sm is-ghost", text: "이 글 빼기", attr: { type: "button" } });
				del.addEventListener("click", () => {
					p.parts.splice(i, 1);
					this.dirtyBody = true;
					void this.flushBody().then(() => this.render());
				});
			}
		});
		const add = main.createDiv({ cls: "st-tadd" });
		const b = add.createEl("button", { cls: "st-btn is-sm", text: "＋ 이어 쓰기", attr: { type: "button" } });
		add.createSpan({ cls: "st-small st-faint", text: " 이어쓰기는 아직 보낼 수 없어요. 글은 하나만, 500자(이모티콘은 바이트)까지." });
		b.addEventListener("click", () => {
			p.parts.push({ text: "", media: [] } as ThreadPart);
			this.dirtyBody = true;
			void this.flushBody().then(() => {
				this.render();
				const tas = this.contentEl.querySelectorAll<HTMLTextAreaElement>(".st-tarea");
				tas[tas.length - 1]?.focus();
			});
		});
		const tip1 = side.createDiv({ cls: "st-sideg" });
		tip1.createEl("h2", { text: "미디어" });
		tip1.createDiv({ cls: "st-small st-muted", text: "jpg·jpeg·png·gif·webp는 8MB, mp4·mov는 1GB까지. 글 하나에 미디어 20개. 주소는 설정의 S3 폴더 공개 주소여야 해요." });
	}

	private editInstagram(main: HTMLElement, side: HTMLElement, p: Post): void {
		// 슬라이드
		const sec = main.createDiv({ cls: "st-igsec" });
		const h = sec.createDiv({ cls: "st-row st-wrap st-igh" });
		h.createEl("h2", { text: p.format === "릴스" ? "영상" : "슬라이드" }).createSpan({ cls: "st-pill", text: String(p.media.length) });
		h.createDiv({ cls: "st-grow" });
		this.formatSeg(h, p);
		const ratio = h.createDiv({ cls: "st-seg" });
		for (const r of ["4:5", "1:1"]) {
			const b = ratio.createEl("button", { cls: r === p.ratio ? "is-on" : "", text: r, attr: { type: "button" } });
			b.addEventListener("click", () => void this.setFields({ ratio: r }));
		}
		const slides = sec.createDiv({ cls: `st-slides r-${p.ratio.replace(":", "")}` });
		let dragFrom = -1;
		p.media.forEach((u, i) => {
			const s = slides.createDiv({ cls: `st-sl${i === this.igSlide ? " is-cur" : ""}`, attr: { draggable: "true" } });
			thumb(s, u, "st-slimg");
			s.createSpan({ cls: "st-no", text: String(i + 1) });
			const alt = s.createEl("button", { cls: `st-alt${p.alt[i] ? " is-on" : ""}`, text: "ALT", attr: { type: "button" } });
			tip(alt, p.alt[i] ? `대체 텍스트: ${p.alt[i]}` : "대체 텍스트 (선택)");
			alt.addEventListener("click", async (ev) => {
				ev.stopPropagation();
				const v = await askForm(this.app, { title: `${i + 1}번 대체 텍스트`, desc: "화면을 못 보는 사람에게 읽어 주는 설명이에요. 비워도 돼요.", fields: [{ key: "a", label: "설명", type: "textarea", value: p.alt[i] ?? "" }], cta: "저장" });
				if (!v) return;
				const alts = p.media.map((_, k) => (k === i ? v.a : (p.alt[k] ?? "")));
				await this.setFields({ alt: alts.some(Boolean) ? alts : null });
			});
			const x = s.createEl("button", { cls: "st-x", text: "✕", attr: { type: "button", "aria-label": "빼기" } });
			x.addEventListener("click", (ev) => {
				ev.stopPropagation();
				const media = p.media.filter((_, k) => k !== i);
				const alts = p.alt.filter((_, k) => k !== i);
				this.igSlide = Math.max(0, Math.min(this.igSlide, media.length - 1));
				void this.setFields({ media, alt: alts.some(Boolean) ? alts : null });
			});
			s.addEventListener("click", () => {
				this.igSlide = i;
				this.render();
			});
			s.addEventListener("dragstart", () => (dragFrom = i));
			s.addEventListener("dragover", (ev) => ev.preventDefault());
			s.addEventListener("drop", (ev) => {
				ev.preventDefault();
				if (ev.dataTransfer?.files.length || dragFrom < 0 || dragFrom === i) return;
				const media = [...p.media];
				const alts = p.media.map((_, k) => p.alt[k] ?? "");
				const [m] = media.splice(dragFrom, 1);
				const [a] = alts.splice(dragFrom, 1);
				media.splice(i, 0, m);
				alts.splice(i, 0, a);
				this.igSlide = i;
				void this.setFields({ media, alt: alts.some(Boolean) ? alts : null });
			});
		});
		const addS3 = slides.createDiv({ cls: "st-add" });
		addS3.createEl("b", { text: "＋" });
		addS3.createSpan({ text: "S3에서 고르기" });
		addS3.addEventListener("click", () => void pickMedia(this.plugin).then((urls) => void (urls.length ? this.setFields({ media: [...p.media, ...urls] }) : undefined)));
		const addLocal = slides.createDiv({ cls: "st-add is-dz" });
		addLocal.createEl("b", { text: "⇩" });
		addLocal.createSpan({ text: "파일 끌어 놓기" });
		addLocal.createSpan({ cls: "st-faint", text: "→ S3에 올림" });
		const up = (files: File[]) =>
			void uploadFiles(this.plugin, files, (m) => addLocal.querySelector(".st-faint")?.setText(m || "→ S3에 올림")).then((urls) => void (urls.length ? this.setFields({ media: [...p.media, ...urls] }) : undefined));
		addLocal.addEventListener("click", () => void chooseFiles().then(up));
		dropZone(addLocal, up);
		dropZone(slides, up);
		sec.createDiv({ cls: "st-small st-faint", text: "끌어서 순서 바꾸기 · 누르면 오른쪽 미리 보기가 그 장으로 · ALT = 대체 텍스트(선택)" });

		// 캡션
		const cap = main.createDiv({ cls: "st-igsec" });
		const ch = cap.createDiv({ cls: "st-row" });
		ch.createEl("h2", { text: "캡션" });
		ch.createDiv({ cls: "st-grow" });
		const cnt = ch.createSpan({ cls: "st-count" });
		const upd = () => {
			const n = charCount(captionOut(p));
			cnt.setText(`${n.toLocaleString()} / ${p.channel.limit.toLocaleString()}자 (해시태그 포함)`);
			cnt.toggleClass("is-over", n > p.channel.limit);
		};
		this.textarea(cap, p.text, "st-caption", (v) => {
			p.text = v;
			upd();
			const pv = this.contentEl.querySelector(".st-phone .st-capv");
			if (pv) this.capPreview(pv as HTMLElement, p);
			this.bodyChanged();
		}, "캡션을 쓰세요");
		upd();
		const tags = cap.createDiv({ cls: "st-tags" });
		tags.createSpan({ cls: "st-small st-muted", text: "해시태그" });
		for (const t of p.hashtags) {
			const c = tags.createEl("button", { cls: "st-tag", text: `#${t} ✕`, attr: { type: "button" } });
			c.addEventListener("click", () => void this.setFields({ hashtags: p.hashtags.filter((x) => x !== t) }));
		}
		const tin = tags.createEl("input", { cls: "st-tagin", attr: { type: "text", placeholder: "＋ 태그 (Enter)" } });
		tin.addEventListener("keydown", (ev) => {
			if ((ev.key !== "Enter" && ev.key !== ",") || ev.isComposing) return;
			ev.preventDefault();
			const add = tin.value.split(/[\s,#]+/).map((x) => x.trim()).filter(Boolean).filter((x) => !p.hashtags.includes(x));
			if (add.length) void this.setFields({ hashtags: [...p.hashtags, ...add] });
		});
		tags.createDiv({ cls: "st-grow" });
		tags.createSpan({ cls: `st-small ${p.hashtags.length > HASHTAG_MAX ? "st-bad" : "st-muted"}`, text: `${p.hashtags.length} / ${HASHTAG_MAX}` });

		// 미리 보기
		const pv = side.createDiv({ cls: "st-sideg" });
		pv.createEl("h2", { text: `미리 보기 ${p.media.length ? `${this.igSlide + 1} / ${p.media.length}` : ""}` });
		const phone = pv.createDiv({ cls: "st-phone" });
		const ph = phone.createDiv({ cls: "st-ph" });
		ph.createEl("i");
		ph.appendText("내 계정");
		const slide = phone.createDiv({ cls: `st-pslide r-${p.ratio.replace(":", "")}` });
		if (p.media[this.igSlide]) thumb(slide, p.media[this.igSlide], "st-pimg");
		else slide.createDiv({ cls: "st-faint st-small", text: "슬라이드가 없어요" });
		if (p.media.length > 1) {
			const dots = phone.createDiv({ cls: "st-dots" });
			p.media.forEach((_, i) => dots.createEl("i", { cls: i === this.igSlide ? "is-on" : "" }));
		}
		this.capPreview(phone.createDiv({ cls: "st-capv" }), p);
	}

	private capPreview(el: HTMLElement, p: Post): void {
		el.empty();
		el.createEl("b", { text: "내 계정 " });
		const t = captionOut(p).replace(/\n+/g, " ");
		el.appendText(t.length > 125 ? t.slice(0, 125) : t);
		if (t.length > 125) el.createSpan({ cls: "st-faint", text: " …더 보기" });
	}

	private addMediaMenu(ev: MouseEvent, put: (urls: string[]) => void, gate?: (f: File) => string | null): void {
		const m = new Menu();
		m.addItem((i) => i.setTitle("S3에서 고르기").setIcon("cloud").onClick(() => void pickMedia(this.plugin).then((u) => u.length && put(u))));
		m.addItem((i) => i.setTitle("이 컴퓨터에서 올리기").setIcon("upload").onClick(() => void chooseFiles().then((f) => uploadFiles(this.plugin, f, undefined, gate)).then((u) => u.length && put(u))));
		m.showAtMouseEvent(ev);
	}

	private mediaPanel(side: HTMLElement, p: Post, title: string): void {
		const g = side.createDiv({ cls: "st-sideg" });
		const h = g.createEl("h2");
		h.appendText(title);
		h.createSpan({ cls: "st-faint st-tiny", text: ` S3 · ${p.media.length}개` });
		const grid = g.createDiv({ cls: "st-media" });
		p.media.forEach((u, i) => {
			const t = thumb(grid, u);
			const x = t.createEl("button", { cls: "st-x", text: "✕", attr: { type: "button", "aria-label": "빼기" } });
			x.addEventListener("click", () => void this.setFields({ media: p.media.filter((_, k) => k !== i) }));
		});
		const s3 = grid.createDiv({ cls: "st-add" });
		s3.createSpan({ text: "＋ S3에서 고르기" });
		s3.addEventListener("click", () => void pickMedia(this.plugin).then((urls) => void (urls.length ? this.setFields({ media: [...p.media, ...urls] }) : undefined)));
		const dz = grid.createDiv({ cls: "st-add is-dz" });
		const lab = dz.createSpan({ text: "여기에 끌어 놓기" });
		const up = (files: File[]) => void uploadFiles(this.plugin, files, (m) => lab.setText(m || "여기에 끌어 놓기")).then((urls) => void (urls.length ? this.setFields({ media: [...p.media, ...urls] }) : undefined));
		dz.addEventListener("click", () => void chooseFiles().then(up));
		dropZone(dz, up);
		g.createDiv({ cls: "st-tiny st-faint", text: "올라가면 주소가 `media`에 들어가요. 볼트에는 사본을 남기지 않아요." });
	}

	private async renderSources1(side: HTMLElement, d: StudioData, p: Post): Promise<void> {
		const g = side.createDiv({ cls: "st-sideg" });
		g.createEl("h2", { text: "이 글의 출처" });
		if (!p.from.length) {
			g.createDiv({ cls: "st-small st-faint", text: "글감 없이 만든 글이에요." });
			return;
		}
		for (const f of p.from) {
			const q = g.createDiv({ cls: "st-quote" });
			const gl = d.glgam.find((x) => f.includes(`#^${x.block}`));
			if (gl) {
				q.createDiv({ cls: "st-row" }).createSpan({ cls: `st-sb s-${gl.src}`, text: SRC_LABEL[gl.src] ?? gl.src });
				const body = q.createDiv({ cls: "st-qt", text: gl.text });
				for (const src of gl.from) void quoteOf(this.plugin, src, gl.file).then((t) => t && t !== gl.text && body.createDiv({ cls: "st-faint st-small", text: `원문: ${t}` }));
				const o = q.createEl("a", { cls: "st-tiny", text: "원문 열기" });
				o.addEventListener("click", () => void this.app.workspace.openLinkText(gl.from[0] ?? gl.file, gl.file, "tab"));
			} else {
				const t = await quoteOf(this.plugin, f, p.path);
				q.createDiv({ cls: "st-qt", text: t ?? f });
			}
		}
	}

	private renderStrategy(side: HTMLElement, d: StudioData, p: Post): void {
		const g = side.createDiv({ cls: "st-sideg" });
		const h = g.createEl("h2");
		h.appendText("채널 전략");
		const text = d.strategy.get(p.channel.key) ?? null;
		const path = strategyPath(d.root, p.channel);
		if (text === null) {
			const box = g.createDiv({ cls: "st-dz-note" });
			box.createSpan({ text: `채널 전략/${p.channel.name}.md가 아직 없어요.` });
			const b = box.createEl("button", { cls: "st-btn is-sm", text: "＋ 만들기", attr: { type: "button" } });
			b.addEventListener("click", () =>
				void this.run(async () => {
					const dir = path.slice(0, path.lastIndexOf("/"));
					if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
					await this.app.vault.create(path, `# ${p.channel.name} 채널 전략\n\n## 좋은 글의 기준\n\n**필수**\n- \n`);
					await openPath(this.plugin, path);
				}),
			);
			return;
		}
		const o = h.createEl("a", { cls: "st-tiny st-faint", text: ` 채널 전략/${p.channel.name}.md` });
		o.addEventListener("click", () => void openPath(this.plugin, path));
		const lines = text.split(/\r?\n/);
		const at = lines.findIndex((l) => /\*\*필수\*\*|^#+\s*필수/.test(l));
		const items: string[] = [];
		for (let i = at + 1; at >= 0 && i < lines.length && items.length < 8; i++) {
			const m = /^\s*-\s+(?:\[.\]\s+)?(.+)$/.exec(lines[i]);
			if (m) items.push(m[1].replace(/\*\*/g, ""));
			else if (items.length && (/^\s*$/.test(lines[i]) ? /^\*\*|^#/.test(lines[i + 1] ?? "") : /^\*\*|^#/.test(lines[i]))) break;
		}
		if (!items.length) {
			g.createDiv({ cls: "st-small st-faint", text: "「필수」 목록이 없어요." });
			return;
		}
		for (const it of items) {
			const lab = g.createEl("label", { cls: "st-chk" });
			lab.createEl("input", { attr: { type: "checkbox" } });
			lab.createSpan({ text: it });
		}
		g.createDiv({ cls: "st-tiny st-faint", text: "체크는 이 화면에서만 보여요. 파일에 쓰지 않아요." });
	}

	private armResultRead(scheduled: string): void {
		const at = scheduledInstant(scheduled);
		if (at == null) return;
		const delay = Math.max(0, at + 30_000 - Date.now());
		const id = window.setTimeout(() => {
			void this.poll(false, true).finally(() => this.syncFastPoll());
		}, delay);
		this.register(() => window.clearTimeout(id));
	}

	private async confirmSendNow(p: Post): Promise<void> {
		const ok = await askForm(this.app, {
			title: "지금 발행",
			desc: `지금 ${p.channel.name}에 올려요. 1~3분 뒤 게시돼요. 되돌릴 수 없어요.`,
			fields: [],
			cta: "지금 발행",
		});
		if (!ok) return;
		await this.run(async () => {
			const at = await sendNow(this.plugin, p);
			this.armResultRead(at);
			new Notice(`${p.channel.name}에 지금 발행을 보냈어요.`);
		});
	}

	private renderSchedule(side: HTMLElement, real: Post): void {
		const g = side.createDiv({ cls: "st-sideg is-last" });
		const status = g.createDiv({ cls: "st-state-line" });
		this.stateBadge(status, real);
		if (real.warning) g.createDiv({ cls: "st-warn-banner", text: real.warning });
		g.createEl("h2", { text: "예약" });
		const assumed = !real.scheduled && real.stage !== "발행";
		// shown as today; written when sent or changed
		const p: Post = assumed ? { ...real, scheduled: defaultSchedule(new Date()) } : real;
		const problems = postProblems(p, { mediaPrefix: publicPrefix(s3Config(this.plugin)) });
		const row = g.createDiv({ cls: "st-schedin" });
		const date = row.createEl("input", { attr: { type: "date" } });
		const time = row.createEl("input", { attr: { type: "time", step: "300" } });
		date.value = p.scheduled.slice(0, 10);
		time.value = p.scheduled.slice(11, 16) || "08:00";
		const save = () => {
			if (!date.value) return;
			void this.setFields({ scheduled: `${date.value} ${time.value || "08:00"}` });
		};
		date.addEventListener("change", save);
		time.addEventListener("change", save);
		if (assumed) g.createDiv({ cls: "st-tiny st-faint", text: "오늘로 잡아 뒀어요. 바꾸거나 보내면 저장돼요." });
		for (const x of problems) if (!(x.text.startsWith("예약 날짜") && !p.scheduled)) g.createDiv({ cls: `st-prob is-${x.level}`, text: x.text });
		const hook = channelEndpoint(this.plugin, p.channel.key);
		if (p.channel.key === "th" && !hook) g.createDiv({ cls: "st-prob is-block", text: "스레드 접수 주소를 설정 › 콘텐츠 스튜디오에 넣어 주세요." });
		const blocked = problems.some((x) => x.level === "block");
		const sent = p.stage === "예약" && !!p.sent;
		const go = g.createEl("button", { cls: "st-btn mod-cta st-wide", text: p.channel.key === "th" && !hook ? "접수 주소 필요" : !hook ? "예약만 적기 (웹훅 없음)" : postState(real).kind === "failed" || sent ? "다시 보내기" : "예약 보내기", attr: { type: "button" } });
		go.disabled = blocked || p.stage === "발행" || (p.channel.key === "th" && !hook);
		go.addEventListener("click", () =>
			void this.run(async () => {
				await this.flushBody();
				const r = await sendSchedule(this.plugin, p);
				new Notice(r === "sent" ? `${p.channel.name}에 예약을 보냈어요 (${p.scheduled}).` : "예약 시각만 적었어요. 설정에서 웹훅을 넣으면 보낼 수 있어요.");
			}),
		);
		if (hook && p.stage !== "발행") {
			const nowBtn = g.createEl("button", { cls: "st-btn is-ghost st-wide", text: "지금 발행", attr: { type: "button" } });
			nowBtn.disabled = blocksNow(problems);
			nowBtn.addEventListener("click", () => void this.confirmSendNow(p));
		}
		if (sent) {
			const c = g.createEl("button", { cls: "st-btn is-ghost st-wide", text: "예약 취소", attr: { type: "button" } });
			c.addEventListener("click", () => void this.run(() => cancelSchedule(this.plugin, p)));
		}
		g.createDiv({ cls: "st-route", text: `보낼 곳: ${hook ? ROUTE[p.channel.key] : "아직 없음 — 설정 › 콘텐츠 스튜디오"}${p.sent ? ` · ${moment(p.sent, "YYYY-MM-DD HH:mm").format("M/D HH:mm")} 예약됨` : ""}` });
		if (p.stage !== "발행") {
			const pub = g.createEl("button", { cls: "st-btn is-ghost is-sm", text: "발행했어요… (주소 넣기)", attr: { type: "button" } });
			pub.addEventListener("click", () => void this.askPublished(p));
		} else if (p.url) {
			const a = g.createEl("a", { cls: "st-small", text: `발행 ${md(p.published)} · ${p.url}`, href: p.url });
			a.setAttr("target", "_blank");
		}
	}
}

/** Open (or reveal) the studio, optionally on a post. */
function announcePoll(r: { unconfigured: boolean; eligible: number; hits: Parameters<typeof formatPollSummary>[0] }): void {
	if (r.unconfigured) new Notice("설정 › 콘텐츠 스튜디오에서 S3를 연결해 주세요.");
	else if (r.eligible === 0) new Notice("새 발행 결과가 없어요.");
	else new Notice(formatPollSummary(r.hits) || "새 발행 결과가 없어요.", 12000);
}

/** Forced read from the command palette. Uses the open studio when there is one. */
export async function readPublishResults(plugin: MyLogsPlugin): Promise<void> {
	const leaf = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_STUDIO)[0];
	if (leaf?.view instanceof StudioView) {
		await leaf.view.readResults();
		return;
	}
	const d = await loadStudio(plugin);
	if (!d) {
		new Notice("스튜디오를 쓰는 Flywheel 요소가 없어요.");
		return;
	}
	announcePoll(await pollResults(plugin, d, true));
}

export async function activateStudio(plugin: MyLogsPlugin, from?: WorkspaceLeaf, post?: string): Promise<void> {
	const ws = plugin.app.workspace;
	let leaf = ws.getLeavesOfType(VIEW_TYPE_STUDIO)[0];
	if (!leaf) {
		leaf = from ?? ws.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_STUDIO, active: true });
	}
	await ws.revealLeaf(leaf);
	if (post && leaf.view instanceof StudioView) leaf.view.openPost(post);
}

export { channelByKey };
