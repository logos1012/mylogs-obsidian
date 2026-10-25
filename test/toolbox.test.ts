import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import { getFmValue } from "../src/projects/ops.ts";
import { getSectionContent } from "../src/writer.ts";
import {
	failure,
	firstLine,
	isStaleSkill,
	nameLink,
	nextSkillId,
	parseSkill,
	pendingRequests,
	recentDoneRequests,
	reconcile,
	registryAffected,
	requestStamp,
	rowName,
	type Skill,
	skillEditChanges,
	skillName,
	type SkillInput,
	tooMany,
	truncate,
	validateSkillInput,
} from "../src/toolbox/model.ts";
import {
	appendRunRequest,
	applySkillEdit,
	changeText,
	fillPlaceholders,
	fillSkillTemplate,
	leftoverPlaceholders,
	logToolboxChange,
	moveRowToDiscarded,
	parseRunRequests,
	parseToolboxRegistry,
	setSkillStatus,
	skillRowOf,
	upsertSkillRow,
} from "../src/toolbox/ops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/toolbox", p), "utf8");
const SKILL = fx("AI 뉴스 브리핑.md");
const REG = fx("Toolbox Index.md");
const TEMPLATE = fx("_Templates/스킬.md");
const FOLDER = "11 Toolbox";
const TODAY = "2026-10-26";

function load(text = SKILL, path = `${FOLDER}/AI 뉴스 브리핑.md`): Skill {
	const { data, body } = parseFrontmatterText(text);
	const s = parseSkill(data, body, path, FOLDER);
	assert.ok(s, path);
	return s;
}

/** Lines removed from `a` and lines added in `b` (multiset difference, file order kept). */
function lineDiff(a: string, b: string): { removed: string[]; added: string[] } {
	const count = (ls: string[]) => ls.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
	const take = (from: string[], other: string[]) => {
		const left = count(other);
		return from.filter((l) => {
			const n = left.get(l) ?? 0;
			if (n > 0) {
				left.set(l, n - 1);
				return false;
			}
			return true;
		});
	};
	const x = a.split("\n");
	const y = b.split("\n");
	return { removed: take(x, y), added: take(y, x) };
}

// ───────────────────────── skill parsing ─────────────────────────

test("skillName: only <folder>/<이름>.md; templates, index and AGENTS excluded", () => {
	assert.equal(skillName("11 Toolbox/AI 뉴스 브리핑.md", FOLDER), "AI 뉴스 브리핑");
	assert.equal(skillName("11 Toolbox/_Templates/스킬.md", FOLDER), null);
	assert.equal(skillName("11 Toolbox/Toolbox Index.md", FOLDER), null);
	assert.equal(skillName("11 Toolbox/AGENTS.md", FOLDER), null);
	assert.equal(skillName("05 Project Folders/x.md", FOLDER), null);
	assert.equal(skillName("11 Toolbox/x.md", "/11 Toolbox/"), "x");
});

test("parseSkill: frontmatter and the first line of 「목적」", () => {
	const s = load();
	assert.equal(s.id, "T-01");
	assert.equal(s.name, "AI 뉴스 브리핑");
	assert.equal(s.owner, "hermes");
	assert.equal(s.trigger, "cron");
	assert.equal(s.schedule, "0 4 * * *");
	assert.equal(s.output, "07 Shelf/LLM Wiki/raw/articles/ai-news/{YYYY-MM-DD}_AI 뉴스 브리핑.md");
	assert.equal(s.notify, "04 Daily Pad 오늘 파일 `## 자료`에 링크 한 줄");
	assert.equal(s.status, "멈춤");
	assert.equal(s.lastRun, "");
	assert.equal(s.lastResult, "");
	assert.equal(s.lastReviewed, "2026-10-26");
	assert.equal(s.created, "2026-10-26");
	assert.match(s.purpose, /^매일 새벽, 지난 24시간 동안/);
	assert.ok(!s.purpose.includes("**"), "emphasis stripped");
	// not a skill
	const { data, body } = parseFrontmatterText(REG);
	assert.equal(parseSkill(data, body, `${FOLDER}/Toolbox Index.md`, FOLDER), null);
	assert.equal(parseSkill({ type: "skill" }, "", `${FOLDER}/_Templates/스킬.md`, FOLDER), null);
});

