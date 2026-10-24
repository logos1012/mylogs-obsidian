import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	buildBoard,
	bulletItems,
	computeSubProgress,
	dday,
	displayMainProgress,
	findSectionText,
	fmtNum,
	type Goal,
	metricProgress,
	missingFields,
	parseFrontmatterText,
	parseGoal,
	parseInputValue,
	parseSections,
	rollupMain,
	yearInfo,
} from "../src/pinboard/model.ts";
import {
	appendProgressLog,
	applyIndexEdit,
	indexPathCell,
	indexProgressCell,
	prependChangeLog,
	updateIndexRows,
} from "../src/pinboard/index-writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "fixtures/pinboard/2026");
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const texts = new Map(files.map((f) => [`01 Pinboard/2026/${f}`, readFileSync(join(dir, f), "utf8")]));
const indexText = readFileSync(join(here, "fixtures/pinboard/Pinboard Index.md"), "utf8");

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

/** Assert `out` equals `src` with exactly the line at `lineNo` replaced by `expected` (others byte-identical). */
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

test("the 7 fixtures parse into 3 Main and 4 Sub Goals", () => {
	const { goals } = load();
	assert.equal(goals.length, 7);
	const board = buildBoard(goals);
	assert.deepEqual(
		board.cards.map((c) => [c.main.id, c.main.area, c.subs.map((s) => s.id)]),
		[
			["G-2026-01", "사업", ["G-2026-01.1", "G-2026-01.2"]],
			["G-2026-02", "건강", ["G-2026-02.1"]],
			["G-2026-03", "브랜드", ["G-2026-03.1"]],
		],
	);
	assert.deepEqual(board.areas, ["사업", "건강", "브랜드"]);
	assert.equal(board.orphans.length, 0);
});

test("frontmatter fields are normalised; empty stays empty", () => {
	const { goals } = load();
	const by = new Map(goals.map((g) => [g.id, g]));
	const main = by.get("G-2026-01")!;
	assert.equal(main.type, "main-goal");
	assert.equal(main.title, "AI 사업으로 월 500만원 벌기");
	assert.equal(main.period, "2026");
	assert.equal(main.status, "active");
	assert.equal(main.subTotal, 2);
	assert.equal(main.subAchieved, 0);
	assert.equal(main.progress, 0);
	assert.equal(main.updated, "2026-10-24");

	const w = by.get("G-2026-02.1")!;
	assert.deepEqual(
		[w.type, w.parent, w.measure, w.kind, w.baseline, w.current, w.target, w.unit, w.due, w.progress],
		["sub-goal", "G-2026-02", "metric", "outcome", "100", "100", "95", "kg", "2026-12-31", 0],
	);
	assert.deepEqual(w.projects, []);
	assert.deepEqual(w.projectIds, []);

	const m = by.get("G-2026-01.2")!;
	assert.deepEqual([m.measure, m.baseline, m.current, m.target, m.unit, m.due], ["milestone", "", "강의 제작 중", "첫 결제 발생", "", ""]);

	const ig = by.get("G-2026-03.1")!;
	assert.deepEqual([ig.baseline, ig.current, ig.target], ["", "", "500"]);
	assert.equal(by.get("G-2026-01.1")!.target, "5000000");
});

test("Obsidian-typed frontmatter (Date, null, numbers) normalises the same way", () => {
	const g = parseGoal(
		{ id: "G-2026-09.1", type: "sub-goal", title: "x", due: new Date("2026-12-31T00:00:00Z"), baseline: null, current: 3, target: 10 },
		"p/x.md",
	)!;
	assert.deepEqual([g.due, g.baseline, g.current, g.target], ["2026-12-31", "", "3", "10"]);
	assert.equal(parseGoal({ type: "index" }, "p/i.md"), null);
	assert.equal(parseGoal(undefined, "p/i.md"), null);
});

