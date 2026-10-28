/**
 * 루미 conversations are sessions like any other chat (`10 Archive Box/AGENTS.md` 「3」): one file in
 * `10 Archive Box/Sessions/{YYYY}/{YYYY-MM-DD HHMM} {제목}.md` plus a row in `Sessions Index.md`,
 * rewritten after every answer. Tear-off reads them at midnight (루트 「8」).
 *
 * Pure text builders here; IO in `./controller.ts`.
 */

export interface LumiTurn {
	role: "user" | "lumi";
	text: string;
	/** ISO `YYYY-MM-DDTHH:MM:SS` local time. */
	at: string;
}

export interface SessionMeta {
	id: string;
	sourceId: string;
	tool: "claude-code" | "codex";
	title: string;
	/** Engine thread to continue when the session is reopened (lumi_session), and its model. */
	engineSession?: string | null;
	model?: string;
}

/** Fields Tear-off owns: carried over when the file is rewritten (「4-1」 2). */
export interface Carried {
	tornOffUntil: string;
	routedTo: string[];
	project: string;
}

export function localIso(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 「3-1」 title: about ten characters from the first question, without file-name characters. */
export function titleFrom(text: string): string {
	const t = text.replace(/[\/:\\*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
	return (t.length > 16 ? t.slice(0, 16).trim() : t) || "루미와 대화";
}

export function sessionPath(root: string, first: string, title: string): string {
	return `${root}/${first.slice(0, 4)}/${first.slice(0, 10)} ${first.slice(11, 13)}${first.slice(14, 16)} ${title}.md`;
}

export function sessionId(first: string): string {
	return `S-${first.slice(0, 10)}-${first.slice(11, 13)}${first.slice(14, 16)}${first.slice(17, 19)}`;
}

function yamlStr(s: string): string {
	return /^[\w가-힣 .\-()]*$/.test(s) && s.trim() === s ? s : JSON.stringify(s);
}

/** Read back the Tear-off fields of an existing session file. */
export function carriedFrom(text: string | null): Carried {
	const out: Carried = { tornOffUntil: "", routedTo: [], project: "" };
	if (!text) return out;
	const fmEnd = text.indexOf("\n---", 4);
	const head = fmEnd > 0 ? text.slice(0, fmEnd) : "";
	out.tornOffUntil = /^torn_off_until:\s*(.*)$/m.exec(head)?.[1].trim().replace(/^"|"$/g, "") ?? "";
	out.project = /^project:\s*(.*)$/m.exec(head)?.[1].trim() ?? "";
	const inline = /^routed_to:\s*\[(.*)\]\s*$/m.exec(head);
	if (inline) out.routedTo = inline[1].split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
	else {
		const block = /^routed_to:\s*\n((?:\s+-\s.*\n?)*)/m.exec(head);
		if (block) out.routedTo = block[1].split("\n").map((l) => l.replace(/^\s+-\s/, "").trim().replace(/^"|"$/g, "")).filter(Boolean);
	}
	return out;
}

/** The whole session file (「3-2」 frontmatter, 「3-3」 body). */
export function sessionText(meta: SessionMeta, turns: LumiTurn[], carried: Carried): string {
	const first = turns[0].at;
	const last = turns[turns.length - 1].at;
	const tornOff = !!carried.tornOffUntil && carried.tornOffUntil >= last;
	const fm = [
		"---",
		"type: session",
		`id: ${meta.id}`,
		`source_id: ${meta.sourceId}`,
		`date: ${first.slice(0, 10)}`,
		`last: ${last.slice(0, 10)}`,
		`tool: ${meta.tool}`,
		"channel: app",
		"kind: chat",
		`title: ${yamlStr(meta.title)}`,
		`project: ${carried.project}`,
		`turns: ${turns.filter((t) => t.text.trim()).length}`,
		"attachments: 0",
		"truncated: false",
		"secrets_removed: 0",
		`torn_off_until: ${carried.tornOffUntil}`,
		`torn_off: ${tornOff}`,
		`routed_to: [${carried.routedTo.map((r) => JSON.stringify(r)).join(", ")}]`,
		"saved_by: mylogs-lumi",
		`lumi_session: ${meta.engineSession ?? ""}`,
		`lumi_model: ${meta.model ?? ""}`,
		`saved_at: ${localIso().slice(0, 16)}`,
		"---",
		"",
		`# ${meta.title}`,
		"",
	];
	const day = first.slice(0, 10);
	const body: string[] = [];
	for (const t of turns) {
		if (!t.text.trim()) continue;
		const stamp = t.at.slice(0, 10) === day ? t.at.slice(11, 16) : `${t.at.slice(5, 10)} ${t.at.slice(11, 16)}`;
		body.push("---", `**${t.role === "user" ? "사용자" : "AI"} · ${stamp}**`, "", t.text.trim(), "");
	}
	return [...fm, ...body].join("\n");
}

/** Insert or replace this session's row in `Sessions Index.md` (matched by source_id). */
export function upsertIndexRow(index: string, meta: SessionMeta, path: string, turns: LumiTurn[], carried: Carried): string {
	const first = turns[0].at;
	const last = turns[turns.length - 1].at;
	const link = `[[${path.replace(/\.md$/, "")}\\|${meta.title}]]`;
	const tornOff = !!carried.tornOffUntil && carried.tornOffUntil >= last;
	const row = `| ${meta.id} | \`${meta.sourceId}\` | ${first.slice(0, 10)} | ${last.slice(0, 10)} | ${link} | chat | ${meta.tool} | ${turns.filter((t) => t.text.trim()).length} | ${carried.tornOffUntil} | ${tornOff} | ${carried.routedTo.join("; ")} |`;
	const lines = index.split("\n");
	const at = lines.findIndex((l) => l.includes(`\`${meta.sourceId}\``));
	if (at !== -1) {
		lines[at] = row;
		return lines.join("\n");
	}
	// After the last row of the first table (the register).
	const head = lines.findIndex((l) => l.startsWith("| id | source_id |"));
	if (head === -1) return `${index.replace(/\s*$/, "")}\n\n${row}\n`;
	let end = head + 2;
	while (end < lines.length && lines[end].startsWith("|")) end++;
	lines.splice(end, 0, row);
	return lines.join("\n");
}

/** `선택지: A / B / C` on 루미's last line → quick replies (and the line leaves the bubble). */
export function splitChoices(text: string): { body: string; choices: string[] } {
	const lines = text.replace(/\s+$/, "").split("\n");
	const last = lines[lines.length - 1] ?? "";
	const m = /^\s*(?:\*\*)?선택지(?:\*\*)?\s*[:：]\s*(.+)$/.exec(last);
	if (!m) return { body: text, choices: [] };
	const choices = m[1].split(/\s*[\/|·]\s*/).map((c) => c.replace(/^[`"'「]|[`"'」]$/g, "").trim()).filter((c) => c && c.length <= 40).slice(0, 4);
	return { body: lines.slice(0, -1).join("\n").replace(/\s+$/, ""), choices };
}

export interface OpenedSession {
	title: string;
	engine: "claude" | "codex";
	engineSession: string | null;
	model: string;
	turns: LumiTurn[];
}

/** Read a 루미 session file back (frontmatter + 「3-3」 turns) to reopen it in a tab. */
export function parseSession(text: string): OpenedSession {
	const end = text.indexOf("\n---", 4);
	const head = end > 0 ? text.slice(0, end) : "";
	const get = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(head)?.[1].trim().replace(/^"|"$/g, "") ?? "";
	const date = get("date");
	const tool = get("tool");
	const body = end > 0 ? text.slice(end + 4) : text;
	const turns: LumiTurn[] = [];
	const re = /^---\n\*\*(사용자|AI) · (?:(\d{2}-\d{2}) )?(\d{2}:\d{2})\*\*\n\n/gm;
	const marks = [...body.matchAll(re)];
	marks.forEach((m, i) => {
		const start = (m.index ?? 0) + m[0].length;
		const stop = i + 1 < marks.length ? (marks[i + 1].index ?? body.length) : body.length;
		const day = m[2] ? `${date.slice(0, 4)}-${m[2]}` : date;
		turns.push({ role: m[1] === "사용자" ? "user" : "lumi", text: body.slice(start, stop).replace(/\s+$/, ""), at: `${day}T${m[3]}:00` });
	});
	return { title: get("title") || "루미와 대화", engine: tool === "codex" ? "codex" : "claude", engineSession: get("lumi_session") || null, model: get("lumi_model"), turns };
}

/** The conversation as markdown (「대화 전체 복사」). */
export function transcript(turns: LumiTurn[]): string {
	return turns.filter((t) => t.text.trim()).map((t) => `**${t.role === "user" ? "나" : "루미"}**\n\n${t.text.trim()}`).join("\n\n---\n\n");
}
