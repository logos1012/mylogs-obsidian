import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import { getFmValue } from "../src/projects/ops.ts";
import { getSectionContent } from "../src/writer.ts";
import {
	descriptionWithPhrase,
	editDelta,
	initialStatus,
	isReviewStale,
	liveStatuses,
	parseKind,
	slugProblem,
	SLUG_RE,
	statusForKind,
	STATUSES_BY_KIND,
	stubAffected,
	validStatus,
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
	LIVE_STATUSES,
	SKILL_STATUSES,
	canRequestRun,
	needsConfirm,
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
	hasKindTable,
	kindTable,
	moveRowToDiscarded,
	moveRowToKind,
	stripFrontmatterComments,
	parseRunRequests,
	parseToolboxRegistry,
	setSkillStatus,
	skillRowOf,
	upsertSkillRow,
} from "../src/toolbox/ops.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => readFileSync(join(here, "fixtures/toolbox", p), "utf8");
/** Before AGENTS v2.0 (no `kind`, one 「스킬」 table): the tests below them cover the legacy path. */
const SKILL = fx("legacy/AI 뉴스 브리핑.md");
const REG = fx("legacy/Toolbox Index.md");
/** AGENTS v2.0 copies (`kind`, `slug`, `description`; 「운영」「도구」「작업」 tables). */
const SKILL2 = fx("AI 뉴스 브리핑.md");
const REG2 = fx("Toolbox Index.md");
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
	assert.match(getSectionContent(out, "변경 기록") ?? "", /^- 2026-10-26: T-02 「볼트 링크 점검」 만듦 \(작업, 멈춤, cron 0 5 \* \* 1\) \(플러그인\)\n- 2026-10-26: Toolbox 형식 확정/);
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

