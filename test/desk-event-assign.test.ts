import { test } from "node:test";
import assert from "node:assert/strict";
import { type MonthData, newMonthSkeleton, parseMonthFile } from "../src/desk/model.ts";
import { copyEvent, isOpenInboxEvent, markEventSent, planAssignEventDay, runPlan } from "../src/desk/ops.ts";
import { addDays } from "../src/parser.ts";
import { type DaySlot, type DeskMoveApi, deskMoveTargets, runDeskTarget } from "../src/desk/mobile-targets.ts";

const TODAY = "2026-11-05";

/** A November file with these 인박스 lines (and optional lines under one day). */
function nov(inbox: string[], day?: { date: string; lines: string[] }): string {
	let t = newMonthSkeleton(2026, 11, "2026-11-01").replace("## 이달 중\n", `## 이달 중\n${inbox.map((l) => l + "\n").join("")}`);
	if (day) t = t.replace(`### ${day.date}\n`, `### ${day.date}\n${day.lines.map((l) => l + "\n").join("")}`);
	return t;
}

function parse(text: string): MonthData {
	return parseMonthFile(text, 2026, 11);
}

function inboxItem(text: string, label: string) {
	return parse(text).during.find((x) => x.item.text === label)!;
}

/** The body lines under `### date`. */
function dayLines(text: string, date: string): string[] {
	const lines = text.split("\n");
	const i = lines.indexOf(`### ${date}`);
	const out: string[] = [];
	for (let j = i + 1; j < lines.length && !lines[j].startsWith("#"); j++) if (lines[j].trim()) out.push(lines[j]);
	return out;
}

test("event assign: copyEvent keeps the plain event line (time, #행사, tags, fields), no checkbox", () => {
	assert.equal(copyEvent("- 동창회 #행사"), "- 동창회 #행사");
	assert.equal(copyEvent("  - 14:00 치과 #회사"), "- 14:00 치과 #회사");
	assert.equal(copyEvent("- 북토크 (from:: Wall Calendar) #행사 #test"), "- 북토크 (from:: Wall Calendar) #행사 #test");
});

test("event assign: markEventSent puts → MM/DD before the trailing tags/fields (moved event)", () => {
	assert.equal(markEventSent("- 동창회 #행사", "11/12"), "- 동창회 → 11/12 #행사");
	assert.equal(markEventSent("- 동창회 #회사 #행사", "11/12"), "- 동창회 → 11/12 #회사 #행사");
	assert.equal(markEventSent("- 14:00 치과", "11/03"), "- 14:00 치과 → 11/03");
});

test("event assign: 인박스 일정 → a day: copy under ### day, 인박스 line becomes a moved event", () => {
	const text = nov(["- [ ] 보고서 쓰기", "- 동창회 #회사 #행사"]);
	const src = inboxItem(text, "동창회");
	assert.ok(isOpenInboxEvent(src));
	const r = runPlan(planAssignEventDay(src, "2026-11-12", TODAY), { "2026-11": text });
	assert.ok(r.ok);
	const out = r.files["2026-11"];
	assert.deepEqual(dayLines(out, "2026-11-12"), ["- 동창회 #회사 #행사"]);
	assert.ok(out.includes("\n- 동창회 → 11/12 #회사 #행사\n"));
	// The task line and the other days are untouched; `updated` moves to today.
	assert.ok(out.includes("\n- [ ] 보고서 쓰기\n"));
	assert.ok(out.includes(`updated: ${TODAY}`));
	const after = parse(out);
	const moved = after.during.find((x) => x.item.text === "동창회")!;
	assert.equal(moved.item.kind, "event");
	assert.equal(moved.item.status, "moved");
	assert.equal(moved.item.movedTo, "11/12");
	assert.deepEqual(moved.problems, []);
	const onDay = after.days.get("2026-11-12")!;
	assert.equal(onDay.length, 1);
	assert.equal(onDay[0].item.kind, "event");
	assert.equal(onDay[0].item.status, "scheduled");
	assert.equal(onDay[0].item.checkbox, null);
	assert.ok(onDay[0].item.tags.includes("회사"));
	// Once sent it is no longer an open 인박스 일정.
	assert.equal(isOpenInboxEvent(moved), false);
});

