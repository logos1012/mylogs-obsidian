import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { activeCount, columns, daysSinceReview, findDuplicate, goalIdOf, isNew, isStale, parseDrawer, splitSources } from "../src/drawer/model.ts";
import {
	appendToDrawerSection,
	deleteItem,
	destinationLine,
	drawerTemplate,
	editItem,
	formatContextLine,
	formatItemLine,
	logEntry,
	logLine,
	markLetGo,
	markTakenOut,
	moveItem,
	putItem,
	refOf,
	touchReviewed,
} from "../src/drawer/ops.ts";
import { defaultSection, extractCandidates, removeCandidate } from "../src/drawer/candidates.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/drawer", p), "utf8");
const DRAWER = fx("Drawer.md");
const PAD = fx("daily-2026-10-25.md");
const TODAY = "2026-10-25";

/** Replace exactly one occurrence (asserting it exists once) — builds the expected text. */
function rep(text: string, from: string, to: string): string {
	assert.equal(text.split(from).length, 2, `exactly one "${from}"`);
	return text.replace(from, to);
}
const UPD = (t: string) => rep(t, "updated: 2026-10-20\n", `updated: ${TODAY}\n`);
const LOG = (t: string, entry: string) => rep(t, "→ [[04 Daily Pad/2026/2026-10-20]]\n", `→ [[04 Daily Pad/2026/2026-10-20]]\n- ${TODAY}: ${entry}\n`);
const item = (text: string, src = DRAWER) => {
	const it = parseDrawer(src).items.find((i) => i.text === text);
	assert.ok(it, `item "${text}"`);
	return it!;
};
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
	assert.ok(r.ok, JSON.stringify(r));
	return r as Extract<T, { ok: true }>;
}

// ───────────────────────── parsing ─────────────────────────

test("parseDrawer: sections, fields, 맥락, from sources, departed lines, 변경 기록", () => {
	const d = parseDrawer(DRAWER);
	assert.equal(d.updated, "2026-10-20");
	assert.deepEqual(d.sections, { 보류: true, 아이디어: true, "프로젝트 후보": true });
	assert.deepEqual(
		d.items.map((i) => [i.section, i.text, i.status]),
		[
			["보류", "강의 자막 다시 다듬기", "scheduled"],
			["보류", "책장 정리", "scheduled"],
			["보류", "블로그 글 하나 쓰기", "moved"],
			["아이디어", "자동 자막 생성 스크립트", "scheduled"],
			["아이디어", "뉴스레터 시작", "cancelled"],
			["프로젝트 후보", "혼팀 숏폼 파이프라인", "scheduled"],
		],
	);
	const a = item("강의 자막 다시 다듬기");
	assert.equal(a.when, "강의 첫 판매 후");
	assert.deepEqual(a.from, ["대화 2026-10-10"]);
	assert.equal(a.added, "2026-10-10");
	assert.equal(a.reviewed, "2026-10-10");
	assert.equal(a.index, 7);
	assert.deepEqual(a.context, { index: 8, line: "  - 맥락: 자동 자막 오타가 많았다", text: "자동 자막 오타가 많았다" });
	assert.deepEqual(a.subLines, [8]);
	assert.equal(a.test, true);
	assert.deepEqual(a.tags, []);
	assert.deepEqual(a.problems, []);

	const p = item("혼팀 숏폼 파이프라인");
	assert.deepEqual(p.from, ["[[10 Archive Box/Sessions/2026-10-01 혼팀]]", "[[10 Archive Box/Sessions/2026-10-08 혼팀]]", "[[10 Archive Box/Sessions/2026-10-14 혼팀]]"]);
	assert.equal(p.context, null);

	assert.equal(item("블로그 글 하나 쓰기").movedTo, "2026-10-20");
	assert.equal(item("뉴스레터 시작").why, "인스타에 집중");
	assert.equal(d.hasChangelog, true);
	assert.deepEqual(d.changelog, [
		"- 2026-10-01: 넣음 「혼팀 숏폼 파이프라인」 (from:: [[10 Archive Box/Sessions/2026-10-01 혼팀]])",
		"- 2026-10-20: 꺼냄 「블로그 글 하나 쓰기」 → [[04 Daily Pad/2026/2026-10-20]]",
	]);
});

