import { test } from "node:test";
import assert from "node:assert/strict";
import {
	anchorKey,
	appendRecord,
	classifyFiles,
	elementOf,
	isRegistry,
	linkMemoLine,
	materialsOf,
	nextBlockId,
	nextElementId,
	orderRegistry,
	parseEvidence,
	parseRecord,
	parseRegistry,
	recordLinksOf,
	removeRecordEmbed,
	setEvidence,
	setHubFm,
	setHubMethod,
	sourceOf,
	toggleMaterial,
	unlinkMemoLine,
	upsertRegistryRow,
	wheelPurpose,
} from "../src/flywheel/wheel.ts";
import { planDay, planElementChange, planNewElement, planRecord, readWheel } from "../src/flywheel/store.ts";
import { getFmList, getFmValue } from "../src/projects/ops.ts";

// Flywheel v3 (12 Flywheel/AGENTS.md 3.0). Fictional data only (김하루).
const ROOT = "12 Flywheel";
const REG = `---\ntype: flywheel\nelements: 2\nupdated: 2026-01-01\n---\n# Flywheel\n\n매일 몸을 쓰고, 배운 걸 쓴다\n\n## 요소\n| id | 이름 | 상태 | 목표 | 시작 |\n|---|---|---|---|---|\n| F-1 | [[몸 만들기/몸 만들기\\|몸 만들기]] | 사용 | G-2026-02.1 | 2026-01-01 |\n| F-2 | [[글쓰기/글쓰기\\|글쓰기]] | 쉼 | — | 2026-01-05 |\n\n## 변경 기록\n- 2026-01-01: 바퀴 세움\n`;
const HUB = `---\ntype: flywheel-element\nid: F-1\ntitle: 몸 만들기\nstatus: 사용\nsince: 2026-01-01\ngoals: [G-2026-02.1]\nchannels: [인스타그램]\nupdated: 2026-01-01\n---\n# 몸 만들기\n\n## 방법\n- 정체성:: 나는 매일 몸을 쓰는 사람이다\n- 최소:: 걷기 15분\n- 보통:: (채우기)\n- 다음:: → F-2 체력이 있어야 쓴다\n\n## 지금 다듬는 것\n\n## 주요 결정\n- 2026-01-01 — 요소 시작\n`;

test("registry: rows, purpose, upsert keeps other rows, order, next id", () => {
	assert.ok(isRegistry(REG));
	assert.equal(isRegistry("# Flywheel\n\n## F-1 몸 만들기\n- status:: 사용\n"), false);
	const rows = parseRegistry(REG);
	assert.deepEqual(rows.map((r) => [r.id, r.name, r.link, r.status, r.goals, r.since]), [
		["F-1", "몸 만들기", "몸 만들기/몸 만들기", "사용", ["G-2026-02.1"], "2026-01-01"],
		["F-2", "글쓰기", "글쓰기/글쓰기", "쉼", [], "2026-01-05"],
	]);
	assert.equal(wheelPurpose(REG), "매일 몸을 쓰고, 배운 걸 쓴다");
	const up = upsertRegistryRow(REG, { ...rows[1], status: "사용", goals: ["G-2026-03.1", "G-2026-03.2"] });
	assert.ok(up.includes("| F-2 | [[글쓰기/글쓰기\\|글쓰기]] | 사용 | G-2026-03.1, G-2026-03.2 | 2026-01-05 |"));
	assert.ok(up.includes("| F-1 | [[몸 만들기/몸 만들기\\|몸 만들기]] | 사용 | G-2026-02.1 | 2026-01-01 |"));
	const added = upsertRegistryRow(REG, { id: "F-3", name: "책 읽기", link: "책 읽기/책 읽기", status: "사용", goals: [], since: "2026-01-09" });
	assert.deepEqual(parseRegistry(added).map((r) => r.id), ["F-1", "F-2", "F-3"]);
	assert.deepEqual(parseRegistry(orderRegistry(added, ["F-3", "F-1"])).map((r) => r.id), ["F-3", "F-1", "F-2"]);
	assert.equal(nextElementId(added + "\n- 2026-01-02: 요소 교체: F-7 폐기\n"), "F-8", "never reuses a number seen anywhere");
});

