import type { Project } from "./model.ts";
import { validMilestoneDate } from "./milestones.ts";

/** Derived markers, never task rows. No writes and no progress side effects. */
export interface MilestoneMarker {
	projectId: string; projectPath: string; projectTitle: string;
	source?: string; line: number; title: string; date: string; done: boolean; archived: boolean;
}
export function milestoneMarkers(projects: Project[]): MilestoneMarker[] {
	return projects.flatMap(p => (p.milestones ?? []).filter(m => m.due && validMilestoneDate(m.due) && !m.dueIssue).map(m => ({
		source: p.milestoneSource, projectId: p.id, projectPath: p.path, projectTitle: p.title, line: m.line, title: m.text, date: m.due!, done: m.done, archived: p.archived,
	}))).sort((a, b) => a.date.localeCompare(b.date) || a.projectTitle.localeCompare(b.projectTitle, "ko") || a.line - b.line);
}
export function markerState(m: MilestoneMarker, today: string): "archived" | "done" | "overdue" | "planned" {
	return m.archived ? "archived" : m.done ? "done" : m.date < today ? "overdue" : "planned";
}
