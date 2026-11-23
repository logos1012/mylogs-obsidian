import { Menu } from "obsidian";
import { tip } from "../ui/tip.ts";
import { touchDrag } from "../desk/touch-drag.ts";
import { touchReorder } from "./schedule-dnd.ts";
import { todayIsoLocal } from "../desk/model.ts";
import type { Project } from "./model.ts";
import { formatMetricValue, metricMeasure, milestoneKind, milestoneSplit, milestoneSummary, type MilestoneChange, type Milestone } from "./milestones.ts";
import { aimIds, calendarStateOf, linkedRows, milestoneTaskProgress, readyToConfirm, recommendLinks, reviewNotes, type LinkChange } from "./milestone-links.ts";
import { hubTopRows, type HubTopRow, type ProjectTask } from "./tasks.ts";

/**
 * 마일스톤 ↔ 할 일 연결 (0.51.0). Given only where the project's 할 일 are loaded (the workspace);
 * without it the rows look as before.
 */
export interface MilestoneLinks {
	hubText: string;
	tasks: ProjectTask[];
	save: (change: LinkChange, expected: string) => Promise<void>;
	/** The linked rows (top-level keys) and their 하위 할 일, editable in place (`renderTaskOutline` scope). */
	outline: (el: HTMLElement, keys: Set<string>, ms: string) => void;
	/** One line of text (the new 묶음's title), or null. */
	askTitle: (milestone: string) => Promise<string | null>;
	pick: <T extends { label: string; sub?: string }>(title: string, items: T[]) => Promise<T | null>;
	newTaskId: () => string;
}

export interface MilestoneUIState {
	open: boolean;
	busy?: boolean;
	error?: string;
	editor?: { line: number | null; text: string; source: string; due?: string; dateDirty?: boolean; dueIssue?: string };
	removing?: { line: number; text: string; source: string };
	/** The 성과 지표 whose current value is being typed in place. */
	current?: { line: number; value: string; source: string };
	/** 「지표 설정」: target · unit · period of one 성과 지표. */
	metric?: { line: number; target: string; unit: string; period: string; source: string };
	/** Milestone ids whose linked 할 일 are open under the row (screen only). */
	expanded?: Set<string>;
	/** 「노리는 성과 지표」: the 성과 지표 lines ticked so far. */
	aiming?: { line: number; chosen: number[]; source: string };
	/** 「다시 검토」 notes closed this session (`milestone ms|metric ms`); never written to the file. */
	dismissed?: Set<string>;
	/** A 마일스톤 that just got its first 묶음 (no id on screen yet): open its panel after the reload. */
	expandNew?: number;
}

/** Reordering by the ⋮⋮ handle; a type of its own, so it never reads as a drop on the calendar. */
const ORDER_MIME = "application/x-mylogs-milestone-order";
/** The row being reordered (dragover cannot read the data): only rows of the same hub accept it. */
let ordering: { path: string; line: number } | null = null;

