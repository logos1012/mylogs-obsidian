/**
 * Project status change on a phone (계획 「11」): the kanban's drop zones as a picker.
 * `projectStatusTargets` lists the columns whose `dropZone` accepts the card (`view.ts`: not
 * archived, another column), and `runProjectTarget` calls what the drop calls (`moveTo`). Pure;
 * tested in `test/mobile-targets.test.ts`.
 */

import { columnOf, type Project, PROJECT_STATUSES, type ProjectStatus } from "./model.ts";
import { withRo } from "./ops.ts";

const HINT: Record<ProjectStatus, string> = {
	후보: "해 볼까 하는 것",
	진행: "지금 하는 것",
	대기: "남의 답·조건을 기다림",
	보류: "잠시 내려 둠",
	완료: "완료하고 Archive Box로 보관",
};

export interface ProjectTarget {
	status: ProjectStatus;
	label: string;
	sub: string;
}

export function projectStatusTargets(p: Pick<Project, "status" | "archived">): ProjectTarget[] {
	if (p.archived) return [];
	const cur = columnOf(p);
	return PROJECT_STATUSES.filter((s) => s !== cur).map((s) => ({ status: s, label: s === "완료" ? "완료하고 보관…" : withRo(s), sub: HINT[s] }));
}

export interface ProjectMoveApi<P> {
	/** kanban drop: `moveTo(project, status)` */
	moveTo(p: P, status: ProjectStatus): Promise<unknown>;
}

export function runProjectTarget<P>(t: ProjectTarget, p: P, api: ProjectMoveApi<P>): Promise<unknown> {
	return api.moveTo(p, t.status);
}
