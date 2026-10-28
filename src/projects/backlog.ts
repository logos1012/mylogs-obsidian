/**
 * 배정 안 된 프로젝트 할 일 (Wall 달 배정 · Desk 주 보기): open projects' hub tasks with no
 * month or date yet, on the shown 개인 / 회사 side. A 묶음 is not assigned itself; its 하위 할 일 are.
 */

import { parseFrontmatterText } from "../pinboard/model.ts";
import { asSide, shows, type Side, type SideMode } from "../side.ts";
import { activeRoot, archiveRoot, type ProjectsHost } from "./actions.ts";
import { hubLocation, parseProject } from "./model.ts";
import { loadProjectTasks } from "./task-actions.ts";
import type { ProjectTask } from "./tasks.ts";

export interface BacklogGroup {
	project: string;
	projectId: string;
	projectPath: string;
	scope: Side;
	tasks: ProjectTask[];
	/** `topLevel`: per 묶음 id, how many of its 하위 할 일 are still unassigned. */
	children?: Record<string, number>;
}

/** `statuses`: which projects count (Desk 주 보기: 진행 · 대기; Wall 달 계획 also 후보). `mode`: the side shown. */
/**
 * `topLevel` (Wall 인박스): first-level rows only — a 묶음 stands for its 하위 할 일 (shown while any of
 * them is unassigned; put on a month it takes them all). Otherwise (Desk 주 보기) the 하위 할 일 themselves.
 */
export async function loadProjectBacklog(host: ProjectsHost, statuses: string[] = ["진행", "대기"], mode: SideMode = host.settings.sideMode, topLevel = false): Promise<BacklogGroup[]> {
	const out: BacklogGroup[] = [];
	for (const f of host.app.vault.getMarkdownFiles()) {
		const loc = hubLocation(f.path, activeRoot(host), archiveRoot(host));
		if (!loc || loc.archived) continue;
		const text = await host.app.vault.cachedRead(f);
		const fm = parseFrontmatterText(text);
		const p = parseProject(fm.data, fm.body, loc, f.path);
		if (!p || !statuses.includes(p.status)) continue;
		const scope = asSide(p.scope);
		if (!shows(scope, mode)) continue;
		try {
			const all = await loadProjectTasks(host, p, text);
			const open = (t: ProjectTask) => t.kind === "hub" && t.state === "scheduled" && !t.date && !t.month;
			const tasks = topLevel
				? all.filter((t) => !t.parentId && open(t) && (!t.group || all.some((k) => k.parentId === t.id && open(k))))
				: all.filter((t) => open(t) && !t.group);
			const children: Record<string, number> = {};
			if (topLevel) for (const t of tasks) if (t.group) children[t.id] = all.filter((k) => k.parentId === t.id && open(k)).length;
			if (tasks.length) out.push({ project: p.title, projectId: p.id, projectPath: p.path, scope, tasks, children });
		} catch (err) {
			console.warn("[MyLogs] project tasks unreadable", p.path, err);
		}
	}
	return out.sort((a, b) => a.project.localeCompare(b.project, "ko"));
}
