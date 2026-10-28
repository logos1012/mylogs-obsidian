/**
 * 배정 안 된 프로젝트 할 일 (Wall 달 배정 · Desk 주 보기): 진행 · 대기 projects' hub tasks with no
 * month or date yet, on the shown 개인 / 회사 side. A 묶음 is not assigned itself; its 하위 할 일 are.
 */

import { parseFrontmatterText } from "../pinboard/model.ts";
import { asSide, shows } from "../side.ts";
import { activeRoot, archiveRoot, type ProjectsHost } from "./actions.ts";
import { hubLocation, parseProject } from "./model.ts";
import { loadProjectTasks } from "./task-actions.ts";
import type { ProjectTask } from "./tasks.ts";

export interface BacklogGroup {
	project: string;
	projectId: string;
	projectPath: string;
	tasks: ProjectTask[];
}

export async function loadProjectBacklog(host: ProjectsHost): Promise<BacklogGroup[]> {
	const out: BacklogGroup[] = [];
	const mode = host.settings.sideMode;
	for (const f of host.app.vault.getMarkdownFiles()) {
		const loc = hubLocation(f.path, activeRoot(host), archiveRoot(host));
		if (!loc || loc.archived) continue;
		const text = await host.app.vault.cachedRead(f);
		const fm = parseFrontmatterText(text);
		const p = parseProject(fm.data, fm.body, loc, f.path);
		if (!p || !["진행", "대기"].includes(p.status) || !shows(asSide(p.scope), mode)) continue;
		try {
			const tasks = (await loadProjectTasks(host, p, text)).filter((t) => t.kind === "hub" && t.state === "scheduled" && !t.group && !t.date && !t.month);
			if (tasks.length) out.push({ project: p.title, projectId: p.id, projectPath: p.path, tasks });
		} catch (err) {
			console.warn("[MyLogs] project tasks unreadable", p.path, err);
		}
	}
	return out.sort((a, b) => a.project.localeCompare(b.project, "ko"));
}