test("parseDrawer: problems for lines missing when/added/reviewed or using a date as when", () => {
	const d = parseDrawer("---\ntype: drawer\n---\n# Drawer\n\n## 보류\n- [ ] 조건 없음\n- [ ] 날짜 조건 (when:: 2026-12) (added:: 2026-10-01) (reviewed:: 2026-10-01)\n- 메모 줄\n");
	assert.equal(d.items.length, 3);
	assert.deepEqual(d.items[0].problems, ["when:: 조건이 없어요", "added:: 날짜가 없어요", "reviewed:: 날짜가 없어요"]);
	assert.deepEqual(d.items[1].problems, ["when::에 날짜를 쓰지 않아요 (Drawer는 달력이 아니에요)"]);
	assert.ok(d.items[2].problems.includes("Drawer 항목은 체크박스 줄이어야 해요"));
	assert.equal(d.hasChangelog, false);
});

test("splitSources: commas inside [[ ]] are not separators", () => {
	assert.deepEqual(splitSources("[[a, b]], 대화 2026-10-01, [[c]]"), ["[[a, b]]", "대화 2026-10-01", "[[c]]"]);
	assert.deepEqual(splitSources(""), []);
});

test("drawerTemplate parses to three empty sections and a 변경 기록", () => {
	const d = parseDrawer(drawerTemplate(TODAY));
	assert.deepEqual(d.sections, { 보류: true, 아이디어: true, "프로젝트 후보": true });
	assert.equal(d.items.length, 0);
	assert.deepEqual(d.changelog, [`- ${TODAY}: 파일 생성 (플러그인)`]);
	assert.equal(d.updated, TODAY);
});

// ───────────────────────── lifecycle ─────────────────────────

test("lifecycle: 새로 들어옴 (added this month), 오래됨 (reviewed ≥ 90 days), goal id when", () => {
	assert.equal(isNew(item("강의 자막 다시 다듬기"), TODAY), true);
	assert.equal(isNew(item("책장 정리"), TODAY), false);
	assert.equal(daysSinceReview(item("책장 정리"), TODAY), 115);
	assert.equal(isStale(item("책장 정리"), TODAY), true);
	assert.equal(isStale(item("강의 자막 다시 다듬기"), TODAY), false);
	// departed lines are never "stale"
	assert.equal(isStale(item("뉴스레터 시작"), TODAY), false);
	assert.equal(isStale({ reviewed: "2026-07-27", added: "", status: "scheduled" }, TODAY), true);
	assert.equal(isStale({ reviewed: "2026-07-28", added: "", status: "scheduled" }, TODAY), false);
	assert.equal(goalIdOf("G-2026-02.1"), "G-2026-02.1");
	assert.equal(goalIdOf("G-2026-02"), "G-2026-02");
	assert.equal(goalIdOf("강의 첫 판매 후"), null);
	assert.equal(goalIdOf("G-2026-02.1 달성 시"), null);
});

test("columns: active first, departed at the bottom; duplicates by text", () => {
	const d = parseDrawer(DRAWER);
	const cols = columns(d);
	assert.deepEqual(
		cols.map((c) => [c.section, c.active.map((i) => i.text), c.departed.map((i) => i.text)]),
		[
			["보류", ["강의 자막 다시 다듬기", "책장 정리"], ["블로그 글 하나 쓰기"]],
			["아이디어", ["자동 자막 생성 스크립트"], ["뉴스레터 시작"]],
			["프로젝트 후보", ["혼팀 숏폼 파이프라인"], []],
		],
	);
	assert.equal(activeCount(d), 4);
	assert.equal(findDuplicate(d, "자동자막 생성  스크립트")?.text, "자동 자막 생성 스크립트");
	// a departed line with the same text is not a duplicate (it is gone)
	assert.equal(findDuplicate(d, "뉴스레터 시작"), null);
});

