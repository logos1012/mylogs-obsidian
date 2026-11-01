/**
 * 콘텐츠 스튜디오 data (「콘텐츠 스튜디오 설계 v3」, `12 Flywheel/AGENTS.md` 「2-2」).
 *
 *   <요소>/03 글감/글감 YYYY-MM.md        고른 글감 — 한 줄에 하나 (루트 「6」 체크박스)
 *   <요소>/02 산출물/{채널}/날짜 제목.md   게시물 — 파일 하나 = 보드 카드 하나, 단계는 `stage` 한 칸
 *   <요소>/99 작업실/글감 소스.md          글감 소스 등록부 — 한 행 = 소스 하나
 *
 * md is the only source of truth. Media live in S3 (only their https addresses are written here).
 * 「예약 보내기」 posts the payload to the channel webhook. LinkedIn results come back as
 * `studio/results/{id}.json` in the same bucket (outside the upload prefix); the plugin copies
 * that file into the post's frontmatter.
 *
 * Pure module (no Obsidian imports).
 */

export type ChannelKey = "li" | "th" | "ig";

export interface ChannelDef {
	key: ChannelKey;
	/** Folder name under `02 산출물/` and the label. */
	name: string;
	/** Payload `channel`. */
	api: string;
	/** Characters per post (Threads: per post of the 타래; Instagram: caption). */
	limit: number;
	/** Body sections the editor owns. */
	section: string;
}

export const CHANNELS: ChannelDef[] = [
	{ key: "li", name: "링크드인", api: "linkedin", limit: 3000, section: "본문" },
	{ key: "th", name: "스레드", api: "threads", limit: 500, section: "" },
	{ key: "ig", name: "인스타그램", api: "instagram", limit: 2200, section: "캡션" },
];

export const channelByName = (name: string): ChannelDef | undefined => CHANNELS.find((c) => c.name === name);
export const channelByKey = (key: string): ChannelDef => CHANNELS.find((c) => c.key === key) ?? CHANNELS[0];

export const STAGES = ["초안", "다듬기", "미디어", "예약", "발행"] as const;
export type Stage = (typeof STAGES)[number];
export const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);

export const FORMATS: Record<ChannelKey, string[]> = {
	li: ["글만", "이미지", "문서", "영상"],
	th: ["타래"],
	ig: ["피드", "캐러셀", "릴스"],
};

export const HASHTAG_MAX = 30;

export const GLGAM_DIR = "03 글감";
export const OUTPUT_DIR = "02 산출물";
export const WORK_DIR = "99 작업실";
export const SOURCES_FILE = "글감 소스.md";
export const STRATEGY_DIR = "채널 전략";

export const glgamPath = (root: string, ym: string) => `${root}/${GLGAM_DIR}/글감 ${ym}.md`;
export const sourcesPath = (root: string) => `${root}/${WORK_DIR}/${SOURCES_FILE}`;
export const strategyPath = (root: string, ch: ChannelDef) => `${root}/${WORK_DIR}/${STRATEGY_DIR}/${ch.name}.md`;
export const channelDir = (root: string, ch: ChannelDef) => `${root}/${OUTPUT_DIR}/${ch.name}`;

// ───────────────────────── frontmatter (studio keys) ─────────────────────────

export type FmValue = string | string[];

/** Frontmatter block → its lines and the body. No frontmatter → `fm: null`. */
export function splitFm(text: string): { fm: string[] | null; body: string } {
	const t = text.replace(/^﻿/, "");
	const lines = t.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { fm: null, body: t };
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (end === -1) return { fm: null, body: t };
	return { fm: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

function unquote(v: string): string {
	const s = v.trim();
	if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) {
		const inner = s.slice(1, -1);
		return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
	}
	const c = /\s+#/.exec(s);
	return c ? s.slice(0, c.index).trim() : s;
}

/** `[a, "b, c", [[x]]]` → items; quotes respected, `[[…]]` kept whole. */
export function parseFlowList(raw: string): string[] {
	const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
	const out: string[] = [];
	let cur = "";
	let q = "";
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (q) {
			cur += ch;
			if (ch === "\\" && q === '"') {
				cur += inner[++i] ?? "";
				continue;
			}
			if (ch === q) q = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			q = ch;
			cur += ch;
		} else if (ch === "[") {
			depth++;
			cur += ch;
		} else if (ch === "]") {
			depth--;
			cur += ch;
		} else if (ch === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out.map(unquote).filter((x) => x !== "");
}

/** Every top-level key → value (flow and block lists become arrays). */
export function readFm(text: string): Record<string, FmValue> {
	const { fm } = splitFm(text);
	const out: Record<string, FmValue> = {};
	if (!fm) return out;
	let last = "";
	for (const line of fm) {
		const item = /^\s+-\s+(.*)$/.exec(line) ?? (last && /^-\s+(.*)$/.exec(line));
		if (item && last) {
			const cur = out[last];
			const list = Array.isArray(cur) ? cur : [];
			const v = unquote(item[1]);
			if (v) list.push(v);
			out[last] = list;
			continue;
		}
		const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		last = m[1];
		const raw = m[2].trim();
		out[m[1]] = raw.startsWith("[") ? parseFlowList(raw) : unquote(raw);
	}
	return out;
}

const NEEDS_QUOTE = /^$|^[\s\-?:,[\]{}#&*!|>'"%@`]|: |\s#|\s$/;

/** One scalar as YAML; quoted when YAML would misread it. */
export function yamlScalar(v: string): string {
	if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v)) return v.includes(" ") ? `"${v}"` : v;
	return NEEDS_QUOTE.test(v) || /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v) ? JSON.stringify(v) : v;
}

