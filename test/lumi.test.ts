import { test } from "node:test";
import assert from "node:assert/strict";
import { carriedFrom, sessionId, sessionPath, sessionText, splitChoices, titleFrom, upsertIndexRow, type LumiTurn } from "../src/lumi/session.ts";

// 루미 sessions follow 10 Archive Box AGENTS 「3」. Fictional data only (김하루).
const turns: LumiTurn[] = [
	{ role: "user", text: "운동 습관 목표를 세우고 싶어", at: "2026-10-28T23:58:10" },
	{ role: "lumi", text: "좋아요! 무엇이 달라지나요?\n선택지: 건강 / 체력", at: "2026-10-28T23:58:30" },
	{ role: "user", text: "체력", at: "2026-10-29T00:01:05" },
	{ role: "lumi", text: "", at: "2026-10-29T00:01:06" },
];

test("session file: name, id, frontmatter, day-change stamps, empty turns skipped", () => {
	const title = titleFrom(turns[0].text);
	assert.equal(title, "운동 습관 목표를 세우고 싶어");
	assert.equal(titleFrom('a/b:c*d?"e<f>g|h'), "a b c d e f g h");
	assert.equal(sessionPath("10 Archive Box/Sessions", turns[0].at, title), "10 Archive Box/Sessions/2026/2026-10-28 2358 운동 습관 목표를 세우고 싶어.md");
	assert.equal(sessionId(turns[0].at), "S-2026-10-28-235810");
	const t = sessionText({ id: "S-2026-10-28-235810", sourceId: "lumi-claude-abc", tool: "claude-code", title }, turns, { tornOffUntil: "", routedTo: [], project: "" });
	assert.match(t, /^---\ntype: session\nid: S-2026-10-28-235810\nsource_id: lumi-claude-abc\ndate: 2026-10-28\nlast: 2026-10-29\ntool: claude-code\nchannel: app\nkind: chat\n/);
	assert.match(t, /turns: 3\n/);
	assert.match(t, /torn_off: false\nrouted_to: \[\]\nsaved_by: mylogs-lumi/);
	assert.match(t, /---\n\*\*사용자 · 23:58\*\*\n\n운동 습관 목표를 세우고 싶어\n/);
	assert.match(t, /\*\*사용자 · 10-29 00:01\*\*\n\n체력/);
	assert.ok(!t.includes("**AI · 10-29"), "an empty answer is not written");
});

test("rewrite keeps what Tear-off wrote (torn_off_until, routed_to, project)", () => {
	const old = sessionText({ id: "S-1", sourceId: "lumi-codex-x", tool: "codex", title: "t" }, turns.slice(0, 2), { tornOffUntil: "2026-10-28T23:58:30", routedTo: ["2026-10-28: My Life Daily", "2026-10-28: Drawer 보류"], project: "P-run" });
	const c = carriedFrom(old);
	assert.deepEqual(c, { tornOffUntil: "2026-10-28T23:58:30", routedTo: ["2026-10-28: My Life Daily", "2026-10-28: Drawer 보류"], project: "P-run" });
	assert.match(old, /torn_off: true/);
	assert.match(sessionText({ id: "S-1", sourceId: "lumi-codex-x", tool: "codex", title: "t" }, turns, c), /torn_off: false/, "new messages after the cursor reopen it");
	assert.deepEqual(carriedFrom("---\ntype: session\nrouted_to:\n  - \"2026-10-27: Desk 10/28\"\n---\n").routedTo, ["2026-10-27: Desk 10/28"]);
});

