/** Pure, template-based goal + execution-space plans. All examples/tests use 김하루. */
import { appendToSection, findSection, replaceSectionContent } from "../writer.ts";
import { parseFlywheel } from "../flywheel/model.ts";
import { type Templates, planNewProject, leftoverPlaceholders } from "../projects/create.ts";
import { type NewProjectInput, nameProblem } from "../projects/model.ts";
import { getFmList, setFmList, setFmValue, yamlScalar, upsertActiveRow, logRegistryChange } from "../projects/ops.ts";
import { applyMainRollup, linkProject, removeUndecidedLines } from "./goal-edit.ts";
import { INDEX_FILE, indexPathCell, prependChangeLog } from "./index-writer.ts";
import { type Goal, parseFrontmatterText, parseGoal, rollupMain, displaySubProgress, isEnded, toNum } from "./model.ts";
import type { Write } from "./batch.ts";

export interface GoalInput {
	title: string; area: string; why: string; measure: "metric" | "milestone";
	baseline: string; current: string; target: string; unit: string; due: string;
}
export function inputProblems(i: GoalInput, sub: boolean): string[] {
	const errors: string[] = [];
	const p = nameProblem(i.title); if (p) errors.push(p);
	if (/[\r\n]/.test(i.title) || /[\r\n]/.test(i.area)) errors.push("이름과 영역은 한 줄로 적어 주세요.");
	if (!i.area.trim()) errors.push("영역을 적어 주세요.");
	if (sub && i.due) { const d=new Date(`${i.due}T00:00:00Z`);if(!/^\d{4}-\d{2}-\d{2}$/.test(i.due)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==i.due) errors.push("기한을 실제 날짜로 적어 주세요."); }
	if (sub && i.measure === "metric") {
		for (const [label, v] of [["시작값",i.baseline],["현재값",i.current],["목표값",i.target]]) if (v.trim() && toNum(v) === null) errors.push(`${label}은 숫자로 적거나 비워 주세요.`);
		if (i.baseline.trim() && i.target.trim() && toNum(i.baseline) === toNum(i.target)) errors.push("시작값과 목표값은 달라야 해요.");
	}
	return errors;
}
export function readGoal(text: string, path: string): Goal {
	const g = parseGoal(parseFrontmatterText(text).data, path);
	if (!g || !g.id) throw new Error(`목표 형식을 확인해 주세요: ${path}`);
	return g;
}
export function nextGoalId(year: number, ids: string[], parent?: string): string {
	const prefix = parent ? `${parent}.` : `G-${year}-`;
	const ns = ids.filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length)).filter(s => /^\d+$/.test(s)).map(Number);
	const n = Math.max(0,...ns)+1;
	return prefix + (parent ? String(n) : String(n).padStart(2,"0"));
}
const cell = (s: string) => s.replace(/\r?\n/g," ").replace(/(?<!\\)\|/g,"\\|");
/** Replace/append only known rows; preserve user notes, custom columns, and other years. */
export function upsertGoalRows(text: string, year: number, goals: Goal[], relations: Map<string,string> = new Map()): string {
	const heading = `## ${year}`;
	if (!findSection(text,String(year))) {
		const table = `${heading}\n\n| id | 종류 | 제목 | parent | status | health | baseline → current → target | due | progress | 수단·연결 |\n|---|---|---|---|---|---|---|---|---|---|\n\n`;
		text = text.includes("## 미정·확인 필요") ? text.replace("## 미정·확인 필요",table+"## 미정·확인 필요") : text+"\n"+table;
	}
	const lines=text.split("\n"); const start=lines.indexOf(heading);
	const next=lines.findIndex((s,n)=>n>start && s.startsWith("## ")); const end=next<0?lines.length:next;
	const header=lines.findIndex((s,n)=>n>start&&n<end&&/^\|\s*id\s*\|/.test(s));
	if(header<0) throw new Error("Pinboard 등록부 표를 찾을 수 없어요.");
	const cols=lines[header].split(/(?<!\\)\|/).slice(1,-1).map(x=>x.trim());
	for(const key of ["id","종류","제목","parent","status","health","due","progress","수단·연결"]) if(!cols.includes(key)) throw new Error(`등록부에 ${key} 칸이 없어요.`);
	for(const g of goals) {
		const at=lines.findIndex((s,n)=>n>header&&n<end&&s.split(/(?<!\\)\|/)[1]?.trim()===g.id);
		const old=at<0?cols.map(()=>"—"):lines[at].split(/(?<!\\)\|/).slice(1,-1).map(x=>x.trim());
		const values:Record<string,string>={id:g.id,종류:g.type==="main-goal"?"main":"sub",제목:g.title,parent:g.parent||"—",status:g.status,health:g.health||"—",due:g.due|| (g.type==="main-goal"?"—":"미정"),progress:g.type==="main-goal"?`${g.progress??0}% (${g.subAchieved??0}/${g.subTotal??0})`:`${g.progress??0}%${displaySubProgress(g)===null?" (계산 불가)":""}`};
		const pathCol=cols.find(c=>c.startsWith("baseline"));if(pathCol)values[pathCol]=g.type==="main-goal"?"—":indexPathCell(g);
		if(relations.has(g.id)) values["수단·연결"]=relations.get(g.id)||"—";
		const row="| "+cols.map((c,n)=>c in values?cell(values[c]):old[n]||"—").join(" | ")+" |";
		if(at<0) {let insert=header+2; while(insert<lines.length&&lines[insert].startsWith("|"))insert++;lines.splice(insert,0,row);}else lines[at]=row;
	}
	return lines.join("\n");
}
export function updateUnknowns(text: string, g: Goal): string {
	const missing=[!g.health?"health": "",g.type==="sub-goal"&&!g.due?"기한":"",g.type==="sub-goal"&&!g.target?"목표값/달성 조건":"",g.measure==="metric"&&!g.baseline?"시작값":"",g.measure==="metric"&&!g.current?"현재값":""].filter(Boolean);
	text=removeUndecidedLines(text,[g.id]);
	return missing.length?appendToSection(text,"미정·확인 필요",`- ${g.id}: ${missing.join(", ")} 미정`):text;
}
export interface GoalPlan { goal: Goal; writes: Write[]; folders: string[] }
export function planGoal(o: {root:string; year:number; input:GoalInput; template:string; index:string; existing:Goal[]; parent?:{goal:Goal;text:string}; today:string}):GoalPlan {
	const {input:i,parent,today}=o;
	const issues=inputProblems(i,!!parent);if(issues.length)throw new Error(issues.join("\n"));
	if(parent && (parent.goal.type!=="main-goal" || isEnded(parent.goal.status)))throw new Error("진행 중인 상위 목표를 골라 주세요.");
	if(parent && o.existing.filter(g=>g.parent===parent.goal.id&&g.status!=="dropped").length>=3)throw new Error("하위 목표는 3개 이하로 유지해 주세요.");
	if(o.existing.some(g=>g.title===i.title.trim()))throw new Error("같은 이름의 목표가 있어요.");
	const ids=[...o.existing.map(g=>g.id),...(o.index.match(/G-\d{4}-\d+(?:\.\d+)?/g)??[])];
	const id=nextGoalId(o.year,ids,parent?.goal.id);const path=`${o.root}/${o.year}/${id} ${i.title.trim()}.md`;
	let text=o.template;
	const fields:Record<string,string>={id,type:parent?"sub-goal":"main-goal",title:yamlScalar(i.title.trim()),area:yamlScalar(i.area.trim()),status:"active",health:"",progress:"0",updated:today};
	if(parent)Object.assign(fields,{parent:parent.goal.id,measure:i.measure,kind:"outcome",baseline:i.measure==="metric"?i.baseline.replace(/,/g,""):"",current:i.measure==="metric"?i.current.replace(/,/g,""):"",target:yamlScalar(i.target),unit:yamlScalar(i.measure==="metric"?i.unit:""),due:i.due,weight:""});
	else Object.assign(fields,{period:String(o.year),sub_total:"0",sub_achieved:"0"});
	for(const [k,v]of Object.entries(fields))text=setFmValue(text,k,v);
	text=text.replace(/^# .*$/m,`# ${i.title.trim()}`);
	if(parent){text=text.replace(/^상위 목표:.*$/m,`상위 목표: [[${parent.goal.path.replace(/\.md$/,"")}]]`);text=setFmList(setFmList(text,"projects",[]),"project_ids",[]);text=replaceSectionContent(text,"달성 기준",i.target?`- ${i.due||"기한 미정"}: ${i.target}${i.unit?` ${i.unit}`:""}`:"- 미정");}
	else {text=replaceSectionContent(text,"Sub Goal (측정 기준)","");if(i.why)text=replaceSectionContent(text,"왜 이 목표인가",i.why);}
	if(/G-YYYY|\{\{/.test(text))throw new Error("목표 템플릿에 채우지 못한 자리표시자가 있어요.");
	let g=readGoal(text,path);if(parent){text=setFmValue(text,"progress",String(displaySubProgress(g)??0));g=readGoal(text,path);}
	const writes:Write[]=[{path,before:null,after:text}]; const rows=[g];
	if(parent){const r=rollupMain([...o.existing.filter(s=>s.parent===parent.goal.id),g]);const ptext=applyMainRollup(appendToSection(parent.text,"Sub Goal (측정 기준)",`- [[${path.replace(/\.md$/,"")}]]`),r,today);writes.push({path:parent.goal.path,before:parent.text,after:ptext});rows.push(readGoal(ptext,parent.goal.path));}
	let index=upsertGoalRows(o.index,o.year,rows);index=updateUnknowns(index,g);index=setFmValue(prependChangeLog(index,today,`${id} ${parent?"하위 목표":"목표"} 생성 (플러그인)`),"updated",today);
	writes.push({path:`${o.root}/${INDEX_FILE}`,before:o.index,after:index});
	return {goal:g,writes,folders:[`${o.root}/${o.year}`]};
}
export function attachNewProject(plan:GoalPlan,input:NewProjectInput,templates:Templates,o:{projectRoot:string;registryPath:string;registry:string;today:string}):GoalPlan {
	const p=planNewProject(input,templates,{activeRoot:o.projectRoot,today:o.today});
	p.row.goals=plan.goal.id;
	const hub=p.files[0];hub.content=setFmList(hub.content,"goals",[plan.goal.id]);
	p.files[p.files.length-1].content=p.files[p.files.length-1].content.replace("새 프로젝트로 등록한다. 사용자 요청",`새 프로젝트로 등록하고 ${plan.goal.id}에 연결한다. 사용자 요청`);
	for(const f of p.files)if(leftoverPlaceholders(f.content).length)throw new Error(`프로젝트 템플릿을 확인해 주세요: ${f.path}`);
	const reg=upsertActiveRow(o.registry,{id:p.id},p.row);if(!reg.ok)throw new Error(reg.reason);
	const writes=plan.writes.map(w=>({...w}));const gw=writes.find(w=>w.path===plan.goal.path)!;
	gw.after=linkProject(gw.after,p.id,`[[${hub.path.replace(/\.md$/,"")}]]`,o.today);
	const goal=readGoal(gw.after,gw.path);const idx=writes.find(w=>w.path.endsWith(`/${INDEX_FILE}`))!;
	idx.after=upsertGoalRows(idx.after,Number(goal.id.slice(2,6)),[goal],new Map([[goal.id,`[[${hub.path.replace(/\.md$/,"")}|${input.name}]]`]]));
	return {goal,folders:[...plan.folders,...p.folders],writes:[...writes,...p.files.map(f=>({path:f.path,before:null,after:f.content})),{path:o.registryPath,before:o.registry,after:logRegistryChange(reg.text,o.today,p.change+` · ${goal.id} 연결`)}]};
}
/** Change just the selected element's goal field; require the user-confirmed prior value. */
export function setFlywheelGoal(text:string,id:string,goalId:string,expected:string,today:string):string {
	const elements=parseFlywheel(text);const e=elements.find(e=>e.id===id);
	if(!e||(e.status==="폐기"&&goalId))throw new Error("사용할 수 없는 Flywheel 요소예요.");
	if((e.fields.goal??"")!==expected)throw new Error("Flywheel 연결이 바뀌었어요. 다시 선택해 주세요.");
	if(expected===goalId)return text;
	const lines=text.split("\n");const start=lines.findIndex(l=>l.startsWith(`## ${id} `));let end=lines.findIndex((l,n)=>n>start&&l.startsWith("## "));if(end<0)end=lines.length;
	const at=lines.findIndex((l,n)=>n>start&&n<end&&/^- goal::/.test(l));
	if(at<0)lines.splice(start+1,0,`- goal:: ${goalId}`);else lines[at]=`- goal:: ${goalId}`;
	return setFmValue(prependChangeLog(lines.join("\n"),today,`${id} 목표 연결 ${expected||"없음"} → ${goalId||"없음"} (플러그인)`),"updated",today);
}
export function projectSharedWith(goals:string[],deleting:string[]):string[]{return goals.filter(id=>!deleting.includes(id));}
export function linkedGoalIds(text:string):string[]{return getFmList(text,"goals");}
