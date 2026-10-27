import { Notice, type Plugin } from "obsidian";
import { activeRoot, archiveRoot, type ProjectsHost } from "../projects/actions.ts";
import { hubLocation } from "../projects/model.ts";
import { setFmValue, setFmList } from "../projects/ops.ts";
import { cleanFolder } from "../settings.ts";
import { parseFrontmatterText, parseGoal, rollupMain, type Goal } from "./model.ts";
import { applyMainRollup } from "./goal-edit.ts";
import { readGoals, vaultIO, exclusive } from "./create-actions.ts";
import { upsertGoalRows } from "./create.ts";
import { commitBatch, type Write } from "./batch.ts";
import { prependChangeLog } from "./index-writer.ts";
import { applyProjectProgress, projectProgress, type ProjectProgress } from "./project-progress.ts";

export async function loadProjectProgress(host: ProjectsHost, writes: Write[] = [], guards?: Write[]): Promise<ProjectProgress[]> {
 const result: ProjectProgress[] = [];
 const paths = new Set([...host.app.vault.getMarkdownFiles().map(f => f.path), ...writes.map(w => w.path)]);
 for (const path of paths) {
  if (!hubLocation(path, activeRoot(host), archiveRoot(host))) continue;
  const w = writes.find(w => w.path === path), text = w?.after ?? await vaultIO(host.app).read(path);
  if (!text) continue;
  const fm = parseFrontmatterText(text).data;
  if (fm.type !== "project" || !fm.id) continue;
  result.push(projectProgress(String(fm.id), String(fm.title || path.split("/").pop()), text));
  if (!w) guards?.push({ path, before: text, after: text });
 }
 return result;
}
/** Merge derived values into the caller's transaction; source snapshots guard concurrent edits. */
export async function withProjectRollup(host: ProjectsHost, incoming: Write[], today: string): Promise<Write[]> {
 const writes = new Map(incoming.map(w => [w.path, { ...w }]));
 const items = await readGoals(host);
 for (const w of incoming) {
  const goal = parseGoal(parseFrontmatterText(w.after).data, w.path);
  if (!goal) continue;
  const i = items.findIndex(x => x.goal.path === w.path);
  if (i >= 0) items[i] = { goal, text: w.after }; else items.push({ goal, text: w.after });
 }
 if (!items.some(x => x.goal.progressSource === "projects")) return incoming;
 const guards: Write[] = [], projects = await loadProjectProgress(host, incoming, guards);
 applyProjectProgress(items.map(x => x.goal), projects);
 const changed: Goal[] = [];
 const put = (path: string, text: string, after: string) => {
  const old = writes.get(path); writes.set(path, { path, before: old ? old.before : text, after });
 };
 for (const item of items) {
  const g = item.goal;
  if (g.type === "sub-goal" && g.progressSource === "projects") {
   // Explicit mode survives unlinking the last project.
   let after = setFmValue(item.text, "progress_source", "projects");
   after = setFmValue(after, "progress", String(g.progress ?? 0));
   if (after !== item.text) { after = setFmValue(after, "updated", today); put(g.path, item.text, after); changed.push(g); }
  }
 }
 for (const item of items.filter(x => x.goal.type === "main-goal")) {
  const subs = items.filter(x => x.goal.parent === item.goal.id).map(x => x.goal);
  if (!subs.some(s => s.progressSource === "projects")) continue;
  const r = rollupMain(subs), g = item.goal;
  if (g.progress !== r.progress || g.subTotal !== r.subTotal || g.subAchieved !== r.subAchieved) {
   const after = applyMainRollup(item.text, r, today); put(g.path, item.text, after);
   changed.push(parseGoal(parseFrontmatterText(after).data, g.path)!);
  }
 }
 if (!changed.length) return incoming;
 const ip = `${cleanFolder(host.settings.pinboardFolder)}/Pinboard Index.md`;
 const before = writes.get(ip)?.after ?? await vaultIO(host.app).read(ip);
 if (before === null) throw new Error("Pinboard 등록부가 없어 자동 집계하지 못했어요.");
 let after = before;
 for (const g of changed) after = upsertGoalRows(after, Number(g.id.slice(2, 6)), [g]);
 after = setFmValue(prependChangeLog(after, today, `프로젝트 가중 진척 자동 집계: ${changed.map(g => `${g.id} ${g.progress}%`).join(", ")} (결과값·상태 보존)`), "updated", today);
 put(ip, before, after);
 for (const item of items) if (!writes.has(item.goal.path)) guards.push({ path: item.goal.path, before: item.text, after: item.text });
 for (const w of guards) if (!writes.has(w.path)) writes.set(w.path, w);
 return [...writes.values()];
}
export async function syncProjectRollup(host: ProjectsHost, today: string): Promise<void> {
 return exclusive(host, async () => { await commitBatch(vaultIO(host.app), await withProjectRollup(host, [], today)); });
}
export async function saveProgressSettings(host: ProjectsHost, goal: Goal, expected: string, source: string, weights: string[], today: string): Promise<void> {
 return exclusive(host, async () => {
  const io = vaultIO(host.app), before = await io.read(goal.path);
  if (before !== expected) throw new Error("목표가 다른 곳에서 바뀌었어요. 취소 후 다시 열어 주세요.");
  if (!["projects", "manual"].includes(source)) throw new Error("집계 방식을 선택해 주세요.");
  if (weights.some(x => !Number.isFinite(Number(x.split("=").pop())) || Number(x.split("=").pop()) < 0) || (weights.length && !weights.some(x => Number(x.split("=").pop()) > 0))) throw new Error("비중은 0 이상이며 적어도 하나는 0보다 커야 해요.");
  let after = setFmValue(setFmList(before, "project_weights", weights), "progress_source", source);
  after = setFmValue(after, "updated", today);
  // Manual mode recomputes independently, without changing results or status.
  const { computeSubProgress } = await import("./model.ts");
  const next = parseGoal(parseFrontmatterText(after).data, goal.path)!;
  if (source === "manual") after = setFmValue(after, "progress", String(computeSubProgress(next) ?? next.progress ?? 0));
  const all = await readGoals(host), writes: Write[] = [{ path: goal.path, before, after }];
  const finalGoal = parseGoal(parseFrontmatterText(after).data, goal.path)!;
  const parent = all.find(x => x.goal.id === goal.parent && x.goal.type === "main-goal");
  const rows = [finalGoal];
  if (parent) {
   const subs = all.filter(x => x.goal.parent === goal.parent).map(x => x.goal.id === goal.id ? finalGoal : x.goal);
   applyProjectProgress(subs, await loadProjectProgress(host));
   const pafter = applyMainRollup(parent.text, rollupMain(subs), today);
   writes.push({ path: parent.goal.path, before: parent.text, after: pafter }); rows.push(parseGoal(parseFrontmatterText(pafter).data, parent.goal.path)!);
  }
  const ip = `${cleanFolder(host.settings.pinboardFolder)}/Pinboard Index.md`, index = await io.read(ip);
  if (index === null) throw new Error("Pinboard 등록부가 없어요.");
  writes.push({ path: ip, before: index, after: setFmValue(prependChangeLog(upsertGoalRows(index, Number(goal.id.slice(2,6)), rows), today, `${goal.id} 집계 방식·프로젝트 비중 변경 (사용자 입력)`), "updated", today) });
  await commitBatch(io, await withProjectRollup(host, writes, today));
 });
}
export function registerProjectRollup(host: ProjectsHost & Plugin): void {
 let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, attempts = 0;
 const schedule = () => { if (stopped) return; if (timer) clearTimeout(timer); timer = setTimeout(run, 700); };
 const run = async () => {
  if (stopped) return;
  try { await syncProjectRollup(host, new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" })); attempts = 0; }
  catch (e) { if (++attempts < 3) schedule(); else { new Notice(`목표 자동 집계 대기: ${String(e)}`); attempts = 0; } }
 };
 const relevant = (f: { path: string }) => { if (f.path.endsWith(".md") && [cleanFolder(host.settings.pinboardFolder), activeRoot(host), archiveRoot(host)].some(p => f.path.startsWith(p + "/"))) schedule(); };
 host.registerEvent(host.app.vault.on("modify", relevant));
 host.registerEvent(host.app.vault.on("create", relevant));
 host.registerEvent(host.app.vault.on("delete", relevant));
 host.registerEvent(host.app.vault.on("rename", (f, old) => { relevant(f); relevant({ path: old }); }));
 host.app.workspace.onLayoutReady(schedule);
 host.register(() => { stopped = true; if (timer) clearTimeout(timer); });
}
