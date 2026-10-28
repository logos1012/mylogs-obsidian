import { App, PluginSettingTab, Setting } from "obsidian";
import type MyLogsPlugin from "./main.ts";
import { asSideMode, type SideMode } from "./side.ts";

export interface SectionNames {
	pending: string;
	today: string;
	/** Daily Pad 「회사 할 일」 (2026-10-28; `today` is 「개인 할 일」). */
	work: string;
	memo: string;
	log: string;
	refs: string;
}

export interface MyLogsSettings {
	dailyPadFolder: string;
	deskCalendarFolder: string;
	/** Pinboard view: goal notes in `<folder>/<YYYY>/`, index at `<folder>/Pinboard Index.md`. */
	pinboardFolder: string;
	/** Pinboard view: the last chosen view, 목록 (`list`) or 전략 맵 (`map`). */
	pinboardTab: "list" | "map";
	/** Wall Calendar year files: <folder>/<YYYY>.md and <folder>/Wall Calendar Index.md. */
	wallCalendarFolder: string;
	/** Project Folders: `<folder>/<개인|회사>/<프로젝트명>/`, registry and templates in `<folder>/99 작업실/`. */
	projectFoldersFolder: string;
	/** Completed projects: `<folder>/<개인|회사>/<프로젝트명>/`. */
	projectArchiveFolder: string;
	/** The Drawer file (one file is the whole Drawer: `06 Drawer/AGENTS.md` 「3」). */
	drawerPath: string;
	/** My Life root: `<folder>/01 Daily/YYYY/YYYY-MM/`, `02 Weekly/GGGG/`, `03 Monthly/YYYY/`, `04 Yearly/`. */
	myLifePath: string;
	/** My Life view: collapsed section names per tab (daily / weekly / monthly / yearly). */
	myLifeCollapsed: Record<string, string[]>;
	/** Toolbox folder: skills `<folder>/<이름>.md`, registry `<folder>/Toolbox Index.md`, template `<folder>/_Templates/스킬.md`. */
	toolboxPath: string;
	/** Diary folder: entries `<folder>/<YYYY>/<YYYY-MM>/<YYYY-MM-DD HHMM>.md`, registry `<folder>/Diary Index.md`, `_Templates/엔트리.md`, `99 작업실/`. */
	diaryPath: string;
	/** Diary view: the material pane is folded away (remembered). */
	diaryMaterialCollapsed: boolean;
	/** Flywheel folder: `<folder>/Flywheel.md` (read only; its `status:: 사용` elements open each new Daily Pad). */
	flywheelPath: string;
	sections: SectionNames;
	/** 개인 / 회사 / 전체: what Pinboard · Wall · Desk · Projects show, and the side of new lines (set by hand, remembered). */
	sideMode: SideMode;
	/** Show `#test` markers on test data. */
	showTestMarkers: boolean;
	/** Desk Calendar: hide 완료 · 옮김 · 놓아줌 lines (screen only; remembered). */
	deskHideClosed: boolean;
	/** Wall Calendar: which kinds a month shows — milestones ◆, events, tasks (Desk 인박스 · 주 · 날 tasks included). Remembered. */
	wallShow: { milestone: boolean; event: boolean; task: boolean };
	/** Wall Calendar: hide months already past (remembered). */
	wallHidePast: boolean;
	/** Desk month level (phone 흐름 · 달력): show every task, not only milestones · events · #마감 (remembered). */
	deskShowTasks: boolean;
	/** 루미 (desktop AI): which local agent runs — the user's own Claude Code or Codex login. */
	lumiEngine: "claude" | "codex";
	/** Full path to the `claude` / `codex` executable ("" = look in the usual places). */
	lumiClaudePath: string;
	lumiCodexPath: string;
	/** Model override ("" = the engine's default). */
	lumiClaudeModel: string;
	lumiCodexModel: string;
	/** 루미 tabs open in the panel (restored on start); a tab's turns live in its session file. */
	lumiTabs: { id: string; title: string; engine: "claude" | "codex"; model: string; path: string | null; engineSession: string | null }[];
	lumiActiveTab: string;
	autosaveDelayMs: number;
}

