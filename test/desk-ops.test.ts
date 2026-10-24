import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dayIndex, type DeskItem, findPairAlloc, type MonthData, parseMonthFile } from "../src/desk/model.ts";
import {
	addDateAssign,
	addWeekAssign,
	appendUnderWallMonth,
	copyTask,
	markCancelled,
	markMoved,
	movedCount,
	pairedCopies,
	planAssignDay,
	planAssignWeek,
	planCancelEvent,
	planDelete,
	planEdit,
	planDrawer,
	planFuture,
	planLetGo,
	planMoveDay,
	planSplit,
	planToggle,
	planUnassign,
	prependChangeLog,
	removeDateAssign,
	removeWeekAssign,
	replaceDateAssign,
	runPlan,
	wallYearSkeleton,
} from "../src/desk/ops.ts";
import { drawerTemplate } from "../src/drawer/ops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/desk", p), "utf8");
const OCT = fx("2026-10.md");
const NOV = fx("2026-11.md");
const TODAY = "2026-10-25";

function load(oct = OCT, nov = NOV): { oct: MonthData; nov: MonthData; months: MonthData[] } {
	const o = parseMonthFile(oct, 2026, 10);
	const n = parseMonthFile(nov, 2026, 11);
	return { oct: o, nov: n, months: [o, n] };
}

function duringItem(d: MonthData, text: string): DeskItem {
	return d.during.find((x) => x.item.text === text)!;
}
function allocItem(d: MonthData, monday: string, text: string): DeskItem {
	return d.weeks.get(monday)!.alloc!.find((x) => x.item.text === text)!;
}
function dayItem(d: MonthData, date: string, text: string): DeskItem {
	return d.days.get(date)!.find((x) => x.item.text === text)!;
}

/** Replace exactly one occurrence (asserting it exists once) — builds the expected text. */
function rep(text: string, from: string, to: string): string {
	assert.equal(text.split(from).length, 2, `exactly one "${from}"`);
	return text.replace(from, to);
}

const UPD = (t: string) => rep(t, "updated: 2026-10-24\n", `updated: ${TODAY}\n`);

function run(plan: ReturnType<typeof planAssignWeek>, files: Record<string, string | undefined>) {
	const r = runPlan(plan, files);
	assert.ok(r.ok, JSON.stringify(r));
	return r.files;
}

// ───────────────────────── line transforms ─────────────────────────

test("line transforms keep tags/fields at the end", () => {
	assert.equal(addWeekAssign("- [ ] 부모님 선물 고르기 #test", 44), "- [ ] 부모님 선물 고르기 → W44 #test");
	assert.equal(addWeekAssign("- [ ] 연말정산 서류 미리 모으기 → W44 #test", 45), "- [ ] 연말정산 서류 미리 모으기 → W44, W45 #test");
	assert.equal(addWeekAssign("- [ ] 연말정산 → W44 #test", 44), "- [ ] 연말정산 → W44 #test");
	assert.equal(addWeekAssign("- [ ] 기획안 (goal:: G-2026-03.1) #test", 45), "- [ ] 기획안 → W45 (goal:: G-2026-03.1) #test");
	assert.equal(addDateAssign("- [ ] 릴스 → 10/30 (goal:: G) #test", "2026-10-27"), "- [ ] 릴스 → 10/27, 10/30 (goal:: G) #test");
	assert.equal(addDateAssign("- [ ] 출장 자료 #회사 #test", "2026-10-25"), "- [ ] 출장 자료 → 10/25 #회사 #test");
	assert.equal(addDateAssign("- [ ] 연말 → 12/30", "2027-01-02"), "- [ ] 연말 → 12/30, 01/02");
	assert.equal(removeDateAssign("- [ ] 릴스 → 10/27, 10/30 #test", "2026-10-27"), "- [ ] 릴스 → 10/30 #test");
	assert.equal(removeDateAssign("- [ ] 강의 → 10/28 (goal:: G) #test", "2026-10-28"), "- [ ] 강의 (goal:: G) #test");
	assert.equal(replaceDateAssign("- [ ] 운동 → 10/20, 10/22, 10/24 #test", "2026-10-24", "2026-10-21"), "- [ ] 운동 → 10/20, 10/21, 10/22 #test");
	assert.equal(copyTask("- [x] 강의 1강 촬영 → 10/06 (goal:: G-2026-01.2) #test"), "- [ ] 강의 1강 촬영 (goal:: G-2026-01.2) #test");
	assert.equal(copyTask("- [ ] 연말정산 서류 미리 모으기 → W44 #test"), "- [ ] 연말정산 서류 미리 모으기 #test");
	assert.equal(copyTask("- [ ] 10:00 회의 준비 #회사", 1), "- [ ] 10:00 회의 준비 (moved:: 1) #회사");
	assert.equal(markCancelled("- [ ] 신규 앱 체험해 보기 #test", "지금 목표와 (관계)없음\n"), "- [-] 신규 앱 체험해 보기 (why:: 지금 목표와 관계없음) #test");
});

