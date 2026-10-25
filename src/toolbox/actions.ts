/**
 * Toolbox vault operations: the 「4-1」 / 「4-2」 / 「4-4」 6 / 「4-5」 procedures of
 * `11 Toolbox/AGENTS.md`, executed with the pure transforms of `ops.ts`. Each file is changed
 * with `vault.process` (atomic read-modify-write). The skill file is written first; the registry
 * follows it (file = canonical).
 */

import { type App, normalizePath, Notice, TFile } from "obsidian";
import { toIsoDate } from "../parser.ts";
import { parseFrontmatterText, valueToString } from "../pinboard/model.ts";
import { cleanFolder, type MyLogsSettings } from "../settings.ts";
import { type Entry, type LiveStatus, nameLink, nextSkillId, parseSkill, reconcile, registryAffected, registryPathOf, requestStamp, type RunRequest, type Skill, type SkillEdit, skillEditChanges, type SkillInput, skillName, skillPath, type SkillRow, templatePathOf } from "./model.ts";
import { appendRunRequest, applySkillEdit, changeText, fillSkillTemplate, leftoverPlaceholders, logToolboxChange, moveRowToDiscarded, parseToolboxRegistry, type RegistryResult, setSkillStatus, skillRowOf, upsertSkillRow } from "./ops.ts";
import { DEFAULT_SKILL_TEMPLATE } from "./templates.ts";

export interface ToolboxHost {
	app: App;
	settings: MyLogsSettings;
}

export function toolboxRoot(host: ToolboxHost): string {
	return cleanFolder(host.settings.toolboxPath) || "11 Toolbox";
}
export function registryPath(host: ToolboxHost): string {
	return normalizePath(registryPathOf(toolboxRoot(host)));
}

function fileAt(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
}

function today(): string {
	return toIsoDate(new Date());
}

// ───────────────────────── read ─────────────────────────

export interface ToolboxData {
	skills: Skill[];
	rows: SkillRow[];
	requests: RunRequest[];
	entries: Entry[];
	/** The registry exists. */
	hasRegistry: boolean;
}

/** Skill files directly under the folder (`type: skill`) and the registry. */
export async function loadToolbox(host: ToolboxHost): Promise<ToolboxData> {
	const { app } = host;
	const root = toolboxRoot(host);
	const skills: Skill[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		if (!skillName(f.path, root)) continue;
		if (valueToString(app.metadataCache.getFileCache(f)?.frontmatter?.type) !== "skill") continue;
		// The raw text keeps `last_run: 2026-10-26T04:30` as written (the cache may make it a Date).
		const { data, body } = parseFrontmatterText(await app.vault.cachedRead(f));
		const s = parseSkill(data, body, f.path, root);
		if (s) skills.push(s);
	}
	const reg = fileAt(app, registryPath(host));
	const parsed = reg ? parseToolboxRegistry(await app.vault.cachedRead(reg)) : { skills: [], discarded: [], requests: [] };
	return { skills, rows: parsed.skills, requests: parsed.requests, entries: reconcile(skills, parsed.skills), hasRegistry: !!reg };
}

/** Ids and names on disk or in the registry (「4-1」 1: duplicates are refused). */
export function takenIdsAndNames(d: Pick<ToolboxData, "skills" | "rows">, discarded: { id: string }[] = []): { ids: string[]; names: string[] } {
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const s of d.skills) {
		if (s.id) ids.add(s.id);
		names.add(s.name);
	}
	for (const r of d.rows) {
		if (r.id) ids.add(r.id);
		const n = r.nameCell.replace(/^\[\[[^\]|]*\\\|/, "").replace(/\]\]$/, "");
		if (n) names.add(n);
	}
	for (const r of discarded) if (r.id) ids.add(r.id);
	return { ids: [...ids], names: [...names] };
}

/** The next `T-NN` from skill files, the 「스킬」 table and the 「폐기」 table. */
export async function nextId(host: ToolboxHost, d: Pick<ToolboxData, "skills" | "rows">): Promise<string> {
	const reg = fileAt(host.app, registryPath(host));
	const discarded = reg ? parseToolboxRegistry(await host.app.vault.cachedRead(reg)).discarded : [];
	return nextSkillId(takenIdsAndNames(d, discarded).ids);
}

async function loadTemplate(host: ToolboxHost): Promise<string> {
	const f = fileAt(host.app, templatePathOf(toolboxRoot(host)));
	if (f) return host.app.vault.read(f);
	console.warn("[MyLogs] Toolbox template 스킬.md not found; using the built-in copy");
	return DEFAULT_SKILL_TEMPLATE;
}

// ───────────────────────── write helpers ─────────────────────────

