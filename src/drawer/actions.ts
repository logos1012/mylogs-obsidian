/**
 * Drawer vault operations: the 「4-1」 … 「4-5」 procedures of `06 Drawer/AGENTS.md` executed with the
 * pure transforms of `ops.ts` / `candidates.ts`, plus the destination writes of 「4-3」 꺼내기 through
 * the existing Daily Pad / Desk Calendar / Wall Calendar writers. Each file is changed with
 * `vault.process` (atomic read-modify-write); a stale line fails instead of guessing.
 */

import { hasWorkTag, withoutWorkTag } from "../side.ts";
import { type App, moment, normalizePath, Notice, TFile } from "obsidian";
import { deskMonthPath, logDeskChange } from "../desk/actions.ts";
import { appendUnderWallMonth, wallYearSkeleton } from "../desk/ops.ts";
import { todayIsoLocal } from "../desk/model.ts";
import { MAIN_SECTION_KEYS, type MyLogsSettings } from "../settings.ts";
import { addIndexChange, insertIntoDesk } from "../wall/edit.ts";
import { appendToSection, dailyPadSkeleton, setFrontmatterScalar } from "../writer.ts";
import { type Candidate, removeCandidate } from "./candidates.ts";
import { type DrawerItem, type DrawerSection } from "./model.ts";
import { deleteItem, destinationLine, type DrawerChange, drawerTemplate, type EditResult, editItem, markLetGo, markTakenOut, moveItem, type NewDrawerItem, putItem, type PutResult, refOf } from "./ops.ts";

export interface DrawerHost {
	app: App;
	settings: MyLogsSettings;
}

const CHANGED_NOTICE = "Drawer 파일이 바뀌었어요. 다시 그렸어요";
const WALL_INDEX_FILE = "Wall Calendar Index.md";

export function drawerPath(host: DrawerHost): string {
	return normalizePath(host.settings.drawerPath || "06 Drawer/Drawer.md");
}

export function fileAt(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (folder && !app.vault.getAbstractFileByPath(folder)) {
		try {
			await app.vault.createFolder(folder);
		} catch {
			// created concurrently
		}
	}
}

/** Create `Drawer.md` from the template (「3」). Refuses when it exists. */
export async function createDrawerFile(host: DrawerHost): Promise<TFile | null> {
	const path = drawerPath(host);
	if (fileAt(host.app, path)) return fileAt(host.app, path);
	try {
		await ensureFolder(host.app, path);
		const f = await host.app.vault.create(path, drawerTemplate(todayIsoLocal()));
		new Notice(`${path}을(를) 만들었어요.`);
		return f;
	} catch (err) {
		console.error("[MyLogs] Drawer create failed", err);
		new Notice(`MyLogs: 파일을 만들지 못했어요 (${path})`);
		return null;
	}
}

type AnyResult = EditResult | PutResult;

/**
 * Apply one transform to `Drawer.md`. Returns the transform's result (so callers see `merged`), or
 * null when the file is missing or the line had changed (a Notice is shown either way).
 */
export async function editDrawer<R extends AnyResult>(host: DrawerHost, fn: (text: string) => R): Promise<Extract<R, { ok: true }> | null> {
	const f = fileAt(host.app, drawerPath(host));
	if (!f) {
		new Notice(`Drawer 파일이 없어요: ${drawerPath(host)}`);
		return null;
	}
	let result: R | null = null;
	try {
		await host.app.vault.process(f, (text) => {
			const r = fn(text);
			result = r;
			return r.ok ? r.text : text;
		});
	} catch (err) {
		console.error("[MyLogs] Drawer write failed", err);
		new Notice("MyLogs: Drawer 파일에 쓰지 못했어요. 콘솔을 확인해 주세요.");
		return null;
	}
	const r = result as R | null;
	if (!r || !r.ok) {
		new Notice(r && "reason" in r && r.reason !== "line-changed" && r.reason !== "section-missing" ? `MyLogs: ${reasonText(r.reason)}` : CHANGED_NOTICE);
		return null;
	}
	return r as Extract<R, { ok: true }>;
}

function reasonText(reason: string): string {
	switch (reason) {
		case "empty-text":
			return "내용이 비어 있어요.";
		case "empty-why":
			return "놓아주는 이유가 비어 있어요.";
		case "not-active":
			return "이미 나간 줄이에요 ([>] 또는 [-]).";
		case "same-section":
			return "같은 섹션이에요.";
		default:
			return reason;
	}
}

// ───────────────────────── 「4-1」 넣기 ─────────────────────────

/** Put an item (dedupe inside). Reports a merge. */
export async function putIntoDrawer(host: DrawerHost, input: NewDrawerItem): Promise<Extract<PutResult, { ok: true }> | null> {
	const today = todayIsoLocal();
	const r = await editDrawer(host, (t) => putItem(t, input, today));
	if (!r) return null;
	if (r.merged) new Notice(`같은 항목 「${r.into.text}」이(가) ${r.into.section}에 이미 있어요. 출처를 보태고 reviewed를 오늘로 바꿨어요.`);
	else new Notice(`「${input.text.trim()}」을(를) ${input.section}에 넣었어요.`);
	return r;
}

