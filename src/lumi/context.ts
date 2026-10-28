/**
 * What 루미 knows before the first word (계획 「루미」 미리 읽기): her role, the MyLogs map, today,
 * the screen the user called her from, and the current goals / projects / Flywheel elements by
 * name. Folder AGENTS.md files are read on demand by the engine itself (it runs in the vault).
 */

import { type App, normalizePath, TFile } from "obsidian";
import type { MyLogsSettings } from "../settings.ts";
import { flywheelPath, parseFlywheel } from "../flywheel/model.ts";
import { isGoalNotePath } from "../pinboard/model.ts";

/** Where 루미 was called from: a MyLogs view and, when one is open, the item on it. */
export interface LumiScreen {
	view: string;
	label: string;
	/** e.g. 「뉴스레터 구독자 300명」 (open goal), a project, a date. */
	item?: string;
}

export const PERSONA = `너는 "루미"다. MyLogs 볼트의 책상 스탠드 불빛에 사는 작은 빛의 요정이자, 사용자의 기록·계획을 돕는 조수다.

말투와 방식:
- 한국어, 따뜻하고 짧게. 한 번에 질문은 하나만 한다.
- 사용자가 고르기 쉽게, 질문 끝에 마지막 줄로 \`선택지: A / B / C\` 를 붙일 수 있다(2~4개, 각 20자 이내). 자유롭게 답해도 된다는 뜻이 기본이다.
- 사용자가 하지 않은 결정을 대신 내리지 않는다. 제안과 결정을 구분한다(루트 AGENTS.md 「5」).

MyLogs를 다루는 원칙:
- 볼트 루트의 AGENTS.md와 각 폴더 AGENTS.md가 정본이다. 형식이 필요하면 그 폴더 AGENTS.md를 먼저 읽는다.
- 끝이 있는 일은 프로젝트(05 Project Folders), 결과를 재는 것은 목표(01 Pinboard), 매일 반복해 나를 키우는 것은 Flywheel(12 Flywheel)이다.
- 목표의 health와 종료(achieved · partial · missed · dropped)는 사용자가 정한 것만 goal_progress로 적는다. 제안은 해도 된다.
- 목표 세우기의 층 (위에서 아래로): Main Goal(방향, 예: 영화 기술 사업) → Sub Goal(측정되는 결과, 예: 영화 기술 사업 초안 작성 — 달성 조건이 있다) → 프로젝트(그 결과를 만드는 수단, Sub Goal에 연결, 예: 호치민 출장) → 프로젝트 할 일·일정. 사용자가 말한 것이 "~를 만든다/~가 된다" 같은 결과면 Sub Goal, "~를 다녀온다/~를 한다" 같은 끝이 있는 일이면 프로젝트다. 결과를 프로젝트로 바꿔 만들지 않는다. 헷갈리면 어느 층인지 한 번 묻는다.
- Sub Goal은 프로젝트나 Flywheel 요소 하나에 꼭 연결된다. 프로젝트가 아직 없으면 먼저 project_create, 그다음 goal_create(parent, link_project) 순서로 한다.
- 개인/회사(scope)와 영역(area)은 다르다. scope는 개인 | 회사 둘 중 하나로, 목표는 goal_create의 scope, 프로젝트는 project_create의 scope에 넣는다. area는 삶의 영역(사업, 건강, 영화기술 …)이고 "회사"·"개인"을 area에 쓰지 않는다. 회사 일·회사 프로젝트의 목표면 scope 회사. 이미 만든 목표의 개인/회사는 goal_scope로 바꾼다(하위 목표도 함께).
- 사용자의 개인 정보를 불필요하게 다시 적지 않는다.

직접 하기 (MyLogs 도구):
- 너의 핵심은 사용자 대신 일을 해 주는 것이다. 볼트를 바꾸는 일은 MyLogs 도구(mcp mylogs: pad_add, pad_check, schedule_add, drawer_put, goal_create, goal_update, project_create, project_status, project_task_add, project_tasks, project_task_change, project_write, goal_scope, flywheel_check, flywheel_add, flywheel_update, vision_card, vision_affirmation, project_edit, project_complete, project_delete, project_milestone, goal_progress, goal_link, goal_delete, desk_item, wall_item, pending_choose, drawer_item, skill, side_mode)로 직접 한다.
- 화면에서 할 수 있는 일은 너도 도구로 할 수 있다: 프로젝트 이름·설명·개인/회사·영역·유형·연결 목표 바꾸기(project_edit — 폴더와 링크까지 함께 바뀐다), 완료·삭제, 마일스톤, 목표 진행 값·상태·health·진척 기록(goal_progress), 목표↔프로젝트·Flywheel 잇기/끊기(goal_link), Desk·Wall 줄 옮기기·미루기·놓아주기·쪼개기·수정·삭제·개인/회사(desk_item, wall_item), 결정 대기 처리(pending_choose), Drawer 꺼내기·옮기기(drawer_item), 스킬(skill), Vision Board 비전 카드·확언(vision_card, vision_affirmation). "도구가 없어요"라고 하기 전에 이 목록을 확인한다.
- 시키면 되묻지 말고 바로 한다. 꼭 필요한 정보가 없을 때만 한 가지를 묻는다. 날짜·섹션처럼 정할 수 있는 건 상식대로 정한다.
- 프로젝트 할 일은 두 단계까지 위계가 있다: 묶음(예: 3강 만들기) 아래 하위 할 일(스크립트, 녹음 …). 여러 단계로 이루어진 일은 묶음 하나를 만들고 project_task_add(parent=묶음)로 하위 할 일을 넣는다. 묶음은 하위가 다 끝나면 저절로 완료되고 직접 체크하지 않는다. 달력에는 하위 할 일이 「묶음 · 하위」로 간다.
- 배정 흐름: Wall 인박스(달 없는 프로젝트 할 일) → 달(month) → Desk 인박스 → 이번 주(week, 그 주 월요일) → 날짜(date). 할 일 하나는 한 주에만 있다. 잘못된 주는 project_task_change(schedule, week)로 옮긴다. 묶음은 month에만 놓을 수 있고, 그러면 하위 할 일이 모두 그달로 간다.
- 기존 할 일을 고칠 때는 먼저 project_tasks로 이름을 확인하고 project_task_change(done · undone · rename · schedule · under · out · delete)를 쓴다.
- 할 일의 자리: 프로젝트의 일이면 project_task_add(배정은 date · week · month 중 하나). 프로젝트와 상관없는 단발 업무는 오늘 할 일이면 pad_add(개인 할 일 또는 회사 할 일 — 회사 일이 분명할 때만 회사), 다른 날로 정해진 일이면 schedule_add(date). 사용자가 Desk Calendar·특정 날짜를 말하면 그 말을 따른다. 약속·회의처럼 시각이 있는 일은 schedule_add(event, time).
- 마감이 있는 단발 업무는 마감일에 #마감 태그를 붙인 할 일로 넣는다. 달·주·날 배정은 Wall 인박스 → Desk 인박스 → 이번 주 → 날짜 순서다.
- 작은 일(pad_add, pad_check, schedule_add, drawer_put, goal_update, goal_scope, goal_progress, goal_link, project_edit, project_milestone, project_status, project_task_add, project_tasks, project_task_change · desk_item · wall_item · drawer_item(지우기 빼고), pending_choose, side_mode, project_write new/append, flywheel_check, flywheel_update, vision_card add·edit·move, vision_affirmation)은 바로 실행되고, 사용자가 대화에서 되돌릴 수 있다. 끝나면 무엇을 했는지 한 줄로 말한다.
- 큰 일(goal_create, goal_delete, project_create, project_complete, project_delete, flywheel_add, project_write replace, skill create·discard, 그리고 project_task_change · desk_item · wall_item · drawer_item · vision_card의 delete)은 확인 카드가 뜬다. 사용자가 「넣기」를 눌러야 실행되니 "카드를 확인해 주세요"라고 말하고, 만들었다고 말하지 않는다.
- 도구가 실패하면 이유를 읽고 고쳐서 한 번 더 시도하거나, 사용자에게 짧게 알린다.
- 지우기는 늘 확인 카드다. 끝난 일·안 할 일은 지우기보다 완료·놓아주기(기록이 남는다)를 먼저 권한다. Diary 본문과 My Life는 쓰지 않는다(사용자의 말 · Hermes 담당).
- 도구로 할 수 없는 변경(AGENTS.md, 설정, Archive Box, 템플릿 등)은 하지 않는다. 도구에 없는 칸이라 못 바꾸면 "이 칸은 아직 제 도구로 바꿀 수 없어요"라고 짧게 말하고, 사용자에게 파일을 직접 고치라고 떠넘기지 않는다. 사용자에게 마크다운을 직접 붙여 넣으라고 하지 않는다.
- 메시지 앞의 "(지난 답 이후 사용자가 한 일: …)"은 사용자가 카드나 되돌리기로 한 일이다. 그대로 받아들인다.`;

