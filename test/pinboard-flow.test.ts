import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import { inlineToken } from "../src/pinboard/inline-edit.ts";
import { readMilestones, milestoneSummary } from "../src/projects/milestones.ts";
import { getFmList, parseRegistry } from "../src/projects/ops.ts";
import { TEMPLATE_FILES } from "../src/projects/create.ts";
import { readGoal } from "../src/pinboard/create.ts";
import { TODAY, ROOT, MAIN_TEMPLATE, SUB_TEMPLATE, INDEX, REGISTRY, WHEEL, INPUT, PROJECT, templates } from "./support/pinboard-fixtures.ts";

// Real actions, real parsers, real templates; only the Obsidian storage adapter is simulated.
const temp=mkdtempSync(join(tmpdir(),"mylogs-pinboard-test-"));after(()=>rmSync(temp,{recursive:true,force:true}));
const stub=`export class App{};export class PluginSettingTab{};export class Setting{};export class Notice{constructor(message){globalThis.__notices?.push(message)}};export class TFile{constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.replace(/\\.md$/,'')}};export class TFolder{constructor(path){this.path=path;this.name=path.split('/').pop();this.children=[]}};export const normalizePath=p=>p.replace(/\\\\/g,'/').replace(/\\/+/g,'/').replace(/^\\/|\\/$/g,'');`;
const result=await build({stdin:{contents:`export * from './src/pinboard/create-actions.ts';export * from './src/projects/actions.ts';export * from './src/projects/milestone-actions.ts';export * from './src/projects/task-actions.ts';export * from './src/desk/actions.ts';export * from './src/pinboard/inline-actions.ts';export {DEFAULT_SETTINGS} from './src/settings.ts';export {TFile,TFolder} from 'obsidian';`,resolveDir:resolve(import.meta.dirname,"..")},bundle:true,format:"cjs",platform:"node",write:false,plugins:[{name:"mock-obsidian",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:stub,loader:"js"}));}}]});
const bundle=join(temp,"actions.cjs");writeFileSync(bundle,result.outputFiles[0].text);const api=createRequire(import.meta.url)(bundle);

function vault(){
	const data=new Map<string,string>(),nodes=new Map<string,any>(),trash:string[]=[],moves:string[][]=[];
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
		trash:async(f:any)=>{trash.push(f.path);for(const p of [...nodes.keys()])if(p===f.path||p.startsWith(f.path+"/")){nodes.delete(p);data.delete(p);}},
	};
	app.fileManager={renameFile:async(f:any,to:string)=>{const from=f.path;if(nodes.has(to))throw Error("exists "+to);addFolder(to.slice(0,to.lastIndexOf("/")));moves.push([from,to]);for(const p of [...nodes.keys()])if(p===from||p.startsWith(from+"/")){const n=nodes.get(p),np=to+p.slice(from.length);nodes.delete(p);n.path=np;nodes.set(np,n);if(data.has(p)){data.set(np,data.get(p)!);data.delete(p);}}for(const [p,t]of data)data.set(p,t.split(from+"/").join(to+"/"));}};
	put(`${ROOT}/Pinboard Index.md`,INDEX);put(`${ROOT}/_Templates/Main Goal.md`,MAIN_TEMPLATE);put(`${ROOT}/_Templates/Sub Goal.md`,SUB_TEMPLATE);put("05 Project Folders/99 작업실/Project Folders Index.md",REGISTRY);put("12 Flywheel/Flywheel.md",WHEEL);
	for(const [k,f]of Object.entries(TEMPLATE_FILES))put(`05 Project Folders/99 작업실/템플릿/${f}`,templates[k as keyof typeof templates]);
	return {host,data,nodes,trash,moves,put};
}
async function start(){const v=vault();const main=await api.createGoalFlow(v.host,{input:INPUT},2026,undefined,TODAY);const sub=await api.createGoalFlow(v.host,{input:{...INPUT,title:"뉴스레터 첫 발행",measure:"milestone",target:"창간호 발송"},execution:{mode:"new",project:PROJECT}},2026,main.id,TODAY);return {...v,main,sub};}

