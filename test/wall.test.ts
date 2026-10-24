import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { countStatuses, parseWallItem, parseWallYear } from "../src/wall/parse.ts";
import {
	addIndexChange,
	cancelWallEvent,
	cancelWallTask,
	deskLineFor,
	deskLink,
	formatNewLine,
	insertIntoDesk,
	insertIntoMonth,
	markSentToDesk,
	moveWallItem,
	normalizeDateInput,
	retargetDate,
	toggleWallTask,
	type WallTarget,
} from "../src/wall/edit.ts";
import { findDaySection } from "../src/parser.ts";
import { getSectionContent } from "../src/writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures/wall", n), "utf8");
const y2026 = fx("2026.md");
const y2027 = fx("2027.md");
const index = fx("Wall Calendar Index.md");
const desk = fx("desk-2026-10.md");
const py = JSON.parse(fx("wall.python-expected.json")) as Record<
	string,
	{ counts: Record<string, number>; issues: number; items: Array<Record<string, unknown>> }
>;

function target(text: string, year: number, month: number, startsWith: string): WallTarget {
	const sec = parseWallYear(text, year).months[month - 1];
	const l = sec.lines.find((x) => x.line.startsWith(startsWith));
	assert.ok(l, `line starting with ${startsWith}`);
	return { month, index: l.index, line: l.line };
}

/** Remove exactly one occurrence of `line\n` and compare with the original. */
function withoutLine(text: string, line: string): string {
	const i = text.indexOf(line + "\n");
	assert.notEqual(i, -1, `has ${line}`);
	return text.slice(0, i) + text.slice(i + line.length + 1);
}

for (const [year, text] of [
	[2026, y2026],
	[2027, y2027],
] as const) {
	test(`${year}.md: every line matches the Python build`, () => {
		const wy = parseWallYear(text, year);
		const exp = py[String(year)];
		assert.deepEqual(countStatuses(wy), exp.counts);
		assert.equal(wy.issues.length, exp.issues);
		const got = wy.months.flatMap((m) => m.lines);
		assert.equal(got.length, exp.items.length);
		got.forEach((l, i) => {
			const e = exp.items[i];
			const it = l.item;
			const where = `line ${e.line}: ${l.line}`;
			assert.equal(l.index + 1, e.line, where);
			assert.equal(l.month, e.month, where);
			assert.equal(it.kind, e.kind, where);
			assert.equal(it.status, e.status, where);
			assert.equal(it.start, e.start, where);
			assert.equal(it.end, e.end, where);
			assert.equal(it.time, e.time, where);
			assert.equal(it.text, e.text, where);
			assert.deepEqual(it.tags, e.tags, where);
			assert.deepEqual(it.fields, e.fields, where);
			assert.equal(it.test, e.test, where);
			assert.equal(it.ok, e.ok, where);
			if (e.moved_to) assert.ok(String(e.moved_to).endsWith(it.movedTo), where);
			else assert.equal(it.movedTo, "", where);
		});
	});
}

test("date-prefixed grammar: time, ranges, cross-year, month phrase", () => {
	const a = parseWallItem("[ ] 10/15 14:00 회의 #회사", 2026, 10);
	assert.deepEqual([a.kind, a.start, a.time, a.text, a.dateRaw], ["task", "2026-10-15", "14:00", "회의", "10/15 14:00"]);
	const b = parseWallItem("12/30~01/02 연말 여행", 2026, 12);
	assert.deepEqual([b.kind, b.start, b.end], ["event", "2026-12-30", "2027-01-02"]);
	const c = parseWallItem("10/15~17 출장", 2026, 10);
	assert.equal(c.end, "2026-10-17");
	const d = parseWallItem("[ ] 3월 중 건강검진 예약 #건강", 2027, 3);
	assert.deepEqual([d.start, d.text], [null, "건강검진 예약"]);
	const e = parseWallItem("~~05/09 워크숍~~ #test", 2026, 5);
	assert.deepEqual([e.kind, e.status, e.start, e.text], ["event", "cancelled", "2026-05-09", "워크숍"]);
	const f = parseWallItem("02/30 없는 날", 2026, 2);
	assert.equal(f.ok, false);
	assert.equal(parseWallItem("한글날 #행사", 2026, 10).kind, "event");
	assert.equal(parseWallItem("그냥 메모", 2026, 10).kind, "note");
});

