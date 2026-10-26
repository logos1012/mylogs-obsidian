import { test } from "node:test";
import assert from "node:assert/strict";
import {
	centerOn,
	columnX,
	edgePath,
	fitView,
	isEmptyMap,
	layoutMap,
	type MapInput,
	type MapLayout,
	type MapNode,
	type MapSub,
	MAX_ZOOM,
	MIN_ZOOM,
	minimapFit,
	NODE_SIZE,
	SIBLING_GAP,
	visibleRect,
	zoomAt,
} from "../src/pinboard/map.ts";

// 김하루's goals (fictional).
function sub(id: string, title: string, related: MapSub["related"] = [], extra: Partial<MapSub> = {}): MapSub {
	return { id, title, status: "active", health: "on-track", progress: 40, current: "4", target: "10", unit: "km", due: "2026-12-31", related, ...extra };
}

const input: MapInput = {
	year: 2026,
	mains: [
		{
			id: "G-2026-01",
			title: "건강한 몸 만들기",
			area: "건강",
			status: "active",
			health: "on-track",
			progress: 45,
			subs: [
				sub("G-2026-01.1", "10km 완주", [
					{ kind: "project", label: "러닝 클럽 가입", path: "05 Project Folders/개인/러닝 클럽/러닝 클럽.md" },
					{ kind: "habit", label: "아침 스트레칭" },
				]),
				sub("G-2026-01.2", "주 3회 근력 운동", [{ kind: "memo", label: "동네 헬스장 알아보기" }]),
			],
		},
		{
			id: "G-2026-02",
			title: "뉴스레터 꾸준히 내기",
			area: "일",
			status: "active",
			health: "at-risk",
			progress: 20,
			subs: [sub("G-2026-02.1", "뉴스레터 12호 발행", [{ kind: "project", label: "뉴스레터", oneSided: true }])],
		},
		{ id: "G-2026-03", title: "제주 한 달 살기", area: "여행", status: "achieved", health: "", progress: 100, subs: [] },
	],
	orphans: [sub("G-2026-04.1", "책 20권 읽기")],
};

const byKey = (l: MapLayout, k: string): MapNode => {
	const n = l.nodes.find((x) => x.key === k);
	assert.ok(n, `node ${k}`);
	return n;
};

function assertNoOverlap(l: MapLayout): void {
	const cols = new Map<number, MapNode[]>();
	for (const n of l.nodes) cols.set(n.x, [...(cols.get(n.x) ?? []), n]);
	for (const col of cols.values()) {
		col.sort((a, b) => a.y - b.y);
		for (let i = 1; i < col.length; i++) {
			assert.ok(col[i - 1].y + col[i - 1].h <= col[i].y, `${col[i - 1].key} overlaps ${col[i].key}`);
		}
	}
}

test("map layout: nodes, columns and edge kinds", () => {
	const l = layoutMap(input);
	const kinds = l.nodes.map((n) => n.kind);
	assert.equal(kinds.filter((k) => k === "root").length, 1);
	assert.equal(kinds.filter((k) => k === "main").length, 3);
	assert.equal(kinds.filter((k) => k === "group").length, 1);
	assert.equal(kinds.filter((k) => k === "sub").length, 4);
	assert.equal(kinds.filter((k) => k === "related").length, 4);

	for (const n of l.nodes) {
		assert.equal(n.x, columnX(n.depth));
		assert.equal(n.w, NODE_SIZE[n.kind].w);
		assert.equal(n.h, NODE_SIZE[n.kind].h);
	}
	assert.ok(columnX(0) < columnX(1) && columnX(1) < columnX(2) && columnX(2) < columnX(3));

	const kindOf = (from: string, to: string) => l.edges.find((e) => e.from === from && e.to === to)?.kind;
	assert.equal(kindOf("root", "main:G-2026-01"), "root");
	assert.equal(kindOf("main:G-2026-01", "sub:G-2026-01.1"), "solid");
	assert.equal(kindOf("sub:G-2026-01.1", "sub:G-2026-01.1/r0"), "dashed");
	assert.equal(kindOf("group:orphans", "sub:G-2026-04.1"), "group");
	assert.equal(l.edges.length, l.nodes.length - 2, "every node but the two tree roots has one edge");

	assert.equal(byKey(l, "main:G-2026-01").childCount, 2);
	assert.equal(byKey(l, "sub:G-2026-01.1").childCount, 2);
	assert.equal(byKey(l, "main:G-2026-03").childCount, 0);
	assert.equal(byKey(l, "sub:G-2026-02.1/r0").related?.oneSided, true);
	assertNoOverlap(l);
});

