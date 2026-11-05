/**
 * Small icon buttons (넘기기, 바퀴 잇기) that belong on a rendered list item's own text row.
 *
 * `MarkdownRenderer` gives two shapes of `<li>`:
 * - tight list: `<li><input>글<ul>하위</ul></li>` — the row is the li's own inline content,
 *   so the button must go before the nested list, not after it;
 * - loose list (blank line between items, or a multi-paragraph item):
 *   `<li><p><input>글</p><ul>하위</ul></li>` — the row is the first `<p>`; anything appended to
 *   the li lands below that block, on a line of its own.
 */

/** The bit of an Element this module reads (kept minimal so it is testable without a DOM). */
export interface RowNode {
	tagName: string;
	children: ArrayLike<RowNode>;
}

/** Block-level children that end the item's first text row. */
const BLOCKS = new Set(["UL", "OL", "P", "BLOCKQUOTE", "PRE", "TABLE", "HR", "H1", "H2", "H3", "H4", "H5", "H6"]);

/** Where an inline tail goes for this li: append to `parent` before `before` (null = at the end). */
export function rowAnchor<T extends RowNode>(li: T): { parent: T; before: T | null } {
	const kids = Array.from(li.children) as T[];
	const first = kids.find((k) => BLOCKS.has(k.tagName.toUpperCase()));
	if (!first) return { parent: li, before: null };
	// Loose item: its first row lives in the leading <p> — append inside it.
	if (first.tagName.toUpperCase() === "P") return { parent: first, before: null };
	return { parent: li, before: first };
}

/**
 * Put `el` at the end of the li's first text row, glued to the last word with a word joiner
 * inside a `nowrap` span, so a long line wraps but the button never drops to a line alone.
 */
export function attachToRow(li: HTMLElement, el: HTMLElement): HTMLElement {
	const { parent, before } = rowAnchor<HTMLElement>(li as HTMLElement & RowNode);
	// Re-use one tail per row so several buttons sit together.
	let tail = Array.from(parent.children).find((c) => c.classList.contains("ml-row-tail")) as HTMLElement | undefined;
	if (!tail) {
		tail = document.createElement("span");
		tail.className = "ml-row-tail";
		tail.append("⁠");
		parent.insertBefore(tail, before);
	}
	tail.appendChild(el);
	return tail;
}