export const DEFAULT_SETTINGS: MyLogsSettings = {
	dailyPadFolder: "04 Daily Pad",
	deskCalendarFolder: "03 Desk Calendar",
	pinboardFolder: "01 Pinboard",
	pinboardTab: "list",
	wallCalendarFolder: "02 Wall Calendar",
	projectFoldersFolder: "05 Project Folders",
	projectArchiveFolder: "10 Archive Box/Projects",
	drawerPath: "06 Drawer/Drawer.md",
	myLifePath: "08 My Life",
	myLifeCollapsed: {},
	toolboxPath: "11 Toolbox",
	diaryPath: "09 Diary",
	diaryMaterialCollapsed: false,
	flywheelPath: "12 Flywheel",
	sections: {
		pending: "결정 대기",
		today: "개인 할 일",
		work: "회사 할 일",
		memo: "메모",
		log: "로그",
		refs: "자료",
	},
	sideMode: "전체",
	showTestMarkers: true,
	deskHideClosed: false,
	deskShowTasks: false,
	wallShow: { milestone: true, event: true, task: true },
	wallHidePast: false,
	lumiEngine: "claude",
	lumiClaudePath: "",
	lumiCodexPath: "",
	lumiClaudeModel: "",
	lumiCodexModel: "",
	lumiTabs: [],
	lumiActiveTab: "",
	autosaveDelayMs: 800,
};

export function mergeSettings(saved: unknown): MyLogsSettings {
	const s = (saved ?? {}) as Partial<MyLogsSettings>;
	return {
		...DEFAULT_SETTINGS,
		...s,
		sections: migrateSections({ ...DEFAULT_SETTINGS.sections, ...(s.sections ?? {}) }),
		sideMode: asSideMode(s.sideMode),
		wallShow: { ...DEFAULT_SETTINGS.wallShow, ...(s.wallShow ?? {}) },
		myLifeCollapsed: { ...(s.myLifeCollapsed ?? {}) },
	};
}

/** Saved settings from before 2026-10-28 still name the task section 「오늘 할 일」. */
function migrateSections(x: SectionNames): SectionNames {
	return x.today === LEGACY_TODAY ? { ...x, today: DEFAULT_SETTINGS.sections.today } : x;
}

/** The task section of Daily Pads written before 2026-10-28, read as 「개인 할 일」. */
export const LEGACY_TODAY = "오늘 할 일";

/** The fixed section keys, in display and skeleton order. */
export const MAIN_SECTION_KEYS = ["today", "work", "memo", "log", "refs"] as const;
export type MainSectionKey = (typeof MAIN_SECTION_KEYS)[number];

export function cleanFolder(p: string): string {
	return p.trim().replace(/^\/+|\/+$/g, "");
}

export class MyLogsSettingTab extends PluginSettingTab {
	plugin: MyLogsPlugin;

