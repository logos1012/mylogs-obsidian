/**
 * Drawer write operations: the 「4-1」 … 「4-5」 procedures of `06 Drawer/AGENTS.md` as pure
 * `text → text` transforms of `Drawer.md`.
 *
 * Every write ends the same way (「4」 완료 조건): the line format is right, exactly one line is
 * appended to 「변경 기록」 (the registry) and frontmatter `updated` is today. Lines are located by
 * the index and content they had when rendered (inside their section); when the line is gone or
 * different the transform fails instead of guessing, and the view re-renders.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { cleanFieldValue, cleanText, replaceContent, setField } from "../line-edit.ts";
import { LIST_LINE_RE, splitLinesKeepEol, stripEol, TASK_LINE_RE } from "../parser.ts";
import { appendToSection, detectEol, findSection, locateLine, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { insertBeforeMeta } from "../wall/edit.ts";
import {
	CHANGELOG_SECTION,
	CONTEXT_LABEL,
	DRAWER_SECTIONS,
	type DrawerItem,
	type DrawerSection,
	findDuplicate,
	goalIdOf,
	parseDrawer,
	splitSources,
	WHEN_UNDECIDED,
} from "./model.ts";

export type EditResult = { ok: true; text: string } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** Where a rendered item was. */
export interface DrawerRef {
	section: DrawerSection;
	index: number;
	line: string;
}

export function refOf(it: DrawerItem): DrawerRef {
	return { section: it.section, index: it.index, line: it.line };
}

// ───────────────────────── formatting (「3. 파일 형식」) ─────────────────────────

export interface NewDrawerItem {
	text: string;
	/** 다시 꺼낼 조건. "" → `(when:: 미정)` (the user insisted, 「4-1」 1). */
	when: string;
	/** Sources: `[[10 Archive Box/Sessions/…]]`, `대화 YYYY-MM-DD`, `Desk Calendar YYYY-MM-DD`, … */
	from: string[];
	section: DrawerSection;
	/** 「맥락」 sub-bullet (optional, one line). */
	context?: string;
	tags?: string[];
	test?: boolean;
}

/** `- [ ] 내용 (when:: 조건) (from:: 출처) (added:: YYYY-MM-DD) (reviewed:: YYYY-MM-DD) #tags` */
export function formatItemLine(i: NewDrawerItem, today: string): string {
	const when = cleanFieldValue(i.when) || WHEN_UNDECIDED;
	const from = i.from.map((s) => cleanText(s)).filter(Boolean);
	const tags = [...(i.tags ?? []).map((t) => `#${t.replace(/^#/, "")}`), ...(i.test ? ["#test"] : [])];
	const parts = [`- [ ] ${cleanText(i.text)}`, `(when:: ${when})`];
	if (from.length) parts.push(`(from:: ${from.join(", ")})`);
	parts.push(`(added:: ${today})`, `(reviewed:: ${today})`, ...tags);
	return parts.join(" ");
}

/** `  - 맥락: …` (one line, 「3」 필드 표). */
export function formatContextLine(context: string): string {
	return `  - ${CONTEXT_LABEL}: ${cleanText(context)}`;
}

/** The 「변경 기록」 entries (「3」 변경 기록 = 등록부). */
export const logEntry = {
	put: (text: string, from: string[]) => `넣음 「${text}」${from.length ? ` (from:: ${from.join(", ")})` : ""}`,
	move: (text: string, from: DrawerSection, to: DrawerSection) => `옮김 「${text}」 ${from} → ${to}`,
	take: (text: string, destLink: string) => `꺼냄 「${text}」 → ${destLink}`,
	letGo: (text: string, why: string) => `놓아줌 「${text}」 (why:: ${cleanFieldValue(why)})`,
	remove: (text: string) => `삭제 「${text}」`,
};

export function logLine(today: string, entry: string): string {
	return `- ${today}: ${entry.replace(/[\r\n]+/g, " ")}`;
}

/** Append one registry line at the end of `## 변경 기록` (added when missing) and set `updated`. */
export function finishWrite(text: string, today: string, entry: string | null): string {
	const out = entry ? appendToSection(text, CHANGELOG_SECTION, logLine(today, entry)) : text;
	return setFrontmatterScalar(out, "updated", today);
}

