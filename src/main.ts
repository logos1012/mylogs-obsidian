import { debounce, Plugin, type WorkspaceLeaf } from "obsidian";
import { mergeSettings, type MyLogsSettings, MyLogsSettingTab } from "./settings.ts";
import { DailyPadView, VIEW_TYPE_DAILY_PAD } from "./view.ts";
import { VIEW_TYPE_WALL_CALENDAR, WallCalendarView } from "./wall/view.ts";

/*
 * MyLogs v0.1.0 — Daily Pad view only.
 *
 * Out of scope for v0.1 (see the vault's `MyLogs Plugin 계획.md`):
 * TODO(계획 §1): Pinboard view (`mylogs-pinboard`).
 * TODO(계획 §3): Desk Calendar view (`mylogs-desk-calendar`) incl. drag & drop allocation.
 * TODO(계획 §4 「못 한 일 버튼」): 다른 날 / 미래로 / 서랍에 / 쪼개기 / 놓아주기, moved count, 3rd-move questions.
 * TODO(계획 「기본 방침」 5, 「결정할 것」 1): index updates (Daily Pad Index.md, Desk Calendar Index.md).
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
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WALL_CALENDAR)) {
				const v = leaf.view;
				if (v instanceof WallCalendarView) void v.refreshAll();
			}
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

		this.registerView(VIEW_TYPE_WALL_CALENDAR, (leaf: WorkspaceLeaf) => new WallCalendarView(leaf, this));
		this.addRibbonIcon("calendar-range", "Wall Calendar 열기", () => void this.activateView(VIEW_TYPE_WALL_CALENDAR));
		this.addCommand({
			id: "open-wall-calendar",
			name: "Wall Calendar 열기",
			callback: () => void this.activateView(VIEW_TYPE_WALL_CALENDAR),
		});

		this.addSettingTab(new MyLogsSettingTab(this.app, this));
	}

	async activateDailyPad(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_DAILY_PAD)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_DAILY_PAD, active: true });
		}
		await workspace.revealLeaf(leaf);
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
