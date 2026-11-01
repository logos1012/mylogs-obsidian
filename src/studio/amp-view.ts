/**
 * 글 증폭 screen (「글 증폭 설계 v1.1」): 왜 → 질문 → 답 → 엮기 → 검토 → 보완 → 완료, for one
 * LinkedIn post. Shown inside the studio view in place of the editor. Every answer, question,
 * review line and source is written into the post file (`./amp.ts`); 생각하기 talk and AI
 * suggestions stay in memory until the user takes them.
 */

import { debounce, moment, Notice, setIcon, TFile } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { askForm } from "../ui/modals.ts";
import {
	addSources,
	AMP_STEPS,
	type AmpContext,
	type AmpData,
	type AmpGap,
	type AmpQuestion,
	type AmpSource,
	type AmpStep,
	type ThinkTurn,
	answerUsed,
	atText,
	insertAfter,
	isAmpStep,
	LENSES,
	paragraphs,
	parseAmp,
	promptOrder,
	promptProbe,
	promptQuestions,
	promptReview,
	promptSources,
	promptThink,
	reviewItems,
	setMessage,
	setQuestions,
	setReview,
	shareFromAnswers,
} from "./amp.ts";
import { ampAsk, ampAvailable } from "./amp-ai.ts";
import { channelByKey, charCount, parsePost, readFm, setFm, setPostBody, type Post } from "./model.ts";
import type { StudioData } from "./store.ts";

const LI = channelByKey("li");

export interface AmpHost {
	plugin: MyLogsPlugin;
	/** Our own writes must not redraw under the cursor. */
	hush(ms?: number): void;
	rerender(): void;
	exit(): void;
}

interface Busy {
	label: string;
	start: number;
	abort: AbortController;
}

type Result = { title: string; url: string; outlet: string; year: string; quote: string; claim: string };

const err = (e: unknown) => new Notice(`MyLogs: ${e instanceof Error ? e.message : String(e)}`, 10000);

export class AmpScreen {
	path: string;
	private text = "";
	private d: AmpData = { message: "", questions: [], review: null, sources: [] };
	private post: Post | null = null;
	private step: AmpStep = "왜";
	private draftMsg: string | null = null;
	private talk: ThinkTurn[] = [];
	private thinking = false;
	private sugg: { persona: string; question: string }[] = [];
	private cur = 0;
	private probe = new Map<string, string>();
	private order: { order: number[]; why: string } | null = null;
	private gap = 0;
	private results = new Map<string, Result[]>();
	private picked = new Set<string>();
	private fill = "";
	private busy: Busy | null = null;
	private timer = 0;
	private bodyArea: HTMLTextAreaElement | null = null;
	private saveBodyLater = debounce(() => void this.saveBody(), 700, true);
	private saveAnswersLater = debounce(() => void this.saveQuestions(), 700, true);
	private pendingBody: string | null = null;

	constructor(
		private host: AmpHost,
		path: string,
	) {
		this.path = path;
	}

	private get plugin(): MyLogsPlugin {
		return this.host.plugin;
	}

	// ── file ──

	async load(): Promise<void> {
		const f = this.plugin.app.vault.getAbstractFileByPath(this.path);
		if (!(f instanceof TFile)) return;
		this.text = await this.plugin.app.vault.read(f);
		this.parse();
		const st = String(readFm(this.text).amp ?? "");
		if (isAmpStep(st) && this.step === "왜" && !this.loadedOnce) this.step = st;
		this.loadedOnce = true;
	}
	private loadedOnce = false;

	private parse(): void {
		this.d = parseAmp(this.text);
		this.post = parsePost(this.path, this.text, LI);
	}

	private async edit(fn: (t: string) => string): Promise<void> {
		const f = this.plugin.app.vault.getAbstractFileByPath(this.path);
		if (!(f instanceof TFile)) throw new Error("게시물 파일이 없어요.");
		this.host.hush(2000);
		let out = "";
		await this.plugin.app.vault.process(f, (t) => (out = fn(t)));
		this.text = out;
		this.parse();
	}

	private async saveBody(): Promise<void> {
		if (this.pendingBody === null) return;
		const v = this.pendingBody;
		this.pendingBody = null;
		try {
			await this.edit((t) => setPostBody(t, LI, { text: v }));
		} catch (e) {
			err(e);
		}
	}

	private async saveQuestions(qs = this.d.questions): Promise<void> {
		try {
			await this.edit((t) => setQuestions(t, qs));
		} catch (e) {
			err(e);
		}
	}

	async flush(): Promise<void> {
		await this.saveBody();
	}

	private async go(step: AmpStep): Promise<void> {
		await this.flush();
		this.step = step;
		this.host.rerender();
		try {
			await this.edit((t) => setFm(t, { amp: step }));
		} catch (e) {
			err(e);
		}
	}

	// ── AI ──

	private ctx(d: StudioData): AmpContext {
		const p = this.post;
		const g = p?.from[0] ? d.glgam.find((x) => p.from[0].includes(`#^${x.block}`)) : undefined;
		return { title: p?.title ?? "", topic: g?.text ?? "", message: this.d.message, strategy: d.strategy.get("li") ?? "" };
	}

	private async ai<T>(label: string, prompt: string, web = false): Promise<T | null> {
		if (!ampAvailable(this.plugin)) {
			new Notice("AI는 데스크톱 앱에서만 쓸 수 있어요.");
			return null;
		}
		if (this.busy) return null;
		const abort = new AbortController();
		this.busy = { label, start: Date.now(), abort };
		this.host.rerender();
		this.timer = window.setInterval(() => {
			const el = document.querySelector(".amp-busy-t");
			if (el && this.busy) el.setText(`${this.busy.label} ${Math.round((Date.now() - this.busy.start) / 1000)}초`);
		}, 1000);
		try {
			return await ampAsk<T>(this.plugin, prompt, { web, signal: abort.signal });
		} catch (e) {
			if (!abort.signal.aborted) err(e);
			return null;
		} finally {
			window.clearInterval(this.timer);
			this.busy = null;
			this.host.rerender();
		}
	}