/** Edit the registry with one transform and log the change (「변경 기록」 + `updated`). */
async function editRegistry(host: ToolboxHost, edit: (text: string) => RegistryResult, change: string | null): Promise<string | null> {
	const f = fileAt(host.app, registryPath(host));
	if (!f) return "등록부(Toolbox Index.md)가 없어요";
	let problem: string | null = null;
	try {
		await host.app.vault.process(f, (text) => {
			const r = edit(text);
			if (!r.ok) {
				problem = r.reason;
				return text;
			}
			return change ? logToolboxChange(r.text, today(), change) : r.text;
		});
	} catch (err) {
		console.error("[MyLogs] Toolbox registry write failed", err);
		return "등록부에 쓰지 못했어요";
	}
	return problem;
}

function report(failed: string[], ok: string): void {
	if (failed.length) new Notice(`MyLogs: ${failed.join(", ")} 갱신에 실패했어요. 나머지는 저장됐어요.`);
	else new Notice(ok);
}

// ───────────────────────── 「4-5」 status / 폐기 ─────────────────────────

/** 멈춤 / 시험 / 사용: skill `status` + `updated`, the registry 상태 cell, one 「변경 기록」 line. */
export async function setStatus(host: ToolboxHost, s: Skill, status: LiveStatus): Promise<void> {
	if (status === s.status) return;
	const f = fileAt(host.app, s.path);
	if (!f) {
		new Notice(`스킬 파일을 찾지 못했어요: ${s.path}`);
		return;
	}
	const failed: string[] = [];
	try {
		await host.app.vault.process(f, (t) => setSkillStatus(t, status, today()));
	} catch (err) {
		console.error("[MyLogs] Toolbox skill write failed", err);
		new Notice("MyLogs: 스킬 파일에 쓰지 못했어요. 등록부는 바꾸지 않았어요.");
		return;
	}
	const problem = await editRegistry(host, (t) => upsertSkillRow(t, { id: s.id, status }, skillRowOf({ ...s, status }, toolboxRoot(host))), changeText.status(status, s.name));
	if (problem) failed.push(`등록부 (${problem})`);
	const said = { 사용: "사용으로 바꿨어요. Hermes가 cron을 맞추면 돌아요.", 시험: "시험으로 바꿨어요. cron에는 걸리지 않고 「지금 실행」으로만 돌아요.", 멈춤: "멈췄어요." }[status];
	report(failed, `「${s.name}」을(를) ${said}`);
}

/**
 * 폐기: `status: 폐기`, the row moves to 「폐기」 (폐기일, 이유), one 「변경 기록」 line. The file stays
 * where it is — TODO(AGENTS 「4-5」): move it to `10 Archive Box/Closed/` once that format is decided.
 */
export async function discardSkill(host: ToolboxHost, s: Skill, o: { date: string; reason: string }): Promise<void> {
	const f = fileAt(host.app, s.path);
	if (!f) {
		new Notice(`스킬 파일을 찾지 못했어요: ${s.path}`);
		return;
	}
	const failed: string[] = [];
	try {
		await host.app.vault.process(f, (t) => setSkillStatus(t, "폐기", today()));
	} catch (err) {
		console.error("[MyLogs] Toolbox skill write failed", err);
		new Notice("MyLogs: 스킬 파일에 쓰지 못했어요. 등록부는 바꾸지 않았어요.");
		return;
	}
	const problem = await editRegistry(
		host,
		(t) => moveRowToDiscarded(t, { id: s.id, nameCell: nameLink(toolboxRoot(host), s.name), date: o.date, reason: o.reason }),
		changeText.discard(s.name, o.reason),
	);
	if (problem) failed.push(`등록부 (${problem})`);
	report(failed, `「${s.name}」을(를) 폐기했어요. 파일은 그대로 두었어요.`);
}

// ───────────────────────── 「4-4」 실행 요청 ─────────────────────────

/** `- [ ] T-NN (requested:: 시각)` under 「실행 요청」. Hermes runs it (the plugin only queues). */
export async function requestRun(host: ToolboxHost, s: Skill): Promise<boolean> {
	const f = fileAt(host.app, registryPath(host));
	if (!f) {
		new Notice("등록부(Toolbox Index.md)가 없어 실행을 요청하지 못했어요.");
		return false;
	}
	if (!s.id) {
		new Notice("id가 없는 스킬은 실행을 요청할 수 없어요. 파일의 frontmatter id를 적어 주세요.");
		return false;
	}
	const stamp = requestStamp(new Date());
	try {
		await host.app.vault.process(f, (t) => appendRunRequest(t, s.id, stamp, today()));
	} catch (err) {
		console.error("[MyLogs] Toolbox registry write failed", err);
		new Notice("MyLogs: 등록부에 쓰지 못했어요.");
		return false;
	}
	new Notice(`「${s.name}」 실행을 요청했어요 (${stamp.replace("T", " ")}). Hermes가 처리하면 [x]로 바뀌어요.`);
	return true;
}

// ───────────────────────── 「4-1」 새 스킬 ─────────────────────────