test("new line formatting and date input", () => {
	assert.equal(formatNewLine({ kind: "task", date: "11/20", text: "보고" }), "- [ ] 11/20 보고");
	assert.equal(formatNewLine({ kind: "event", date: "11/20", text: "모임" }), "- 11/20 모임");
	assert.equal(formatNewLine({ kind: "event", text: "모임" }), "- 모임 #행사");
	assert.equal(formatNewLine({ kind: "note", date: "11/20", text: "생각" }), "- 생각");
	assert.deepEqual(normalizeDateInput("11/3", 2026, 11), { ok: true, date: "11/03" });
	assert.deepEqual(normalizeDateInput("11/3~5 14:00", 2026, 11), { ok: true, date: "11/03~11/05 14:00" });
	assert.equal(normalizeDateInput("12/3", 2026, 11).ok, false);
	assert.equal(normalizeDateInput("11/31", 2026, 11).ok, false);
	assert.equal(normalizeDateInput("내일", 2026, 11).ok, false);
});

test("insert in date order; undated at the end; empty month; rest byte-identical", () => {
	const lines = (t: string, m: number) => parseWallYear(t, 2026).months[m - 1].lines.map((l) => l.line);
	const r1 = insertIntoMonth(y2026, 2026, 11, "- [ ] 11/10 새 할 일");
	assert.ok(r1.ok);
	assert.deepEqual(lines(r1.text, 11), [
		"- 11/03~11/07 호치민 출장 #회사 #test",
		"- [ ] 11/10 새 할 일",
		"- [ ] 11/14 Claude Code 강의 1~5강 완성 (goal:: G-2026-01.2) #test",
		"- 11/21 가족 생일 #가족 #test",
		"- [ ] 2027년 예산안 초안 검토 #회사 #test",
	]);
	assert.equal(withoutLine(r1.text, "- [ ] 11/10 새 할 일"), y2026);

	const r2 = insertIntoMonth(y2026, 2026, 11, "- 메모 하나");
	assert.ok(r2.ok);
	assert.equal(lines(r2.text, 11).at(-1), "- 메모 하나");
	assert.ok(r2.text.includes("- [ ] 2027년 예산안 초안 검토 #회사 #test\n- 메모 하나\n\n## 2026-12"));

	const r3 = insertIntoMonth(y2026, 2026, 6, "- 06/01 첫 행사");
	assert.ok(r3.ok);
	assert.ok(r3.text.includes("## 2026-06\n- 06/01 첫 행사\n\n## 2026-07"));

	const r4 = insertIntoMonth(y2026, 2026, 11, "- 11/30 월말");
	assert.ok(r4.ok);
	assert.deepEqual(lines(r4.text, 11).slice(-2), ["- 11/30 월말", "- [ ] 2027년 예산안 초안 검토 #회사 #test"]);

	// The last month at the end of the file (no blank line after).
	const r5 = insertIntoMonth(y2027, 2027, 12, "- [ ] 12/01 끝");
	assert.ok(r5.ok);
	assert.ok(r5.text.endsWith("## 2027-12\n- [ ] 12/01 끝\n"));
	const r6 = insertIntoMonth(y2026, 2026, 12, "- [ ] 12/31 한 해 마무리");
	assert.ok(r6.ok);
	assert.ok(r6.text.includes("- [ ] 12/31 2026 Yearly 리뷰 #test\n- [ ] 12/31 한 해 마무리\n- 연말 감사"));
});

test("toggle a task", () => {
	const t = target(y2026, 2026, 11, "- [ ] 11/14");
	const r = toggleWallTask(y2026, 2026, t);
	assert.ok(r.ok);
	assert.equal(r.line, "- [x] 11/14 Claude Code 강의 1~5강 완성 (goal:: G-2026-01.2) #test");
	assert.equal(r.text.length, y2026.length);
	const back = toggleWallTask(r.text, 2026, { ...t, line: r.line! });
	assert.ok(back.ok);
	assert.equal(back.text, y2026);
	const moved = toggleWallTask(y2026, 2026, target(y2026, 2026, 10, "- [>]"));
	assert.deepEqual(moved, { ok: false, reason: "not-toggleable" });
});

