/** Project task projections. A checkbox has one home; assigned hub rows are references only. */
import { parseItem, splitLinesKeepEol, stripEol } from "../parser.ts";
import { findSection, detectEol } from "../writer.ts";
import { parseMonthFile, isoWeekNo, type DeskItem } from "../desk/model.ts";
import { parseWallYear } from "../wall/parse.ts";
export interface ProjectTask {
 path: string; index: number; line: string; id: string; projectId: string; title: string;
 state: "scheduled" | "done" | "moved" | "cancelled"; kind: "hub" | "desk" | "wall";
 date?: string; month?: string; desk?: DeskItem; issue?: string;
 /** 위계 (2026-10-28): a 하위 할 일 under a 묶음 (top-level hub row with indented rows under it). */
 parentId?: string; parentTitle?: string;
 /** A 묶음: done by itself when every 하위 할 일 is done; not scheduled itself. */
 group?: boolean;
}

/** A 묶음 row of the hub's `## 할 일` and the ids of its 하위 rows (checkbox or reference). */
export interface TaskGroup { id: string; title: string; index: number; line: string; children: string[] }

/**
 * Two levels only: a top-level row with indented rows under it is a 묶음; the indented rows are its
 * 하위 할 일. References (assigned rows, no checkbox) count, so a 하위 할 일 keeps its 묶음 once it
 * is on a calendar.
 */
export function hubOutline(text: string): { groups: Map<string, TaskGroup>; parentOf: Map<string, TaskGroup> } {
 const groups=new Map<string,TaskGroup>(),parentOf=new Map<string,TaskGroup>(),sec=findSection(text,"할 일");
 if(!sec)return {groups,parentOf};
 const lines=splitLinesKeepEol(text);let top:TaskGroup|null=null;
 for(let i=sec.headingIndex+1;i<lines.length;i++){
  const line=stripEol(lines[i]);if(/^#{1,2}\s/.test(line))break;
  const m=/^(\s*)[-*+]\s+(.*)$/.exec(line);if(!m)continue;
  const id=/\(task::\s*([^)]*)\)/.exec(m[2])?.[1]?.trim()||"";
  if(!m[1].length){top=id?{id,title:parseItem(m[2]).text,index:i,line,children:[]}:null;continue;}
  if(top&&id){top.children.push(id);groups.set(top.id,top);parentOf.set(id,top);}
 }
 return {groups,parentOf};
}

/** 하위 할 일 → its 묶음 (calendar copies included). */
export function annotateGroups(tasks: ProjectTask[], text: string): ProjectTask[] {
 const {groups,parentOf}=hubOutline(text);
 for(const t of tasks){const g=t.id?parentOf.get(t.id):undefined;if(g){t.parentId=g.id;t.parentTitle=g.title;}if(t.kind==="hub"&&t.id&&groups.has(t.id))t.group=true;}
 return tasks;
}

/** How a task reads outside its project: a 하위 할 일 carries its 묶음 (`3강 만들기 · 스크립트`). */
export function taskLabel(t: Pick<ProjectTask,"title"|"parentTitle">): string {
 return t.parentTitle&&!t.title.startsWith(t.parentTitle+" · ")?`${t.parentTitle} · ${t.title}`:t.title;
}

/** Insert a 하위 할 일 after the 묶음's last row (indented four spaces). A done 묶음 reopens. */
export function appendChildTask(text: string, parentIndex: number, line: string): string {
 const lines=splitLinesKeepEol(text),eol=detectEol(text);
 if(!/^[-*+]\s+\[[ xX]\]/.test(stripEol(lines[parentIndex]??"")))throw Error("하위 할 일은 아직 배정하지 않은 위 단계 할 일에만 붙여요.");
 lines[parentIndex]=lines[parentIndex].replace(/^([-*+]\s+\[)[xX](\])/,"$1 $2");
 let i=parentIndex+1;
 while(i<lines.length&&/^\s+[-*+]\s/.test(stripEol(lines[i])))i++;
 if(!lines[i-1].endsWith("\n"))lines[i-1]+=eol;
 lines.splice(i,0,"    "+line.replace(/^\s+/,"")+eol);return lines.join("");
}

/**
 * Move a hub row (checkbox or reference, by task id) under `parentId` (a top-level row with a
 * checkbox), or out to the top level (`null`: right after the 묶음 it was in). Two levels only: a
 * 묶음 with 하위 할 일 can't go under another row.
 */
