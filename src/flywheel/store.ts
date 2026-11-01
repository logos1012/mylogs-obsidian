/**
 * Reading the wheel and planning its writes (v3, `12 Flywheel/AGENTS.md` 「3」「4」).
 *
 * Every change goes through `commitBatch` (`src/pinboard/batch.ts`): the hub, the registry
 * (`Flywheel.md` row + `elements` + 변경 기록) and anything else in one optimistic batch, so a
 * concurrent edit (Google Drive, Hermes) is never overwritten and nothing is half-saved.
 *
 * No Obsidian imports: the caller passes a reader / `BatchIO` (see `vaultIO`).
 */

import type { Write } from "../pinboard/batch.ts";
import { prependChangeLog } from "../desk/ops.ts";
import { setFrontmatterScalar } from "../writer.ts";
import { type FlywheelElement, FLYWHEEL_FILE, parseFlywheel } from "./model.ts";
import { countActive, setLogCell } from "./ops.ts";
import {
	appendRecord,
	elementOf,
	hubPathOf,
	hubSkeleton,
	isRegistry,
	type NewElementInput,
	nextElementId,
	parseRegistry,
	recordPath,
	recordSkeleton,
	type RegistryRow,
	setEvidence,
	upsertRegistryRow,
	wheelPurpose,
} from "./wheel.ts";

export interface Reader {
	read(path: string): Promise<string | null>;
}

export interface Wheel {
	root: string;
	path: string;
	text: string | null;
	purpose: string;
	/** Registry order (= wheel order). */
	elements: FlywheelElement[];
	/** false = the old one-file `Flywheel.md` (read only; run the migration). */
	registry: boolean;
}

export function wheelFile(root: string): string {
	return `${root}/${FLYWHEEL_FILE}`;
}
export function logPath(root: string, ym: string): string {
	return `${root}/99 작업실/수행/${ym}.md`;
}

export async function readWheel(io: Reader, root: string): Promise<Wheel> {
	const path = wheelFile(root);
	const text = await io.read(path);
	if (!isRegistry(text)) {
		const elements = parseFlywheel(text).map((e) => ({ ...e, folder: `${root}/${e.id} ${e.name}` }));
		return { root, path, text, purpose: wheelPurpose(text), elements, registry: false };
	}
	const rows = parseRegistry(text);
	const elements = await Promise.all(
		rows.map(async (r) => {
			const hubPath = r.link ? `${root}/${r.link}.md` : hubPathOf(root, r.name);
			return elementOf(r, await io.read(hubPath), hubPath);
		}),
	);
	return { root, path, text, purpose: wheelPurpose(text), elements, registry: true };
}

/** Elements counted in a 수행 표 (not 폐기), registry order. */
export function liveIds(w: Wheel): string[] {
	return w.elements.filter((e) => e.status !== "폐기").map((e) => e.id);
}

function rowOf(e: FlywheelElement, root: string): RegistryRow {
	const rel = e.hubPath.startsWith(root + "/") ? e.hubPath.slice(root.length + 1).replace(/\.md$/, "") : `${e.name}/${e.name}`;
	return { id: e.id, name: e.name, link: rel, status: e.status, goals: e.goals, since: e.since };
}

/** Registry text after a row change: row, `elements`, 변경 기록 (+ `updated`). */
function registryAfter(text: string, row: RegistryRow, what: string, today: string): string {
	let t = upsertRegistryRow(text, row);
	t = setFrontmatterScalar(t, "elements", String(parseRegistry(t).filter((r) => r.status !== "폐기").length));
	return prependChangeLog(t, today, what);
}

/**
 * Change one element: `hub` edits its hub text, `row` patches what the registry shows (computed from
 * the new hub when omitted). Returns the batch writes.
 */
export async function planElementChange(
	io: Reader,
	w: Wheel,
	e: FlywheelElement,
	what: string,
	today: string,
	o: { hub?: (t: string) => string; row?: Partial<RegistryRow> },
): Promise<Write[]> {
	if (!w.registry) throw new Error("Flywheel.md가 옛 형식이에요. 「Flywheel: 새 구조로 정리」를 먼저 실행해 주세요.");
	const reg = await io.read(w.path);
	if (reg === null) throw new Error("Flywheel.md가 없어요.");
	const writes: Write[] = [];
	let next = e;
	if (o.hub) {
		const before = await io.read(e.hubPath);
		if (before === null) throw new Error(`요소 허브가 없어요: ${e.hubPath}`);
		const after = o.hub(before);
		writes.push({ path: e.hubPath, before, after });
		next = elementOf(null, after, e.hubPath);
	}
	const row = { ...rowOf(next, w.root), ...(o.row ?? {}) };
	writes.push({ path: w.path, before: reg, after: registryAfter(reg, row, what, today) });
	return writes;
}

export interface NewElement extends Omit<NewElementInput, "id"> {}

/** A new element: folder + hub + registry row (요소 교체 in the change log). */
export async function planNewElement(io: Reader, w: Wheel, input: NewElement, today: string): Promise<{ id: string; writes: Write[]; folders: string[] }> {
	if (!w.registry || w.text === null) throw new Error("Flywheel.md가 옛 형식이거나 없어요.");
	const reg = await io.read(w.path);
	if (reg === null) throw new Error("Flywheel.md가 없어요.");
	if (w.elements.some((e) => e.name === input.name.trim())) throw new Error("같은 이름의 요소가 있어요.");
	const id = nextElementId(reg);
	const hubPath = hubPathOf(w.root, input.name.trim());
	if ((await io.read(hubPath)) !== null) throw new Error("같은 이름의 폴더가 이미 있어요.");
	const hub = hubSkeleton({ ...input, id, name: input.name.trim() }, today);
	const row: RegistryRow = { id, name: input.name.trim(), link: `${input.name.trim()}/${input.name.trim()}`, status: "사용", goals: input.goals ?? [], since: input.since };
	return {
		id,
		folders: [hubPath.slice(0, hubPath.lastIndexOf("/"))],
		writes: [
			{ path: hubPath, before: null, after: hub },
			{ path: w.path, before: reg, after: registryAfter(reg, row, `요소 교체: ${id} ${row.name} 추가`, today) },
		],
	};
}

/**
 * One day's 수행 표 cell (`x` · `-` · `쉼` · "" ) and, when `note` is given, its evidence line
 * (`null` removes it). The file is created when missing.
 */
export async function planDay(io: Reader, w: Wheel, e: FlywheelElement, iso: string, value: string, note?: string | null): Promise<{ write: Write; folder: string }> {
	const ym = iso.slice(0, 7);
	const path = logPath(w.root, ym);
	const before = await io.read(path);
	let after = setLogCell(before, ym, iso.slice(8, 10), e.id, value, liveIds(w));
	if (note !== undefined) after = setEvidence(after, iso, e.id, note);
	return { write: { path, before, after }, folder: path.slice(0, path.lastIndexOf("/")) };
}

/** Append one line to the element's record of that month (file from the skeleton when missing). */
export async function planRecord(io: Reader, e: FlywheelElement, iso: string, line: string): Promise<{ write: Write; folder: string }> {
	const path = recordPath(e, iso.slice(0, 7));
	const before = await io.read(path);
	const after = appendRecord(before ?? recordSkeleton(e, iso.slice(0, 7)), iso, line);
	return { write: { path, before, after }, folder: path.slice(0, path.lastIndexOf("/")) };
}

/** Elements counted as live for `elements:` in the old format (kept for callers). */
export { countActive };