test("inline goal numeric save updates note, parent and index together",async()=>{
	const v=await start();let s=v.sub;
	for(const [field,value]of [["measure","metric"],["baseline","0"],["target","100"],["current","50"]])s=await api.saveInlineGoal(v.host,s,field,inlineToken(v.data.get(s.path)!,field as any),value,TODAY);
	assert.equal(s.progress,50);assert.equal(readGoal(v.data.get(v.main.path)!,v.main.path).progress,50);assert.match(v.data.get(`${ROOT}/Pinboard Index.md`)!,/50%/);
	assert.match(v.data.get(s.path)!,/\(value:: 50\)/);assert.deepEqual(getFmList(v.data.get(s.path)!,"project_ids"),[PROJECT.id]);
});
test("inline title rename uses FileManager and preserves goal links",async()=>{
	const v=await start(),s=await api.saveInlineGoal(v.host,v.sub,"title",v.sub.title,"뉴스레터 창간호 발송",TODAY);
	assert.equal(v.moves.length,1);assert.ok(!v.data.has(v.sub.path));assert.ok(v.data.has(s.path));assert.match(v.data.get(v.main.path)!,/뉴스레터 창간호 발송/);assert.doesNotMatch(v.data.get(v.main.path)!,/뉴스레터 첫 발행/);assert.match(v.data.get(`${ROOT}/Pinboard Index.md`)!,/뉴스레터 창간호 발송/);
});
test("inline save failures roll back notes/index and preserve drafts' source",async()=>{
	const v=await start(),before=new Map(v.data),real=v.host.app.vault.process;
	v.host.app.vault.process=async(f:any,fn:any)=>{if(f.path===`${ROOT}/Pinboard Index.md`)throw Error("disk full");return real(f,fn);};
	await assert.rejects(api.saveInlineGoal(v.host,v.sub,"title",v.sub.title,"다른 이름",TODAY),/저장을 취소/);assert.deepEqual(v.data,before);assert.equal(v.moves.length,0);
	v.host.app.vault.process=real;v.host.app.fileManager.renameFile=async()=>{throw Error("rename failed")};
	await assert.rejects(api.saveInlineGoal(v.host,v.sub,"title",v.sub.title,"다른 이름",TODAY),/수정을 취소/);assert.deepEqual(v.data,before);
});
test("inline title collision and same-field conflict do not write",async()=>{
	const v=await start();v.put(v.sub.path.replace(v.sub.title,"중복 제목"),"기존 파일");const before=new Map(v.data);
	await assert.rejects(api.saveInlineGoal(v.host,v.sub,"title",v.sub.title,"중복 제목",TODAY),/같은 이름/);assert.deepEqual(v.data,before);
	await assert.rejects(api.saveInlineGoal(v.host,v.sub,"title","옛 제목","새 제목",TODAY),/다른 곳/);assert.deepEqual(v.data,before);
});