test("Sessions Index row is added once, then replaced by source_id", () => {
	const INDEX = "---\ntype: index\n---\n\n| id | source_id | date | last | title | kind | tool | turns | torn_off_until | torn_off | routed_to |\n|---|---|---|---|---|---|---|---|---|---|---|\n| S-0 | `old` | 2026-10-01 | 2026-10-01 | x | chat | hermes | 2 |  | false |  |\n\n## 변경 기록\n";
	const meta = { id: "S-2026-10-28-235810", sourceId: "lumi-claude-abc", tool: "claude-code" as const, title: "운동 습관" };
	const a = upsertIndexRow(INDEX, meta, "10 Archive Box/Sessions/2026/2026-10-28 2358 운동 습관.md", turns.slice(0, 2), { tornOffUntil: "", routedTo: [], project: "" });
	assert.match(a, /\| S-0 .*\n\| S-2026-10-28-235810 \| `lumi-claude-abc` \| 2026-10-28 \| 2026-10-28 \| \[\[10 Archive Box\/Sessions\/2026\/2026-10-28 2358 운동 습관\\\|운동 습관\]\] \| chat \| claude-code \| 2 \|/);
	const b = upsertIndexRow(a, meta, "10 Archive Box/Sessions/2026/2026-10-28 2358 운동 습관.md", turns, { tornOffUntil: "", routedTo: [], project: "" });
	assert.equal(b.split("lumi-claude-abc").length, 2, "one row");
	assert.match(b, /\| 2026-10-28 \| 2026-10-29 \|/);
});

test("선택지 line becomes quick replies", () => {
	assert.deepEqual(splitChoices("무엇이 달라지나요?\n선택지: 건강해져요 / 체력이 늘어요 / 직접 쓸게요"), { body: "무엇이 달라지나요?", choices: ["건강해져요", "체력이 늘어요", "직접 쓸게요"] });
	assert.deepEqual(splitChoices("**선택지**: 예 | 아니오").choices, ["예", "아니오"]);
	assert.deepEqual(splitChoices("그냥 답변").choices, []);
});

test("a saved session reopens: turns, engine thread, model", async () => {
	const { parseSession } = await import("../src/lumi/session.ts");
	const text = sessionText({ id: "S-1", sourceId: "lumi-codex-th1", tool: "codex", title: "운동 습관", engineSession: "th1", model: "gpt-6-astra" }, turns, { tornOffUntil: "", routedTo: [], project: "" });
	const o = parseSession(text);
	assert.equal(o.engine, "codex");
	assert.equal(o.engineSession, "th1");
	assert.equal(o.model, "gpt-6-astra");
	assert.equal(o.title, "운동 습관");
	assert.deepEqual(o.turns.map((t) => [t.role, t.text, t.at]), [
		["user", "운동 습관 목표를 세우고 싶어", "2026-10-28T23:58:00"],
		["lumi", "좋아요! 무엇이 달라지나요?\n선택지: 건강 / 체력", "2026-10-28T23:58:00"],
		["user", "체력", "2026-10-29T00:01:00"],
	]);
});

test("session file: an empty field never swallows the next line; saving again and again keeps body and cursor", () => {
	const meta = { id: "lumi-x", sourceId: "lumi-x", title: "목표 세우기", tool: "claude", engineSession: null, model: null } as never;
	const turns = [{ role: "user", text: "안녕", at: "2026-10-29T09:00:00" }, { role: "assistant", text: "네", at: "2026-10-29T09:00:05" }] as never;
	let text = sessionText(meta, turns, carriedFrom(null));
	assert.match(text, /^project: \nturns: 2$/m);
	for (let i = 0; i < 3; i++) text = sessionText(meta, turns, carriedFrom(text));
	assert.match(text, /^project: \nturns: 2$/m);
	assert.match(text, /^torn_off_until: \ntorn_off: false$/m);
	// Hermes's cursor (quoted, with a timezone) survives.
	const done = text.replace(/^torn_off_until: $/m, "torn_off_until: '2026-10-29T09:30:00+09:00'");
	assert.equal(carriedFrom(done).tornOffUntil, "2026-10-29T09:30:00+09:00");
	assert.match(sessionText(meta, turns, carriedFrom(done)), /^torn_off: true$/m);
	// Old damage heals: `project: turns: 2`, `torn_off_until: torn_off: false`.
	const broken = text.replace(/^project: $/m, "project: turns: 2").replace(/^torn_off_until: $/m, "torn_off_until: torn_off: false");
	const c = carriedFrom(broken);
	assert.equal(c.project, "");
	assert.equal(c.tornOffUntil, "");
	assert.match(sessionText(meta, turns, c), /^project: \nturns: 2$/m);
});
