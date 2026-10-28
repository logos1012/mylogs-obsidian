import { Notice } from "obsidian";
import type { ProjectsHost } from "./actions.ts";
import { readProject } from "../pinboard/create-actions.ts";
import { saveMilestone } from "./milestone-actions.ts";
import { changeProjectTask, loadProjectTasks, type ScheduleTarget } from "./task-actions.ts";
import type { ProjectTask } from "./tasks.ts";
import { todayIsoLocal } from "../desk/model.ts";
import { askForm } from "../ui/modals.ts";
export type ScheduleItem = {kind:"milestone";projectPath:string;projectId:string;line:number;title:string;source:string;date?:string} | {kind:"task";projectPath:string;projectId:string;title:string;task:ProjectTask};
export const MIME="application/x-mylogs-project-schedule";
export const TOUCH_DROP="mylogs-schedule-drop";
let active:{app:object;item:ScheduleItem}|null=null;
/** Several picked at once (Wall 인박스: Shift / ⌘ click, or taps on a phone): one drop assigns them all. */
let many:{app:object;items:ScheduleItem[]}|null=null;
const same=(a:ScheduleItem,b:ScheduleItem)=>a.kind==="task"&&b.kind==="task"?a.task.id===b.task.id&&a.task.path===b.task.path&&a.task.index===b.task.index:a===b;
export const pickedSchedule=(host:ProjectsHost):ScheduleItem[]=>many?.app===host.app?many.items:[];
/** Add or take out one item of the multi-pick. */
export function togglePicked(host:ProjectsHost,item:ScheduleItem):void {
 const cur=pickedSchedule(host),has=cur.some(x=>same(x,item));
 const items=has?cur.filter(x=>!same(x,item)):[...cur,item];
 many=items.length?{app:host.app,items}:null;active=items.length?{app:host.app,item:items[items.length-1]}:null;
}
export const isPicked=(host:ProjectsHost,item:ScheduleItem):boolean=>pickedSchedule(host).some(x=>same(x,item));
let saving=false;
export const selectedSchedule=(host:ProjectsHost):ScheduleItem|null=>active?.app===host.app?active.item:null;
export function selectSchedule(host:ProjectsHost,item:ScheduleItem|null):void {active=item?{app:host.app,item}:null;if(!item||!isPicked(host,item))many=null;}
export function scheduleSource(el:HTMLElement,host:ProjectsHost,item:ScheduleItem):void {
 el.draggable=true;el.addClass("ml-schedule-draggable");
 touchDrag(el,host,item);
 el.addEventListener("dragstart",e=>{e.stopPropagation();if(isPicked(host,item))active={app:host.app,item};else selectSchedule(host,item);e.dataTransfer?.setData(MIME,"1");if(e.dataTransfer)e.dataTransfer.effectAllowed="move";el.addClass("is-dragging");});
 el.addEventListener("dragend",()=>{el.removeClass("is-dragging");if(!saving&&!isPicked(host,item))selectSchedule(host,null);});
}
export async function applySchedule(host:ProjectsHost,item:ScheduleItem,target:ScheduleTarget|null):Promise<void> {
 const {p}=await readProject(host,item.projectPath);if(p.id!==item.projectId||p.archived)throw Error("프로젝트가 바뀌었거나 보관됐어요.");
 if(item.kind==="milestone") {
  if(target&&target.kind!=="day")throw Error("마일스톤은 날짜 칸에 놓아 주세요.");
  await saveMilestone(host,p,item.source,{kind:"edit",line:item.line,text:item.title,due:target?.date??""},todayIsoLocal());
 }else{
  if(!target)throw Error("할 일을 배정할 달·주·날짜를 골라 주세요.");
  // A 묶음 goes to a month as a whole: each of its 하위 할 일 not yet assigned goes there.
  if(item.task.group){
   if(target.kind!=="month")throw Error("묶음은 달에만 놓아요. 하위 할 일은 Desk에서 주·날로 배정해요.");
   const {text}=await readProject(host,item.projectPath);
   const kids=(await loadProjectTasks(host,p,text!)).filter(t=>t.parentId===item.task.id&&t.kind==="hub"&&t.state==="scheduled");
   if(!kids.length)throw Error("달에 놓을 하위 할 일이 없어요.");
   for(const k of kids){const fresh=(await loadProjectTasks(host,p,(await readProject(host,item.projectPath)).text!)).find(t=>t.id===k.id&&t.kind==="hub");if(fresh)await changeProjectTask(host,p,{kind:"schedule",task:fresh,target},todayIsoLocal());}
   return;
  }
  const n=/\(moved::\s*(\d+)\)/.exec(item.task.line);let reviewed:string|undefined;
  if(item.task.date&&Number(n?.[1])>=2) {
   const v=await askForm(host.app,{title:"세 번째 미루기",desc:"반드시 해야 하는 일인가요? 나나 내 사람에게 중요한가요? 둘 다 아니라면 놓아주기를 고려하세요.",fields:[{key:"reason",label:"의무·가치와 못 한 이유",type:"text",value:""}],validate:v=>v.reason.trim()?[]:["계속할 이유를 적어 주세요."],cta:"확인하고 배정"});
   if(!v)throw Error("배정을 취소했어요.");reviewed=v.reason.trim();
  }
  await changeProjectTask(host,p,{kind:"schedule",task:item.task,target,reviewed},todayIsoLocal());
 }
}
export function scheduleTarget(el:HTMLElement,host:ProjectsHost,target:ScheduleTarget,refresh:()=>Promise<void>,done?:(item:ScheduleItem)=>void):void {
 el.addClass("ml-schedule-target");
 const accepts=()=>{const i=selectedSchedule(host);return !!i&&(i.kind!=="milestone"||target.kind==="day");};
 const run=async()=>{const item=selectedSchedule(host);if(!item||saving)return;
  // The dragged / chosen item, or every picked one when it is among them.
  const items=isPicked(host,item)?pickedSchedule(host):[item];
  saving=true;el.addClass("is-saving");const failed:string[]=[];
  try{for(const it of items){try{await applySchedule(host,it,target);done?.(it);}catch(e){failed.push(`「${it.title}」: ${e instanceof Error?e.message:String(e)}`);}}selectSchedule(host,null);await refresh();}
  finally{saving=false;el.removeClass("is-saving");if(failed.length)new Notice(failed.join("\n"));}};
 el.addEventListener("dragover",e=>{if(!e.dataTransfer?.types.includes(MIME)||!accepts())return;e.preventDefault();e.stopPropagation();if(e.dataTransfer)e.dataTransfer.dropEffect="move";el.addClass("ml-schedule-over");});
 el.addEventListener("dragleave",e=>{if(!el.contains(e.relatedTarget as Node|null))el.removeClass("ml-schedule-over");});
 el.addEventListener("drop",e=>{if(!e.dataTransfer?.types.includes(MIME)||!accepts())return;e.preventDefault();e.stopPropagation();el.removeClass("ml-schedule-over");void run();});
 el.addEventListener("click",e=>{if(!accepts()||(e.target as HTMLElement).closest(".ml-schedule-draggable, input, a, [role=checkbox]"))return;e.stopPropagation();void run();});
 // Touch drop (`touchDrag`): a custom event, so long-press click guards cannot swallow it.
 el.addEventListener(TOUCH_DROP,()=>{if(accepts())void run();});
 el.addEventListener("keydown",e=>{if(e.key==="Escape")selectSchedule(host,null);if(e.target===el&&(e.key==="Enter"||e.key===" ")&&accepts()){e.preventDefault();void run();}});
}

