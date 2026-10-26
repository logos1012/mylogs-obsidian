import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getFmList, getFmValue } from "../src/projects/ops.ts";
import {
	addFromLink,
	applyMetaEdit,
	attachmentPath,
	attachmentsOf,
	bodiesEqual,
	bodyOf,
	calendarDays,
	displayTitle,
	entryBaseName,
	entryPathOf,
	entryStamp,
	filterEntries,
	firstImageOf,
	groupTimeline,
	insertEmbed,
	isEntryPath,
	newEntryText,
	nextAttachmentNo,
	normalizeBody,
	onThisDay,
	parseEntry,
	parsePrompts,
	previewOf,
	promptForDate,
	recentlyAnswered,
	setPinned,
	setStarred,
	splitTags,
	streakOf,
	syncTitle,
	tagCounts,
	wikilink,
	withBody,
	yearsOf,
} from "../src/diary/model.ts";
import { forgetWrites, isConflict, isOwnWrite, lastWritten, rememberWrite } from "../src/diary/sync.ts";
import { deleteLogText, entryRowOf, fileCellOf, monthRowsOf, parseEntryRows, parseMonthRows, recomputeMonths, registerEntry, removeEntryRow, unregisterEntry, upsertEntryRow } from "../src/diary/ops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "fixtures/diary");
const fx = (p: string) => readFileSync(join(FX, p), "utf8");
const ROOT = "09 Diary";
const NOW = new Date(2026, 0, 11, 22, 10); // 2026-01-11 22:10 local

const FILES = ["2025/2025-01/2025-01-09 2300.md", "2026/2026-01/2026-01-09 0730.md", "2026/2026-01/2026-01-09 2210.md", "2026/2026-01/2026-01-11 2145.md"];
const entries = FILES.map((rel) => {
	const e = parseEntry(fx(rel), `${ROOT}/${rel}`);
	assert.ok(e, rel);
	return e;
});
const [run2025, early, paid, pinnedQ] = entries;
const EMPTY_REG = fx("Diary Index.md");
const FILLED_REG = fx("Diary Index.filled.md");
const TEMPLATE = fx("_Templates/엔트리.md");

// ───────────────────────── entry parsing ─────────────────────────

test("diary: parse an entry (frontmatter, body, preview, first image, chars)", () => {
	assert.equal(paid.name, "2026-01-09 2210");
	assert.equal(paid.date, "2026-01-09");
	assert.equal(paid.time, "22:10");
	assert.equal(paid.title, "첫 유료 고객");
	assert.deepEqual(paid.tags, ["사이드프로젝트", "주간장부"]);
	assert.equal(paid.location, "집");
	assert.equal(paid.weather, "맑음 -3°C");
	assert.equal(paid.starred, true);
	assert.equal(paid.pinned, false);
	assert.deepEqual(paid.from, ["[[04 Daily Pad/2026/2026-01-09#끼적임]]"]);
	assert.equal(paid.updated, "2026-01-09T22:41");
	assert.ok(paid.body.startsWith("# 첫 유료 고객\n"));
	assert.equal(paid.firstImage, "09 Diary/99 작업실/첨부/2026-01/2026-01-09 2210 01.jpg");
	// Two lines, H1 and the embed skipped.
	assert.deepEqual(paid.preview.split("\n"), ['카페에서 나오는데 손이 떨렸다. 사장님이 먼저 "얼마예요" 하고 물었다. 돈 얘기를 내가 꺼내지 않았는데 저쪽에서 먼저 나온 건 처음이다.', "2만원. 사장님 입에서 나온 숫자를 그대로 가격으로 삼기로 했다. 1월은 무료, 2월부터 받는다."]);
	assert.ok(paid.chars > 100 && paid.chars < 300, String(paid.chars));
});

test("diary: title falls back to the H1, then to (제목 없음)", () => {
	// No `title:` key → first `# ` line.
	assert.equal(run2025.title, "5km를 처음 쉬지 않고");
	// Empty `title:` and empty `# ` → "" and the display name.
	assert.equal(early.title, "");
	assert.equal(displayTitle(early), "(제목 없음)");
	assert.equal(displayTitle(paid), "첫 유료 고객");
	// Body-only file: time from the file name.
	const e = parseEntry("# 제목만\n\n본문", `${ROOT}/2026/2026-02/2026-02-01 0905.md`);
	assert.equal(e?.date, "2026-02-01");
	assert.equal(e?.time, "09:05");
	assert.equal(e?.title, "제목만");
	assert.equal(parseEntry("본문", `${ROOT}/2026/2026-02/메모.md`), null);
});