test("map layout: parents are centred on their children; orphan group sits below", () => {
	const l = layoutMap(input);
	const mid = (n: MapNode) => n.y + n.h / 2;
	const m1 = byKey(l, "main:G-2026-01");
	const a = byKey(l, "sub:G-2026-01.1");
	const b = byKey(l, "sub:G-2026-01.2");
	assert.equal(mid(m1), (mid(a) + mid(b)) / 2);
	assert.equal(b.y - (a.y + a.h) >= SIBLING_GAP.sub, true);

	const rootNode = byKey(l, "root");
	const mains = l.nodes.filter((n) => n.kind === "main");
	assert.equal(mid(rootNode), (mid(mains[0]) + mid(mains[2])) / 2);

	// A single child sits level with its parent.
	const m2 = byKey(l, "main:G-2026-02");
	assert.equal(mid(byKey(l, "sub:G-2026-02.1")), mid(m2));
	assert.equal(mid(byKey(l, "sub:G-2026-02.1/r0")), mid(m2));

	const group = byKey(l, "group:orphans");
	const yearBottom = Math.max(...l.nodes.filter((n) => n.kind !== "group" && n.key !== "sub:G-2026-04.1").map((n) => n.y + n.h));
	assert.ok(group.y > yearBottom);
	assert.equal(l.bounds.x, 0);
	assert.ok(l.bounds.y + l.bounds.h >= group.y + group.h);
});

test("map layout: collapsing hides the subtree and its edges", () => {
	const full = layoutMap(input);
	const l = layoutMap(input, new Set(["main:G-2026-01"]));
	const m1 = byKey(l, "main:G-2026-01");
	assert.equal(m1.collapsed, true);
	assert.equal(m1.childCount, 2, "count stays for the toggle pill");
	assert.equal(l.nodes.some((n) => n.key.startsWith("sub:G-2026-01.")), false);
	assert.equal(l.edges.some((e) => e.from === "main:G-2026-01"), false);
	assert.equal(l.nodes.length, full.nodes.length - 5);
	assert.ok(l.bounds.h < full.bounds.h);
	assertNoOverlap(l);

	const r = layoutMap(input, new Set(["root"]));
	assert.deepEqual(
		r.nodes.map((n) => n.kind),
		["root", "group", "sub"],
	);
	// A key on a childless node changes nothing.
	assert.equal(layoutMap(input, new Set(["main:G-2026-03"])).nodes.find((n) => n.key === "main:G-2026-03")?.collapsed, false);
});

test("map layout: only orphans → no year root; empty input; duplicate ids get unique keys", () => {
	const only = layoutMap({ year: 2026, mains: [], orphans: [sub("G-2026-04.1", "책 20권 읽기")] });
	assert.deepEqual(
		only.nodes.map((n) => n.key),
		["group:orphans", "sub:G-2026-04.1"],
	);
	assert.equal(isEmptyMap({ year: 2026, mains: [], orphans: [] }), true);
	assert.equal(isEmptyMap(input), false);
	assert.deepEqual(layoutMap({ year: 2026, mains: [], orphans: [] }).nodes, []);

	const dup = layoutMap({ year: 2026, mains: [], orphans: [sub("G-2026-05.1", "가"), sub("G-2026-05.1", "나")] });
	const keys = dup.nodes.map((n) => n.key);
	assert.equal(new Set(keys).size, keys.length);
});

test("edgePath: bezier from right middle to left middle", () => {
	const d = edgePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 100, w: 80, h: 20 });
	assert.equal(d, "M 100 20 C 150 20, 150 110, 200 110");
});

test("fitView: centres and never enlarges past 100 %", () => {
	const small = fitView({ x: 0, y: 0, w: 200, h: 100 }, 1000, 600);
	assert.equal(small.k, 1);
	assert.equal(small.x, 400);
	assert.equal(small.y, 250);

	const big = fitView({ x: 0, y: 0, w: 2000, h: 400 }, 1000, 600, 0);
	assert.equal(big.k, 0.5);
	assert.equal(big.x, 0);
	assert.equal(big.y, (600 - 200) / 2);

	assert.equal(fitView({ x: 0, y: 0, w: 1e6, h: 1e6 }, 100, 100).k, MIN_ZOOM);
});

test("zoomAt keeps the point under the cursor; clamps", () => {
	const v = { x: 30, y: -20, k: 1 };
	const z = zoomAt(v, 2, 300, 200);
	const before = { x: (300 - v.x) / v.k, y: (200 - v.y) / v.k };
	const after = { x: (300 - z.x) / z.k, y: (200 - z.y) / z.k };
	assert.deepEqual(after, before);
	assert.equal(zoomAt(v, 100, 0, 0).k, MAX_ZOOM);
	assert.equal(zoomAt(v, 0.001, 0, 0).k, MIN_ZOOM);
});

test("visibleRect / centerOn / minimapFit", () => {
	const v = { x: -100, y: -50, k: 2 };
	assert.deepEqual(visibleRect(v, 400, 300), { x: 50, y: 25, w: 200, h: 150 });

	const c = centerOn(v, 500, 300, 400, 300);
	const r = visibleRect(c, 400, 300);
	assert.equal(r.x + r.w / 2, 500);
	assert.equal(r.y + r.h / 2, 300);
	assert.equal(c.k, 2);

	const m = minimapFit({ x: 0, y: 0, w: 1000, h: 500 }, 200, 120, 0);
	assert.equal(m.s, 0.2);
	assert.equal(m.ox, 0);
	assert.equal(m.oy, (120 - 100) / 2);
});