/**
 * Touch screens have no HTML5 drag: a long press (~350 ms) picks the item up, a ghost follows the
 * finger, and lifting it over a schedule target (`scheduleTarget`) drops it there — the same
 * `run()` as a click on that target. Moving before the press completes is an ordinary scroll.
 */
function touchDrag(el:HTMLElement,host:ProjectsHost,item:ScheduleItem):void {
 let timer:number|null=null,ghost:HTMLElement|null=null,over:HTMLElement|null=null,sx=0,sy=0,dragged=0;
 const targetAt=(x:number,y:number)=>{const hit=el.doc.elementFromPoint(x,y) as HTMLElement|null;return hit?.closest<HTMLElement>(".ml-schedule-target")??null;};
 const end=()=>{if(timer!==null)window.clearTimeout(timer);timer=null;ghost?.remove();ghost=null;over?.removeClass("ml-schedule-over");over=null;el.removeClass("is-dragging");};
 el.addEventListener("touchstart",e=>{
  if(e.touches.length!==1)return;const p=e.touches[0];sx=p.clientX;sy=p.clientY;
  e.stopPropagation(); // not the view-wide long-press menu: here a long press picks the item up
  timer=window.setTimeout(()=>{timer=null;if(isPicked(host,item))active={app:host.app,item};else selectSchedule(host,item);el.addClass("is-dragging");
   const n=pickedSchedule(host).length;
   ghost=el.doc.body.createDiv({cls:"ml-touch-ghost",text:n>1?`${n}개 · ${item.title} 외`:`◆ ${item.title}`});ghost.style.left=`${sx}px`;ghost.style.top=`${sy}px`;
   navigator.vibrate?.(10);},350);
 },{passive:true});
 el.addEventListener("touchmove",e=>{
  const p=e.touches[0];if(!p)return;
  if(!ghost){if(Math.abs(p.clientX-sx)>8||Math.abs(p.clientY-sy)>8)end();return;}
  e.preventDefault();ghost.style.left=`${p.clientX}px`;ghost.style.top=`${p.clientY}px`;
  const t=targetAt(p.clientX,p.clientY);if(t!==over){over?.removeClass("ml-schedule-over");over=t;over?.addClass("ml-schedule-over");}
 },{passive:false});
 el.addEventListener("touchend",e=>{
  if(!ghost){end();return;}
  const p=e.changedTouches[0],t=p?targetAt(p.clientX,p.clientY):null;end();dragged=Date.now();
  if(t)t.dispatchEvent(new CustomEvent(TOUCH_DROP));else selectSchedule(host,null);
 });
 el.addEventListener("touchcancel",()=>{end();selectSchedule(host,null);});
 // The tap that ends a drag must not also open the project / swallow-native menu.
 el.addEventListener("click",e=>{if(Date.now()-dragged<600){e.preventDefault();e.stopImmediatePropagation();}},{capture:true});
 el.addEventListener("contextmenu",e=>{if(ghost||timer!==null)e.preventDefault();});
}
