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
	/** Not used yet (v0.1). TODO(MyLogs Plugin 계획.md §1 Pinboard). */
	pinboardFolder: string;
	/** Not used yet (v0.1). TODO(MyLogs Plugin 계획.md §2 Wall Calendar). */
	wallCalendarFolder: string;
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
		const folder = (name: string, desc: string, key: "dailyPadFolder" | "deskCalendarFolder" | "pinboardFolder" | "wallCalendarFolder") =>
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
		folder("Pinboard 폴더", "다음 버전에서 사용합니다.", "pinboardFolder");
		folder("Wall Calendar 폴더", "다음 버전에서 사용합니다.", "wallCalendarFolder");

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