export function placeTask(text: string, id: string, parentId: string | null): string {
 const sec=findSection(text,"할 일");if(!sec)throw Error("할 일 섹션이 없어요.");
 const lines=splitLinesKeepEol(text),eol=detectEol(text);
 let end=sec.headingIndex+1;while(end<lines.length&&!/^#{1,2}\s/.test(stripEol(lines[end])))end++;
 const idOf=(i:number)=>/\(task::\s*([^)]*)\)/.exec(stripEol(lines[i]))?.[1]?.trim()??"";
 const isList=(i:number)=>/^\s*[-*+]\s/.test(stripEol(lines[i]));
 const isChild=(i:number)=>/^\s+[-*+]\s/.test(stripEol(lines[i]));
 const blockEnd=(top:number)=>{let j=top+1;while(j<end&&isChild(j))j++;return j;};
 const at=lines.findIndex((_,i)=>i>sec.headingIndex&&i<end&&isList(i)&&idOf(i)===id);
 if(at<0)throw Error("할 일을 찾을 수 없어요. 다시 열어 주세요.");
 const child=isChild(at);
 if(parentId===null&&!child)return text;
 if(parentId!==null&&!child&&blockEnd(at)>at+1)throw Error("하위 할 일이 있는 묶음은 다른 할 일 아래로 넣을 수 없어요. 위계는 두 단계까지예요.");
 if(parentId===id)return text;
 // The 묶음 this row is in now (for an outdent, it goes right after that block).
 let top=at;while(top>sec.headingIndex&&isChild(top))top--;
 if(parentId!==null&&child&&idOf(top)===parentId)return text;
 const row=stripEol(lines[at]).replace(/^\s+/,"");
 lines.splice(at,1);end--;
 if(parentId===null){
  const j=blockEnd(top);
  lines.splice(j,0,row+eol);
 }else{
  const p=lines.findIndex((_,i)=>i>sec.headingIndex&&i<end&&isList(i)&&!isChild(i)&&idOf(i)===parentId);
  if(p<0)throw Error("위 단계 할 일을 찾을 수 없어요.");
  if(!/^[-*+]\s+\[[ xX]\]/.test(stripEol(lines[p])))throw Error("배정한 할 일 아래에는 넣을 수 없어요.");
  const j=blockEnd(p);
  if(j>0&&!lines[j-1].endsWith("\n"))lines[j-1]+=eol;
  lines.splice(j,0,"    "+row+eol);
 }
 return lines.join("");
}

/**
 * Insert a new hub row right after the row `afterId` (null: at the end). `child`: as a 하위 할 일 —
 * of `afterId` itself when it is top-level, else of its 묶음. Not child: after the whole block.
 */
export function insertTaskAfter(text: string, afterId: string | null, line: string, child: boolean): string {
 const row=line.replace(/^\s+/,"");
 const sec=findSection(text,"할 일");
 if(!sec||afterId===null){
  if(!child)return appendHubTask(text,row);
  const last=lastTopLevel(text);if(!last)throw Error("하위로 넣을 위 단계 할 일이 없어요.");
  return insertTaskAfter(text,last,row,true);
 }
 const lines=splitLinesKeepEol(text),eol=detectEol(text);
 let end=sec.headingIndex+1;while(end<lines.length&&!/^#{1,2}\s/.test(stripEol(lines[end])))end++;
 const idOf=(i:number)=>/\(task::\s*([^)]*)\)/.exec(stripEol(lines[i]))?.[1]?.trim()??"";
 const isChild=(i:number)=>/^\s+[-*+]\s/.test(stripEol(lines[i]));
 const at=lines.findIndex((_,i)=>i>sec.headingIndex&&i<end&&/^\s*[-*+]\s/.test(stripEol(lines[i]))&&idOf(i)===afterId);
 if(at<0)throw Error("할 일을 찾을 수 없어요. 다시 열어 주세요.");
 let top=at;while(top>sec.headingIndex&&isChild(top))top--;
 let j:number;
 if(child){
  if(!/^[-*+]\s+\[[ xX]\]/.test(stripEol(lines[top])))throw Error("배정한 할 일 아래에는 넣을 수 없어요.");
  if(!isChild(at)&&at!==top)throw Error("위계는 두 단계까지예요.");
  j=at+1;
  lines[top]=lines[top].replace(/^([-*+]\s+\[)[xX](\])/,"$1 $2");
 }else{j=top+1;while(j<end&&isChild(j))j++;}
 if(j>0&&!lines[j-1].endsWith("\n"))lines[j-1]+=eol;
 lines.splice(j,0,(child?"    ":"")+row+eol);
 return lines.join("");
}