/** Same disclosure and inline controls on desktop and mobile; no modal or hover-only controls. */
export function renderMilestones(parent: HTMLElement, p: Project, state: MilestoneUIState, save: (change: MilestoneChange, expected: string) => Promise<void>, refresh: () => Promise<void>, schedule?: (item: Milestone) => void, draggable?: (el: HTMLElement, item: Milestone) => void, links?: MilestoneLinks): void {
	const host = parent.createDiv({ cls: "pf-milestones" });
	host.addEventListener("contextmenu", e => e.stopPropagation());
	host.addEventListener("dragstart", e => { e.stopPropagation(); if (!draggable) e.preventDefault(); });
	const source = p.milestoneSource ?? "", items = p.milestones ?? [], summary = milestoneSummary(items), split = milestoneSplit(items);
	const paint = (focus = false): void => {
		host.empty();
		const details = host.createEl("details"); details.open = state.open;
		details.addEventListener("toggle", () => { state.open = details.open; });
		const head = details.createEl("summary", { attr: { "aria-label": `${p.title} 마일스톤 ${split.label}` } });
		head.createSpan({ text: "마일스톤" });
		head.createSpan({ cls: "pf-ms-count", text: p.milestoneError ? "확인 필요" : split.label });
		if (summary.total) {
			const progress = head.createEl("progress", { attr: { max: String(summary.total), value: String(summary.done), "aria-label": `마일스톤 ${summary.label}` } });
			progress.textContent = summary.label;
		}
		const body = details.createDiv({ cls: "pf-ms-body" });
		if (p.milestoneError) { body.createDiv({ cls: "pf-ms-error", text: p.milestoneError }); return; }
		if (!summary.total) tip(head, "완료까지 확인할 중요한 도달 상태를 적어 주세요.");
		const locked = !!(state.busy || state.editor || state.removing || state.current || state.metric || state.aiming);
		const button = (where: HTMLElement, text: string, action: () => void, disabled = false): HTMLButtonElement => {
			const b = where.createEl("button", { text, attr: { type: "button" } }); b.disabled = disabled;
			b.addEventListener("click", e => { e.stopPropagation(); action(); }); return b;
		};
		const commit = async (change: MilestoneChange, expected: string): Promise<void> => {
			if (state.busy) return;
			state.busy = true; state.error = ""; paint();
			try { await save(change, expected); state.editor = undefined; state.removing = undefined; state.current = undefined; state.metric = undefined; state.busy = false; paint(); await refresh(); }
			catch (e) { state.busy = false; state.error = e instanceof Error ? e.message : String(e); paint(true); }
		};
		/** A link change: the hub's line edits and the records, one save (same busy / error handling). */
		const commitLink = async (change: LinkChange, after?: () => void): Promise<void> => {
			if (state.busy || !links) return;
			state.busy = true; state.error = ""; paint();
			try { await links.save(change, source); state.aiming = undefined; after?.(); state.busy = false; paint(); await refresh(); }
			catch (e) { state.busy = false; state.error = e instanceof Error ? e.message : String(e); paint(true); }
		};
		const cancelInline = () => { state.current = undefined; state.metric = undefined; state.aiming = undefined; state.error = ""; paint(); };
		const expanded = (state.expanded ??= new Set()), dismissed = (state.dismissed ??= new Set());
		const topRows: HubTopRow[] = links ? hubTopRows(links.hubText) : [];
		const refState = links ? calendarStateOf(links.tasks) : () => undefined;
		const notes = links ? reviewNotes(items) : [];
		const metrics = items.filter(i => milestoneKind(i) === "metric");
		/** 「+ 할 일」: a new 묶음 in `## 할 일`, linked to this 마일스톤; its panel opens. */
		const addGroup = async (item: Milestone) => {
			if (!links || locked) return;
			const title = await links.askTitle(item.text);
			if (!title?.trim()) return;
			await commitLink({ kind: "addGroup", line: item.line, title, taskId: links.newTaskId(), projectId: p.id }, () => { if (item.ms) expanded.add(item.ms); else state.expandNew = item.line; });
		};
		const move = (item: Milestone, target: Milestone, place: "before" | "after") => void commit({ kind: "move", line: item.line, target: target.line, place }, source);
		const clearDrop = () => body.querySelectorAll(".is-drop-before, .is-drop-after").forEach(el => el.removeClass("is-drop-before", "is-drop-after"));
		const scroller = host.closest<HTMLElement>(".view-content") ?? host;

		items.forEach((item, index) => {
			const metric = milestoneKind(item) === "metric";
			const row = body.createDiv({ cls: `pf-ms-row${item.done ? " is-done" : ""}${metric ? " is-metric" : ""}`, attr: { "data-line": String(item.line) } });
			if (!p.archived && !locked) draggable?.(row, item);
			// ⋮⋮ (desktop, shown on hover): drag up or down to reorder. Phone: long-press the row itself.
			if (!p.archived && items.length > 1) {
				const handle = row.createSpan({ cls: "pf-ms-handle", text: "⋮⋮", attr: { role: "button", tabindex: "-1", "aria-label": `${item.text} 순서 바꾸기` } });
				if (!locked) {
					tip(handle, "끌어서 순서 바꾸기 · 휴대폰은 줄을 길게 누른 뒤 끌어요");
					handle.draggable = true;
					handle.addEventListener("dragstart", e => {
						e.stopPropagation(); // not the row's drag to the calendar
						ordering = { path: p.path, line: item.line };
						e.dataTransfer?.setData(ORDER_MIME, JSON.stringify(ordering));
						if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
						row.addClass("is-dragging");
					});
					handle.addEventListener("dragend", () => { ordering = null; row.removeClass("is-dragging"); clearDrop(); });
					// One long-press on the row: over another row it reorders, over a calendar day it sets the date.
					const reorder = {
						selector: ".pf-ms-row", scroller,
						hint: (target: HTMLElement) => target === row || !body.contains(target) ? null : items.findIndex(i => String(i.line) === target.dataset.line) > index ? "is-drop-after" : "is-drop-before",
						drop: (target: HTMLElement) => {
							if (!body.contains(target)) return;
							const to = items.find(i => String(i.line) === target.dataset.line);
							if (to && to !== item) move(item, to, items.indexOf(to) > index ? "after" : "before");
						},
					};
					// The calendar long-press (`scheduleSource`) already owns this row's touches: extend it.
					if (row.hasClass("ml-schedule-draggable")) touchReorder(row, reorder);
					else touchDrag(scroller, row, `⋮⋮ ${item.text}`, reorder.selector, reorder.drop);
				}
			}
			if (!p.archived && !locked) {
				const placeOf = (e: DragEvent): "before" | "after" => { const r = row.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? "before" : "after"; };
				row.addEventListener("dragover", e => {
					if (!e.dataTransfer?.types.includes(ORDER_MIME) || ordering?.path !== p.path) return;
					e.preventDefault(); e.stopPropagation();
					e.dataTransfer.dropEffect = "move";
					const place = placeOf(e);
					clearDrop(); row.addClass(place === "before" ? "is-drop-before" : "is-drop-after");
				});
				row.addEventListener("dragleave", e => { if (!row.contains(e.relatedTarget as Node | null)) row.removeClass("is-drop-before", "is-drop-after"); });
				row.addEventListener("drop", e => {
					if (!e.dataTransfer?.types.includes(ORDER_MIME)) return;
					e.preventDefault(); e.stopPropagation(); clearDrop();
					let data: { path?: string; line?: number } = {};
					try { data = JSON.parse(e.dataTransfer.getData(ORDER_MIME)) as typeof data; } catch { return; }
					ordering = null;
					const from = data.path === p.path ? items.find(i => i.line === data.line) : undefined;
					if (from && from !== item) move(from, item, placeOf(e));
				});
			}
			const main = row.createDiv({ cls: "pf-ms-main" });
			const first = main.createDiv({ cls: "pf-ms-line" });
			const label = first.createEl("label", { cls: "pf-ms-check" });
			const check = label.createEl("input", { attr: { type: "checkbox", "aria-label": `${item.text} 달성 확인` } });
			check.checked = item.done; check.disabled = p.archived || locked;
			label.createSpan({ cls: "pf-ms-title", text: item.text });
			// 「할 일 n/m」: small, on the same line; tapping opens the linked 할 일 under the row.
			const linked = links && !metric ? linkedRows(links.hubText, item.ms) : [];
			const progress = milestoneTaskProgress(linked, refState);
			if (state.expandNew === item.line && item.ms && linked.length) { expanded.add(item.ms); state.expandNew = undefined; }
			const open = !!item.ms && expanded.has(item.ms) && linked.length > 0;
			if (linked.length) {
				const chip = button(first, `할 일 ${progress.done}/${progress.total}`, () => { if (open) expanded.delete(item.ms!); else expanded.add(item.ms!); paint(); });
				chip.addClass("pf-ms-tasks");
				if (progress.total && progress.done === progress.total) chip.addClass("is-complete");
				chip.setAttr("aria-expanded", String(open));
				chip.setAttr("aria-label", `${item.text} 연결된 할 일 ${progress.done}/${progress.total} ${open ? "접기" : "펼치기"}`);
				const fill = chip.createSpan({ cls: "pf-ms-tasks-bar", attr: { "aria-hidden": "true" } });
				fill.createSpan().style.width = `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`;
			}
			// Only a 성과 지표 is marked, small, at the end of the line; a plain 마일스톤 needs no label.
			if (metric) first.createSpan({ cls: "pf-ms-badge is-metric", text: "성과 지표" });
			check.addEventListener("change", () => void commit({ kind: "check", line: item.line, done: check.checked }, source));
			if (metric) renderMeasure(main.createDiv({ cls: "pf-ms-sub" }), main, item);
			if (item.fieldIssue) main.createDiv({ cls: "pf-ms-field-issue", text: item.fieldIssue });
			const editItem = (dateFocus = false) => {
				state.editor = { line: item.line, text: item.text, source, due: item.due, dueIssue: item.dueIssue }; state.error = ""; paint(true);
				if (dateFocus) host.querySelector<HTMLInputElement>('input[type="date"]')?.focus();
			};
			const dateText = item.dueIssue ? "날짜 확인" : item.due ? item.due.slice(2).replace(/-/g, "/") : "날짜";
			if (p.archived) { if (item.due || item.dueIssue) row.createSpan({ cls: "pf-ms-date", text: dateText }); }
			else {
				const date = button(row, dateText, () => schedule ? schedule(item) : editItem(true), locked);
				date.addClass("pf-ms-date"); date.setAttr("aria-label", `${item.text} 목표일 ${item.due || "미정"} 수정`);
				date.setAttr("title", item.dueIssue || `목표일: ${item.due || "미정"}`);
			}
			if (!p.archived) {
				const more = button(row, "⋯", () => {}, locked);
				more.addClass("pf-ms-more"); more.setAttr("aria-label", `${item.text} 메뉴`); more.setAttr("aria-haspopup", "menu");
				more.addEventListener("click", e => {
					const menu = new Menu();
					menu.addItem(i => i.setTitle("수정").setIcon("pencil").onClick(() => editItem()));
					if (metric) menu.addItem(i => i.setTitle("지표 설정").setIcon("sliders-horizontal").onClick(() => {
						state.metric = { line: item.line, source, target: item.target === undefined ? "" : String(item.target), unit: item.unit ?? "", period: item.period ?? "" };
						state.error = ""; paint(true);
					}));
					if (links && !metric) {
						const free = topRows.filter(r => !r.ms);
						const mine = linkedRows(links.hubText, item.ms);
						menu.addItem(i => i.setTitle("+ 할 일").setIcon("list-plus").onClick(() => void addGroup(item)));
						if (free.length) menu.addItem(i => i.setTitle("기존 묶음 연결").setIcon("link").onClick(() => void (async () => {
							const picked = await links.pick(`「${item.text}」에 연결할 할 일`, free.map(r => ({ label: r.title, sub: r.children.length ? `하위 ${r.children.length}개` : r.ref ? "배정됨" : "단독 할 일", row: r })));
							if (picked) await commitLink({ kind: "link", line: item.line, rows: [{ key: picked.row.key, line: picked.row.line }] }, () => { if (item.ms) expanded.add(item.ms); else state.expandNew = item.line; });
						})()));
						if (mine.length) menu.addItem(i => i.setTitle("연결 풀기").setIcon("unlink").onClick(() => void (async () => {
							const all = { label: `모두 풀기 (${mine.length}개)`, sub: "할 일은 그대로 남아요", rows: mine };
							const choices = [...mine.map(r => ({ label: r.title, sub: "연결만 풀어요. 할 일은 그대로예요", rows: [r] })), ...(mine.length > 1 ? [all] : [])];
							const picked = await links.pick(`「${item.text}」 연결 풀기`, choices);
							if (picked) await commitLink({ kind: "unlink", line: item.line, rows: picked.rows.map(r => ({ key: r.key, line: r.line })) });
						})()));
						if (metrics.length) menu.addItem(i => i.setTitle("노리는 성과 지표").setIcon("target").onClick(() => {
							state.aiming = { line: item.line, source, chosen: metrics.filter(x => x.ms && aimIds(item).includes(x.ms)).map(x => x.line) };
							state.error = ""; paint(true);
						}));
					}
					menu.addItem(i => i.setTitle(metric ? "마일스톤으로 바꾸기" : "성과 지표로 바꾸기").setIcon(metric ? "flag" : "gauge").onClick(() => void commit({ kind: "setKind", line: item.line, to: metric ? "milestone" : "metric" }, source)));
					if (index > 0) menu.addItem(i => i.setTitle("위로").setIcon("arrow-up").onClick(() => move(item, items[index - 1], "before")));
					if (index < items.length - 1) menu.addItem(i => i.setTitle("아래로").setIcon("arrow-down").onClick(() => move(item, items[index + 1], "after")));
					menu.addItem(i => i.setTitle("삭제").setIcon("trash-2").setWarning(true).onClick(() => { state.removing = { ...item, source }; state.error = ""; paint(); host.querySelector<HTMLButtonElement>(".pf-ms-remove button")?.focus(); }));
					menu.showAtMouseEvent(e);
				});
			}
			if (state.metric?.line === item.line && !p.archived) renderMetricForm(body, item);
			if (state.aiming?.line === item.line && !p.archived) renderAimForm(body, item);
			if (links && !metric) {
				const linked = linkedRows(links.hubText, item.ms), progress = milestoneTaskProgress(linked, refState);
				// No automatic achievement (rule 「6-1」): the user confirms, through the usual check.
				if (readyToConfirm(item, progress) && !p.archived) {
					const ok = button(body, "할 일을 다 끝냈어요 · 달성 확인", () => void commit({ kind: "check", line: item.line, done: true }, source), locked);
					ok.addClass("pf-ms-confirm");
				}
				if (item.ms && expanded.has(item.ms) && linked.length) {
					const panel = body.createDiv({ cls: "pf-ms-panel", attr: { role: "group", "aria-label": `${item.text} 연결된 할 일` } });
					links.outline(panel, new Set(linked.map(r => r.key)), item.ms);
					if (!p.archived) {
						const actions = panel.createDiv({ cls: "pf-ms-panel-actions" });
						button(actions, "+ 할 일", () => void addGroup(item), locked).addClass("pf-ms-panel-add");
					}
				}
				for (const n of notes.filter(n => n.milestone === item)) {
					const key = `${item.ms}|${n.metric.ms}`;
					if (dismissed.has(key)) continue;
					const note = body.createDiv({ cls: "pf-ms-review", attr: { role: "note" } });
					note.createSpan({ text: `마일스톤은 해냈어요 👏 그런데 「${n.metric.text}」은 아직 그대로예요. 방법을 한 번 다시 검토해 볼까요?` });
					const close = button(note, "×", () => { dismissed.add(key); paint(); });
					close.addClass("pf-ms-review-close"); close.setAttr("aria-label", "안내 닫기");
				}
			}
		});

		/** 「노리는 성과 지표」: tick 성과 지표 → `(aim::)` (ids and `(start::)` added in the same save). */
		function renderAimForm(where: HTMLElement, item: Milestone): void {
			const f = state.aiming!, form = where.createEl("form", { cls: "pf-ms-editor pf-ms-aim-form" });
			form.createDiv({ cls: "pf-ms-hint", text: `「${item.text}」이 노리는 성과 지표` });
			for (const x of metrics) {
				const label = form.createEl("label", { cls: "pf-ms-aim-choice" });
				const box = label.createEl("input", { attr: { type: "checkbox" } });
				box.checked = f.chosen.includes(x.line); box.disabled = !!state.busy;
				box.addEventListener("change", () => { f.chosen = box.checked ? [...f.chosen, x.line] : f.chosen.filter(l => l !== x.line); });
				label.createSpan({ text: x.text });
			}
			form.createDiv({ cls: "pf-ms-hint", text: "연결할 때 그 지표의 지금 값을 시작 값으로 적어 둬요." });
			const actions = form.createDiv({ cls: "pf-ms-editor-actions" });
			const ok = actions.createEl("button", { text: state.busy ? "저장 중…" : "저장", attr: { type: "submit" } }); ok.disabled = !!state.busy;
			button(actions, "취소", cancelInline, !!state.busy);
			form.addEventListener("submit", e => { e.preventDefault(); void commitLink({ kind: "aim", line: item.line, metrics: metrics.filter(x => f.chosen.includes(x.line)).map(x => x.line) }); });
			form.addEventListener("keydown", e => { if (e.key === "Escape" && !state.busy) { e.preventDefault(); cancelInline(); } });
		}

		/** `최근 30일 · 0원 / 100만 원 · 11/23 기준`, a small bar, and the current value to tap. */
		function renderMeasure(sub: HTMLElement, main: HTMLElement, item: Milestone): void {
			const m = metricMeasure(item);
			const editing = state.current?.line === item.line && !p.archived;
			if (editing) {
				const cur = state.current!, form = sub.createEl("form", { cls: "pf-ms-current-edit" });
				const input = form.createEl("input", { attr: { type: "text", inputmode: "decimal", enterkeyhint: "done", "aria-label": `${item.text} 현재 값`, placeholder: "현재 값" } });
				input.value = cur.value; input.disabled = !!state.busy;
				input.addEventListener("input", () => { cur.value = input.value; });
				input.addEventListener("keydown", e => { if (e.key === "Escape" && !state.busy) { e.preventDefault(); cancelInline(); } });
				if (item.unit) form.createSpan({ cls: "pf-ms-unit", text: item.unit });
				const ok = form.createEl("button", { text: state.busy ? "저장 중…" : "저장", attr: { type: "submit" } }); ok.disabled = !!state.busy;
				button(form, "취소", cancelInline, !!state.busy);
				form.addEventListener("submit", e => { e.preventDefault(); e.stopPropagation(); void commit({ kind: "setMetric", line: item.line, current: cur.value, asOf: todayIsoLocal() }, cur.source); });
				form.addEventListener("click", e => e.stopPropagation());
				window.setTimeout(() => { input.focus(); input.select(); }, 0);
				return;
			}
			const line = sub.createSpan({ cls: `pf-ms-measure${m.missingTarget ? " is-missing" : ""}` });
			if (m.missingTarget) line.setText(m.text);
			else {
				if (item.period) line.createSpan({ text: `${item.period} · ` });
				const value = item.current === undefined ? "현재 값 적기" : formatMetricValue(item.current, item.unit);
				if (p.archived) line.createSpan({ text: value });
				else {
					const b = button(line, value, () => { state.current = { line: item.line, value: item.current === undefined ? "" : String(item.current), source }; state.error = ""; paint(); }, locked);
					b.addClass("pf-ms-current"); b.setAttr("aria-label", `${item.text} 현재 값 ${value} 고치기`);
				}
				line.createSpan({ text: ` / ${formatMetricValue(item.target!, item.unit)}` });
				if (item.asOf) line.createSpan({ cls: "pf-ms-asof", text: ` · ${+item.asOf.slice(5, 7)}/${+item.asOf.slice(8, 10)} 기준` });
			}
			if (m.ratio !== undefined) {
				const bar = main.createDiv({ cls: "pf-ms-bar", attr: { role: "img", "aria-label": `${Math.round(m.ratio * 100)}%` } });
				bar.createDiv({ cls: "pf-ms-bar-fill" }).style.width = `${Math.round(m.ratio * 100)}%`;
			}
			if (m.reached && !item.done) main.createDiv({ cls: "pf-ms-reached", text: "목표에 닿았어요 · 달성 확인" });
			if (m.missingTarget && !p.archived) {
				const set = button(sub, "지표 설정", () => { state.metric = { line: item.line, source, target: "", unit: item.unit ?? "", period: item.period ?? "" }; state.error = ""; paint(true); }, locked);
				set.addClass("pf-ms-set");
			}
		}

		/** 목표 값 · 단위 · 기간, in place under the row. */
		function renderMetricForm(where: HTMLElement, item: Milestone): void {
			const f = state.metric!, form = where.createEl("form", { cls: "pf-ms-editor pf-ms-metric-form" });
			form.createDiv({ cls: "pf-ms-hint", text: `「${item.text}」 지표 설정` });
			const field = (text: string, key: "target" | "unit" | "period", placeholder: string, mode?: string) => {
				const label = form.createEl("label", { cls: "pf-ms-date-field", text });
				const input = label.createEl("input", { attr: { type: "text", placeholder, ...(mode ? { inputmode: mode } : {}) } });
				input.value = f[key]; input.disabled = !!state.busy;
				input.addEventListener("input", () => { f[key] = input.value; });
				input.addEventListener("keydown", e => { if (e.key === "Escape" && !state.busy) { e.preventDefault(); cancelInline(); } });
				return input;
			};
			const first = field("목표 값", "target", "예: 1,000,000", "decimal");
			field("단위", "unit", "원 · 건 · 개 · 명 · %");
			field("기간", "period", "예: 최근 30일");
			const actions = form.createDiv({ cls: "pf-ms-editor-actions" });
			const ok = actions.createEl("button", { text: state.busy ? "저장 중…" : "저장", attr: { type: "submit" } }); ok.disabled = !!state.busy;
			button(actions, "취소", cancelInline, !!state.busy);
			form.addEventListener("submit", e => { e.preventDefault(); void commit({ kind: "setMetric", line: item.line, target: f.target, unit: f.unit, period: f.period }, f.source); });
			if (focus) window.setTimeout(() => first.focus(), 0);
		}

		// 추천 연결: only pairs the matcher is sure of; one tap writes them all, nothing before it.
		const suggested = links && !p.archived ? recommendLinks(links.hubText) : [];
		if (suggested.length) {
			const box = body.createDiv({ cls: "pf-ms-suggest" });
			const go = button(box, `추천 연결 ${suggested.length}건 · 한 번에 연결`, () => void commitLink({ kind: "pairs", pairs: suggested.map(x => ({ line: x.line, row: x.row })) }), locked);
			go.addClass("pf-ms-suggest-go");
			const list = box.createEl("ul", { cls: "pf-ms-suggest-list" });
			for (const x of suggested) list.createEl("li", { text: `${x.title} → ◆ ${x.milestone}` });
		}
		if (summary.total && summary.done === summary.total && !p.archived) body.createDiv({ cls: "pf-ms-ready", text: "모든 마일스톤을 달성했어요. 성공 기준을 확인한 뒤 프로젝트를 완료해 주세요." });
		if (state.editor && !p.archived) {
			const editor = state.editor, form = body.createEl("form", { cls: "pf-ms-editor" });
			const label = form.createEl("label", { text: editor.line === null ? "새 마일스톤" : "마일스톤 수정" });
			const input = label.createEl("textarea", { attr: { rows: "2", placeholder: "예: 창간호 테스트 발송 및 검수 통과" } });
			input.value = editor.text; input.disabled = !!state.busy;
			input.addEventListener("input", () => { editor.text = input.value; });
			input.addEventListener("focus", () => form.scrollIntoView({ block: "nearest" }));
			const dateLabel = form.createEl("label", { cls: "pf-ms-date-field", text: "목표일 (선택)" });
			const date = dateLabel.createEl("input", { attr: { type: "date", min: "1900-01-01", max: "2999-12-31", "aria-label": "마일스톤 목표일" } });
			date.value = editor.due ?? ""; date.disabled = !!state.busy;
			date.addEventListener("input", () => { editor.due = date.value; editor.dateDirty = true; });
			button(dateLabel, "날짜 지우기", () => { editor.due = ""; editor.dateDirty = true; date.value = ""; }, !!state.busy);
			if (editor.dueIssue) form.createDiv({ cls: "pf-ms-error", text: `${editor.dueIssue} 새 날짜를 고르거나 날짜 지우기를 누르세요.` });
			tip(input, "달력에 ◆ 마일스톤으로 표시돼요. 할 일로 추가되지는 않아요.");
			const actions = form.createDiv({ cls: "pf-ms-editor-actions" });
			const submit = actions.createEl("button", { text: state.busy ? "저장 중…" : "저장", attr: { type: "submit" } }); submit.disabled = !!state.busy;
			const cancel = () => { state.editor = undefined; state.error = ""; paint(); void refresh(); };
			button(actions, "취소", cancel, !!state.busy);
			input.addEventListener("keydown", e => { if (e.key === "Escape" && !state.busy) { e.preventDefault(); cancel(); } });
			form.addEventListener("submit", e => { e.preventDefault(); const due = editor.dateDirty ? editor.due ?? "" : undefined; void commit(editor.line === null ? { kind: "add", text: editor.text, due } : { kind: "edit", line: editor.line, text: editor.text, due }, editor.source); });
			if (focus) input.focus();
		} else if (state.removing && !p.archived) {
			const removing = state.removing, box = body.createDiv({ cls: "pf-ms-remove", attr: { role: "group", "aria-label": "마일스톤 삭제 확인" } });
			box.createDiv({ text: `「${removing.text}」을 목록에서 지울까요? 전체 수가 바뀌며 삭제 기록은 로그에 남아요.` });
			button(box, "삭제 확인", () => void commit({ kind: "remove", line: removing.line }, removing.source), !!state.busy);
			button(box, "취소", () => { state.removing = undefined; state.error = ""; paint(); void refresh(); }, !!state.busy);
		} else if (!p.archived) button(body, "마일스톤 추가", () => { state.editor = { line: null, text: "", source }; state.error = ""; paint(true); }, locked);
		if (p.archived) body.createDiv({ cls: "pf-ms-hint", text: "보관된 프로젝트 · 읽기 전용" });
		if (state.error) body.createDiv({ cls: "pf-ms-error", text: state.error, attr: { role: "alert" } });
	};
	paint();
}
