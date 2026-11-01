/**
 * 콘텐츠 스튜디오 reads and writes inside Obsidian. Every write goes through `vault.process` /
 * `vault.create` / `fileManager.renameFile`, so links follow renames and concurrent edits are safe.
 */

import { moment, normalizePath, Notice, requestUrl, TFile, TFolder } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { loadWheel } from "../flywheel/actions.ts";
import type { FlywheelElement } from "../flywheel/model.ts";
import {
	appendGlgam,
	buildPayload,
	type Candidate,
	candidateLink,
	candidatesOf,
	type ChannelDef,
	channelByName,
	channelDir,
	CHANNELS,
	FM_ORDER,
	type FmValue,
	formatGlgam,
	GLGAM_DIR,
	glgamPath,
	glgamSkeleton,
	hash,
	interpretResultGet,
	markDropped,
	unmarkWritten,
	markWritten,
	newBlockId,
	newPostId,
	parseGlgam,
	parsePost,
	parseSources,
	type Post,
	postSkeleton,
	resultPatch,
	webhookHeaders,
	rewriteSources,
	safeTitle,
	setFm,
	setPostBody,
	type Source,
	sourcesPath,
	strategyPath,
	type GlgamLine,
	type ThreadPart,
	underSource,
	withBlock,
} from "./model.ts";
import { getObject, isS3Ready, resultObjectKey } from "./s3.ts";
import { loadSecrets, obsidianSend, s3Config } from "./settings.ts";

export const todayIso = () => moment().format("YYYY-MM-DD");
export const nowStamp = () => moment().format("YYYY-MM-DD HH:mm");

export interface StudioData {
	e: FlywheelElement;
	root: string;
	posts: Post[];
	glgam: GlgamLine[];
	sources: Source[];
	sourcesExist: boolean;
	/** Channel strategy file text (null = none). */
	strategy: Map<string, string | null>;
	today: string;
}

const file = (plugin: MyLogsPlugin, path: string): TFile | null => {
	const f = plugin.app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
};

async function readPath(plugin: MyLogsPlugin, path: string): Promise<string | null> {
	const f = file(plugin, path);
	return f ? plugin.app.vault.cachedRead(f) : null;
}

async function ensureFolder(plugin: MyLogsPlugin, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/");
	for (let i = 1; i <= parts.length; i++) {
		const p = parts.slice(0, i).join("/");
		if (!plugin.app.vault.getAbstractFileByPath(p)) await plugin.app.vault.createFolder(p);
	}
}

/** The element whose hub says `workspace: studio` (퍼스널 브랜딩). */
export async function studioElement(plugin: MyLogsPlugin): Promise<FlywheelElement | null> {
	const w = await loadWheel(plugin);
	return w.elements.find((e) => e.workspace === "studio" && e.status !== "폐기" && e.folder) ?? null;
}

export async function loadStudio(plugin: MyLogsPlugin): Promise<StudioData | null> {
	const e = await studioElement(plugin);
	if (!e) return null;
	const root = e.folder;
	const vault = plugin.app.vault;
	const posts: Post[] = [];
	for (const ch of CHANNELS) {
		const dir = vault.getAbstractFileByPath(channelDir(root, ch));
		if (!(dir instanceof TFolder)) continue;
		for (const f of dir.children) {
			if (!(f instanceof TFile) || f.extension !== "md") continue;
			posts.push(parsePost(f.path, await vault.cachedRead(f), ch));
		}
	}
	const glgam: GlgamLine[] = [];
	const gdir = vault.getAbstractFileByPath(`${root}/${GLGAM_DIR}`);
	if (gdir instanceof TFolder) {
		for (const f of gdir.children) if (f instanceof TFile && f.extension === "md") glgam.push(...parseGlgam(await vault.cachedRead(f), f.path));
	}
	glgam.sort((a, b) => b.added.localeCompare(a.added) || b.line - a.line);
	const srcText = await readPath(plugin, sourcesPath(root));
	const strategy = new Map<string, string | null>();
	for (const ch of CHANNELS) strategy.set(ch.key, await readPath(plugin, strategyPath(root, ch)));
	return { e, root, posts, glgam, sources: parseSources(srcText), sourcesExist: srcText !== null, strategy, today: todayIso() };
}

