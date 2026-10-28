import { parseFrontmatterText } from "../pinboard/model.ts";
import { refreshCalendarIndex } from "./calendar-index.ts";
import { type ProjectsHost } from "./actions.ts";
import type { Project } from "./model.ts";
import { exclusive, readProject, vaultIO } from "../pinboard/create-actions.ts";
import { commitBatch, type Write } from "../pinboard/batch.ts";
import { projectRecordWrites } from "./milestone-actions.ts";
import { cleanFolder } from "../settings.ts";
import { setFrontmatterScalar } from "../writer.ts";
import { appendLines, appendUnderWallMonth, wallYearSkeleton, prependChangeLog, setCheckbox, markMoved, copyTask, movedCount, planAssignDay, planAssignWeek, planMoveDay, type Plan, planEdit, pairedCopies } from "../desk/ops.ts";
import { mondayOf, isoWeekNo, mmdd, parseMonthFile } from "../desk/model.ts";
import { splitWallBody } from "../wall/parse.ts";
import { replaceContent, setFields, TIME_LEAD_RE } from "../line-edit.ts";
import { WALL_DATE_RE } from "../wall/parse.ts";
import { validMilestoneDate } from "./milestones.ts";
import { annotateGroups, appendChildTask, placeTask, appendHubTask, calendarTasks, executionTasks, hubTasks, replaceTaskLine, syncGroupChecks, taskLabel, taskTitle, type ProjectTask } from "./tasks.ts";

