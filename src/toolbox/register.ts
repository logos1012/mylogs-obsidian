import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { ToolboxView, VIEW_TYPE_TOOLBOX } from "./view.ts";

/** Open (or reveal) the Toolbox view. */
export async function activateToolbox(plugin: MyLogsPlugin): Promise<ToolboxView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_TOOLBOX)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_TOOLBOX, active: true });
	}
	await workspace.revealLeaf(leaf);
	return leaf.view instanceof ToolboxView ? leaf.view : null;
}

/** View type, ribbon icon and commands of Toolbox. */
export function registerToolbox(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_TOOLBOX, (leaf: WorkspaceLeaf) => new ToolboxView(leaf, plugin));
	plugin.addRibbonIcon("wrench", "Toolbox 열기", () => void activateToolbox(plugin));
	plugin.addCommand({
		id: "open-toolbox",
		name: "Toolbox 열기",
		callback: () => void activateToolbox(plugin),
	});
	plugin.addCommand({
		id: "new-skill",
		name: "새 스킬 만들기",
		callback: async () => {
			const view = await activateToolbox(plugin);
			await view?.refresh();
			await view?.newSkill();
		},
	});
}

/** Re-read open Toolbox views (settings changed). */
export function refreshToolbox(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TOOLBOX)) {
		if (leaf.view instanceof ToolboxView) void leaf.view.refresh();
	}
}
