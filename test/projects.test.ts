import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import {
	buildKanban,
	groupByArea,
	hubLocation,
	isStale,
	parseProject,
	type Project,
	suggestId,
	timelineBars,
	timelineYears,
	validateInput,
	type NewProjectInput,
} from "../src/projects/model.ts";
import {
	activeRowOf,
	appendLogEntry,
	applyHubChange,
	formatLogEntry,
	getFmValue,
	logRegistryChange,
	moveRowToDone,
	newMonthlyLog,
	parseRegistry,
	setFmValue,
	statusChangeTexts,
	updateLogIndex,
	withRo,
	updateProjectAgents,
	upsertActiveRow,
} from "../src/projects/ops.ts";
import { leftoverPlaceholders, planNewProject, type Templates } from "../src/projects/create.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/projects", p), "utf8");
const templates: Templates = {
	hub: fx("템플릿/허브.md"),
	agents: fx("템플릿/AGENTS.md"),
	logIndex: fx("템플릿/로그 인덱스.md"),
	monthlyLog: fx("템플릿/월별 로그.md"),
};
const ACTIVE = "05 Project Folders";
const ARCHIVE = "10 Archive Box/Projects";

function load(file: string, path: string): Project {
	const { data, body } = parseFrontmatterText(fx(file));
	const loc = hubLocation(path, ACTIVE, ARCHIVE);
	assert.ok(loc, path);
	const p = parseProject(data, body, loc, path);
	assert.ok(p, path);
	return p;
}

const active = () => load("vault/hub-active.md", "05 Project Folders/개인/혼팀 브랜드/혼팀 브랜드.md");
const done = () => load("vault/hub-done.md", "10 Archive Box/Projects/회사/연말 보고서/연말 보고서.md");

/** Lines that differ between two texts (same line count expected unless `allowGrow`). */
function changedLines(a: string, b: string): [string, string][] {
	const x = a.split("\n");
	const y = b.split("\n");
	const out: [string, string][] = [];
	for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) out.push([x[i], y[i]]);
	return out;
}

// ───────────────────────── paths & hub parsing ─────────────────────────

test("hubLocation: only <root>/<개인|회사>/<name>/<file>.md", () => {
	assert.deepEqual(hubLocation("05 Project Folders/개인/혼팀/혼팀.md", ACTIVE, ARCHIVE), {
		scope: "개인",
		folder: "05 Project Folders/개인/혼팀",
		name: "혼팀",
		archived: false,
	});
	assert.equal(hubLocation("10 Archive Box/Projects/회사/A/A.md", ACTIVE, ARCHIVE)?.archived, true);
	assert.equal(hubLocation("05 Project Folders/99 작업실/Project Folders Index.md", ACTIVE, ARCHIVE), null);
	assert.equal(hubLocation("05 Project Folders/개인/혼팀/99 작업실/혼팀 로그.md", ACTIVE, ARCHIVE), null);
	assert.equal(hubLocation("05 Project Folders/기타/혼팀/혼팀.md", ACTIVE, ARCHIVE), null);
	assert.equal(hubLocation("05 Project Folders/AGENTS.md", ACTIVE, ARCHIVE), null);
});

test("parseProject: frontmatter, action (AI 초안 flag), summary, goals", () => {
	const p = active();
	assert.equal(p.id, "P-honteam");
	assert.equal(p.title, "혼팀 브랜드");
	assert.equal(p.scope, "개인");
	assert.equal(p.area, "브랜드");
	assert.equal(p.kind, "콘텐츠 제작");
	assert.equal(p.status, "진행");
	assert.equal(p.started, "2026-09-01");
	assert.equal(p.completed, "");
	assert.equal(p.cover, "99 작업실/cover.png");
	assert.deepEqual(p.goals, ["G-2026-03.1"]);
	assert.equal(p.updated, "2026-10-01");
	assert.equal(p.action, "인스타그램 릴스 3개 기획안 쓰기");
	assert.equal(p.actionDraft, true);
	assert.equal(p.summary, "혼팀 브랜드를 AI 콘텐츠로 키운다.");
	assert.equal(p.archived, false);

	const d = done();
	assert.equal(d.archived, true);
	assert.equal(d.result, "보고서 제출, 승인받음");
	assert.equal(d.actionDone, true);
	assert.deepEqual(d.goals, []);
});

test("parseProject: not a hub → null", () => {
	const loc = hubLocation("05 Project Folders/개인/A/AGENTS.md", ACTIVE, ARCHIVE)!;
	assert.equal(parseProject({ type: "project-operator-contract" }, "", loc, "x"), null);
	assert.equal(parseProject(null, "", loc, "x"), null);
});

