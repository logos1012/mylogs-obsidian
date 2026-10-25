import { App, PluginSettingTab, Setting } from "obsidian";
import type MyLogsPlugin from "./main.ts";

export interface SectionNames {
	pending: string;
	today: string;
	memo: string;
	log: string;
	scribble: string;
	refs: string;
}

export interface MyLogsSettings {
	dailyPadFolder: string;
	deskCalendarFolder: string;
	/** Pinboard view: goal notes in `<folder>/<YYYY>/`, index at `<folder>/Pinboard Index.md`. */
	pinboardFolder: string;
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
	sections: SectionNames;
	/** Show `#test` markers on test data. */
	showTestMarkers: boolean;
	autosaveDelayMs: number;
}

export const DEFAULT_SETTINGS: MyLogsSettings = {
	dailyPadFolder: "04 Daily Pad",
	deskCalendarFolder: "03 Desk Calendar",
	pinboardFolder: "01 Pinboard",
	wallCalendarFolder: "02 Wall Calendar",
	projectFoldersFolder: "05 Project Folders",
	projectArchiveFolder: "10 Archive Box/Projects",
	drawerPath: "06 Drawer/Drawer.md",
	myLifePath: "08 My Life",
	myLifeCollapsed: {},
	toolboxPath: "11 Toolbox",
	sections: {
		pending: "결정 대기",
		today: "오늘 할 일",
		memo: "메모",
		log: "로그",
		scribble: "끼적임",
		refs: "자료",
	},
	showTestMarkers: true,
	autosaveDelayMs: 800,
};

export function mergeSettings(saved: unknown): MyLogsSettings {
	const s = (saved ?? {}) as Partial<MyLogsSettings>;
	return {
		...DEFAULT_SETTINGS,
		...s,
		sections: { ...DEFAULT_SETTINGS.sections, ...(s.sections ?? {}) },
		myLifeCollapsed: { ...(s.myLifeCollapsed ?? {}) },
	};
}

/** The five fixed section keys, in display and skeleton order. */
export const MAIN_SECTION_KEYS = ["today", "memo", "log", "scribble", "refs"] as const;
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
		section("오늘 할 일", "today");
		section("메모", "memo");
		section("로그", "log");
		section("끼적임", "scribble");
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
