import type { WorkspaceLeaf } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { createDeskMonth } from "./actions.ts";
import { shiftMonth, todayIsoLocal } from "./model.ts";
import { pickMonth } from "./modals.ts";
import { DeskCalendarView, VIEW_TYPE_DESK_CALENDAR } from "./view.ts";

/** Open (or reveal) the Desk Calendar view, optionally at a month. */
export async function activateDeskCalendar(plugin: MyLogsPlugin, month?: string): Promise<void> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_DESK_CALENDAR)[0];
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_DESK_CALENDAR, active: true, state: month ? { month } : {} });
	} else if (month && leaf.view instanceof DeskCalendarView) {
		await leaf.view.goTo(month);
	}
	await workspace.revealLeaf(leaf);
}

/** View type, ribbon icon and the two commands of the Desk Calendar. */
export function registerDeskCalendar(plugin: MyLogsPlugin): void {
	plugin.registerView(VIEW_TYPE_DESK_CALENDAR, (leaf: WorkspaceLeaf) => new DeskCalendarView(leaf, plugin));
	plugin.addRibbonIcon("calendar-days", "Desk Calendar 열기", () => void activateDeskCalendar(plugin));
	plugin.addCommand({
		id: "open-desk-calendar",
		name: "Desk Calendar 열기",
		callback: () => void activateDeskCalendar(plugin, todayIsoLocal().slice(0, 7)),
	});
	plugin.addCommand({
		id: "new-desk-month",
		name: "새 달 만들기",
		callback: async () => {
			// Like new_month.py: next month by default.
			const key = await pickMonth(plugin.app, "새 달 만들기", shiftMonth(todayIsoLocal().slice(0, 7), 1), "그 달의 모든 주와 날짜 칸이 들어간 빈 틀을 만들어요. 이미 있으면 만들지 않아요.");
			if (!key) return;
			if (await createDeskMonth(plugin, key)) await activateDeskCalendar(plugin, key);
		},
	});
}

/** Re-render open Desk Calendar views (settings changed). */
export function refreshDeskCalendars(plugin: MyLogsPlugin): void {
	for (const leaf of plugin.app.workspace.getLeavesOfType(VIEW_TYPE_DESK_CALENDAR)) {
		if (leaf.view instanceof DeskCalendarView) void leaf.view.reload();
	}
}