// ───────────────────────── staleness ─────────────────────────

test("isStale: 진행 and more than 14 days since updated", () => {
	const p = { status: "진행", updated: "2026-10-01", started: "2026-09-01" };
	assert.equal(isStale(p, "2026-10-15"), false); // exactly 14 days
	assert.equal(isStale(p, "2026-10-16"), true); // 15 days
	assert.equal(isStale({ ...p, status: "대기" }, "2026-12-01"), false);
	assert.equal(isStale({ ...p, updated: "" }, "2026-09-20"), true); // falls back to started
	assert.equal(isStale({ status: "진행", updated: "", started: "" }, "2026-12-01"), false);
});

// ───────────────────────── board ─────────────────────────

function mk(over: Partial<Project>): Project {
	return { ...active(), ...over };
}

test("buildKanban: status columns, 완료 shows latest 3, scope filter", () => {
	const ps = [
		mk({ id: "a", status: "후보", updated: "2026-10-02" }),
		mk({ id: "b", status: "진행", updated: "2026-10-03" }),
		mk({ id: "c", status: "이상한값" }),
		mk({ id: "d", status: "보류", scope: "회사" }),
		...[1, 2, 3, 4, 5].map((n) => mk({ id: `done${n}`, status: "완료", archived: true, completed: `2026-0${n}-10` })),
	];
	const cols = buildKanban(ps);
	assert.deepEqual(
		cols.map((c) => c.status),
		["후보", "진행", "대기", "보류", "완료"],
	);
	assert.deepEqual(
		cols[0].cards.map((c) => c.id),
		["a", "c"],
	);
	const doneCol = cols[4];
	assert.equal(doneCol.total, 5);
	assert.deepEqual(
		doneCol.cards.map((c) => c.id),
		["done5", "done4", "done3"],
	);
	const company = buildKanban(ps, "회사");
	assert.deepEqual(
		company.flatMap((c) => c.cards.map((x) => x.id)),
		["d"],
	);
});

test("groupByArea: area groups, 기타 last, order respected", () => {
	const ps = [mk({ id: "a", area: "사업" }), mk({ id: "b", area: "" }), mk({ id: "c", area: "건강" }), mk({ id: "d", area: "브랜드" })];
	assert.deepEqual(
		groupByArea(ps, "전체", ["브랜드", "사업"]).map((g) => g.area),
		["브랜드", "사업", "건강", "기타"],
	);
});

test("timeline: bars and years", () => {
	const d = done();
	const span = mk({ id: "x", archived: true, status: "완료", started: "2025-11-15", completed: "2026-02-28" });
	assert.deepEqual(timelineYears([d, span, active()]), [2025, 2026]);
	const bars = timelineBars([d, span], 2026);
	assert.equal(bars.length, 2);
	assert.equal(bars[0].project.id, "x");
	assert.equal(bars[0].from, 0);
	assert.equal(bars[0].clippedStart, true);
	assert.equal(bars[0].to, 2); // through the end of Feb
	const r = bars[1];
	assert.ok(Math.abs(r.from - (2 + 9 / 31)) < 1e-9); // Mar 10
	assert.ok(Math.abs(r.to - (4 + 20 / 31)) < 1e-9); // through May 20
	assert.equal(timelineBars([d], 2025).length, 0);
});

// ───────────────────────── frontmatter helpers ─────────────────────────

test("setFmValue keeps trailing comments; getFmValue strips quotes/comments", () => {
	const t = `---\nlatest_log: "99 작업실/로그/A 로그 YYYY-MM.md"   # 프로젝트 폴더 기준\nupdated:\n---\nbody\n`;
	assert.equal(getFmValue(t, "latest_log"), "99 작업실/로그/A 로그 YYYY-MM.md");
	const out = setFmValue(t, "latest_log", `"99 작업실/로그/A 로그 2026-10.md"`);
	assert.equal(out.split("\n")[1], `latest_log: "99 작업실/로그/A 로그 2026-10.md"   # 프로젝트 폴더 기준`);
	assert.equal(setFmValue(t, "updated", "2026-10-24").split("\n")[2], "updated: 2026-10-24");
});

// ───────────────────────── status-change writes ─────────────────────────

