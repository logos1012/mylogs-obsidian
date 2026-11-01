/**
 * 글 증폭 (`12 Flywheel/99 작업실/글 증폭 PRD.md`) — the data in the post file and the prompts.
 *
 *   ## 본문      the manuscript (the only part that is sent)
 *   ## 메시지    나는 사람들에게 "…"라고 말하고 싶다.
 *   ## 질문      ### 질문 ✓ (by:: 나 | AI·독자 유형) + the user's answer below
 *   ## 검토 YYYY-MM-DD HH:mm   - [ ] 렌즈 · 구멍 (ask:: 독자 질문) (at:: 원고 구절)
 *   ## 자료      - "인용" — [제목](url), 매체, 연도 (찾음 YYYY-MM-DD, 웹 검색)
 *
 * The AI only asks (생각하기), adds questions, reviews through five lenses and finds sources.
 * It never writes the manuscript or the user's answers. Pure module.
 */

import { splitFm, splitSections, type Section, joinSections } from "./model.ts";

export const AMP_STEPS = ["왜", "질문", "답", "엮기", "검토", "보완", "완료"] as const;
export type AmpStep = (typeof AMP_STEPS)[number];
export const isAmpStep = (s: string): s is AmpStep => (AMP_STEPS as readonly string[]).includes(s);

export const LENSES = ["후킹", "흐름", "표현", "메시지", "근거·디테일"] as const;

export interface AmpQuestion {
	text: string;
	use: boolean;
	/** `나` or `AI·{독자 유형}` */
	by: string;
	answer: string;
}

export interface AmpGap {
	mark: " " | "x" | "-";
	lens: string;
	/** What is missing (or, for a 괜찮음 line, what works). */
	finding: string;
	/** The reader's question this gap leaves. */
	ask: string;
	/** A passage of the manuscript it points at ("" = the whole). */
	at: string;
	why: string;
	/** A 「괜찮음」 note, not a gap. */
	ok: boolean;
}

export interface AmpSource {
	quote: string;
	title: string;
	url: string;
	outlet: string;
	year: string;
	found: string;
}

export interface AmpData {
	message: string;
	questions: AmpQuestion[];
	review: { stamp: string; items: AmpGap[] } | null;
	sources: AmpSource[];
}

// ───────────────────────── sections ─────────────────────────

const trimLines = (lines: string[]) => {
	let a = 0;
	let b = lines.length;
	while (a < b && !lines[a].trim()) a++;
	while (b > a && !lines[b - 1].trim()) b--;
	return lines.slice(a, b);
};

/** Replace (or add, after the last section) one `## heading` section; `match` finds it by prefix. */
export function setSection(text: string, heading: string, lines: string[] | null, match = heading): string {
	const { fm, body } = splitFm(text);
	const head = fm ? `---\n${fm.join("\n")}\n---\n` : "";
	const secs = splitSections(body);
	const i = secs.findIndex((s) => s.heading !== null && (s.heading === match || s.heading.startsWith(`${match} `)));
	if (lines === null) {
		if (i >= 0) secs.splice(i, 1);
	} else if (i >= 0) secs[i] = { heading, lines };
	else secs.push({ heading, lines } as Section);
	return head + "\n" + joinSections(secs);
}

const sectionOf = (secs: Section[], name: string) => secs.find((s) => s.heading !== null && (s.heading === name || s.heading.startsWith(`${name} `)));

// ───────────────────────── 메시지 ─────────────────────────

const MSG_RE = /^나는 사람들에게\s*[“"](.*)[”"]\s*(?:라고|이라고)\s*말하고 싶다\.?$/s;

export function messageLine(core: string): string {
	return `나는 사람들에게 "${core.replace(/\s+/g, " ").trim()}"라고 말하고 싶다.`;
}

export function parseMessage(lines: string[]): string {
	const t = trimLines(lines).join(" ").trim();
	const m = MSG_RE.exec(t);
	return m ? m[1].trim() : t;
}