test("milestone storage updates all records but no goal values or project status", async()=>{
	const v=await start(),path=v.sub.projects[0].slice(2,-2)+".md",{p}=await api.readProject(v.host,path),goal=v.data.get(v.sub.path),main=v.data.get(v.main.path),index=v.data.get(`${ROOT}/Pinboard Index.md`);
	await api.saveMilestone(v.host,p,"",{kind:"add",text:"창간호 검수 통과"},TODAY);
	let m=readMilestones(v.data.get(path)!);await api.saveMilestone(v.host,p,m.source,{kind:"check",line:m.items[0].line,done:true},TODAY);
	m=readMilestones(v.data.get(path)!);assert.equal(milestoneSummary(m.items).label,"1/1 달성");assert.match(v.data.get(path)!,/status: 후보/);
	assert.equal(v.data.get(v.sub.path),goal);assert.equal(v.data.get(v.main.path),main);assert.equal(v.data.get(`${ROOT}/Pinboard Index.md`),index);
	assert.match(v.data.get(`${p.folder}/99 작업실/로그/${p.name} 로그 2026-01.md`)!,/마일스톤 달성 확인/);
	assert.match(v.data.get(`${p.folder}/99 작업실/${p.name} 로그.md`)!,/1\/1 달성/);
	assert.match(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!,/마일스톤 달성 확인/);
	assert.equal(v.moves.length,0);
});
test("milestone stale source, archived hub and write failure are safe",async()=>{
	const v=await start(),path=v.sub.projects[0].slice(2,-2)+".md",{p}=await api.readProject(v.host,path);
	await api.saveMilestone(v.host,p,"",{kind:"add",text:"구성 확정"},TODAY);
	const before=new Map(v.data);await assert.rejects(api.saveMilestone(v.host,p,"",{kind:"add",text:"검수"},TODAY),/다른 곳/);assert.deepEqual(v.data,before);
	const real=v.host.app.vault.process;v.host.app.vault.process=async(f:any,fn:any)=>{if(f.path.endsWith("Project Folders Index.md"))throw Error("disk full");return real(f,fn)};
	await assert.rejects(api.saveMilestone(v.host,p,readMilestones(v.data.get(path)!).source,{kind:"add",text:"검수"},TODAY),/저장을 취소/);assert.deepEqual(v.data,before);
	v.host.app.vault.process=real;const archivePath=path.replace("05 Project Folders","10 Archive Box/Projects");v.put(archivePath,v.data.get(path)!);
	await assert.rejects(api.saveMilestone(v.host,{...p,path:archivePath},readMilestones(v.data.get(path)!).source,{kind:"add",text:"검수"},TODAY),/보관/);
});

test("milestone dates update project records only, never generate calendar tasks or complete a goal", async()=>{
	const v=await start(),path=v.sub.projects[0].slice(2,-2)+".md",{p}=await api.readProject(v.host,path);
	v.put("02 Wall Calendar/2026.md","# 미래\n"); v.put("03 Desk Calendar/2026/2026-01.md","# 이달\n"); v.put("04 Daily Pad/2026/2026-01-09.md","# 오늘\n");
	const before=new Map(v.data);
	await api.saveMilestone(v.host,p,"",{kind:"add",text:"창간호 검수",due:"2026-01-15"},TODAY);
	const m=readMilestones(v.data.get(path)!);
	await api.saveMilestone(v.host,p,m.source,{kind:"edit",line:m.items[0].line,text:"창간호 검수",due:"2026-02-01"},TODAY);
	assert.equal(readMilestones(v.data.get(path)!).items[0].due,"2026-02-01");
	assert.equal(readMilestones(v.data.get(path)!).items[0].done,false);
	for(const [name,text]of before)if(!name.startsWith("05 Project Folders/"))assert.equal(v.data.get(name),text);
	assert.match(v.data.get(`${p.folder}/99 작업실/로그/${p.name} 로그 2026-01.md`)!,/목표일 2026-01-15 → 2026-02-01/);
	assert.match(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!,/목표일 2026-01-15 → 2026-02-01/);
});

