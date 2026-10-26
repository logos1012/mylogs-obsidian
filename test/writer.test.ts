import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findDaySection } from "../src/parser.ts";
import { flywheelLines, parseFlywheel } from "../src/flywheel/model.ts";
import {
	appendToSection,
	dailyPadSkeleton,
	findSection,
	getSectionContent,
	listSections,
	replaceSectionContent,
	setFrontmatterScalar,
	splitBody,
	toggleCheckbox,
} from "../src/writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const desk = readFileSync(join(here, "fixtures/desk-2026-10.md"), "utf8");
const pad = readFileSync(join(here, "fixtures/daily-2026-10-24.md"), "utf8");

/** Count differing characters between two equal-length strings. */
function diffChars(a: string, b: string): number[] {
	assert.equal(a.length, b.length, "length unchanged");
	const out: number[] = [];
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
	return out;
}

test("toggle a Desk Calendar checkbox changes exactly one character", () => {
	const sec = findDaySection(desk, "2026-10-24");
	const task = sec.lines[0];
	const r = toggleCheckbox(desk, { index: task.index, line: task.line, scope: { start: sec.start, end: sec.end } });
	assert.ok(r.ok);
	const diffs = diffChars(desk, r.text);
	assert.equal(diffs.length, 1);
	assert.equal(r.text[diffs[0]], "x");
	assert.equal(desk[diffs[0]], " ");
	assert.equal(r.text.split("\n")[task.index], "- [x] 웨이트 운동 #test");

	// …and back again restores the original byte-for-byte.
	const back = toggleCheckbox(r.text, { index: task.index, line: "- [x] 웨이트 운동 #test" });
	assert.ok(back.ok);
	assert.equal(back.text, desk);
});

test("toggle finds the line by content when line numbers shifted, within the day only", () => {
	const sec = findDaySection(desk, "2026-10-24");
	const task = sec.lines[0];
	// Someone (Hermes) inserted two lines above the day section after we rendered.
	const shifted = desk.replace("### 2026-10-24\n", "### 2026-10-24\n- 새 메모 하나\n- 또 하나\n");
	const now = findDaySection(shifted, "2026-10-24");
	const r = toggleCheckbox(shifted, { index: task.index, line: task.line, scope: { start: now.start, end: now.end } });
	assert.ok(r.ok);
	assert.equal(r.index, task.index + 2);
	assert.equal(diffChars(shifted, r.text).length, 1);

	// The identical line `- [ ] 웨이트 운동 #test` on 10-26 must not be toggled instead.
	const removed = desk.replace("### 2026-10-24\n- [ ] 웨이트 운동 #test\n", "### 2026-10-24\n");
	const sec2 = findDaySection(removed, "2026-10-24");
	const miss = toggleCheckbox(removed, { index: task.index, line: task.line, scope: { start: sec2.start, end: sec2.end } });
	assert.deepEqual(miss, { ok: false, reason: "not-found" });
});

test("toggle refuses [>] and [-] and unknown lines", () => {
	const lines = pad.split("\n");
	const movedIdx = lines.findIndex((l) => l.startsWith("- [>]"));
	const droppedIdx = lines.findIndex((l) => l.startsWith("- [-]"));
	assert.deepEqual(toggleCheckbox(pad, { index: movedIdx, line: lines[movedIdx] }), { ok: false, reason: "not-toggleable" });
	assert.deepEqual(toggleCheckbox(pad, { index: droppedIdx, line: lines[droppedIdx] }), { ok: false, reason: "not-toggleable" });
	assert.deepEqual(toggleCheckbox(pad, { index: 3, line: "- [ ] 없는 줄" }), { ok: false, reason: "not-found" });
});

test("sections of the Daily Pad fixture", () => {
	assert.deepEqual(listSections(pad), ["결정 대기", "오늘 할 일", "메모", "로그", "끼적임", "자료"]);
	assert.equal(
		getSectionContent(pad, "끼적임"),
		"혼팀 파이프라인을 어떻게 시작하지? 대본 → 이미지 → 영상 → 업로드 순서로 나눠 보면,\n제일 막히는 건 대본이다. 대본만 먼저 자동화해 볼까. #test",
	);
	assert.equal(getSectionContent(pad, "없는 섹션"), null);
	const body = (() => {
		const r = findSection(pad, "메모")!;
		return pad.slice(r.bodyStart, r.bodyEnd);
	})();
	const parts = splitBody(body);
	assert.equal(parts.lead + parts.core + parts.tail, body);
});

test("replacing a section body preserves the rest of the file byte-for-byte", () => {
	const r = findSection(pad, "메모")!;
	const before = pad.slice(0, r.bodyStart);
	const after = pad.slice(r.bodyEnd);
	const out = replaceSectionContent(pad, "메모", "- 완전히 새 메모\n- 두 번째 줄");
	assert.ok(out.startsWith(before), "everything before the body is unchanged");
	assert.ok(out.endsWith(after), "everything after the body is unchanged");
	assert.equal(getSectionContent(out, "메모"), "- 완전히 새 메모\n- 두 번째 줄");
	// The blank line separating the section from the next heading is kept.
	assert.ok(out.includes("- 두 번째 줄\n\n## 로그\n"));

	// Same content → identical text (no write needed).
	assert.equal(replaceSectionContent(pad, "메모", getSectionContent(pad, "메모")!), pad);
	// Round trip.
	assert.equal(replaceSectionContent(out, "메모", getSectionContent(pad, "메모")!), pad);
	// Trailing whitespace from a textarea doesn't matter.
	assert.equal(replaceSectionContent(pad, "메모", getSectionContent(pad, "메모")! + "\n\n  "), pad);
});

