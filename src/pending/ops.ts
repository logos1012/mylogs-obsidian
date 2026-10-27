/**
 * Daily Pad 「결정 대기」 — 못 한 일 다섯 가지 (04 Daily Pad AGENTS 「3-6」「3-7」). Pure text edits; the
 * IO and dialogs are in `./actions.ts`.
 *
 * A 결정 대기 line is the copy Tear-off made of an unfinished task; its `(from:: Daily Pad YYYY-MM-DD)`
 * names the day it came from. Choosing a destination:
 *   1. removes the line from `## 결정 대기` (the heading goes too when empty),
 *   2. writes the destination (Desk Calendar day / Wall Calendar month / Drawer / smaller tasks),
 *   3. marks the original open line of that day — Desk Calendar day cell and Daily Pad
 *      `## 오늘 할 일` — `[>] … → 보낸 곳` or `[-] … (why:: …)`, when it is still there,
 *   4. drops the row from `Daily Pad Index.md` 「결정 대기」 and logs the change.
 */

import { removeCandidate } from "../drawer/candidates.ts";
import { cleanFieldValue, copyTask, markCancelled, markMoved, movedCount } from "../desk/ops.ts";
import { findDaySection, parseItem, splitLinesKeepEol, stripEol, TASK_LINE_RE } from "../parser.ts";
import { appendToSection, findSection, sectionLineRange } from "../writer.ts";

export type PendingChoice =
	| { kind: "day"; date: string }
	| { kind: "future"; month: string }
	| { kind: "drawer"; when: string }
	| { kind: "split"; parts: string[] }
	| { kind: "letgo"; why: string };

export type TextResult = { ok: true; text: string } | { ok: false; reason: string };

/** `(from:: Daily Pad 2026-10-26)` / `(from:: Desk Calendar 2026-10-26)` → `2026-10-26`. */
export function sourceDateOf(line: string): string | null {
	const m = /\(from::\s*(?:Daily Pad|Desk Calendar)\s+(\d{4}-\d{2}-\d{2})\s*\)/.exec(line);
	return m ? m[1] : null;
}

/** The task text a person reads (no checkbox, fields, tags), for matching copies of one task. */
export function taskKey(line: string): string {
	const body = stripEol(line).replace(/^\s*[-*+]\s+/, "");
	return parseItem(body).text.replace(/\s+/g, " ").trim();
}

function mmdd(iso: string): string {
	return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/** Where the destination was, as written after `→` on the original line. */
export function arrowTarget(c: PendingChoice): string | null {
	switch (c.kind) {
		case "day":
			return mmdd(c.date);
		case "future":
			return "Wall Calendar";
		case "drawer":
			return "Drawer";
		case "split":
			return "쪼갬";
		case "letgo":
			return null;
	}
}

/** Does this choice postpone (and count in `moved::`)? */
export function postpones(c: PendingChoice): boolean {
	return c.kind === "day" || c.kind === "future";
}

/** The original line, marked for the choice. */
export function markForChoice(line: string, c: PendingChoice): string {
	if (c.kind === "letgo") return markCancelled(line, c.why);
	const n = postpones(c) ? movedCount(line) + 1 : undefined;
	return markMoved(line, arrowTarget(c)!, n);
}

/** The copy that goes to a Desk Calendar day / Wall Calendar month (moved count + 1). */
export function forwardCopy(line: string): string {
	return copyTask(stripEol(line), movedCount(line) + 1);
}

/**
 * Mark every open task line (`[ ]`) with the same text inside `[start, end)` lines. Returns the new
 * text and how many lines changed (0 = not there any more; that is fine).
 */
export function markOpenInRange(text: string, range: { start: number; end: number }, key: string, fn: (line: string) => string): { text: string; count: number } {
	const lines = splitLinesKeepEol(text);
	let count = 0;
	for (let i = range.start; i < range.end && i < lines.length; i++) {
		const raw = stripEol(lines[i]);
		const m = TASK_LINE_RE.exec(raw);
		if (!m || m[2] !== " " || taskKey(raw) !== key) continue;
		const eol = lines[i].slice(raw.length);
		lines[i] = fn(raw) + eol;
		count++;
	}
	return { text: lines.join(""), count };
}

/** Mark the original in a Desk Calendar month file's day cell. */
export function markInDeskDay(text: string, date: string, key: string, fn: (line: string) => string): { text: string; count: number } {
	const sec = findDaySection(text, date);
	if (!sec.found) return { text, count: 0 };
	return markOpenInRange(text, { start: sec.start, end: sec.end }, key, fn);
}

/** Mark the original in a Daily Pad section (`## 오늘 할 일`). */
export function markInPadSection(text: string, section: string, key: string, fn: (line: string) => string): { text: string; count: number } {
	const r = findSection(text, section);
	if (!r) return { text, count: 0 };
	return markOpenInRange(text, sectionLineRange(text, r), key, fn);
}

/** Take the line out of `## 결정 대기` (heading removed when empty) and set `updated`. */
export function removePendingLine(padText: string, ref: { index: number; line: string }, today: string, section: string): TextResult {
	const r = removeCandidate(padText, ref, today, section);
	return r.ok ? { ok: true, text: r.text } : r;
}

/** 쪼개기: the smaller next actions as `- [ ]` lines at the end of `## 오늘 할 일`. */
export function appendSplitParts(padText: string, section: string, parts: string[]): string {
	let out = padText;
	for (const p of parts) {
		const t = p.trim().replace(/^[-*+]\s+(\[.\]\s+)?/, "");
		if (t) out = appendToSection(out, section, `- [ ] ${t}`);
	}
	return out;
}

/** Drop the row(s) of this task from `Daily Pad Index.md` 「결정 대기」 (first cell = the task text). */
export function dropIndexRow(indexText: string, key: string, section = "결정 대기"): string {
	const r = findSection(indexText, section);
	if (!r) return indexText;
	const range = sectionLineRange(indexText, r);
	const lines = splitLinesKeepEol(indexText);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i >= range.start && i < range.end) {
			const raw = stripEol(lines[i]);
			const cells = raw.split("|").map((c) => c.trim());
			if (raw.trim().startsWith("|") && cells[1] && cells[1].replace(/\s+/g, " ") === key) continue;
		}
		out.push(lines[i]);
	}
	return out.join("");
}

/** One-line description of what happened, for the index change log. */
export function describeChoice(text: string, c: PendingChoice, moved: number): string {
	switch (c.kind) {
		case "day":
			return `결정 대기 「${text}」 → ${mmdd(c.date)} Desk Calendar (moved:: ${moved + 1})`;
		case "future":
			return `결정 대기 「${text}」 미래로 → Wall Calendar ${c.month} (moved:: ${moved + 1})`;
		case "drawer":
			return `결정 대기 「${text}」 서랍으로 (when:: ${cleanFieldValue(c.when) || "미정"})`;
		case "split":
			return `결정 대기 「${text}」 쪼갬 → ${c.parts.length}개`;
		case "letgo":
			return `결정 대기 「${text}」 놓아줌 (why:: ${cleanFieldValue(c.why)})`;
	}
}

