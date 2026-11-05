/**
 * Daily Pad 「결정 대기」: ask, then write every affected file in one checked batch (`commitBatch`:
 * nothing is half-written; a file that changed meanwhile cancels the whole choice).
 * Rules: 04 Daily Pad AGENTS 「3-6」「3-7」; pure edits in `./ops.ts`.
 */

import { appendToSection } from "../writer.ts";
import { hasWorkTag, withoutWorkTag } from "../side.ts";
import { type App, normalizePath, Notice } from "obsidian";
import type { MyLogsSettings } from "../settings.ts";
import { addDays, type SourceLine } from "../parser.ts";
import { commitBatch, type Write } from "../pinboard/batch.ts";
import { exclusive, vaultIO } from "../pinboard/create-actions.ts";
import { deskMonthPath } from "../desk/actions.ts";
import { appendLines, appendUnderWallMonth, cleanFieldValue, movedCount, prependChangeLog, touchUpdated, wallYearSkeleton } from "../desk/ops.ts";
import {
	canDefer,
	deferCopy,
	deferLabel,
	deferMonth,
	type DeferTarget,
	describeDefer,
	letGoPadLine,
	locatePadLine,
	markPadDeferred,
	type PadLineRef,
	putDeskCopy,
	splitPadLine,
} from "./defer.ts";
import { askThirdMove, pickDate, pickMonth, promptText } from "../desk/modals.ts";
import { drawerPath } from "../drawer/actions.ts";
import { askWhen } from "../drawer/modals.ts";
import { drawerTemplate, putItem } from "../drawer/ops.ts";
import { findSection, sectionLineRange, setFrontmatterScalar, toggleCheckbox } from "../writer.ts";
import {
	appendSplitParts,
	checkInDeskDay,
	checkInPadSection,
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

/**
 * Which 할 일 section a 결정 대기 line came from: `#회사` → 회사; else the day it came from — found in
 * that Daily Pad's 회사 할 일 → 회사; otherwise 개인 (the side we protect).
 */
export async function pendingSide(host: PendingHost, padDate: string, sl: SourceLine): Promise<"개인" | "회사"> {
	if (hasWorkTag(sl.line)) return "회사";
	const src = sourceDateOf(sl.line) ?? addDays(padDate, -1);
	const t = await vaultIO(host.app).read(padPath(host, src));
	if (t === null) return "개인";
	const key = taskKey(sl.line);
	return markInPadSection(t, host.settings.sections.work, key, (l) => l).count ? "회사" : "개인";
}

/** 오늘 하기 in one tap (or a drop on 개인 / 회사 할 일): third postpone still asks first. */
export async function chooseToday(host: PendingHost, padDate: string, sl: SourceLine, side: "개인" | "회사", today: string): Promise<boolean> {
	const text = sl.item?.text ?? sl.line.trim();
	if (movedCount(sl.line) >= 2) {
		const a = await askThirdMove(host.app, text, movedCount(sl.line));
		if (a === "cancel") return false;
		if (a !== "proceed") return choosePending(host, padDate, sl, a === "letgo" ? "letgo" : "split", today);
	}
	const choice: PendingChoice = { kind: "today", date: padDate, side };
	try {
		await exclusive(host, () => applyPending(host, padDate, sl, choice, today));
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
		case "today":
			return `「${text}」을(를) 오늘 ${c.side} 할 일로 옮겼어요.`;
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
	let padAfter = c.kind === "split" ? appendSplitParts(removed.text, s.sections.today, c.parts) : removed.text;
	// 오늘 하기: the copy goes into this Daily Pad's 개인 / 회사 할 일 (the section is the side: no #회사).
	if (c.kind === "today") padAfter = appendToSection(padAfter, c.side === "회사" ? s.sections.work : s.sections.today, withoutWorkTag(forwardCopy(sl.line).replace(/\s*\(from::[^)]*\)/, "")));
	put(pad, padAfter);

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
		// The original is in 개인 할 일 or 회사 할 일.
		let t = srcText;
		let n = 0;
		for (const sec of [s.sections.today, s.sections.work]) {
			const r = markInPadSection(t, sec, key, mark);
			t = r.text;
			n += r.count;
		}
		if (n) put(srcPad, setFrontmatterScalar(t, "updated", today));
	}

	// 4. Daily Pad Index 「결정 대기」 row + change log.
	const index = normalizePath(`${s.dailyPadFolder}/${INDEX_FILE}`);
	const idx = await load(index);
	if (idx !== null) put(index, prependChangeLog(dropIndexRow(idx, key, s.sections.pending), today, describeChoice(label, c, moved)));

	const writes: Write[] = [...files].filter(([, v]) => v.before !== v.after).map(([path, v]) => ({ path, before: v.before, after: v.after }));
	await commitBatch(io, writes);
}

// ───────────────────────── 할 일 넘기기 (Daily Pad → Desk Calendar) ─────────────────────────

/** The three entries of the 넘기기 menu. */
export type DeferPick = "inbox" | "tomorrow" | "day";

