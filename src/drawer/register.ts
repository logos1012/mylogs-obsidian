import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { DrawerView, VIEW_TYPE_DRAWER } from "./view.ts";

/** Open (or reveal) the Drawer view. */
export async function activateDrawer(plugin: MyLogsPlugin): Promise<DrawerView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_DRAWER)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_DRAWER, active: true });
	}
	await workspace.revealLeaf(leaf);
	return leaf.view instanceof DrawerView ? leaf.view : null;
}

/** View type, ribbon icon and commands of the Drawer. */
export function registerDrawer(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_DRAWER, (leaf: WorkspaceLeaf) => new DrawerView(leaf, plugin));
	plugin.addRibbonIcon("archive", "Drawer 열기", () => void activateDrawer(plugin));
	plugin.addCommand({
		id: "open-drawer",
		name: "Drawer 열기",
		callback: () => void activateDrawer(plugin),
	});
	plugin.addCommand({
		id: "drawer-put",
		name: "Drawer에 넣기",
		callback: async () => {
			const view = await activateDrawer(plugin);
			await view?.reload();
			await view?.addManually();
		},
	});
}

/** Re-read open Drawer views (settings changed). */
export function refreshDrawers(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_DRAWER)) {
		if (leaf.view instanceof DrawerView) void leaf.view.reload();
	}
}
