/**
 * 루미 engines — the user's own local agents, run with their own login (no API key):
 *   Claude Code through the Claude Agent SDK (`claude` executable),
 *   Codex through the Codex SDK (`codex` executable).
 *
 * Node-only (child processes). Loaded with a dynamic `import()` from `./controller.ts` the first
 * time 루미 is asked something, so the plugin still loads on a phone, where this file never runs.
 *
 * Both read the vault freely but never write it directly: Claude may Read / Glob / Grep and every other
 * built-in tool is denied, Codex runs in its read-only sandbox. Writes go through the MyLogs tools
 * (`./tools.ts`) — in-process for Claude, over `./mcp-http.ts` for Codex — so each one is recorded
 * and can be undone.
 */

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { ZodRawShape } from "zod";

export type EngineId = "claude" | "codex";

export type LumiEvent =
	| { type: "delta"; text: string }
	/** Whole text of the current answer so far (replaces what was streamed). */
	| { type: "text"; text: string }
	| { type: "activity"; label: string }
	| { type: "done"; sessionId: string | null }
	| { type: "error"; message: string };

/** The MyLogs tools offered for one run, and how to call them (the plugin runs them). */
export interface ToolBridge {
	tools: { name: string; description: string; shape: ZodRawShape }[];
	call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface RunOptions {
	engine: EngineId;
	/** Executable path from settings ("" = look in the usual places). */
	path: string;
	model: string;
	vaultPath: string;
	/** 루미's instructions + the MyLogs 현황 요약 for this turn. */
	instructions: string;
	/** Engine session/thread id to continue, or null for a new conversation. */
	resume: string | null;
	signal: AbortSignal;
	tools: ToolBridge;
}

const READ_TOOLS = ["Read", "Glob", "Grep"];

/** Where the installers put `claude` / `codex` (Obsidian started from the Dock has a short PATH). */
export function findExecutable(name: EngineId, configured: string): string | null {
	if (configured.trim()) return existsSync(configured.trim()) ? configured.trim() : null;
	const home = homedir();
	const candidates = [
		join(home, ".local", "bin", name),
		join(home, ".claude", "local", name),
		`/opt/homebrew/bin/${name}`,
		`/usr/local/bin/${name}`,
		join(home, ".npm-global", "bin", name),
		...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, name)),
	];
	return candidates.find((p) => existsSync(p)) ?? null;
}