test("applyHubChange: status, updated, 주요 결정; nothing else changes", () => {
	const src = fx("vault/hub-active.md");
	const out = applyHubChange(src, { today: "2026-10-24", status: "대기", decision: "상태를 진행에서 대기(으)로 바꾼다. 사용자 결정" });
	const changes = changedLines(src, out);
	assert.deepEqual(changes.slice(0, 2), [
		["status: 진행", "status: 대기"],
		["updated: 2026-10-01", "updated: 2026-10-24"],
	]);
	assert.ok(out.endsWith("<!-- - YYYY-MM-DD — 결정. 이유 -->\n- 2026-10-24 — 상태를 진행에서 대기(으)로 바꾼다. 사용자 결정\n"));
	assert.equal(getFmValue(out, "started"), "2026-09-01");
});

test("applyHubChange: 진행 sets started only when empty", () => {
	const src = fx("vault/hub-active.md").replace("status: 진행", "status: 후보").replace("started: 2026-09-01", "started:");
	const out = applyHubChange(src, { today: "2026-10-24", status: "진행" });
	assert.equal(getFmValue(out, "started"), "2026-10-24");
	const again = applyHubChange(out, { today: "2026-11-02", status: "진행" });
	assert.equal(getFmValue(again, "started"), "2026-10-24");
});

