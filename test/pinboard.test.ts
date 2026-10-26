import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	buildBoard,
	bulletItems,
	chartSeries,
	computeSubProgress,
	dday,
	displayMainProgress,
	displaySubProgress,
	findSectionText,
	fmtNum,
	type Goal,
	goalIdsIn,
	healthCounts,
	isEnded,
	mergeRelated,
	metricProgress,
	missingFields,
	newestFirst,
	parseFrontmatterText,
	parseGoal,
	parseInputValue,
	parseProgressLine,
	parseSections,
	relatedOf,
	rollupMain,
	yearInfo,
} from "../src/pinboard/model.ts";
import {
	appendProgressLog,
	applyIndexEdit,
	ensureHealthColumn,
	indexPathCell,
	indexProgressCell,
	prependChangeLog,
	progressLogLine,
	updateIndexRows,
} from "../src/pinboard/index-writer.ts";

// Fixtures: the fictional 김하루's 2026 goals (MyLogs 배포 설계 「6」).
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "fixtures/pinboard/2026");
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const texts = new Map(files.map((f) => [`01 Pinboard/2026/${f}`, readFileSync(join(dir, f), "utf8")]));
const indexText = readFileSync(join(here, "fixtures/pinboard/Pinboard Index.md"), "utf8");
const P = (name: string) => `01 Pinboard/2026/${name}.md`;

function load(): { goals: Goal[]; sections: Map<string, Map<string, string>> } {
	const goals: Goal[] = [];
	const sections = new Map<string, Map<string, string>>();
	for (const [path, text] of texts) {
		const { data, body } = parseFrontmatterText(text);
		const g = parseGoal(data, path);
		assert.ok(g, path);
		goals.push(g);
		sections.set(path, parseSections(body));
	}
	return { goals, sections };
}

/** Assert `out` equals `src` with exactly one line changed from `from` to `to`. */
function assertOnlyLineChanged(src: string, out: string, from: string, to: string): void {
	const a = src.split("\n");
	const b = out.split("\n");
	assert.equal(b.length, a.length);
	const changed = a.map((l, i) => (l !== b[i] ? i : -1)).filter((i) => i >= 0);
	assert.equal(changed.length, 1, `exactly one line changed, got ${changed.length}`);
	assert.equal(a[changed[0]], from);
	assert.equal(b[changed[0]], to);
}

// ───────────────────────── parse ─────────────────────────

test("the 8 fixtures parse into 3 Main and 5 Sub Goals", () => {
	const { goals } = load();
	assert.equal(goals.length, 8);
	const board = buildBoard(goals);
	assert.deepEqual(
		board.cards.map((c) => [c.main.id, c.main.area, c.subs.map((s) => s.id)]),
		[
			["G-2026-01", "사업", ["G-2026-01.1", "G-2026-01.2"]],
			["G-2026-02", "건강", ["G-2026-02.1", "G-2026-02.2"]],
			["G-2026-03", "글쓰기", ["G-2026-03.1"]],
		],
	);
	assert.equal(board.orphans.length, 0);
});

test("frontmatter: health, weight, statuses; empty stays empty", () => {
	const { goals } = load();
	const by = new Map(goals.map((g) => [g.id, g]));
	const main = by.get("G-2026-01")!;
	assert.deepEqual([main.type, main.status, main.health, main.subTotal, main.subAchieved, main.progress], ["main-goal", "active", "at-risk", 2, 0, 20]);
	assert.equal(by.get("G-2026-03")!.health, "");

	const rev = by.get("G-2026-01.2")!;
	assert.deepEqual(
		[rev.measure, rev.baseline, rev.current, rev.target, rev.unit, rev.due, rev.weight, rev.health, rev.progress],
		["metric", "0", "300000", "1000000", "원/월", "2026-12-31", 2, "on-track", 30],
	);
	assert.deepEqual(rev.projects, ["[[05 Project Folders/개인/뉴스레터 창간/뉴스레터 창간]]"]);
	assert.deepEqual(rev.projectIds, ["P-newsletter"]);

	const first = by.get("G-2026-01.1")!;
	assert.deepEqual([first.measure, first.current, first.target, first.due, first.weight, first.health], ["milestone", "베타 사용자 5명", "첫 결제 발생", "", null, ""]);
	assert.equal(by.get("G-2026-02.1")!.status, "achieved");
	assert.ok(isEnded("achieved") && isEnded("partial") && isEnded("missed") && isEnded("dropped"));
	assert.ok(!isEnded("active") && !isEnded("paused"));
});