	stop(): void {
		this.busy?.abort.abort();
	}

	// ── render ──

	render(root: HTMLElement, d: StudioData): void {
		const p = this.post;
		const wrap = root.createDiv({ cls: "st-ed is-li amp" });
		const top = wrap.createDiv({ cls: "st-row st-edtop" });
		top.createSpan({ cls: "st-mark c-li", text: "in" });
		const back = top.createEl("button", { cls: "st-link", text: "← 편집 화면", attr: { type: "button" } });
		back.addEventListener("click", async () => {
			await this.flush();
			this.stop();
			this.host.exit();
		});
		top.createSpan({ cls: "st-faint st-small st-grow st-ellipsis", text: this.path.slice(d.root.length + 1) });
		top.createSpan({ cls: "st-faint st-small", text: "자동 저장" });
		wrap.createDiv({ cls: "amp-title", text: p?.title ?? "" });

		const bar = wrap.createDiv({ cls: "amp-steps" });
		const at = AMP_STEPS.indexOf(this.step);
		AMP_STEPS.forEach((s, i) => {
			const b = bar.createEl("button", { cls: `amp-st${i < at ? " is-done" : i === at ? " is-now" : ""}`, attr: { type: "button" } });
			b.createEl("i", { text: i < at ? "✓" : String(i + 1) });
			b.appendText(s);
			const sub = this.stepSub(s);
			if (sub) b.createEl("small", { text: sub });
			b.addEventListener("click", () => void this.go(s));
		});

		const msg = wrap.createDiv({ cls: `amp-msg${this.d.message ? "" : " is-empty"}` });
		msg.createEl("b", { text: "📌 메시지" });
		if (this.d.message) {
			const s = msg.createSpan({ cls: "st-grow" });
			s.appendText("나는 사람들에게 ");
			s.createEl("u", { text: `"${this.d.message}"` });
			s.appendText("라고 말하고 싶다.");
		} else msg.createSpan({ cls: "st-grow", text: "아직 정하지 않았어요 — 「왜」에서 한 문장으로 정해요" });
		if (this.step !== "왜") {
			const fix = msg.createEl("button", { cls: "st-link", text: "고치기", attr: { type: "button" } });
			fix.addEventListener("click", () => void this.go("왜"));
		}

		const body = wrap.createDiv({ cls: "amp-body" });
		const map: Record<AmpStep, () => void> = {
			왜: () => this.renderWhy(body, d),
			질문: () => this.renderQuestions(body, d),
			답: () => this.renderAnswers(body, d),
			엮기: () => this.renderWeave(body, d),
			검토: () => this.renderReview(body, d),
			보완: () => this.renderFill(body, d),
			완료: () => this.renderDone(body),
		};
		map[this.step]();
	}

	private stepSub(s: AmpStep): string {
		const use = this.d.questions.filter((q) => q.use);
		const open = this.d.review?.items.filter((g) => !g.ok && g.mark === " ").length ?? 0;
		switch (s) {
			case "왜":
				return this.d.message ? "✓" : "";
			case "질문":
				return this.d.questions.length ? `${this.d.questions.length}개` : "";
			case "답":
				return use.length ? `${use.filter((q) => q.answer.trim()).length}/${use.length}` : "";
			case "엮기":
				return this.post?.text.trim() ? `${charCount(this.post.text)}자` : "";
			case "검토":
				return this.d.review ? `구멍 ${open}` : "";
			case "보완": {
				const all = this.d.review?.items.filter((g) => !g.ok).length ?? 0;
				return all ? `${all - open}/${all}` : "";
			}
			default:
				return "";
		}
	}

	private aiCard(parent: HTMLElement, title: string): HTMLElement {
		const c = parent.createDiv({ cls: "amp-ai" });
		const h = c.createDiv({ cls: "amp-ai-h" });
		setIcon(h.createSpan({ cls: "amp-lm" }), "sparkles");
		h.createSpan({ cls: "st-grow", text: title });
		const body = c.createDiv({ cls: "amp-ai-b" });
		if (this.busy) {
			const b = body.createDiv({ cls: "amp-busy" });
			b.createSpan({ cls: "amp-dots" });
			b.createSpan({ cls: "amp-busy-t", text: `${this.busy.label} ${Math.round((Date.now() - this.busy.start) / 1000)}초` });
			const s = b.createEl("button", { cls: "st-btn is-sm is-ghost", text: "멈추기", attr: { type: "button" } });
			s.addEventListener("click", () => this.stop());
		}
		if (!ampAvailable(this.plugin)) body.createDiv({ cls: "st-small st-faint", text: "AI는 데스크톱 앱에서 써요(루미와 같은 Claude Code / Codex 로그인)." });
		return body;
	}