// ───────────────────────── formatting ─────────────────────────

test("formatItemLine / formatContextLine / destinationLine / 변경 기록 formats", () => {
	assert.equal(
		formatItemLine({ text: " 영어  회화 앱 ", when: "강의 첫 판매 후", from: ["대화 2026-10-24"], section: "보류", test: true }, TODAY),
		`- [ ] 영어 회화 앱 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-24) (added:: ${TODAY}) (reviewed:: ${TODAY}) #test`,
	);
	assert.equal(formatItemLine({ text: "x", when: "", from: [], section: "보류" }, TODAY), `- [ ] x (when:: 미정) (added:: ${TODAY}) (reviewed:: ${TODAY})`);
	assert.equal(formatItemLine({ text: "x", when: "(괄호) 제거", from: [], section: "보류", tags: ["회사"] }, TODAY), `- [ ] x (when:: 괄호 제거) (added:: ${TODAY}) (reviewed:: ${TODAY}) #회사`);
	assert.equal(formatContextLine("왜 넣었나\n두 줄"), "  - 맥락: 왜 넣었나 두 줄");
	assert.equal(destinationLine(item("책장 정리")), "- [ ] 책장 정리 (from:: Drawer) (goal:: G-2026-02.1) #test");
	assert.equal(destinationLine(item("강의 자막 다시 다듬기")), "- [ ] 강의 자막 다시 다듬기 (from:: Drawer) #test");
	assert.equal(destinationLine({ text: "회사 일", when: "미정", tags: ["회사"], test: false }), "- [ ] 회사 일 (from:: Drawer) #회사");
	assert.equal(logLine(TODAY, logEntry.put("내용", ["대화 2026-10-25"])), `- ${TODAY}: 넣음 「내용」 (from:: 대화 2026-10-25)`);
	assert.equal(logLine(TODAY, logEntry.put("내용", [])), `- ${TODAY}: 넣음 「내용」`);
	assert.equal(logLine(TODAY, logEntry.move("내용", "보류", "아이디어")), `- ${TODAY}: 옮김 「내용」 보류 → 아이디어`);
	assert.equal(logLine(TODAY, logEntry.take("내용", "[[04 Daily Pad/2026/2026-10-25]]")), `- ${TODAY}: 꺼냄 「내용」 → [[04 Daily Pad/2026/2026-10-25]]`);
	assert.equal(logLine(TODAY, logEntry.letGo("내용", "지금 (목표)와 관계없음")), `- ${TODAY}: 놓아줌 「내용」 (why:: 지금 목표와 관계없음)`);
	assert.equal(logLine(TODAY, logEntry.remove("내용")), `- ${TODAY}: 삭제 「내용」`);
});

// ───────────────────────── 「4-1」 넣기 ─────────────────────────

test("putItem: appended at the section end, 맥락 below, one 변경 기록 line, updated", () => {
	const r = ok(putItem(DRAWER, { text: "영어 회화 앱 다시 써 보기", when: "강의 첫 판매 후", from: ["대화 2026-10-24"], section: "보류", context: "덕분에 영어가 늘었다", test: true }, TODAY));
	assert.equal(r.merged, false);
	let exp = rep(
		DRAWER,
		"→ [[04 Daily Pad/2026/2026-10-20]] #test\n",
		`→ [[04 Daily Pad/2026/2026-10-20]] #test\n- [ ] 영어 회화 앱 다시 써 보기 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-24) (added:: ${TODAY}) (reviewed:: ${TODAY}) #test\n  - 맥락: 덕분에 영어가 늘었다\n`,
	);
	exp = LOG(UPD(exp), "넣음 「영어 회화 앱 다시 써 보기」 (from:: 대화 2026-10-24)");
	assert.equal(r.text, exp);
	const d = parseDrawer(r.text);
	assert.equal(d.items.filter((i) => i.section === "보류").length, 4);
	assert.equal(d.changelog.length, 3);
});