test("moved counter: 0 → 1 → 2 → 3, in place", () => {
	let line = "- [ ] 은행 서류 제출 #test";
	assert.equal(movedCount(line), 0);
	line = markMoved(line, "10/27", movedCount(line) + 1);
	assert.equal(line, "- [>] 은행 서류 제출 → 10/27 (moved:: 1) #test");
	let copy = copyTask("- [ ] 은행 서류 제출 #test", 1);
	assert.equal(copy, "- [ ] 은행 서류 제출 (moved:: 1) #test");
	assert.equal(movedCount(copy), 1);
	assert.equal(markMoved(copy, "10/28", movedCount(copy) + 1), "- [>] 은행 서류 제출 → 10/28 (moved:: 2) #test");
	copy = copyTask(copy, movedCount(copy) + 1);
	assert.equal(copy, "- [ ] 은행 서류 제출 (moved:: 2) #test");
	assert.equal(markMoved(copy, "Wall Calendar", 3), "- [>] 은행 서류 제출 → Wall Calendar (moved:: 3) #test");
});

// ───────────────────────── DnD 1: 이달 중 → 이번 주 할 일 ─────────────────────────

test("DnD 1: 이달 중 item onto W44 adds → W44 and copies under ### 이번 주", () => {
	const { oct } = load();
	const plan = planAssignWeek(duringItem(oct, "부모님 선물 고르기"), "2026-10-26", 44, "2026-10", TODAY);
	const out = run(plan, { "2026-10": OCT, "2026-11": NOV });
	let exp = rep(OCT, "- [ ] 부모님 선물 고르기 #test\n", "- [ ] 부모님 선물 고르기 → W44 #test\n");
	exp = rep(exp, "- [ ] 연말정산 서류 미리 모으기 #test\n\n### 2026-10-26", "- [ ] 연말정산 서류 미리 모으기 #test\n- [ ] 부모님 선물 고르기 #test\n\n### 2026-10-26");
	assert.equal(out["2026-10"], UPD(exp));
	assert.deepEqual(Object.keys(out), ["2026-10"]);
});

test("DnD 1: an item already → W44 dropped on W43 extends the list", () => {
	const { oct } = load();
	const plan = planAssignWeek(duringItem(oct, "연말정산 서류 미리 모으기"), "2026-10-19", 43, "2026-10", TODAY);
	const out = run(plan, { "2026-10": OCT });
	let exp = rep(OCT, "→ W44 #test\n", "→ W44, W43 #test\n");
	exp = rep(exp, "- [ ] 강의 썸네일 시안 받기 (goal:: G-2026-01.2) #test\n", "- [ ] 강의 썸네일 시안 받기 (goal:: G-2026-01.2) #test\n- [ ] 연말정산 서류 미리 모으기 #test\n");
	assert.equal(out["2026-10"], UPD(exp));
});

test("DnD 1 cross-month: November 이달 중 → W44 writes the copy into 2026-10.md", () => {
	const { nov } = load();
	const plan = planAssignWeek(duringItem(nov, "혼팀 연말 이벤트 기획안"), "2026-10-26", 44, "2026-10", TODAY);
	const out = run(plan, { "2026-10": OCT, "2026-11": NOV });
	const expNov = rep(NOV, "- [ ] 혼팀 연말 이벤트 기획안 (goal:: G-2026-03.1) #test\n", "- [ ] 혼팀 연말 이벤트 기획안 → W44 (goal:: G-2026-03.1) #test\n");
	const expOct = rep(
		OCT,
		"- [ ] 연말정산 서류 미리 모으기 #test\n\n### 2026-10-26",
		"- [ ] 연말정산 서류 미리 모으기 #test\n- [ ] 혼팀 연말 이벤트 기획안 (goal:: G-2026-03.1) #test\n\n### 2026-10-26",
	);
	assert.equal(out["2026-11"], UPD(expNov));
	assert.equal(out["2026-10"], UPD(expOct));
	// …and the November view now resolves the pair through October's box.
	const after = load(out["2026-10"], out["2026-11"]);
	const d = duringItem(after.nov, "혼팀 연말 이벤트 기획안");
	assert.deepEqual(d.item.assignWeek, [44]);
	assert.ok(after.oct.weeks.get("2026-10-26")!.alloc!.some((a) => a.key === d.key));
});