test("cancel a task (why::) and an event (~~ ~~)", () => {
	const t = target(y2026, 2026, 11, "- [ ] 11/14");
	const r = cancelWallTask(y2026, 2026, t, "우선순위 변경");
	assert.ok(r.ok);
	assert.equal(r.line, "- [-] 11/14 Claude Code 강의 1~5강 완성 (goal:: G-2026-01.2) (why:: 우선순위 변경) #test");
	assert.equal(parseWallYear(r.text, 2026).months[10].lines[1].item.status, "cancelled");
	assert.equal(r.text.replace(r.line!, t.line), y2026);

	const e = target(y2026, 2026, 11, "- 11/21");
	const r2 = cancelWallEvent(y2026, 2026, e);
	assert.ok(r2.ok);
	assert.equal(r2.line, "- ~~11/21 가족 생일~~ #가족 #test");
	const it = parseWallYear(r2.text, 2026).months[10].lines[2].item;
	assert.deepEqual([it.kind, it.status, it.start, it.text], ["event", "cancelled", "2026-11-21", "가족 생일"]);
	assert.equal(r2.text.replace(r2.line!, e.line), y2026);
	// A note is not an event.
	assert.equal(cancelWallEvent(y2026, 2026, target(y2026, 2026, 12, "- 연말")).ok, false);
});

test("move between months: removes, re-dates, inserts in order", () => {
	const t = target(y2026, 2026, 11, "- [ ] 11/14");
	const r = moveWallItem(y2026, 2026, t, 12);
	assert.ok(r.ok);
	const wy = parseWallYear(r.text, 2026);
	assert.equal(wy.months[10].lines.length, 3);
	assert.deepEqual(
		wy.months[11].lines.map((l) => l.line).slice(0, 3),
		["- 12/05 혼팀 인스타그램 이벤트 (goal:: G-2026-03.1) #test", "- [ ] 12/14 Claude Code 강의 1~5강 완성 (goal:: G-2026-01.2) #test", "- [ ] 12/20 체중 중간 점검 (goal:: G-2026-02.1) #건강 #test"],
	);
	// Only those two lines differ.
	assert.equal(withoutLine(r.text, r.line!), withoutLine(y2026, t.line));

	// Range: 11/03~11/07 → 2026-12 becomes 12/03~12/07.
	const rr = moveWallItem(y2026, 2026, target(y2026, 2026, 11, "- 11/03"), 12);
	assert.ok(rr.ok);
	assert.equal(rr.line, "- 12/03~12/07 호치민 출장 #회사 #test");

	// Undated: unchanged text, goes to the end.
	const ru = moveWallItem(y2026, 2026, target(y2026, 2026, 11, "- [ ] 2027년"), 6);
	assert.ok(ru.ok);
	assert.ok(ru.text.includes("## 2026-06\n- [ ] 2027년 예산안 초안 검토 #회사 #test\n\n## 2026-07"));

	// 12/31 → November has no 31st: ask for a date.
	const t31 = target(y2026, 2026, 12, "- [ ] 12/31");
	assert.deepEqual(moveWallItem(y2026, 2026, t31, 11), { ok: false, reason: "need-date" });
	const rd = moveWallItem(y2026, 2026, t31, 11, "11/30");
	assert.ok(rd.ok);
	assert.equal(rd.line, "- [ ] 11/30 2026 Yearly 리뷰 #test");
	assert.equal(retargetDate("[ ] 01/31 x", 2026, 2), null);
	assert.equal(retargetDate("~~05/09 워크숍~~ #test", 2026, 6), "~~06/09 워크숍~~ #test");
});

