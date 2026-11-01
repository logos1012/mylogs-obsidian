/**
 * Flywheel writes inside Obsidian (v3): load the wheel, check a day, write a record line, create a
 * post, rename an element (folder · hub · record files through FileManager so links follow), and the
 * one-time 「새 구조로 정리」 migration. Every multi-file write is one `commitBatch`.
 */

import { type App, moment, normalizePath, TFile, TFolder } from "obsidian";
import { coverValue } from "./wheel.ts";
import type { MyLogsSettings } from "../settings.ts";
import { cleanFolder } from "../settings.ts";
import { commitBatch, type Write } from "../pinboard/batch.ts";
import { vaultIO } from "../pinboard/create-actions.ts";
import type { FlywheelElement } from "./model.ts";
import { planDay, planElementChange, planNewElement, planRecord, readWheel, type NewElement, type Wheel } from "./store.ts";
import {
	BAD_NAME_RE,
	blockIdOf,
	elementOf,
	linkMemoLine,
	nextBlockId,
	OUTPUT_DIR,
	RECORD_DIR,
	recordName,
	removeRecordEmbed,
	renameHub,
	setHubFm,
	unlinkMemoLine,
	WORK_DIR,
} from "./wheel.ts";
import { appendToSection, findSection, sectionLineRange } from "../writer.ts";

export interface Host {
	app: App;
	settings: MyLogsSettings;
}

export function wheelRoot(s: MyLogsSettings): string {
	return cleanFolder(s.flywheelPath) || "12 Flywheel";
}

export function todayIso(): string {
	return moment().format("YYYY-MM-DD");
}
export function nowHm(): string {
	return moment().format("HH:mm");
}

/** Fresh read (not cached) — for writes. */
export async function loadWheel(h: Host): Promise<Wheel> {
	return readWheel(vaultIO(h.app), wheelRoot(h.settings));
}

/** Cached read — for screens. */
export async function loadWheelCached(h: Host): Promise<Wheel> {
	const app = h.app;
	return readWheel(
		{
			read: async (path) => {
				const f = app.vault.getAbstractFileByPath(normalizePath(path));
				return f instanceof TFile ? app.vault.cachedRead(f) : null;
			},
		},
		wheelRoot(h.settings),
	);
}

async function commit(h: Host, writes: Write[], folders: string[] = []): Promise<void> {
	await commitBatch(vaultIO(h.app), writes, folders);
}

/**
 * One day's check (`x` 했음 · `-` 못 함 · `쉼` · "" 비움). `note`: the evidence line (`null` removes it,
 * `undefined` leaves it). A direct check from the screen has no evidence line (= 「직접」).
 */
export async function setDay(h: Host, e: FlywheelElement, iso: string, value: string, note?: string | null): Promise<void> {
	const w = await loadWheel(h);
	const { write, folder } = await planDay(vaultIO(h.app), w, e, iso, value, note);
	await commit(h, [write], [folder]);
}

export async function addRecordLine(h: Host, e: FlywheelElement, iso: string, line: string): Promise<void> {
	const { write, folder } = await planRecord(vaultIO(h.app), e, iso, line);
	await commit(h, [write], [folder]);
}

export async function changeElement(h: Host, e: FlywheelElement, what: string, o: Parameters<typeof planElementChange>[5]): Promise<void> {
	const w = await loadWheel(h);
	const fresh = w.elements.find((x) => x.id === e.id);
	if (!fresh) throw new Error("요소를 찾지 못했어요. 다시 열어 주세요.");
	await commit(h, await planElementChange(vaultIO(h.app), w, fresh, what, todayIso(), o));
}

export async function createElement(h: Host, input: NewElement): Promise<string> {
	if (BAD_NAME_RE.test(input.name)) throw new Error("이름에 쓸 수 없는 글자가 있어요.");
	const w = await loadWheel(h);
	const p = await planNewElement(vaultIO(h.app), w, input, todayIso());
	await commit(h, p.writes, p.folders);
	return p.id;
}