test("Obsidian-typed frontmatter (Date, null, numbers) normalises the same way; bad health / weight ignored", () => {
	const g = parseGoal(
		{ id: "G-2026-09.1", type: "sub-goal", title: "x", due: new Date("2026-12-31T00:00:00Z"), baseline: null, current: 3, target: 10, health: "great", weight: -1 },
		"p/x.md",
	)!;
	assert.deepEqual([g.due, g.baseline, g.current, g.target, g.health, g.weight], ["2026-12-31", "", "3", "10", "", null]);
	assert.equal(parseGoal({ type: "sub-goal", health: "Off-Track" }, "p/y.md")!.health, "off-track");
	assert.equal(parseGoal({ type: "sub-goal", weight: "1.5" }, "p/y.md")!.weight, 1.5);
	assert.equal(parseGoal({ type: "index" }, "p/i.md"), null);
	assert.equal(parseGoal(undefined, "p/i.md"), null);
});

test("body sections are read; comments and empty bullets dropped", () => {
	const { sections } = load();
	const run = sections.get(P("G-2026-02 달리기"))!;
	assert.deepEqual(bulletItems(findSectionText(run, "왜 이 목표인가")), ["오래 일하려면 체력이 먼저다."]);
	assert.deepEqual(bulletItems(findSectionText(run, "수단 (프로젝트·습관)", "수단")), []);
	const biz = sections.get(P("G-2026-01 사이드 프로젝트로 첫 매출 내기"))!;
	assert.equal(bulletItems(findSectionText(biz, "수단")).length, 3);
	const first = sections.get(P("G-2026-01.1 첫 유료 고객 1명"))!;
	assert.deepEqual(bulletItems(findSectionText(first, "진척 기록")), []);
});

test("채워 넣을 칸 matches the reference builder's rules", () => {
	const { goals, sections } = load();
	const missing = missingFields(buildBoard(goals), (p) => sections.get(p)!);
	assert.deepEqual(
		missing.map((m) => `${m.id} ${m.field}`),
		[
			"G-2026-01 왜 이 목표인가",
			"G-2026-01 달성한 모습",
			"G-2026-01.1 기한",
			"G-2026-02 수단 (프로젝트·습관)",
			"G-2026-03 왜 이 목표인가",
			"G-2026-03.1 시작 값",
			"G-2026-03.1 현재 값",
		],
	);
});

// ───────────────────────── math (SPEC 1-2) ─────────────────────────

test("metric progress: (current-baseline)/(target-baseline), clamped 0–100", () => {
	assert.equal(metricProgress(0, 300000, 1000000), 30);
	assert.equal(metricProgress(70, 68, 65), 40); // decreasing target
	assert.equal(metricProgress(70, 71, 65), 0); // clamped below
	assert.equal(metricProgress(70, 60, 65), 100); // clamped above
	assert.equal(metricProgress("", 10, 300), null); // baseline unknown → not invented
	assert.equal(metricProgress(5, 5, 5), null); // target == baseline
	assert.equal(metricProgress("1,000", "1,500", "2,000"), 50);
});

