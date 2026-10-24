import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	dayIndex,
	isoWeekNo,
	type MonthData,
	newMonthSkeleton,
	parseMonthFile,
	resolveAlloc,
	resolveDuring,
	summarizeMonth,
	weekAllocIndex,
	weekAllocStats,
	weekMondays,
} from "../src/desk/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/desk", p), "utf8");
const oct = parseMonthFile(fx("2026-10.md"), 2026, 10);
const nov = parseMonthFile(fx("2026-11.md"), 2026, 11);
const months: MonthData[] = [oct, nov];

/**
 * python-resolve.json was produced by running test/fixtures/desk/dump_resolve.py against a
 * scratch copy of `03 Desk Calendar/_build/build_desk_calendar.py` and the two month files.
 */
const py = JSON.parse(fx("python-resolve.json")) as Record<
	string,
	{
		counts: Record<string, number>;
		unassigned: number;
		issues: number;
		alloc: { line: number; text: string; state: string; targets: [string, string | null][]; missing: string[] }[];
		during: { line: number; text: string; state: string; targets: [number, number | null][]; missing: number[] }[];
		focus: { id: string; title: string; note: string }[];
	}
>;

test("2026-10 summary matches the Python build: 예정 27 / 완료 20 / 옮김 1 / 취소 1 / 미배정 3 / 형식 확인 0", () => {
	const s = summarizeMonth(oct, dayIndex(months));
	assert.deepEqual(
		{ scheduled: s.counts.scheduled, done: s.counts.done, moved: s.counts.moved, cancelled: s.counts.cancelled, unassigned: s.unassigned, issues: s.issues.length },
		{ scheduled: 27, done: 20, moved: 1, cancelled: 1, unassigned: 3, issues: 0 },
	);
	assert.equal(s.counts.total, py["2026-10"].counts.total);
	assert.equal(s.counts.test, py["2026-10"].counts.test);
});

test("2026-11 summary matches the Python build: 예정 30 / 취소 1 / 미배정 3", () => {
	const s = summarizeMonth(nov, dayIndex(months));
	assert.deepEqual(
		{ scheduled: s.counts.scheduled, done: s.counts.done, moved: s.counts.moved, cancelled: s.counts.cancelled, unassigned: s.unassigned, issues: s.issues.length },
		{ scheduled: 30, done: 0, moved: 0, cancelled: 1, unassigned: 3, issues: 0 },
	);
	assert.equal(s.counts.test, py["2026-11"].counts.test);
});

test("cross-month: W44 allocation (in 2026-10) resolves 11/01 against 2026-11 day cells", () => {
	const w44 = oct.weeks.get("2026-10-26")!;
	const weight = w44.alloc!.find((a) => a.item.text === "웨이트 운동")!;
	const r = resolveAlloc(weight, dayIndex(months));
	assert.deepEqual(r.missing, []);
	assert.equal(r.targets[2][0], "2026-11-01");
	assert.equal(r.targets[2][1]?.file, "2026-11");
	// Without November loaded the pair is missing (the view always loads the adjacent months).
	assert.deepEqual(resolveAlloc(weight, dayIndex([oct])).missing, ["2026-11-01"]);
	const novW44 = nov.weeks.get("2026-10-26")!;
	assert.equal(novW44.alloc, null);
	assert.equal(novW44.allocLink, "2026-10");
});

test("every allocation and 이달 중 item resolves exactly like resolve_alloc / resolve_during", () => {
	const didx = dayIndex(months);
	const widx = weekAllocIndex(months);
	for (const data of months) {
		const exp = py[data.key];
		const allocs = [...data.weeks.values()].flatMap((w) => w.alloc ?? []);
		assert.equal(allocs.length, exp.alloc.length, data.key);
		allocs.forEach((a, i) => {
			const e = exp.alloc[i];
			const r = resolveAlloc(a, didx);
			assert.equal(a.index + 1, e.line);
			assert.deepEqual(
				{ text: a.item.text, state: r.state, targets: r.targets.map(([d, x]) => [d, x ? x.item.status : null]), missing: r.missing },
				{ text: e.text, state: e.state, targets: e.targets, missing: e.missing },
				`${data.key}:${e.line}`,
			);
		});
		assert.equal(data.during.length, exp.during.length);
		data.during.forEach((d, i) => {
			const e = exp.during[i];
			const r = resolveDuring(d, widx, didx);
			assert.deepEqual(
				{ line: d.index + 1, state: r.state, targets: r.targets.map(([no, x]) => [no, x ? x.index + 1 : null]), missing: r.missing },
				{ line: e.line, state: e.state, targets: e.targets, missing: e.missing },
			);
		});
		assert.deepEqual(
			data.focus.map((f) => ({ id: f.id, title: f.title, note: f.note })),
			exp.focus,
		);
	}
});

test("per-week 미배정 counts", () => {
	const un = (d: MonthData) => [...d.weeks.values()].filter((w) => w.alloc).map((w) => `W${w.no}:${weekAllocStats(w).join("/")}`);
	assert.deepEqual(un(oct), ["W41:3/0", "W42:4/0", "W43:5/2", "W44:6/1"]);
	assert.deepEqual(un(nov), ["W45:4/1", "W46:4/0", "W47:4/2", "W48:1/0", "W49:0/0"]);
});

test("issue checks: broken structure is reported like the Python build", () => {
	const bad = fx("2026-10.md")
		.replace("### 2026-10-05\n", "### 10/05 (월)\n")
		.replace("## W42 (10/12~10/18)", "## W40 (10/12~10/18)")
		.replace("- [ ] 강의 4강 촬영 → 10/28", "- [ ] 강의 4강 촬영 → 11/05")
		.replace("### 2026-10-31\n", "### 2026-10-31\n○ 옛 기호 줄\n");
	const d = parseMonthFile(bad, 2026, 10);
	const whys = d.issues.map((i) => i.why);
	assert.ok(whys.some((w) => w.startsWith("옛 날짜 제목이에요")));
	assert.ok(whys.includes("주차 번호가 달라요 (W42)"));
	assert.ok(whys.some((w) => w.includes("11/05 은(는) 이 주 밖의 날짜예요")));
	assert.ok(whys.some((w) => w.includes("옛 기호 형식이에요")));
	assert.ok(whys.includes("날짜 칸이 빠져 있어요 (빈 칸으로 표시)"));
});

test("ISO weeks and month weeks", () => {
	assert.equal(isoWeekNo("2026-10-26"), 44);
	assert.equal(isoWeekNo("2026-12-28"), 53);
	assert.equal(isoWeekNo("2027-01-04"), 1);
	assert.equal(isoWeekNo("2025-12-29"), 1);
	assert.deepEqual(weekMondays(2026, 10), ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
});

test("new month skeleton is byte-identical to new_month.py --stdout", () => {
	const dir = join(here, "fixtures/desk/new_month");
	const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	assert.ok(files.length >= 5);
	for (const f of files) {
		const key = f.replace(/\.md$/, "");
		const [y, m] = key.split("-").map((n) => +n);
		assert.equal(newMonthSkeleton(y, m, "2026-10-24"), readFileSync(join(dir, f), "utf8"), key);
	}
});