test("event assign: a timed 인박스 일정 keeps its time on the day; appended after the day's lines", () => {
	const text = nov(["- 15:00 치과 예약"], { date: "2026-11-03", lines: ["- [ ] 장보기"] });
	const r = runPlan(planAssignEventDay(inboxItem(text, "치과 예약"), "2026-11-03", TODAY), { "2026-11": text });
	assert.ok(r.ok);
	assert.deepEqual(dayLines(r.files["2026-11"], "2026-11-03"), ["- [ ] 장보기", "- 15:00 치과 예약"]);
	assert.ok(r.files["2026-11"].includes("\n- 15:00 치과 예약 → 11/03\n"));
});

test("event assign: the same open event already on that day is not copied twice (the 인박스 line is still marked)", () => {
	const text = nov(["- 동창회 #행사"], { date: "2026-11-12", lines: ["- 동창회 #행사"] });
	const r = runPlan(planAssignEventDay(inboxItem(text, "동창회"), "2026-11-12", TODAY), { "2026-11": text });
	assert.ok(r.ok);
	assert.deepEqual(dayLines(r.files["2026-11"], "2026-11-12"), ["- 동창회 #행사"]);
	assert.ok(r.files["2026-11"].includes("\n- 동창회 → 11/12 #행사\n"));
});

test("event assign: a day in the next month's file is written there; the 인박스 file gets the arrow", () => {
	const novText = nov(["- 송년회 #행사"]);
	const dec = newMonthSkeleton(2026, 12, "2026-11-01");
	const r = runPlan(planAssignEventDay(inboxItem(novText, "송년회"), "2026-12-01", TODAY), { "2026-11": novText, "2026-12": dec });
	assert.ok(r.ok);
	assert.ok(r.files["2026-11"].includes("\n- 송년회 → 12/01 #행사\n"));
	assert.deepEqual(dayLines(r.files["2026-12"], "2026-12-01"), ["- 송년회 #행사"]);
});

test("event assign: stale line or missing day fails without writing", () => {
	const text = nov(["- 동창회 #행사"]);
	const src = inboxItem(text, "동창회");
	const changed = text.replace("- 동창회 #행사", "- 동창회 (장소 변경) #행사");
	const r1 = runPlan(planAssignEventDay(src, "2026-11-12", TODAY), { "2026-11": changed });
	assert.equal(r1.ok, false);
	const noDay = text.replace("### 2026-11-12\n", "");
	const r2 = runPlan(planAssignEventDay(src, "2026-11-12", TODAY), { "2026-11": noDay });
	assert.deepEqual(r2, { ok: false, file: "2026-11", reason: "section-missing" });
});

test("event assign: only open plain 인박스 events qualify (not tasks, notes, moved or cancelled events)", () => {
	const text = nov(["- [ ] 보고서 쓰기", "- 그냥 메모", "- 지난 행사 → 11/02 #행사", "- ~~취소된 행사~~ #행사", "- 동창회 #행사"]);
	const d = parse(text).during;
	const open = d.filter(isOpenInboxEvent).map((x) => x.item.text);
	assert.deepEqual(open, ["동창회"]);
	const task = d.find((x) => x.item.text === "보고서 쓰기")!;
	const r = runPlan(planAssignEventDay(task, "2026-11-12", TODAY), { "2026-11": text });
	assert.equal(r.ok, false);
});

test("event assign (phone): an 인박스 일정's targets are the existing days, run as assignEventDay", async () => {
	const mondays = ["2026-10-26", "2026-11-02"];
	const days: DaySlot[] = mondays.flatMap((m) => Array.from({ length: 7 }, (_, i) => addDays(m, i))).map((iso) => ({ iso, exists: iso.startsWith("2026-11") }));
	const t = deskMoveTargets({ kind: "during", open: false, event: true, assignWeek: [], assign: [], monday: null, date: null }, [{ monday: "2026-11-02", no: 45, fileKey: "2026-11", hasAlloc: true }], days);
	assert.deepEqual(
		t.map((x) => [x.op, "iso" in x ? x.iso : null]),
		Array.from({ length: 8 }, (_, i) => ["eventDay", addDays("2026-11-01", i)]),
	);
	const calls: unknown[][] = [];
	const api: DeskMoveApi<string> = {
		assignWeek: async () => void calls.push(["assignWeek"]),
		unassign: async () => void calls.push(["unassign"]),
		assignDay: async () => void calls.push(["assignDay"]),
		moveToDay: async () => void calls.push(["moveToDay"]),
		assignEventDay: async (...a) => void calls.push(["assignEventDay", ...a]),
	};
	await runDeskTarget(t[3], "동창회", api);
	assert.deepEqual(calls, [["assignEventDay", "동창회", "2026-11-04"]]);
});