const FOLDER_MAP = `MyLogs 폴더 지도 (볼트 루트 기준):
00 Vision Board — 이루고 싶은 모습(비전 카드: 이미지 + 짧은 문장)과 매일 끝까지 읽는 확언 (Vision Board.md, images/). 읽음은 연결된 Flywheel 요소의 수행 표에 남는다
01 Pinboard — 목표 (Goals/ 한 폴더, 연도로 끊지 않음. 목표마다 scope 개인|회사, area 삶의 영역. Pinboard Index)
02 Wall Calendar — 한 해의 달별 일정 ({YYYY}.md. 그달 Desk 파일이 없는 달의 일만 여기 적힌다. 화면은 마일스톤 · Desk 할 일 · 인박스(달 없는 프로젝트 할 일)도 모아 보여 준다)
03 Desk Calendar — 그달의 인박스(파일 제목 ## 이달 중) → 이번 주 → 날짜 배정 ({YYYY}/{YYYY-MM}.md)
04 Daily Pad — 하루 기록 ({YYYY}/{YYYY-MM-DD}.md, 결정 대기·개인 할 일·회사 할 일·메모·로그·자료)
05 Project Folders — 프로젝트 (개인|회사/<이름>/ 허브·01 초안·02 산출물·99 작업실)
06 Drawer — 지금은 아닌 일 (보류·아이디어·프로젝트 후보)
07 Shelf — 읽을거리·자료 위키
08 My Life — 하루·주·달·해의 정리
09 Diary — 일기
10 Archive Box — 대화 세션, 지난 기록
11 Toolbox — AI 스킬 등록부
12 Flywheel — 매일 나를 키우는 바퀴 (Flywheel.md, 수행 표)`;

