/**
 * 루미 wiring: the panel view, the round button on every MyLogs view (desktop only), a command,
 * and what each screen tells 루미 about itself.
 */

import { type ItemView, Platform, type WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { LUMI_SVG } from "./icon.ts";
import { LumiView, VIEW_TYPE_LUMI } from "./view.ts";
import type { LumiScreen } from "./context.ts";
import { APP_VIEWS } from "../ui/nav.ts";
import { tip } from "../ui/tip.ts";

/** A MyLogs view may name the item it shows (an open goal, a project) for 루미's first line. */
export interface LumiAware {
	lumiItem?(): string | undefined;
}

export function screenOf(view: ItemView): LumiScreen {
	const type = view.getViewType();
	const label = APP_VIEWS.find((v) => v.type === type)?.label ?? view.getDisplayText();
	const item = (view as unknown as LumiAware).lumiItem?.();
	return { view: type, label, item: item || undefined };
}

export function registerLumi(plugin: MyLogsPlugin): void {
	if (!Platform.isDesktopApp) return;
	plugin.registerView(VIEW_TYPE_LUMI, (leaf: WorkspaceLeaf) => new LumiView(leaf, plugin));
	plugin.addCommand({ id: "open-lumi", name: "루미 열기", callback: () => void openLumi(plugin, null) });
}

/** Open (or reveal) the panel in the right sidebar; `from` = the screen 루미 was called from. */
export async function openLumi(plugin: MyLogsPlugin, from: ItemView | null): Promise<void> {
	if (from) plugin.lumi.setScreen(screenOf(from));
	else plugin.lumi.setScreen(plugin.lumi.screen);
	const ws = plugin.app.workspace;
	let leaf = ws.getLeavesOfType(VIEW_TYPE_LUMI)[0];
	if (!leaf) {
		leaf = ws.getRightLeaf(false) ?? ws.getLeaf("split");
		await leaf.setViewState({ type: VIEW_TYPE_LUMI, active: true });
	}
	await ws.revealLeaf(leaf);
	if (leaf.view instanceof LumiView) leaf.view.focusInput();
}

/** Click on the button: open with this screen, or close the panel when it is already in front. */
async function toggleLumi(plugin: MyLogsPlugin, from: ItemView): Promise<void> {
	const ws = plugin.app.workspace;
	const leaf = ws.getLeavesOfType(VIEW_TYPE_LUMI)[0];
	const shown = leaf && (leaf.view.containerEl as HTMLElement).isShown() && !ws.rightSplit.collapsed;
	if (shown && plugin.lumi.screen?.view === from.getViewType()) {
		leaf.detach();
		return;
	}
	await openLumi(plugin, from);
}

/** The round 루미 button in a MyLogs view's bottom-right corner (desktop only). */
export function mountLumiButton(view: ItemView, plugin: MyLogsPlugin | undefined): void {
	if (!plugin?.lumi || !Platform.isDesktopApp || Platform.isMobile) return;
	view.containerEl.querySelectorAll(":scope > .lumi-fab").forEach((e) => e.remove());
	const b = view.containerEl.createEl("button", { cls: "lumi-fab", attr: { type: "button", "aria-label": "루미" } });
	b.innerHTML = LUMI_SVG;
	tip(b, "루미 — 목표·프로젝트·Flywheel을 같이 정리해 줘요");
	b.addEventListener("click", () => void toggleLumi(plugin, view));
	const sync = () => b.toggleClass("is-busy", plugin.lumi.busy);
	view.register(plugin.lumi.on(sync));
	view.register(() => b.remove());
	view.containerEl.addClass("has-lumi-fab");
}