// ───────────────────────── 후보 ─────────────────────────

/** Candidates of every active (non-루미) source in the last `days` days, newest first. */
export async function scanCandidates(plugin: MyLogsPlugin, d: StudioData, days: number): Promise<Candidate[]> {
	const since = moment().subtract(days - 1, "days").format("YYYY-MM-DD");
	const sinceMs = moment(since, "YYYY-MM-DD").valueOf();
	const out: Candidate[] = [];
	const files = plugin.app.vault.getMarkdownFiles();
	for (const src of d.sources) {
		if (!src.on || src.unit === "루미") continue;
		for (const f of files) {
			if (f.path.startsWith(`${d.root}/`) && !f.path.startsWith(`${d.root}/01 기록/`)) continue; // not our own posts · 글감
			if (!underSource(f.path, src.path)) continue;
			const nameDate = /(\d{4}-\d{2}-\d{2})/.exec(f.basename)?.[1];
			const ym = /(\d{4}-\d{2})(?!-\d)/.exec(f.basename)?.[1];
			if (nameDate ? nameDate < since : ym ? `${ym}-31` < since : f.stat.mtime < sinceMs) continue;
			out.push(...candidatesOf(src, f.path, await plugin.app.vault.cachedRead(f), f.stat.mtime, since));
		}
	}
	return out.sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path) || b.line - a.line).slice(0, 400);
}

/** Links already kept by 글감 lines (to mark candidates as 고름). */
export function pickedLinks(d: StudioData): Set<string> {
	const s = new Set<string>();
	for (const g of d.glgam) for (const f of g.from) s.add(f);
	return s;
}

export function linkKeyOf(c: Candidate): string {
	return c.line >= 0 && !c.heading ? (c.block ? candidateLink(c, c.block) : "") : candidateLink(c, "");
}

async function writeGlgam(plugin: MyLogsPlugin, root: string, line: string, today: string): Promise<void> {
	const ym = today.slice(0, 7);
	const path = glgamPath(root, ym);
	const f = file(plugin, path);
	if (!f) {
		await ensureFolder(plugin, path.slice(0, path.lastIndexOf("/")));
		await plugin.app.vault.create(path, appendGlgam(glgamSkeleton(ym, today), line));
		return;
	}
	await plugin.app.vault.process(f, (t) => setFm(appendGlgam(t, line), { updated: today }));
}

/** 「글감으로」: a block id on the source line (line candidates), then one 글감 line. */
export async function pickCandidate(plugin: MyLogsPlugin, d: StudioData, c: Candidate, text?: string): Promise<void> {
	let link = "";
	if (c.line >= 0 && !c.heading) {
		const f = file(plugin, c.path);
		if (!f) throw new Error(`원본을 찾지 못했어요: ${c.path}`);
		let block = c.block;
		if (!block) {
			block = newBlockId("g");
			let found = false;
			await plugin.app.vault.process(f, (t) => {
				const lines = t.split("\n");
				let i = c.line;
				if (!(lines[i] !== undefined && `${c.path}#L${hash(lines[i].replace(/\r$/, ""))}` === c.key)) {
					i = lines.findIndex((l) => `${c.path}#L${hash(l.replace(/\r$/, ""))}` === c.key);
				}
				if (i < 0) return t;
				const ex = /\s\^([\w-]+)\s*$/.exec(lines[i]);
				if (ex) block = ex[1];
				else lines[i] = withBlock(lines[i].replace(/\r$/, ""), block) + (lines[i].endsWith("\r") ? "\r" : "");
				found = true;
				return lines.join("\n");
			});
			if (!found) throw new Error("원본 줄이 바뀌었어요. 화면을 새로 고친 뒤 다시 골라 주세요.");
		}
		link = candidateLink(c, block);
	} else link = candidateLink(c, "");
	await writeGlgam(plugin, d.root, formatGlgam({ text: text ?? c.text, src: c.source, from: [link], added: d.today, block: newBlockId("g") }), d.today);
}