// ───────────────────────── 질문 ─────────────────────────

const Q_HEAD = /^###\s+(.+?)\s*$/;

export function parseQuestions(lines: string[]): AmpQuestion[] {
	const out: AmpQuestion[] = [];
	let cur: AmpQuestion | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (cur) {
			cur.answer = trimLines(buf).join("\n");
			out.push(cur);
		}
		buf = [];
	};
	for (const l of lines) {
		const h = Q_HEAD.exec(l);
		if (h) {
			flush();
			let s = h[1];
			const by = /\s*\(by::\s*([^)]*)\)\s*$/.exec(s);
			if (by) s = s.slice(0, by.index);
			const use = /\s✓$/.test(s);
			cur = { text: s.replace(/\s✓$/, "").trim(), use, by: by?.[1].trim() || "나", answer: "" };
		} else if (cur) buf.push(l);
	}
	flush();
	return out;
}

export function formatQuestions(qs: AmpQuestion[]): string[] {
	const out: string[] = [];
	for (const q of qs) {
		out.push(`### ${q.text.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim()}${q.use ? " ✓" : ""} (by:: ${q.by || "나"})`, "");
		if (q.answer.trim()) out.push(...q.answer.replace(/^#{1,6}\s/gm, "").split("\n"), "");
	}
	return trimLines(out);
}

// ───────────────────────── 검토 ─────────────────────────

const field = (s: string, k: string) => new RegExp(`\\(${k}::\\s*([^)]*)\\)`).exec(s)?.[1].trim() ?? "";
const clean = (s: string) => s.replace(/\(/g, "（").replace(/\)/g, "）").replace(/\s+/g, " ").trim();

export function parseReview(heading: string, lines: string[]): { stamp: string; items: AmpGap[] } {
	const items: AmpGap[] = [];
	for (const l of lines) {
		const m = /^\s*-\s\[([ x-])\]\s+(.*)$/.exec(l);
		if (!m) continue;
		const rest = m[2];
		const main = rest.replace(/\s*\([a-z]+::[^)]*\)/g, "").trim();
		const dot = main.indexOf(" · ");
		const lens = dot > 0 ? main.slice(0, dot).trim() : "";
		let finding = dot > 0 ? main.slice(dot + 3).trim() : main;
		const ok = /^괜찮음:\s*/.test(finding);
		finding = finding.replace(/^괜찮음:\s*/, "");
		items.push({ mark: m[1] as " " | "x" | "-", lens, finding, ask: field(rest, "ask"), at: field(rest, "at"), why: field(rest, "why"), ok });
	}
	return { stamp: heading.replace(/^검토\s*/, "").trim(), items };
}

export function formatGap(g: AmpGap): string {
	const tail = [g.ask && `(ask:: ${clean(g.ask)})`, g.at && `(at:: ${clean(g.at)})`, g.why && `(why:: ${clean(g.why)})`].filter(Boolean).join(" ");
	return `- [${g.mark}] ${g.lens} · ${g.ok ? "괜찮음: " : ""}${clean(g.finding)}${tail ? ` ${tail}` : ""}`;
}

/** `at` was written with （ ） in place of ( ) — back to the manuscript's characters for finding. */
export const atText = (at: string) => at.replace(/（/g, "(").replace(/）/g, ")");

// ───────────────────────── 자료 ─────────────────────────

export function formatSource(s: AmpSource): string {
	const where = [s.title && s.url ? `[${s.title.replace(/[[\]]/g, "")}](${s.url})` : s.url || s.title, s.outlet, s.year].filter(Boolean).join(", ");
	return `- "${s.quote.replace(/\s+/g, " ").replace(/"/g, "'").trim()}" — ${where} (찾음 ${s.found}, 웹 검색)`;
}

export function parseSources(lines: string[]): AmpSource[] {
	const out: AmpSource[] = [];
	for (const l of lines) {
		const m = /^\s*-\s+"(.*)"\s+—\s+(.*?)\s*(?:\(찾음\s+(\d{4}-\d{2}-\d{2})[^)]*\))?\s*$/.exec(l);
		if (!m) continue;
		const link = /\[([^\]]*)\]\(([^)]+)\)/.exec(m[2]);
		const rest = m[2].replace(/\[[^\]]*\]\([^)]+\)/, "").split(",").map((x) => x.trim()).filter(Boolean);
		out.push({ quote: m[1], title: link?.[1] ?? rest.shift() ?? "", url: link?.[2] ?? "", outlet: rest[0] ?? "", year: rest[1] ?? "", found: m[3] ?? "" });
	}
	return out;
}