test("DnD 1 into an empty 이번 주 (W49)", () => {
	const { nov } = load();
	const plan = planAssignWeek(duringItem(nov, "2027년 예산안 초안 검토"), "2026-11-30", 49, "2026-11", TODAY);
	const out = run(plan, { "2026-11": NOV });
	let exp = rep(NOV, "- [ ] 2027년 예산안 초안 검토 #회사 (from:: Wall Calendar) #test\n", "- [ ] 2027년 예산안 초안 검토 → W49 #회사 (from:: Wall Calendar) #test\n");
	exp = rep(exp, "### 이번 주\n\n### 2026-11-30", "### 이번 주\n- [ ] 2027년 예산안 초안 검토 #회사 (from:: Wall Calendar) #test\n\n### 2026-11-30");
	assert.equal(out["2026-11"], UPD(exp));
});

// ───────────────────────── DnD 2: 이번 주 할 일 → day ─────────────────────────

test("DnD 2: allocation item onto a day adds → MM/DD and copies; a second drop adds a second date", () => {
	const { oct } = load();
	const src = allocItem(oct, "2026-10-19", "호치민 출장 자료 준비");
	const out1 = run(planAssignDay(src, "2026-10-25", TODAY), { "2026-10": OCT })["2026-10"];
	let exp = rep(OCT, "- [ ] 호치민 출장 자료 준비 #회사 #test\n", "- [ ] 호치민 출장 자료 준비 → 10/25 #회사 #test\n");
	exp = rep(exp, "- [ ] 주간 리뷰 #test\n\n## W44", "- [ ] 주간 리뷰 #test\n- [ ] 호치민 출장 자료 준비 #회사 #test\n\n## W44");
	assert.equal(out1, UPD(exp));

	const again = allocItem(load(out1).oct, "2026-10-19", "호치민 출장 자료 준비");
	const out2 = run(planAssignDay(again, "2026-10-23", TODAY), { "2026-10": out1 })["2026-10"];
	let exp2 = rep(exp, "→ 10/25 #회사 #test\n", "→ 10/23, 10/25 #회사 #test\n");
	exp2 = rep(exp2, "- [x] 혼팀 릴스 업로드 #test\n\n### 2026-10-24", "- [x] 혼팀 릴스 업로드 #test\n- [ ] 호치민 출장 자료 준비 #회사 #test\n\n### 2026-10-24");
	assert.equal(out2, UPD(exp2));
});

test("DnD 2 cross-month: W44 item onto 11/01 writes the day copy into 2026-11.md", () => {
	const { oct } = load();
	const src = allocItem(oct, "2026-10-26", "연말정산 서류 미리 모으기");
	const out = run(planAssignDay(src, "2026-11-01", TODAY), { "2026-10": OCT, "2026-11": NOV });
	assert.equal(out["2026-10"], UPD(rep(OCT, "- [ ] 연말정산 서류 미리 모으기 #test\n\n### 2026-10-26", "- [ ] 연말정산 서류 미리 모으기 → 11/01 #test\n\n### 2026-10-26")));
	assert.equal(out["2026-11"], UPD(rep(NOV, "- [ ] 출장 짐 싸기 #test\n", "- [ ] 출장 짐 싸기 #test\n- [ ] 연말정산 서류 미리 모으기 #test\n")));
	const after = load(out["2026-10"], out["2026-11"]);
	assert.equal(summaryUnassigned(after.oct), 2);
});

function summaryUnassigned(d: MonthData): number {
	return [...d.weeks.values()].reduce((n, w) => n + (w.alloc ?? []).filter((a) => a.item.status === "scheduled" && !a.assign.length).length, 0);
}

// ───────────────────────── DnD 3: day → day ─────────────────────────

