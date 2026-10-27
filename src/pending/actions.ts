/**
 * Daily Pad 「결정 대기」: ask, then write every affected file in one checked batch (`commitBatch`:
 * nothing is half-written; a file that changed meanwhile cancels the whole choice).
 * Rules: 04 Daily Pad AGENTS 「3-6」「3-7」; pure edits in `./ops.ts`.
 */

import { type App, normalizePath, Notice } from "obsidian";
import type { MyLogsSettings } from "../settings.ts";
import { addDays, type SourceLine } from "../parser.ts";
import { commitBatch, type Write } from "../pinboard/batch.ts";
import { exclusive, vaultIO } from "../pinboard/create-actions.ts";
import { deskMonthPath } from "../desk/actions.ts";
import { appendLines, appendUnderWallMonth, movedCount, prependChangeLog, touchUpdated, wallYearSkeleton } from "../desk/ops.ts";
import { askThirdMove, pickDate, pickMonth, promptText } from "../desk/modals.ts";
import { drawerPath } from "../drawer/actions.ts";
import { askWhen } from "../drawer/modals.ts";
import { drawerTemplate, putItem } from "../drawer/ops.ts";
import { setFrontmatterScalar } from "../writer.ts";
import {
	appendSplitParts,
	describeChoice,
	dropIndexRow,
	forwardCopy,
	markForChoice,
	markInDeskDay,
	markInPadSection,
	type PendingChoice,
	removePendingLine,
	sourceDateOf,
	taskKey,
} from "./ops.ts";

export interface PendingHost {
	app: App;
	settings: MyLogsSettings;
}

const INDEX_FILE = "Daily Pad Index.md";

function padPath(host: PendingHost, date: string): string {
	return normalizePath(`${host.settings.dailyPadFolder}/${date.slice(0, 4)}/${date}.md`);
}

