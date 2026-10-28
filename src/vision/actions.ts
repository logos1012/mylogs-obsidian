import { type App, normalizePath, TFile } from "obsidian";
import { prependChangeLog } from "../desk/ops.ts";
import { setFrontmatterScalar } from "../writer.ts";
import { parseVisionBoard, type VisionBoard, visionPath } from "./model.ts";

/** `<folder>/Vision Board.md`, or null when it does not exist yet. */
export function visionFile(app: App, folder: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(normalizePath(visionPath(folder)));
	return f instanceof TFile ? f : null;
}

/**
 * Edit `Vision Board.md` (the screen and 루미 share this): `fn` returns the new text. Adds the
 * change-log line and `updated`. Throws when the file is missing.
 */
export async function editVisionBoard(app: App, folder: string, today: string, what: string, fn: (text: string, board: VisionBoard) => string): Promise<void> {
	const f = visionFile(app, folder);
	if (!f) throw new Error("Vision Board.md가 없어요. Vision Board 화면에서 먼저 만들어 주세요.");
	await app.vault.process(f, (t) => prependChangeLog(setFrontmatterScalar(fn(t, parseVisionBoard(t)), "updated", today), today, what));
}
