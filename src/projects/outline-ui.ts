/**
 * 프로젝트 「할 일」 = one outline, written like a note (계획 「할 일 위계」, 2026-10-28):
 *
 *   Enter            save this line, open a new line right under it (same level)
 *   Enter on empty   a 하위 line steps out; a top-level empty line closes
 *   Tab / Shift+Tab  one level in (under the top-level row above) / back out — two levels only
 *   Backspace empty  delete this task (a 묶음 once its 하위 할 일 are gone)
 *   ↑ / ↓            previous / next line
 *   ⋮⋮ handle        drag onto a calendar slot (assign) or onto a row (in) / the heading (out)
 *
 * Every change is one `changeProjectTask` call, run in order (a queue), by task id, so typing on
 * while the previous line saves is safe. The hub file keeps order and indentation.
 */

import type { ProjectsHost } from "./actions.ts";
import type { Project } from "./model.ts";
import { tip } from "../ui/tip.ts";
import { readProject } from "../pinboard/create-actions.ts";
import { todayIsoLocal } from "../desk/model.ts";
import { hubRows, previousTopLevel, type ProjectTask } from "./tasks.ts";
import { changeProjectTask, loadProjectTasks, newTaskId, type TaskChange } from "./task-actions.ts";
import { MIME, scheduleSource, selectSchedule, selectedSchedule, TOUCH_DROP, type ScheduleItem } from "./schedule-dnd.ts";

/** A line being written that is not a task yet. `after`: the row it follows (null = first). */
export interface OutlineDraft {
	after: string | null;
	child: boolean;
	text: string;
}

export interface OutlineState {
	/** Text typed into existing rows, not saved yet (by task id). */
	texts?: Record<string, string>;
	draft?: OutlineDraft | null;
	/** Where the caret goes after the next render: a task id or "draft". */
	focus?: string;
	chain?: Promise<void>;
	error?: string;
	/** The line that has the caret (kept across re-renders from file changes). */
	focused?: string;
}

interface Row {
	id: string;
	depth: 0 | 1;
	ref: boolean;
	task: ProjectTask;
	kids: number;
}

