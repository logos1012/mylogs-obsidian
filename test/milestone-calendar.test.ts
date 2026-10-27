import { test } from "node:test";
import assert from "node:assert/strict";
import { changeMilestones, readMilestones, validMilestoneDate } from "../src/projects/milestones.ts";
import { milestoneMarkers, markerState } from "../src/projects/milestone-calendar.ts";
import type { Project } from "../src/projects/model.ts";

const hub = "## 마일스톤\n- [ ] 김하루의 창간호 검수 (due:: 2026-11-05)\n- [x] 구성 확정\n\n## 다음 액션\n- [ ] 인터뷰 요청\n";
test("date fields stay out of milestone text, legacy items retain old shape", () => {
	assert.deepEqual(readMilestones(hub).items, [{ line: 1, text: "김하루의 창간호 검수", due: "2026-11-05", done: false }, { line: 2, text: "구성 확정", done: true }]);
});
test("real ISO dates and leap days, not Date overflow", () => {
	for (const d of ["2024-02-29", "2026-12-31", "1900-01-01", "2999-12-31"]) assert.equal(validMilestoneDate(d), true);
	for (const d of ["2026-02-29", "2026-11-31", "2026-1-01", "2026-13-01", "0000-01-01", "3000-01-01", "tomorrow", ""]) assert.equal(validMilestoneDate(d), false);
});
test("date edits replace one source field, never milestone completion or other sections", () => {
	const m = readMilestones(hub), next = changeMilestones(hub, m.source, { kind: "edit", line: 1, text: m.items[0].text, due: "2027-01-02" });
	assert.equal(next, hub.replace("2026-11-05", "2027-01-02"));
	assert.equal(readMilestones(next).items[0].done, false);
});
test("title-only edit and checkbox preserve dates, explicit clearing removes only date", () => {
	const m = readMilestones(hub);
	assert.match(changeMilestones(hub, m.source, { kind: "edit", line: 1, text: "창간호 승인" }), /창간호 승인 \(due:: 2026-11-05\)/);
	assert.match(changeMilestones(hub, m.source, { kind: "check", line: 1, done: true }), /\[x\] 김하루의 창간호 검수 \(due:: 2026-11-05\)/);
	assert.equal(changeMilestones(hub, m.source, { kind: "edit", line: 1, text: m.items[0].text, due: "" }), hub.replace(" (due:: 2026-11-05)", ""));
});
test("add accepts optional date and rejects malformed or hidden duplicate date metadata", () => {
	const next = changeMilestones("", "", { kind: "add", text: "창간호 발송", due: "2026-12-01" });
	assert.equal(readMilestones(next).items[0].due, "2026-12-01");
	assert.throws(() => changeMilestones("", "", { kind: "add", text: "발송", due: "2026-02-29" }), /실제 날짜/);
	assert.throws(() => changeMilestones("", "", { kind: "add", text: "발송 (due:: 2026-11-05)" }), /날짜 칸/);
});
test("invalid/duplicate dates warn rather than silently choosing one or changing old data", () => {
	const old = "## 마일스톤\n- [ ] 검수 (due:: bad) (due:: 2026-11-05)\n";
	const m = readMilestones(old); assert.ok(m.items[0].dueIssue); assert.equal(m.items[0].due, undefined);
	assert.match(changeMilestones(old, m.source, { kind: "edit", line: 1, text: "검수 통과" }), /\(due:: bad\) \(due:: 2026-11-05\)/);
	const fixed = changeMilestones(old, m.source, { kind: "edit", line: 1, text: "검수 통과", due: "2026-11-06" });
	assert.equal(readMilestones(fixed).items[0].dueIssue, undefined); assert.equal(readMilestones(fixed).items[0].due, "2026-11-06");
});
test("date field before the text and CRLF survive targeted date edits", () => {
	const raw = "## 마일스톤\r\n- [ ] (due:: 2026-11-05) 검수\r\n";
	const m = readMilestones(raw); assert.equal(m.items[0].text, "검수");
	assert.equal(changeMilestones(raw, m.source, { kind: "edit", line: 1, text: "검수", due: "2026-11-06" }), "## 마일스톤\r\n- [ ] 검수 (due:: 2026-11-06)\r\n");
});
const project = (text: string, archived = false): Project => ({ id: "P-newsletter", path: "folder/hub.md", title: "김하루의 뉴스레터 창간", archived, milestones: readMilestones(text).items } as Project);
test("calendar projection only includes valid dated milestones, sorted across years", () => {
	const source = project(hub + ""), original = structuredClone(source);
	const markers = milestoneMarkers([source, { ...project("## 마일스톤\n- [ ] 발송 (due:: 2027-01-01)\n- [ ] 오류 (due:: 2026-02-29)\n"), id: "P-next" }]);
	assert.deepEqual(markers.map(m => m.date), ["2026-11-05", "2027-01-01"]); assert.deepEqual(source, original);
});
test("elapsed date only changes display state, not completion; archived not overdue", () => {
	const m = milestoneMarkers([project(hub)])[0];
	assert.equal(markerState(m, "2026-11-05"), "planned"); assert.equal(markerState(m, "2026-11-06"), "overdue"); assert.equal(m.done, false);
	assert.equal(markerState({ ...m, done: true }, "2026-11-06"), "done");
	assert.equal(markerState({ ...m, archived: true }, "2026-11-06"), "archived");
});
test("date cleared or milestone removed leaves no old marker", () => {
	const m = readMilestones(hub);
	for (const change of [{ kind: "edit", line: 1, text: m.items[0].text, due: "" } as const, { kind: "remove", line: 1 } as const]) assert.equal(milestoneMarkers([project(changeMilestones(hub, m.source, change))]).length, 0);
});
