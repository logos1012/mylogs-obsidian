import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import { TEMPLATE_FILES } from "../src/projects/create.ts";
import { readMilestones } from "../src/projects/milestones.ts";
import { adoptHubRow, hubOutline, hubReferenceLine, hubRows, hubTasks, annotateGroups, insertTaskAfter, isRowKey, placeTask, previousTopLevel, removeHubRow, rowKey, syncGroupChecks } from "../src/projects/tasks.ts";
import { TODAY, ROOT, MAIN_TEMPLATE, SUB_TEMPLATE, INDEX, REGISTRY, WHEEL3, HUBS, INPUT, PROJECT, templates } from "./support/pinboard-fixtures.ts";

// Real actions and parsers; only the Obsidian storage adapter is simulated (as in pinboard-flow.test.ts).
const temp=mkdtempSync(join(tmpdir(),"mylogs-idless-test-"));after(()=>rmSync(temp,{recursive:true,force:true}));
const stub=`export class Modal{};export class SuggestModal{};export const moment=Object.assign((d)=>({format:()=>'',isoWeek:()=>1}),{});export function setIcon(){};export function setTooltip(){};export const Platform={isMobile:false};export const requestUrl=async()=>({status:0,text:""});export class App{};export class PluginSettingTab{};export class Setting{};export class Notice{constructor(message){globalThis.__notices?.push(message)}};export class TFile{constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.replace(/\\.md$/,'')}};export class TFolder{constructor(path){this.path=path;this.name=path.split('/').pop();this.children=[]}};export const normalizePath=p=>p.replace(/\\\\/g,'/').replace(/\\/+/g,'/').replace(/^\\/|\\/$/g,'');`;
const result=await build({stdin:{contents:`export * from './src/pinboard/create-actions.ts';export * from './src/projects/actions.ts';export * from './src/projects/milestone-actions.ts';export * from './src/projects/task-actions.ts';export * from './src/desk/actions.ts';export * from './src/pinboard/inline-actions.ts';export * from './src/pinboard/project-rollup.ts';export {DEFAULT_SETTINGS} from './src/settings.ts';export {LUMI_TOOLS} from './src/lumi/tools.ts';export {TFile,TFolder} from 'obsidian';`,resolveDir:resolve(import.meta.dirname,"..")},bundle:true,format:"cjs",platform:"node",write:false,plugins:[{name:"mock-obsidian",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:stub,loader:"js"}));}}]});
const bundle=join(temp,"actions.cjs");writeFileSync(bundle,result.outputFiles[0].text);const api=createRequire(import.meta.url)(bundle);

// 봇이 쓴 줄: `(task:: …)` 없이 묶음 + 4칸 들여쓴 하위.
const TASKS = [
	"## 할 일",
	"<!-- 미배정 할 일 -->",
	"- [ ] 자사몰 세팅 (아임웹) (ms:: M-3f9a1c20)",
	"    - [ ] 자사몰 이름 정하기",
	"    - [ ] 아임웹 결제 붙이기",
	"- [ ] 단독 일 (ms:: M-3f9a1c20)",
	"- [ ] 기존 일 (task:: T-old) (project:: P-newsletter)",
	"",
].join("\n");
const HUB = `---\ntype: project\nid: P-newsletter\n---\n# 뉴스레터\n\n${TASKS}\n## 비목표\n`;

