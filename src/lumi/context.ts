/**
 * What 루미 knows before the first word (계획 「루미」 미리 읽기): her role, the MyLogs map, today,
 * the screen the user called her from, and the current goals / projects / Flywheel elements by
 * name. Folder AGENTS.md files are read on demand by the engine itself (it runs in the vault).
 */

import { type App, normalizePath, TFile } from "obsidian";
import type { MyLogsSettings } from "../settings.ts";
import { flywheelPath, parseFlywheel } from "../flywheel/model.ts";

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
- 사용자의 개인 정보를 불필요하게 다시 적지 않는다.

직접 하기 (MyLogs 도구):
- 너의 핵심은 사용자 대신 일을 해 주는 것이다. 볼트를 바꾸는 일은 MyLogs 도구(mcp mylogs: pad_add, pad_check, schedule_add, drawer_put, goal_create, goal_update, project_create, project_status, project_write, flywheel_check, flywheel_add, flywheel_update)로 직접 한다.
- 시키면 되묻지 말고 바로 한다. 꼭 필요한 정보가 없을 때만 한 가지를 묻는다. 날짜·섹션처럼 정할 수 있는 건 상식대로 정한다(예: 오늘 할 일 = pad_add 오늘 할 일).
- 작은 일(pad_add, pad_check, schedule_add, drawer_put, goal_update, project_status, project_write new/append, flywheel_check, flywheel_update)은 바로 실행되고, 사용자가 대화에서 되돌릴 수 있다. 끝나면 무엇을 했는지 한 줄로 말한다.
- 큰 일(goal_create, project_create, flywheel_add, project_write replace)은 확인 카드가 뜬다. 사용자가 「넣기」를 눌러야 실행되니 "카드를 확인해 주세요"라고 말하고, 만들었다고 말하지 않는다.
- 도구가 실패하면 이유를 읽고 고쳐서 한 번 더 시도하거나, 사용자에게 짧게 알린다.
- 지우는 도구는 없다. 지우라는 요청은 완료 체크·Drawer 보류·놓아주기로 제안한다.
- 도구로 할 수 없는 변경(AGENTS.md, 설정, Archive Box, 템플릿 등)은 하지 않는다. 사용자에게 마크다운을 직접 붙여 넣으라고 하지 않는다.
- 메시지 앞의 "(지난 답 이후 사용자가 한 일: …)"은 사용자가 카드나 되돌리기로 한 일이다. 그대로 받아들인다.`;

const FOLDER_MAP = `MyLogs 폴더 지도 (볼트 루트 기준):
01 Pinboard — 목표 (Main/Sub Goal 노트, Pinboard Index)
02 Wall Calendar — 한 해의 달별 일정 ({YYYY}.md)
03 Desk Calendar — 이번 달의 주·날짜 배정 ({YYYY}/{YYYY-MM}.md)
04 Daily Pad — 하루 기록 ({YYYY}/{YYYY-MM-DD}.md, 결정 대기·오늘 할 일·메모·로그·끼적임·자료)
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
	const year = date.slice(0, 4);
	const files = app.vault.getMarkdownFiles();
	const goals = files
		.filter((f) => f.path.startsWith(`${s.pinboardFolder}/${year}/`))
		.map((f) => fm(app, f))
		.filter((g) => g.type === "main-goal" || g.type === "sub-goal")
		.map((g) => `${g.type === "sub-goal" ? "  - " : "- "}${String(g.id ?? "")} ${String(g.title ?? "")}${g.status && g.status !== "active" ? ` (${String(g.status)})` : ""}${g.progress !== undefined && g.progress !== null && g.progress !== "" ? ` · ${String(g.progress)}%` : ""}`)
		.sort((a, b) => a.trim().localeCompare(b.trim()));
	const projects = files
		.filter((f) => f.path.startsWith(`${s.projectFoldersFolder}/`))
		.map((f) => fm(app, f))
		.filter((p) => p.type === "project")
		.map((p) => `- ${String(p.id ?? "")} ${String(p.title ?? "")} [${String(p.status ?? "")}]`);
	const wheel = app.vault.getAbstractFileByPath(normalizePath(flywheelPath(s.flywheelPath)));
	const elements = wheel instanceof TFile ? parseFlywheel(await app.vault.cachedRead(wheel)) : [];
	const lines = [
		`오늘: ${date}`,
		screen ? `사용자가 지금 보고 있는 화면: ${screen.label}${screen.item ? ` · ${screen.item}` : ""}` : "",
		"",
		FOLDER_MAP,
		"",
		`${year}년 목표 (Pinboard):`,
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