	private area(parent: HTMLElement, value: string, cls: string, ph: string, onInput: (v: string) => void): HTMLTextAreaElement {
		const ta = parent.createEl("textarea", { cls, attr: { placeholder: ph, spellcheck: "false" } });
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

	private btn(parent: HTMLElement, text: string, cls: string, fn: () => void): HTMLButtonElement {
		const b = parent.createEl("button", { cls: `st-btn ${cls}`, text, attr: { type: "button" } });
		b.addEventListener("click", fn);
		return b;
	}

	// ── 1 왜 ──

	private renderWhy(body: HTMLElement, d: StudioData): void {
		const card = body.createDiv({ cls: "amp-card" });
		card.createEl("h2", { text: "나는 왜 이 메시지를 말하고 싶었지?" });
		card.createDiv({ cls: "amp-sub", text: "주제(\"~에 대해\")가 아니라 주장(\"~다\")으로. 한 문장이면 돼요." });
		const box = card.createDiv({ cls: "amp-msgbox" });
		box.createSpan({ cls: "amp-pre", text: "나는 사람들에게" });
		const ta = this.area(box, this.draftMsg ?? this.d.message, "amp-msgin", "하고 싶은 말", (v) => (this.draftMsg = v));
		box.createSpan({ cls: "amp-pre", text: "라고 말하고 싶다." });
		ta.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
				ev.preventDefault();
				pin();
			}
		});
		const row = card.createDiv({ cls: "st-row amp-actions" });
		const pin = () =>
			void (async () => {
				const v = (this.draftMsg ?? ta.value).replace(/^["“]|["”]$/g, "").trim();
				if (!v) return;
				try {
					await this.edit((t) => setMessage(t, v));
					this.draftMsg = null;
					new Notice("메시지를 고정했어요.");
					this.host.rerender();
				} catch (e) {
					err(e);
				}
			})();
		this.btn(row, "📌 메시지로 고정", "mod-cta", pin);
		row.createSpan({ cls: "st-small st-muted", text: "고정하면 모든 단계 머리에 보여요" });
		row.createDiv({ cls: "st-grow" });
		this.btn(row, "다음: 질문 →", "is-ghost", () => void this.go("질문"));
		const ctx = this.ctx(d);
		if (ctx.topic) {
			card.createDiv({ cls: "st-small st-muted amp-gap", text: "주제 · 글감" });
			card.createDiv({ cls: "st-small", text: ctx.topic });
		}

		const ai = this.aiCard(body, "생각하기");
		ai.createDiv({ cls: "st-tiny st-faint", text: "질문으로 생각을 끌어내요. 「그만」을 누를 때까지 하나씩 · 대화는 저장하지 않아요" });
		for (const [i, t] of this.talk.entries()) {
			const a = ai.createDiv({ cls: "amp-say is-ai" });
			a.createDiv({ cls: "amp-w", text: `✦ 생각하기 ${i + 1}` });
			if (t.from) a.createDiv({ cls: "amp-from", text: `↳ "${t.from}"에서` });
			a.createDiv({ text: t.q });
			if (t.a) {
				const m = ai.createDiv({ cls: "amp-say is-me" });
				m.createDiv({ cls: "amp-w", text: "나" });
				m.createDiv({ text: t.a });
			}
		}
		const last = this.talk[this.talk.length - 1];
		if (this.thinking && last && !last.a && !this.busy) {
			const ans = this.area(ai, "", "amp-ans-sm", "답을 적어요… (Enter)", () => undefined);
			const send = async () => {
				const v = ans.value.trim();
				if (!v) return;
				last.a = v;
				await this.nextThink(d, ta.value);
			};
			ans.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
					ev.preventDefault();
					void send();
				}
			});
			const r = ai.createDiv({ cls: "st-row amp-actions" });
			this.btn(r, "답하기", "mod-cta is-sm", () => void send());
			this.btn(r, "그만", "is-ghost is-sm", () => {
				this.thinking = false;
				this.talk.pop();
				this.host.rerender();
			});
			window.requestAnimationFrame(() => ans.focus());
		} else if (!this.busy) {
			const r = ai.createDiv({ cls: "st-row amp-actions" });
			this.btn(r, this.talk.length ? "✦ 계속 생각하기" : "✦ 생각하기 시작", "amp-aibtn", () => {
				this.thinking = true;
				void this.nextThink(d, ta.value);
			});
			if (this.talk.length) this.btn(r, "지우기", "is-ghost is-sm", () => ((this.talk = []), this.host.rerender()));
		}
	}

	private async nextThink(d: StudioData, draft: string): Promise<void> {
		const r = await this.ai<{ question?: string; from?: string }>("생각하는 중…", promptThink(this.ctx(d), draft, this.talk.filter((t) => t.a)));
		if (r?.question) this.talk.push({ q: r.question, a: "", from: (r.from ?? "").trim() });
		this.host.rerender();
	}

	// ── 2 질문 ──

	private renderQuestions(body: HTMLElement, d: StudioData): void {
		const card = body.createDiv({ cls: "amp-card" });
		card.createEl("h2", { text: "사람들은 이 주장에 대해 뭐가 궁금할까?" });
		card.createDiv({ cls: "amp-sub", text: "많을수록 좋아요. 먼저 내가 적고, 막히면 오른쪽 AI 질문을 받아요. 쓸 것에 ✓, 끌어서 순서." });
		const add = card.createEl("input", { cls: "amp-qadd", attr: { type: "text", placeholder: "독자가 물을 법한 질문… (Enter로 더하기)" } });
		add.addEventListener("keydown", (ev) => {
			if (ev.key !== "Enter" || ev.isComposing || !add.value.trim()) return;
			const qs = [...this.d.questions, { text: add.value.trim(), use: true, by: "나", answer: "" }];
			add.value = "";
			void this.saveQuestions(qs).then(() => {
				this.host.rerender();
				window.requestAnimationFrame(() => (document.querySelector(".amp-qadd") as HTMLInputElement | null)?.focus());
			});
		});
		const list = card.createDiv({ cls: "amp-ql" });
		let from = -1;
		this.d.questions.forEach((q, i) => {
			const r = list.createDiv({ cls: `amp-q${q.use ? "" : " is-off"}`, attr: { draggable: "true" } });
			r.createSpan({ cls: "amp-h", text: "⋮⋮" });
			const cb = r.createEl("button", { cls: `amp-cb${q.use ? " is-on" : ""}`, text: q.use ? "✓" : "", attr: { type: "button", "aria-label": "쓸 질문" } });
			cb.addEventListener("click", () => void this.saveQuestions(this.d.questions.map((x, k) => (k === i ? { ...x, use: !x.use } : x))).then(() => this.host.rerender()));
			const t = r.createSpan({ cls: "st-grow amp-qt", text: q.text });
			t.addEventListener("dblclick", () => void this.editQuestion(i));
			r.createSpan({ cls: `st-pill ${q.by === "나" ? "amp-me" : "amp-aip"}`, text: q.by === "나" ? "나" : q.by });
			if (q.answer.trim()) r.createSpan({ cls: "st-pill is-ok", text: "답함" });
			const x = r.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "빼기" } });
			setIcon(x, "x");
			x.addEventListener("click", async () => {
				if (q.answer.trim()) {
					const ok = await askForm(this.plugin.app, { title: "질문 빼기", desc: "이 질문에 쓴 답도 함께 빠져요.", fields: [], cta: "빼기" });
					if (!ok) return;
				}
				await this.saveQuestions(this.d.questions.filter((_, k) => k !== i));
				this.host.rerender();
			});
			r.addEventListener("dragstart", () => (from = i));
			r.addEventListener("dragover", (ev) => ev.preventDefault());
			r.addEventListener("drop", (ev) => {
				ev.preventDefault();
				if (from < 0 || from === i) return;
				const qs = [...this.d.questions];
				const [m] = qs.splice(from, 1);
				qs.splice(i, 0, m);
				void this.saveQuestions(qs).then(() => this.host.rerender());
			});
		});
		const foot = card.createDiv({ cls: "st-row amp-actions" });
		foot.createSpan({ cls: "st-small st-muted", text: `질문 ${this.d.questions.length} · 쓸 것 ${this.d.questions.filter((q) => q.use).length} · 두 번 누르면 고쳐요` });
		foot.createDiv({ cls: "st-grow" });
		this.btn(foot, "다음: 답 →", "is-ghost", () => void this.go("답"));

		const ai = this.aiCard(body, "AI 질문 더 보기");
		ai.createDiv({ cls: "st-tiny st-faint", text: "메시지와 내 질문을 보고, 아직 없는 관점만 제안해요" });
		if (!this.busy) {
			const r = ai.createDiv({ cls: "st-row amp-actions" });
			this.btn(r, this.sugg.length ? "✦ 다시 제안" : "✦ 질문 제안받기", "amp-aibtn", () =>
				void this.ai<{ questions?: { persona?: string; question?: string }[] }>(
					"질문을 찾는 중…",
					promptQuestions(this.ctx(d), this.d.questions.map((q) => q.text)),
				).then((r2) => {
					if (r2?.questions) this.sugg = r2.questions.filter((x) => x.question).map((x) => ({ persona: (x.persona ?? "독자").trim(), question: x.question!.trim() }));
					this.host.rerender();
				}),
			);
		}
		let last = "";
		for (const [k, s] of this.sugg.entries()) {
			if (s.persona !== last) ai.createDiv({ cls: "amp-persona", text: (last = s.persona) });
			const r = ai.createDiv({ cls: "amp-qs" });
			r.createSpan({ cls: "st-grow", text: s.question });
			this.btn(r, "＋", "is-sm", () => {
				this.sugg.splice(k, 1);
				void this.saveQuestions([...this.d.questions, { text: s.question, use: true, by: `AI·${s.persona}`, answer: "" }]).then(() => this.host.rerender());
			});
			this.btn(r, "✕", "is-sm is-ghost", () => {
				this.sugg.splice(k, 1);
				this.host.rerender();
			});
		}
	}

	private async editQuestion(i: number): Promise<void> {
		const q = this.d.questions[i];
		const v = await askForm(this.plugin.app, { title: "질문 고치기", fields: [{ key: "t", label: "질문", type: "text", value: q.text }], cta: "저장" });
		if (!v?.t) return;
		await this.saveQuestions(this.d.questions.map((x, k) => (k === i ? { ...x, text: v.t } : x)));
		this.host.rerender();
	}

	// ── 3 답 ──

	private renderAnswers(body: HTMLElement, d: StudioData): void {
		body.addClass("is-one");
		const use = this.d.questions.filter((q) => q.use);
		if (!use.length) {
			const c = body.createDiv({ cls: "amp-card" });
			c.createDiv({ cls: "st-muted", text: "쓸 질문(✓)이 아직 없어요." });
			this.btn(c, "← 질문으로", "", () => void this.go("질문"));
			return;
		}
		this.cur = Math.min(this.cur, use.length - 1);
		const lay = body.createDiv({ cls: "amp-anslay" });
		const nav = lay.createDiv({ cls: "amp-qnav" });
		nav.createDiv({ cls: "st-small st-muted amp-pad", text: `질문 ${use.length} · 답 ${use.filter((q) => q.answer.trim()).length}` });
		use.forEach((q, i) => {
			const n = nav.createDiv({ cls: `amp-qn${q.answer.trim() ? " is-done" : ""}${i === this.cur ? " is-now" : ""}` });
			n.createSpan({ cls: "amp-d" });
			n.createSpan({ text: q.text });
			n.addEventListener("click", () => void this.saveQuestions().then(() => ((this.cur = i), this.host.rerender())));
		});
		const q = use[this.cur];
		const card = lay.createDiv({ cls: "amp-card" });
		const meta = card.createDiv({ cls: "st-row st-small st-muted" });
		meta.createSpan({ cls: `st-pill ${q.by === "나" ? "amp-me" : "amp-aip"}`, text: q.by });
		meta.createSpan({ text: `질문 ${this.cur + 1} / ${use.length}` });
		card.createDiv({ cls: "amp-qbig", text: q.text });
		const ta = this.area(card, q.answer, "amp-ansbox", "말하듯이 길게 적어요. 장면, 숫자, 그때 든 생각…", (v) => {
			q.answer = v;
			this.saveAnswersLater();
		});
		window.requestAnimationFrame(() => {
			ta.focus();
			ta.setSelectionRange(ta.value.length, ta.value.length);
		});
		const probe = this.probe.get(q.text);
		if (probe) {
			const pb = card.createDiv({ cls: "amp-probe" });
			setIcon(pb.createSpan({ cls: "amp-lm" }), "sparkles");
			const t = pb.createDiv({ cls: "st-grow" });
			t.createEl("b", { text: "하나만 더: " });
			t.appendText(probe);
			const r = t.createDiv({ cls: "st-row amp-actions" });
			this.btn(r, "이어서 답하기", "is-sm", () => ta.focus());
			this.btn(r, "괜찮아요", "is-sm is-ghost", () => (this.probe.delete(q.text), this.host.rerender()));
		}
		const row = card.createDiv({ cls: "st-row amp-actions" });
		if (!this.busy)
			this.btn(row, "✦ 생각하기", "amp-aibtn is-sm", () =>
				void this.saveQuestions().then(() =>
					this.ai<{ question?: string | null }>("생각하는 중…", promptProbe(this.ctx(d), q.text, ta.value)).then((r) => {
						if (r) this.probe.set(q.text, r.question || "충분히 구체적이에요. 다음 질문으로 가도 좋아요.");
						this.host.rerender();
					}),
				),
			);
		else this.busyInline(row);
		row.createSpan({ cls: "st-tiny st-faint", text: "답은 그대로 저장돼요 · AI가 고치거나 요약하지 않아요" });
		row.createDiv({ cls: "st-grow" });
		if (this.cur > 0) this.btn(row, "← 이전", "", () => void this.saveQuestions().then(() => (this.cur--, this.host.rerender())));
		if (this.cur < use.length - 1) this.btn(row, "다음 질문 →", "mod-cta", () => void this.saveQuestions().then(() => (this.cur++, this.host.rerender())));
		else this.btn(row, "엮기로 →", "mod-cta", () => void this.saveQuestions().then(() => this.go("엮기")));
	}

	private busyInline(parent: HTMLElement): void {
		if (!this.busy) return;
		const b = parent.createDiv({ cls: "amp-busy" });
		b.createSpan({ cls: "amp-dots" });
		b.createSpan({ cls: "amp-busy-t", text: this.busy.label });
		this.btn(b, "멈추기", "is-sm is-ghost", () => this.stop());
	}

	// ── 4 엮기 ──

	private renderWeave(body: HTMLElement, d: StudioData): void {
		body.addClass("is-weave");
		const use = this.d.questions.filter((q) => q.use);
		const left = body.createDiv();
		const text = () => this.pendingBody ?? this.post?.text ?? "";
		const hd = left.createDiv({ cls: "st-row st-small st-muted amp-pad" });
		hd.createSpan({ cls: "st-grow", text: `답 ${use.filter((q) => q.answer.trim()).length} · 눌러서 원고 커서 자리에` });
		this.btn(hd, "안 쓴 답 모두 넣기", "is-sm", () => {
			const add = use.filter((q) => q.answer.trim() && !answerUsed(q.answer, text())).map((q) => q.answer.trim());
			if (!add.length) return;
			this.putBody([text().trim(), ...add].filter(Boolean).join("\n\n"));
		});
		if (this.order) {
			const pb = left.createDiv({ cls: "amp-probe" });
			setIcon(pb.createSpan({ cls: "amp-lm" }), "sparkles");
			const t = pb.createDiv({ cls: "st-grow" });
			t.createEl("b", { text: "순서 제안 " });
			t.appendText(`${this.order.order.join(" → ")} · ${this.order.why}`);
			const r = t.createDiv({ cls: "st-row amp-actions" });
			this.btn(r, "이 순서로", "is-sm", () => {
				const o = this.order!.order.map((n) => use[n - 1]).filter(Boolean);
				const rest = this.d.questions.filter((q) => !o.includes(q));
				this.order = null;
				void this.saveQuestions([...o, ...rest]).then(() => this.host.rerender());
			});
			this.btn(r, "그대로", "is-sm is-ghost", () => ((this.order = null), this.host.rerender()));
		} else if (!this.busy && use.length > 2) {
			this.btn(left, "✦ 순서 제안", "amp-aibtn is-sm", () =>
				void this.ai<{ order?: number[]; why?: string }>("순서를 보는 중…", promptOrder(this.ctx(d), use)).then((r) => {
					if (r?.order?.length) this.order = { order: r.order.filter((n) => n >= 1 && n <= use.length), why: r.why ?? "" };
					this.host.rerender();
				}),
			);
		} else this.busyInline(left);
		use.forEach((q, i) => {
			const used = !!q.answer.trim() && answerUsed(q.answer, text());
			const b = left.createDiv({ cls: `amp-blk${used ? " is-used" : ""}${q.answer.trim() ? "" : " is-empty"}` });
			b.createDiv({ cls: "amp-bq", text: `Q${i + 1} · ${q.text}` });
			b.createDiv({ cls: "amp-bt", text: q.answer.trim() || "(답 없음)" });
			if (used) b.createSpan({ cls: "st-pill is-ok", text: "원고에 있음" });
			else if (q.answer.trim())
				b.addEventListener("click", () => {
					const ta = this.bodyArea;
					const cur = text();
					const at = ta && document.activeElement === ta ? ta.selectionStart : (this.lastCaret ?? cur.length);
					const before = cur.slice(0, at).replace(/\s+$/, "");
					const after = cur.slice(at).replace(/^\s+/, "");
					this.putBody([before, q.answer.trim(), after].filter(Boolean).join("\n\n"));
				});
		});

		const post = body.createDiv({ cls: "st-lipost amp-post" });
		const ph = post.createDiv({ cls: "st-liph" });
		ph.createDiv({ cls: "st-liav" });
		const nm = ph.createDiv();
		nm.createEl("b", { text: "원고" });
		nm.createDiv({ cls: "st-tiny st-faint", text: "답을 눌러 넣고, 첫 줄·이음말·끝 줄은 직접 써요" });
		const tw = post.createDiv({ cls: "st-libody" });
		const ft = post.createDiv({ cls: "st-lifoot" });
		const stat = ft.createSpan({ text: "" });
		ft.createDiv({ cls: "st-grow" });
		const cnt = ft.createSpan({ cls: "st-count" });
		const upd = (v: string) => {
			const ps = paragraphs(v);
			const from = ps.filter((p) => use.some((q) => q.answer && answerUsed(p, q.answer))).length;
			stat.setText(`답에서 옮긴 문단 ${from} · 직접 쓴 문단 ${ps.length - from}`);
			cnt.setText(`${charCount(v).toLocaleString()} / 3,000자`);
			cnt.toggleClass("is-over", charCount(v) > 3000);
		};
		this.bodyArea = this.area(tw, text(), "st-body", "원고 — 왼쪽 답을 눌러 넣어요", (v) => {
			this.pendingBody = v;
			upd(v);
			this.saveBodyLater();
		});
		this.bodyArea.addEventListener("blur", () => (this.lastCaret = this.bodyArea?.selectionStart ?? null));
		upd(text());
		const nx = body.createDiv({ cls: "st-row amp-actions amp-span" });
		nx.createDiv({ cls: "st-grow" });
		this.btn(nx, "다음: 검토 →", "mod-cta", () => void this.go("검토"));
	}
	private lastCaret: number | null = null;

	private putBody(v: string): void {
		this.pendingBody = v;
		void this.saveBody().then(() => this.host.rerender());
	}

	// ── 5 검토 ──

	private renderReview(body: HTMLElement, d: StudioData): void {
		const text = this.post?.text ?? "";
		const items = this.d.review?.items ?? [];
		const post = body.createDiv({ cls: "st-lipost amp-post" });
		const ph = post.createDiv({ cls: "st-liph" });
		ph.createDiv({ cls: "st-liav" });
		const nm = ph.createDiv({ cls: "st-grow" });
		nm.createEl("b", { text: "원고" });
		const open = items.filter((g) => !g.ok && g.mark === " ");
		nm.createDiv({ cls: "st-tiny st-faint", text: this.d.review ? `검토 ${this.d.review.stamp} · 구멍 ${open.length} · 괜찮음 ${items.filter((g) => g.ok).length}` : "아직 검토하지 않았어요" });
		const tx = post.createDiv({ cls: "amp-read" });
		const marks = open.filter((g) => g.at).map((g) => ({ at: atText(g.at), lens: g.lens }));
		for (const p of paragraphs(text)) {
			const el = tx.createEl("p");
			let rest = p;
			while (rest) {
				let best: { i: number; at: string; lens: string } | null = null;
				for (const m of marks) {
					const i = rest.indexOf(m.at);
					if (i >= 0 && (!best || i < best.i)) best = { i, ...m };
				}
				if (!best) {
					el.appendText(rest);
					break;
				}
				el.appendText(rest.slice(0, best.i));
				el.createSpan({ cls: `amp-hl l-${LENSES.indexOf(best.lens as (typeof LENSES)[number])}`, text: best.at });
				rest = rest.slice(best.i + best.at.length);
			}
		}
		if (!text.trim()) tx.createDiv({ cls: "st-faint", text: "원고가 비어 있어요. 「엮기」에서 먼저 써요." });
		post.createDiv({ cls: "st-lifoot" }).createSpan({ cls: "st-count", text: `${charCount(text).toLocaleString()} / 3,000자` });

		const ai = this.aiCard(body, "검토 · 다섯 렌즈");
		ai.createDiv({ cls: "st-tiny st-faint", text: "후킹 · 흐름 · 표현 · 메시지 · 근거·디테일. 고쳐 쓴 문장 대신 구멍과 독자의 질문을 줘요." });
		if (!this.busy) {
			const r = ai.createDiv({ cls: "st-row amp-actions" });
			this.btn(r, this.d.review ? "✦ 다시 검토" : "✦ 검토하기", "amp-aibtn", () => void this.runReview(d));
		}
		const lenses = [...new Set([...LENSES, ...items.map((g) => g.lens)])];
		for (const lens of lenses) {
			const mine = items.filter((g) => g.lens === lens);
			if (!mine.length) continue;
			const gaps = mine.filter((g) => !g.ok);
			const l = ai.createDiv({ cls: "amp-lens" });
			const h = l.createDiv({ cls: "amp-lh" });
			const todo = gaps.filter((g) => g.mark === " ").length;
			h.createSpan({ cls: `st-pill ${todo ? "amp-bad" : "is-ok"}`, text: todo ? "!" : "✓" });
			h.createSpan({ cls: "st-grow", text: lens });
			h.createSpan({ cls: "st-tiny st-faint", text: gaps.length ? `구멍 ${todo}/${gaps.length}` : "괜찮음" });
			for (const g of mine.filter((x) => x.ok)) l.createDiv({ cls: "amp-ok", text: g.finding });
			for (const g of gaps) {
				const it = l.createDiv({ cls: `amp-li${g.mark !== " " ? " is-closed" : ""}` });
				const t = it.createDiv();
				if (g.at) t.createEl("b", { text: `"${atText(g.at)}" ` });
				t.appendText(`— ${g.finding}`);
				if (g.ask) it.createDiv({ cls: "amp-w", text: `독자 질문: "${g.ask}"` });
				if (g.mark === "x") it.createDiv({ cls: "amp-w is-ok", text: "✓ 보완함" });
				else if (g.mark === "-") it.createDiv({ cls: "amp-w", text: `안 고침${g.why ? ` · ${g.why}` : ""}` });
				else {
					const r = it.createDiv({ cls: "st-row amp-actions" });
					const idx = items.indexOf(g);
					this.btn(r, "보완하기", "mod-cta is-sm", () => ((this.gap = idx), void this.go("보완")));
					this.btn(r, "✦ 근거 찾아 줘", "amp-aibtn is-sm", () => {
						this.gap = idx;
						void this.go("보완").then(() => this.search(d, g));
					});
					this.btn(r, "괜찮아", "is-sm is-ghost", () => void this.keep(idx));
				}
			}
		}
	}

	private async runReview(d: StudioData): Promise<void> {
		await this.flush();
		const text = this.post?.text ?? "";
		if (!text.trim()) return void new Notice("원고가 비어 있어요.");
		const r = await this.ai<Parameters<typeof reviewItems>[0]>("검토하는 중…", promptReview(this.ctx(d), text));
		if (!r) return;
		const items = reviewItems(r, text);
		try {
			await this.edit((t) => setReview(t, moment().format("YYYY-MM-DD HH:mm"), items));
			this.gap = 0;
		} catch (e) {
			err(e);
		}
		this.host.rerender();
	}

	private async setGap(idx: number, g: Partial<AmpGap>): Promise<void> {
		const rv = this.d.review;
		if (!rv) return;
		const items = rv.items.map((x, k) => (k === idx ? { ...x, ...g } : x));
		await this.edit((t) => setReview(t, rv.stamp, items));
	}

	private async keep(idx: number): Promise<void> {
		const v = await askForm(this.plugin.app, { title: "그대로 둘까요?", fields: [{ key: "why", label: "이유 (선택)", type: "text", value: "", placeholder: "예: 내 고유 언어라 유지" }], cta: "그대로 두기" });
		if (!v) return;
		try {
			await this.setGap(idx, { mark: "-", why: v.why });
		} catch (e) {
			err(e);
		}
		this.host.rerender();
	}

	// ── 6 보완 ──

	private renderFill(body: HTMLElement, d: StudioData): void {
		const items = this.d.review?.items ?? [];
		const gaps = items.map((g, i) => ({ g, i })).filter((x) => !x.g.ok);
		const left = body.createDiv();
		if (!gaps.length) {
			const c = left.createDiv({ cls: "amp-card" });
			c.createDiv({ cls: "st-muted", text: this.d.review ? "보완할 구멍이 없어요." : "먼저 「검토」를 해요." });
			this.btn(c, this.d.review ? "완료로 →" : "← 검토로", "", () => void this.go(this.d.review ? "완료" : "검토"));
			return;
		}
		if (!gaps.some((x) => x.i === this.gap)) this.gap = (gaps.find((x) => x.g.mark === " ") ?? gaps[0]).i;
		const g = items[this.gap];
		const card = left.createDiv({ cls: "amp-card" });
		const meta = card.createDiv({ cls: "st-row" });
		meta.createSpan({ cls: "st-pill amp-bad", text: g.lens });
		const n = gaps.findIndex((x) => x.i === this.gap);
		meta.createSpan({ cls: "st-small st-muted", text: `${n + 1} / ${gaps.length}` });
		if (g.mark === "x") meta.createSpan({ cls: "st-pill is-ok", text: "보완함" });
		if (g.mark === "-") meta.createSpan({ cls: "st-pill", text: "안 고침" });
		meta.createDiv({ cls: "st-grow" });
		if (n > 0) this.btn(meta, "‹", "is-sm is-ghost", () => ((this.gap = gaps[n - 1].i), (this.fill = ""), this.host.rerender()));
		if (n < gaps.length - 1) this.btn(meta, "›", "is-sm is-ghost", () => ((this.gap = gaps[n + 1].i), (this.fill = ""), this.host.rerender()));
		card.createDiv({ cls: "amp-gq", text: g.ask || g.finding });
		if (g.ask) card.createDiv({ cls: "st-small st-muted", text: g.finding });
		if (g.at) card.createDiv({ cls: "amp-quote", text: atText(g.at) });
		card.createDiv({ cls: "st-small st-muted amp-gap", text: "내 말로 채워요. 찾은 근거는 오른쪽에서 골라 참고해요." });
		const ta = this.area(card, this.fill, "amp-ansbox is-sm", "채울 문장을 직접 써요", (v) => (this.fill = v));
		const r = card.createDiv({ cls: "st-row amp-actions" });
		r.createSpan({ cls: "st-tiny st-faint", text: g.at ? "원고에서 짚은 구절이 있는 문단 뒤에 들어가요" : "원고 끝에 들어가요" });
		r.createDiv({ cls: "st-grow" });
		this.btn(r, "괜찮아", "is-ghost", () => void this.keep(this.gap));
		this.btn(r, "원고에 넣기", "mod-cta", () =>
			void (async () => {
				const v = ta.value.trim();
				if (!v) return;
				try {
					await this.edit((t) => setPostBody(t, LI, { text: insertAfter(parsePost(this.path, t, LI).text, g.at, v) }));
					await this.setGap(this.gap, { mark: "x" });
					this.fill = "";
					const next = gaps.find((x) => x.i !== this.gap && x.g.mark === " ");
					if (next) this.gap = next.i;
					new Notice("원고에 넣었어요.");
				} catch (e) {
					err(e);
				}
				this.host.rerender();
			})(),
		);
		const done = gaps.filter((x) => x.g.mark !== " ").length;
		const foot = left.createDiv({ cls: "st-row amp-actions" });
		foot.createSpan({ cls: "st-small st-muted", text: `보완 ${done} / ${gaps.length}` });
		foot.createDiv({ cls: "st-grow" });
		this.btn(foot, "다음: 완료 →", "is-ghost", () => void this.go("완료"));

		const ai = this.aiCard(body, "근거 찾기 · 웹 검색");
		const key = this.gapKey(g);
		const res = this.results.get(key);
		if (!this.busy) {
			const rr = ai.createDiv({ cls: "st-row amp-actions" });
			this.btn(rr, res ? "✦ 다시 찾기" : "✦ 근거 찾아 줘", "amp-aibtn", () => void this.search(d, g));
		}
		if (res) {
			if (!res.length) ai.createDiv({ cls: "st-small st-muted", text: "확인된 근거를 찾지 못했어요." });
			for (const x of res) {
				const id = `${key}|${x.url}`;
				const c = ai.createDiv({ cls: `amp-res${this.picked.has(id) ? " is-pick" : ""}` });
				c.createEl("b", { text: x.claim || x.title });
				c.createDiv({ cls: "amp-rq", text: `"${x.quote}"` });
				const s = c.createDiv({ cls: "amp-rs" });
				const a = s.createEl("a", { text: [x.title, x.outlet, x.year].filter(Boolean).join(" · "), href: x.url });
				a.setAttr("target", "_blank");
				c.addEventListener("click", (ev) => {
					if ((ev.target as HTMLElement).closest("a")) return;
					if (this.picked.has(id)) this.picked.delete(id);
					else this.picked.add(id);
					this.host.rerender();
				});
			}
			const chosen = res.filter((x) => this.picked.has(`${key}|${x.url}`));
			if (chosen.length) {
				const rr = ai.createDiv({ cls: "st-row amp-actions" });
				this.btn(rr, `고른 ${chosen.length}개 「자료」에 저장`, "mod-cta is-sm", () =>
					void (async () => {
						const add: AmpSource[] = chosen.map((x) => ({ quote: x.quote, title: x.title, url: x.url, outlet: x.outlet, year: x.year, found: moment().format("YYYY-MM-DD") }));
						try {
							await this.edit((t) => addSources(t, add));
							for (const x of chosen) this.picked.delete(`${key}|${x.url}`);
							new Notice("「자료」에 저장했어요.");
						} catch (e) {
							err(e);
						}
						this.host.rerender();
					})(),
				);
			}
			ai.createDiv({ cls: "st-tiny st-faint", text: "숫자는 출처를 열어 확인한 뒤 써요. 고른 것만 인용 문장과 출처로 「자료」에 남아요." });
		}
		if (this.d.sources.length) {
			ai.createDiv({ cls: "amp-persona", text: `자료 ${this.d.sources.length}` });
			for (const s of this.d.sources) {
				const c = ai.createDiv({ cls: "amp-src" });
				c.createDiv({ text: `"${s.quote}"` });
				const a = c.createEl("a", { cls: "st-tiny", text: [s.title, s.outlet, s.year].filter(Boolean).join(" · ") || s.url, href: s.url });
				a.setAttr("target", "_blank");
			}
		}
	}

	private gapKey(g: AmpGap): string {
		return `${g.lens}|${g.finding}`;
	}

	private async search(d: StudioData, g: AmpGap): Promise<void> {
		const r = await this.ai<{ results?: Partial<Result>[] }>("웹에서 근거를 찾는 중…", promptSources(this.ctx(d), g, this.post?.text ?? ""), true);
		if (r)
			this.results.set(
				this.gapKey(g),
				(r.results ?? []).filter((x) => x.url && /^https?:\/\//.test(x.url) && x.quote).map((x) => ({ title: x.title ?? "", url: x.url!, outlet: x.outlet ?? "", year: String(x.year ?? ""), quote: x.quote!, claim: x.claim ?? "" })),
			);
		this.host.rerender();
	}

	// ── 7 완료 ──

	private renderDone(body: HTMLElement): void {
		body.addClass("is-one");
		const qs = this.d.questions;
		const mine = qs.filter((q) => q.by === "나").length;
		const ansChars = qs.reduce((n, q) => n + charCount(q.answer), 0);
		const gaps = this.d.review?.items.filter((g) => !g.ok) ?? [];
		const sum = body.createDiv({ cls: "amp-sum" });
		const kpi = (k: string, v: string, s: string) => {
			const c = sum.createDiv({ cls: "amp-kpi" });
			c.createDiv({ cls: "amp-k", text: k });
			c.createDiv({ cls: "amp-v", text: v });
			c.createDiv({ cls: "st-tiny st-faint", text: s });
		};
		kpi("꺼낸 질문", String(qs.length), `나 ${mine} · AI ${qs.length - mine}`);
		kpi("답한 글자", ansChars.toLocaleString(), `원고의 ${shareFromAnswers(this.post?.text ?? "", qs)}%가 답에서`);
		kpi("보완한 구멍", `${gaps.filter((g) => g.mark === "x").length} / ${gaps.length}`, `안 고침 ${gaps.filter((g) => g.mark === "-").length}`);
		kpi("근거", String(this.d.sources.length), "출처 있음");
		const card = body.createDiv({ cls: "amp-card" });
		card.createEl("h2", { text: "끝내기 전에" });
		card.createDiv({ cls: "amp-sub", text: `원고 ${charCount(this.post?.text ?? "").toLocaleString()}자 · 남은 구멍 ${gaps.filter((g) => g.mark === " ").length}` });
		const r = card.createDiv({ cls: "st-row st-wrap amp-actions" });
		this.btn(r, "✦ 마지막 검토 한 번", "amp-aibtn", () => void this.go("검토"));
		r.createDiv({ cls: "st-grow" });
		r.createSpan({ cls: "st-small st-muted", text: "다음 단계" });
		let next: "미디어" | "예약" = "미디어";
		const seg = r.createDiv({ cls: "st-seg" });
		const bs = (["미디어", "예약"] as const).map((s) => {
			const b = seg.createEl("button", { cls: s === next ? "is-on" : "", text: s, attr: { type: "button" } });
			b.addEventListener("click", () => {
				next = s;
				bs.forEach((x) => x.toggleClass("is-on", x === b));
			});
			return b;
		});
		this.btn(r, "완료 → 편집 화면", "mod-cta", () =>
			void (async () => {
				try {
					await this.flush();
					await this.edit((t) => setFm(t, { amp: "완료", stage: next === "예약" ? "다듬기" : "미디어" }));
				} catch (e) {
					err(e);
				}
				this.host.exit();
			})(),
		);
		card.createDiv({ cls: "st-tiny st-faint", text: "「예약」을 고르면 편집 화면에서 날짜를 정해 보내요." });
	}
}

/** Questions answered (for the editor's button label). */
export function ampProgress(text: string): string {
	const a = parseAmp(text);
	if (!a.message && !a.questions.length) return "";
	const use = a.questions.filter((q: AmpQuestion) => q.use);
	return `${a.message ? "메시지 ✓ · " : ""}답 ${use.filter((q) => q.answer.trim()).length}/${use.length}`;
}
