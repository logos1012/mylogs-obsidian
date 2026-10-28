import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { ShelfView, VIEW_TYPE_SHELF } from "./view.ts";

/** Open (or reveal) the Shelf view. */
export async function activateShelf(plugin: MyLogsPlugin): Promise<ShelfView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_SHELF)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_SHELF, active: true });
	}
	await workspace.revealLeaf(leaf);
	return leaf.view instanceof ShelfView ? leaf.view : null;
}

/** View type, ribbon icon and command of Shelf. */
export function registerShelf(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_SHELF, (leaf: WorkspaceLeaf) => new ShelfView(leaf, plugin));
	plugin.addRibbonIcon("library", "Shelf 열기", () => void activateShelf(plugin));
	plugin.addCommand({ id: "open-shelf", name: "Shelf 열기", callback: () => void activateShelf(plugin) });
}

/** Re-read open Shelf views (settings changed). */
export function refreshShelf(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SHELF)) {
		if (leaf.view instanceof ShelfView) void leaf.view.refresh();
	}
}
