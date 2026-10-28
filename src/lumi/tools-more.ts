/**
 * 루미 tools for everything else the screens can do (2026-10-28: "화면에서 할 수 있는 일은 루미도").
 * Each one calls the same code as the screen's button, so files, links, registries and change logs
 * stay as the screen leaves them, and 「되돌리기」 works (the recording host). Destroying or closing
 * things (delete, complete, discard) shows a card first.
 *
 *   Projects   project_edit · project_complete · project_delete · project_milestone
 *   Goals      goal_progress (current · status · health · 진척 기록) · goal_link · goal_delete
 *   Calendars  desk_item (done · day · week · letgo · split · drawer · future · edit · delete · event cancel · side)
 *              wall_item (done · letgo · cancel · month · edit · delete · side · to Desk)
 *   Daily Pad  pending_choose (결정 대기 다섯 가지)
 *   Drawer     drawer_item (today · month · letgo · section · edit · delete)
 *   Toolbox    skill (status · run · discard · create)
 *   Mode       side_mode (개인 · 회사 · 전체, when the user asks)
 *   Vision     vision_card (add · edit · move · delete) · vision_affirmation (읽음은 flywheel_check)
 *
 * Not here on purpose: Diary body (the user's own words — 09 Diary AGENTS), My Life (Hermes writes it).
 */