test("body sections are read; comments and empty bullets dropped", () => {
	const { sections } = load();
	const health = sections.get("01 Pinboard/2026/G-2026-02 건강한 몸 만들기.md")!;
	assert.deepEqual(bulletItems(findSectionText(health, "왜 이 목표인가")), ["너무너무 중요한데 아직 잘 못하고 있다."]);
	assert.deepEqual(bulletItems(findSectionText(health, "달성한 모습")), ["최종적으로 체중 78kg."]);
	assert.deepEqual(bulletItems(findSectionText(health, "수단 (프로젝트·습관)", "수단")), []);
	const biz = sections.get("01 Pinboard/2026/G-2026-01 AI 사업으로 월 500만원 벌기.md")!;
	assert.equal(bulletItems(findSectionText(biz, "수단")).length, 3);
	const w = sections.get("01 Pinboard/2026/G-2026-02.1 체중 95kg.md")!;
	assert.deepEqual(bulletItems(findSectionText(w, "진척 기록")), ["2026-10-24: 시작 체중 100kg (사용자 보고)"]);
	assert.deepEqual(bulletItems(findSectionText(parseSections("## 진척 기록\n<!-- - YYYY-MM-DD: 내용 -->\n\n## 메모"), "진척 기록")), []);
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
			"G-2026-01.2 기한",
			"G-2026-02 수단 (프로젝트·습관)",
			"G-2026-03 왜 이 목표인가",
			"G-2026-03.1 시작 값",
			"G-2026-03.1 현재 값",
		],
	);
});

// ───────────────────────── math ─────────────────────────

test("metric progress: (current-baseline)/(target-baseline), clamped 0–100", () => {
	assert.equal(metricProgress(0, 0, 5000000), 0);
	assert.equal(metricProgress(0, 2500000, 5000000), 50);
	assert.equal(metricProgress(100, 98, 95), 40); // decreasing target (weight)
	assert.equal(metricProgress(100, 101, 95), 0); // clamped below
	assert.equal(metricProgress(100, 90, 95), 100); // clamped above
	assert.equal(metricProgress("", 10, 500), null); // baseline unknown → not invented
	assert.equal(metricProgress(5, 5, 5), null); // target == baseline
	assert.equal(metricProgress("1,000", "1,500", "2,000"), 50);
});

test("sub progress: metric rounds, milestone is 0 or 100", () => {
	const base = { baseline: "100", current: "97", target: "95", status: "active" };
	assert.equal(computeSubProgress({ ...base, measure: "metric" }), 60);
	assert.equal(computeSubProgress({ ...base, measure: "metric", current: "99" }), 20);
	assert.equal(computeSubProgress({ baseline: "0", current: "1", target: "3", status: "active", measure: "metric" }), 33);
	assert.equal(computeSubProgress({ baseline: "", current: "", target: "500", status: "active", measure: "metric" }), null);
	assert.equal(computeSubProgress({ baseline: "", current: "강의 제작 중", target: "첫 결제", status: "active", measure: "milestone" }), 0);
	assert.equal(computeSubProgress({ baseline: "", current: "첫 결제", target: "첫 결제", status: "achieved", measure: "milestone" }), 100);
});

test("main rollup: dropped excluded from total, achieved counted", () => {
	assert.deepEqual(rollupMain([{ status: "active" }, { status: "active" }]), { subTotal: 2, subAchieved: 0, progress: 0 });
	assert.deepEqual(rollupMain([{ status: "achieved" }, { status: "active" }]), { subTotal: 2, subAchieved: 1, progress: 50 });
	assert.deepEqual(rollupMain([{ status: "achieved" }, { status: "dropped" }]), { subTotal: 1, subAchieved: 1, progress: 100 });
	assert.deepEqual(rollupMain([{ status: "achieved" }, { status: "paused" }, { status: "active" }]), { subTotal: 3, subAchieved: 1, progress: 33 });
	assert.deepEqual(rollupMain([]), { subTotal: 0, subAchieved: 0, progress: 0 });
	const { goals } = load();
	const b = buildBoard(goals);
	assert.deepEqual(displayMainProgress(b.cards[0].main, b.cards[0].subs), { subTotal: 2, subAchieved: 0, progress: 0 });
});

