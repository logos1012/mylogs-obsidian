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
import { type InboxKind, type Plan, planAddDuring, planAddWeekTask, prependChangeLog, runPlan } from "./ops.ts";

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
	return runChecked(io, planAddDuring(monthKeyStr, text, kind, side, today), { [monthKeyStr]: paths.month }, paths.index, today);
}

export interface WeekAddPaths extends InboxAddPaths {
	/** Vault path of the file holding the week's `### 이번 주` (`allocFileOf(monday)`); same as `month` for most weeks. */
	alloc: string;
}

/**
 * 주 칸 「+ 추가」 — the write. `planAddWeekTask` (인박스 line with `→ Wnn` + the copy under the
 * week's `### 이번 주`, the same lines a drag-assign leaves) through the same checked batch as
 * `addToInboxChecked`: the 인박스 month file, the week's file when it is another month, and the
 * Desk Calendar Index. Any of them changed since the read → nothing written, `conflict`.
 */
export async function addToWeekChecked(
	io: BatchIO,
	paths: WeekAddPaths,
	inboxMonth: string,
	monday: string,
	allocFile: string,
	text: string,
	side: Side,
	today: string,
): Promise<InboxAddResult> {
	const plan = planAddWeekTask(inboxMonth, monday, allocFile, text, side, today);
	return runChecked(io, plan, { [inboxMonth]: paths.month, [allocFile]: paths.alloc }, paths.index, today);
}

/**
 * Read every month file of `plan` (month key → vault path), dry-run it, then write all changed
 * files plus the index change log in one `commitBatch`. A missing month file → `file-missing`.
 */
async function runChecked(io: BatchIO, plan: Plan, monthPaths: Record<string, string>, indexPath: string, today: string): Promise<InboxAddResult> {
	const befores: Record<string, string> = {};
	for (const [key, path] of Object.entries(monthPaths)) {
		const t = await io.read(path);
		if (t === null) return { ok: false, reason: "file-missing" };
		befores[key] = t;
	}
	const dry = runPlan(plan, befores);
	if (!dry.ok) {
		const r = dry.reason;
		const known = r === "empty-text" || r === "section-missing" || r === "duplicate" || r === "file-missing";
		return { ok: false, reason: known ? r : "error", message: r };
	}
	const writes: Write[] = Object.entries(dry.files).map(([key, after]) => ({ path: monthPaths[key], before: befores[key], after }));
	const idx = await io.read(indexPath);
	if (idx !== null) writes.push({ path: indexPath, before: idx, after: prependChangeLog(idx, today, plan.what) });
	try {
		await commitBatch(io, writes);
	} catch (err) {
		if (isConflict(err)) return { ok: false, reason: "conflict" };
		return { ok: false, reason: "error", message: String(err instanceof Error ? err.message : err) };
	}
	return { ok: true, what: plan.what };
}