test("sub progress: metric rounds, milestone 0 until achieved, achieved is always 100", () => {
	const base = { baseline: "0", current: "2", target: "3", status: "active" };
	assert.equal(computeSubProgress({ ...base, measure: "metric" }), 67);
	assert.equal(computeSubProgress({ ...base, measure: "metric", status: "achieved" }), 100);
	assert.equal(computeSubProgress({ baseline: "", current: "", target: "300", status: "active", measure: "metric" }), null);
	assert.equal(computeSubProgress({ baseline: "", current: "", target: "300", status: "achieved", measure: "metric" }), 100);
	assert.equal(computeSubProgress({ baseline: "", current: "베타 사용자 5명", target: "첫 결제", status: "active", measure: "milestone" }), 0);
	assert.equal(computeSubProgress({ baseline: "", current: "첫 결제", target: "첫 결제", status: "achieved", measure: "milestone" }), 100);
	assert.equal(computeSubProgress({ baseline: "", current: "", target: "", status: "partial", measure: "milestone" }), 0);
	const { goals } = load();
	const by = new Map(goals.map((g) => [g.id, g]));
	assert.equal(displaySubProgress(by.get("G-2026-03.1")!), null); // 미정 on screen
	assert.equal(Math.round(displaySubProgress(by.get("G-2026-02.2")!)!), 67);
});

test("main rollup: weighted average, dropped excluded, 미정 counts as 0, achieved = 100", () => {
	const m = (status: string, current: string, weight: number | null = null) => ({ status, measure: "metric", baseline: "0", current, target: "100", weight });
	// equal weights
	assert.deepEqual(rollupMain([m("active", "50"), m("active", "100")]), { subTotal: 2, subAchieved: 0, progress: 75 });
	// weights: (20×1 + 80×3) / 4 = 65
	assert.equal(rollupMain([m("active", "20"), m("active", "80", 3)]).progress, 65);
	// a missing weight counts as 1 when others have one: (0×1 + 30×2) / 3 = 20
	assert.equal(rollupMain([{ status: "active", measure: "milestone", weight: null }, m("active", "30", 2)]).progress, 20);
	// dropped is out of both the count and the average
	assert.deepEqual(rollupMain([m("active", "40"), m("dropped", "100", 5)]), { subTotal: 1, subAchieved: 0, progress: 40 });
	// achieved = 100 even when its numbers say otherwise
	assert.deepEqual(rollupMain([m("achieved", "10"), m("active", "0")]), { subTotal: 2, subAchieved: 1, progress: 50 });
	// 미정 (not computable) = 0
	assert.equal(rollupMain([{ status: "active", measure: "metric", baseline: "", current: "", target: "300" }, m("active", "60")]).progress, 30);
	// milestone
	assert.equal(rollupMain([{ status: "achieved", measure: "milestone" }, { status: "active", measure: "milestone" }, { status: "paused", measure: "milestone" }]).progress, 33);
	assert.deepEqual(rollupMain([]), { subTotal: 0, subAchieved: 0, progress: 0 });
	// the fixtures' stored Main values match
	const b = buildBoard(load().goals);
	assert.deepEqual(
		b.cards.map((c) => displayMainProgress(c.main, c.subs)),
		[
			{ subTotal: 2, subAchieved: 0, progress: 20 },
			{ subTotal: 2, subAchieved: 1, progress: 84 },
			{ subTotal: 1, subAchieved: 0, progress: 0 },
		],
	);
	for (const c of b.cards) assert.equal(c.main.progress, displayMainProgress(c.main, c.subs).progress, c.main.id);
});

test("health summary counts live goals only", () => {
	const { goals } = load();
	assert.deepEqual(healthCounts(goals), { "on-track": 3, "at-risk": 1, "off-track": 0, none: 3 });
});

test("display helpers: numbers, D-day, year", () => {
	assert.equal(fmtNum(1000000), "100만");
	assert.equal(fmtNum(1234), "1,234");
	assert.equal(fmtNum(2.5), "2.5");
	assert.deepEqual(dday("2026-12-31", "2026-10-24"), { big: "D-68", small: "2026.12.31", cls: "" });
	assert.deepEqual(dday("2026-10-30", "2026-10-24"), { big: "D-6", small: "2026.10.30", cls: "soon" });
	assert.deepEqual(dday("2026-10-20", "2026-10-24"), { big: "D+4", small: "2026.10.20 지남", cls: "over" });
	const y = yearInfo(2026, "2026-10-24");
	assert.equal(y.daysLeft, 68);
	assert.equal(Math.round(y.pct), 81);
	assert.equal(parseInputValue("98"), 98);
	assert.equal(parseInputValue("1,500"), 1500);
	assert.equal(parseInputValue("베타 사용자 7명"), "베타 사용자 7명");
});