export type ScheduleTarget = { kind:"day"; date:string } | { kind:"month"; month:string } | { kind:"week"; monday:string };
export async function loadProjectTasks(host:ProjectsHost,p:Project,text:string, includeParents=false):Promise<ProjectTask[]> {
 const tasks=hubTasks(text,p.path,p.id),desk=cleanFolder(host.settings.deskCalendarFolder),wall=cleanFolder(host.settings.wallCalendarFolder);
 for(const f of host.app.vault.getMarkdownFiles()) {
  const d=f.path.startsWith(desk+"/") ? /\/(\d{4}-\d{2})\.md$/.exec(f.path):null;
  const w=f.path.startsWith(wall+"/") ? /\/(\d{4})\.md$/.exec(f.path):null;
  if(d||w)tasks.push(...calendarTasks(await host.app.vault.read(f),f.path,d?"desk":"wall",(d||w)![1]).filter(t=>t.projectId===p.id));
 }
 annotateGroups(tasks,text);
 return includeParents ? tasks : executionTasks(tasks).sort((a,b)=>Number(a.state!=="scheduled")-Number(b.state!=="scheduled")||(a.date??a.month??"").localeCompare(b.date??b.month??""));
}
export type TaskChange = {kind:"add";text:string;id:string;/** 하위 할 일 of this 묶음 / top-level task */parentId?:string} | {kind:"toggle";task:ProjectTask} | {kind:"edit";task:ProjectTask;text:string} | {kind:"schedule";task:ProjectTask;target:ScheduleTarget;reviewed?:string} | {kind:"level";id:string;/** null = out to the top level */parentId:string|null};
export const newTaskId=():string=>`T-${crypto.randomUUID()}`;
export function targetLabel(t:ScheduleTarget):string{return t.kind==="day"?t.date:t.kind==="month"?`${t.month} 이달 중`:`${t.monday} 주`}
/** No goal writes. Scheduling, canonical source and audit records commit or roll back together. */
export async function changeProjectTask(host:ProjectsHost,displayed:Project,change:TaskChange,today:string):Promise<void> {
 return exclusive(host,async()=>{
  const io=vaultIO(host.app),{p,text}=await readProject(host,displayed.path);
  if(p.id!==displayed.id||p.archived)throw Error("프로젝트가 바뀌었거나 보관됐어요.");
  const writes=new Map<string,Write>(), calendarIndexes=new Set<string>(), snapshots=new Map<string,string|null>([[p.path,text]]);
  const read=async(path:string)=>{if(writes.has(path))return writes.get(path)!.after;if(!snapshots.has(path))snapshots.set(path,await io.read(path));return snapshots.get(path)!;};
  const put=async(path:string,after:string)=>{const prev=writes.get(path),before=prev?prev.before:await read(path);writes.set(path,{path,before,after});};
  const deskRoot=cleanFolder(host.settings.deskCalendarFolder),wallRoot=cleanFolder(host.settings.wallCalendarFolder);
  const dp=(ym:string)=>`${deskRoot}/${ym.slice(0,4)}/${ym}.md`;
  let edited=text,detail="";
  const logCalendar=(kind:"desk"|"wall")=>calendarIndexes.add(kind==="desk"?`${deskRoot}/Desk Calendar Index.md`:`${wallRoot}/Wall Calendar Index.md`);
  if(change.kind==="level") {
   edited=placeTask(text,change.id,change.parentId);if(edited===text)return;
   const t=hubTasks(text,p.path,p.id).find(x=>x.id===change.id)?.title??change.id;
   detail=change.parentId?`할 일 위계: ${t} → ${hubTasks(text,p.path,p.id).find(x=>x.id===change.parentId)?.title??change.parentId} 아래로`:`할 일 위계: ${t} → 위 단계로`;
  }else if(change.kind==="add") {
   const title=taskTitle(change.text); if(!/^T-[a-zA-Z0-9-]+$/.test(change.id))throw Error("할 일 식별자를 확인해 주세요.");
   const all=await loadProjectTasks(host,p,text);if(all.some(t=>t.id===change.id))return;
   const row=`- [ ] ${title} (task:: ${change.id}) (project:: ${p.id})`;
   if(change.parentId){
    const parent=hubTasks(text,p.path,p.id).find(x=>x.id===change.parentId&&!/^\s/.test(x.line));
    if(!parent)throw Error("위 단계 할 일을 찾을 수 없어요. 배정한 할 일에는 하위 할 일을 붙이지 않아요.");
    edited=appendChildTask(text,parent.index,row);detail=`하위 할 일 추가: ${parent.title} · ${title}`;
   }else{edited=appendHubTask(text,row);detail=`할 일 추가: ${title}`;}
  }else{
   const t=change.task,all=await loadProjectTasks(host,p,text,true);
   if(t.projectId!==p.id||!all.some(x=>x.path===t.path&&x.index===t.index&&x.line===t.line))throw Error("할 일이 다른 곳에서 바뀌었어요. 다시 열어 주세요.");
   if(t.kind==="wall"&&t.month!<today.slice(0,7))throw Error("지난달 Wall Calendar 기록은 읽기 전용이에요.");
   const before=await read(t.path);if(before===null)throw Error("할 일 원본이 없어졌어요.");
   if(change.kind!=="schedule") {
    let line=t.line;
    if(change.kind==="toggle") {
     if(t.group)throw Error("묶음은 하위 할 일이 모두 끝나면 저절로 완료돼요.");
     if(t.desk && t.desk.section!=="day")throw Error("날짜를 배정한 뒤 날짜 칸의 할 일을 완료해 주세요.");
     if(!["done","scheduled"].includes(t.state))throw Error("취소된 일은 원본에서 확인해 주세요.");
     line=setCheckbox(line,t.state==="done"?" ":"x");detail=`할 일 ${t.state==="done"?"완료 취소":"완료"}: ${t.title}`;
    } else if(change.kind==="edit") {
     const title=taskTitle(change.text);line=line.replace(/^(\s*[-*+]\s+)(.*)$/,(_,a,b)=>a+replaceContent(b,title,t.kind==="wall"?WALL_DATE_RE:TIME_LEAD_RE));detail=`할 일 수정: ${t.title} → ${title}`;
    }
    if(change.kind==="edit"&&t.desk){
     const months=[];for(const f of host.app.vault.getMarkdownFiles()){const key=/\/(\d{4}-\d{2})\.md$/.exec(f.path);if(key&&f.path.startsWith(deskRoot+"/"))months.push(parseMonthFile(await host.app.vault.read(f),+key[1].slice(0,4),+key[1].slice(5,7)));}
     const plan=planEdit(t.desk,{text:change.text},pairedCopies(t.desk,months),null,today);
     for(const e of plan.edits){const path=dp(e.file),b=await read(path);if(b===null)throw Error("짝 원본이 없어졌어요.");const r=e.apply(b);if(!r.ok)throw Error("짝 원본이 바뀌었어요.");await put(path,r.text);}logCalendar("desk");
    }else{
    const after=replaceTaskLine(before,t,line);if(t.kind==="hub")edited=after;else{await put(t.path,setFrontmatterScalar(after,"updated",today));logCalendar(t.kind);}
    }
   }else{
    if(t.issue)throw Error(t.issue);
    if(t.group)throw Error("묶음은 배정하지 않아요. 하위 할 일을 하나씩 배정해 주세요.");
    if(t.state!=="scheduled")throw Error("완료·취소된 일은 배정하지 않아요.");
    const target=change.target,key=target.kind==="day"?target.date:target.kind==="week"?target.monday:target.month+"-01";
    if(!validMilestoneDate(key)||(target.kind==="week"&&mondayOf(key)!==key))throw Error("배정할 날짜를 확인해 주세요.");
    const ym=key.slice(0,7),deskText=await read(dp(ym)),kind=deskText!==null?"desk":"wall",path=kind==="desk"?dp(ym):`${wallRoot}/${ym.slice(0,4)}.md`;
    if(target.kind==="week"&&kind!=="desk")throw Error("그 주 월요일의 Desk Calendar가 없어요. 달 또는 날짜에 배정해 주세요.");
    if(kind==="wall"&&ym<today.slice(0,7))throw Error("지난달 Wall Calendar에는 배정할 수 없어요.");
    if(target.kind==="day"&&t.date===target.date&&path===t.path)return;
    if(target.kind==="day"&&t.id&&all.some(x=>x.id===t.id&&x.date===key&&x.state!=="moved"&&!(x.path===t.path&&x.index===t.index)))throw Error("그 날짜에 같은 할 일이 이미 있어요. 기존 항목을 확인해 주세요.");
    if(target.kind==="month"&&t.month===ym&&!t.date&&(!t.desk||t.desk.section==="during")&&path===t.path)return;
    if(target.kind==="week"&&t.desk?.section==="alloc"&&t.desk.monday===target.monday)return;
    if(t.date&&movedCount(t.line)>=2&&!change.reviewed)throw Error("세 번째 미루기: 의무·가치를 먼저 확인해 주세요.");
    // Existing Desk allocation grammar is retained for week/day assignments and day moves.
    let plan:Plan|undefined;
    if(t.desk&&kind==="desk") {
     if(t.desk.section==="during"&&target.kind==="week")plan=planAssignWeek(t.desk,target.monday,isoWeekNo(key),ym,today);
     if(t.desk.section==="alloc"&&target.kind==="day"&&t.desk.monday===mondayOf(key))plan=planAssignDay(t.desk,key,today);
     if(t.desk.section==="day"&&target.kind==="day") {
      const alloc=all.find(x=>x.desk?.section==="alloc"&&x.desk.key===t.desk?.key&&x.desk.assign.includes(t.date!))?.desk??null;
      plan=planMoveDay(t.desk,key,alloc,today);
     }
    }
    if(plan) {
     for(const e of plan.edits){const ep=e.month?dp(e.file):e.file,b=await read(ep);if(b===null)throw Error("배정 대상 파일이 없어요.");const r=e.apply(b);if(!r.ok)throw Error("배정 중 원본이 바뀌었어요: "+r.reason);await put(ep,r.text);}
     logCalendar("desk");
    }else{
     const id=t.id||newTaskId();let line=t.kind==="wall"?"- "+(()=>{const x=splitWallBody(t.line.replace(/^\s*[-*+]\s+/,""));return x.checkbox+(x.match?.[5]?x.match[5]+" ":"")+x.rest;})():t.line;
     line=copyTask(line,t.date?movedCount(t.line)+1:undefined).replace(/^(\s*[-*+]\s+)(.*)$/,(_,a,b)=>a+setFields(b,{task:id,project:p.id}));
     // A 하위 할 일 goes out flush and named with its 묶음; its hub reference keeps the indent.
     const indent=/^(\s*)/.exec(t.line)?.[1]??"";
     line=line.replace(/^\s+/,"");
     if(t.kind==="hub"&&t.parentTitle)line=line.replace(/^([-*+]\s+)(.*)$/,(_,a,b)=>a+replaceContent(b,taskLabel(t),TIME_LEAD_RE));
     if(t.kind==="hub")edited=replaceTaskLine(text,t,`${indent}- ${t.title} (task:: ${id}) (project:: ${p.id})`);
     else{const anchor=kind==="wall"?ym:target.kind==="day"?key:target.kind==="month"?"이달 중":"";const destination=`[[${path.replace(/\.md$/,"")}${anchor?"#"+anchor:""}]]`;await put(t.path,setFrontmatterScalar(replaceTaskLine(before,t,markMoved(t.line,destination,t.date?movedCount(t.line)+1:undefined)),"updated",today));logCalendar(t.kind);}
     const dest=await read(path);
     if(kind==="desk") {
      const where=target.kind==="day"?{kind:"day" as const,date:key}:target.kind==="week"?{kind:"alloc" as const,monday:key}:{kind:"during" as const};
      const r=appendLines(dest!,+ym.slice(0,4),+ym.slice(5,7),where,[line]);if(!r.ok)throw Error("달력 칸을 찾을 수 없어요: "+r.reason);await put(path,setFrontmatterScalar(r.text,"updated",today));
     }else{
      if(target.kind==="day")line=line.replace(/^(\s*[-*+]\s+\[ \]\s*)/,`$1${mmdd(key)} `);
      await put(path,setFrontmatterScalar(appendUnderWallMonth(dest??wallYearSkeleton(+ym.slice(0,4),today),ym,line),"updated",today));
     }
     logCalendar(kind);
    }
    detail=`할 일 배정: ${t.title} → ${targetLabel(target)}${change.reviewed ? ` · 계속할 이유: ${taskTitle(change.reviewed)}` : ""}`;
   }
  }
  // 묶음 checkboxes follow their 하위 할 일 (hub checkboxes, or calendar copies for assigned ones).
  if(change.kind==="toggle"||change.kind==="level"||(change.kind==="add"&&change.parentId)){
   const cal=(await loadProjectTasks(host,p,text,true)).filter(x=>x.kind!=="hub"&&x.state!=="moved");
   const flipped=change.kind==="toggle"&&change.task.kind!=="hub"?change.task:null;
   const hub=hubTasks(edited,p.path,p.id);
   edited=syncGroupChecks(edited,id=>{
    const h=hub.find(x=>x.id===id);if(h)return h.state;
    if(flipped?.id===id)return flipped.state==="done"?"scheduled":"done";
    const c=cal.filter(x=>x.id===id);if(!c.length)return undefined;
    return c.some(x=>x.state==="done")?"done":c.every(x=>x.state==="cancelled")?"cancelled":"scheduled";
   });
  }
  const calendarFiles=new Map<string,string>();
  if(calendarIndexes.size)for(const f of host.app.vault.getMarkdownFiles())if(f.path.startsWith(deskRoot+"/")||f.path.startsWith(wallRoot+"/"))calendarFiles.set(f.path,await read(f.path)??"");
  for(const w of writes.values())calendarFiles.set(w.path,w.after);
  for(const path of calendarIndexes){const before=await read(path);if(before===null)throw Error(`달력 등록부가 없어요: ${path}`);await put(path,prependChangeLog(refreshCalendarIndex(before,path.startsWith(deskRoot+"/")?"desk":"wall",calendarFiles,path.startsWith(deskRoot+"/")?deskRoot:wallRoot,today),today,`${p.id} ${detail}`));}
  const audit=await projectRecordWrites(host,p,text,edited,"할 일 관리",detail,"실행 상태만 변경. 목표·마일스톤은 유지",today);
  for(const [path,before] of snapshots)if(await io.read(path)!==before)throw Error(`동시 변경: ${path}. 저장하지 않았어요.`);
  await commitBatch(io,[...writes.values(),...audit]);
 });
}

