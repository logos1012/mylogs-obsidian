/** Optimistic multi-file writes. No silent partial success and no overwriting concurrent edits. */
export interface Write { path: string; before: string | null; after: string }
export interface BatchIO {
	read(path: string): Promise<string | null>;
	create(path: string, text: string): Promise<void>;
	compareWrite(path: string, before: string, after: string): Promise<void>;
	trashIfUnchanged(path: string, text: string): Promise<void>;
	ensureFolder?(path: string): Promise<void>;
	cleanupCreatedFolders?(): Promise<void>;
}
export async function commitBatch(io: BatchIO, writes: Write[], folders: string[] = []): Promise<void> {
	if (new Set(writes.map(w => w.path)).size !== writes.length) throw new Error("중복 저장 경로가 있어요.");
	for (const w of writes) if (await io.read(w.path) !== w.before) throw new Error(`파일이 바뀌었어요. 다시 열어 주세요: ${w.path}`);
	const done: Write[] = [];
	try {
		for (const folder of folders) await io.ensureFolder?.(folder);
		for (const w of writes) {
			if (w.before === w.after) continue;
			if (w.before === null) await io.create(w.path, w.after);
			else await io.compareWrite(w.path, w.before, w.after);
			done.push(w);
		}
	} catch (err) {
		const failed: string[] = [];
		for (const w of done.reverse()) {
			try {
				if (w.before === null) await io.trashIfUnchanged(w.path, w.after);
				else await io.compareWrite(w.path, w.after, w.before);
			} catch { failed.push(w.path); }
		}
		try { await io.cleanupCreatedFolders?.(); } catch (err) { failed.push(String(err)); }
		throw new Error(`${String(err)}\n${failed.length ? `부분 저장 — 직접 확인할 파일: ${failed.join(", ")}` : "이번 저장을 취소했어요. 새 파일은 휴지통에서 복구할 수 있어요."}`);
	}
}
