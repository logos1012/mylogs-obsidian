/**
 * Built-in copy of `11 Toolbox/_Templates/스킬.md` (as of 2026-10-26).
 * Used only when the template file is missing from the vault; the vault copy always wins.
 */

export const DEFAULT_SKILL_TEMPLATE =
	"---\ntype: skill\nid: T-00\nname: \nowner: hermes\ntrigger: cron\nschedule: \"\"\noutput: \nnotify: \nstatus: 멈춤\nlast_run: \nlast_result: \nlast_reviewed: {{date:YYYY-MM-DD}}\ncreated: {{date:YYYY-MM-DD}}\nupdated: {{date:YYYY-MM-DD}}\n---\n# {{title}}\n\n## 목적\n\n<!-- 한 문단. 이 스킬이 없으면 무엇이 불편한가. -->\n\n## 입력\n\n<!-- 읽는 것: 볼트 파일, 웹, 도구. 계정·키는 적지 않는다(서버 환경 변수). -->\n\n## 절차\n\n1. \n2. \n3. \n\n<!-- 실행 AI가 판단 없이 따를 수 있게. 출력 위치의 폴더 AGENTS 규칙을 여기에 반영한다. -->\n\n## 출력 형식\n\n<!-- 파일 이름, frontmatter, 섹션. 예시는 김하루의 것만. -->\n\n## 금지\n\n- \n\n## 완료 조건\n\n- [ ] \n- [ ] `output` 위치에 파일이 있고 그 폴더 인덱스를 갱신했다\n- [ ] `notify`대로 알렸다\n- [ ] frontmatter `last_run`·`last_result`와 등록부를 갱신했다\n\n## 변경 기록\n\n- {{date:YYYY-MM-DD}}: 만듦.\n";