export function yamlValue(v: FmValue): string {
	if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
	return v === "" ? "" : yamlScalar(v);
}

/**
 * Set (or remove, `null`) frontmatter keys, keeping every other line as it is. New keys go after
 * `after` (or at the end). A file without frontmatter gets one.
 */
export function setFm(text: string, patch: Record<string, FmValue | null>, order: string[] = []): string {
	const { fm, body } = splitFm(text);
	const lines = fm ? [...fm] : [];
	const keyAt = (k: string) => lines.findIndex((l) => new RegExp(`^${k}\\s*:`).test(l));
	const blockEnd = (i: number) => {
		let j = i + 1;
		while (j < lines.length && /^\s+-\s|^-\s/.test(lines[j]) && !/^[A-Za-z0-9_-]+\s*:/.test(lines[j])) j++;
		return j;
	};
	for (const [k, v] of Object.entries(patch)) {
		const i = keyAt(k);
		if (v === null) {
			if (i >= 0) lines.splice(i, blockEnd(i) - i);
			continue;
		}
		const line = `${k}: ${yamlValue(v)}`.replace(/\s+$/, "");
		if (i >= 0) {
			lines.splice(i, blockEnd(i) - i, line);
			continue;
		}
		// after the nearest earlier key of `order` that exists
		let at = lines.length;
		const pos = order.indexOf(k);
		for (let p = pos - 1; p >= 0; p--) {
			const j = keyAt(order[p]);
			if (j >= 0) {
				at = blockEnd(j);
				break;
			}
		}
		if (pos === 0) {
			const j = order.slice(1).map(keyAt).find((x) => x >= 0);
			if (j !== undefined) at = j;
		}
		lines.splice(at, 0, line);
	}
	return `---\n${lines.join("\n")}\n---\n${body.replace(/^\n*/, fm ? body.match(/^\n*/)![0] : "\n")}`;
}

// ───────────────────────── body sections ─────────────────────────

export interface Section {
	/** `null` = the part before the first `## `. */
	heading: string | null;
	lines: string[];
}

export function splitSections(body: string): Section[] {
	const out: Section[] = [{ heading: null, lines: [] }];
	let fence = false;
	for (const line of body.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		const m = fence ? null : /^##\s+(.+?)\s*$/.exec(line);
		if (m) out.push({ heading: m[1], lines: [] });
		else out[out.length - 1].lines.push(line);
	}
	return out;
}

export function joinSections(secs: Section[]): string {
	const parts: string[] = [];
	for (const s of secs) {
		if (s.heading === null) {
			const pre = trimBlank(s.lines);
			if (pre.length) parts.push(pre.join("\n"));
		} else parts.push([`## ${s.heading}`, "", ...trimBlank(s.lines)].join("\n"));
	}
	return parts.join("\n\n") + "\n";
}

function trimBlank(lines: string[]): string[] {
	let a = 0;
	let b = lines.length;
	while (a < b && !lines[a].trim()) a++;
	while (b > a && !lines[b - 1].trim()) b--;
	return lines.slice(a, b);
}

const sectionText = (s: Section | undefined) => (s ? trimBlank(s.lines).join("\n") : "");

const IMG_LINE = /^!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*$/;

/** One post of a Threads 타래: its text and the media lines inside its section. */
export interface ThreadPart {
	text: string;
	media: string[];
}

export function partOf(lines: string[]): ThreadPart {
	const media: string[] = [];
	const text: string[] = [];
	for (const l of lines) {
		const m = IMG_LINE.exec(l.trim());
		if (m) media.push(m[1]);
		else text.push(l);
	}
	return { text: trimBlank(text).join("\n"), media };
}

// ───────────────────────── posts ─────────────────────────

export interface Post {
	path: string;
	channel: ChannelDef;
	/** File name without `YYYY-MM-DD ` and `.md`. */
	title: string;
	/** Date in the file name ("" if none). */
	date: string;
	id: string;
	stage: Stage;
	format: string;
	/** `YYYY-MM-DD HH:mm` ("" = not scheduled). */
	scheduled: string;
	sent: string;
	published: string;
	url: string;
	/** Publish-result failure reason, cleared on a new send or a 취소 result. */
	error: string;
	media: string[];
	from: string[];
	topic: string;
	hashtags: string[];
	ratio: string;
	alt: string[];
	/** Single-text channels (링크드인 본문 · 인스타그램 캡션). */
	text: string;
	/** Threads 타래 (`## 1`, `## 2` …); one part for the other channels. */
	parts: ThreadPart[];
}

export const FM_ORDER = ["id", "channel", "format", "stage", "from", "topic", "media", "ratio", "alt", "hashtags", "scheduled", "sent", "published", "url", "error"];

const str = (v: FmValue | undefined) => (Array.isArray(v) ? v.join(", ") : (v ?? "")).trim();
const list = (v: FmValue | undefined) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => x.trim()).filter(Boolean);

