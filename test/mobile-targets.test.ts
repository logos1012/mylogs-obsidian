import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays } from "../src/parser.ts";
import { dayInMonth, defaultDay, type DeskMoveApi, type DeskMoveItem, deskMoveTargets, runDeskTarget, type DaySlot, type WeekSlot } from "../src/desk/mobile-targets.ts";

/** A recording fake of the calls the desktop drop zones make. */
function recorder<I>() {
	const calls: unknown[][] = [];
	const api: DeskMoveApi<I> = {
		assignWeek: async (...a) => void calls.push(["assignWeek", ...a]),
		unassign: async (...a) => void calls.push(["unassign", ...a]),
		assignDay: async (...a) => void calls.push(["assignDay", ...a]),
		moveToDay: async (...a) => void calls.push(["moveToDay", ...a]),
	};
	return { api, calls };
}

// 2026-10: weeks start 09-28, 10-05, 10-12, 10-19, 10-26 (W40–W44).
const MONDAYS = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"];
const weeks: WeekSlot[] = MONDAYS.map((monday, i) => ({ monday, no: 40 + i, fileKey: monday.slice(0, 7), hasAlloc: monday !== "2026-09-28" }));
const days: DaySlot[] = MONDAYS.flatMap((m) => Array.from({ length: 7 }, (_, i) => addDays(m, i))).map((iso) => ({ iso, exists: iso.startsWith("2026-10") }));

const base: DeskMoveItem = { kind: "during", open: true, assignWeek: [], assign: [], monday: null, date: null };

test("desk targets: 이달 중 → every week box that exists and is not yet assigned (renderAllocCell accepts)", () => {
	const t = deskMoveTargets({ ...base, assignWeek: [42] }, weeks, days);
	assert.deepEqual(
		t.map((x) => [x.op, x.op === "assignWeek" ? x.no : null]),
		[
			["assignWeek", 41],
			["assignWeek", 43],
			["assignWeek", 44],
		],
	);
});