	constructor(app: App, plugin: MyLogsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("루미 (AI)").setHeading();
		new Setting(containerEl)
			.setName("엔진")
			.setDesc("내 구독으로 로그인된 Claude Code 또는 Codex를 데스크톱에서 실행해요. 루미 패널 위에서도 바꿀 수 있어요.")
			.addDropdown((d) =>
				d
					.addOption("claude", "Claude Code")
					.addOption("codex", "Codex")
					.setValue(s.lumiEngine)
					.onChange(async (v) => {
						s.lumiEngine = v === "codex" ? "codex" : "claude";
						await this.plugin.saveSettings();
					}),
			);
		const exe = (name: string, key: "lumiClaudePath" | "lumiCodexPath", ph: string) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc("비워 두면 ~/.local/bin, /opt/homebrew/bin 등에서 찾아요.")
				.addText((t) =>
					t
						.setPlaceholder(ph)
						.setValue(s[key])
						.onChange(async (v) => {
							s[key] = v.trim();
							await this.plugin.saveSettings();
						}),
				);
		exe("claude 실행 파일 경로", "lumiClaudePath", "~/.local/bin/claude");
		exe("codex 실행 파일 경로", "lumiCodexPath", "~/.local/bin/codex");
		const model = (name: string, key: "lumiClaudeModel" | "lumiCodexModel", ph: string) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc("비워 두면 엔진의 기본 모델을 써요.")
				.addText((t) =>
					t
						.setPlaceholder(ph)
						.setValue(s[key])
						.onChange(async (v) => {
							s[key] = v.trim();
							await this.plugin.saveSettings();
						}),
				);
		model("Claude 모델", "lumiClaudeModel", "예: opus, sonnet");
		model("Codex 모델", "lumiCodexModel", "예: gpt-5.5");

		new Setting(containerEl).setName("폴더").setHeading();
		const folder = (name: string, desc: string, key: "dailyPadFolder" | "deskCalendarFolder" | "pinboardFolder" | "wallCalendarFolder" | "projectFoldersFolder" | "projectArchiveFolder") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) =>
					t
						.setPlaceholder(DEFAULT_SETTINGS[key])
						.setValue(s[key])
						.onChange(async (v) => {
							s[key] = cleanFolder(v) || DEFAULT_SETTINGS[key];
							await this.plugin.saveSettings();
						}),
				);
		folder("Daily Pad 폴더", "하루 파일 위치: <폴더>/<YYYY>/<YYYY-MM-DD>.md", "dailyPadFolder");
		folder("Desk Calendar 폴더", "달 파일 위치: <폴더>/<YYYY>/<YYYY-MM>.md", "deskCalendarFolder");
		folder("Pinboard 폴더", "목표 노트 위치: <폴더>/<YYYY>/*.md · 인덱스: <폴더>/Pinboard Index.md", "pinboardFolder");
		folder("Wall Calendar 폴더", "연도 파일 위치: <폴더>/<YYYY>.md", "wallCalendarFolder");
		folder("Project Folders 폴더", "프로젝트 위치: <폴더>/<개인|회사>/<프로젝트명>/ · 등록부·템플릿: <폴더>/99 작업실/", "projectFoldersFolder");
		folder("완료 프로젝트 보관 폴더", "완료된 프로젝트를 옮기는 곳: <폴더>/<개인|회사>/<프로젝트명>/", "projectArchiveFolder");
		new Setting(containerEl)
			.setName("Drawer 파일")
			.setDesc("보류 · 아이디어 · 프로젝트 후보와 변경 기록이 들어 있는 파일 하나")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.drawerPath)
					.setValue(s.drawerPath)
					.onChange(async (v) => {
						const p = cleanFolder(v);
						s.drawerPath = p ? (p.endsWith(".md") ? p : `${p}.md`) : DEFAULT_SETTINGS.drawerPath;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("My Life 폴더")
			.setDesc("기록 위치: <폴더>/01 Daily/<YYYY>/<YYYY-MM>/<YYYY-MM-DD>.md · 02 Weekly/<GGGG>/<GGGG-Www>.md · 03 Monthly/<YYYY>/<YYYY-MM>.md · 04 Yearly/<YYYY>.md")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.myLifePath)
					.setValue(s.myLifePath)
					.onChange(async (v) => {
						s.myLifePath = cleanFolder(v) || DEFAULT_SETTINGS.myLifePath;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Toolbox 폴더")
			.setDesc("스킬 파일 위치: <폴더>/<이름>.md · 등록부: <폴더>/Toolbox Index.md · 템플릿: <폴더>/_Templates/스킬.md")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.toolboxPath)
					.setValue(s.toolboxPath)
					.onChange(async (v) => {
						s.toolboxPath = cleanFolder(v) || DEFAULT_SETTINGS.toolboxPath;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Diary 폴더")
			.setDesc("엔트리 위치: <폴더>/<YYYY>/<YYYY-MM>/<YYYY-MM-DD HHMM>.md · 등록부: <폴더>/Diary Index.md · 템플릿: <폴더>/_Templates/엔트리.md · 질문·첨부: <폴더>/99 작업실/")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.diaryPath)
					.setValue(s.diaryPath)
					.onChange(async (v) => {
						s.diaryPath = cleanFolder(v) || DEFAULT_SETTINGS.diaryPath;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("Flywheel 폴더")
			.setDesc("바퀴 한 장: <폴더>/Flywheel.md · 읽기만 함. status:: 사용 요소를 새 Daily Pad의 오늘 할 일 맨 위에 넣습니다")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.flywheelPath)
					.setValue(s.flywheelPath)
					.onChange(async (v) => {
						s.flywheelPath = cleanFolder(v) || DEFAULT_SETTINGS.flywheelPath;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Daily Pad 섹션 이름").setHeading();
		const section = (name: string, key: keyof SectionNames, desc?: string) => {
			const st = new Setting(containerEl).setName(name).addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.sections[key])
					.setValue(s.sections[key])
					.onChange(async (v) => {
						s.sections[key] = v.trim() || DEFAULT_SETTINGS.sections[key];
						await this.plugin.saveSettings();
					}),
			);
			if (desc) st.setDesc(desc);
		};
		section("개인 할 일", "today");
		section("회사 할 일", "work");
		section("메모", "memo");
		section("로그", "log");
		section("자료", "refs");
		section("결정 대기", "pending", "이 섹션이 파일에 있을 때만 화면 맨 위에 보입니다.");

		new Setting(containerEl).setName("편집").setHeading();
		new Setting(containerEl)
			.setName("자동 저장 지연 (ms)")
			.setDesc("입력을 멈추고 이만큼 지나면 파일에 저장합니다.")
			.addText((t) =>
				t
					.setPlaceholder(String(DEFAULT_SETTINGS.autosaveDelayMs))
					.setValue(String(s.autosaveDelayMs))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						s.autosaveDelayMs = Number.isFinite(n) ? Math.min(Math.max(n, 150), 10000) : DEFAULT_SETTINGS.autosaveDelayMs;
						await this.plugin.saveSettings();
					}),
			);
		new Setting(containerEl)
			.setName("테스트 데이터 표시")
			.setDesc("#test 태그가 붙은 항목에 작은 표시를 붙입니다.")
			.addToggle((t) =>
				t.setValue(s.showTestMarkers).onChange(async (v) => {
					s.showTestMarkers = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
