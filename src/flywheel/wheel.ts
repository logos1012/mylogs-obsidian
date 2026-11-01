/**
 * Flywheel v3 data (`12 Flywheel/AGENTS.md` v3.0): the registry `Flywheel.md`, one hub per
 * element, monthly records, outputs, and the 수행 표 evidence lines.
 *
 *   12 Flywheel/Flywheel.md               한 문장 + 「## 요소」 등록부 표 + 변경 기록
 *   12 Flywheel/운동/운동.md               요소 허브 (frontmatter + ## 방법 …) — 정의의 정본
 *   12 Flywheel/운동/01 기록/운동 기록 2026-11.md   ### YYYY-MM-DD 날짜 칸
 *   12 Flywheel/운동/02 산출물/{채널}/YYYY-MM-DD 제목.md
 *   12 Flywheel/99 작업실/수행/YYYY-MM.md   수행 표 + `- YYYY-MM-DD F-N: 근거` 줄
 *
 * Ids (`F-N`) stay in files only; screens show names. Pure module (no Obsidian imports).
 */

import { getFmList, getFmValue, setFmList, setFmValue } from "../projects/ops.ts";
import { getSectionContent, replaceSectionContent } from "../writer.ts";
import type { FlywheelElement } from "./model.ts";

export const REGISTRY_SECTION = "요소";
export const METHOD_SECTION = "방법";
export const TUNING_SECTION = "지금 다듬는 것";
export const DECISIONS_SECTION = "주요 결정";
export const RECORD_DIR = "01 기록";
export const OUTPUT_DIR = "02 산출물";
export const WORK_DIR = "99 작업실";
export const WEEKLY_DIR = "주간";
export const MATERIAL_TAG = "#재료";
export const METHOD_KEYS = ["정체성", "최소", "보통", "다음"] as const;

const eolOf = (t: string) => (t.includes("\r\n") ? "\r\n" : "\n");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Characters that break a file name or a wikilink (AGENTS 「3-5」). */
export const BAD_NAME_RE = /["'/\\:*?<>|#^[\]]/;

// ───────────────────────── 등록부 (Flywheel.md 「## 요소」) ─────────────────────────

export interface RegistryRow {
	id: string;
	name: string;
	/** Link target relative to the Flywheel folder, without `.md` (e.g. `운동/운동`). */
	link: string;
	status: string;
	goals: string[];
	since: string;
}

function cells(line: string): string[] {
	// `\|` inside a wikilink alias is part of the cell.
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
}

/** [header, first row, end) of the registry table, or null. */
function registryTable(lines: string[]): { header: number; end: number } | null {
	let inSec = false;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (/^## /.test(l)) inSec = l.slice(3).trim() === REGISTRY_SECTION;
		if (!inSec || !l.trim().startsWith("|")) continue;
		const c = cells(l);
		if (c[0] !== "id") continue;
		let end = i + 2;
		while (end < lines.length && lines[end].trim().startsWith("|")) end++;
		return { header: i, end };
	}
	return null;
}

/** True when `Flywheel.md` is the v3 registry (has 「## 요소」 with an `id` table). */
export function isRegistry(text: string | null): boolean {
	return !!text && registryTable(text.split(/\r?\n/)) !== null;
}

function linkOf(cell: string): { link: string; alias: string } {
	const m = /\[\[([^\]]+?)\]\]/.exec(cell);
	if (!m) return { link: "", alias: cell };
	const [target, alias] = m[1].split(/\\?\|/);
	return { link: target.trim(), alias: (alias ?? target).trim() };
}

const goalList = (s: string) =>
	s
		.split(/[,\s]+/)
		.map((x) => x.replace(/^\[\[|\]\]$/g, "").trim())
		.filter((x) => /^G-\d{4}-\d{2}/.test(x));

export function parseRegistry(text: string | null): RegistryRow[] {
	if (!text) return [];
	const lines = text.split(/\r?\n/);
	const t = registryTable(lines);
	if (!t) return [];
	const head = cells(lines[t.header]);
	const col = (k: string) => head.indexOf(k);
	const out: RegistryRow[] = [];
	for (let i = t.header + 2; i < t.end; i++) {
		const c = cells(lines[i]);
		const id = c[col("id")] ?? "";
		if (!/^F-\d+$/.test(id)) continue;
		const { link, alias } = linkOf(c[col("이름")] ?? "");
		out.push({ id, name: alias, link, status: c[col("상태")] ?? "", goals: goalList(c[col("목표")] ?? ""), since: c[col("시작")] ?? "" });
	}
	return out;
}