/** Set or clear an element's goals (hub `goals` + the registry's 목표 칸). */
export async function setElementGoals(h: Host, e: FlywheelElement, goals: string[], what: string): Promise<void> {
	await changeElement(h, e, what, { hub: (t) => setHubFm(t, "goals", goals, todayIso()) });
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const parts = normalizePath(path).split("/");
	for (let i = 1; i <= parts.length; i++) {
		const p = parts.slice(0, i).join("/");
		if (!app.vault.getAbstractFileByPath(p)) await app.vault.createFolder(p);
	}
}

/** Rename an element: folder, hub, record files (FileManager → links follow), then hub title and registry. */
export async function renameElement(h: Host, e: FlywheelElement, name: string): Promise<void> {
	const clean = name.trim();
	if (!clean || BAD_NAME_RE.test(clean)) throw new Error("이름에 쓸 수 없는 글자가 있어요.");
	if (clean === e.name) return;
	const w = await loadWheel(h);
	if (w.elements.some((x) => x.id !== e.id && x.name === clean)) throw new Error("같은 이름의 요소가 있어요.");
	await moveElementFiles(h, e, clean);
	const moved = await loadWheel(h);
	const hubPath = `${w.root}/${clean}/${clean}.md`;
	const cur = moved.elements.find((x) => x.id === e.id) ?? e;
	await commit(
		h,
		await planElementChange(vaultIO(h.app), moved, { ...cur, hubPath }, `${e.id} 이름 ${e.name} → ${clean}`, todayIso(), {
			hub: (t) => renameHub(t, clean, todayIso()),
			row: { name: clean, link: `${clean}/${clean}` },
		}),
	);
}

/** Folder `…/old` → `…/new`, hub `old.md` → `new.md`, records `old 기록 YYYY-MM` → `new 기록 YYYY-MM`. */
async function moveElementFiles(h: Host, e: FlywheelElement, name: string): Promise<void> {
	const app = h.app;
	const root = wheelRoot(h.settings);
	const folder = app.vault.getAbstractFileByPath(normalizePath(e.folder));
	const target = `${root}/${name}`;
	if (app.vault.getAbstractFileByPath(target) && e.folder !== target) throw new Error(`이미 있는 폴더예요: ${target}`);
	if (folder instanceof TFolder && e.folder !== target) await app.fileManager.renameFile(folder, target);
	const oldHubName = e.hubPath.slice(e.hubPath.lastIndexOf("/") + 1);
	const hub = app.vault.getAbstractFileByPath(`${target}/${oldHubName}`);
	if (hub instanceof TFile && hub.name !== `${name}.md`) await app.fileManager.renameFile(hub, `${target}/${name}.md`);
	const rec = app.vault.getAbstractFileByPath(`${target}/${RECORD_DIR}`);
	if (rec instanceof TFolder) {
		for (const f of [...rec.children]) {
			if (!(f instanceof TFile)) continue;
			const m = /^(.*) 기록 (\d{4}-\d{2})\.md$/.exec(f.name);
			if (m && m[1] !== name) await app.fileManager.renameFile(f, `${target}/${RECORD_DIR}/${recordName(name, m[2])}.md`);
		}
	}
}

/**
 * 「Flywheel: 새 구조로 정리」 (AGENTS v3.0, 2026-11-01): element folders lose their `F-N ` prefix,
 * and channel folders left in old element folders move to the element that lists that channel.
 * Empty old folders go to the trash. Returns what happened, line by line.
 */
