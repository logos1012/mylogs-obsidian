import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import { TEMPLATE_FILES } from "../src/projects/create.ts";
import { readMilestones, changeMilestones, milestoneSummary } from "../src/projects/milestones.ts";
import { hubTopRows, hubRows, setTopRowField } from "../src/projects/tasks.ts";
import { applyLinkChange, linkedRows, milestoneTaskProgress, newMilestoneId, MS_ID_RE, readyToConfirm, recommendLinks, reviewNotes, linkScore, aimIds } from "../src/projects/milestone-links.ts";
import { TODAY, ROOT, MAIN_TEMPLATE, SUB_TEMPLATE, INDEX, REGISTRY, WHEEL3, HUBS, INPUT, PROJECT, templates } from "./support/pinboard-fixtures.ts";

// ── through the real actions (storage simulated, as in task-idless.test.ts) ──
const temp=mkdtempSync(join(tmpdir(),"mylogs-links-test-"));after(()=>rmSync(temp,{recursive:true,force:true}));
const stub=`export class Modal{};export class SuggestModal{};export const moment=Object.assign((d)=>({format:()=>'',isoWeek:()=>1}),{});export function setIcon(){};export function setTooltip(){};export const Platform={isMobile:false};export const requestUrl=async()=>({status:0,text:""});export class App{};export class PluginSettingTab{};export class Setting{};export class Notice{constructor(message){globalThis.__notices?.push(message)}};export class TFile{constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.replace(/\\.md$/,'')}};export class TFolder{constructor(path){this.path=path;this.name=path.split('/').pop();this.children=[]}};export const normalizePath=p=>p.replace(/\\\\/g,'/').replace(/\\/+/g,'/').replace(/^\\/|\\/$/g,'');`;
const result=await build({stdin:{contents:`export * from './src/pinboard/create-actions.ts';export * from './src/projects/actions.ts';export * from './src/projects/milestone-actions.ts';export * from './src/projects/task-actions.ts';export {DEFAULT_SETTINGS} from './src/settings.ts';export {TFile,TFolder} from 'obsidian';`,resolveDir:resolve(import.meta.dirname,"..")},bundle:true,format:"cjs",platform:"node",write:false,plugins:[{name:"mock-obsidian",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:stub,loader:"js"}));}}]});
const bundle=join(temp,"actions.cjs");writeFileSync(bundle,result.outputFiles[0].text);const api=createRequire(import.meta.url)(bundle);