export function renderTaskOutline(list: HTMLElement, host: ProjectsHost, p: Project, tasks: ProjectTask[], hubText: string, state: OutlineState, refresh: () => Promise<void>, select: (item: ScheduleItem) => void): void {
	const texts = (state.texts ??= {});
	const item = (t: ProjectTask): ScheduleItem => ({ kind: "task", projectPath: p.path, projectId: p.id, title: t.title, task: t });
	const rows: Row[] = [];
	for (const r of hubRows(hubText)) {
		const task = tasks.find((t) => t.id === r.id);
		if (task) rows.push({ ...r, task, kids: 0 });
	}
	for (const r of rows) if (!r.depth) r.kids = rows.filter((x) => x.task.parentId === r.id).length;

	/** Run changes one after another; then reload and put the caret back. */
	const queue = (change: () => Promise<TaskChange | null>, focus?: string) => {
		state.chain = (state.chain ?? Promise.resolve())
			.then(async () => {
				const c = await change();
				if (c) await changeProjectTask(host, p, c, todayIsoLocal());
				state.error = "";
			})
			.catch((e) => {
				state.error = e instanceof Error ? e.message : String(e);
			})
			.then(async () => {
				// Keep the caret where the user is now, unless this change says where it goes.
				const here = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>(".pf-ol-row");
				state.focus = focus ?? (here?.hasClass("is-draft") ? "draft" : here?.dataset.task);
				await refresh();
			});
	};
	/** The task as it is now in the files (rows shift as earlier changes save). */
	const fresh = async (id: string): Promise<ProjectTask | undefined> => {
		const { p: now, text } = await readProject(host, p.path);
		return (await loadProjectTasks(host, now, text)).find((t) => t.id === id);
	};
	const saveText = (r: Row) => {
		const v = texts[r.id];
		if (v === undefined || v.trim() === r.task.title || !v.trim()) return;
		delete texts[r.id];
		queue(async () => {
			const t = await fresh(r.id);
			return t ? { kind: "edit", task: t, text: v.trim() } : null;
		});
	};
	const open = (after: string | null, child: boolean) => {
		state.draft = { after, child, text: "" };
		state.focus = "draft";
		void refresh();
	};

	// Drag a row onto another row (in) or onto the heading (out).
	const dragged = () => {
		const it = selectedSchedule(host);
		return it?.kind === "task" && it.projectId === p.id && it.task.id ? it.task : null;
	};
	const dropZone = (el: HTMLElement, parentOf: (t: ProjectTask) => string | null | undefined) => {
		if (p.archived) return;
		el.addClass("ml-schedule-target", "pf-outline-drop");
		const ok = () => {
			const t = dragged();
			return t && parentOf(t) !== undefined ? t : null;
		};
		const go = () => {
			const t = ok();
			if (!t) return;
			selectSchedule(host, null);
			queue(async () => ({ kind: "level", id: t.id, parentId: parentOf(t)! }), t.id);
		};
		el.addEventListener("dragover", (e) => {
			if (!e.dataTransfer?.types.includes(MIME) || !ok()) return;
			e.preventDefault();
			e.stopPropagation();
			el.addClass("ml-schedule-over");
		});
		el.addEventListener("dragleave", (e) => {
			if (!el.contains(e.relatedTarget as Node | null)) el.removeClass("ml-schedule-over");
		});
		el.addEventListener("drop", (e) => {
			if (!e.dataTransfer?.types.includes(MIME) || !ok()) return;
			e.preventDefault();
			e.stopPropagation();
			el.removeClass("ml-schedule-over");
			go();
		});
		el.addEventListener(TOUCH_DROP, (e) => {
			if (ok()) {
				e.stopPropagation();
				go();
			}
		});
	};
	const heading = list.querySelector<HTMLElement>("h3");
	if (heading) dropZone(heading, (t) => (t.parentId ? null : undefined));

	const box = list.createDiv({ cls: "pf-outline", attr: { role: "list" } });
	// A re-render removes the focused input without a blur event, so `focused` survives it.
	const track = (input: HTMLInputElement, key: string) => {
		input.addEventListener("focus", () => (state.focused = key));
		input.addEventListener("blur", () => {
			// A re-render removes the input (blur fires then too): that is not the user leaving.
			window.setTimeout(() => {
				if (input.isConnected && state.focused === key) state.focused = undefined;
			}, 0);
		});
	};
	const inputs: HTMLInputElement[] = [];
	const focusAt = (i: number) => {
		const x = inputs[Math.max(0, Math.min(inputs.length - 1, i))];
		if (x) {
			x.focus();
			x.setSelectionRange(x.value.length, x.value.length);
		}
	};
	const keys = (input: HTMLInputElement, e: KeyboardEvent, on: { enter: () => void; tab: (out: boolean) => void; empty: () => void; escape?: () => void }) => {
		if (e.isComposing) return;
		const i = inputs.indexOf(input);
		if (e.key === "Escape" && on.escape) {
			e.preventDefault();
			on.escape();
		} else if (e.key === "Enter") {
			e.preventDefault();
			on.enter();
		} else if (e.key === "Tab") {
			e.preventDefault();
			on.tab(e.shiftKey);
		} else if (e.key === "Backspace" && input.value === "") {
			e.preventDefault();
			on.empty();
		} else if (e.key === "ArrowUp" && i > 0) {
			e.preventDefault();
			focusAt(i - 1);
		} else if (e.key === "ArrowDown" && i < inputs.length - 1) {
			e.preventDefault();
			focusAt(i + 1);
		}
	};

	const renderDraft = () => {
		const d = state.draft!;
		const line = box.createDiv({ cls: `pf-ol-row is-draft${d.child ? " is-child" : ""}`, attr: { role: "listitem" } });
		line.createSpan({ cls: "pf-ol-box", attr: { "aria-hidden": "true" } });
		const input = line.createEl("input", { cls: "pf-ol-text", attr: { type: "text", placeholder: d.child ? "하위 할 일 · Shift+Tab 나가기" : "할 일 · Tab 하위로", "aria-label": "새 할 일", enterkeyhint: "next" } });
		input.value = d.text;
		inputs.push(input);
		track(input, "draft");
		input.addEventListener("input", () => (d.text = input.value));
		input.addEventListener("keydown", (e) =>
			keys(input, e, {
				enter: () => {
					const v = d.text.trim();
					if (!v) {
						// An empty 하위 line steps out; an empty top-level line closes (like a note's list).
						if (d.child) {
							d.child = false;
							state.focus = "draft";
							void refresh();
						} else {
							state.draft = null;
							state.focus = d.after ?? undefined;
							void refresh();
						}
						return;
					}
					const id = newTaskId();
					const { after, child } = d;
					state.draft = { after: id, child, text: "" };
					queue(async () => ({ kind: "add", text: v, id, after: after ?? undefined, child }), "draft");
				},
				tab: (out) => {
					if (out) d.child = false;
					else if (d.after && (rows.find((r) => r.id === d.after)?.depth || !rows.find((r) => r.id === d.after)?.ref)) d.child = true;
					state.focus = "draft";
					void refresh();
				},
				empty: () => {
					state.draft = null;
					state.focus = d.after ?? undefined;
					void refresh();
				},
				escape: () => {
					state.draft = null;
					void refresh();
				},
			}),
		);
		input.addEventListener("blur", () => {
			// Leaving a written draft keeps it as a task; an empty one just goes away.
			window.setTimeout(() => {
				if (!input.isConnected || state.draft !== d || document.activeElement === input) return;
				const v = d.text.trim();
				state.draft = null;
				if (v) queue(async () => ({ kind: "add", text: v, id: newTaskId(), after: d.after ?? undefined, child: d.child }));
			}, 150);
		});
	};

	const drawRow = (r: Row) => {
		const t = r.task;
		const line = box.createDiv({ cls: `pf-ol-row${r.depth ? " is-child" : ""}${t.state === "done" ? " is-done" : ""}${t.group ? " is-group" : ""}${r.ref ? " is-assigned" : ""}`, attr: { role: "listitem", "data-task": r.id } });
		const check = line.createEl("input", { cls: "pf-ol-check", attr: { type: "checkbox", "aria-label": `${t.title} 완료` } });
		check.checked = t.state === "done";
		check.disabled = p.archived || t.state === "cancelled" || !!t.group || !!(t.desk && t.desk.section !== "day");
		if (t.group) tip(check, "하위 할 일이 모두 끝나면 저절로 완료돼요");
		else if (t.desk && t.desk.section !== "day") tip(check, "날짜를 정한 뒤 완료해요");
		check.addEventListener("change", () =>
			queue(async () => {
				const f = await fresh(r.id);
				return f ? { kind: "toggle", task: f } : null;
			}, r.id),
		);
		const input = line.createEl("input", { cls: "pf-ol-text", attr: { type: "text", "aria-label": "할 일" } });
		input.value = texts[r.id] ?? t.title;
		input.readOnly = p.archived || t.state === "cancelled";
		inputs.push(input);
		track(input, r.id);
		input.addEventListener("input", () => (texts[r.id] = input.value));
		input.addEventListener("blur", () => {
			if (input.isConnected) saveText(r);
		});
		input.addEventListener("keydown", (e) =>
			keys(input, e, {
				enter: () => {
					saveText(r);
					// Under a 묶음 the new line is its first 하위 할 일; else a sibling.
					open(r.id, !!r.depth || r.kids > 0);
				},
				tab: (out) => {
					saveText(r);
					if (out) {
						if (r.depth) queue(async () => ({ kind: "level", id: r.id, parentId: null }), r.id);
					} else if (!r.depth && !t.group) {
						const prev = previousTopLevel(hubText, r.id);
						if (prev) queue(async () => ({ kind: "level", id: r.id, parentId: prev }), r.id);
					}
				},
				empty: () => {
					if (r.kids) return;
					const i = rows.indexOf(r);
					delete texts[r.id];
					queue(async () => ({ kind: "delete", id: r.id }), rows[i - 1]?.id);
				},
			}),
		);
		const meta = line.createSpan({ cls: "pf-ol-meta" });
		if (t.group) meta.setText(`하위 ${rows.filter((x) => x.task.parentId === r.id && x.task.state === "done").length}/${r.kids}`);
		else if (t.state === "cancelled") meta.setText("놓아줌");
		else if (t.date || t.month || t.desk) meta.setText(t.date ?? (t.desk?.section === "alloc" ? `${t.desk.monday} 주` : `${+(t.month ?? "").slice(5, 7)}월 인박스`));
		if (!p.archived && t.state !== "cancelled") {
			const handle = line.createSpan({ cls: "pf-ol-handle", text: "⋮⋮", attr: { "aria-label": `${t.title} 끌기`, role: "button", tabindex: "-1" } });
			tip(handle, t.group ? "끌어서 다른 할 일 아래로, 또는 달력 「인박스」에 놓아 하위 할 일을 그 달로" : "끌어서 달력 날짜·주·인박스에 배정하거나, 다른 할 일 위에 놓아 그 아래로");
			scheduleSource(handle, host, item(t));
			handle.addEventListener("click", () => {
				if (t.state === "scheduled" && !t.group) select(item(t));
			});
			dropZone(line, (d) => {
				if (d.id === r.id || d.group) return undefined;
				const target = r.depth ? t.parentId! : r.id;
				return d.parentId === target || (!r.depth && r.ref) ? undefined : target;
			});
			const del = line.createEl("button", { cls: "pf-ol-del", text: "×", attr: { type: "button", "aria-label": `${t.title} 삭제` } });
			tip(del, r.kids ? "하위 할 일을 먼저 옮기거나 지워요" : r.ref ? "삭제 · 달력에 배정한 줄도 함께 지워요" : "삭제");
			del.disabled = r.kids > 0;
			del.addEventListener("click", () => {
				delete texts[r.id];
				queue(async () => ({ kind: "delete", id: r.id }));
			});
		}
	};

	for (const r of rows) {
		drawRow(r);
		const d = state.draft;
		if (!d || d.after !== r.id) continue;
		// The draft sits where the new row will go: right here, or after this 묶음's 하위 rows.
		if (d.child || !r.kids) renderDraft();
	}
	const d = state.draft;
	if (d) {
		const after = rows.find((r) => r.id === d.after);
		const placed = after && (d.child || !after.kids);
		if (!placed) {
			if (after?.kids && !d.child) {
				// After the 묶음's last 하위 row.
				const last = [...box.querySelectorAll<HTMLElement>(".pf-ol-row")].filter((el) => rows.find((r) => r.id === el.dataset.task)?.task.parentId === after.id).pop();
				renderDraft();
				if (last) last.after(box.lastElementChild as HTMLElement);
			} else renderDraft();
		}
	} else if (!p.archived) {
		if (!rows.length) {
			state.draft = { after: null, child: false, text: "" };
			renderDraft();
		} else {
			const add = box.createDiv({ cls: "pf-ol-row pf-ol-add", text: "+ 할 일", attr: { role: "button", tabindex: "0" } });
			add.addEventListener("click", () => open(rows[rows.length - 1].id, false));
		}
	}
	if (state.error) list.createDiv({ cls: "pf-ms-error", text: state.error, attr: { role: "alert" } });

	const want = state.focus ?? state.focused;
	state.focus = undefined;
	if (want)
		window.setTimeout(() => {
			const el = want === "draft" ? box.querySelector<HTMLInputElement>(".is-draft .pf-ol-text") : box.querySelector<HTMLInputElement>(`.pf-ol-row[data-task="${CSS.escape(want)}"] .pf-ol-text`);
			if (el) {
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			}
		}, 0);
}