test("firstLine / truncate: comments and empty bullets skipped, long text cut with …", () => {
	assert.equal(firstLine("<!-- hint -->\n- \n- **하는 일** 한 줄\n둘째 줄"), "하는 일 한 줄");
	assert.equal(firstLine(""), "");
	assert.equal(truncate("가나다라마바사", 5), "가나다라…");
	assert.equal(truncate("짧다", 5), "짧다");
});

// ───────────────────────── next id ─────────────────────────

test("nextSkillId: max + 1, two digits; none → T-01; three digits kept", () => {
	assert.equal(nextSkillId([]), "T-01");
	assert.equal(nextSkillId(["T-01"]), "T-02");
	assert.equal(nextSkillId(["T-03", "T-01", "P-x", "T-9"]), "T-10");
	assert.equal(nextSkillId(["T-120"]), "T-121");
});

// ───────────────────────── badges ─────────────────────────

test("stale / failed / too many", () => {
	assert.equal(isStaleSkill({ status: "사용", lastRun: "" }, TODAY), true);
	assert.equal(isStaleSkill({ status: "사용", lastRun: "2026-07-28T04:30" }, TODAY), true, "90 days");
	assert.equal(isStaleSkill({ status: "사용", lastRun: "2026-07-29T04:30" }, TODAY), false, "89 days");
	assert.equal(isStaleSkill({ status: "멈춤", lastRun: "2026-01-01T00:00" }, TODAY), true);
	assert.equal(isStaleSkill({ status: "폐기", lastRun: "" }, TODAY), false);
	assert.deepEqual(failure({ lastResult: "성공" }), { failed: false, reason: "" });
	assert.deepEqual(failure({ lastResult: "실패: 로그인 만료" }), { failed: true, reason: "로그인 만료" });
	assert.deepEqual(failure({ lastResult: "실패" }), { failed: true, reason: "" });
	assert.equal(tooMany(20), false);
	assert.equal(tooMany(21), true);
});

// ───────────────────────── registry parsing & reconciliation ─────────────────────────

test("parseToolboxRegistry: 스킬 rows (code cells unbackticked), 폐기 rows, 실행 요청", () => {
	const r = parseToolboxRegistry(REG);
	assert.equal(r.skills.length, 1);
	const row = r.skills[0];
	assert.equal(row.id, "T-01");
	assert.equal(row.nameCell, "[[11 Toolbox/AI 뉴스 브리핑\\|AI 뉴스 브리핑]]");
	assert.equal(rowName(row.nameCell), "AI 뉴스 브리핑");
	assert.equal(row.schedule, "0 4 * * *");
	assert.equal(row.output, "07 Shelf/LLM Wiki/raw/articles/ai-news/");
	assert.equal(row.owner, "hermes");
	assert.equal(row.status, "멈춤");
	assert.equal(row.lastRun, "");
	assert.equal(row.lastReviewed, "2026-10-26");
	assert.deepEqual(r.discarded, []);
	assert.deepEqual(r.requests, []);
});

test("reconcile: file ↔ row by id; file-only and row-only flagged; sorted by id", () => {
	const s1 = load();
	const s2: Skill = { ...s1, id: "T-03", name: "새 스킬", path: `${FOLDER}/새 스킬.md` };
	const rows = parseToolboxRegistry(REG).skills;
	const ghost = { ...rows[0], id: "T-02", nameCell: "[[11 Toolbox/없는 스킬\\|없는 스킬]]" };
	const out = reconcile([s2, s1], [...rows, ghost]);
	assert.deepEqual(
		out.map((e) => [e.kind, e.skill?.id ?? e.row?.id]),
		[
			["both", "T-01"],
			["row-only", "T-02"],
			["file-only", "T-03"],
		],
	);
});

// ───────────────────────── create plan ─────────────────────────

const INPUT: SkillInput = {
	name: "볼트 링크 점검",
	purpose: "매주 볼트의 깨진 위키링크를 찾아 목록을 만든다",
	trigger: "cron",
	schedule: "0 5 * * 1",
	output: "07 Shelf/99 작업실/받은 자료/{YYYY-MM-DD}_링크 점검.md",
	notify: "04 Daily Pad `## 자료`에 링크 한 줄",
};