import { normalizePath, TFile, type App } from "obsidian";
import { z } from "zod";
import type { LumiTool, ToolCtx } from "./tools.ts";
import { activeRoot, archiveRoot, aliasesOf, completeProject, deleteProject, editProject } from "../projects/actions.ts";
import { hubLocation, KINDS, type Project, SCOPES, type Scope } from "../projects/model.ts";
import { actionAsWritten } from "../projects/edit.ts";
import { saveMilestone } from "../projects/milestone-actions.ts";
import { readMilestones } from "../projects/milestones.ts";
import { connectFlywheel, connectProject, readGoals, readProject } from "../pinboard/create-actions.ts";
import { saveGoalFields } from "../pinboard/goal-actions.ts";
import { removeGoalsFromProjects } from "../projects/actions.ts";
import { parseFrontmatterText, type Goal, ENDED_STATUSES } from "../pinboard/model.ts";
import { flywheelPath, parseFlywheel } from "../flywheel/model.ts";
import { type DeskItem, findPairAlloc, isoWeekNo, mondayOf, type MonthData, parseMonthFile, parseMonthKey, shiftMonth } from "../desk/model.ts";
import { pairedCopies, planAssignWeek, planCancelEvent, planDelete, planDrawer, planEdit, planFuture, planLetGo, planMoveDay, planMoveWeek, planSetSide, planSplit, planToggle, type Plan } from "../desk/ops.ts";
import { deskMonthPath, runDeskPlan } from "../desk/actions.ts";
import { toggleLinkedProjectTask } from "../projects/task-actions.ts";
import { parseWallYear, type WallLine } from "../wall/parse.ts";
import { cancelWallEvent, cancelWallTask, deleteWallItem, deskLineFor, deskLink, editWallItem, type EditResult, insertIntoDesk, markSentToDesk, moveWallItem, setWallSide, toggleWallTask, type WallTarget } from "../wall/edit.ts";
import { applyPending, pendingSide } from "../pending/actions.ts";
import { parseBodyLines, splitLinesKeepEol, type SourceLine } from "../parser.ts";
import { findSection, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { parseDrawer, type DrawerItem, type DrawerSection } from "../drawer/model.ts";
import { deleteDrawerItem, editDrawerItem, letGoItem, moveToSection, takeOutMonth, takeOutToday } from "../drawer/actions.ts";
import { createSkill, discardSkill, loadToolbox, nextId, requestRun, setStatus } from "../toolbox/actions.ts";
import { SKILL_KINDS, SKILL_STATUSES, type Skill } from "../toolbox/model.ts";
import { lineSide, type Side } from "../side.ts";
import { moveCard, parseVisionBoard, setAffirmation, setCards, type VisionCard } from "../vision/model.ts";
import { editVisionBoard, visionFile } from "../vision/actions.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const ym = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);

/** One of several by text (exact, then part); several → the names, to ask again. */
function pick<T>(items: T[], want: string, text: (x: T) => string, what: string): T {
	const w = norm(want);
	const exact = items.filter((x) => norm(text(x)) === w);
	if (exact.length === 1) return exact[0];
	const part = items.filter((x) => norm(text(x)).includes(w));
	if (part.length === 1) return part[0];
	if (!part.length) throw new Error(`${what}을(를) 찾지 못했어요: ${want}`);
	throw new Error(`여러 ${what}이(가) 맞아요: ${part.slice(0, 8).map((x) => `「${text(x)}」`).join(", ")}. 더 구체적으로 불러 주세요.`);
}

async function projectBy(ctx: ToolCtx, want: string): Promise<{ p: Project; text: string }> {
	const host = ctx.host;
	const all: { p: Project; text: string }[] = [];
	for (const f of host.app.vault.getMarkdownFiles()) {
		const loc = hubLocation(f.path, activeRoot(host), archiveRoot(host));
		if (!loc) continue;
		const raw = parseFrontmatterText(await host.app.vault.read(f));
		if (raw.data.type !== "project") continue;
		const r = await readProject(host, f.path);
		if (r.p.id === want.trim()) return r;
		all.push(r);
	}
	return pick(all, want, (x) => x.p.title, "프로젝트");
}

async function goalBy(ctx: ToolCtx, want: string): Promise<{ goal: Goal; text: string }> {
	const all = await readGoals(ctx.host);
	const id = all.find((x) => x.goal.id === want.trim());
	return id ?? pick(all, want, (x) => x.goal.title, "목표");
}

// ───────────────────────── Desk / Wall plan runner ─────────────────────────

async function execDesk(ctx: ToolCtx, plan: Plan): Promise<void> {
	await runDeskPlan(ctx.host, plan, "루미");
}

/** The Desk months around `month` (the view's -1 / 0 / +1). */
async function deskMonths(ctx: ToolCtx, month: string): Promise<MonthData[]> {
	const out: MonthData[] = [];
	for (const n of [-1, 0, 1]) {
		const key = shiftMonth(month, n);
		const f = ctx.host.app.vault.getAbstractFileByPath(deskMonthPath(ctx.host, key));
		if (!(f instanceof TFile)) continue;
		const p = parseMonthKey(key)!;
		out.push(parseMonthFile(await ctx.host.app.vault.read(f), p.year, p.month));
	}
	return out;
}

function deskItemsOf(md: MonthData): DeskItem[] {
	return [...md.during, ...[...md.weeks.values()].flatMap((w) => w.alloc ?? []), ...[...md.days.values()].flat()].filter((x) => x.item.kind !== null);
}

async function wallFile(ctx: ToolCtx, year: number): Promise<TFile> {
	const f = ctx.host.app.vault.getAbstractFileByPath(normalizePath(`${ctx.host.settings.wallCalendarFolder}/${year}.md`));
	if (!(f instanceof TFile)) throw new Error(`${year}년 Wall Calendar가 없어요.`);
	return f;
}

async function wallApply(app: App, f: TFile, fn: (t: string) => EditResult): Promise<void> {
	let failed = "";
	await app.vault.process(f, (t) => {
		const r = fn(t);
		if (!r.ok) {
			failed = r.reason;
			return t;
		}
		return setFrontmatterScalar(r.text, "updated", new Date().toISOString().slice(0, 10));
	});
	if (failed) throw new Error(`Wall Calendar를 고치지 못했어요 (${failed}).`);
}

// ───────────────────────── tools ─────────────────────────

export const MORE_TOOLS: LumiTool[] = [
	// ── Projects ──
	{
		name: "project_edit",
		description: `프로젝트 정보 고치기(화면의 「수정」과 같다). 바꿀 칸만 준다: name(이름 — 폴더 · 허브 · 로그 · 목표 링크 · 등록부까지 함께 바뀐다), summary(한 문장 설명), scope(${SCOPES.join("|")} — 폴더가 옮겨진다), area(영역), kind(${KINDS.join("|")}), action(지금 가장 효과적인 한 가지 행동), aliases(다른 이름, 쉼표), goals(연결할 Sub Goal id, 쉼표 — 통째로 바뀐다).`,
		shape: { project: z.string(), name: z.string().optional(), summary: z.string().optional(), scope: z.enum(SCOPES).optional(), area: z.string().optional(), kind: z.enum(KINDS).optional(), action: z.string().optional(), aliases: z.string().optional(), goals: z.string().optional() },
		async run(ctx, a) {
			const { p } = await projectBy(ctx, String(a.project));
			if (p.archived) throw new Error("완료되어 보관된 프로젝트는 고치지 않아요.");
			const s = (k: string, now: string) => (a[k] === undefined ? now : String(a[k]));
			await editProject(ctx.host, p, {
				name: s("name", p.name),
				aliases: s("aliases", await aliasesOf(ctx.host, p)),
				summary: s("summary", p.summary),
				scope: s("scope", p.scope) as Scope,
				area: s("area", p.area),
				kind: s("kind", p.kind),
				action: s("action", actionAsWritten(p)),
				goals: s("goals", p.goals.join(", ")),
			});
			return `「${p.title}」을(를) 고쳤어요${a.name ? `: 이름 → 「${String(a.name)}」` : ""}.`;
		},
	},
	{
		name: "project_complete",
		description: "프로젝트 완료하고 보관(확인 카드). result는 한 줄 결과(필수). started / completed는 YYYY-MM-DD(비우면 허브의 시작일, 오늘).",
		shape: { project: z.string(), result: z.string().min(1), started: isoDate.optional(), completed: isoDate.optional() },
		big: () => true,
		async preview(ctx, a) {
			const { p } = await projectBy(ctx, String(a.project));
			return { title: `프로젝트 완료: ${p.title}`, lines: [`결과 · ${String(a.result)}`, "10 Archive Box/Projects로 보관해요. 목표 진척은 따로 확인해요."] };
		},
		async run(ctx, a) {
			const { p } = await projectBy(ctx, String(a.project));
			await completeProject(ctx.host, p, { result: String(a.result), started: String(a.started ?? p.started ?? ""), completed: String(a.completed ?? ctx.today) });
			return `「${p.title}」을(를) 완료하고 보관했어요.`;
		},
	},
	{
		name: "project_delete",
		description: "프로젝트 지우기(확인 카드). 폴더는 휴지통으로(복구 가능), 등록부 행과 목표 연결이 빠진다. 끝난 일이면 project_complete를 쓴다.",
		shape: { project: z.string() },
		big: () => true,
		async preview(ctx, a) {
			const { p } = await projectBy(ctx, String(a.project));
			return { title: `프로젝트 지우기: ${p.title}`, lines: ["폴더를 휴지통으로 보내요(복구 가능).", p.goals.length ? `연결된 목표 ${p.goals.join(", ")}에서 링크가 빠져요.` : "연결된 목표 없음"] };
		},
		async run(ctx, a) {
			const { p } = await projectBy(ctx, String(a.project));
			await deleteProject(ctx.host, p);
			return `「${p.title}」을(를) 휴지통으로 보냈어요.`;
		},
	},
	{
		name: "project_milestone",
		description: "프로젝트 마일스톤 다루기. action: add(text, due) | edit(milestone = 지금 이름, text / due) | done | undone | remove. due는 YYYY-MM-DD(\"\" = 미정). 마일스톤은 달력에 ◆로 보인다.",
		shape: { project: z.string(), action: z.enum(["add", "edit", "done", "undone", "remove"]), milestone: z.string().optional(), text: z.string().optional(), due: z.string().optional() },
		async run(ctx, a) {
			const { p, text } = await projectBy(ctx, String(a.project));
			const ms = readMilestones(text);
			const action = String(a.action);
			const expected = p.milestoneSource ?? "";
			if (action === "add") {
				if (!a.text) throw new Error("text를 주세요.");
				await saveMilestone(ctx.host, p, expected, { kind: "add", text: String(a.text), due: a.due === undefined ? undefined : String(a.due) }, ctx.today);
				return `「${p.title}」에 마일스톤 「${String(a.text)}」을(를) 넣었어요.`;
			}
			const m = pick(ms.items, String(a.milestone ?? ""), (x) => x.text, "마일스톤");
			const change =
				action === "edit"
					? { kind: "edit" as const, line: m.line, text: String(a.text ?? m.text), due: a.due === undefined ? undefined : String(a.due) }
					: action === "remove"
						? { kind: "remove" as const, line: m.line }
						: { kind: "check" as const, line: m.line, done: action === "done" };
			await saveMilestone(ctx.host, p, expected, change, ctx.today);
			return `마일스톤 「${m.text}」: ${action === "edit" ? "고쳤어요" : action === "remove" ? "뺐어요" : action === "done" ? "달성 확인" : "달성 취소"}.`;
		},
	},

	// ── Goals ──
	{
		name: "goal_progress",
		description: `목표의 진행 다루기(Pinboard 상세와 같다). current(숫자 목표의 현재 값), status(active | paused | 종료: ${ENDED_STATUSES.join(" | ")} — 종료는 사용자가 정한 것만), health(on-track | at-risk | off-track | "" 판단 없음 — 사용자가 확정한 것만), log(진척 기록 한 줄: log_text, log_value, verify 보고됨|확인됨, evidence). Main의 진행률과 Pinboard Index가 함께 바뀐다.`,
		shape: {
			goal: z.string().describe("목표 id 또는 이름"),
			current: z.string().optional(),
			status: z.enum(["active", "paused", ...ENDED_STATUSES] as [string, ...string[]]).optional(),
			health: z.enum(["on-track", "at-risk", "off-track", ""]).optional(),
			log_text: z.string().optional(),
			log_value: z.string().optional(),
			verify: z.enum(["보고됨", "확인됨"]).default("보고됨"),
			evidence: z.string().optional(),
		},
		async run(ctx, a) {
			const { goal } = await goalBy(ctx, String(a.goal));
			const g = await saveGoalFields(
				ctx.host,
				goal.id,
				{
					current: a.current === undefined ? undefined : String(a.current),
					status: a.status === undefined ? undefined : String(a.status),
					health: a.health === undefined ? undefined : String(a.health),
					log: a.log_text ? { date: ctx.today, text: String(a.log_text), value: a.log_value ? String(a.log_value) : "", health: a.health ? String(a.health) : "", verify: a.verify === "확인됨" ? "확인됨" : "보고됨", evidence: a.evidence ? String(a.evidence) : "" } : undefined,
				},
				ctx.today,
			);
			return `${g.id} 「${g.title}」: ${[a.current !== undefined && `현재 ${String(a.current)}`, a.status && `상태 ${String(a.status)}`, a.health !== undefined && `health ${String(a.health) || "—"}`, a.log_text && "진척 기록 추가"].filter(Boolean).join(", ")}${g.progress !== null ? ` (진행 ${g.progress}%)` : ""}.`;
		},
	},
	{
		name: "goal_link",
		description: "Sub Goal을 프로젝트나 Flywheel 요소와 잇거나 끊기. project(프로젝트 id 또는 이름) 또는 flywheel(요소 id 또는 이름) 하나, link: true(잇기) | false(끊기). 프로젝트 허브의 goals도 함께 바뀐다.",
		shape: { goal: z.string(), project: z.string().optional(), flywheel: z.string().optional(), link: z.boolean().default(true) },
		async run(ctx, a) {
			const { goal } = await goalBy(ctx, String(a.goal));
			const link = a.link !== false;
			if (a.project) {
				const { p } = await projectBy(ctx, String(a.project));
				await connectProject(ctx.host, goal, p.path, link, ctx.today);
				return `${goal.id} 「${goal.title}」 ${link ? "↔" : "✕"} 프로젝트 「${p.title}」`;
			}
			if (a.flywheel) {
				const f = ctx.host.app.vault.getAbstractFileByPath(normalizePath(flywheelPath(ctx.host.settings.flywheelPath)));
				if (!(f instanceof TFile)) throw new Error("Flywheel.md가 없어요.");
				const els = parseFlywheel(await ctx.host.app.vault.read(f));
				const e = els.find((x) => x.id === String(a.flywheel)) ?? pick(els, String(a.flywheel), (x) => x.name, "Flywheel 요소");
				await connectFlywheel(ctx.host, goal, e.id, e.fields.goal ?? "", link, ctx.today);
				return `${goal.id} 「${goal.title}」 ${link ? "↔" : "✕"} Flywheel 「${e.name}」`;
			}
			throw new Error("project 또는 flywheel을 주세요.");
		},
	},
	{
		name: "goal_delete",
		description: "목표 지우기(확인 카드). Main을 지우면 그 Sub Goal도 함께. 목표 노트는 휴지통으로(복구 가능), 연결된 프로젝트는 그대로 두고 연결만 끊는다. 끝난 목표면 지우지 말고 goal_progress로 종료한다.",
		shape: { goal: z.string() },
		big: () => true,
		async preview(ctx, a) {
			const { goal } = await goalBy(ctx, String(a.goal));
			const subs = (await readGoals(ctx.host)).filter((x) => x.goal.parent === goal.id);
			return { title: `목표 지우기: ${goal.id} ${goal.title}`, lines: [subs.length ? `하위 목표 ${subs.length}개도 함께` : "하위 목표 없음", "노트는 휴지통으로(복구 가능), 프로젝트는 남기고 연결만 끊어요."] };
		},
		async run(ctx, a) {
			const { goal } = await goalBy(ctx, String(a.goal));
			const all = await readGoals(ctx.host);
			const targets = goal.type === "main-goal" ? [goal, ...all.filter((x) => x.goal.parent === goal.id).map((x) => x.goal)] : [goal];
			const failures: string[] = [];
			await removeGoalsFromProjects(ctx.host, targets.map((t) => t.id), failures);
			for (const t of targets) {
				const f = ctx.host.app.vault.getAbstractFileByPath(t.path);
				if (f instanceof TFile) await ctx.host.app.vault.trash(f, true);
			}
			// The Main's rollup, when one of its Subs went.
			if (goal.type === "sub-goal") await saveGoalFields(ctx.host, goal.parent, {}, ctx.today).catch(() => failures.push(`${goal.parent} 집계`));
			return `${targets.map((t) => t.id).join(", ")}을(를) 휴지통으로 보냈어요${failures.length ? ` (확인 필요: ${failures.join(", ")})` : ""}. Pinboard Index의 행은 Pinboard 화면에서 정리돼요.`;
		},
	},

	// ── Desk Calendar ──
	{
		name: "desk_item",
		description:
			"Desk Calendar 줄 하나 다루기(Desk 화면의 메뉴와 같다). month(YYYY-MM, 비우면 이번 달), text(줄 내용 일부), date(그 날짜 칸의 줄만 — 같은 이름이 여러 칸에 있을 때). action: done | undone | day(date_to로 옮기기, 미룸 기록) | week(monday = 그 주 월요일: 인박스 → 주, 또는 다른 주로 옮기기 — 한 주에만) | letgo(why) | split(parts: 줄바꿈으로 나눈 작은 할 일) | drawer(when) | future(to_month: 먼 달 Wall로) | edit(new_text, time) | cancel_event | side(개인|회사) | delete(확인 카드).",
		shape: {
			month: ym.optional(),
			text: z.string(),
			date: isoDate.optional(),
			action: z.enum(["done", "undone", "day", "week", "letgo", "split", "drawer", "future", "edit", "cancel_event", "side", "delete"]),
			date_to: isoDate.optional(),
			monday: isoDate.optional(),
			why: z.string().optional(),
			parts: z.string().optional(),
			when: z.string().optional(),
			to_month: ym.optional(),
			new_text: z.string().optional(),
			time: z.string().optional(),
			side: z.enum(SCOPES).optional(),
		},
		big: (a) => a.action === "delete",
		async preview(ctx, a) {
			const { it } = await deskTarget(ctx, a);
			return { title: `Desk 줄 지우기: ${it.item.text}`, lines: [it.section === "day" ? `${it.date} 칸` : it.section === "alloc" ? "이번 주 할 일" : "인박스", "짝으로 이어진 → 표시도 함께 정리해요."] };
		},
		async run(ctx, a) {
			const { it, months } = await deskTarget(ctx, a);
			const today = ctx.today;
			const action = String(a.action);
			const name = it.item.text;
			if (action === "done" || action === "undone") {
				if ((it.item.status === "done") === (action === "done")) return `「${name}」은(는) 이미 그 상태예요.`;
				const path = deskMonthPath(ctx.host, it.file);
				if (await toggleLinkedProjectTask(ctx.host, path, it.index, it.line, today)) return `「${name}」 ${action === "done" ? "완료" : "완료 취소"} (프로젝트 할 일).`;
				await execDesk(ctx, planToggle(it, today));
				return `「${name}」 ${action === "done" ? "완료" : "완료 취소"}.`;
			}
			let plan: Plan;
			if (action === "day") {
				if (!a.date_to) throw new Error("date_to를 주세요.");
				if (it.section !== "day") throw new Error("날짜 칸의 줄만 다른 날로 옮겨요. 인박스·이번 주 줄은 week로 주에 놓아요.");
				plan = planMoveDay(it, String(a.date_to), findPairAlloc(it, months), today);
			} else if (action === "week") {
				if (!a.monday || mondayOf(String(a.monday)) !== String(a.monday)) throw new Error("monday에 그 주 월요일(YYYY-MM-DD)을 주세요.");
				const monday = String(a.monday);
				const no = isoWeekNo(monday);
				const fileKey = monday.slice(0, 7);
				const allocs = months.flatMap((m) => [...m.weeks.values()].flatMap((w) => w.alloc ?? []));
				if (it.section === "alloc") {
					const oldNo = it.monday ? isoWeekNo(it.monday) : 0;
					plan = planMoveWeek(it, months.flatMap((m) => m.during).find((x) => x.key === it.key && x.item.assignWeek.includes(oldNo)) ?? null, monday, no, fileKey, today);
				} else if (it.section === "during") {
					const old = it.item.assignWeek.length ? allocs.find((x) => x.key === it.key && x.monday && it.item.assignWeek.includes(isoWeekNo(x.monday))) : undefined;
					plan = old ? planMoveWeek(old, it, monday, no, fileKey, today) : planAssignWeek(it, monday, no, fileKey, today);
				} else throw new Error("날짜 칸의 줄은 day로 다른 날에 옮겨요.");
			} else if (action === "letgo") {
				if (!a.why) throw new Error("놓아주는 이유(why)를 한 줄 주세요.");
				plan = planLetGo(it, String(a.why), today);
			} else if (action === "split") {
				const parts = String(a.parts ?? "").split(/\r?\n|·/).map((x) => x.trim()).filter(Boolean);
				if (!parts.length) throw new Error("parts에 나눌 할 일을 주세요.");
				plan = planSplit(it, parts, today);
			} else if (action === "drawer") plan = planDrawer(it, normalizePath(ctx.host.settings.drawerPath), today, String(a.when ?? ""));
			else if (action === "future") {
				if (!a.to_month) throw new Error("to_month를 주세요.");
				const to = String(a.to_month);
				plan = planFuture(it, to, normalizePath(`${ctx.host.settings.wallCalendarFolder}/${to.slice(0, 4)}.md`), today);
			} else if (action === "edit") plan = planEdit(it, { text: a.new_text === undefined ? undefined : String(a.new_text), time: a.time === undefined ? undefined : String(a.time) }, pairedCopies(it, months), null, today);
			else if (action === "cancel_event") plan = planCancelEvent(it, today);
			else if (action === "side") plan = planSetSide(it, (String(a.side ?? "회사") as Side), pairedCopies(it, months), today);
			else plan = planDelete(it, months, today);
			await execDesk(ctx, plan);
			return `Desk: ${plan.what}`;
		},
	},

	// ── Wall Calendar ──
	{
		name: "wall_item",
		description:
			"Wall Calendar 줄 하나 다루기(Wall 화면의 메뉴와 같다). year(비우면 올해), month(1–12), text(줄 내용 일부). action: done | undone | letgo(why, 할 일) | cancel(행사 취소선) | move(to_month: 다른 달) | edit(new_text) | side(개인|회사) | to_desk(그달 Desk로 보내기) | delete(확인 카드). 지난달 줄은 기록이라 고치지 않는다.",
		shape: { year: z.number().int().optional(), month: z.number().int().min(1).max(12), text: z.string(), action: z.enum(["done", "undone", "letgo", "cancel", "move", "edit", "side", "to_desk", "delete"]), why: z.string().optional(), to_month: z.number().int().min(1).max(12).optional(), new_text: z.string().optional(), side: z.enum(SCOPES).optional() },
		big: (a) => a.action === "delete",
		async preview(ctx, a) {
			const { l } = await wallTarget(ctx, a);
			return { title: `Wall 줄 지우기: ${l.item.text}`, lines: ["기록을 남기지 않고 줄을 지워요. 놓아주기(letgo)나 취소(cancel)도 있어요."] };
		},
		async run(ctx, a) {
			const { l, f, year } = await wallTarget(ctx, a);
			const t: WallTarget = { month: l.month, index: l.index, line: l.line };
			const action = String(a.action);
			const name = l.item.text;
			if (action === "done" || action === "undone") {
				if ((l.item.status === "done") === (action === "done")) return `「${name}」은(는) 이미 그 상태예요.`;
				if (await toggleLinkedProjectTask(ctx.host, f.path, l.index, l.line, ctx.today)) return `「${name}」 ${action === "done" ? "완료" : "완료 취소"} (프로젝트 할 일).`;
				await wallApply(ctx.host.app, f, (x) => toggleWallTask(x, year, t));
			} else if (action === "letgo") {
				if (!a.why) throw new Error("why를 주세요.");
				await wallApply(ctx.host.app, f, (x) => cancelWallTask(x, year, t, String(a.why)));
			} else if (action === "cancel") await wallApply(ctx.host.app, f, (x) => cancelWallEvent(x, year, t));
			else if (action === "move") {
				if (!a.to_month) throw new Error("to_month를 주세요.");
				await wallApply(ctx.host.app, f, (x) => moveWallItem(x, year, t, Number(a.to_month)));
			} else if (action === "edit") {
				if (!a.new_text) throw new Error("new_text를 주세요.");
				await wallApply(ctx.host.app, f, (x) => editWallItem(x, year, t, { text: String(a.new_text) }));
			} else if (action === "side") await wallApply(ctx.host.app, f, (x) => setWallSide(x, year, t, String(a.side ?? "회사") as Side));
			else if (action === "to_desk") {
				const link = deskLink(ctx.host.settings.deskCalendarFolder, year, l.month);
				const desk = ctx.host.app.vault.getAbstractFileByPath(normalizePath(`${link}.md`));
				if (!(desk instanceof TFile)) throw new Error(`${link}.md가 없어요. Desk 달 파일을 먼저 만들어 주세요.`);
				const deskLine = deskLineFor(l.line.replace(/^\s*[-*+]\s+/, ""), l.item);
				const ymKey = `${year}-${String(l.month).padStart(2, "0")}`;
				const day = l.item.start && l.item.start.slice(0, 7) === ymKey ? l.item.start : null;
				let ok = false;
				await ctx.host.app.vault.process(desk, (d) => {
					const r = insertIntoDesk(d, deskLine, day);
					ok = r.ok;
					return r.ok ? setFrontmatterScalar(r.text, "updated", ctx.today) : d;
				});
				if (!ok) throw new Error(day ? `Desk Calendar에 ${day} 칸이 없어요.` : "Desk Calendar에 인박스(## 이달 중)가 없어요.");
				await wallApply(ctx.host.app, f, (x) => markSentToDesk(x, year, t, link));
			} else await wallApply(ctx.host.app, f, (x) => deleteWallItem(x, year, t));
			return `Wall ${year}-${String(l.month).padStart(2, "0")} 「${short(name)}」: ${action}`;
		},
	},

	// ── Daily Pad 결정 대기 ──
	{
		name: "pending_choose",
		description: "Daily Pad 「결정 대기」(지난날 못 한 일) 하나의 갈 곳 정하기. date(그 Daily Pad 날짜, 비우면 오늘), text(줄 일부). choice: today(오늘 할 일로 — side 개인|회사, 비우면 원래 있던 칸) | day(to_date) | future(to_month) | drawer(when) | split(parts: 줄바꿈) | letgo(why).",
		shape: { date: isoDate.optional(), text: z.string(), choice: z.enum(["today", "day", "future", "drawer", "split", "letgo"]), side: z.enum(SCOPES).optional(), to_date: isoDate.optional(), to_month: ym.optional(), when: z.string().optional(), parts: z.string().optional(), why: z.string().optional() },
		async run(ctx, a) {
			const date = String(a.date ?? ctx.today);
			const path = normalizePath(`${ctx.host.settings.dailyPadFolder}/${date.slice(0, 4)}/${date}.md`);
			const f = ctx.host.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) throw new Error(`${date} Daily Pad가 없어요.`);
			const text = await ctx.host.app.vault.read(f);
			const r = findSection(text, ctx.host.settings.sections.pending);
			if (!r) throw new Error(`${date}에는 결정 대기가 없어요.`);
			const range = sectionLineRange(text, r);
			const lines: SourceLine[] = parseBodyLines(splitLinesKeepEol(text), range.start, range.end).filter((x) => x.item?.kind === "task" && x.indent === 0);
			const sl = pick(lines, String(a.text), (x) => x.item!.text, "결정 대기 할 일");
			const c = String(a.choice);
			const choice =
				c === "today" ? { kind: "today" as const, date, side: (a.side ? String(a.side) : await pendingSide(ctx.host, date, sl)) as "개인" | "회사" }
				: c === "day" ? { kind: "day" as const, date: String(a.to_date ?? "") }
				: c === "future" ? { kind: "future" as const, month: String(a.to_month ?? "") }
				: c === "drawer" ? { kind: "drawer" as const, when: String(a.when ?? "") }
				: c === "split" ? { kind: "split" as const, parts: String(a.parts ?? "").split(/\r?\n|·/).map((x) => x.trim()).filter(Boolean) }
				: { kind: "letgo" as const, why: String(a.why ?? "") };
			if (choice.kind === "day" && !choice.date) throw new Error("to_date를 주세요.");
			if (choice.kind === "future" && !choice.month) throw new Error("to_month를 주세요.");
			if (choice.kind === "letgo" && !choice.why) throw new Error("why를 주세요.");
			if (choice.kind === "split" && !choice.parts.length) throw new Error("parts를 주세요.");
			await applyPending(ctx.host, date, sl, choice, ctx.today);
			return `결정 대기 「${sl.item!.text}」 → ${c}`;
		},
	},

	// ── Drawer ──
	{
		name: "drawer_item",
		description: "Drawer 항목 하나 다루기. text(항목 일부). action: today(오늘 Daily Pad로 꺼내기) | month(month = YYYY-MM: 그달 Desk 인박스로, Desk가 없으면 Wall) | letgo(why) | section(to: 보류|아이디어|프로젝트 후보) | edit(new_text, when, context) | delete(확인 카드).",
		shape: { text: z.string(), action: z.enum(["today", "month", "letgo", "section", "edit", "delete"]), month: ym.optional(), why: z.string().optional(), to: z.enum(["보류", "아이디어", "프로젝트 후보"]).optional(), new_text: z.string().optional(), when: z.string().optional(), context: z.string().optional() },
		big: (a) => a.action === "delete",
		async preview(ctx, a) {
			const it = await drawerTarget(ctx, String(a.text));
			return { title: `Drawer에서 지우기: ${it.text}`, lines: ["기록 없이 지워요. 하지 않기로 했다면 놓아주기(letgo)가 기록이 남아요."] };
		},
		async run(ctx, a) {
			const it = await drawerTarget(ctx, String(a.text));
			const action = String(a.action);
			let ok = true;
			if (action === "today") ok = await takeOutToday(ctx.host, it);
			else if (action === "month") ok = await takeOutMonth(ctx.host, it, String(a.month ?? ctx.today.slice(0, 7)));
			else if (action === "letgo") {
				if (!a.why) throw new Error("why를 주세요.");
				ok = await letGoItem(ctx.host, it, String(a.why));
			} else if (action === "section") ok = await moveToSection(ctx.host, it, String(a.to ?? "보류") as DrawerSection);
			else if (action === "edit") ok = await editDrawerItem(ctx.host, it, { text: a.new_text === undefined ? undefined : String(a.new_text), when: a.when === undefined ? undefined : String(a.when), context: a.context === undefined ? undefined : String(a.context) });
			else ok = await deleteDrawerItem(ctx.host, it);
			if (!ok) throw new Error("Drawer를 고치지 못했어요. Drawer.md가 바뀌었는지 확인해 주세요.");
			return `Drawer 「${short(it.text)}」: ${action}`;
		},
	},

	// ── Toolbox ──
	{
		name: "skill",
		description: `Toolbox 스킬 다루기. action: status(to: ${SKILL_STATUSES.filter((x) => x !== "폐기").join("|")}) | run(실행 요청 — Hermes가 실행) | discard(폐기, reason, 확인 카드) | create(kind ${SKILL_KINDS.join("|")}, purpose 하는 일 한 줄, trigger 수동|cron|…, schedule, output, notify).`,
		shape: { skill: z.string().optional().describe("스킬 이름 또는 id (create 때는 새 이름)"), action: z.enum(["status", "run", "discard", "create"]), to: z.enum(SKILL_STATUSES).optional(), reason: z.string().optional(), kind: z.enum(SKILL_KINDS).optional(), purpose: z.string().optional(), trigger: z.string().optional(), schedule: z.string().optional(), output: z.string().optional(), notify: z.string().optional() },
		big: (a) => a.action === "discard" || a.action === "create",
		async preview(ctx, a) {
			if (a.action === "create") return { title: `스킬 만들기: ${String(a.skill ?? "")}`, lines: [`${String(a.kind ?? "작업")} · ${String(a.purpose ?? "")}`, `실행 · ${String(a.trigger ?? "수동")} ${String(a.schedule ?? "")}`] };
			const s = await skillTarget(ctx, String(a.skill ?? ""));
			return { title: `스킬 폐기: ${s.name}`, lines: [`이유 · ${String(a.reason ?? "")}`] };
		},
		async run(ctx, a) {
			const action = String(a.action);
			if (action === "create") {
				if (!a.skill || !a.purpose) throw new Error("skill(이름)과 purpose를 주세요.");
				const d = await loadToolbox(ctx.host);
				const path = await createSkill(ctx.host, { kind: a.kind as never, name: String(a.skill), purpose: String(a.purpose), trigger: String(a.trigger ?? "수동"), schedule: String(a.schedule ?? ""), output: String(a.output ?? ""), notify: String(a.notify ?? "") }, await nextId(ctx.host, d));
				if (!path) throw new Error("스킬을 만들지 못했어요.");
				return `스킬 「${String(a.skill)}」을(를) 만들었어요.`;
			}
			const s = await skillTarget(ctx, String(a.skill ?? ""));
			if (action === "status") {
				if (!a.to) throw new Error("to를 주세요.");
				await setStatus(ctx.host, s, String(a.to));
				return `스킬 「${s.name}」 → ${String(a.to)}`;
			}
			if (action === "run") {
				if (!(await requestRun(ctx.host, s))) throw new Error("실행 요청을 남기지 못했어요.");
				return `스킬 「${s.name}」 실행을 요청했어요(Hermes가 실행).`;
			}
			if (!a.reason) throw new Error("reason을 주세요.");
			await discardSkill(ctx.host, s, { date: ctx.today, reason: String(a.reason) });
			return `스킬 「${s.name}」을(를) 폐기했어요.`;
		},
	},

	// ── Mode ──
	{
		name: "side_mode",
		description: "개인 / 회사 / 전체 모드 바꾸기. 사용자가 바꿔 달라고 할 때만 쓴다(모드는 사용자가 직접 정한다).",
		shape: { mode: z.enum(["개인", "회사", "전체"]) },
		async run(ctx, a) {
			if (!ctx.plugin) throw new Error("모드는 화면 위 스위치로 바꿔 주세요.");
			await ctx.plugin.setSideMode(String(a.mode));
			return `${String(a.mode)} 모드로 바꿨어요.`;
		},
	},
	// ── Vision Board ──
	{
		name: "vision_card",
		description: "Vision Board 비전 카드(화면의 카드 ⋯와 같다). action: add(title, text, image) | edit(card + 바꿀 칸) | move(card, to: 1부터) | delete(card, 확인 카드). card는 장면 이름 또는 1부터 순서. image는 볼트 안 이미지 경로(00 Vision Board/images/…), 비우면 없음. 문장은 이미 이룬 것처럼 짧게, 사용자의 말 그대로.",
		shape: { action: z.enum(["add", "edit", "move", "delete"]), card: z.string().optional(), title: z.string().optional(), text: z.string().optional(), image: z.string().optional(), to: z.number().int().optional() },
		big: (a) => a.action === "delete",
		async preview(ctx, a) {
			const { c } = await visionCardBy(ctx, String(a.card ?? ""));
			return { title: `비전 카드 지우기: ${c.title}`, lines: [c.text, "이미지 파일은 images 폴더에 남아요."].filter(Boolean) };
		},
		async run(ctx, a) {
			const folder = ctx.host.settings.visionBoardPath;
			const action = String(a.action);
			if (action === "add") {
				const title = String(a.title ?? "").trim();
				if (!title) throw new Error("장면 이름(title)이 필요해요.");
				const card = { title, text: String(a.text ?? ""), image: String(a.image ?? "") };
				await editVisionBoard(ctx.host.app, folder, ctx.today, `비전 카드 추가: ${title}`, (t, b) => setCards(t, [...b.cards, card]));
				return `비전 카드 「${title}」를 넣었어요`;
			}
			const { i, c } = await visionCardBy(ctx, String(a.card ?? ""));
			if (action === "delete") {
				await editVisionBoard(ctx.host.app, folder, ctx.today, `비전 카드 지움: ${c.title}`, (t, b) => setCards(t, b.cards.filter((_, k) => k !== i)));
				return `비전 카드 「${c.title}」를 지웠어요`;
			}
			if (action === "move") {
				const to = Math.max(1, Number(a.to ?? 1)) - 1;
				await editVisionBoard(ctx.host.app, folder, ctx.today, `비전 카드 순서: ${c.title}`, (t, b) => setCards(t, moveCard(b.cards, i, to)));
				return `「${c.title}」를 ${to + 1}번째로 옮겼어요`;
			}
			const next = { title: a.title === undefined ? c.title : String(a.title), text: a.text === undefined ? c.text : String(a.text), image: a.image === undefined ? c.image : String(a.image) };
			await editVisionBoard(ctx.host.app, folder, ctx.today, `비전 카드 고침: ${next.title}`, (t, b) => setCards(t, b.cards.map((x, k) => (k === i ? next : x))));
			return `비전 카드 「${next.title}」를 고쳤어요`;
		},
	},
	{
		name: "vision_affirmation",
		description: "Vision Board 확언 전문을 통째로 바꾸기(화면의 「확언 고치기」와 같다). 사용자가 불러 준 말 그대로 쓰고, 다듬은 초안은 먼저 보여 주고 승인받은 뒤에 쓴다. 읽음 체크는 여기서 하지 않는다(사용자가 화면에서 끝까지 읽고 넘길 때, 또는 flywheel_check).",
		shape: { text: z.string() },
		async run(ctx, a) {
			await editVisionBoard(ctx.host.app, ctx.host.settings.visionBoardPath, ctx.today, "확언 고침", (t) => setAffirmation(t, String(a.text)));
			return "확언을 바꿨어요";
		},
	},
];