/** Remove the hub row of task `id` (a 묶음 only once it has no 하위 할 일). */
export function removeHubRow(text: string, id: string): string {
 const lines=splitLinesKeepEol(text),sec=findSection(text,"할 일");if(!sec)throw Error("할 일 섹션이 없어요.");
 let end=sec.headingIndex+1;while(end<lines.length&&!/^#{1,2}\s/.test(stripEol(lines[end])))end++;
 const at=lines.findIndex((l,i)=>i>sec.headingIndex&&i<end&&/^\s*[-*+]\s/.test(stripEol(l))&&/\(task::\s*([^)]*)\)/.exec(stripEol(l))?.[1]?.trim()===id);
 if(at<0)throw Error("할 일을 찾을 수 없어요. 다시 열어 주세요.");
 if(!/^\s/.test(stripEol(lines[at]))&&at+1<end&&/^\s+[-*+]\s/.test(stripEol(lines[at+1])))throw Error("하위 할 일이 있어요. 하위 할 일을 먼저 옮기거나 지워 주세요.");
 lines.splice(at,1);return lines.join("");
}

/** Hub rows in file order (checkbox or reference), with their level. */
export function hubRows(text: string): { id: string; depth: 0 | 1; ref: boolean; index: number }[] {
 const sec=findSection(text,"할 일");if(!sec)return [];
 const lines=splitLinesKeepEol(text).map(stripEol),out:{ id: string; depth: 0 | 1; ref: boolean; index: number }[]=[];
 for(let i=sec.headingIndex+1;i<lines.length;i++){
  if(/^#{1,2}\s/.test(lines[i]))break;
  const m=/^(\s*)[-*+]\s+(.*)$/.exec(lines[i]);if(!m)continue;
  const id=/\(task::\s*([^)]*)\)/.exec(m[2])?.[1]?.trim()??"";if(!id)continue;
  out.push({id,depth:m[1].length?1:0,ref:!/^\[.\]/.test(m[2]),index:i});
 }
 return out;
}

/** The top-level row right above this one in the hub (where Tab puts it), or null. */
export function previousTopLevel(text: string, id: string): string | null {
 const sec=findSection(text,"할 일");if(!sec)return null;
 const lines=splitLinesKeepEol(text).map(stripEol);let prev:string|null=null;
 for(let i=sec.headingIndex+1;i<lines.length;i++){
  if(/^#{1,2}\s/.test(lines[i]))break;
  const m=/^(\s*)[-*+]\s+(.*)$/.exec(lines[i]);if(!m)continue;
  const tid=/\(task::\s*([^)]*)\)/.exec(m[2])?.[1]?.trim()??"";
  if(tid===id)return prev;
  if(!m[1].length&&tid)prev=/^\[[ xX]\]/.test(m[2])?tid:null;
 }
 return null;
}

/** The last top-level row with a checkbox (where a Tab-indented new task goes), or null. */
export function lastTopLevel(text: string): string | null {
 const sec=findSection(text,"할 일");if(!sec)return null;
 const lines=splitLinesKeepEol(text).map(stripEol);let last:string|null=null;
 for(let i=sec.headingIndex+1;i<lines.length;i++){
  if(/^#{1,2}\s/.test(lines[i]))break;
  const m=/^([-*+])\s+(.*)$/.exec(lines[i]);if(!m)continue;
  const tid=/\(task::\s*([^)]*)\)/.exec(m[2])?.[1]?.trim()??"";
  last=tid&&/^\[[ xX]\]/.test(m[2])?tid:null;
 }
 return last;
}

/**
 * Each 묶음's checkbox from its 하위 할 일: done when every one is done or let go (at least one done),
 * open otherwise. `stateOf` gives a 하위 할 일's state by id (hub checkbox or its calendar copy).
 */