/** Calendar/Daily checkbox entry point for id-tracked project tasks. Legacy tasks keep their old path. */
export async function toggleLinkedProjectTask(host:ProjectsHost,path:string,index:number,line:string,today:string):Promise<boolean>{
 const id=/\(task::\s*([^)]*)\)/.exec(line)?.[1]?.trim(),project=/\(project::\s*([^)]*)\)/.exec(line)?.[1]?.trim();
 if(!id||!project)return false;
 const {hubLocation}=await import("./model.ts"),{activeRoot,archiveRoot}=await import("./actions.ts");
 const found:Project[]=[];
 for(const f of host.app.vault.getMarkdownFiles())if(hubLocation(f.path,activeRoot(host),archiveRoot(host))){const raw=parseFrontmatterText(await host.app.vault.read(f));if(raw.data.type!=="project")continue;const {p}=await readProject(host,f.path);if(p.id===project)found.push(p);}
 if(found.length!==1)throw Error("연결된 프로젝트를 하나로 찾을 수 없어요. 원본을 확인해 주세요.");
 const p=found[0],text=await vaultIO(host.app).read(p.path),t=(await loadProjectTasks(host,p,text!,true)).find(t=>t.path===path&&t.index===index&&t.line===line);
 if(!t)throw Error("할 일 원본이 바뀌었어요. 다시 열어 주세요.");
 await changeProjectTask(host,p,{kind:"toggle",task:t},today);return true;
}
