import { Notice } from "obsidian";
import type { ProjectsHost } from "./actions.ts";
import { readProject } from "../pinboard/create-actions.ts";
import { saveMilestone } from "./milestone-actions.ts";
import { changeProjectTask, type ScheduleTarget } from "./task-actions.ts";
import type { ProjectTask } from "./tasks.ts";
import { todayIsoLocal } from "../desk/model.ts";
import { askForm } from "../ui/modals.ts";
export type ScheduleItem = {kind:"milestone";projectPath:string;projectId:string;line:number;title:string;source:string;date?:string} | {kind:"task";projectPath:string;projectId:string;title:string;task:ProjectTask};
const MIME="application/x-mylogs-project-schedule";
let active:{app:object;item:ScheduleItem}|null=null;
let saving=false;
export const selectedSchedule=(host:ProjectsHost):ScheduleItem|null=>active?.app===host.app?active.item:null;
export function selectSchedule(host:ProjectsHost,item:ScheduleItem|null):void {active=item?{app:host.app,item}:null;}
export function scheduleSource(el:HTMLElement,host:ProjectsHost,item:ScheduleItem):void {
 el.draggable=true;el.addClass("ml-schedule-draggable");
 el.addEventListener("dragstart",e=>{e.stopPropagation();selectSchedule(host,item);e.dataTransfer?.setData(MIME,"1");if(e.dataTransfer)e.dataTransfer.effectAllowed="move";el.addClass("is-dragging");});
 el.addEventListener("dragend",()=>{el.removeClass("is-dragging");if(!saving)selectSchedule(host,null);});
}
export async function applySchedule(host:ProjectsHost,item:ScheduleItem,target:ScheduleTarget|null):Promise<void> {
 const {p}=await readProject(host,item.projectPath);if(p.id!==item.projectId||p.archived)throw Error("프로젝트가 바뀌었거나 보관됐어요.");
 if(item.kind==="milestone") {
  if(target&&target.kind!=="day")throw Error("마일스톤은 날짜 칸에 놓아 주세요.");
  await saveMilestone(host,p,item.source,{kind:"edit",line:item.line,text:item.title,due:target?.date??""},todayIsoLocal());
 }else{
  if(!target)throw Error("할 일을 배정할 달·주·날짜를 골라 주세요.");
  const n=/\(moved::\s*(\d+)\)/.exec(item.task.line);let reviewed:string|undefined;
  if(item.task.date&&Number(n?.[1])>=2) {
   const v=await askForm(host.app,{title:"세 번째 미루기",desc:"반드시 해야 하는 일인가요? 나나 내 사람에게 중요한가요? 둘 다 아니라면 놓아주기를 고려하세요.",fields:[{key:"reason",label:"의무·가치와 못 한 이유",type:"text",value:""}],validate:v=>v.reason.trim()?[]:["계속할 이유를 적어 주세요."],cta:"확인하고 배정"});
   if(!v)throw Error("배정을 취소했어요.");reviewed=v.reason.trim();
  }
  await changeProjectTask(host,p,{kind:"schedule",task:item.task,target,reviewed},todayIsoLocal());
 }
}
export function scheduleTarget(el:HTMLElement,host:ProjectsHost,target:ScheduleTarget,refresh:()=>Promise<void>):void {
 el.addClass("ml-schedule-target");
 const accepts=()=>{const i=selectedSchedule(host);return !!i&&(i.kind!=="milestone"||target.kind==="day");};
 const run=async()=>{const item=selectedSchedule(host);if(!item||saving)return;saving=true;el.addClass("is-saving");try{await applySchedule(host,item,target);selectSchedule(host,null);await refresh();}catch(e){new Notice(e instanceof Error?e.message:String(e));}finally{saving=false;el.removeClass("is-saving");}};
 el.addEventListener("dragover",e=>{if(!e.dataTransfer?.types.includes(MIME)||!accepts())return;e.preventDefault();e.stopPropagation();if(e.dataTransfer)e.dataTransfer.dropEffect="move";el.addClass("ml-schedule-over");});
 el.addEventListener("dragleave",e=>{if(!el.contains(e.relatedTarget as Node|null))el.removeClass("ml-schedule-over");});
 el.addEventListener("drop",e=>{if(!e.dataTransfer?.types.includes(MIME)||!accepts())return;e.preventDefault();e.stopPropagation();el.removeClass("ml-schedule-over");void run();});
 el.addEventListener("click",e=>{if(!accepts()||(e.target as HTMLElement).closest(".ml-schedule-draggable, input, a, [role=checkbox]"))return;e.stopPropagation();void run();});
 el.addEventListener("keydown",e=>{if(e.key==="Escape")selectSchedule(host,null);if(e.target===el&&(e.key==="Enter"||e.key===" ")&&accepts()){e.preventDefault();void run();}});
}