/** Create the file from the template and add the registry row. Returns the new path, or null. */
export async function createSkill(host: ToolboxHost, input: SkillInput, id: string): Promise<string | null> {
	const { app } = host;
	const root = toolboxRoot(host);
	if (!fileAt(app, registryPath(host))) {
		// 「1」: 등록부에 없으면 돌지 않는다 — no skill file without a registry row.
		new Notice(`MyLogs: 등록부(${registryPath(host)})가 없어 스킬을 만들지 않았어요.`);
		return null;
	}
	const path = normalizePath(skillPath(root, input.name.trim()));
	if (app.vault.getAbstractFileByPath(path)) {
		new Notice(`이미 있는 파일이에요. 만들지 않았어요.\n${path}`);
		return null;
	}
	const text = fillSkillTemplate(await loadTemplate(host), input, id, new Date());
	const left = leftoverPlaceholders(text);
	if (left.length) console.warn(`[MyLogs] Toolbox template placeholders left: ${left.join(", ")}`);
	let created: TFile;
	try {
		created = await app.vault.create(path, text);
	} catch (err) {
		console.error("[MyLogs] Toolbox create failed", err);
		new Notice(`MyLogs: 스킬 파일을 만들지 못했어요 (${path}). 등록부는 바꾸지 않았어요.`);
		return null;
	}
	const { data, body } = parseFrontmatterText(text);
	const skill = parseSkill(data, body, created.path, root);
	const row = skill ? skillRowOf(skill, root) : null;
	const problem = row ? await editRegistry(host, (t) => upsertSkillRow(t, { id }, row), changeText.create(id, input.name.trim(), input)) : "파일을 다시 읽지 못했어요";
	if (problem) new Notice(`MyLogs: 스킬은 만들었지만 등록부에 올리지 못했어요 (${problem}). 화면의 「등록」으로 다시 시도할 수 있어요.`);
	else new Notice(`「${input.name.trim()}」 스킬을 만들었어요 (${id}, 멈춤). 내용을 채운 뒤 사용으로 바꿔 주세요.`);
	return created.path;
}

// ───────────────────────── 「4-2」 수정 ─────────────────────────

/** Frontmatter edit (+ file rename when the name changed), registry row, logs. */
export async function editSkill(host: ToolboxHost, s: Skill, e: SkillEdit): Promise<void> {
	const { app } = host;
	const root = toolboxRoot(host);
	const changes = skillEditChanges(s, e);
	if (!changes.length) {
		new Notice("바뀐 것이 없어요.");
		return;
	}
	const f = fileAt(app, s.path);
	if (!f) {
		new Notice(`스킬 파일을 찾지 못했어요: ${s.path}`);
		return;
	}
	const newName = e.name.trim();
	const newPath = normalizePath(skillPath(root, newName));
	if (newName !== s.name && app.vault.getAbstractFileByPath(newPath)) {
		new Notice(`같은 이름의 파일이 이미 있어요. 아무것도 바꾸지 않았어요.\n${newPath}`);
		return;
	}
	const failed: string[] = [];
	try {
		await app.vault.process(f, (t) => applySkillEdit(t, s, e, today()));
	} catch (err) {
		console.error("[MyLogs] Toolbox skill write failed", err);
		new Notice("MyLogs: 스킬 파일에 쓰지 못했어요. 아무것도 바꾸지 않았어요.");
		return;
	}
	if (newName !== s.name) {
		try {
			await app.fileManager.renameFile(f, newPath);
		} catch (err) {
			console.error("[MyLogs] Toolbox rename failed", err);
			failed.push("파일 이름");
		}
	}
	const next: Skill = { ...s, name: failed.includes("파일 이름") ? s.name : newName, trigger: e.trigger, schedule: e.trigger === "cron" ? e.schedule.trim() : "", output: e.output.trim(), notify: e.notify.trim() };
	if (registryAffected(s, e)) {
		const row = skillRowOf(next, root);
		const problem = await editRegistry(
			host,
			(t) => upsertSkillRow(t, { id: s.id, nameCell: row.nameCell, trigger: row.trigger, schedule: row.schedule, output: row.output }, row),
			changeText.edit(s.id, next.name, changes),
		);
		if (problem) failed.push(`등록부 (${problem})`);
	}
	report(failed, `「${next.name}」 수정: ${changes.join(", ")}`);
}

// ───────────────────────── registry ↔ file ─────────────────────────

/** A skill file without a registry row: add the row from the file (file = canonical). */
export async function registerSkill(host: ToolboxHost, s: Skill): Promise<void> {
	if (!s.id) {
		new Notice("id가 없는 스킬은 등록할 수 없어요. 파일의 frontmatter id를 먼저 적어 주세요.");
		return;
	}
	const row = skillRowOf(s, toolboxRoot(host));
	const problem = await editRegistry(host, (t) => upsertSkillRow(t, { id: s.id }, row), changeText.register(s.id, s.name));
	if (problem) new Notice(`MyLogs: 등록부에 올리지 못했어요 (${problem}).`);
	else new Notice(`「${s.name}」을(를) 등록부에 올렸어요.`);
}