export async function addManualGlgam(plugin: MyLogsPlugin, d: StudioData, text: string): Promise<void> {
	const t = text.trim();
	if (!t) return;
	await writeGlgam(plugin, d.root, formatGlgam({ text: t, src: "hand", from: [], added: d.today, block: newBlockId("g") }), d.today);
}

async function editGlgamLine(plugin: MyLogsPlugin, g: GlgamLine, fn: (raw: string) => string): Promise<void> {
	const f = file(plugin, g.file);
	if (!f) throw new Error(`글감 파일이 없어요: ${g.file}`);
	await plugin.app.vault.process(f, (t) => {
		const lines = t.split("\n");
		let i = g.line;
		if (lines[i]?.replace(/\r$/, "") !== g.raw) i = lines.findIndex((l) => l.replace(/\r$/, "") === g.raw);
		if (i < 0) throw new Error("글감 줄이 바뀌었어요. 다시 시도해 주세요.");
		lines[i] = fn(lines[i].replace(/\r$/, ""));
		return setFm(lines.join("\n"), { updated: todayIso() });
	});
}

export const dropGlgam = (plugin: MyLogsPlugin, g: GlgamLine, why: string) => editGlgamLine(plugin, g, (raw) => markDropped(raw, why));

// ───────────────────────── 게시물 ─────────────────────────

export async function createPost(plugin: MyLogsPlugin, d: StudioData, ch: ChannelDef, title: string, g: GlgamLine | null): Promise<TFile> {
	const dir = channelDir(d.root, ch);
	await ensureFolder(plugin, dir);
	let path = `${dir}/${d.today} ${safeTitle(title)}.md`;
	for (let n = 2; file(plugin, path); n++) path = `${dir}/${d.today} ${safeTitle(title)} ${n}.md`;
	const id = newPostId(d.today, d.posts.map((p) => p.id));
	const block = g ? g.block || newBlockId("g") : "";
	const from = g ? [`[[${g.file.slice(g.file.lastIndexOf("/") + 1).replace(/\.md$/, "")}#^${block}]]`] : [];
	let text = postSkeleton(ch, id, from);
	if (g) text = setPostBody(text, ch, ch.key === "th" ? { parts: [{ text: g.text, media: [] }] } : { text: g.text });
	const f = await plugin.app.vault.create(path, text);
	if (g) await editGlgamLine(plugin, g, (raw) => markWritten(withBlock(raw, block), `[[${f.path.replace(/\.md$/, "")}|${ch.name}]]`));
	return f;
}

/** 삭제: the post file to Obsidian's trash; 글감 lines that pointed at it let go of the link. */
export async function deletePost(plugin: MyLogsPlugin, d: StudioData, p: Post): Promise<void> {
	const f = file(plugin, p.path);
	if (!f) return;
	const stem = p.path.replace(/\.md$/, "");
	for (const g of d.glgam.filter((x) => x.posts.includes(stem))) await editGlgamLine(plugin, g, (raw) => unmarkWritten(raw, p.path));
	await plugin.app.fileManager.trashFile(f);
}

export async function patchPost(plugin: MyLogsPlugin, path: string, patch: Record<string, FmValue | null>, body?: { ch: ChannelDef; text?: string; parts?: ThreadPart[] }): Promise<void> {
	const f = file(plugin, path);
	if (!f) throw new Error(`게시물이 없어요: ${path}`);
	await plugin.app.vault.process(f, (t) => {
		let out = Object.keys(patch).length ? setFm(t, patch, FM_ORDER) : t;
		if (body) out = setPostBody(out, body.ch, body);
		return out;
	});
}

