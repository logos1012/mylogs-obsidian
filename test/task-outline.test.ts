import { test } from "node:test";
import assert from "node:assert/strict";
import { lastTopLevel, placeTask, previousTopLevel } from "../src/projects/tasks.ts";

const HUB = `---
type: project
---

## 할 일

- [ ] 3강 만들기 (task:: T-g) (project:: P)
    - [ ] 스크립트 (task:: T-s) (project:: P)
    - 녹화 (task:: T-r) (project:: P)
- [ ] 홍보 글 (task:: T-a) (project:: P)
- 배정한 일 (task:: T-x) (project:: P)

## 비목표
`;

test("outline: Tab puts a row under the top-level row above it", () => {
	assert.equal(previousTopLevel(HUB, "T-a"), "T-g");
	const out = placeTask(HUB, "T-a", "T-g");
	assert.match(out, /- \[ \] 3강 만들기[^\n]*\n    - \[ \] 스크립트[^\n]*\n    - 녹화[^\n]*\n    - \[ \] 홍보 글 \(task:: T-a\)[^\n]*\n- 배정한 일/);
});

test("outline: Shift+Tab takes a 하위 row out, right after its 묶음", () => {
	const out = placeTask(HUB, "T-s", null);
	assert.match(out, /- \[ \] 3강 만들기[^\n]*\n    - 녹화[^\n]*\n- \[ \] 스크립트 \(task:: T-s\)[^\n]*\n- \[ \] 홍보 글/);
	assert.equal(placeTask(HUB, "T-a", null), HUB);
});

test("outline: two levels only, and never under an assigned row", () => {
	assert.throws(() => placeTask(HUB, "T-g", "T-a"), /두 단계/);
	assert.throws(() => placeTask(HUB, "T-a", "T-x"), /배정한 할 일 아래/);
	assert.equal(previousTopLevel(HUB, "T-g"), null);
	assert.equal(lastTopLevel(HUB), null);
	assert.equal(lastTopLevel(HUB.replace("- 배정한 일 (task:: T-x) (project:: P)\n", "")), "T-a");
});

test("outline: a 하위 row moves from one 묶음 to another", () => {
	const out = placeTask(HUB, "T-r", "T-a");
	assert.match(out, /- \[ \] 홍보 글 \(task:: T-a\)[^\n]*\n    - 녹화 \(task:: T-r\)/);
	assert.doesNotMatch(out, /스크립트[^\n]*\n    - 녹화/);
});

import { insertTaskAfter, removeHubRow, hubRows } from "../src/projects/tasks.ts";

test("outline: Enter inserts right after a row, as a sibling or a 하위 line", () => {
	const row = "- [ ] 새 일 (task:: T-n) (project:: P)";
	assert.match(insertTaskAfter(HUB, "T-a", row, false), /- \[ \] 홍보 글[^\n]*\n- \[ \] 새 일/);
	assert.match(insertTaskAfter(HUB, "T-g", row, true), /- \[ \] 3강 만들기[^\n]*\n    - \[ \] 새 일[^\n]*\n    - \[ \] 스크립트/);
	assert.match(insertTaskAfter(HUB, "T-s", row, true), /스크립트[^\n]*\n    - \[ \] 새 일[^\n]*\n    - 녹화/);
	assert.match(insertTaskAfter(HUB, "T-g", row, false), /    - 녹화[^\n]*\n- \[ \] 새 일[^\n]*\n- \[ \] 홍보 글/);
	assert.throws(() => insertTaskAfter(HUB, "T-x", row, true), /배정한 할 일 아래/);
	assert.match(insertTaskAfter(HUB, null, row, false), /- 배정한 일[^\n]*\n\n?- \[ \] 새 일[^\n]*\n/);
});

test("outline: Backspace on an empty line deletes it; a 묶음 only without 하위", () => {
	assert.doesNotMatch(removeHubRow(HUB, "T-a"), /홍보 글/);
	assert.throws(() => removeHubRow(HUB, "T-g"), /하위 할 일이 있어요/);
	assert.deepEqual(hubRows(HUB).map((r) => [r.id, r.depth, r.ref]), [["T-g", 0, false], ["T-s", 1, false], ["T-r", 1, true], ["T-a", 0, false], ["T-x", 0, true]]);
});
