/**
 * Pure text transforms used to write back into vault files.
 *
 * Every function takes the full current file text and returns the new text. They change
 * only the bytes they are about (one checkbox character, one section body, one frontmatter
 * line) and leave everything else byte-for-byte identical. The view wraps them in
 * `app.vault.process` so the read-modify-write is atomic.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { frontmatterEnd, HEADING_RE, splitLinesKeepEol, stripEol, TASK_LINE_RE } from "./parser.ts";

// ───────────────────────── checkbox toggle ─────────────────────────

export interface ToggleTarget {
	/** 0-based line index where the line was when it was rendered. */
	index: number;
	/** The full line (without terminator) as it was when rendered. */
	line: string;
	/** Optional [start, end) line range to search in if the line moved (e.g. the day section). */
	scope?: { start: number; end: number };
}

export type ToggleResult =
	| { ok: true; text: string; index: number; from: string; to: string }
	| { ok: false; reason: "not-found" | "not-toggleable" };

/** `[ ]` → `[x]`, `[x]`/`[X]` → `[ ]`. Other states are not toggled in v0.1. */
export function toggledChar(c: string): string | null {
	if (c === " ") return "x";
	if (c === "x" || c === "X") return " ";
	return null;
}

/**
 * Locate a rendered line in the current text. First the original index; if the line shifted,
 * the closest line with exactly the same content (inside `scope` when given, else anywhere).
 */
export function locateLine(lines: string[], target: ToggleTarget): number {
	const inScope = (i: number) => !target.scope || (i >= target.scope.start && i < target.scope.end);
	if (target.index >= 0 && target.index < lines.length && inScope(target.index) && stripEol(lines[target.index]) === target.line) {
		return target.index;
	}
	const search = (start: number, end: number): number => {
		let best = -1;
		for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) {
			if (stripEol(lines[i]) === target.line) {
				if (best === -1 || Math.abs(i - target.index) < Math.abs(best - target.index)) best = i;
			}
		}
		return best;
	};
	// With a scope we never guess outside it: identical lines exist on other days.
	return target.scope ? search(target.scope.start, target.scope.end) : search(0, lines.length);
}

/** Toggle `[ ]` ↔ `[x]` on one line, changing exactly one character. */
export function toggleCheckbox(text: string, target: ToggleTarget): ToggleResult {
	const lines = splitLinesKeepEol(text);
	const idx = locateLine(lines, target);
	if (idx === -1) return { ok: false, reason: "not-found" };
	const m = TASK_LINE_RE.exec(stripEol(lines[idx]));
	if (!m) return { ok: false, reason: "not-found" };
	const next = toggledChar(m[2]);
	if (next === null) return { ok: false, reason: "not-toggleable" };
	const pos = m[1].length;
	lines[idx] = lines[idx].slice(0, pos) + next + lines[idx].slice(pos + 1);
	return { ok: true, text: lines.join(""), index: idx, from: m[2], to: next };
}

// ───────────────────────── sections (## heading) ─────────────────────────

export interface SectionRange {
	name: string;
	/** 0-based index of the `## name` line. */
	headingIndex: number;
	/** Character offset where the body starts (right after the heading line terminator). */
	bodyStart: number;
	/** Character offset where the body ends (start of the next `#`/`##` heading, or EOF). */
	bodyEnd: number;
	/** True when another `#`/`##` heading follows this section. */
	hasNext: boolean;
}

/** Parts of a section body: leading blank lines, content, trailing whitespace. */
export interface BodyParts {
	lead: string;
	core: string;
	tail: string;
}

