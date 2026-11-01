import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { activateStudio, StudioView, VIEW_TYPE_STUDIO } from "./view.ts";

/** View type and command of the 콘텐츠 스튜디오 (opened from the Flywheel card of the `workspace: studio` element). */
export function registerStudio(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_STUDIO, (leaf: WorkspaceLeaf) => new StudioView(leaf, plugin));
	plugin.addCommand({ id: "open-studio", name: "콘텐츠 스튜디오 열기", callback: () => void activateStudio(plugin) });
}

export { activateStudio };