export async function renamePost(plugin: MyLogsPlugin, p: Post, title: string): Promise<string> {
	const f = file(plugin, p.path);
	if (!f) return p.path;
	const t = safeTitle(title);
	if (t === p.title) return p.path;
	const dir = p.path.slice(0, p.path.lastIndexOf("/"));
	let to = `${dir}/${p.date ? `${p.date} ` : ""}${t}.md`;
	for (let n = 2; file(plugin, to); n++) to = `${dir}/${p.date ? `${p.date} ` : ""}${t} ${n}.md`;
	await plugin.app.fileManager.renameFile(f, to);
	return to;
}

/** Old posts get an id the first time the studio sees them (the key for `studio/results/{id}.json`). */
export async function ensureIds(plugin: MyLogsPlugin, d: StudioData): Promise<number> {
	const taken = new Set(d.posts.map((p) => p.id).filter(Boolean));
	let n = 0;
	for (const p of d.posts) {
		if (p.id) continue;
		const id = newPostId(p.date || d.today, taken);
		taken.add(id);
		await patchPost(plugin, p.path, { id, channel: p.channel.name });
		n++;
	}
	return n;
}

// ───────────────────────── 예약 보내기 · 결과 ─────────────────────────

async function postWebhook(plugin: MyLogsPlugin, p: Post, action: "schedule" | "cancel"): Promise<{ status: number; text: string }> {
	const sec = loadSecrets(plugin.app);
	const headers = webhookHeaders(p.channel.key, sec.studioKey);
	const r = await requestUrl({
		url: sec.webhook[p.channel.key].trim(),
		method: "POST",
		contentType: "application/json",
		...(Object.keys(headers).length ? { headers } : {}),
		body: JSON.stringify(buildPayload(p, action)),
		throw: false,
	});
	return { status: r.status, text: r.text ?? "" };
}

export async function sendSchedule(plugin: MyLogsPlugin, p: Post): Promise<"sent" | "noted"> {
	const hook = loadSecrets(plugin.app).webhook[p.channel.key].trim();
	if (!hook) {
		await patchPost(plugin, p.path, { stage: "예약", scheduled: p.scheduled, sent: null, error: null });
		return "noted";
	}
	const r = await postWebhook(plugin, p, "schedule");
	if (r.status < 200 || r.status >= 300) throw new Error(`보내지 못했어요 (${r.status}) ${r.text.slice(0, 120)}`);
	await patchPost(plugin, p.path, { stage: "예약", scheduled: p.scheduled, sent: nowStamp(), error: null });
	return "sent";
}

export async function cancelSchedule(plugin: MyLogsPlugin, p: Post): Promise<void> {
	const hook = loadSecrets(plugin.app).webhook[p.channel.key].trim();
	if (hook && p.sent) {
		const r = await postWebhook(plugin, p, "cancel");
		if (r.status < 200 || r.status >= 300) throw new Error(`취소를 보내지 못했어요 (${r.status})`);
	}
	await patchPost(plugin, p.path, { stage: "다듬기", sent: null, error: null });
}

/** Hand-marked 발행 (posted by hand, or before a result file exists). */
export async function markPublished(plugin: MyLogsPlugin, p: Post, url: string, date: string): Promise<void> {
	await patchPost(plugin, p.path, { stage: "발행", published: date, url, error: null });
}

let lastPoll = 0;

export interface PollOutcome {
	changed: number;
	/** Reads that failed for a reason other than "no result yet". */
	errors: number;
	/** Bucket, region, or keys are missing, and there was something to check. */
	unconfigured: boolean;
}