test("hub: element from frontmatter + 방법; method/frontmatter edits are line edits", () => {
	const e = elementOf(parseRegistry(REG)[0], HUB, `${ROOT}/몸 만들기/몸 만들기.md`);
	assert.equal(e.id, "F-1");
	assert.equal(e.name, "몸 만들기");
	assert.equal(e.folder, `${ROOT}/몸 만들기`);
	assert.deepEqual(e.goals, ["G-2026-02.1"]);
	assert.deepEqual(e.channels, ["인스타그램"]);
	assert.equal(e.fields["최소"], "걷기 15분");
	assert.equal(e.fields["다음"], "→ F-2 체력이 있어야 쓴다");
	const m = setHubMethod(HUB, "보통", "달리기 5km");
	assert.ok(m.includes("- 보통:: 달리기 5km\n- 다음::"));
	assert.equal(m.replace("- 보통:: 달리기 5km", "- 보통:: (채우기)"), HUB);
	const g = setHubFm(HUB, "goals", ["G-2026-02.1", "G-2026-03.1"], "2026-01-09");
	assert.deepEqual(getFmList(g, "goals"), ["G-2026-02.1", "G-2026-03.1"]);
	assert.equal(getFmValue(g, "updated"), "2026-01-09");
	const missing = elementOf(parseRegistry(REG)[1], null, `${ROOT}/글쓰기/글쓰기.md`);
	assert.equal(missing.hasHub, false);
	assert.equal(missing.status, "쉼");
});

test("records: date blocks in order, material tag, embeds, unlink removes an empty day", () => {
	let r = appendRecord("---\ntype: flywheel-record\n---\n# 몸 만들기 기록 2026-01\n", "2026-01-09", "아침에 걸으니 저녁에 덜 피곤하다 #재료");
	r = appendRecord(r, "2026-01-07", "비 와서 실내 자전거 20분");
	r = appendRecord(r, "2026-01-09", "- ![[04 Daily Pad/2026/2026-01-09#^fw-1]]");
	assert.ok(r.indexOf("### 2026-01-07") < r.indexOf("### 2026-01-09"));
	const days = parseRecord(r);
	assert.deepEqual(days.map((d) => [d.date, d.lines.length]), [["2026-01-07", 1], ["2026-01-09", 2]]);
	assert.equal(days[1].lines[0].material, true);
	assert.equal(days[1].lines[0].text, "아침에 걸으니 저녁에 덜 피곤하다");
	assert.equal(days[1].lines[1].embed, "04 Daily Pad/2026/2026-01-09#^fw-1");
	const mats = materialsOf({ id: "F-1", name: "몸 만들기", folder: `${ROOT}/몸 만들기` }, days, "2026-01");
	assert.deepEqual(mats.map((m) => m.anchor), ["몸 만들기 기록 2026-01#2026-01-09"]);
	const off = toggleMaterial(r, days[1].lines[0].raw);
	assert.equal(parseRecord(off)[1].lines[0].material, false);
	const one = appendRecord("# x\n", "2026-01-10", "- ![[pad#^fw-2]]");
	assert.ok(!removeRecordEmbed(one, "2026-01-10", "pad#^fw-2").includes("### 2026-01-10"), "empty day heading goes too");
	assert.ok(removeRecordEmbed(r, "2026-01-09", "04 Daily Pad/2026/2026-01-09#^fw-1").includes("### 2026-01-09\n- 아침에"));
});