function envFor(exe: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
	const extra = [dirname(exe), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
	env.PATH = [...extra, env.PATH ?? ""].filter(Boolean).join(delimiter);
	return env;
}

export async function* runLumi(prompt: string, o: RunOptions): AsyncGenerator<LumiEvent> {
	const exe = findExecutable(o.engine, o.path);
	if (!exe) {
		yield { type: "error", message: o.engine === "claude" ? "Claude Code(`claude`)를 찾지 못했어요. 설치하고 로그인한 뒤, 필요하면 설정에서 경로를 적어 주세요." : "Codex(`codex`)를 찾지 못했어요. 설치하고 로그인한 뒤, 필요하면 설정에서 경로를 적어 주세요." };
		return;
	}
	try {
		if (o.engine === "claude") yield* runClaude(prompt, exe, o);
		else yield* runCodex(prompt, exe, o);
	} catch (err) {
		if (o.signal.aborted) {
			yield { type: "done", sessionId: o.resume };
			return;
		}
		yield { type: "error", message: err instanceof Error ? err.message : String(err) };
	}
}

async function* runClaude(prompt: string, exe: string, o: RunOptions): AsyncGenerator<LumiEvent> {
	const abort = new AbortController();
	o.signal.addEventListener("abort", () => abort.abort(), { once: true });
	const mylogs = createSdkMcpServer({
		name: "mylogs",
		version: "1.0.0",
		tools: o.tools.tools.map((t) =>
			tool(t.name, t.description, t.shape, async (args) => {
				const r = await o.tools.call(t.name, args as Record<string, unknown>);
				return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
			}),
		),
	});
	const q = query({
		prompt,
		options: {
			pathToClaudeCodeExecutable: exe,
			cwd: o.vaultPath,
			env: envFor(exe),
			model: o.model || undefined,
			resume: o.resume ?? undefined,
			// The vault's CLAUDE.md / .claude settings, not the user's personal setup.
			settingSources: ["project"],
			systemPrompt: { type: "preset", preset: "claude_code", append: o.instructions },
			includePartialMessages: true,
			// Reads are allowed in the callback (not `allowedTools`, which would bypass it).
			mcpServers: { mylogs },
			permissionMode: "default",
			canUseTool: async (toolName, input) =>
				READ_TOOLS.includes(toolName) || toolName.startsWith("mcp__mylogs__")
					? { behavior: "allow", updatedInput: input }
					: { behavior: "deny", message: "볼트 파일은 MyLogs 도구(mcp__mylogs__*)로만 바꿔요. 맞는 도구가 없으면 무엇을 바꿀지 사용자에게 보여 주세요." },
			abortController: abort,
		},
	});
	let sessionId: string | null = o.resume;
	let text = "";
	for await (const m of q) {
		if ("session_id" in m && typeof m.session_id === "string") sessionId = m.session_id;
		if (m.type === "stream_event") {
			const ev = m.event as { type: string; delta?: { type: string; text?: string } };
			if (m.parent_tool_use_id === null && ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
				text += ev.delta.text;
				yield { type: "delta", text: ev.delta.text };
			}
		} else if (m.type === "assistant" && m.parent_tool_use_id === null) {
			for (const b of m.message.content as { type: string; name?: string; input?: Record<string, unknown> }[]) {
				if (b.type === "tool_use") yield { type: "activity", label: activityLabel(b.name ?? "", b.input ?? {}) };
			}
		} else if (m.type === "result") {
			if (m.subtype !== "success") yield { type: "error", message: "답을 끝까지 만들지 못했어요. 다시 물어봐 주세요." };
			else if (!text && typeof m.result === "string") yield { type: "text", text: m.result };
		}
	}
	yield { type: "done", sessionId };
}

function activityLabel(name: string, input: Record<string, unknown>): string {
	const path = String(input.file_path ?? input.path ?? input.pattern ?? "");
	const short = path.split("/").slice(-2).join("/");
	if (name.startsWith("mcp__mylogs__")) return "MyLogs에 쓰는 중";
	if (name === "Read") return `읽는 중 · ${short}`;
	if (name === "Glob" || name === "Grep") return `찾는 중 · ${String(input.pattern ?? "")}`;
	return name;
}

async function* runCodex(prompt: string, exe: string, o: RunOptions): AsyncGenerator<LumiEvent> {
	const { openRun, token } = await import("./mcp-http.ts");
	const run = await openRun(o.tools);
	try {
		yield* codexTurn(prompt, exe, o, run.url, token);
	} finally {
		run.close();
	}
}

async function* codexTurn(prompt: string, exe: string, o: RunOptions, url: string, token: string): AsyncGenerator<LumiEvent> {
	const codex = new Codex({
		codexPathOverride: exe,
		env: { ...envFor(exe), MYLOGS_LUMI_TOKEN: token },
		// Only this server's tools are pre-approved (they are recorded and undoable); the sandbox stays read-only.
		config: { mcp_servers: { mylogs: { url, bearer_token_env_var: "MYLOGS_LUMI_TOKEN", tool_timeout_sec: 120, default_tools_approval_mode: "approve" } } },
	});
	const opts = {
		workingDirectory: o.vaultPath,
		skipGitRepoCheck: true,
		sandboxMode: "read-only" as const,
		approvalPolicy: "never" as const,
		model: o.model || undefined,
	};
	const thread = o.resume ? codex.resumeThread(o.resume, opts) : codex.startThread(opts);
	// Codex has no system prompt option: 루미's instructions ride in front of the message.
	const { events } = await thread.runStreamed(`${o.instructions}\n\n---\n사용자: ${prompt}`, { signal: o.signal });
	for await (const e of events) {
		if ((e.type === "item.updated" || e.type === "item.completed") && e.item.type === "agent_message") yield { type: "text", text: e.item.text };
		else if (e.type === "item.started" && e.item.type === "command_execution") yield { type: "activity", label: `살펴보는 중 · ${e.item.command.slice(0, 60)}` };
		else if (e.type === "item.started" && e.item.type === "mcp_tool_call") yield { type: "activity", label: "MyLogs에 쓰는 중" };
		else if (e.type === "turn.failed") yield { type: "error", message: e.error.message };
		else if (e.type === "error") yield { type: "error", message: e.message };
	}
	yield { type: "done", sessionId: thread.id };
}

/** Codex models offered to this user (`~/.codex/models_cache.json`, visible ones by priority). */
export function listCodexModels(): { id: string; label: string }[] {
	try {
		const raw = JSON.parse(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8")) as { models?: { slug?: string; display_name?: string; visibility?: string; priority?: number }[] };
		return (raw.models ?? [])
			.filter((m) => m.slug && m.visibility !== "hide")
			.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
			.map((m) => ({ id: m.slug!, label: m.display_name ?? m.slug! }));
	} catch {
		return [];
	}
}
