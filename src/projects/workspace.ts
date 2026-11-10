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

/** A folder under one workspace section (`01 초안` · `02 산출물` · `99 작업실`). */
export interface WorkspaceFolder {
	name: string;
	/** Path relative to the section root, e.g. `인터뷰 질문지` or `10 자료/사진`. */
	path: string;
	/** Every file under this folder, nested ones included. */
	fileCount: number;
	folders: WorkspaceFolder[];
	/** Files directly in this folder; `label` stays relative to the section root. */
	files: WorkspaceFile[];
}
export interface WorkspaceTree { files: WorkspaceFile[]; folders: WorkspaceFolder[] }

const folderOrder = (a: WorkspaceFolder, b: WorkspaceFolder) => a.name.localeCompare(b.name, "ko", { numeric: true, sensitivity: "base" });

/**
 * Nest the flat section files into folders. Root files keep their input order and come first;
 * folders follow in natural order (`10 자료` before `40 회의`). Folders exist only because a file
 * sits under them, so empty folders never appear.
 */
export function workspaceTree(files: WorkspaceFile[]): WorkspaceTree {
	const root: WorkspaceTree = { files: [], folders: [] };
	const index = new Map<string, WorkspaceFolder>();
	for (const f of files) {
		const parts = f.label.split("/").filter(Boolean);
		if (parts.length <= 1) { root.files.push(f); continue; }
		let siblings = root.folders;
		let path = "";
		let node: WorkspaceFolder | undefined;
		for (const name of parts.slice(0, -1)) {
			path = path ? `${path}/${name}` : name;
			node = index.get(path);
			if (!node) { node = { name, path, fileCount: 0, folders: [], files: [] }; index.set(path, node); siblings.push(node); }
			node.fileCount++;
			siblings = node.folders;
		}
		node!.files.push(f);
	}
	const sort = (list: WorkspaceFolder[]) => { list.sort(folderOrder); list.forEach(n => sort(n.folders)); };
	sort(root.folders);
	return root;
}

/** Remembered open folders for one project; paths are relative to the project folder (`99 작업실/10 자료`). */
export function expandedFolders(map: Record<string, string[]> | undefined, projectId: string): Set<string> {
	return new Set(map?.[projectId] ?? []);
}
/** A new map with `path` opened or closed for the project. Empty lists are dropped. */
export function toggleExpandedFolder(map: Record<string, string[]> | undefined, projectId: string, path: string, open: boolean): Record<string, string[]> {
	const set = expandedFolders(map, projectId);
	if (open) set.add(path); else set.delete(path);
	const next = { ...(map ?? {}) };
	if (set.size) next[projectId] = [...set]; else delete next[projectId];
	return next;
}