// ── the example hub of the plan (§1 as it is now, §4 after kinds are set) ──
const MS_NOW = [
	"## 마일스톤",
	"<!-- 사용자가 정한 중요한 도달 상태를 - [ ] / - [x]로 적는다. -->",
	"- [ ] 자사몰 오픈: 아임웹 결제 테스트 통과 (due:: 2026-11-25)",
	"- [ ] 테스트 제품 3개 확정: … (due:: 2026-11-27)",
	"- [ ] 첫 광고 집행: … (due:: 2026-11-28)",
	"- [ ] 첫 주문 (due:: 2026-11-30)",
	"- [ ] 광고비를 빼고도 순이익이 나는 제품 1개 확인: … (due:: 2026-12-07)",
	"- [ ] 최근 30일 순이익 100만 원 (due:: 2026-12-11)",
	"- [ ] 최근 30일 순이익 300만 원 (due:: 2026-12-31)",
	"- [ ] 월 순이익 1,000만 원 (due:: 2027-02-23)",
	"",
];
const MS_KINDS = [
	"## 마일스톤",
	"- [ ] 자사몰 오픈: 아임웹 결제 테스트 통과 (due:: 2026-11-25) (ms:: M-3f9a1c20)",
	"- [ ] 테스트 제품 3개 확정: … (due:: 2026-11-27) (ms:: M-8a41d7e3)",
	"- [ ] 첫 광고 집행: … (due:: 2026-11-28) (ms:: M-c02b9f56)",
	"- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과) (ms:: M-b71e04d2) (current:: 0) (target:: 1) (unit:: 건) (period:: 누적)",
	"- [ ] 광고비를 빼고도 순이익이 나는 제품 1개 확인: … (due:: 2026-12-07) (kind:: 성과) (current:: 0) (target:: 1) (unit:: 개)",
	"- [ ] 최근 30일 순이익 100만 원 (due:: 2026-12-11) (kind:: 성과) (current:: 0) (target:: 1000000) (unit:: 원) (period:: 최근 30일)",
	"- [ ] 최근 30일 순이익 300만 원 (due:: 2026-12-31) (kind:: 성과) (current:: 0) (target:: 3000000) (unit:: 원) (period:: 최근 30일)",
	"- [ ] 월 순이익 1,000만 원 (due:: 2027-02-23) (kind:: 성과) (current:: 0) (target:: 10000000) (unit:: 원) (period:: 월)",
	"",
];
const TASKS = [
	"## 할 일",
	"<!-- 미배정 할 일. -->",
	"- [ ] 자사몰 세팅 (아임웹)",
	"    - [ ] 자사몰 이름 정하기",
	"    - [ ] 아임웹 결제 붙이기",
	"    - [ ] 아임웹 꾸미기",
	"- [ ] 실내 원터치 난방텐트 판매 시작",
	"    - [ ] 후킹 영상 샷 기획 …",
	"- [ ] 테스트 제품 10개 정하기 (1/10: 실내 원터치 난방텐트)",
	"    - [ ] 아이템 선정 워크플로우 확정 …",
	"",
];
const hubOf = (ms: string[], tasks = TASKS) => ["---", "type: project", "id: P-shop", "---", "# 온라인 판매", "", ...ms, ...tasks, "## 비목표", ""].join("\n");
const EXPECTED_PAIRS = [
	["자사몰 세팅 (아임웹)", "자사몰 오픈: 아임웹 결제 테스트 통과"],
	["실내 원터치 난방텐트 판매 시작", "첫 광고 집행: …"],
	["테스트 제품 10개 정하기 (1/10: 실내 원터치 난방텐트)", "테스트 제품 3개 확정: …"],
];
/** Lines that differ (same line count). */
const diff = (a: string, b: string) => { const x = a.split("\n"), y = b.split("\n"); assert.equal(x.length, y.length); return y.filter((l, i) => l !== x[i]); };
let seq = 0;
const ids = () => `M-${(++seq).toString(16).padStart(8, "0")}`;

test("ms / aim / start: read, kept out of the title, written in plugin order", () => {
	const text = "## 마일스톤\n- [ ] 자사몰 오픈 (ms:: M-3f9a1c20) (aim:: M-b71e04d2, M-5c2d8e91) (due:: 2026-11-25)\n- [ ] 첫 주문 (kind:: 성과) (start:: 1,000) (current:: 2)\n";
	const [a, b] = readMilestones(text).items;
	assert.equal(a.text, "자사몰 오픈"); assert.equal(a.ms, "M-3f9a1c20"); assert.deepEqual(aimIds(a), ["M-b71e04d2", "M-5c2d8e91"]);
	assert.equal(b.text, "첫 주문"); assert.equal(b.start, 1000);
	// Editing the title keeps every field exactly as written.
	assert.equal(changeMilestones(text, readMilestones(text).source, { kind: "edit", line: 1, text: "자사몰 오픈 완료" }).split("\n")[1], "- [ ] 자사몰 오픈 완료 (ms:: M-3f9a1c20) (aim:: M-b71e04d2, M-5c2d8e91) (due:: 2026-11-25)");
	// New fields go in order: due → kind → ms → aim → start → current → target → unit → period → as_of.
	const metric = "## 마일스톤\n- [ ] 순이익 (due:: 2026-12-11) (kind:: 성과) (current:: 5) (target:: 10) (unit:: 원) (period:: 월) (as_of:: 2026-11-23)\n- [ ] 오픈 (due:: 2026-11-25)\n";
	const r = applyLinkChange(metric, readMilestones(metric).source, { kind: "aim", line: 2, metrics: [1] }, () => "M-0000000a");
	assert.deepEqual(r.text.split("\n").slice(1, 3), [
		"- [ ] 순이익 (due:: 2026-12-11) (kind:: 성과) (ms:: M-0000000a) (start:: 5) (current:: 5) (target:: 10) (unit:: 원) (period:: 월) (as_of:: 2026-11-23)",
		"- [ ] 오픈 (due:: 2026-11-25) (aim:: M-0000000a)",
	]);
	assert.match(newMilestoneId(), MS_ID_RE);
	assert.equal(newMilestoneId(["M-00000001"], (() => { let n = 0; return () => String(++n).padStart(8, "0"); })()), "M-00000002");
});

