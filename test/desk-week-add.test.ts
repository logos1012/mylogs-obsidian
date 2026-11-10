import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isoWeekNo, parseMonthFile } from "../src/desk/model.ts";
import { inboxShown, isAssignedInbox, isUnassignedInbox, planAddDuring, planAddWeekTask, planAssignEventDay, planAssignWeek, runPlan } from "../src/desk/ops.ts";
import { addToWeekChecked, INBOX_CONFLICT_NOTICE } from "../src/desk/inbox-add.ts";
import type { BatchIO } from "../src/pinboard/batch.ts";

// Desk 주 칸 「+ 추가」 and the 인박스 「배정된 일」 filter. Fictional data only.

const here = dirname(fileURLToPath(import.meta.url));
const NOV = readFileSync(join(here, "fixtures/desk/2026-11.md"), "utf8");
const OCT = readFileSync(join(here, "fixtures/desk/2026-10.md"), "utf8");
const TODAY = "2026-11-05";
const W45 = "2026-11-02";
const W44 = "2026-10-26"; // its 이번 주 is in the October file

/** What the drag does: 인박스 add, then the drag-assign of that new line. */
function viaDrag(text: string, monday: string, allocFile: string, side: "개인" | "회사", files: Record<string, string>) {
	const a = runPlan(planAddDuring("2026-11", text, "task", side, TODAY), { "2026-11": files["2026-11"] });
	assert.ok(a.ok);
	const all = { ...files, ...a.files };
	const src = parseMonthFile(all["2026-11"], 2026, 11).during.at(-1)!;
	const b = runPlan(planAssignWeek(src, monday, isoWeekNo(monday), allocFile, TODAY), all);
	assert.ok(b.ok);
	return { ...all, ...b.files };
}