export function registryLine(r: RegistryRow): string {
	const link = r.link ? `[[${r.link}\\|${r.name}]]` : r.name;
	return `| ${r.id} | ${link} | ${r.status} | ${r.goals.length ? r.goals.join(", ") : "—"} | ${r.since} |`;
}

/** Replace the row with the same id, or add it at the end of the table (creating 「## 요소」 if needed). */
export function upsertRegistryRow(text: string, r: RegistryRow): string {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	const t = registryTable(lines);
	const line = registryLine(r);
	if (!t) {
		const at = lines.findIndex((l) => l === "## 변경 기록");
		const block = [`## ${REGISTRY_SECTION}`, "| id | 이름 | 상태 | 목표 | 시작 |", "|---|---|---|---|---|", line, ""];
		if (at === -1) lines.push("", ...block);
		else lines.splice(at, 0, ...block);
		return lines.join(eol);
	}
	for (let i = t.header + 2; i < t.end; i++) {
		if (cells(lines[i])[0] === r.id) {
			lines[i] = line;
			return lines.join(eol);
		}
	}
	lines.splice(t.end, 0, line);
	return lines.join(eol);
}

/** Reorder registry rows by id (rows not listed keep their relative order at the end). */
export function orderRegistry(text: string, ids: string[]): string {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	const t = registryTable(lines);
	if (!t) return text;
	const rows = lines.slice(t.header + 2, t.end);
	const rank = (l: string) => {
		const i = ids.indexOf(cells(l)[0]);
		return i === -1 ? ids.length : i;
	};
	const sorted = rows.map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map((x) => x.l);
	lines.splice(t.header + 2, rows.length, ...sorted);
	return lines.join(eol);
}

/** Next id: the largest `F-N` anywhere in the registry file + 1 (never reused). */
export function nextElementId(text: string): string {
	let max = 0;
	for (const m of text.matchAll(/\bF-(\d+)\b/g)) max = Math.max(max, parseInt(m[1], 10));
	return `F-${max + 1}`;
}

/** The one-sentence purpose under `# Flywheel` (before the first `## `), or "". */
export function wheelPurpose(text: string | null): string {
	if (!text) return "";
	const lines = text.split(/\r?\n/);
	const h1 = lines.findIndex((l) => /^#\s/.test(l));
	if (h1 === -1) return "";
	const out: string[] = [];
	for (let i = h1 + 1; i < lines.length && !lines[i].startsWith("## "); i++) if (lines[i].trim() && !lines[i].trim().startsWith("<!--")) out.push(lines[i].trim());
	return out.join(" ");
}

// ───────────────────────── 요소 허브 ─────────────────────────

export function elementFolder(root: string, name: string): string {
	return `${root}/${name}`;
}
export function hubPathOf(root: string, name: string): string {
	return `${root}/${name}/${name}.md`;
}

/** `- 키:: 값` lines of one `## section`. */
function fieldLines(body: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of (body ?? "").split(/\r?\n/)) {
		const m = /^- ([^:]+?)::\s?(.*)$/.exec(raw);
		if (m) out[m[1].trim()] = m[2].trim();
	}
	return out;
}

/** An element from its hub (null text = hub missing → registry values only). */
export function elementOf(row: RegistryRow | null, hubText: string | null, hubPath: string): FlywheelElement {
	const folder = hubPath.slice(0, hubPath.lastIndexOf("/"));
	if (hubText === null) {
		return { id: row?.id ?? "", name: row?.name ?? "", status: row?.status ?? "", since: row?.since ?? "", goals: row?.goals ?? [], channels: [], fields: {}, folder, hubPath, hasHub: false };
	}
	const fm = (k: string) => getFmValue(hubText, k);
	const fields = fieldLines(getSectionContent(hubText, METHOD_SECTION));
	const status = fm("status");
	const since = fm("since");
	const goals = getFmList(hubText, "goals").map((g) => g.replace(/^\[\[|\]\]$/g, ""));
	if (status) fields.status = status;
	if (since) fields.since = since;
	if (goals.length) fields.goal = goals.join(", ");
	return {
		id: fm("id") || row?.id || "",
		name: fm("title") || row?.name || "",
		status,
		since,
		goals,
		channels: getFmList(hubText, "channels"),
		fields,
		folder,
		hubPath,
		hasHub: true,
	};
}