test("applyHubChange: 완료 sets completed and the 한 줄 결과 in 현재 상태", () => {
	const src = fx("vault/hub-active.md");
	const out = applyHubChange(src, { today: "2026-10-24", status: "완료", completed: "2026-10-24", result: "릴스 30개 발행" });
	assert.equal(getFmValue(out, "status"), "완료");
	assert.equal(getFmValue(out, "completed"), "2026-10-24");
	assert.match(out, /## 현재 상태\n- \*\*단계:\*\* 기획\n- \*\*결과:\*\* 릴스 30개 발행\n\n## 다음 액션/);
	// a second result replaces the line
	const again = applyHubChange(out, { today: "2026-10-24", result: "수정된 결과" });
	assert.equal((again.match(/\*\*결과:\*\*/g) ?? []).length, 1);
});

test("monthly log: entry format, append, new file from template", () => {
	const p = active();
	const t = statusChangeTexts(p, "대기", "2026-10-24");
	const entry = formatLogEntry(t.entry);
	assert.equal(
		entry,
		[
			"## 2026-10-24 — 상태 변경: 진행 → 대기",
			"",
			"- **맥락:** MyLogs Project Folders 화면에서 사용자가 상태를 바꿈",
			"- **수행:** 허브 `status`를 대기로 변경",
			"- **결과:** status: 대기",
			"- **결정:** 상태를 진행에서 대기로 바꾼다. 사용자 결정",
			"- **미해결:** 없음",
			"- **다음:** 인스타그램 릴스 3개 기획안 쓰기 (AI 초안)",
			"- **근거:** MyLogs 플러그인, 사용자 조작",
		].join("\n"),
	);
	const file = newMonthlyLog(templates.monthlyLog, "혼팀 브랜드", "2026-10", entry);
	assert.ok(file.startsWith('---\ntype: project-log\nproject: "혼팀 브랜드"\nmonth: 2026-10\n---\n\n# 혼팀 브랜드 로그 2026-10\n\n## 2026-10-24 — 상태 변경'));
	assert.equal(file.match(/^## /gm)?.length, 1);
	assert.deepEqual(leftoverPlaceholders(file), []);
	const appended = appendLogEntry(file, "## 2026-10-25 — 다음");
	assert.ok(appended.endsWith("사용자 조작\n\n## 2026-10-25 — 다음\n"));
});

test("withRo: Korean particle", () => {
	assert.equal(withRo("진행"), "진행으로");
	assert.equal(withRo("대기"), "대기로");
	assert.equal(withRo("보류"), "보류로");
	assert.equal(withRo("완료"), "완료로");
	assert.equal(withRo("후보"), "후보로");
});

test("updateLogIndex: latest_log (comment kept), updated, 최근 작업, 기간별 로그", () => {
	const filled = templates.logIndex.split("{{프로젝트명}}").join("혼팀").replace(/YYYY-MM/g, "2026-09");
	const out = updateLogIndex(filled, { name: "혼팀", ym: "2026-10", today: "2026-10-24", recent: "상태 변경: 진행 → 대기" });
	assert.match(out, /^latest_log: "99 작업실\/로그\/혼팀 로그 2026-10.md"   # 프로젝트 폴더 기준$/m);
	assert.match(out, /^updated: 2026-10-24$/m);
	assert.match(out, /## 최근 작업\n- 2026-10-24: 상태 변경: 진행 → 대기\n\n## 기간별 로그\n- \[\[혼팀 로그 2026-09\]\]\n- \[\[혼팀 로그 2026-10\]\]\n$/);
	const twice = updateLogIndex(out, { name: "혼팀", ym: "2026-10", today: "2026-10-25", recent: "다음 일" });
	assert.match(twice, /## 최근 작업\n- 2026-10-25: 다음 일\n- 2026-10-24: 상태 변경: 진행 → 대기\n/);
	assert.equal(twice.match(/혼팀 로그 2026-10\]\]/g)?.length, 1);
});

test("updateProjectAgents: latest_log and 문서 지도 follow the new month", () => {
	const src = templates.agents.split("{{프로젝트명}}").join("혼팀").replace(/YYYY-MM/g, "2026-09");
	const out = updateProjectAgents(src, { name: "혼팀", ym: "2026-10", today: "2026-10-24" });
	assert.match(out, /^latest_log: "99 작업실\/로그\/혼팀 로그 2026-10.md"$/m);
	assert.match(out, /최신 월별 로그: `99 작업실\/로그\/혼팀 로그 2026-10.md`/);
	assert.equal(updateProjectAgents(out, { name: "혼팀", ym: "2026-10", today: "2026-10-30" }), out);
});

// ───────────────────────── registry ─────────────────────────

test("parseRegistry: both tables (empty real registry and filled fixture)", () => {
	assert.deepEqual(parseRegistry(fx("Project Folders Index.md")), { active: [], done: [] });
	const r = parseRegistry(fx("vault/registry-filled.md"));
	assert.equal(r.active.length, 2);
	assert.equal(r.active[0].id, "P-honteam");
	assert.equal(r.active[0].aliases, "혼팀");
	assert.equal(r.active[1].path, "05 Project Folders/회사/다른 일");
});

test("upsertActiveRow: updates only the given cells of that row", () => {
	const src = fx("vault/registry-filled.md");
	const r = upsertActiveRow(src, { id: "P-honteam", status: "대기", updated: "2026-10-24" });
	assert.ok(r.ok && !r.added);
	const ch = changedLines(src, r.text);
	assert.equal(ch.length, 1);
	assert.equal(
		ch[0][1],
		"| P-honteam | 혼팀 브랜드 | 혼팀 | 개인 | 브랜드 | 콘텐츠 제작 | 대기 | 인스타그램 릴스 3개 기획안 쓰기 (AI 초안) | G-2026-03.1 | 05 Project Folders/개인/혼팀 브랜드 | 2026-10-24 |",
	);
});

test("upsertActiveRow: adds a missing row (empty real registry) and escapes pipes", () => {
	const src = fx("Project Folders Index.md");
	const p = active();
	const row = { ...activeRowOf(p, "혼팀"), action: "A | B" };
	const r = upsertActiveRow(src, { id: p.id }, row);
	assert.ok(r.ok && r.added);
	assert.match(
		r.text,
		/\|---\|---\|---\|---\|---\|---\|---\|---\|---\|---\|---\|\n\| P-honteam \| 혼팀 브랜드 \| 혼팀 \| 개인 \| 브랜드 \| 콘텐츠 제작 \| 진행 \| A \\\| B \| G-2026-03\.1 \| 05 Project Folders\/개인\/혼팀 브랜드 \| 2026-10-01 \|\n\n## 완료/,
	);
	assert.equal(parseRegistry(r.text).active[0].action, "A | B");
});

test("moveRowToDone + logRegistryChange: row moves to 완료 with new path", () => {
	const src = fx("vault/registry-filled.md");
	const r = moveRowToDone(src, {
		id: "P-honteam",
		name: "혼팀 브랜드",
		scope: "개인",
		started: "2026-09-01",
		completed: "2026-10-24",
		result: "릴스 30개 발행",
		path: "10 Archive Box/Projects/개인/혼팀 브랜드",
	});
	assert.ok(r.ok);
	const out = logRegistryChange(r.text, "2026-10-24", "P-honteam 상태 진행 → 완료 (플러그인)");
	const reg = parseRegistry(out);
	assert.deepEqual(
		reg.active.map((a) => a.id),
		["P-other"],
	);
	assert.deepEqual(reg.done, [
		{ id: "P-honteam", name: "혼팀 브랜드", scope: "개인", started: "2026-09-01", completed: "2026-10-24", result: "릴스 30개 발행", path: "10 Archive Box/Projects/개인/혼팀 브랜드" },
	]);
	assert.match(out, /^updated: 2026-10-24$/m);
	assert.match(out, /## 변경 기록\n\n- 2026-10-24: P-honteam 상태 진행 → 완료 \(플러그인\)\n- 2026-10-01: 혼팀 브랜드 추가\./);
});

// ───────────────────────── new project ─────────────────────────

const input: NewProjectInput = {
	name: "혼팀 브랜드",
	summary: "혼팀 브랜드를 AI 콘텐츠로 키운다.",
	scope: "개인",
	area: "브랜드",
	kind: "콘텐츠 제작",
	id: "P-honteam",
	aliases: "혼팀,  honteam ",
	action: "",
};

test("validateInput / suggestId", () => {
	assert.deepEqual(validateInput(input, { ids: [], names: [] }), []);
	assert.equal(validateInput({ ...input, id: "P-" }, { ids: [], names: [] }).length, 1);
	assert.equal(validateInput({ ...input, name: "a/b" }, { ids: [], names: [] }).length, 1);
	assert.equal(validateInput(input, { ids: ["P-honteam"], names: ["혼팀 브랜드"] }).length, 2);
	assert.equal(suggestId("Claude Code 강의"), "P-claude-code");
	assert.equal(suggestId("혼팀"), "P-");
});

test("planNewProject: minimal-visible layout, filled templates, registry row", () => {
	const plan = planNewProject(input, templates, { activeRoot: "05 Project Folders", today: "2026-10-24" });
	const f = "05 Project Folders/개인/혼팀 브랜드";
	assert.equal(plan.folder, f);
	assert.deepEqual(plan.folders, [f, `${f}/01 초안`, `${f}/02 산출물`, `${f}/99 작업실`, `${f}/99 작업실/로그`]);
	assert.deepEqual(
		plan.files.map((x) => x.path),
		[`${f}/혼팀 브랜드.md`, `${f}/AGENTS.md`, `${f}/99 작업실/혼팀 브랜드 로그.md`, `${f}/99 작업실/로그/혼팀 브랜드 로그 2026-10.md`],
	);
	// Visible root items: 01 초안, 02 산출물, hub, AGENTS.md, 99 작업실 — nothing else.
	const rootItems = new Set([...plan.folders, ...plan.files.map((x) => x.path)].filter((p) => p !== f).map((p) => p.slice(f.length + 1).split("/")[0]));
	assert.deepEqual([...rootItems].sort(), ["01 초안", "02 산출물", "99 작업실", "AGENTS.md", "혼팀 브랜드.md"].sort());
	// No optional numbered places (10–80).
	assert.ok(!plan.folders.some((p) => /99 작업실\/\d0 /.test(p)));
	for (const file of plan.files) assert.deepEqual(leftoverPlaceholders(file.content), [], file.path);

	const hub = plan.files[0].content;
	const { data, body } = parseFrontmatterText(hub);
	const p = parseProject(data, body, hubLocation(plan.files[0].path, ACTIVE, ARCHIVE)!, plan.files[0].path)!;
	assert.equal(p.id, "P-honteam");
	assert.equal(p.title, "혼팀 브랜드");
	assert.equal(p.status, "후보");
	assert.equal(p.started, "");
	assert.equal(p.updated, "2026-10-24");
	assert.equal(p.kind, "콘텐츠 제작");
	assert.equal(p.summary, "혼팀 브랜드를 AI 콘텐츠로 키운다.");
	assert.equal(p.action, "미확인");
	assert.match(hub, /## 목표\n- 미확인\n/);

	const agents = plan.files[1].content;
	assert.match(agents, /^id: P-honteam$/m);
	assert.match(agents, /\| `99 작업실\/60 에셋` \| 예 \|/);
	assert.match(agents, /\| `99 작업실\/70 프롬프트` \| 예 \|/);
	assert.match(agents, /\| `99 작업실\/50 데이터` \| \|/);

	const idx = plan.files[2].content;
	assert.match(idx, /^latest_log: "99 작업실\/로그\/혼팀 브랜드 로그 2026-10.md"/m);
	assert.match(idx, /## 최근 작업\n- 2026-10-24: 프로젝트 생성\n/);

	const log = plan.files[3].content;
	assert.match(log, /## 2026-10-24 — 프로젝트 생성\n/);

	assert.equal(plan.row.aliases, "혼팀, honteam");
	assert.equal(plan.row.status, "후보");
	assert.equal(plan.row.path, f);
	const reg = upsertActiveRow(fx("Project Folders Index.md"), { id: plan.id }, plan.row);
	assert.ok(reg.ok && reg.added);
	assert.equal(parseRegistry(reg.text).active[0].name, "혼팀 브랜드");
});
