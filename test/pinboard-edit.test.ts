import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	applyMainRollup,
	deleteProgressEntry,
	editGoalNote,
	editProgressEntry,
	linkProject,
	progressEntries,
	removeIndexRows,
	removeUndecidedLines,
	renameLinks,
	sectionAsLines,
	setIndexCells,
	unlinkProject,
	WHY_SECTION,
} from "../src/pinboard/goal-edit.ts";
import { parseFrontmatterText, parseGoal, rollupMain } from "../src/pinboard/model.ts";
import { getFmList } from "../src/projects/ops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/pinboard", p), "utf8");
const MAIN = fx("2026/G-2026-01 AI 사업으로 월 500만원 벌기.md");
const SUB_M = fx("2026/G-2026-01.2 Claude Code 기본 강의 첫 판매.md");
const SUB_W = fx("2026/G-2026-02.1 체중 95kg.md");
const INDEX = fx("Pinboard Index.md");
const TODAY = "2026-10-25";

function changed(a: string, b: string): [string, string][] {
	const x = a.split("\n");
	const y = b.split("\n");
	assert.equal(x.length, y.length, "same line count");
	return x.map((l, i) => [l, y[i]] as [string, string]).filter(([l, m]) => l !== m);
}

test("edit Sub Goal: card fields in frontmatter, H1, progress recomputed, updated", () => {
	const r = editGoalNote(SUB_W, "p/w.md", { title: "체중 96kg", target: "96", due: "2026-11-30", unit: "kg", baseline: "100" }, TODAY);
	assert.deepEqual(changed(SUB_W, r.text), [
		["title: 체중 95kg", "title: 체중 96kg"],
		["target: 95", "target: 96"],
		["due: 2026-12-31", "due: 2026-11-30"],
		["updated: 2026-10-24", `updated: ${TODAY}`],
		["# 체중 95kg", "# 체중 96kg"],
	]);
	assert.equal(r.goal?.target, "96");
	// numbers changed → progress recomputed (100 → 98 toward 96 = 50%)
	const w2 = SUB_W.replace("current: 100", "current: 98");
	const r2 = editGoalNote(w2, "p/w.md", { target: "96" }, TODAY);
	assert.equal(r2.goal?.progress, 50);
	assert.match(r2.text, /^progress: 50$/m);
});

test("edit Sub Goal: nothing changed → text unchanged; empty value clears the key", () => {
	assert.equal(editGoalNote(SUB_W, "p/w.md", { title: "체중 95kg", target: "95" }, TODAY).text, SUB_W);
	const r = editGoalNote(SUB_M, "p/m.md", { target: "", due: "2027-01-31" }, TODAY);
	assert.match(r.text, /^target:$/m);
	assert.match(r.text, /^due: 2027-01-31$/m);
	// text values with special characters are quoted
	const r2 = editGoalNote(SUB_M, "p/m.md", { target: "첫 결제: 1건" }, TODAY);
	assert.match(r2.text, /^target: "첫 결제: 1건"$/m);
	assert.equal(parseGoal(parseFrontmatterText(r2.text).data, "p")?.target, "첫 결제: 1건");
});