test("validateSkillInput: duplicates, cron schedule, required fields", () => {
	const taken = { ids: ["T-01"], names: ["AI 뉴스 브리핑"] };
	assert.deepEqual(validateSkillInput(INPUT, "T-02", taken), []);
	assert.ok(validateSkillInput({ ...INPUT, name: "AI 뉴스 브리핑" }, "T-02", taken).some((p) => p.includes("이미 있는 스킬 이름")));
	assert.ok(validateSkillInput(INPUT, "T-01", taken).some((p) => p.includes("이미 있는 id")));
	assert.ok(validateSkillInput({ ...INPUT, schedule: "" }, "T-02", taken).some((p) => p.includes("schedule")));
	assert.ok(validateSkillInput({ ...INPUT, schedule: "every day" }, "T-02", taken).some((p) => p.includes("다섯 칸")));
	assert.deepEqual(validateSkillInput({ ...INPUT, trigger: "수동", schedule: "" }, "T-02", taken), []);
	assert.ok(validateSkillInput({ ...INPUT, name: "a/b" }, "T-02", taken).length);
	assert.ok(validateSkillInput({ ...INPUT, output: "" }, "T-02", taken).some((p) => p.includes("출력")));
});

test("fillPlaceholders: {{date:…}}, {{date}}, {{title}}", () => {
	const d = new Date(2026, 9, 26, 9, 5);
	assert.equal(fillPlaceholders("{{date:YYYY-MM-DD}} {{date}} {{date:HH:mm}} # {{title}}", { date: d, title: "T" }), "2026-10-26 2026-10-26 09:05 # T");
});