test("display helpers: numbers, D-day, year", () => {
	assert.equal(fmtNum(5000000), "500만");
	assert.equal(fmtNum(1234), "1,234");
	assert.equal(fmtNum(2.5), "2.5");
	assert.deepEqual(dday("2026-12-31", "2026-10-24"), { big: "D-68", small: "2026.12.31", cls: "" });
	assert.deepEqual(dday("2026-10-30", "2026-10-24"), { big: "D-6", small: "2026.10.30", cls: "soon" });
	assert.deepEqual(dday("2026-10-24", "2026-10-24"), { big: "D-DAY", small: "2026.10.24", cls: "soon" });
	assert.deepEqual(dday("2026-10-20", "2026-10-24"), { big: "D+4", small: "2026.10.20 지남", cls: "over" });
	assert.equal(dday("", "2026-10-24").cls, "none");
	const y = yearInfo(2026, "2026-10-24");
	assert.equal(y.daysLeft, 68);
	assert.equal(Math.round(y.pct), 81);
	assert.equal(parseInputValue("98"), 98);
	assert.equal(parseInputValue("1,500"), 1500);
	assert.equal(parseInputValue("강의 완성"), "강의 완성");
	assert.equal(parseInputValue("2026-10-24"), "2026-10-24");
});

// ───────────────────────── index ─────────────────────────

test("index: current edit rewrites only the middle of the path and the progress cell", () => {
	const r = updateIndexRows(indexText, "2026", [{ id: "G-2026-02.1", current: "98", progress: "40%" }]);
	assert.deepEqual(r.missing, []);
	assertOnlyLineChanged(
		indexText,
		r.text,
		"| G-2026-02.1 | sub | 체중 95kg | G-2026-02 | active | 100 → 100 → 95 kg | 2026-12-31 | 0% | — |",
		"| G-2026-02.1 | sub | 체중 95kg | G-2026-02 | active | 100 → 98 → 95 kg | 2026-12-31 | 40% | — |",
	);
	// Human wording of the target ("첫 결제") is kept.
	const m = updateIndexRows(indexText, "2026", [{ id: "G-2026-01.2", current: "강의 완성" }]);
	assertOnlyLineChanged(
		indexText,
		m.text,
		"| G-2026-01.2 | sub | Claude Code 기본 강의 첫 판매 | G-2026-01 | active | — → 강의 제작 중 → 첫 결제 | 미정 | 0% | 강의 제작 (5시간, 10강) |",
		"| G-2026-01.2 | sub | Claude Code 기본 강의 첫 판매 | G-2026-01 | active | — → 강의 완성 → 첫 결제 | 미정 | 0% | 강의 제작 (5시간, 10강) |",
	);
});

test("index: status change rewrites sub and main rows", () => {
	const r = updateIndexRows(indexText, "2026", [
		{ id: "G-2026-01.2", status: "achieved", progress: indexProgressCell(100) },
		{ id: "G-2026-01", progress: indexProgressCell(50, { subAchieved: 1, subTotal: 2 }) },
	]);
	assert.deepEqual(r.missing, []);
	const expected = indexText
		.replace(
			"| G-2026-01 | main | AI 사업으로 월 500만원 벌기 | — | active | — | — | 0% (0/2) |",
			"| G-2026-01 | main | AI 사업으로 월 500만원 벌기 | — | active | — | — | 50% (1/2) |",
		)
		.replace(
			"| G-2026-01.2 | sub | Claude Code 기본 강의 첫 판매 | G-2026-01 | active | — → 강의 제작 중 → 첫 결제 | 미정 | 0% |",
			"| G-2026-01.2 | sub | Claude Code 기본 강의 첫 판매 | G-2026-01 | achieved | — → 강의 제작 중 → 첫 결제 | 미정 | 100% |",
		);
	assert.notEqual(expected, indexText);
	assert.equal(r.text, expected);
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
	const g = { baseline: "", current: "120", target: "500", unit: "명", measure: "metric" };
	assert.equal(indexPathCell(g), "? → 120 → 500 명");
	assert.equal(indexPathCell({ baseline: "", current: "", target: "첫 결제", unit: "", measure: "milestone" }), "— → — → 첫 결제");
	const odd = indexText.replace("| ? → ? → 500 명 |", "| 미입력 |");
	const r = updateIndexRows(odd, "2026", [{ id: "G-2026-03.1", current: "120", path: indexPathCell(g) }]);
	assert.ok(r.text.includes("| G-2026-03.1 | sub | 인스타그램 팔로워 500명 | G-2026-03 | active | ? → 120 → 500 명 | 2026-12-31 |"));
});