/** The empty file, as in `06 Drawer/Drawer.md` (「3」). */
export function drawerTemplate(today: string): string {
	return `---\ntype: drawer\nupdated: ${today}\n---\n# Drawer\n\n## 보류\n\n## 아이디어\n\n## 프로젝트 후보\n\n## ${CHANGELOG_SECTION}\n\n${logLine(today, "파일 생성 (플러그인)")}\n`;
}

/**
 * The line written where an item is taken out to (「4-3」 1): `(from:: Drawer)`, and `(goal:: id)`
 * when `when::` was a Pinboard goal id. Tags (and `#test`) follow the item.
 */
export function destinationLine(it: Pick<DrawerItem, "text" | "when" | "tags" | "test">): string {
	const parts = [`- [ ] ${it.text}`, "(from:: Drawer)"];
	const goal = goalIdOf(it.when);
	if (goal) parts.push(`(goal:: ${goal})`);
	parts.push(...it.tags.map((t) => `#${t}`));
	if (it.test) parts.push("#test");
	return parts.join(" ");
}

// ───────────────────────── locating ─────────────────────────

/** Replace the checkbox character of a task line (same as `desk/ops.ts`; kept local to avoid an import cycle). */
function setCheckbox(line: string, ch: string): string {
	const m = TASK_LINE_RE.exec(line);
	return m ? m[1] + ch + m[3] : line;
}

interface Located {
	lines: string[];
	eol: string;
	idx: number;
	/** Index after the last indented line that belongs to the item. */
	end: number;
	body: string;
	prefix: string;
}

function locate(text: string, ref: DrawerRef): Located | { reason: string } {
	const sec = findSection(text, ref.section);
	if (!sec) return { reason: "section-missing" };
	const lines = splitLinesKeepEol(text);
	const range = sectionLineRange(text, sec);
	const idx = locateLine(lines, { index: ref.index, line: ref.line, scope: range });
	if (idx === -1) return { reason: "line-changed" };
	const s = stripEol(lines[idx]);
	const lm = LIST_LINE_RE.exec(s);
	if (!lm || lm[1]) return { reason: "line-changed" };
	let end = idx + 1;
	while (end < range.end) {
		const t = stripEol(lines[end]);
		if (!t.trim()) {
			// A blank line ends the item unless an indented line follows it.
			let k = end + 1;
			while (k < range.end && !stripEol(lines[k]).trim()) k++;
			if (k < range.end && /^\s+\S/.test(stripEol(lines[k]))) {
				end = k + 1;
				continue;
			}
			break;
		}
		if (!/^\s+\S/.test(t)) break;
		end++;
	}
	return { lines, eol: detectEol(text), idx, end, body: lm[3], prefix: `${lm[1]}${lm[2]} ` };
}

/** Index of the item's `- 맥락:` sub-line inside [idx+1, end), or -1. */
function contextIndex(l: Located): number {
	const re = new RegExp(`^\\s+[-*+]\\s+${CONTEXT_LABEL}\\s*[:：]`);
	for (let i = l.idx + 1; i < l.end; i++) if (re.test(stripEol(l.lines[i]))) return i;
	return -1;
}

function setLine(l: Located, i: number, line: string): void {
	const cur = stripEol(l.lines[i]);
	l.lines[i] = line + l.lines[i].slice(cur.length);
}

/** Remove lines [from, to) without leaving a dangling terminator at EOF. */
function cut(lines: string[], from: number, to: number): string[] {
	const removed = lines.splice(from, to - from);
	const lastHadEol = /\n$/.test(removed[removed.length - 1] ?? "\n");
	if (!lastHadEol && from > 0 && from === lines.length) lines[from - 1] = stripEol(lines[from - 1]);
	return removed.map(stripEol);
}

