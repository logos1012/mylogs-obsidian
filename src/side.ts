/**
 * 개인 / 회사 (root `AGENTS.md` 「6. 줄 형식」 「개인 / 회사」, 계획 「개인 / 회사 분리」).
 *
 *   - a line ending in `#회사` is 회사; no mark is 개인 (`#개인` is never written)
 *   - a line linked to a project (`(project:: …)`) follows that project hub's `scope`
 *   - Pinboard goals carry frontmatter `scope`; Daily Pad splits by section (개인 할 일 / 회사 할 일)
 *
 * The mode (개인 / 회사 / 전체) is a view filter and the default for new lines; it never switches
 * by itself. Pure module (no Obsidian imports).
 */

export type Side = "개인" | "회사";
export type SideMode = Side | "전체";
export const SIDE_MODES: SideMode[] = ["개인", "회사", "전체"];
export const WORK_TAG = "회사";

const WORK_TAG_RE = /(?:^|\s)#회사(?=$|[\s()[\],.])/;
const PROJECT_FIELD_RE = /\(\s*project\s*::\s*([^)]*?)\s*\)/;

/** project id / name / hub link → its hub's scope. */
export type ScopeLookup = (project: string) => Side | undefined;

export function asSide(v: unknown): Side {
	return String(v ?? "").trim() === "회사" ? "회사" : "개인";
}

export function asSideMode(v: unknown): SideMode {
	return (SIDE_MODES as unknown[]).includes(v) ? (v as SideMode) : "전체";
}

export function hasWorkTag(body: string): boolean {
	return WORK_TAG_RE.test(body);
}

/** The project a line is linked to (`(project:: P-…)`, `[[…/허브]]` reduced to its last part). */
export function projectRef(body: string): string {
	const m = PROJECT_FIELD_RE.exec(body);
	if (!m) return "";
	const v = m[1].replace(/^\[\[|\]\]$/g, "").split("|")[0];
	return (v.split("/").pop() ?? v).trim();
}

/** Which side a line belongs to. The linked project wins over the tag. */
export function lineSide(body: string, scopeOf?: ScopeLookup): Side {
	const p = projectRef(body);
	const s = p ? scopeOf?.(p) : undefined;
	if (s) return s;
	return hasWorkTag(body) ? "회사" : "개인";
}

export function shows(side: Side, mode: SideMode): boolean {
	return mode === "전체" || side === mode;
}

/** The side a line added in this mode gets (전체 → 개인: the side we protect). */
export function inputSide(mode: SideMode): Side {
	return mode === "회사" ? "회사" : "개인";
}

/** `내용 (goal:: x)` → `내용 (goal:: x) #회사`. Unchanged when already tagged. */
export function withWorkTag(body: string): string {
	if (hasWorkTag(body)) return body;
	return `${body.replace(/\s+$/, "")} #${WORK_TAG}`;
}

/** Drop every `#회사` tag. */
export function withoutWorkTag(body: string): string {
	return body.replace(/(^|\s)#회사(?=$|[\s()[\],.])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/\s+$/, "");
}

/** Tag a line for the side it should be on (a whole `- [ ] …` line or a body). */
export function setSide(body: string, side: Side): string {
	return side === "회사" ? withWorkTag(body) : withoutWorkTag(body);
}

/** A new line's body in this mode. */
export function forInput(body: string, mode: SideMode): string {
	return inputSide(mode) === "회사" ? withWorkTag(body) : body;
}

/** Build a lookup from project hubs (id, title, folder name, hub file name). */
export function scopeLookup(projects: { id?: string; title?: string; name?: string; path?: string; scope?: string }[]): ScopeLookup {
	const m = new Map<string, Side>();
	for (const p of projects) {
		const s = asSide(p.scope);
		for (const k of [p.id, p.title, p.name, p.path?.split("/").pop()?.replace(/\.md$/, "")]) if (k) m.set(k.trim(), s);
	}
	return (ref) => m.get(ref.replace(/\.md$/, "").trim());
}
