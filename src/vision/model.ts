/**
 * Vision Board model: `00 Vision Board/Vision Board.md` (`00 Vision Board/AGENTS.md`).
 *
 *   ---
 *   type: vision-board
 *   flywheel: F-4
 *   updated: 2026-10-29
 *   ---
 *   # Vision Board
 *
 *   ## 비전
 *
 *   ### 어머니와 알프스
 *   ![[00 Vision Board/images/alps.png]]
 *   어머니 손을 잡고 알프스를 걷는다.
 *
 *   ## 확언
 *
 *   (전문)
 *
 *   ## 변경 기록
 *
 * Cards are `###` blocks under `## 비전`: the first `![[…]]` is the image, the other lines are the
 * sentence. `## 확언` is read whole. Reading it to the end checks the linked Flywheel element.
 *
 * Pure module (no Obsidian imports).
 */

export const VISION_FILE = "Vision Board.md";
export const CARDS_HEADING = "비전";
export const AFFIRMATION_HEADING = "확언";
export const IMAGES_DIR = "images";

export interface VisionCard {
	title: string;
	/** Link target inside `![[…]]` ("" = no image). */
	image: string;
	/** The sentence (may span lines). */
	text: string;
}

export interface VisionBoard {
	/** Flywheel element the daily reading checks (`flywheel:` in frontmatter); "" = not linked. */
	flywheel: string;
	cards: VisionCard[];
	affirmation: string;
}

/** `<folder>/Vision Board.md` */
export function visionPath(folder: string): string {
	const f = folder.trim().replace(/^\/+|\/+$/g, "");
	return f ? `${f}/${VISION_FILE}` : VISION_FILE;
}

const EMBED_RE = /^!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]\s*$/;

function frontmatterValue(text: string, key: string): string {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m) return "";
	const line = m[1].split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
	return line ? line.slice(key.length + 1).trim() : "";
}

/** Lines of `## heading` up to the next `## ` (null when the section is missing). */
function sectionLines(lines: string[], heading: string): string[] | null {
	const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
	if (at === -1) return null;
	const out: string[] = [];
	for (let i = at + 1; i < lines.length && !/^## /.test(lines[i]); i++) out.push(lines[i]);
	return out;
}

/** Trim blank lines at both ends, keep inner blank lines (paragraphs). */
function trimBlock(lines: string[]): string {
	let s = 0;
	let e = lines.length;
	while (s < e && !lines[s].trim()) s++;
	while (e > s && !lines[e - 1].trim()) e--;
	return lines.slice(s, e).join("\n");
}

export function parseVisionBoard(text: string | null): VisionBoard {
	const board: VisionBoard = { flywheel: "", cards: [], affirmation: "" };
	if (text === null) return board;
	board.flywheel = frontmatterValue(text, "flywheel");
	const lines = text.split(/\r?\n/);
	let cur: { title: string; image: string; body: string[] } | null = null;
	const flush = () => {
		if (cur) board.cards.push({ title: cur.title, image: cur.image, text: trimBlock(cur.body) });
		cur = null;
	};
	for (const l of sectionLines(lines, CARDS_HEADING) ?? []) {
		if (l.startsWith("### ")) {
			flush();
			cur = { title: l.slice(4).trim(), image: "", body: [] };
			continue;
		}
		if (!cur) continue;
		const m = EMBED_RE.exec(l.trim());
		if (m && !cur.image) cur.image = m[1].trim();
		else cur.body.push(l);
	}
	flush();
	board.affirmation = trimBlock(sectionLines(lines, AFFIRMATION_HEADING) ?? []);
	return board;
}

function cardBlock(c: VisionCard): string[] {
	const out = [`### ${c.title.replace(/[\r\n]+/g, " ").trim() || "비전"}`];
	if (c.image.trim()) out.push(`![[${c.image.trim()}]]`);
	if (c.text.trim()) out.push(...c.text.trim().split(/\r?\n/));
	out.push("");
	return out;
}

/** Replace the body of `## heading` (adds the section before `## 변경 기록` / at the end when missing). */
function replaceSection(text: string, heading: string, body: string[]): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
	const block = ["", ...body];
	while (block.length > 1 && block[block.length - 1] === "") block.pop();
	block.push("");
	if (at === -1) {
		let ins = lines.findIndex((l) => l.trim() === "## 변경 기록");
		if (ins === -1) {
			while (lines.length && lines[lines.length - 1] === "") lines.pop();
			lines.push("");
			ins = lines.length;
		}
		lines.splice(ins, 0, `## ${heading}`, ...block);
		return lines.join(eol);
	}
	let end = at + 1;
	while (end < lines.length && !/^## /.test(lines[end])) end++;
	lines.splice(at + 1, end - at - 1, ...block);
	return lines.join(eol);
}

/** Rewrite every card under `## 비전` (other sections and frontmatter kept). */
export function setCards(text: string, cards: VisionCard[]): string {
	return replaceSection(text, CARDS_HEADING, cards.flatMap(cardBlock));
}

export function setAffirmation(text: string, body: string): string {
	return replaceSection(text, AFFIRMATION_HEADING, body.trim() ? body.trim().split(/\r?\n/) : []);
}

/** Move `from` to `to` (both clamped). */
export function moveCard(cards: VisionCard[], from: number, to: number): VisionCard[] {
	const out = cards.slice();
	if (from < 0 || from >= out.length) return out;
	const [c] = out.splice(from, 1);
	out.splice(Math.max(0, Math.min(out.length, to)), 0, c);
	return out;
}

export function visionSkeleton(today: string, flywheel = ""): string {
	return `---\ntype: vision-board\nflywheel: ${flywheel}\nupdated: ${today}\n---\n# Vision Board\n\n## ${CARDS_HEADING}\n\n## ${AFFIRMATION_HEADING}\n\n## 변경 기록\n- ${today}: 만듦 (플러그인)\n`;
}

/** File name for an uploaded image: `YYYY-MM-DD 제목.ext`, safe for the vault. */
export function imageName(today: string, title: string, ext: string): string {
	const base = title.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "vision";
	return `${today} ${base}.${ext.replace(/^\./, "").toLowerCase() || "png"}`;
}

/** Consecutive `x` days ending today (or yesterday when today is not done yet). */
export function streak(done: (iso: string) => boolean, today: string, addDays: (iso: string, n: number) => string, max = 400): number {
	let d = done(today) ? today : addDays(today, -1);
	let n = 0;
	while (n < max && done(d)) {
		n++;
		d = addDays(d, -1);
	}
	return n;
}
