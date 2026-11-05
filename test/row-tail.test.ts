import { test } from "node:test";
import assert from "node:assert/strict";
import { rowAnchor, type RowNode } from "../src/ui/row-tail.ts";

const el = (tagName: string, ...children: RowNode[]): RowNode => ({ tagName, children });

test("row-tail: tight item without children → end of the li", () => {
	const li = el("LI", el("INPUT"), el("SPAN"));
	assert.deepEqual(rowAnchor(li), { parent: li, before: null });
});

test("row-tail: tight item with a nested list → before the nested list", () => {
	const ul = el("UL", el("LI"));
	const li = el("LI", el("DIV"), el("INPUT"), el("A"), ul);
	const a = rowAnchor(li);
	assert.equal(a.parent, li);
	assert.equal(a.before, ul);
	const ol = el("OL", el("LI"));
	assert.equal(rowAnchor(el("LI", el("INPUT"), ol)).before, ol);
});

test("row-tail: loose item (<p> inside li) → inside the first paragraph", () => {
	const p = el("P", el("INPUT"));
	const li = el("LI", p, el("P"), el("UL", el("LI")));
	assert.deepEqual(rowAnchor(li), { parent: p, before: null });
	// Collapse arrow / checkbox before the paragraph don't change that.
	const p2 = el("P");
	assert.deepEqual(rowAnchor(el("LI", el("DIV"), el("INPUT"), p2)), { parent: p2, before: null });
});

test("row-tail: tag case does not matter", () => {
	const ul = el("ul");
	assert.equal(rowAnchor(el("li", el("input"), ul)).before, ul);
});
