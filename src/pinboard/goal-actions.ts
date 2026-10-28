/**
 * Goal changes the Pinboard panel makes, as host-level actions (for 루미 and the panel alike):
 * current · status · health · 진척 기록 (`saveGoalFields`), and links to projects / Flywheel are in
 * `./create-actions.ts`. One batch: the goal note, its Main's rollup, `Pinboard Index.md`.
 */

import { cleanFolder } from "../settings.ts";
import type { ProjectsHost } from "../projects/actions.ts";
import { applyGoalChange, applyMainRollup, type GoalFieldChange } from "./goal-edit.ts";
import { applyIndexEdit, ensureHealthColumn, INDEX_FILE, indexPathCell, indexProgressCell, indexToken, type RowUpdate } from "./index-writer.ts";
import { type Goal, goalIdYear, rollupMain } from "./model.ts";
import { readGoal } from "./create.ts";
import { commitBatch, type Write } from "./batch.ts";
import { exclusive, readGoals, vaultIO } from "./create-actions.ts";

export async function saveGoalFields(host: ProjectsHost, id: string, c: GoalFieldChange, today: string): Promise<Goal> {
	return exclusive(host, async () => {
		const io = vaultIO(host.app);
		const all = await readGoals(host);
		const hit = all.find((x) => x.goal.id === id);
		if (!hit) throw new Error(`목표를 찾지 못했어요: ${id}`);
		const r = applyGoalChange(hit.text, hit.goal.path, c, today);
		const ng = r.goal;
		if (!ng) throw new Error("목표 노트를 다시 확인해 주세요.");
		const og = r.before ?? hit.goal;
		const writes: Write[] = [{ path: hit.goal.path, before: hit.text, after: r.text }];
		const row: RowUpdate = { id: ng.id };
		const parts: string[] = [];
		if (ng.status !== og.status) (row.status = ng.status), parts.push(`status ${og.status} → ${ng.status}`);
		if (ng.health !== og.health) (row.health = ng.health), parts.push(`health ${og.health || "—"} → ${ng.health || "—"}`);
		const rows: RowUpdate[] = [row];
		if (ng.type === "sub-goal") {
			if (ng.current !== og.current) {
				row.current = indexToken(ng.current, ng.measure);
				row.path = indexPathCell(ng);
				parts.push(`current ${indexToken(og.current, og.measure)} → ${indexToken(ng.current, ng.measure)}`);
			}
			if (ng.progress !== null && (ng.progress !== og.progress || row.status !== undefined)) row.progress = indexProgressCell(ng.progress);
			const main = all.find((x) => x.goal.id === ng.parent && x.goal.type === "main-goal");
			if (main) {
				const subs = all.filter((x) => x.goal.type === "sub-goal" && x.goal.parent === main.goal.id).map((x) => (x.goal.id === ng.id ? ng : x.goal));
				const roll = rollupMain(subs);
				if (main.goal.progress !== roll.progress || main.goal.subTotal !== roll.subTotal || main.goal.subAchieved !== roll.subAchieved) {
					writes.push({ path: main.goal.path, before: main.text, after: applyMainRollup(main.text, roll, today) });
					const cell = indexProgressCell(roll.progress, roll);
					rows.push({ id: main.goal.id, progress: cell });
					parts.push(`${main.goal.id} ${cell}`);
				}
			}
		}
		if (c.log) parts.push(`진척 기록 추가${c.log.value ? ` (value ${c.log.value})` : ""}`);
		if (parts.length) {
			const ip = `${cleanFolder(host.settings.pinboardFolder)}/${INDEX_FILE}`;
			const index = await io.read(ip);
			if (index !== null) {
				const year = String(goalIdYear(ng.id));
				const healthOf = (gid: string) => (gid === ng.id ? ng.health : (all.find((x) => x.goal.id === gid)?.goal.health ?? ""));
				const ir = applyIndexEdit(ensureHealthColumn(index, year, healthOf), { year, rows, log: `${ng.id} ${parts.join(", ")} (루미)`, today });
				writes.push({ path: ip, before: index, after: ir.text });
			}
		}
		await commitBatch(io, writes);
		return readGoal(r.text, hit.goal.path);
	});
}