export async function migrateFolders(h: Host): Promise<string[]> {
	const app = h.app;
	const log: string[] = [];
	let w = await loadWheel(h);
	if (!w.registry) throw new Error("Flywheel.md가 아직 옛 형식이에요. 지침 v3.0 「3-1」 형식으로 먼저 바꿔 주세요.");
	for (const e of w.elements) {
		const folderName = e.folder.slice(e.folder.lastIndexOf("/") + 1);
		if (folderName === e.name) continue;
		await moveElementFiles(h, e, e.name);
		w = await loadWheel(h);
		const cur = w.elements.find((x) => x.id === e.id)!;
		await commit(h, await planElementChange(vaultIO(app), w, { ...cur, hubPath: `${w.root}/${e.name}/${e.name}.md` }, `${e.id} 폴더 이름 정리 (${folderName} → ${e.name})`, todayIso(), { row: { link: `${e.name}/${e.name}` } }));
		log.push(`폴더 이름: ${folderName} → ${e.name}`);
		w = await loadWheel(h);
	}
	const root = app.vault.getAbstractFileByPath(w.root);
	if (root instanceof TFolder) {
		const owned = new Set(w.elements.map((e) => e.folder.normalize("NFC")));
		for (const old of [...root.children]) {
			if (!(old instanceof TFolder) || owned.has(old.path.normalize("NFC")) || !/^F-\d+ /.test(old.name)) continue;
			for (const ch of [...old.children]) {
				if (!(ch instanceof TFolder) || [RECORD_DIR, OUTPUT_DIR, WORK_DIR].includes(ch.name)) continue;
				const to = w.elements.find((e) => e.channels.some((c) => c.normalize("NFC") === ch.name.normalize("NFC")));
				if (!to) {
					log.push(`그대로 둠: ${ch.path} (이 채널을 가진 요소가 없어요)`);
					continue;
				}
				const dest = `${to.folder}/${OUTPUT_DIR}/${ch.name}`;
				if (app.vault.getAbstractFileByPath(dest)) {
					log.push(`그대로 둠: ${ch.path} (${dest}가 이미 있어요)`);
					continue;
				}
				const from = ch.path;
				await ensureFolder(app, `${to.folder}/${OUTPUT_DIR}`);
				await app.fileManager.renameFile(ch, dest);
				log.push(`옮김: ${from} → ${dest}`);
			}
			if (!old.children.length) {
				await app.vault.trash(old, true);
				log.push(`휴지통: ${old.path} (비어 있음)`);
			}
		}
	}
	if (!log.length) log.push("정리할 것이 없어요.");
	return log;
}

/** A new post (`02 산출물/{채널}/YYYY-MM-DD 제목.md`) or output (no channel). Adds a new channel to the hub. */
export async function createOutput(h: Host, e: FlywheelElement, channel: string, title: string, from: string[]): Promise<TFile> {
	const app = h.app;
	const t = title.trim();
	if (!t || BAD_NAME_RE.test(t)) throw new Error("제목에 쓸 수 없는 글자가 있어요.");
	if (channel && BAD_NAME_RE.test(channel)) throw new Error("채널 이름에 쓸 수 없는 글자가 있어요.");
	const today = todayIso();
	const dir = channel ? `${e.folder}/${OUTPUT_DIR}/${channel.trim()}` : `${e.folder}/${OUTPUT_DIR}`;
	const path = `${dir}/${today} ${t}.md`;
	if (app.vault.getAbstractFileByPath(path)) throw new Error("같은 이름의 파일이 있어요.");
	const fromYaml = from.length ? `[${from.map((x) => JSON.stringify(`[[${x}]]`)).join(", ")}]` : "[]";
	const body = channel ? `---\nfrom: ${fromYaml}\npublished:\nurl:\n---\n\n## 본문\n\n` : `---\nfrom: ${fromYaml}\n---\n\n`;
	await ensureFolder(app, dir);
	const f = await app.vault.create(path, body);
	if (channel && !e.channels.includes(channel.trim())) {
		await changeElement(h, e, `${e.id} 채널 추가: ${channel.trim()}`, { hub: (x) => setHubFm(x, "channels", [...e.channels, channel.trim()], today) });
	}
	return f;
}

