/**
 * Project Folders vault operations: the 「3-4」 / 「3-5」 / 「3-2」 procedures of
 * `05 Project Folders/AGENTS.md`, executed with the pure transforms of `ops.ts` / `create.ts`.
 * Each file is changed with `vault.process` (atomic read-modify-write).
 */

import { type App, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { toIsoDate } from "../parser.ts";
import { cleanFolder, type MyLogsSettings } from "../settings.ts";
import { planNewProject, TEMPLATE_FILES, type TemplateKey, type Templates } from "./create.ts";
import type { CompleteAnswer } from "./modals.ts";
import { archiveFolder, hubLocation, hubPath, LOG_DIR, logIndexPath, monthlyLogPath, type NewProjectInput, parseProject, type Project, WORK_DIR } from "./model.ts";
import { goalUnlinkTexts, hubWithoutGoals, planProjectEdit, type ProjectEdit, removeRegistryRow, renameInProjectText, applyHubEdit } from "./edit.ts";
import { linkProject, unlinkProject } from "../pinboard/goal-edit.ts";
import { INDEX_FILE as PINBOARD_INDEX, prependChangeLog } from "../pinboard/index-writer.ts";
import { valueToString } from "../pinboard/model.ts";
import { setFrontmatterScalar } from "../writer.ts";
import type { LogEntry } from "./ops.ts";
import {
	activeRowOf,
	appendLogEntry,
	applyHubChange,
	formatLogEntry,
	logRegistryChange,
	moveRowToDone,
	newLogIndex,
	newMonthlyLog,
	parseRegistry,
	PLUGIN_MARK,
	REGISTRY_FILE,
	type RegistryResult,
	statusChangeTexts,
	TEMPLATE_DIR,
	updateLogIndex,
	updateProjectAgents,
	upsertActiveRow,
} from "./ops.ts";
import { DEFAULT_TEMPLATES } from "./templates.ts";

export interface ProjectsHost {
	app: App;
	settings: MyLogsSettings;
}

export function activeRoot(host: ProjectsHost): string {
	return cleanFolder(host.settings.projectFoldersFolder);
}
export function archiveRoot(host: ProjectsHost): string {
	return cleanFolder(host.settings.projectArchiveFolder);
}
export function registryPath(host: ProjectsHost): string {
	return normalizePath(`${activeRoot(host)}/${WORK_DIR}/${REGISTRY_FILE}`);
}

function fileAt(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = normalizePath(path).split("/");
	for (let i = 1; i <= parts.length; i++) {
		const p = parts.slice(0, i).join("/");
		if (app.vault.getAbstractFileByPath(p)) continue;
		try {
			await app.vault.createFolder(p);
		} catch {
			// created concurrently
		}
	}
}

/** Templates from `<root>/99 작업실/템플릿/`, falling back to the built-in copies. */
export async function loadTemplates(host: ProjectsHost): Promise<Templates> {
	const out = { ...DEFAULT_TEMPLATES };
	for (const k of Object.keys(TEMPLATE_FILES) as TemplateKey[]) {
		const f = fileAt(host.app, `${activeRoot(host)}/${WORK_DIR}/${TEMPLATE_DIR}/${TEMPLATE_FILES[k]}`);
		if (f) out[k] = await host.app.vault.read(f);
		else console.warn(`[MyLogs] template ${TEMPLATE_FILES[k]} not found; using the built-in copy`);
	}
	return out;
}

/** Registry ids/names plus projects on disk (「3-2」 1: duplicates are reported, not created). */
export async function takenIdsAndNames(host: ProjectsHost, projects: Project[]): Promise<{ ids: string[]; names: string[] }> {
	const ids = new Set(projects.map((p) => p.id).filter(Boolean));
	const names = new Set(projects.flatMap((p) => [p.name, p.title]));
	const reg = fileAt(host.app, registryPath(host));
	if (reg) {
		const r = parseRegistry(await host.app.vault.cachedRead(reg));
		for (const row of [...r.active, ...r.done]) {
			if (row.id) ids.add(row.id);
			if (row.name) names.add(row.name);
		}
	}
	return { ids: [...ids], names: [...names] };
}

async function editRegistry(host: ProjectsHost, edit: (text: string) => RegistryResult, change: string, today: string): Promise<string | null> {
	const f = fileAt(host.app, registryPath(host));
	if (!f) return `${REGISTRY_FILE}을 찾지 못했어요`;
	let problem: string | null = null;
	await host.app.vault.process(f, (text) => {
		const r = edit(text);
		if (!r.ok) {
			problem = r.reason;
			return text;
		}
		return logRegistryChange(r.text, today, change);
	});
	return problem;
}

interface RecordOpts {
	review?: boolean;
	complete?: CompleteAnswer;
}

/**
 * 「3-4」 1–3 inside the project folder: monthly log entry, hub, log index (+ project AGENTS.md
 * `latest_log`). Returns the names of the files that failed.
 */
async function writeProjectRecord(host: ProjectsHost, p: Project, to: string, today: string, o: RecordOpts, templates: Templates): Promise<string[]> {
	const { app } = host;
	const failed: string[] = [];
	const ym = today.slice(0, 7);
	const t = statusChangeTexts(p, to, today, { result: o.complete?.result, review: o.review });
	const entry = formatLogEntry(t.entry);
	const step = async (label: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (err) {
			console.error(`[MyLogs] Project Folders: ${label} failed`, err);
			failed.push(label);
		}
	};

	await step("월별 로그", async () => {
		const path = normalizePath(monthlyLogPath(p.folder, p.name, ym));
		const f = fileAt(app, path);
		if (f) await app.vault.process(f, (text) => appendLogEntry(text, entry));
		else {
			await ensureFolder(app, path.slice(0, path.lastIndexOf("/")));
			await app.vault.create(path, newMonthlyLog(templates.monthlyLog, p.name, ym, entry));
		}
	});
	await step("허브", async () => {
		const f = fileAt(app, p.path);
		if (!f) throw new Error("hub not found");
		await app.vault.process(f, (text) =>
			applyHubChange(text, {
				today,
				status: to,
				decision: t.decision,
				...(o.complete ? { completed: o.complete.completed, result: o.complete.result, started: p.started ? undefined : o.complete.started } : {}),
			}),
		);
	});
	await step("로그 인덱스", async () => {
		const path = normalizePath(logIndexPath(p.folder, p.name));
		const f = fileAt(app, path);
		const args = { name: p.name, ym, today, recent: t.recent };
		if (f) await app.vault.process(f, (text) => updateLogIndex(text, args));
		else await app.vault.create(path, newLogIndex(templates.logIndex, args));
	});
	await step("프로젝트 AGENTS.md", async () => {
		const f = fileAt(app, `${p.folder}/AGENTS.md`);
		if (f) await app.vault.process(f, (text) => updateProjectAgents(text, { name: p.name, ym, today }));
	});
	return failed;
}

function report(failed: string[], ok: string): void {
	if (failed.length) new Notice(`MyLogs: ${failed.join(", ")} 갱신에 실패했어요. 나머지는 저장됐어요.`);
	else new Notice(ok);
}

/** 「3-5」 상태 바꾸기 (not 완료) and the "계속" review answer: 「3-4」 1–4. */
export async function changeStatus(host: ProjectsHost, p: Project, to: string, o: { review?: boolean } = {}): Promise<void> {
	if (p.archived) {
		new Notice("완료되어 Archive Box에 보관된 프로젝트는 여기서 바꾸지 않아요.");
		return;
	}
	const today = toIsoDate(new Date());
	const templates = await loadTemplates(host);
	const failed = await writeProjectRecord(host, p, to, today, o, templates);
	const t = statusChangeTexts(p, to, today, o);
	const next: Project = { ...p, status: to, updated: today, started: p.started || (to === "진행" ? today : "") };
	const full = activeRowOf(next);
	const problem = await editRegistry(
		host,
		(text) => upsertActiveRow(text, { id: p.id, name: next.title, status: to, action: full.action, path: p.folder, updated: today }, full),
		t.change,
		today,
	).catch((err) => {
		console.error("[MyLogs] Project Folders registry update failed", err);
		return "등록부 갱신 실패";
	});
	if (problem) failed.push(`등록부 (${problem})`);
	report(failed, p.status === to ? `「${p.title}」 계속 진행으로 기록했어요.` : `「${p.title}」 ${p.status} → ${to}`);
}

/** 「3-5」 완료: record, move the folder to the Archive Box, move the registry row to 「완료」. */
export async function completeProject(host: ProjectsHost, p: Project, ans: CompleteAnswer): Promise<void> {
	const { app } = host;
	if (p.archived) return;
	const target = normalizePath(archiveFolder(archiveRoot(host), p.scope, p.name));
	if (app.vault.getAbstractFileByPath(target)) {
		new Notice(`보관 위치에 같은 이름의 폴더가 이미 있어요. 아무것도 바꾸지 않았어요.\n${target}`);
		return;
	}
	const folder = app.vault.getAbstractFileByPath(normalizePath(p.folder));
	if (!(folder instanceof TFolder)) {
		new Notice(`프로젝트 폴더를 찾지 못했어요: ${p.folder}`);
		return;
	}
	const today = toIsoDate(new Date());
	const templates = await loadTemplates(host);
	// Write before moving: archived originals are not edited (10 Archive Box/AGENTS.md 「5. 금지」).
	const failed = await writeProjectRecord(host, p, "완료", today, { complete: ans }, templates);
	try {
		await ensureFolder(app, target.slice(0, target.lastIndexOf("/")));
		await app.fileManager.renameFile(folder, target);
	} catch (err) {
		console.error("[MyLogs] Project Folders: move to archive failed", err);
		new Notice(`MyLogs: 폴더를 Archive Box로 옮기지 못했어요. 허브는 완료로 기록됐어요. 등록부는 바꾸지 않았어요.`);
		return;
	}
	const t = statusChangeTexts(p, "완료", today, { result: ans.result });
	const problem = await editRegistry(
		host,
		(text) =>
			moveRowToDone(text, {
				id: p.id,
				name: p.title,
				scope: p.scope,
				started: p.started || ans.started,
				completed: ans.completed,
				result: ans.result,
				path: target,
			}),
		t.change,
		today,
	).catch((err) => {
		console.error("[MyLogs] Project Folders registry update failed", err);
		return "등록부 갱신 실패";
	});
	if (problem) failed.push(`등록부 (${problem})`);
	report(failed, `「${p.title}」 완료. ${target}로 옮겼어요.`);
}

/** 「3-2」 새 프로젝트 만들기. Returns the hub path, or null when nothing was created. */
export async function createProject(host: ProjectsHost, input: NewProjectInput): Promise<string | null> {
	const { app } = host;
	const reg = fileAt(app, registryPath(host));
	// 「8. 금지」: no project folder without a registry row.
	if (!reg) {
		new Notice(`MyLogs: 등록부(${registryPath(host)})가 없어 프로젝트를 만들지 않았어요.`);
		return null;
	}
	const today = toIsoDate(new Date());
	const plan = planNewProject(input, await loadTemplates(host), { activeRoot: activeRoot(host), today });
	if (app.vault.getAbstractFileByPath(normalizePath(plan.folder))) {
		new Notice(`이미 있는 폴더예요. 만들지 않았어요.\n${plan.folder}`);
		return null;
	}
	try {
		for (const f of plan.folders) await ensureFolder(app, f);
		for (const f of plan.files) await app.vault.create(normalizePath(f.path), f.content);
	} catch (err) {
		console.error("[MyLogs] Project Folders: create failed", err);
		new Notice(`MyLogs: 프로젝트 파일을 만들지 못했어요 (${plan.folder}). 등록부는 바꾸지 않았어요.`);
		return null;
	}
	const problem = await editRegistry(host, (text) => upsertActiveRow(text, { id: plan.id }, plan.row), plan.change, today).catch((err) => {
		console.error("[MyLogs] Project Folders registry update failed", err);
		return "등록부 갱신 실패";
	});
	if (problem) new Notice(`MyLogs: 프로젝트는 만들었지만 등록부에 올리지 못했어요 (${problem}). 등록부에 행을 추가해 주세요.`);
	else new Notice(`「${plan.name}」 프로젝트를 만들었어요.`);
	return hubPath(plan.folder, plan.name);
}

// ───────────────────────── 수정 / 삭제 ─────────────────────────

/** 「3-4」 1, 3 (+ AGENTS.md `latest_log`) for any entry. Returns the names of the files that failed. */
async function writeRecord(host: ProjectsHost, folder: string, name: string, entry: LogEntry, recent: string, today: string, templates: Templates): Promise<string[]> {
	const { app } = host;
	const failed: string[] = [];
	const ym = today.slice(0, 7);
	const text = formatLogEntry(entry);
	const step = async (label: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (err) {
			console.error(`[MyLogs] Project Folders: ${label} failed`, err);
			failed.push(label);
		}
	};
	await step("월별 로그", async () => {
		const path = normalizePath(monthlyLogPath(folder, name, ym));
		const f = fileAt(app, path);
		if (f) await app.vault.process(f, (t) => appendLogEntry(t, text));
		else {
			await ensureFolder(app, path.slice(0, path.lastIndexOf("/")));
			await app.vault.create(path, newMonthlyLog(templates.monthlyLog, name, ym, text));
		}
	});
	await step("로그 인덱스", async () => {
		const path = normalizePath(logIndexPath(folder, name));
		const f = fileAt(app, path);
		const args = { name, ym, today, recent };
		if (f) await app.vault.process(f, (t) => updateLogIndex(t, args));
		else await app.vault.create(path, newLogIndex(templates.logIndex, args));
	});
	await step("프로젝트 AGENTS.md", async () => {
		const f = fileAt(app, `${folder}/AGENTS.md`);
		if (f) await app.vault.process(f, (t) => updateProjectAgents(t, { name, ym, today }));
	});
	return failed;
}

/** Sub Goal note files of the given ids (Pinboard, any year). */
function goalFiles(host: ProjectsHost, ids: string[]): Map<string, TFile> {
	const root = cleanFolder(host.settings.pinboardFolder);
	const out = new Map<string, TFile>();
	if (!ids.length) return out;
	for (const f of host.app.vault.getMarkdownFiles()) {
		if (!f.path.startsWith(`${root}/`)) continue;
		const id = valueToString(host.app.metadataCache.getFileCache(f)?.frontmatter?.id);
		if (ids.includes(id)) out.set(id, f);
	}
	return out;
}

/** `Pinboard Index.md`: 변경 기록 + `updated` (Pinboard 「8. 인덱스 규칙」 3–4). */
async function logPinboard(host: ProjectsHost, entry: string, today: string): Promise<void> {
	const f = fileAt(host.app, `${cleanFolder(host.settings.pinboardFolder)}/${PINBOARD_INDEX}`);
	if (!f) return;
	await host.app.vault.process(f, (t) => setFrontmatterScalar(prependChangeLog(t, today, entry), "updated", today));
}

/** The 별칭 cell of a project's registry row. */
async function registryAliases(host: ProjectsHost, id: string): Promise<string> {
	const reg = fileAt(host.app, registryPath(host));
	if (!reg) return "";
	return parseRegistry(await host.app.vault.read(reg)).active.find((r) => r.id === id)?.aliases ?? "";
}

export async function aliasesOf(host: ProjectsHost, p: Project): Promise<string> {
	return registryAliases(host, p.id);
}

/**
 * 수정: hub, folder / file names (개인↔회사, 이름), registry row, the 「3-4」 record, and the Pinboard
 * side of goal links (Pinboard 「3-6」: Sub Goal `projects` / `project_ids`).
 */
export async function editProject(host: ProjectsHost, p: Project, e: ProjectEdit): Promise<void> {
	const { app } = host;
	if (p.archived) {
		new Notice("완료되어 Archive Box에 보관된 프로젝트는 여기서 바꾸지 않아요.");
		return;
	}
	const today = toIsoDate(new Date());
	const logDir = app.vault.getAbstractFileByPath(normalizePath(`${p.folder}/${WORK_DIR}/${LOG_DIR}`));
	const monthlyLogs = logDir instanceof TFolder ? logDir.children.filter((c) => c instanceof TFile).map((c) => c.name) : [];
	const plan = planProjectEdit(p, e, { activeRoot: activeRoot(host), today, registryAliases: await registryAliases(host, p.id), monthlyLogs });
	if (!plan.changes.length) {
		new Notice("바뀐 것이 없어요.");
		return;
	}
	const failed: string[] = [];
	if (plan.folder) {
		const target = normalizePath(plan.folder.to);
		const folder = app.vault.getAbstractFileByPath(normalizePath(plan.folder.from));
		if (app.vault.getAbstractFileByPath(target)) {
			new Notice(`같은 이름의 프로젝트 폴더가 이미 있어요. 아무것도 바꾸지 않았어요.\n${target}`);
			return;
		}
		if (!(folder instanceof TFolder)) {
			new Notice(`프로젝트 폴더를 찾지 못했어요: ${p.folder}`);
			return;
		}
		try {
			await ensureFolder(app, target.slice(0, target.lastIndexOf("/")));
			await app.fileManager.renameFile(folder, target);
		} catch (err) {
			console.error("[MyLogs] Project Folders: folder move failed", err);
			new Notice("MyLogs: 프로젝트 폴더를 옮기지 못했어요. 아무것도 바꾸지 않았어요.");
			return;
		}
	}
	for (const r of plan.files) {
		const f = fileAt(app, r.from);
		if (!f || app.vault.getAbstractFileByPath(normalizePath(r.to))) continue;
		try {
			await app.fileManager.renameFile(f, normalizePath(r.to));
		} catch (err) {
			console.error("[MyLogs] Project Folders: rename failed", err);
			failed.push(r.from.split("/").pop()!);
		}
	}
	const hub = fileAt(app, hubPath(plan.newFolder, plan.newName)) ?? fileAt(app, hubPath(plan.newFolder, p.name));
	if (hub) await app.vault.process(hub, (t) => applyHubEdit(t, plan.hub)).catch(() => failed.push("허브"));
	else failed.push("허브");
	if (plan.newName !== p.name) {
		for (const path of [`${plan.newFolder}/AGENTS.md`, logIndexPath(plan.newFolder, plan.newName)]) {
			const f = fileAt(app, path);
			if (f) await app.vault.process(f, (t) => renameInProjectText(t, p.name, plan.newName)).catch(() => failed.push(path.split("/").pop()!));
		}
	}
	failed.push(...(await writeRecord(host, plan.newFolder, plan.newName, plan.entry, plan.recent, today, await loadTemplates(host))));
	const problem = await editRegistry(host, (t) => upsertActiveRow(t, plan.registry), plan.change, today).catch((err) => {
		console.error("[MyLogs] Project Folders registry update failed", err);
		return "등록부 갱신 실패";
	});
	if (problem) failed.push(`등록부 (${problem})`);
	// Pinboard side of the goal links.
	const relink = plan.hubLinkOld !== plan.hubLinkNew ? p.goals.filter((g) => !plan.goalsRemoved.includes(g)) : [];
	const touched = [...plan.goalsAdded, ...plan.goalsRemoved, ...relink];
	if (touched.length) {
		const files = goalFiles(host, touched);
		for (const id of touched) {
			const f = files.get(id);
			if (!f) continue;
			await app.vault
				.process(f, (t) => {
					let out = t;
					if (plan.goalsRemoved.includes(id) || relink.includes(id)) out = unlinkProject(out, p.id, p.name, today);
					if (plan.goalsAdded.includes(id) || relink.includes(id)) out = linkProject(out, p.id, `[[${plan.hubLinkNew}]]`, today);
					return out;
				})
				.catch(() => failed.push(id));
		}
		const parts = [];
		if (plan.goalsAdded.length) parts.push(`${plan.goalsAdded.join(", ")} ↔ ${p.id} 연결`);
		if (plan.goalsRemoved.length) parts.push(`${plan.goalsRemoved.join(", ")} ↔ ${p.id} 연결 해제`);
		if (relink.length) parts.push(`${relink.join(", ")}의 프로젝트 링크를 ${plan.hubLinkNew}로`);
		await logPinboard(host, `${parts.join(", ")} (플러그인)`, today).catch(() => failed.push(PINBOARD_INDEX));
	}
	report(failed, `「${plan.newName}」 수정: ${plan.changes.join(", ")}`);
}

/**
 * 삭제: the project folder goes to the trash (recoverable), its registry row is removed, and the
 * Pinboard Sub Goals that pointed at it drop the link (Pinboard 「10. 연결 규칙」).
 */
export async function deleteProject(host: ProjectsHost, p: Project): Promise<void> {
	const { app } = host;
	const folder = app.vault.getAbstractFileByPath(normalizePath(p.folder));
	if (!(folder instanceof TFolder)) {
		new Notice(`프로젝트 폴더를 찾지 못했어요: ${p.folder}`);
		return;
	}
	const today = toIsoDate(new Date());
	try {
		await app.vault.trash(folder, true);
	} catch (err) {
		console.error("[MyLogs] Project Folders: trash failed", err);
		new Notice("MyLogs: 프로젝트 폴더를 휴지통으로 옮기지 못했어요. 등록부는 바꾸지 않았어요.");
		return;
	}
	const failed: string[] = [];
	const problem = await editRegistry(
		host,
		(t) => {
			const r = removeRegistryRow(t, p.id);
			return { ok: true, text: r.text, added: false };
		},
		`${p.id} 「${p.title}」 삭제 (폴더는 휴지통으로) ${PLUGIN_MARK}`,
		today,
	).catch(() => "등록부 갱신 실패");
	if (problem) failed.push(`등록부 (${problem})`);
	if (p.goals.length) {
		const files = goalFiles(host, p.goals);
		for (const [id, f] of files) await app.vault.process(f, (t) => unlinkProject(t, p.id, p.name, today)).catch(() => failed.push(id));
		await logPinboard(host, `${[...files.keys()].join(", ")}에서 프로젝트 ${p.id} 연결 해제 (프로젝트 삭제) (플러그인)`, today).catch(() => failed.push(PINBOARD_INDEX));
	}
	report(failed, `「${p.title}」 폴더를 휴지통으로 옮기고 등록부에서 지웠어요.`);
}

/** Pinboard goals were deleted: remove their ids from the hubs that list them (「3-4」 record each). */
export async function removeGoalsFromProjects(host: ProjectsHost, ids: string[]): Promise<void> {
	const { app } = host;
	const act = activeRoot(host);
	const arc = archiveRoot(host);
	const today = toIsoDate(new Date());
	const templates = await loadTemplates(host);
	for (const f of app.vault.getMarkdownFiles()) {
		const loc = hubLocation(f.path, act, arc);
		if (!loc || loc.archived) continue;
		const cache = app.metadataCache.getFileCache(f);
		if (valueToString(cache?.frontmatter?.type) !== "project") continue;
		const text = await app.vault.read(f);
		const p = parseProject(cache?.frontmatter, text.slice(cache?.frontmatterPosition?.end.offset ?? 0), loc, f.path);
		const removed = p ? p.goals.filter((g) => ids.includes(g)) : [];
		if (!p || !removed.length) continue;
		await app.vault.process(f, (t) => hubWithoutGoals(t, removed, today));
		const t = goalUnlinkTexts(p, removed, today);
		const failed = await writeRecord(host, p.folder, p.name, t.entry, t.recent, today, templates);
		const goals = p.goals.filter((g) => !removed.includes(g)).join(", ");
		await editRegistry(host, (x) => upsertActiveRow(x, { id: p.id, goals, updated: today }), t.change, today).catch(() => failed.push("등록부"));
		if (failed.length) new Notice(`MyLogs: ${p.title}의 ${failed.join(", ")} 갱신에 실패했어요.`);
	}
}
