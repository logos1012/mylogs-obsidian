/**
 * Drawer 후보 in the Daily Pad: `#서랍후보` / `#프로젝트후보` lines that Tear-off put into
 * `## 결정 대기` (root `AGENTS.md` 「7-5」, 「7-7」). The user has two choices only: 넣기 / 놓아주기
 * (`04 Daily Pad/AGENTS.md` 「3-6」 0). Either way the line leaves `## 결정 대기`, and the section
 * goes when it becomes empty.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

import { parseBodyLines, splitLinesKeepEol, stripEol } from "../parser.ts";
import { findSection, locateLine, sectionLineRange, setFrontmatterScalar } from "../writer.ts";
import { CANDIDATE_TAGS, type DrawerSection, splitSources } from "./model.ts";

export type CandidateKind = "drawer" | "project";

export interface Candidate {
	/** 0-based line index in the Daily Pad file. */
	index: number;
	line: string;
	text: string;
	kind: CandidateKind;
	when: string;
	from: string[];
	/** Tags other than the 후보 tag and `#test`. */
	tags: string[];
	test: boolean;
	/** `(goal:: …)` etc. that the line also carries (kept out of the Drawer line). */
	fields: [string, string][];
}

/** The section a 후보 goes to when the user does not choose one (「7-5」, 「7-7」). */
export function defaultSection(kind: CandidateKind): DrawerSection {
	return kind === "project" ? "프로젝트 후보" : "보류";
}

/** The 후보 lines of `## 결정 대기` (open tasks with a 후보 tag only). */
export function extractCandidates(padText: string, sectionName = "결정 대기"): Candidate[] {
	const sec = findSection(padText, sectionName);
	if (!sec) return [];
	const range = sectionLineRange(padText, sec);
	const out: Candidate[] = [];
	for (const sl of parseBodyLines(splitLinesKeepEol(padText), range.start, range.end)) {
		const it = sl.item;
		if (!it || sl.indent > 0 || it.kind !== "task" || it.status !== "scheduled") continue;
		const kind: CandidateKind | null = it.tags.includes(CANDIDATE_TAGS.project) ? "project" : it.tags.includes(CANDIDATE_TAGS.drawer) ? "drawer" : null;
		if (!kind) continue;
		const f = (k: string) => it.fields.find(([x]) => x === k)?.[1].trim() ?? "";
		out.push({
			index: sl.index,
			line: sl.line,
			text: it.text,
			kind,
			when: f("when"),
			from: splitSources(f("from")),
			tags: it.tags.filter((t) => t !== CANDIDATE_TAGS.project && t !== CANDIDATE_TAGS.drawer),
			test: it.test,
			fields: it.fields.filter(([k]) => k !== "when" && k !== "from"),
		});
	}
	return out;
}

export type RemoveResult = { ok: true; text: string; sectionRemoved: boolean } | { ok: false; reason: string };

/**
 * Remove a 후보 line from `## 결정 대기` (with its sub-bullets). When the section has nothing left,
 * the heading goes too (「3-6」 5: 섹션이 비면 섹션째 지운다). Sets `updated`.
 */
export function removeCandidate(padText: string, ref: { index: number; line: string }, today: string, sectionName = "결정 대기"): RemoveResult {
	const sec = findSection(padText, sectionName);
	if (!sec) return { ok: false, reason: "section-missing" };
	const lines = splitLinesKeepEol(padText);
	const range = sectionLineRange(padText, sec);
	const idx = locateLine(lines, { index: ref.index, line: ref.line, scope: range });
	if (idx === -1) return { ok: false, reason: "line-changed" };
	let end = idx + 1;
	while (end < range.end && /^\s+\S/.test(stripEol(lines[end]))) end++;
	lines.splice(idx, end - idx);
	let out = lines.join("");
	let sectionRemoved = false;
	const again = findSection(out, sectionName);
	if (again) {
		const r = sectionLineRange(out, again);
		const ls = splitLinesKeepEol(out);
		const empty = ls.slice(r.start, r.end).every((l) => !stripEol(l).trim());
		if (empty) {
			ls.splice(again.headingIndex, r.end - again.headingIndex);
			// Without a following heading the file may now end in blank lines: trim to one terminator.
			out = again.hasNext ? ls.join("") : ls.join("").replace(/\s+$/, "\n");
			sectionRemoved = true;
		}
	}
	return { ok: true, text: setFrontmatterScalar(out, "updated", today), sectionRemoved };
}