test("edit Main Goal: title, area and the 왜 / 달성한 모습 sections", () => {
	const r = editGoalNote(MAIN, "p/main.md", { title: "AI 사업으로 월 600만원 벌기", area: "사업", why: "회사 밖에서도 버틸 힘\n- 가족과 시간", vision: "매달 통장에 600" }, TODAY);
	assert.match(r.text, /^title: AI 사업으로 월 600만원 벌기$/m);
	assert.match(r.text, /^# AI 사업으로 월 600만원 벌기$/m);
	assert.match(r.text, /## 왜 이 목표인가\n- 회사 밖에서도 버틸 힘\n- 가족과 시간\n\n## 달성한 모습\n- 매달 통장에 600\n\n## Sub Goal/);
	assert.equal(sectionAsLines(r.text, WHY_SECTION), "회사 밖에서도 버틸 힘\n가족과 시간");
	// the rest of the body is byte-identical
	assert.ok(r.text.endsWith(MAIN.slice(MAIN.indexOf("## Sub Goal"))));
});

test("links: rename and remove a Sub Goal's link line; Main rollup", () => {
	const renamed = renameLinks(MAIN, "G-2026-01.2 Claude Code 기본 강의 첫 판매", "G-2026-01.2 Claude Code 강의 첫 판매");
	assert.match(renamed, /^- \[\[G-2026-01\.2 Claude Code 강의 첫 판매\]\]$/m);
	assert.equal(renameLinks("[[a/G-1 x|별칭]] [[G-1 xy]]", "G-1 x", "G-1 z"), "[[a/G-1 z|별칭]] [[G-1 xy]]");
	const r = rollupMain([{ status: "achieved" }]);
	const out = applyMainRollup(MAIN, r, TODAY, "G-2026-01.2 Claude Code 기본 강의 첫 판매");
	assert.ok(!out.includes("[[G-2026-01.2"));
	assert.ok(out.includes("- [[G-2026-01.1 월 매출 500만원 달성]]"));
	assert.match(out, /^sub_total: 1$/m);
	assert.match(out, /^sub_achieved: 1$/m);
	assert.match(out, /^progress: 100$/m);
	assert.match(out, new RegExp(`^updated: ${TODAY}$`, "m"));
});

test("index: set title/due/path cells, remove rows and 미정 lines", () => {
	const r = setIndexCells(INDEX, "2026", [{ id: "G-2026-02.1", title: "체중 96kg", due: "2026-11-30", path: "100 → 100 → 96 kg" }]);
	assert.deepEqual(r.missing, []);
	assert.deepEqual(changed(INDEX, r.text), [
		[
			"| G-2026-02.1 | sub | 체중 95kg | G-2026-02 | active | 100 → 100 → 95 kg | 2026-12-31 | 0% | — |",
			"| G-2026-02.1 | sub | 체중 96kg | G-2026-02 | active | 100 → 100 → 96 kg | 2026-11-30 | 0% | — |",
		],
	]);
	const del = removeIndexRows(INDEX, "2026", ["G-2026-01.2", "G-2026-01"]);
	assert.deepEqual(del.removed, ["G-2026-01", "G-2026-01.2"]);
	assert.equal(del.text.split("\n").length, INDEX.split("\n").length - 2);
	assert.ok(del.text.includes("| G-2026-01.1 |"));
	const und = removeUndecidedLines(INDEX, ["G-2026-01.2"]);
	assert.ok(!und.includes("- G-2026-01.2: 기한"));
	assert.ok(und.includes("- G-2026-01.1: 기한"));
	assert.ok(und.includes("- 모든 수단:"));
});

test("진척 기록: list, edit and delete one entry", () => {
	const es = progressEntries(SUB_W);
	assert.deepEqual(es.map((e) => e.text), ["2026-10-24: 시작 체중 100kg (사용자 보고)"]);
	const ed = editProgressEntry(SUB_W, es[0], "2026-10-24: 시작 체중 101kg (보고됨)");
	assert.ok(ed.ok);
	assert.deepEqual(changed(SUB_W, ed.text), [["- 2026-10-24: 시작 체중 100kg (사용자 보고)", "- 2026-10-24: 시작 체중 101kg (보고됨)"]]);
	const del = deleteProgressEntry(SUB_W, es[0]);
	assert.ok(del.ok);
	assert.equal(del.text, SUB_W.replace("- 2026-10-24: 시작 체중 100kg (사용자 보고)\n", ""));
	assert.deepEqual(deleteProgressEntry(del.text, es[0]), { ok: false, reason: "not-found" });
	assert.deepEqual(editProgressEntry(SUB_W, es[0], " "), { ok: false, reason: "empty-text" });
	assert.deepEqual(progressEntries(SUB_M), []);
});

test("project links on a Sub Goal: add and remove (projects + project_ids)", () => {
	const hub = "[[05 Project Folders/개인/강의/강의]]";
	const a = linkProject(SUB_M, "P-lecture", hub, TODAY);
	assert.deepEqual(getFmList(a, "project_ids"), ["P-lecture"]);
	assert.deepEqual(getFmList(a, "projects"), [hub]);
	assert.match(a, /^projects:\n {2}- "\[\[05 Project Folders\/개인\/강의\/강의\]\]"$/m);
	assert.equal(linkProject(a, "P-lecture", hub, TODAY), a);
	const b = unlinkProject(a, "P-lecture", "강의", TODAY);
	assert.deepEqual(getFmList(b, "project_ids"), []);
	assert.deepEqual(getFmList(b, "projects"), []);
	assert.match(b, /^project_ids: \[\]$/m);
	assert.equal(unlinkProject(SUB_M, "P-none", "없음", TODAY), SUB_M);
});