export function fileTitle(path: string): { date: string; title: string } {
	const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
	const m = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(base);
	return m ? { date: m[1], title: m[2] } : { date: "", title: base };
}

export function parsePost(path: string, text: string, ch: ChannelDef): Post {
	const fm = readFm(text);
	const { body } = splitFm(text);
	const secs = splitSections(body);
	const { date, title } = fileTitle(path);
	const published = str(fm.published);
	const st = str(fm.stage);
	const stage: Stage = published ? "발행" : isStage(st) ? st : "초안";
	let parts: ThreadPart[];
	let textOut = "";
	if (ch.key === "th") {
		const nums = secs.filter((s) => s.heading !== null && /^\d+$/.test(s.heading));
		parts = nums.length ? nums.map((s) => partOf(s.lines)) : [partOf((secs.find((s) => s.heading === "본문") ?? secs[0]).lines)];
		if (!parts.length) parts = [{ text: "", media: [] }];
	} else {
		const own = secs.find((s) => s.heading === ch.section) ?? secs.find((s) => s.heading === "본문") ?? (secs.length === 1 ? secs[0] : undefined);
		textOut = sectionText(own);
		parts = [{ text: textOut, media: [] }];
	}
	return {
		path,
		channel: ch,
		title,
		date,
		id: str(fm.id),
		stage,
		format: str(fm.format) || (ch.key === "th" ? "타래" : ch.key === "ig" ? "캐러셀" : list(fm.media).length ? "이미지" : "글만"),
		scheduled: str(fm.scheduled),
		sent: str(fm.sent),
		published,
		url: str(fm.url),
		error: str(fm.error),
		media: list(fm.media),
		from: list(fm.from),
		topic: str(fm.topic),
		hashtags: list(fm.hashtags).map((h) => h.replace(/^#/, "")),
		ratio: str(fm.ratio) || (ch.key === "ig" ? "4:5" : ""),
		alt: Array.isArray(fm.alt) ? fm.alt : [],
		text: textOut,
		parts,
	};
}

/** The editor's text back into the file: only the sections the channel owns change. */
export function setPostBody(text: string, ch: ChannelDef, value: { text?: string; parts?: ThreadPart[] }): string {
	const { fm, body } = splitFm(text);
	const head = fm ? `---\n${fm.join("\n")}\n---\n` : "";
	const secs = splitSections(body);
	if (ch.key === "th") {
		const parts = value.parts ?? [];
		const isNum = (s: Section) => s.heading !== null && /^\d+$/.test(s.heading);
		let at = secs.findIndex(isNum);
		if (at < 0) {
			at = secs.findIndex((s) => s.heading === "본문");
			if (at >= 0) secs.splice(at, 1);
			else {
				// the whole old text was the one post: keep a title line (`# …`) only
				secs[0].lines = secs[0].lines.filter((l) => /^#\s/.test(l));
				at = secs.length;
			}
		}
		const rest = secs.filter((s) => !isNum(s));
		const before = rest.slice(0, Math.min(at, rest.length));
		const after = rest.slice(before.length);
		const mine: Section[] = parts.map((p, i) => ({ heading: String(i + 1), lines: [...(p.text ? p.text.split("\n") : []), ...(p.media.length ? ["", ...p.media.map((u) => `![](${u})`)] : [])] }));
		return head + "\n" + joinSections([...before, ...mine, ...after]);
	}
	const own = secs.find((s) => s.heading === ch.section) ?? secs.find((s) => s.heading === "본문");
	const lines = (value.text ?? "").split("\n");
	if (own) own.lines = lines;
	else {
		// no owned section yet: keep a `# title` line, the rest of the old preamble becomes the text
		const pre = secs[0];
		const keep = pre.lines.filter((l) => /^#\s/.test(l));
		pre.lines = keep;
		secs.splice(1, 0, { heading: ch.section, lines });
	}
	return head + "\n" + joinSections(secs);
}

export function postSkeleton(ch: ChannelDef, id: string, from: string[], format = ""): string {
	const fm: Record<string, FmValue> = { id, channel: ch.name, format: format || FORMATS[ch.key][0], stage: "초안", from };
	if (ch.key === "ig") fm.ratio = "4:5";
	const lines = Object.entries(fm).map(([k, v]) => `${k}: ${yamlValue(v)}`);
	lines.push("scheduled:", "sent:", "published:", "url:");
	const body = ch.key === "th" ? "## 1\n\n" : `## ${ch.section}\n\n`;
	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

/** `C-YYYYMMDD-NN` — the key that matches `studio/results/{id}.json` to a post. */
export function newPostId(date: string, taken: Iterable<string>): string {
	const base = `C-${date.replace(/-/g, "")}-`;
	const used = new Set(taken);
	for (let n = 1; n < 1000; n++) {
		const id = `${base}${String(n).padStart(2, "0")}`;
		if (!used.has(id)) return id;
	}
	return `${base}${Date.now()}`;
}

/** File-name safe title. */
export function safeTitle(t: string): string {
	return t.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "제목 없음";
}

/** Characters as the channels count them (code points). */
export const charCount = (s: string) => [...s].length;

/** Text actually sent: Instagram caption + hashtags at the end. */
export function captionOut(p: Post): string {
	if (p.channel.key !== "ig" || !p.hashtags.length) return p.text;
	return `${p.text.replace(/\s+$/, "")}\n\n${p.hashtags.map((h) => `#${h}`).join(" ")}`;
}

export interface Problem {
	level: "block" | "warn";
	text: string;
}

/** What stops 「예약 보내기」 (and what only warns). */
export function postProblems(p: Post): Problem[] {
	const out: Problem[] = [];
	const ch = p.channel;
	if (ch.key === "th") {
		if (!p.parts.some((x) => x.text.trim())) out.push({ level: "block", text: "글이 비어 있어요." });
		p.parts.forEach((x, i) => charCount(x.text) > ch.limit && out.push({ level: "block", text: `${i + 1}번 글이 ${ch.limit}자를 넘어요 (${charCount(x.text)}자).` }));
	} else {
		if (!p.text.trim()) out.push({ level: "block", text: ch.key === "ig" ? "캡션이 비어 있어요." : "본문이 비어 있어요." });
		const n = charCount(captionOut(p));
		if (n > ch.limit) out.push({ level: "block", text: `${ch.limit.toLocaleString()}자를 넘어요 (${n.toLocaleString()}자).` });
	}
	if (ch.key === "ig") {
		if (!p.media.length) out.push({ level: "block", text: "인스타그램은 사진이나 영상이 있어야 해요." });
		if (p.format === "피드" && p.media.length > 1) out.push({ level: "warn", text: "피드 1장인데 미디어가 여러 개예요. 첫 장만 올라가요." });
		if (p.format === "캐러셀" && p.media.length < 2) out.push({ level: "block", text: "캐러셀은 2장 이상이어야 해요." });
		if (p.format === "릴스" && !p.media.some(isVideo)) out.push({ level: "block", text: "릴스에는 영상이 있어야 해요." });
		if (p.hashtags.length > HASHTAG_MAX) out.push({ level: "block", text: `해시태그가 ${HASHTAG_MAX}개를 넘어요.` });
	}
	if (ch.key === "li" && (p.format === "이미지" || p.format === "영상" || p.format === "문서") && !p.media.length) out.push({ level: "warn", text: `형식이 「${p.format}」인데 미디어가 없어요.` });
	if (!p.scheduled) out.push({ level: "block", text: "예약 날짜와 시각을 정해 주세요." });
	return out;
}

export const isVideo = (u: string) => /\.(mp4|mov|m4v|webm)(\?|$)/i.test(u);

export interface Payload {
	id: string;
	action: "schedule" | "cancel";
	channel: string;
	format: string;
	at: string;
	title: string;
	text: string;
	parts?: { text: string; media: string[] }[];
	media: string[];
	alt?: string[];
	ratio?: string;
	topic?: string;
}

/** `2026-01-16 08:00` (Asia/Seoul) → `2026-01-16T08:00:00+09:00`. */
export function atIso(scheduled: string): string {
	const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(scheduled);
	return m ? `${m[1]}T${m[2]}:${m[3]}:00+09:00` : "";
}

export function buildPayload(p: Post, action: "schedule" | "cancel" = "schedule"): Payload {
	const base: Payload = { id: p.id, action, channel: p.channel.api, format: p.format, at: atIso(p.scheduled), title: p.title, text: "", media: [] };
	if (action === "cancel") return base;
	if (p.channel.key === "th") {
		const parts = p.parts.filter((x) => x.text.trim() || x.media.length).map((x) => ({ text: x.text, media: x.media }));
		return { ...base, text: parts[0]?.text ?? "", parts, media: parts.flatMap((x) => x.media), ...(p.topic ? { topic: p.topic } : {}) };
	}
	return { ...base, text: captionOut(p), media: p.media, ...(p.channel.key === "ig" ? { ratio: p.ratio, alt: p.alt } : {}) };
}

// ───────────────────────── 발행 결과 (S3 studio/results/{id}.json) ─────────────────────────

export interface ResultRow {
	id: string;
	status: string;
	url: string;
	error: string;
	/** KST `YYYY-MM-DD HH:mm` (older ISO strings still compare). */
	at: string;
}

const PUBLISHED = /^(발행|published|success|ok|done)$/i;
const FAILED = /^(실패|failed|fail|error)$/i;
const CANCELLED = /^취소$/;

const resultStr = (v: unknown) => (v == null ? "" : String(v)).trim();

/** One result file. Null when the body is not a result object. */
export function parseResultJson(text: string): ResultRow | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	const id = resultStr(o.id);
	if (!id) return null;
	return { id, status: resultStr(o.status), url: resultStr(o.url), error: resultStr(o.error), at: resultStr(o.at) };
}

/**
 * Missing result object.
 * Without `s3:ListBucket` on `studio/results/`, S3 answers **403 AccessDenied** (sometimes
 * `NoSuchKey`) instead of 404. Both mean "no result yet".
 */
export function isAbsentResult(status: number, body: string): boolean {
	if (status === 404) return true;
	if (status !== 403) return false;
	const code = /<Code>\s*([^<]+?)\s*<\/Code>/.exec(body)?.[1] ?? "";
	return code === "AccessDenied" || code === "NoSuchKey";
}

export type ResultRead = { kind: "missing" } | { kind: "ok"; row: ResultRow } | { kind: "error"; message: string };

/** Classify one results GetObject. 404 and 403 AccessDenied/NoSuchKey are "not yet". */
export function interpretResultGet(status: number, body: string): ResultRead {
	if (isAbsentResult(status, body)) return { kind: "missing" };
	if (status !== 200) {
		const code = s3Code(body);
		return { kind: "error", message: `S3 발행 결과 읽기 실패 (${status}${code ? ` ${code}` : ""})` };
	}
	const row = parseResultJson(body);
	if (!row) return { kind: "error", message: "발행 결과 JSON을 읽지 못했어요" };
	return { kind: "ok", row };
}

export const s3Code = (body: string) => /<Code>\s*([^<]+?)\s*<\/Code>/.exec(body)?.[1] ?? "";

/** Use `text` when it has a body; otherwise `requestUrl`'s parsed `json`. */
export function resultBody(res: { text?: string | null; json?: unknown }): string {
	const text = (res.text ?? "").replace(/^\uFEFF/, "");
	if (text.trim()) return text;
	let j: unknown;
	try {
		j = res.json;
	} catch {
		return "";
	}
	if (j == null || j === "") return "";
	if (typeof j === "string") return j.replace(/^\uFEFF/, "");
	try {
		return JSON.stringify(j);
	} catch {
		return "";
	}
}

/** Five minutes. Not started by an all-miss round. */
export const POLL_THROTTLE_MS = 5 * 60_000;
/** While a sent post is past its scheduled time and still has no result. */
export const FAST_POLL_MS = 90_000;

/** `bypass` is a forced read or the fast overdue timer. */
export function shouldThrottlePoll(lastPoll: number, now: number, bypass: boolean): boolean {
	if (bypass || lastPoll <= 0) return false;
	return now - lastPoll < POLL_THROTTLE_MS;
}

/**
 * Remember `lastPoll` only after a real result file, or when nothing was eligible.
 * An all-miss round (404 / 403 AccessDenied / NoSuchKey) must not start the throttle.
 */
export function shouldRememberPoll(eligible: number, found: number): boolean {
	if (eligible <= 0) return true;
	return found > 0;
}

export type PollHitKind = "applied" | "missing" | "error" | "unchanged";

export interface PollHit {
	id: string;
	kind: PollHitKind;
	/** `발행 반영`, `403 AccessDenied`, `500 …`, … */
	detail: string;
}

export function appliedLabel(patch: Record<string, FmValue | null>): string {
	if (patch.stage === "발행") return "발행 반영";
	if (patch.stage === "다듬기") return "취소 반영";
	if (typeof patch.error === "string") return "실패 반영";
	return "반영";
}

export function formatPollHit(h: PollHit): string {
	if (h.kind === "missing") return `${h.id}: 아직 결과 없음 (${h.detail})`;
	if (h.kind === "error") return `${h.id}: 오류 ${h.detail}`;
	return `${h.id}: ${h.detail}`;
}

export function formatPollSummary(hits: PollHit[]): string {
	return hits.map(formatPollHit).join("\n");
}

export function pollFoundCount(hits: { kind: string }[]): number {
	return hits.filter((h) => h.kind === "applied" || h.kind === "unchanged").length;
}

/** `YYYY-MM-DD HH:mm` read as Asia/Seoul. */
export function scheduledInstant(scheduled: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(scheduled.trim());
	if (!m) return null;
	return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - 9 * 3600_000;
}

export interface FastPollPost {
	stage: string;
	sent: string;
	published: string;
	id: string;
	scheduled: string;
	error: string;
}

/** Eligible, scheduled time has come, and no failure result has been written yet. */
export function needsFastPoll(p: FastPollPost, now = Date.now()): boolean {
	if (p.stage !== "예약" || !p.sent || p.published || !p.id || p.error) return false;
	const at = scheduledInstant(p.scheduled);
	return at != null && at <= now;
}

/** Interval while any post needs a fast re-check; null stops the timer. */
export function fastPollEvery(posts: FastPollPost[], now = Date.now()): number | null {
	return posts.some((p) => needsFastPoll(p, now)) ? FAST_POLL_MS : null;
}

/** A result → the post's frontmatter patch (null = nothing to change). */
export function resultPatch(p: Post, r: ResultRow | undefined): Record<string, FmValue | null> | null {
	if (!r || !p.sent) return null;
	if (r.at && p.sent && r.at.slice(0, 16).replace("T", " ") < p.sent.slice(0, 16)) return null; // an older send's result
	const status = r.status.trim();
	if (PUBLISHED.test(status)) {
		if (p.published && p.url === r.url) return null;
		return { published: (r.at || "").slice(0, 10) || p.scheduled.slice(0, 10), url: r.url, stage: "발행", error: null };
	}
	if (FAILED.test(status)) {
		const why = r.error.trim() || "이유 없음";
		return p.error === why ? null : { error: why };
	}
	// Same frontmatter as `cancelSchedule`: back to 다듬기, clear sent and error.
	if (CANCELLED.test(status)) return { stage: "다듬기", sent: null, error: null };
	return null;
}

/** Header for a channel webhook POST. LinkedIn sends `x-studio-key` only when the setting is non-empty. */
export function webhookHeaders(channel: ChannelKey, studioKey: string): Record<string, string> {
	const key = studioKey.trim();
	if (channel !== "li" || !key) return {};
	return { "x-studio-key": key };
}

// ───────────────────────── 글감 (03 글감/글감 YYYY-MM.md) ─────────────────────────

export interface GlgamLine {
	/** 0-based line index in the file. */
	line: number;
	raw: string;
	mark: " " | ">" | "-";
	text: string;
	src: string;
	from: string[];
	added: string;
	why: string;
	/** `[>] … → [[post]], [[post]]` targets. */
	posts: string[];
	block: string;
	file: string;
}

const GL_RE = /^(\s*)-\s\[([ >\-x])\]\s+(.*)$/;

const field = (s: string, k: string) => new RegExp(`\\(${k}::\\s*([^)]*)\\)`).exec(s)?.[1].trim() ?? "";
const linksIn = (s: string) => [...s.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);

export function parseGlgam(text: string, file: string): GlgamLine[] {
	const out: GlgamLine[] = [];
	text.split(/\r?\n/).forEach((raw, i) => {
		const m = GL_RE.exec(raw);
		if (!m) return;
		let rest = m[3];
		const block = /\s\^([\w-]+)\s*$/.exec(rest)?.[1] ?? "";
		rest = rest.replace(/\s\^[\w-]+\s*$/, "");
		const fromRaw = field(rest, "from");
		let main = rest.replace(/\s*\([a-z]+::[^)]*\)/g, "").trim();
		let posts: string[] = [];
		const arrow = main.indexOf(" → ");
		if (arrow >= 0) {
			posts = linksIn(main.slice(arrow)).map((l) => l.split("|")[0]);
			main = main.slice(0, arrow).trim();
		}
		out.push({ line: i, raw, mark: m[2] === "x" ? ">" : (m[2] as " " | ">" | "-"), text: main, src: field(rest, "src"), from: linksIn(fromRaw).map((l) => l.split("|")[0]), added: field(rest, "added"), why: field(rest, "why"), posts, block, file });
	});
	return out;
}

export function glgamSkeleton(ym: string, today: string): string {
	return `---\ntype: studio-glgam\nmonth: ${ym}\nupdated: ${today}\n---\n# 글감 ${ym}\n\n## 글감\n`;
}

/** One line; a `(key:: …)`-looking part of the user's text is kept from reading as a field. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").replace(/\(([a-z_]+)::/g, "($1 ::").trim();

export function formatGlgam(g: { text: string; src: string; from: string[]; added: string; block: string }): string {
	const from = g.from.length ? ` (from:: ${g.from.map((f) => `[[${f}]]`).join(", ")})` : "";
	return `- [ ] ${oneLine(g.text)} (src:: ${g.src})${from} (added:: ${g.added}) ^${g.block}`;
}

/** Append a 글감 line under `## 글감` (created when missing). */
export function appendGlgam(text: string, line: string): string {
	const lines = text.replace(/\s+$/, "").split("\n");
	let h = lines.findIndex((l) => /^##\s+글감\s*$/.test(l));
	if (h < 0) {
		lines.push("", "## 글감");
		h = lines.length - 1;
	}
	let end = h + 1;
	while (end < lines.length && !/^##\s/.test(lines[end])) end++;
	let at = end;
	while (at > h + 1 && !lines[at - 1].trim()) at--;
	lines.splice(at, 0, line);
	return lines.join("\n") + "\n";
}

/** `[ ]` → `[>] text → [[post|title]]` (posts added to an already moved line too). */
export function markWritten(raw: string, postLink: string): string {
	const m = GL_RE.exec(raw);
	if (!m) return raw;
	let rest = m[3];
	const tail = /((?:\s*\([a-z]+::[^)]*\))*)(\s\^[\w-]+)?\s*$/.exec(rest)!;
	let main = rest.slice(0, tail.index).trimEnd();
	main = main.includes(" → ") ? `${main}, ${postLink}` : `${main} → ${postLink}`;
	rest = main + tail[0];
	return `${m[1]}- [>] ${rest}`;
}

/** A post was deleted: drop its link; no post left → back to `[ ]` (the 글감 waits again). */
export function unmarkWritten(raw: string, postPath: string): string {
	const m = GL_RE.exec(raw);
	if (!m || !m[3].includes(" → ")) return raw;
	const rest = m[3];
	const tail = /((?:\s*\([a-z]+::[^)]*\))*)(\s\^[\w-]+)?\s*$/.exec(rest)!;
	const main = rest.slice(0, tail.index).trimEnd();
	const i = main.indexOf(" → ");
	const text = main.slice(0, i);
	const want = postPath.replace(/\.md$/, "");
	const keep = [...main.slice(i).matchAll(/\[\[[^\]]+\]\]/g)].map((x) => x[0]).filter((l) => l.slice(2, -2).split("|")[0] !== want);
	return keep.length ? `${m[1]}- [>] ${text} → ${keep.join(", ")}${tail[0]}` : `${m[1]}- [ ] ${text}${tail[0]}`;
}

/** Default 예약: today at the next full hour (from 23:00 on, tomorrow 08:00). */
export function defaultSchedule(now: Date): string {
	const k = new Date(now.getTime() + 9 * 3600_000); // Asia/Seoul wall clock
	let day = k.toISOString().slice(0, 10);
	let h = k.getUTCHours() + 1;
	if (h >= 23) {
		day = new Date(k.getTime() + 86400_000).toISOString().slice(0, 10);
		h = 8;
	}
	return `${day} ${String(h).padStart(2, "0")}:00`;
}

export function markDropped(raw: string, why: string): string {
	const m = GL_RE.exec(raw);
	if (!m) return raw;
	const rest = m[3].replace(/\s*\(why::[^)]*\)/, "");
	const tail = /((?:\s*\([a-z]+::[^)]*\))*)(\s\^[\w-]+)?\s*$/.exec(rest)!;
	return `${m[1]}- [-] ${rest.slice(0, tail.index).trimEnd()} (why:: ${oneLine(why) || "안 씀"})${tail[0]}`;
}