// ───────────────────────── 「4-2」 섹션 옮기기 ─────────────────────────

export async function moveToSection(host: DrawerHost, it: DrawerItem, to: DrawerSection): Promise<boolean> {
	const r = await editDrawer(host, (t) => moveItem(t, refOf(it), to, todayIsoLocal()));
	if (r) new Notice(`「${it.text}」 ${it.section} → ${to}`);
	return !!r;
}

// ───────────────────────── 「4-4」 놓아주기 ─────────────────────────

export async function letGoItem(host: DrawerHost, it: DrawerItem, why: string): Promise<boolean> {
	const r = await editDrawer(host, (t) => markLetGo(t, refOf(it), why, todayIsoLocal()));
	if (!r) return false;
	// 「4-4」 2 / 「6」: My Life is 형식 미정, so the 「놓아준 일」 record can't be written yet.
	// TODO(08 My Life 형식 확정 후): write the same line to `08 My Life/Daily/YYYY-MM-DD.md` 「놓아준 일」.
	new Notice(`「${it.text}」을(를) 놓아줬어요. My Life 형식이 미정이어서 「놓아준 일」 기록은 남기지 못했어요.`, 8000);
	return true;
}

// ───────────────────────── 「4-5」 수정 · 삭제 ─────────────────────────

export async function editDrawerItem(host: DrawerHost, it: DrawerItem, c: DrawerChange): Promise<boolean> {
	const r = await editDrawer(host, (t) => editItem(t, refOf(it), c, todayIsoLocal()));
	if (r) new Notice(c.section && c.section !== it.section ? `「${(c.text ?? it.text).trim()}」 수정 · ${it.section} → ${c.section}` : `「${(c.text ?? it.text).trim()}」 수정`);
	return !!r;
}

export async function deleteDrawerItem(host: DrawerHost, it: DrawerItem): Promise<boolean> {
	const r = await editDrawer(host, (t) => deleteItem(t, refOf(it), todayIsoLocal()));
	if (r) new Notice(`「${it.text}」 줄을 지웠어요. 변경 기록에 「삭제」로 남아요.`);
	return !!r;
}

// ───────────────────────── 「4-3」 꺼내기 ─────────────────────────

/** `[>] … → [[destLink]]` + 「꺼냄」 (step 2–3). The destination must already have its line. */
export async function markTakenOutTo(host: DrawerHost, it: DrawerItem, destLink: string): Promise<boolean> {
	const r = await editDrawer(host, (t) => markTakenOut(t, refOf(it), destLink, todayIsoLocal()));
	return !!r;
}

/** Dry-run the Drawer-side mark so a stale card never writes half an operation. */
async function canMark(host: DrawerHost, it: DrawerItem): Promise<boolean> {
	const f = fileAt(host.app, drawerPath(host));
	if (!f) {
		new Notice(`Drawer 파일이 없어요: ${drawerPath(host)}`);
		return false;
	}
	const r = markTakenOut(await host.app.vault.read(f), refOf(it), "[[x]]", todayIsoLocal());
	if (!r.ok) new Notice(r.reason === "not-active" ? "이미 나간 줄이에요." : CHANGED_NOTICE);
	return r.ok;
}

export function dailyPadPath(host: DrawerHost, date: string): string {
	return normalizePath(`${host.settings.dailyPadFolder}/${date.slice(0, 4)}/${date}.md`);
}

function linkOf(path: string): string {
	return `[[${path.replace(/\.md$/, "")}]]`;
}

/** 오늘 → Daily Pad 오늘 파일 `## 개인 할 일` / `## 회사 할 일` by the line's side (created like 「3-1」 when missing). */
export async function takeOutToday(host: DrawerHost, it: DrawerItem): Promise<boolean> {
	if (!(await canMark(host, it))) return false;
	const today = todayIsoLocal();
	const path = dailyPadPath(host, today);
	const s = host.settings;
	const raw = destinationLine(it);
	// A #회사 line goes to 회사 할 일 without its tag (the section is the mark there).
	const work = hasWorkTag(raw);
	const line = work ? withoutWorkTag(raw) : raw;
	const section = work ? s.sections.work : s.sections.today;
	try {
		let f = fileAt(host.app, path);
		if (!f) {
			await ensureFolder(host.app, path);
			const skeleton = dailyPadSkeleton({
				isoDate: today,
				weekday: moment(today, "YYYY-MM-DD").format("ddd"),
				deskCalendarFolder: s.deskCalendarFolder,
				sections: MAIN_SECTION_KEYS.map((k) => s.sections[k]),
			});
			f = await host.app.vault.create(path, skeleton);
			// TODO(04 Daily Pad 「7. 인덱스 규칙」): add the 「최근 날짜」 row in Daily Pad Index.md (index logic not built yet).
		}
		await host.app.vault.process(f, (t) => setFrontmatterScalar(appendToSection(t, section, line), "updated", today));
	} catch (err) {
		console.error("[MyLogs] Drawer → Daily Pad failed", err);
		new Notice(`MyLogs: ${path}에 쓰지 못했어요. Drawer는 바꾸지 않았어요.`);
		return false;
	}
	const ok = await markTakenOutTo(host, it, linkOf(path));
	new Notice(ok ? `「${it.text}」을(를) 오늘 할 일로 꺼냈어요.` : `오늘 할 일에는 적었지만 Drawer 줄을 [>]로 바꾸지 못했어요. Drawer.md를 확인해 주세요.`);
	return ok;
}