test("last section (to EOF), empty sections, missing sections", () => {
	const r = findSection(pad, "자료")!;
	const out = replaceSectionContent(pad, "자료", "- 하나\n- 둘");
	assert.equal(out.slice(0, r.bodyStart), pad.slice(0, r.bodyStart));
	assert.ok(out.endsWith("## 자료\n- 하나\n- 둘\n"));

	const skel = dailyPadSkeleton({ isoDate: "2026-10-25", weekday: "일", deskCalendarFolder: "03 Desk Calendar", sections: ["오늘 할 일", "메모", "로그", "끼적임", "자료"] });
	const s1 = replaceSectionContent(skel, "메모", "- 첫 메모");
	assert.equal(s1, skel.replace("## 메모\n\n## 로그", "## 메모\n- 첫 메모\n\n## 로그"));
	const s2 = replaceSectionContent(skel, "자료", "- 링크");
	assert.equal(s2, skel + "- 링크\n");
	// Clearing restores the empty skeleton.
	assert.equal(replaceSectionContent(s1, "메모", ""), skel);
	assert.equal(replaceSectionContent(s2, "자료", ""), skel);

	// Missing section is appended at the end.
	const s3 = replaceSectionContent(skel, "결정 대기", "- [ ] 무언가");
	assert.ok(s3.startsWith(skel));
	assert.ok(s3.endsWith("\n## 결정 대기\n- [ ] 무언가\n"));
});

test("appendToSection adds a task line only inside that section", () => {
	const out = appendToSection(pad, "오늘 할 일", "- [ ] 새 할 일");
	const r = findSection(pad, "오늘 할 일")!;
	assert.equal(out.slice(0, r.bodyStart), pad.slice(0, r.bodyStart));
	assert.ok(out.endsWith(pad.slice(r.bodyEnd)));
	assert.ok(out.includes("- [-] 신규 앱 체험해 보기 (why:: 지금 목표와 관계없음) #test\n- [ ] 새 할 일\n\n## 메모"));
});

test("CRLF files keep CRLF", () => {
	const crlf = pad.replace(/\n/g, "\r\n");
	const out = replaceSectionContent(crlf, "메모", "- a\n- b");
	assert.ok(!/[^\r]\n/.test(out), "no bare LF introduced");
	assert.equal(getSectionContent(out, "메모"), "- a\n- b");
	const r = findSection(crlf, "메모")!;
	assert.ok(out.endsWith(crlf.slice(r.bodyEnd)));
});

test("setFrontmatterScalar edits one line without reformatting", () => {
	const out = setFrontmatterScalar(pad, "updated", "2026-10-25");
	const diffLines = out.split("\n").filter((l, i) => l !== pad.split("\n")[i]);
	assert.deepEqual(diffLines, ["updated: 2026-10-25"]);
	assert.equal(setFrontmatterScalar(pad, "updated", "2026-10-24"), pad, "no-op when equal");
	const noKey = pad.replace("updated: 2026-10-24\n", "");
	assert.ok(setFrontmatterScalar(noKey, "updated", "2026-10-25").includes("test: true\nupdated: 2026-10-25\n---\n"));
	assert.equal(setFrontmatterScalar("# no frontmatter\n", "updated", "x"), "# no frontmatter\n");
});

test("skeleton matches new_day.py render() exactly", () => {
	const expected =
		"---\n" +
		"type: daily-pad\n" +
		"date: 2026-10-24\n" +
		'desk_calendar: "03 Desk Calendar/2026/2026-10.md"\n' +
		"torn_off: false\n" +
		"updated: 2026-10-24\n" +
		"---\n\n" +
		"# 2026-10-24 (토)\n\n" +
		"![[03 Desk Calendar/2026/2026-10#2026-10-24]]\n" +
		"\n## 오늘 할 일\n\n## 메모\n\n## 로그\n\n## 끼적임\n\n## 자료\n";
	const got = dailyPadSkeleton({
		isoDate: "2026-10-24",
		weekday: "토",
		deskCalendarFolder: "03 Desk Calendar",
		sections: ["오늘 할 일", "메모", "로그", "끼적임", "자료"],
	});
	assert.equal(got, expected);
	// …and byte-for-byte against the output of the real new_day.py (generated into fixtures).
	assert.equal(got, readFileSync(join(here, "fixtures/new_day-2026-10-24.md"), "utf8"));
	const nov = dailyPadSkeleton({
		isoDate: "2026-11-01",
		weekday: "일",
		deskCalendarFolder: "03 Desk Calendar",
		sections: ["오늘 할 일", "메모", "로그", "끼적임", "자료"],
	});
	assert.equal(nov, readFileSync(join(here, "fixtures/new_day-2026-11-01.md"), "utf8"));
	// With `12 Flywheel/Flywheel.md` present, new_day.py opens 오늘 할 일 with the 사용 elements.
	const flywheel = flywheelLines(parseFlywheel(readFileSync(join(here, "fixtures/flywheel/Flywheel.md"), "utf8")));
	assert.equal(flywheel.length, 3);
	const withFlywheel = dailyPadSkeleton({
		isoDate: "2026-10-24",
		weekday: "토",
		deskCalendarFolder: "03 Desk Calendar",
		sections: ["오늘 할 일", "메모", "로그", "끼적임", "자료"],
		flywheelLines: flywheel,
	});
	assert.equal(withFlywheel, readFileSync(join(here, "fixtures/new_day-2026-10-24.flywheel.md"), "utf8"));
});
