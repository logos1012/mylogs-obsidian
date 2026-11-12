import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	dayLine,
	flowOf,
	flowUpdatedLabel,
	flowUpdatedOf,
	isoWeekKey,
	parseMyLifeFile,
	TEMPLATE_SECTIONS,
	WEEK_FLOW_SECTION,
	weekDates,
} from "../src/mylife/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/my-life", p), "utf8");

// ───────────────────────── weekDates ─────────────────────────

test("week-flow: weekDates gives Monday..Sunday of the ISO week", () => {
	const w = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10", "2026-01-11"];
	assert.deepEqual(weekDates("2026-01-05"), w);
	assert.deepEqual(weekDates("2026-01-08"), w);
	assert.deepEqual(weekDates("2026-01-11"), w);
	assert.deepEqual(weekDates("2026-11-12"), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
});

test("week-flow: weekDates across a year boundary (2025-12-29 is 2026-W01)", () => {
	const w = ["2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];
	assert.deepEqual(weekDates("2025-12-29"), w);
	assert.deepEqual(weekDates("2026-01-04"), w);
	assert.ok(w.every((d) => isoWeekKey(d) === "2026-W01"));
	// 2027-01-01 (Fri) still belongs to 2026-W53.
	assert.deepEqual(weekDates("2027-01-01"), ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
});

test("week-flow: weekDates of an invalid date is empty", () => {
	assert.deepEqual(weekDates(""), []);
	assert.deepEqual(weekDates("2026-02-30"), []);
	assert.deepEqual(weekDates("not a date"), []);
});

// ───────────────────────── dayLine ─────────────────────────

const daily = (body: string) => `---\ntype: my-life-daily\n---\n# 2026-11-12 (목)\n\n${body}`;

test("week-flow: dayLine takes the first sentence of the fixture's 하루", () => {
	assert.equal(dayLine(fx("daily/2026-01-05.md")), "새해 첫 출근.");
	for (const d of ["06", "07", "08", "09", "10", "11"]) {
		const line = dayLine(fx(`daily/2026-01-${d}.md`));
		assert.ok(line && line.length > 0, `2026-01-${d}`);
		assert.match(line!, /[.?!。…]["'”’」』)\]]*$/, `2026-01-${d}: ${line}`);
	}
});

test("week-flow: dayLine strips comments and links, collapses whitespace", () => {
	const t = daily(`## 하루\n\n<!-- 템플릿 안내 -->\n[[08 My Life/01 Daily/2026/2026-11/2026-11-11|어제]]에 이어   [보고서](https://x.y/z) 정리를\n**마쳤다**. 그다음은 [[Pinboard]].\n\n## 한 일\n\n- 무엇\n`);
	assert.equal(dayLine(t), "어제에 이어 보고서 정리를 마쳤다.");
	assert.equal(dayLine(daily(`## 하루\n\n[[Pinboard]] 보고 쉬었다\n`)), "Pinboard 보고 쉬었다");
});

test("week-flow: dayLine sentence ends (다. 요. 까? !) and no split inside numbers", () => {
	assert.equal(dayLine(daily("## 하루\n\n5.5km를 뛰었다. 다리가 무겁다.\n")), "5.5km를 뛰었다.");
	assert.equal(dayLine(daily("## 하루\n\n이걸 계속해도 될까? 모르겠다.\n")), "이걸 계속해도 될까?");
	assert.equal(dayLine(daily("## 하루\n\n좋았어요! 내일도.\n")), "좋았어요!");
	assert.equal(dayLine(daily("## 하루\n\n「끝났다.」 하고 말했다.\n")), "「끝났다.」");
});

test("week-flow: dayLine falls back to the first paragraph, null when missing or empty", () => {
	assert.equal(dayLine(daily("## 하루\n\n마침표 없는 한 단락\n이어지는 줄\n\n둘째 단락.\n")), "마침표 없는 한 단락 이어지는 줄");
	assert.equal(dayLine(daily("## 하루\n\n<!-- 주석만 -->\n\n## 한 일\n\n- x\n")), null);
	assert.equal(dayLine(daily("## 하루\n\n## 한 일\n\n- x\n")), null);
	assert.equal(dayLine(daily("## 한 일\n\n- x\n")), null);
	assert.equal(dayLine(""), null);
});

// ───────────────────────── flowOf ─────────────────────────

const weekly = (fm: string, flow: string | null) =>
	`---\ntype: my-life-weekly\nweek: 2026-W46\nstatus: 초안\n${fm}---\n# 2026-W46 (11/09~11/15)\n\n${flow === null ? "" : `## 이번 주 흐름\n\n${flow}\n\n`}## 한 주\n\n<!-- 4~6문장. -->\n`;

test("week-flow: flowOf returns the section content", () => {
	const t = weekly("", "월요일엔 보고서를 붙잡았고, **수요일**부터 [[워크숍]] 준비로 넘어갔다.\n\n- 목: 발표 초안");
	assert.equal(flowOf(t), "월요일엔 보고서를 붙잡았고, **수요일**부터 [[워크숍]] 준비로 넘어갔다.\n\n- 목: 발표 초안");
});

test("week-flow: flowOf is null when the section is comment-only, blank or missing", () => {
	assert.equal(flowOf(weekly("", "<!-- 주중에 Tear-off가 매일 저녁 다시 쓴다. -->")), null);
	assert.equal(flowOf(weekly("", "<!-- a -->\n\n   \n<!--\nb\n-->")), null);
	assert.equal(flowOf(weekly("", "")), null);
	assert.equal(flowOf(weekly("", null)), null);
	assert.equal(flowOf(fx("weekly/2026-W02.md")), null);
	// The plugin's copy of the template has the section, comment-only.
	assert.equal(flowOf(fx("templates/Weekly.md")), null);
});

test("week-flow: 이번 주 흐름 is the first weekly template section and parses as inTemplate", () => {
	assert.equal(TEMPLATE_SECTIONS.weekly[0], WEEK_FLOW_SECTION);
	assert.equal(TEMPLATE_SECTIONS.weekly[1], "한 주");
	const f = parseMyLifeFile(weekly("", "흐름이 있다."), "weekly");
	assert.deepEqual(
		f.sections.map((s) => [s.name, s.empty, s.inTemplate]),
		[
			[WEEK_FLOW_SECTION, false, true],
			["한 주", true, true],
		],
	);
	const g = parseMyLifeFile(weekly("", "<!-- 주석 -->"), "weekly");
	assert.equal(g.sections[0].empty, true);
});

// ───────────────────────── flow_updated_at ─────────────────────────

test("week-flow: flow_updated_at → HH:mm 기준 in KST", () => {
	assert.equal(flowUpdatedLabel("2026-11-12T22:05:00+09:00"), "22:05 기준");
	assert.equal(flowUpdatedLabel("2026-11-12T13:05:00Z"), "22:05 기준");
	assert.equal(flowUpdatedLabel("2026-11-12T20:30:00.000Z"), "05:30 기준");
	assert.equal(flowUpdatedLabel("2026-11-12T08:05:00-05:00"), "22:05 기준");
	assert.equal(flowUpdatedLabel("2026-11-12 22:05"), "22:05 기준");
	assert.equal(flowUpdatedOf(weekly("flow_updated_at: 2026-11-12T22:05:00+09:00\n", "흐름.")), "22:05 기준");
	assert.equal(flowUpdatedOf(weekly('flow_updated_at: "2026-11-12T13:05:00Z"\n', "흐름.")), "22:05 기준");
});

test("week-flow: empty, missing or invalid flow_updated_at shows no time", () => {
	assert.equal(flowUpdatedOf(weekly("flow_updated_at:\n", "흐름.")), null);
	assert.equal(flowUpdatedOf(weekly('flow_updated_at: ""\n', "흐름.")), null);
	assert.equal(flowUpdatedOf(weekly("flow_updated_at:    \n", "흐름.")), null);
	assert.equal(flowUpdatedOf(weekly("", "흐름.")), null);
	assert.equal(flowUpdatedLabel(""), null);
	assert.equal(flowUpdatedLabel("   "), null);
	assert.equal(flowUpdatedLabel(null), null);
	assert.equal(flowUpdatedLabel(undefined), null);
	assert.equal(flowUpdatedLabel("어제 저녁"), null);
	assert.equal(flowUpdatedLabel("2026-11-12"), null);
	assert.equal(flowUpdatedLabel("2026-11-12T25:00:00+09:00"), null);
});
