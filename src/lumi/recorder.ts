/**
 * 루미's 「되돌리기」: every MyLogs tool runs on a host whose `app.vault` (and `fileManager.renameFile`)
 * records what it changes, in order. Undo replays the record backwards, and only when each file is
 * still exactly as 루미 left it (nobody edited it since).
 */

import { type App, normalizePath, TFile, TFolder, type TAbstractFile } from "obsidian";
import type { MyLogsSettings } from "../settings.ts";

export type Change =
	| { kind: "write"; path: string; before: string | null; after: string }
	| { kind: "trash"; path: string; before: string }
	| { kind: "rename"; from: string; to: string }
	| { kind: "folder"; path: string };

export interface RecordingHost {
	app: App;
	settings: MyLogsSettings;
	changes: Change[];
}

export function recordingHost(app: App, settings: MyLogsSettings): RecordingHost {
	const changes: Change[] = [];
	const vault = app.vault;
	const pathOf = (f: TAbstractFile | string) => (typeof f === "string" ? normalizePath(f) : f.path);
	const wrapped: Record<string, unknown> = {
		process: async (f: TFile, fn: (data: string) => string, opts?: unknown) =>
			vault.process(
				f,
				(data) => {
					const out = fn(data);
					if (out !== data) changes.push({ kind: "write", path: f.path, before: data, after: out });
					return out;
				},
				opts as never,
			),
		modify: async (f: TFile, data: string, opts?: unknown) => {
			const before = await vault.read(f);
			await vault.modify(f, data, opts as never);
			if (before !== data) changes.push({ kind: "write", path: f.path, before, after: data });
		},
		create: async (path: string, data: string, opts?: unknown) => {
			const f = await vault.create(path, data, opts as never);
			changes.push({ kind: "write", path: f.path, before: null, after: data });
			return f;
		},
		createFolder: async (path: string) => {
			const f = await vault.createFolder(path);
			changes.push({ kind: "folder", path: f.path });
			return f;
		},
		append: async (f: TFile, data: string, opts?: unknown) => {
			const before = await vault.read(f);
			await vault.append(f, data, opts as never);
			changes.push({ kind: "write", path: f.path, before, after: before + data });
		},
		trash: async (f: TAbstractFile, system: boolean) => {
			if (f instanceof TFile) changes.push({ kind: "trash", path: f.path, before: await vault.read(f) });
			else if (f instanceof TFolder) changes.push({ kind: "folder", path: f.path });
			return vault.trash(f, system);
		},
		delete: async () => {
			throw new Error("루미는 파일을 지우지 않아요.");
		},
		rename: async (f: TAbstractFile, to: string) => {
			const from = pathOf(f);
			await vault.rename(f, to);
			changes.push({ kind: "rename", from, to: normalizePath(to) });
		},
	};
	const vaultProxy = new Proxy(vault, {
		get(t, k) {
			if (typeof k === "string" && k in wrapped) return wrapped[k];
			const v = Reflect.get(t, k, t) as unknown;
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
		},
	});
	const fm = app.fileManager;
	const fmProxy = new Proxy(fm, {
		get(t, k) {
			if (k === "renameFile")
				return async (f: TAbstractFile, to: string) => {
					const from = f.path;
					await fm.renameFile(f, to);
					changes.push({ kind: "rename", from, to: normalizePath(to) });
				};
			const v = Reflect.get(t, k, t) as unknown;
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
		},
	});
	const appProxy = new Proxy(app, {
		get(t, k) {
			if (k === "vault") return vaultProxy;
			if (k === "fileManager") return fmProxy;
			return Reflect.get(t, k, t) as unknown;
		},
	});
	return { app: appProxy, settings, changes };
}

/** Collapse repeated writes to one file into its first `before` and last `after` (for display). */
export function touchedFiles(changes: Change[]): string[] {
	const out: string[] = [];
	for (const c of changes) {
		const p = c.kind === "rename" ? c.to : c.path;
		if (c.kind !== "folder" && !out.includes(p)) out.push(p);
	}
	return out;
}

/**
 * Undo `changes` (newest first). Checks everything before touching anything: a file someone changed
 * after 루미 is reported and nothing is undone.
 */
export async function undoChanges(app: App, changes: Change[]): Promise<void> {
	const vault = app.vault;
	const file = (p: string) => {
		const f = vault.getAbstractFileByPath(normalizePath(p));
		return f instanceof TFile ? f : null;
	};
	// Final state per path, walking forward.
	// undefined = the file exists but its text was not recorded (renamed only): not compared.
	const last = new Map<string, string | null | undefined>();
	for (const c of changes) {
		if (c.kind === "write") last.set(c.path, c.after);
		else if (c.kind === "trash") last.set(c.path, null);
		else if (c.kind === "rename") {
			last.set(c.to, last.get(c.from));
			last.set(c.from, null);
		}
	}
	for (const [p, text] of last) {
		if (text === undefined) continue;
		const f = file(p);
		if (text === null ? !!f : !f || (await vault.read(f)) !== text) throw new Error(`루미가 바꾼 뒤에 다시 바뀐 파일이 있어 되돌리지 않았어요: ${p}`);
	}
	for (const c of [...changes].reverse()) {
		if (c.kind === "write") {
			const f = file(c.path);
			if (!f) continue;
			if (c.before === null) await vault.trash(f, true);
			else await vault.modify(f, c.before);
		} else if (c.kind === "trash") {
			await vault.create(c.path, c.before);
		} else if (c.kind === "rename") {
			const f = vault.getAbstractFileByPath(c.to);
			if (f) await app.fileManager.renameFile(f, c.from);
		} else if (c.kind === "folder") {
			const f = vault.getAbstractFileByPath(c.path);
			if (f instanceof TFolder && f.children.length === 0) await vault.trash(f, true);
		}
	}
}
