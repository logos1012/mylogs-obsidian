import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlywheel } from "../src/flywheel/model.ts";
import { addElement, countActive, dayMark, isPlaceholder, nextId, parseLogTable, purposeOf, renameElement, replacementsThisQuarter, setElementField, setPurpose, togglePadLine, weekRate } from "../src/flywheel/ops.ts";

// Flywheel view edits (계획 「10-1」). Fictional data only (김하루).
const WHEEL = `---\ntype: flywheel\nelements: 2\nupdated: 2026-10-01\n---\n# Flywheel\n\n(한 문장 — 채우기)\n\n## F-1 몸 만들기\n- 정체성:: 나는 매일 몸을 쓰는 사람이다\n- 최소:: 걷기 15분\n- 보통:: (채우기)\n- 다음:: → F-2 체력이 있어야 글이 써진다\n- status:: 사용\n- since:: 2026-10-05\n\n## F-3 글쓰기\n- 최소:: 한 문장\n- status:: 폐기\n\n## 변경 기록\n- 2026-10-05: 바퀴 세움\n`;

test("purpose, fields, rename keep everything else byte-for-byte", () => {
	assert.equal(purposeOf(WHEEL), "(한 문장 — 채우기)");
	const p = setPurpose(WHEEL, "매일 몸을 쓰고 글을 쓴다");
	assert.equal(purposeOf(p), "매일 몸을 쓰고 글을 쓴다");
	assert.ok(p.includes("## F-1 몸 만들기\n- 정체성::"));
	const f = setElementField(WHEEL, "F-1", "보통", "달리기 5km")!;
	assert.ok(f.includes("- 보통:: 달리기 5km\n- 다음::"));
	assert.equal(f.replace("- 보통:: 달리기 5km", "- 보통:: (채우기)"), WHEEL);
	const g = setElementField(WHEEL, "F-1", "goal", "G-2026-02.1")!;
	assert.ok(g.includes("- since:: 2026-10-05\n- goal:: G-2026-02.1\n"), "missing field goes after the last field");
	assert.equal(setElementField(WHEEL, "F-9", "최소", "x"), null);
	assert.ok(renameElement(WHEEL, "F-1", "몸 쓰기")!.includes("## F-1 몸 쓰기\n"));
	assert.ok(isPlaceholder("(채우기 — 예: 15분)") && isPlaceholder("") && !isPlaceholder("걷기"));
});

test("new element: next id never reuses a retired number; block goes before 변경 기록", () => {
	assert.equal(nextId(WHEEL), "F-4");
	const out = addElement(WHEEL, "F-4", { name: "나누기", identity: "나는 나누는 사람이다", min: "메모 하나 공유", normal: "", next: "→ F-1 이유" }, "2026-10-27");
	const els = parseFlywheel(out);
	assert.deepEqual(els.map((e) => e.id), ["F-1", "F-3", "F-4"]);
	assert.equal(els[2].status, "사용");
	assert.equal(els[2].fields["since"], "2026-10-27");
	assert.ok(out.indexOf("## F-4 나누기") < out.indexOf("## 변경 기록"));
	assert.equal(countActive(els), 2);
	assert.equal(replacementsThisQuarter("## 변경 기록\n- 2026-10-12: 요소 교체: F-3 추가 (플러그인)\n- 2026-09-30: 요소 교체: F-2 폐기\n", "2026-11-02"), 1);
});

test("day marks: Daily Pad line, then 수행 표, 쉼, 기록 없음, before since; week rate per 「4-4」", () => {
	const [e] = parseFlywheel(WHEEL);
	const pad = (c: string) => `## 오늘 할 일\n- [${c}] F-1 몸 만들기 — 걷기 15분 (flywheel:: F-1)\n`;
	assert.equal(dayMark(e, "2026-10-01", pad("x"), undefined), "out");
	assert.equal(dayMark(e, "2026-10-06", pad("x"), undefined), "x");
	assert.equal(dayMark(e, "2026-10-06", pad(" "), "x"), "-");
	assert.equal(dayMark(e, "2026-10-06", null, "쉼"), "쉼");
	assert.equal(dayMark(e, "2026-10-06", null, undefined), "");
	assert.equal(dayMark(e, "2026-10-06", "## 오늘 할 일\n", undefined, true), "쉼");
	const table = parseLogTable("| 날짜 | F-1 | F-2 | 합 |\n|---|---|---|---|\n| 05 | x | - | 1/2 |\n| 6 | 쉼 | x | 1/1 |\n");
	assert.equal(table.get("05")?.get("F-1"), "x");
	assert.equal(table.get("06")?.get("F-1"), "쉼");
	assert.deepEqual(weekRate(["x", "x", "-", "쉼", "", "out", "x"]), { done: 3, denom: 5, blank: 1 });
	assert.equal(togglePadLine(pad(" "), "F-1"), pad("x"));
	assert.equal(togglePadLine(pad("x"), "F-1"), pad(" "));
	assert.equal(togglePadLine(pad("x"), "F-2"), null);
});
