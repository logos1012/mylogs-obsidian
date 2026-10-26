import { test } from "node:test";
import assert from "node:assert/strict";
import { readMilestones, changeMilestones, milestoneSummary } from "../src/projects/milestones.ts";

const hub = `---\ntype: project\nid: P-newsletter\nstatus: 진행\ngoals: [G-2026-01.1]\n---\n# 뉴스레터 창간\n\n## 성공 기준\n- 첫 호 발송\n\n## 마일스톤\n- [x] 구성 확정\n- [ ] 테스트 발송 및 검수 통과\n\n## 다음 액션\n- [x] 목차 고민하기\n`;
test("milestones count only their section, not actions", () => {
	const m = readMilestones(hub); assert.equal(m.items.length, 2); assert.deepEqual(milestoneSummary(m.items), { done: 1, total: 2, label: "1/2 달성" });
});
test("milestones missing or empty is unconfigured, not zero percent", () => {
	assert.equal(milestoneSummary(readMilestones("## 마일스톤\n- [ ] \n").items).label, "미설정"); assert.equal(readMilestones("## 다음 액션\n- [x] 완료\n").source, "");
});
test("ignore fenced examples, indented children, moved and cancelled lines", () => {
	const m = readMilestones("```md\n## 마일스톤\n- [x] 예시\n```\n## 마일스톤\n- [ ] 실제\n  - [x] 세부\n- [-] 취소 (why:: 변경)\n- [>] 이동 → 다음\n~~~\n- [x] 코드\n~~~\n"); assert.deepEqual(m.items.map(i => i.text), ["실제"]);
});
test("duplicates refuse edits instead of guessing", () => { assert.throws(() => readMilestones("## 마일스톤\n\n## 마일스톤\n"), /둘 이상/); });
test("commented-out examples are not milestones", () => { assert.equal(readMilestones("<!--\n## 마일스톤\n- [x] 예시\n-->\n## 마일스톤\n<!--\n- [x] 주석\n-->\n- [ ] 실제\n").items.length, 1); });
test("adding preserves unrelated sections, goals and status", () => {
	const s = readMilestones(hub).source, next = changeMilestones(hub, s, { kind: "add", text: "창간호 발송" });
	assert.equal(readMilestones(next).items.length, 3); assert.equal(next.replace(readMilestones(next).source, ""), hub.replace(s, ""));
});
test("legacy hub gets section only on first addition", () => {
	const old = "# 뉴스레터\n\n## 성공 기준\n- 첫 발송\n\n## 비목표\n- 유료화\n";
	const next = changeMilestones(old, "", { kind: "add", text: "구성 확정" });
	assert.ok(next.indexOf("## 마일스톤") < next.indexOf("## 비목표")); assert.equal(readMilestones(next).items.length, 1);
});
test("check and undo preserve item text, do not complete project", () => {
	const m = readMilestones(hub), next = changeMilestones(hub, m.source, { kind: "check", line: m.items[1].line, done: true });
	assert.equal(milestoneSummary(readMilestones(next).items).label, "2/2 달성"); assert.match(next, /status: 진행/);
	assert.equal(changeMilestones(next, readMilestones(next).source, { kind: "check", line: m.items[1].line, done: false }), hub);
});
test("edit and remove one of duplicate titles by line", () => {
	const old = "## 마일스톤\n- [ ] 검수\n- [x] 검수\n";
	const next = changeMilestones(old, readMilestones(old).source, { kind: "edit", line: 2, text: "검수 통과" });
	assert.deepEqual(readMilestones(next).items.map(i => i.text), ["검수", "검수 통과"]);
	const after = changeMilestones(next, readMilestones(next).source, { kind: "remove", line: 1 }); assert.equal(milestoneSummary(readMilestones(after).items).label, "1/1 달성");
});
test("stale edits and invalid input never silently overwrite", () => {
	assert.throws(() => changeMilestones(hub, "old", { kind: "add", text: "완료" }), /다른 곳/);
	for (const text of ["", " \t", "a\nb", "a\rb"]) assert.throws(() => changeMilestones(hub, readMilestones(hub).source, { kind: "add", text }), /한 줄/);
	assert.throws(() => changeMilestones(hub, readMilestones(hub).source, { kind: "remove", line: 999 }), /찾지 못/);
});
test("CRLF and no-final-newline survive targeted edit", () => {
	const old = hub.replaceAll("\n", "\r\n"), m = readMilestones(old);
	assert.equal(changeMilestones(old, m.source, { kind: "check", line: m.items[1].line, done: true }), old.replace("- [ ] 테스트", "- [x] 테스트"));
	const short = "## 마일스톤\n- [ ] 검수"; assert.equal(changeMilestones(short, short, { kind: "edit", line: 1, text: "검수 통과" }), "## 마일스톤\n- [ ] 검수 통과");
});