/**
 * Daily Pad 「개인 할 일」 / 「회사 할 일」 → Desk Calendar: ask what is needed (third postpone: 의무 /
 * 가치 first; 「다른 날…」: the date), then write in one checked batch. Only today's or a later
 * Pad (an older day's open lines are 결정 대기's job). Returns true when the files were written.
 */
export async function chooseDefer(host: PendingHost, padDate: string, section: string, ref: PadLineRef, pick: DeferPick, today: string): Promise<boolean> {
	const app = host.app;
	const text = taskKey(ref.line);
	if (padDate < today) {
		new Notice("지난 날의 할 일은 다음 날 「결정 대기」에서 정해요.");
		return false;
	}
	const moved = movedCount(ref.line);
	if (moved >= 2) {
		const a = await askThirdMove(app, text, moved);
		if (a === "cancel") return false;
		if (a === "letgo" || a === "split") return finishThirdMove(host, padDate, section, ref, a, today);
	}
	let target: DeferTarget | null = null;
	if (pick === "inbox") target = { kind: "inbox", month: padDate.slice(0, 7) };
	else if (pick === "tomorrow") target = { kind: "day", date: addDays(padDate, 1) };
	else {
		const date = await pickDate(app, "다른 날로 넘기기", addDays(padDate, 1), `「${text}」을(를) 할 날을 골라요. Desk Calendar 그날 칸에 들어가요.`);
		if (!date) return false;
		if (date <= padDate) {
			new Notice("이 Daily Pad 날짜보다 뒤의 날을 골라 주세요.");
			return false;
		}
		target = { kind: "day", date };
	}
	try {
		await exclusive(host, () => deferPadTask(host, padDate, section, ref, target!, today));
	} catch (err) {
		console.error("[MyLogs] 할 일 넘기기 실패", err);
		new Notice(err instanceof Error ? err.message : String(err));
		return false;
	}
	new Notice(`「${text}」을(를) ${deferLabel(target)}(으)로 넘겼어요.`);
	return true;
}

