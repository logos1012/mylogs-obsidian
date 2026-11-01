/**
 * 글 증폭's AI calls: one question → one JSON answer, through 루미's engine (the user's own
 * Claude Code / Codex login). No MyLogs tools; reads only; web only for 「근거 찾아 줘」.
 * Desktop only — the engine module is loaded on first use, like 루미.
 */

import { FileSystemAdapter, Platform } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { AMP_SYSTEM, parseJsonReply } from "./amp.ts";

export const ampAvailable = (plugin: MyLogsPlugin) => Platform.isDesktopApp && plugin.app.vault.adapter instanceof FileSystemAdapter;

export async function ampAsk<T>(plugin: MyLogsPlugin, prompt: string, o: { web?: boolean; signal: AbortSignal }): Promise<T> {
	if (!ampAvailable(plugin)) throw new Error("AI는 데스크톱 앱에서만 쓸 수 있어요.");
	const { runLumi } = await import("../lumi/engines.ts");
	const s = plugin.settings;
	const engine = s.lumiEngine;
	const vaultPath = (plugin.app.vault.adapter as FileSystemAdapter).getBasePath();
	let text = "";
	for await (const ev of runLumi(prompt, {
		engine,
		path: engine === "claude" ? s.lumiClaudePath : s.lumiCodexPath,
		model: engine === "claude" ? s.lumiClaudeModel : s.lumiCodexModel,
		vaultPath,
		instructions: AMP_SYSTEM,
		resume: null,
		signal: o.signal,
		tools: { tools: [], call: async () => ({ text: "", isError: true }) },
		allowWeb: !!o.web,
	})) {
		if (ev.type === "delta") text += ev.text;
		else if (ev.type === "text") text = ev.text;
		else if (ev.type === "error") throw new Error(ev.message);
	}
	if (o.signal.aborted) throw new Error("멈췄어요.");
	return parseJsonReply<T>(text);
}