test("putItem: into an empty section of a fresh file (blank line kept before the next heading)", () => {
	const base = drawerTemplate(TODAY);
	const r = ok(putItem(base, { text: "첫 항목", when: "미정", from: [], section: "아이디어" }, TODAY));
	assert.equal(
		r.text,
		`---\ntype: drawer\nupdated: ${TODAY}\n---\n# Drawer\n\n## 보류\n\n## 아이디어\n- [ ] 첫 항목 (when:: 미정) (added:: ${TODAY}) (reviewed:: ${TODAY})\n\n## 프로젝트 후보\n\n## 변경 기록\n\n- ${TODAY}: 파일 생성 (플러그인)\n- ${TODAY}: 넣음 「첫 항목」\n`,
	);
	assert.deepEqual(parseDrawer(r.text).items.map((i) => [i.section, i.text]), [["아이디어", "첫 항목"]]);
});

test("putItem: same text → merge from:: and refresh reviewed, nothing added (「4-1」 2)", () => {
	const r = ok(putItem(DRAWER, { text: "자동 자막 생성 스크립트", when: "", from: ["[[10 Archive Box/Sessions/2026-10-24 자막]]", "대화 2026-10-15"], section: "보류" }, TODAY));
	assert.equal(r.merged, true);
	if (r.merged) assert.equal(r.into.text, "자동 자막 생성 스크립트");
	let exp = rep(
		DRAWER,
		"(from:: [[10 Archive Box/Sessions/2026-10-12 자막]], 대화 2026-10-15) (added:: 2026-10-12) (reviewed:: 2026-10-15) #test",
		`(from:: [[10 Archive Box/Sessions/2026-10-12 자막]], 대화 2026-10-15, [[10 Archive Box/Sessions/2026-10-24 자막]]) (added:: 2026-10-12) (reviewed:: ${TODAY}) #test`,
	);
	exp = LOG(UPD(exp), "넣음 「자동 자막 생성 스크립트」 (from:: [[10 Archive Box/Sessions/2026-10-24 자막]])");
	assert.equal(r.text, exp);
	assert.equal(parseDrawer(r.text).items.length, 6);
});

test("putItem: empty text fails; missing section heading is created in order", () => {
	assert.equal(putItem(DRAWER, { text: "  ", when: "x", from: [], section: "보류" }, TODAY).ok, false);
	const noIdea = "---\ntype: drawer\nupdated: 2026-10-20\n---\n# Drawer\n\n## 보류\n- [ ] a (when:: x) (added:: 2026-10-01) (reviewed:: 2026-10-01)\n\n## 변경 기록\n- 2026-10-01: 넣음 「a」\n";
	const r = ok(putItem(noIdea, { text: "b", when: "y", from: [], section: "아이디어" }, TODAY));
	assert.equal(
		r.text,
		`---\ntype: drawer\nupdated: ${TODAY}\n---\n# Drawer\n\n## 보류\n- [ ] a (when:: x) (added:: 2026-10-01) (reviewed:: 2026-10-01)\n\n## 아이디어\n- [ ] b (when:: y) (added:: ${TODAY}) (reviewed:: ${TODAY})\n\n## 변경 기록\n- 2026-10-01: 넣음 「a」\n- ${TODAY}: 넣음 「b」\n`,
	);
});

test("appendToDrawerSection: after the last line even when blank lines trail the section", () => {
	const t = "---\ntype: drawer\nupdated: 2026-10-20\n---\n## 보류\n- [ ] a\n\n\n## 아이디어\n";
	assert.equal(appendToDrawerSection(t, "보류", ["- [ ] b"]), "---\ntype: drawer\nupdated: 2026-10-20\n---\n## 보류\n- [ ] a\n- [ ] b\n\n\n## 아이디어\n");
});

