import { withProjectRollup } from "./project-rollup.ts";
import { TFile, TFolder, normalizePath, type App } from "obsidian";
import { cleanFolder } from "../settings.ts";
import { type ProjectsHost, activeRoot, archiveRoot, registryPath } from "../projects/actions.ts";
import { TEMPLATE_FILES, type Templates, type TemplateKey } from "../projects/create.ts";
import { type Project, type NewProjectInput, hubLocation, parseProject, monthlyLogPath, logIndexPath, validateInput } from "../projects/model.ts";
import { goalLinkTexts, hubGoalsLinked } from "../projects/edit.ts";
import { getFmList, setFmValue, parseRegistry, appendLogEntry, formatLogEntry, newMonthlyLog, updateLogIndex, updateProjectAgents, upsertActiveRow, logRegistryChange } from "../projects/ops.ts";
import { type Goal, parseFrontmatterText, parseSections, bulletItems, findSectionText } from "./model.ts";
import { linkProject, unlinkProject } from "./goal-edit.ts";
import { INDEX_FILE, prependChangeLog } from "./index-writer.ts";
import { planGoal, attachNewProject, readGoal, setFlywheelGoal, upsertGoalRows } from "./create.ts";
import { commitBatch, type BatchIO, type Write } from "./batch.ts";
import type { GoalAnswer } from "./create-modal.ts";
import { parseFlywheel, flywheelPath } from "../flywheel/model.ts";

