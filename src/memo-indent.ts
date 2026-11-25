/**
 * Daily Pad 메모 들여쓰기 (Tab / Shift+Tab, 모바일 버튼).
 *
 * Pure text helper — no `obsidian` import, so `node --test` can load it. Memos are ordinary markdown
 * list lines; a nested memo is just the same bullet with two more leading spaces (vault convention,
 * e.g. `  - BHD(오전): …`). Only the leading whitespace of the list lines touched by the selection
 * changes; every other byte of the section stays as it was.
 */
import { LIST_LINE_RE } from "./parser.ts";

/** One nesting level in a memo: two spaces (what the existing Daily Pads use). */
export const MEMO_INDENT = "  ";

export type MemoIndentDirection = "in" | "out";

export interface MemoIndentResult {
	text: string;
	start: number;
	end: number;
}

/** Column width of a line's leading whitespace; a tab counts as 4 like `parser.ts`. */
function indentWidth(ws: string): number {
	return ws.replace(/\t/g, "    ").length;
}

function listIndent(line: string): string | null {
	const m = LIST_LINE_RE.exec(line);
	return m ? m[1] : null;
}

/**
 * Indent (`"in"`) or outdent (`"out"`) the list lines touched by `[selectionStart, selectionEnd]` by one
 * level. Returns `null` when nothing would change (the caller still swallows the Tab key).
 *
 * - Indent moves the selected list lines as one block, and only if the first of them stays at most one
 *   level deeper than the nearest list line above it (blank / non-list lines are skipped). Relative depth
 *   inside the block is kept. Two spaces are always prepended; a tab is never inserted.
 * - Outdent removes one level from each selected list line that has any: one leading tab if the line
 *   starts with a tab, otherwise up to two leading spaces.
 * - Non-list lines (free text, quotes, blanks) are never touched.
 */
export function adjustMemoIndent(
	text: string,
	selectionStart: number,
	selectionEnd: number,
	direction: MemoIndentDirection,
): MemoIndentResult | null {
	const lines = text.split("\n");
	const offsets: number[] = [];
	let acc = 0;
	for (const l of lines) {
		offsets.push(acc);
		acc += l.length + 1;
	}
	const a = Math.max(0, Math.min(selectionStart, selectionEnd, text.length));
	const b = Math.max(0, Math.min(Math.max(selectionStart, selectionEnd), text.length));
	const lineAt = (pos: number): number => {
		let i = 0;
		while (i + 1 < lines.length && offsets[i + 1] <= pos) i++;
		return i;
	};
	const first = lineAt(a);
	let last = lineAt(b);
	// A selection that ends at the very start of a line does not include that line (editor convention).
	if (b > a && last > first && offsets[last] === b) last--;

	const selected: number[] = [];
	for (let i = first; i <= last; i++) if (listIndent(lines[i]) !== null) selected.push(i);
	if (!selected.length) return null;

	/** [line index, chars removed at line start (0 for insert), chars inserted] */
	const edits: Array<{ line: number; remove: number; insert: string }> = [];
	if (direction === "in") {
		const head = selected[0];
		let prev: string | null = null;
		for (let i = head - 1; i >= 0; i--) {
			const ws = listIndent(lines[i]);
			if (ws !== null) {
				prev = ws;
				break;
			}
		}
		if (prev === null) return null; // the first item has nothing to nest under
		if (indentWidth(listIndent(lines[head])!) > indentWidth(prev)) return null; // already one level deeper
		for (const i of selected) edits.push({ line: i, remove: 0, insert: MEMO_INDENT });
	} else {
		for (const i of selected) {
			const ws = listIndent(lines[i])!;
			if (!ws) continue;
			let remove = 0;
			if (ws[0] === "\t") remove = 1;
			else while (remove < MEMO_INDENT.length && ws[remove] === " ") remove++;
			if (remove) edits.push({ line: i, remove, insert: "" });
		}
		if (!edits.length) return null;
	}

	const out = lines.slice();
	for (const e of edits) out[e.line] = e.insert + out[e.line].slice(e.remove);
	const map = (pos: number): number => {
		let shift = 0;
		for (const e of edits) {
			const at = offsets[e.line];
			if (pos < at) break;
			if (e.insert) shift += e.insert.length;
			else shift -= Math.min(e.remove, pos - at);
		}
		return pos + shift;
	};
	return { text: out.join("\n"), start: map(selectionStart), end: map(selectionEnd) };
}