// ───────────────────────── whole ─────────────────────────

export function parseAmp(text: string): AmpData {
	const secs = splitSections(splitFm(text).body);
	const msg = sectionOf(secs, "메시지");
	const qs = sectionOf(secs, "질문");
	const rv = sectionOf(secs, "검토");
	const src = sectionOf(secs, "자료");
	return {
		message: msg ? parseMessage(msg.lines) : "",
		questions: qs ? parseQuestions(qs.lines) : [],
		review: rv ? parseReview(rv.heading!, rv.lines) : null,
		sources: src ? parseSources(src.lines) : [],
	};
}

export const setMessage = (text: string, core: string) => setSection(text, "메시지", core.trim() ? [messageLine(core)] : null);
export const setQuestions = (text: string, qs: AmpQuestion[]) => setSection(text, "질문", qs.length ? formatQuestions(qs) : null);
export const setReview = (text: string, stamp: string, items: AmpGap[]) => setSection(text, `검토 ${stamp}`, items.map(formatGap), "검토");
export const addSources = (text: string, add: AmpSource[]) => {
	const cur = parseAmp(text).sources;
	const all = [...cur, ...add.filter((a) => !cur.some((c) => c.url && c.url === a.url && c.quote === a.quote))];
	return setSection(text, "자료", all.map(formatSource));
};

// ───────────────────────── 엮기 helpers ─────────────────────────

/** Paragraphs of the manuscript (blank-line separated). */
export const paragraphs = (body: string) =>
	body
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean);

