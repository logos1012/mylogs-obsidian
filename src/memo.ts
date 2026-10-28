/**
 * 빠른 메모 (2026-10-29): from any screen — the ✎ button on MyLogs views, the ribbon, or the
 * command (default ⌘/Ctrl+Shift+M) — a small box; Enter writes it to today's Daily Pad 「메모」.
 * Each line becomes a list line; a line already written as a list (`- …`, `- [ ] …`) stays as is.
 * Today's Daily Pad is made from the skeleton when it does not exist yet.
 */

import { type App, Modal, moment, normalizePath, Notice, Platform, setIcon, TFile, type ItemView } from "obsidian";
import type MyLogsPlugin from "./main.ts";
import { MAIN_SECTION_KEYS, type MyLogsSettings } from "./settings.ts";
import { appendToSection, dailyPadSkeleton, setFrontmatterScalar } from "./writer.ts";
import { toIsoDate } from "./parser.ts";
import { tip } from "./ui/tip.ts";

/** Lines as they go into 「메모」. */
export function memoLines(text: string): string[] {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((l) => l.replace(/\s+$/, ""))
		.filter((l) => l.trim())
		.map((l) => (/^\s*[-*+]\s/.test(l) ? l : `- ${l.trim()}`));
}

/** Append to today's 「메모」 (making today's Daily Pad when missing). Returns the pad path. */
export async function addQuickMemo(host: { app: App; settings: MyLogsSettings }, text: string, date = toIsoDate(new Date())): Promise<string> {
	const lines = memoLines(text);
	if (!lines.length) throw new Error("적은 내용이 없어요.");
	const s = host.settings;
	const path = normalizePath(`${s.dailyPadFolder}/${date.slice(0, 4)}/${date}.md`);
	let f = host.app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) {
		const folder = path.slice(0, path.lastIndexOf("/"));
		if (!host.app.vault.getAbstractFileByPath(folder)) await host.app.vault.createFolder(folder).catch(() => undefined);
		f = await host.app.vault.create(path, dailyPadSkeleton({ isoDate: date, weekday: moment(date, "YYYY-MM-DD").format("ddd"), deskCalendarFolder: s.deskCalendarFolder, sections: MAIN_SECTION_KEYS.map((k) => s.sections[k]) }));
	}
	await host.app.vault.process(f as TFile, (t) => setFrontmatterScalar(appendToSection(t, s.sections.memo, lines.join("\n")), "updated", date));
	return path;
}

class QuickMemoModal extends Modal {
	constructor(
		app: App,
		private plugin: MyLogsPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("mylogs-quick-memo");
		this.titleEl.setText("오늘 메모");
		const box = this.contentEl.createEl("textarea", { cls: "mylogs-quick-memo-input", attr: { rows: "3", placeholder: "떠오른 것을 적거나 붙여 넣고 Enter", "aria-label": "메모" } });
		this.contentEl.createDiv({ cls: "mylogs-quick-memo-help", text: Platform.isMobile ? "Daily Pad 오늘 「메모」에 적혀요" : "Enter 저장 · Shift+Enter 줄바꿈 · Esc 닫기 — Daily Pad 오늘 「메모」에 적혀요" });
		const save = async () => {
			if (!box.value.trim()) return this.close();
			box.disabled = true;
			try {
				await addQuickMemo(this.plugin, box.value);
				new Notice("오늘 메모에 적었어요.", 1800);
				this.close();
			} catch (e) {
				box.disabled = false;
				new Notice(e instanceof Error ? e.message : String(e));
			}
		};
		box.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void save();
			}
		});
		if (Platform.isMobile) {
			const b = this.contentEl.createEl("button", { cls: "mod-cta", text: "적기", attr: { type: "button" } });
			b.addEventListener("click", () => void save());
		}
		window.setTimeout(() => box.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export function openQuickMemo(plugin: MyLogsPlugin): void {
	new QuickMemoModal(plugin.app, plugin).open();
}

/** Ribbon icon and the command (default hotkey ⌘/Ctrl+Shift+M — change it in Obsidian 단축키). */
export function registerQuickMemo(plugin: MyLogsPlugin): void {
	plugin.addRibbonIcon("sticky-note", "빠른 메모 (오늘 Daily Pad 메모)", () => openQuickMemo(plugin));
	plugin.addCommand({ id: "quick-memo", name: "빠른 메모 — 오늘 Daily Pad 메모에 적기", icon: "sticky-note", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }], callback: () => openQuickMemo(plugin) });
}

/** The small ✎ button on every MyLogs view (above 루미 on desktop, bottom-right on a phone). */
export function mountMemoButton(view: ItemView, plugin: MyLogsPlugin | undefined): void {
	if (!plugin) return;
	view.containerEl.querySelectorAll(":scope > .mylogs-memo-fab").forEach((e) => e.remove());
	const b = view.containerEl.createEl("button", { cls: "mylogs-memo-fab", attr: { type: "button", "aria-label": "빠른 메모" } });
	setIcon(b, "sticky-note");
	tip(b, "빠른 메모 — 오늘 Daily Pad 메모에 적어요 (⌘⇧M)");
	b.addEventListener("click", () => openQuickMemo(plugin));
	view.register(() => b.remove());
	view.containerEl.addClass("has-memo-fab");
}
