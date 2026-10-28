import { type ItemView, setIcon } from "obsidian";
import { tip } from "./tip.ts";
import { mountLumiButton } from "../lumi/register.ts";
import type MyLogsPlugin from "../main.ts";
import { SIDE_MODES, type SideMode } from "../side.ts";

/** Every MyLogs view, in vault folder order (01 Pinboard … 12 Flywheel). */
export const APP_VIEWS: { type: string; label: string; icon: string; desc: string }[] = [
	{ type: "mylogs-pinboard", label: "Pinboard", icon: "target", desc: "올해의 목표와 진척" },
	{ type: "mylogs-wall-calendar", label: "Wall", icon: "calendar-range", desc: "Wall Calendar · 한 해의 달별 일정" },
	{ type: "mylogs-desk-calendar", label: "Desk", icon: "calendar-days", desc: "Desk Calendar · 이번 달 주·날짜 배정" },
	{ type: "mylogs-daily-pad", label: "Daily Pad", icon: "notebook-pen", desc: "오늘 할 일과 기록" },
	{ type: "mylogs-project-folders", label: "Projects", icon: "folder-kanban", desc: "Project Folders · 프로젝트 칸반" },
	{ type: "mylogs-drawer", label: "Drawer", icon: "archive", desc: "지금은 아니지만 꺼낼 조건이 있는 일" },
	{ type: "mylogs-shelf", label: "Shelf", icon: "library", desc: "지식 책장 · 위키별 칸, 주제별 책" },
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
	const plugin = (view as unknown as { plugin?: MyLogsPlugin }).plugin;
	if (plugin) mountSideSwitch(nav, plugin);
	// Keep the current tab visible when the bar scrolls (phone width).
	window.requestAnimationFrame(() => list.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest", inline: "center" }));
	mountLumiButton(view, plugin);
}

const SIDE_TIP: Record<SideMode, string> = {
	개인: "개인 모드 · 회사 일은 접어 두고 개인 일만 봐요. 새로 적는 일은 개인이에요",
	회사: "회사 모드 · 회사 일만 봐요. 새로 적는 일에 #회사가 붙어요",
	전체: "전체 · 개인과 회사를 함께 봐요. 새로 적는 일은 개인이에요",
};

/** 개인 / 회사 / 전체 (`../side.ts`). Changed by hand only; the band under the bar shows the mode. */
function mountSideSwitch(nav: HTMLElement, plugin: MyLogsPlugin): void {
	const mode = plugin.settings.sideMode;
	nav.dataset.side = mode;
	const seg = nav.createDiv({ cls: "mylogs-side-switch", attr: { role: "radiogroup", "aria-label": "개인 / 회사" } });
	for (const m of SIDE_MODES) {
		const b = seg.createEl("button", { cls: "mylogs-side-btn", text: m, attr: { type: "button", role: "radio", "data-side": m } });
		b.toggleClass("is-active", m === mode);
		b.setAttr("aria-checked", String(m === mode));
		tip(b, SIDE_TIP[m]);
		b.addEventListener("click", () => void plugin.setSideMode(m));
	}
}

/** Every open MyLogs view's switch and band to `m` (before the views reload). */
export function syncSideSwitches(m: SideMode): void {
	document.querySelectorAll<HTMLElement>(".mylogs-appnav").forEach((nav) => {
		nav.dataset.side = m;
		nav.querySelectorAll<HTMLElement>(".mylogs-side-btn").forEach((b) => {
			const on = b.dataset.side === m;
			b.toggleClass("is-active", on);
			b.setAttr("aria-checked", String(on));
		});
	});
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