// ───────────────────────── targets ─────────────────────────

async function visionCardBy(ctx: ToolCtx, want: string): Promise<{ i: number; c: VisionCard }> {
	const f = visionFile(ctx.host.app, ctx.host.settings.visionBoardPath);
	if (!f) throw new Error("Vision Board.md가 없어요.");
	const cards = parseVisionBoard(await ctx.host.app.vault.read(f)).cards;
	if (!cards.length) throw new Error("비전 카드가 없어요.");
	const n = /^\d+$/.test(want.trim()) ? Number(want) - 1 : -1;
	if (n >= 0 && n < cards.length) return { i: n, c: cards[n] };
	const c = pick(cards, want, (x) => x.title, "비전 카드");
	return { i: cards.indexOf(c), c };
}

async function deskTarget(ctx: ToolCtx, a: Record<string, unknown>): Promise<{ it: DeskItem; months: MonthData[] }> {
	const month = String(a.month ?? (a.date ? String(a.date).slice(0, 7) : ctx.today.slice(0, 7)));
	const months = await deskMonths(ctx, month);
	const cur = months.find((m) => m.key === month);
	if (!cur) throw new Error(`${month} Desk Calendar 파일이 없어요.`);
	let items = deskItemsOf(cur);
	if (a.date) items = items.filter((x) => x.date === String(a.date));
	const action = String(a.action);
	// The same task sits in 인박스 · 이번 주 · 날짜: pick the copy the action works on.
	if (action === "day" || action === "done" || action === "undone" || action === "letgo" || action === "split" || action === "drawer" || action === "future") {
		const days = items.filter((x) => x.section === "day");
		if (days.some((x) => norm(x.item.text).includes(norm(String(a.text))))) items = days;
	} else if (action === "week") {
		const open = items.filter((x) => x.section !== "day");
		if (open.some((x) => norm(x.item.text).includes(norm(String(a.text))))) items = open.filter((x) => x.section === "alloc").some((x) => norm(x.item.text).includes(norm(String(a.text)))) ? open.filter((x) => x.section === "alloc") : open;
	}
	const it = pick(items, String(a.text), (x) => x.item.text, "Desk 줄");
	it.side = lineSide(it.item.raw);
	return { it, months };
}

