import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	activeElements,
	flywheelIdOf,
	flywheelLine,
	flywheelLines,
	flywheelPath,
	isFlywheelLine,
	missingStatus,
	missedCount,
	parseFlywheel,
	weeklyDone,
} from "../src/flywheel/model.ts";
import { dailyPadSkeleton } from "../src/writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const vault = readFileSync(join(here, "fixtures/flywheel/Flywheel.md"), "utf8");
const mixed = readFileSync(join(here, "fixtures/flywheel/Flywheel-mixed.md"), "utf8");

test("parseFlywheel reads the vault's Flywheel.md: id, name, fields, status", () => {
	const els = parseFlywheel(vault);
	assert.deepEqual(
		els.map((e) => [e.id, e.name, e.status]),
		[
			["F-1", "건강", "사용"],
			["F-2", "마케팅", "사용"],
			["F-3", "상품 개발", "사용"],
		],
	);
	assert.equal(els[0].fields["정체성"], "나는 매일 몸을 쓰는 사람이다");
	assert.equal(els[0].fields["선행지표"], "주 5회");
	assert.equal(els[0].fields["goal"], "G-2026-02.1");
	assert.equal(els[0].fields["since"], "2026-10-26");
	assert.equal(els[1].fields["goal"], "", "empty value keeps the key");
	assert.equal(els[2].fields["다음"], "→ F-1 만든 것이 팔려야 몸을 쓸 여유와 이유가 생긴다");
	// 변경 기록 is not an element.
	assert.ok(els.every((e) => e.id.startsWith("F-")));
});

test("parseFlywheel: 쉼·폐기, missing status is left out (쉼), empty 최소, missing file", () => {
	const els = parseFlywheel(mixed);
	assert.deepEqual(
		els.map((e) => [e.id, e.status]),
		[
			["F-1", "사용"],
			["F-2", "사용"],
			["F-3", "쉼"],
			["F-4", ""],
			["F-5", "폐기"],
		],
	);
	assert.equal(els[1].fields["최소"], "");
	assert.equal(els[3].fields["status"], undefined);
	assert.deepEqual(missingStatus(els).map((e) => e.id), ["F-4"], "no status field → warned and left out (new_day.py)");
	assert.deepEqual(activeElements(els).map((e) => e.id), ["F-1", "F-2"]);
	assert.deepEqual(missingStatus(parseFlywheel(vault)), []);
	// An empty `status::` is present (not warned) but still not 사용.
	const empty = parseFlywheel("## F-7 빈 상태\n- status:: \n");
	assert.deepEqual([missingStatus(empty).length, activeElements(empty).length], [0, 0]);
	assert.deepEqual(parseFlywheel(null), [], "no Flywheel.md → no elements");
	assert.deepEqual(parseFlywheel(""), []);
	assert.deepEqual(parseFlywheel("# Flywheel\n\n## 변경 기록\n- 2026-10-26: 비움\n"), []);
	// CRLF files parse the same.
	assert.deepEqual(parseFlywheel(mixed.replace(/\n/g, "\r\n")).map((e) => e.id), els.map((e) => e.id));
});

test("flywheelLine formats exactly like new_day.py (omits ' — ' when 최소 is empty)", () => {
	const els = parseFlywheel(mixed);
	assert.equal(flywheelLine(els[0]), "- [ ] F-1 몸 만들기 — 걷기 15분 (flywheel:: F-1)");
	assert.equal(flywheelLine(els[1]), "- [ ] F-2 공부 (flywheel:: F-2)");
	assert.equal(flywheelLine({ id: "F-9", name: "이름", fields: {}, status: "사용" }), "- [ ] F-9 이름 (flywheel:: F-9)");
	assert.deepEqual(flywheelLines(els), [
		"- [ ] F-1 몸 만들기 — 걷기 15분 (flywheel:: F-1)",
		"- [ ] F-2 공부 (flywheel:: F-2)",
	]);
	assert.deepEqual(flywheelLines(parseFlywheel(vault)), [
		"- [ ] F-1 건강 — (채우기 — 바쁜 날 버전, 2분이면 되는 것) (flywheel:: F-1)",
		"- [ ] F-2 마케팅 — (채우기 — 예: 좋은 카피 하나 베껴 쓰기) (flywheel:: F-2)",
		"- [ ] F-3 상품 개발 — (채우기 — 예: 15분 작업) (flywheel:: F-3)",
	]);
	assert.deepEqual(flywheelLines([]), []);
	assert.equal(flywheelPath("12 Flywheel"), "12 Flywheel/Flywheel.md");
	assert.equal(flywheelPath("/12 Flywheel/"), "12 Flywheel/Flywheel.md");
});

