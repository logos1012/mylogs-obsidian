/**
 * Everything the Flywheel screens show, read once (cached reads): the wheel, the last 4 weeks of
 * 수행 표 + evidence, this and last month's records, each element's files, post `from` links, goal
 * titles and the projects that came out of an element.
 */

import { type App, moment, normalizePath, TFile } from "obsidian";
import { addDays } from "../parser.ts";
import { cleanFolder } from "../settings.ts";
import type { FlywheelElement } from "./model.ts";
import { type DayMark, dayMark, parseLogTable } from "./ops.ts";
import { logPath, type Wheel } from "./store.ts";
import { type Host, loadWheelCached, todayIso } from "./actions.ts";
import {
	anchorKey,
	type CheckSource,
	classifyFiles,
	type ElementFile,
	evidenceQuote,
	evidenceTime,
	type Material,
	materialsOf,
	parseEvidence,
	parseRecord,
	type RecordDay,
	recordPath,
	sourceOf,
} from "./wheel.ts";

export const DAYS = 28;

export interface ElementStats {
	e: FlywheelElement;
	today: DayMark;
	source: CheckSource;
	time: string;
	quote: string;
	/** The 7 days ending today. */
	last7: { iso: string; mark: DayMark }[];
	missed2: boolean;
	/** This month's record days / lines. */
	recDays: number;
	recLines: number;
	lastLine: { date: string; text: string } | null;
	/** Record days of this and last month, newest first. */
	days: { ym: string; day: RecordDay }[];
	files: ElementFile[];
	drafts: ElementFile[];
	outputs: ElementFile[];
	materials: Material[];
	projects: { id: string; title: string; path: string; status: string }[];
}

export interface ScreenData {
	wheel: Wheel;
	today: string;
	/** Oldest → newest, the last 28 days. */
	dates: string[];
	cell: (iso: string, id: string) => string | undefined;
	evidence: Map<string, string>;
	stats: Map<string, ElementStats>;
	materials: Material[];
	/** `name#date` anchors some post's `from` points at. */
	used: Map<string, string>;
	published: Set<string>;
	goals: Map<string, string>;
}

function fm(app: App, f: TFile): Record<string, unknown> {
	return (app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) ?? {};
}

export function markOf(d: Pick<ScreenData, "cell">, e: FlywheelElement, iso: string): DayMark {
	return dayMark(e, iso, null, d.cell(iso, e.id));
}

export async function loadScreen(h: Host): Promise<ScreenData> {
	const app = h.app;
	const wheel = await loadWheelCached(h);
	const today = todayIso();
	const dates = Array.from({ length: DAYS }, (_, i) => addDays(today, i - (DAYS - 1)));
	const read = async (path: string) => {
		const f = app.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? app.vault.cachedRead(f) : null;
	};
	const months = [...new Set([...dates.map((d) => d.slice(0, 7)), today.slice(0, 7)])];
	const tables = new Map<string, Map<string, Map<string, string>>>();
	const evidence = new Map<string, string>();
	for (const ym of months) {
		const t = await read(logPath(wheel.root, ym));
		tables.set(ym, parseLogTable(t));
		for (const [k, v] of parseEvidence(t)) evidence.set(k, v);
	}
	const cell = (iso: string, id: string) => tables.get(iso.slice(0, 7))?.get(iso.slice(8, 10))?.get(id);
	const base = { cell };

	// Files under the Flywheel folder, posts' `from` and published state.
	const all = app.vault.getFiles().filter((f) => f.path.startsWith(wheel.root + "/"));
	const paths = all.map((f) => f.path);
	const used = new Map<string, string>();
	const published = new Set<string>();
	for (const f of all) {
		if (f.extension !== "md" || !f.path.includes("/02 산출물/")) continue;
		const m = fm(app, f);
		if (m.published) published.add(f.path);
		const from = Array.isArray(m.from) ? (m.from as unknown[]) : m.from ? [m.from] : [];
		for (const x of from) used.set(anchorKey(String(x)), f.basename);
	}
	// Goal titles (Pinboard) and projects that name an element in `flywheel`.
	const goals = new Map<string, string>();
	const pinRoot = cleanFolder(h.settings.pinboardFolder);
	const projects = new Map<string, { id: string; title: string; path: string; status: string }[]>();
	for (const f of app.vault.getMarkdownFiles()) {
		const m = fm(app, f);
		if (f.path.startsWith(pinRoot + "/") && typeof m.id === "string") goals.set(m.id, String(m.title ?? m.id));
		if (m.type === "project" && m.flywheel) {
			const ids = Array.isArray(m.flywheel) ? (m.flywheel as unknown[]).map(String) : String(m.flywheel).split(/[,\s]+/);
			for (const id of ids) {
				const list = projects.get(id) ?? [];
				list.push({ id: String(m.id ?? ""), title: String(m.title ?? f.basename), path: f.path, status: String(m.status ?? "") });
				projects.set(id, list);
			}
		}
	}

	const ym = today.slice(0, 7);
	const prevYm = moment(today, "YYYY-MM-DD").subtract(1, "month").format("YYYY-MM");
	const stats = new Map<string, ElementStats>();
	const materials: Material[] = [];
	for (const e of wheel.elements) {
		const days: { ym: string; day: RecordDay }[] = [];
		for (const m of [ym, prevYm]) {
			const parsed = parseRecord(await read(recordPath(e, m)));
			for (const d of parsed) days.push({ ym: m, day: d });
			materials.push(...materialsOf(e, parsed, m));
		}
		days.sort((a, b) => b.day.date.localeCompare(a.day.date));
		const thisMonth = days.filter((d) => d.ym === ym);
		const latest = days.find((d) => d.day.lines.length);
		const lastLine = latest ? { date: latest.day.date, text: latest.day.lines[latest.day.lines.length - 1].text } : null;
		const mark = markOf(base, e, today);
		const ev = evidence.get(`${today}|${e.id}`);
		const last7 = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)).map((iso) => ({ iso, mark: markOf(base, e, iso) }));
		const files = e.folder ? classifyFiles(paths, e.folder) : [];
		const posts = files.filter((f) => f.kind === "post");
		stats.set(e.id, {
			e,
			today: mark,
			source: sourceOf(mark, ev),
			time: evidenceTime(ev),
			quote: evidenceQuote(ev),
			last7,
			missed2: [1, 2].every((n) => markOf(base, e, addDays(today, -n)) === "-"),
			recDays: thisMonth.filter((d) => d.day.lines.length).length,
			recLines: thisMonth.reduce((n, d) => n + d.day.lines.length, 0),
			lastLine,
			days,
			files,
			drafts: posts.filter((f) => !published.has(f.path)),
			outputs: [...posts.filter((f) => published.has(f.path)), ...files.filter((f) => f.kind === "output")],
			materials: [],
			projects: projects.get(e.id) ?? [],
		});
	}
	materials.sort((a, b) => b.date.localeCompare(a.date));
	for (const m of materials) stats.get(m.elementId)?.materials.push(m);
	return { wheel, today, dates, cell, evidence, stats, materials, used, published, goals };
}
