/**
 * Field-level edits of one list-line body (the part after `- `), following the root `AGENTS.md`
 * 「6. 줄 형식」:
 *
 *   [checkbox] [~~] [lead: Wall date `10/15 14:00` / Desk time `14:00`] content [→ …] [~~] (fields) #tags
 *
 * Only the part being edited changes: the checkbox, arrow, every `(key:: value)` field and every
 * tag stay exactly where they were. Used by the Wall Calendar and Desk Calendar "수정" dialogs.
 *
 * Pure module (no Obsidian imports) so it can be unit-tested with `node --test`.
 */

/** `(key:: value)`. */
const FIELD_RE = /\(\s*([A-Za-z_][\w-]*)\s*::\s*([^)]*?)\s*\)/g;
const TAG_RE = /(?:(?<=\s)|^)#[^\s#()[\],.]+/g;
/** Trailing run of tags and fields (with the whitespace before each). */
const DECOR_RE = /((?:\s+(?:#[^\s#()[\],.]+|\(\s*[A-Za-z_][\w-]*\s*::[^)]*\)))*)(\s*)$/;
const TRAILING_TAGS_RE = /(?:\s+#[^\s#()[\],.]+)+\s*$/;
const ARROW_RE = /\s*(?:→|->)\s*.*$/;
const CHECKBOX_RE = /^\[(.)\](?:[ \t]+|$)/;

/** Desk Calendar / Daily Pad lead: a time at the start of the content. */
export const TIME_LEAD_RE = /^\d{1,2}:\d{2}(?:\s*~\s*\d{1,2}:\d{2})?(?=\s|$)\s*/;

export interface ContentParts {
	/** Checkbox (with its space) and the opening `~~` of a struck-through item. */
	pre: string;
	/** Date / time prefix (with its trailing space), or "". */
	lead: string;
	/** The editable text (may still contain fields/tags written in the middle). */
	content: string;
	/** Everything after the content: arrow, closing `~~`, trailing fields and tags. */
	post: string;
}

/** Split a body into its parts. `pre + lead + content + post === body` always holds. */
export function splitContent(body: string, leadRe: RegExp | null = null): ContentParts {
	let pre = "";
	let rest = body;
	const cm = CHECKBOX_RE.exec(rest);
	if (cm) {
		pre = cm[0];
		rest = rest.slice(cm[0].length);
	}
	const strike = rest.startsWith("~~") && rest.indexOf("~~", 2) > 2;
	if (strike) {
		pre += "~~";
		rest = rest.slice(2);
	}
	let lead = "";
	if (leadRe) {
		const lm = leadRe.exec(rest);
		// A lead alone inside the strike (`~~10/15~~`) is not a lead.
		if (lm && lm.index === 0 && !(strike && rest.slice(lm[0].length).startsWith("~~"))) {
			lead = lm[0];
			rest = rest.slice(lm[0].length);
		}
	}
	if (strike) {
		const close = rest.indexOf("~~");
		const inner = rest.slice(0, close);
		const content = inner.replace(/\s+$/, "");
		return { pre, lead, content, post: inner.slice(content.length) + rest.slice(close) };
	}
	const dm = DECOR_RE.exec(rest)!;
	let head = rest.slice(0, dm.index);
	let post = rest.slice(dm.index);
	const am = ARROW_RE.exec(head);
	if (am) {
		post = head.slice(am.index) + post;
		head = head.slice(0, am.index);
	}
	const content = head.replace(/\s+$/, "");
	return { pre, lead, content, post: head.slice(content.length) + post };
}

/** One line, single spaces. */
export function cleanText(s: string): string {
	return s.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** A field value that can't break the `(key:: value)` syntax. */
export function cleanFieldValue(s: string): string {
	return cleanText(s.replace(/[()]/g, ""));
}

/** The content as the user would edit it: no fields or tags written in the middle. */
export function contentText(body: string, leadRe: RegExp | null = null): string {
	return cleanText(splitContent(body, leadRe).content.replace(FIELD_RE, " ").replace(TAG_RE, " "));
}

function join(p: ContentParts): string {
	let post = p.post;
	if (post && p.content && !/^\s/.test(post) && !post.startsWith("~~")) post = ` ${post}`;
	return p.pre + p.lead + p.content + post;
}

/**
 * Replace the content text. Fields and tags that were written in the middle of the old content
 * are kept (after the new text), so nothing but the words changes.
 */
export function replaceContent(body: string, text: string, leadRe: RegExp | null = null): string {
	const p = splitContent(body, leadRe);
	const kept = [...p.content.matchAll(FIELD_RE)].map((m) => m[0]);
	const noFields = p.content.replace(FIELD_RE, " ");
	kept.push(...[...noFields.matchAll(TAG_RE)].map((m) => m[0]));
	const next = [cleanText(text), ...kept].filter(Boolean).join(" ");
	return join({ ...p, content: next });
}

/** Replace (or add / with "" remove) the lead. `lead` is written followed by one space. */
export function setLead(body: string, lead: string, leadRe: RegExp): string {
	const p = splitContent(body, leadRe);
	const l = lead.trim();
	return join({ ...p, lead: l ? `${l} ` : "" });
}

/** The value of `(key:: …)`, or "". */
export function getField(body: string, key: string): string {
	for (const m of body.matchAll(FIELD_RE)) if (m[1] === key) return m[2].trim();
	return "";
}

/**
 * Set `(key:: value)` in place; add it before the trailing tags (after the other fields) when absent;
 * remove it (with the space before it) when `value` is empty.
 */
export function setField(body: string, key: string, value: string): string {
	const v = cleanFieldValue(value);
	const re = new RegExp(`(\\s*)\\(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*::[^)]*\\)`);
	const m = re.exec(body);
	if (m) {
		if (!v) return (body.slice(0, m.index) + body.slice(m.index + m[0].length)).replace(/[ \t]{2,}/g, " ").replace(/\s+$/, "");
		return body.slice(0, m.index) + `${m[1]}(${key}:: ${v})` + body.slice(m.index + m[0].length);
	}
	if (!v) return body;
	const piece = `(${key}:: ${v})`;
	const t = TRAILING_TAGS_RE.exec(body);
	if (!t || t.index === 0) return `${body.replace(/\s+$/, "")} ${piece}`;
	return `${body.slice(0, t.index)} ${piece}${body.slice(t.index).replace(/\s+$/, "")}`;
}

/** Apply several field edits (`undefined` = leave as is). */
export function setFields(body: string, fields: Record<string, string | undefined>): string {
	let out = body;
	for (const [k, v] of Object.entries(fields)) if (v !== undefined && v.trim() !== getField(out, k)) out = setField(out, k, v);
	return out;
}

/** Normalise a typed time: `9:00` → `09:00`, `9:00~10:30` → `09:00~10:30`. Null when invalid; "" stays "". */
export function normalizeTime(input: string): string | null {
	const s = input.trim();
	if (!s) return "";
	const m = /^(\d{1,2}):(\d{2})(?:\s*~\s*(\d{1,2}):(\d{2}))?$/.exec(s);
	if (!m) return null;
	const ok = (h: string, mm: string) => +h < 24 && +mm < 60;
	if (!ok(m[1], m[2]) || (m[3] && !ok(m[3], m[4]))) return null;
	const f = (h: string, mm: string) => `${h.padStart(2, "0")}:${mm}`;
	return f(m[1], m[2]) + (m[3] ? `~${f(m[3], m[4])}` : "");
}

/** Remove the line at `idx` from `lines` (terminators kept), without leaving a dangling newline. */
export function spliceLine(lines: string[], idx: number): string {
	const hadEol = /\n$/.test(lines[idx]);
	lines.splice(idx, 1);
	if (!hadEol && idx > 0 && idx === lines.length) lines[idx - 1] = lines[idx - 1].replace(/\r?\n$/, "");
	return lines.join("");
}

/** `14:00 회의 #회사` → `~~14:00 회의~~ #회사` (cancelled event, root 「6」). Already struck: unchanged. */
export function strikeContent(body: string, leadRe: RegExp | null = null): string {
	const p = splitContent(body, leadRe);
	if (p.pre.endsWith("~~")) return body;
	const post = p.post.replace(/^\s+/, "");
	return `${p.pre}~~${p.lead}${p.content}~~${post ? ` ${post}` : ""}`;
}