export function vaultIO(app:App):BatchIO {
	const createdFolders:string[]=[];
	const file=(path:string)=>{const f=app.vault.getAbstractFileByPath(normalizePath(path));if(f && !(f instanceof TFile))throw new Error(`파일 대신 폴더가 있어요: ${path}`);return f as TFile|null;};
	return {
		read:async path=>{const f=file(path);return f?app.vault.read(f):null;},
		create:async(path,text)=>{await ensureFolders(app,path.slice(0,path.lastIndexOf("/")),createdFolders);await app.vault.create(normalizePath(path),text);},
		compareWrite:async(path,before,after)=>{const f=file(path);if(!f)throw new Error(`파일 없음: ${path}`);await app.vault.process(f,text=>{if(text!==before)throw new Error(`동시 변경: ${path}`);return after;});},
		trashIfUnchanged:async(path,text)=>{const f=file(path);if(!f)return;if(await app.vault.read(f)!==text)throw new Error(`동시 변경: ${path}`);await app.vault.trash(f,true);},
		ensureFolder:async path=>ensureFolders(app,path,createdFolders),
		cleanupCreatedFolders:async()=>{for(const path of [...createdFolders].reverse()){const f=app.vault.getAbstractFileByPath(path);if(f instanceof TFolder&&f.children.length===0)await app.vault.trash(f,true);}},
	};
}
async function ensureFolders(app:App,path:string,created:string[]=[]):Promise<void>{const parts=normalizePath(path).split("/");for(let i=1;i<=parts.length;i++){const p=parts.slice(0,i).join("/");const f=app.vault.getAbstractFileByPath(p);if(f){if(!(f instanceof TFolder))throw new Error(`폴더 경로에 파일이 있어요: ${p}`);continue;}await app.vault.createFolder(p);created.push(p);}}
async function required(io:BatchIO,path:string):Promise<string>{const t=await io.read(path);if(t===null)throw new Error(`필수 파일이 없어요: ${path}`);return t;}
export async function strictTemplates(host:ProjectsHost):Promise<Templates>{const io=vaultIO(host.app),out={}as Templates;for(const k of Object.keys(TEMPLATE_FILES)as TemplateKey[])out[k]=await required(io,`${activeRoot(host)}/99 작업실/템플릿/${TEMPLATE_FILES[k]}`);return out;}
export async function readGoals(host:ProjectsHost):Promise<{goal:Goal;text:string}[]> {
	const root=cleanFolder(host.settings.pinboardFolder),out:{goal:Goal;text:string}[]=[];
	for(const f of host.app.vault.getMarkdownFiles()){if(!f.path.startsWith(root+"/")||!/^\d{4}\//.test(f.path.slice(root.length+1)))continue;const text=await host.app.vault.read(f);try{out.push({goal:readGoal(text,f.path),text});}catch{/* Non-goal attachments are not goal notes. */}}
	return out;
}
export async function readProject(host:ProjectsHost,path:string):Promise<{p:Project;text:string}>{
	const text=await required(vaultIO(host.app),path),fm=parseFrontmatterText(text),loc=hubLocation(path,activeRoot(host),archiveRoot(host));
	const p=loc?parseProject(fm.data,fm.body,loc,path):null;if(!p)throw new Error(`프로젝트 허브를 읽을 수 없어요: ${path}`);return {p,text};
}
export function relatedText(g:Goal,text:string,wheel:string):string{
	const means=bulletItems(findSectionText(parseSections(parseFrontmatterText(text).body),g.type==="main-goal"?"수단 (프로젝트·습관)":"수단")).filter(x=>!x.startsWith("<!--"));
	const fw=parseFlywheel(wheel).filter(e=>(e.fields.goal??"")===g.id).map(e=>`${e.id} ${e.name}`);
	return [...g.projects,...fw,...means].join(", ")||"—";
}
const busy=new WeakSet<object>();
export async function exclusive<T>(host:ProjectsHost,run:()=>Promise<T>):Promise<T>{if(busy.has(host.app))throw new Error("저장 중이에요. 잠시 기다려 주세요.");busy.add(host.app);try{return await run();}finally{busy.delete(host.app);}}

/** Existing-project link writes include every project record and the registry (「3-4」). */
async function projectSideWrites(host:ProjectsHost,path:string,goalId:string,link:boolean,today:string):Promise<Write[]> {
	const io=vaultIO(host.app),{p,text}=await readProject(host,path);if(p.archived)throw new Error("보관된 프로젝트의 연결은 바꾸지 않아요.");
	if(p.goals.includes(goalId)===link)return [];
	const templates=await strictTemplates(host),after=hubGoalsLinked(text,goalId,link,today),goals=getFmList(after,"goals");
	const t=goalLinkTexts(p,goalId,link,goals,p.action,today),ym=today.slice(0,7),mp=monthlyLogPath(p.folder,p.name,ym),lp=logIndexPath(p.folder,p.name),ap=p.folder+"/AGENTS.md",rp=registryPath(host);
	const m=await io.read(mp),l=await required(io,lp),a=await required(io,ap),r=await required(io,rp);
	const rr=upsertActiveRow(r,{id:p.id,goals:goals.join(", "),updated:today});if(!rr.ok)throw new Error(rr.reason);
	return [{path,before:text,after},{path:mp,before:m,after:m?appendLogEntry(m,formatLogEntry(t.entry)):newMonthlyLog(templates.monthlyLog,p.name,ym,formatLogEntry(t.entry))},{path:lp,before:l,after:updateLogIndex(l,{name:p.name,ym,today,recent:t.recent})},{path:ap,before:a,after:updateProjectAgents(a,{name:p.name,ym,today})},{path:rp,before:r,after:logRegistryChange(rr.text,today,t.change)}];
}
export async function createGoalFlow(host:ProjectsHost,answer:GoalAnswer,year:number,parentId:string|undefined,today:string):Promise<Goal>{return exclusive(host,async()=>{
	const io=vaultIO(host.app),root=cleanFolder(host.settings.pinboardFolder),existing=await readGoals(host),parent=existing.find(x=>x.goal.id===parentId);
	if(parentId&&!parent)throw new Error("상위 목표가 없어졌어요.");
	const index=await required(io,`${root}/${INDEX_FILE}`),template=await required(io,`${root}/_Templates/${parent?"Sub":"Main"} Goal.md`);
	let plan=planGoal({root,year,input:answer.input,template,index,existing:existing.map(x=>x.goal).filter(g=>g.id.startsWith(`G-${year}-`)),parent,today});
	const ex=answer.execution;
	if(parent&&!ex)throw new Error("실행 공간을 골라 주세요.");
	if(ex?.mode==="new"){
		const reg=await required(io,registryPath(host)),r=parseRegistry(reg),taken=[...r.active,...r.done];
		const problems=validateInput(ex.project,{ids:taken.map(p=>p.id),names:taken.map(p=>p.name)});if(problems.length)throw new Error(problems.join("\n"));
		if(host.app.vault.getAbstractFileByPath(`${activeRoot(host)}/${ex.project.scope}/${ex.project.name}`))throw new Error("같은 프로젝트가 생겼어요. 다시 열어 주세요.");
		plan=attachNewProject(plan,ex.project,await strictTemplates(host),{projectRoot:activeRoot(host),registryPath:registryPath(host),registry:reg,today});
	}else if(ex?.mode==="project"){
		const {p}=await readProject(host,ex.path);const gw=plan.writes.find(w=>w.path===plan.goal.path)!;gw.after=linkProject(gw.after,p.id,`[[${p.path.replace(/\.md$/,"")}]]`,today);
		plan.goal=readGoal(gw.after,gw.path);plan.writes.push(...await projectSideWrites(host,p.path,plan.goal.id,true,today));
	}else if(ex?.mode==="flywheel"){
		const wp=flywheelPath(host.settings.flywheelPath),w=await required(io,wp),after=setFlywheelGoal(w,ex.id,plan.goal.id,ex.previous,today);plan.writes.push({path:wp,before:w,after});
	}
	const wp=flywheelPath(host.settings.flywheelPath),wheel=plan.writes.find(w=>w.path===wp)?.after??await io.read(wp)??"";
	const indexWrite=plan.writes.find(w=>w.path===`${root}/${INDEX_FILE}`)!;
	const note=plan.writes.find(w=>w.path===plan.goal.path)!.after;
	indexWrite.after=upsertGoalRows(indexWrite.after,year,[plan.goal],new Map([[plan.goal.id,relatedText(plan.goal,note,wheel)]]));
	if(ex?.mode==="flywheel"&&ex.previous){const old=existing.find(x=>x.goal.id===ex.previous);if(old)indexWrite.after=upsertGoalRows(indexWrite.after,Number(old.goal.id.slice(2,6)),[old.goal],new Map([[old.goal.id,relatedText(old.goal,old.text,wheel)]]));}
	await commitBatch(io,await withProjectRollup(host,plan.writes,today),plan.folders);
	return plan.goal;
});}

export async function connectProject(host:ProjectsHost,g:Goal,path:string,link:boolean,today:string):Promise<void>{return exclusive(host,async()=>{
	const io=vaultIO(host.app),before=await required(io,g.path),goal=readGoal(before,g.path),{p}=await readProject(host,path);
	if(goal.id!==g.id||goal.type!=="sub-goal")throw new Error("하위 목표를 다시 확인해 주세요.");
	const after=link?linkProject(before,p.id,`[[${p.path.replace(/\.md$/,"")}]]`,today):unlinkProject(before,p.id,p.name,today);
	const ip=`${cleanFolder(host.settings.pinboardFolder)}/${INDEX_FILE}`,idx=await required(io,ip),wheel=await io.read(flywheelPath(host.settings.flywheelPath))??"";
	const ng=readGoal(after,g.path);let next=upsertGoalRows(idx,Number(g.id.slice(2,6)),[ng],new Map([[g.id,relatedText(ng,after,wheel)]]));next=setFmValue(prependChangeLog(next,today,`${g.id} ↔ ${p.id} ${link?"연결":"연결 해제"} (플러그인)`),"updated",today);
	await commitBatch(io,await withProjectRollup(host,[{path:g.path,before,after},...await projectSideWrites(host,path,g.id,link,today),{path:ip,before:idx,after:next}],today));
});}

export async function createProjectForGoal(host:ProjectsHost,g:Goal,input:NewProjectInput,today:string):Promise<void>{return exclusive(host,async()=>{
	const io=vaultIO(host.app),text=await required(io,g.path),goal=readGoal(text,g.path),ip=`${cleanFolder(host.settings.pinboardFolder)}/${INDEX_FILE}`,index=await required(io,ip),reg=await required(io,registryPath(host));
	if(goal.id!==g.id||goal.type!=="sub-goal")throw new Error("하위 목표를 다시 확인해 주세요.");
	const r=parseRegistry(reg),taken=[...r.active,...r.done],problems=validateInput(input,{ids:taken.map(p=>p.id),names:taken.map(p=>p.name)});if(problems.length)throw new Error(problems.join("\n"));
	if(host.app.vault.getAbstractFileByPath(`${activeRoot(host)}/${input.scope}/${input.name}`))throw new Error("같은 프로젝트 폴더가 이미 있어요.");
	const plan=attachNewProject({goal,folders:[],writes:[{path:g.path,before:text,after:text},{path:ip,before:index,after:index}]},input,await strictTemplates(host),{projectRoot:activeRoot(host),registryPath:registryPath(host),registry:reg,today});
	const gw=plan.writes.find(w=>w.path===g.path)!,iw=plan.writes.find(w=>w.path===ip)!,wheel=await io.read(flywheelPath(host.settings.flywheelPath))??"";
	iw.after=upsertGoalRows(iw.after,Number(g.id.slice(2,6)),[plan.goal],new Map([[g.id,relatedText(plan.goal,gw.after,wheel)]]));
	iw.after=setFmValue(prependChangeLog(iw.after,today,`${g.id} ↔ ${input.id} 프로젝트 생성·연결 (플러그인)`),"updated",today);
	await commitBatch(io,await withProjectRollup(host,plan.writes,today),plan.folders);
});}

export async function connectFlywheel(host:ProjectsHost,goal:Goal,id:string,expected:string,link:boolean,today:string):Promise<void>{return exclusive(host,async()=>{
	const io=vaultIO(host.app),wp=flywheelPath(host.settings.flywheelPath),w=await required(io,wp),after=setFlywheelGoal(w,id,link?goal.id:"",expected,today),ip=`${cleanFolder(host.settings.pinboardFolder)}/${INDEX_FILE}`,idx=await required(io,ip),goals=await readGoals(host);
	if(!goals.some(x=>x.goal.id===goal.id))throw new Error("목표가 삭제됐어요. 다시 열어 주세요.");
	let next=idx;for(const x of goals.filter(x=>[goal.id,expected].includes(x.goal.id)))next=upsertGoalRows(next,Number(x.goal.id.slice(2,6)),[x.goal],new Map([[x.goal.id,relatedText(x.goal,x.text,after)]]));
	next=setFmValue(prependChangeLog(next,today,`${id} 목표 연결 ${expected||"없음"} → ${link?goal.id:"없음"} (플러그인)`),"updated",today);
	await commitBatch(io,[{path:wp,before:w,after},{path:ip,before:idx,after:next}]);
});}

/** No element, artifact or checkbox is removed when a goal is deleted. */
export async function unlinkDeletedFlywheel(host:ProjectsHost,ids:string[],today:string):Promise<void>{
	const io=vaultIO(host.app),path=flywheelPath(host.settings.flywheelPath),before=await io.read(path);if(before===null)return;let after=before;
	for(const e of parseFlywheel(before))if(ids.includes(e.fields.goal??""))after=setFlywheelGoal(after,e.id,"",e.fields.goal,today);
	if(after!==before)await commitBatch(io,[{path,before,after}]);
}

export async function refreshRelatedIndex(host:ProjectsHost,ids:string[],today:string):Promise<void>{
	const io=vaultIO(host.app),path=`${cleanFolder(host.settings.pinboardFolder)}/${INDEX_FILE}`,before=await required(io,path),wheel=await io.read(flywheelPath(host.settings.flywheelPath))??"";let after=before;
	for(const x of (await readGoals(host)).filter(x=>ids.includes(x.goal.id)))after=upsertGoalRows(after,Number(x.goal.id.slice(2,6)),[x.goal],new Map([[x.goal.id,relatedText(x.goal,x.text,wheel)]]));
	if(after!==before)await commitBatch(io,[{path,before,after:setFmValue(after,"updated",today)}]);
}