test("DnD 3: day item onto another day: [>] → MM/DD (moved:: 1), copy, allocation date swapped", () => {
	const { oct, months } = load();
	const src = dayItem(oct, "2026-10-24", "웨이트 운동");
	const pair = findPairAlloc(src, months);
	assert.equal(pair?.line, "- [ ] 웨이트 운동 → 10/20, 10/22, 10/24 (goal:: G-2026-02.1) #test");
	const out = run(planMoveDay(src, "2026-10-25", pair, TODAY), { "2026-10": OCT })["2026-10"];
	let exp = rep(OCT, "→ 10/20, 10/22, 10/24 (goal:: G-2026-02.1)", "→ 10/20, 10/22, 10/25 (goal:: G-2026-02.1)");
	exp = rep(exp, "### 2026-10-24\n- [ ] 웨이트 운동 #test\n", "### 2026-10-24\n- [>] 웨이트 운동 → 10/25 (moved:: 1) #test\n");
	exp = rep(exp, "- [ ] 주간 리뷰 #test\n\n## W44", "- [ ] 주간 리뷰 #test\n- [ ] 웨이트 운동 (moved:: 1) #test\n\n## W44");
	assert.equal(out, UPD(exp));
	// The allocation still resolves (new date has a scheduled copy).
	const after = load(out);
	const a = allocItem(after.oct, "2026-10-19", "웨이트 운동");
	assert.deepEqual(a.assign, ["2026-10-20", "2026-10-22", "2026-10-25"]);
	assert.ok(dayIndex(after.months).get("2026-10-25")!.some((x) => x.key === a.key));
});

test("DnD 3 across files: 10/31 day item onto 11/01 (same week W44)", () => {
	const { oct, months } = load();
	const src = dayItem(oct, "2026-10-31", "10월 Monthly 리뷰");
	const pair = findPairAlloc(src, months);
	assert.ok(pair);
	const out = run(planMoveDay(src, "2026-11-01", pair, TODAY), { "2026-10": OCT, "2026-11": NOV });
	let expOct = rep(OCT, "- [ ] 10월 Monthly 리뷰 → 10/31 #test", "- [ ] 10월 Monthly 리뷰 → 11/01 #test");
	expOct = rep(expOct, "- [ ] 10월 Monthly 리뷰 #test\n", "- [>] 10월 Monthly 리뷰 → 11/01 (moved:: 1) #test\n");
	assert.equal(out["2026-10"], UPD(expOct));
	assert.equal(out["2026-11"], UPD(rep(NOV, "- [ ] 출장 짐 싸기 #test\n", "- [ ] 출장 짐 싸기 #test\n- [ ] 10월 Monthly 리뷰 (moved:: 1) #test\n")));
});

test("DnD 3 on an already-moved copy bumps (moved:: 1) to 2 on both lines", () => {
	const moved1 = OCT.replace("### 2026-10-25\n- [ ] 주간 리뷰 #test\n", "### 2026-10-25\n- [ ] 주간 리뷰 (moved:: 1) #test\n");
	const { oct } = load(moved1);
	const src = dayItem(oct, "2026-10-25", "주간 리뷰");
	const out = run(planMoveDay(src, "2026-10-24", null, TODAY), { "2026-10": moved1 })["2026-10"];
	let exp = rep(moved1, "- [ ] 주간 리뷰 (moved:: 1) #test\n", "- [>] 주간 리뷰 → 10/24 (moved:: 2) #test\n");
	exp = rep(exp, "- 출장용 상비약 챙기기 #test\n", "- 출장용 상비약 챙기기 #test\n- [ ] 주간 리뷰 (moved:: 2) #test\n");
	assert.equal(out, UPD(exp));
});

// ───────────────────────── DnD 4: day → 이번 주 할 일 ─────────────────────────

test("DnD 4: day item back onto the allocation column removes the day line and the date", () => {
	const { oct, months } = load();
	const src = dayItem(oct, "2026-10-28", "강의 4강 촬영");
	const pair = findPairAlloc(src, months);
	const out = run(planUnassign(src, pair, "2026-10-26", "2026-10", TODAY), { "2026-10": OCT })["2026-10"];
	let exp = rep(OCT, "- [ ] 강의 4강 촬영 → 10/28 (goal:: G-2026-01.2) #test\n", "- [ ] 강의 4강 촬영 (goal:: G-2026-01.2) #test\n");
	exp = rep(exp, "### 2026-10-28\n- [ ] 강의 4강 촬영 #test\n", "### 2026-10-28\n");
	assert.equal(out, UPD(exp));
});

test("DnD 4: with two dates only the dropped one goes", () => {
	const { oct, months } = load();
	const src = dayItem(oct, "2026-10-27", "혼팀 릴스 업로드");
	const out = run(planUnassign(src, findPairAlloc(src, months), "2026-10-26", "2026-10", TODAY), { "2026-10": OCT })["2026-10"];
	let exp = rep(OCT, "→ 10/27, 10/30 (goal:: G-2026-03.1)", "→ 10/30 (goal:: G-2026-03.1)");
	exp = rep(exp, "### 2026-10-27\n- [ ] 혼팀 릴스 업로드 #test\n", "### 2026-10-27\n");
	assert.equal(out, UPD(exp));
});