function nextMonth(iso: string): string {
	const y = +iso.slice(0, 4);
	const m = +iso.slice(5, 7);
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Ask for one of the five choices' details and carry it out. `kind` is the button the user pressed.
 * Returns true when the files were written.
 */
export async function choosePending(
	host: PendingHost,
	padDate: string,
	sl: SourceLine,
	kind: PendingChoice["kind"],
	today: string,
): Promise<boolean> {
	const text = sl.item?.text ?? sl.line.trim();
	const app = host.app;

	// 「3-7」: a third postpone asks 의무 / 가치 first.
	if ((kind === "day" || kind === "future") && movedCount(sl.line) >= 2) {
		const a = await askThirdMove(app, text, movedCount(sl.line));
		if (a === "cancel") return false;
		if (a === "letgo") kind = "letgo";
		else if (a === "split") kind = "split";
	}

	let choice: PendingChoice | null = null;
	switch (kind) {
		case "day": {
			const date = await pickDate(app, "다른 날", addDays(today, 1), `「${text}」을(를) 할 날을 골라요.`);
			if (date) choice = { kind: "day", date };
			break;
		}
		case "future": {
			const month = await pickMonth(app, "미래로", nextMonth(today), `「${text}」을(를) 보낼 달을 골라요.`);
			if (month) choice = { kind: "future", month };
			break;
		}
		case "drawer": {
			const a = await askWhen(app, text);
			if (!a) return false;
			if (a.kind === "letgo") return choosePending(host, padDate, sl, "letgo", today);
			choice = { kind: "drawer", when: a.when };
			break;
		}
		case "split": {
			const v = await promptText(app, "쪼개기", {
				desc: `「${text}」을(를) 더 작은 다음 행동으로 나눠요. 한 줄에 하나씩 적어요. 오늘 할 일에 들어가요.`,
				placeholder: "예: 자료 목록 만들기\n첫 단락 쓰기",
				multiline: true,
				okText: "쪼개기",
			});
			const parts = (v ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
			if (parts.length) choice = { kind: "split", parts };
			break;
		}
		case "letgo": {
			const why = await promptText(app, "놓아주기", {
				desc: `「${text}」을(를) 하지 않기로 해요. 이유를 한 줄로 남겨요.`,
				placeholder: "예: 지금 목표와 관계없음",
				okText: "놓아주기",
			});
			if (why) choice = { kind: "letgo", why };
			break;
		}
	}
	if (!choice) return false;

	try {
		await exclusive(host, () => applyPending(host, padDate, sl, choice!, today));
	} catch (err) {
		console.error("[MyLogs] 결정 대기 처리 실패", err);
		new Notice(err instanceof Error ? err.message : String(err));
		return false;
	}
	new Notice(doneNotice(text, choice));
	return true;
}

function doneNotice(text: string, c: PendingChoice): string {
	switch (c.kind) {
		case "day":
			return `「${text}」을(를) ${+c.date.slice(5, 7)}월 ${+c.date.slice(8, 10)}일로 옮겼어요.`;
		case "future":
			return `「${text}」을(를) ${c.month} Wall Calendar로 보냈어요.`;
		case "drawer":
			return `「${text}」을(를) 서랍에 넣었어요.`;
		case "split":
			return `「${text}」을(를) ${c.parts.length}개로 쪼개 오늘 할 일에 넣었어요.`;
		case "letgo":
			return `「${text}」을(를) 놓아줬어요.`;
	}
}

/** Build every write for the choice, then commit them together. */
export async function applyPending(host: PendingHost, padDate: string, sl: SourceLine, c: PendingChoice, today: string): Promise<void> {
	const io = vaultIO(host.app);
	const s = host.settings;
	const files = new Map<string, { before: string | null; after: string }>();
	const load = async (path: string): Promise<string | null> => {
		const cur = files.get(path);
		if (cur) return cur.after;
		const t = await io.read(path);
		if (t !== null) files.set(path, { before: t, after: t });
		return t;
	};
	const put = (path: string, after: string, before: string | null = null) => {
		const cur = files.get(path);
		files.set(path, { before: cur ? cur.before : before, after });
	};

	const key = taskKey(sl.line);
	const label = sl.item?.text ?? key;
	const moved = movedCount(sl.line);

	// 1. Out of 결정 대기 (+ 쪼갠 다음 행동 into 오늘 할 일).
	const pad = padPath(host, padDate);
	const padText = await load(pad);
	if (padText === null) throw new Error(`Daily Pad 파일이 없어요: ${pad}`);
	const removed = removePendingLine(padText, { index: sl.index, line: sl.line }, today, s.sections.pending);
	if (!removed.ok) throw new Error("결정 대기 줄이 그새 바뀌었어요. 화면을 다시 그렸어요.");
	put(pad, c.kind === "split" ? appendSplitParts(removed.text, s.sections.today, c.parts) : removed.text);

	// 2. Destination.
	if (c.kind === "day") {
		const path = deskMonthPath(host, c.date.slice(0, 7));
		const t = await load(path);
		if (t === null) throw new Error(`${c.date.slice(0, 7)} Desk Calendar가 아직 없어요. Desk Calendar에서 새 달을 만들거나 「미래로」를 골라 주세요.`);
		const r = appendLines(t, +c.date.slice(0, 4), +c.date.slice(5, 7), { kind: "day", date: c.date }, [forwardCopy(sl.line)]);
		if (!r.ok) throw new Error(`Desk Calendar에 ${c.date} 칸이 없어요.`);
		const u = touchUpdated(r.text, today);
		put(path, u.ok ? u.text : r.text);
	} else if (c.kind === "future") {
		if ((await io.read(deskMonthPath(host, c.month))) !== null) throw new Error(`${c.month}은(는) Desk Calendar가 이미 있는 달이에요. 「다른 날」로 날짜를 골라 주세요.`);
		const year = +c.month.slice(0, 4);
		const path = normalizePath(`${s.wallCalendarFolder}/${year}.md`);
		const t = (await load(path)) ?? wallYearSkeleton(year, today);
		put(path, setFrontmatterScalar(appendUnderWallMonth(t, c.month, forwardCopy(sl.line)), "updated", today));
	} else if (c.kind === "drawer") {
		const path = drawerPath(host);
		const t = (await load(path)) ?? drawerTemplate(today);
		const src = sourceDateOf(sl.line) ?? padDate;
		const r = putItem(t, { text: label, when: c.when, from: [`Daily Pad ${src}`], section: "보류", tags: sl.item?.tags, test: sl.item?.test }, today);
		if (!r.ok) throw new Error("Drawer에 넣지 못했어요. Drawer.md를 확인해 주세요.");
		put(path, r.text);
	}

	// 3. The original open line of the day it came from (when it is still open).
	const src = sourceDateOf(sl.line) ?? addDays(padDate, -1);
	const mark = (l: string) => markForChoice(l, c);
	const deskPath = deskMonthPath(host, src.slice(0, 7));
	const deskText = await load(deskPath);
	if (deskText !== null) {
		const r = markInDeskDay(deskText, src, key, mark);
		if (r.count) {
			const u = touchUpdated(r.text, today);
			put(deskPath, u.ok ? u.text : r.text);
		}
	}
	const srcPad = padPath(host, src);
	const srcText = await load(srcPad);
	if (srcText !== null) {
		const r = markInPadSection(srcText, s.sections.today, key, mark);
		if (r.count) put(srcPad, setFrontmatterScalar(r.text, "updated", today));
	}

	// 4. Daily Pad Index 「결정 대기」 row + change log.
	const index = normalizePath(`${s.dailyPadFolder}/${INDEX_FILE}`);
	const idx = await load(index);
	if (idx !== null) put(index, prependChangeLog(dropIndexRow(idx, key, s.sections.pending), today, describeChoice(label, c, moved)));

	const writes: Write[] = [...files].filter(([, v]) => v.before !== v.after).map(([path, v]) => ({ path, before: v.before, after: v.after }));
	await commitBatch(io, writes);
}
