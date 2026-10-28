import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dropIndexRow, markForChoice, sourceDateOf, taskKey } from "../src/pending/ops.ts";
import { newMonthSkeleton } from "../src/desk/model.ts";

// Daily Pad 「결정 대기」 (04 Daily Pad AGENTS 「3-6」): real actions and parsers, simulated storage.
// Fictional data only (김하루).

const temp = mkdtempSync(join(tmpdir(), "mylogs-pending-test-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const stub = `export class App{};export class Modal{};export class Setting{};export class Notice{constructor(m){globalThis.__notices?.push(m)}};export class TFile{constructor(path){this.path=path;this.name=path.split('/').pop()}};export class TFolder{constructor(path){this.path=path;this.children=[]}};export const normalizePath=p=>p.replace(/\\/+/g,'/').replace(/^\\/|\\/$/g,'');export class PluginSettingTab{};export const moment=()=>({format:()=>""});export const setIcon=()=>{};export const setTooltip=()=>{};export const Platform={isMobile:false};`;
const result = await build({
	stdin: { contents: `export * from './src/pending/actions.ts';export {DEFAULT_SETTINGS} from './src/settings.ts';export {TFile,TFolder} from 'obsidian';`, resolveDir: resolve(import.meta.dirname, "..") },
	bundle: true,
	format: "cjs",
	platform: "node",
	write: false,
	plugins: [{ name: "mock-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: stub, loader: "js" })); } }],
});
const bundle = join(temp, "pending.cjs");
writeFileSync(bundle, result.outputFiles[0].text);
const api = createRequire(import.meta.url)(bundle);

const TODAY = "2026-11-05";
const LINE = "- [ ] 독서 모임 장소 예약하기 (from:: Daily Pad 2026-11-04)";

function vault(files: Record<string, string>) {
	const data = new Map(Object.entries(files));
	const host: any = { settings: { ...api.DEFAULT_SETTINGS }, app: {} };
	const file = (p: string) => (data.has(p) ? new api.TFile(p) : null);
	host.app.vault = {
		getAbstractFileByPath: (p: string) => file(p) ?? (p.includes(".") ? null : new api.TFolder(p)),
		read: async (f: any) => data.get(f.path),
		createFolder: async () => undefined,
		create: async (p: string, t: string) => {
			data.set(p, t);
			return file(p);
		},
		process: async (f: any, fn: (s: string) => string) => data.set(f.path, fn(data.get(f.path)!)),
		trash: async (f: any) => data.delete(f.path),
	};
	return { host, data };
}

function pad(date: string, pending: string, today = "") {
	return `---\ntype: daily-pad\ndate: "${date}"\nupdated: "${date}"\n---\n\n# ${date}\n\n## 결정 대기\n\n${pending}\n\n## 오늘 할 일\n${today}\n## 메모\n`;
}

function desk(): string {
	const t = newMonthSkeleton(2026, 11, TODAY);
	return t.replace("### 2026-11-04\n", "### 2026-11-04\n- [ ] 독서 모임 장소 예약하기 (from:: Daily Pad)\n");
}

const INDEX = `---\nupdated: 2026-11-04\n---\n\n## 결정 대기\n\n| 항목 | 처음 생긴 날 | 미룬 횟수 | 비고 |\n|---|---|---|---|\n| 독서 모임 장소 예약하기 | 2026-11-04 | 0 | |\n| 산책 코스 정하기 | 2026-11-04 | 0 | |\n\n## 변경 기록\n\n- 2026-11-04: 시작\n`;

function setup(extra: Record<string, string> = {}) {
	return vault({
		"04 Daily Pad/2026/2026-11-05.md": pad("2026-11-05", `${LINE}\n- [ ] 산책 코스 정하기 (from:: Daily Pad 2026-11-04)`),
		"04 Daily Pad/2026/2026-11-04.md": pad("2026-11-04", "", "- [ ] 장 보기\n"),
		"03 Desk Calendar/2026/2026-11.md": desk(),
		"04 Daily Pad/Daily Pad Index.md": INDEX,
		...extra,
	});
}

const sl = (index: number) => ({ index, line: LINE, indent: 0, item: { text: "독서 모임 장소 예약하기", tags: [], test: false } });
const LINE_INDEX = 10; // `## 결정 대기` is line 8, a blank line, then LINE

test("pure helpers", () => {
	assert.equal(sourceDateOf(LINE), "2026-11-04");
	assert.equal(sourceDateOf("- [ ] x (from:: Desk Calendar 2026-01-02)"), "2026-01-02");
	assert.equal(sourceDateOf("- [ ] x"), null);
	assert.equal(taskKey(LINE), taskKey("- [ ] 독서 모임 장소 예약하기 (from:: Daily Pad) #모임"));
	assert.equal(markForChoice("- [ ] A (moved:: 1)", { kind: "day", date: "2026-11-07" }), "- [>] A → 11/07 (moved:: 2)");
	assert.equal(markForChoice("- [ ] A", { kind: "letgo", why: "필요 없음" }), "- [-] A (why:: 필요 없음)");
	assert.equal(markForChoice("- [ ] A", { kind: "split", parts: ["a"] }), "- [>] A → 쪼갬");
	const out = dropIndexRow(INDEX, "독서 모임 장소 예약하기");
	assert.ok(!out.includes("| 독서 모임"));
	assert.ok(out.includes("| 산책 코스 정하기"));
});

test("다른 날: Desk day copy (+1 moved), original [>], line out of 결정 대기, index row gone", async () => {
	const { host, data } = setup();
	assert.equal(data.get("04 Daily Pad/2026/2026-11-05.md")!.split("\n")[LINE_INDEX], LINE);
	await api.applyPending(host, "2026-11-05", sl(LINE_INDEX), { kind: "day", date: "2026-11-07" }, TODAY);
	const p = data.get("04 Daily Pad/2026/2026-11-05.md")!;
	assert.ok(!p.includes("독서 모임"));
	assert.ok(p.includes("## 결정 대기"), "another item is still waiting");
	const d = data.get("03 Desk Calendar/2026/2026-11.md")!;
	assert.match(d, /### 2026-11-04\n- \[>\] 독서 모임 장소 예약하기 → 11\/07 \(moved:: 1\) \(from:: Daily Pad\)/);
	assert.match(d, /### 2026-11-07\n- \[ \] 독서 모임 장소 예약하기 (?=[^\n]*\(from:: Daily Pad 2026-11-04\))(?=[^\n]*\(moved:: 1\))/);
	const idx = data.get("04 Daily Pad/Daily Pad Index.md")!;
	assert.ok(!idx.includes("| 독서 모임"));
	assert.match(idx, /- 2026-11-05: 결정 대기 「독서 모임 장소 예약하기」 → 11\/07/);
});

test("놓아주기 on the last item removes the section; 쪼개기 adds to 오늘 할 일", async () => {
	const { host, data } = setup({ "04 Daily Pad/2026/2026-11-05.md": pad("2026-11-05", LINE) });
	await api.applyPending(host, "2026-11-05", sl(LINE_INDEX), { kind: "letgo", why: "다른 사람이 맡음" }, TODAY);
	assert.ok(!data.get("04 Daily Pad/2026/2026-11-05.md")!.includes("## 결정 대기"));
	assert.match(data.get("03 Desk Calendar/2026/2026-11.md")!, /- \[-\] 독서 모임 장소 예약하기 \(why:: 다른 사람이 맡음\) \(from:: Daily Pad\)/);

	const b = setup();
	await api.applyPending(b.host, "2026-11-05", sl(LINE_INDEX), { kind: "split", parts: ["후보 장소 세 곳 찾기", "전화하기"] }, TODAY);
	const p = b.data.get("04 Daily Pad/2026/2026-11-05.md")!;
	assert.match(p, /## 오늘 할 일\n- \[ \] 후보 장소 세 곳 찾기\n- \[ \] 전화하기/);
	assert.match(b.data.get("03 Desk Calendar/2026/2026-11.md")!, /→ 쪼갬/);
});

test("미래로 goes to the Wall Calendar month; refused when that month already has a Desk Calendar", async () => {
	const { host, data } = setup();
	await api.applyPending(host, "2026-11-05", sl(LINE_INDEX), { kind: "future", month: "2027-02" }, TODAY);
	assert.match(data.get("02 Wall Calendar/2027.md")!, /## 2027-02\n- \[ \] 독서 모임 장소 예약하기 (?=[^\n]*\(from:: Daily Pad 2026-11-04\))(?=[^\n]*\(moved:: 1\))/);
	assert.match(data.get("03 Desk Calendar/2026/2026-11.md")!, /→ Wall Calendar \(moved:: 1\)/);

	const b = setup();
	const before = new Map(b.data);
	await assert.rejects(api.applyPending(b.host, "2026-11-05", sl(LINE_INDEX), { kind: "future", month: "2026-11" }, TODAY), /다른 날/);
	assert.deepEqual(b.data, before, "nothing written");
});

test("서랍에 creates the Drawer line with when:: and from::; a changed line cancels everything", async () => {
	const { host, data } = setup();
	await api.applyPending(host, "2026-11-05", sl(LINE_INDEX), { kind: "drawer", when: "모임 인원이 정해지면" }, TODAY);
	const dr = data.get("06 Drawer/Drawer.md")!;
	assert.match(dr, /독서 모임 장소 예약하기 \(when:: 모임 인원이 정해지면\) \(from:: Daily Pad 2026-11-04\)/);
	assert.match(data.get("03 Desk Calendar/2026/2026-11.md")!, /→ Drawer/);

	const b = setup();
	const before = new Map(b.data);
	await assert.rejects(api.applyPending(b.host, "2026-11-05", { ...sl(LINE_INDEX), line: "- [ ] 다른 줄" }, { kind: "letgo", why: "x" }, TODAY));
	assert.deepEqual(b.data, before);
});

test("checking a 결정 대기 line finishes the original on its day; unchecking reopens it", async () => {
	const { host, data } = setup({ "04 Daily Pad/2026/2026-11-04.md": pad("2026-11-04", "", "- [ ] 독서 모임 장소 예약하기\n") });
	assert.equal(await api.togglePending(host, "2026-11-05", sl(LINE_INDEX), TODAY), "done");
	assert.match(data.get("04 Daily Pad/2026/2026-11-05.md")!, /- \[x\] 독서 모임 장소 예약하기 \(from:: Daily Pad 2026-11-04\)/);
	assert.match(data.get("03 Desk Calendar/2026/2026-11.md")!, /### 2026-11-04\n- \[x\] 독서 모임 장소 예약하기 \(from:: Daily Pad\)/);
	assert.match(data.get("04 Daily Pad/2026/2026-11-04.md")!, /## 오늘 할 일\n- \[x\] 독서 모임 장소 예약하기/);
	assert.ok(!data.get("04 Daily Pad/Daily Pad Index.md")!.includes("| 독서 모임"));
	const doneLine = { ...sl(LINE_INDEX), line: "- [x] 독서 모임 장소 예약하기 (from:: Daily Pad 2026-11-04)" };
	assert.equal(await api.togglePending(host, "2026-11-05", doneLine, TODAY), "open");
	assert.match(data.get("03 Desk Calendar/2026/2026-11.md")!, /### 2026-11-04\n- \[ \] 독서 모임 장소 예약하기/);
});

test("오늘로: into today's 개인 / 회사 할 일 (the section is the side), original [>] today, side found from the day it came from", async () => {
	const { host, data } = setup({ "04 Daily Pad/2026/2026-11-04.md": `---\ntype: daily-pad\n---\n\n# 2026-11-04\n\n## 개인 할 일\n- [ ] 장 보기\n\n## 회사 할 일\n- [ ] 산책 코스 정하기\n` });
	const walk = { index: LINE_INDEX + 1, line: "- [ ] 산책 코스 정하기 (from:: Daily Pad 2026-11-04)", indent: 0, item: { text: "산책 코스 정하기", tags: [], test: false } };
	assert.equal(await api.pendingSide(host, "2026-11-05", walk), "회사");
	assert.equal(await api.pendingSide(host, "2026-11-05", sl(LINE_INDEX)), "개인");
	await api.applyPending(host, "2026-11-05", walk, { kind: "today", date: "2026-11-05", side: "회사" }, TODAY);
	const p = data.get("04 Daily Pad/2026/2026-11-05.md")!;
	assert.match(p, /## 회사 할 일\n- \[ \] 산책 코스 정하기 \(moved:: 1\)\n/);
	assert.doesNotMatch(p, /산책 코스 정하기 \(from::/);
	assert.match(data.get("04 Daily Pad/2026/2026-11-04.md")!, /\[>\] 산책 코스 정하기 → 11\/05 \(moved:: 1\)/);
	assert.match(data.get("04 Daily Pad/Daily Pad Index.md")!, /→ 오늘\(11\/05\) 회사 할 일/);
});
