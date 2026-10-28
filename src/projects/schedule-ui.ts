import type { ProjectsHost } from "./actions.ts";
import { tip } from "../ui/tip.ts";
import type { Project } from "./model.ts";
import { lastTopLevel, missingTaskRefs, previousTopLevel, type ProjectTask } from "./tasks.ts";
import { changeProjectTask, newTaskId } from "./task-actions.ts";
import { monthDays, weekdayMon0, shiftMonth, weekMondays, todayIsoLocal } from "../desk/model.ts";
import { applySchedule, MIME, scheduleSource, scheduleTarget, selectSchedule, selectedSchedule, TOUCH_DROP, type ScheduleItem } from "./schedule-dnd.ts";
export interface ScheduleState { month:string; draft:string; draftId?:string; editing?:ProjectTask; busy?:boolean; error?:string; select?:(item:ScheduleItem)=>void; calendar?:boolean /** undefined = open (default) */; /** The new-task input is indented (Tab): it adds under the last top-level task. */ indent?:boolean; refocus?:boolean; focusId?:string }
export function renderProjectSchedule(parent:HTMLElement,host:ProjectsHost,p:Project,tasks:ProjectTask[],state:ScheduleState,refresh:()=>Promise<void>, hubText=""):void {
 const root=parent.createDiv({cls:"pf-schedule"});
 const ms:ScheduleItem[]=(p.milestones??[]).map(m=>({kind:"milestone",projectPath:p.path,projectId:p.id,line:m.line,title:m.text,source:p.milestoneSource??"",date:m.due}));
 const ti=(task:ProjectTask):ScheduleItem=>({kind:"task",projectPath:p.path,projectId:p.id,title:task.title,task});
 state.select=item=>{selectSchedule(host,item);state.calendar=true;if(item.kind==="milestone"&&item.date)state.month=item.date.slice(0,7);paint();root.querySelector(".pf-schedule-calendar")?.scrollIntoView({block:"nearest"});root.querySelector<HTMLElement>(".pf-schedule-day")?.focus({preventScroll:true});};
 const button=(el:HTMLElement,text:string,action:()=>void,cls="")=>{const b=el.createEl("button",{text,cls,attr:{type:"button"}});b.disabled=!!state.busy;b.addEventListener("click",e=>{e.stopPropagation();action();});return b;};
 const run=async(action:()=>Promise<void>,clear=false)=>{if(state.busy)return;state.busy=true;state.error="";paint();try{await action();if(clear){state.draft="";state.editing=undefined;state.draftId=undefined;}selectSchedule(host,null);}catch(e){state.error=e instanceof Error?e.message:String(e);}finally{state.busy=false;paint();await refresh();}};
 const paint=()=>{
  root.empty();root.toggleClass("is-busy",!!state.busy);
  const head=root.createDiv({cls:"pf-schedule-head"});
  tip(head.createEl("h2",{text:"할 일·일정"}),p.archived?"보관된 프로젝트 · 읽기 전용":"할 일은 □, 마일스톤은 ◆. 항목을 달력 날짜로 끌거나, 항목을 누른 뒤 날짜를 누르면 배정돼요.");
  const selected=selectedSchedule(host),chosen=selected?.projectId===p.id?selected:null;
  // Open by default (2026-10-28); 「달력 접기」 folds it until the view is reopened.
  const calOpen=state.calendar!==false||!!chosen;
  button(head,calOpen?"달력 접기":"달력 펼치기",()=>{state.calendar=!calOpen;if(!state.calendar)selectSchedule(host,null);paint();},"pf-cal-toggle");
  const bar=root.createDiv({cls:"pf-schedule-selection",attr:{"aria-live":"polite"}});
  if(!chosen)bar.hide();
  bar.createSpan({text:chosen?`${chosen.kind==="milestone"?"◆":"□"} ${chosen.title} — 날짜를 선택하세요`:""});
  if(chosen)button(bar,"선택 취소",()=>{selectSchedule(host,null);paint();});
  if(chosen?.kind==="milestone"&&chosen.date&&!p.archived)button(bar,"날짜 해제",()=>void run(()=>applySchedule(host,chosen,null)));
  const layout=root.createDiv({cls:"pf-schedule-layout"}),list=layout.createDiv({cls:"pf-schedule-list"});
  // 할 일 목록 = an outline (two levels): Enter adds, Tab / Shift+Tab go in / out, rows drag onto
  // rows (in) or onto the 「할 일」 heading (out). The hub file keeps the order and indentation.
  const h3=list.createEl("h3",{text:"할 일"});
  const level=(id:string,parentId:string|null)=>{state.focusId=id;void run(()=>changeProjectTask(host,p,{kind:"level",id,parentId},todayIsoLocal()));};
  const dragged=()=>{const it=selectedSchedule(host);return it?.kind==="task"&&it.projectId===p.id&&it.task.id?it.task:null;};
  const dropZone=(el:HTMLElement,parentOf:(t:ProjectTask)=>string|null|undefined)=>{
   if(p.archived)return;
   el.addClass("ml-schedule-target","pf-outline-drop");
   const ok=()=>{const t=dragged();return t&&parentOf(t)!==undefined?t:null;};
   const go=()=>{const t=ok();if(!t)return;selectSchedule(host,null);level(t.id,parentOf(t)!);};
   el.addEventListener("dragover",e=>{if(!e.dataTransfer?.types.includes(MIME)||!ok())return;e.preventDefault();e.stopPropagation();el.addClass("ml-schedule-over");});
   el.addEventListener("dragleave",e=>{if(!el.contains(e.relatedTarget as Node|null))el.removeClass("ml-schedule-over");});
   el.addEventListener("drop",e=>{if(!e.dataTransfer?.types.includes(MIME)||!ok())return;e.preventDefault();e.stopPropagation();el.removeClass("ml-schedule-over");go();});
   el.addEventListener(TOUCH_DROP,e=>{if(ok()){e.stopPropagation();go();}});
  };
  // The heading takes a 하위 할 일 back out to the top level.
  dropZone(h3,t=>t.parentId?null:undefined);
  for(const title of missingTaskRefs(hubText,tasks))list.createDiv({cls:"pf-ms-error",text:`「${title}」의 달력 원본을 찾지 못했어요. 삭제·보류 여부를 확인해 주세요. 자동으로 다시 만들지 않습니다.`});
  if(!tasks.length)list.createEl("p",{cls:"pf-schedule-muted",text:"할 일이 없어요. 아래에 적고 Enter."});
  const shown=new Set(tasks.filter(t=>t.group).map(t=>t.id));
  const renderTask=(task:ProjectTask,depth:number)=>{
   const row=list.createDiv({cls:`pf-task-row${task.state==="done"?" is-done":""}${depth?" is-child":""}${task.group?" is-group":""}`,attr:{tabindex:"0","data-task":task.id}});
   const check=row.createEl("input",{attr:{type:"checkbox","aria-label":`${task.title} 완료`}});check.checked=task.state==="done";check.disabled=p.archived||!!state.busy||task.state==="cancelled"||!!task.group||!!(task.desk&&task.desk.section!=="day");
   if(task.group)tip(check,"하위 할 일이 모두 끝나면 저절로 완료돼요");
   check.addEventListener("change",()=>void run(()=>changeProjectTask(host,p,{kind:"toggle",task},todayIsoLocal())));
   const body=row.createDiv({cls:"pf-task-body"}),item=ti(task);
   if(task.issue)body.createDiv({cls:"pf-ms-error",text:task.issue});
   const schedulable=!p.archived&&task.state==="scheduled"&&!task.issue&&!task.group;
   const pick=button(body,task.title,()=>{if(schedulable)state.select?.(item);},"pf-task-title");
   const kids=task.group?tasks.filter(x=>x.parentId===task.id):[];
   body.createSpan({cls:"pf-schedule-muted",text:task.group?`하위 ${kids.filter(x=>x.state==="done").length}/${kids.length}`:task.state==="cancelled"?"놓아줌":task.date??(task.desk?.section==="alloc"?`${task.desk.monday} 주`:task.month?`${task.month} 이달 중`:"미배정")});
   // Dragging: onto a calendar slot (assign) or onto another row (in / out of a 묶음).
   if(!p.archived&&!state.busy&&task.id&&(schedulable||task.state!=="cancelled"))scheduleSource(pick,host,item);
   if(!p.archived&&task.id){
    row.addEventListener("keydown",e=>{
     const at=e.target as HTMLElement;if(e.key!=="Tab"||state.busy||at.closest(".pf-task-row")!==row||at.tagName==="INPUT"||at.closest("details"))return;
     e.preventDefault();
     if(e.shiftKey){if(depth)level(task.id,null);}
     else if(!depth&&!task.group){const prev=previousTopLevel(hubText,task.id);if(prev)level(task.id,prev);}
    });
    // A row takes the dragged task under it (a top-level row) or into its own 묶음 (a 하위 row).
    dropZone(row,t=>{if(t.id===task.id||t.group)return undefined;const target=depth?task.parentId!:task.id;return t.parentId===target||(!depth&&task.kind!=="hub")?undefined:target;});
    const more=row.createEl("details",{cls:"pf-task-more"});more.createEl("summary",{text:"⋯",attr:{"aria-label":`${task.title} 메뉴`}});
    button(more,"수정",()=>{state.editing=task;state.indent=false;state.draft=task.title;paint();root.querySelector<HTMLInputElement>(".pf-task-form input")?.focus();});
   }
   for(const k of kids)renderTask(k,1);
  };
  for(const task of tasks){if(task.parentId&&shown.has(task.parentId))continue;renderTask(task,0);}
  if(!p.archived){
   // One way in: type, Enter. Tab = under the last top-level task, Shift+Tab = back out. Esc clears.
   const parentId=state.indent&&!state.editing?lastTopLevel(hubText):null;
   const parentTitle=parentId?tasks.find(t=>t.id===parentId)?.title:"";
   const form=list.createEl("form",{cls:`pf-task-form${parentId?" is-child":""}`});
   const input=form.createEl("input",{attr:{type:"text",placeholder:state.editing?"할 일 수정 · Enter 저장 · Esc 취소":parentId?`「${parentTitle}」 하위 할 일 · Shift+Tab 나가기`:"할 일을 적고 Enter · Tab 하위로","aria-label":"프로젝트 할 일",enterkeyhint:"done"}});input.value=state.draft;input.disabled=!!state.busy;
   input.addEventListener("input",()=>{state.draft=input.value;});
   input.addEventListener("keydown",e=>{
    if(state.busy)return;
    if(e.key==="Escape"){state.draft="";state.editing=undefined;state.indent=false;state.draftId=undefined;paint();void refresh();}
    else if(e.key==="Tab"&&!state.editing){e.preventDefault();const want=!e.shiftKey;if(want&&!lastTopLevel(hubText))return;if(state.indent!==want){state.indent=want;state.refocus=true;paint();}}
   });
   form.addEventListener("submit",e=>{e.preventDefault();if(!state.draft.trim())return;const value=state.draft,editing=state.editing;state.draftId??=newTaskId();state.refocus=true;void run(()=>changeProjectTask(host,p,editing?{kind:"edit",task:editing,text:value}:{kind:"add",text:value,id:state.draftId!,parentId:parentId??undefined},todayIsoLocal()),true);});
   if(state.refocus){state.refocus=false;window.setTimeout(()=>{const x=root.querySelector<HTMLInputElement>(".pf-task-form input");x?.focus();},0);}
  }
  if(state.focusId&&!state.busy){const id=state.focusId;state.focusId=undefined;window.setTimeout(()=>root.querySelector<HTMLElement>(`.pf-task-row[data-task="${CSS.escape(id)}"]`)?.focus(),0);}
  const undated=ms.filter(m=>m.kind==="milestone"&&!m.date);
  if(undated.length){list.createEl("h3",{text:"날짜 미정 마일스톤"});for(const m of undated){const b=button(list,`◆ ${m.title}`,()=>state.select?.(m),"pf-schedule-milestone");if(!p.archived&&!state.busy)scheduleSource(b,host,m);}}
  layout.toggleClass("is-calendar-closed",!calOpen);
  const calendar=layout.createDiv({cls:"pf-schedule-calendar"}),nav=calendar.createDiv({cls:"pf-schedule-nav"});
  if(!calOpen)calendar.hide();
  button(nav,"‹",()=>{state.month=shiftMonth(state.month,-1);paint();}).setAttr("aria-label","이전 달");
  nav.createEl("strong",{text:state.month});button(nav,"오늘",()=>{state.month=todayIsoLocal().slice(0,7);paint();});
  button(nav,"›",()=>{state.month=shiftMonth(state.month,1);paint();}).setAttr("aria-label","다음 달");
  if(chosen)calendar.createDiv({cls:"pf-schedule-chosen",text:`${chosen.kind==="milestone"?"◆":"□"} ${chosen.title} — 날짜 선택`});
  const slots=calendar.createDiv({cls:"pf-schedule-slots"});
  const month=button(slots,"이달 중",()=>{});if(!p.archived)scheduleTarget(month,host,{kind:"month",month:state.month},refresh);
  for(const monday of weekMondays(+state.month.slice(0,4),+state.month.slice(5,7)).filter(d=>d.startsWith(state.month))){const b=button(slots,`${monday.slice(5).replace("-","/")} 주`,()=>{});if(!p.archived)scheduleTarget(b,host,{kind:"week",monday},refresh);}
  const grid=calendar.createDiv({cls:"pf-schedule-grid",attr:{"aria-label":`${state.month} 배정 달력`}});
  for(const day of ["월","화","수","목","금","토","일"])grid.createDiv({cls:"pf-schedule-weekday",text:day});
  const days=monthDays(+state.month.slice(0,4),+state.month.slice(5,7));for(let i=0;i<weekdayMon0(days[0]);i++)grid.createDiv({cls:"pf-schedule-blank"});
  for(const date of days){
   const cell=grid.createDiv({cls:`pf-schedule-day${date===todayIsoLocal()?" is-today":""}`,attr:{tabindex:"0",role:"button","aria-label":`${date}에 배정`,"data-date":date}});cell.createSpan({cls:"pf-schedule-daynum",text:String(+date.slice(8))});
   if(!p.archived&&!state.busy)scheduleTarget(cell,host,{kind:"day",date},refresh);
   const entries=[...ms.filter(m=>m.kind==="milestone"&&m.date===date),...tasks.filter(t=>t.date===date).map(ti)];
   for(const item of entries){const b=button(cell,`${item.kind==="milestone"?"◆":item.task.state==="done"?"✓":"□"} ${item.title}`,()=>{ if(chosen&&!p.archived)void run(()=>applySchedule(host,chosen,{kind:"day",date}));else if(item.kind==="milestone"||item.task.state==="scheduled")state.select?.(item); },item.kind==="milestone"?"pf-schedule-milestone":"pf-schedule-task");b.setAttr("title",item.title);if(!p.archived&&!state.busy&&(item.kind==="milestone"||item.task.state==="scheduled"))scheduleSource(b,host,item);}
  }
  if(state.error)root.createDiv({cls:"pf-ms-error",text:state.error,attr:{role:"alert"}});
 };
 paint();
}