test("storage flow: Main → Sub + template project saves all originals and registries",async()=>{const v=await start();const hub=v.sub.projects[0].slice(2,-2)+".md";assert.ok(v.data.has(hub));assert.deepEqual(getFmList(v.data.get(hub)!,"goals"),[v.sub.id]);assert.equal(readGoal(v.data.get(v.main.path)!,v.main.path).subTotal,1);assert.match(v.data.get(`${ROOT}/Pinboard Index.md`)!,/뉴스레터 창간/);assert.equal(v.trash.length,0);});
test("storage flow: missing real project template creates neither Sub nor project",async()=>{const v=vault(),m=await api.createGoalFlow(v.host,{input:INPUT},2026,undefined,TODAY);const path="05 Project Folders/99 작업실/템플릿/허브.md";v.nodes.delete(path);v.data.delete(path);const before=[...v.data];await assert.rejects(api.createGoalFlow(v.host,{input:{...INPUT,title:"첫 발행"},execution:{mode:"new",project:PROJECT}},2026,m.id,TODAY),/필수 파일/);assert.deepEqual([...v.data],before);});
test("storage flow: existing project choice creates no duplicate folder and records both links",async()=>{const v=await start(),hub=v.sub.projects[0].slice(2,-2)+".md",count=v.nodes.size;const second=await api.createGoalFlow(v.host,{input:{...INPUT,title:"뉴스레터 구독자",baseline:"0",current:"10",target:"100"},execution:{mode:"project",path:hub}},2026,v.main.id,TODAY);assert.equal(v.nodes.size,count+1);assert.deepEqual(getFmList(v.data.get(hub)!,"goals"),[v.sub.id,second.id]);assert.ok(parseRegistry(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!).active[0].goals.includes(second.id));});
test("storage flow: Flywheel choice creates only a Sub, preserves element and no project",async()=>{const v=vault(),m=await api.createGoalFlow(v.host,{input:INPUT},2026,undefined,TODAY),count=v.nodes.size;const s=await api.createGoalFlow(v.host,{input:{...INPUT,title:"글쓰기 결과"},execution:{mode:"flywheel",id:"F-1",previous:""}},2026,m.id,TODAY);assert.equal(v.nodes.size,count+1);assert.match(v.data.get("12 Flywheel/Flywheel.md")!,new RegExp(`goal:: ${s.id.replaceAll(".","\\.")}`));assert.equal(parseRegistry(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!).active.length,0);});
test("storage flow: duplicate project blocks goal creation before writes",async()=>{const v=await start(),before=[...v.data];await assert.rejects(api.createGoalFlow(v.host,{input:{...INPUT,title:"다른 하위 목표"},execution:{mode:"new",project:PROJECT}},2026,v.main.id,TODAY),/이미 있는/);assert.deepEqual([...v.data],before);});
test("storage flow: unlink existing project updates hub, logs, both registries",async()=>{const v=await start(),hub=v.sub.projects[0].slice(2,-2)+".md";await api.connectProject(v.host,v.sub,hub,false,TODAY);assert.deepEqual(getFmList(v.data.get(hub)!,"goals"),[]);assert.deepEqual(getFmList(v.data.get(v.sub.path)!,"project_ids"),[]);assert.equal(parseRegistry(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!).active[0].goals,"");});
test("deletion support: keep project removes only deleted goal id and logs it",async()=>{const v=await start(),hub=v.sub.projects[0].slice(2,-2)+".md",errors:string[]=[];await api.removeGoalsFromProjects(v.host,[v.sub.id],errors);assert.deepEqual(errors,[]);assert.deepEqual(getFmList(v.data.get(hub)!,"goals"),[]);assert.equal(v.moves.length,0);assert.equal(v.trash.length,0);});
test("deletion support: archive uses FileManager, Completed registry, reason, no invented start date",async()=>{const v=await start(),hub=v.sub.projects[0].slice(2,-2)+".md",errors:string[]=[];await api.removeGoalsFromProjects(v.host,[v.sub.id],errors);const {p}=await api.readProject(v.host,hub);await api.completeProject(v.host,p,{started:p.started,completed:TODAY,result:"종료: 목표 삭제에 따라 보관"},errors);assert.deepEqual(errors,[]);assert.equal(v.moves.length,1);assert.match(v.moves[0][1],/^10 Archive Box\/Projects\/개인\//);const out=v.data.get(v.moves[0][1]+"/뉴스레터 창간.md")!;assert.match(out,/status: 완료/);assert.match(out,/started:\s*\n/);assert.match(out,/종료: 목표 삭제에 따라 보관/);assert.equal(parseRegistry(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!).done.length,1);});
test("deletion support: trash is recoverable and clears registry",async()=>{const v=await start(),hub=v.sub.projects[0].slice(2,-2)+".md",errors:string[]=[];await api.removeGoalsFromProjects(v.host,[v.sub.id],errors);const {p}=await api.readProject(v.host,hub);await api.deleteProject(v.host,p,errors);assert.deepEqual(errors,[]);assert.deepEqual(v.trash,[p.folder]);assert.equal(parseRegistry(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!).active.length,0);});
test("deletion support: Flywheel link cleanup leaves artifacts and checks alone",async()=>{const v=vault();v.put("12 Flywheel/F-2 몸 만들기/기록.md","김하루의 기록");const before=v.data.get("12 Flywheel/F-2 몸 만들기/기록.md");await api.unlinkDeletedFlywheel(v.host,["G-2026-09.1"],TODAY);assert.equal(v.data.get("12 Flywheel/F-2 몸 만들기/기록.md"),before);assert.doesNotMatch(v.data.get("12 Flywheel/Flywheel.md")!.split("## 변경 기록")[0],/G-2026-09.1/);assert.equal(v.trash.length,0);});
test("storage flow: injected index failure rolls back goal, hub and registry changes",async()=>{const v=vault(),m=await api.createGoalFlow(v.host,{input:INPUT},2026,undefined,TODAY),before=new Map(v.data),real=v.host.app.vault.process;v.host.app.vault.process=async(f:any,fn:any)=>{if(f.path===`${ROOT}/Pinboard Index.md`)throw Error("disk full");return real(f,fn);};await assert.rejects(api.createGoalFlow(v.host,{input:{...INPUT,title:"첫 발행"},execution:{mode:"new",project:PROJECT}},2026,m.id,TODAY),/저장을 취소/);assert.deepEqual(v.data,before);});

async function taskSetup(){
 const v=await start(),path=v.sub.projects[0].slice(2,-2)+".md",{p}=await api.readProject(v.host,path);
 const {newMonthSkeleton}=await import("../src/desk/model.ts");
 v.put("03 Desk Calendar/2026/2026-10.md",newMonthSkeleton(2026,10,TODAY));
 v.put("03 Desk Calendar/Desk Calendar Index.md","---\nupdated: 2026-10-27\n---\n\n## 변경 기록\n");
 v.put("02 Wall Calendar/Wall Calendar Index.md","---\nupdated: 2026-10-27\n---\n\n## 변경 기록\n");
 return {...v,p,path};
}
const getTasks=async(v:any,parents=false)=>api.loadProjectTasks(v.host,v.p,v.data.get(v.path),parents);
test("project tasks: hub → Desk date → completion is one canonical checkbox, goal untouched",async()=>{
 const v=await taskSetup(),goal=v.data.get(v.sub.path);
 await api.changeProjectTask(v.host,v.p,{kind:"add",text:"인터뷰 질문 작성",id:"T-first"},TODAY);
 let tasks=await getTasks(v);assert.equal(tasks.length,1);assert.equal(tasks[0].kind,"hub");
 await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:tasks[0],target:{kind:"day",date:"2026-10-28"}},TODAY);
 tasks=await getTasks(v);assert.equal(tasks.length,1);assert.equal(tasks[0].kind,"desk");assert.equal(tasks[0].date,"2026-10-28");
 assert.doesNotMatch(v.data.get(v.path)!,/- \[ \] 인터뷰 질문/);assert.match(v.data.get(v.path)!,/\(task:: T-first\)/);
 await api.changeProjectTask(v.host,v.p,{kind:"toggle",task:tasks[0]},TODAY);
 assert.equal((await getTasks(v))[0].state,"done");assert.equal(v.data.get(v.sub.path),goal);assert.ok(![...v.data.keys()].some(p=>p.startsWith("04 Daily Pad/")));
 assert.match(v.data.get("03 Desk Calendar/Desk Calendar Index.md")!,/할 일 완료/);
});
test("project tasks: future date routes to Wall, reschedule preserves id and moved history",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"인터뷰 질문 작성",id:"T-route"},TODAY);
 await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:(await getTasks(v))[0],target:{kind:"day",date:"2027-01-03"}},TODAY);
 let t=(await getTasks(v))[0];assert.equal(t.kind,"wall");assert.equal(t.date,"2027-01-03");assert.match(v.data.get("02 Wall Calendar/2027.md")!,/01\/03 인터뷰 질문/);
 await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:t,target:{kind:"day",date:"2026-10-29"}},TODAY);
 t=(await getTasks(v))[0];assert.equal(t.id,"T-route");assert.equal(t.kind,"desk");assert.match(t.line,/moved:: 1/);assert.match(v.data.get("02 Wall Calendar/2027.md")!,/\[>\]/);
});
test("project tasks: month → week → day uses existing allocation, paired title follows id",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"초고 쓰기",id:"T-plan"},TODAY);
 for(const target of [{kind:"month",month:"2026-10"},{kind:"week",monday:"2026-10-26"},{kind:"day",date:"2026-10-28"}]){
  const ts=await getTasks(v);assert.equal(ts.length,1);await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:ts[0],target},TODAY);
 }
 let ts=await getTasks(v);assert.equal(ts.length,1);assert.equal(ts[0].date,"2026-10-28");
 await api.changeProjectTask(v.host,v.p,{kind:"edit",task:ts[0],text:"창간호 초고 쓰기"},TODAY);
 const copies=(await getTasks(v,true)).filter((t:any)=>t.kind==="desk");assert.equal(copies.length,3);assert.ok(copies.every((t:any)=>t.title==="창간호 초고 쓰기"));
 await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:(await getTasks(v))[0],target:{kind:"day",date:"2026-10-29"}},TODAY);
 ts=await getTasks(v);assert.equal(ts.length,1);assert.equal(ts[0].date,"2026-10-29");
});
test("project tasks: conflicts, missing target, third move and archive never silently write",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"초고 쓰기",id:"T-safe"},TODAY);
 let t=(await getTasks(v))[0],before=new Map(v.data);
 await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"schedule",task:t,target:{kind:"week",monday:"2027-01-04"}},TODAY),/Desk Calendar/);assert.deepEqual(v.data,before);
 await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"schedule",task:{...t,line:t.line+" changed"},target:{kind:"day",date:"2026-10-28"}},TODAY),/바뀌/);assert.deepEqual(v.data,before);
 for(const date of ["2026-10-28","2026-10-29","2026-10-30"])await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:(await getTasks(v))[0],target:{kind:"day",date}},TODAY);
 t=(await getTasks(v))[0];before=new Map(v.data);await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"schedule",task:t,target:{kind:"day",date:"2026-10-31"}},TODAY),/세 번째/);assert.deepEqual(v.data,before);
});
test("project tasks: late registry failure rolls back calendar, hub and logs",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"초고 쓰기",id:"T-rollback"},TODAY);const t=(await getTasks(v))[0],before=new Map(v.data),real=v.host.app.vault.process;
 v.host.app.vault.process=async(f:any,fn:any)=>{if(f.path.endsWith("Project Folders Index.md"))throw Error("disk full");return real(f,fn);};
 await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"schedule",task:t,target:{kind:"day",date:"2026-10-28"}},TODAY),/저장을 취소/);assert.deepEqual(v.data,before);
});

