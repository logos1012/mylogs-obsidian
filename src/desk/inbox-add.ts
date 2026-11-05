/**
 * 인박스에 직접 추가 — the write. Reads the Desk month file (and the Desk Calendar Index), runs
 * `planAddDuring` on that text, and writes both in one `commitBatch` (the same checked batch the
 * Daily Pad 넘기기 uses): if either file changed between the read and the write (Hermes, sync,
 * another pane), nothing is written and the result is `conflict`.
 *
 * Pure: no `obsidian` import, so it runs under `node --test` with an in-memory `BatchIO`.
 */
import { commitBatch, type BatchIO, type Write } from "../pinboard/batch.ts";
import type { Side } from "../side.ts";
import { type InboxKind, planAddDuring, prependChangeLog, runPlan } from "./ops.ts";

export type InboxAddResult =
	| { ok: true; what: string }
	| { ok: false; reason: "conflict" | "file-missing" | "empty-text" | "section-missing" | "duplicate" | "error"; message?: string };

export interface InboxAddPaths {
	/** Vault path of the month file (`…/2026/2026-11.md`). */
	month: string;
	/** Vault path of `Desk Calendar Index.md` (its change log is written in the same batch; skipped when missing). */
	index: string;
}

export const INBOX_CONFLICT_NOTICE = "Desk Calendar 파일이 그새 바뀌어 추가를 취소했어요. 다시 시도해 주세요.";

/** True for the errors `commitBatch` / `compareWrite` raise when a file changed under us (not a storage failure). */
function isConflict(err: unknown): boolean {
	const msg = String(err instanceof Error ? err.message : err);
	if (msg.includes("부분 저장")) return false;
	return msg.includes("파일이 바뀌었어요") || msg.includes("동시 변경");
}

export async function addToInboxChecked(
	io: BatchIO,
	paths: InboxAddPaths,
	monthKeyStr: string,
	text: string,
	kind: InboxKind,
	side: Side,
	today: string,
): Promise<InboxAddResult> {
	const before = await io.read(paths.month);
	if (before === null) return { ok: false, reason: "file-missing" };
	const plan = planAddDuring(monthKeyStr, text, kind, side, today);
	const dry = runPlan(plan, { [monthKeyStr]: before });
	if (!dry.ok) {
		const r = dry.reason;
		return { ok: false, reason: r === "empty-text" || r === "section-missing" || r === "duplicate" ? r : "error", message: r };
	}
	const writes: Write[] = [{ path: paths.month, before, after: dry.files[monthKeyStr] }];
	const idx = await io.read(paths.index);
	if (idx !== null) writes.push({ path: paths.index, before: idx, after: prependChangeLog(idx, today, plan.what) });
	try {
		await commitBatch(io, writes);
	} catch (err) {
		if (isConflict(err)) return { ok: false, reason: "conflict" };
		return { ok: false, reason: "error", message: String(err instanceof Error ? err.message : err) };
	}
	return { ok: true, what: plan.what };
}
