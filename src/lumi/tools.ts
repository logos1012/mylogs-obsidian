/**
 * 루미's MyLogs tools (계획 「루미」 P1): the same writes the screens make, through the same code, so
 * the files keep their formats whichever engine runs. Every run is recorded (`./recorder.ts`) and
 * can be undone from the conversation.
 *
 *   작은 일 — run at once, 「되돌리기」 on the card.
 *   큰 일 (`big`) — a card first; the write runs when the user presses 「넣기」.
 *
 * 루미 never deletes: no tool removes a line or a file.
 */

import { moment, normalizePath, TFile } from "obsidian";
import { z } from "zod";
import type { RecordingHost } from "./recorder.ts";
import { MAIN_SECTION_KEYS } from "../settings.ts";
import { findDaySection, parseBodyLines, splitLinesKeepEol, TASK_LINE_RE, toIsoDate } from "../parser.ts";
import { appendToSection, dailyPadSkeleton, findSection, sectionLineRange, setFrontmatterScalar, toggleCheckbox } from "../writer.ts";
import { togglePending } from "../pending/actions.ts";
import { changeProjectTask, loadProjectTasks, newTaskId, toggleLinkedProjectTask } from "../projects/task-actions.ts";
import { deskMonthPath, logDeskChange } from "../desk/actions.ts";
import { prependChangeLog, wallYearSkeleton } from "../desk/ops.ts";
import { addIndexChange, formatNewLine, insertIntoDesk, insertIntoMonth } from "../wall/edit.ts";
import { putIntoDrawer } from "../drawer/actions.ts";
import { DRAWER_SECTIONS, type DrawerSection } from "../drawer/model.ts";
import { createGoalFlow, readGoals, readProject } from "../pinboard/create-actions.ts";
import { inputProblems, type GoalInput } from "../pinboard/create.ts";
import { saveInlineGoal } from "../pinboard/inline-actions.ts";
import { INLINE_LABELS, inlineToken, type InlineGoalField } from "../pinboard/inline-edit.ts";
import { activeRoot, archiveRoot, changeStatus, createProject, registryPath } from "../projects/actions.ts";
import { hubLocation, KINDS, type NewProjectInput, type Project, SCOPES, validateInput } from "../projects/model.ts";
import { parseRegistry } from "../projects/ops.ts";
import { parseFrontmatterText } from "../pinboard/model.ts";
import { type FlywheelElement, flywheelPath, parseFlywheel } from "../flywheel/model.ts";
import { addElement, countActive, MAX_ELEMENTS, nextId, renameElement, REPLACEMENT_MARK, setElementField, setLogCell } from "../flywheel/ops.ts";

export interface ToolCtx {
	host: RecordingHost;
	today: string;
}

export interface CardPreview {
	title: string;
	lines: string[];
}

export interface LumiTool {
	name: string;
	/** For the AI (Korean). */
	description: string;
	shape: z.ZodRawShape;
	/** Shown first as a card; runs on 「넣기」. */
	big?: (args: Record<string, unknown>) => boolean;
	/** Big tools: check the input and describe the card (throws with what is missing). */
	preview?: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<CardPreview>;
	/** Do it; returns one Korean sentence of what was done. */
	run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<string>;
}

const PAD_SECTIONS = ["오늘 할 일", "결정 대기", "메모", "로그"] as const;
const SECTION_KEY: Record<(typeof PAD_SECTIONS)[number], "today" | "pending" | "memo" | "log"> = { "오늘 할 일": "today", "결정 대기": "pending", 메모: "memo", 로그: "log" };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

function padPath(ctx: ToolCtx, date: string): string {
	return normalizePath(`${ctx.host.settings.dailyPadFolder}/${date.slice(0, 4)}/${date}.md`);
}

function fileAt(ctx: ToolCtx, path: string): TFile | null {
	const f = ctx.host.app.vault.getAbstractFileByPath(normalizePath(path));
	return f instanceof TFile ? f : null;
}

async function ensureFolders(ctx: ToolCtx, filePath: string): Promise<void> {
	const parts = filePath.split("/").slice(0, -1);
	for (let i = 1; i <= parts.length; i++) {
		const p = parts.slice(0, i).join("/");
		if (!ctx.host.app.vault.getAbstractFileByPath(p)) await ctx.host.app.vault.createFolder(p);
	}
}