// ───────────────────────── 진척 기록 (SPEC 1-3) ─────────────────────────

test("진척 기록 line: new format fields, old format still valid", () => {
	const l = parseProgressLine("2026-10-24: 유료 구독 30명 (value:: 300000) (health:: on-track) (확인됨) — 근거: [[08 My Life/02 Weekly/2026/2026-W43]]");
	assert.deepEqual(l, {
		date: "2026-10-24",
		text: "유료 구독 30명",
		value: 300000,
		valueRaw: "300000",
		health: "on-track",
		verify: "확인됨",
		evidence: "[[08 My Life/02 Weekly/2026/2026-W43]]",
	});
	const old = parseProgressLine("2026-10-20: 이번 주 2회 달림 (사용자 보고)");
	assert.deepEqual(old, { date: "2026-10-20", text: "이번 주 2회 달림 (사용자 보고)", value: null, valueRaw: "", health: "", verify: "", evidence: "" });
	const odd = parseProgressLine("메모만 (health:: 좋음) (보고됨)");
	assert.deepEqual([odd.date, odd.text, odd.health, odd.verify], ["", "메모만", "", "보고됨"]);
});

test("진척 기록 line format: fields in order, default 근거", () => {
	assert.equal(
		progressLogLine({ date: "2026-10-27", text: "유료 구독 38명", value: "380,000", health: "at-risk", verify: "보고됨" }),
		"- 2026-10-27: 유료 구독 38명 (value:: 380000) (health:: at-risk) (보고됨) — 근거: 사용자 보고 (대화, 2026-10-27)",
	);
	assert.equal(
		progressLogLine({ date: "2026-10-27", text: "인터뷰\n3명", verify: "확인됨", evidence: "[[08 My Life/01 Daily/2026/2026-10/2026-10-27]]" }),
		"- 2026-10-27: 인터뷰 3명 (확인됨) — 근거: [[08 My Life/01 Daily/2026/2026-10/2026-10-27]]",
	);
	// round trip
	const back = parseProgressLine(progressLogLine({ date: "2026-10-27", text: "x", value: "5", health: "off-track", verify: "보고됨" }).slice(2));
	assert.deepEqual([back.value, back.health, back.verify, back.evidence], [5, "off-track", "보고됨", "사용자 보고 (대화, 2026-10-27)"]);
});

test("진척 기록 append after an existing line touches only that section", () => {
	const src = texts.get(P("G-2026-02.2 주 3회 달리기"))!;
	const out = appendProgressLog(src, { date: "2026-10-27", text: "이번 주 3회", value: "3", health: "on-track", verify: "보고됨" });
	assert.equal(
		out,
		src.replace(
			"## 진척 기록\n- 2026-10-20: 이번 주 2회 달림 (사용자 보고)\n\n## 메모",
			"## 진척 기록\n- 2026-10-20: 이번 주 2회 달림 (사용자 보고)\n- 2026-10-27: 이번 주 3회 (value:: 3) (health:: on-track) (보고됨) — 근거: 사용자 보고 (대화, 2026-10-27)\n\n## 메모",
		),
	);
});

test("진척 기록 append into an empty section, and a Main Goal without the section gets one before 리뷰 메모", () => {
	const src = texts.get(P("G-2026-03.1 뉴스레터 구독자 300명"))!;
	const out = appendProgressLog(src, { date: "2026-10-27", text: "구독자 40명", verify: "보고됨" });
	assert.equal(out, src.replace("## 진척 기록\n\n## 메모", "## 진척 기록\n- 2026-10-27: 구독자 40명 (보고됨) — 근거: 사용자 보고 (대화, 2026-10-27)\n\n## 메모"));
	const main = texts.get(P("G-2026-01 사이드 프로젝트로 첫 매출 내기"))!;
	const m = appendProgressLog(main, { date: "2026-10-27", text: "결제 페이지 지연", health: "at-risk", verify: "보고됨" });
	assert.equal(
		m,
		main.replace("## 리뷰 메모", "## 진척 기록\n- 2026-10-27: 결제 페이지 지연 (health:: at-risk) (보고됨) — 근거: 사용자 보고 (대화, 2026-10-27)\n\n## 리뷰 메모"),
	);
});

