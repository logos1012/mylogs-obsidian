import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseMonthFile } from "../src/desk/model.ts";
import { inboxLine, planAddDuring, runPlan } from "../src/desk/ops.ts";
import { formatNewLine } from "../src/wall/edit.ts";
import { addToInboxChecked, INBOX_CONFLICT_NOTICE } from "../src/desk/inbox-add.ts";
import type { BatchIO } from "../src/pinboard/batch.ts";

// Desk Calendar 인박스(`## 이달 중`)에 직접 추가. Fictional data only.

const here = dirname(fileURLToPath(import.meta.url));
const NOV = readFileSync(join(here, "fixtures/desk/2026-11.md"), "utf8");
const TODAY = "2026-11-05";

function add(text: string, kind: "task" | "event", side: "개인" | "회사" = "개인", file = NOV) {
	return runPlan(planAddDuring("2026-11", text, kind, side, TODAY), { "2026-11": file });
}

/** Lines that differ between two texts (same line count + 1 expected). */
function diff(a: string, b: string): { removed: string[]; added: string[] } {
	const al = a.split("\n");
	const bl = b.split("\n");
	return { removed: al.filter((l) => !bl.includes(l)), added: bl.filter((l) => !al.includes(l)) };
}

test("inboxLine: the same format as the other undated lines (formatNewLine, 루미 schedule_add)", () => {
	assert.equal(inboxLine("  보험 서류 정리  ", "task", "개인"), "- [ ] 보험 서류 정리");
	assert.equal(inboxLine("보험 서류 정리", "task", "회사"), "- [ ] 보험 서류 정리 #회사");
	assert.equal(inboxLine("동창 모임", "event", "개인"), "- 동창 모임 #행사");
	assert.equal(inboxLine("거래처 저녁", "event", "회사"), "- 거래처 저녁 #회사 #행사");
	assert.equal(inboxLine("동창 모임 #행사", "event", "개인"), "- 동창 모임 #행사", "#행사 is not doubled");
	assert.equal(inboxLine("- [ ] 붙여넣은\n줄", "task", "개인"), "- [ ] 붙여넣은 줄", "list marker dropped, one line");
	assert.equal(inboxLine("회의 준비 #회사", "task", "개인"), "- [ ] 회의 준비", "개인 mode drops #회사 (setSide)");
	assert.equal(inboxLine("   ", "task", "개인"), "");
	// Byte-identical to the Wall Calendar / 루미 formatter for an undated item.
	assert.equal(inboxLine("동창 모임", "event", "개인"), formatNewLine({ kind: "event", text: "동창 모임" }));
	assert.equal(inboxLine("보험 서류 정리", "task", "개인"), formatNewLine({ kind: "task", text: "보험 서류 정리" }));
});

