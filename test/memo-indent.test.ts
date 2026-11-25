import { test } from "node:test";
import assert from "node:assert/strict";
import { adjustMemoIndent, MEMO_INDENT } from "../src/memo-indent.ts";
import { LIST_LINE_RE } from "../src/parser.ts";
import { getSectionContent, replaceSectionContent } from "../src/writer.ts";

/** `|` marks the caret, `[` `]` mark a selection. Returns text + offsets. */
function at(src: string): { text: string; start: number; end: number } {
	if (src.includes("|")) {
		const i = src.indexOf("|");
		return { text: src.replace("|", ""), start: i, end: i };
	}
	const s = src.indexOf("[");
	const e = src.indexOf("]") - 1;
	return { text: src.replace("[", "").replace("]", ""), start: s, end: e };
}
function show(r: { text: string; start: number; end: number } | null): string | null {
	if (!r) return null;
	if (r.start === r.end) return r.text.slice(0, r.start) + "|" + r.text.slice(r.start);
	return r.text.slice(0, r.start) + "[" + r.text.slice(r.start, r.end) + "]" + r.text.slice(r.end);
}
const run = (src: string, dir: "in" | "out") => {
	const { text, start, end } = at(src);
	return show(adjustMemoIndent(text, start, end, dir));
};

test("memo indent: unit is two spaces", () => {
	assert.equal(MEMO_INDENT, "  ");
});

test("memo indent: Tab under a previous item nests it two spaces; caret follows the text", () => {
	assert.equal(run("- A\n- B|", "in"), "- A\n  - B|");
	assert.equal(run("- A\n- 점|심", "in"), "- A\n  - 점|심");
	assert.equal(run("- A\n|- B", "in"), "- A\n  |- B");
});

test("memo indent: first item does not indent", () => {
	assert.equal(run("- A|\n- B", "in"), null);
	assert.equal(run("자유 메모\n- A|", "in"), null); // only non-list text above
});

test("memo indent: an item already one level deeper than the one above stays", () => {
	assert.equal(run("- A\n  - B|", "in"), null);
	// …but one step at a time it can go deeper under a nested item.
	assert.equal(run("- A\n  - B\n  - C|", "in"), "- A\n  - B\n    - C|");
	assert.equal(run("- A\n  - B\n    - C|", "in"), null);
});

test("memo indent: blank and non-list lines are skipped when finding the item above", () => {
	assert.equal(run("- A\n\n- B|", "in"), "- A\n\n  - B|");
	assert.equal(run("  - A\n\n> 인용\n- B|", "in"), "  - A\n\n> 인용\n  - B|");
});

test("memo indent: Shift+Tab outdents one level; flush left is a no-op", () => {
	assert.equal(run("- A\n    - B|", "out"), "- A\n  - B|");
	assert.equal(run("- A\n  - B|", "out"), "- A\n- B|");
	assert.equal(run("- A\n- B|", "out"), null);
	assert.equal(run("- A\n |- B", "out"), "- A\n|- B"); // caret inside the removed spaces lands at line start
});

test("memo indent: leading tab outdent removes one tab; indent always adds spaces", () => {
	assert.equal(run("- A\n\t- B|", "out"), "- A\n- B|");
	assert.equal(run("- A\n\t\t- B|", "out"), "- A\n\t- B|");
	assert.equal(run("\t- A\n\t- B|", "in"), "\t- A\n  \t- B|");
	assert.ok(!adjustMemoIndent("- A\n- B", 6, 6, "in")!.text.includes("\t"));
});

test("memo indent: a multi-line selection moves as a block, keeping relative depth", () => {
	assert.equal(run("- A\n[- B\n  - C]", "in"), "- A\n  [- B\n    - C]");
	assert.equal(run("- A\n  [- B\n    - C]", "out"), "- A\n[- B\n  - C]");
	// First selected item can't move → nothing moves (no over-indenting later lines).
	assert.equal(run("- A\n  [- B\n  - C]", "in"), null);
	// Outdent per line: flush lines stay flush.
	assert.equal(run("[- A\n  - B]", "out"), "[- A\n- B]");
	// Selection ending at the start of the next line does not take that line.
	assert.equal(run("- A\n[- B\n]- C", "in"), "- A\n  [- B\n]- C");
});

test("memo indent: unrelated lines stay byte-for-byte", () => {
	const before = "자유 문장 그대로\n- A  \n\t- 탭 들여쓰기\n- B|\n\n> 인용\n- C\n";
	const out = run(before, "in")!;
	const a = before.replace("|", "").split("\n");
	const b = out.replace("|", "").split("\n");
	assert.equal(a.length, b.length);
	for (let i = 0; i < a.length; i++) {
		if (a[i] === "- B") assert.equal(b[i], "  - B");
		else assert.equal(b[i], a[i]);
	}
	// Non-list lines are never touched, even inside the selection.
	assert.equal(run("- A\n[메모 본문\n- B]", "in"), "- A\n[메모 본문\n  - B]");
	assert.equal(run("- A\n본문|", "in"), null);
});

test("memo indent: vault-shaped Daily Pad memo — nested child parses and a new sibling nests", () => {
	const pad = "## 개인 할 일\n- [ ] 운동\n\n## 메모\n- 현지 면담 4건 진행\n  - BHD(오전): 미팅\n- AIOI Studios: 후속|\n\n## 로그\n- 09:00 출발\n";
	const sec = getSectionContent(pad.replace("|", ""), "메모")!;
	const caret = sec.length;
	const r = adjustMemoIndent(sec, caret, caret, "in")!;
	assert.equal(r.text, "- 현지 면담 4건 진행\n  - BHD(오전): 미팅\n  - AIOI Studios: 후속");
	assert.equal(r.start, r.text.length);
	for (const l of r.text.split("\n")) assert.ok(LIST_LINE_RE.test(l));
	assert.equal(LIST_LINE_RE.exec(r.text.split("\n")[2])![1], "  ");
	// Only the 메모 section changes; other sections stay as they were.
	const saved = replaceSectionContent(pad.replace("|", ""), "메모", r.text);
	assert.equal(saved, pad.replace("|", "").replace("\n- AIOI", "\n  - AIOI"));
});
