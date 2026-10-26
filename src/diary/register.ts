import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { DiaryView, VIEW_TYPE_DIARY } from "./view.ts";

/** Open (or reveal) the Diary view. */
export async function activateDiary(plugin: MyLogsPlugin): Promise<DiaryView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_DIARY)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_DIARY, active: true });
	}
	await workspace.revealLeaf(leaf);
	return leaf.view instanceof DiaryView ? leaf.view : null;
}

/** View type, ribbon icons and commands of Diary. */
export function registerDiary(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_DIARY, (leaf: WorkspaceLeaf) => new DiaryView(leaf, plugin));
	plugin.addRibbonIcon("feather", "Diary 열기", () => void activateDiary(plugin));
	plugin.addRibbonIcon("pen-line", "Diary 오늘 쓰기", () => void writeToday(plugin));
	plugin.addCommand({
		id: "open-diary",
		name: "Diary 열기",
		callback: () => void activateDiary(plugin),
	});
	plugin.addCommand({
		id: "diary-write-today",
		name: "Diary 오늘 쓰기",
		callback: () => void writeToday(plugin),
	});
}

async function writeToday(plugin: MyLogsPlugin): Promise<void> {
	const view = await activateDiary(plugin);
	await view?.writeToday();
}

/** Re-read open Diary views (settings changed). */
export function refreshDiaries(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_DIARY)) {
		if (leaf.view instanceof DiaryView) void leaf.view.refresh();
	}
}