test("DnD 4 cross-month: 11/01 item back onto W44 (box in 2026-10.md)", () => {
	const { nov, months } = load();
	const src = dayItem(nov, "2026-11-01", "출장 짐 싸기");
	const pair = findPairAlloc(src, months);
	assert.equal(pair?.file, "2026-10");
	const out = run(planUnassign(src, pair, "2026-10-26", "2026-10", TODAY), { "2026-10": OCT, "2026-11": NOV });
	assert.equal(out["2026-10"], UPD(rep(OCT, "- [ ] 출장 짐 싸기 → 11/01 #test\n", "- [ ] 출장 짐 싸기 #test\n")));
	assert.equal(out["2026-11"], UPD(rep(NOV, "- [ ] 출장 짐 싸기 #test\n", "")));
});

test("DnD 4: a day-only item (no pair) moves into the box as unassigned", () => {
	const { oct, months } = load();
	const src = dayItem(oct, "2026-10-31", "시사회 보고문 제출");
	assert.equal(findPairAlloc(src, months), null);
	const out = run(planUnassign(src, null, "2026-10-26", "2026-10", TODAY), { "2026-10": OCT })["2026-10"];
	let exp = rep(OCT, "- [ ] 시사회 보고문 제출 #회사 (from:: Wall Calendar) #test\n", "");
	exp = rep(exp, "- [ ] 연말정산 서류 미리 모으기 #test\n\n### 2026-10-26", "- [ ] 연말정산 서류 미리 모으기 #test\n- [ ] 시사회 보고문 제출 #회사 (from:: Wall Calendar) #test\n\n### 2026-10-26");
	assert.equal(out, UPD(exp));
});

// ───────────────────────── verification ─────────────────────────

test("writes verify the rendered line: changed line → refused, shifted line → found", () => {
	const { oct } = load();
	const src = dayItem(oct, "2026-10-24", "웨이트 운동");
	const changed = OCT.replace("### 2026-10-24\n- [ ] 웨이트 운동 #test", "### 2026-10-24\n- [x] 웨이트 운동 #test");
	const r = runPlan(planLetGo(src, "x", TODAY), { "2026-10": changed });
	assert.equal(r.ok, false);
	const shifted = OCT.replace("### 2026-10-24\n", "### 2026-10-24\n- 새 메모 #test\n");
	const r2 = runPlan(planLetGo(src, "피곤함", TODAY), { "2026-10": shifted });
	assert.ok(r2.ok);
	assert.equal(r2.files["2026-10"], UPD(rep(shifted, "- [ ] 웨이트 운동 #test\n- 18:30", "- [-] 웨이트 운동 (why:: 피곤함) #test\n- 18:30")));
	// The identical line on 10/26 is never edited in place of a vanished 10/24 line.
	const gone = OCT.replace("### 2026-10-24\n- [ ] 웨이트 운동 #test\n", "### 2026-10-24\n");
	assert.equal(runPlan(planLetGo(src, "x", TODAY), { "2026-10": gone }).ok, false);
	// A missing target file is reported, not created.
	const moved = runPlan(planMoveDay(src, "2026-11-02", null, TODAY), { "2026-10": OCT });
	assert.equal(moved.ok, false);
});

test("toggle a day task [ ] ↔ [x]", () => {
	const { oct } = load();
	const out = run(planToggle(dayItem(oct, "2026-10-24", "웨이트 운동"), TODAY), { "2026-10": OCT })["2026-10"];
	assert.equal(out, UPD(rep(OCT, "### 2026-10-24\n- [ ] 웨이트 운동", "### 2026-10-24\n- [x] 웨이트 운동")));
	const back = run(planToggle(dayItem(load(out).oct, "2026-10-24", "웨이트 운동"), TODAY), { "2026-10": out })["2026-10"];
	assert.equal(back, UPD(OCT));
});

// ───────────────────────── let-go ─────────────────────────

test("놓아주기: [-] + (why:: …)", () => {
	const { oct } = load();
	const out = run(planLetGo(dayItem(oct, "2026-10-24", "웨이트 운동"), "오늘은 쉬기로", TODAY), { "2026-10": OCT })["2026-10"];
	assert.equal(out, UPD(rep(OCT, "### 2026-10-24\n- [ ] 웨이트 운동 #test", "### 2026-10-24\n- [-] 웨이트 운동 (why:: 오늘은 쉬기로) #test")));
});

