import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { GoalInput } from "../../src/pinboard/create.ts";
import { type Templates, TEMPLATE_FILES } from "../../src/projects/create.ts";
import type { NewProjectInput } from "../../src/projects/model.ts";

export const TODAY="2026-01-09",ROOT="01 Pinboard";
export const MAIN_TEMPLATE=`---\nid: G-YYYY-NN\ntype: main-goal\ntitle:\nperiod:\narea:\nstatus: active\nhealth:\nsub_total: 0\nsub_achieved: 0\nprogress: 0\nupdated:\n---\n# \n\n## 왜 이 목표인가\n\n## 달성한 모습\n\n## Sub Goal (측정 기준)\n- [[G-YYYY-NN.1 ]]\n\n## 수단 (프로젝트·습관)\n\n## 진척 기록\n\n## 리뷰 메모\n\n## 종료 회고\n`;
export const SUB_TEMPLATE=`---\nid: G-YYYY-NN.M\ntype: sub-goal\ntitle:\nparent: G-YYYY-NN\narea:\nstatus: active\nhealth:\nmeasure: metric\nkind: outcome\nbaseline:\ncurrent:\ntarget:\nunit:\ndue:\nweight:\nprogress: 0\nprojects: []\nproject_ids: []\nupdated:\n---\n# \n\n상위 목표: [[G-YYYY-NN ]]\n\n## 달성 기준\n\n## 수단\n\n## 진척 기록\n\n## 메모\n\n## 종료 회고\n`;
export const INDEX=`---\ntype: index\nupdated: 2026-01-01\n---\n# Pinboard Index\n\n## 미정·확인 필요\n\n## 변경 기록\n`;
export const REGISTRY=`---\ntype: index\nupdated: 2026-01-01\n---\n# Project Folders Index\n\n## 진행 중\n\n| id | 프로젝트 | 별칭 | 개인/회사 | area | 유형 | 상태 | 지금 가장 효과적인 한 가지 행동 | 목표 | 경로 | 갱신 |\n|---|---|---|---|---|---|---|---|---|---|---|\n\n## 완료 (Archive Box)\n\n| id | 프로젝트 | 개인/회사 | 시작 | 완료 | 한 줄 결과 | 경로 |\n|---|---|---|---|---|---|---|\n\n## 변경 기록\n`;
export const WHEEL=`---\ntype: flywheel\nelements: 2\nupdated: 2026-01-01\n---\n# Flywheel\n\n## F-1 글쓰기\n- 정체성:: 나는 매일 쓰는 사람이다\n- 최소:: 한 문장\n- 선행지표:: 매일 최소 행동 수행\n- goal:: \n- status:: 사용\n\n## F-2 몸 만들기\n- goal:: G-2026-09.1\n- status:: 사용\n\n## 변경 기록\n`;
export const INPUT:GoalInput={title:"글로 나를 알린다",area:"글쓰기",why:"김하루의 글쓰기 연습",measure:"metric",baseline:"",current:"",target:"",unit:"",due:""};
export const PROJECT:NewProjectInput={id:"P-newsletter",name:"뉴스레터 창간",summary:"김하루의 첫 뉴스레터를 발행한다",scope:"개인",area:"글쓰기",kind:"콘텐츠 제작",aliases:"",action:"창간호 목차 정하기"};
const here=dirname(fileURLToPath(import.meta.url));
export const templates=Object.fromEntries(Object.entries(TEMPLATE_FILES).map(([k,f])=>[k,readFileSync(join(here,"../fixtures/projects/템플릿",f),"utf8")])) as Templates;
