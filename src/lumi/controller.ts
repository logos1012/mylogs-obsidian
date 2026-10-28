/**
 * 루미's conversation: one at a time, kept while the panel is closed. Sends to the chosen engine
 * (loaded lazily — `./engines.ts` is Node-only), streams the answer, and saves the session file
 * after every answer.
 */

import { FileSystemAdapter, normalizePath, Notice, Platform, TFile } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { buildContext, greeting, type LumiScreen } from "./context.ts";
import { carriedFrom, localIso, type LumiTurn, type SessionMeta, sessionId, sessionPath, sessionText, titleFrom, upsertIndexRow } from "./session.ts";

export interface LumiMessage extends LumiTurn {
	/** Small "읽는 중 · …" lines shown under an answer while it is made. */
	activity?: string[];
	error?: string;
	/** 루미's local greeting: shown, never sent or saved. */
	local?: boolean;
}

type Listener = () => void;

const SESSIONS = "10 Archive Box/Sessions";
const SESSIONS_INDEX = "10 Archive Box/Sessions Index.md";

export class LumiController {
	messages: LumiMessage[] = [];
	busy = false;
	screen: LumiScreen | null = null;
	/** Engine session/thread id of this conversation (per engine). */
	private engineSession: string | null = null;
	private meta: SessionMeta | null = null;
	private path: string | null = null;
	private abort: AbortController | null = null;
	private listeners = new Set<Listener>();

	constructor(private plugin: MyLogsPlugin) {}

	get available(): boolean {
		return Platform.isDesktopApp && this.plugin.app.vault.adapter instanceof FileSystemAdapter;
	}

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	/** Called when 루미 is opened from a screen: a fresh conversation greets for that screen. */
	setScreen(screen: LumiScreen | null): void {
		this.screen = screen;
		if (!this.messages.some((m) => !m.local)) {
			this.messages = [{ role: "lumi", text: greeting(screen), at: localIso(), local: true }];
		}
		this.emit();
	}

	newConversation(): void {
		this.stop();
		this.engineSession = null;
		this.meta = null;
		this.path = null;
		this.messages = [{ role: "lumi", text: greeting(this.screen), at: localIso(), local: true }];
		this.emit();
	}

	stop(): void {
		this.abort?.abort();
	}

	/** Switching engines starts a new conversation (each engine keeps its own thread). */
	async setEngine(engine: "claude" | "codex"): Promise<void> {
		if (this.plugin.settings.lumiEngine === engine) return;
		this.plugin.settings.lumiEngine = engine;
		await this.plugin.saveSettings();
		this.newConversation();
	}

	async send(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt || this.busy) return;
		if (!this.available) {
			new Notice("루미는 데스크톱 Obsidian에서만 쓸 수 있어요.");
			return;
		}
		const s = this.plugin.settings;
		const engine = s.lumiEngine;
		this.messages.push({ role: "user", text: prompt, at: localIso() });
		const answer: LumiMessage = { role: "lumi", text: "", at: localIso(), activity: [] };
		this.messages.push(answer);
		this.busy = true;
		this.abort = new AbortController();
		this.emit();
		try {
			const { runLumi } = await import("./engines.ts");
			const vaultPath = (this.plugin.app.vault.adapter as FileSystemAdapter).getBasePath();
			const instructions = await buildContext(this.plugin.app, s, this.screen);
			for await (const ev of runLumi(prompt, {
				engine,
				path: engine === "claude" ? s.lumiClaudePath : s.lumiCodexPath,
				model: engine === "claude" ? s.lumiClaudeModel : s.lumiCodexModel,
				vaultPath,
				instructions,
				resume: this.engineSession,
				signal: this.abort.signal,
			})) {
				if (ev.type === "delta") answer.text += ev.text;
				else if (ev.type === "text") answer.text = ev.text;
				else if (ev.type === "activity") answer.activity = [...(answer.activity ?? []), ev.label].slice(-4);
				else if (ev.type === "error") answer.error = ev.message;
				else if (ev.type === "done") this.engineSession = ev.sessionId ?? this.engineSession;
				answer.at = localIso();
				this.emit();
			}
		} catch (err) {
			answer.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.busy = false;
			this.abort = null;
			this.emit();
		}
		if (answer.text.trim()) await this.save(engine);
	}

	/** Write the session file and its `Sessions Index.md` row (「3」「4-1」). */
	private async save(engine: "claude" | "codex"): Promise<void> {
		const turns = this.messages.filter((m) => !m.local && m.text.trim());
		if (!turns.length) return;
		const app = this.plugin.app;
		try {
			if (!this.meta) {
				const first = turns[0].at;
				const title = titleFrom(turns[0].text);
				this.meta = {
					id: sessionId(first),
					sourceId: `lumi-${engine}-${this.engineSession ?? first}`,
					tool: engine === "claude" ? "claude-code" : "codex",
					title,
				};
				let path = normalizePath(sessionPath(SESSIONS, first, title));
				for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = normalizePath(sessionPath(SESSIONS, first, `${title} ${n}`));
				this.path = path;
			}
			const path = this.path!;
			const existing = app.vault.getAbstractFileByPath(path);
			const carried = carriedFrom(existing instanceof TFile ? await app.vault.read(existing) : null);
			const text = sessionText(this.meta, turns, carried);
			if (existing instanceof TFile) await app.vault.modify(existing, text);
			else {
				const folder = path.slice(0, path.lastIndexOf("/"));
				if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
				await app.vault.create(path, text);
			}
			const index = app.vault.getAbstractFileByPath(SESSIONS_INDEX);
			if (index instanceof TFile) {
				const meta = this.meta;
				await app.vault.process(index, (t) => upsertIndexRow(t, meta, path, turns, carried));
			}
		} catch (err) {
			console.error("[MyLogs] 루미 session save failed", err);
		}
	}
}