test("calendar/Daily tracked task completion shares the project audit and ignores non-hub notes",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"초고 쓰기",id:"T-daily"},TODAY);
 await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:(await getTasks(v))[0],target:{kind:"day",date:"2026-10-28"}},TODAY);
 const t=(await getTasks(v))[0];assert.equal(await api.toggleLinkedProjectTask(v.host,t.path,t.index,t.line,TODAY),true);assert.equal((await getTasks(v))[0].state,"done");assert.match(v.data.get("05 Project Folders/99 작업실/Project Folders Index.md")!,/할 일 완료: 초고 쓰기/);
 assert.equal(await api.toggleLinkedProjectTask(v.host,t.path,0,"- [ ] 일반 할 일",TODAY),false);
});

test("project task scheduling rejects malformed date sections and preserves archive read-only",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"초고 쓰기",id:"T-missing"},TODAY);
 const t=(await getTasks(v))[0],calendar="03 Desk Calendar/2026/2026-10.md";v.data.set(calendar,v.data.get(calendar)!.replace("### 2026-10-28","### 날짜가 깨진 칸"));let before=new Map(v.data);
 await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"schedule",task:t,target:{kind:"day",date:"2026-10-28"}},TODAY),/달력 칸/);assert.deepEqual(v.data,before);
 await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"schedule",task:t,target:{kind:"day",date:"2026-02-30"}},TODAY),/날짜/);assert.deepEqual(v.data,before);
 const {p}=await api.readProject(v.host,v.path);await api.completeProject(v.host,p,{started:p.started,completed:TODAY,result:"종료: 김하루 확인"},[]);
 const archived=[...v.data.keys()].find((p:string)=>p.startsWith("10 Archive Box/Projects/")&&p.endsWith("/뉴스레터 창간.md"))!;const {p:ap}=await api.readProject(v.host,archived);before=new Map(v.data);
 await assert.rejects(api.changeProjectTask(v.host,ap,{kind:"add",text:"새 일",id:"T-archive"},TODAY),/보관/);assert.deepEqual(v.data,before);
});

