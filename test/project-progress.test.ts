import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoal, computeSubProgress, rollupMain } from "../src/pinboard/model.ts";
import { applyProjectProgress, contributions, projectProgress } from "../src/pinboard/project-progress.ts";
const goal=(extra={})=>parseGoal({id:"G-2026-01.1",type:"sub-goal",measure:"metric",baseline:0,current:12,target:100,project_ids:["P-a","P-b"],...extra},"goal.md")!;
test("project weights are goal-local; exact ratios, zero exclusions and duplicate IDs",()=>{
 const a=goal({project_weights:["P-a=3","P-b=1"]}), b=goal({project_weights:["P-a=0","P-b=1"]});
 const projects=[projectProgress("P-a","김하루 초고","## 마일스톤\n- [x] 완성\n- [ ] 검수"),projectProgress("P-b","김하루 발송","## 마일스톤\n- [x] 발송")];
 applyProjectProgress([a,b],projects);assert.equal(a.progress,63);assert.equal(b.progress,100);assert.equal(a.current,"12");assert.equal(a.status,"active");
 assert.equal(rollupMain([{...a,weight:3},b]).progress,72);
 applyProjectProgress([a],[...projects,projects[0]]);assert.equal(a.progress,25);assert.match(contributions(a,[...projects,projects[0]])[0].issue!,/중복/);
});
test("manual mode is opt-out; achieved does not override automatic progress",()=>{
 const manual=goal({progress_source:"manual"}),auto=goal({status:"achieved"});
 applyProjectProgress([manual,auto],[]);assert.equal(computeSubProgress(manual),12);assert.equal(computeSubProgress(auto),0);assert.equal(auto.status,"achieved");
});
test("malformed and missing milestone sources give zero contribution and warning",()=>{
 const p=projectProgress("P-a","김하루 작업","## 마일스톤\n- [x] 완료\n## 마일스톤\n- [x] 중복");assert.equal(p.progress,0);assert.ok(p.issue);
 const g=goal();applyProjectProgress([g],[p]);assert.equal(g.progress,0);assert.ok(contributions(g,[p])[1].issue);
});
