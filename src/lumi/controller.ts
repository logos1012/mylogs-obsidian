/**
 * 루미's conversations: one `LumiChat` per tab in the panel. Tabs run independently (several can
 * answer at once), keep their own engine / model / thread, survive closing the panel, and are
 * restored on start from their session files. Engines are loaded lazily (`./engines.ts` is
 * Node-only).
 */

import { FileSystemAdapter, normalizePath, Notice, Platform, TFile } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { buildContext, greeting, type LumiScreen } from "./context.ts";
import { carriedFrom, localIso, type LumiTurn, parseSession, type SessionMeta, sessionId, sessionPath, sessionText, titleFrom, transcript, upsertIndexRow } from "./session.ts";
import type { EngineId } from "./engines.ts";

export interface LumiMessage extends LumiTurn {
	/** Small "읽는 중 · …" lines shown under an answer while it is made. */
	activity?: string[];
	error?: string;
	/** 루미's local greeting: shown, never sent or saved. */
	local?: boolean;
}

type Listener = () => void;

export const SESSIONS = "10 Archive Box/Sessions";
const SESSIONS_INDEX = "10 Archive Box/Sessions Index.md";
const MAX_TABS = 8;

function newId(): string {
	return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class LumiChat {
	id = newId();
	title = "새 대화";
	engine: EngineId;
	model: string;
	messages: LumiMessage[] = [];
	busy = false;
	engineSession: string | null = null;
	/** The session file once the first answer is saved. */
	path: string | null = null;
	private meta: SessionMeta | null = null;
	private abort: AbortController | null = null;

	constructor(
		private owner: LumiController,
		engine: EngineId,
		model: string,
	) {
		this.engine = engine;
		this.model = model;
	}

	get started(): boolean {
		return this.messages.some((m) => !m.local);
	}

	greet(screen: LumiScreen | null): void {
		if (!this.started) this.messages = [{ role: "lumi", text: greeting(screen), at: localIso(), local: true }];
	}

	stop(): void {
		this.abort?.abort();
	}

	/** Engine or model change: a started conversation keeps its thread only for the same engine. */
	setEngine(engine: EngineId, model: string): void {
		if (this.busy) return;
		if (engine !== this.engine) {
			this.engineSession = null;
			this.meta = null;
			this.path = null;
			if (this.started) this.messages.push({ role: "lumi", text: `엔진을 ${engine === "claude" ? "Claude Code" : "Codex"}(으)로 바꿨어요. 여기부터는 새 대화로 이어서 저장해요.`, at: localIso(), local: true });
		}
		this.engine = engine;
		this.model = model;
		this.owner.persist();
		this.owner.emit();
	}

	copyAll(): string {
		return transcript(this.messages.filter((m) => !m.local));
	}

	async send(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt || this.busy) return;
		if (!this.owner.available) {
			new Notice("루미는 데스크톱 Obsidian에서만 쓸 수 있어요.");
			return;
		}
		const plugin = this.owner.plugin;
		if (!this.started) this.title = titleFrom(prompt);
		const history = this.messages.filter((m) => !m.local && m.text.trim());
		this.messages.push({ role: "user", text: prompt, at: localIso() });
		const answer: LumiMessage = { role: "lumi", text: "", at: localIso(), activity: [] };
		this.messages.push(answer);
		this.busy = true;
		this.abort = new AbortController();
		this.owner.emit();
		try {
			const { runLumi } = await import("./engines.ts");
			const vaultPath = (plugin.app.vault.adapter as FileSystemAdapter).getBasePath();
			const instructions = await buildContext(plugin.app, plugin.settings, this.owner.screen);
			const path = this.engine === "claude" ? plugin.settings.lumiClaudePath : plugin.settings.lumiCodexPath;
			const run = async (input: string, resume: string | null) => {
				for await (const ev of runLumi(input, { engine: this.engine, path, model: this.model, vaultPath, instructions, resume, signal: this.abort!.signal })) {
					if (ev.type === "delta") answer.text += ev.text;
					else if (ev.type === "text") answer.text = ev.text;
					else if (ev.type === "activity") answer.activity = [...(answer.activity ?? []), ev.label].slice(-4);
					else if (ev.type === "error") answer.error = ev.message;
					else if (ev.type === "done") this.engineSession = ev.sessionId ?? this.engineSession;
					answer.at = localIso();
					this.owner.emit();
				}
			};
			await run(prompt, this.engineSession);
			// A reopened conversation whose engine thread is gone: start a new thread with the
			// conversation so far in front of the question.
			if (!answer.text && answer.error && this.engineSession && !this.abort.signal.aborted) {
				answer.error = undefined;
				this.engineSession = null;
				const recap = history.slice(-20).map((m) => `${m.role === "user" ? "사용자" : "루미"}: ${m.text}`).join("\n\n");
				await run(`(지난 대화를 이어서 해요)\n${recap}\n\n---\n${prompt}`, null);
			}
		} catch (err) {
			answer.error = err instanceof Error ? err.message : String(err);
		} finally {
			this.busy = false;
			this.abort = null;
			this.owner.emit();
		}
		if (answer.text.trim()) await this.save();
		this.owner.persist();
	}

	/** Restore from a session file (history list or panel restart). */
	load(text: string, path: string): void {
		const o = parseSession(text);
		this.title = o.title;
		this.engine = o.engine;
		this.model = o.model;
		this.engineSession = o.engineSession;
		this.path = path;
		this.messages = o.turns.map((t) => ({ ...t }));
		this.meta = null;
	}

	/** Write the session file and its `Sessions Index.md` row (10 Archive Box AGENTS 「3」「4-1」). */
	private async save(): Promise<void> {
		const turns = this.messages.filter((m) => !m.local && m.text.trim());
		if (!turns.length) return;
		const app = this.owner.plugin.app;
		try {
			const existing0 = this.path ? app.vault.getAbstractFileByPath(this.path) : null;
			if (!this.meta) {
				const first = turns[0].at;
				const oldText = existing0 instanceof TFile ? await app.vault.read(existing0) : null;
				const oldId = oldText ? /^id:\s*(.+)$/m.exec(oldText)?.[1].trim() : undefined;
				const oldSource = oldText ? /^source_id:\s*(.+)$/m.exec(oldText)?.[1].trim() : undefined;
				this.meta = {
					id: oldId ?? sessionId(first),
					sourceId: oldSource ?? `lumi-${this.engine}-${this.engineSession ?? first}`,
					tool: this.engine === "claude" ? "claude-code" : "codex",
					title: this.title,
				};
				if (!this.path) {
					let path = normalizePath(sessionPath(SESSIONS, first, this.title));
					for (let n = 2; app.vault.getAbstractFileByPath(path); n++) path = normalizePath(sessionPath(SESSIONS, first, `${this.title} ${n}`));
					this.path = path;
				}
			}
			this.meta.engineSession = this.engineSession;
			this.meta.model = this.model;
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

export class LumiController {
	chats: LumiChat[] = [];
	activeId = "";
	screen: LumiScreen | null = null;
	private listeners = new Set<Listener>();
	private restored = false;

	constructor(public plugin: MyLogsPlugin) {}

	get available(): boolean {
		return Platform.isDesktopApp && this.plugin.app.vault.adapter instanceof FileSystemAdapter;
	}

	/** Any tab answering (the round button breathes). */
	get busy(): boolean {
		return this.chats.some((c) => c.busy);
	}

	get active(): LumiChat {
		this.restore();
		let c = this.chats.find((x) => x.id === this.activeId);
		if (!c) {
			c = this.chats[0] ?? this.addTab();
			this.activeId = c.id;
		}
		return c;
	}

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emit(): void {
		for (const fn of this.listeners) fn();
	}

	/** Tabs from the last run: their session files hold the turns. */
	private restore(): void {
		if (this.restored) return;
		this.restored = true;
		const s = this.plugin.settings;
		for (const t of s.lumiTabs ?? []) {
			const chat = new LumiChat(this, t.engine, t.model);
			chat.id = t.id;
			chat.title = t.title;
			chat.engineSession = t.engineSession;
			if (t.path) {
				const f = this.plugin.app.vault.getAbstractFileByPath(t.path);
				if (f instanceof TFile) {
					chat.path = t.path;
					void this.plugin.app.vault.cachedRead(f).then((text) => {
						chat.load(text, t.path!);
						this.emit();
					});
				}
			}
			chat.greet(this.screen);
			this.chats.push(chat);
		}
		this.activeId = s.lumiActiveTab;
	}

	persist(): void {
		const s = this.plugin.settings;
		s.lumiTabs = this.chats.map((c) => ({ id: c.id, title: c.title, engine: c.engine, model: c.model, path: c.path, engineSession: c.engineSession }));
		s.lumiActiveTab = this.activeId;
		void this.plugin.saveSettings();
	}

	/** Called when 루미 is opened from a screen: an empty tab greets for that screen. */
	setScreen(screen: LumiScreen | null): void {
		this.screen = screen;
		this.active.greet(screen);
		this.emit();
	}

	addTab(): LumiChat {
		this.restore();
		if (this.chats.length >= MAX_TABS) {
			new Notice(`대화 탭은 ${MAX_TABS}개까지 열 수 있어요. 다 쓴 탭을 닫아 주세요.`);
			return this.chats.find((c) => c.id === this.activeId) ?? this.chats[this.chats.length - 1];
		}
		const s = this.plugin.settings;
		const chat = new LumiChat(this, s.lumiEngine, s.lumiEngine === "claude" ? s.lumiClaudeModel : s.lumiCodexModel);
		chat.greet(this.screen);
		this.chats.push(chat);
		this.activeId = chat.id;
		this.persist();
		this.emit();
		return chat;
	}

	select(id: string): void {
		if (!this.chats.some((c) => c.id === id)) return;
		this.activeId = id;
		this.persist();
		this.emit();
	}

	close(id: string): void {
		const i = this.chats.findIndex((c) => c.id === id);
		if (i === -1) return;
		this.chats[i].stop();
		this.chats.splice(i, 1);
		if (this.activeId === id) this.activeId = this.chats[Math.min(i, this.chats.length - 1)]?.id ?? "";
		if (!this.chats.length) this.addTab();
		this.persist();
		this.emit();
	}

	rename(id: string, title: string): void {
		const c = this.chats.find((x) => x.id === id);
		if (!c || !title.trim()) return;
		c.title = title.trim();
		this.persist();
		this.emit();
	}

	/** Reopen a saved session (지난 대화) in a tab — or switch to it when it is already open. */
	async openSession(path: string): Promise<void> {
		this.restore();
		const open = this.chats.find((c) => c.path === path);
		if (open) return this.select(open.id);
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return;
		const blank = this.chats.find((c) => c.id === this.activeId && !c.started && !c.busy);
		const chat = blank ?? this.addTab();
		chat.load(await this.plugin.app.vault.read(f), path);
		this.activeId = chat.id;
		this.persist();
		this.emit();
	}

	/** 루미's saved conversations, newest first (for 지난 대화). */
	history(): { path: string; title: string; date: string; engine: string }[] {
		const app = this.plugin.app;
		return app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(`${SESSIONS}/`))
			.map((f) => ({ f, fm: (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown> }))
			.filter(({ fm }) => fm.saved_by === "mylogs-lumi")
			.map(({ f, fm }) => ({ path: f.path, title: String(fm.title ?? f.basename), date: String(fm.last ?? fm.date ?? ""), engine: fm.tool === "codex" ? "Codex" : "Claude Code" }))
			.sort((a, b) => b.path.localeCompare(a.path));
	}
}
