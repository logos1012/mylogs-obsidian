import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import { hubLocation, parseProject, type Project } from "../src/projects/model.ts";
import { getFmList, parseRegistry, setFmList, upsertActiveRow } from "../src/projects/ops.ts";
import {
	applyHubEdit,
	goalIdProblems,
	goalUnlinkTexts,
	hubWithoutGoals,
	parseGoalIds,
	planProjectEdit,
	type ProjectEdit,
	removeRegistryRow,
	renameInProjectText,
	setActionText,
} from "../src/projects/edit.ts";
import { fillAgents } from "../src/projects/create.ts";
import { newLogIndex } from "../src/projects/ops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/projects", p), "utf8");
const HUB = fx("vault/hub-active.md");
const REG = fx("vault/registry-filled.md");
const TODAY = "2026-10-25";
const ROOT = "05 Project Folders";

function active(): Project {
	const path = `${ROOT}/개인/혼팀 브랜드/혼팀 브랜드.md`;
	const { data, body } = parseFrontmatterText(HUB);
	return parseProject(data, body, hubLocation(path, ROOT, "10 Archive Box/Projects")!, path)!;
}

const same = (p: Project): ProjectEdit => ({
	name: p.title,
	aliases: "혼팀",
	summary: p.summary,
	scope: "개인",
	area: p.area,
	kind: p.kind,
	action: p.action,
	goals: p.goals.join(", "),
});

test("plan: nothing changed → no changes, no moves", () => {
	const p = active();
	const plan = planProjectEdit(p, same(p), { activeRoot: ROOT, today: TODAY, registryAliases: "혼팀", monthlyLogs: [] });
	assert.deepEqual(plan.changes, []);
	assert.equal(plan.folder, null);
	assert.deepEqual(plan.files, []);
	// the untouched draft action keeps its (AI 초안) mark in the registry
	assert.equal(plan.registry.action, "인스타그램 릴스 3개 기획안 쓰기 (AI 초안)");
});

test("plan: rename + 개인 → 회사 moves the folder and renames the project files", () => {
	const p = active();
	const plan = planProjectEdit(
		p,
		{ ...same(p), name: "혼팀 스튜디오", scope: "회사", aliases: "혼팀, 스튜디오", goals: "G-2026-03.1, G-2026-01.2" },
		{ activeRoot: ROOT, today: TODAY, registryAliases: "혼팀", monthlyLogs: ["혼팀 브랜드 로그 2026-09.md", "혼팀 브랜드 로그 2026-10.md", "메모.md"] },
	);
	assert.deepEqual(plan.folder, { from: `${ROOT}/개인/혼팀 브랜드`, to: `${ROOT}/회사/혼팀 스튜디오` });
	const nf = `${ROOT}/회사/혼팀 스튜디오`;
	assert.deepEqual(plan.files, [
		{ from: `${nf}/혼팀 브랜드.md`, to: `${nf}/혼팀 스튜디오.md` },
		{ from: `${nf}/99 작업실/혼팀 브랜드 로그.md`, to: `${nf}/99 작업실/혼팀 스튜디오 로그.md` },
		{ from: `${nf}/99 작업실/로그/혼팀 브랜드 로그 2026-09.md`, to: `${nf}/99 작업실/로그/혼팀 스튜디오 로그 2026-09.md` },
		{ from: `${nf}/99 작업실/로그/혼팀 브랜드 로그 2026-10.md`, to: `${nf}/99 작업실/로그/혼팀 스튜디오 로그 2026-10.md` },
	]);
	assert.deepEqual(plan.goalsAdded, ["G-2026-01.2"]);
	assert.deepEqual(plan.goalsRemoved, []);
	assert.equal(plan.hubLinkNew, `${nf}/혼팀 스튜디오`);
	assert.match(plan.change, /^P-honteam 수정: 이름 「혼팀 브랜드」 → 「혼팀 스튜디오」, 별칭 혼팀 → 혼팀, 스튜디오, 개인 → 회사, 목표 G-2026-03\.1 → G-2026-03\.1, G-2026-01\.2, 경로 05 Project Folders\/회사\/혼팀 스튜디오 \(플러그인\)$/);
	assert.match(plan.hub.decision!, /이름을 「혼팀 스튜디오」\(으\)로 바꾼다\. 회사 프로젝트로 옮긴다/);

	// registry row: every edited cell, path, 갱신; other cells as written
	const r = upsertActiveRow(REG, plan.registry);
	assert.ok(r.ok);
	const row = parseRegistry(r.text).active.find((x) => x.id === "P-honteam")!;
	assert.deepEqual(row, {
		id: "P-honteam",
		name: "혼팀 스튜디오",
		aliases: "혼팀, 스튜디오",
		scope: "회사",
		area: "브랜드",
		kind: "콘텐츠 제작",
		status: "진행",
		action: "인스타그램 릴스 3개 기획안 쓰기 (AI 초안)",
		goals: "G-2026-03.1, G-2026-01.2",
		path: nf,
		updated: TODAY,
	});
});