test("diary: preview strips frontmatter, H1, embeds, comments, markup; first image by extension", () => {
	const body = "# 제목\n\n<!-- 숨김 -->\n![[09 Diary/99 작업실/첨부/2026-01/x.pdf]]\n\n- **굵게** [[A/B|링크]] `코드`\n\n![[09 Diary/99 작업실/첨부/2026-01/y.PNG|300]]\n> 인용 셋째 줄\n";
	assert.equal(previewOf(body), "굵게 링크 코드\n인용 셋째 줄");
	assert.equal(firstImageOf(body), "09 Diary/99 작업실/첨부/2026-01/y.PNG");
	assert.equal(firstImageOf("![](https://x/y.jpg) ![[a.md]]"), "https://x/y.jpg");
	assert.equal(firstImageOf("글만"), "");
	assert.equal(previewOf("# 제목\n\n" + "가".repeat(100)), "가".repeat(89) + "…");
	assert.equal(bodyOf("---\na: 1\n---\n# 본문\n"), "# 본문\n");
	assert.equal(bodyOf("# 본문\n"), "# 본문\n");
});

test("diary: entry paths and stamps", () => {
	assert.deepEqual(entryStamp("2026-01-09 2210"), { date: "2026-01-09", time: "22:10" });
	assert.deepEqual(entryStamp("2026-01-09 2210-2"), { date: "2026-01-09", time: "22:10" });
	assert.equal(entryStamp("2026-01-09"), null);
	assert.equal(entryStamp("2026-13-09 2210"), null);
	assert.equal(isEntryPath(ROOT, "09 Diary/2026/2026-01/2026-01-09 2210.md"), true);
	assert.equal(isEntryPath(ROOT, "09 Diary/Diary Index.md"), false);
	assert.equal(isEntryPath(ROOT, "09 Diary/_Templates/엔트리.md"), false);
	assert.equal(isEntryPath(ROOT, "09 Diary/99 작업실/프롬프트.md"), false);
	assert.equal(wikilink("04 Daily Pad/2026/2026-01-09.md", "끼적임"), "[[04 Daily Pad/2026/2026-01-09#끼적임]]");
	assert.equal(wikilink("09 Diary/2025/2025-01/2025-01-09 2300.md"), "[[09 Diary/2025/2025-01/2025-01-09 2300]]");
});

// ───────────────────────── timeline ─────────────────────────

test("diary: timeline groups by month newest first, pinned on top, same-day label once", () => {
	const groups = groupTimeline(entries);
	assert.deepEqual(
		groups.map((g) => [g.key, g.rows.map((r) => r.entry.name)]),
		[
			["pinned", ["2026-01-11 2145"]],
			["2026-01", ["2026-01-11 2145", "2026-01-09 2210", "2026-01-09 0730"]],
			["2025-01", ["2025-01-09 2300"]],
		],
	);
	assert.deepEqual(groups[1].rows.map((r) => r.showDate), [true, true, false]);
	// `-2` sibling sorts after the one without a suffix within the same minute.
	const a = parseEntry("# a", `${ROOT}/2026/2026-03/2026-03-01 1000.md`)!;
	const b = parseEntry("# b", `${ROOT}/2026/2026-03/2026-03-01 1000-2.md`)!;
	assert.deepEqual(groupTimeline([a, b])[0].rows.map((r) => r.entry.name), ["2026-03-01 1000-2", "2026-03-01 1000"]);
});

test("diary: filters (starred · tag · year), tag counts, years", () => {
	assert.deepEqual(filterEntries(entries, { starred: true }).map((e) => e.name), ["2026-01-09 2210"]);
	assert.deepEqual(filterEntries(entries, { tag: "질문" }).map((e) => e.name), ["2026-01-11 2145"]);
	assert.deepEqual(
		filterEntries(entries, { year: "2025" }).map((e) => e.name),
		["2025-01-09 2300"],
	);
	assert.deepEqual(filterEntries(entries, { year: "2026", tag: "뉴스레터" }).map((e) => e.name), ["2026-01-09 0730"]);
	assert.deepEqual(tagCounts(entries).slice(0, 2), [
		["뉴스레터", 1],
		["달리기", 1],
	]);
	assert.deepEqual(yearsOf(entries), ["2026", "2025"]);
});