test("할 일: one line at the end of ## 이달 중 (before ## W44), only `updated` changes besides", () => {
	const r = add("보험 서류 정리", "task");
	assert.ok(r.ok);
	const out = r.files["2026-11"];
	assert.match(out, /- \[ \] 혼팀 연말 이벤트 기획안 \(goal:: G-2026-03\.1\) #test\n- \[ \] 보험 서류 정리\n\n## W44/);
	const d = diff(NOV, out);
	assert.deepEqual(d.removed, ["updated: 2026-10-24"]);
	assert.deepEqual(d.added, ["updated: 2026-11-05", "- [ ] 보험 서류 정리"]);
	assert.equal(out.split("\n").length, NOV.split("\n").length + 1);
	const it = parseMonthFile(out, 2026, 11).during.at(-1)!;
	assert.equal(it.section, "during");
	assert.equal(it.item.kind, "task");
	assert.equal(it.item.text, "보험 서류 정리");
	assert.deepEqual(it.problems, []);
});

test("일정: `- 내용 #행사`, read back as an event of the 인박스; 회사 mode adds #회사", () => {
	const r = add("거래처 저녁", "event", "회사");
	assert.ok(r.ok);
	const it = parseMonthFile(r.files["2026-11"], 2026, 11).during.at(-1)!;
	assert.equal(it.line, "- 거래처 저녁 #회사 #행사");
	assert.equal(it.item.kind, "event");
	assert.ok(it.item.tags.includes("회사"));
});

test("empty 인박스, CRLF file, file without a final newline", () => {
	const empty = "---\nupdated: 2026-11-01\n---\n\n## 이달 중\n\n## W45 (11/02~11/08)\n";
	const r1 = add("A", "task", "개인", empty);
	assert.ok(r1.ok);
	assert.equal(r1.files["2026-11"], "---\nupdated: 2026-11-05\n---\n\n## 이달 중\n- [ ] A\n\n## W45 (11/02~11/08)\n");

	const crlf = NOV.replace(/\n/g, "\r\n");
	const r2 = add("B", "task", "개인", crlf);
	assert.ok(r2.ok);
	assert.ok(!/[^\r]\n/.test(r2.files["2026-11"]), "every line ends in CRLF");
	assert.match(r2.files["2026-11"], /#test\r\n- \[ \] B\r\n\r\n## W44/);

	const noEol = "---\nupdated: 2026-11-01\n---\n\n## 이달 중\n- [ ] 첫 줄";
	const r3 = add("C", "task", "개인", noEol);
	assert.ok(r3.ok);
	assert.equal(r3.files["2026-11"], "---\nupdated: 2026-11-05\n---\n\n## 이달 중\n- [ ] 첫 줄\n- [ ] C");
});

test("refused: same open item already in the 인박스, no ## 이달 중, empty text", () => {
	const dup = add("혼팀 연말 이벤트 기획안", "task");
	assert.equal(dup.ok, false);
	assert.equal(!dup.ok && dup.reason, "duplicate");
	// Same text as an event is a different item.
	assert.ok(add("혼팀 연말 이벤트 기획안", "event").ok);
	const none = add("X", "task", "개인", NOV.replace("## 이달 중\n", ""));
	assert.equal(!none.ok && none.reason, "section-missing");
	const blank = add("  ", "task");
	assert.equal(!blank.ok && blank.reason, "empty-text");
});

// ───────── checked write (commitBatch): a file changed between the read and the write cancels everything ─────────

const MONTH = "Desk/2026/2026-11.md";
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

const PATHS = { month: MONTH, index: INDEX };
const checked = (io: BatchIO, text = "보험 서류 정리") => addToInboxChecked(io, PATHS, "2026-11", text, "task", "개인", TODAY);
const reasonOf = (r: Awaited<ReturnType<typeof checked>>) => (r.ok ? "ok" : r.reason);

test("checked add: month line and the Desk Calendar Index change log in one batch", async () => {
	const m = memory({ [MONTH]: NOV, [INDEX]: IDX });
	const r = await checked(m.io);
	assert.ok(r.ok);
	const plain = add("보험 서류 정리", "task");
	assert.ok(plain.ok);
	assert.equal(m.files.get(MONTH), plain.files["2026-11"]);
	assert.match(m.files.get(INDEX)!, /- 2026-11-05: 인박스에 할 일 추가: 「보험 서류 정리」 \(플러그인\)\n- 2026-11-01/);
	assert.match(m.files.get(INDEX)!, /updated: 2026-11-05/);
	// No index file: the month line alone.
	const n = memory({ [MONTH]: NOV });
	assert.ok((await checked(n.io)).ok);
	assert.equal(n.files.has(INDEX), false);
});

test("checked add: month file changed right after the read → conflict, nothing written", async () => {
	const m = memory({ [MONTH]: NOV, [INDEX]: IDX });
	const edited = NOV.replace("## 이달 중\n", "## 이달 중\n- [ ] Hermes가 넣은 줄\n");
	let reads = 0;
	const read = m.io.read;
	m.io.read = async (p) => {
		const t = await read(p);
		// The first read of the month file is the plan's; Hermes edits right after it.
		if (p === MONTH && ++reads === 1) m.files.set(MONTH, edited);
		return t;
	};
	const r = await checked(m.io);
	assert.deepEqual(r, { ok: false, reason: "conflict" });
	assert.equal(m.files.get(MONTH), edited, "the concurrent edit survives");
	assert.equal(m.files.get(INDEX), IDX, "no change log for a cancelled add");
	assert.deepEqual(m.writes, []);
	assert.equal(INBOX_CONFLICT_NOTICE, "Desk Calendar 파일이 그새 바뀌어 추가를 취소했어요. 다시 시도해 주세요.");
});

test("checked add: month file changed inside the write (compareWrite) → conflict, the edit survives", async () => {
	const m = memory({ [MONTH]: NOV, [INDEX]: IDX });
	const cw = m.io.compareWrite;
	m.io.compareWrite = async (p, b, a) => {
		if (p === MONTH) m.files.set(MONTH, NOV + "\n- 동기화로 바뀜\n");
		return cw(p, b, a);
	};
	const r = await checked(m.io);
	assert.equal(reasonOf(r), "conflict");
	assert.equal(m.files.get(MONTH), NOV + "\n- 동기화로 바뀜\n");
	assert.equal(m.files.get(INDEX), IDX);
});

test("checked add: index changed during the batch → the month line is rolled back, conflict", async () => {
	const m = memory({ [MONTH]: NOV, [INDEX]: IDX });
	const cw = m.io.compareWrite;
	m.io.compareWrite = async (p, b, a) => {
		if (p === INDEX && b === IDX) m.files.set(INDEX, IDX + "- 다른 기록\n");
		return cw(p, b, a);
	};
	const r = await checked(m.io);
	assert.equal(reasonOf(r), "conflict");
	assert.equal(m.files.get(MONTH), NOV, "month write undone");
	assert.equal(m.files.get(INDEX), IDX + "- 다른 기록\n");
});

test("checked add: refusals come from the fresh read, nothing written", async () => {
	const m = memory({ [MONTH]: NOV, [INDEX]: IDX });
	assert.equal(reasonOf(await checked(m.io, "혼팀 연말 이벤트 기획안")), "duplicate");
	assert.equal(reasonOf(await checked(m.io, "  ")), "empty-text");
	assert.equal(reasonOf(await checked(memory({ [MONTH]: NOV.replace("## 이달 중\n", "") }).io)), "section-missing");
	assert.equal(reasonOf(await checked(memory({}).io)), "file-missing");
	assert.deepEqual(m.writes, []);
	assert.equal(m.files.get(MONTH), NOV);
});
