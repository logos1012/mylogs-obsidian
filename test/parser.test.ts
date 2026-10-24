import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { addDays, findDaySection, fromIsoDate, LIST_LINE_RE, parseItem, toIsoDate } from "../src/parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const desk = readFileSync(join(here, "fixtures/desk-2026-10.md"), "utf8");
const pythonExpected: Array<{
	line: number;
	raw: string;
	kind: string;
	status: string;
	time: string;
	text: string;
	tags: string[];
	fields: [string, string][];
	assignRaw: [number, number][];
	assignWeek: number[];
	movedTo: string;
	test: boolean;
	goal: string;
}> = JSON.parse(readFileSync(join(here, "fixtures/desk-2026-10.python-expected.json"), "utf8"));

test("### 2026-10-24 section: every line parses as expected", () => {
	const sec = findDaySection(desk, "2026-10-24");
	assert.equal(sec.found, true);
	const lines = desk.split("\n");
	assert.equal(lines[sec.headingIndex], "### 2026-10-24");
	// Body runs until the next heading (### 2026-10-25), blank lines skipped.
	assert.equal(lines[sec.end], "### 2026-10-25");
	assert.deepEqual(
		sec.lines.map((l) => l.line),
		["- [ ] 웨이트 운동 #test", "- 18:30 가족 외식 #가족 #test", "- 출장용 상비약 챙기기 #test"],
	);
	for (const l of sec.lines) assert.equal(lines[l.index], l.line, "index points at the source line");

	const [a, b, c] = sec.lines.map((l) => l.item!);
	assert.deepEqual(
		{ kind: a.kind, status: a.status, checkbox: a.checkbox, text: a.text, tags: a.tags, test: a.test, time: a.time },
		{ kind: "task", status: "scheduled", checkbox: " ", text: "웨이트 운동", tags: [], test: true, time: "" },
	);
	assert.deepEqual(
		{ kind: b.kind, status: b.status, time: b.time, text: b.text, tags: b.tags, test: b.test },
		{ kind: "event", status: "scheduled", time: "18:30", text: "가족 외식", tags: ["가족"], test: true },
	);
	assert.deepEqual(
		{ kind: c.kind, status: c.status, time: c.time, text: c.text, tags: c.tags, test: c.test },
		{ kind: "note", status: "scheduled", time: "", text: "출장용 상비약 챙기기", tags: [], test: true },
	);
	for (const it of [a, b, c]) assert.deepEqual(it.problems, []);
});

test("parity with the Python reference parser for every item in 2026-10.md", () => {
	const lines = desk.split("\n");
	assert.ok(pythonExpected.length > 50);
	for (const exp of pythonExpected) {
		const raw = lines[exp.line - 1];
		assert.equal(raw, exp.raw);
		const m = LIST_LINE_RE.exec(raw.trim())!;
		const it = parseItem(m[3].trim());
		const got = {
			kind: it.kind,
			status: it.status,
			time: it.time,
			text: it.text,
			tags: it.tags,
			fields: it.fields,
			assignRaw: it.assignRaw,
			assignWeek: it.assignWeek,
			movedTo: it.movedTo,
			test: it.test,
			goal: it.goal,
		};
		const { line: _l, raw: _r, ...want } = exp;
		assert.deepEqual(got, want, `line ${exp.line}: ${raw}`);
	}
});

test("grammar: all states and decorations", () => {
	const done = parseItem("[x] 견적서 회신 #회사");
	assert.equal(done.status, "done");
	assert.equal(parseItem("[X] 대문자 완료").status, "done");

	const moved = parseItem("[>] 은행 서류 제출 → 10/27 (moved:: 1) #test");
	assert.equal(moved.status, "moved");
	assert.equal(moved.movedTo, "10/27");
	assert.equal(moved.text, "은행 서류 제출");
	assert.deepEqual(moved.fields, [["moved", "1"]]);

	const dropped = parseItem("[-] 신규 앱 체험해 보기 (why:: 지금 목표와 관계없음) #test");
	assert.equal(dropped.status, "cancelled");
	assert.deepEqual(dropped.fields, [["why", "지금 목표와 관계없음"]]);

	const cancelledEvent = parseItem("~~19:00 대학 동기 모임~~ #test");
	assert.equal(cancelledEvent.kind, "event");
	assert.equal(cancelledEvent.status, "cancelled");
	assert.equal(cancelledEvent.time, "19:00");
	assert.equal(cancelledEvent.text, "대학 동기 모임");

	const movedEvent = parseItem("10/15 부산 출장 → [[03 Desk Calendar/2026/2026-10]]");
	assert.equal(movedEvent.status, "moved");
	assert.equal(movedEvent.movedTo, "2026-10");

	const tagEvent = parseItem("한글날 #행사");
	assert.equal(tagEvent.kind, "event");
	assert.equal(tagEvent.eventTag, true);
	assert.deepEqual(tagEvent.tags, []);

	const goal = parseItem("[ ] 10:00 강의 3강 촬영 (goal:: G-2026-01.2)");
	assert.equal(goal.goal, "G-2026-01.2");
	assert.equal(goal.time, "10:00");

	const multi = parseItem("[ ] 혼팀 릴스 2개 → 11/05, 11/07");
	assert.deepEqual(multi.assignRaw, [[11, 5], [11, 7]]);
	assert.deepEqual(parseItem("[ ] 연말정산 → W44").assignWeek, [44]);

	const old = parseItem("○ 옛 기호");
	assert.equal(old.ok, false);
	assert.equal(old.kind, null);

	const bad = parseItem("[?] 이상한 상자");
	assert.equal(bad.kind, "task");
	assert.equal(bad.problems.length, 1);
});

test("findDaySection: missing day, empty day, frontmatter", () => {
	assert.equal(findDaySection(desk, "2026-10-40").found, false);
	assert.equal(findDaySection(desk, "2026-11-01").found, false);
	const empty = findDaySection(desk, "2026-10-17"); // immediately followed by ### 2026-10-18
	assert.equal(empty.found, true);
	assert.deepEqual(empty.lines, []);
	const last = findDaySection(desk, "2026-10-31"); // last section, runs to EOF
	assert.equal(last.lines.length, 3);
});

test("date helpers", () => {
	assert.equal(addDays("2026-10-31", 1), "2026-11-01");
	assert.equal(addDays("2026-01-01", -1), "2025-12-31");
	assert.equal(fromIsoDate("2026-02-30"), null);
	assert.equal(toIsoDate(fromIsoDate("2026-10-24")!), "2026-10-24");
});