async function wallTarget(ctx: ToolCtx, a: Record<string, unknown>): Promise<{ l: WallLine; f: TFile; year: number }> {
	const year = Number(a.year ?? ctx.today.slice(0, 4));
	const f = await wallFile(ctx, year);
	const wy = parseWallYear(await ctx.host.app.vault.read(f), year);
	const sec = wy.months.find((m) => m.month === Number(a.month));
	if (!sec) throw new Error(`${year}-${String(a.month)} 칸이 없어요.`);
	const l = pick(sec.lines.filter((x) => x.item.ok), String(a.text), (x) => x.item.text, "Wall 줄");
	return { l, f, year };
}

async function drawerTarget(ctx: ToolCtx, want: string): Promise<DrawerItem> {
	const f = ctx.host.app.vault.getAbstractFileByPath(normalizePath(ctx.host.settings.drawerPath));
	if (!(f instanceof TFile)) throw new Error("Drawer.md가 없어요.");
	const items = parseDrawer(await ctx.host.app.vault.read(f)).items.filter((x) => x.item.status === "scheduled");
	return pick(items, want, (x) => x.text, "Drawer 항목");
}

async function skillTarget(ctx: ToolCtx, want: string): Promise<Skill> {
	const d = await loadToolbox(ctx.host);
	return d.skills.find((s) => s.id === want.trim()) ?? pick(d.skills, want, (s) => s.name, "스킬");
}