test("쪼개기: [>] → 쪼갬 and the smaller tasks on the same day (end of file)", () => {
	const { oct } = load();
	const out = run(planSplit(dayItem(oct, "2026-10-31", "10월 Monthly 리뷰"), ["지표 모으기", "- [ ] 회고 쓰기", "  "], TODAY), { "2026-10": OCT })["2026-10"];
	let exp = rep(OCT, "- [ ] 10월 Monthly 리뷰 #test\n", "- [>] 10월 Monthly 리뷰 → 쪼갬 #test\n");
	exp = rep(exp, "- 조카 할로윈 파티 #행사 #가족 #test\n", "- 조카 할로윈 파티 #행사 #가족 #test\n- [ ] 지표 모으기\n- [ ] 회고 쓰기\n");
	assert.equal(out, UPD(exp));
});

test("서랍에: [>] → Drawer and a full Drawer line in ## 보류 (new file from the template, or existing)", () => {
	const { oct } = load();
	const plan = planDrawer(dayItem(oct, "2026-10-24", "웨이트 운동"), "06 Drawer/Drawer.md", TODAY, "95kg 도달 시");
	const out = run(plan, { "2026-10": OCT });
	assert.equal(out["2026-10"], UPD(rep(OCT, "### 2026-10-24\n- [ ] 웨이트 운동 #test", "### 2026-10-24\n- [>] 웨이트 운동 → Drawer #test")));
	// No Drawer yet: the template, the line in ## 보류, one 변경 기록 line.
	const line = `- [ ] 웨이트 운동 (when:: 95kg 도달 시) (from:: Desk Calendar 2026-10-24) (added:: ${TODAY}) (reviewed:: ${TODAY}) #test`;
	assert.equal(out["06 Drawer/Drawer.md"], drawerTemplate(TODAY).replace("## 보류\n", `## 보류\n${line}\n`) + `- ${TODAY}: 넣음 「웨이트 운동」 (from:: Desk Calendar 2026-10-24)\n`);
	assert.ok(out["06 Drawer/Drawer.md"].startsWith("---\ntype: drawer\n"));
	// Existing drawer: appended at the end of ## 보류; registry line; `updated`. Nothing else changes.
	const existing = "---\ntype: drawer\nupdated: 2026-10-01\n---\n# Drawer\n\n## 보류\n- [ ] 다른 일 (when:: x) (added:: 2026-10-01) (reviewed:: 2026-10-01)\n\n## 아이디어\n\n## 변경 기록\n- 2026-10-01: 넣음 「다른 일」\n";
	const out2 = run(plan, { "2026-10": OCT, "06 Drawer/Drawer.md": existing });
	assert.equal(
		out2["06 Drawer/Drawer.md"],
		`---\ntype: drawer\nupdated: ${TODAY}\n---\n# Drawer\n\n## 보류\n- [ ] 다른 일 (when:: x) (added:: 2026-10-01) (reviewed:: 2026-10-01)\n${line}\n\n## 아이디어\n\n## 변경 기록\n- 2026-10-01: 넣음 「다른 일」\n- ${TODAY}: 넣음 「웨이트 운동」 (from:: Desk Calendar 2026-10-24)\n`,
	);
	// The user insisted without a condition → (when:: 미정).
	const out3 = run(planDrawer(dayItem(oct, "2026-10-24", "웨이트 운동"), "06 Drawer/Drawer.md", TODAY), { "2026-10": OCT });
	assert.ok(out3["06 Drawer/Drawer.md"].includes("- [ ] 웨이트 운동 (when:: 미정) (from:: Desk Calendar 2026-10-24)"));
});