test("ids are given lazily: viewing and other edits add none; linking adds one in the same change", () => {
	const hub = hubOf(MS_NOW);
	const m = readMilestones(hub);
	assert.ok(m.items.every(i => !i.ms));
	assert.doesNotMatch(changeMilestones(hub, m.source, { kind: "check", line: m.items[0].line, done: true }), /ms::/);
	const group = hubTopRows(hub)[0];
	const out = applyLinkChange(hub, m.source, { kind: "link", line: m.items[0].line, rows: [{ key: group.key, line: group.line }] }, () => "M-3f9a1c20").text;
	assert.deepEqual(diff(hub, out), ["- [ ] 자사몰 오픈: 아임웹 결제 테스트 통과 (due:: 2026-11-25) (ms:: M-3f9a1c20)", "- [ ] 자사몰 세팅 (아임웹) (ms:: M-3f9a1c20)"]);
	// An id that is there is reused, not replaced.
	const again = applyLinkChange(out, readMilestones(out).source, { kind: "link", line: m.items[0].line, rows: [{ key: hubTopRows(out)[1].key, line: hubTopRows(out)[1].line }] }, () => "M-ffffffff").text;
	assert.deepEqual(diff(out, again), ["- [ ] 실내 원터치 난방텐트 판매 시작 (ms:: M-3f9a1c20)"]);
	// 성과 지표 take no 할 일.
	const kinds = hubOf(MS_KINDS);
	assert.throws(() => applyLinkChange(kinds, readMilestones(kinds).source, { kind: "link", line: readMilestones(kinds).items[3].line, rows: [{ key: group.key, line: group.line }] }, ids), /성과 지표에는 할 일을/);
});

test("link / unlink: only the group line changes; children never carry ms and follow their 묶음", () => {
	const hub = hubOf(MS_KINDS), m = readMilestones(hub), [g1, g2] = hubTopRows(hub);
	const linked = applyLinkChange(hub, m.source, { kind: "link", line: m.items[0].line, rows: [{ key: g1.key, line: g1.line }, { key: g2.key, line: g2.line }] }, ids).text;
	assert.deepEqual(diff(hub, linked), ["- [ ] 자사몰 세팅 (아임웹) (ms:: M-3f9a1c20)", "- [ ] 실내 원터치 난방텐트 판매 시작 (ms:: M-3f9a1c20)"]);
	assert.equal(linked.split("\n").filter(l => /^\s+-/.test(l) && /ms::/.test(l)).length, 0);
	const rows = linkedRows(linked, "M-3f9a1c20");
	assert.deepEqual(rows.map(r => r.children.length), [3, 1]);
	// A 하위 row cannot be linked.
	const child = hubRows(hub).find(r => r.depth === 1)!;
	assert.throws(() => setTopRowField(hub, child.key, hub.split("\n")[child.index], "ms", "M-3f9a1c20"), /하위 할 일에는/);
	const back = applyLinkChange(linked, readMilestones(linked).source, { kind: "unlink", line: m.items[0].line, rows: [{ key: rows[1].key, line: rows[1].line }] }, ids).text;
	assert.deepEqual(diff(linked, back), ["- [ ] 실내 원터치 난방텐트 판매 시작"]);
	// Other fields on the row stay; the link goes after them.
	const withId = "## 마일스톤\n- [ ] 오픈 (ms:: M-00000001)\n\n## 할 일\n- [ ] 세팅 (task:: T-1) (project:: P-1) #tag\n";
	const row = hubTopRows(withId)[0];
	assert.equal(applyLinkChange(withId, readMilestones(withId).source, { kind: "link", line: 1, rows: [{ key: row.key, line: row.line }] }).text.split("\n")[4], "- [ ] 세팅 (task:: T-1) (project:: P-1) (ms:: M-00000001) #tag");
});

