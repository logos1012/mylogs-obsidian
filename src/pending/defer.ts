/**
 * Daily Pad 할 일 넘기기: an open task in 「개인 할 일」 / 「회사 할 일」 that won't be done today goes
 * back to the Desk Calendar — the month's 인박스 (`## 이달 중`) or another day (`### YYYY-MM-DD`).
 *
 * Same rules as 결정 대기 「다른 날」 (`./ops.ts`, 04 Daily Pad AGENTS 「3-6」「3-7」):
 *   - the Pad line stays, marked `[>] … → 보낸 곳 (moved:: n+1)` (Tear-off and 결정 대기 only pick
 *     up open `[ ]` lines, so it is not carried over twice),
 *   - the Desk copy is `forwardCopy` (same text, tags, fields, `moved:: n+1`, no `→`); a 회사 할 일
 *     gets `#회사` there, because the Desk tells the sides apart by the tag,
 *   - no new `(from:: …)`: `sourceDateOf` would later read it as the day a 결정 대기 line came from.
 *
 * Pure text edits (no Obsidian imports); the IO and dialogs are in `./actions.ts`.
 */

import { isFlywheelLine } from "../flywheel/model.ts";
import { parseItem, splitLinesKeepEol, stripEol, TASK_LINE_RE } from "../parser.ts";
import { withWorkTag } from "../side.ts";
import { detectEol, findSection, locateLine, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { appendLines, markCancelled, markMoved, movedCount, sectionItems, touchUpdated } from "../desk/ops.ts";
import { normKey } from "../desk/model.ts";
import { forwardCopy, type TextResult } from "./ops.ts";

export type DeferTarget = { kind: "inbox"; month: string } | { kind: "day"; date: string };

/** A rendered Pad task line: its line offset inside the section content, and the line itself. */
export interface PadLineRef {
	offset: number;
	line: string;
}

const fail = (reason: string): TextResult => ({ ok: false, reason });

/** `→` target written on the Pad line: `11/07` for a day, `11월 인박스` for a month's 인박스. */
export function deferArrow(t: DeferTarget): string {
	if (t.kind === "day") return `${t.date.slice(5, 7)}/${t.date.slice(8, 10)}`;
	return `${+t.month.slice(5, 7)}월 인박스`;
}

/** Where the Desk copy goes, as a person says it (notices, change log). */
export function deferLabel(t: DeferTarget): string {
	if (t.kind === "day") return `${+t.date.slice(5, 7)}월 ${+t.date.slice(8, 10)}일`;
	return `${+t.month.slice(5, 7)}월 인박스`;
}

/** The month file a target lives in. */
export function deferMonth(t: DeferTarget): string {
	return t.kind === "day" ? t.date.slice(0, 7) : t.month;
}

/** Can this Pad line be passed on? Open (`[ ]`), top level, not a Flywheel line. */
export function canDefer(line: string): boolean {
	const m = TASK_LINE_RE.exec(stripEol(line));
	return !!m && m[2] === " " && !/^\s/.test(line) && !isFlywheelLine(line);
}

/**
 * The file line index of a rendered section line (`offset` counts from the first non-blank line
 * of the section, as `getSectionContent` shows it), or -1 when it is gone or different.
 * The same rule as the checkbox toggle of the Daily Pad view.
 */
export function locatePadLine(text: string, section: string, ref: PadLineRef): number {
	const r = findSection(text, section);
	if (!r) return -1;
	const range = sectionLineRange(text, r);
	const lines = splitLinesKeepEol(text);
	let first = range.start;
	while (first < range.end && !stripEol(lines[first]).trim()) first++;
	return locateLine(lines, { index: first + ref.offset, line: ref.line, scope: range });
}

/** Rewrite one verified open task line of a Pad section (+ `updated`); extra lines go right below it. */
function editPadLine(text: string, section: string, ref: PadLineRef, today: string, fn: (line: string) => string, below: string[] = []): TextResult {
	const idx = locatePadLine(text, section, ref);
	if (idx === -1) return fail("line-changed");
	const lines = splitLinesKeepEol(text);
	const cur = stripEol(lines[idx]);
	if (!canDefer(cur)) return fail("not-open");
	let eol = lines[idx].slice(cur.length);
	lines[idx] = fn(cur) + eol;
	if (below.length) {
		if (!eol) {
			eol = detectEol(text);
			lines[idx] += eol;
			lines.splice(idx + 1, 0, ...below.map((l, k) => (k === below.length - 1 ? l : l + eol)));
		} else lines.splice(idx + 1, 0, ...below.map((l) => l + eol));
	}
	return { ok: true, text: setFrontmatterScalar(lines.join(""), "updated", today) };
}

/** The Pad line becomes `[>] … → 보낸 곳 (moved:: n+1)`. */
export function markPadDeferred(text: string, section: string, ref: PadLineRef, target: DeferTarget, today: string): TextResult {
	return editPadLine(text, section, ref, today, (l) => markMoved(l, deferArrow(target), movedCount(l) + 1));
}

/** Third postpone answered 「놓아주기」: `[-] … (why:: …)` in place. */
export function letGoPadLine(text: string, section: string, ref: PadLineRef, why: string, today: string): TextResult {
	return editPadLine(text, section, ref, today, (l) => markCancelled(l, why));
}

/** Third postpone answered 「쪼개기」: `[>] … → 쪼갬` and the smaller tasks right below it. */
export function splitPadLine(text: string, section: string, ref: PadLineRef, parts: string[], today: string): TextResult {
	const below = parts.map((p) => p.trim().replace(/^[-*+]\s+(\[.\]\s+)?/, "").trim()).filter(Boolean).map((p) => `- [ ] ${p}`);
	if (!below.length) return fail("empty-parts");
	return editPadLine(text, section, ref, today, (l) => markMoved(l, "쪼갬"), below);
}

/** The Desk copy of a Pad line (`work` = it was in 회사 할 일). */
export function deferCopy(line: string, work: boolean): string {
	const copy = forwardCopy(line);
	return work ? withWorkTag(copy) : copy;
}

/**
 * Put the copy at the end of the target section of a Desk month file (+ `updated`). Fails with
 * `section-missing` (no 인박스 / no such day cell) or `duplicate` (an open task with the same text
 * is already there: passing it on twice would make two).
 */
export function putDeskCopy(deskText: string, target: DeferTarget, copy: string, today: string): TextResult {
	const ym = deferMonth(target);
	const y = +ym.slice(0, 4);
	const m = +ym.slice(5, 7);
	const where = target.kind === "inbox" ? ({ kind: "during" } as const) : ({ kind: "day", date: target.date } as const);
	const key = normKey(parseItem(copy.replace(/^\s*[-*+]\s+/, "")).text);
	if (sectionItems(deskText, y, m, where).some((x) => x.key === key && x.item.kind === "task" && x.item.status === "scheduled")) return fail("duplicate");
	const r = appendLines(deskText, y, m, where, [copy]);
	if (!r.ok) return r;
	return touchUpdated(r.text, today);
}

/** One line for the Daily Pad Index change log. */
export function describeDefer(text: string, section: string, target: DeferTarget, moved: number): string {
	return `${section} 「${text}」 → Desk Calendar ${deferLabel(target)} (moved:: ${moved + 1})`;
}