test("미래로: [>] → Wall Calendar (moved:: n+1) and the line under ## YYYY-MM", () => {
	const WALL = fx("wall-2026.md");
	const { oct } = load();
	const plan = planFuture(dayItem(oct, "2026-10-24", "웨이트 운동"), "2026-12", "02 Wall Calendar/2026.md", TODAY);
	const out = run(plan, { "2026-10": OCT, "02 Wall Calendar/2026.md": WALL });
	assert.equal(out["2026-10"], UPD(rep(OCT, "### 2026-10-24\n- [ ] 웨이트 운동 #test", "### 2026-10-24\n- [>] 웨이트 운동 → Wall Calendar (moved:: 1) #test")));
	assert.equal(
		out["02 Wall Calendar/2026.md"],
		UPD(rep(WALL, "- 연말 감사 인사 보낼 사람 정리 #test\n", "- 연말 감사 인사 보낼 사람 정리 #test\n- [ ] 웨이트 운동 (moved:: 1) #test\n")),
	);
	// A month in the middle of the file.
	assert.equal(
		appendUnderWallMonth(WALL, "2026-11", "- [ ] X"),
		rep(WALL, "- [ ] 2027년 예산안 초안 검토 #회사 #test\n", "- [ ] 2027년 예산안 초안 검토 #회사 #test\n- [ ] X\n"),
	);
	// A missing month heading is inserted in order.
	const noJune = WALL.replace("## 2026-06\n\n", "");
	assert.equal(appendUnderWallMonth(noJune, "2026-06", "- [ ] X"), rep(noJune, "## 2026-07\n", "## 2026-06\n- [ ] X\n\n## 2026-07\n"));
	// A missing year file is created with all twelve months.
	const p2 = planFuture(dayItem(oct, "2026-10-24", "웨이트 운동"), "2027-02", "02 Wall Calendar/2027.md", TODAY);
	const created = run(p2, { "2026-10": OCT })["02 Wall Calendar/2027.md"];
	assert.equal(created, rep(wallYearSkeleton(2027, TODAY), "## 2027-02\n", "## 2027-02\n- [ ] 웨이트 운동 (moved:: 1) #test\n"));
});

// ───────────────────────── index ─────────────────────────

test("Desk Calendar Index: change log entry prepended, updated set, nothing else changes", () => {
	const IDX = fx("index.md");
	const out = prependChangeLog(IDX, TODAY, "「웨이트 운동」 10/24 → 10/25 옮김");
	let exp = rep(IDX, "## 변경 기록\n\n- ", `## 변경 기록\n\n- ${TODAY}: 「웨이트 운동」 10/24 → 10/25 옮김 (플러그인)\n- `);
	exp = rep(exp, "updated: 2026-10-24\n", `updated: ${TODAY}\n`);
	assert.equal(out, exp);
	const empty = "---\ntype: index\nupdated: 2026-10-01\n---\n\n# I\n\n## 변경 기록\n";
	assert.equal(prependChangeLog(empty, TODAY, "x"), `---\ntype: index\nupdated: ${TODAY}\n---\n\n# I\n\n## 변경 기록\n- ${TODAY}: x (플러그인)\n`);
});

// ───────────────────────── 수정 / 삭제 ─────────────────────────

test("pairs: 이달 중 ↔ 이번 주 ↔ 날짜 칸 copies by text", () => {
	const { oct, months } = load();
	const reels = dayItem(oct, "2026-10-27", "혼팀 릴스 업로드");
	assert.deepEqual(
		pairedCopies(reels, months).map((x) => `${x.section} ${x.date ?? x.monday}`).sort(),
		["alloc 2026-10-26", "day 2026-10-30"],
	);
	const tax = duringItem(oct, "연말정산 서류 미리 모으기");
	assert.deepEqual(pairedCopies(tax, months).map((x) => `${x.section} ${x.monday}`), ["alloc 2026-10-26"]);
	assert.deepEqual(pairedCopies(dayItem(oct, "2026-10-29", "3분기 실적 보고"), months), []);
});

test("edit: text follows to the paired copies; arrows, fields, tags stay", () => {
	const { oct, months } = load();
	const src = dayItem(oct, "2026-10-27", "혼팀 릴스 업로드");
	const plan = planEdit(src, { text: "혼팀 릴스 2개 업로드", fields: { goal: "G-2026-03.1" } }, pairedCopies(src, months), null, TODAY);
	const out = run(plan, { "2026-10": OCT, "2026-11": NOV });
	let exp = rep(OCT, "- [ ] 혼팀 릴스 업로드 → 10/27, 10/30 (goal:: G-2026-03.1) #test", "- [ ] 혼팀 릴스 2개 업로드 → 10/27, 10/30 (goal:: G-2026-03.1) #test");
	exp = rep(exp, "### 2026-10-27\n- [ ] 혼팀 릴스 업로드 #test", "### 2026-10-27\n- [ ] 혼팀 릴스 2개 업로드 (goal:: G-2026-03.1) #test");
	exp = rep(exp, "### 2026-10-30\n- [ ] 혼팀 릴스 업로드 #test", "### 2026-10-30\n- [ ] 혼팀 릴스 2개 업로드 (goal:: G-2026-03.1) #test");
	assert.equal(out["2026-10"], UPD(exp));
	assert.match(plan.what, /짝 2줄도/);
});