test("evidence lines: set/replace/remove; source of a check", () => {
	const t = "| 날짜 | F-1 | 합 |\n|---|---|---|\n| 09 | x | 1/1 |\n";
	let a = setEvidence(t, "2026-01-09", "F-1", "사용자 보고 (루미 21:32) “점심에 20분 걸었어”");
	a = setEvidence(a, "2026-01-09", "F-2", "Vision Board 확언 끝까지 (07:02)");
	a = setEvidence(a, "2026-01-09", "F-1", "사용자 보고 (체크인 21:40)");
	const ev = parseEvidence(a);
	assert.equal(ev.get("2026-01-09|F-1"), "사용자 보고 (체크인 21:40)");
	assert.equal(ev.size, 2);
	assert.ok(a.startsWith(t.trimEnd()), "the table is untouched");
	assert.equal(parseEvidence(setEvidence(a, "2026-01-09", "F-1", null)).size, 1);
	assert.equal(sourceOf("x", undefined), "me");
	assert.equal(sourceOf("x", ev.get("2026-01-09|F-1")), "agent");
	assert.equal(sourceOf("x", ev.get("2026-01-09|F-2")), "vision");
	assert.equal(sourceOf("x", "사용자 수정 (2026-01-10 09:00)"), "fix");
	assert.equal(sourceOf("-", undefined), "none");
	assert.equal(sourceOf("쉼", undefined), "rest");
});

test("files: records, posts per channel, weekly, channel docs, outputs, 작업실", () => {
	const F = `${ROOT}/글쓰기`;
	const files = classifyFiles(
		[
			`${F}/글쓰기.md`,
			`${F}/01 기록/글쓰기 기록 2026-01.md`,
			`${F}/02 산출물/2026-01-09 독서 노트 아주 작은 습관.md`,
			`${F}/02 산출물/인스타그램/2026-01-12 아침 산책 30일.md`,
			`${F}/02 산출물/인스타그램/채널 전략.md`,
			`${F}/02 산출물/인스타그램/주간/2026-01-12 주간 기획.md`,
			`${F}/99 작업실/20 지식/릴스 첫 3초.md`,
			`${ROOT}/글쓰기2/02 산출물/다른 요소.md`,
		],
		F,
	);
	const by = (k: string) => files.filter((f) => f.kind === k).map((f) => `${f.channel}|${f.title}`);
	assert.deepEqual(by("record"), ["|글쓰기 기록 2026-01"]);
	assert.deepEqual(by("post"), ["인스타그램|아침 산책 30일"]);
	assert.deepEqual(by("output"), ["|독서 노트 아주 작은 습관"]);
	assert.deepEqual(by("doc"), ["인스타그램|채널 전략"]);
	assert.deepEqual(by("weekly"), ["인스타그램|주간 기획"]);
	assert.deepEqual(files.filter((f) => f.kind === "work").map((f) => f.group), ["20 지식"]);
	assert.equal(anchorKey("[[12 Flywheel/몸 만들기/01 기록/몸 만들기 기록 2026-01#2026-01-09|산책]]"), "몸 만들기 기록 2026-01#2026-01-09");
});

test("memo link: field + block id, merge, unlink keeps the memo text", () => {
	const line = "- 점심 먹고 20분 걸었다 #건강";
	const a = linkMemoLine(line, "몸 만들기 기록 2026-01#2026-01-14", nextBlockId("- x ^fw-1\n"));
	assert.equal(a, "- 점심 먹고 20분 걸었다 (record:: [[몸 만들기 기록 2026-01#2026-01-14]]) #건강 ^fw-2");
	const b = linkMemoLine(a, "글쓰기 기록 2026-01#2026-01-14", "fw-9");
	assert.deepEqual(recordLinksOf(b), ["몸 만들기 기록 2026-01#2026-01-14", "글쓰기 기록 2026-01#2026-01-14"]);
	assert.ok(b.endsWith(" ^fw-2"), "keeps its block id");
	const c = unlinkMemoLine(b, "몸 만들기 기록 2026-01#2026-01-14");
	assert.deepEqual(recordLinksOf(c), ["글쓰기 기록 2026-01#2026-01-14"]);
	assert.equal(unlinkMemoLine(c, "글쓰기 기록 2026-01#2026-01-14"), line);
});

function reader(files: Record<string, string>) {
	return { read: async (p: string) => files[p] ?? null };
}