// ───────────────────────── 「4-2」 옮김 ─────────────────────────

test("moveItem: line and its 맥락 move to the end of the other section; reviewed today; 옮김 logged", () => {
	const it = item("강의 자막 다시 다듬기");
	const r = ok(moveItem(DRAWER, refOf(it), "아이디어", TODAY));
	let exp = rep(DRAWER, "- [ ] 강의 자막 다시 다듬기 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-10) (added:: 2026-10-10) (reviewed:: 2026-10-10) #test\n  - 맥락: 자동 자막 오타가 많았다\n", "");
	exp = rep(
		exp,
		"(why:: 인스타에 집중) #test\n",
		`(why:: 인스타에 집중) #test\n- [ ] 강의 자막 다시 다듬기 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-10) (added:: 2026-10-10) (reviewed:: ${TODAY}) #test\n  - 맥락: 자동 자막 오타가 많았다\n`,
	);
	exp = LOG(UPD(exp), "옮김 「강의 자막 다시 다듬기」 보류 → 아이디어");
	assert.equal(r.text, exp);
	const moved = item("강의 자막 다시 다듬기", r.text);
	assert.equal(moved.section, "아이디어");
	assert.equal(moved.context?.text, "자동 자막 오타가 많았다");
	assert.equal(moveItem(DRAWER, refOf(it), "보류", TODAY).ok, false);
});

test("moveItem: a stale ref (line changed) fails instead of guessing", () => {
	const it = item("책장 정리");
	const r = moveItem(DRAWER, { ...refOf(it), line: it.line.replace("책장", "책상") }, "아이디어", TODAY);
	assert.deepEqual(r, { ok: false, reason: "line-changed" });
});

// ───────────────────────── 「4-3」 꺼냄 ─────────────────────────

test("markTakenOut: [>] … → [[dest]] before the tags, not deleted; 꺼냄 logged", () => {
	const it = item("책장 정리");
	const dest = "[[03 Desk Calendar/2026/2026-10]]";
	const r = ok(markTakenOut(DRAWER, refOf(it), dest, TODAY));
	let exp = rep(
		DRAWER,
		"- [ ] 책장 정리 (when:: G-2026-02.1) (from:: Desk Calendar 2026-07-02) (added:: 2026-07-02) (reviewed:: 2026-07-02) #test",
		`- [>] 책장 정리 (when:: G-2026-02.1) (from:: Desk Calendar 2026-07-02) (added:: 2026-07-02) (reviewed:: 2026-07-02) → ${dest} #test`,
	);
	exp = LOG(UPD(exp), `꺼냄 「책장 정리」 → ${dest}`);
	assert.equal(r.text, exp);
	const after = item("책장 정리", r.text);
	assert.equal(after.status, "moved");
	assert.equal(after.movedTo, "2026-10");
	assert.equal(after.when, "G-2026-02.1");
	// departed lines can't be taken out again
	assert.deepEqual(markTakenOut(r.text, refOf(after), dest, TODAY), { ok: false, reason: "not-active" });
});

// ───────────────────────── 「4-4」 놓아줌 ─────────────────────────

test("markLetGo: [-] … (why::) after the fields, before the tags; 놓아줌 logged", () => {
	const it = item("혼팀 숏폼 파이프라인");
	const r = ok(markLetGo(DRAWER, refOf(it), "릴스를 (아직) 안 올림", TODAY));
	let exp = rep(DRAWER, "- [ ] 혼팀 숏폼 파이프라인 (when:: 릴스 10개 올린 뒤)", "- [-] 혼팀 숏폼 파이프라인 (when:: 릴스 10개 올린 뒤)");
	exp = rep(exp, "(added:: 2026-10-01) (reviewed:: 2026-10-14) #test", "(added:: 2026-10-01) (reviewed:: 2026-10-14) (why:: 릴스를 아직 안 올림) #test");
	exp = LOG(UPD(exp), "놓아줌 「혼팀 숏폼 파이프라인」 (why:: 릴스를 아직 안 올림)");
	assert.equal(r.text, exp);
	const after = item("혼팀 숏폼 파이프라인", r.text);
	assert.equal(after.status, "cancelled");
	assert.equal(after.why, "릴스를 아직 안 올림");
	assert.deepEqual(markLetGo(DRAWER, refOf(it), "  ", TODAY), { ok: false, reason: "empty-why" });
});

