/**
 * Toolbox on a phone (계획 「11. 모바일」): each section's table becomes one card per skill (the
 * desktop row, laid out as label · value lines by CSS) and the inline status buttons become one
 * 「상태」 button with a picker — the same `setStatus` the buttons call. The row menu opens from
 * ⋯ or a long press.
 *
 * Reached only through `ToolboxView.renderSection()`'s `Platform.isMobile` dispatch.
 */

import type { App } from "obsidian";
import { enableTouchMenus, pickTarget } from "../ui/mobile.ts";
import { type Entry, entryKind, liveStatuses, type Skill, type SkillKind } from "./model.ts";
import type { ToolboxData } from "./actions.ts";

type LiveEntry = Extract<Entry, { kind: "both" | "file-only" }>;

export interface ToolboxMobileHost<C extends string> {
	app: App;
	contentEl: HTMLElement;
	cols(kind: SkillKind): C[];
	colLabel(c: C): string;
	lead(kind: SkillKind): string;
	statusHint(kind: SkillKind, status: string): string;
	renderRow(body: HTMLElement, cols: C[], e: LiveEntry, today: string): void;
	renderGhostRow(body: HTMLElement, cols: C[], e: Entry): void;
	setStatus(s: Skill, to: string): Promise<unknown>;
	register(cb: () => void): void;
}

const installed = new WeakSet<HTMLElement>();

export function renderToolboxSectionMobile<C extends string>(h: ToolboxMobileHost<C>, root: HTMLElement, kind: SkillKind, d: ToolboxData, today: string): void {
	if (!installed.has(h.contentEl)) {
		installed.add(h.contentEl);
		root.addClass("tb-m");
		h.register(enableTouchMenus(h.contentEl));
	}
	const entries = d.entries.filter((e) => entryKind(e) === kind);
	const sec = root.createDiv({ cls: `tb-section kind-${kind}` });
	const head = sec.createDiv({ cls: "tb-section-head" });
	head.createEl("h2", { text: kind });
	head.createSpan({ cls: "tb-section-count", text: `${entries.length}` });
	head.createSpan({ cls: "tb-section-lead", text: h.lead(kind) });
	if (!entries.length) {
		sec.createDiv({ cls: "tb-section-empty", text: `${kind} 스킬이 없어요.` });
		return;
	}
	const cols = h.cols(kind);
	for (const e of entries) {
		const card = sec.createDiv({ cls: "tb-m-card" });
		const body = card.createEl("table", { cls: "tb-table tb-m-table" }).createEl("tbody");
		if (e.kind === "row-only") h.renderGhostRow(body, cols, e);
		else h.renderRow(body, cols, e, today);
		const tr = body.lastElementChild;
		if (!tr) continue;
		Array.from(tr.children).forEach((td, i) => {
			const label = cols[i] ? h.colLabel(cols[i]) : "";
			if (label) td.setAttribute("data-label", label);
		});
		if (e.kind !== "row-only") statusPicker(h, tr as HTMLElement, e.skill);
	}
}

/** Replace the 2–3 inline status buttons with one button → picker → the same `setStatus`. */
function statusPicker<C extends string>(h: ToolboxMobileHost<C>, tr: HTMLElement, s: Skill): void {
	const seg = tr.querySelector<HTMLElement>(".tb-seg");
	if (!seg) return;
	const b = createEl("button", { cls: `tb-m-status tb-status st-${s.status} is-active`, attr: { type: "button", "aria-label": `${s.name} 상태 바꾸기` } });
	b.createSpan({ text: s.status || "—" });
	b.createSpan({ cls: "tb-m-caret", text: "▾" });
	b.addEventListener("click", async (e) => {
		e.stopPropagation();
		const options = liveStatuses(s.kind)
			.filter((v) => v !== s.status)
			.map((v) => ({ label: `${v}으로`, sub: h.statusHint(s.kind, v), value: v }));
		const t = await pickTarget(h.app, `「${s.name}」 상태`, options);
		if (t) await h.setStatus(s, t.value);
	});
	seg.replaceWith(b);
}