test("newest first and chart series (baseline first, valued lines in date order)", () => {
	const ls = [
		parseProgressLine("2026-10-24: b (value:: 300000) (health:: on-track) (확인됨) — 근거: x"),
		parseProgressLine("2026-09-30: a (value:: 100000) (보고됨) — 근거: x"),
		parseProgressLine("2026-10-24: c, no value (보고됨) — 근거: x"),
		parseProgressLine("undated"),
	];
	assert.deepEqual(
		newestFirst(ls).map((l) => l.text),
		["c, no value", "b", "a", "undated"],
	);
	const s = chartSeries({ baseline: "0", target: "1000000" }, ls, "2026-10-27");
	assert.deepEqual(s, {
		points: [
			{ date: "2026-09-30", value: 0, health: "", baseline: true },
			{ date: "2026-09-30", value: 100000, health: "" },
			{ date: "2026-10-24", value: 300000, health: "on-track" },
		],
		target: 1000000,
	});
	assert.deepEqual(chartSeries({ baseline: "", target: "300" }, [], "2026-10-27"), { points: [], target: 300 });
	assert.deepEqual(chartSeries({ baseline: "0", target: "3" }, [], "2026-10-27").points, [{ date: "2026-10-27", value: 0, health: "", baseline: true }]);
});

// ───────────────────────── 관련 업무 (SPEC 1-5) ─────────────────────────

test("관련 업무: projects both ways (one-sided marked), habits by goal::, 수단 as 메모", () => {
	const { goals } = load();
	const rev = goals.find((g) => g.id === "G-2026-01.2")!;
	const projects = [
		{ id: "P-newsletter", title: "뉴스레터 창간", path: "05 Project Folders/개인/뉴스레터 창간/뉴스레터 창간.md", status: "진행", goals: [] },
		{ id: "P-report", title: "분기 보고서 자동화", path: "05 Project Folders/회사/분기 보고서 자동화/분기 보고서 자동화.md", status: "진행", goals: ["G-2026-01.2"] },
		{ id: "P-other", title: "다른 일", path: "05 Project Folders/개인/다른 일/다른 일.md", status: "후보", goals: ["G-2026-03.1"] },
	];
	const habits = [
		{ id: "F-1", name: "달리기", status: "사용", goals: goalIdsIn("G-2026-02.2") },
		{ id: "F-2", name: "글쓰기", status: "사용", goals: goalIdsIn("[[G-2026-01.2 월 매출 100만원]], G-2026-03.1") },
	];
	const r = relatedOf(rev, projects, habits, ["뉴스레터 유료 구독"]);
	assert.deepEqual(r, [
		{ kind: "project", label: "뉴스레터 창간", path: projects[0].path, id: "P-newsletter", status: "진행", oneSided: true },
		{ kind: "project", label: "분기 보고서 자동화", path: projects[1].path, id: "P-report", status: "진행", oneSided: true },
		{ kind: "habit", label: "F-2 글쓰기", id: "F-2", status: "사용" },
		{ kind: "memo", label: "뉴스레터 유료 구독" },
	]);
	// both sides linked → not one-sided; an id without a hub is broken
	const linked = relatedOf({ ...rev, projectIds: ["P-newsletter", "P-gone"] }, [{ ...projects[0], goals: ["G-2026-01.2"] }], [], []);
	assert.deepEqual(
		linked.map((x) => [x.label, !!x.oneSided, !!x.broken]),
		[
			["뉴스레터 창간", false, false],
			["P-gone", false, true],
		],
	);
	// Main: its own memos + the Subs' projects/habits once
	const merged = mergeRelated([{ kind: "memo", label: "m" }], [r, r]);
	assert.deepEqual(
		merged.map((x) => `${x.kind}:${x.label}`),
		["memo:m", "project:뉴스레터 창간", "project:분기 보고서 자동화", "habit:F-2 글쓰기"],
	);
});