test("id-less rows: shown with a row key, grouped, and viewing writes nothing", () => {
	const before = HUB;
	const rows = hubRows(HUB);
	assert.deepEqual(rows.map(r => [r.id, r.depth]), [["", 0], ["", 1], ["", 1], ["", 0], ["T-old", 0]]);
	assert.ok(rows.slice(0, 4).every(r => isRowKey(r.key)));
	assert.equal(rows[4].key, "T-old");
	const tasks = annotateGroups(hubTasks(HUB, "p.md", "P-newsletter"), HUB);
	assert.equal(tasks.length, 5);
	assert.deepEqual(tasks.map(t => t.title), ["자사몰 세팅 (아임웹)", "자사몰 이름 정하기", "아임웹 결제 붙이기", "단독 일", "기존 일"]);
	assert.equal(tasks[0].group, true);
	assert.equal(tasks[1].parentId, tasks[0].key); assert.equal(tasks[1].parentTitle, "자사몰 세팅 (아임웹)");
	assert.equal(hubOutline(HUB).groups.get(tasks[0].key!)?.children.length, 2);
	assert.equal(previousTopLevel(HUB, tasks[3].key!), tasks[0].key);
	assert.equal(HUB, before);
	// A plain note line (no checkbox) is still not a task.
	assert.equal(hubRows("## 할 일\n- 메모만 있는 줄\n").length, 0);
	// The key follows the exact text and position.
	assert.notEqual(rowKey(3, "- [ ] 가"), rowKey(3, "- [x] 가"));
	assert.notEqual(rowKey(3, "- [ ] 가"), rowKey(4, "- [ ] 가"));
});

test("adopting a row adds the id to that line only; a changed line cancels", () => {
	const key = hubRows(HUB)[1].key;
	const out = adoptHubRow(HUB, key, "T-new", "P-newsletter");
	const a = HUB.split("\n"), b = out.split("\n");
	assert.deepEqual(b.filter((l, i) => l !== a[i]), ["    - [ ] 자사몰 이름 정하기 (task:: T-new) (project:: P-newsletter)"]);
	assert.throws(() => adoptHubRow(HUB.replace("자사몰 이름 정하기", "가게 이름 정하기"), key, "T-new", "P-newsletter"), /다른 곳에서 변경됐어요/);
	// Lines above moved but the same text is there once: still found.
	const shifted = HUB.replace("<!-- 미배정 할 일 -->\n", "");
	assert.match(adoptHubRow(shifted, key, "T-new", "P-newsletter"), /자사몰 이름 정하기 \(task:: T-new\)/);
	// CRLF kept.
	const crlf = HUB.replaceAll("\n", "\r\n");
	assert.equal(adoptHubRow(crlf, hubRows(crlf)[1].key, "T-new", "P-newsletter"), out.replaceAll("\n", "\r\n"));
});

test("outline edits by row key: indent, outdent, insert and delete without adopting neighbours", () => {
	const [group, child, , single] = hubRows(HUB);
	const under = placeTask(HUB, single.key, group.key);
	assert.match(under, /    - \[ \] 아임웹 결제 붙이기\n    - \[ \] 단독 일 \(ms:: M-3f9a1c20\)\n- \[ \] 기존 일/);
	const out = placeTask(HUB, child.key, null);
	assert.match(out, /    - \[ \] 아임웹 결제 붙이기\n- \[ \] 자사몰 이름 정하기\n- \[ \] 단독 일/);
	assert.match(insertTaskAfter(HUB, group.key, "- [ ] 새 일 (task:: T-n) (project:: P)", true), /자사몰 세팅 \(아임웹\) \(ms:: M-3f9a1c20\)\n    - \[ \] 새 일/);
	assert.doesNotMatch(removeHubRow(HUB, single.key), /단독 일/);
	assert.throws(() => removeHubRow(HUB, group.key), /하위 할 일이 있어요/);
	assert.ok(!/task:: T-[^o]/.test(under + out));
});

test("a 묶음 waits for every 하위 할 일, id-less ones included", () => {
	const once = adoptHubRow(HUB, hubRows(HUB)[1].key, "T-a", "P-newsletter").replace("- [ ] 자사몰 이름 정하기 (task:: T-a)", "- [x] 자사몰 이름 정하기 (task:: T-a)");
	const state = (text: string) => { const hub = hubTasks(text, "p.md", "P"); return (id: string) => hub.find(x => x.key === id)?.state; };
	assert.equal(syncGroupChecks(once, state(once)), once);
	const all = once.replace("- [ ] 아임웹 결제 붙이기", "- [x] 아임웹 결제 붙이기");
	assert.match(syncGroupChecks(all, state(all)), /- \[x\] 자사몰 세팅 \(아임웹\) \(ms:: M-3f9a1c20\)\n/);
});

