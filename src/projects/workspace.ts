/** Read-only workspace projections. The hub and existing links remain the source of truth. */
import { type Goal, findSectionText, parseFrontmatterText, parseSections } from "../pinboard/model.ts";
import type { Project } from "./model.ts";
import type { FlywheelElement } from "../flywheel/model.ts";

export function goalPointsToProject(g: Goal, p: Project): boolean {
	return g.projectIds.includes(p.id) || g.projects.some(link => {
		const target = link.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].split("#")[0].replace(/\.md$/, "");
		return target === p.path.replace(/\.md$/, "") || target === p.name;
	});
}
export function projectGoalLinks(p: Project, goals: Goal[]): { id: string; goal?: Goal; oneSided: boolean }[] {
	const ids = new Set([...p.goals, ...goals.filter(g => goalPointsToProject(g, p)).map(g => g.id)]);
	return [...ids].map(id => { const goal = goals.find(g => g.id === id); return { id, goal, oneSided: !!goal && (!p.goals.includes(id) || !goalPointsToProject(goal, p)) }; });
}
/**
 * Flywheel elements shown on a project: those the hub names in `flywheel` (the project came out of
 * them, AGENTS 「4-8」) and those linked to one of the project's goals. 폐기 excluded.
 */
export function sharedFlywheel(p: Project, goals: Goal[], elements: FlywheelElement[], direct: string[] = []): FlywheelElement[] {
	const ids = new Set(projectGoalLinks(p, goals).map(g => g.id));
	return elements.filter(e => e.status !== "폐기" && (direct.includes(e.id) || e.goals.some(g => ids.has(g))));
}
export function workspaceSections(text: string): { title: string; text: string }[] {
	const sections = parseSections(parseFrontmatterText(text).body);
	return ["성공 기준", "현재 상태", "다음 액션", "막힌 점", "목표", "비목표", "주요 결정"].map(title => ({ title, text: findSectionText(sections, title).trim() }));
}
export interface WorkspaceFile { path: string; label: string }
export function workspaceFiles(paths: string[], folder: string, relative: string): WorkspaceFile[] {
	const prefix = `${folder}/${relative}/`;
	return paths.filter(p => p.startsWith(prefix) && !p.slice(prefix.length).split("/").some(s => s.startsWith(".")))
		.sort((a, b) => a.localeCompare(b, "ko"))
		.map(path => ({ path, label: path.slice(prefix.length) }));
}
