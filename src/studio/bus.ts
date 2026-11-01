/**
 * 루미 → 스튜디오: candidates 루미 found for a 「루미에게 찾기」 question. Kept in memory only —
 * nothing is written until the user picks one (「콘텐츠 스튜디오 설계」 ① ✦).
 */

import type { Candidate } from "./model.ts";

type Listener = () => void;

class LumiBus {
	query = "";
	waiting = false;
	results: Candidate[] = [];
	private ls = new Set<Listener>();

	on(fn: Listener): () => void {
		this.ls.add(fn);
		return () => this.ls.delete(fn);
	}
	private emit(): void {
		for (const f of this.ls) f();
	}
	ask(query: string): void {
		this.query = query;
		this.waiting = true;
		this.results = [];
		this.emit();
	}
	put(items: Candidate[], query?: string): void {
		if (query) this.query = query;
		this.results = items;
		this.waiting = false;
		this.emit();
	}
	clear(): void {
		this.query = "";
		this.results = [];
		this.waiting = false;
		this.emit();
	}
	drop(key: string): void {
		this.results = this.results.filter((c) => c.key !== key);
		this.emit();
	}
}

export const lumiBus = new LumiBus();