test("fillSkillTemplate: frontmatter, 목적, 멈춤, dates, no placeholders left", () => {
	const now = new Date(2026, 9, 26, 9, 5);
	const text = fillSkillTemplate(TEMPLATE, INPUT, "T-02", now);
	assert.deepEqual(leftoverPlaceholders(text), []);
	assert.equal(getFmValue(text, "id"), "T-02");
	assert.equal(getFmValue(text, "name"), "볼트 링크 점검");
	assert.equal(getFmValue(text, "trigger"), "cron");
	assert.match(text, /^schedule: "0 5 \* \* 1"$/m);
	assert.equal(getFmValue(text, "output"), INPUT.output);
	assert.equal(getFmValue(text, "notify"), INPUT.notify);
	assert.equal(getFmValue(text, "status"), "멈춤");
	assert.equal(getFmValue(text, "created"), "2026-10-26");
	assert.equal(getFmValue(text, "updated"), "2026-10-26");
	assert.equal(getFmValue(text, "last_reviewed"), "2026-10-26");
	assert.equal(getFmValue(text, "last_run"), "");
	assert.match(text, /^# 볼트 링크 점검$/m);
	assert.equal(getSectionContent(text, "목적"), INPUT.purpose);
	assert.match(getSectionContent(text, "변경 기록") ?? "", /^- 2026-10-26: 만듦\.$/);
	// the parsed result round-trips
	const s = load(text, `${FOLDER}/볼트 링크 점검.md`);
	assert.equal(s.purpose, INPUT.purpose);
	assert.equal(s.schedule, "0 5 * * 1");
	// 수동: schedule empty
	const manual = fillSkillTemplate(TEMPLATE, { ...INPUT, trigger: "수동", schedule: "0 5 * * 1" }, "T-02", now);
	assert.match(manual, /^schedule: ""$/m);
	assert.equal(getFmValue(manual, "trigger"), "수동");
});

test("create: registry row from the new file + 변경 기록 line", () => {
	const text = fillSkillTemplate(TEMPLATE, INPUT, "T-02", new Date(2026, 9, 26, 9, 5));
	const s = load(text, `${FOLDER}/볼트 링크 점검.md`);
	const row = skillRowOf(s, FOLDER);
	const r = upsertSkillRow(REG, { id: row.id }, row);
	assert.ok(r.ok && r.added);
	const out = logToolboxChange(r.text, TODAY, changeText.create("T-02", s.name, INPUT));
	const diff = lineDiff(REG, out);
	assert.equal(getFmValue(out, "updated"), TODAY);
	const rows = parseToolboxRegistry(out).skills;
	assert.equal(rows.length, 2);
	assert.equal(rows[1].id, "T-02");
	assert.equal(rows[1].nameCell, nameLink(FOLDER, "볼트 링크 점검"));
	assert.equal(rows[1].purpose, INPUT.purpose);
	assert.equal(rows[1].schedule, "0 5 * * 1");
	assert.equal(rows[1].output, INPUT.output);
	assert.equal(rows[1].status, "멈춤");
	assert.equal(rows[1].lastReviewed, TODAY);
	// the written row: same column order as the header, code cells in backticks
	assert.match(out, /^\| T-02 \| \[\[11 Toolbox\/볼트 링크 점검\\\|볼트 링크 점검\]\] \| 매주 볼트의 깨진 위키링크를 찾아 목록을 만든다 \| cron \| `0 5 \* \* 1` \| `07 Shelf\/99 작업실\/받은 자료\/\{YYYY-MM-DD\}_링크 점검\.md` \| hermes \| 멈춤 \|  \|  \| 2026-10-26 \|$/m);
	assert.match(getSectionContent(out, "변경 기록") ?? "", /^- 2026-10-26: T-02 「볼트 링크 점검」 만듦 \(멈춤, cron 0 5 \* \* 1\) \(플러그인\)\n- 2026-10-26: Toolbox 형식 확정/);
	// only the row and the 변경 기록 line were added (`updated` already was today); nothing removed
	assert.deepEqual(diff.removed, []);
	assert.equal(diff.added.length, 2, JSON.stringify(diff));
});

// ───────────────────────── status toggle ─────────────────────────

test("status toggle: file status + updated; registry 상태 cell; 변경 기록 line", () => {
	const file = setSkillStatus(SKILL, "사용", TODAY);
	assert.deepEqual(lineDiff(SKILL, file), { removed: ["status: 멈춤"], added: ["status: 사용"] });
	const later = setSkillStatus(SKILL, "사용", "2026-11-02");
	assert.deepEqual(lineDiff(SKILL, later), { removed: ["status: 멈춤", "updated: 2026-10-26"], added: ["status: 사용", "updated: 2026-11-02"] });
	const r = upsertSkillRow(REG, { id: "T-01", status: "사용" });
	assert.ok(r.ok && !r.added);
	const reg = logToolboxChange(r.text, TODAY, changeText.status("사용", "AI 뉴스 브리핑"));
	const diff = lineDiff(REG, reg);
	assert.equal(diff.removed.length, 1, JSON.stringify(diff));
	assert.equal(diff.added.length, 2, JSON.stringify(diff));
	assert.equal(parseToolboxRegistry(reg).skills[0].status, "사용");
	assert.ok(diff.added[0].includes("| cron | `0 4 * * *` | `07 Shelf/LLM Wiki/raw/articles/ai-news/` | hermes | 사용 |"), "other cells untouched");
	assert.equal(diff.added[1], "- 2026-10-26: 사용 「AI 뉴스 브리핑」 (플러그인)");
	// back to 멈춤
	const r2 = upsertSkillRow(reg, { id: "T-01", status: "멈춤" });
	assert.ok(r2.ok);
	assert.equal(parseToolboxRegistry(r2.text).skills[0].status, "멈춤");
	assert.equal(changeText.status("멈춤", "AI 뉴스 브리핑"), "멈춤 「AI 뉴스 브리핑」 (플러그인)");
});

test("upsertSkillRow: unknown table → error; missing row added with full", () => {
	const noTable = REG.replace("## 스킬", "## 다른");
	const r = upsertSkillRow(noTable, { id: "T-01", status: "사용" });
	assert.ok(!r.ok);
	const full = skillRowOf(load(), FOLDER);
	const r2 = upsertSkillRow(REG.replace(/^\| T-01 .*\n/m, ""), { id: "T-01" }, full);
	assert.ok(r2.ok && r2.added);
	assert.equal(parseToolboxRegistry(r2.text).skills[0].purpose, full.purpose);
});

// ───────────────────────── 폐기 ─────────────────────────

test("폐기: file status 폐기, row moves to 「폐기」 with date and reason, 변경 기록 line", () => {
	const file = setSkillStatus(SKILL, "폐기", TODAY);
	assert.equal(getFmValue(file, "status"), "폐기");
	const r = moveRowToDiscarded(REG, { id: "T-01", nameCell: nameLink(FOLDER, "AI 뉴스 브리핑"), date: TODAY, reason: "Hermes 자체 스킬로 대체" });
	assert.ok(r.ok);
	const reg = logToolboxChange(r.text, TODAY, changeText.discard("AI 뉴스 브리핑", "Hermes 자체 스킬로 대체"));
	const p = parseToolboxRegistry(reg);
	assert.deepEqual(p.skills, []);
	assert.deepEqual(p.discarded, [{ id: "T-01", nameCell: "[[11 Toolbox/AI 뉴스 브리핑\\|AI 뉴스 브리핑]]", date: TODAY, reason: "Hermes 자체 스킬로 대체" }]);
	assert.match(reg, /^\| T-01 \| \[\[11 Toolbox\/AI 뉴스 브리핑\\\|AI 뉴스 브리핑\]\] \| 2026-10-26 \| Hermes 자체 스킬로 대체 \|$/m);
	assert.match(getSectionContent(reg, "변경 기록") ?? "", /^- 2026-10-26: 폐기 「AI 뉴스 브리핑」: Hermes 자체 스킬로 대체 \(플러그인\)/);
	// the 스킬 table header and separator survive
	assert.match(reg, /\| id \| 이름 \| 하는 일 \|[^\n]*\n\|---\|---\|---\|---\|---\|---\|---\|---\|---\|---\|---\|\n\n## 실행 요청/);
});

// ───────────────────────── 실행 요청 ─────────────────────────

test("실행 요청: appended after the comment; pending / done detection; 7-day fade", () => {
	const stamp = requestStamp(new Date(2026, 9, 26, 9, 5));
	assert.equal(stamp, "2026-10-26T09:05");
	const reg = appendRunRequest(REG, "T-01", stamp, TODAY);
	assert.deepEqual(lineDiff(REG, reg), { removed: [], added: ["- [ ] T-01 (requested:: 2026-10-26T09:05)"] });
	assert.match(reg, /## 실행 요청\n\n<!-- 사용자나 플러그인이[^\n]*-->\n- \[ \] T-01 \(requested:: 2026-10-26T09:05\)\n\n## 폐기/);
	const reqs = parseRunRequests(reg);
	assert.deepEqual(reqs, [{ id: "T-01", requested: "2026-10-26T09:05", done: false, line: "- [ ] T-01 (requested:: 2026-10-26T09:05)" }]);
	assert.equal(pendingRequests(reqs, "T-01").length, 1);
	assert.equal(pendingRequests(reqs, "T-02").length, 0);
	// a second request goes below the first
	const reg2 = appendRunRequest(reg, "T-01", "2026-10-26T10:00", TODAY);
	assert.equal(parseRunRequests(reg2).length, 2);
	// Hermes checks it → done; shown faded for 7 days, then hidden
	const done = reg2.replace("- [ ] T-01 (requested:: 2026-10-26T09:05)", "- [x] T-01 (requested:: 2026-10-26T09:05)");
	const dr = parseRunRequests(done);
	assert.equal(pendingRequests(dr, "T-01").length, 1);
	assert.equal(recentDoneRequests(dr, "T-01", "2026-10-26").length, 1);
	assert.equal(recentDoneRequests(dr, "T-01", "2026-11-02").length, 1, "day 7 still shown");
	assert.equal(recentDoneRequests(dr, "T-01", "2026-11-03").length, 0, "day 8 hidden");
	// no section at all → created
	const bare = appendRunRequest(REG.replace(/## 실행 요청\n\n<!--[^\n]*-->\n\n/, ""), "T-01", stamp, TODAY);
	assert.equal(parseRunRequests(bare).length, 1);
});

// ───────────────────────── 수정 ─────────────────────────

test("수정: changes list, registryAffected, file edit (frontmatter, H1, 변경 기록)", () => {
	const s = load();
	const same = { name: s.name, trigger: s.trigger, schedule: s.schedule, output: s.output, notify: s.notify };
	assert.deepEqual(skillEditChanges(s, same), []);
	assert.equal(applySkillEdit(SKILL, s, same, "2026-11-01"), SKILL, "no change → untouched");
	// notify only: file changes, registry not affected
	const n = { ...same, notify: "Slack DM" };
	assert.deepEqual(skillEditChanges(s, n), ["알림"]);
	assert.equal(registryAffected(s, n), false);
	const nf = applySkillEdit(SKILL, s, n, "2026-11-01");
	assert.deepEqual(lineDiff(SKILL, nf), {
		removed: ["notify: 04 Daily Pad 오늘 파일 `## 자료`에 링크 한 줄", "updated: 2026-10-26"],
		added: ["notify: Slack DM", "updated: 2026-11-01", "- 2026-11-01: 수정: 알림 (플러그인)"],
	});
	// rename + 수동 (schedule dropped) + output
	const e = { name: "AI 브리핑", trigger: "수동", schedule: s.schedule, output: "07 Shelf/LLM Wiki/raw/articles/ai-news/{YYYY-MM-DD}.md", notify: s.notify };
	assert.deepEqual(skillEditChanges(s, e), ["이름 「AI 뉴스 브리핑」 → 「AI 브리핑」", "트리거 cron → 수동", "schedule 0 4 * * * → —", "출력 07 Shelf/LLM Wiki/raw/articles/ai-news/{YYYY-MM-DD}_AI 뉴스 브리핑.md → 07 Shelf/LLM Wiki/raw/articles/ai-news/{YYYY-MM-DD}.md"]);
	assert.equal(registryAffected(s, e), true);
	const ef = applySkillEdit(SKILL, s, e, "2026-11-01");
	assert.equal(getFmValue(ef, "name"), "AI 브리핑");
	assert.equal(getFmValue(ef, "trigger"), "수동");
	assert.match(ef, /^schedule: ""$/m);
	assert.equal(getFmValue(ef, "output"), e.output);
	assert.match(ef, /^# AI 브리핑$/m);
	assert.ok(!/^# AI 뉴스 브리핑$/m.test(ef));
	assert.equal(getFmValue(ef, "id"), "T-01", "id never changes");
	// registry row follows the file
	const ns = load(ef, `${FOLDER}/AI 브리핑.md`);
	const row = skillRowOf(ns, FOLDER);
	const r = upsertSkillRow(REG, { id: "T-01", nameCell: row.nameCell, trigger: row.trigger, schedule: row.schedule, output: row.output });
	assert.ok(r.ok);
	const reg = logToolboxChange(r.text, "2026-11-01", changeText.edit("T-01", ns.name, skillEditChanges(s, e)));
	const rows = parseToolboxRegistry(reg).skills;
	assert.equal(rows[0].nameCell, "[[11 Toolbox/AI 브리핑\\|AI 브리핑]]");
	assert.equal(rows[0].trigger, "수동");
	assert.equal(rows[0].schedule, "");
	assert.equal(rows[0].output, e.output);
	assert.equal(rows[0].purpose, "X·인스타·링크드인에서 AI 소식·기술 트렌드·사용 사례를 조사해 보고서 작성", "untouched cell kept");
	assert.equal(getFmValue(reg, "updated"), "2026-11-01");
});

// ───────────────────────── registry ↔ file reconciliation writes ─────────────────────────

test("등록: a file without a row gets one from the file; a row without a file is reported", () => {
	const text = fillSkillTemplate(TEMPLATE, { ...INPUT, name: "고아 스킬" }, "T-05", new Date(2026, 9, 26));
	const s = load(text, `${FOLDER}/고아 스킬.md`);
	const entries = reconcile([load(), s], parseToolboxRegistry(REG).skills);
	assert.equal(entries[1].kind, "file-only");
	const row = skillRowOf(s, FOLDER);
	const r = upsertSkillRow(REG, { id: row.id }, row);
	assert.ok(r.ok && r.added);
	const reg = logToolboxChange(r.text, TODAY, changeText.register("T-05", s.name));
	assert.equal(reconcile([load(), s], parseToolboxRegistry(reg).skills).every((e) => e.kind === "both"), true);
	assert.match(reg, /T-05 「고아 스킬」 등록부에 행 추가/);
});