// ───────────────────────── index ─────────────────────────

test("index: current edit rewrites only the middle of the path and the progress cell", () => {
	const r = updateIndexRows(indexText, "2026", [{ id: "G-2026-01.2", current: "380000", progress: "38%" }]);
	assert.deepEqual(r.missing, []);
	assertOnlyLineChanged(
		indexText,
		r.text,
		"| G-2026-01.2 | sub | 월 매출 100만원 | G-2026-01 | active | on-track | 0 → 300000 → 1000000 원/월 | 2026-12-31 | 30% | 뉴스레터 유료 구독 |",
		"| G-2026-01.2 | sub | 월 매출 100만원 | G-2026-01 | active | on-track | 0 → 380000 → 1000000 원/월 | 2026-12-31 | 38% | 뉴스레터 유료 구독 |",
	);
	// Human wording of the target ("첫 결제") is kept.
	const m = updateIndexRows(indexText, "2026", [{ id: "G-2026-01.1", current: "베타 사용자 7명" }]);
	assertOnlyLineChanged(
		indexText,
		m.text,
		"| G-2026-01.1 | sub | 첫 유료 고객 1명 | G-2026-01 | active | — | — → 베타 사용자 5명 → 첫 결제 | 미정 | 0% | 뉴스레터 창간 |",
		"| G-2026-01.1 | sub | 첫 유료 고객 1명 | G-2026-01 | active | — | — → 베타 사용자 7명 → 첫 결제 | 미정 | 0% | 뉴스레터 창간 |",
	);
});

test("index: health column — set, clear to —", () => {
	const r = updateIndexRows(indexText, "2026", [
		{ id: "G-2026-03", health: "at-risk" },
		{ id: "G-2026-01.2", health: "" },
	]);
	assert.ok(r.text.includes("| G-2026-03 | main | 글쓰기 습관 | — | active | at-risk | — |"));
	assert.ok(r.text.includes("| G-2026-01.2 | sub | 월 매출 100만원 | G-2026-01 | active | — | 0 → 300000"));
});

test("index: status change rewrites sub and main rows", () => {
	const r = updateIndexRows(indexText, "2026", [
		{ id: "G-2026-01.1", status: "achieved", health: "", progress: indexProgressCell(100) },
		{ id: "G-2026-01", progress: indexProgressCell(80, { subAchieved: 1, subTotal: 2 }) },
	]);
	assert.deepEqual(r.missing, []);
	const expected = indexText
		.replace("| G-2026-01 | main | 사이드 프로젝트로 첫 매출 내기 | — | active | at-risk | — | — | 20% (0/2) |", "| G-2026-01 | main | 사이드 프로젝트로 첫 매출 내기 | — | active | at-risk | — | — | 80% (1/2) |")
		.replace("| G-2026-01.1 | sub | 첫 유료 고객 1명 | G-2026-01 | active | — | — → 베타 사용자 5명 → 첫 결제 | 미정 | 0% |", "| G-2026-01.1 | sub | 첫 유료 고객 1명 | G-2026-01 | achieved | — | — → 베타 사용자 5명 → 첫 결제 | 미정 | 100% |");
	assert.notEqual(expected, indexText);
	assert.equal(r.text, expected);
});

