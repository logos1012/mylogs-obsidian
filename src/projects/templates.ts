/**
 * Built-in copies of `05 Project Folders/99 작업실/템플릿/` (as of 2026-10-24).
 * Used only when a template file is missing from the vault; the vault copy always wins.
 */

import type { Templates } from "./create.ts";

export const DEFAULT_TEMPLATES: Templates = {
	hub: "---\ntype: project\nid: P-\ntitle:\nscope: 개인\narea:\nkind:\nstatus: 후보\nstarted:\ncompleted:\ncover: \"99 작업실/cover.png\"\ngoals: []\nupdated:\n---\n\n# {{프로젝트명}}\n\n## 한 문장 설명\n\n\n## 지금 가장 효과적인 한 가지 행동\n- [ ] \n\n## 목표\n- \n\n## 성공 기준\n- \n\n## 비목표\n- \n\n## 현재 상태\n- **단계:** \n\n## 다음 액션\n- [ ] \n\n## 막힌 점\n- 없음\n\n## 주요 결정\n<!-- - YYYY-MM-DD — 결정. 이유 -->\n",
	agents: "---\ntype: project-operator-contract\naudience: AI agents\nproject: \"{{프로젝트명}}\"\nid: P-\nhub: \"{{프로젝트명}}.md\"\nlog_index: \"99 작업실/{{프로젝트명}} 로그.md\"\nlatest_log: \"99 작업실/로그/{{프로젝트명}} 로그 YYYY-MM.md\"\nupdated:\n---\n\n# {{프로젝트명}} 운영 계약\n\nAI용 운영 계약이다. 이 프로젝트를 다루기 전에 먼저 읽는다. 절차(조회, 작업 기록, 상태 변경, 완료)는 `05 Project Folders/AGENTS.md`를 따른다. 이 문서와 충돌하면 이 문서를 따르고 사용자에게 알린다.\n\n## 문서 지도\n\n- 허브: [[{{프로젝트명}}]]\n- 로그 인덱스: `99 작업실/{{프로젝트명}} 로그.md`\n- 최신 월별 로그: `99 작업실/로그/{{프로젝트명}} 로그 YYYY-MM.md`\n\n## 폴더 지도\n\n파일은 이 표에 따라 둔다. 프로젝트 루트에는 `01 초안`, `02 산출물`, 허브, `AGENTS.md`, `99 작업실` 외에 아무것도 만들지 않는다. `99 작업실` 안의 자리는 처음 필요할 때 만든다. 새 자리를 만들면 이 표에 추가한다.\n\n| 자리 | 이 프로젝트에서 쓰는가 | 담는 것 |\n|---|---|---|\n| `01 초안` | 예 | |\n| `02 산출물` | 예 | |\n| `99 작업실/10 자료` | | |\n| `99 작업실/20 지식` | | |\n| `99 작업실/30 실험` | | |\n| `99 작업실/40 회의` | | |\n| `99 작업실/50 데이터` | | |\n| `99 작업실/60 에셋` | | |\n| `99 작업실/70 프롬프트` | | |\n| `99 작업실/80 스크립트` | | |\n\n## 이 프로젝트만의 규칙\n\n- (없으면 비워 둔다)\n\n## 완료 조건 (의미 있는 작업 후)\n\n- [ ] 월별 로그 항목 추가\n- [ ] 허브 갱신 (지금 가장 효과적인 한 가지 행동, 현재 상태, 다음 액션, `updated`)\n- [ ] 로그 인덱스 갱신 (`latest_log`, `updated`, 최근 작업)\n- [ ] 등록부 `05 Project Folders/99 작업실/Project Folders Index.md`의 이 프로젝트 행 갱신\n",
	logIndex: "---\ntype: project-log-index\nproject: \"{{프로젝트명}}\"\nlatest_log: \"99 작업실/로그/{{프로젝트명}} 로그 YYYY-MM.md\"   # 프로젝트 폴더 기준\nupdated:\n---\n\n# {{프로젝트명}} 로그\n\n## 최근 작업\n- \n\n## 기간별 로그\n- [[{{프로젝트명}} 로그 YYYY-MM]]\n",
	monthlyLog: "---\ntype: project-log\nproject: \"{{프로젝트명}}\"\nmonth: YYYY-MM\n---\n\n# {{프로젝트명}} 로그 YYYY-MM\n\n## YYYY-MM-DD — 작업 제목\n\n- **맥락:** \n- **수행:** \n- **결과:** \n- **결정:** \n- **미해결:** \n- **다음:** \n- **근거:** \n",
};
