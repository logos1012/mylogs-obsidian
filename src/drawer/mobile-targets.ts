/**
 * Where a Drawer card or 후보 can go on a phone, where drag and drop does not exist (계획 「11」).
 *
 * `drawerItemTargets` / `candidateTargets` list exactly the desktop drop zones that accept it
 * (columns, the 꺼내기 dock, 놓아주기 — `renderColumn` / `renderDock` in `view.ts`), and
 * `runDrawerTarget` maps each one to the call that zone's `drop` makes. Pure; tested in
 * `test/mobile-targets.test.ts`.
 */

import { DRAWER_SECTIONS, type DrawerSection } from "./model.ts";

/** The dock's 꺼내기 targets (desktop `TakeTarget`). */
export type DrawerTake = "today" | "month" | "wall" | "project";

export type DrawerTarget =
	| { op: "section"; section: DrawerSection; label: string; sub: string; icon: string }
	| { op: "take"; take: DrawerTake; label: string; sub: string; icon: string }
	| { op: "letgo"; label: string; sub: string; icon: string };

export type CandidateTarget = { op: "accept"; section: DrawerSection; label: string; sub: string; icon: string } | { op: "drop"; label: string; sub: string; icon: string };

const TAKES: { take: DrawerTake; label: string; sub: (ym: string) => string; icon: string }[] = [
	{ take: "today", label: "꺼내기: 오늘", sub: () => "Daily Pad 오늘 할 일", icon: "sun" },
	{ take: "month", label: "꺼내기: 이달 Desk", sub: (ym) => `${ym} 인박스 (Desk 파일이 없으면 Wall)`, icon: "calendar-days" },
	{ take: "wall", label: "꺼내기: Wall · 달 선택…", sub: () => "미래의 달 (그 달 Desk 파일이 있으면 Desk)", icon: "calendar-range" },
	{ take: "project", label: "꺼내기: 프로젝트로…", sub: () => "새 프로젝트 창을 이름·출처로 채워 열기", icon: "folder-kanban" },
];

/**
 * A card: the other two columns (`renderColumn` accepts an active item of another section), the
 * four 꺼내기 targets and 놓아주기 (the dock accepts any active item). Departed lines go nowhere.
 */
export function drawerItemTargets(it: { section: DrawerSection; active: boolean }, ym: string): DrawerTarget[] {
	if (!it.active) return [];
	const out: DrawerTarget[] = [];
	for (const s of DRAWER_SECTIONS) if (s !== it.section) out.push({ op: "section", section: s, label: `${s}(으)로 옮기기`, sub: "섹션 옮김", icon: "arrow-right-left" });
	for (const t of TAKES) out.push({ op: "take", take: t.take, label: t.label, sub: t.sub(ym), icon: t.icon });
	out.push({ op: "letgo", label: "놓아주기…", sub: "하지 않기로 한다 · 이유를 한 줄 남겨요", icon: "circle-slash" });
	return out;
}

/** A 후보: any column (넣기와 분류를 한 번에; columns accept every candidate), or 놓아주기 (its button). */
export function candidateTargets(defaultSection: DrawerSection): CandidateTarget[] {
	const out: CandidateTarget[] = DRAWER_SECTIONS.map((s) => ({ op: "accept", section: s, label: `${s}에 넣기`, sub: s === defaultSection ? "기본 섹션" : "넣기와 분류를 한 번에", icon: "archive" }) as CandidateTarget);
	out.push({ op: "drop", label: "놓아주기", sub: "기록 없이 후보 줄을 지워요", icon: "circle-slash" });
	return out;
}

/** The calls the desktop drop zones make (`view.ts`). */
export interface DrawerMoveApi<I, C> {
	/** column drop of a card: `run(() => moveToSection(plugin, item, section))` */
	moveToSection(item: I, section: DrawerSection): Promise<unknown>;
	/** 꺼내기 drop: `takeOut(item, id)` */
	takeOut(item: I, take: DrawerTake): Promise<unknown>;
	/** 놓아주기 drop: `chooseLetGo(item)` */
	letGo(item: I): Promise<unknown>;
	/** column drop of a 후보: `acceptCand(cand, section)` */
	acceptCand(cand: C, section: DrawerSection): Promise<unknown>;
	/** 후보 놓아주기 button: `dropCand(cand)` */
	dropCand(cand: C): Promise<unknown>;
}

export function runDrawerTarget<I, C>(t: DrawerTarget, item: I, api: DrawerMoveApi<I, C>): Promise<unknown> {
	switch (t.op) {
		case "section":
			return api.moveToSection(item, t.section);
		case "take":
			return api.takeOut(item, t.take);
		case "letgo":
			return api.letGo(item);
	}
}

export function runCandidateTarget<I, C>(t: CandidateTarget, cand: C, api: DrawerMoveApi<I, C>): Promise<unknown> {
	return t.op === "accept" ? api.acceptCand(cand, t.section) : api.dropCand(cand);
}