/** Read `studio/results/{id}.json` for each 예약 post that was sent and is not published yet. */
export async function pollResults(plugin: MyLogsPlugin, d: StudioData, force = false): Promise<PollOutcome> {
	const waiting = d.posts.filter((p) => p.stage === "예약" && p.sent && !p.published && p.id);
	if (!waiting.length) return { changed: 0, errors: 0, unconfigured: false };
	const cfg = s3Config(plugin);
	if (!isS3Ready(cfg)) return { changed: 0, errors: 0, unconfigured: true };
	if (!force && Date.now() - lastPoll < 5 * 60_000) return { changed: 0, errors: 0, unconfigured: false };
	lastPoll = Date.now();
	let changed = 0;
	const problems: string[] = [];
	for (const p of waiting) {
		const key = resultObjectKey(p.id);
		if (!key) {
			problems.push(`${p.id}: 결과 키가 올바르지 않아요`);
			continue;
		}
		try {
			const res = await getObject(cfg, obsidianSend, key);
			const read = interpretResultGet(res.status, res.text);
			if (read.kind === "missing") continue;
			if (read.kind === "error") {
				problems.push(`${p.id}: ${read.message}`);
				continue;
			}
			if (read.row.id !== p.id) {
				problems.push(`${p.id}: 결과 id가 달라요`);
				continue;
			}
			const patch = resultPatch(p, read.row);
			if (!patch) continue;
			await patchPost(plugin, p.path, patch);
			changed++;
		} catch (e) {
			problems.push(`${p.id}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (problems.length) {
		console.warn("[MyLogs] studio results", problems);
		new Notice(`발행 결과 일부를 읽지 못했어요. ${problems[0]}`, 8000);
	}
	return { changed, errors: problems.length, unconfigured: false };
}

// ───────────────────────── 소스 등록부 ─────────────────────────

export async function saveSources(plugin: MyLogsPlugin, d: StudioData, sources: Source[], change: string): Promise<void> {
	const path = sourcesPath(d.root);
	const f = file(plugin, path);
	if (!f) {
		await ensureFolder(plugin, path.slice(0, path.lastIndexOf("/")));
		await plugin.app.vault.create(path, rewriteSources(null, sources, d.today, change));
		return;
	}
	await plugin.app.vault.process(f, (t) => rewriteSources(t, sources, d.today, change));
}

export async function openPath(plugin: MyLogsPlugin, path: string, newTab = true): Promise<void> {
	const f = file(plugin, path);
	if (f) await plugin.app.workspace.getLeaf(newTab ? "tab" : false).openFile(f);
	else await plugin.app.workspace.openLinkText(path, "", newTab ? "tab" : false);
}

/** `[[path#^block]]` / `[[path#heading]]` → the text there (for 출처 quotes). */
export async function quoteOf(plugin: MyLogsPlugin, link: string, from = ""): Promise<string | null> {
	const target = link.replace(/^\[\[|\]\]$/g, "").split("|")[0];
	const [p, frag = ""] = target.split("#");
	const f = plugin.app.metadataCache.getFirstLinkpathDest(p, from);
	if (!f) return null;
	const lines = (await plugin.app.vault.cachedRead(f)).split(/\r?\n/);
	if (frag.startsWith("^")) {
		const l = lines.find((x) => x.trimEnd().endsWith(frag));
		return l ? l.replace(/^\s*[-*+]\s+(\[[ x>\-]\]\s+)?/, "").replace(/\s*\([a-z]+::[^)]*\)/g, "").replace(/\s\^[\w-]+\s*$/, "").replace(/\s*→\s*\[\[.*$/, "").trim() : null;
	}
	if (frag) {
		const i = lines.findIndex((x) => /^#{1,6}\s/.test(x) && x.replace(/^#+\s*/, "").trim() === frag.trim());
		if (i >= 0) return [lines[i].replace(/^#+\s*/, ""), ...lines.slice(i + 1, i + 6).filter((x) => x.trim() && !/^#/.test(x))].join(" ").slice(0, 280);
	}
	return lines.filter((x) => x.trim() && !/^(---|#|\w+:)/.test(x)).slice(0, 3).join(" ").slice(0, 280);
}

export function notice(msg: string, ms = 6000): void {
	new Notice(msg, ms);
}

export { channelByName };