test("the hub reference line keeps (ms:: …) and other fields", () => {
	assert.equal(hubReferenceLine("- [ ] 자사몰 세팅 (아임웹) (ms:: M-3f9a1c20)", "자사몰 세팅 (아임웹)", "T-1", "P-1"), "- 자사몰 세팅 (아임웹) (task:: T-1) (project:: P-1) (ms:: M-3f9a1c20)");
	assert.equal(hubReferenceLine("    - [ ] 이름 (task:: T-1) (project:: P-1) (ms:: M-1) (why:: 메모)", "이름", "T-1", "P-1"), "    - 이름 (task:: T-1) (project:: P-1) (ms:: M-1) (why:: 메모)");
	assert.equal(hubReferenceLine("- [ ] 이름 (task:: T-1) (project:: P-1)", "이름", "T-1", "P-1"), "- 이름 (task:: T-1) (project:: P-1)");
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
	// The bot's lines, written straight into the hub.
	const hub=v.data.get(path)!;
	v.data.set(path,/^## 할 일\s*$/m.test(hub)?hub.replace(/^## 할 일[^\n]*\n/m,TASKS.split("\n").slice(0,-1).join("\n")+"\n"):hub.replace(/\n*$/,"\n\n"+TASKS));
	const {p}=await api.readProject(v.host,path);
	return {...v,p,path};
}
const tasksOf=async(v:any)=>api.loadProjectTasks(v.host,v.p,v.data.get(v.path),true) as Promise<any[]>;
const taskLines=(text:string)=>text.split("\n").filter(l=>/task::/.test(l));

test("id-less rows: loading never writes; the first toggle adopts that line in the same save", async()=>{
	const v=await setup(),before=new Map(v.data);
	const ts=await tasksOf(v);
	assert.equal(ts.filter((t:any)=>t.kind==="hub"&&!t.id).length,4);
	assert.deepEqual(v.data,before);
	const child=ts.find((t:any)=>t.title==="자사몰 이름 정하기");
	await api.changeProjectTask(v.host,v.p,{kind:"toggle",task:child},TODAY);
	const hub=v.data.get(v.path)!;
	assert.match(hub,/    - \[x\] 자사몰 이름 정하기 \(task:: T-[0-9a-f-]+\) \(project:: P-newsletter\)\n    - \[ \] 아임웹 결제 붙이기\n/);
	assert.deepEqual(taskLines(hub).filter(l=>!/기존 일/.test(l)).length,1);
	// The 묶음 stays open while another 하위 할 일 is open, and keeps no id.
	assert.match(hub,/- \[ \] 자사몰 세팅 \(아임웹\) \(ms:: M-3f9a1c20\)\n/);
	assert.match(v.data.get(`${v.p.folder}/99 작업실/로그/${v.p.name} 로그 2026-01.md`)!,/할 일 완료: 자사몰 이름 정하기/);
});

test("id-less rows: edit with the caller's id; indent adopts only the moved row", async()=>{
	const v=await setup();
	let ts=await tasksOf(v);
	const single=ts.find((t:any)=>t.title==="단독 일"),group=ts.find((t:any)=>t.group);
	await api.changeProjectTask(v.host,v.p,{kind:"edit",task:single,text:"단독 일 고침",adopt:{key:single.key,id:"T-mine"}},TODAY);
	assert.match(v.data.get(v.path)!,/\n- \[ \] 단독 일 고침 \(ms:: M-3f9a1c20\) \(task:: T-mine\) \(project:: P-newsletter\)\n/);
	ts=await tasksOf(v);
	const other=ts.find((t:any)=>t.title==="아임웹 결제 붙이기");
	await api.changeProjectTask(v.host,v.p,{kind:"level",id:other.key,parentId:null},TODAY);
	const hub=v.data.get(v.path)!;
	assert.match(hub,/    - \[ \] 자사몰 이름 정하기\n- \[ \] 아임웹 결제 붙이기 \(task:: T-[0-9a-f-]+\) \(project:: P-newsletter\)\n- \[ \] 단독 일 고침/);
	assert.match(hub,/- \[ \] 자사몰 세팅 \(아임웹\) \(ms:: M-3f9a1c20\)\n/);
	assert.ok(group);
});

test("id-less rows: a line changed elsewhere cancels the whole save", async()=>{
	const v=await setup(),ts=await tasksOf(v),child=ts.find((t:any)=>t.title==="아임웹 결제 붙이기");
	v.data.set(v.path,v.data.get(v.path)!.replace("아임웹 결제 붙이기","토스 결제 붙이기"));
	const before=new Map(v.data);
	await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"toggle",task:child},TODAY),/변경됐어요|바뀌었어요/);
	await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"edit",task:child,text:"새 이름",adopt:{key:child.key,id:"T-x"}},TODAY),/변경됐어요|바뀌었어요/);
	assert.deepEqual(v.data,before);
});

