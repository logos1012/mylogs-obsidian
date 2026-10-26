import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	applyGoalChange,
	applyMainRollup,
	deleteProgressEntry,
	editGoalNote,
	editProgressEntry,
	ensureRetro,
	linkProject,
	progressEntries,
	removeIndexRows,
	removeUndecidedLines,
	renameLinks,
	sectionAsLines,
	setFmValueAfter,
	setIndexCells,
	unlinkProject,
	WHY_SECTION,
} from "../src/pinboard/goal-edit.ts";
import { parseFrontmatterText, parseGoal, rollupMain } from "../src/pinboard/model.ts";
import { getFmList } from "../src/projects/ops.ts";
import { goalLinkTexts, hubGoalsLinked } from "../src/projects/edit.ts";

// Fixtures: the fictional 김하루's 2026 goals.
const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/pinboard", p), "utf8");
const MAIN = fx("2026/G-2026-01 사이드 프로젝트로 첫 매출 내기.md");
const SUB_M = fx("2026/G-2026-01.1 첫 유료 고객 1명.md");
const SUB_REV = fx("2026/G-2026-01.2 월 매출 100만원.md");
const SUB_RUN = fx("2026/G-2026-02.2 주 3회 달리기.md");
const SUB_NEWS = fx("2026/G-2026-03.1 뉴스레터 구독자 300명.md");
const INDEX = fx("Pinboard Index.md");
const TODAY = "2026-10-27";

function changed(a: string, b: string): [string, string][] {
	const x = a.split("\n");
	const y = b.split("\n");
	assert.equal(x.length, y.length, "same line count");
	return x.map((l, i) => [l, y[i]] as [string, string]).filter(([l, m]) => l !== m);
}

test("edit Sub Goal: card fields in frontmatter, H1, progress recomputed, updated", () => {
	const r = editGoalNote(SUB_RUN, "p/r.md", { title: "주 4회 달리기", target: "4", due: "2026-11-30" }, TODAY);
	assert.deepEqual(changed(SUB_RUN, r.text), [
		["title: 주 3회 달리기", "title: 주 4회 달리기"],
		["target: 3", "target: 4"],
		["due: 2026-12-31", "due: 2026-11-30"],
		["progress: 67", "progress: 50"],
		["updated: 2026-10-24", `updated: ${TODAY}`],
		["# 주 3회 달리기", "# 주 4회 달리기"],
	]);
	assert.equal(r.goal?.progress, 50);
});

test("edit Sub Goal: nothing changed → text unchanged; empty value clears the key; weight goes after due", () => {
	assert.equal(editGoalNote(SUB_RUN, "p/r.md", { title: "주 3회 달리기", target: "3", weight: "" }, TODAY).text, SUB_RUN);
	const r = editGoalNote(SUB_M, "p/m.md", { target: "", due: "2027-01-31" }, TODAY);
	assert.match(r.text, /^target:$/m);
	assert.match(r.text, /^due: 2027-01-31$/m);
	const r2 = editGoalNote(SUB_M, "p/m.md", { target: "첫 결제: 1건" }, TODAY);
	assert.match(r2.text, /^target: "첫 결제: 1건"$/m);
	assert.equal(parseGoal(parseFrontmatterText(r2.text).data, "p")?.target, "첫 결제: 1건");
	const w = editGoalNote(SUB_M, "p/m.md", { weight: "3" }, TODAY);
	assert.match(w.text, /^due:\nweight: 3\nprogress: 0$/m);
	assert.equal(w.goal?.weight, 3);
	assert.match(editGoalNote(SUB_REV, "p/v.md", { weight: "1" }, TODAY).text, /^weight: 1$/m);
});

