import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	aggregateDiary,
	dailyMonthFolder,
	dailyPath,
	dateOfDailyName,
	hasUserNote,
	INSIGHT_SECTION,
	isoWeek,
	isoWeekKey,
	isSample,
	LOG_SECTION,
	monthlyPath,
	parseMyLifeFile,
	setUserNote,
	shiftMonthKey,
	TEMPLATE_SECTIONS,
	unitPath,
	unitTitle,
	USER_NOTE_SECTION,
	userNoteOf,
	weeklyPath,
	weekMonday,
	yearlyPath,
} from "../src/mylife/model.ts";
import { listSections } from "../src/writer.ts";
import { parseFrontmatterText } from "../src/pinboard/model.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "fixtures/my-life");
const fx = (p: string) => readFileSync(join(FX, p), "utf8");
const ROOT = "08 My Life";
const TODAY = "2026-10-25";

const DAILY_DATES = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09", "2026-01-10", "2026-01-11"];
const dailies = DAILY_DATES.map((date) => ({ date, path: dailyPath(ROOT, date), text: fx(`daily/${date}.md`) }));
const WEEKLY = fx("weekly/2026-W02.md");
const MONTHLY = fx("monthly/2026-01.md");
const YEARLY = fx("yearly/2025.md");

/** `## name` headings of a template file, in order (comments and frontmatter ignored). */
function templateHeadings(name: string): string[] {
	return listSections(fx(`templates/${name}.md`));
}

// ───────────────────────── paths ─────────────────────────

test("my-life: unit paths follow AGENTS 「2」", () => {
	assert.equal(dailyPath(ROOT, "2026-01-07"), "08 My Life/01 Daily/2026/2026-01/2026-01-07.md");
	assert.equal(weeklyPath(ROOT, "2026-01-07"), "08 My Life/02 Weekly/2026/2026-W02.md");
	assert.equal(monthlyPath(ROOT, "2026-01-07"), "08 My Life/03 Monthly/2026/2026-01.md");
	assert.equal(yearlyPath(ROOT, "2026-01-07"), "08 My Life/04 Yearly/2026.md");
	assert.equal(unitPath(ROOT, "weekly", "2026-01-07"), weeklyPath(ROOT, "2026-01-07"));
	assert.equal(dailyMonthFolder(ROOT, "2026-01"), "08 My Life/01 Daily/2026/2026-01");
});

test("my-life: root folder is cleaned and defaults", () => {
	assert.equal(yearlyPath(" /My Life/ ", "2026-05-01"), "My Life/04 Yearly/2026.md");
	assert.equal(yearlyPath("", "2026-05-01"), "08 My Life/04 Yearly/2026.md");
});

test("my-life: ISO week-year edge cases", () => {
	// 2026-01-01 is a Thursday → W01 of 2026.
	assert.deepEqual(isoWeek("2026-01-01"), { year: 2026, week: 1 });
	// Monday 2025-12-29 belongs to 2026-W01 (its Thursday is 2026-01-01).
	assert.equal(isoWeekKey("2025-12-29"), "2026-W01");
	assert.equal(weeklyPath(ROOT, "2025-12-29"), "08 My Life/02 Weekly/2026/2026-W01.md");
	assert.equal(isoWeekKey("2026-01-04"), "2026-W01");
	assert.equal(isoWeekKey("2026-01-05"), "2026-W02");
	// 2026 has 53 ISO weeks: Sunday 2027-01-03 is still 2026-W53.
	assert.equal(isoWeekKey("2027-01-03"), "2026-W53");
	assert.equal(weeklyPath(ROOT, "2027-01-03"), "08 My Life/02 Weekly/2026/2026-W53.md");
	assert.equal(isoWeekKey("2027-01-04"), "2027-W01");
	// 2021-01-03 (Sunday) → 2020-W53; 2024-12-30 (Monday) → 2025-W01.
	assert.equal(isoWeekKey("2021-01-03"), "2020-W53");
	assert.equal(isoWeekKey("2024-12-30"), "2025-W01");
	// Sample Weekly files: W01 = 12/29~01/04, W05 = 01/26~02/01.
	assert.equal(isoWeekKey("2026-02-01"), "2026-W05");
	assert.equal(weekMonday("2026-02-01"), "2026-01-26");
	assert.equal(weekMonday("2026-01-05"), "2026-01-05");
});