/**
 * 이달 / Wall의 달 → the month's Desk Calendar file `## 이달 중` when it exists, else the Wall
 * Calendar month (root 「5. 공통 규칙」 12-1). The folder's own index/change log is updated.
 */
export async function takeOutMonth(host: DrawerHost, it: DrawerItem, ym: string): Promise<boolean> {
	if (!/^\d{4}-\d{2}$/.test(ym)) return false;
	if (!(await canMark(host, it))) return false;
	const today = todayIsoLocal();
	const line = destinationLine(it);
	const deskPath = deskMonthPath(host, ym);
	const desk = fileAt(host.app, deskPath);
	let destLink: string;
	let where: string;
	try {
		if (desk) {
			let failed: string | null = null;
			await host.app.vault.process(desk, (t) => {
				const r = insertIntoDesk(t, line, null);
				if (!r.ok) {
					failed = r.reason;
					return t;
				}
				return setFrontmatterScalar(r.text, "updated", today);
			});
			if (failed) {
				new Notice(`${ym} Desk Calendar에 「## 이달 중」이 없어요. Drawer는 바꾸지 않았어요.`);
				return false;
			}
			await logDeskChange(host, `Drawer에서 꺼냄 「${it.text}」 → 이달 중`);
			destLink = linkOf(deskPath);
			where = `${ym} Desk Calendar 이달 중`;
		} else {
			const year = ym.slice(0, 4);
			const folder = host.settings.wallCalendarFolder || "02 Wall Calendar";
			const wallPath = normalizePath(`${folder}/${year}.md`);
			let wall = fileAt(host.app, wallPath);
			if (!wall) {
				await ensureFolder(host.app, wallPath);
				wall = await host.app.vault.create(wallPath, wallYearSkeleton(+year, today));
			}
			await host.app.vault.process(wall, (t) => setFrontmatterScalar(appendUnderWallMonth(t, ym, line), "updated", today));
			const idx = fileAt(host.app, `${folder}/${WALL_INDEX_FILE}`);
			if (idx) await host.app.vault.process(idx, (t) => addIndexChange(t, today, `Drawer에서 꺼냄 「${it.text}」 → ${ym}`));
			destLink = `[[${wallPath.replace(/\.md$/, "")}#${ym}]]`;
			where = `${ym} Wall Calendar`;
		}
	} catch (err) {
		console.error("[MyLogs] Drawer → month failed", err);
		new Notice("MyLogs: 달력 파일에 쓰지 못했어요. Drawer는 바꾸지 않았어요.");
		return false;
	}
	const ok = await markTakenOutTo(host, it, destLink);
	new Notice(ok ? `「${it.text}」을(를) ${where}(으)로 꺼냈어요.` : `${where}에는 적었지만 Drawer 줄을 [>]로 바꾸지 못했어요. Drawer.md를 확인해 주세요.`);
	return ok;
}

// ───────────────────────── 후보 (Daily Pad ## 결정 대기) ─────────────────────────

/** Remove a 후보 line from its Daily Pad (「3-6」 0 놓아주기, or after 넣기). */
export async function removeCandidateLine(host: DrawerHost, pad: TFile, cand: Candidate): Promise<boolean> {
	const today = todayIsoLocal();
	let failed: string | null = null;
	try {
		await host.app.vault.process(pad, (t) => {
			const r = removeCandidate(t, cand, today, host.settings.sections.pending);
			if (!r.ok) {
				failed = r.reason;
				return t;
			}
			return r.text;
		});
	} catch (err) {
		console.error("[MyLogs] Daily Pad write failed", err);
		new Notice(`MyLogs: ${pad.path}에 쓰지 못했어요.`);
		return false;
	}
	if (failed) {
		new Notice("Daily Pad의 결정 대기 줄이 그새 바뀌었어요. 다시 그렸어요.");
		return false;
	}
	// TODO(04 Daily Pad 「7. 인덱스 규칙」): remove the row from Daily Pad Index.md 「결정 대기」 (index logic not built yet).
	return true;
}

/** 넣기 + 분류 in one step (「4-1」 via 「7-5」): put, then take the line out of ## 결정 대기. */
export async function acceptCandidate(host: DrawerHost, pad: TFile, cand: Candidate, section: DrawerSection, when: string): Promise<boolean> {
	const r = await putIntoDrawer(host, { text: cand.text, when, from: cand.from, section, tags: cand.tags, test: cand.test });
	if (!r) return false;
	return removeCandidateLine(host, pad, cand);
}