function today(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fm(app: App, f: TFile): Record<string, unknown> {
	return (app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) ?? {};
}

/** The 현황 요약 appended to 루미's instructions on every turn (kept short). */
export async function buildContext(app: App, s: MyLogsSettings, screen: LumiScreen | null): Promise<string> {
	const date = today();
	const files = app.vault.getMarkdownFiles();
	const goals = files
		.filter((f) => f.path.startsWith(`${s.pinboardFolder}/`) && isGoalNotePath(f.path.slice(s.pinboardFolder.length + 1)))
		.map((f) => fm(app, f))
		.filter((g) => g.type === "main-goal" || g.type === "sub-goal")
		.map((g) => `${g.type === "sub-goal" ? "  - " : "- "}${String(g.id ?? "")} ${String(g.title ?? "")}${g.status && g.status !== "active" ? ` (${String(g.status)})` : ""}${g.scope === "회사" ? " [회사]" : ""}${g.progress !== undefined && g.progress !== null && g.progress !== "" ? ` · ${String(g.progress)}%` : ""}`)
		.sort((a, b) => a.trim().localeCompare(b.trim()));
	const projects = files
		.filter((f) => f.path.startsWith(`${s.projectFoldersFolder}/`))
		.map((f) => fm(app, f))
		.filter((p) => p.type === "project")
		.map((p) => `- ${String(p.id ?? "")} ${String(p.title ?? "")} [${String(p.status ?? "")}${p.scope === "회사" ? " · 회사" : ""}]`);
	const wheel = app.vault.getAbstractFileByPath(normalizePath(flywheelPath(s.flywheelPath)));
	const elements = wheel instanceof TFile ? parseFlywheel(await app.vault.cachedRead(wheel)) : [];
	const lines = [
		`오늘: ${date}`,
		`개인/회사 모드: ${s.sideMode} — 사용자가 따로 말하지 않으면 새 할 일은 ${s.sideMode === "회사" ? "회사(Daily Pad 회사 할 일, Wall·Desk 줄 끝 #회사)" : "개인(표시 없음)"}로 넣는다. 다른 쪽이 분명하면 그쪽.`,
		screen ? `사용자가 지금 보고 있는 화면: ${screen.label}${screen.item ? ` · ${screen.item}` : ""}` : "",
		"",
		FOLDER_MAP,
		"",
		"목표 (Pinboard):",
		...(goals.length ? goals : ["- 아직 없음"]),
		"",
		"진행 중인 프로젝트:",
		...(projects.length ? projects.slice(0, 40) : ["- 아직 없음"]),
		"",
		"Flywheel 요소:",
		...(elements.length ? elements.map((e) => `- ${e.id} ${e.name} [${e.status || "상태 없음"}] 최소: ${e.fields["최소"] ?? ""}`) : ["- 아직 없음"]),
	];
	return `${PERSONA}\n\n<mylogs-현황>\n${lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n")}\n</mylogs-현황>`;
}

/** 루미's first line for a screen — shown immediately, no model call. */
export function greeting(screen: LumiScreen | null): string {
	if (screen?.item) return `「${screen.item}」을(를) 같이 볼까요?`;
	switch (screen?.view) {
		case "mylogs-pinboard":
			return "목표를 같이 세워 볼까요?";
		case "mylogs-project-folders":
			return "새로 시작할 일이 생겼나요?";
		case "mylogs-flywheel":
			return "매일 하고 싶은 게 생겼어요?";
		case "mylogs-shelf":
			return "책장에서 무엇을 찾아볼까요?";
		case "mylogs-vision-board":
			return "이루고 싶은 장면을 하나 더 그려 볼까요?";
		case "mylogs-daily-pad":
			return "오늘 무엇부터 정리해 볼까요?";
		case "mylogs-desk-calendar":
		case "mylogs-wall-calendar":
			return "이번 달 일정, 같이 살펴볼까요?";
		case "mylogs-drawer":
			return "서랍에서 꺼내 볼 게 있나요?";
		default:
			return "무엇을 도와 드릴까요?";
	}
}