test("project schedule does not overwrite a calendar edited between snapshot and commit",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"초고 쓰기",id:"T-race"},TODAY);const t=(await getTasks(v))[0],path="03 Desk Calendar/2026/2026-10.md",real=v.host.app.vault.read,hub=v.data.get(v.path);let n=0;
 v.host.app.vault.read=async(f:any)=>{const before=await real(f);if(f.path===path&&++n===2)v.data.set(path,before+"\n사용자가 동시에 적은 메모\n");return before;};
 await assert.rejects(api.changeProjectTask(v.host,v.p,{kind:"schedule",task:t,target:{kind:"day",date:"2026-10-28"}},TODAY),/동시 변경/);
 assert.equal(v.data.get(v.path),hub);assert.match(v.data.get(path)!,/사용자가 동시에 적은 메모/);assert.doesNotMatch(v.data.get(path)!,/초고 쓰기/);
});

test("creating the future Desk month migrates Wall tasks/events, retains ids and avoids repeat copies",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"표지 검수",id:"T-future"},TODAY);
 await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:(await getTasks(v))[0],target:{kind:"day",date:"2026-11-05"}},TODAY);
 const wall="02 Wall Calendar/2026.md";v.data.set(wall,v.data.get(wall)!.replace("## 2026-11\n","## 2026-11\n- 11/06 14:00 김하루의 인터뷰\n- [x] 11/01 완료된 일\n"));
 assert.equal(await api.createDeskMonth(v.host,"2026-11"),true);const ts=await getTasks(v);assert.equal(ts.length,1);assert.equal(ts[0].kind,"desk");assert.equal(ts[0].id,"T-future");assert.equal(ts[0].date,"2026-11-05");
 assert.match(v.data.get("03 Desk Calendar/2026/2026-11.md")!,/14:00 김하루의 인터뷰/);assert.doesNotMatch(v.data.get("03 Desk Calendar/2026/2026-11.md")!,/완료된 일/);assert.match(v.data.get(wall)!,/\[>\] 11\/05 표지 검수/);
 const before=new Map(v.data);assert.equal(await api.createDeskMonth(v.host,"2026-11"),false);assert.deepEqual(v.data,before);
});
test("future month creation failure restores Wall and leaves no partial Desk month",async()=>{
 const v=await taskSetup();await api.changeProjectTask(v.host,v.p,{kind:"add",text:"표지 검수",id:"T-future-fail"},TODAY);await api.changeProjectTask(v.host,v.p,{kind:"schedule",task:(await getTasks(v))[0],target:{kind:"month",month:"2026-11"}},TODAY);
 const before=new Map(v.data),real=v.host.app.vault.process;v.host.app.vault.process=async(f:any,fn:any)=>{if(f.path.endsWith("Wall Calendar Index.md"))throw Error("disk full");return real(f,fn);};
 assert.equal(await api.createDeskMonth(v.host,"2026-11"),false);assert.deepEqual(v.data,before);
});

test("new Desk month never migrates read-only historical Wall records",async()=>{
 const v=await taskSetup();v.put("02 Wall Calendar/2020.md","## 2020-01\n- [ ] 01/03 김하루의 과거 기록\n");const before=new Map(v.data);assert.equal(await api.createDeskMonth(v.host,"2020-01"),false);assert.deepEqual(v.data,before);
});