test("3-state: 멈춤 → 시험 → 사용 each writes file status, registry cell and a 변경 기록 line with the new word", () => {
	assert.deepEqual([...SKILL_STATUSES], ["멈춤", "시험", "사용", "폐기"]);
	assert.deepEqual([...LIVE_STATUSES], ["멈춤", "시험", "사용"]);
	assert.equal(canRequestRun("멈춤"), false);
	assert.equal(canRequestRun("시험"), true);
	assert.equal(canRequestRun("사용"), true);
	assert.equal(canRequestRun("폐기"), false);
	assert.equal(needsConfirm("멈춤"), false);
	assert.equal(needsConfirm("시험"), true);
	assert.equal(needsConfirm("사용"), true);
	let file = SKILL;
	let reg = REG;
	for (const [status, day] of [
		["시험", "2026-10-27"],
		["사용", "2026-10-28"],
		["멈춤", "2026-10-29"],
	] as const) {
		file = setSkillStatus(file, status, day);
		assert.equal(getFmValue(file, "status"), status);
		assert.equal(getFmValue(file, "updated"), day);
		const r = upsertSkillRow(reg, { id: "T-01", status });
		assert.ok(r.ok);
		reg = logToolboxChange(r.text, day, changeText.status(status, "AI 뉴스 브리핑"));
		assert.equal(parseToolboxRegistry(reg).skills[0].status, status);
		assert.match(getSectionContent(reg, "변경 기록") ?? "", new RegExp(`^- ${day}: ${status} 「AI 뉴스 브리핑」 \\(플러그인\\)`));
		assert.equal(getFmValue(reg, "updated"), day);
	}
	// three lines, newest first, above the vault's own lines
	assert.match(getSectionContent(reg, "변경 기록") ?? "", /^- 2026-10-29: 멈춤 「AI 뉴스 브리핑」 \(플러그인\)\n- 2026-10-28: 사용 「AI 뉴스 브리핑」 \(플러그인\)\n- 2026-10-27: 시험 「AI 뉴스 브리핑」 \(플러그인\)\n- 2026-10-26: /);
	// the file: only status / updated moved, the body (including its own 변경 기록) is untouched
	assert.deepEqual(lineDiff(SKILL, file), { removed: ["updated: 2026-10-26"], added: ["updated: 2026-10-29"] });
	// stale badge is about last_run, not status; 시험 rows are asked too
	assert.equal(isStaleSkill({ status: "시험", lastRun: "" }, TODAY), true);
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

// ═════════════════════════ AGENTS v2.0: kinds (작업 / 도구 / 운영) ═════════════════════════

const TOOL: SkillInput = {
	kind: "도구",
	name: "데일리로그 기록",
	slug: "daily-log",
	description: "사용자가 오늘 한 일을 말하면 Daily Pad 로그에 시간순으로 적는다.",
	purpose: "",
	phrase: "데일리로그 기록해 줘",
	owner: "claude-code",
	trigger: "cron",
	schedule: "",
	output: "",
	notify: "",
};
const OPS: SkillInput = {
	kind: "운영",
	name: "MyLogs 운영",
	slug: "mylogs-ops",
	description: "MyLogs 볼트에서 일을 시작할 때마다 먼저 읽는 계약.",
	purpose: "",
	scope: "MyLogs 볼트 전체",
	trigger: "cron",
	schedule: "",
	output: "",
	notify: "",
};
const JOB: SkillInput = { ...INPUT, kind: "작업", slug: "vault-link-check", description: "매주 월요일 깨진 위키링크를 찾아 목록으로 만든다." };
const NOW = new Date(2026, 9, 26, 9, 5);

/** `## ` headings of a text, in order. */
function headings(t: string): string[] {
	return [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
}

test("kind: parsed from frontmatter; missing or unknown → 작업 (back-compat); slug / description", () => {
	const s = load(SKILL2);
	assert.equal(s.kind, "작업");
	assert.equal(s.slug, "ai-news-briefing");
	assert.match(s.description, /^매일 새벽 X·링크드인·인스타그램에서/);
	assert.match(s.description, /"AI 뉴스 브리핑 돌려 줘"$/);
	assert.equal(s.status, "시험");
	assert.equal(s.lastRun, "2026-10-26T00:25");
	// a file from before v2.0 (no kind / slug / description)
	const old = load(SKILL);
	assert.equal(old.kind, "작업");
	assert.equal(old.slug, "");
	assert.equal(old.description, "");
	assert.equal(parseKind(undefined), "작업");
	assert.equal(parseKind("도구"), "도구");
	assert.equal(parseKind("운영"), "운영");
	assert.equal(parseKind("스킬"), "작업");
	// the template's comment-only values read as empty (YAML: `key:   # comment`)
	const { data } = parseFrontmatterText(TEMPLATE);
	assert.equal(data.kind, "작업");
	assert.equal(data.slug, null);
	assert.equal(data.description, null);
	assert.equal(getFmValue(TEMPLATE, "slug"), "");
	assert.equal(getFmValue(TEMPLATE, "status"), "멈춤");
});

test("registry: 운영 / 도구 / 작업 tables parsed in that order; legacy 「스킬」 read as 작업", () => {
	const r = parseToolboxRegistry(REG2);
	assert.equal(r.skills.length, 1);
	assert.equal(r.skills[0].kind, "작업");
	assert.equal(r.skills[0].id, "T-01");
	assert.equal(r.skills[0].status, "시험");
	assert.equal(r.skills[0].lastResult, "실패: 제외 건수 미집계 및 위키 인덱스 확인 불가 (부분 수집, 뉴스 0건)");
	assert.deepEqual(r.requests.map((q) => [q.id, q.done]), [["T-01", true]]);
	assert.equal(kindTable(REG2, "작업"), "작업");
	// rows in every table
	let reg = REG2;
	reg = (upsertSkillRow(reg, { id: "T-02" }, { kind: "도구", id: "T-02", nameCell: nameLink(FOLDER, "데일리로그 기록"), slug: "daily-log", scope: "", phrase: "데일리로그 기록해 줘", purpose: "", trigger: "", schedule: "", output: "", owner: "hermes", status: "사용", lastRun: "", lastResult: "", lastReviewed: TODAY }) as { text: string }).text;
	reg = (upsertSkillRow(reg, { id: "T-03" }, { kind: "운영", id: "T-03", nameCell: nameLink(FOLDER, "MyLogs 운영"), slug: "`mylogs-ops`", scope: "MyLogs 볼트 전체", phrase: "", purpose: "", trigger: "", schedule: "", output: "", owner: "", status: "사용", lastRun: "", lastResult: "", lastReviewed: TODAY }) as { text: string }).text;
	assert.match(reg, /^\| T-02 \| \[\[11 Toolbox\/데일리로그 기록\\\|데일리로그 기록\]\] \| daily-log \| 데일리로그 기록해 줘 \| hermes \| 사용 \| 2026-10-26 \|$/m);
	const p = parseToolboxRegistry(reg);
	assert.deepEqual(p.skills.map((x) => [x.kind, x.id]), [["운영", "T-03"], ["도구", "T-02"], ["작업", "T-01"]]);
	assert.equal(p.skills[0].scope, "MyLogs 볼트 전체");
	assert.equal(p.skills[0].slug, "mylogs-ops", "backticks dropped on read");
	assert.equal(p.skills[1].phrase, "데일리로그 기록해 줘");
	assert.equal(p.skills[1].owner, "hermes");
	assert.equal(p.skills[1].purpose, "", "column the table doesn't have");
	// legacy: one 「스킬」 table
	const l = parseToolboxRegistry(REG);
	assert.deepEqual(l.skills.map((x) => [x.kind, x.id, x.status]), [["작업", "T-01", "멈춤"]]);
	assert.equal(kindTable(REG, "작업"), "스킬");
	assert.equal(kindTable(REG, "도구"), "도구");
});

test("status sets per kind: 작업 멈춤/시험/사용, 도구 멈춤/사용, 운영 사용 only; 지금 실행 and run-stale only for 작업", () => {
	assert.deepEqual([...STATUSES_BY_KIND.작업], ["멈춤", "시험", "사용", "폐기"]);
	assert.deepEqual([...STATUSES_BY_KIND.도구], ["멈춤", "사용", "폐기"]);
	assert.deepEqual([...STATUSES_BY_KIND.운영], ["사용", "폐기"]);
	assert.deepEqual([...liveStatuses("작업")], ["멈춤", "시험", "사용"]);
	assert.deepEqual([...liveStatuses("도구")], ["멈춤", "사용"]);
	assert.deepEqual([...liveStatuses("운영")], [], "no toggle, a badge");
	assert.equal(validStatus("도구", "시험"), false);
	assert.equal(validStatus("운영", "멈춤"), false);
	assert.equal(initialStatus("작업"), "멈춤");
	assert.equal(initialStatus("도구"), "멈춤");
	assert.equal(initialStatus("운영"), "사용");
	assert.equal(statusForKind("도구", "시험"), "멈춤");
	assert.equal(statusForKind("도구", "사용"), "사용");
	assert.equal(statusForKind("운영", "멈춤"), "사용");
	assert.equal(statusForKind("작업", "멈춤"), "멈춤");
	assert.equal(canRequestRun("사용", "도구"), false);
	assert.equal(canRequestRun("사용", "운영"), false);
	assert.equal(canRequestRun("시험", "작업"), true);
	// stale: last_run only for 작업; last_reviewed ≥ 90 days for all kinds
	assert.equal(isStaleSkill({ kind: "도구", status: "사용", lastRun: "" }, TODAY), false);
	assert.equal(isStaleSkill({ kind: "운영", status: "사용", lastRun: "" }, TODAY), false);
	assert.equal(isStaleSkill({ kind: "작업", status: "사용", lastRun: "" }, TODAY), true);
	assert.equal(isReviewStale({ status: "사용", lastReviewed: "2026-07-28" }, TODAY), true, "90 days");
	assert.equal(isReviewStale({ status: "사용", lastReviewed: "2026-07-29" }, TODAY), false, "89 days");
	assert.equal(isReviewStale({ status: "사용", lastReviewed: "" }, TODAY), true);
	assert.equal(isReviewStale({ status: "폐기", lastReviewed: "2020-01-01" }, TODAY), false);
	// a 도구 row toggles in its own table
	const tool = fillSkillTemplate(TEMPLATE, TOOL, "T-02", NOW);
	const ts = load(tool, `${FOLDER}/데일리로그 기록.md`);
	const added = upsertSkillRow(REG2, { id: "T-02" }, skillRowOf(ts, FOLDER));
	assert.ok(added.ok);
	const on = upsertSkillRow(added.text, { id: "T-02", status: "사용" });
	assert.ok(on.ok && !on.added);
	const p = parseToolboxRegistry(on.text).skills;
	assert.deepEqual(p.map((x) => [x.kind, x.id, x.status]), [["도구", "T-02", "사용"], ["작업", "T-01", "시험"]]);
});

test("slug validation: lowercase letters, digits, single hyphens; unique", () => {
	for (const ok of ["ai-news-briefing", "daily-log", "a", "x2", "mylogs-ops-2"]) assert.ok(SLUG_RE.test(ok), ok);
	for (const bad of ["", "AI-news", "ai_news", "-ai", "ai-", "ai--news", "ai news", "데일리", "ai.news"]) assert.ok(!SLUG_RE.test(bad), bad);
	assert.equal(slugProblem("daily-log", []), null);
	assert.match(slugProblem("daily-log", ["daily-log"]) ?? "", /이미 있는 slug/);
	assert.match(slugProblem("Daily_Log") ?? "", /영문 소문자/);
	assert.match(slugProblem("  ") ?? "", /slug를 적어/);
	const taken = { ids: ["T-01"], names: ["AI 뉴스 브리핑"], slugs: ["ai-news-briefing"] };
	assert.deepEqual(validateSkillInput(TOOL, "T-02", taken), []);
	assert.deepEqual(validateSkillInput(OPS, "T-02", taken), []);
	assert.deepEqual(validateSkillInput(JOB, "T-02", taken), []);
	assert.ok(validateSkillInput({ ...TOOL, slug: "ai-news-briefing" }, "T-02", taken).some((p) => p.includes("이미 있는 slug")));
	assert.ok(validateSkillInput({ ...TOOL, slug: "" }, "T-02", taken).some((p) => p.includes("slug")));
	assert.ok(validateSkillInput({ ...TOOL, phrase: "" }, "T-02", taken).some((p) => p.includes("부르는 말")));
	assert.ok(validateSkillInput({ ...OPS, scope: "" }, "T-02", taken).some((p) => p.includes("범위")));
	assert.ok(validateSkillInput({ ...OPS, description: "" }, "T-02", taken).some((p) => p.includes("description")));
	// 도구 / 운영 don't need 작업 fields
	assert.ok(!validateSkillInput(TOOL, "T-02", taken).some((p) => p.includes("출력")));
	// 작업 still needs them
	assert.ok(validateSkillInput({ ...JOB, output: "" }, "T-02", taken).some((p) => p.includes("출력")));
});

test("descriptionWithPhrase: the 부르는 말 is appended quoted unless already there", () => {
	assert.equal(descriptionWithPhrase("오늘 로그를 적는다.", "데일리로그 기록해 줘"), '오늘 로그를 적는다. "데일리로그 기록해 줘"');
	assert.equal(descriptionWithPhrase('오늘 로그를 적는다. "데일리로그 기록해 줘"', "데일리로그 기록해 줘"), '오늘 로그를 적는다. "데일리로그 기록해 줘"');
	assert.equal(descriptionWithPhrase("오늘 로그를 적는다.", '"로그 적어 줘", "기록해 줘"'), '오늘 로그를 적는다. "로그 적어 줘", "기록해 줘"');
	assert.equal(descriptionWithPhrase("오늘 로그를 적는다.", ""), "오늘 로그를 적는다.");
});

test("create 작업: kind / slug / description written, template comments dropped, row in 「작업」 table", () => {
	const text = fillSkillTemplate(TEMPLATE, JOB, "T-02", NOW);
	assert.deepEqual(leftoverPlaceholders(text), []);
	assert.ok(!/^[a-z_]+:.*\s#/m.test(text.split("\n---")[0]), "no frontmatter comments");
	assert.equal(getFmValue(text, "kind"), "작업");
	assert.equal(getFmValue(text, "slug"), "vault-link-check");
	assert.equal(getFmValue(text, "description"), JOB.description);
	assert.equal(getFmValue(text, "status"), "멈춤");
	assert.match(text, /^status: 멈춤$/m);
	assert.match(text, /^last_reviewed: 2026-10-26$/m);
	assert.deepEqual(headings(text), ["목적", "입력", "절차", "출력 형식", "금지", "완료 조건", "변경 기록"]);
	const s = load(text, `${FOLDER}/볼트 링크 점검.md`);
	const r = upsertSkillRow(REG2, { id: "T-02" }, skillRowOf(s, FOLDER));
	assert.ok(r.ok && r.added);
	const out = logToolboxChange(r.text, TODAY, changeText.create("T-02", s.name, JOB));
	const p = parseToolboxRegistry(out).skills;
	assert.deepEqual(p.map((x) => [x.kind, x.id]), [["작업", "T-01"], ["작업", "T-02"]]);
	assert.match(getSectionContent(out, "변경 기록") ?? "", /^- 2026-10-26: T-02 「볼트 링크 점검」 만듦 \(작업, 멈춤, cron 0 5 \* \* 1\) \(플러그인\)/);
	assert.deepEqual(lineDiff(REG2, out).removed, []);
	assert.equal(lineDiff(REG2, out).added.length, 2);
});

test("create 도구: 도구 body sections, no 작업-only keys, 멈춤, description carries the 부르는 말, row in 「도구」 table", () => {
	const text = fillSkillTemplate(TEMPLATE, TOOL, "T-02", NOW);
	assert.deepEqual(leftoverPlaceholders(text), []);
	assert.equal(getFmValue(text, "kind"), "도구");
	assert.equal(getFmValue(text, "status"), "멈춤");
	assert.equal(getFmValue(text, "owner"), "claude-code");
	assert.equal(getFmValue(text, "description"), '사용자가 오늘 한 일을 말하면 Daily Pad 로그에 시간순으로 적는다. "데일리로그 기록해 줘"');
	for (const k of ["trigger", "schedule", "output", "notify", "last_run", "last_result"]) assert.ok(!new RegExp(`^${k}:`, "m").test(text), k);
	assert.match(text, /^# 데일리로그 기록$/m);
	assert.deepEqual(headings(text), ["목적", "트리거", "절차", "금지", "완료 조건", "변경 기록"]);
	assert.match(getSectionContent(text, "변경 기록") ?? "", /^- 2026-10-26: 만듦\.$/);
	const s = load(text, `${FOLDER}/데일리로그 기록.md`);
	assert.equal(s.kind, "도구");
	assert.equal(s.phrase, "데일리로그 기록해 줘");
	const r = upsertSkillRow(REG2, { id: "T-02" }, skillRowOf(s, FOLDER));
	assert.ok(r.ok && r.added);
	assert.match(r.text, /## 도구\n\n[^\n]*\n\n\| id \| 이름 \| slug \| 부르는 말 \| 담당 \| 상태 \| 마지막 검토 \|\n\|[-|]+\|\n\| T-02 \| \[\[11 Toolbox\/데일리로그 기록\\\|데일리로그 기록\]\] \| daily-log \| 데일리로그 기록해 줘 \| claude-code \| 멈춤 \| 2026-10-26 \|\n\n## 작업/);
	assert.deepEqual(parseToolboxRegistry(r.text).skills.map((x) => [x.kind, x.id]), [["도구", "T-02"], ["작업", "T-01"]]);
	assert.equal(changeText.create("T-02", s.name, TOOL), "T-02 「데일리로그 기록」 만듦 (도구, 멈춤) (플러그인)");
	// legacy registry has no 「도구」 table → refused (the caller reports it)
	const legacy = upsertSkillRow(REG, { id: "T-02" }, skillRowOf(s, FOLDER));
	assert.ok(!legacy.ok);
	assert.equal(hasKindTable(REG, "도구"), false);
	assert.equal(hasKindTable(REG, "작업"), true);
	assert.equal(hasKindTable(REG2, "운영"), true);
});

test("create 운영: 운영 body sections, 사용 from the start, row in 「운영」 table", () => {
	const text = fillSkillTemplate(TEMPLATE, OPS, "T-02", NOW);
	assert.deepEqual(leftoverPlaceholders(text), []);
	assert.equal(getFmValue(text, "kind"), "운영");
	assert.equal(getFmValue(text, "status"), "사용");
	assert.equal(getFmValue(text, "slug"), "mylogs-ops");
	assert.ok(!/^trigger:/m.test(text));
	assert.deepEqual(headings(text), ["목적", "범위", "시작할 때", "경계", "완료 보고", "변경 기록"]);
	assert.equal(getSectionContent(text, "범위"), "MyLogs 볼트 전체");
	const s = load(text, `${FOLDER}/MyLogs 운영.md`);
	assert.equal(s.scope, "MyLogs 볼트 전체");
	const r = upsertSkillRow(REG2, { id: "T-02" }, skillRowOf(s, FOLDER));
	assert.ok(r.ok);
	assert.match(r.text, /\| id \| 이름 \| slug \| 범위 \| 상태 \| 마지막 검토 \|\n\|[-|]+\|\n\| T-02 \| \[\[11 Toolbox\/MyLogs 운영\\\|MyLogs 운영\]\] \| mylogs-ops \| MyLogs 볼트 전체 \| 사용 \| 2026-10-26 \|\n\n## 도구/);
	assert.equal(changeText.create("T-02", s.name, OPS), "T-02 「MyLogs 운영」 만듦 (운영, 사용) (플러그인)");
});

test("stripFrontmatterComments: value comments and comment-only values; quoted values kept", () => {
	const t = '---\nkind: 작업   # a | b\nslug:      # hint\nschedule: "0 4 * * *"  # c\nname: 가 #나\n---\n# x #y\n';
	assert.equal(stripFrontmatterComments(t), '---\nkind: 작업\nslug:\nschedule: "0 4 * * *"  # c\nname: 가\n---\n# x #y\n', "YAML: a space before # starts a comment");
});

test("수정 kind change: file kind + status, 「트리거」 inserted, the row moves 「작업」 → 「도구」", () => {
	const s = load(SKILL2);
	const e = { kind: "도구" as const, name: s.name, slug: s.slug, description: s.description, phrase: "AI 뉴스 브리핑 돌려 줘", owner: "hermes", trigger: s.trigger, schedule: s.schedule, output: s.output, notify: s.notify };
	const d = editDelta(s, e);
	assert.equal(d.kind, "도구");
	assert.equal(d.status, "멈춤", "시험 isn't a 도구 status");
	assert.deepEqual(skillEditChanges(s, e), ["종류 작업 → 도구 (시험 → 멈춤)", "부르는 말 — → AI 뉴스 브리핑 돌려 줘"]);
	assert.equal(registryAffected(s, e), true);
	assert.equal(stubAffected(s, e), true);
	const file = applySkillEdit(SKILL2, s, e, "2026-11-01");
	assert.equal(getFmValue(file, "kind"), "도구");
	assert.equal(getFmValue(file, "status"), "멈춤");
	assert.equal(getFmValue(file, "trigger"), "cron", "작업 keys left for the user");
	const hs = headings(file);
	assert.equal(hs[hs.length - 2], "트리거", "inserted right before 변경 기록");
	assert.equal(getSectionContent(file, "트리거"), "AI 뉴스 브리핑 돌려 줘");
	assert.match(getSectionContent(file, "변경 기록") ?? "", /- 2026-11-01: 수정: 종류 작업 → 도구 \(시험 → 멈춤\), 부르는 말 — → AI 뉴스 브리핑 돌려 줘 \(플러그인\)$/);
	const ns = load(file);
	assert.equal(ns.kind, "도구");
	assert.equal(ns.phrase, "AI 뉴스 브리핑 돌려 줘");
	const r = moveRowToKind(REG2, skillRowOf(ns, FOLDER));
	assert.ok(r.ok);
	const p = parseToolboxRegistry(r.text);
	assert.deepEqual(p.skills.map((x) => [x.kind, x.id, x.status, x.phrase]), [["도구", "T-01", "멈춤", "AI 뉴스 브리핑 돌려 줘"]]);
	assert.match(r.text, /\| T-01 \| \[\[11 Toolbox\/AI 뉴스 브리핑\\\|AI 뉴스 브리핑\]\] \| ai-news-briefing \| AI 뉴스 브리핑 돌려 줘 \| hermes \| 멈춤 \| 2026-10-26 \|\n\n## 작업/);
	assert.match(r.text, /## 작업\n\n[^\n]*\n\n\| id \| 이름 \| 하는 일 [^\n]*\n\|[-|]+\|\n\n## 실행 요청/, "작업 table left empty, header kept");
	// and back: 도구 → 작업 keeps 멈춤, the row returns to 「작업」
	const back = moveRowToKind(r.text, { ...skillRowOf(ns, FOLDER), kind: "작업" });
	assert.ok(back.ok);
	assert.deepEqual(parseToolboxRegistry(back.text).skills.map((x) => [x.kind, x.id]), [["작업", "T-01"]]);
	// 운영: a 멈춤 skill becomes 사용
	assert.equal(editDelta({ ...s, status: "멈춤" }, { ...e, kind: "운영", scope: "볼트 전체" }).status, "사용");
	// slug / description only: stub must be re-synced, row cell for slug
	const e2 = { ...e, kind: "작업" as const, slug: "ai-news", phrase: undefined };
	assert.deepEqual(skillEditChanges(s, e2), ["slug ai-news-briefing → ai-news"]);
	assert.equal(stubAffected(s, e2), true);
	assert.equal(getFmValue(applySkillEdit(SKILL2, s, e2, "2026-11-01"), "slug"), "ai-news");
});

test("reconcile: a row in another kind's table is misplaced; moving it fixes it", () => {
	const text = fillSkillTemplate(TEMPLATE, TOOL, "T-02", NOW);
	const s = load(text, `${FOLDER}/데일리로그 기록.md`);
	// the row was put into 「작업」 by hand
	const wrong = upsertSkillRow(REG2, { id: "T-02" }, { ...skillRowOf(s, FOLDER), kind: "작업" });
	assert.ok(wrong.ok);
	const es = reconcile([load(SKILL2), s], parseToolboxRegistry(wrong.text).skills);
	assert.deepEqual(es.map((e) => [e.kind, e.kind === "both" ? e.misplaced : null]), [["both", false], ["both", true]]);
	const fixed = moveRowToKind(wrong.text, skillRowOf(s, FOLDER));
	assert.ok(fixed.ok);
	const es2 = reconcile([load(SKILL2), s], parseToolboxRegistry(fixed.text).skills);
	assert.ok(es2.every((e) => e.kind === "both" && !e.misplaced));
	assert.match(changeText.move("T-02", s.name, "작업", "도구"), /^T-02 「데일리로그 기록」 등록부 행을 「작업」 표에서 「도구」 표로 옮김/);
});

test("폐기 from a kind table: the row leaves 「도구」 for 「폐기」", () => {
	const s = load(fillSkillTemplate(TEMPLATE, TOOL, "T-02", NOW), `${FOLDER}/데일리로그 기록.md`);
	const reg = (upsertSkillRow(REG2, { id: "T-02" }, skillRowOf(s, FOLDER)) as { text: string }).text;
	const r = moveRowToDiscarded(reg, { id: "T-02", nameCell: nameLink(FOLDER, s.name), date: TODAY, reason: "안 씀" });
	assert.ok(r.ok);
	const p = parseToolboxRegistry(r.text);
	assert.deepEqual(p.skills.map((x) => x.id), ["T-01"]);
	assert.deepEqual(p.discarded.map((x) => x.id), ["T-02"]);
});
