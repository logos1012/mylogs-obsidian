import { type ItemView, setIcon } from "obsidian";
import { tip } from "./tip.ts";
import { mountLumiButton } from "../lumi/register.ts";
import type MyLogsPlugin from "../main.ts";

/** Every MyLogs view, in vault folder order (01 Pinboard … 12 Flywheel). */
export const APP_VIEWS: { type: string; label: string; icon: string; desc: string }[] = [
	{ type: "mylogs-pinboard", label: "Pinboard", icon: "target", desc: "올해의 목표와 진척" },
	{ type: "mylogs-wall-calendar", label: "Wall", icon: "calendar-range", desc: "Wall Calendar · 한 해의 달별 일정" },
	{ type: "mylogs-desk-calendar", label: "Desk", icon: "calendar-days", desc: "Desk Calendar · 이번 달 주·날짜 배정" },
	{ type: "mylogs-daily-pad", label: "Daily Pad", icon: "notebook-pen", desc: "오늘 할 일과 기록" },
	{ type: "mylogs-project-folders", label: "Projects", icon: "folder-kanban", desc: "Project Folders · 프로젝트 칸반" },
	{ type: "mylogs-drawer", label: "Drawer", icon: "archive", desc: "지금은 아니지만 꺼낼 조건이 있는 일" },
	{ type: "mylogs-my-life", label: "My Life", icon: "book-open", desc: "하루·주·달·해의 정리" },
	{ type: "mylogs-diary", label: "Diary", icon: "feather", desc: "일기" },
	{ type: "mylogs-toolbox", label: "Toolbox", icon: "wrench", desc: "AI 스킬 등록부" },
	{ type: "mylogs-flywheel", label: "Flywheel", icon: "repeat", desc: "매일 조금씩 나를 키우는 바퀴" },
];

/**
 * The top navigation shared by every MyLogs view. It sits between the view header and
 * `contentEl` (a sibling, so no view's own layout or scroll container changes) and is removed
 * with the view. A tab switches to an open view of that type, or opens it in this tab.
 */
export function mountAppNav(view: ItemView): void {
	const current = view.getViewType();
	view.containerEl.querySelectorAll(":scope > .mylogs-appnav").forEach((e) => e.remove());
	const nav = createDiv({ cls: "mylogs-appnav", attr: { role: "navigation", "aria-label": "MyLogs 화면" } });
	view.contentEl.before(nav);
	view.register(() => nav.remove());
	const list = nav.createDiv({ cls: "mylogs-appnav-list" });
	for (const v of APP_VIEWS) {
		const on = v.type === current;
		const b = list.createEl("button", { cls: `mylogs-appnav-item${on ? " is-active" : ""}`, attr: { type: "button" } });
		if (on) b.setAttr("aria-current", "page");
		setIcon(b.createSpan({ cls: "mylogs-appnav-icon" }), v.icon);
		b.createSpan({ cls: "mylogs-appnav-label", text: v.label });
		tip(b, v.desc);
		b.addEventListener("click", () => {
			if (!on) void goToView(view, v.type);
		});
	}
	// Keep the current tab visible when the bar scrolls (phone width).
	window.requestAnimationFrame(() => list.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest", inline: "center" }));
	mountLumiButton(view, (view as unknown as { plugin?: MyLogsPlugin }).plugin);
}

async function goToView(from: ItemView, type: string): Promise<void> {
	const ws = from.app.workspace;
	const open = ws.getLeavesOfType(type)[0];
	if (open) {
		await ws.revealLeaf(open);
		ws.setActiveLeaf(open, { focus: true });
		return;
	}
	await from.leaf.setViewState({ type, active: true });
}
