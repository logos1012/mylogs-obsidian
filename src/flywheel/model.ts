/**
 * Flywheel model: `12 Flywheel/Flywheel.md` (`12 Flywheel/AGENTS.md` 「3」) and the Daily Pad
 * lines it produces every morning (「4-2」, `04 Daily Pad/_build/new_day.py` → `flywheel_lines()`).
 *
 *   ## F-1 몸 만들기
 *   - 최소:: 걷기 15분
 *   - status:: 사용
 *
 * becomes `- [ ] F-1 몸 만들기 — 걷기 15분 (flywheel:: F-1)` at the top of `## 오늘 할 일`. The
 * parser and the line format are a faithful port of the Python so a day made by the plugin is
 * byte-identical to one made by `new_day.py`. There is no Flywheel view (계획 「10」): the user
 * checks the line or leaves it; Tear-off counts and marks `(missed:: N)` (「4-3」).
 *
 * Pure module (no Obsidian imports).
 */

import { TASK_LINE_RE } from "../parser.ts";

export interface FlywheelElement {
	/** `F-N`, never reused (「3」). */
	id: string;
	name: string;
	/** Every `- 키:: 값` line of the block, keys as written (정체성, 최소, 보통, 다음, 선행지표, goal, status, since). */
	fields: Record<string, string>;
	/** `status::` — 사용 / 쉼 / 폐기; `사용` when the field is missing (as in the Python). */
	status: string;
}

export const FLYWHEEL_FILE = "Flywheel.md";

/** `<folder>/Flywheel.md` */
export function flywheelPath(folder: string): string {
	const f = folder.trim().replace(/^\/+|\/+$/g, "");
	return f ? `${f}/${FLYWHEEL_FILE}` : FLYWHEEL_FILE;
}

/**
 * Elements of `Flywheel.md` in file order. Mirrors `new_day.py`: a block starts at `## F-`,
 * ends at the next `## ` heading, and any `- 키:: 값` line inside is a field. `null` (no file) → [].
 */
export function parseFlywheel(text: string | null): FlywheelElement[] {
	if (text === null) return [];
	const out: FlywheelElement[] = [];
	let cur: FlywheelElement | null = null;
	for (const raw of text.split(/\r?\n/)) {
		if (raw.startsWith("## F-")) {
			if (cur) out.push(cur);
			const rest = raw.slice(3);
			const sp = rest.indexOf(" ");
			const id = sp === -1 ? rest : rest.slice(0, sp);
			const name = sp === -1 ? "" : rest.slice(sp + 1).trim();
			cur = { id, name, fields: {}, status: "사용" };
		} else if (cur && raw.startsWith("- ") && raw.includes("::")) {
			const body = raw.slice(2);
			const k = body.slice(0, body.indexOf("::")).trim();
			const v = body.slice(body.indexOf("::") + 2).trim();
			cur.fields[k] = v;
			if (k === "status") cur.status = v;
		} else if (raw.startsWith("## ") && cur) {
			out.push(cur);
			cur = null;
		}
	}
	if (cur) out.push(cur);
	return out;
}

/** Elements that go into today's Daily Pad: `status:: 사용` only (쉼·폐기 are skipped). */
export function activeElements(elements: FlywheelElement[]): FlywheelElement[] {
	return elements.filter((e) => e.status === "사용");
}

/**
 * `- [ ] F-1 이름 — 최소 (flywheel:: F-1)`; without ` — ` when 최소 is empty. Exactly the
 * Python f-string plus its `.replace(" —  (", " (")`.
 */
export function flywheelLine(e: FlywheelElement): string {
	const min = e.fields["최소"] ?? "";
	return `- [ ] ${e.id} ${e.name} — ${min} (flywheel:: ${e.id})`.replaceAll(" —  (", " (");
}

/** `new_day.py` → `flywheel_lines()`: one line per `사용` element, in file order. */
export function flywheelLines(elements: FlywheelElement[]): string[] {
	return activeElements(elements).map(flywheelLine);
}

// ───────────────────────── Daily Pad lines ─────────────────────────

const FLYWHEEL_FIELD_RE = /\(\s*flywheel\s*::\s*(F-\d+)\s*\)/;
const MISSED_FIELD_RE = /\(\s*missed\s*::\s*(\d+)\s*\)/;

/** The `F-N` of a Daily Pad line carrying `(flywheel:: F-N)`, else null. */
export function flywheelIdOf(line: string): string | null {
	return FLYWHEEL_FIELD_RE.exec(line)?.[1] ?? null;
}

/** A Flywheel line is checked or left — it never gets the 못 한 일 menu (「4-2」 3, 「4-3」 4). */
export function isFlywheelLine(line: string): boolean {
	return FLYWHEEL_FIELD_RE.test(line);
}

/** `(missed:: N)` — Tear-off's "two days in a row" mark (「4-3」 3); null when absent. */
export function missedCount(line: string): number | null {
	const m = MISSED_FIELD_RE.exec(line);
	return m ? parseInt(m[1], 10) : null;
}

/**
 * Completions per element across one week's Daily Pad texts (null = no file that day): a day
 * counts once for `F-N` when a `(flywheel:: F-N)` task line is `[x]`. Feeds the `n/7` badge.
 */
export function weeklyDone(texts: (string | null)[]): Map<string, number> {
	const done = new Map<string, number>();
	for (const text of texts) {
		if (text === null || !text.includes("flywheel")) continue;
		const seen = new Set<string>();
		for (const line of text.split(/\r?\n/)) {
			const id = flywheelIdOf(line);
			if (!id || seen.has(id)) continue;
			const m = TASK_LINE_RE.exec(line);
			if (m && m[2].toLowerCase() === "x") {
				seen.add(id);
				done.set(id, (done.get(id) ?? 0) + 1);
			}
		}
	}
	return done;
}
