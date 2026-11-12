import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	DAY_FLOW_SECTION,
	dailyItemsByScope,
	dayLine,
	dayText,
	parseDayFlow,
	weekFlowCell,
	flowOf,
	flowSummary,
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

// ───────────────────────── flowSummary (v2.3 개인 / 회사 rows) ─────────────────────────

test("week-flow: flowSummary parses 개인 / 회사 bullets with markdown and continuation lines", () => {
	const t = weekly(
		"",
		"<!-- 예시\n- 개인: 두세 문장\n- 회사: 두세 문장\n-->\n- 개인: 월요일엔 **산책**을 했고\n  수요일엔 [[독서모임]]에 갔다.\n- 회사： 보고서를 끝냈다.\n이어서 `발표` 준비.",
	);
	assert.deepEqual(flowSummary(t), {
		kind: "rows",
		personal: "월요일엔 **산책**을 했고\n수요일엔 [[독서모임]]에 갔다.",
		company: "보고서를 끝냈다.\n이어서 `발표` 준비.",
	});
	// flowOf stays the raw section.
	assert.ok(flowOf(t)?.startsWith("<!-- 예시"));
});

test("week-flow: flowSummary with only one bullet leaves the other row empty", () => {
	assert.deepEqual(flowSummary(weekly("", "- 회사: 워크숍 준비.")), { kind: "rows", personal: null, company: "워크숍 준비." });
	assert.deepEqual(flowSummary(weekly("", "- 개인: 쉬었다.")), { kind: "rows", personal: "쉬었다.", company: null });
});

test("week-flow: flowSummary treats an explicit — as a quiet empty row, not placeholder or legacy", () => {
	assert.deepEqual(flowSummary(weekly("", "- 개인: —\n- 회사: 회의 세 개.")), { kind: "rows", personal: null, company: "회의 세 개." });
	assert.deepEqual(flowSummary(weekly("", "- 개인: —\n- 회사: —")), { kind: "rows", personal: null, company: null });
	assert.deepEqual(flowSummary(weekly("", "- 개인:\n- 회사: —")), { kind: "rows", personal: null, company: null });
});

test("week-flow: flowSummary falls back to the whole section for the old paragraph format", () => {
	const text = "월요일엔 보고서를 붙잡았고, **수요일**부터 [[워크숍]] 준비로 넘어갔다.\n\n- 목: 발표 초안";
	assert.deepEqual(flowSummary(weekly("", text)), { kind: "legacy", text });
	// 개인/회사 mentioned mid-sentence is not a bullet.
	const prose = "개인: 이런 말은 문장 속에 있다.";
	assert.deepEqual(flowSummary(weekly("", prose)), { kind: "legacy", text: prose });
});

test("week-flow: flowSummary is null for missing / blank / comment-only sections, even with example bullets", () => {
	assert.equal(flowSummary(weekly("", "<!-- 두 줄로.\n- 개인: 두세 문장\n- 회사: 두세 문장\n-->")), null);
	assert.equal(flowSummary(weekly("", "<!-- a -->\n\n   \n<!--\nb\n-->")), null);
	assert.equal(flowSummary(weekly("", "")), null);
	assert.equal(flowSummary(weekly("", null)), null);
	assert.equal(flowSummary(fx("weekly/2026-W02.md")), null);
	// The plugin's copy of the template (v2.3) has example bullets inside the comment.
	const tpl = fx("templates/Weekly.md");
	assert.match(tpl, /<!--[^>]*- 개인:[^>]*- 회사:[^>]*-->/);
	assert.equal(flowSummary(tpl), null);
});

