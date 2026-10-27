import { withProjectRollup } from "./project-rollup.ts";
import { TFile, normalizePath } from "obsidian";
import type { ProjectsHost } from "../projects/actions.ts";
import { cleanFolder } from "../settings.ts";
import { setFmValue } from "../projects/ops.ts";
import { type Goal, rollupMain } from "./model.ts";
import { applyMainRollup, goalBaseName, renameLinks } from "./goal-edit.ts";
import { readGoal, upsertGoalRows } from "./create.ts";
import { readGoals, vaultIO, exclusive } from "./create-actions.ts";
import { commitBatch, type Write } from "./batch.ts";
import { ensureHealthColumn, INDEX_FILE, prependChangeLog } from "./index-writer.ts";
import { editInlineGoal, INLINE_LABELS, type InlineGoalField } from "./inline-edit.ts";

/** Single-field save with fresh sibling rollup, registry, and rename rollback. */
export async function saveInlineGoal(host: ProjectsHost, displayed: Goal, field: InlineGoalField, expected: string, value: string, today: string): Promise<Goal> {
	return exclusive(host, async () => {
		const io = vaultIO(host.app), all = await readGoals(host);
		const original = all.find(x => x.goal.id === displayed.id && x.goal.path === displayed.path);
		if (!original) throw new Error("목표가 이동되었거나 삭제됐어요. 다시 열어 주세요.");
		const edited = editInlineGoal(original.text, displayed.path, field, expected, value, today);
		if (edited.text === original.text) return original.goal;
		const next = edited.goal, file = host.app.vault.getAbstractFileByPath(displayed.path);
		if (!(file instanceof TFile)) throw new Error("목표 파일을 찾지 못했어요.");
		const oldBase = displayed.path.split("/").pop()!.replace(/\.md$/, ""), newBase = goalBaseName(next.id, next.title);
		const rename = field === "title" && oldBase !== newBase;
		const target = rename ? normalizePath(displayed.path.slice(0, displayed.path.lastIndexOf("/") + 1) + newBase + ".md") : displayed.path;
		if (rename && host.app.vault.getAbstractFileByPath(target)) throw new Error("같은 이름의 파일이 있어요. 다른 제목을 적어 주세요.");
		const writes = new Map<string, Write>([[displayed.path, { path: displayed.path, before: original.text, after: edited.text }]]);
		const rows = [next];
		if (next.type === "sub-goal" && next.parent) {
			const parent = all.find(x => x.goal.id === next.parent && x.goal.type === "main-goal");
			if (!parent) throw new Error("상위 목표를 찾지 못해 집계할 수 없어요. 연결을 먼저 확인해 주세요.");
			const siblings = all.filter(x => x.goal.parent === next.parent).map(x => x.goal.id === next.id ? next : x.goal);
			const after = applyMainRollup(parent.text, rollupMain(siblings), today);
			writes.set(parent.goal.path, { path: parent.goal.path, before: parent.text, after }); rows.push(readGoal(after, parent.goal.path));
		}
		if (rename) {
			// FileManager handles vault-wide links. Keep goal links correct even when auto-update is off.
			for (const item of all) {
				const w = writes.get(item.goal.path), before = w?.after ?? item.text, after = renameLinks(before, oldBase, newBase);
				if (after !== before) writes.set(item.goal.path, { path: item.goal.path, before: w?.before ?? item.text, after: setFmValue(after, "updated", today) });
			}
		}
		const ip = `${cleanFolder(host.settings.pinboardFolder)}/${INDEX_FILE}`, index = await io.read(ip);
		if (index === null) throw new Error("Pinboard 등록부가 없어요. 아무것도 저장하지 않았어요.");
		const year = Number(next.id.slice(2, 6));
		let idx = upsertGoalRows(ensureHealthColumn(index, String(year), id => all.find(x => x.goal.id === id)?.goal.health ?? ""), year, rows);
		if (rename) idx = renameLinks(idx, oldBase, newBase);
		idx = setFmValue(prependChangeLog(idx, today, `${next.id} ${INLINE_LABELS[field]} 수정 (화면에서 직접 편집)`), "updated", today);
		writes.set(ip, { path: ip, before: index, after: idx });
		const batch = await withProjectRollup(host, [...writes.values()], today);
		await commitBatch(io, batch);
		if (rename) {
			try { await host.app.fileManager.renameFile(file, target); }
			catch (err) {
				if (file.path !== displayed.path) throw new Error(`내용과 파일 이름은 변경됐지만 링크 갱신을 확인해야 해요: ${file.path}\n${String(err)}`);
				try { await commitBatch(io, batch.map(w => ({ path: w.path, before: w.after, after: w.before! }))); }
				catch (rollback) { throw new Error(`파일 이름 변경 실패·부분 저장. 노트와 등록부를 확인해 주세요.\n${String(rollback)}`); }
				throw new Error(`파일 이름을 바꾸지 못해 이번 수정을 취소했어요.\n${String(err)}`);
			}
		}
		return { ...next, path: target };
	});
}
