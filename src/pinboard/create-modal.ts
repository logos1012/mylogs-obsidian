import { type App, Modal, Setting } from "obsidian";
import { type Goal, type ProjectRef } from "./model.ts";
import { type FlywheelElement } from "../flywheel/model.ts";
import { KINDS, type NewProjectInput, type Scope, validateInput } from "../projects/model.ts";
import { type GoalInput, inputProblems, projectSharedWith } from "./create.ts";

export type Execution = { mode:"new"; project:NewProjectInput } | {mode:"project";path:string} | {mode:"flywheel";id:string;previous:string};
export interface GoalAnswer {input:GoalInput; execution?:Execution}
export interface CreateOptions {year:number;parent?:Goal;projects:ProjectRef[];flywheel:FlywheelElement[];taken:{ids:string[];names:string[]};today:string;areas:string[]}
export function askCreateGoal(app:App,o:CreateOptions):Promise<GoalAnswer|null>{return new Promise(resolve=>new CreateModal(app,o,resolve).open());}
function autoId(o:CreateOptions):string{const prefix=`P-${o.today.replace(/-/g,"")}-`;let n=1;while(o.taken.ids.includes(prefix+n))n++;return prefix+n;}
class CreateModal extends Modal {
	private done=false;
	constructor(app:App,private o:CreateOptions,private resolve:(a:GoalAnswer|null)=>void){super(app);}
	onOpen():void {
		const o=this.o,sub=!!o.parent,el=this.contentEl;this.modalEl.addClass("mylogs-modal","mylogs-goal-create");
		this.setTitle(sub?"하위 목표 만들기":"목표 만들기");
		el.createEl("p",{text:sub?`「${o.parent!.title}」의 측정 기준과 실행 공간을 함께 만들어요.`:`${o.year}년에 이루려는 방향을 적어 주세요.`,cls:"mylogs-modal-desc"});
		const i:GoalInput={title:"",area:o.parent?.area??"",why:"",measure:"metric",baseline:"",current:"",target:"",unit:"",due:""};
		const p:NewProjectInput={id:autoId(o),name:"",summary:"",area:i.area,scope:"개인",kind:"",aliases:"",action:""};
		let mode:"new"|"project"|"flywheel"="new",projectPath="",flywheelId="",confirmed=false,nameTouched=false;
		let nameInput:HTMLInputElement|null=null;
		new Setting(el).setName("이름").addText(t=>{t.inputEl.addClass("mylogs-form-wide");t.onChange(v=>{i.title=v;if(!nameTouched){p.name=v;if(nameInput)nameInput.value=v;}});setTimeout(()=>t.inputEl.focus(),0);});
		new Setting(el).setName("영역").setDesc("사업, 건강, 글쓰기처럼 묶어 볼 분류").addText(t=>t.setValue(i.area).onChange(v=>{i.area=v;p.area=v;}));
		if(!sub)new Setting(el).setName("왜 이루려 하나요?").setDesc("선택").addTextArea(t=>t.onChange(v=>i.why=v));
		if(sub){
			const m=new Setting(el).setName("측정 방식");
			const numbers=el.createDiv();
			const num=(label:string,key:"baseline"|"current"|"target"|"unit")=>new Setting(numbers).setName(label).addText(t=>{t.inputEl.inputMode=key==="unit"?"text":"decimal";t.setPlaceholder("모르면 비워 두기").onChange(v=>i[key]=v);});
			num("시작값","baseline");num("현재값","current");num("목표값","target");num("단위","unit");
			const milestone=el.createDiv();milestone.hide();
			new Setting(milestone).setName("달성 조건").setDesc("무엇이 되면 달성인가요?").addText(t=>t.onChange(v=>i.target=v));
			m.addDropdown(d=>d.addOption("metric","숫자").addOption("milestone","달성 여부").onChange(v=>{i.measure=v as GoalInput["measure"];i.target="";numbers.toggle(v==="metric");milestone.toggle(v==="milestone");numbers.querySelectorAll<HTMLInputElement>("input")[2].value="";milestone.querySelector("input")!.value="";}));
			new Setting(el).setName("기한").setDesc("모르면 비워 두세요. 미정으로 표시해요.").controlEl.createEl("input",{attr:{type:"date","aria-label":"기한"}},x=>x.addEventListener("change",()=>i.due=x.value));
			el.createEl("h3",{text:"어떻게 실행할까요?"});
			const pick=new Setting(el).setName("실행 공간");
			const fresh=el.createDiv(),existing=el.createDiv(),wheel=el.createDiv();existing.hide();wheel.hide();
			pick.addDropdown(d=>d.addOption("new","새 프로젝트 함께 만들기").addOption("project","기존 프로젝트 연결").addOption("flywheel","Flywheel 연결").onChange(v=>{mode=v as typeof mode;fresh.toggle(v==="new");existing.toggle(v==="project");wheel.toggle(v==="flywheel");}));
			fresh.createEl("p",{text:"초안·산출물 폴더, 허브, 운영 지침, 로그를 볼트 템플릿으로 만들어요. 처음 상태는 후보예요.",cls:"mylogs-modal-desc"});
			new Setting(fresh).setName("프로젝트 이름").setDesc("무엇을 마치면 끝나는지 드러나게 적어 주세요.").addText(t=>{nameInput=t.inputEl;t.onChange(v=>{nameTouched=true;p.name=v;});});
			new Setting(fresh).setName("한 문장 설명").addText(t=>t.onChange(v=>p.summary=v));
			new Setting(fresh).setName("개인 / 회사").addDropdown(d=>d.addOption("개인","개인").addOption("회사","회사").onChange(v=>p.scope=v as Scope));
			new Setting(fresh).setName("유형").addDropdown(d=>{d.addOption("","고르기");for(const k of KINDS)d.addOption(k,k);d.onChange(v=>p.kind=v);});
			new Setting(fresh).setName("지금 할 한 가지").setDesc("선택. 비우면 미확인으로 둬요.").addText(t=>t.onChange(v=>p.action=v));
			new Setting(existing).setName("프로젝트").addDropdown(d=>{d.addOption("","고르기");for(const x of o.projects.filter(p=>!p.archived))d.addOption(x.path,x.title);d.onChange(v=>projectPath=v);});
			if(!o.projects.some(p=>!p.archived))existing.createEl("p",{text:"연결할 프로젝트가 없어요. 새 프로젝트 함께 만들기를 선택해 주세요."});
			const warning=wheel.createEl("p",{cls:"mylogs-modal-desc"});
			new Setting(wheel).setName("요소").addDropdown(d=>{d.addOption("","고르기");for(const x of o.flywheel.filter(e=>e.status!=="폐기"))d.addOption(x.id,`${x.id} ${x.name}`);d.onChange(v=>{flywheelId=v;confirmed=false;const e=o.flywheel.find(e=>e.id===v);warning.setText(e?.fields.goal?`현재 ${e.fields.goal}에 연결돼 있어요. 새 하위 목표로 교체하려면 아래에 확인해 주세요.`:"요소와 기존 결과물은 그대로 두고 목표만 연결해요.");});});
			new Setting(wheel).setName("기존 목표 연결 교체에 동의").setDesc("이미 연결된 목표가 있을 때만 필요해요.").addToggle(t=>t.onChange(v=>confirmed=v));
			if(!o.flywheel.length)wheel.createEl("p",{text:"Flywheel 요소를 먼저 정해 주세요. 여기서 자동으로 요소를 만들지는 않아요."});
		}
		const errors=el.createEl("ul",{cls:"mylogs-form-errors",attr:{role:"alert"}});
		new Setting(el).addButton(b=>b.setButtonText("취소").onClick(()=>this.finish(null))).addButton(b=>b.setButtonText(sub?"하위 목표와 실행 공간 저장":"목표 저장").setCta().onClick(()=>{
			for(const k of Object.keys(i) as (keyof GoalInput)[]) (i as unknown as Record<string,string>)[k]=i[k].trim();
			const problems=inputProblems(i,sub);let execution:Execution|undefined;
			if(sub){
				if(mode==="new"){p.name=p.name.trim();p.summary=p.summary.trim();p.area=i.area;problems.push(...validateInput(p,o.taken));execution={mode,project:p};}
				if(mode==="project"){if(!projectPath)problems.push("연결할 프로젝트를 골라 주세요.");execution={mode,path:projectPath};}
				if(mode==="flywheel"){const e=o.flywheel.find(x=>x.id===flywheelId);if(!e)problems.push("Flywheel 요소를 골라 주세요.");else if(e.fields.goal&&!confirmed)problems.push("기존 목표 연결의 교체를 확인해 주세요.");execution={mode,id:flywheelId,previous:e?.fields.goal??""};}
			}
			errors.empty();for(const x of problems)errors.createEl("li",{text:x});if(!problems.length)this.finish({input:i,execution});
		})).settingEl.addClass("mylogs-form-actions");
	}
	private finish(v:GoalAnswer|null):void{if(this.done)return;this.done=true;this.resolve(v);this.close();}
	onClose():void{this.contentEl.empty();if(!this.done){this.done=true;this.resolve(null);}}
}

