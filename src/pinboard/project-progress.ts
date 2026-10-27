import type { Goal } from "./model.ts";
import { readMilestones } from "../projects/milestones.ts";
export interface ProjectProgress { id: string; title: string; progress: number; done: number; total: number; issue?: string }
export function projectProgress(id: string, title: string, text: string): ProjectProgress {
 try { const items = readMilestones(text).items, done = items.filter(x => x.done).length;
 return { id, title, done, total: items.length, progress: items.length ? done / items.length * 100 : 0, issue: items.length ? undefined : "마일스톤 미설정" };
 } catch { return { id, title, done: 0, total: 0, progress: 0, issue: "마일스톤 형식 오류" }; }
}
export function projectWeight(g: Goal, id: string): number {
 const entry = g.projectWeights?.find(x => x.slice(0, x.lastIndexOf("=")) === id);
 if (!entry) return 1;
 const n = Number(entry.slice(entry.lastIndexOf("=") + 1));
 return Number.isFinite(n) && n >= 0 ? n : 1;
}
export function contributions(g: Goal, projects: ProjectProgress[]) {
 const rows = [...new Set(g.projectIds)].map(id => {
 const matches = projects.filter(p => p.id === id);
 const p = matches.length === 1 ? matches[0] : { id, title: id, progress: 0, done: 0, total: 0, issue: matches.length ? "프로젝트 id 중복" : "프로젝트 없음" };
 return { ...p, weight: projectWeight(g, id) };
 });
 const sum = rows.reduce((s, r) => s + r.weight, 0);
 return rows.map(r => ({ ...r, share: sum ? r.weight / sum * 100 : 0 }));
}
export function applyProjectProgress(goals: Goal[], projects: ProjectProgress[]): void {
 for (const g of goals) if (g.type === "sub-goal" && g.progressSource === "projects") {
 const rows = contributions(g, projects);
 g.progress = Math.round(rows.reduce((sum, r) => sum + r.progress * r.share / 100, 0));
 }
}