// ───────────────────────── 「4-5」 수정 · 삭제 ─────────────────────────

test("editItem: text, when and 맥락 in place; reviewed today; no 변경 기록 line", () => {
	const it = item("강의 자막 다시 다듬기");
	const r = ok(editItem(DRAWER, refOf(it), { text: "강의 자막 전체 다듬기", when: "강의 두 번째 판매 후", context: "자동 자막 오타가 많았다. 2강부터" }, TODAY));
	let exp = rep(
		DRAWER,
		"- [ ] 강의 자막 다시 다듬기 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-10) (added:: 2026-10-10) (reviewed:: 2026-10-10) #test\n  - 맥락: 자동 자막 오타가 많았다\n",
		`- [ ] 강의 자막 전체 다듬기 (when:: 강의 두 번째 판매 후) (from:: 대화 2026-10-10) (added:: 2026-10-10) (reviewed:: ${TODAY}) #test\n  - 맥락: 자동 자막 오타가 많았다. 2강부터\n`,
	);
	exp = UPD(exp);
	assert.equal(r.text, exp);
	assert.equal(parseDrawer(r.text).changelog.length, 2);
});

test("editItem: add a 맥락 where there was none, remove one with \"\"", () => {
	const add = ok(editItem(DRAWER, refOf(item("책장 정리")), { context: "거실 책장" }, TODAY));
	assert.ok(add.text.includes(`(reviewed:: ${TODAY}) #test\n  - 맥락: 거실 책장\n- [>] 블로그 글 하나 쓰기`));
	assert.equal(item("책장 정리", add.text).context?.text, "거실 책장");
	const rm = ok(editItem(DRAWER, refOf(item("강의 자막 다시 다듬기")), { context: "" }, TODAY));
	assert.ok(!rm.text.includes("맥락"));
	assert.equal(item("강의 자막 다시 다듬기", rm.text).context, null);
	assert.equal(editItem(DRAWER, refOf(item("책장 정리")), { text: " " }, TODAY).ok, false);
});

test("editItem: a section change moves the block and logs 옮김", () => {
	const it = item("자동 자막 생성 스크립트");
	const r = ok(editItem(DRAWER, refOf(it), { section: "프로젝트 후보", when: "강의 3개" }, TODAY));
	const after = item("자동 자막 생성 스크립트", r.text);
	assert.equal(after.section, "프로젝트 후보");
	assert.equal(after.when, "강의 3개");
	assert.equal(after.reviewed, TODAY);
	assert.ok(after.index > item("혼팀 숏폼 파이프라인", r.text).index);
	const log = parseDrawer(r.text).changelog;
	assert.equal(log[log.length - 1], `- ${TODAY}: 옮김 「자동 자막 생성 스크립트」 아이디어 → 프로젝트 후보`);
	assert.equal(log.length, 3);
});

test("deleteItem: the line and its 맥락 go; 삭제 logged", () => {
	const r = ok(deleteItem(DRAWER, refOf(item("강의 자막 다시 다듬기")), TODAY));
	let exp = rep(DRAWER, "- [ ] 강의 자막 다시 다듬기 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-10) (added:: 2026-10-10) (reviewed:: 2026-10-10) #test\n  - 맥락: 자동 자막 오타가 많았다\n", "");
	exp = LOG(UPD(exp), "삭제 「강의 자막 다시 다듬기」");
	assert.equal(r.text, exp);
	assert.equal(parseDrawer(r.text).items.length, 5);
});