export function newBlockId(prefix = "g"): string {
	return prefix + Math.random().toString(36).slice(2, 8);
}

// ───────────────────────── 글감 소스 (99 작업실/글감 소스.md) ─────────────────────────

export type SourceUnit = "줄" | "섹션" | "파일" | "루미";

export interface Source {
	key: string;
	name: string;
	/** Vault folder; one `*` segment matches any folder name. */
	path: string;
	unit: SourceUnit;
	/** 줄: which `## ` headings (empty = every list line); 섹션: the heading mark (`###`). */
	where: string[];
	on: boolean;
}

export const DEFAULT_SOURCES: Source[] = [
	{ key: "daily", name: "Daily Pad", path: "04 Daily Pad", unit: "줄", where: ["## 메모", "## 로그"], on: true },
	{ key: "fw", name: "Flywheel 기록", path: "12 Flywheel/*/01 기록", unit: "줄", where: [], on: true },
	{ key: "news", name: "AI 뉴스", path: "07 Shelf/LLM Wiki/raw/articles/ai-news", unit: "섹션", where: ["###"], on: true },
	{ key: "wiki", name: "LLM Wiki", path: "07 Shelf/LLM Wiki/wiki/concepts", unit: "파일", where: [], on: true },
	{ key: "diary", name: "Diary", path: "09 Diary", unit: "파일", where: [], on: true },
	{ key: "session", name: "AI 대화", path: "10 Archive Box/Sessions", unit: "루미", where: [], on: true },
];