export type ProjectDisposition="keep"|"archive"|"trash";
export function askDeleteGoals(app:App,goals:Goal[],projects:ProjectRef[]):Promise<Record<string,ProjectDisposition>|null>{
	return new Promise(resolve=>new DeleteModal(app,goals,projects,resolve).open());
}
class DeleteModal extends Modal {
	private done=false;
	constructor(app:App,private goals:Goal[],private projects:ProjectRef[],private resolve:(v:Record<string,ProjectDisposition>|null)=>void){super(app);}
	onOpen():void {
		this.modalEl.addClass("mylogs-modal");this.setTitle("목표 삭제와 연결된 프로젝트 처리");const el=this.contentEl,ids=this.goals.map(g=>g.id),choices:Record<string,ProjectDisposition>={};
		el.createEl("p",{text:"아래 목표 노트는 휴지통으로 보냅니다. Flywheel은 목표 연결만 끊고 요소·결과물·수행 기록은 유지합니다."});
		const ul=el.createEl("ul");for(const g of this.goals)ul.createEl("li",{text:`${g.id} ${g.title}`});
		for(const p of this.projects){choices[p.id]="keep";const shared=projectSharedWith(p.goals,ids);const s=new Setting(el).setName(p.title).setDesc(shared.length?`다른 목표와 공유: ${shared.join(", ")}. 유지가 기본입니다. 보관·삭제하면 다른 목표에도 영향을 줍니다.`:"목표 연결만 해제하고 프로젝트를 유지할 수 있어요.");s.addDropdown(d=>{d.addOption("keep","유지 — 목표 연결만 해제");if(!p.archived)d.addOption("archive","종료하고 Archive Box/Projects에 보관").addOption("trash","프로젝트도 휴지통으로");d.onChange(v=>choices[p.id]=v as ProjectDisposition);});}
		let checked=false;new Setting(el).setName("목표와 선택한 프로젝트 처리를 확인했습니다").setDesc("보관은 프로젝트 종료이며 목표 달성을 뜻하지 않습니다. 휴지통은 폴더 안의 자료도 함께 보냅니다.").addToggle(t=>t.onChange(v=>checked=v));
		const error=el.createDiv({attr:{role:"alert"}});
		new Setting(el).addButton(b=>b.setButtonText("취소").onClick(()=>this.finish(null))).addButton(b=>b.setButtonText("선택대로 처리하고 목표 삭제").setWarning().onClick(()=>{if(!checked){error.setText("처리할 대상을 확인해 주세요.");return;}this.finish(choices);}));
	}
	private finish(v:Record<string,ProjectDisposition>|null):void{if(this.done)return;this.done=true;this.resolve(v);this.close();}
	onClose():void{this.contentEl.empty();if(!this.done){this.done=true;this.resolve(null);}}
}