test("week-flow: 이번 주 흐름 is the first weekly template section and parses as inTemplate", () => {
	assert.equal(TEMPLATE_SECTIONS.weekly[0], WEEK_FLOW_SECTION);
	assert.equal(TEMPLATE_SECTIONS.weekly[1], DAY_FLOW_SECTION);
	assert.equal(TEMPLATE_SECTIONS.weekly[2], "한 주");
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

// ───────────────────────── 요일별 흐름 ─────────────────────────

const dayFlowWeekly = (section: string | null) =>
	`---\ntype: my-life-weekly\nflow_updated_at: 2026-11-12T22:05:00+09:00\n---\n# 2026-W46 (11/09~11/15)\n\n## 이번 주 흐름\n\n흐름.\n\n${
		section === null ? "" : `## 요일별 흐름\n\n${section}\n\n`
	}## 한 주\n\n<!-- 4~6문장. -->\n`;

const obj = (m: Map<string, unknown>) => Object.fromEntries(m);

test("week-flow: parseDayFlow reads days, weekday labels, both scopes and continuation lines", () => {
	const t = dayFlowWeekly(
		[
			"### 2026-11-09 (월)",
			"- 개인: 아침에 **5km** 뛰었다.",
			"- 회사: [[보고서]] 초안을 넘겼다.",
			"  박팀장 피드백은 내일.",
			"",
			"### 2026-11-10",
			"- 회사：워크숍 준비.",
			"",
			"### 2026-11-11 (수)",
			"- 개인: —",
			"- 회사: 리뷰 두 건.",
		].join("\n"),
	);
	assert.deepEqual(obj(parseDayFlow(t)), {
		"2026-11-09": { personal: "아침에 **5km** 뛰었다.", company: "[[보고서]] 초안을 넘겼다.\n박팀장 피드백은 내일." },
		"2026-11-10": { personal: null, company: "워크숍 준비." },
		"2026-11-11": { personal: "—", company: "리뷰 두 건." },
	});
});

test("week-flow: parseDayFlow strips multi-line comments before headings (template examples parse as nothing)", () => {
	// The plugin's template copy: the section holds only a comment with example ### / - 개인: lines.
	assert.deepEqual(obj(parseDayFlow(fx("templates/Weekly.md"))), {});
	const commentOnly = dayFlowWeekly("<!-- 예시\n### 2026-11-09 (월)\n- 개인: 한두 문장\n- 회사: 한두 문장\n-->");
	assert.equal(parseDayFlow(commentOnly).size, 0);
	assert.equal(parseDayFlow(dayFlowWeekly("<!-- a -->\n\n<!--\n### 2026-11-10\n-->")).size, 0);
});

test("week-flow: parseDayFlow of a missing section is empty; sample weekly has none", () => {
	assert.equal(parseDayFlow(dayFlowWeekly(null)).size, 0);
	assert.equal(parseDayFlow(fx("weekly/2026-W02.md")).size, 0);
	assert.equal(parseDayFlow("").size, 0);
});

test("week-flow: parseDayFlow ignores comments inside a day, skips invalid headings, keeps empty days with nulls", () => {
	const t = dayFlowWeekly(
		[
			"### 2026-11-09 (월)",
			"<!-- Tear-off 메모: 다시 쓸 것 -->",
			"- 개인: 산책. <!-- 인라인 주석 -->",
			"<!--",
			"- 회사: 주석 안의 가짜 줄",
			"-->",
			"",
			"### 2026-02-30 (월)",
			"- 개인: 없는 날",
			"",
			"### 메모",
			"- 회사: 제목이 날짜가 아님",
			"",
			"### 2026-11-10 (화)",
			"",
			"### 2026-11-11 (수)",
			"- 회사:   ",
			"- 기타: 무시",
		].join("\n"),
	);
	assert.deepEqual(obj(parseDayFlow(t)), {
		"2026-11-09": { personal: "산책.", company: null },
		"2026-11-10": { personal: null, company: null },
		"2026-11-11": { personal: null, company: null },
	});
});

test("week-flow: dailyItemsByScope splits the fixture's 한 일 by #회사 and strips links, tags and fields", () => {
	const r = dailyItemsByScope(fx("daily/2026-01-05.md"));
	assert.deepEqual(r.company, [
		"분기 보고서 현행 절차 정리: 수작업 단계 11개 목록화",
		"박팀장 보고용 자동화 범위 제안 메모 작성 (발송·실행 미확인)",
		"데이터 소스 4개(ERP 매출·인사 현황·비용 집계·고객 CS) 추출 가능 여부 확인",
		"엑셀 매크로 vs 파이썬 스크립트 비교 (유지보수·이대리 학습 비용 기준)",
	]);
	assert.deepEqual(r.personal, ["저녁 5km 달리기, 31분", "뉴스레터 3호 후보 주제 3개 정리"]);
});

test("week-flow: dailyItemsByScope link labels, untagged = 개인, nested lines and comments ignored", () => {
	const t = daily(
		[
			"## 한 일",
			"",
			"<!-- - 템플릿 예시 #회사 -->",
			"- [[08 My Life/Pinboard|핀보드]] 정리하고 [문서](https://x.y) 읽음 #회사 (세션: 정리)",
			"- [[워크숍]] 숙소 예약   두 곳 비교 #sample",
			"  - 하위 메모 #회사",
			"- [x] 장보기 (project:: P-1) (Daily Pad)",
			"",
			"## 결정",
			"",
			"- 무엇 #회사",
		].join("\n"),
	);
	assert.deepEqual(dailyItemsByScope(t), {
		personal: ["워크숍 숙소 예약 두 곳 비교", "장보기"],
		company: ["핀보드 정리하고 문서 읽음"],
	});
	assert.deepEqual(dailyItemsByScope(daily("## 한 일\n\n<!-- 없음 -->\n\n## 결정\n\n- x\n")), { personal: [], company: [] });
	assert.deepEqual(dailyItemsByScope(daily("## 하루\n\n하루.\n")), { personal: [], company: [] });
	assert.deepEqual(dailyItemsByScope(""), { personal: [], company: [] });
});

test("week-flow: weekFlowCell — weekly flow wins over Daily items", () => {
	const items = { personal: ["a"], company: ["b"] };
	assert.deepEqual(weekFlowCell({ personal: "개인 흐름", company: "회사 흐름" }, items), {
		personal: { kind: "flow", text: "개인 흐름" },
		company: { kind: "flow", text: "회사 흐름" },
	});
});

test("week-flow: weekFlowCell falls back to items per scope (mixed), and empty when neither", () => {
	assert.deepEqual(weekFlowCell({ personal: "개인 흐름", company: null }, { personal: ["a"], company: ["b", "c"] }), {
		personal: { kind: "flow", text: "개인 흐름" },
		company: { kind: "items", items: ["b", "c"], more: 0 },
	});
	assert.deepEqual(weekFlowCell(undefined, { personal: [], company: ["x"] }), {
		personal: { kind: "empty" },
		company: { kind: "items", items: ["x"], more: 0 },
	});
	assert.deepEqual(weekFlowCell(null, null), { personal: { kind: "empty" }, company: { kind: "empty" } });
	assert.deepEqual(weekFlowCell({ personal: null, company: null }, { personal: [], company: [] }), {
		personal: { kind: "empty" },
		company: { kind: "empty" },
	});
});

test("week-flow: weekFlowCell — an explicit — is empty and does not fall back to Daily items", () => {
	assert.deepEqual(weekFlowCell({ personal: "—", company: " — " }, { personal: ["a", "b"], company: ["c"] }), {
		personal: { kind: "empty" },
		company: { kind: "empty" },
	});
	// Parsed end to end: 개인 — stays empty, 회사 line missing → Daily items.
	const flow = parseDayFlow(dayFlowWeekly("### 2026-11-12 (목)\n- 개인: —\n"));
	assert.deepEqual(weekFlowCell(flow.get("2026-11-12"), dailyItemsByScope(fx("daily/2026-01-05.md"))), {
		personal: { kind: "empty" },
		company: {
			kind: "items",
			items: [
				"분기 보고서 현행 절차 정리: 수작업 단계 11개 목록화",
				"박팀장 보고용 자동화 범위 제안 메모 작성 (발송·실행 미확인)",
				"데이터 소스 4개(ERP 매출·인사 현황·비용 집계·고객 CS) 추출 가능 여부 확인",
			],
			more: 1,
		},
	});
});

test("week-flow: weekFlowCell caps items at 3 with a more count", () => {
	const c = weekFlowCell(null, { personal: ["1", "2", "3", "4", "5"], company: ["1", "2", "3"] });
	assert.deepEqual(c.personal, { kind: "items", items: ["1", "2", "3"], more: 2 });
	assert.deepEqual(c.company, { kind: "items", items: ["1", "2", "3"], more: 0 });
});

test("week-flow: dayText is the whole 하루 (comments stripped), null when missing or empty", () => {
	const full = dayText(fx("daily/2026-01-05.md"))!;
	assert.ok(full.startsWith("새해 첫 출근. 아침 8시 반"));
	assert.ok(full.endsWith("정하지는 못했다."));
	assert.equal(dayText(daily("## 하루\n\n<!-- 주석 -->\n첫 줄.\n\n둘째 단락.\n\n## 한 일\n")), "첫 줄.\n\n둘째 단락.");
	assert.equal(dayText(daily("## 하루\n\n<!-- 주석만 -->\n\n## 한 일\n")), null);
	assert.equal(dayText(daily("## 한 일\n\n- x\n")), null);
});