/** Append lines after the last non-blank line of `## section` (the heading is added when missing). */
export function appendToDrawerSection(text: string, section: DrawerSection, newLines: string[]): string {
	const eol = detectEol(text);
	let base = text;
	let sec = findSection(base, section);
	if (!sec) {
		// Add the heading in canonical order: before the next section that exists, else before 변경 기록, else at EOF.
		const lines = splitLinesKeepEol(base);
		const after = DRAWER_SECTIONS.slice(DRAWER_SECTIONS.indexOf(section) + 1);
		let at = -1;
		for (const name of [...after, CHANGELOG_SECTION]) {
			const s = findSection(base, name);
			if (s) {
				at = s.headingIndex;
				break;
			}
		}
		if (at === -1) {
			if (base.length && !base.endsWith("\n")) base += eol;
			base += `${eol}## ${section}${eol}`;
		} else {
			lines.splice(at, 0, `## ${section}${eol}`, eol);
			base = lines.join("");
		}
		sec = findSection(base, section)!;
	}
	const lines = splitLinesKeepEol(base);
	const range = sectionLineRange(base, sec);
	let at = sec.headingIndex;
	for (let i = range.end - 1; i >= range.start; i--) {
		if (stripEol(lines[i]).trim()) {
			at = i;
			break;
		}
	}
	const prevHasEol = /\n$/.test(lines[at]);
	if (!prevHasEol) lines[at] += eol;
	lines.splice(at + 1, 0, ...newLines.map((l) => l + eol));
	// Keep one blank line before the next heading when the section was empty and is followed by one.
	if (at === sec.headingIndex && sec.hasNext) {
		const next = at + 1 + newLines.length;
		if (next < lines.length && stripEol(lines[next]).trim()) lines.splice(next, 0, eol);
	}
	return lines.join("");
}

// ───────────────────────── 「4-1」 넣기 ─────────────────────────

export type PutResult = ({ ok: true; text: string } & ({ merged: false } | { merged: true; into: DrawerItem })) | { ok: false; reason: string };

/**
 * Add an item at the end of its section. When an active line with the same text exists, nothing is
 * added: its `from::` gains the new sources and `reviewed` becomes today (「4-1」 2). Either way one
 * 「변경 기록」 line (`넣음`) is appended and `updated` is set.
 */
export function putItem(text: string, input: NewDrawerItem, today: string): PutResult {
	if (!input.text.trim()) return fail("empty-text");
	const data = parseDrawer(text);
	const dup = findDuplicate(data, input.text);
	const sources = input.from.map((s) => cleanText(s)).filter(Boolean);
	if (dup) {
		const l = locate(text, refOf(dup));
		if ("reason" in l) return fail(l.reason);
		const have = dup.from.map((s) => s.replace(/\s+/g, ""));
		const add = sources.filter((s) => !have.includes(s.replace(/\s+/g, "")));
		let body = l.body;
		if (add.length) body = setField(body, "from", splitSources([...dup.from, ...add].join(", ")).join(", "));
		body = setField(body, "reviewed", today);
		setLine(l, l.idx, l.prefix + body);
		return { ok: true, text: finishWrite(l.lines.join(""), today, logEntry.put(dup.text, add)), merged: true, into: dup };
	}
	const newLines = [formatItemLine(input, today)];
	if (input.context?.trim()) newLines.push(formatContextLine(input.context));
	const out = appendToDrawerSection(text, input.section, newLines);
	return { ok: true, text: finishWrite(out, today, logEntry.put(cleanText(input.text), sources)), merged: false };
}

// ───────────────────────── 「4-2」 섹션 옮기기 ─────────────────────────

/** Move the item (with its sub-bullets) to the end of another section; `reviewed` → today; log `옮김`. */
export function moveItem(text: string, ref: DrawerRef, to: DrawerSection, today: string): EditResult {
	if (to === ref.section) return fail("same-section");
	const l = locate(text, ref);
	if ("reason" in l) return fail(l.reason);
	const itemText = parseDrawer(text).items.find((i) => i.index === l.idx)?.text ?? "";
	setLine(l, l.idx, l.prefix + setField(l.body, "reviewed", today));
	const block = cut(l.lines, l.idx, l.end);
	const out = appendToDrawerSection(l.lines.join(""), to, block);
	return { ok: true, text: finishWrite(out, today, logEntry.move(itemText, ref.section, to)) };
}

// ───────────────────────── 「4-3」 꺼내기 ─────────────────────────

