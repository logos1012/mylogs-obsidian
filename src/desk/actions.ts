import { type App, normalizePath, Notice, TFile } from "obsidian";
import type { MyLogsSettings } from "../settings.ts";
import { newMonthSkeleton, parseMonthKey, todayIsoLocal } from "./model.ts";
import { prependChangeLog } from "./ops.ts";

export const DESK_INDEX_FILE = "Desk Calendar Index.md";

export interface DeskHost {
	app: App;
	settings: MyLogsSettings;
}

export function deskMonthPath(host: DeskHost, key: string): string {
	return normalizePath(`${host.settings.deskCalendarFolder}/${key.slice(0, 4)}/${key}.md`);
}

/** Prepend `- YYYY-MM-DD: what (플러그인)` to `## 변경 기록` of `Desk Calendar Index.md` and set `updated`. */
export async function logDeskChange(host: DeskHost, what: string): Promise<void> {
	const path = normalizePath(`${host.settings.deskCalendarFolder}/${DESK_INDEX_FILE}`);
	const f = host.app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) {
		console.warn(`[MyLogs] ${path} not found; change log not written`);
		return;
	}
	const today = todayIsoLocal();
	await host.app.vault.process(f, (data) => prependChangeLog(data, today, what));
}

/**
 * Create a month file with exactly the skeleton of `_build/new_month.py`. Refuses when the file
 * already exists. Returns true when it was created.
 */
export async function createDeskMonth(host: DeskHost, key: string): Promise<boolean> {
	const ym = parseMonthKey(key);
	if (!ym) {
		new Notice("달은 YYYY-MM 형식이어야 해요.");
		return false;
	}
	const path = deskMonthPath(host, key);
	if (host.app.vault.getAbstractFileByPath(path)) {
		new Notice(`이미 있는 파일이에요. 덮어쓰지 않았어요.\n${path}`);
		return false;
	}
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (folder && !host.app.vault.getAbstractFileByPath(folder)) {
		try {
			await host.app.vault.createFolder(folder);
		} catch {
			// created concurrently
		}
	}
	try {
		await host.app.vault.create(path, newMonthSkeleton(ym.year, ym.month, todayIsoLocal()));
	} catch (err) {
		console.error("[MyLogs] new month failed", err);
		new Notice(`MyLogs: 파일을 만들지 못했어요 (${path})`);
		return false;
	}
	await logDeskChange(host, `${key} 새 달 만들기`);
	new Notice(`${key} Desk Calendar를 만들었어요.`);
	return true;
}
