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