test("index: a year table without the health column gets it after status", () => {
	const old = indexText
		.split("\n")
		.map((l) => {
			if (!l.startsWith("|")) return l;
			const parts = l.split("|");
			parts.splice(6, 1);
			return parts.join("|");
		})
		.join("\n");
	assert.ok(old.includes("| id | 종류 | 제목 | parent | status | baseline → current → target |"));
	const health = new Map([
		["G-2026-01", "at-risk"],
		["G-2026-01.2", "on-track"],
		["G-2026-02", "on-track"],
		["G-2026-02.2", "on-track"],
	]);
	const migrated = ensureHealthColumn(old, "2026", (id) => health.get(id) ?? "");
	assert.equal(migrated, indexText);
	assert.equal(ensureHealthColumn(indexText, "2026"), indexText); // already there
	assert.equal(ensureHealthColumn(old, "2027"), old); // no such year
	// then a normal row update works on the new column
	assert.ok(updateIndexRows(migrated, "2026", [{ id: "G-2026-03", health: "off-track" }]).text.includes("| 글쓰기 습관 | — | active | off-track |"));
});

test("index: unknown id is reported and nothing changes", () => {
	const r = updateIndexRows(indexText, "2026", [{ id: "G-2026-09.1", status: "paused" }]);
	assert.deepEqual(r.missing, ["G-2026-09.1"]);
	assert.equal(r.text, indexText);
	const y = updateIndexRows(indexText, "2027", [{ id: "G-2026-01", status: "paused" }]);
	assert.deepEqual(y.missing, ["G-2026-01"]);
	assert.equal(y.text, indexText);
});

test("index: full path cell when the existing cell can't be split", () => {
	const g = { baseline: "", current: "40", target: "300", unit: "명", measure: "metric" };
	assert.equal(indexPathCell(g), "? → 40 → 300 명");
	assert.equal(indexPathCell({ baseline: "", current: "", target: "첫 결제", unit: "", measure: "milestone" }), "— → — → 첫 결제");
	const odd = indexText.replace("| ? → ? → 300 명 |", "| 미입력 |");
	const r = updateIndexRows(odd, "2026", [{ id: "G-2026-03.1", current: "40", path: indexPathCell(g) }]);
	assert.ok(r.text.includes("| G-2026-03.1 | sub | 뉴스레터 구독자 300명 | G-2026-03 | active | — | ? → 40 → 300 명 | 2026-12-31 |"));
});

test("index: full edit = row + 변경 기록 on top + updated; rest byte-identical", () => {
	const r = applyIndexEdit(indexText, {
		year: "2026",
		rows: [{ id: "G-2026-01.2", current: "380000", progress: "38%", health: "at-risk" }],
		log: "G-2026-01.2 current 300000 → 380000, health on-track → at-risk (플러그인)",
		today: "2026-10-27",
	});
	const expected = indexText
		.replace("updated: 2026-10-24\n", "updated: 2026-10-27\n")
		.replace("| active | on-track | 0 → 300000 → 1000000 원/월 | 2026-12-31 | 30% |", "| active | at-risk | 0 → 380000 → 1000000 원/월 | 2026-12-31 | 38% |")
		.replace("최근 항목이 위에 오게 쓴다.\n\n- 2026-10-24:", "최근 항목이 위에 오게 쓴다.\n\n- 2026-10-27: G-2026-01.2 current 300000 → 380000, health on-track → at-risk (플러그인)\n- 2026-10-24:");
	assert.equal(r.text, expected);
	assert.deepEqual(r.missing, []);
});

test("index: 변경 기록 prepends even without existing items, and handles CRLF", () => {
	const empty = "---\nupdated: 2026-10-24\n---\n\n## 변경 기록\n\n최근 항목이 위에 오게 쓴다.\n";
	assert.equal(prependChangeLog(empty, "2026-10-25", "x"), "---\nupdated: 2026-10-24\n---\n\n## 변경 기록\n\n최근 항목이 위에 오게 쓴다.\n- 2026-10-25: x\n");
	const crlf = indexText.replace(/\n/g, "\r\n");
	const r = applyIndexEdit(crlf, { year: "2026", rows: [{ id: "G-2026-02.2", status: "paused" }], log: "y", today: "2026-10-25" });
	assert.ok(r.text.includes("\r\n- 2026-10-25: y\r\n- 2026-10-24: G-2026-01.2"));
	assert.ok(r.text.includes("| G-2026-02.2 | sub | 주 3회 달리기 | G-2026-02 | paused |"));
	assert.ok(!/[^\r]\n/.test(r.text));
});
