import { debounce, Plugin, type WorkspaceLeaf } from "obsidian";
import { mergeSettings, type MyLogsSettings, MyLogsSettingTab } from "./settings.ts";
import { DailyPadView, VIEW_TYPE_DAILY_PAD } from "./view.ts";
import { PinboardView, VIEW_TYPE_PINBOARD } from "./pinboard/view.ts";
import { VIEW_TYPE_WALL_CALENDAR, WallCalendarView } from "./wall/view.ts";
import { refreshDeskCalendars, registerDeskCalendar } from "./desk/register.ts";
import { refreshProjectFolders, registerProjectFolders } from "./projects/register.ts";
import { refreshDrawers, registerDrawer } from "./drawer/register.ts";
import { activateMyLife, refreshMyLife, registerMyLife } from "./mylife/register.ts";
import { refreshToolbox, registerToolbox } from "./toolbox/register.ts";
import { activateDiary, refreshDiaries, registerDiary } from "./diary/register.ts";

/*
 * MyLogs — Daily Pad, Pinboard, Wall Calendar, Desk Calendar, Project Folders, Drawer, My Life, Toolbox, Diary views.
 *
 * Desk Calendar view (`mylogs-desk-calendar`, drag & drop allocation): src/desk/.
 * Project Folders view (`mylogs-project-folders`, kanban / list / 완료 타임라인): src/projects/.
 * Drawer view (`mylogs-drawer`, 후보 띠 / 세 열 / 꺼내기·놓아주기 dock): src/drawer/.
 * My Life view (`mylogs-my-life`, 날짜 + 오늘/이번 주/이번 달/올해 탭, read-only but 사용자 한마디): src/mylife/.
 * Toolbox view (`mylogs-toolbox`, 스킬 등록부 표 / 상태 토글 / 폐기 / 실행 요청 / 새 스킬 / 수정): src/toolbox/.
 * Diary view (`mylogs-diary`, Day One식 타임라인 / 에디터 / 재료 패널, 오늘 쓰기, 캘린더, 등록부): src/diary/.
 *
 * Still out of scope (see the vault's `MyLogs Plugin 계획.md`):
 * TODO(계획 §9 「뒤로 뺀 것」): Diary Day One JSON import, map, media grid, weather auto-fill.
 * TODO(Toolbox AGENTS 「4-3」「4-4」): running skills and registering cron (Hermes does that); the plugin only queues 「실행 요청」 lines.
 * TODO(Toolbox AGENTS 「4-5」): move 폐기 files to `10 Archive Box/Closed/` once that format is decided (now the file stays in place).
 * TODO(My Life AGENTS 「4」): writing or regenerating My Life files (Hermes does that); index editing; Weekly/Monthly charts.
 * Flywheel (계획 §10, `12 Flywheel/AGENTS.md` 「4-2」): no view; `src/flywheel/model.ts` feeds the Daily Pad new-day skeleton and the `n/7` badges.
 * TODO(계획 §4 「못 한 일 버튼」): 다른 날 / 미래로 / 서랍에 / 쪼개기 / 놓아주기, moved count, 3rd-move questions — never on `(flywheel:: F-N)` lines.
 * TODO(계획 「기본 방침」 5, 「결정할 것」 1): index updates (Daily Pad Index.md, Desk Calendar Index.md).
 * TODO(계획 §6 「후보」): Drawer 「프로젝트 후보」 in the Project Folders 후보 column (separate task).
 * TODO(계획 §7 「뒤로 뺀 것」, Drawer AGENTS 「4-6」): 월간 리뷰 모드 (꺼내기 / 두기 / 놓아주기 per card, departed lines deleted, 50개 초과 warning).
 * TODO(계획 §7 「뒤로 뺀 것」): 조건 충족 auto-detection from Pinboard goal `status` (the when:: chip only links to the goal for now).
 * TODO(계획 §6 「새 프로젝트」): cover image generation (「대표 이미지 프롬프트」; integration undecided).
 * TODO(AGENTS 「3-2」 5): link Pinboard Sub Goals (goals ↔ projects/project_ids) when creating a project.
 * TODO(계획 「기본 방침」 8): move UI strings into translation files (i18n).
 */
export default class MyLogsPlugin extends Plugin {
	settings!: MyLogsSettings;

	private refreshViews = debounce(
		() => {
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DAILY_PAD)) {
				const v = leaf.view;
				if (v instanceof DailyPadView) void v.refreshAll();
			}
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PINBOARD)) {
				const v = leaf.view;
				if (v instanceof PinboardView) void v.refresh();
			}
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WALL_CALENDAR)) {
				const v = leaf.view;
				if (v instanceof WallCalendarView) void v.refreshAll();
			}
			refreshDeskCalendars(this);
			refreshProjectFolders(this);
			refreshDrawers(this);
			refreshMyLife(this);
			refreshToolbox(this);
			refreshDiaries(this);
		},
		600,
		true,
	);

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_DAILY_PAD, (leaf: WorkspaceLeaf) => new DailyPadView(leaf, this));

		this.addRibbonIcon("notebook-pen", "Daily Pad 열기", () => void this.activateDailyPad());

		this.addCommand({
			id: "open-daily-pad",
			name: "Daily Pad 열기",
			callback: () => void this.activateDailyPad(),
		});

		this.registerView(VIEW_TYPE_PINBOARD, (leaf: WorkspaceLeaf) => new PinboardView(leaf, this));
		this.addRibbonIcon("target", "Pinboard 열기", () => void this.activatePinboard());
		this.addCommand({
			id: "open-pinboard",
			name: "Pinboard 열기",
			callback: () => void this.activatePinboard(),
		});

		this.registerView(VIEW_TYPE_WALL_CALENDAR, (leaf: WorkspaceLeaf) => new WallCalendarView(leaf, this));
		this.addRibbonIcon("calendar-range", "Wall Calendar 열기", () => void this.activateView(VIEW_TYPE_WALL_CALENDAR));
		this.addCommand({
			id: "open-wall-calendar",
			name: "Wall Calendar 열기",
			callback: () => void this.activateView(VIEW_TYPE_WALL_CALENDAR),
		});
		registerDeskCalendar(this);
		registerProjectFolders(this);
		registerDrawer(this);
		registerMyLife(this);
		registerToolbox(this);
		registerDiary(this);

		this.addSettingTab(new MyLogsSettingTab(this.app, this));
	}

	async activateDailyPad(): Promise<void> {
		await this.activateView(VIEW_TYPE_DAILY_PAD);
	}

	/** Daily Pad on a given date (My Life ↔ Daily Pad cross-navigation). */
	async openDailyPadAt(date: string): Promise<void> {
		await this.activateDailyPad();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_DAILY_PAD)[0];
		if (leaf?.view instanceof DailyPadView) await leaf.view.goTo(date);
	}

	/** My Life on a given date (its 오늘 tab). */
	async activateMyLife(date?: string): Promise<void> {
		await activateMyLife(this, date);
	}

	/** The Diary view (My Life header button, Daily Pad). */
	async activateDiary(): Promise<void> {
		await activateDiary(this);
	}

	async activatePinboard(): Promise<void> {
		await this.activateView(VIEW_TYPE_PINBOARD);
	}

	async activateView(type: string): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshViews();
	}
}
