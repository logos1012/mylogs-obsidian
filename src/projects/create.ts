/**
 * 「3-2. 새 프로젝트 만들기」 as a file plan: which folders and files to create, with what text,
 * and the registry row to add. The view only executes the plan.
 *
 * Visible items are exactly `01 초안/`, `02 산출물/`, the hub, `AGENTS.md` (+ `99 작업실/`);
 * the numbered places inside `99 작업실/` (10–80) are NOT created here — only when first needed.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { replaceSectionContent } from "../writer.ts";
import {
	ACTION_SECTION,
	DRAFT_DIR,
	KIND_PLACES,
	LOG_DIR,
	monthlyLogPath,
	type NewProjectInput,
	OUTPUT_DIR,
	STATE_SECTION,
	SUMMARY_SECTION,
	UNCONFIRMED,
	WORK_DIR,
	hubPath,
	logIndexPath,
} from "./model.ts";
import { type ActiveRow, actionSectionBody, formatLogEntry, newLogIndex, newMonthlyLog, PLUGIN_MARK, setFmValue, yamlScalar } from "./ops.ts";

/** The template files in `05 Project Folders/99 작업실/템플릿/`. */
export const TEMPLATE_FILES = {
	hub: "허브.md",
	agents: "AGENTS.md",
	logIndex: "로그 인덱스.md",
	monthlyLog: "월별 로그.md",
} as const;
export type TemplateKey = keyof typeof TEMPLATE_FILES;
export type Templates = Record<TemplateKey, string>;

export interface PlannedFile {
	path: string;
	content: string;
}

export interface CreationPlan {
	id: string;
	name: string;
	folder: string;
	/** Parents first. */
	folders: string[];
	files: PlannedFile[];
	row: ActiveRow;
	/** 등록부 「변경 기록」 line (without date). */
	change: string;
}

/** Template placeholders left over (`{{`, an id that is only `P-`, `YYYY-MM`). Empty = clean. */
export function leftoverPlaceholders(text: string): string[] {
	const out: string[] = [];
	if (text.includes("{{")) out.push("{{…}}");
	if (/^id:\s*["']?P-["']?\s*$/m.test(text)) out.push("id: P-");
	if (/YYYY-MM/.test(text.replace(/<!--[\s\S]*?-->/g, ""))) out.push("YYYY-MM");
	return out;
}

/** Hub from `템플릿/허브.md` (「3-2」 4, 「6. 허브 형식」). */
export function fillHub(template: string, i: NewProjectInput, today: string): string {
	const name = i.name.trim();
	let t = template.split("{{프로젝트명}}").join(name);
	t = setFmValue(t, "id", i.id.trim());
	t = setFmValue(t, "title", yamlScalar(name));
	t = setFmValue(t, "scope", i.scope);
	t = setFmValue(t, "area", yamlScalar(i.area));
	t = setFmValue(t, "kind", yamlScalar(i.kind));
	t = setFmValue(t, "status", "후보");
	t = setFmValue(t, "updated", today);
	t = replaceSectionContent(t, SUMMARY_SECTION, i.summary.trim());
	t = replaceSectionContent(t, ACTION_SECTION, actionSectionBody(i.action));
	for (const s of ["목표", "성공 기준", "비목표"]) t = replaceSectionContent(t, s, `- ${UNCONFIRMED}`);
	t = replaceSectionContent(t, STATE_SECTION, `- **단계:** ${UNCONFIRMED}`);
	return t;
}

/** Project `AGENTS.md` from `템플릿/AGENTS.md`; the 폴더 지도 marks the places this kind mainly uses. */
export function fillAgents(template: string, i: NewProjectInput, ym: string, today: string): string {
	const name = i.name.trim();
	let t = template.split("{{프로젝트명}}").join(name).replace(/YYYY-MM(?!-DD)/g, ym);
	t = setFmValue(t, "id", i.id.trim());
	t = setFmValue(t, "updated", today);
	const places = KIND_PLACES[i.kind] ?? [];
	return t
		.split("\n")
		.map((line) => {
			const m = /^(\|\s*`([^`]+)`\s*\|)([^|]*)(\|.*)$/.exec(line);
			if (!m) return line;
			const place = m[2].replace(`${WORK_DIR}/`, "");
			if (!places.includes(place) || m[3].trim()) return line;
			return `${m[1]} 예 ${m[4]}`;
		})
		.join("\n");
}

/** The whole plan (「3-2」 2–4, 7). `activeRoot` = `05 Project Folders`. */
export function planNewProject(i: NewProjectInput, templates: Templates, o: { activeRoot: string; today: string }): CreationPlan {
	const name = i.name.trim();
	const id = i.id.trim();
	const ym = o.today.slice(0, 7);
	const folder = `${o.activeRoot.replace(/^\/+|\/+$/g, "")}/${i.scope}/${name}`;
	const entry = formatLogEntry({
		date: o.today,
		title: "프로젝트 생성",
		context: i.summary.trim(),
		done: `폴더와 허브·AGENTS.md·로그 인덱스·월별 로그를 템플릿으로 만들고 등록부에 행 추가 (유형: ${i.kind})`,
		result: "status: 후보",
		decision: "새 프로젝트로 등록한다. 사용자 요청",
		open: "목표·성공 기준·비목표 미확인",
		next: i.action.trim() || UNCONFIRMED,
		evidence: "MyLogs 플러그인, 사용자 입력",
	});
	const files: PlannedFile[] = [
		{ path: hubPath(folder, name), content: fillHub(templates.hub, i, o.today) },
		{ path: `${folder}/AGENTS.md`, content: fillAgents(templates.agents, i, ym, o.today) },
		{ path: logIndexPath(folder, name), content: newLogIndex(templates.logIndex, { name, ym, today: o.today, recent: "프로젝트 생성" }) },
		{ path: monthlyLogPath(folder, name, ym), content: newMonthlyLog(templates.monthlyLog, name, ym, entry) },
	];
	const row: ActiveRow = {
		id,
		name,
		aliases: i.aliases
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean)
			.join(", "),
		scope: i.scope,
		area: i.area.trim(),
		kind: i.kind,
		status: "후보",
		action: i.action.trim() || UNCONFIRMED,
		goals: "",
		path: folder,
		updated: o.today,
	};
	return {
		id,
		name,
		folder,
		folders: [folder, `${folder}/${DRAFT_DIR}`, `${folder}/${OUTPUT_DIR}`, `${folder}/${WORK_DIR}`, `${folder}/${WORK_DIR}/${LOG_DIR}`],
		files,
		row,
		change: `${id} 새 프로젝트 「${name}」 생성 (${i.scope}, ${i.kind}) ${PLUGIN_MARK}`,
	};
}