test("send to Desk Calendar: Wall line marked, Desk line inserted, rest byte-identical", () => {
	const link = deskLink("03 Desk Calendar", 2026, 10);
	assert.equal(link, "03 Desk Calendar/2026/2026-10");
	// Build a current-month Wall section with scheduled items.
	let wall = insertIntoMonth(y2026, 2026, 10, "- [ ] 10/28 10:00 제안서 제출 (project:: P-x) #회사 #test");
	assert.ok(wall.ok);
	wall = insertIntoMonth(wall.text, 2026, 10, "- 10/29~10/30 워크숍 #test");
	assert.ok(wall.ok);
	wall = insertIntoMonth(wall.text, 2026, 10, "- [ ] 서류 정리 #test");
	assert.ok(wall.ok);
	const base = wall.text;

	// Task, dated, with time.
	const tt = target(base, 2026, 10, "- [ ] 10/28");
	const m1 = markSentToDesk(base, 2026, tt, link);
	assert.ok(m1.ok);
	assert.equal(m1.line, "- [>] 10/28 10:00 제안서 제출 (project:: P-x) → [[03 Desk Calendar/2026/2026-10]] #회사 #test");
	const it1 = parseWallYear(m1.text, 2026).months[9].lines.find((l) => l.line === m1.line)!.item;
	assert.deepEqual([it1.status, it1.movedTo], ["moved", "2026-10"]);
	const d1 = deskLineFor(tt.line.slice(2), parseWallYear(base, 2026).months[9].lines.find((l) => l.line === tt.line)!.item);
	assert.equal(d1, "- [ ] 10:00 제안서 제출 (project:: P-x) (from:: Wall Calendar) #회사 #test");
	const k1 = insertIntoDesk(desk, d1, "2026-10-28");
	assert.ok(k1.ok);
	assert.equal(withoutLine(k1.text, d1), desk);
	assert.deepEqual(findDaySection(k1.text, "2026-10-28").lines.map((l) => l.line), ["- [ ] 강의 4강 촬영 #test", d1]);

	// Event range: stays plain, end kept, #행사 added (no time).
	const te = target(base, 2026, 10, "- 10/29~");
	const m2 = markSentToDesk(base, 2026, te, link);
	assert.ok(m2.ok);
	assert.equal(m2.line, "- 10/29~10/30 워크숍 → [[03 Desk Calendar/2026/2026-10]] #test");
	const d2 = deskLineFor(te.line.slice(2), parseWallYear(base, 2026).months[9].lines.find((l) => l.line === te.line)!.item);
	assert.equal(d2, "- 워크숍 (~10/30) (from:: Wall Calendar) #행사 #test");
	const k2 = insertIntoDesk(desk, d2, "2026-10-29");
	assert.ok(k2.ok);
	assert.equal(withoutLine(k2.text, d2), desk);

	// Undated task: under ## 이달 중 (after its last line).
	const tu = target(base, 2026, 10, "- [ ] 서류");
	const d3 = deskLineFor(tu.line.slice(2), parseWallYear(base, 2026).months[9].lines.find((l) => l.line === tu.line)!.item);
	assert.equal(d3, "- [ ] 서류 정리 (from:: Wall Calendar) #test");
	const k3 = insertIntoDesk(desk, d3, null);
	assert.ok(k3.ok);
	assert.equal(withoutLine(k3.text, d3), desk);
	assert.equal(getSectionContent(k3.text, "이달 중")?.split("\n").at(-1), d3);

	// Already moved: refused.
	assert.equal(markSentToDesk(y2026, 2026, target(y2026, 2026, 10, "- [>]"), link).ok, false);
	// Missing day heading: refused.
	assert.deepEqual(insertIntoDesk(desk, d1, "2026-11-01"), { ok: false, reason: "no-day" });
	// Empty day section (### 2026-10-17 has no body).
	const k4 = insertIntoDesk(desk, "- x", "2026-10-17");
	assert.ok(k4.ok);
	assert.ok(k4.text.includes("### 2026-10-17\n- x\n### 2026-10-18"));
});

test("index: prepend change log entry, set updated", () => {
	const out = addIndexChange(index, "2026-10-25", "2026-11에 할 일 추가: 보고");
	assert.ok(out.includes("## 변경 기록\n\n- 2026-10-25: 2026-11에 할 일 추가: 보고 (플러그인)\n- 2026-10-24: 줄 형식을"));
	assert.ok(out.startsWith("---\ntype: index\nfolder: 02 Wall Calendar\nupdated: 2026-10-25\n---"));
	const back = out.replace("- 2026-10-25: 2026-11에 할 일 추가: 보고 (플러그인)\n", "").replace("updated: 2026-10-25", "updated: 2026-10-24");
	assert.equal(back, index);
});