test("store: read the wheel, plan a change (hub + registry + change log), new element, a day, a record", async () => {
	const files: Record<string, string> = { [`${ROOT}/Flywheel.md`]: REG, [`${ROOT}/몸 만들기/몸 만들기.md`]: HUB };
	const io = reader(files);
	const w = await readWheel(io, ROOT);
	assert.equal(w.registry, true);
	assert.deepEqual(w.elements.map((e) => [e.name, e.hasHub]), [["몸 만들기", true], ["글쓰기", false]]);
	const e = w.elements[0];
	const writes = await planElementChange(io, w, e, "F-1 쉼", "2026-01-10", { hub: (t) => setHubFm(t, "status", "쉼", "2026-01-10") });
	assert.deepEqual(writes.map((x) => x.path), [`${ROOT}/몸 만들기/몸 만들기.md`, `${ROOT}/Flywheel.md`]);
	const reg = writes[1].after;
	assert.equal(parseRegistry(reg)[0].status, "쉼");
	assert.ok(reg.includes("- 2026-01-10: F-1 쉼 (플러그인)\n- 2026-01-01: 바퀴 세움"));
	assert.equal(getFmValue(reg, "elements"), "2");

	const n = await planNewElement(io, w, { name: "책 읽기", identity: "나는 매일 읽는 사람이다", min: "2쪽", normal: "한 챕터", next: "", since: "2026-01-11" }, "2026-01-10");
	assert.equal(n.id, "F-3");
	assert.deepEqual(n.writes.map((x) => [x.path, x.before === null]), [[`${ROOT}/책 읽기/책 읽기.md`, true], [`${ROOT}/Flywheel.md`, false]]);
	assert.ok(n.writes[1].after.includes("요소 교체: F-3 책 읽기 추가"));
	await assert.rejects(planNewElement(io, w, { name: "몸 만들기", identity: "", min: "x", normal: "", next: "", since: "2026-01-11" }, "2026-01-10"));

	const day = await planDay(io, w, e, "2026-01-09", "x", "사용자 보고 (체크인 21:30)");
	assert.equal(day.write.path, `${ROOT}/99 작업실/수행/2026-01.md`);
	assert.ok(day.write.after.includes("| 09 | x |"));
	assert.ok(day.write.after.includes("- 2026-01-09 F-1: 사용자 보고 (체크인 21:30)"));
	const rec = await planRecord(io, e, "2026-01-09", "점심 먹고 20분");
	assert.equal(rec.write.path, `${ROOT}/몸 만들기/01 기록/몸 만들기 기록 2026-01.md`);
	assert.ok(rec.write.after.startsWith("---\ntype: flywheel-record\nelement: F-1\nmonth: 2026-01\n---\n# 몸 만들기 기록 2026-01\n"));
	assert.ok(rec.write.after.includes("### 2026-01-09\n- 점심 먹고 20분\n"));
});

test("store: the old one-file Flywheel.md is read but not written", async () => {
	const io = reader({ [`${ROOT}/Flywheel.md`]: "# Flywheel\n\n## F-1 몸 만들기\n- 최소:: 걷기\n- goal:: G-2026-02.1\n- status:: 사용\n" });
	const w = await readWheel(io, ROOT);
	assert.equal(w.registry, false);
	assert.deepEqual(w.elements[0].goals, ["G-2026-02.1"]);
	await assert.rejects(planElementChange(io, w, w.elements[0], "x", "2026-01-10", {}));
});

test("hub cover: quoted wikilink, embed, alias and bare path all resolve to the target", async () => {
	const { coverTarget, coverValue, elementOf } = await import("../src/flywheel/wheel.ts");
	assert.equal(coverTarget('[[12 Flywheel/99 작업실/images/운동.jpg]]'), "12 Flywheel/99 작업실/images/운동.jpg");
	assert.equal(coverTarget("![[운동.jpg|커버]]"), "운동.jpg");
	assert.equal(coverTarget("images/운동.jpg"), "images/운동.jpg");
	assert.equal(coverTarget(""), "");
	assert.equal(coverValue("a/b.jpg"), '"[[a/b.jpg]]"');
	const hub = '---\ntype: flywheel-element\nid: F-1\ntitle: 운동\nstatus: 사용\ncover: "[[12 Flywheel/99 작업실/images/운동.jpg]]"\n---\n# 운동\n';
	assert.equal(elementOf(null, hub, "12 Flywheel/운동/운동.md").cover, "12 Flywheel/99 작업실/images/운동.jpg");
});