test("my-life: unit titles and month shifting", () => {
	assert.equal(unitTitle("weekly", "2026-01-07"), "2026-W02 (01/05~01/11)");
	assert.equal(unitTitle("weekly", "2025-12-31"), "2026-W01 (12/29~01/04)");
	assert.equal(unitTitle("monthly", "2026-01-07"), "2026-01");
	assert.equal(unitTitle("yearly", "2026-01-07"), "2026");
	assert.equal(unitTitle("daily", "2026-01-07"), "2026-01-07");
	assert.equal(shiftMonthKey("2026-01", -1), "2025-12");
	assert.equal(shiftMonthKey("2026-12", 1), "2027-01");
	assert.equal(dateOfDailyName("2026-01-07"), "2026-01-07");
	assert.equal(dateOfDailyName("2026-01-32"), null);
	assert.equal(dateOfDailyName("notes"), null);
});

// ───────────────────────── templates ─────────────────────────

test("my-life: TEMPLATE_SECTIONS match the vault templates exactly", () => {
	assert.deepEqual([...TEMPLATE_SECTIONS.daily], templateHeadings("Daily"));
	assert.deepEqual([...TEMPLATE_SECTIONS.weekly], templateHeadings("Weekly"));
	assert.deepEqual([...TEMPLATE_SECTIONS.monthly], templateHeadings("Monthly"));
	assert.deepEqual([...TEMPLATE_SECTIONS.yearly], templateHeadings("Yearly"));
	assert.equal(hasUserNote("daily"), false);
	assert.equal(hasUserNote("weekly"), true);
	assert.equal(hasUserNote("monthly"), true);
	assert.equal(hasUserNote("yearly"), true);
});

// ───────────────────────── parsing ─────────────────────────

test("my-life: parse a sample Daily", () => {
	const f = parseMyLifeFile(dailies[2].text, "daily");
	assert.equal(f.title, "2026-01-07 (수)");
	assert.equal(f.frontmatter.type, "my-life-daily");
	assert.equal(f.sample, true);
	assert.equal(f.status, "샘플");
	// 끼적임 is deleted when empty (「4-1」 5); everything else is present, in template order.
	assert.deepEqual(
		f.sections.map((s) => s.name),
		["하루", "한 일", "결정", "깨달음·감상", "열린 질문", "보낸 곳", "놓아준 일", "로그", "세션"],
	);
	assert.ok(f.sections.every((s) => s.inTemplate));
	assert.ok(f.sections.every((s) => !s.empty));
	const insight = f.sections.find((s) => s.name === INSIGHT_SECTION)!;
	assert.equal(insight.content, '- > "5km에서 5.5km 늘린 건데 숨이 아니라 지루함이 먼저 왔다."\n  — 달리기 기록을 보며. #개인 #sample (세션: 달리기 기록 분석)');
	assert.deepEqual(
		f.stats.map((s) => [s.label, s.value]),
		[
			["세션", "3"],
			["항목", "6"],
			["놓아줌", "1"],
			["걸러냄", "2"],
			["상태", "샘플"],
		],
	);
});

