/**
 * 루미's MyLogs tools for Codex: a minimal MCP server (streamable HTTP, JSON responses) on
 * 127.0.0.1, guarded by a random bearer token that only the Codex process we start receives.
 * Each run registers its tools under `/mcp/<run id>` and removes them when it ends.
 *
 * Node-only; loaded with `./engines.ts`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ToolBridge } from "./engines.ts";

const runs = new Map<string, ToolBridge>();
let server: Server | null = null;
let port = 0;
export const token = randomBytes(24).toString("hex");

async function ensureServer(): Promise<number> {
	if (server && port) return port;
	server = createServer((req, res) => void handle(req, res));
	await new Promise<void>((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server.address();
	port = typeof addr === "object" && addr ? addr.port : 0;
	// Do not keep Obsidian's process alive for this.
	server.unref();
	return port;
}

/** Register a run's tools; returns the URL for Codex and a function that removes them. */
export async function openRun(bridge: ToolBridge): Promise<{ url: string; close: () => void }> {
	const p = await ensureServer();
	const id = randomBytes(8).toString("hex");
	runs.set(id, bridge);
	return { url: `http://127.0.0.1:${p}/mcp/${id}`, close: () => runs.delete(id) };
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, body === undefined ? {} : { "Content-Type": "application/json" });
	res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

type Rpc = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> };

async function answer(bridge: ToolBridge, m: Rpc): Promise<unknown> {
	const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
	switch (m.method) {
		case "initialize":
			return ok({ protocolVersion: (m.params?.protocolVersion as string) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mylogs", version: "1.0.0" } });
		case "ping":
			return ok({});
		case "tools/list":
			return ok({ tools: bridge.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.shape)) })) });
		case "tools/call": {
			const name = String(m.params?.name ?? "");
			const def = bridge.tools.find((t) => t.name === name);
			if (!def) return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${name}` } };
			const parsed = z.object(def.shape).safeParse(m.params?.arguments ?? {});
			if (!parsed.success) return ok({ content: [{ type: "text", text: `입력이 올바르지 않아요: ${parsed.error.message}` }], isError: true });
			const r = await bridge.call(name, parsed.data as Record<string, unknown>);
			return ok({ content: [{ type: "text", text: r.text }], isError: r.isError });
		}
		default:
			return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } };
	}
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	try {
		if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401);
		const id = /^\/mcp\/([0-9a-f]+)$/.exec(req.url ?? "")?.[1];
		const bridge = id ? runs.get(id) : undefined;
		if (!bridge) return send(res, 404);
		if (req.method === "DELETE") return send(res, 200);
		if (req.method !== "POST") return send(res, 405);
		const body = JSON.parse(await readBody(req)) as Rpc | Rpc[];
		const list = Array.isArray(body) ? body : [body];
		const out: unknown[] = [];
		for (const m of list) if (m.id !== undefined && m.id !== null) out.push(await answer(bridge, m));
		if (!out.length) return send(res, 202);
		send(res, 200, Array.isArray(body) ? out : out[0]);
	} catch (err) {
		send(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
	}
}