/** `[>] … → [[destLink]]` (the line is not deleted); log `꺼냄`. */
export function markTakenOut(text: string, ref: DrawerRef, destLink: string, today: string): EditResult {
	const l = locate(text, ref);
	if ("reason" in l) return fail(l.reason);
	if (!/^\[ \]/.test(l.body)) return fail("not-active");
	const itemText = parseDrawer(text).items.find((i) => i.index === l.idx)?.text ?? "";
	const line = setCheckbox(l.prefix + insertBeforeMeta(l.body, `→ ${destLink}`), ">");
	setLine(l, l.idx, line);
	return { ok: true, text: finishWrite(l.lines.join(""), today, logEntry.take(itemText, destLink)) };
}

// ───────────────────────── 「4-4」 놓아주기 ─────────────────────────

/** `[-] … (why:: 이유)` (the line is not deleted); log `놓아줌`. */
export function markLetGo(text: string, ref: DrawerRef, why: string, today: string): EditResult {
	const w = cleanFieldValue(why);
	if (!w) return fail("empty-why");
	const l = locate(text, ref);
	if ("reason" in l) return fail(l.reason);
	if (!/^\[ \]/.test(l.body)) return fail("not-active");
	const itemText = parseDrawer(text).items.find((i) => i.index === l.idx)?.text ?? "";
	setLine(l, l.idx, setCheckbox(l.prefix + setField(l.body, "why", w), "-"));
	return { ok: true, text: finishWrite(l.lines.join(""), today, logEntry.letGo(itemText, w)) };
}

// ───────────────────────── 「4-5」 수정 · 삭제 ─────────────────────────

export interface DrawerChange {
	text?: string;
	when?: string;
	/** "" removes the 맥락 line. `undefined` = keep. */
	context?: string;
	section?: DrawerSection;
}

/**
 * 수정: text · `when::` · 맥락 · section. `reviewed` → today. Every other part (status, from, added,
 * tags) stays as written. The registry gets a line only when the section changes (「4-5」).
 */
export function editItem(text: string, ref: DrawerRef, c: DrawerChange, today: string): EditResult {
	const l = locate(text, ref);
	if ("reason" in l) return fail(l.reason);
	if (c.text !== undefined && !c.text.trim()) return fail("empty-text");
	const before = parseDrawer(text).items.find((i) => i.index === l.idx);
	let body = l.body;
	if (c.text !== undefined) body = replaceContent(body, c.text);
	if (c.when !== undefined) body = setField(body, "when", cleanFieldValue(c.when) || WHEN_UNDECIDED);
	body = setField(body, "reviewed", today);
	setLine(l, l.idx, l.prefix + body);
	if (c.context !== undefined) {
		const ci = contextIndex(l);
		const v = cleanText(c.context);
		if (ci !== -1 && v) setLine(l, ci, formatContextLine(v));
		else if (ci !== -1) {
			cut(l.lines, ci, ci + 1);
			l.end--;
		} else if (v) {
			if (!/\n$/.test(l.lines[l.idx])) l.lines[l.idx] += l.eol;
			l.lines.splice(l.idx + 1, 0, formatContextLine(v) + l.eol);
			l.end++;
		}
	}
	const newText = c.text !== undefined ? cleanText(c.text) : (before?.text ?? "");
	if (c.section && c.section !== ref.section) {
		const block = cut(l.lines, l.idx, l.end);
		const out = appendToDrawerSection(l.lines.join(""), c.section, block);
		return { ok: true, text: finishWrite(out, today, logEntry.move(newText, ref.section, c.section)) };
	}
	return { ok: true, text: finishWrite(l.lines.join(""), today, null) };
}

/** 삭제 (실수·중복·테스트 데이터): remove the line and its sub-bullets; log `삭제`. */
export function deleteItem(text: string, ref: DrawerRef, today: string): EditResult {
	const l = locate(text, ref);
	if ("reason" in l) return fail(l.reason);
	const itemText = parseDrawer(text).items.find((i) => i.index === l.idx)?.text ?? "";
	cut(l.lines, l.idx, l.end);
	return { ok: true, text: finishWrite(l.lines.join(""), today, logEntry.remove(itemText)) };
}

/** 「두기」 (monthly review) / a plain touch: `reviewed` → today, no registry line. */
export function touchReviewed(text: string, ref: DrawerRef, today: string): EditResult {
	const l = locate(text, ref);
	if ("reason" in l) return fail(l.reason);
	setLine(l, l.idx, l.prefix + setField(l.body, "reviewed", today));
	return { ok: true, text: setFrontmatterScalar(l.lines.join(""), "updated", today) };
}
