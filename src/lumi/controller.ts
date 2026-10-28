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
import type { EngineId, ToolBridge } from "./engines.ts";
import { type Change, recordingHost, undoChanges } from "./recorder.ts";
import { LUMI_TOOLS, todayIsoNow } from "./tools.ts";

/** One thing 루미 did (or proposes, on a card) during an answer. */
export interface LumiAction {
	id: string;
	tool: string;
	status: "done" | "undone" | "failed" | "waiting" | "cancelled";
	/** What was done, or the card's title. */
	label: string;
	/** Card details (big tools). */
	lines?: string[];
	error?: string;
	changes?: Change[];
	args?: Record<string, unknown>;
}

const ACTION_MARK: Record<LumiAction["status"], string> = { done: "✓", undone: "↶", failed: "!", waiting: "?", cancelled: "✗" };
const ACTION_NOTE: Record<LumiAction["status"], string> = { done: "", undone: " (되돌림)", failed: " (실패)", waiting: " (확인 대기)", cancelled: " (그만둠)" };

export interface LumiMessage extends LumiTurn {
	/** Small "읽는 중 · …" lines shown under an answer while it is made. */
	activity?: string[];
	error?: string;
	/** 루미's local greeting: shown, never sent or saved. */
	local?: boolean;
	/** What 루미 did through the MyLogs tools during this answer. */
	actions?: LumiAction[];
}

/** The answer text as saved: what 루미 did follows the words. */
function savedText(m: LumiMessage): string {
	if (!m.actions?.length) return m.text;
	const done = m.actions.map((a) => `- ${ACTION_MARK[a.status]} ${a.label}${ACTION_NOTE[a.status]}`).join("\n");
	return `${m.text.replace(/\s+$/, "")}\n\n**루미가 한 일**\n${done}`;
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
	/** Card answers and undos since the last message, told to 루미 with the next one. */
	private notes: string[] = [];

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
		const answer: LumiMessage = { role: "lumi", text: "", at: localIso(), activity: [], actions: [] };
		const told = this.notes.length ? `(지난 답 이후 사용자가 한 일: ${this.notes.join(" / ")})\n\n` : "";
		this.notes = [];
		const tools: ToolBridge = {
			tools: LUMI_TOOLS.map(({ name, description, shape }) => ({ name, description, shape })),
			call: (name, args) => this.callTool(answer, name, args),
		};
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
				for await (const ev of runLumi(input, { engine: this.engine, path, model: this.model, vaultPath, instructions, resume, signal: this.abort!.signal, tools })) {
					if (ev.type === "delta") answer.text += ev.text;
					else if (ev.type === "text") answer.text = ev.text;
					else if (ev.type === "activity") answer.activity = [...(answer.activity ?? []), ev.label].slice(-4);
					else if (ev.type === "error") answer.error = ev.message;
					else if (ev.type === "done") this.engineSession = ev.sessionId ?? this.engineSession;
					answer.at = localIso();
					this.owner.emit();
				}
			};
			await run(told + prompt, this.engineSession);
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
		if (answer.text.trim() || answer.actions?.length) await this.save();
		this.owner.persist();
	}

	/** A MyLogs tool call from the engine: small ones run now (recorded), big ones become a card. */
	private async callTool(answer: LumiMessage, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
		const def = LUMI_TOOLS.find((t) => t.name === name);
		if (!def) return { text: `없는 도구예요: ${name}`, isError: true };
		const plugin = this.owner.plugin;
		const action: LumiAction = { id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, tool: name, status: "waiting", label: "", args };
		if (def.big?.(args)) {
			try {
				const pv = await def.preview!({ host: recordingHost(plugin.app, plugin.settings), today: todayIsoNow() }, args);
				action.label = pv.title;
				action.lines = pv.lines;
			} catch (err) {
				return { text: `아직 카드를 만들 수 없어요: ${err instanceof Error ? err.message : String(err)}`, isError: true };
			}
			(answer.actions ??= []).push(action);
			this.owner.emit();
			return { text: "확인 카드를 사용자에게 보여 줬어요. 사용자가 「넣기」를 눌러야 만들어져요. 아직 만들어지지 않았으니 만들었다고 말하지 말고, 카드를 확인해 달라고 짧게 말해요.", isError: false };
		}
		const r = await this.execute(action, args);
		(answer.actions ??= []).push(action);
		this.owner.emit();
		return r.ok ? { text: `${action.label} (사용자는 대화에서 되돌릴 수 있어요)`, isError: false } : { text: `못 했어요: ${action.error}`, isError: true };
	}

	/** Run a tool on a recording host; on failure undo whatever it already wrote. */
	private async execute(action: LumiAction, args: Record<string, unknown>): Promise<{ ok: boolean }> {
		const def = LUMI_TOOLS.find((t) => t.name === action.tool)!;
		const plugin = this.owner.plugin;
		const host = recordingHost(plugin.app, plugin.settings);
		try {
			const summary = await def.run({ host, today: todayIsoNow() }, args);
			action.status = "done";
			action.label = summary;
			action.changes = host.changes;
			return { ok: true };
		} catch (err) {
			if (host.changes.length) await undoChanges(plugin.app, host.changes).catch((e) => console.error("[MyLogs] 루미 rollback failed", e, host.changes));
			action.status = "failed";
			action.error = err instanceof Error ? err.message : String(err);
			if (!action.label) action.label = action.tool;
			return { ok: false };
		}
	}

	private findAction(id: string): LumiAction | null {
		for (const m of this.messages) for (const a of m.actions ?? []) if (a.id === id) return a;
		return null;
	}

	/** 「넣기」 on a card. */
	async confirm(id: string): Promise<void> {
		const a = this.findAction(id);
		if (!a || a.status !== "waiting") return;
		const title = a.label;
		const r = await this.execute(a, a.args ?? {});
		if (!r.ok) new Notice(`루미: ${a.error}`);
		this.notes.push(r.ok ? `카드 「${title}」 넣음 → ${a.label}` : `카드 「${title}」 넣기 실패: ${a.error}`);
		this.owner.emit();
		await this.save();
	}

	/** 「그만두기」 on a card. */
	async cancel(id: string): Promise<void> {
		const a = this.findAction(id);
		if (!a || a.status !== "waiting") return;
		a.status = "cancelled";
		this.notes.push(`카드 「${a.label}」 그만둠`);
		this.owner.emit();
		await this.save();
	}

	/** 「되돌리기」 on something 루미 did. */
	async undo(id: string): Promise<void> {
		const a = this.findAction(id);
		if (!a || a.status !== "done" || !a.changes) return;
		try {
			await undoChanges(this.owner.plugin.app, a.changes);
			a.status = "undone";
			this.notes.push(`「${a.label}」 되돌림`);
			new Notice("되돌렸어요");
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
		this.owner.emit();
		await this.save();
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
		const turns = this.messages.filter((m) => !m.local && (m.text.trim() || m.actions?.length)).map((m) => ({ role: m.role, at: m.at, text: savedText(m) }));
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
