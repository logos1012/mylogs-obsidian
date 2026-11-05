import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { newMonthSkeleton, parseMonthFile } from "../src/desk/model.ts";
import { canDefer, deferArrow, deferCopy, locatePadLine, markPadDeferred, putDeskCopy, splitPadLine, letGoPadLine } from "../src/pending/defer.ts";
import { markInPadSection, setCheckInRange, taskKey } from "../src/pending/ops.ts";
import { getSectionContent } from "../src/writer.ts";

// Daily Pad 할 일 넘기기 (개인 / 회사 할 일 → Desk Calendar 인박스 · 다른 날): real actions, simulated
// storage. Fictional data only (김하루).

const temp = mkdtempSync(join(tmpdir(), "mylogs-defer-test-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const stub = `export class App{};export class Modal{};export class Setting{};export class Notice{constructor(m){globalThis.__notices?.push(m)}};export class TFile{constructor(path){this.path=path;this.name=path.split('/').pop()}};export class TFolder{constructor(path){this.path=path;this.children=[]}};export const normalizePath=p=>p.replace(/\\/+/g,'/').replace(/^\\/|\\/$/g,'');export class PluginSettingTab{};export const moment=()=>({format:()=>""});export const setIcon=()=>{};export const setTooltip=()=>{};export const Platform={isMobile:false};export const requestUrl=async()=>({status:0,text:""});`;
const result = await build({
	stdin: { contents: `export * from './src/pending/actions.ts';export {DEFAULT_SETTINGS} from './src/settings.ts';export {TFile,TFolder} from 'obsidian';`, resolveDir: resolve(import.meta.dirname, "..") },
	bundle: true,
	format: "cjs",
	platform: "node",
	write: false,
	plugins: [{ name: "mock-obsidian", setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mock" })); b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: stub, loader: "js" })); } }],
});
const bundle = join(temp, "defer.cjs");
writeFileSync(bundle, result.outputFiles[0].text);
const api = createRequire(import.meta.url)(bundle);

const TODAY = "2026-11-05";
const PAD = "04 Daily Pad/2026/2026-11-05.md";
const DESK = "03 Desk Calendar/2026/2026-11.md";
const INDEX = "04 Daily Pad/Daily Pad Index.md";

function pad(personal: string, work = ""): string {
	return `---\ntype: daily-pad\ndate: "2026-11-05"\nupdated: "2026-11-05"\n---\n\n# 2026-11-05\n\n![[03 Desk Calendar/2026/2026-11#2026-11-05]]\n\n## 개인 할 일\n\n${personal}\n\n## 회사 할 일\n\n${work}\n\n## 메모\n- 점심 산책\n`;
}

const PERSONAL = "- [ ] F-1 산책 — 10분 (flywheel:: F-1)\n- [ ] 장 보기 #생활\n- [ ] 책장 정리 (moved:: 1)\n- [x] 물 마시기";
const WORK = "- [ ] 견적서 보내기";
const INDEX_TEXT = "---\nupdated: 2026-11-04\n---\n\n## 결정 대기\n\n| 항목 | 처음 생긴 날 | 미룬 횟수 | 비고 |\n|---|---|---|---|\n\n## 변경 기록\n\n- 2026-11-04: 시작\n";

function vault(files: Record<string, string>, onRead?: (path: string, n: number, data: Map<string, string>) => void) {
	const data = new Map(Object.entries(files));
	const reads = new Map<string, number>();
	const host: any = { settings: { ...api.DEFAULT_SETTINGS }, app: {} };
	const file = (p: string) => (data.has(p) ? new api.TFile(p) : null);
	host.app.vault = {
		getAbstractFileByPath: (p: string) => file(p) ?? (p.includes(".") ? null : new api.TFolder(p)),
		read: async (f: any) => {
			const n = (reads.get(f.path) ?? 0) + 1;
			reads.set(f.path, n);
			onRead?.(f.path, n, data);
			return data.get(f.path);
		},
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

function setup(extra: Record<string, string> = {}, onRead?: (path: string, n: number, data: Map<string, string>) => void) {
	return vault({ [PAD]: pad(PERSONAL, WORK), [DESK]: newMonthSkeleton(2026, 11, "2026-11-01"), [INDEX]: INDEX_TEXT, ...extra }, onRead);
}

/** The ref the Daily Pad view hands over: offset inside the section content + the line. */
function ref(text: string, section: string, line: string) {
	const content = getSectionContent(text, section)!;
	const offset = content.split("\n").indexOf(line);
	assert.ok(offset >= 0, `${line} in ${section}`);
	return { offset, line };
}

const inbox = { kind: "inbox", month: "2026-11" } as const;

test("pure: which lines can be passed on, arrows, copies", () => {
	assert.equal(canDefer("- [ ] 장 보기"), true);
	assert.equal(canDefer("- [x] 장 보기"), false);
	assert.equal(canDefer("- [>] 장 보기 → 11/07"), false);
	assert.equal(canDefer("- [-] 장 보기 (why:: x)"), false);
	assert.equal(canDefer("\t- [ ] 하위 할 일"), false, "nested lines go with their parent");
	assert.equal(canDefer("- [ ] F-1 산책 — 10분 (flywheel:: F-1)"), false, "Flywheel lines are checked or left");
	assert.equal(canDefer("- 메모"), false);
	assert.equal(deferArrow(inbox), "11월 인박스");
	assert.equal(deferArrow({ kind: "day", date: "2026-11-07" }), "11/07");
	assert.equal(deferCopy("- [ ] 견적서 보내기", true), "- [ ] 견적서 보내기 (moved:: 1) #회사");
	assert.equal(deferCopy("- [ ] 책장 정리 (moved:: 1) #집", false), "- [ ] 책장 정리 (moved:: 2) #집");
	assert.ok(!deferCopy("- [ ] 장 보기", false).includes("from::"), "no new from:: (sourceDateOf would misread it)");
});

test("pure: the Pad line becomes [>] → 보낸 곳 (moved +1); nothing else but `updated` changes", () => {
	const text = pad(PERSONAL, WORK).replace('updated: "2026-11-05"', 'updated: "2026-11-04"');
	const r = markPadDeferred(text, "개인 할 일", ref(text, "개인 할 일", "- [ ] 장 보기 #생활"), inbox, TODAY);
	assert.ok(r.ok);
	assert.equal(r.text, text.replace("- [ ] 장 보기 #생활", "- [>] 장 보기 → 11월 인박스 (moved:: 1) #생활").replace('updated: "2026-11-04"', "updated: 2026-11-05"));
	// Stale view (the line changed) → refused; an already closed line → refused.
	assert.equal(markPadDeferred(text, "개인 할 일", { offset: 1, line: "- [ ] 장 보기 (옛 글)" }, inbox, TODAY).ok, false);
	const done = text.replace("- [ ] 장 보기 #생활", "- [x] 장 보기 #생활");
	assert.equal(markPadDeferred(done, "개인 할 일", { offset: 1, line: "- [x] 장 보기 #생활" }, inbox, TODAY).ok, false);
	// CRLF kept.
	const crlf = text.replace(/\n/g, "\r\n");
	const c = markPadDeferred(crlf, "개인 할 일", ref(text, "개인 할 일", "- [ ] 장 보기 #생활"), { kind: "day", date: "2026-11-07" }, TODAY);
	assert.ok(c.ok && c.text.includes("- [>] 장 보기 → 11/07 (moved:: 1) #생활\r\n") && !/[^\r]\n/.test(c.text));
});

test("Tear-off / 결정 대기 helpers leave a passed-on [>] line alone (no double carry-over)", () => {
	const text = pad("- [>] 장 보기 → 11월 인박스 (moved:: 1) #생활");
	assert.equal(markInPadSection(text, "개인 할 일", taskKey("- [ ] 장 보기"), (l) => l + " X").count, 0);
	assert.equal(setCheckInRange(text, { start: 0, end: 30 }, taskKey("- [ ] 장 보기"), " ", "x").count, 0);
	assert.equal(setCheckInRange(text, { start: 0, end: 30 }, taskKey("- [ ] 장 보기"), "x", " ").count, 0);
});

test("pure: Desk copy at the end of the 인박스 / day cell; duplicate and missing cell refused", () => {
	const desk = newMonthSkeleton(2026, 11, "2026-11-01");
	const r = putDeskCopy(desk, inbox, "- [ ] 장 보기 (moved:: 1) #생활", TODAY);
	assert.ok(r.ok);
	const it = parseMonthFile(r.text, 2026, 11).during.at(-1)!;
	assert.equal(it.line, "- [ ] 장 보기 (moved:: 1) #생활");
	assert.equal(it.section, "during");
	assert.match(r.text, /updated: 2026-11-05/);
	const again = putDeskCopy(r.text, inbox, "- [ ] 장 보기 (moved:: 1) #생활", TODAY);
	assert.equal(!again.ok && again.reason, "duplicate");
	const day = putDeskCopy(desk, { kind: "day", date: "2026-11-07" }, "- [ ] 장 보기 (moved:: 1)", TODAY);
	assert.ok(day.ok);
	assert.deepEqual(parseMonthFile(day.text, 2026, 11).days.get("2026-11-07")!.map((x) => x.line), ["- [ ] 장 보기 (moved:: 1)"]);
	const noDay = putDeskCopy(desk.replace("### 2026-11-07\n", ""), { kind: "day", date: "2026-11-07" }, "- [ ] x", TODAY);
	assert.equal(!noDay.ok && noDay.reason, "section-missing");
});

test("인박스로: Desk 인박스 copy, Pad line [>] → 11월 인박스, Index change log — other bytes kept", async () => {
	const { host, data } = setup();
	const before = data.get(PAD)!;
	const deskBefore = data.get(DESK)!;
	await api.deferPadTask(host, "2026-11-05", "개인 할 일", ref(before, "개인 할 일", "- [ ] 장 보기 #생활"), inbox, TODAY);
	assert.equal(data.get(PAD), before.replace("- [ ] 장 보기 #생활", "- [>] 장 보기 → 11월 인박스 (moved:: 1) #생활"), "updated was already today");
	const desk = data.get(DESK)!;
	assert.equal(desk, deskBefore.replace("updated: 2026-11-01", "updated: 2026-11-05").replace("## 이달 중\n", "## 이달 중\n- [ ] 장 보기 (moved:: 1) #생활\n"));
	assert.equal(parseMonthFile(desk, 2026, 11).during.map((x) => x.line).join("|"), "- [ ] 장 보기 (moved:: 1) #생활");
	assert.equal(desk.split("\n").length, deskBefore.split("\n").length + 1);
	assert.match(data.get(INDEX)!, /- 2026-11-05: 개인 할 일 「장 보기」 → Desk Calendar 11월 인박스 \(moved:: 1\) \(플러그인\)\n- 2026-11-04: 시작/);
});

test("다른 날: day cell copy, moved accumulates; 회사 할 일 gets #회사 on the Desk", async () => {
	const { host, data } = setup();
	const p = data.get(PAD)!;
	await api.deferPadTask(host, "2026-11-05", "개인 할 일", ref(p, "개인 할 일", "- [ ] 책장 정리 (moved:: 1)"), { kind: "day", date: "2026-11-09" }, TODAY);
	await api.deferPadTask(host, "2026-11-05", "회사 할 일", ref(data.get(PAD)!, "회사 할 일", WORK), { kind: "day", date: "2026-11-06" }, TODAY);
	const desk = parseMonthFile(data.get(DESK)!, 2026, 11);
	assert.deepEqual(desk.days.get("2026-11-09")!.map((x) => x.line), ["- [ ] 책장 정리 (moved:: 2)"]);
	assert.deepEqual(desk.days.get("2026-11-06")!.map((x) => x.line), ["- [ ] 견적서 보내기 (moved:: 1) #회사"]);
	const after = data.get(PAD)!;
	assert.ok(after.includes("- [>] 책장 정리 → 11/09 (moved:: 2)\n"));
	assert.ok(after.includes("## 회사 할 일\n\n- [>] 견적서 보내기 → 11/06 (moved:: 1)\n"), "the Pad 회사 line gets no #회사 (the section is the side)");
});

test("a file changed meanwhile (Hermes) cancels everything; refusals write nothing", async () => {
	// The Desk file changes between the action's read and the batch check.
	const { host, data } = setup({}, (path, n, d) => {
		if (path === DESK && n === 2) d.set(DESK, d.get(DESK)!.replace("### 2026-11-30\n", "### 2026-11-30\n- [ ] Hermes가 쓴 줄\n"));
	});
	const padBefore = data.get(PAD)!;
	await assert.rejects(api.deferPadTask(host, "2026-11-05", "개인 할 일", ref(padBefore, "개인 할 일", "- [ ] 장 보기 #생활"), inbox, TODAY), /파일이 바뀌었어요/);
	assert.equal(data.get(PAD), padBefore, "Pad untouched");
	assert.ok(data.get(DESK)!.includes("Hermes가 쓴 줄") && !data.get(DESK)!.includes("장 보기"), "Hermes' edit kept, no copy");
	assert.equal(data.get(INDEX), INDEX_TEXT);

	// No Desk month file → Korean refusal, nothing written.
	const v2 = setup();
	v2.data.delete(DESK);
	await assert.rejects(api.deferPadTask(v2.host, "2026-11-05", "개인 할 일", ref(padBefore, "개인 할 일", "- [ ] 장 보기 #생활"), { kind: "day", date: "2026-12-01" }, TODAY), /2026-12 Desk Calendar가 아직 없어요/);
	assert.equal(v2.data.get(PAD), padBefore);

	// The line was edited in the Pad since it was drawn → refused.
	const v3 = setup();
	await assert.rejects(api.deferPadTask(v3.host, "2026-11-05", "개인 할 일", { offset: 1, line: "- [ ] 장 보기 (예전)" }, inbox, TODAY), /그새 바뀌었어요/);
	assert.equal(v3.data.get(PAD), padBefore);

	// Already in the target → refused (no second copy, Pad line stays open).
	const v4 = setup({ [DESK]: newMonthSkeleton(2026, 11, "2026-11-01").replace("## 이달 중\n", "## 이달 중\n- [ ] 장 보기\n") });
	await assert.rejects(api.deferPadTask(v4.host, "2026-11-05", "개인 할 일", ref(padBefore, "개인 할 일", "- [ ] 장 보기 #생활"), inbox, TODAY), /같은 할 일이 이미 있어요/);
	assert.equal(v4.data.get(PAD), padBefore);

	// Flywheel line → refused.
	const v5 = setup();
	await assert.rejects(api.deferPadTask(v5.host, "2026-11-05", "개인 할 일", ref(padBefore, "개인 할 일", "- [ ] F-1 산책 — 10분 (flywheel:: F-1)"), inbox, TODAY), /열린 할 일만/);
	assert.equal(v5.data.get(PAD), padBefore);
});

test("third postpone answers: 놓아주기 / 쪼개기 change only the Pad line", () => {
	const text = pad(PERSONAL);
	const r = ref(text, "개인 할 일", "- [ ] 책장 정리 (moved:: 1)");
	const g = letGoPadLine(text, "개인 할 일", r, "필요 없음", TODAY);
	assert.ok(g.ok && g.text === text.replace("- [ ] 책장 정리 (moved:: 1)", "- [-] 책장 정리 (why:: 필요 없음) (moved:: 1)"));
	const s = splitPadLine(text, "개인 할 일", r, ["책 고르기", "- [ ] 버릴 책 묶기", " "], TODAY);
	assert.ok(s.ok && s.text === text.replace("- [ ] 책장 정리 (moved:: 1)", "- [>] 책장 정리 → 쪼갬 (moved:: 1)\n- [ ] 책 고르기\n- [ ] 버릴 책 묶기"));
	assert.equal(splitPadLine(text, "개인 할 일", r, ["  "], TODAY).ok, false);
});

test("chooseDefer refuses an older Daily Pad (결정 대기 handles it) without writing", async () => {
	(globalThis as any).__notices = [];
	const { host, data } = setup();
	const before = data.get(PAD)!;
	const ok = await api.chooseDefer(host, "2026-11-05", "개인 할 일", ref(before, "개인 할 일", "- [ ] 장 보기 #생활"), "inbox", "2026-11-06");
	assert.equal(ok, false);
	assert.equal(data.get(PAD), before);
	assert.match((globalThis as any).__notices.join("\n"), /결정 대기/);
	// Today's Pad: the inbox pick writes without a dialog.
	assert.equal(await api.chooseDefer(host, "2026-11-05", "개인 할 일", ref(before, "개인 할 일", "- [ ] 장 보기 #생활"), "inbox", TODAY), true);
	assert.ok(data.get(PAD)!.includes("- [>] 장 보기 → 11월 인박스 (moved:: 1) #생활"));
	assert.equal(locatePadLine(data.get(PAD)!, "개인 할 일", { offset: 1, line: "- [ ] 장 보기 #생활" }), -1);
});