test("assigning an id-less row: the hub reference keeps (ms::), the calendar copy does not take it", async()=>{
	const v=await setup(),single=(await tasksOf(v)).find((t:any)=>t.title==="단독 일");
	await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:single,target:{kind:"day",date:"2026-10-28"}},TODAY);
	const hub=v.data.get(v.path)!,desk=v.data.get("03 Desk Calendar/2026/2026-10.md")!;
	const id=/- 단독 일 \(task:: (T-[0-9a-f-]+)\) \(project:: P-newsletter\) \(ms:: M-3f9a1c20\)\n/.exec(hub)?.[1];
	assert.ok(id,hub);
	assert.match(desk,new RegExp(`- \\[ \\] 단독 일 \\(task:: ${id}\\) \\(project:: P-newsletter\\)`));
	assert.doesNotMatch(desk,/ms::/);
});

test("milestone kinds, order and metric values save with the usual records", async()=>{
	const v=await setup();
	await api.saveMilestone(v.host,v.p,readMilestones(v.data.get(v.path)!).source,{kind:"add",text:"자사몰 오픈 완료"},TODAY);
	await api.saveMilestone(v.host,v.p,readMilestones(v.data.get(v.path)!).source,{kind:"add",text:"첫 주문"},TODAY);
	let m=readMilestones(v.data.get(v.path)!);
	const order=m.items.find(i=>i.text==="첫 주문")!;
	await api.saveMilestone(v.host,v.p,m.source,{kind:"setKind",line:order.line,to:"metric"},TODAY);
	m=readMilestones(v.data.get(v.path)!);
	await api.saveMilestone(v.host,v.p,m.source,{kind:"setMetric",line:order.line,target:"1",unit:"건",period:"누적"},TODAY);
	m=readMilestones(v.data.get(v.path)!);
	await api.saveMilestone(v.host,v.p,m.source,{kind:"setMetric",line:order.line,current:"0"},TODAY);
	m=readMilestones(v.data.get(v.path)!);
	await api.saveMilestone(v.host,v.p,m.source,{kind:"move",line:order.line,target:m.items[0].line,place:"before"},TODAY);
	const hub=v.data.get(v.path)!;
	assert.match(hub,new RegExp(`- \\[ \\] 첫 주문 \\(kind:: 성과\\) \\(current:: 0\\) \\(target:: 1\\) \\(unit:: 건\\) \\(period:: 누적\\) \\(as_of:: ${TODAY}\\)\\n- \\[ \\] 자사몰 오픈 완료`));
	const log=v.data.get(`${v.p.folder}/99 작업실/로그/${v.p.name} 로그 2026-01.md`)!;
	for(const verb of ["마일스톤 종류 변경","지표 설정","지표 값 수정","마일스톤 순서 변경"])assert.match(log,new RegExp(verb));
	assert.match(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!,/지표 값 수정: 첫 주문 · 현재 없음 → 0건/);
	// Stale view: cancelled, nothing written.
	const before=new Map(v.data);
	await assert.rejects(api.saveMilestone(v.host,v.p,m.source,{kind:"move",line:order.line,target:m.items[0].line,place:"after"},TODAY),/다른 곳/);
	assert.deepEqual(v.data,before);
});