test("new-day skeleton with Flywheel lines is byte-identical to new_day.py render()", () => {
	const base = {
		isoDate: "2026-10-24",
		weekday: "토",
		deskCalendarFolder: "03 Desk Calendar",
		sections: ["오늘 할 일", "메모", "로그", "끼적임", "자료"],
	};
	const plain = readFileSync(join(here, "fixtures/new_day-2026-10-24.md"), "utf8");
	assert.equal(dailyPadSkeleton({ ...base, flywheelLines: flywheelLines(parseFlywheel(null)) }), plain, "no Flywheel.md → unchanged skeleton");
	assert.equal(dailyPadSkeleton({ ...base, flywheelLines: [] }), plain);
	assert.equal(
		dailyPadSkeleton({ ...base, flywheelLines: flywheelLines(parseFlywheel(vault)) }),
		readFileSync(join(here, "fixtures/new_day-2026-10-24.flywheel.md"), "utf8"),
	);
	assert.equal(
		dailyPadSkeleton({ ...base, flywheelLines: flywheelLines(parseFlywheel(mixed)) }),
		readFileSync(join(here, "fixtures/new_day-2026-10-24.flywheel-mixed.md"), "utf8"),
	);
});

test("Daily Pad line helpers: flywheel id, missed count", () => {
	const line = "- [ ] F-1 건강 — 걷기 15분 (flywheel:: F-1)";
	assert.equal(flywheelIdOf(line), "F-1");
	assert.equal(isFlywheelLine(line), true);
	assert.equal(missedCount(line), null);
	const missed = "- [ ] F-2 마케팅 — 카피 하나 (flywheel:: F-2) (missed:: 2)";
	assert.equal(flywheelIdOf(missed), "F-2");
	assert.equal(missedCount(missed), 2);
	assert.equal(missedCount("- [ ] F-2 마케팅 (missed:: 3) (flywheel:: F-2)"), 3);
	assert.equal(flywheelIdOf("- [ ] 보고서 쓰기 (goal:: G-2026-01.1)"), null);
	assert.equal(isFlywheelLine("- [ ] 플라이휠 정리 #flywheel"), false);
	assert.equal(flywheelIdOf("- [x] F-3 상품 개발 — 15분 (flywheel::F-3)"), "F-3", "spacing inside the field is loose");
});

test("weeklyDone counts [x] per element across the week's Daily Pad files", () => {
	const day = (f1: string, f2: string) => `# day\n\n## 오늘 할 일\n- [${f1}] F-1 건강 (flywheel:: F-1)\n- [${f2}] F-2 마케팅 (flywheel:: F-2)\n- [x] 다른 일\n`;
	const week = [day("x", " "), day("x", "x"), null, day(" ", " "), day("X", "x"), null, day("x", " ").replace("(flywheel:: F-2)", "(flywheel:: F-2) (missed:: 2)")];
	const done = weeklyDone(week);
	assert.equal(done.get("F-1"), 4, "[X] counts too; missing days do not");
	assert.equal(done.get("F-2"), 2);
	assert.equal(done.get("F-3"), undefined);
	assert.deepEqual([...weeklyDone([null, null]).keys()], []);
	// Two lines for the same element on one day count once.
	assert.equal(weeklyDone(["- [x] F-1 a (flywheel:: F-1)\n- [x] F-1 b (flywheel:: F-1)\n"]).get("F-1"), 1);
	// [>] / [-] are not completions.
	assert.equal(weeklyDone(["- [>] F-1 a (flywheel:: F-1)\n- [-] F-1 b (flywheel:: F-1)\n"]).get("F-1"), undefined);
});
