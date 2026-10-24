/**
 * Project 수정 / 삭제 as a plan of pure text transforms and file moves
 * (`05 Project Folders/AGENTS.md` 「3-4. 작업 기록」, 「4. 등록부 형식」, 「6. 허브 형식」):
 *
 * - hub: `title`, `scope`, `area`, `kind`, `goals`, `updated`, the H1, 「한 문장 설명」,
 *   「지금 가장 효과적인 한 가지 행동」 (checkbox state kept);
 * - a new name or 개인/회사 moves the folder (`<root>/<개인|회사>/<프로젝트명>/`) and renames the
 *   files named after the project (hub, log index, monthly logs). Past monthly-log *contents* are
 *   not rewritten (「8. 금지」: 과거 로그를 다시 쓰지 않는다); the current-state files (AGENTS.md,
 *   log index) follow the new name;
 * - registry row (이름, 별칭, 개인/회사, area, 유형, 행동, 목표, 경로, 갱신) and 「변경 기록」;
 * - the 「3-4」 record: monthly log entry, log index 최근 작업.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { splitLinesKeepEol, stripEol } from "../parser.ts";
import { appendToSection, getSectionContent, replaceSectionContent } from "../writer.ts";
import { ACTION_SECTION, AI_DRAFT, DECISIONS_SECTION, LOG_DIR, logIndexPath, type Project, type Scope, SUMMARY_SECTION, WORK_DIR, hubPath } from "./model.ts";
import { type ActiveRow, getFmList, getFmValue, type LogEntry, PLUGIN_MARK, setFmList, setFmValue, yamlScalar } from "./ops.ts";

export const GOAL_ID_RE = /^G-\d{4}-\d{2}(?:\.\d+)?$/;

/** What the 수정 dialog returns. */
export interface ProjectEdit {
	name: string;
	aliases: string;
	summary: string;
	scope: Scope;
	area: string;
	kind: string;
	action: string;
	/** Comma-separated Sub Goal ids. */
	goals: string;
}

export function parseGoalIds(s: string): string[] {
	return [
		...new Set(
			s
				.split(/[,\s]+/)
				.map((x) => x.trim())
				.filter(Boolean),
		),
	];
}

export function goalIdProblems(ids: string[], known: string[] | null): string[] {
	const out: string[] = [];
	for (const id of ids) {
		if (!GOAL_ID_RE.test(id)) out.push(`목표 id 형식이 아니에요: ${id} (예: G-2026-03.1)`);
		else if (known && !known.includes(id)) out.push(`Pinboard에 없는 목표 id예요: ${id}`);
	}
	return out;
}

