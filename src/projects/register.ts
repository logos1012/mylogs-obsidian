import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { ProjectFoldersView, type ProjectsMode, VIEW_TYPE_PROJECT_FOLDERS } from "./view.ts";

/** Open (or reveal) the Project Folders view, optionally on a screen. */
export async function activateProjectFolders(plugin: MyLogsPlugin, mode?: ProjectsMode): Promise<ProjectFoldersView | null> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_FOLDERS)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_PROJECT_FOLDERS, active: true, state: mode ? { mode } : {} });
	} else if (mode && leaf.view instanceof ProjectFoldersView) {
		await leaf.view.show(mode);
	}
	await workspace.revealLeaf(leaf);
	return leaf.view instanceof ProjectFoldersView ? leaf.view : null;
}

/** View type, ribbon icon and commands of Project Folders. */
export function registerProjectFolders(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_PROJECT_FOLDERS, (leaf: WorkspaceLeaf) => new ProjectFoldersView(leaf, plugin));
	plugin.addRibbonIcon("folder-kanban", "Project Folders 열기", () => void activateProjectFolders(plugin));
	plugin.addCommand({
		id: "open-project-folders",
		name: "Project Folders 열기",
		callback: () => void activateProjectFolders(plugin),
	});
	plugin.addCommand({
		id: "open-project-timeline",
		name: "완료 타임라인 열기",
		callback: () => void activateProjectFolders(plugin, "timeline"),
	});
	plugin.addCommand({
		id: "new-project",
		name: "새 프로젝트 만들기",
		callback: async () => {
			const view = await activateProjectFolders(plugin);
			await view?.refresh();
			await view?.newProject();
		},
	});
}

/** Re-read open Project Folders views (settings changed). */
export function refreshProjectFolders(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_FOLDERS)) {
		if (leaf.view instanceof ProjectFoldersView) void leaf.view.refresh();
	}
}