test("edit: time on one line only; empty text refused", () => {
	const { oct } = load();
	const src = dayItem(oct, "2026-10-26", "회사 주간 회의");
	const out = run(planEdit(src, { time: "09:30" }, [], null, TODAY), { "2026-10": OCT });
	assert.equal(out["2026-10"], UPD(rep(OCT, "### 2026-10-26\n- 10:00 회사 주간 회의", "### 2026-10-26\n- 09:30 회사 주간 회의")));
	const bad = runPlan(planEdit(src, { text: " " }, [], null, TODAY), { "2026-10": OCT });
	assert.deepEqual(bad, { ok: false, file: "2026-10", reason: "empty-text" });
});

test("edit: a new date moves the day line (no [>], no moved) and fixes the allocation", () => {
	const { oct, months } = load();
	const src = dayItem(oct, "2026-10-27", "혼팀 릴스 업로드");
	const alloc = findPairAlloc(src, months);
	assert.ok(alloc);
	const out = run(planEdit(src, { date: "2026-10-28" }, pairedCopies(src, months), alloc, TODAY), { "2026-10": OCT, "2026-11": NOV });
	let exp = rep(OCT, "→ 10/27, 10/30 (goal:: G-2026-03.1)", "→ 10/28, 10/30 (goal:: G-2026-03.1)");
	exp = rep(exp, "### 2026-10-27\n- [ ] 혼팀 릴스 업로드 #test\n", "### 2026-10-27\n");
	exp = rep(exp, "### 2026-10-28\n- [ ] 강의 4강 촬영 #test\n", "### 2026-10-28\n- [ ] 강의 4강 촬영 #test\n- [ ] 혼팀 릴스 업로드 #test\n");
	assert.equal(out["2026-10"], UPD(exp));

	// to another week: the date leaves the allocation list
	const out2 = run(planEdit(src, { date: "2026-11-03" }, [], alloc, TODAY), { "2026-10": OCT, "2026-11": NOV });
	assert.ok(out2["2026-10"].includes("- [ ] 혼팀 릴스 업로드 → 10/30 (goal:: G-2026-03.1) #test"));
	assert.ok(/### 2026-11-03\n[\s\S]*?- \[ \] 혼팀 릴스 업로드 #test/.test(out2["2026-11"]));
});

test("delete: day line goes and its date leaves the allocation", () => {
	const { oct, months } = load();
	const out = run(planDelete(dayItem(oct, "2026-10-28", "강의 4강 촬영"), months, TODAY), { "2026-10": OCT, "2026-11": NOV });
	let exp = rep(OCT, "- [ ] 강의 4강 촬영 → 10/28 (goal:: G-2026-01.2) #test", "- [ ] 강의 4강 촬영 (goal:: G-2026-01.2) #test");
	exp = rep(exp, "### 2026-10-28\n- [ ] 강의 4강 촬영 #test\n", "### 2026-10-28\n");
	assert.equal(out["2026-10"], UPD(exp));
});

test("delete: 이번 주 line goes and its week leaves the 이달 중 line; day copies stay", () => {
	const { oct, months } = load();
	const out = run(planDelete(allocItem(oct, "2026-10-26", "연말정산 서류 미리 모으기"), months, TODAY), { "2026-10": OCT, "2026-11": NOV });
	let exp = rep(OCT, "- [ ] 연말정산 서류 미리 모으기 → W44 #test", "- [ ] 연말정산 서류 미리 모으기 #test");
	exp = rep(exp, "- [ ] 출장 짐 싸기 → 11/01 #test\n- [ ] 연말정산 서류 미리 모으기 #test\n", "- [ ] 출장 짐 싸기 → 11/01 #test\n");
	assert.equal(out["2026-10"], UPD(exp));
	const out2 = run(planDelete(allocItem(oct, "2026-10-26", "강의 4강 촬영"), months, TODAY), { "2026-10": OCT });
	assert.ok(out2["2026-10"].includes("### 2026-10-28\n- [ ] 강의 4강 촬영 #test"));
	assert.equal(removeWeekAssign("- [ ] a → W44, W45 #t", 44), "- [ ] a → W45 #t");
});

test("cancel an event: strike through, time inside", () => {
	const { oct } = load();
	const out = run(planCancelEvent(dayItem(oct, "2026-10-29", "3분기 실적 보고"), TODAY), { "2026-10": OCT });
	assert.equal(out["2026-10"], UPD(rep(OCT, "- 14:00 3분기 실적 보고 #회사 #test", "- ~~14:00 3분기 실적 보고~~ #회사 #test")));
	const parsed = parseMonthFile(out["2026-10"], 2026, 10).days.get("2026-10-29")!.find((x) => x.item.text === "3분기 실적 보고")!;
	assert.deepEqual([parsed.item.kind, parsed.item.status], ["event", "cancelled"]);
});