const UNITS: SourceUnit[] = ["줄", "섹션", "파일", "루미"];

export function parseSources(text: string | null): Source[] {
	if (text === null) return DEFAULT_SOURCES.map((s) => ({ ...s }));
	const out: Source[] = [];
	for (const raw of text.split(/\r?\n/)) {
		if (!/^\|/.test(raw.trim())) continue;
		const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/^`|`$/g, ""));
		if (cells.length < 6 || cells[0] === "key" || /^-+$/.test(cells[0].replace(/:/g, ""))) continue;
		const [key, name, path, unit, where, state] = cells;
		if (!key || !UNITS.includes(unit as SourceUnit)) continue;
		out.push({ key, name: name || key, path: path.replace(/\/+$/, ""), unit: unit as SourceUnit, where: where ? where.split(",").map((w) => w.trim()).filter(Boolean) : [], on: state !== "끔" });
	}
	return out;
}

export function formatSources(sources: Source[], today: string, log: string[] = []): string {
	const rows = sources.map((s) => `| ${s.key} | ${s.name} | ${s.path}/ | ${s.unit} | ${s.where.join(", ")} | ${s.on ? "사용" : "끔"} |`);
	return [
		"---",
		"type: studio-sources",
		`updated: ${today}`,
		"---",
		"# 글감 소스",
		"",
		"콘텐츠 스튜디오 「글감」 화면이 훑는 곳. 한 행이 소스 하나다. 단위: 줄(목록 한 줄) · 섹션(제목 아래 덩어리) · 파일(파일 하나) · 루미(자동으로 훑지 않고 루미에게 물을 때만).",
		"",
		"| key | 이름 | 경로 | 단위 | 고를 곳 | 상태 |",
		"|---|---|---|---|---|---|",
		...rows,
		"",
		"## 변경 기록",
		...log,
		"",
	].join("\n");
}