const norm = (s: string) => s.replace(/\s+/g, "").replace(/[.,!?…'"“”‘’]/g, "");

/** Is an answer (or most of it) already in the manuscript? */
export function answerUsed(answer: string, body: string): boolean {
	const a = norm(answer);
	if (a.length < 8) return false;
	const b = norm(body);
	if (b.includes(a)) return true;
	// most of its sentences are there (the user edited a bit)
	const sents = answer.split(/(?<=[.!?。])\s+|\n+/).map(norm).filter((x) => x.length >= 8);
	return sents.length > 0 && sents.filter((s) => b.includes(s)).length / sents.length >= 0.6;
}

/** Share of the manuscript (characters) that came from answers. */
export function shareFromAnswers(body: string, qs: AmpQuestion[]): number {
	const ps = paragraphs(body);
	const total = ps.reduce((n, p) => n + p.length, 0);
	if (!total) return 0;
	const from = ps.filter((p) => qs.some((q) => q.answer && (norm(q.answer).includes(norm(p)) || answerUsed(p, q.answer)))).reduce((n, p) => n + p.length, 0);
	return Math.round((from / total) * 100);
}

// ───────────────────────── prompts ─────────────────────────

export const AMP_SYSTEM = [
	"너는 MyLogs 콘텐츠 스튜디오의 「글 증폭」 조수다. 사용자가 링크드인 글을 직접 쓰도록 생각을 끌어내는 일만 한다.",
	"절대 하지 않는 것: 본문 문장을 써 주기, 고쳐 쓴 문장 제안, 사용자의 답 요약·수정, 출처 없는 숫자, 파일 쓰기.",
	"말투: 짧고 다정한 한국어 존댓말(~요). 한 번에 하나만.",
	"출력은 요청한 JSON 하나만. 코드 블록이나 설명 없이.",
].join("\n");

export interface AmpContext {
	title: string;
	topic: string;
	message: string;
	strategy: string;
}

const ctxBlock = (c: AmpContext) =>
	[`글 제목: ${c.title}`, c.topic && `글감(주제): ${c.topic}`, c.message ? `메시지: ${messageLine(c.message)}` : "메시지: (아직 없음)", c.strategy && `채널 전략(발췌):\n${c.strategy.slice(0, 1800)}`].filter(Boolean).join("\n");

export function promptThink(c: AmpContext, draft: string, talk: { q: string; a: string }[]): string {
	return [
		ctxBlock(c),
		draft && `지금 적어 둔 메시지 초안: ${draft}`,
		talk.length ? `지금까지의 생각하기:\n${talk.map((t, i) => `Q${i + 1}. ${t.q}\nA${i + 1}. ${t.a || "(답 없음)"}`).join("\n")}` : "",
		"",
		"「왜」 단계: 사용자가 이 글로 사람들에게 정말 하고 싶은 말(주장 한 문장)을 스스로 찾도록 다음 질문 하나를 해.",
		"- 이미 한 질문과 겹치지 않게. 왜 중요한지, 누구에게, 반대로 생각하는 사람, 그걸 언제 깨달았는지, 한 단어로 하면 같은 방향.",
		"- 초안이 주제(~에 대해)라면 주장(~다)으로 바꿔 보게 묻기. 메시지를 대신 써 주지 마.",
		'JSON: {"question": "다음 질문 하나"}',
	]
		.filter((x) => x !== "")
		.join("\n");
}

export function promptQuestions(c: AmpContext, mine: string[]): string {
	return [
		ctxBlock(c),
		`사용자가 이미 적은 독자 질문:\n${mine.map((q) => `- ${q}`).join("\n") || "(없음)"}`,
		"",
		"「질문」 단계: 이 메시지를 읽을 독자가 궁금해할 질문을 더 제안해. 이미 있는 것과 겹치지 않는 관점만.",
		"독자 유형별로: 회의적인 사람, 처음 듣는 사람, 실무자, 반대 관점, 바쁜 사람. 유형마다 1~2개, 모두 6~9개.",
		"질문은 독자의 말투로 짧게.",
		'JSON: {"questions": [{"persona": "회의적인 사람", "question": "…"}]}',
	].join("\n");
}

export function promptProbe(c: AmpContext, q: string, a: string): string {
	return [
		ctxBlock(c),
		`질문: ${q}`,
		`사용자의 답: ${a}`,
		"",
		"「답」 단계 생각하기: 이 답이 추상적이거나 일반론이면, 구체적인 장면·숫자·예·전후를 끌어낼 질문 하나를 해. 충분히 구체적이면 null.",
		"답을 요약하거나 고쳐 쓰지 마.",
		'JSON: {"question": "…"} 또는 {"question": null}',
	].join("\n");
}

export function promptOrder(c: AmpContext, qs: AmpQuestion[]): string {
	return [
		ctxBlock(c),
		`쓸 질문과 답(번호는 지금 순서):\n${qs.map((q, i) => `${i + 1}. ${q.text}\n   답: ${q.answer.slice(0, 300) || "(없음)"}`).join("\n")}`,
		"",
		"「엮기」 단계: 독자의 관심을 끝까지 끌고 가려면 어떤 순서로 이으면 좋을지 제안해. 문장은 쓰지 마. 지금 순서가 좋으면 그대로.",
		'JSON: {"order": [번호, …], "why": "이유 한 문장"}',
	].join("\n");
}

export function promptReview(c: AmpContext, body: string): string {
	return [
		ctxBlock(c),
		`원고:\n<<<\n${body}\n>>>`,
		"",
		"「검토」 단계: 독자의 눈으로 다섯 렌즈를 봐. 후킹(첫 두 줄이 독자의 막힌 순간에 닿나), 흐름(문단마다 독자의 예상·관심을 끌고 가나, 늘어지는 곳), 표현(식상한 상투어 — 채널 전략의 고유 언어는 지킨다), 메시지(진부하지 않나, 반대 문장이 터무니없지 않나), 근거·디테일(장면·숫자·전후·실패가 있나, 일반론만인 문단).",
		"- 렌즈마다 괜찮으면 ok에 한 줄(무엇이 좋은지), 구멍이 있으면 gaps에. 구멍은 모두 합쳐 최대 8개.",
		"- 구멍마다: finding(무엇이 비었나, 한 문장), ask(그 구멍 때문에 독자가 던질 질문), at(원고에서 그대로 복사한 구절, 짧게 — 원고 전체면 빈 문자열).",
		"- 고쳐 쓴 문장을 주지 마. 점수 없음.",
		'JSON: {"lenses": [{"lens": "후킹", "ok": "…" 또는 null, "gaps": [{"finding": "…", "ask": "…", "at": "…"}]}]}',
	].join("\n");
}

export function promptSources(c: AmpContext, gap: AmpGap, body: string): string {
	return [
		ctxBlock(c),
		`원고(발췌): ${body.slice(0, 1500)}`,
		`보완할 구멍: ${gap.finding}`,
		gap.ask && `독자의 질문: ${gap.ask}`,
		"",
		"「보완」 단계 근거 찾기: 웹 검색으로 이 구멍을 받칠 수치·연구·조사·사례를 3~5개 찾아. 실제로 열어 확인한 것만. 확인 못 한 숫자는 넣지 마.",
		"- 각각: title(문서 제목), url, outlet(매체·기관), year, quote(출처의 문장을 그대로 짧게 인용), claim(이 근거가 말해 주는 것 한 줄).",
		"- 원고 문장을 써 주지 마.",
		'JSON: {"query": "쓴 검색어", "results": [{"title": "…", "url": "https://…", "outlet": "…", "year": "2024", "quote": "…", "claim": "…"}]}',
	]
		.filter(Boolean)
		.join("\n");
}

/** The JSON object in an AI answer (code fences and chatter around it are ignored). */
export function parseJsonReply<T>(text: string): T {
	const t = text.replace(/```(?:json)?/g, "");
	const a = t.indexOf("{");
	const b = t.lastIndexOf("}");
	if (a < 0 || b < a) throw new Error("AI 답에서 결과를 읽지 못했어요. 다시 해 주세요.");
	return JSON.parse(t.slice(a, b + 1)) as T;
}

/** Lens results → review lines (괜찮음 lines first per lens, then gaps), at most 8 gaps. */
export function reviewItems(r: { lenses?: { lens?: string; ok?: string | null; gaps?: { finding?: string; ask?: string; at?: string }[] }[] }, body: string): AmpGap[] {
	const out: AmpGap[] = [];
	let gaps = 0;
	for (const l of r.lenses ?? []) {
		const lens = (l.lens ?? "").trim() || "기타";
		if (l.ok) out.push({ mark: "x", lens, finding: l.ok, ask: "", at: "", why: "", ok: true });
		for (const g of l.gaps ?? []) {
			if (gaps >= 8 || !g.finding) continue;
			gaps++;
			const at = (g.at ?? "").trim();
			out.push({ mark: " ", lens, finding: g.finding, ask: g.ask ?? "", at: at && body.includes(at) ? at : "", why: "", ok: false });
		}
	}
	return out;
}

/** Put the user's text after the passage a gap points at (or at the end). */
export function insertAfter(body: string, at: string, add: string): string {
	const a = add.trim();
	if (!a) return body;
	const i = at ? body.indexOf(atText(at)) : -1;
	if (i < 0) return `${body.replace(/\s+$/, "")}\n\n${a}`;
	const end = body.indexOf("\n\n", i + atText(at).length);
	if (end < 0) return `${body.replace(/\s+$/, "")}\n\n${a}`;
	return `${body.slice(0, end)}\n\n${a}${body.slice(end)}`;
}