/** Add one more `from` link to a post (no copy of the material). */
export async function addFrom(h: Host, post: TFile, anchor: string): Promise<void> {
	await h.app.fileManager.processFrontMatter(post, (fm: Record<string, unknown>) => {
		const cur = Array.isArray(fm.from) ? (fm.from as string[]) : fm.from ? [String(fm.from)] : [];
		const link = `[[${anchor}]]`;
		if (!cur.includes(link)) fm.from = [...cur, link];
	});
}

// ───────────────────────── Daily Pad 메모 잇기 (AGENTS 「3-6」) ─────────────────────────

/** The memo section's top-level lines (offset within the section body). */
export function memoLines(padText: string, section: string): { offset: number; line: string }[] {
	const sec = findSection(padText, section);
	if (!sec) return [];
	const { start, end } = sectionLineRange(padText, sec);
	const lines = padText.split(/\r?\n/);
	const out: { offset: number; line: string }[] = [];
	let fence = false;
	for (let i = start; i < end; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
		if (!fence && /^[-*+] /.test(lines[i])) out.push({ offset: i, line: lines[i] });
	}
	return out;
}

/**
 * Link (or unlink) a Daily Pad memo line to an element's record of that day: the memo keeps its text
 * and gets `(record:: [[…]]) ^fw-N`; the record gets `- ![[pad#^fw-N]]`. One batch.
 */
export async function linkMemo(h: Host, padPath: string, date: string, lineNo: number, expect: string, e: FlywheelElement, link: boolean): Promise<void> {
	const io = vaultIO(h.app);
	const pad = await io.read(padPath);
	if (pad === null) throw new Error("Daily Pad가 없어요.");
	const eol = pad.includes("\r\n") ? "\r\n" : "\n";
	const lines = pad.split(/\r?\n/);
	if (lines[lineNo] !== expect) throw new Error("메모가 그새 바뀌었어요. 다시 해 주세요.");
	const anchor = `${recordName(e.name, date.slice(0, 7))}#${date}`;
	const id = blockIdOf(expect) ?? nextBlockId(pad);
	const target = `${padPath.replace(/\.md$/, "")}#^${id}`;
	lines[lineNo] = link ? linkMemoLine(expect, anchor, id) : unlinkMemoLine(expect, anchor);
	const writes: Write[] = [{ path: padPath, before: pad, after: lines.join(eol) }];
	const folders: string[] = [];
	if (link) {
		const r = await planRecord(io, e, date, `- ![[${target}]]`);
		writes.push(r.write);
		folders.push(r.folder);
	} else {
		const { write } = await planRecord(io, e, date, "");
		if (write.before !== null) writes.push({ path: write.path, before: write.before, after: removeRecordEmbed(write.before, date, target) });
	}
	await commit(h, writes.filter((w) => w.before !== w.after), folders);
}

/** Append a memo line to Daily Pad 「메모」 (used by 「바퀴 기록으로 남기기」 from elsewhere). */
export function appendMemo(padText: string, section: string, line: string): string {
	return appendToSection(padText, section, line);
}

/** Hub text → element (for screens that already have the text). */
export { elementOf };

/** The element's card image as a resource URL, or null (no `cover`, or the file is gone). */
export function coverSrc(app: App, e: FlywheelElement): string | null {
	if (!e.cover) return null;
	const f = app.metadataCache.getFirstLinkpathDest(e.cover, e.hubPath) ?? app.vault.getAbstractFileByPath(normalizePath(e.cover));
	return f instanceof TFile ? app.vault.getResourcePath(f) : null;
}

export const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "avif"];

/** Set (path) or clear ("") the hub `cover`. */
export async function setCover(h: Host, e: FlywheelElement, path: string): Promise<void> {
	await changeElement(h, e, path ? `커버 이미지: ${e.id} ${e.name}` : `커버 이미지 뺌: ${e.id} ${e.name}`, { hub: (t) => setHubFm(t, "cover", coverValue(path), todayIso()) });
}
