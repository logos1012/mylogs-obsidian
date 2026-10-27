import { Menu } from "obsidian";
import type { Project } from "./model.ts";
import { milestoneSummary, type MilestoneChange } from "./milestones.ts";

export interface MilestoneUIState {
	open: boolean;
	busy?: boolean;
	error?: string;
	editor?: { line: number | null; text: string; source: string; due?: string; dateDirty?: boolean; dueIssue?: string };
	removing?: { line: number; text: string; source: string };
}

/** Same disclosure and inline controls on desktop and mobile; no modal or hover-only controls. */
export function renderMilestones(parent: HTMLElement, p: Project, state: MilestoneUIState, save: (change: MilestoneChange, expected: string) => Promise<void>, refresh: () => Promise<void>): void {
	const host = parent.createDiv({ cls: "pf-milestones" });
	host.addEventListener("contextmenu", e => e.stopPropagation());
	host.addEventListener("dragstart", e => { e.stopPropagation(); e.preventDefault(); });
	const source = p.milestoneSource ?? "", items = p.milestones ?? [], summary = milestoneSummary(items);
	const paint = (focus = false): void => {
		host.empty();
		const details = host.createEl("details"); details.open = state.open;
		details.addEventListener("toggle", () => { state.open = details.open; });
		const head = details.createEl("summary", { attr: { "aria-label": `${p.title} 마일스톤 ${summary.label}` } });
		head.createSpan({ text: "마일스톤" });
		head.createSpan({ cls: "pf-ms-count", text: p.milestoneError ? "확인 필요" : summary.label });
		if (summary.total) {
			const progress = head.createEl("progress", { attr: { max: String(summary.total), value: String(summary.done), "aria-label": `마일스톤 ${summary.label}` } });
			progress.textContent = summary.label;
		}
		const body = details.createDiv({ cls: "pf-ms-body" });
		if (p.milestoneError) { body.createDiv({ cls: "pf-ms-error", text: p.milestoneError }); return; }
		if (!summary.total) body.createDiv({ cls: "pf-ms-hint", text: "완료까지 확인할 중요한 도달 상태를 적어 주세요." });
		const locked = !!(state.busy || state.editor || state.removing);
		const button = (where: HTMLElement, text: string, action: () => void, disabled = false): HTMLButtonElement => {
			const b = where.createEl("button", { text, attr: { type: "button" } }); b.disabled = disabled;
			b.addEventListener("click", e => { e.stopPropagation(); action(); }); return b;
		};
		const commit = async (change: MilestoneChange, expected: string): Promise<void> => {
			if (state.busy) return;
			state.busy = true; state.error = ""; paint();
			try { await save(change, expected); state.editor = undefined; state.removing = undefined; state.busy = false; paint(); await refresh(); }
			catch (e) { state.busy = false; state.error = e instanceof Error ? e.message : String(e); paint(true); }
		};
		for (const item of items) {
			const row = body.createDiv({ cls: `pf-ms-row${item.done ? " is-done" : ""}` });
			const label = row.createEl("label", { cls: "pf-ms-check" });
			const check = label.createEl("input", { attr: { type: "checkbox", "aria-label": `${item.text} 달성 확인` } });
			check.checked = item.done; check.disabled = p.archived || locked;
			label.createSpan({ text: item.text });
			check.addEventListener("change", () => void commit({ kind: "check", line: item.line, done: check.checked }, source));
			const editItem = (dateFocus = false) => {
				state.editor = { line: item.line, text: item.text, source, due: item.due, dueIssue: item.dueIssue }; state.error = ""; paint(true);
				if (dateFocus) host.querySelector<HTMLInputElement>('input[type="date"]')?.focus();
			};
			const dateText = item.dueIssue ? "날짜 확인" : item.due ? item.due.slice(2).replace(/-/g, "/") : "날짜";
			if (p.archived) { if (item.due || item.dueIssue) row.createSpan({ cls: "pf-ms-date", text: dateText }); }
			else {
				const date = button(row, dateText, () => editItem(true), locked);
				date.addClass("pf-ms-date"); date.setAttr("aria-label", `${item.text} 목표일 ${item.due || "미정"} 수정`);
				date.setAttr("title", item.dueIssue || `목표일: ${item.due || "미정"}`);
			}
			if (!p.archived) {
				const more = button(row, "⋯", () => {}, locked);
				more.addClass("pf-ms-more"); more.setAttr("aria-label", `${item.text} 메뉴`); more.setAttr("aria-haspopup", "menu");
				more.addEventListener("click", e => {
					const menu = new Menu();
					menu.addItem(i => i.setTitle("수정").setIcon("pencil").onClick(() => editItem()));
					menu.addItem(i => i.setTitle("삭제").setIcon("trash-2").setWarning(true).onClick(() => { state.removing = { ...item, source }; state.error = ""; paint(); host.querySelector<HTMLButtonElement>(".pf-ms-remove button")?.focus(); }));
					menu.showAtMouseEvent(e);
				});
			}
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
			form.createDiv({ cls: "pf-ms-hint", text: "달력에 ◆ 마일스톤으로 표시됩니다. 할 일로 추가되지는 않아요." });
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
