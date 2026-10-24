import { test } from "node:test";
import assert from "node:assert/strict";
import {
	contentText,
	getField,
	normalizeTime,
	replaceContent,
	setField,
	setFields,
	setLead,
	spliceLine,
	splitContent,
	TIME_LEAD_RE,
} from "../src/line-edit.ts";
import { splitLinesKeepEol } from "../src/parser.ts";
import { WALL_DATE_RE } from "../src/wall/parse.ts";

test("splitContent: parts always join back to the body", () => {
	const cases: [string, RegExp | null][] = [
		["[ ] 11/14 Claude Code 강의 1~5강 완성 (goal:: G-2026-01.2) #test", WALL_DATE_RE],
		["~~05/09 워크숍~~ #test", WALL_DATE_RE],
		["10/03 가족 여행 → [[03 Desk Calendar/2026/2026-10]] #회사", WALL_DATE_RE],
		["[ ] 혼팀 릴스 업로드 → 10/07, 10/09 (goal:: G-2026-03.1) #test", TIME_LEAD_RE],
		["14:00 회사 월간 회의 #회사 #test", TIME_LEAD_RE],
		["[-] 신규 앱 체험해 보기 (why:: 지금 목표와 관계없음)", TIME_LEAD_RE],
		["한글날 #행사", null],
		["[ ] ", null],
	];
	for (const [b, re] of cases) {
		const p = splitContent(b, re);
		assert.equal(p.pre + p.lead + p.content + p.post, b, b);
	}
	assert.deepEqual(splitContent("[>] 은행 서류 제출 → 10/27 (moved:: 1)", TIME_LEAD_RE), {
		pre: "[>] ",
		lead: "",
		content: "은행 서류 제출",
		post: " → 10/27 (moved:: 1)",
	});
});

test("replaceContent changes only the words", () => {
	assert.equal(replaceContent("[ ] 혼팀 릴스 업로드 → 10/07, 10/09 (goal:: G-2026-03.1) #test", "혼팀 릴스 2개 업로드", TIME_LEAD_RE), "[ ] 혼팀 릴스 2개 업로드 → 10/07, 10/09 (goal:: G-2026-03.1) #test");
	assert.equal(replaceContent("14:00 회사 월간 회의 #회사 #test", "본부 회의", TIME_LEAD_RE), "14:00 본부 회의 #회사 #test");
	assert.equal(replaceContent("~~05/09 워크숍~~ #test", "팀 워크숍", WALL_DATE_RE), "~~05/09 팀 워크숍~~ #test");
	// fields/tags written in the middle are kept
	assert.equal(replaceContent("[ ] 강의 (goal:: G-1) 촬영 #회사 마무리 #test", "강의 촬영", null), "[ ] 강의 촬영 (goal:: G-1) #회사 #test");
	assert.equal(contentText("[ ] 강의 (goal:: G-1) 촬영 #회사 마무리 #test"), "강의 촬영 마무리");
	// new lines are flattened
	assert.equal(replaceContent("[ ] a #t", "b\nc"), "[ ] b c #t");
});

test("setLead adds, replaces and removes a time", () => {
	assert.equal(setLead("[ ] 10:00 회의 #a", "", TIME_LEAD_RE), "[ ] 회의 #a");
	assert.equal(setLead("[ ] 회의 #a", "09:00", TIME_LEAD_RE), "[ ] 09:00 회의 #a");
	assert.equal(setLead("~~19:00 모임~~", "20:00", TIME_LEAD_RE), "~~20:00 모임~~");
	assert.equal(normalizeTime("9:00"), "09:00");
	assert.equal(normalizeTime("9:00 ~ 10:30"), "09:00~10:30");
	assert.equal(normalizeTime("25:00"), null);
	assert.equal(normalizeTime(""), "");
});

test("fields: set in place, add before tags, remove", () => {
	assert.equal(getField("[ ] x (goal:: G-1) (project:: P-a) #t", "project"), "P-a");
	assert.equal(setField("[ ] x #a #b", "goal", "G-1"), "[ ] x (goal:: G-1) #a #b");
	assert.equal(setField("[ ] x (moved:: 1) #a", "goal", "G-1"), "[ ] x (moved:: 1) (goal:: G-1) #a");
	assert.equal(setField("[ ] x (goal:: G-1) #a", "goal", "G-2"), "[ ] x (goal:: G-2) #a");
	assert.equal(setField("[ ] x (goal:: G-1) #a", "goal", ""), "[ ] x #a");
	assert.equal(setField("[ ] x", "why", "이유 (메모)"), "[ ] x (why:: 이유 메모)");
	// unchanged values are not rewritten
	const b = "[ ] x (goal::G-1) #a";
	assert.equal(setFields(b, { goal: "G-1", project: "" }), b);
});

test("spliceLine keeps terminators right", () => {
	assert.equal(spliceLine(splitLinesKeepEol("a\nb\nc\n"), 1), "a\nc\n");
	assert.equal(spliceLine(splitLinesKeepEol("a\nb\nc"), 2), "a\nb");
	assert.equal(spliceLine(splitLinesKeepEol("a\r\nb\r\n"), 0), "b\r\n");
});
