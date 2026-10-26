import { test } from "node:test";
import assert from "node:assert/strict";
import { editInlineGoal, inlineToken, inlineValue, type InlineGoalField } from "../src/pinboard/inline-edit.ts";

const today = "2026-01-09", path = "01 Pinboard/2026/G-2026-01.1 구독자 100명.md";
const sub = `---\ntype: sub-goal\nid: G-2026-01.1\ntitle: 구독자 100명\nparent: G-2026-01\narea: 글쓰기\nstatus: active\nhealth: on-track\nmeasure: metric\nkind: outcome\nbaseline: 0\ncurrent: 10\ntarget: 100\nunit: 명\ndue:\nweight:\nprogress: 10\nprojects: []\nproject_ids: []\nupdated: 2026-01-01\n---\n# 구독자 100명\n\n## 달성 기준\n- 구독자 100명\n\n## 수단\n- 뉴스레터 발행\n\n## 진척 기록\n\n## 메모\n- 사용자 메모\n`;
const edit = (text: string, field: InlineGoalField, value: string) => editInlineGoal(text, path, field, inlineToken(text, field), value, today);
test("inline title changes only title/H1/updated, preserving id and links", () => { const r=edit(sub,"title","구독자 200명"); assert.equal(r.goal.id,"G-2026-01.1");assert.match(r.text,/# 구독자 200명/);assert.match(r.text,/## 수단\n- 뉴스레터 발행/); });
test("inline description and memo support multiline text and clearing", () => { const r=edit(sub,"criteria","김하루의 구독자\n실제 구독 수로 확인");assert.equal(inlineValue(r.text,"criteria"),"김하루의 구독자\n실제 구독 수로 확인");assert.match(r.text,/## 메모\n- 사용자 메모/);assert.equal(inlineValue(edit(r.text,"criteria","").text,"criteria"),""); });
test("inline current saves metric and evidence, recalculates progress", () => { const r=edit(sub,"current","50");assert.equal(r.goal.progress,50);assert.match(r.text,/\(value:: 50\)/);assert.match(r.text,/보고됨/);assert.match(r.text,/사용자 입력/);assert.equal(edit(r.text,"current","").goal.current,""); });
test("only the edited field conflicts; unrelated remote edits survive", () => { const changed=sub.replace("사용자 메모","다른 기기의 메모");const r=editInlineGoal(changed,path,"current",inlineToken(sub,"current"),"20",today);assert.match(r.text,/다른 기기의 메모/);assert.throws(()=>editInlineGoal(sub.replace("current: 10","current: 30"),path,"current","10","20",today),/다른 곳/); });
test("section conflict token also protects hidden comments", () => { const changed=sub.replace("- 사용자 메모","<!-- 새 주석 -->\n- 사용자 메모");assert.throws(()=>editInlineGoal(changed,path,"memo",inlineToken(sub,"memo"),"새 메모",today),/다른 곳/); });
test("invalid numeric/date/weight/title inputs do not save", () => {
 for(const [field,value] of [["current","abc"],["baseline","NaN"],["target","Infinity"],["weight","0"],["weight","-1"],["due","2026-02-30"],["title",""],["title","a/b"],["area","a\nb"],["measure","random"]] as [InlineGoalField,string][])assert.throws(()=>edit(sub,field,value));
 assert.equal(edit(sub,"target","1,000").goal.target,"1000"); assert.equal(edit(sub,"weight","").goal.weight,null);
});
test("decreasing targets work and equal endpoints stay unmeasurable", () => { const t=sub.replace("baseline: 0","baseline: 100").replace("current: 10","current: 95").replace("target: 100","target: 90");assert.equal(edit(t,"current","92").goal.progress,80);assert.equal(edit(t,"target","100").goal.target,"100"); });
test("main descriptions, legacy why alias and period edit in place", () => {
 const main=`---\ntype: main-goal\nid: G-2026-01\ntitle: 글로 나를 알린다\nperiod: 2026\nprogress: 10\n---\n# 글로 나를 알린다\n\n## 왜\n- 김하루의 연습\n\n## 달성한 모습\n- 창간\n`;
 const r=edit(main,"why","매주 발행한다");assert.match(r.text,/## 왜\n- 매주 발행한다/);assert.doesNotMatch(r.text,/## 왜 이 목표인가/);assert.equal(edit(main,"period","2026년 상반기").goal.period,"2026년 상반기");assert.throws(()=>edit(main,"current","100"),/하위 목표/);
});
test("unchanged values are a byte-for-byte no-op",()=>{assert.equal(edit(sub,"current","10").text,sub);assert.equal(edit(sub,"memo","사용자 메모").text,sub);});
