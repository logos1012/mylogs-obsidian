import { test } from "node:test";
import assert from "node:assert/strict";
import { appendToSection } from "../src/writer.ts";

// memo.ts imports obsidian; the line rule is small enough to check through the same steps.
const memoLines = (text: string) => text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim()).map((l) => (/^\s*[-*+]\s/.test(l) ? l : `- ${l.trim()}`));

test("빠른 메모: each line a list line; written lists stay; appended to 메모", () => {
	assert.deepEqual(memoLines("회의실 예약 확인\n\n- [ ] 견적 다시 보기\n  링크 https://x"), ["- 회의실 예약 확인", "- [ ] 견적 다시 보기", "- 링크 https://x"]);
	const pad = "## 개인 할 일\n\n## 메모\n- 아침 생각\n\n## 로그\n";
	assert.equal(appendToSection(pad, "메모", memoLines("점심 때 떠오름").join("\n")), "## 개인 할 일\n\n## 메모\n- 아침 생각\n- 점심 때 떠오름\n\n## 로그\n");
});
