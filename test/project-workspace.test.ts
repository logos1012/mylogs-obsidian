import { test } from "node:test";
import assert from "node:assert/strict";
import { expandedFolders, goalPointsToProject, projectGoalLinks, sharedFlywheel, toggleExpandedFolder, workspaceFiles, workspaceSections, workspaceTree, type WorkspaceFolder } from "../src/projects/workspace.ts";
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

test("workspace tree: root files first, folders in natural order with nested counts", () => {
	const root = p.folder + "/99 작업실/";
	const files = workspaceFiles([
		root + "메모.md", root + "40 회의/킥오프.md", root + "10 자료/사진/a.png", root + "10 자료/사진/b.png",
		root + "10 자료/목록.md", root + "9 임시/x.md", root + "100 끝/y.md", root + "가.md",
	], p.folder, "99 작업실");
	const tree = workspaceTree(files);
	assert.deepEqual(tree.files.map(f => f.label), ["가.md", "메모.md"]);
	assert.deepEqual(tree.folders.map(f => [f.name, f.fileCount]), [["9 임시", 1], ["10 자료", 3], ["40 회의", 1], ["100 끝", 1]]);
	const data = tree.folders[1];
	assert.equal(data.path, "10 자료");
	assert.deepEqual(data.files.map(f => f.label), ["10 자료/목록.md"]);
	assert.deepEqual(data.folders.map(f => [f.path, f.fileCount, f.files.length]), [["10 자료/사진", 2, 2]]);
	assert.equal(data.folders[0].files[0].path, root + "10 자료/사진/a.png");
});
test("workspace tree: folders only exist through files, so empty ones never show", () => {
	const count = (fs: WorkspaceFolder[]): number => fs.reduce((n, f) => n + 1 + count(f.folders), 0);
	const tree = workspaceTree([{ path: "x/a/b/c.md", label: "a/b/c.md" }]);
	assert.equal(count(tree.folders), 2);
	assert.deepEqual(workspaceTree([]), { files: [], folders: [] });
	// Filtered-out files (작업실 로그/) leave no folder behind.
	const kept = workspaceFiles([p.folder + "/99 작업실/로그/2026.md", p.folder + "/99 작업실/AGENTS.md"], p.folder, "99 작업실").filter(f => !/^(로그\/|AGENTS\.md$)/.test(f.label));
	assert.deepEqual(workspaceTree(kept), { files: [], folders: [] });
});
test("expanded folders are remembered per project and closing the last drops the entry", () => {
	let map: Record<string, string[]> = {};
	map = toggleExpandedFolder(map, "P-1", "02 산출물/인터뷰 질문지", true);
	map = toggleExpandedFolder(map, "P-1", "99 작업실/10 자료", true);
	map = toggleExpandedFolder(map, "P-2", "01 초안/a", true);
	assert.deepEqual([...expandedFolders(map, "P-1")], ["02 산출물/인터뷰 질문지", "99 작업실/10 자료"]);
	const before = map;
	map = toggleExpandedFolder(map, "P-1", "02 산출물/인터뷰 질문지", false);
	assert.deepEqual(before["P-1"].length, 2, "input map is not mutated");
	assert.deepEqual(map["P-1"], ["99 작업실/10 자료"]);
	map = toggleExpandedFolder(map, "P-1", "99 작업실/10 자료", false);
	assert.equal("P-1" in map, false);
	assert.equal(expandedFolders(undefined, "P-1").size, 0);
	assert.deepEqual(map["P-2"], ["01 초안/a"]);
});