/** Keep the change log of an existing registry, add one line, rewrite the table. */
export function rewriteSources(old: string | null, sources: Source[], today: string, change: string): string {
	const prev = old ? (/## 변경 기록\n([\s\S]*)$/.exec(old)?.[1] ?? "").split("\n").filter((l) => l.startsWith("- ")) : [];
	return formatSources(sources, today, [`- ${today}: ${change}`, ...prev]);
}

/** Does `path` (a vault file) sit under the source folder (with `*` segments)? */
export function underSource(path: string, src: string): boolean {
	const segs = src.split("/").filter(Boolean);
	const p = path.split("/");
	if (p.length <= segs.length) return false;
	return segs.every((s, i) => s === "*" || s === p[i]);
}

// ───────────────────────── 후보 (candidates) ─────────────────────────

export interface Candidate {
	/** Stable id for 「안 씀」: `path#line` or `path#heading`. */
	key: string;
	source: string;
	path: string;
	date: string;
	/** Where it sits: `메모`, `로그`, a heading, … */
	where: string;
	text: string;
	/** 0-based line of the item (줄) or heading (섹션); -1 for a whole file. */
	line: number;
	heading: string;
	/** Line already carries a block id. */
	block: string;
	/** Filled for 루미 results. */
	why?: string;
}

const ISO_IN = /(\d{4}-\d{2}-\d{2})/;
const LIST_RE = /^\s*[-*+]\s+(?:\[[ x>\-]\]\s+)?(.*)$/;
const DATE_H = /^#{2,4}\s+(\d{4}-\d{2}-\d{2})\b/;

export function fileDate(path: string, mtime: number): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const m = ISO_IN.exec(base);
	if (m) return m[1];
	const d = new Date(mtime + 9 * 3600_000);
	return d.toISOString().slice(0, 10);
}