function oneLine(s: string): string {
	return s.replace(/\s*\r?\n\s*/g, " ").trim();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Inside the current-state files (hub, project AGENTS.md, log index): the project name where it
 * names a file or the project — `[[name]]`, `[[name|`, `name 로그`, `name.md`, `"name"`, the H1.
 */
export function renameInProjectText(text: string, oldName: string, newName: string): string {
	if (oldName === newName) return text;
	const re = new RegExp(`(^|[\\s"'\`/\\[])${esc(oldName)}(?=( 로그| 운영 계약|\\.md|\\]\\]|\\||#|"|'|\\s*$))`, "gm");
	return text.replace(re, (_m, pre: string) => `${pre}${newName}`);
}

/** The first item of 「지금 가장 효과적인 한 가지 행동」 with a new text; checkbox state kept. */
export function setActionText(text: string, action: string): string {
	const cur = getSectionContent(text, ACTION_SECTION);
	const a = oneLine(action) || "미확인";
	if (cur === null) return replaceSectionContent(text, ACTION_SECTION, `- [ ] ${a}`);
	const lines = cur.split("\n");
	const i = lines.findIndex((l) => /^\s*[-*+]\s/.test(l));
	if (i === -1) return replaceSectionContent(text, ACTION_SECTION, [`- [ ] ${a}`, ...lines.filter((l) => l.trim())].join("\n"));
	const m = /^(\s*[-*+]\s+(?:\[[ xX]\]\s*)?)/.exec(lines[i])!;
	lines[i] = `${m[1]}${a}`;
	return replaceSectionContent(text, ACTION_SECTION, lines.join("\n"));
}

/** The action as written (with `(AI 초안)` when it is still a draft). */
export function actionAsWritten(p: Pick<Project, "action" | "actionDraft">): string {
	return p.action ? (p.actionDraft ? `${p.action} ${AI_DRAFT}` : p.action) : "";
}

export interface HubEdit {
	today: string;
	title?: string;
	scope?: string;
	area?: string;
	kind?: string;
	summary?: string;
	/** The action exactly as it should be written (a user edit drops `(AI 초안)`). */
	action?: string;
	goals?: string[];
	/** A 「주요 결정」 line (without date). */
	decision?: string;
	/** Old title for the H1. */
	oldTitle?: string;
}

/** Hub fields in place (「6. 허브 형식」); `updated` always set. */
export function applyHubEdit(text: string, e: HubEdit): string {
	let out = text;
	const fm: [keyof HubEdit, string][] = [
		["title", "title"],
		["scope", "scope"],
		["area", "area"],
		["kind", "kind"],
	];
	for (const [k, key] of fm) {
		const v = e[k] as string | undefined;
		if (v !== undefined && v.trim() !== getFmValue(out, key)) out = setFmValue(out, key, yamlScalar(v));
	}
	if (e.goals !== undefined) out = setFmList(out, "goals", e.goals);
	if (e.title !== undefined && e.oldTitle && e.title.trim() !== e.oldTitle) {
		const lines = splitLinesKeepEol(out);
		const i = lines.findIndex((l) => stripEol(l).trim() === `# ${e.oldTitle}`);
		if (i !== -1) {
			lines[i] = `# ${e.title.trim()}` + lines[i].slice(stripEol(lines[i]).length);
			out = lines.join("");
		}
	}
	if (e.summary !== undefined && oneLine(e.summary) !== oneLine(getSectionContent(out, SUMMARY_SECTION) ?? "")) out = replaceSectionContent(out, SUMMARY_SECTION, oneLine(e.summary));
	if (e.action !== undefined) out = setActionText(out, e.action);
	if (e.decision) out = appendToSection(out, DECISIONS_SECTION, `- ${e.today} — ${oneLine(e.decision)}`);
	return setFmValue(out, "updated", e.today);
}

export interface Rename {
	from: string;
	to: string;
}

export interface ProjectEditPlan {
	/** Folder move (scope or name changed), done first. */
	folder: Rename | null;
	/** Files inside the (new) folder named after the project. `from` paths are after the folder move. */
	files: Rename[];
	newFolder: string;
	newName: string;
	hub: HubEdit;
	registry: Partial<ActiveRow> & { id: string };
	goalsAdded: string[];
	goalsRemoved: string[];
	/** Hub wikilink target (no `.md`) before / after, for Sub Goals' `projects`. */
	hubLinkOld: string;
	hubLinkNew: string;
	/** What changed, for the logs. Empty when nothing did. */
	changes: string[];
	entry: LogEntry;
	recent: string;
	change: string;
}

/**
 * Plan a 수정. `monthlyLogs` = names of the files in `99 작업실/로그/` (to rename them with the
 * project); `registryAliases` = the current 별칭 cell.
 */
export function planProjectEdit(
	p: Project,
	e: ProjectEdit,
	o: { activeRoot: string; today: string; registryAliases: string; monthlyLogs: string[] },
): ProjectEditPlan {
	const name = e.name.trim();
	const root = o.activeRoot.replace(/^\/+|\/+$/g, "");
	const newFolder = `${root}/${e.scope}/${name}`;
	const moved = newFolder !== p.folder;
	const renamed = name !== p.name;
	const goals = parseGoalIds(e.goals);
	const aliases = e.aliases
		.split(",")
		.map((a) => a.trim())
		.filter(Boolean)
		.join(", ");
	const oldAction = actionAsWritten(p);
	// A user edit of the action makes it the user's (no `(AI 초안)`).
	const action = oneLine(e.action) === p.action ? oldAction : oneLine(e.action);
	const changes: string[] = [];
	if (renamed || name !== p.title) changes.push(`이름 「${p.title}」 → 「${name}」`);
	if (aliases !== o.registryAliases.trim()) changes.push(`별칭 ${o.registryAliases.trim() || "—"} → ${aliases || "—"}`);
	if (oneLine(e.summary) !== p.summary) changes.push("한 문장 설명");
	if (e.scope !== p.scope) changes.push(`${p.scope} → ${e.scope}`);
	if (e.area.trim() !== p.area) changes.push(`area ${p.area || "—"} → ${e.area.trim()}`);
	if (e.kind !== p.kind) changes.push(`유형 ${p.kind || "—"} → ${e.kind}`);
	if (action !== oldAction) changes.push("지금 가장 효과적인 한 가지 행동");
	const goalsAdded = goals.filter((g) => !p.goals.includes(g));
	const goalsRemoved = p.goals.filter((g) => !goals.includes(g));
	if (goalsAdded.length || goalsRemoved.length) changes.push(`목표 ${p.goals.join(", ") || "—"} → ${goals.join(", ") || "—"}`);

	const files: Rename[] = [];
	if (renamed) {
		files.push({ from: hubPath(newFolder, p.name), to: hubPath(newFolder, name) });
		files.push({ from: logIndexPath(newFolder, p.name), to: logIndexPath(newFolder, name) });
		const prefix = `${p.name} 로그 `;
		for (const f of o.monthlyLogs) {
			if (!f.startsWith(prefix) || !f.endsWith(".md")) continue;
			files.push({ from: `${newFolder}/${WORK_DIR}/${LOG_DIR}/${f}`, to: `${newFolder}/${WORK_DIR}/${LOG_DIR}/${name} 로그 ${f.slice(prefix.length)}` });
		}
	}
	const decisions: string[] = [];
	if (renamed) decisions.push(`프로젝트 이름을 「${name}」(으)로 바꾼다`);
	if (e.scope !== p.scope) decisions.push(`${e.scope} 프로젝트로 옮긴다 (${newFolder})`);
	const summary = changes.join(", ");
	return {
		folder: moved ? { from: p.folder, to: newFolder } : null,
		files,
		newFolder,
		newName: name,
		hub: {
			today: o.today,
			title: name,
			oldTitle: p.title,
			scope: e.scope,
			area: e.area.trim(),
			kind: e.kind,
			summary: e.summary,
			action: action !== oldAction ? action : undefined,
			goals: goalsAdded.length || goalsRemoved.length ? goals : undefined,
			decision: decisions.length ? `${decisions.join(". ")}. 사용자 결정` : undefined,
		},
		registry: {
			id: p.id,
			name,
			aliases,
			scope: e.scope,
			area: e.area.trim(),
			kind: e.kind,
			action: action || "미확인",
			goals: goals.join(", "),
			path: newFolder,
			updated: o.today,
		},
		goalsAdded,
		goalsRemoved,
		hubLinkOld: `${p.folder}/${p.name}`,
		hubLinkNew: `${newFolder}/${name}`,
		changes,
		entry: {
			date: o.today,
			title: "프로젝트 정보 수정",
			context: "MyLogs Project Folders 화면에서 사용자가 프로젝트 정보를 고침",
			done: summary,
			result: moved ? `경로: ${newFolder}` : `status: ${p.status}`,
			decision: decisions.length ? `${decisions.join(". ")}. 사용자 결정` : "없음",
			open: "없음",
			next: action || "미확인",
			evidence: "MyLogs 플러그인, 사용자 조작",
		},
		recent: `프로젝트 정보 수정: ${summary}`,
		change: `${p.id} 수정: ${summary}${moved ? `, 경로 ${newFolder}` : ""} ${PLUGIN_MARK}`,
	};
}

/** The 「3-4」 texts when goal ids leave a project because the goals were deleted in Pinboard. */
export function goalUnlinkTexts(p: Project, removed: string[], today: string): { entry: LogEntry; recent: string; change: string } {
	const list = removed.join(", ");
	return {
		entry: {
			date: today,
			title: "목표 연결 해제",
			context: `Pinboard에서 목표 ${list}를 삭제함`,
			done: `허브 goals에서 ${list} 제거`,
			result: `goals: ${p.goals.filter((g) => !removed.includes(g)).join(", ") || "없음"}`,
			decision: "없음",
			open: "없음",
			next: actionAsWritten(p) || "미확인",
			evidence: "MyLogs 플러그인, 사용자 조작",
		},
		recent: `목표 연결 해제: ${list}`,
		change: `${p.id} 목표 ${list} 연결 해제 (목표 삭제) ${PLUGIN_MARK}`,
	};
}

/** Remove the row of `id` from both registry tables. */
export function removeRegistryRow(text: string, id: string): { text: string; removed: boolean } {
	const lines = splitLinesKeepEol(text);
	let removed = false;
	for (let i = lines.length - 1; i >= 0; i--) {
		const s = stripEol(lines[i]);
		if (!/^\s*\|/.test(s)) continue;
		const cells = s.split(/(?<!\\)\|/).map((c) => c.trim());
		if (cells[1] === id) {
			lines.splice(i, 1);
			removed = true;
		}
	}
	return { text: lines.join(""), removed };
}

/** Hub goals without the given ids (for the Pinboard → project unlink). */
export function hubWithoutGoals(text: string, ids: string[], today: string): string {
	const cur = getFmList(text, "goals");
	const next = cur.filter((g) => !ids.includes(g));
	if (next.length === cur.length) return text;
	return setFmValue(setFmList(text, "goals", next), "updated", today);
}
