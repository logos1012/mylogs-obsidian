import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { MyLifeView, VIEW_TYPE_MY_LIFE } from "./view.ts";

/** Open (or reveal) the My Life view, optionally on a date (its 오늘 tab). */
export async function activateMyLife(plugin: MyLogsPlugin, date?: string): Promise<MyLifeView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_MY_LIFE)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_MY_LIFE, active: true });
	}
	await workspace.revealLeaf(leaf);
	const view = leaf.view instanceof MyLifeView ? leaf.view : null;
	if (view && date) await view.openDaily(date);
	return view;
}

/** View type, ribbon icon and command of My Life. */
export function registerMyLife(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_MY_LIFE, (leaf: WorkspaceLeaf) => new MyLifeView(leaf, plugin));
	plugin.addRibbonIcon("book-open", "My Life 열기", () => void activateMyLife(plugin));
	plugin.addCommand({
		id: "open-my-life",
		name: "My Life 열기",
		callback: () => void activateMyLife(plugin),
	});
}

/** Re-read open My Life views (settings changed). */
export function refreshMyLife(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_MY_LIFE)) {
		if (leaf.view instanceof MyLifeView) void leaf.view.refresh();
	}
}