test("주 칸 추가 (같은 달): the same bytes as 인박스 추가 + drag onto W45", () => {
	const r = runPlan(planAddWeekTask("2026-11", W45, "2026-11", "보험 서류 정리", "개인", TODAY), { "2026-11": NOV });
	assert.ok(r.ok);
	assert.deepEqual(Object.keys(r.files), ["2026-11"], "one file, one write");
	const out = r.files["2026-11"];
	assert.equal(out, viaDrag("보험 서류 정리", W45, "2026-11", "개인", { "2026-11": NOV })["2026-11"]);
	assert.match(out, /#test\n- \[ \] 보험 서류 정리 → W45\n\n## W44/);
	assert.match(out, /- \[ \] 호텔 헬스장 운동 \(goal:: G-2026-02\.1\) #test\n- \[ \] 보험 서류 정리\n\n### 2026-11-02/);
	assert.equal(out.split("\n").length, NOV.split("\n").length + 2);
	const data = parseMonthFile(out, 2026, 11);
	const inbox = data.during.at(-1)!;
	assert.deepEqual(inbox.item.assignWeek, [45]);
	assert.ok(data.weeks.get(W45)!.alloc!.some((x) => x.key === inbox.key && x.item.status === "scheduled"));
});

test("주 칸 추가 회사 mode: #회사 after the arrow on the 인박스 line, kept on the copy", () => {
	const r = runPlan(planAddWeekTask("2026-11", W45, "2026-11", "거래처 견적", "회사", TODAY), { "2026-11": NOV });
	assert.ok(r.ok);
	assert.match(r.files["2026-11"], /\n- \[ \] 거래처 견적 → W45 #회사\n/);
	assert.match(r.files["2026-11"], /\n- \[ \] 거래처 견적 #회사\n\n### 2026-11-02/);
	assert.equal(r.files["2026-11"], viaDrag("거래처 견적", W45, "2026-11", "회사", { "2026-11": NOV })["2026-11"]);
});

test("주 칸 추가 (다른 달): 인박스 in November, the copy in October's W44", () => {
	const r = runPlan(planAddWeekTask("2026-11", W44, "2026-10", "연말 선물 목록", "개인", TODAY), { "2026-11": NOV, "2026-10": OCT });
	assert.ok(r.ok);
	assert.deepEqual(Object.keys(r.files).sort(), ["2026-10", "2026-11"]);
	assert.match(r.files["2026-11"], /\n- \[ \] 연말 선물 목록 → W44\n\n## W44/);
	assert.match(r.files["2026-10"], /- \[ \] 연말정산 서류 미리 모으기 #test\n- \[ \] 연말 선물 목록\n\n### 2026-10-26/);
	assert.match(r.files["2026-10"], /updated: 2026-11-05/);
	const drag = viaDrag("연말 선물 목록", W44, "2026-10", "개인", { "2026-11": NOV, "2026-10": OCT });
	assert.equal(r.files["2026-11"], drag["2026-11"]);
	assert.equal(r.files["2026-10"], drag["2026-10"]);
});

test("주 칸 추가: refused for empty text, duplicate in the 인박스, missing sections", () => {
	const reason = (p: ReturnType<typeof planAddWeekTask>, files: Record<string, string> = { "2026-11": NOV }) => {
		const r = runPlan(p, files);
		return r.ok ? "ok" : r.reason;
	};
	assert.equal(reason(planAddWeekTask("2026-11", W45, "2026-11", "   ", "개인", TODAY)), "empty-text");
	assert.equal(reason(planAddWeekTask("2026-11", W45, "2026-11", "혼팀 연말 이벤트 기획안", "개인", TODAY)), "duplicate");
	assert.equal(reason(planAddWeekTask("2026-11", W45, "2026-11", "X", "개인", TODAY), { "2026-11": NOV.replace("## 이달 중\n", "") }), "section-missing");
	// W45 without its 이번 주 box.
	const noBox = NOV.replace("### 이번 주\n- [ ] 강의 5강 촬영", "- [ ] 강의 5강 촬영");
	assert.equal(reason(planAddWeekTask("2026-11", W45, "2026-11", "X", "개인", TODAY), { "2026-11": noBox }), "section-missing");
	// W44's box is not in the November file.
	assert.equal(reason(planAddWeekTask("2026-11", W44, "2026-11", "X", "개인", TODAY)), "section-missing");
	assert.equal(reason(planAddWeekTask("2026-11", W44, "2026-10", "X", "개인", TODAY)), "file-missing");
});

// ───────── checked write ─────────

const MONTH = "Desk/2026/2026-11.md";
const PREV = "Desk/2026/2026-10.md";
const INDEX = "Desk/Desk Calendar Index.md";
const IDX = "---\nupdated: 2026-11-01\n---\n\n## 변경 기록\n\n- 2026-11-01: 이전 기록 (플러그인)\n";

function memory(initial: Record<string, string>) {
	const files = new Map(Object.entries(initial));
	const writes: string[] = [];
	const io: BatchIO = {
		read: async (p) => files.get(p) ?? null,
		create: async (p, t) => {
			if (files.has(p)) throw Error("exists");
			files.set(p, t);
			writes.push(p);
		},
		compareWrite: async (p, b, a) => {
			if (files.get(p) !== b) throw Error(`동시 변경: ${p}`);
			files.set(p, a);
			writes.push(p);
		},
		trashIfUnchanged: async (p, t) => {
			if (files.get(p) !== t) throw Error(`동시 변경: ${p}`);
			files.delete(p);
		},
	};
	return { files, writes, io };
}

const sameMonth = (io: BatchIO, text = "보험 서류 정리") => addToWeekChecked(io, { month: MONTH, alloc: MONTH, index: INDEX }, "2026-11", W45, "2026-11", text, "개인", TODAY);
const crossMonth = (io: BatchIO, text = "연말 선물 목록") => addToWeekChecked(io, { month: MONTH, alloc: PREV, index: INDEX }, "2026-11", W44, "2026-10", text, "개인", TODAY);

test("checked 주 칸 추가, same file: one month write + the index log", async () => {
	const m = memory({ [MONTH]: NOV, [INDEX]: IDX });
	const r = await sameMonth(m.io);
	assert.ok(r.ok);
	assert.deepEqual(m.writes, [MONTH, INDEX]);
	const plain = runPlan(planAddWeekTask("2026-11", W45, "2026-11", "보험 서류 정리", "개인", TODAY), { "2026-11": NOV });
	assert.ok(plain.ok);
	assert.equal(m.files.get(MONTH), plain.files["2026-11"]);
	assert.match(m.files.get(INDEX)!, /- 2026-11-05: 이번 주 할 일에 추가: 「보험 서류 정리」 → W45 \(플러그인\)\n- 2026-11-01/);
});

test("checked 주 칸 추가, two months: both files and the index in one batch", async () => {
	const m = memory({ [MONTH]: NOV, [PREV]: OCT, [INDEX]: IDX });
	const r = await crossMonth(m.io);
	assert.ok(r.ok);
	assert.deepEqual([...m.writes].sort(), [INDEX, PREV, MONTH].sort());
	assert.match(m.files.get(MONTH)!, /- \[ \] 연말 선물 목록 → W44\n/);
	assert.match(m.files.get(PREV)!, /- \[ \] 연말 선물 목록\n\n### 2026-10-26/);
	// The October file missing: nothing written.
	const n = memory({ [MONTH]: NOV, [INDEX]: IDX });
	const miss = await crossMonth(n.io);
	assert.equal(miss.ok ? "ok" : miss.reason, "file-missing");
	assert.deepEqual(n.writes, []);
});

test("checked 주 칸 추가: the week's file changed after the read → conflict, nothing written", async () => {
	const m = memory({ [MONTH]: NOV, [PREV]: OCT, [INDEX]: IDX });
	const edited = OCT + "\n- Hermes가 넣은 줄\n";
	let reads = 0;
	const read = m.io.read;
	m.io.read = async (p) => {
		const t = await read(p);
		if (p === PREV && ++reads === 1) m.files.set(PREV, edited);
		return t;
	};
	const r = await crossMonth(m.io);
	assert.deepEqual(r, { ok: false, reason: "conflict" });
	assert.equal(m.files.get(PREV), edited);
	assert.equal(m.files.get(MONTH), NOV);
	assert.equal(m.files.get(INDEX), IDX);
	assert.deepEqual(m.writes, []);
	assert.match(INBOX_CONFLICT_NOTICE, /취소했어요/);
});

test("checked 주 칸 추가: index changed inside the batch → month writes rolled back, conflict", async () => {
	const m = memory({ [MONTH]: NOV, [PREV]: OCT, [INDEX]: IDX });
	const cw = m.io.compareWrite;
	m.io.compareWrite = async (p, b, a) => {
		if (p === INDEX && b === IDX) m.files.set(INDEX, IDX + "- 다른 기록\n");
		return cw(p, b, a);
	};
	const r = await crossMonth(m.io);
	assert.equal(r.ok ? "ok" : r.reason, "conflict");
	assert.equal(m.files.get(MONTH), NOV);
	assert.equal(m.files.get(PREV), OCT);
	assert.equal(m.files.get(INDEX), IDX + "- 다른 기록\n");
});

test("checked 주 칸 추가: refusals from the fresh read write nothing", async () => {
	const m = memory({ [MONTH]: NOV, [INDEX]: IDX });
	assert.equal(((r) => (r.ok ? "ok" : r.reason))(await sameMonth(m.io, "혼팀 연말 이벤트 기획안")), "duplicate");
	assert.equal(((r) => (r.ok ? "ok" : r.reason))(await sameMonth(m.io, " ")), "empty-text");
	assert.deepEqual(m.writes, []);
});

// ───────── 인박스: 배정된 줄 숨김 (화면만) ─────────

const INBOX = `---
updated: 2026-11-01
---

## 이달 중
- [ ] 아직 안 정한 일
- [ ] 주에 넣은 일 → W45
- [x] 주에 넣고 끝낸 일 → W45
- [x] 바로 끝낸 일
- [-] 놓아준 일 (why:: 안 함)
- 동창회 #행사
- 집들이 → 11/12 #행사
- 그냥 메모

## W45 (11/02~11/08)

### 이번 주
- [ ] 주에 넣은 일
`;

test("isUnassignedInbox = 주 보기's 인박스 list: open 할 일 not in a week, or an open 인박스 일정", () => {
	const during = parseMonthFile(INBOX, 2026, 11).during;
	assert.deepEqual(during.filter(isUnassignedInbox).map((x) => x.item.text), ["아직 안 정한 일", "동창회"]);
});

test("isAssignedInbox / inboxShown: → Wnn 할 일 and → MM/DD 일정 leave the month list unless shown", () => {
	const during = parseMonthFile(INBOX, 2026, 11).during;
	assert.deepEqual(during.filter(isAssignedInbox).map((x) => x.item.text), ["주에 넣은 일", "주에 넣고 끝낸 일", "집들이"]);
	const off = inboxShown(during, false);
	assert.equal(off.hidden, 3);
	assert.deepEqual(off.shown.map((x) => x.item.text), ["아직 안 정한 일", "바로 끝낸 일", "놓아준 일", "동창회", "그냥 메모"]);
	const on = inboxShown(during, true);
	assert.equal(on.hidden, 0);
	assert.equal(on.shown.length, during.length);
	// Only assigned lines: the list is empty (plus the count).
	const onlyAssigned = parseMonthFile("## 이달 중\n- [ ] A → W45\n- B → 11/03 #행사\n", 2026, 11).during;
	assert.deepEqual(inboxShown(onlyAssigned, false), { shown: [], hidden: 2 });
});

test("a 일정 sent to a day by planAssignEventDay counts as assigned; a 주 칸 추가 line too", () => {
	const add = runPlan(planAddDuring("2026-11", "동창 모임", "event", "개인", TODAY), { "2026-11": NOV });
	assert.ok(add.ok);
	const src = parseMonthFile(add.files["2026-11"], 2026, 11).during.at(-1)!;
	assert.equal(isAssignedInbox(src), false);
	const sent = runPlan(planAssignEventDay(src, "2026-11-06", TODAY), add.files);
	assert.ok(sent.ok);
	const after = parseMonthFile(sent.files["2026-11"], 2026, 11).during.at(-1)!;
	assert.equal(isAssignedInbox(after), true);
	const wk = runPlan(planAddWeekTask("2026-11", W45, "2026-11", "보험 서류 정리", "개인", TODAY), { "2026-11": NOV });
	assert.ok(wk.ok);
	assert.equal(isAssignedInbox(parseMonthFile(wk.files["2026-11"], 2026, 11).during.at(-1)!), true);
});