test("edit Main Goal: title, area and the 왜 / 달성한 모습 sections", () => {
	const r = editGoalNote(MAIN, "p/main.md", { title: "사이드 프로젝트로 월 매출 내기", area: "사업", why: "회사 밖에서도 버틸 힘\n- 가족과 시간", vision: "매달 통장에 100" }, TODAY);
	assert.match(r.text, /^title: 사이드 프로젝트로 월 매출 내기$/m);
	assert.match(r.text, /^# 사이드 프로젝트로 월 매출 내기$/m);
	assert.match(r.text, /## 왜 이 목표인가\n- 회사 밖에서도 버틸 힘\n- 가족과 시간\n\n## 달성한 모습\n- 매달 통장에 100\n\n## Sub Goal/);
	assert.equal(sectionAsLines(r.text, WHY_SECTION), "회사 밖에서도 버틸 힘\n가족과 시간");
	assert.ok(r.text.endsWith(MAIN.slice(MAIN.indexOf("## Sub Goal"))));
});

test("panel change: current → progress recomputed, only those lines and updated change", () => {
	const r = applyGoalChange(SUB_REV, "p/v.md", { current: "380,000" }, TODAY);
	assert.deepEqual(changed(SUB_REV, r.text), [
		["current: 300000", "current: 380000"],
		["progress: 30", "progress: 38"],
		["updated: 2026-10-24", `updated: ${TODAY}`],
	]);
	assert.equal(r.before?.current, "300000");
	assert.equal(r.goal?.progress, 38);
	// not computable → progress kept
	const n = applyGoalChange(SUB_NEWS, "p/n.md", { current: "40" }, TODAY);
	assert.deepEqual(changed(SUB_NEWS, n.text), [
		["current:", "current: 40"],
		["updated: 2026-10-24", `updated: ${TODAY}`],
	]);
	// same value → nothing
	assert.equal(applyGoalChange(SUB_REV, "p/v.md", { current: "300000" }, TODAY).text, SUB_REV);
});

test("panel change: health set next to status, changed, cleared", () => {
	const add = applyGoalChange(SUB_M, "p/m.md", { health: "at-risk" }, TODAY);
	assert.match(add.text, /^status: active\nhealth: at-risk\nmeasure: milestone$/m);
	assert.equal(add.goal?.health, "at-risk");
	const ch = applyGoalChange(SUB_REV, "p/v.md", { health: "off-track" }, TODAY);
	assert.deepEqual(changed(SUB_REV, ch.text), [
		["health: on-track", "health: off-track"],
		["updated: 2026-10-24", `updated: ${TODAY}`],
	]);
	const clr = applyGoalChange(SUB_REV, "p/v.md", { health: "" }, TODAY);
	assert.match(clr.text, /^health:$/m);
	// empty health on a note without the key adds nothing
	assert.equal(applyGoalChange(SUB_M, "p/m.md", { health: "" }, TODAY).text, SUB_M);
	assert.equal(setFmValueAfter("---\na: 1\n---\n", "b", "", "a"), "---\na: 1\n---\n");
});

test("panel change: ending a goal (achieved / partial / missed) → progress, health cleared, 종료 회고 added", () => {
	const a = applyGoalChange(SUB_REV, "p/v.md", { status: "achieved" }, TODAY);
	assert.equal(a.goal?.status, "achieved");
	assert.equal(a.goal?.progress, 100);
	assert.equal(a.goal?.health, "");
	assert.match(a.text, /^health:$/m);
	assert.ok(a.text.endsWith("## 메모\n\n## 종료 회고\n- 결과: achieved\n- 영향: \n- 계획에서 벗어난 부분: \n- 이루지 못한 이유: \n"));
	const m = applyGoalChange(SUB_RUN, "p/r.md", { status: "missed" }, TODAY);
	assert.equal(m.goal?.progress, 67); // metric keeps its formula when not achieved
	assert.match(m.text, /- 결과: missed/);
	// an existing 종료 회고 keeps what the user wrote; only 결과 follows
	const twice = ensureRetro(ensureRetro(SUB_RUN, "partial").replace("- 영향: ", "- 영향: 체력이 늘었다"), "missed");
	assert.match(twice, /- 결과: missed\n- 영향: 체력이 늘었다\n/);
	assert.equal((twice.match(/## 종료 회고/g) ?? []).length, 1);
	// back to active: the retro stays as written
	assert.match(applyGoalChange(a.text, "p/v.md", { status: "active" }, TODAY).text, /## 종료 회고/);
});

test("panel change: update form = current + health + 진척 기록 line in one write", () => {
	const r = applyGoalChange(
		SUB_REV,
		"p/v.md",
		{ current: "380000", health: "at-risk", log: { date: TODAY, text: "유료 구독 38명", value: "380000", health: "at-risk", verify: "보고됨" } },
		TODAY,
	);
	assert.deepEqual(changed(SUB_REV, r.text.replace("\n- 2026-10-27: 유료 구독 38명 (value:: 380000) (health:: at-risk) (보고됨) — 근거: 사용자 보고 (대화, 2026-10-27)", "")), [
		["health: on-track", "health: at-risk"],
		["current: 300000", "current: 380000"],
		["progress: 30", "progress: 38"],
		["updated: 2026-10-24", `updated: ${TODAY}`],
	]);
	assert.ok(r.text.includes("(확인됨) — 근거: [[08 My Life/02 Weekly/2026/2026-W43]]\n- 2026-10-27: 유료 구독 38명 (value:: 380000)"));
});

test("links: rename and remove a Sub Goal's link line; Main rollup", () => {
	const renamed = renameLinks(MAIN, "G-2026-01.1 첫 유료 고객 1명", "G-2026-01.1 첫 유료 고객 3명");
	assert.match(renamed, /^- \[\[G-2026-01\.1 첫 유료 고객 3명\]\]$/m);
	assert.equal(renameLinks("[[a/G-1 x|별칭]] [[G-1 xy]]", "G-1 x", "G-1 z"), "[[a/G-1 z|별칭]] [[G-1 xy]]");
	const r = rollupMain([{ status: "active", measure: "metric", baseline: "0", current: "300000", target: "1000000", weight: 2 }]);
	assert.deepEqual(r, { subTotal: 1, subAchieved: 0, progress: 30 });
	const out = applyMainRollup(MAIN, r, TODAY, "G-2026-01.1 첫 유료 고객 1명");
	assert.ok(!out.includes("[[G-2026-01.1"));
	assert.ok(out.includes("- [[G-2026-01.2 월 매출 100만원]]"));
	assert.match(out, /^sub_total: 1$/m);
	assert.match(out, /^sub_achieved: 0$/m);
	assert.match(out, /^progress: 30$/m);
	assert.match(out, new RegExp(`^updated: ${TODAY}$`, "m"));
});

test("index: set title/due/path/health cells, remove rows and 미정 lines", () => {
	const r = setIndexCells(INDEX, "2026", [{ id: "G-2026-02.2", title: "주 4회 달리기", due: "2026-11-30", path: "0 → 2 → 4 회/주", health: "at-risk" }]);
	assert.deepEqual(r.missing, []);
	assert.deepEqual(changed(INDEX, r.text), [
		[
			"| G-2026-02.2 | sub | 주 3회 달리기 | G-2026-02 | active | on-track | 0 → 2 → 3 회/주 | 2026-12-31 | 67% | F-1 달리기 |",
			"| G-2026-02.2 | sub | 주 4회 달리기 | G-2026-02 | active | at-risk | 0 → 2 → 4 회/주 | 2026-11-30 | 67% | F-1 달리기 |",
		],
	]);
	const del = removeIndexRows(INDEX, "2026", ["G-2026-01.1", "G-2026-01"]);
	assert.deepEqual(del.removed, ["G-2026-01", "G-2026-01.1"]);
	assert.equal(del.text.split("\n").length, INDEX.split("\n").length - 2);
	assert.ok(del.text.includes("| G-2026-01.2 |"));
	const und = removeUndecidedLines(INDEX, ["G-2026-01.1"]);
	assert.ok(!und.includes("- G-2026-01.1: 기한"));
	assert.ok(und.includes("- G-2026-03.1: 지금 구독자 수"));
	assert.ok(und.includes("- 모든 수단:"));
});

test("진척 기록: list, edit and delete one entry", () => {
	const es = progressEntries(SUB_RUN);
	assert.deepEqual(es.map((e) => e.text), ["2026-10-20: 이번 주 2회 달림 (사용자 보고)"]);
	const ed = editProgressEntry(SUB_RUN, es[0], "2026-10-20: 이번 주 2회 달림 (value:: 2) (보고됨) — 근거: 사용자 보고 (대화, 2026-10-20)");
	assert.ok(ed.ok);
	assert.deepEqual(changed(SUB_RUN, ed.text), [["- 2026-10-20: 이번 주 2회 달림 (사용자 보고)", "- 2026-10-20: 이번 주 2회 달림 (value:: 2) (보고됨) — 근거: 사용자 보고 (대화, 2026-10-20)"]]);
	const del = deleteProgressEntry(SUB_RUN, es[0]);
	assert.ok(del.ok);
	assert.equal(del.text, SUB_RUN.replace("- 2026-10-20: 이번 주 2회 달림 (사용자 보고)\n", ""));
	assert.deepEqual(deleteProgressEntry(del.text, es[0]), { ok: false, reason: "not-found" });
	assert.deepEqual(editProgressEntry(SUB_RUN, es[0], " "), { ok: false, reason: "empty-text" });
	assert.deepEqual(progressEntries(SUB_M), []); // the template comment is not an entry
	assert.equal(progressEntries(SUB_REV).length, 2);
});

// ───────────────────────── 프로젝트 연결 (Pinboard 「3-6」, both sides) ─────────────────────────

test("project link, Sub Goal side: add and remove (projects + project_ids), idempotent", () => {
	const hub = "[[05 Project Folders/회사/분기 보고서 자동화/분기 보고서 자동화]]";
	const a = linkProject(SUB_M, "P-report", hub, TODAY);
	assert.deepEqual(getFmList(a, "project_ids"), ["P-report"]);
	assert.deepEqual(getFmList(a, "projects"), [hub]);
	assert.match(a, /^projects:\n {2}- "\[\[05 Project Folders\/회사\/분기 보고서 자동화\/분기 보고서 자동화\]\]"$/m);
	assert.match(a, new RegExp(`^updated: ${TODAY}$`, "m"));
	assert.equal(linkProject(a, "P-report", hub, TODAY), a);
	const b = unlinkProject(a, "P-report", "분기 보고서 자동화", TODAY);
	assert.deepEqual(getFmList(b, "project_ids"), []);
	assert.deepEqual(getFmList(b, "projects"), []);
	assert.equal(unlinkProject(SUB_M, "P-none", "없음", TODAY), SUB_M);
	// a second project keeps the first
	const two = linkProject(SUB_REV, "P-report", hub, TODAY);
	assert.deepEqual(getFmList(two, "project_ids"), ["P-newsletter", "P-report"]);
	assert.deepEqual(getFmList(unlinkProject(two, "P-newsletter", "뉴스레터 창간", TODAY), "projects"), [hub]);
});

test("project link, hub side: goals add / remove, updated, idempotent; 「3-4」 record texts", () => {
	const hub = "---\ntype: project\nid: P-newsletter\ntitle: 뉴스레터 창간\ngoals: []\nupdated: 2026-10-20\n---\n\n# 뉴스레터 창간\n";
	const a = hubGoalsLinked(hub, "G-2026-01.2", true, TODAY);
	assert.deepEqual(getFmList(a, "goals"), ["G-2026-01.2"]);
	assert.match(a, new RegExp(`^updated: ${TODAY}$`, "m"));
	assert.equal(hubGoalsLinked(a, "G-2026-01.2", true, TODAY), a);
	const b = hubGoalsLinked(hubGoalsLinked(a, "G-2026-03.1", true, TODAY), "G-2026-01.2", false, TODAY);
	assert.deepEqual(getFmList(b, "goals"), ["G-2026-03.1"]);
	assert.equal(hubGoalsLinked(hub, "G-2026-01.2", false, TODAY), hub);
	const t = goalLinkTexts({ id: "P-newsletter" }, "G-2026-01.2", true, ["G-2026-01.2"], "1호 발송", TODAY);
	assert.equal(t.recent, "목표 연결: G-2026-01.2");
	assert.match(t.change, /^P-newsletter 목표 연결: G-2026-01\.2/);
	assert.equal(t.entry.result, "goals: G-2026-01.2");
	assert.equal(t.entry.next, "1호 발송");
	assert.equal(goalLinkTexts({ id: "P-newsletter" }, "G-2026-01.2", false, [], "", TODAY).entry.result, "goals: 없음");
});