test("touchReviewed: only reviewed and updated change", () => {
	const r = ok(touchReviewed(DRAWER, refOf(item("책장 정리")), TODAY));
	assert.equal(r.text, UPD(rep(DRAWER, "(added:: 2026-07-02) (reviewed:: 2026-07-02)", `(added:: 2026-07-02) (reviewed:: ${TODAY})`)));
});

// ───────────────────────── 후보 (Daily Pad ## 결정 대기) ─────────────────────────

test("extractCandidates: only #서랍후보 / #프로젝트후보 open tasks; when, from, kind", () => {
	const c = extractCandidates(PAD);
	assert.deepEqual(
		c.map((x) => [x.kind, x.text, x.when, x.from.length, x.test]),
		[
			["drawer", "영어 회화 앱 다시 써 보기", "강의 첫 판매 후", 1, true],
			["drawer", "자동 자막 생성 스크립트", "", 1, true],
			["project", "MyLogs 플러그인", "0.5 릴리스 후", 3, true],
		],
	);
	assert.deepEqual(c[0].tags, []);
	assert.equal(c[0].index, 15);
	assert.equal(c[0].line, "- [ ] 영어 회화 앱 다시 써 보기 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-24) #서랍후보 #test");
	assert.deepEqual(c[2].from, ["[[10 Archive Box/Sessions/2026-10-22 플러그인]]", "[[10 Archive Box/Sessions/2026-10-23 플러그인]]", "[[10 Archive Box/Sessions/2026-10-24 플러그인]]"]);
	assert.equal(defaultSection("drawer"), "보류");
	assert.equal(defaultSection("project"), "프로젝트 후보");
	assert.deepEqual(extractCandidates(PAD.replace("## 결정 대기", "## 결정대기")), []);
});

test("removeCandidate: the line leaves ## 결정 대기; other lines stay; updated set", () => {
	const c = extractCandidates(PAD)[0];
	const r = ok(removeCandidate(PAD, c, TODAY));
	assert.equal(r.sectionRemoved, false);
	const exp = rep(rep(PAD, "- [ ] 영어 회화 앱 다시 써 보기 (when:: 강의 첫 판매 후) (from:: 대화 2026-10-24) #서랍후보 #test\n", ""), "updated: 2026-10-24\n", `updated: ${TODAY}\n`);
	assert.equal(r.text, exp);
	assert.equal(extractCandidates(r.text).length, 2);
	assert.deepEqual(removeCandidate(PAD, { ...c, line: c.line + " x" }, TODAY), { ok: false, reason: "line-changed" });
});

test("removeCandidate: the section goes when it becomes empty (「3-6」 5)", () => {
	const pad = "---\ntype: daily-pad\nupdated: 2026-10-24\n---\n\n# 2026-10-25 (일)\n\n![[03 Desk Calendar/2026/2026-10#2026-10-25]]\n\n## 결정 대기\n- [ ] 하나뿐 (when:: x) (from:: 대화 2026-10-24) #서랍후보\n  - 맥락: 메모\n\n## 오늘 할 일\n\n## 메모\n";
	const c = extractCandidates(pad)[0];
	const r = ok(removeCandidate(pad, c, TODAY));
	assert.equal(r.sectionRemoved, true);
	assert.equal(r.text, `---\ntype: daily-pad\nupdated: ${TODAY}\n---\n\n# 2026-10-25 (일)\n\n![[03 Desk Calendar/2026/2026-10#2026-10-25]]\n\n## 오늘 할 일\n\n## 메모\n`);
	// last section of the file
	const tail = "---\nupdated: 2026-10-24\n---\n# x\n\n## 메모\n- a\n\n## 결정 대기\n- [ ] 하나뿐 #프로젝트후보\n";
	const r2 = ok(removeCandidate(tail, extractCandidates(tail)[0], TODAY));
	assert.equal(r2.text, `---\nupdated: ${TODAY}\n---\n# x\n\n## 메모\n- a\n`);
});