test("my-life: parse a sample Weekly (empty 사용자 한마디, ### kept inside sections)", () => {
	const f = parseMyLifeFile(WEEKLY, "weekly");
	assert.equal(f.title, "2026-W02 (01/05~01/11)");
	assert.deepEqual(
		f.sections.map((s) => s.name),
		[...TEMPLATE_SECTIONS.weekly],
	);
	const note = f.sections.find((s) => s.name === USER_NOTE_SECTION)!;
	assert.equal(note.content, "");
	assert.equal(note.empty, true);
	assert.equal(userNoteOf(WEEKLY), "");
	const m = parseMyLifeFile(MONTHLY, "monthly");
	const weekly = m.sections.find((s) => s.name === "한 일 (주별)")!;
	assert.match(weekly.content, /^### W01 \(12\/29~01\/04\)/);
	assert.match(weekly.content, /### W05 \(01\/26~02\/01\)/);
	assert.equal(m.stats.find((s) => s.key === "items")?.value, "200");
});

test("my-life: parse the sample Yearly and extra / template-only sections", () => {
	const f = parseMyLifeFile(YEARLY, "yearly");
	assert.deepEqual(
		f.sections.map((s) => s.name),
		[...TEMPLATE_SECTIONS.yearly],
	);
	assert.equal(f.sample, true);
	// An extra section goes after the template ones; a template section with only a comment is empty.
	const text = `---
type: my-life-weekly
week: 2026-W10
status: 초안
---
# 2026-W10

## 메모장

- 내 것

## 한 주

<!-- 4~6문장. -->

## 사용자 한마디

`;
	const g = parseMyLifeFile(text, "weekly");
	assert.deepEqual(
		g.sections.map((s) => [s.name, s.empty, s.inTemplate]),
		[
			["한 주", true, true],
			[USER_NOTE_SECTION, true, true],
			["메모장", false, false],
		],
	);
	assert.equal(g.sample, false);
	assert.deepEqual(g.stats, [{ key: "status", label: "상태", value: "초안" }]);
});

test("my-life: sample detection", () => {
	assert.equal(isSample({ sample: true }, ""), true);
	assert.equal(isSample({ status: "샘플" }, ""), true);
	assert.equal(isSample({}, "- 한 일 #sample"), true);
	assert.equal(isSample({}, "- 한 일 #sampler"), false);
	assert.equal(isSample({}, "<!-- #sample -->"), false);
	assert.equal(isSample({ status: "초안" }, "- 한 일 #test"), false);
});

// ───────────────────────── 사용자 한마디 write-back ─────────────────────────

/** Everything outside `## 사용자 한마디` must be identical. */
function assertOnlyUserNoteChanged(before: string, after: string): void {
	const strip = (t: string) => {
		const names = listSections(t);
		const i = names.indexOf(USER_NOTE_SECTION);
		assert.ok(i >= 0);
		const next = names[i + 1];
		const start = t.indexOf(`\n## ${USER_NOTE_SECTION}\n`);
		const end = next ? t.indexOf(`\n## ${next}\n`) : t.length;
		return t.slice(0, start) + t.slice(end);
	};
	assert.equal(strip(after), strip(before));
}

test("my-life: setUserNote writes only that section (Weekly)", () => {
	const out = setUserNote(WEEKLY, "이번 주는 몸이 먼저 움직였다.\n두 줄째.", TODAY);
	assert.notEqual(out, WEEKLY);
	assert.equal(userNoteOf(out), "이번 주는 몸이 먼저 움직였다.\n두 줄째.");
	assertOnlyUserNoteChanged(WEEKLY, out);
	// The next section is still right after the note.
	assert.match(out, /## 사용자 한마디\n\n이번 주는 몸이 먼저 움직였다.\n두 줄째.\n\n## 날짜\n/);
	// No `updated` key existed → frontmatter is untouched (written_at stays Hermes's).
	assert.equal(parseFrontmatterText(out).data.updated, undefined);
	assert.equal(parseFrontmatterText(out).data.written_at, "2026-10-25");
	// The sample has three blank lines there; the write leaves heading / blank / 2 lines / blank.
	assert.equal(out.split("\n").length, WEEKLY.split("\n").length + 1);
	// Same text again → no-op; clearing leaves the template's one blank line (「4-1」 5).
	assert.equal(setUserNote(out, "이번 주는 몸이 먼저 움직였다.\n두 줄째.", TODAY), out);
	const cleared = setUserNote(out, "", TODAY);
	assert.equal(cleared, WEEKLY.replace("## 사용자 한마디\n\n\n\n## 날짜", "## 사용자 한마디\n\n## 날짜"));
	assert.equal(userNoteOf(cleared), "");
	// Already-empty section + empty text → untouched, blank lines and all.
	assert.equal(setUserNote(WEEKLY, "", TODAY), WEEKLY);
	assert.equal(setUserNote(WEEKLY, "  \n\n", TODAY), WEEKLY);
});

test("my-life: setUserNote on Monthly and Yearly, and when the section is missing", () => {
	for (const src of [MONTHLY, YEARLY]) {
		const out = setUserNote(src, "한마디.", TODAY);
		assert.equal(userNoteOf(out), "한마디.");
		assertOnlyUserNoteChanged(src, out);
	}
	// Daily has no 사용자 한마디: never created (「6」).
	assert.equal(setUserNote(dailies[0].text, "안 됨", TODAY), dailies[0].text);
});

test("my-life: setUserNote bumps `updated` only when the key exists", () => {
	const text = `---
type: my-life-weekly
week: 2026-W10
updated: 2026-03-01
---
# 2026-W10

## 한 주

문장.

## 사용자 한마디

## 날짜

- 링크
`;
	const out = setUserNote(text, "메모", TODAY);
	assert.match(out, /^updated: 2026-10-25$/m);
	assert.match(out, /## 사용자 한마디\n\n메모\n\n## 날짜\n/);
	assert.equal(out.replace("updated: 2026-10-25", "updated: 2026-03-01").replace("## 사용자 한마디\n\n메모\n\n", "## 사용자 한마디\n\n"), text);
});

// ───────────────────────── Diary ─────────────────────────

test("my-life: Diary aggregates 깨달음·감상 and 로그 of a month, then the Monthly's", () => {
	const monthly = { date: "2026-01", path: monthlyPath(ROOT, "2026-01-01"), text: MONTHLY };
	// Add a stray Daily from another month: ignored. Shuffle order: sorted by date.
	const stray = { date: "2026-02-01", path: dailyPath(ROOT, "2026-02-01"), text: dailies[0].text };
	const d = aggregateDiary("2026-01", [stray, ...[...dailies].reverse()], monthly);
	assert.equal(d.month, "2026-01");
	assert.deepEqual(d.days, DAILY_DATES);
	assert.equal(d.hasMonthly, true);
	// Every sample Daily has both sections filled → 14 + Monthly 1.
	assert.equal(d.entries.length, 15);
	assert.deepEqual(
		d.entries.slice(0, 4).map((e) => [e.date, e.section]),
		[
			["2026-01-05", INSIGHT_SECTION],
			["2026-01-05", LOG_SECTION],
			["2026-01-06", INSIGHT_SECTION],
			["2026-01-06", LOG_SECTION],
		],
	);
	const last = d.entries[d.entries.length - 1];
	assert.equal(last.unit, "monthly");
	assert.equal(last.date, "2026-01");
	assert.equal(last.section, INSIGHT_SECTION);
	assert.equal(last.path, "08 My Life/03 Monthly/2026/2026-01.md");
	// Verbatim content.
	const jan7log = d.entries.find((e) => e.date === "2026-01-07" && e.section === LOG_SECTION)!;
	assert.equal(jan7log.content, "- Daily Pad 없음 (2026-01-07 파일 없음) #sample");
	assert.equal(jan7log.path, "08 My Life/01 Daily/2026/2026-01/2026-01-07.md");
	assert.ok(d.entries.every((e) => e.unit === "monthly" || DAILY_DATES.includes(e.date)));
});

test("my-life: Diary skips blank or missing sections and works without a Monthly", () => {
	const blank = {
		date: "2026-03-02",
		path: dailyPath(ROOT, "2026-03-02"),
		text: "---\ntype: my-life-daily\n---\n# 2026-03-02\n\n## 하루\n\n글.\n\n## 깨달음·감상\n\n<!-- 비어 있음 -->\n\n## 로그\n\n- 09:00 시작\n",
	};
	const noLog = { date: "2026-03-01", path: dailyPath(ROOT, "2026-03-01"), text: "# 2026-03-01\n\n## 깨달음·감상\n\n- > \"한 줄\"\n" };
	const d = aggregateDiary("2026-03", [blank, noLog], null);
	assert.equal(d.hasMonthly, false);
	assert.deepEqual(d.days, ["2026-03-01", "2026-03-02"]);
	assert.deepEqual(
		d.entries.map((e) => [e.date, e.section, e.content]),
		[
			["2026-03-01", INSIGHT_SECTION, '- > "한 줄"'],
			["2026-03-02", LOG_SECTION, "- 09:00 시작"],
		],
	);
	assert.deepEqual(aggregateDiary("2026-04", [], null), { month: "2026-04", entries: [], days: [], hasMonthly: false });
});

test("my-life: fixtures folder holds the seven sample Dailies", () => {
	const names = readdirSync(join(FX, "daily")).filter((n) => n.endsWith(".md")).sort();
	assert.deepEqual(names, DAILY_DATES.map((d) => `${d}.md`));
});