test("desk targets: 이번 주 할 일 → the days of its own week not yet assigned (renderDayCell accepts)", () => {
	const t = deskMoveTargets({ ...base, kind: "alloc", monday: "2026-10-12", assign: ["2026-10-13"] }, weeks, days);
	assert.deepEqual(
		t.map((x) => (x.op === "assignDay" ? x.iso : x.op)),
		["2026-10-12", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"],
	);
});

test("desk targets: a day line → its week box (배정 취소) and every other existing day", () => {
	const t = deskMoveTargets({ ...base, kind: "day", monday: "2026-10-12", date: "2026-10-14" }, weeks, days);
	assert.equal(t.filter((x) => x.op === "unassign").length, 1);
	const un = t.find((x) => x.op === "unassign");
	assert.ok(un && un.op === "unassign" && un.monday === "2026-10-12" && un.fileKey === "2026-10");
	const moves = t.filter((x) => x.op === "moveDay").map((x) => (x.op === "moveDay" ? x.iso : ""));
	assert.equal(moves.length, 30, "31 October days minus its own; September days have no section");
	assert.ok(!moves.includes("2026-10-14"));
	assert.ok(!moves.some((d) => d.startsWith("2026-09") || d.startsWith("2026-11")));
});

test("desk targets: no week box → no assignWeek / unassign; not an open task → nothing", () => {
	const noBox = weeks.map((w) => ({ ...w, hasAlloc: false }));
	assert.deepEqual(deskMoveTargets(base, noBox, days), []);
	assert.equal(deskMoveTargets({ ...base, kind: "day", monday: "2026-10-12", date: "2026-10-14" }, noBox, days).some((x) => x.op === "unassign"), false);
	assert.deepEqual(deskMoveTargets({ ...base, open: false }, weeks, days), []);
	assert.deepEqual(deskMoveTargets({ ...base, kind: "day", open: false, monday: "2026-10-12", date: "2026-10-14" }, weeks, days), []);
});

test("desk targets: each target runs the call its drop zone makes, with the same arguments", async () => {
	const item = { id: "x" };
	const { api, calls } = recorder<typeof item>();
	const during = deskMoveTargets(base, weeks, days)[0];
	const alloc = deskMoveTargets({ ...base, kind: "alloc", monday: "2026-10-12" }, weeks, days)[0];
	const day = deskMoveTargets({ ...base, kind: "day", monday: "2026-10-12", date: "2026-10-14" }, weeks, days);
	for (const t of [during, alloc, ...day.filter((x) => x.op === "unassign"), day.find((x) => x.op === "moveDay")!]) await runDeskTarget(t, item, api);
	assert.deepEqual(calls, [
		["assignWeek", item, "2026-10-05", 41, "2026-10"],
		["assignDay", item, "2026-10-12"],
		["unassign", item, "2026-10-12", "2026-10"],
		["moveToDay", item, "2026-10-01"],
	]);
});

test("desk day page: default day and clamping into a month", () => {
	assert.equal(defaultDay("2026-10", "2026-10-26"), "2026-10-26");
	assert.equal(defaultDay("2026-11", "2026-10-26"), "2026-11-01");
	assert.equal(dayInMonth("2026-02", "2026-01-31"), "2026-02-28");
	assert.equal(dayInMonth("2026-03", "2026-02-15"), "2026-03-15");
	assert.equal(dayInMonth("2026-10", "2026-10-09"), "2026-10-09");
});

// ── Drawer ──

import { candidateTargets, type DrawerMoveApi, drawerItemTargets, runCandidateTarget, runDrawerTarget } from "../src/drawer/mobile-targets.ts";

function drawerRecorder() {
	const calls: unknown[][] = [];
	const api: DrawerMoveApi<string, string> = {
		moveToSection: async (...a) => void calls.push(["moveToSection", ...a]),
		takeOut: async (...a) => void calls.push(["takeOut", ...a]),
		letGo: async (...a) => void calls.push(["letGo", ...a]),
		acceptCand: async (...a) => void calls.push(["acceptCand", ...a]),
		dropCand: async (...a) => void calls.push(["dropCand", ...a]),
	};
	return { api, calls };
}

test("drawer targets: a card → the other two columns, the four 꺼내기 targets, 놓아주기 (the dock)", () => {
	const t = drawerItemTargets({ section: "아이디어", active: true }, "2026-10");
	assert.deepEqual(
		t.map((x) => (x.op === "section" ? `section:${x.section}` : x.op === "take" ? `take:${x.take}` : x.op)),
		["section:보류", "section:프로젝트 후보", "take:today", "take:month", "take:wall", "take:project", "letgo"],
	);
	assert.deepEqual(drawerItemTargets({ section: "보류", active: false }, "2026-10"), [], "departed lines go nowhere");
});

test("drawer targets: each card target runs the drop zone's call", async () => {
	const { api, calls } = drawerRecorder();
	for (const t of drawerItemTargets({ section: "보류", active: true }, "2026-10")) await runDrawerTarget(t, "item", api);
	assert.deepEqual(calls, [
		["moveToSection", "item", "아이디어"],
		["moveToSection", "item", "프로젝트 후보"],
		["takeOut", "item", "today"],
		["takeOut", "item", "month"],
		["takeOut", "item", "wall"],
		["takeOut", "item", "project"],
		["letGo", "item"],
	]);
});

test("drawer targets: a 후보 → any column (acceptCand with that section) or 놓아주기 (dropCand)", async () => {
	const { api, calls } = drawerRecorder();
	const t = candidateTargets("프로젝트 후보");
	assert.equal(t.find((x) => x.op === "accept" && x.section === "프로젝트 후보")?.sub, "기본 섹션");
	for (const x of t) await runCandidateTarget(x, "cand", api);
	assert.deepEqual(calls, [
		["acceptCand", "cand", "보류"],
		["acceptCand", "cand", "아이디어"],
		["acceptCand", "cand", "프로젝트 후보"],
		["dropCand", "cand"],
	]);
});