/** Third postpone answered 놓아주기 / 쪼개기: only this Daily Pad line changes (+ the index log). */
async function finishThirdMove(host: PendingHost, padDate: string, section: string, ref: PadLineRef, a: "letgo" | "split", today: string): Promise<boolean> {
	const text = taskKey(ref.line);
	let why = "";
	let parts: string[] = [];
	if (a === "letgo") {
		why = (await promptText(host.app, "놓아주기", { desc: `「${text}」을(를) 하지 않기로 해요. 이유를 한 줄로 남겨요.`, placeholder: "예: 지금 목표와 관계없음", okText: "놓아주기" })) ?? "";
		if (!why.trim()) return false;
	} else {
		const v = await promptText(host.app, "쪼개기", {
			desc: `「${text}」을(를) 더 작은 다음 행동으로 나눠요. 한 줄에 하나씩 적어요. 이 줄 바로 아래에 들어가요.`,
			placeholder: "예: 자료 목록 만들기\n첫 단락 쓰기",
			multiline: true,
			okText: "쪼개기",
		});
		parts = (v ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
		if (!parts.length) return false;
	}
	try {
		await exclusive(host, async () => {
			const io = vaultIO(host.app);
			const pad = padPath(host, padDate);
			const before = await io.read(pad);
			if (before === null) throw new Error(`Daily Pad 파일이 없어요: ${pad}`);
			const r = a === "letgo" ? letGoPadLine(before, section, ref, why, today) : splitPadLine(before, section, ref, parts, today);
			if (!r.ok) throw new Error(PAD_LINE_CHANGED);
			const writes: Write[] = [{ path: pad, before, after: r.text }];
			const index = normalizePath(`${host.settings.dailyPadFolder}/${INDEX_FILE}`);
			const idx = await io.read(index);
			const what = a === "letgo" ? `${section} 「${text}」 놓아줌 (why:: ${cleanFieldValue(why)})` : `${section} 「${text}」 쪼갬 → ${parts.length}개`;
			if (idx !== null) writes.push({ path: index, before: idx, after: prependChangeLog(idx, today, what) });
			await commitBatch(io, writes);
		});
	} catch (err) {
		console.error("[MyLogs] 할 일 넘기기 실패", err);
		new Notice(err instanceof Error ? err.message : String(err));
		return false;
	}
	new Notice(a === "letgo" ? `「${text}」을(를) 놓아줬어요.` : `「${text}」을(를) ${parts.length}개로 쪼갰어요.`);
	return true;
}

const PAD_LINE_CHANGED = "Daily Pad의 그 줄이 그새 바뀌었어요. 화면을 다시 그렸어요.";

/**
 * Write a 넘기기: the Desk copy at the end of the target (인박스 / day cell), the Pad line
 * `[>] … → 보낸 곳 (moved:: n+1)`, and the Daily Pad Index change log — one `commitBatch`, so a
 * file Hermes (or sync) changed in the meantime cancels everything.
 */
export async function deferPadTask(host: PendingHost, padDate: string, section: string, ref: PadLineRef, target: DeferTarget, today: string): Promise<void> {
	const io = vaultIO(host.app);
	const s = host.settings;
	const pad = padPath(host, padDate);
	const padBefore = await io.read(pad);
	if (padBefore === null) throw new Error(`Daily Pad 파일이 없어요: ${pad}`);
	const idx = locatePadLine(padBefore, section, ref);
	if (idx === -1) throw new Error(PAD_LINE_CHANGED);
	const cur = padBefore.split(/\r?\n/)[idx];
	if (!canDefer(cur)) throw new Error("열린 할 일만 넘길 수 있어요 (완료·옮김·놓아줌·Flywheel 줄 제외).");
	const marked = markPadDeferred(padBefore, section, ref, target, today);
	if (!marked.ok) throw new Error(PAD_LINE_CHANGED);

	const ym = deferMonth(target);
	const deskPath = deskMonthPath(host, ym);
	const deskBefore = await io.read(deskPath);
	if (deskBefore === null) throw new Error(`${ym} Desk Calendar가 아직 없어요. Desk Calendar에서 새 달을 만든 뒤 다시 넘겨 주세요.`);
	const put = putDeskCopy(deskBefore, target, deferCopy(cur, section === s.sections.work), today);
	if (!put.ok) {
		if (put.reason === "duplicate") throw new Error(`${deferLabel(target)}에 같은 할 일이 이미 있어요. 넘기지 않았어요.`);
		throw new Error(target.kind === "inbox" ? `${ym} Desk Calendar에 인박스(## 이달 중)가 없어요.` : `${ym} Desk Calendar에 ${target.date} 칸이 없어요.`);
	}

	const writes: Write[] = [
		{ path: deskPath, before: deskBefore, after: put.text },
		{ path: pad, before: padBefore, after: marked.text },
	];
	const index = normalizePath(`${s.dailyPadFolder}/${INDEX_FILE}`);
	const idxText = await io.read(index);
	if (idxText !== null) writes.push({ path: index, before: idxText, after: prependChangeLog(idxText, today, describeDefer(taskKey(cur), section, target, movedCount(cur))) });
	await commitBatch(io, writes);
}

/**
 * A 결정 대기 line checked (or unchecked) in place: the same line on the day it came from — its
 * Desk Calendar day cell and that day's Daily Pad 「오늘 할 일」 — follows, and a done item leaves
 * the index 「결정 대기」 table. One checked batch. Returns the new state, or null when the line moved.
 */
export async function togglePending(host: PendingHost, padDate: string, sl: SourceLine, today: string): Promise<"done" | "open" | null> {
	return exclusive(host, async () => {
		const io = vaultIO(host.app);
		const s = host.settings;
		const files = new Map<string, { before: string; after: string }>();
		const load = async (path: string): Promise<string | null> => {
			const cur = files.get(path);
			if (cur) return cur.after;
			const t = await io.read(path);
			if (t !== null) files.set(path, { before: t, after: t });
			return t;
		};
		const put = (path: string, after: string) => {
			const cur = files.get(path);
			if (cur) cur.after = after;
		};

		const pad = padPath(host, padDate);
		const padText = await load(pad);
		const sec = padText === null ? null : findSection(padText, s.sections.pending);
		if (padText === null || !sec) return null;
		const r = toggleCheckbox(padText, { index: sl.index, line: sl.line, scope: sectionLineRange(padText, sec) });
		if (!r.ok) return null;
		const nowDone = /^\s*[-*+]\s+\[[xX]\]/.test(r.text.split(/\r?\n/)[sl.index] ?? "");
		put(pad, setFrontmatterScalar(r.text, "updated", today));

		const key = taskKey(sl.line);
		const [from, to] = nowDone ? [" ", "x"] : ["x", " "];
		const src = sourceDateOf(sl.line) ?? addDays(padDate, -1);
		const deskPath = deskMonthPath(host, src.slice(0, 7));
		const desk = await load(deskPath);
		if (desk !== null) {
			const c = checkInDeskDay(desk, src, key, from, to);
			if (c.count) {
				const u = touchUpdated(c.text, today);
				put(deskPath, u.ok ? u.text : c.text);
			}
		}
		const srcPad = padPath(host, src);
		if (srcPad !== pad) {
			const st = await load(srcPad);
			if (st !== null) {
				let t = st;
				let n = 0;
				for (const sec of [s.sections.today, s.sections.work]) {
					const c = checkInPadSection(t, sec, key, from, to);
					t = c.text;
					n += c.count;
				}
				if (n) put(srcPad, setFrontmatterScalar(t, "updated", today));
			}
		}
		if (nowDone) {
			const index = normalizePath(`${s.dailyPadFolder}/${INDEX_FILE}`);
			const idx = await load(index);
			if (idx !== null) {
				const dropped = dropIndexRow(idx, key, s.sections.pending);
				if (dropped !== idx) put(index, prependChangeLog(dropped, today, `결정 대기 「${sl.item?.text ?? key}」 완료 (원래 날 ${src}에도 반영)`));
			}
		}
		await commitBatch(io, [...files].filter(([, v]) => v.before !== v.after).map(([path, v]) => ({ path, before: v.before, after: v.after })));
		return nowDone ? "done" : "open";
	});
}
