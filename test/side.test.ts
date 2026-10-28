import { test } from "node:test";
import assert from "node:assert/strict";
import { forInput, hasWorkTag, inputSide, lineSide, projectRef, scopeLookup, setSide, shows, withoutWorkTag, withWorkTag } from "../src/side.ts";
import { appendToSection, findSection, getSectionContent, replaceSectionContent } from "../src/writer.ts";
import { parseMonthFile } from "../src/desk/model.ts";
import { filterMonth } from "../src/desk/side-filter.ts";
import { planSetSide } from "../src/desk/ops.ts";

test("side: #회사 is 회사, no mark is 개인", () => {
	assert.equal(lineSide("- [ ] 견적서 회신 #회사"), "회사");
	assert.equal(lineSide("- [ ] 장보기"), "개인");
	assert.equal(lineSide("- [ ] #회사원 모임"), "개인");
	assert.equal(lineSide("- 14:00 회의 #회사 (goal:: G-1)"), "회사");
	assert.equal(hasWorkTag("회사 회의"), false);
});

test("side: a project link follows the project's scope", () => {
	const scopeOf = scopeLookup([{ id: "P-a", title: "회사 일", scope: "회사" }, { id: "P-b", title: "글쓰기", scope: "개인" }]);
	assert.equal(projectRef("- [ ] 초안 (task:: T-1) (project:: P-a)"), "P-a");
	assert.equal(lineSide("- [ ] 초안 (task:: T-1) (project:: P-a)", scopeOf), "회사");
	assert.equal(lineSide("- [ ] 초안 (project:: P-b) #회사", scopeOf), "개인");
	assert.equal(lineSide("- [ ] 초안 (project:: P-x) #회사", scopeOf), "회사");
});

test("side: tagging and modes", () => {
	assert.equal(withWorkTag("- [ ] a (goal:: G-1)"), "- [ ] a (goal:: G-1) #회사");
	assert.equal(withWorkTag("- [ ] a #회사"), "- [ ] a #회사");
	assert.equal(withoutWorkTag("- [ ] a #회사 (why:: x)"), "- [ ] a (why:: x)");
	assert.equal(setSide("- [ ] a #회사", "개인"), "- [ ] a");
	assert.equal(forInput("- [ ] a", "회사"), "- [ ] a #회사");
	assert.equal(forInput("- [ ] a", "전체"), "- [ ] a");
	assert.equal(inputSide("전체"), "개인");
	assert.ok(shows("회사", "전체") && shows("개인", "개인") && !shows("회사", "개인"));
});

test("Daily Pad: 「오늘 할 일」 pages read as 개인 할 일; 회사 할 일 goes right under it", () => {
	const old = "---\ntype: daily-pad\n---\n\n# 2026-10-27\n\n## 오늘 할 일\n- [ ] a\n\n## 메모\n- m\n";
	assert.equal(getSectionContent(old, "개인 할 일"), "- [ ] a");
	assert.equal(findSection(old, "개인 할 일")?.name, "오늘 할 일");
	const next = appendToSection(old, "회사 할 일", "- [ ] w");
	assert.equal(next, "---\ntype: daily-pad\n---\n\n# 2026-10-27\n\n## 오늘 할 일\n- [ ] a\n\n## 회사 할 일\n- [ ] w\n\n## 메모\n- m\n");
	const fresh = "## 개인 할 일\n\n## 회사 할 일\n\n## 메모\n";
	assert.equal(replaceSectionContent(fresh, "회사 할 일", "- [ ] w"), "## 개인 할 일\n\n## 회사 할 일\n- [ ] w\n\n## 메모\n");
});

const MONTH = `---
type: desk-calendar
---

## 이달의 초점

## 이달 중
- [ ] 이력서 #회사
- [ ] 책 읽기

## W44 (10/26~11/01)

### 이번 주
- [ ] 보고서 #회사 → 10/27
- [ ] 산책 → 10/27

### 2026-10-27
- [ ] 보고서 #회사
- [ ] 산책
- 14:00 회의 #회사
- [ ] 초안 (task:: T-1) (project:: P-w)
`;

test("Desk: the mode filters lines and counts both sides per day", () => {
	const md = parseMonthFile(MONTH, 2026, 10);
	const scopeOf = scopeLookup([{ id: "P-w", scope: "회사" }]);
	const p = filterMonth(md, "개인", scopeOf);
	assert.deepEqual(p.data.days.get("2026-10-27")!.map((x) => x.item.text), ["산책"]);
	assert.deepEqual(p.data.during.map((x) => x.item.text), ["책 읽기"]);
	assert.deepEqual(p.counts.get("2026-10-27"), { 개인: 1, 회사: 3 });
	const w = filterMonth(md, "회사", scopeOf);
	assert.equal(w.data.days.get("2026-10-27")!.length, 3);
	assert.equal(w.data.weeks.get("2026-10-26")!.alloc!.length, 1);
	assert.equal(filterMonth(md, "전체", scopeOf).data.days.get("2026-10-27")!.length, 4);
	// File line indexes are untouched, so writes still land on the right line.
	assert.equal(p.data.days.get("2026-10-27")![0].index, md.days.get("2026-10-27")![1].index);
});

test("Desk: 개인 ↔ 회사 retags the line and its pair", () => {
	const md = parseMonthFile(MONTH, 2026, 10);
	const day = md.days.get("2026-10-27")!.find((x) => x.item.text === "산책")!;
	const alloc = md.weeks.get("2026-10-26")!.alloc!.find((x) => x.item.text === "산책")!;
	const plan = planSetSide(day, "회사", [alloc], "2026-10-28");
	let text = MONTH;
	for (const e of plan.edits) {
		const r = e.apply(text);
		assert.ok(r.ok);
		text = r.text;
	}
	assert.match(text, /- \[ \] 산책 #회사 → 10\/27|- \[ \] 산책 → 10\/27 #회사/);
	assert.match(text, /### 2026-10-27\n- \[ \] 보고서 #회사\n- \[ \] 산책 #회사\n/);
});