test("index: full edit = row + 변경 기록 on top + updated; rest byte-identical", () => {
	const r = applyIndexEdit(indexText, {
		year: "2026",
		rows: [{ id: "G-2026-02.1", current: "98", progress: "40%" }],
		log: "G-2026-02.1 current 100 → 98 (플러그인)",
		today: "2026-10-25",
	});
	const expected = indexText
		.replace("updated: 2026-10-24\n", "updated: 2026-10-25\n")
		.replace("| active | 100 → 100 → 95 kg | 2026-12-31 | 0% |", "| active | 100 → 98 → 95 kg | 2026-12-31 | 40% |")
		.replace(
			"최근 항목이 위에 오게 쓴다.\n\n- 2026-10-24: 시각화",
			"최근 항목이 위에 오게 쓴다.\n\n- 2026-10-25: G-2026-02.1 current 100 → 98 (플러그인)\n- 2026-10-24: 시각화",
		);
	assert.equal(r.text, expected);
	assert.deepEqual(r.missing, []);
});

test("index: 변경 기록 prepends even without existing items, and handles CRLF", () => {
	const empty = "---\nupdated: 2026-10-24\n---\n\n## 변경 기록\n\n최근 항목이 위에 오게 쓴다.\n";
	assert.equal(prependChangeLog(empty, "2026-10-25", "x"), "---\nupdated: 2026-10-24\n---\n\n## 변경 기록\n\n최근 항목이 위에 오게 쓴다.\n- 2026-10-25: x\n");
	const crlf = indexText.replace(/\n/g, "\r\n");
	const r = applyIndexEdit(crlf, { year: "2026", rows: [{ id: "G-2026-02.1", status: "paused" }], log: "y", today: "2026-10-25" });
	assert.ok(r.text.includes("\r\n- 2026-10-25: y\r\n- 2026-10-24: 시각화"));
	assert.ok(r.text.includes("| G-2026-02.1 | sub | 체중 95kg | G-2026-02 | paused |"));
	assert.ok(!/[^\r]\n/.test(r.text));
});

// ───────────────────────── 진척 기록 ─────────────────────────

test("진척 기록 append after an existing line touches only that section", () => {
	const src = texts.get("01 Pinboard/2026/G-2026-02.1 체중 95kg.md")!;
	const out = appendProgressLog(src, "2026-10-25", "체중 98kg");
	assert.equal(
		out,
		src.replace(
			"## 진척 기록\n- 2026-10-24: 시작 체중 100kg (사용자 보고)\n\n## 메모",
			"## 진척 기록\n- 2026-10-24: 시작 체중 100kg (사용자 보고)\n- 2026-10-25: 체중 98kg (보고됨)\n\n## 메모",
		),
	);
});

test("진척 기록 append into an empty section", () => {
	const src = texts.get("01 Pinboard/2026/G-2026-03.1 인스타그램 팔로워 500명.md")!;
	const out = appendProgressLog(src, "2026-10-25", "팔로워 120명\n확인");
	assert.equal(out, src.replace("## 진척 기록\n\n## 메모", "## 진척 기록\n- 2026-10-25: 팔로워 120명 확인 (보고됨)\n\n## 메모"));
});