export function syncGroupChecks(text: string, stateOf: (id: string) => ProjectTask["state"] | undefined): string {
 const {groups}=hubOutline(text),lines=splitLinesKeepEol(text);let changed=false;
 for(const g of groups.values()){
  const st=g.children.map(stateOf).filter((x):x is ProjectTask["state"]=>!!x);
  if(!st.length)continue;
  const done=st.every(x=>x==="done"||x==="cancelled")&&st.includes("done");
  const m=/^([-*+]\s+\[)([ xX])(\].*)$/.exec(stripEol(lines[g.index]));if(!m)continue;
  const want=done?"x":" ";if((m[2]===" ")===(want===" "))continue;
  lines[g.index]=m[1]+want+m[3]+lines[g.index].slice(stripEol(lines[g.index]).length);changed=true;
 }
 return changed?lines.join(""):text;
}
export function hubTasks(text: string, path: string, projectId: string): ProjectTask[] {
 if ((text.match(/^## 할 일\s*$/gm)??[]).length>1) throw Error("할 일 섹션이 여러 개예요. 원본을 확인해 주세요.");
 const sec = findSection(text, "할 일"); if (!sec) return [];
 const lines = splitLinesKeepEol(text), out: ProjectTask[] = [];
 for (let i=sec.headingIndex+1;i<lines.length;i++) {
  const line=stripEol(lines[i]); if (/^#{1,2}\s/.test(line)) break;
  const m=/^\s*[-*+]\s+(\[[ x>\-]\].*)$/.exec(line); if(!m) continue;
  const item=parseItem(m[1]); if(item.kind!=="task") continue;
  out.push({path,index:i,line,id:Object.fromEntries(item.fields).task||"",projectId,title:item.text,state:item.status,kind:"hub"});
 }
 return out;
}
export function calendarTasks(text: string,path:string,kind:"desk"|"wall",key:string):ProjectTask[] {
 const out:ProjectTask[]=[];
 if(kind==="desk") {
  const m=parseMonthFile(text,+key.slice(0,4),+key.slice(5,7));
  for(const d of [...m.during,...[...m.weeks.values()].flatMap(w=>w.alloc??[]),...[...m.days.values()].flat()]) {
   if(d.item.kind!=="task"||!Object.fromEntries(d.item.fields).project) continue;
   out.push({path,index:d.index,line:d.line,id:Object.fromEntries(d.item.fields).task||"",projectId:Object.fromEntries(d.item.fields).project,title:d.item.text,state:d.item.status,kind,date:d.date,month:key,desk:d});
  }
 } else {
  for(const m of parseWallYear(text,+key).months) for(const d of m.lines) {
   if(d.item.kind!=="task"||!Object.fromEntries(d.item.fields).project) continue;
   out.push({path,index:d.index,line:d.line,id:Object.fromEntries(d.item.fields).task||"",projectId:Object.fromEntries(d.item.fields).project,title:d.item.text,state:d.item.status,kind,date:d.item.start??undefined,month:`${key}-${String(m.month).padStart(2,"0")}`});
  }
 }
 return out;
}
export function executionTasks(tasks:ProjectTask[]):ProjectTask[] {
 return tasks.flatMap(t=>{
  if(t.state==="moved")return [];
  if(t.desk && (t.desk.assign.length || t.desk.item.assignWeek.length)) {
   const matches=tasks.filter(x=>x.desk?.key===t.desk!.key);
   const missing=t.desk.assign.some(d=>!matches.some(x=>x.date===d))||t.desk.item.assignWeek.some(w=>!matches.some(x=>x.desk?.section==="alloc"&&x.desk.monday&&isoWeekNo(x.desk.monday)===w));
   return missing?[{...t,issue:"배정한 하위 칸의 원본을 찾을 수 없어요. 달력에서 확인해 주세요."}]:[];
  }
  return [t];
 });
}
export function replaceTaskLine(text:string,t:Pick<ProjectTask,"index"|"line">,line:string):string {
 const lines=splitLinesKeepEol(text); if(stripEol(lines[t.index]??"")!==t.line) throw Error("할 일이 다른 곳에서 바뀌었어요. 다시 열어 주세요.");
 lines[t.index]=line+lines[t.index].slice(t.line.length); return lines.join("");
}
export function appendHubTask(text:string,line:string):string {
 const sec=findSection(text,"할 일"),eol=detectEol(text);
 if(!sec) return text+(text.endsWith("\n")?"":eol)+eol+"## 할 일"+eol+eol+line+eol;
 const lines=splitLinesKeepEol(text); let i=sec.headingIndex+1;
 while(i<lines.length&&!/^#{1,2}\s/.test(stripEol(lines[i])))i++;
 if(i&& !lines[i-1].endsWith("\n"))lines[i-1]+=eol;
 lines.splice(i,0,line+eol);return lines.join("");
}
export function taskTitle(value:string):string {
 const title=value.trim(); if(!title||/[\r\n]/.test(title)||/\([^)]*::|[→]|^[-*+]\s*\[/.test(title))throw Error("할 일 내용을 한 줄로 적어 주세요. 연결·배정 정보는 자동으로 넣어요.");
 return title;
}

export function missingTaskRefs(text:string,tasks:ProjectTask[]):string[] {
 const sec=findSection(text,"할 일");if(!sec)return [];
 const lines=text.split(/\r?\n/),out:string[]=[];
 for(let i=sec.headingIndex+1;i<lines.length;i++){if(/^#{1,2}\s/.test(lines[i]))break;if(/^\s*[-*+]\s+\[[ x>\-]\]/.test(lines[i]))continue;const id=/\(task::\s*([^)]*)\)/.exec(lines[i])?.[1]?.trim();if(id&&!tasks.some(t=>t.id===id))out.push(lines[i].replace(/^\s*[-*+]\s+/,"").replace(/\([^)]*::[^)]*\)/g,"").trim());}
 return out;
}
