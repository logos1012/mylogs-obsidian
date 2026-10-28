import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { VisionBoardView, VIEW_TYPE_VISION } from "./view.ts";

/** Open (or reveal) the Vision Board view. */
export async function activateVisionBoard(plugin: MyLogsPlugin): Promise<VisionBoardView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_VISION)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_VISION, active: true });
	}
	await workspace.revealLeaf(leaf);
	return leaf.view instanceof VisionBoardView ? leaf.view : null;
}

/** View type, ribbon icon and command of Vision Board. */
export function registerVisionBoard(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_VISION, (leaf: WorkspaceLeaf) => new VisionBoardView(leaf, plugin));
	plugin.addRibbonIcon("sparkles", "Vision Board 열기", () => void activateVisionBoard(plugin));
	plugin.addCommand({ id: "open-vision-board", name: "Vision Board 열기", callback: () => void activateVisionBoard(plugin) });
}

/** Re-read open Vision Board views (settings changed). */
export function refreshVisionBoard(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_VISION)) {
		if (leaf.view instanceof VisionBoardView) void leaf.view.refresh();
	}
}