export interface NewElementInput {
	id: string;
	name: string;
	identity: string;
	min: string;
	normal: string;
	next: string;
	since: string;
	goals?: string[];
	channels?: string[];
}

export function hubSkeleton(e: NewElementInput, today: string): string {
	return [
		"---",
		"type: flywheel-element",
		`id: ${e.id}`,
		`title: ${oneLine(e.name)}`,
		"status: 사용",
		`since: ${e.since}`,
		`goals: [${(e.goals ?? []).join(", ")}]`,
		`channels: [${(e.channels ?? []).join(", ")}]`,
		`updated: ${today}`,
		"---",
		`# ${oneLine(e.name)}`,
		"",
		`## ${METHOD_SECTION}`,
		`- 정체성:: ${oneLine(e.identity)}`,
		`- 최소:: ${oneLine(e.min)}`,
		`- 보통:: ${oneLine(e.normal)}`,
		`- 다음:: ${oneLine(e.next)}`,
		"",
		`## ${TUNING_SECTION}`,
		"",
		`## ${DECISIONS_SECTION}`,
		`- ${today} — 요소 시작`,
		"",
	].join("\n");
}

/** Set `- key:: value` in 「## 방법」 (adds the line or the section when missing). */
export function setHubMethod(text: string, key: string, value: string): string {
	const body = getSectionContent(text, METHOD_SECTION);
	const line = `- ${key}:: ${oneLine(value)}`;
	if (body === null) {
		const eol = eolOf(text);
		return `${text.replace(/\s*$/, "")}${eol}${eol}## ${METHOD_SECTION}${eol}${line}${eol}`;
	}
	const ls = body.split(/\r?\n/);
	const i = ls.findIndex((l) => new RegExp(`^- ${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*::`).test(l));
	if (i !== -1) ls[i] = line;
	else {
		let last = -1;
		ls.forEach((l, n) => {
			if (/^- [^:]+::/.test(l)) last = n;
		});
		ls.splice(last + 1, 0, line);
	}
	return replaceSectionContent(text, METHOD_SECTION, ls.join("\n").replace(/\n+$/, ""));
}