// ───────────────────────── new entry ─────────────────────────

test("diary: same-minute file names get -2, -3", () => {
	assert.equal(entryBaseName(NOW, []), "2026-01-11 2210");
	assert.equal(entryBaseName(NOW, ["2026-01-11 2210"]), "2026-01-11 2210-2");
	assert.equal(entryBaseName(NOW, ["2026-01-11 2210", "2026-01-11 2210-2"]), "2026-01-11 2210-3");
	assert.equal(entryPathOf(ROOT, NOW, []), "09 Diary/2026/2026-01/2026-01-11 2210.md");
	assert.equal(entryPathOf("", new Date(2026, 11, 31, 0, 5), ["2026-12-31 0005"]), "09 Diary/2026/2026-12/2026-12-31 0005-2.md");
});

test("diary: a new entry fills the template, keeps the body empty; 답하기 sets prompt and a > line", () => {
	const t = newEntryText(TEMPLATE, NOW);
	assert.equal(getFmValue(t, "date"), "2026-01-11");
	assert.equal(getFmValue(t, "time"), "22:10");
	assert.equal(getFmValue(t, "created"), "2026-01-11T22:10");
	assert.equal(getFmValue(t, "title"), "");
	assert.equal(getFmValue(t, "prompt"), "");
	assert.ok(!t.includes("{{"));
	assert.match(bodyOf(t), /^# \n\n?$/);
	const e = parseEntry(t, `${ROOT}/2026/2026-01/2026-01-11 2210.md`)!;
	assert.equal(e.title, "");
	assert.equal(e.chars, 0);

	const q = newEntryText(TEMPLATE, NOW, "오늘 나를 웃게 한 것은?");
	assert.equal(getFmValue(q, "prompt"), "오늘 나를 웃게 한 것은?");
	assert.equal(bodyOf(q), "# \n\n> 오늘 나를 웃게 한 것은?\n\n");
});

// ───────────────────────── title ↔ frontmatter · updated ─────────────────────────

test("diary: saving the body syncs the first # line into title and bumps updated", () => {
	const t = newEntryText(TEMPLATE, NOW);
	const later = new Date(2026, 0, 11, 22, 31);
	const saved = withBody(t, "# 늦은 밤\n\n오늘은 여기까지.", later);
	assert.equal(getFmValue(saved, "title"), "늦은 밤");
	assert.equal(getFmValue(saved, "updated"), "2026-01-11T22:31");
	assert.equal(getFmValue(saved, "created"), "2026-01-11T22:10");
	assert.equal(bodyOf(saved), "# 늦은 밤\n\n오늘은 여기까지.\n");
	// Title with a colon is quoted; removing the H1 empties the title; other keys untouched.
	const colon = withBody(saved, "# 가격: 2만원\n본문", later);
	assert.equal(getFmValue(colon, "title"), "가격: 2만원");
	assert.ok(/^title: "가격: 2만원"$/m.test(colon));
	const none = withBody(colon, "제목 없이 바로 본문", later);
	assert.equal(getFmValue(none, "title"), "");
	assert.equal(getFmValue(none, "time"), "22:10");
	assert.equal(getFmValue(none, "starred"), "false");
	// syncTitle alone is a no-op when equal.
	assert.equal(syncTitle(saved), saved);
	// A body-only file (no frontmatter) is written as is.
	assert.equal(withBody("# a\n", "# b\n", later), "# b\n");
});

test("diary: metadata strip edit, starred / pinned toggles, tags split", () => {
	const t = fx("2026/2026-01/2026-01-09 0730.md");
	const m = applyMetaEdit(t, { time: "07:35", location: "카페", weather: "눈", tags: ["뉴스레터", "아침"] }, NOW);
	assert.ok(/^time: "07:35"$/m.test(m));
	assert.equal(getFmValue(m, "location"), "카페");
	assert.equal(getFmValue(m, "weather"), "눈");
	assert.ok(/^tags: \[뉴스레터, 아침\]$/m.test(m));
	assert.equal(getFmValue(m, "updated"), "2026-01-11T22:10");
	assert.equal(applyMetaEdit(t, {}, NOW), t);
	assert.ok(/^starred: true$/m.test(setStarred(t, true)));
	assert.equal(setStarred(t, false), t);
	assert.ok(/^pinned: true$/m.test(setPinned(t, true)));
	assert.deepEqual(splitTags("#a, b  c,,"), ["a", "b", "c"]);
});

// ───────────────────────── from links · embeds ─────────────────────────

test("diary: a material click appends its link to from once; the body never changes", () => {
	const t = fx("2026/2026-01/2026-01-09 2210.md");
	const link = "[[08 My Life/01 Daily/2026/2026-01/2026-01-08#깨달음·감상]]";
	const out = addFromLink(t, link);
	assert.deepEqual(getFmList(out, "from"), ["[[04 Daily Pad/2026/2026-01-09#끼적임]]", link]);
	assert.equal(bodyOf(out), bodyOf(t));
	assert.equal(addFromLink(out, link), out);
	// Empty `from: []` → block list.
	const e = addFromLink(fx("2026/2026-01/2026-01-09 0730.md"), link);
	assert.deepEqual(getFmList(e, "from"), [link]);
	assert.ok(e.includes(`from:\n  - "${link}"`));
});

test("diary: attachments: path, next number, embed insertion, owned files", () => {
	assert.equal(attachmentPath(ROOT, "2026-01-09 2210", 1, "jpg"), "09 Diary/99 작업실/첨부/2026-01/2026-01-09 2210 01.jpg");
	assert.equal(attachmentPath(ROOT, "2026-01-09 2210-2", 3, ".PNG"), "09 Diary/99 작업실/첨부/2026-01/2026-01-09 2210 03.png");
	assert.equal(nextAttachmentNo("2026-01-09 2210", ["2026-01-09 2210 01.jpg", "2026-01-09 2210 02.png", "2026-01-09 0730 01.jpg"]), 3);
	assert.equal(nextAttachmentNo("2026-01-09 2210", []), 1);
	assert.deepEqual(insertEmbed("가\n나", 1, "x/y.png"), { text: "가\n![[x/y.png]]\n나", pos: 1 + 1 + "![[x/y.png]]".length });
	assert.deepEqual(insertEmbed("가나", 1, "x/y.png"), { text: "가\n![[x/y.png]]\n나", pos: 1 + 1 + "![[x/y.png]]".length });
	assert.deepEqual(insertEmbed("", 0, "x/y.png"), { text: "![[x/y.png]]", pos: "![[x/y.png]]".length });
	assert.deepEqual(attachmentsOf(ROOT, paid, ["2026-01-09 2210 01.jpg", "2026-01-09 2210 02.png", "2026-01-09 0730 01.jpg"]), [
		"09 Diary/99 작업실/첨부/2026-01/2026-01-09 2210 01.jpg",
		"09 Diary/99 작업실/첨부/2026-01/2026-01-09 2210 02.png",
	]);
});

// ───────────────────────── material ─────────────────────────

test("diary: on this day matches the same month-day across other years", () => {
	assert.deepEqual(onThisDay(entries, "2026-01-09").map((e) => e.name), ["2025-01-09 2300"]);
	assert.deepEqual(onThisDay(entries, "2027-01-09").map((e) => e.name), ["2026-01-09 2210", "2026-01-09 0730", "2025-01-09 2300"]);
	assert.deepEqual(onThisDay(entries, "2026-01-10"), []);
});

test("diary: prompt is picked by date seed and skips prompts answered within 90 days", () => {
	const prompts = parsePrompts(fx("99 작업실/프롬프트.md"));
	assert.equal(prompts.length, 20);
	assert.equal(prompts[0], "오늘 가장 오래 머문 생각은 무엇이었나?");
	const none = new Set<string>();
	const p1 = promptForDate(prompts, "2026-01-11", none);
	assert.ok(p1 && prompts.includes(p1));
	assert.equal(promptForDate(prompts, "2026-01-11", none), p1);
	// Different dates reach different prompts somewhere in a month.
	const seen = new Set<string>();
	for (let d = 1; d <= 28; d++) seen.add(promptForDate(prompts, `2026-01-${String(d).padStart(2, "0")}`, none)!);
	assert.ok(seen.size > 5, String(seen.size));
	// 90-day exclusion: the pinned entry answered "일주일 전의 나에게 한마디 한다면?" on 2026-01-11.
	assert.deepEqual([...recentlyAnswered(entries, "2026-01-11")], ["일주일 전의 나에게 한마디 한다면?"]);
	// 90 days inclusive: still excluded on day 90, free on day 91.
	assert.deepEqual([...recentlyAnswered(entries, "2026-04-11")], ["일주일 전의 나에게 한마디 한다면?"]);
	assert.deepEqual([...recentlyAnswered(entries, "2026-04-12")], []);
	const answered = recentlyAnswered(entries, "2026-01-11");
	for (let d = 1; d <= 28; d++) {
		const p = promptForDate(prompts, `2026-02-${String(d).padStart(2, "0")}`, answered);
		assert.notEqual(p, "일주일 전의 나에게 한마디 한다면?");
	}
	assert.equal(promptForDate(prompts, "2026-01-11", new Set(prompts)), null);
	assert.equal(promptForDate([], "2026-01-11", none), null);
});

// ───────────────────────── calendar · streak ─────────────────────────

test("diary: calendar days and streak", () => {
	const jan = calendarDays(entries, "2026-01");
	assert.deepEqual([...jan.keys()], ["2026-01-11", "2026-01-09"]);
	assert.equal(jan.get("2026-01-09")?.count, 2);
	assert.equal(jan.get("2026-01-09")?.image, "09 Diary/99 작업실/첨부/2026-01/2026-01-09 2210 01.jpg");
	assert.equal(jan.get("2026-01-11")?.image, "");
	assert.equal(calendarDays(entries, "2026-02").size, 0);

	const dates = ["2026-01-09", "2026-01-10", "2026-01-11", "2026-01-05"];
	assert.equal(streakOf(dates, "2026-01-11"), 3);
	// Today without an entry: the streak up to yesterday still counts.
	assert.equal(streakOf(dates, "2026-01-12"), 3);
	assert.equal(streakOf(dates, "2026-01-13"), 0);
	assert.equal(streakOf(dates, "2026-01-05"), 1);
	assert.equal(streakOf([], "2026-01-11"), 0);
});

// ───────────────────────── registry ─────────────────────────

test("diary: registry parsing (엔트리 rows, 월별 rows)", () => {
	const rows = parseEntryRows(FILLED_REG);
	assert.equal(rows.length, 4);
	assert.deepEqual(rows[2], {
		date: "2026-01-09",
		time: "22:10",
		title: "첫 유료 고객",
		tags: "사이드프로젝트, 주간장부",
		starred: "★",
		fileCell: "[[09 Diary/2026/2026-01/2026-01-09 2210\\|2026-01-09 2210]]",
		target: "09 Diary/2026/2026-01/2026-01-09 2210",
	});
	assert.deepEqual(parseMonthRows(FILLED_REG), [
		{ month: "2025-01", entries: 1, days: 1 },
		{ month: "2026-01", entries: 3, days: 2 },
	]);
	assert.deepEqual(parseEntryRows(EMPTY_REG), []);
	assert.deepEqual(parseMonthRows(EMPTY_REG), []);
	assert.equal(fileCellOf("09 Diary/2026/2026-01/2026-01-09 2210.md"), "[[09 Diary/2026/2026-01/2026-01-09 2210\\|2026-01-09 2210]]");
});

test("diary: registerEntry upserts the row in date·time order and recomputes 월별", () => {
	const today = "2026-01-11";
	// Insert into the empty registry: row + month.
	const r1 = registerEntry(EMPTY_REG, paid, today);
	assert.ok(r1.ok && r1.added);
	assert.deepEqual(parseEntryRows(r1.text).map((r) => r.target), [paid.path.replace(/\.md$/, "")]);
	assert.deepEqual(parseMonthRows(r1.text), [{ month: "2026-01", entries: 1, days: 1 }]);
	assert.equal(getFmValue(r1.text, "updated"), today);
	assert.ok(r1.text.includes("| 2026-01-09 | 22:10 | 첫 유료 고객 | 사이드프로젝트, 주간장부 | ★ | [[09 Diary/2026/2026-01/2026-01-09 2210\\|2026-01-09 2210]] |"));
	// 변경 기록 untouched (「4-4」: 매일의 저장을 기록하지 않는다).
	assert.equal(r1.text.split("## 변경 기록")[1], EMPTY_REG.split("## 변경 기록")[1]);

	// Earlier entry on the same day goes before; an older year goes first; months sorted.
	const r2 = registerEntry(r1.text, early, today);
	const r3 = registerEntry(r2.ok ? r2.text : "", run2025, today);
	const r4 = registerEntry(r3.ok ? r3.text : "", pinnedQ, today);
	assert.ok(r4.ok);
	assert.deepEqual(
		parseEntryRows(r4.text).map((r) => `${r.date} ${r.time}`),
		["2025-01-09 23:00", "2026-01-09 07:30", "2026-01-09 22:10", "2026-01-11 21:45"],
	);
	assert.deepEqual(parseMonthRows(r4.text), [
		{ month: "2025-01", entries: 1, days: 1 },
		{ month: "2026-01", entries: 3, days: 2 },
	]);
	// Same content as the hand-written fixture.
	assert.equal(r4.text.replace(/^updated: .*$/m, "updated: 2026-01-11"), FILLED_REG);

	// Update: a title change rewrites only that row; nothing added.
	const renamed = { ...paid, title: "첫 유료 고객 (2만원)", starred: false };
	const r5 = registerEntry(r4.text, renamed, "2026-01-12");
	assert.ok(r5.ok && !r5.added);
	const row = parseEntryRows(r5.text).find((r) => r.target === renamed.path.replace(/\.md$/, ""))!;
	assert.equal(row.title, "첫 유료 고객 (2만원)");
	assert.equal(row.starred, "");
	assert.equal(parseEntryRows(r5.text).length, 4);
	// No change → identical text (updated not bumped).
	const r6 = registerEntry(r5.text, renamed, "2026-01-13");
	assert.ok(r6.ok);
	assert.equal(r6.text, r5.text);
	// A pipe in the title is escaped.
	const pipe = registerEntry(r5.text, { ...early, title: "a | b" }, "2026-01-13");
	assert.ok(pipe.ok && pipe.text.includes("| a \\| b |"));
	assert.equal(parseEntryRows(pipe.text)[1].title, "a | b");
});

test("diary: upsertEntryRow / recomputeMonths fail softly without the tables", () => {
	const r = upsertEntryRow("# 없음\n", entryRowOf(paid));
	assert.ok(!r.ok);
	const m = recomputeMonths("# 없음\n");
	assert.ok(!m.ok);
	assert.deepEqual(monthRowsOf([{ date: "2026-01-09" }, { date: "2026-01-09" }, { date: "2026-02-01" }, { date: "x" }]), [
		{ month: "2026-01", entries: 2, days: 1 },
		{ month: "2026-02", entries: 1, days: 1 },
	]);
});

test("diary: delete removes the row, recomputes 월별 and logs 삭제 「제목」 (날짜)", () => {
	const r = unregisterEntry(FILLED_REG, paid, "2026-01-12");
	assert.ok(r.ok);
	assert.deepEqual(parseEntryRows(r.text).map((x) => x.time), ["23:00", "07:30", "21:45"]);
	assert.deepEqual(parseMonthRows(r.text), [
		{ month: "2025-01", entries: 1, days: 1 },
		{ month: "2026-01", entries: 2, days: 2 },
	]);
	assert.ok(r.text.includes("## 변경 기록\n\n- 2026-01-12: 삭제 「첫 유료 고객」 (2026-01-09)\n- 2026-10-26:"));
	assert.equal(getFmValue(r.text, "updated"), "2026-01-12");
	assert.equal(deleteLogText(early), "삭제 「(제목 없음)」 (2026-01-09)");
	// Removing a row that is not there changes nothing but the log.
	assert.equal(removeEntryRow(FILLED_REG, "09 Diary/2026/2026-01/2026-01-01 0000.md").removed, false);
	// Removing the last entry of a month drops the month row.
	const gone = unregisterEntry(FILLED_REG, run2025, "2026-01-12");
	assert.ok(gone.ok);
	assert.deepEqual(parseMonthRows(gone.text), [{ month: "2026-01", entries: 3, days: 2 }]);
});

// ───────────────────────── save conflict · own writes (fix/diary-conflict) ─────────────────────────

const ENTRY_PATH = `${ROOT}/2026/2026-01/2026-01-11 2210.md`;

test("diary: bodiesEqual ignores line endings and trailing whitespace, nothing else", () => {
	assert.ok(bodiesEqual("a", "a\n"));
	assert.ok(bodiesEqual("a\r\nb", "a\nb\n"));
	assert.ok(bodiesEqual("# 제목\n\n본문  \n\n", "# 제목\n\n본문"));
	assert.ok(!bodiesEqual("a", "ab"));
	assert.ok(!bodiesEqual("a\nb", "a\n\nb"));
	assert.equal(normalizeBody("a\r\nb\r\n"), "a\nb\n");
});

test("diary: regression — the second save after a first one is not a conflict (view base vs file body)", () => {
	forgetWrites();
	// What the view does: `base` = normalizeBody(parseEntry(file).body); saveBody compares the file body with it.
	const t0 = newEntryText(TEMPLATE, NOW);
	let base = normalizeBody(parseEntry(t0, ENTRY_PATH)!.body);
	// Save 1: the user typed "a" (the textarea has no trailing newline; withBody adds one).
	assert.equal(isConflict(t0, base, ENTRY_PATH), false);
	const t1 = withBody(t0, "a", NOW);
	rememberWrite(ENTRY_PATH, t1);
	assert.equal(bodyOf(t1), "a\n");
	base = normalizeBody(parseEntry(t1, ENTRY_PATH)!.body);
	assert.ok(bodiesEqual("a", base), "the textarea text counts as saved");
	// Save 2: "ab" against the base the view now holds → must not conflict.
	assert.equal(isConflict(t1, base, ENTRY_PATH), false);
	const t2 = withBody(t1, "ab", NOW);
	rememberWrite(ENTRY_PATH, t2);
	assert.equal(bodyOf(t2), "ab\n");
	// Save 3 against a base still holding the first save (the registry write was slow and a refresh
	// raced it): the file is what we last wrote → still not a conflict.
	assert.equal(isConflict(t2, base, ENTRY_PATH), false);
	// A real external edit is one.
	const ext = withBody(t2, "누군가 바꿈", NOW);
	assert.equal(isConflict(ext, normalizeBody(parseEntry(t2, ENTRY_PATH)!.body), ENTRY_PATH), true);
	// force (`expectBody === null`) never conflicts.
	assert.equal(isConflict(ext, null, ENTRY_PATH), false);
	forgetWrites();
});

test("diary: conflict detection compares normalized bodies — trailing newline, CRLF, trailing spaces", () => {
	forgetWrites();
	const t = withBody(newEntryText(TEMPLATE, NOW), "# 밤\n\n한 줄", NOW);
	assert.equal(bodyOf(t), "# 밤\n\n한 줄\n");
	assert.equal(isConflict(t, "# 밤\n\n한 줄", ENTRY_PATH), false, "no trailing newline in the editor");
	assert.equal(isConflict(t, "# 밤\n\n한 줄\n\n", ENTRY_PATH), false, "extra trailing newlines");
	assert.equal(isConflict(t.replace(/\n/g, "\r\n"), "# 밤\n\n한 줄", ENTRY_PATH), false, "CRLF file");
	assert.equal(isConflict(t, "# 밤\r\n\r\n한 줄\r\n", ENTRY_PATH), false, "CRLF editor");
	assert.equal(isConflict(t, "# 밤\n\n한 줄  ", ENTRY_PATH), false, "trailing spaces");
	assert.equal(isConflict(t, "# 밤\n\n한  줄", ENTRY_PATH), true, "an inner change is a conflict");
	// The frontmatter is not part of the comparison: a starred toggle while typing is no conflict.
	assert.equal(isConflict(setStarred(t, true), "# 밤\n\n한 줄", ENTRY_PATH), false);
});

test("diary: our own write (and Google Drive re-touching it) is recognised; a changed file is not", () => {
	forgetWrites();
	const reg = "09 Diary/Diary Index.md";
	assert.equal(lastWritten(ENTRY_PATH), null);
	assert.equal(isOwnWrite(ENTRY_PATH, "anything"), false, "a path we never wrote is never ours");
	const t1 = withBody(newEntryText(TEMPLATE, NOW), "a", NOW);
	rememberWrite(ENTRY_PATH, t1);
	assert.equal(lastWritten(ENTRY_PATH), t1);
	assert.equal(isOwnWrite(ENTRY_PATH, t1), true, "the modify event of our own save");
	assert.equal(isOwnWrite(ENTRY_PATH, t1.replace(/\n/g, "\r\n")), true, "same content, other line endings");
	assert.equal(isOwnWrite(ENTRY_PATH, t1 + "\n"), true, "same content, trailing newline");
	assert.equal(isOwnWrite(ENTRY_PATH, withBody(t1, "ab", NOW)), false, "an edit from outside");
	assert.equal(isOwnWrite(ENTRY_PATH, setStarred(t1, true)), false, "a frontmatter edit from outside");
	// Paths are keyed independently; a later write replaces the earlier one.
	rememberWrite(reg, EMPTY_REG);
	assert.equal(isOwnWrite(reg, EMPTY_REG), true);
	assert.equal(isOwnWrite(ENTRY_PATH, EMPTY_REG), false);
	const t2 = withBody(t1, "ab", NOW);
	rememberWrite(ENTRY_PATH, t2);
	assert.equal(isOwnWrite(ENTRY_PATH, t1), false, "the previous write is no longer ours");
	assert.equal(isOwnWrite(ENTRY_PATH, t2), true);
	forgetWrites();
	assert.equal(lastWritten(ENTRY_PATH), null);
});

// ───────────────────────── quoted frontmatter ─────────────────────────

test("diary: the template quotes its {{date}} placeholders; creation fills them inside the quotes", () => {
	assert.match(TEMPLATE, /^date: "\{\{date:YYYY-MM-DD\}\}"$/m);
	assert.match(TEMPLATE, /^time: "\{\{date:HH:mm\}\}"$/m);
	assert.match(TEMPLATE, /^created: "\{\{date:YYYY-MM-DDTHH:mm\}\}"$/m);
	assert.match(TEMPLATE, /^updated: "\{\{date:YYYY-MM-DDTHH:mm\}\}"$/m);
	const t = newEntryText(TEMPLATE, NOW);
	assert.match(t, /^date: "2026-01-11"$/m);
	assert.match(t, /^time: "22:10"$/m);
	assert.match(t, /^created: "2026-01-11T22:10"$/m);
	assert.match(t, /^updated: "2026-01-11T22:10"$/m);
	assert.ok(!t.includes("{{"));
	const e = parseEntry(t, ENTRY_PATH)!;
	assert.equal(e.date, "2026-01-11");
	assert.equal(e.time, "22:10");
	assert.equal(e.created, "2026-01-11T22:10");
	assert.equal(e.updated, "2026-01-11T22:10");
	// Saving bumps `updated` in place; the quoted `created` stays as written.
	const saved = withBody(t, "# 늦은 밤\n\n본문", new Date(2026, 0, 11, 22, 31));
	assert.equal(getFmValue(saved, "updated"), "2026-01-11T22:31");
	assert.match(saved, /^created: "2026-01-11T22:10"$/m);
	assert.equal(parseEntry(saved, ENTRY_PATH)!.updated, "2026-01-11T22:31");
});

test("diary: a quoted-frontmatter entry parses like an unquoted one (double and single quotes)", () => {
	const quoted = [
		"---",
		"type: diary",
		'date: "2026-01-09"',
		"time: '22:10'",
		'title: "첫 유료 고객"',
		'tags: ["사이드프로젝트", "주간장부"]',
		'location: "집"',
		'weather: "맑음 -3°C"',
		"starred: true",
		"pinned: false",
		'prompt: ""',
		"from:",
		'  - "[[04 Daily Pad/2026/2026-01-09#끼적임]]"',
		'created: "2026-01-09T22:10"',
		'updated: "2026-01-09T22:41"',
		"---",
		"# 첫 유료 고객",
		"",
		"본문.",
		"",
	].join("\n");
	const e = parseEntry(quoted, `${ROOT}/2026/2026-01/2026-01-09 2210.md`)!;
	assert.ok(e);
	assert.equal(e.date, "2026-01-09");
	assert.equal(e.time, "22:10");
	assert.equal(e.title, "첫 유료 고객");
	assert.deepEqual(e.tags, ["사이드프로젝트", "주간장부"]);
	assert.equal(e.location, "집");
	assert.equal(e.weather, "맑음 -3°C");
	assert.equal(e.starred, true);
	assert.equal(e.prompt, "");
	assert.deepEqual(e.from, ["[[04 Daily Pad/2026/2026-01-09#끼적임]]"]);
	assert.equal(e.created, "2026-01-09T22:10");
	assert.equal(e.updated, "2026-01-09T22:41");
	assert.equal(e.body, "# 첫 유료 고객\n\n본문.\n");
	// The line reader strips quotes too.
	assert.equal(getFmValue(quoted, "date"), "2026-01-09");
	assert.equal(getFmValue(quoted, "time"), "22:10");
	assert.equal(getFmValue(quoted, "created"), "2026-01-09T22:10");
	// Same entry as the unquoted fixture apart from the body.
	assert.equal(e.date, paid.date);
	assert.equal(e.time, paid.time);
	assert.equal(e.title, paid.title);
	assert.deepEqual(e.tags, paid.tags);
});