/** Text of a list line without fields, block id, links syntax. */
export function cleanLine(s: string): string {
	return s
		.replace(/\s\^[\w-]+\s*$/, "")
		.replace(/\s*\([a-z_]+::[^)]*\)/g, "")
		.replace(/!?\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a: string, b: string) => b || a.split("/").pop()!)
		.replace(/\s+/g, " ")
		.trim();
}

export function candidatesOf(src: Source, path: string, text: string, mtime: number, since: string): Candidate[] {
	const fdate = fileDate(path, mtime);
	const lines = text.split(/\r?\n/);
	const out: Candidate[] = [];
	let fmEnd = -1;
	if (lines[0]?.trim() === "---") fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
	if (src.unit === "줄") {
		const wanted = src.where.map((w) => w.replace(/^#+\s*/, ""));
		let sec = "";
		let date = fdate;
		lines.forEach((l, i) => {
			if (i <= fmEnd) return;
			const h = /^(#{1,6})\s+(.+?)\s*$/.exec(l);
			if (h) {
				const dh = DATE_H.exec(l);
				if (dh) date = dh[1];
				if (h[1].length === 2) sec = h[2];
				return;
			}
			if (wanted.length && !wanted.includes(sec)) return;
			const m = LIST_RE.exec(l);
			if (!m || /^!\[\[/.test(m[1].trim())) return;
			const t = cleanLine(m[1]);
			if (t.length < 6 || date < since) return;
			out.push({ key: `${path}#L${hash(l)}`, source: src.key, path, date, where: sec, text: t, line: i, heading: "", block: /\s\^([\w-]+)\s*$/.exec(l)?.[1] ?? "" });
		});
	} else if (src.unit === "섹션") {
		if (fdate < since) return out;
		const level = (src.where[0] ?? "###").replace(/[^#]/g, "").length || 3;
		const re = new RegExp(`^#{${level}}\\s+(.+?)\\s*$`);
		let cur: { i: number; h: string; body: string[] } | null = null;
		const flush = () => {
			if (!cur) return;
			const body = cur.body.join(" ").replace(/\s+/g, " ").trim();
			out.push({ key: `${path}#${cur.h}`, source: src.key, path, date: fdate, where: "", text: cur.h, line: cur.i, heading: cur.h, block: "", why: body.slice(0, 160) });
			cur = null;
		};
		lines.forEach((l, i) => {
			if (i <= fmEnd) return;
			const m = re.exec(l);
			if (m) {
				flush();
				cur = { i, h: m[1], body: [] };
			} else if (/^#{1,6}\s/.test(l) && (/^(#+)/.exec(l)![1].length <= level)) flush();
			else if (cur && l.trim()) cur.body.push(cleanLine(l.replace(/^[-*>\s]+/, "")));
		});
		flush();
	} else if (src.unit === "파일") {
		if (fdate < since) return out;
		const fm = readFm(text);
		const title = str(fm.title) || path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
		const body = lines
			.slice(fmEnd + 1)
			.filter((l) => l.trim() && !/^#/.test(l))
			.map((l) => cleanLine(l.replace(/^[-*>\s]+/, "")))
			.join(" ")
			.slice(0, 200);
		out.push({ key: path, source: src.key, path, date: fdate, where: "", text: title, line: -1, heading: "", block: "", why: body });
	}
	return out;
}

/** djb2 of the raw line — stable while the line is unchanged. */
export function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** The link a 글감 keeps to its candidate (`path` without `.md`). */
export function candidateLink(c: Candidate, block: string): string {
	const p = c.path.replace(/\.md$/, "");
	if (c.line >= 0 && !c.heading) return `${p}#^${block}`;
	if (c.heading) return `${p}#${c.heading.replace(/[#^[\]|]/g, " ").trim()}`;
	return p;
}

/** Add `^block` to a source line (once). */
export function withBlock(line: string, block: string): string {
	if (/\s\^[\w-]+\s*$/.test(line)) return line;
	return `${line.replace(/\s+$/, "")} ^${block}`;
}

/** Words the channel strategy keeps out (가족 · 사생활 · 회사 내부 일) — only a soft flag. */
export const PRIVATE_HINT = /(아내|남편|와이프|엄마|아빠|어머니|아버지|부모|동생|형이|누나|언니|아들|딸|아이가|아이랑|가족|다툼|싸웠|싸움|부부|회사 내부|사내|연봉|인사평가|병원|진료)/;
