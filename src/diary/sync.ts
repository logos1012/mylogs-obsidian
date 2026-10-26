/**
 * Own-write bookkeeping for the Diary view (pure: no `obsidian` import, unit-tested).
 *
 * Every vault write of `actions.ts` records the text it wrote per path. With that the view can
 * tell its own `modify` events — and Google Drive re-touching the file with the same content
 * after a sync — from a real external edit, and a save never mistakes its own previous write
 * for a conflict (the editor's `base` lags the file while the registry row is still being written).
 */

import { bodiesEqual, bodyOf } from "./model.ts";

const ownWrites = new Map<string, string>();

function key(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function rememberWrite(path: string, text: string): void {
	ownWrites.set(key(path), text);
}

/** The text we last wrote to `path`, or null when this plugin never wrote it. */
export function lastWritten(path: string): string | null {
	return ownWrites.get(key(path)) ?? null;
}

/** True when `text` (the file now) is what this plugin last wrote to `path`, modulo line endings / trailing whitespace. */
export function isOwnWrite(path: string, text: string): boolean {
	const last = lastWritten(path);
	return last !== null && bodiesEqual(last, text);
}

/** For tests. */
export function forgetWrites(): void {
	ownWrites.clear();
}

/**
 * Conflict check of a save: the file's body must be what the editor last synced with (`expectBody`)
 * or what we last wrote there (a save whose result the editor has not seen yet). Both compared as
 * normalized bodies (`bodiesEqual`), never raw text. `expectBody === null` skips the check.
 */
export function isConflict(fileText: string, expectBody: string | null, path: string): boolean {
	if (expectBody === null) return false;
	const fileBody = bodyOf(fileText);
	if (bodiesEqual(fileBody, expectBody)) return false;
	const last = lastWritten(path);
	return !(last !== null && bodiesEqual(fileBody, bodyOf(last)));
}
