import { Notice, type WorkspaceLeaf } from "obsidian";
import { migrateFolders } from "./actions.ts";
import type MyLogsPlugin from "../main.ts";
import { FlywheelView, VIEW_TYPE_FLYWHEEL } from "./view.ts";

/** Open (or reveal) the Flywheel view. */
export async function activateFlywheel(plugin: MyLogsPlugin): Promise<FlywheelView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_FLYWHEEL)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_FLYWHEEL, active: true });
	}
	await workspace.revealLeaf(leaf);
	return leaf.view instanceof FlywheelView ? leaf.view : null;
}

/** View type, ribbon icon and command of Flywheel. */
export function registerFlywheel(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_FLYWHEEL, (leaf: WorkspaceLeaf) => new FlywheelView(leaf, plugin));
	plugin.addRibbonIcon("repeat", "Flywheel 열기", () => void activateFlywheel(plugin));
	plugin.addCommand({ id: "open-flywheel", name: "Flywheel 열기", callback: () => void activateFlywheel(plugin) });
	plugin.addCommand({
		id: "flywheel-migrate",
		name: "Flywheel: 새 구조로 정리",
		callback: () =>
			void migrateFolders(plugin)
				.then((log) => new Notice(`Flywheel 정리:\n${log.join("\n")}`, 15000))
				.catch((e) => new Notice(`MyLogs: ${e instanceof Error ? e.message : String(e)}`, 12000))
				.finally(() => refreshFlywheel(plugin)),
	});
}

/** Open the Flywheel view and an element's popup (Pinboard, Projects, Daily Pad call this). */
export async function openFlywheelElement(plugin: MyLogsPlugin, id: string): Promise<void> {
	const v = await activateFlywheel(plugin);
	if (v) {
		await v.refresh();
		v.openElement(id);
	}
}

/** Re-read open Flywheel views (settings changed). */
export function refreshFlywheel(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_FLYWHEEL)) {
		if (leaf.view instanceof FlywheelView) void leaf.view.refresh();
	}
}
