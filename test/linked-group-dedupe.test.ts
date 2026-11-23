import { test } from "node:test";
import assert from "node:assert/strict";
import { readMilestones } from "../src/projects/milestones.ts";
import { linkedGroupKeys, linkedRows } from "../src/projects/milestone-links.ts";
import { hubRows, hubTopRows, placeTask, previousTopLevel } from "../src/projects/tasks.ts";

// 「할 일」 목록 leaves out the 묶음 shown under a 마일스톤 (shown once, there).
const HUB = `---
type: project
---

## 마일스톤
- [ ] 자사몰 결제 준비 완료: 아임웹 결제 테스트 통과 (due:: 2026-11-25) (ms:: M-6366a218)
- [ ] 첫 주문 (kind:: 성과) (ms:: M-b71e04d2) (current:: 0) (target:: 1)

## 할 일

- [ ] 상품 사진 정리
- [ ] 자사몰 세팅 (아임웹) (ms:: M-6366a218)
    - [ ] 결제 모듈 신청
    - [ ] 테스트 결제
- [ ] 광고 문구
- [ ] 옛 연결 (ms:: M-deadbeef)
    - [ ] 하위 하나
- [ ] 지표용 묶음 (ms:: M-b71e04d2)
`;

const ms = readMilestones(HUB).items;
const top = (title: string) => hubTopRows(HUB).find((r) => r.title === title)!;

test("linked groups: a 묶음 linked to an existing 마일스톤 is detected (id-less rows, by row key)", () => {
	const keys = linkedGroupKeys(HUB, ms);
	const g = top("자사몰 세팅 (아임웹)");
	assert.ok(g.key.startsWith("row:"));
	assert.deepEqual([...keys], [g.key]);
	// The same rows the 마일스톤 panel shows.
	assert.deepEqual([...keys], linkedRows(HUB, "M-6366a218").map((r) => r.key));
});

test("linked groups: a dangling (ms:: …) and a 성과 지표 link do not count; unlinked rows stay", () => {
	const keys = linkedGroupKeys(HUB, ms);
	for (const t of ["옛 연결", "지표용 묶음", "상품 사진 정리", "광고 문구"]) assert.ok(!keys.has(top(t).key), t);
	assert.equal(linkedGroupKeys(HUB, []).size, 0);
	// What the unscoped list draws: everything but the linked 묶음 and its 하위 할 일.
	let cur = "";
	const shown = hubRows(HUB).filter((r) => {
		if (!r.depth) cur = r.key;
		return !keys.has(cur);
	});
	assert.equal(shown.length, hubRows(HUB).length - 3);
	assert.ok(shown.some((r) => r.key === top("옛 연결").children[0].key));
});

test("linked groups: Tab goes under the previous visible top-level row, skipping a hidden 묶음", () => {
	const keys = linkedGroupKeys(HUB, ms);
	const photo = top("상품 사진 정리").key, ad = top("광고 문구").key;
	// Without skipping, Tab on 「광고 문구」 would put it under the hidden 묶음.
	assert.equal(previousTopLevel(HUB, ad), top("자사몰 세팅 (아임웹)").key);
	assert.equal(previousTopLevel(HUB, ad, keys), photo);
	const out = placeTask(HUB, ad, photo);
	assert.match(out, /- \[ \] 상품 사진 정리\n    - \[ \] 광고 문구\n- \[ \] 자사몰 세팅 \(아임웹\)/);
	// A row after a dangling-link 묶음 still goes under it (that 묶음 is on screen).
	assert.equal(previousTopLevel(HUB, top("지표용 묶음").key, keys), top("옛 연결").key);
	// Nothing visible above: no-op (null).
	const first = `## 마일스톤\n- [ ] A (ms:: M-00000001)\n\n## 할 일\n- [ ] 묶음 (ms:: M-00000001)\n    - [ ] 하위\n- [ ] 단독\n`;
	const k = linkedGroupKeys(first, readMilestones(first).items);
	const solo = hubTopRows(first)[1].key;
	assert.equal(previousTopLevel(first, solo, k), null);
	assert.equal(previousTopLevel(first, solo), hubTopRows(first)[0].key);
});