test("+ 할 일: a new 묶음 at the end of ## 할 일 with task, project and ms", () => {
	const hub = hubOf(MS_KINDS), m = readMilestones(hub);
	const out = applyLinkChange(hub, m.source, { kind: "addGroup", line: m.items[2].line, title: "광고 소재 3개 만들기", taskId: "T-new", projectId: "P-shop" }, ids).text;
	assert.match(out, /    - \[ \] 아이템 선정 워크플로우 확정 …\n- \[ \] 광고 소재 3개 만들기 \(task:: T-new\) \(project:: P-shop\) \(ms:: M-c02b9f56\)\n\n## 비목표/);
	assert.throws(() => applyLinkChange(hub, m.source, { kind: "addGroup", line: m.items[2].line, title: "(ms:: x)", taskId: "T-new", projectId: "P-shop" }, ids), /한 줄로/);
});

test("progress: a 묶음 counts its 하위 할 일, a 단독 할 일 itself; references read the calendar; 놓아줌 counts in neither", () => {
	const tasks = [
		"## 할 일",
		"- [ ] 묶음 (ms:: M-00000001)",
		"    - [x] 하나",
		"    - [ ] 둘",
		"    - 셋 (task:: T-3) (project:: P)",
		"    - [-] 넷",
		"- [x] 단독 (ms:: M-00000001)",
		"- 배정 단독 (task:: T-9) (project:: P) (ms:: M-00000001)",
		"- [ ] 다른 마일스톤 (ms:: M-00000002)",
		"    - [x] 다섯",
		"",
	];
	const hub = hubOf(["## 마일스톤", "- [ ] 오픈 (ms:: M-00000001)", ""], tasks);
	const rows = linkedRows(hub, "M-00000001");
	assert.deepEqual(rows.map(r => r.title), ["묶음", "단독", "배정 단독"]);
	const cal = (id: string) => (id === "T-3" ? "done" : id === "T-9" ? "scheduled" : undefined) as any;
	assert.deepEqual(milestoneTaskProgress(rows, cal), { done: 3, total: 5 });
	assert.deepEqual(milestoneTaskProgress(linkedRows(hub, undefined)), { done: 0, total: 0 });
	assert.deepEqual(milestoneTaskProgress(linkedRows(hub, "M-00000002")), { done: 1, total: 1 });
});

test("달성 확인: only a button when every linked 할 일 is done; nothing is checked automatically", () => {
	const m = { done: false };
	assert.equal(readyToConfirm(m, { done: 2, total: 2 }), true);
	assert.equal(readyToConfirm(m, { done: 1, total: 2 }), false);
	assert.equal(readyToConfirm(m, { done: 0, total: 0 }), false);
	assert.equal(readyToConfirm({ done: true }, { done: 2, total: 2 }), false);
	assert.equal(readyToConfirm({ done: false, kind: "metric" }, { done: 2, total: 2 }), false);
	// Reading the progress never touches the hub.
	const hub = hubOf(["## 마일스톤", "- [ ] 오픈 (ms:: M-00000001)", ""], ["## 할 일", "- [x] 끝 (ms:: M-00000001)", ""]);
	assert.equal(readyToConfirm(readMilestones(hub).items[0], milestoneTaskProgress(linkedRows(hub, "M-00000001"))), true);
	assert.match(hub, /- \[ \] 오픈 \(ms:: M-00000001\)/);
});

test("노리는 성과 지표: aim on the milestone, ids and start (current then, or 0) on metrics, one change", () => {
	const hub = hubOf(MS_KINDS), m = readMilestones(hub), items = m.items;
	const first = items.find(i => i.text === "첫 주문")!, product = items.find(i => i.text.startsWith("광고비"))!;
	const withCurrent = hub.replace("(unit:: 개)", "(unit:: 개)").replace("(current:: 0) (target:: 1) (unit:: 개)", "(current:: 2) (target:: 1) (unit:: 개)");
	const r = applyLinkChange(withCurrent, readMilestones(withCurrent).source, { kind: "aim", line: items[1].line, metrics: [first.line, product.line] }, () => "M-5c2d8e91");
	assert.deepEqual(diff(withCurrent, r.text), [
		"- [ ] 테스트 제품 3개 확정: … (due:: 2026-11-27) (ms:: M-8a41d7e3) (aim:: M-b71e04d2, M-5c2d8e91)",
		"- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과) (ms:: M-b71e04d2) (start:: 0) (current:: 0) (target:: 1) (unit:: 건) (period:: 누적)",
		"- [ ] 광고비를 빼고도 순이익이 나는 제품 1개 확인: … (due:: 2026-12-07) (kind:: 성과) (ms:: M-5c2d8e91) (start:: 2) (current:: 2) (target:: 1) (unit:: 개)",
	]);
	assert.match(r.detail, /노리는 성과 지표: 테스트 제품 3개 확정/);
	// A start that is there stays; clearing the choice removes aim only.
	const cleared = applyLinkChange(r.text, readMilestones(r.text).source, { kind: "aim", line: items[1].line, metrics: [] }, ids).text;
	assert.deepEqual(diff(r.text, cleared), ["- [ ] 테스트 제품 3개 확정: … (due:: 2026-11-27) (ms:: M-8a41d7e3)"]);
	// Missing current: start 0.
	const bare = "## 마일스톤\n- [ ] 오픈\n- [ ] 주문 (kind:: 성과)\n";
	assert.equal(applyLinkChange(bare, readMilestones(bare).source, { kind: "aim", line: 1, metrics: [2] }, () => "M-00000002").text, "## 마일스톤\n- [ ] 오픈 (aim:: M-00000002)\n- [ ] 주문 (kind:: 성과) (ms:: M-00000002) (start:: 0)\n");
	assert.throws(() => applyLinkChange(bare, readMilestones(bare).source, { kind: "aim", line: 1, metrics: [1] }, ids), /성과 지표 중에서/);
});

test("다시 검토: done milestone, open metric not above its start (missing = 0); shown only", () => {
	const text = (ms: string, metric: string) => `## 마일스톤\n${ms}\n${metric}\n`;
	const notes = (t: string) => reviewNotes(readMilestones(t).items).map(n => n.metric.text);
	const done = "- [x] 오픈 (ms:: M-00000001) (aim:: M-00000002)";
	assert.deepEqual(notes(text(done, "- [ ] 첫 주문 (kind:: 성과) (ms:: M-00000002) (start:: 0) (current:: 0)")), ["첫 주문"]);
	assert.deepEqual(notes(text(done, "- [ ] 첫 주문 (kind:: 성과) (ms:: M-00000002)")), ["첫 주문"]);
	assert.deepEqual(notes(text(done, "- [ ] 첫 주문 (kind:: 성과) (ms:: M-00000002) (start:: 3) (current:: 2)")), ["첫 주문"]);
	assert.deepEqual(notes(text(done, "- [ ] 첫 주문 (kind:: 성과) (ms:: M-00000002) (start:: 0) (current:: 1)")), []);
	assert.deepEqual(notes(text(done, "- [x] 첫 주문 (kind:: 성과) (ms:: M-00000002) (current:: 0)")), []);
	assert.deepEqual(notes(text("- [ ] 오픈 (ms:: M-00000001) (aim:: M-00000002)", "- [ ] 첫 주문 (kind:: 성과) (ms:: M-00000002)")), []);
	// The milestone and the metric are judged on their own: neither is changed.
	const t = text(done, "- [ ] 첫 주문 (kind:: 성과) (ms:: M-00000002)");
	assert.deepEqual(milestoneSummary(readMilestones(t).items), { done: 1, total: 2, label: "1/2 달성" });
});

test("추천 연결: exactly the three pairs for the example hub (as it is, and with kinds and ids)", () => {
	for (const ms of [MS_NOW, MS_KINDS]) {
		const got = recommendLinks(hubOf(ms)).map(x => [x.title, x.milestone]);
		assert.deepEqual(got, EXPECTED_PAIRS);
	}
	// One tap writes all of them: ids on milestones that lack one, ms on the groups; nothing else.
	const hub = hubOf(MS_NOW), sug = recommendLinks(hub);
	const out = applyLinkChange(hub, readMilestones(hub).source, { kind: "pairs", pairs: sug.map(x => ({ line: x.line, row: x.row })) }, (() => { const q = ["M-3f9a1c20", "M-c02b9f56", "M-8a41d7e3"]; return () => q.shift()!; })()).text;
	assert.deepEqual(diff(hub, out), [
		"- [ ] 자사몰 오픈: 아임웹 결제 테스트 통과 (due:: 2026-11-25) (ms:: M-3f9a1c20)",
		"- [ ] 테스트 제품 3개 확정: … (due:: 2026-11-27) (ms:: M-8a41d7e3)",
		"- [ ] 첫 광고 집행: … (due:: 2026-11-28) (ms:: M-c02b9f56)",
		"- [ ] 자사몰 세팅 (아임웹) (ms:: M-3f9a1c20)",
		"- [ ] 실내 원터치 난방텐트 판매 시작 (ms:: M-c02b9f56)",
		"- [ ] 테스트 제품 10개 정하기 (1/10: 실내 원터치 난방텐트) (ms:: M-8a41d7e3)",
	]);
	// Once linked, nothing is left to suggest.
	assert.deepEqual(recommendLinks(out), []);
});

test("추천 연결: nothing for ambiguous or unrelated titles", () => {
	const two = hubOf(["## 마일스톤", "- [ ] 자사몰 오픈", ""], ["## 할 일", "- [ ] 자사몰 세팅", "- [ ] 자사몰 세팅 2차", ""]);
	assert.deepEqual(recommendLinks(two), []);
	const twoMs = hubOf(["## 마일스톤", "- [ ] 자사몰 오픈", "- [ ] 자사몰 리뉴얼 오픈", ""], ["## 할 일", "- [ ] 자사몰 세팅", ""]);
	assert.deepEqual(recommendLinks(twoMs), []);
	const unrelated = hubOf(["## 마일스톤", "- [ ] 창간호 발송", "- [ ] 첫 주문", ""], ["## 할 일", "- [ ] 블로그 글쓰기", "- [ ] 운동 루틴 만들기", ""]);
	assert.deepEqual(recommendLinks(unrelated), []);
	// Outcomes (성과 지표), done milestones and done rows are not offered.
	const outcome = hubOf(["## 마일스톤", "- [ ] 첫 광고 집행 (kind:: 성과)", "- [x] 자사몰 오픈", ""], ["## 할 일", "- [ ] 판매 시작", "- [ ] 자사몰 세팅", ""]);
	assert.deepEqual(recommendLinks(outcome), []);
	assert.equal(linkScore("블로그 글쓰기", "첫 주문"), 0);
	assert.ok(linkScore("실내 원터치 난방텐트 판매 시작", "첫 주문") === 0);
});

test("a change elsewhere cancels: milestone section or the task line", () => {
	const hub = hubOf(MS_KINDS), m = readMilestones(hub), g = hubTopRows(hub)[0];
	const msChanged = hub.replace("첫 주문 (due", "첫 주문! (due");
	assert.throws(() => applyLinkChange(msChanged, m.source, { kind: "link", line: m.items[0].line, rows: [{ key: g.key, line: g.line }] }, ids), /다른 곳에서 변경됐어요/);
	const rowChanged = hub.replace("- [ ] 자사몰 세팅 (아임웹)", "- [ ] 자사몰 세팅 (카페24)");
	assert.throws(() => applyLinkChange(rowChanged, m.source, { kind: "link", line: m.items[0].line, rows: [{ key: g.key, line: g.line }] }, ids), /다른 곳에서 변경됐어요/);
});

function vault(){
	const data=new Map<string,string>(),nodes=new Map<string,any>();
	const addFolder=(path:string)=>{if(!path)return;const parts=path.split("/");for(let n=1;n<=parts.length;n++){const p=parts.slice(0,n).join("/");if(!nodes.has(p))nodes.set(p,new api.TFolder(p));}};
	const put=(path:string,text:string)=>{addFolder(path.slice(0,path.lastIndexOf("/")));data.set(path,text);nodes.set(path,new api.TFile(path));};
	const host:any={settings:{...api.DEFAULT_SETTINGS},app:{}};
	const app=host.app;
	app.metadataCache={getFileCache:(f:any)=>{const t=data.get(f.path)??"";return {frontmatter:parseFrontmatterText(t).data,frontmatterPosition:{end:{offset:t.indexOf("\n---",4)+4}}};}};
	app.vault={
		getAbstractFileByPath:(p:string)=>nodes.get(p)??null,
		getMarkdownFiles:()=>[...nodes.values()].filter(f=>f instanceof api.TFile&&f.path.endsWith(".md")),
		read:async(f:any)=>{if(!data.has(f.path))throw Error("missing "+f.path);return data.get(f.path);},
		cachedRead:async(f:any)=>data.get(f.path),
		createFolder:async(p:string)=>addFolder(p),
		create:async(p:string,t:string)=>{if(nodes.has(p))throw Error("exists "+p);put(p,t);return nodes.get(p);},
		process:async(f:any,fn:(s:string)=>string)=>{if(!data.has(f.path))throw Error("missing");data.set(f.path,fn(data.get(f.path)!));},
		trash:async()=>{},
	};
	app.fileManager={renameFile:async()=>{throw Error("no rename in this test");}};
	put(`${ROOT}/Pinboard Index.md`,INDEX);put(`${ROOT}/_Templates/Main Goal.md`,MAIN_TEMPLATE);put(`${ROOT}/_Templates/Sub Goal.md`,SUB_TEMPLATE);put("05 Project Folders/99 작업실/Project Folders Index.md",REGISTRY);put("12 Flywheel/Flywheel.md",WHEEL3);for(const [k,x] of Object.entries(HUBS))put(k,x);
	for(const [k,f]of Object.entries(TEMPLATE_FILES))put(`05 Project Folders/99 작업실/템플릿/${f}`,templates[k as keyof typeof templates]);
	return {host,data,put};
}
async function setup(){
	const v=vault();
	const main=await api.createGoalFlow(v.host,{input:INPUT},2026,undefined,TODAY);
	const sub=await api.createGoalFlow(v.host,{input:{...INPUT,title:"뉴스레터 첫 발행",measure:"milestone",target:"창간호 발송"},execution:{mode:"new",project:PROJECT}},2026,main.id,TODAY);
	const path=sub.projects[0].slice(2,-2)+".md";
	const {newMonthSkeleton}=await import("../src/desk/model.ts");
	v.put("03 Desk Calendar/2026/2026-10.md",newMonthSkeleton(2026,10,TODAY));
	v.put("03 Desk Calendar/Desk Calendar Index.md","---\nupdated: 2026-10-27\n---\n\n## 변경 기록\n");
	v.put("02 Wall Calendar/Wall Calendar Index.md","---\nupdated: 2026-10-27\n---\n\n## 변경 기록\n");
	let hub=v.data.get(path)!;
	// The example milestones and the bot's 할 일, written straight into the hub.
	hub=hub.replace(/^## 마일스톤[^]*?(?=^## )/m,"");
	hub=/^## 할 일\s*$/m.test(hub)?hub.replace(/^## 할 일[^]*?(?=^## |(?![^]))/m,TASKS.join("\n")+"\n"):hub.replace(/\n*$/,"\n\n"+TASKS.join("\n"));
	hub=hub.replace(/^## 할 일/m,MS_NOW.join("\n")+"\n## 할 일");
	v.data.set(path,hub);
	const {p}=await api.readProject(v.host,path);
	return {...v,p,path};
}
const logOf=(v:any)=>v.data.get(`${v.p.folder}/99 작업실/로그/${v.p.name} 로그 2026-01.md`)!;

test("actions: 한 번에 연결 writes the hub and the usual records in one batch; a stale view writes nothing", async()=>{
	const v=await setup();
	let hub=v.data.get(v.path)!;
	assert.equal(recommendLinks(hub).length,3,hub);
	const source=readMilestones(hub).source,pairs=recommendLinks(hub).map(x=>({line:x.line,row:x.row}));
	// Changed elsewhere first: cancelled, nothing written.
	v.data.set(v.path,hub.replace("- [ ] 첫 주문 (due","- [x] 첫 주문 (due"));
	const before=new Map(v.data);
	await assert.rejects(api.saveMilestoneLink(v.host,v.p,source,{kind:"pairs",pairs},TODAY),/다른 곳에서 변경됐어요/);
	assert.deepEqual(v.data,before);
	v.data.set(v.path,hub);
	await api.saveMilestoneLink(v.host,v.p,source,{kind:"pairs",pairs},TODAY);
	hub=v.data.get(v.path)!;
	assert.equal(readMilestones(hub).items.filter(i=>i.ms).length,3);
	assert.equal(hubTopRows(hub).filter(r=>r.ms).length,3);
	assert.match(logOf(v),/마일스톤 연결: 추천 연결 3건/);
	assert.match(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!,/추천 연결 3건/);
	// Progress counting is unchanged: still the top-level checkboxes (rule 「6-1」).
	assert.equal(milestoneSummary(readMilestones(hub).items).label,"0/8 달성");
});

test("actions: + 할 일, sub-task in place, assignment keeps ms on the reference only, 달성 확인 by the usual check", async()=>{
	const v=await setup();
	let hub=v.data.get(v.path)!;
	const open=readMilestones(hub).items[0];
	await api.saveMilestoneLink(v.host,v.p,readMilestones(hub).source,{kind:"addGroup",line:open.line,title:"결제 테스트",taskId:"T-pay",projectId:v.p.id},TODAY);
	hub=v.data.get(v.path)!;
	const ms=readMilestones(hub).items[0].ms!;
	assert.match(ms,MS_ID_RE);
	assert.match(hub,new RegExp(`- \\[ \\] 결제 테스트 \\(task:: T-pay\\) \\(project:: ${v.p.id}\\) \\(ms:: ${ms}\\)\\n`));
	// A 하위 할 일 added in the panel: no ms on it, it follows its 묶음.
	await api.changeProjectTask(v.host,v.p,{kind:"add",text:"카드 결제",id:"T-card",after:"T-pay",child:true},TODAY);
	hub=v.data.get(v.path)!;
	assert.match(hub,/\(ms:: M-[0-9a-f]{8}\)\n    - \[ \] 카드 결제 \(task:: T-card\) \(project:: [^)]+\)\n/);
	assert.deepEqual(milestoneTaskProgress(linkedRows(hub,ms)),{done:0,total:1});
	// Assign the 묶음's only 하위 할 일 to a day: the hub keeps a reference; the calendar line has no ms.
	const tasks=await api.loadProjectTasks(v.host,v.p,hub,true);
	await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:tasks.find((t:any)=>t.id==="T-card"),target:{kind:"day",date:"2026-10-28"}},TODAY);
	hub=v.data.get(v.path)!;
	assert.match(hub,new RegExp(`- \\[ \\] 결제 테스트 \\(task:: T-pay\\) \\(project:: ${v.p.id}\\) \\(ms:: ${ms}\\)\\n    - 카드 결제 \\(task:: T-card\\)`));
	assert.doesNotMatch(v.data.get("03 Desk Calendar/2026/2026-10.md")!,/ms::/);
	// Assigning a linked 단독 할 일: its reference line keeps (ms::).
	const g=hubTopRows(hub).find(r=>r.title==="자사몰 세팅 (아임웹)")!;
	await api.saveMilestoneLink(v.host,v.p,readMilestones(hub).source,{kind:"link",line:open.line,rows:[{key:g.key,line:g.line}]},TODAY);
	hub=v.data.get(v.path)!;
	assert.equal(linkedRows(hub,ms).length,2);
	// Finish the calendar copy: the reference counts as done through the calendar.
	const all=await api.loadProjectTasks(v.host,v.p,hub,true);
	await api.changeProjectTask(v.host,v.p,{kind:"toggle",task:all.find((t:any)=>t.id==="T-card"&&t.kind==="desk")},TODAY);
	hub=v.data.get(v.path)!;
	const {calendarStateOf}=await import("../src/projects/milestone-links.ts");
	const now=await api.loadProjectTasks(v.host,v.p,hub,true);
	const prog=milestoneTaskProgress(linkedRows(hub,ms),calendarStateOf(now));
	assert.deepEqual(prog,{done:1,total:4});
	assert.equal(readyToConfirm(readMilestones(hub).items[0],prog),false);
	// Nothing checked the milestone.
	assert.match(hub,/- \[ \] 자사몰 오픈: 아임웹 결제 테스트 통과/);
	// 달성 확인 goes through the usual check, with its records.
	await api.saveMilestone(v.host,v.p,readMilestones(hub).source,{kind:"check",line:open.line,done:true},TODAY);
	assert.match(v.data.get(v.path)!,/- \[x\] 자사몰 오픈: 아임웹 결제 테스트 통과 \(due:: 2026-11-25\) \(ms:: M-/);
	assert.match(logOf(v),/마일스톤 달성 확인/);
});