function isFenceToggle(s: string): boolean {
	return /^\s*(```|~~~)/.test(s);
}

/** All level-1/2 headings outside code fences and frontmatter, with offsets. */
function scanTopHeadings(text: string): { index: number; level: number; name: string; start: number; end: number }[] {
	const lines = splitLinesKeepEol(text);
	const fmEnd = frontmatterEnd(lines);
	const out: { index: number; level: number; name: string; start: number; end: number }[] = [];
	let offset = 0;
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const s = stripEol(raw);
		if (i >= fmEnd) {
			if (isFenceToggle(s)) inFence = !inFence;
			else if (!inFence) {
				const m = HEADING_RE.exec(s);
				if (m && m[1].length <= 2) out.push({ index: i, level: m[1].length, name: m[2].trim(), start: offset, end: offset + raw.length });
			}
		}
		offset += raw.length;
	}
	return out;
}

/** Find a `## name` section. The body ends at the next `#` or `##` heading (or EOF). */
export function findSection(text: string, name: string): SectionRange | null {
	const heads = scanTopHeadings(text);
	const k = heads.findIndex((h) => h.level === 2 && h.name === name.trim());
	if (k === -1) return null;
	const h = heads[k];
	const next = heads[k + 1];
	return {
		name: h.name,
		headingIndex: h.index,
		bodyStart: h.end,
		bodyEnd: next ? next.start : text.length,
		hasNext: !!next,
	};
}

/** Convert a section's character range to a [start, end) line range for the body. */
export function sectionLineRange(text: string, r: SectionRange): { start: number; end: number } {
	const count = (s: string) => (s.match(/\n/g) ?? []).length;
	const start = count(text.slice(0, r.bodyStart));
	const end = r.hasNext ? count(text.slice(0, r.bodyEnd)) : splitLinesKeepEol(text).length;
	return { start, end };
}

/** Names of all `##` sections, in file order. */
export function listSections(text: string): string[] {
	return scanTopHeadings(text)
		.filter((h) => h.level === 2)
		.map((h) => h.name);
}

/**
 * Split a section body into `lead` (whole blank lines before the content), `core` (from the
 * first non-blank line to the last non-whitespace character) and `tail` (everything after,
 * i.e. the last line terminator plus blank lines before the next heading).
 * `lead + core + tail === body` always holds.
 */
export function splitBody(body: string): BodyParts {
	const tailM = /\s*$/.exec(body);
	const tailStart = tailM ? tailM.index : body.length;
	const coreAndLead = body.slice(0, tailStart);
	if (!coreAndLead) return { lead: "", core: "", tail: body };
	const lead = /^(?:[ \t]*\r?\n)*/.exec(coreAndLead)?.[0] ?? "";
	return { lead, core: coreAndLead.slice(lead.length), tail: body.slice(tailStart) };
}

/** Detect the file's line ending. */
export function detectEol(text: string): string {
	return /\r\n/.test(text) ? "\r\n" : "\n";
}

/** The editable content of a section (no leading/trailing blank lines), with `\n` line endings. */
export function getSectionContent(text: string, name: string): string | null {
	const r = findSection(text, name);
	if (!r) return null;
	return splitBody(text.slice(r.bodyStart, r.bodyEnd)).core.replace(/\r\n/g, "\n");
}

/**
 * Replace the content of `## name` with `content`, preserving everything outside the section
 * byte-for-byte, and the section's own leading/trailing blank lines. If the section doesn't
 * exist, it is appended at the end of the file.
 */
export function replaceSectionContent(text: string, name: string, content: string): string {
	const eol = detectEol(text);
	const newCore = content.replace(/\r\n/g, "\n").replace(/\s+$/, "").replace(/^(?:[ \t]*\n)+/, "").split("\n").join(eol);
	const r = findSection(text, name);
	if (!r) {
		if (!newCore) return text;
		let base = text;
		if (base.length && !base.endsWith("\n")) base += eol;
		return base + eol + `## ${name}` + eol + newCore + eol;
	}
	// A heading on the last line without a terminator: give it one before adding a body.
	let head = text.slice(0, r.bodyStart);
	if (!/\n$/.test(head) && newCore) head += eol;
	const body = text.slice(r.bodyStart, r.bodyEnd);
	const parts = splitBody(body);
	if (newCore === parts.core) return text;
	let newBody: string;
	if (!newCore) {
		newBody = r.hasNext ? eol : "";
	} else if (!parts.core) {
		newBody = newCore + eol + (r.hasNext ? eol : "");
	} else {
		let tail = parts.tail;
		if (!/\n/.test(tail)) tail = eol + (r.hasNext ? eol : "");
		newBody = parts.lead + newCore + tail;
	}
	return head + newBody + text.slice(r.bodyEnd);
}

/** Append one line at the end of a section's content. */
export function appendToSection(text: string, name: string, line: string): string {
	const current = getSectionContent(text, name) ?? "";
	return replaceSectionContent(text, name, current ? current + "\n" + line : line);
}

// ───────────────────────── frontmatter ─────────────────────────

/**
 * Set a simple scalar `key: value` in the YAML frontmatter with a line edit (no reformatting).
 * If the key is absent, it is inserted before the closing `---`. No-op when there is no
 * frontmatter or the value is already equal.
 */
export function setFrontmatterScalar(text: string, key: string, value: string): string {
	const lines = splitLinesKeepEol(text);
	const end = frontmatterEnd(lines);
	if (end === 0) return text;
	const eol = detectEol(text);
	const re = new RegExp(`^(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:)(\\s*)(.*?)(\\s*)$`);
	for (let i = 1; i < end - 1; i++) {
		const s = stripEol(lines[i]);
		const m = re.exec(s);
		if (m) {
			const cur = m[3].replace(/^["']|["']$/g, "");
			if (cur === value) return text;
			const term = lines[i].slice(s.length);
			lines[i] = `${m[1]} ${value}${term}`;
			return lines.join("");
		}
	}
	lines.splice(end - 1, 0, `${key}: ${value}${eol}`);
	return lines.join("");
}

// ───────────────────────── Daily Pad skeleton ─────────────────────────

export interface SkeletonOptions {
	isoDate: string;
	/** Weekday label for the H1, e.g. "토" (display only). Omit to leave it out. */
	weekday?: string;
	deskCalendarFolder: string;
	sections: string[];
}

/**
 * Exactly the same skeleton as `04 Daily Pad/_build/new_day.py`'s `render()`
 * (with the folder name and weekday label as parameters).
 */
export function dailyPadSkeleton(o: SkeletonOptions): string {
	const [y, m] = o.isoDate.split("-");
	const ym = `${y}-${m}`;
	const desk = o.deskCalendarFolder.replace(/\/+$/, "");
	const head =
		"---\n" +
		"type: daily-pad\n" +
		`date: ${o.isoDate}\n` +
		`desk_calendar: "${desk}/${y}/${ym}.md"\n` +
		"torn_off: false\n" +
		`updated: ${o.isoDate}\n` +
		"---\n\n" +
		`# ${o.isoDate}${o.weekday ? ` (${o.weekday})` : ""}\n\n` +
		`![[${desk}/${y}/${ym}#${o.isoDate}]]\n`;
	return head + o.sections.map((s) => `\n## ${s}\n`).join("");
}