/** The day's Daily Pad, created with the 「3-1」 skeleton when missing. */
async function ensurePad(ctx: ToolCtx, date: string): Promise<TFile> {
	const path = padPath(ctx, date);
	const f = fileAt(ctx, path);
	if (f) return f;
	const s = ctx.host.settings;
	await ensureFolders(ctx, path);
	return ctx.host.app.vault.create(
		path,
		dailyPadSkeleton({ isoDate: date, weekday: moment(date, "YYYY-MM-DD").format("ddd"), deskCalendarFolder: s.deskCalendarFolder, sections: MAIN_SECTION_KEYS.map((k) => s.sections[k]) }),
	);
}

function normalizeForMatch(s: string): string {
	return s
		.replace(/\([a-z_]+::[^)]*\)/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

async function findProject(ctx: ToolCtx, id: string): Promise<{ p: Project; text: string }> {
	const host = ctx.host;
	const want = id.trim();
	for (const f of host.app.vault.getMarkdownFiles()) {
		if (!hubLocation(f.path, activeRoot(host), archiveRoot(host))) continue;
		const raw = parseFrontmatterText(await host.app.vault.read(f));
		if (raw.data.type !== "project") continue;
		const r = await readProject(host, f.path);
		if (r.p.id === want || r.p.name === want || r.p.title === want) return r;
	}
	throw new Error(`프로젝트를 찾지 못했어요: ${want}. 05 Project Folders/99 작업실/Project Folders Index.md에서 id를 확인해 주세요.`);
}

async function readWheel(ctx: ToolCtx): Promise<{ file: TFile; text: string; elements: FlywheelElement[] }> {
	const file = fileAt(ctx, flywheelPath(ctx.host.settings.flywheelPath));
	if (!file) throw new Error("Flywheel.md가 없어요. Flywheel 화면에서 바퀴를 먼저 만들어 주세요.");
	const text = await ctx.host.app.vault.read(file);
	return { file, text, elements: parseFlywheel(text) };
}

function findElement(elements: FlywheelElement[], key: string): FlywheelElement {
	const k = key.trim();
	const e = elements.find((x) => x.id === k) ?? elements.find((x) => x.name === k) ?? elements.find((x) => x.name.includes(k));
	if (!e) throw new Error(`Flywheel 요소를 찾지 못했어요: ${k}. 있는 요소: ${elements.map((x) => `${x.id} ${x.name}`).join(", ") || "없음"}`);
	return e;
}

/** Same write as the Flywheel screen: element count, `updated`, 「변경 기록」. */
async function writeWheel(ctx: ToolCtx, what: string, fn: (t: string) => string | null): Promise<void> {
	const { file } = await readWheel(ctx);
	let ok = false;
	await ctx.host.app.vault.process(file, (t) => {
		const next = fn(t);
		if (next === null) return t;
		ok = true;
		return prependChangeLog(setFrontmatterScalar(next, "elements", String(countActive(parseFlywheel(next)))), ctx.today, what);
	});
	if (!ok) throw new Error("Flywheel을 바꾸지 못했어요. 요소가 그새 바뀌었는지 확인해 주세요.");
}

function goalInput(a: Record<string, unknown>): GoalInput {
	const s = (k: string) => String(a[k] ?? "").trim();
	return { title: s("title"), area: s("area"), why: s("why"), measure: a.measure === "milestone" ? "milestone" : "metric", baseline: s("baseline"), current: s("current"), target: s("target"), unit: s("unit"), due: s("due") };
}

function projectPath(p: Project, rel: string): string {
	const clean = rel.replace(/\\/g, "/").replace(/^\/+/, "").trim();
	if (!clean || clean.split("/").some((x) => x === ".." || x === "." || !x)) throw new Error("파일 경로가 올바르지 않아요. 예: 01 초안/기획안.md");
	if (!clean.endsWith(".md")) throw new Error("마크다운(.md) 파일만 쓸 수 있어요.");
	const path = normalizePath(`${p.folder}/${clean}`);
	if (path === p.path || /(^|\/)AGENTS\.md$/.test(clean) || clean.startsWith("99 작업실/로그")) throw new Error("허브 · AGENTS.md · 로그는 루미가 직접 고치지 않아요. 해당 도구나 화면을 써 주세요.");
	return path;
}

export const LUMI_TOOLS: LumiTool[] = [
	{
		name: "pad_add",
		description: "Daily Pad에 한 줄 넣기. 오늘 할 일·결정 대기는 체크박스 할 일로, 메모는 한 줄로, 로그는 시각과 함께 들어간다. 날짜를 비우면 오늘. 그날 Daily Pad가 없으면 만든다.",
		shape: { section: z.enum(PAD_SECTIONS), text: z.string().min(1).describe("넣을 내용 한 줄 (태그 #회사 등 포함 가능)"), date: isoDate.optional() },
		async run(ctx, a) {
			const date = (a.date as string) || ctx.today;
			const section = a.section as (typeof PAD_SECTIONS)[number];
			const name = ctx.host.settings.sections[SECTION_KEY[section]];
			let text = oneLine(String(a.text)).replace(/^[-*+]\s+(\[.\]\s+)?/, "");
			if (section === "로그" && !/^\d{1,2}:\d{2}/.test(text)) text = `${moment().format("HH:mm")} ${text}`;
			const line = section === "오늘 할 일" || section === "결정 대기" ? `- [ ] ${text}` : `- ${text}`;
			const f = await ensurePad(ctx, date);
			await ctx.host.app.vault.process(f, (t) => setFrontmatterScalar(appendToSection(t, name, line), "updated", ctx.today));
			return `${date === ctx.today ? "" : `${date} `}${section}에 넣었어요: 「${short(text)}」`;
		},
	},
	{
		name: "pad_check",
		description: "그날 Daily Pad의 할 일(오늘 할 일·결정 대기)이나 Desk Calendar에서 온 그날 일을 완료로 체크하거나 체크를 푼다. text는 할 일 문구의 일부. 여러 줄이 맞으면 후보를 돌려주니 더 구체적으로 다시 부른다.",
		shape: { text: z.string().min(1), done: z.boolean().default(true), date: isoDate.optional() },
		async run(ctx, a) {
			const date = (a.date as string) || ctx.today;
			const want = normalizeForMatch(String(a.text));
			const done = a.done !== false;
			const s = ctx.host.settings;
			type Hit = { where: "pad" | "pending" | "desk"; path: string; index: number; line: string; scope: { start: number; end: number } };
			const hits: Hit[] = [];
			const all: string[] = [];
			const scan = (where: Hit["where"], path: string, text: string, range: { start: number; end: number }) => {
				const lines = splitLinesKeepEol(text);
				for (const sl of parseBodyLines(lines, range.start, range.end)) {
					const m = TASK_LINE_RE.exec(sl.line);
					if (!m) continue;
					all.push(sl.line.trim());
					const isDone = m[2] !== " ";
					if (isDone === done) continue;
					if (normalizeForMatch(sl.line).includes(want)) hits.push({ where, path, index: sl.index, line: sl.line, scope: range });
				}
			};
			const pad = fileAt(ctx, padPath(ctx, date));
			if (pad) {
				const t = await ctx.host.app.vault.read(pad);
				for (const [where, name] of [["pad", s.sections.today], ["pending", s.sections.pending]] as const) {
					const r = findSection(t, name);
					if (r) scan(where, pad.path, t, sectionLineRange(t, r));
				}
			}
			const desk = fileAt(ctx, deskMonthPath(ctx.host, date.slice(0, 7)));
			if (desk) {
				const t = await ctx.host.app.vault.read(desk);
				const day = findDaySection(t, date);
				if (day.found) scan("desk", desk.path, t, { start: day.start, end: day.end });
			}
			if (!hits.length) throw new Error(`${date}에 「${String(a.text)}」에 맞는 ${done ? "열린" : "완료된"} 할 일이 없어요. 그날 할 일: ${all.slice(0, 15).join(" / ") || "없음"}`);
			if (hits.length > 1) throw new Error(`여러 줄이 맞아요. 더 구체적으로 불러 주세요: ${hits.map((h) => h.line.trim()).join(" / ")}`);
			const h = hits[0];
			if (h.where === "pending") {
				const sl = parseBodyLines(splitLinesKeepEol(await ctx.host.app.vault.read(pad!)), h.index, h.index + 1)[0];
				const r = await togglePending(ctx.host, date, sl, ctx.today);
				if (!r) throw new Error("결정 대기 줄이 그새 바뀌었어요. 다시 시도해 주세요.");
			} else if (!(await toggleLinkedProjectTask(ctx.host, h.path, h.index, h.line, ctx.today))) {
				const f = fileAt(ctx, h.path)!;
				let ok = false;
				await ctx.host.app.vault.process(f, (t) => {
					const r = toggleCheckbox(t, { index: h.index, line: h.line, scope: h.scope });
					if (!r.ok) return t;
					ok = true;
					return h.where === "pad" ? setFrontmatterScalar(r.text, "updated", ctx.today) : r.text;
				});
				if (!ok) throw new Error("그 줄을 찾지 못했어요. 파일이 그새 바뀌었어요.");
			}
			const label = h.line.replace(TASK_LINE_RE, "$3").replace(/^\]\s*/, "");
			return `${done ? "완료로 체크했어요" : "체크를 풀었어요"}: 「${short(normalizeForMatch(label))}」`;
		},
	},
	{
		name: "schedule_add",
		description:
			"일정 넣기. date(YYYY-MM-DD)가 있으면 그날, month(YYYY-MM)만 있으면 그달 '이달 중'. 그달 Desk Calendar 파일이 있으면 Desk Calendar에, 없으면 Wall Calendar의 그달에 넣는다. kind: task(할 일) | event(행사·약속). time은 HH:MM.",
		shape: { text: z.string().min(1), kind: z.enum(["task", "event"]).default("task"), date: isoDate.optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), time: z.string().regex(/^\d{1,2}:\d{2}(~\d{1,2}:\d{2})?$/).optional() },
		async run(ctx, a) {
			const date = a.date as string | undefined;
			const ym = date?.slice(0, 7) ?? (a.month as string | undefined) ?? ctx.today.slice(0, 7);
			const text = oneLine(String(a.text)).replace(/^[-*+]\s+(\[.\]\s+)?/, "");
			const kind = a.kind === "event" ? "event" : "task";
			const time = (a.time as string | undefined) ?? "";
			const deskPath = deskMonthPath(ctx.host, ym);
			const desk = fileAt(ctx, deskPath);
			if (desk) {
				const head = time ? `${time} ` : "";
				const line = kind === "task" ? `- [ ] ${head}${text}` : `- ${head}${text}${!time && !/#행사/.test(text) ? " #행사" : ""}`;
				let fail: string | null = null;
				await ctx.host.app.vault.process(desk, (t) => {
					const r = insertIntoDesk(t, line, date ?? null);
					if (!r.ok) {
						fail = r.reason;
						return t;
					}
					return setFrontmatterScalar(r.text, "updated", ctx.today);
				});
				if (fail) throw new Error(fail === "no-day" ? `${ym} Desk Calendar에 ${date} 칸이 없어요.` : `${ym} Desk Calendar에 「이달 중」이 없어요.`);
				await logDeskChange(ctx.host, `루미: 「${text}」 → ${date ?? "이달 중"}`);
				return `${ym} Desk Calendar ${date ? date.slice(5).replace("-", "/") : "이달 중"}에 넣었어요: 「${short(text)}」`;
			}
			const [y, m] = ym.split("-").map(Number);
			const folder = ctx.host.settings.wallCalendarFolder || "02 Wall Calendar";
			const wallPath = normalizePath(`${folder}/${y}.md`);
			let wall = fileAt(ctx, wallPath);
			if (!wall) {
				await ensureFolders(ctx, wallPath);
				wall = await ctx.host.app.vault.create(wallPath, wallYearSkeleton(y, ctx.today));
			}
			const md = date ? `${date.slice(5, 7)}/${date.slice(8, 10)}${time ? ` ${time}` : ""}` : "";
			const line = formatNewLine({ kind, date: md, text });
			let fail = false;
			await ctx.host.app.vault.process(wall, (t) => {
				const r = insertIntoMonth(t, y, m, line);
				if (!r.ok) {
					fail = true;
					return t;
				}
				return setFrontmatterScalar(r.text, "updated", ctx.today);
			});
			if (fail) throw new Error(`Wall Calendar ${y}.md에 ${ym} 칸이 없어요.`);
			const idx = fileAt(ctx, `${folder}/Wall Calendar Index.md`);
			if (idx) await ctx.host.app.vault.process(idx, (t) => addIndexChange(t, ctx.today, `루미: 「${text}」 → ${date ?? ym}`));
			return `Wall Calendar ${ym}${date ? ` ${date.slice(5).replace("-", "/")}` : ""}에 넣었어요: 「${short(text)}」`;
		},
	},
	{
		name: "drawer_put",
		description: "지금은 아닌 일을 Drawer에 넣기. section: 보류 | 아이디어 | 프로젝트 후보. when은 다시 꺼낼 조건(예: '12월', '결재 끝나면'), 모르면 비운다. context는 한 줄 맥락(선택).",
		shape: { section: z.enum(DRAWER_SECTIONS), text: z.string().min(1), when: z.string().optional(), context: z.string().optional() },
		async run(ctx, a) {
			const r = await putIntoDrawer(ctx.host, { section: a.section as DrawerSection, text: oneLine(String(a.text)), when: String(a.when ?? ""), context: a.context ? String(a.context) : undefined, from: [`대화 ${ctx.today}`] });
			if (!r) throw new Error("Drawer에 넣지 못했어요.");
			return r.merged ? `Drawer에 이미 있던 「${short(r.into.text)}」에 출처를 더했어요` : `Drawer ${String(a.section)}에 넣었어요: 「${short(String(a.text))}」`;
		},
	},
	{
		name: "goal_create",
		description:
			"Pinboard에 목표 만들기(확인 카드). parent(상위 Main Goal id)가 없으면 Main Goal, 있으면 Sub Goal. measure: metric(숫자: baseline·current·target·unit) | milestone(target에 달성 조건). due는 YYYY-MM-DD. Sub Goal은 link_project(기존 프로젝트 id) 또는 link_flywheel(Flywheel 요소 id) 중 하나가 꼭 필요하다.",
		shape: {
			title: z.string(),
			area: z.string(),
			why: z.string().describe("왜 이 목표인가 (한두 문장)"),
			measure: z.enum(["metric", "milestone"]),
			baseline: z.string().default(""),
			current: z.string().default(""),
			target: z.string(),
			unit: z.string().default(""),
			due: isoDate,
			parent: z.string().optional().describe("상위 Main Goal id, 예: G-2026-01"),
			link_project: z.string().optional(),
			link_flywheel: z.string().optional(),
		},
		big: () => true,
		async preview(ctx, a) {
			const i = goalInput(a);
			const sub = !!a.parent;
			const problems = inputProblems(i, sub);
			if (sub && !a.link_project && !a.link_flywheel) problems.push("Sub Goal은 link_project 또는 link_flywheel이 필요해요.");
			const parent = sub ? (await readGoals(ctx.host)).find((x) => x.goal.id === a.parent && x.goal.type === "main-goal") : undefined;
			if (sub && !parent) problems.push(`상위 Main Goal이 없어요: ${String(a.parent)}`);
			const project = a.link_project ? (await findProject(ctx, String(a.link_project))).p.title : "";
			const element = a.link_flywheel ? findElement((await readWheel(ctx)).elements, String(a.link_flywheel)).name : "";
			if (problems.length) throw new Error(problems.join(" "));
			const measure = i.measure === "metric" ? `${i.baseline || "?"} → ${i.target}${i.unit ? ` ${i.unit}` : ""}` : i.target;
			return {
				title: `${sub ? "Sub Goal" : "Main Goal"} 만들기: ${i.title}`,
				lines: [`영역 · ${i.area}`, `왜 · ${i.why}`, `기준 · ${measure}`, `기한 · ${i.due}`, ...(parent ? [`상위 · ${parent.goal.title}`] : []), ...(project ? [`실행 · 프로젝트 「${project}」`] : []), ...(element ? [`실행 · Flywheel 「${element}」`] : [])],
			};
		},
		async run(ctx, a) {
			const i = goalInput(a);
			let execution;
			if (a.link_project) execution = { mode: "project" as const, path: (await findProject(ctx, String(a.link_project))).p.path };
			else if (a.link_flywheel) {
				const e = findElement((await readWheel(ctx)).elements, String(a.link_flywheel));
				execution = { mode: "flywheel" as const, id: e.id, previous: e.fields.goal ?? "" };
			}
			const g = await createGoalFlow(ctx.host, { input: i, execution }, Number(i.due.slice(0, 4)) || Number(ctx.today.slice(0, 4)), a.parent ? String(a.parent) : undefined, ctx.today);
			return `목표를 만들었어요: ${g.id} 「${g.title}」`;
		},
	},
	{
		name: "goal_update",
		description: `목표 한 칸 고치기(진행 값 갱신 등). field: ${Object.entries(INLINE_LABELS)
			.map(([k, v]) => `${k}(${v})`)
			.join(", ")}. 숫자 목표의 진행은 current를 고친다.`,
		shape: { goal_id: z.string(), field: z.enum(Object.keys(INLINE_LABELS) as [InlineGoalField, ...InlineGoalField[]]), value: z.string() },
		async run(ctx, a) {
			const found = (await readGoals(ctx.host)).find((x) => x.goal.id === String(a.goal_id).trim());
			if (!found) throw new Error(`목표를 찾지 못했어요: ${String(a.goal_id)}`);
			const field = a.field as InlineGoalField;
			const g = await saveInlineGoal(ctx.host, found.goal, field, inlineToken(found.text, field), String(a.value), ctx.today);
			return `${g.id} 「${g.title}」 ${INLINE_LABELS[field]}을(를) 고쳤어요: ${short(oneLine(String(a.value)))}`;
		},
	},
	{
		name: "project_create",
		description: `프로젝트 만들기(확인 카드). scope: ${SCOPES.join("|")}. kind: ${KINDS.join("|")}. id는 'P-' + 영문 소문자·숫자·하이픈(예: P-ai-film-policy). summary는 한 문장. action은 지금 가장 효과적인 한 가지 행동(선택).`,
		shape: { name: z.string(), summary: z.string(), scope: z.enum(SCOPES), area: z.string(), kind: z.enum(KINDS), id: z.string(), action: z.string().default(""), aliases: z.string().default("") },
		big: () => true,
		async preview(ctx, a) {
			const input = projectInput(a);
			const regFile = fileAt(ctx, registryPath(ctx.host));
			if (!regFile) throw new Error("프로젝트 등록부가 없어요.");
			const r = parseRegistry(await ctx.host.app.vault.read(regFile));
			const taken = [...r.active, ...r.done];
			const problems = validateInput(input, { ids: taken.map((p) => p.id), names: taken.map((p) => p.name) });
			if (problems.length) throw new Error(problems.join(" "));
			return { title: `프로젝트 만들기: ${input.name}`, lines: [`${input.scope} · ${input.kind} · ${input.area}`, input.summary, ...(input.action ? [`지금 할 한 가지 · ${input.action}`] : [])] };
		},
		async run(ctx, a) {
			const hub = await createProject(ctx.host, projectInput(a));
			if (!hub) throw new Error("프로젝트를 만들지 못했어요.");
			return `프로젝트를 만들었어요: 「${String(a.name)}」`;
		},
	},
	{
		name: "project_status",
		description: "프로젝트 상태 바꾸기: 후보 | 진행 | 대기 | 보류. 완료는 프로젝트 화면에서 회고와 함께 한다.",
		shape: { project: z.string().describe("프로젝트 id 또는 이름"), status: z.enum(["후보", "진행", "대기", "보류"]) },
		async run(ctx, a) {
			const { p } = await findProject(ctx, String(a.project));
			if (p.archived) throw new Error("보관된 프로젝트예요.");
			if (p.status === a.status) return `「${p.title}」은(는) 이미 ${p.status}이에요`;
			await changeStatus(ctx.host, p, String(a.status));
			return `「${p.title}」 상태: ${p.status} → ${String(a.status)}`;
		},
	},
	{
		name: "project_task_add",
		description:
			"프로젝트에 할 일 추가. date(YYYY-MM-DD)를 주면 그날로 배정되어 Desk Calendar 그날 칸(주 보기)에 들어가고, 없으면 프로젝트 허브의 「할 일」에 날짜 없이 남는다(주 보기의 '배정 안 된 일').",
		shape: { project: z.string().describe("프로젝트 id 또는 이름"), text: z.string().min(1), date: isoDate.optional() },
		async run(ctx, a) {
			const { p } = await findProject(ctx, String(a.project));
			if (p.archived) throw new Error("보관된 프로젝트예요.");
			const text = oneLine(String(a.text)).replace(/^[-*+]\s+(\[.\]\s+)?/, "");
			const id = newTaskId();
			await changeProjectTask(ctx.host, p, { kind: "add", text, id }, ctx.today);
			if (!a.date) return `「${p.title}」 할 일에 넣었어요(날짜 없음): 「${short(text)}」`;
			const fresh = await readProject(ctx.host, p.path);
			const task = (await loadProjectTasks(ctx.host, fresh.p, fresh.text)).find((t) => t.id === id);
			if (!task) throw new Error("방금 넣은 할 일을 찾지 못했어요.");
			await changeProjectTask(ctx.host, fresh.p, { kind: "schedule", task, target: { kind: "day", date: String(a.date) } }, ctx.today);
			return `「${p.title}」 할 일을 ${String(a.date).slice(5).replace("-", "/")}에 넣었어요: 「${short(text)}」`;
		},
	},
	{
		name: "project_write",
		description:
			"프로젝트 폴더 안에 글 쓰기(초안·정리·회의록 등). path는 프로젝트 폴더 기준 상대 경로(예: '01 초안/연구 계획안.md'). mode: new(새 파일) | append(끝에 덧붙이기) | replace(전체 바꾸기, 확인 카드). 허브·AGENTS.md·로그는 못 고친다.",
		shape: { project: z.string(), path: z.string(), content: z.string(), mode: z.enum(["new", "append", "replace"]).default("new") },
		big: (a) => a.mode === "replace",
		async preview(ctx, a) {
			const { p } = await findProject(ctx, String(a.project));
			const path = projectPath(p, String(a.path));
			if (!fileAt(ctx, path)) throw new Error("바꿀 파일이 없어요. mode를 new로 불러 주세요.");
			return { title: `「${p.title}」 ${String(a.path)} 전체 바꾸기`, lines: String(a.content).split("\n").filter((l) => l.trim()).slice(0, 6) };
		},
		async run(ctx, a) {
			const { p } = await findProject(ctx, String(a.project));
			if (p.archived) throw new Error("보관된 프로젝트예요.");
			const path = projectPath(p, String(a.path));
			const body = String(a.content).replace(/\r\n/g, "\n");
			const f = fileAt(ctx, path);
			const mode = a.mode ?? "new";
			if (mode === "new") {
				if (f) throw new Error("같은 이름의 파일이 있어요. 다른 이름을 쓰거나 append/replace로 불러 주세요.");
				await ensureFolders(ctx, path);
				await ctx.host.app.vault.create(path, body.endsWith("\n") ? body : `${body}\n`);
				return `「${p.title}」에 새 글을 썼어요: ${String(a.path)}`;
			}
			if (!f) throw new Error("파일이 없어요. mode를 new로 불러 주세요.");
			await ctx.host.app.vault.process(f, (t) => (mode === "append" ? `${t.replace(/\s*$/, "")}\n\n${body.trim()}\n` : body.endsWith("\n") ? body : `${body}\n`));
			return `「${p.title}」 ${String(a.path)}을(를) ${mode === "append" ? "덧붙였어요" : "바꿨어요"}`;
		},
	},
	{
		name: "flywheel_check",
		description: "오늘 Flywheel 요소를 했음(또는 취소)으로 수행 표에 표시. element는 요소 id(F-1) 또는 이름.",
		shape: { element: z.string(), done: z.boolean().default(true) },
		async run(ctx, a) {
			const { elements } = await readWheel(ctx);
			const e = findElement(elements, String(a.element));
			const month = ctx.today.slice(0, 7);
			const path = normalizePath(`${ctx.host.settings.flywheelPath}/99 작업실/수행/${month}.md`);
			const ids = elements.filter((x) => x.status !== "폐기").map((x) => x.id);
			const value = a.done === false ? "" : "x";
			const f = fileAt(ctx, path);
			if (f) await ctx.host.app.vault.process(f, (t) => setLogCell(t, month, ctx.today.slice(8, 10), e.id, value, ids));
			else {
				await ensureFolders(ctx, path);
				await ctx.host.app.vault.create(path, setLogCell(null, month, ctx.today.slice(8, 10), e.id, value, ids));
			}
			return value ? `오늘 「${e.name}」 했음으로 표시했어요` : `오늘 「${e.name}」 표시를 지웠어요`;
		},
	},
	{
		name: "flywheel_add",
		description: "Flywheel에 요소 추가(확인 카드). 반복할수록 내가 강해지고, 바쁜 날 2분 버전(min)이 있는 것만. identity는 '나는 매일 ~하는 사람이다'.",
		shape: { name: z.string(), identity: z.string().default(""), min: z.string(), normal: z.string().default(""), next: z.string().default("") },
		big: () => true,
		async preview(ctx, a) {
			const { elements } = await readWheel(ctx);
			if (countActive(elements) >= MAX_ELEMENTS) throw new Error(`요소는 ${MAX_ELEMENTS}개까지예요. 하나를 쉬거나 폐기한 뒤에 넣을 수 있어요.`);
			if (!String(a.name).trim() || !String(a.min).trim()) throw new Error("이름과 최소 행동이 필요해요.");
			return { title: `Flywheel 요소 추가: ${String(a.name)}`, lines: [String(a.identity), `최소 · ${String(a.min)}`, ...(a.normal ? [`보통 · ${String(a.normal)}`] : []), ...(a.next ? [`다음 · ${String(a.next)}`] : [])].filter(Boolean) };
		},
		async run(ctx, a) {
			const n = String(a.next ?? "").replace(/^→\s*/, "");
			let id = "";
			await writeWheel(ctx, `${REPLACEMENT_MARK}: ${String(a.name)} 추가 (루미)`, (t) => {
				if (countActive(parseFlywheel(t)) >= MAX_ELEMENTS) return null;
				id = nextId(t);
				return addElement(t, id, { name: String(a.name), identity: String(a.identity ?? ""), min: String(a.min), normal: String(a.normal ?? ""), next: n ? `→ ${n}` : "" }, ctx.today);
			});
			return `Flywheel에 ${id} 「${String(a.name)}」을(를) 넣었어요`;
		},
	},
	{
		name: "flywheel_update",
		description: "Flywheel 요소 한 칸 고치기. field: 이름 | 정체성 | 최소 | 보통 | 다음 | 상태(사용·쉼).",
		shape: { element: z.string(), field: z.enum(["이름", "정체성", "최소", "보통", "다음", "상태"]), value: z.string() },
		async run(ctx, a) {
			const e = findElement((await readWheel(ctx)).elements, String(a.element));
			const v = String(a.value).trim();
			const field = String(a.field);
			if (field === "상태" && v !== "사용" && v !== "쉼") throw new Error("상태는 사용 또는 쉼만 바꿀 수 있어요. 폐기는 Flywheel 화면에서 해요.");
			await writeWheel(ctx, `${e.id} ${e.name} ${field} 고침 (루미)`, (t) =>
				field === "이름" ? renameElement(t, e.id, v) : setElementField(t, e.id, field === "상태" ? "status" : field, field === "다음" && v && !v.startsWith("→") ? `→ ${v}` : v),
			);
			return `${e.id} 「${e.name}」 ${field}: ${short(v)}`;
		},
	},
];

function projectInput(a: Record<string, unknown>): NewProjectInput {
	const s = (k: string) => String(a[k] ?? "").trim();
	return { name: s("name"), summary: s("summary"), scope: s("scope") as NewProjectInput["scope"], area: s("area"), kind: s("kind"), id: s("id"), aliases: s("aliases"), action: s("action") };
}

export function todayIsoNow(): string {
	return toIsoDate(new Date());
}