test("hub edit: fields, H1, summary, action (checkbox kept, draft dropped), goals list, decision", () => {
	const p = active();
	const plan = planProjectEdit(
		p,
		{ ...same(p), name: "혼팀 스튜디오", area: "사업", summary: "혼팀을 AI 스튜디오로 키운다.", action: "릴스 3개 기획안 쓰기", goals: "" },
		{ activeRoot: ROOT, today: TODAY, registryAliases: "혼팀", monthlyLogs: [] },
	);
	const out = applyHubEdit(HUB.replace("- [ ] 인스타그램", "- [x] 인스타그램"), plan.hub);
	assert.match(out, /^title: 혼팀 스튜디오$/m);
	assert.match(out, /^area: 사업$/m);
	assert.match(out, /^goals: \[\]$/m);
	assert.ok(!out.includes("  - G-2026-03.1"));
	assert.match(out, /^# 혼팀 스튜디오$/m);
	assert.match(out, /## 한 문장 설명\n혼팀을 AI 스튜디오로 키운다\.\n\n## 지금 가장 효과적인 한 가지 행동\n- \[x\] 릴스 3개 기획안 쓰기\n/);
	assert.match(out, new RegExp(`^updated: ${TODAY}$`, "m"));
	assert.match(out, new RegExp(`- ${TODAY} — 프로젝트 이름을 「혼팀 스튜디오」\\(으\\)로 바꾼다\\. 사용자 결정\\n?$`));
	// untouched parts are byte-identical
	assert.ok(out.includes("## 목표\n- 미확인\n\n## 성공 기준\n- 미확인"));
	assert.ok(out.includes('cover: "99 작업실/cover.png"'));
	assert.equal(plan.registry.action, "릴스 3개 기획안 쓰기");
	assert.deepEqual(plan.goalsRemoved, ["G-2026-03.1"]);
});

test("rename inside the current-state files (AGENTS.md, log index); other words stay", () => {
	const agents = fillAgents(fx("템플릿/AGENTS.md"), { name: "혼팀 브랜드", id: "P-honteam", kind: "콘텐츠 제작", scope: "개인", area: "브랜드", summary: "", aliases: "", action: "" }, "2026-10", "2026-10-01");
	const out = renameInProjectText(agents, "혼팀 브랜드", "혼팀 스튜디오");
	assert.ok(!out.includes("혼팀 브랜드"), out);
	assert.ok(out.includes('hub: "혼팀 스튜디오.md"'));
	assert.ok(out.includes("[[혼팀 스튜디오]]"));
	assert.ok(out.includes("99 작업실/로그/혼팀 스튜디오 로그 2026-10.md"));
	const idx = newLogIndex(fx("템플릿/로그 인덱스.md"), { name: "혼팀 브랜드", ym: "2026-10", today: "2026-10-01", recent: "혼팀 브랜드 기획 시작" });
	const out2 = renameInProjectText(idx, "혼팀 브랜드", "혼팀 스튜디오");
	assert.ok(out2.includes("[[혼팀 스튜디오 로그 2026-10]]"));
	assert.ok(out2.includes("# 혼팀 스튜디오 로그"));
	// a recent-work line that merely mentions the name in prose is history; it is left alone
	assert.ok(out2.includes("혼팀 브랜드 기획 시작"));
});

test("setActionText keeps the checkbox; adds a line when the section is empty", () => {
	assert.match(setActionText(HUB, "새 행동"), /## 지금 가장 효과적인 한 가지 행동\n- \[ \] 새 행동\n/);
	const empty = HUB.replace("- [ ] 인스타그램 릴스 3개 기획안 쓰기 (AI 초안)\n", "");
	assert.match(setActionText(empty, "새 행동"), /## 지금 가장 효과적인 한 가지 행동\n- \[ \] 새 행동\n/);
});

test("registry: remove a row (either table); goal unlink on the hub", () => {
	const r = removeRegistryRow(REG, "P-other");
	assert.ok(r.removed);
	assert.equal(r.text, REG.replace(/\| P-other \|[^\n]*\n/, ""));
	assert.equal(removeRegistryRow(REG, "P-none").removed, false);

	const h = hubWithoutGoals(HUB, ["G-2026-03.1"], TODAY);
	assert.deepEqual(getFmList(h, "goals"), []);
	assert.match(h, /^goals: \[\]$/m);
	assert.match(h, new RegExp(`^updated: ${TODAY}$`, "m"));
	assert.equal(hubWithoutGoals(HUB, ["G-2026-09.9"], TODAY), HUB);
	const t = goalUnlinkTexts(active(), ["G-2026-03.1"], TODAY);
	assert.equal(t.change, "P-honteam 목표 G-2026-03.1 연결 해제 (목표 삭제) (플러그인)");
});

test("goal ids: parse and check", () => {
	assert.deepEqual(parseGoalIds("G-2026-03.1, G-2026-01.2 G-2026-03.1"), ["G-2026-03.1", "G-2026-01.2"]);
	assert.deepEqual(goalIdProblems(["G-2026-03.1", "x"], null), ["목표 id 형식이 아니에요: x (예: G-2026-03.1)"]);
	assert.deepEqual(goalIdProblems(["G-2026-09.1"], ["G-2026-03.1"]), ["Pinboard에 없는 목표 id예요: G-2026-09.1"]);
});

test("frontmatter lists: block and inline, add and clear", () => {
	assert.deepEqual(getFmList(HUB, "goals"), ["G-2026-03.1"]);
	const two = setFmList(HUB, "goals", ["G-2026-03.1", "G-2026-01.2"]);
	assert.match(two, /^goals:\n {2}- G-2026-03\.1\n {2}- G-2026-01\.2\nupdated:/m);
	assert.deepEqual(getFmList("---\na: [x, \"[[y/z]]\"]\n---\n", "a"), ["x", "[[y/z]]"]);
	assert.equal(setFmList(HUB, "goals", ["G-2026-03.1"]), HUB);
});