/** The text of a hub section (trimmed), "" when missing. */
export function hubSection(text: string, heading: string): string {
	return (getSectionContent(text, heading) ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function setHubSection(text: string, heading: string, body: string): string {
	if (getSectionContent(text, heading) === null) {
		const eol = eolOf(text);
		return `${text.replace(/\s*$/, "")}${eol}${eol}## ${heading}${eol}${body.trim()}${eol}`;
	}
	return replaceSectionContent(text, heading, body.trim());
}

export function setHubFm(text: string, key: string, value: string | string[], today: string): string {
	const t = Array.isArray(value) ? setInlineList(text, key, value) : setFmValue(text, key, value);
	return t === text ? text : setFmValue(t, "updated", today);
}

/** `key: [a, b]` (inline, like the templates) — replaces a block list too. */
function setInlineList(text: string, key: string, values: string[]): string {
	if (getFmList(text, key).join("\u0000") === values.join("\u0000") && getFmValue(text, key).startsWith("[")) return text;
	const viaBlock = setFmList(text, key, []);
	return setFmValue(viaBlock, key, `[${values.join(", ")}]`);
}

/** Rename the H1 and `title`. */
export function renameHub(text: string, name: string, today: string): string {
	const t = setFmValue(text, "title", oneLine(name)).replace(/^# .*$/m, `# ${oneLine(name)}`);
	return setFmValue(t, "updated", today);
}

/** `→ F-2 이유` → `글쓰기 · 이유` (ids stay off the screen). */
export function nextText(v: string, elements: FlywheelElement[]): string {
	const s = v.replace(/^→\s*/, "").trim();
	const m = /^(F-\d+)\b\s*(.*)$/.exec(s);
	if (!m) return s;
	const to = elements.find((e) => e.id === m[1]);
	return to ? `${to.name} · ${m[2]}`.replace(/ · $/, "") : m[2] || s;
}

// ───────────────────────── 기록 (01 기록/{이름} 기록 YYYY-MM.md) ─────────────────────────

export function recordName(name: string, ym: string): string {
	return `${name} 기록 ${ym}`;
}
export function recordPath(e: Pick<FlywheelElement, "folder" | "name">, ym: string): string {
	return `${e.folder}/${RECORD_DIR}/${recordName(e.name, ym)}.md`;
}
export function recordSkeleton(e: Pick<FlywheelElement, "id" | "name">, ym: string): string {
	return `---\ntype: flywheel-record\nelement: ${e.id}\nmonth: ${ym}\n---\n# ${recordName(e.name, ym)}\n`;
}

export interface RecordLine {
	/** Line text without the leading `- ` and without the `#재료` tag. */
	text: string;
	raw: string;
	material: boolean;
	/** `![[target]]` embed (a Daily Pad memo), or null. */
	embed: string | null;
}
export interface RecordDay {
	date: string;
	material: boolean;
	lines: RecordLine[];
}

export function parseRecord(text: string | null): RecordDay[] {
	if (!text) return [];
	const out: RecordDay[] = [];
	let cur: RecordDay | null = null;
	let fence = false;
	for (const raw of text.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
		const h = /^### (\d{4}-\d{2}-\d{2})(.*)$/.exec(raw);
		if (h && !fence) {
			cur = { date: h[1], material: h[2].includes(MATERIAL_TAG), lines: [] };
			out.push(cur);
			continue;
		}
		if (/^#{1,2} /.test(raw)) {
			cur = null;
			continue;
		}
		if (!cur || !raw.trim() || raw.trim().startsWith("<!--")) continue;
		const body = raw.replace(/^\s*[-*+]\s+/, "");
		const embed = /^!\[\[([^\]]+)\]\]/.exec(body.trim())?.[1] ?? null;
		const material = body.includes(MATERIAL_TAG);
		cur.lines.push({ text: body.replaceAll(MATERIAL_TAG, "").trim(), raw, material, embed });
	}
	return out;
}

/** Add one line at the end of the `### date` block (the heading is created in date order). */
export function appendRecord(text: string, date: string, line: string): string {
	const eol = eolOf(text);
	const lines = text.replace(/\s+$/, "").split(/\r?\n/);
	const item = /^\s*[-*+] /.test(line) ? line : `- ${oneLine(line)}`;
	const heads = lines.map((l, i) => ({ i, d: /^### (\d{4}-\d{2}-\d{2})/.exec(l)?.[1] })).filter((h) => h.d);
	const hit = heads.find((h) => h.d === date);
	if (hit) {
		let end = hit.i + 1;
		while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++;
		while (end > hit.i + 1 && !lines[end - 1].trim()) end--;
		lines.splice(end, 0, item);
		return lines.join(eol) + eol;
	}
	const after = heads.find((h) => (h.d as string) > date);
	if (after) {
		lines.splice(after.i, 0, `### ${date}`, item, "");
		return lines.join(eol) + eol;
	}
	lines.push("", `### ${date}`, item);
	return lines.join(eol) + eol;
}

/** Remove the first line of the `### date` block that embeds `target` (unlinking a memo). */
export function removeRecordEmbed(text: string, date: string, target: string): string {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	let head = -1;
	for (let i = 0; i < lines.length; i++) {
		const h = /^### (\d{4}-\d{2}-\d{2})/.exec(lines[i]);
		if (h) head = h[1] === date ? i : -1;
		else if (/^#{1,2} /.test(lines[i])) head = -1;
		else if (head !== -1 && lines[i].includes(`![[${target}]]`)) {
			lines.splice(i, 1);
			let end = head + 1;
			while (end < lines.length && !/^#{1,3} /.test(lines[end])) end++;
			if (!lines.slice(head + 1, end).some((l) => l.trim())) {
				let start = head;
				if (start > 0 && !lines[start - 1].trim()) start--;
				lines.splice(start, end - start);
			}
			return lines.join(eol);
		}
	}
	return text;
}

/** Toggle `#재료` on one raw record line. */
export function toggleMaterial(text: string, raw: string): string {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	const i = lines.indexOf(raw);
	if (i === -1) return text;
	lines[i] = raw.includes(MATERIAL_TAG) ? raw.replace(new RegExp(`\\s*${MATERIAL_TAG}`, "g"), "") : `${raw.replace(/\s+$/, "")} ${MATERIAL_TAG}`;
	return lines.join(eol);
}

// ───────────────────────── 수행 표 근거 줄 ─────────────────────────

const EVIDENCE_RE = /^- (\d{4}-\d{2}-\d{2}) (F-\d+): (.*)$/;

/** `- YYYY-MM-DD F-N: 근거` lines → `${iso}|${id}` → text (last one wins). */
export function parseEvidence(text: string | null): Map<string, string> {
	const out = new Map<string, string>();
	for (const raw of (text ?? "").split(/\r?\n/)) {
		const m = EVIDENCE_RE.exec(raw.trim());
		if (m) out.set(`${m[1]}|${m[2]}`, m[3].trim());
	}
	return out;
}

/** Set (or with `note === null` remove) the evidence line of one day and element. */
export function setEvidence(text: string, iso: string, id: string, note: string | null): string {
	const eol = eolOf(text);
	const lines = text.replace(/\s+$/, "").split(/\r?\n/);
	const i = lines.findIndex((l) => {
		const m = EVIDENCE_RE.exec(l.trim());
		return !!m && m[1] === iso && m[2] === id;
	});
	if (note === null) {
		if (i !== -1) lines.splice(i, 1);
		return lines.join(eol) + eol;
	}
	const line = `- ${iso} ${id}: ${oneLine(note)}`;
	if (i !== -1) lines[i] = line;
	else {
		const last = lines.reduce((n, l, k) => (EVIDENCE_RE.test(l.trim()) ? k : n), -1);
		if (last !== -1) lines.splice(last + 1, 0, line);
		else lines.push("", line);
	}
	return lines.join(eol) + eol;
}

/** How a check got there (shown on the card). */
export type CheckSource = "none" | "me" | "agent" | "vision" | "fix" | "rest";

export const SOURCE_LABEL: Record<CheckSource, string> = { none: "아직", me: "직접", agent: "에이전트", vision: "Vision Board", fix: "고침", rest: "쉼" };

export function sourceOf(mark: string, evidence: string | undefined): CheckSource {
	if (mark === "쉼") return "rest";
	if (mark !== "x") return "none";
	if (!evidence) return "me";
	if (evidence.includes("Vision Board")) return "vision";
	if (evidence.includes("사용자 수정")) return "fix";
	return "agent";
}

/** `HH:MM` in an evidence line, or "". */
export function evidenceTime(evidence: string | undefined): string {
	return /\b(\d{1,2}:\d{2})\b/.exec(evidence ?? "")?.[1] ?? "";
}

/** The user's words quoted in an evidence line (`“…”` or `"…"`), or "". */
export function evidenceQuote(evidence: string | undefined): string {
	return /[“"]([^”"]+)[”"]/.exec(evidence ?? "")?.[1] ?? "";
}

// ───────────────────────── 산출물 · 작업실 ─────────────────────────

export interface ElementFile {
	path: string;
	/** File name without `.md`. */
	name: string;
	/** `YYYY-MM-DD` from the name, or "". */
	date: string;
	title: string;
	channel: string;
	kind: "record" | "post" | "output" | "doc" | "weekly" | "work";
	/** 작업실 group (`10 자료`, …) or channel for docs. */
	group: string;
}

/** Sort an element's files (vault paths) into records, posts, outputs, channel docs and 작업실. */
export function classifyFiles(paths: string[], folder: string): ElementFile[] {
	const out: ElementFile[] = [];
	// macOS / Google Drive may hand back NFD names; compare in NFC.
	const pre = folder.normalize("NFC") + "/";
	for (const path of paths) {
		if (!path.normalize("NFC").startsWith(pre)) continue;
		const rel = path.normalize("NFC").slice(pre.length).split("/");
		const file = rel[rel.length - 1];
		const name = file.replace(/\.md$/, "");
		const dm = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(name);
		const base = { path, name, date: dm?.[1] ?? "", title: dm?.[2] ?? name, channel: "", group: "" };
		if (rel.length === 1) continue; // the hub (or a stray root file)
		if (rel[0] === RECORD_DIR) out.push({ ...base, kind: "record" });
		else if (rel[0] === OUTPUT_DIR) {
			if (rel.length === 2) out.push({ ...base, kind: dm ? "output" : "doc" });
			else if (rel.length === 3) out.push({ ...base, channel: rel[1], group: rel[1], kind: dm ? "post" : "doc" });
			else out.push({ ...base, channel: rel[1], group: rel[1], kind: rel[2] === WEEKLY_DIR ? "weekly" : "doc" });
		} else if (rel[0] === WORK_DIR) out.push({ ...base, group: rel.length > 2 ? rel[1] : "", kind: "work" });
	}
	return out.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

// ───────────────────────── 재료 ─────────────────────────

export interface Material {
	elementId: string;
	elementName: string;
	date: string;
	text: string;
	/** `{이름} 기록 YYYY-MM#YYYY-MM-DD` — what a post's `from` links to. */
	anchor: string;
	recordPath: string;
	raw: string;
	embed: string | null;
}

export function materialsOf(e: Pick<FlywheelElement, "id" | "name" | "folder">, days: RecordDay[], ym: string): Material[] {
	const out: Material[] = [];
	const anchorBase = recordName(e.name, ym);
	for (const d of days) {
		for (const l of d.lines) {
			if (!d.material && !l.material) continue;
			out.push({ elementId: e.id, elementName: e.name, date: d.date, text: l.text, anchor: `${anchorBase}#${d.date}`, recordPath: recordPath(e, ym), raw: l.raw, embed: l.embed });
		}
	}
	return out;
}

/** Normalize a `from` link to `name#heading` (path and alias dropped). */
export function anchorKey(link: string): string {
	const inner = link.replace(/^!?\[\[|\]\]$/g, "").split("|")[0];
	const [path, head = ""] = inner.split("#");
	return `${path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "")}#${head}`;
}

// ───────────────────────── Daily Pad 메모 잇기 (「3-6」) ─────────────────────────

const RECORD_FIELD_RE = /\s*\(record::\s*([^)]*)\)/;
const BLOCK_ID_RE = /\s\^([A-Za-z0-9-]+)\s*$/;

/** Record anchors linked from a memo line. */
export function recordLinksOf(line: string): string[] {
	const m = RECORD_FIELD_RE.exec(line);
	if (!m) return [];
	return [...m[1].matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]);
}

export function blockIdOf(line: string): string | null {
	return BLOCK_ID_RE.exec(line)?.[1] ?? null;
}

/** `fw-N` not used in the pad yet. */
export function nextBlockId(padText: string): string {
	let max = 0;
	for (const m of padText.matchAll(/\^fw-(\d+)\b/g)) max = Math.max(max, parseInt(m[1], 10));
	return `fw-${max + 1}`;
}

/** Add `(record:: [[anchor]])` (merging with an existing field) and a block id at the end. */
export function linkMemoLine(line: string, anchor: string, blockId: string): string {
	const id = blockIdOf(line) ?? blockId;
	let body = line.replace(BLOCK_ID_RE, "").replace(/\s+$/, "");
	const links = recordLinksOf(body);
	if (!links.includes(anchor)) links.push(anchor);
	const field = `(record:: ${links.map((l) => `[[${l}]]`).join(", ")})`;
	body = RECORD_FIELD_RE.test(body) ? body.replace(RECORD_FIELD_RE, ` ${field}`) : insertBeforeTags(body, field);
	return `${body} ^${id}`;
}

/** Remove one anchor (the field goes when empty; the block id stays only while linked). */
export function unlinkMemoLine(line: string, anchor: string): string {
	const links = recordLinksOf(line).filter((l) => l !== anchor);
	let body = line.replace(BLOCK_ID_RE, "").replace(/\s+$/, "");
	body = links.length ? body.replace(RECORD_FIELD_RE, ` (record:: ${links.map((l) => `[[${l}]]`).join(", ")})`) : body.replace(RECORD_FIELD_RE, "");
	const id = blockIdOf(line);
	return links.length && id ? `${body} ^${id}` : body;
}

function insertBeforeTags(body: string, piece: string): string {
	const m = /(\s+#[^\s#]+)+\s*$/.exec(body);
	return m ? `${body.slice(0, m.index)} ${piece}${body.slice(m.index)}` : `${body} ${piece}`;
}

// ───────────────────────── 수행 ─────────────────────────

/** `YYYY-MM-DD` is a valid date string. */
export const isIso = (s: string) => ISO_RE.test(s);
