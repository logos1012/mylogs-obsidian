import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseFrontmatterText } from "../src/pinboard/model.ts";
import { getFmList, parseRegistry } from "../src/projects/ops.ts";
import { TEMPLATE_FILES } from "../src/projects/create.ts";
import { readGoal } from "../src/pinboard/create.ts";
import { TODAY, ROOT, MAIN_TEMPLATE, SUB_TEMPLATE, INDEX, REGISTRY, WHEEL, INPUT, PROJECT, templates } from "./support/pinboard-fixtures.ts";

// Real actions, real parsers, real templates; only the Obsidian storage adapter is simulated.
const temp=mkdtempSync(join(tmpdir(),"mylogs-pinboard-test-"));after(()=>rmSync(temp,{recursive:true,force:true}));
const stub=`export class App{};export class PluginSettingTab{};export class Setting{};export class Notice{constructor(message){globalThis.__notices?.push(message)}};export class TFile{constructor(path){this.path=path;this.name=path.split('/').pop();this.basename=this.name.replace(/\\.md$/,'')}};export class TFolder{constructor(path){this.path=path;this.name=path.split('/').pop();this.children=[]}};export const normalizePath=p=>p.replace(/\\\\/g,'/').replace(/\\/+/g,'/').replace(/^\\/|\\/$/g,'');`;
const result=await build({stdin:{contents:`export * from './src/pinboard/create-actions.ts';export * from './src/projects/actions.ts';export {DEFAULT_SETTINGS} from './src/settings.ts';export {TFile,TFolder} from 'obsidian';`,resolveDir:resolve(import.meta.dirname,"..")},bundle:true,format:"cjs",platform:"node",write:false,plugins:[{name:"mock-obsidian",setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:"obsidian",namespace:"mock"}));b.onLoad({filter:/.*/,namespace:"mock"},()=>({contents:stub,loader:"js"}));}}]});
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
