import { test } from "node:test";
import assert from "node:assert/strict";
import { goalPointsToProject, projectGoalLinks, sharedFlywheel, workspaceFiles, workspaceSections } from "../src/projects/workspace.ts";
import type { Project } from "../src/projects/model.ts";
import type { Goal } from "../src/pinboard/model.ts";

const p = { id: "P-newsletter", name: "뉴스레터 창간", path: "05 Project Folders/개인/뉴스레터 창간/뉴스레터 창간.md", folder: "05 Project Folders/개인/뉴스레터 창간", goals: ["G-2026-01.1"] } as Project;
const goal = (id: string, extras = {}): Goal => ({ id, projectIds: [], projects: [], type: "sub-goal", ...extras } as unknown as Goal);
test("workspace links union both sides, distinguish broken and one-sided", () => {
	const goals = [goal("G-2026-01.1", { projectIds: [p.id] }), goal("G-2026-01.2", { projectIds: [p.id] })];
	assert.deepEqual(projectGoalLinks(p, goals).map(x => [x.id, x.oneSided]), [["G-2026-01.1", false], ["G-2026-01.2", true]]);
	assert.equal(projectGoalLinks(p, [])[0].goal, undefined);
});
test("goal links match exact id or path with extension/alias, not path substrings", () => {
	assert.equal(goalPointsToProject(goal("g", { projects: [`[[${p.path}|김하루의 창간]]`] }), p), true);
	assert.equal(goalPointsToProject(goal("g", { projectIds: [p.id + "-2"] }), p), false);
	assert.equal(goalPointsToProject(goal("g", { projects: [`[[${p.path} extra]]`] }), p), false);
});
test("shared Flywheel: same goal or named in the hub's flywheel; 폐기 left out", () => {
	const el = (id: string, name: string, status: string, goals: string[]) => ({ id, name, status, goals, fields: {}, since: "", channels: [], folder: "", hubPath: "", hasHub: true });
	const elements = [el("F-1", "글쓰기", "사용", ["G-2026-01.1"]), el("F-2", "몸 만들기", "사용", ["G-2026-02.1"]), el("F-3", "옛 요소", "폐기", ["G-2026-01.1"])];
	assert.deepEqual(sharedFlywheel(p, [], elements).map(e => e.id), ["F-1"]);
	assert.deepEqual(sharedFlywheel(p, [], elements, ["F-2"]).map(e => e.id), ["F-1", "F-2"]);
});
test("workspace files stay within the selected project and include nested non-markdown assets", () => {
	const root = p.folder + "/01 초안/";
	const files = workspaceFiles([root + "글.md", root + "첨부/그림.png", root + ".DS_Store", root + ".cache/a.md", p.folder + "2/01 초안/다른.md", p.folder + "/02 산출물/완성.md"], p.folder, "01 초안");
	assert.deepEqual(files.map(f => f.label).sort(), ["글.md", "첨부/그림.png"].sort());
});
test("workspace extracts sections without rewriting source or duplicating milestone state", () => {
	const text = "---\ntype: project\n---\n# 김하루\n\n## 성공 기준\n- 독자에게 발송\n\n## 마일스톤\n- [x] 검수\n\n## 현재 상태\n- 작성 중\n\n## 다음 액션\n- [ ] 확인 요청\n";
	const sections = workspaceSections(text);
	assert.equal(sections[0].text, "- 독자에게 발송");
	assert.equal(sections.find(s => s.title === "마일스톤"), undefined);
	assert.equal(sections.find(s => s.title === "막힌 점")?.text, "");
	assert.equal(sections.find(s => s.title === "다음 액션")?.text, "- [ ] 확인 요청");
});
