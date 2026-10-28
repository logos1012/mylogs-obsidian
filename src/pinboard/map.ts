/**
 * Pinboard 전략 맵 (Pinboard 개편 스펙 「2. 전략 맵」, 「1-5. 연결」).
 *
 * A left → right tree: 목표 → Main Goal → Sub Goal → 관련 업무 (projects, habits, memos).
 * Cards are absolutely positioned HTML inside a transformed canvas; edges are an SVG layer under
 * them. Solid edge = Sub → Main (counts toward progress). Dashed edge = 관련 업무 → Sub (no
 * progress contribution).
 *
 * The layout and the view maths (fit, zoom, minimap) are pure functions with no DOM and no
 * Obsidian runtime import, tested in `test/pinboard-map.test.ts`. Icons are inline SVG for the
 * same reason (the `obsidian` package has no runtime under `node --test`).
 */

// ───────────────────────── input ─────────────────────────

export interface MapRelated {
	contributes?: boolean;
	kind: "project" | "habit" | "memo";
	label: string;
	path?: string;
	oneSided?: boolean;
}
export interface MapSub {
	id: string;
	title: string;
	status: string;
	health: string;
	progress: number | null;
	current: string;
	target: string;
	unit: string;
	due: string;
	related: MapRelated[];
}
export interface MapMain {
	id: string;
	title: string;
	area: string;
	status: string;
	health: string;
	progress: number;
	subs: MapSub[];
}
export interface MapInput {
	year: number;
	/** The root node's name (goals are not cut by year): 「개인 목표」 · 「회사 목표」 · 「내 목표」. */
	title?: string;
	mains: MapMain[];
	orphans: MapSub[];
}
export interface MapCallbacks {
	openGoal(id: string): void;
	openFile(path: string): void;
}

// ───────────────────────── layout (pure) ─────────────────────────

export type MapNodeKind = "root" | "main" | "group" | "sub" | "related";
/** root: year → Main. solid: Main ← Sub (progress). dashed: Sub ← 관련 업무. group: 상위 목표 없음 → Sub. */
export type MapEdgeKind = "root" | "solid" | "dashed" | "group";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MapNode extends Rect {
	key: string;
	kind: MapNodeKind;
	depth: number;
	parentKey: string | null;
	/** All children, shown or not. */
	childCount: number;
	collapsed: boolean;
	/** Kind of the edge from the parent to this node (null for tree roots). */
	edge: MapEdgeKind | null;
	main?: MapMain;
	sub?: MapSub;
	related?: MapRelated;
}

export interface MapEdge {
	from: string;
	to: string;
	kind: MapEdgeKind;
	d: string;
}

export interface MapLayout {
	nodes: MapNode[];
	edges: MapEdge[];
	bounds: Rect;
}

export const NODE_SIZE: Readonly<Record<MapNodeKind, { w: number; h: number }>> = {
	root: { w: 148, h: 60 },
	main: { w: 264, h: 112 },
	group: { w: 264, h: 60 },
	sub: { w: 264, h: 128 },
	related: { w: 216, h: 40 },
};
/** Width of each depth column (root, Main, Sub, 관련 업무). */
const COL_W = [148, 264, 264, 216];
export const COL_GAP = 76;
/** Vertical gap between siblings, by the siblings' kind. */
export const SIBLING_GAP: Readonly<Record<MapNodeKind, number>> = { root: 0, main: 34, group: 0, sub: 24, related: 10 };
/** Gap between the year tree and the 상위 목표 없음 group. */
export const GROUP_GAP = 64;
/** The expand/collapse pill straddles the bottom edge of a card; this much hangs below it. */
export const PILL_OVERHANG = 12;

export function columnX(depth: number): number {
	let x = 0;
	for (let d = 0; d < depth; d++) x += COL_W[Math.min(d, COL_W.length - 1)] + COL_GAP;
	return x;
}

interface TreeNode {
	key: string;
	kind: MapNodeKind;
	edge: MapEdgeKind | null;
	children: TreeNode[];
	main?: MapMain;
	sub?: MapSub;
	related?: MapRelated;
}

export function isEmptyMap(input: MapInput): boolean {
	return input.mains.length === 0 && input.orphans.length === 0;
}

/** Year tree (when there are Mains) and the orphan group (when there are orphans). Keys are unique. */
function buildForest(input: MapInput): TreeNode[] {
	const seen = new Map<string, number>();
	const unique = (k: string): string => {
		const n = seen.get(k) ?? 0;
		seen.set(k, n + 1);
		return n === 0 ? k : `${k}#${n + 1}`;
	};
	const subNode = (s: MapSub, edge: MapEdgeKind): TreeNode => {
		const key = unique(`sub:${s.id}`);
		return {
			key,
			kind: "sub",
			edge,
			sub: s,
			children: s.related.map((r, i) => ({ key: `${key}/r${i}`, kind: "related" as const, edge: r.contributes ? "solid" as const : "dashed" as const, related: r, children: [] })),
		};
	};
	const forest: TreeNode[] = [];
	if (input.mains.length) {
		forest.push({
			key: "root",
			kind: "root",
			edge: null,
			children: input.mains.map((m) => ({
				key: unique(`main:${m.id}`),
				kind: "main" as const,
				edge: "root" as const,
				main: m,
				children: m.subs.map((s) => subNode(s, "solid")),
			})),
		});
	}
	if (input.orphans.length) {
		forest.push({ key: "group:orphans", kind: "group", edge: null, children: input.orphans.map((s) => subNode(s, "group")) });
	}
	return forest;
}

function depthOf(kind: MapNodeKind): number {
	return kind === "root" ? 0 : kind === "main" || kind === "group" ? 1 : kind === "sub" ? 2 : 3;
}

/** Bezier from the right middle of `a` to the left middle of `b`. */
export function edgePath(a: Rect, b: Rect): string {
	const x1 = a.x + a.w;
	const y1 = a.y + a.h / 2;
	const x2 = b.x;
	const y2 = b.y + b.h / 2;
	const dx = Math.max(24, (x2 - x1) / 2);
	const r = (n: number) => Math.round(n * 10) / 10;
	return `M ${r(x1)} ${r(y1)} C ${r(x1 + dx)} ${r(y1)}, ${r(x2 - dx)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

/**
 * Node positions for the tree with `collapsed` node keys folded. Each parent sits vertically
 * centred on its shown children; subtrees stack without overlap.
 */
export function layoutMap(input: MapInput, collapsed: ReadonlySet<string> = new Set()): MapLayout {
	const forest = buildForest(input);
	const shown = (t: TreeNode) => (collapsed.has(t.key) ? [] : t.children);
	const gapsOf = (kids: TreeNode[]) => (kids.length > 1 ? SIBLING_GAP[kids[0].kind] * (kids.length - 1) : 0);

	const memo = new Map<string, number>();
	const measure = (t: TreeNode): number => {
		const cached = memo.get(t.key);
		if (cached !== undefined) return cached;
		const kids = shown(t);
		const own = NODE_SIZE[t.kind].h;
		const span = kids.length ? kids.reduce((s, c) => s + measure(c), 0) + gapsOf(kids) : 0;
		const v = Math.max(own, span);
		memo.set(t.key, v);
		return v;
	};

	const nodes: MapNode[] = [];
	/** Places `t`'s subtree in the band [top, top + measure(t)]; returns its node. */
	const place = (t: TreeNode, top: number, parentKey: string | null): MapNode => {
		const size = NODE_SIZE[t.kind];
		const depth = depthOf(t.kind);
		const total = measure(t);
		const node: MapNode = {
			key: t.key,
			kind: t.kind,
			depth,
			x: columnX(depth),
			y: top + (total - size.h) / 2,
			w: size.w,
			h: size.h,
			parentKey,
			childCount: t.children.length,
			collapsed: t.children.length > 0 && collapsed.has(t.key),
			edge: t.edge,
			main: t.main,
			sub: t.sub,
			related: t.related,
		};
		nodes.push(node);
		const kids = shown(t);
		if (!kids.length) return node;
		const span = kids.reduce((s, c) => s + measure(c), 0) + gapsOf(kids);
		let cursor = top + (total - span) / 2;
		const placed: MapNode[] = [];
		for (const c of kids) {
			placed.push(place(c, cursor, node.key));
			cursor += measure(c) + SIBLING_GAP[c.kind];
		}
		// Centre on the first and last child cards (not their bands), staying inside our own band.
		const first = placed[0];
		const last = placed[placed.length - 1];
		const want = (first.y + first.h / 2 + last.y + last.h / 2) / 2 - size.h / 2;
		node.y = Math.min(top + total - size.h, Math.max(top, want));
		return node;
	};

	let top = 0;
	for (const t of forest) {
		place(t, top, null);
		top += measure(t) + GROUP_GAP;
	}
	const byKey = new Map(nodes.map((n) => [n.key, n]));
	const edges: MapEdge[] = [];
	for (const n of nodes) {
		const p = n.parentKey ? byKey.get(n.parentKey) : undefined;
		if (p && n.edge) edges.push({ from: p.key, to: n.key, kind: n.edge, d: edgePath(p, n) });
	}
	return { nodes, edges, bounds: boundsOf(nodes) };
}

function boundsOf(nodes: MapNode[]): Rect {
	if (!nodes.length) return { x: 0, y: 0, w: 0, h: 0 };
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const n of nodes) {
		x0 = Math.min(x0, n.x);
		y0 = Math.min(y0, n.y);
		x1 = Math.max(x1, n.x + n.w);
		y1 = Math.max(y1, n.y + n.h + (n.childCount ? PILL_OVERHANG : 0));
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ───────────────────────── view maths (pure) ─────────────────────────

/** Screen = content * k + (x, y). */
export interface View {
	x: number;
	y: number;
	k: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2;

export function clampZoom(k: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** Whole `bounds` centred in a `vw` × `vh` viewport, never enlarged past 100 %. */
export function fitView(bounds: Rect, vw: number, vh: number, pad = 40): View {
	const bw = Math.max(1, bounds.w);
	const bh = Math.max(1, bounds.h);
	const k = clampZoom(Math.min((vw - 2 * pad) / bw, (vh - 2 * pad) / bh, 1));
	return { k, x: (vw - bw * k) / 2 - bounds.x * k, y: (vh - bh * k) / 2 - bounds.y * k };
}

/** Zoom by `factor` keeping the screen point (px, py) over the same content point. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
	const k = clampZoom(view.k * factor);
	const cx = (px - view.x) / view.k;
	const cy = (py - view.y) / view.k;
	return { k, x: px - cx * k, y: py - cy * k };
}

/** The content-space rectangle the viewport shows. */
export function visibleRect(view: View, vw: number, vh: number): Rect {
	return { x: -view.x / view.k, y: -view.y / view.k, w: vw / view.k, h: vh / view.k };
}

/** Move (not zoom) so content point (cx, cy) is at the viewport centre. */
export function centerOn(view: View, cx: number, cy: number, vw: number, vh: number): View {
	return { k: view.k, x: vw / 2 - cx * view.k, y: vh / 2 - cy * view.k };
}

/** Minimap scale/offset: minimap = (content - bounds.xy) * s + (ox, oy). */
export function minimapFit(bounds: Rect, mw: number, mh: number, pad = 8): { s: number; ox: number; oy: number } {
	const bw = Math.max(1, bounds.w);
	const bh = Math.max(1, bounds.h);
	const s = Math.min((mw - 2 * pad) / bw, (mh - 2 * pad) / bh);
	return { s, ox: (mw - bw * s) / 2, oy: (mh - bh * s) / 2 };
}

// ───────────────────────── labels ─────────────────────────

const CLOSED_LABEL: Record<string, string> = { achieved: "달성", partial: "부분 달성", missed: "미달성", dropped: "중단" };
const HEALTH_LABEL: Record<string, string> = { "on-track": "순항", "at-risk": "주의", "off-track": "이탈" };
const KIND_LABEL: Record<MapRelated["kind"], string> = { project: "프로젝트", habit: "습관", memo: "메모" };

export function isClosed(status: string): boolean {
	return status in CLOSED_LABEL;
}

function childNoun(kind: MapNodeKind): string {
	return kind === "root" ? "목표" : kind === "sub" ? "관련 업무" : "하위 목표";
}

// ───────────────────────── icons (inline SVG, lucide shapes) ─────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS: Record<string, string[]> = {
	plus: ["M5 12h14", "M12 5v14"],
	minus: ["M5 12h14"],
	fit: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"],
	minimap: ["M3 5h18v14H3z", "M12 12h6v4.5h-6z"],
	project: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
	habit: ["m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3"],
	memo: ["M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z", "M15 3v4a2 2 0 0 0 2 2h4"],
	target: ["M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0", "M6 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0", "M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0"],
	warn: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
	down: ["m6 9 6 6 6-6"],
	right: ["m9 18 6-6-6-6"],
	inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
};

function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const el = doc.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	return el;
}

function icon(parent: HTMLElement, name: string, cls = "pbm-icon"): HTMLElement {
	const doc = parent.ownerDocument;
	const span = parent.createSpan({ cls });
	const svg = svgEl(doc, "svg", {
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": 2,
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
	});
	for (const d of ICONS[name] ?? []) svg.appendChild(svgEl(doc, "path", { d }));
	span.appendChild(svg);
	return span;
}

// ───────────────────────── render ─────────────────────────

/** Movement (px) after which a press is a pan, not a click. */
const DRAG_SLOP = 4;
const GRID = 22;
const ZOOM_STEP = 1.2;

export function renderStrategyMap(parent: HTMLElement, input: MapInput, cb: MapCallbacks): { destroy(): void } {
	const doc = parent.ownerDocument;
	const win = doc.defaultView ?? window;
	const root = parent.createDiv({ cls: "pbm-map" });
	const ac = new AbortController();
	const on = <T extends Event>(target: EventTarget, type: string, fn: (e: T) => void, opts: AddEventListenerOptions = {}) =>
		target.addEventListener(type, fn as EventListener, { ...opts, signal: ac.signal });

	if (isEmptyMap(input)) {
		const empty = root.createDiv({ cls: "pbm-empty" });
		icon(empty, "target", "pbm-empty-icon");
		empty.createDiv({ cls: "pbm-empty-title", text: `${input.title ?? "목표"}가 아직 없어요`, attr: { title: "목표를 만들면 Main → Sub → 관련 업무가 지도로 이어져요." } });
		return {
			destroy() {
				ac.abort();
				root.remove();
			},
		};
	}

	const mobile = doc.body.classList.contains("is-mobile");
	const collapsed = new Set<string>();
	let layout = layoutMap(input, collapsed);
	let view: View = { x: 0, y: 0, k: 1 };
	let vw = 0;
	let vh = 0;
	let fitted = false;
	let showMini = !mobile;

	const viewport = root.createDiv({ cls: "pbm-viewport" });
	viewport.setAttr("aria-label", `${input.title ?? "목표"} 전략 맵`);
	const canvas = viewport.createDiv({ cls: "pbm-canvas" });
	const edgeSvg = svgEl(doc, "svg", { class: "pbm-edges", "aria-hidden": "true" });
	canvas.appendChild(edgeSvg);
	const nodeLayer = canvas.createDiv({ cls: "pbm-nodes" });

	// toolbar
	const bar = root.createDiv({ cls: "pbm-toolbar" });
	const tool = (name: string, label: string, fn: () => void): HTMLButtonElement => {
		const b = bar.createEl("button", { cls: "pbm-tool", attr: { type: "button", "aria-label": label } });
		icon(b, name);
		on(b, "click", fn);
		return b;
	};
	tool("minus", "축소", () => zoomBy(1 / ZOOM_STEP));
	const zoomLabel = bar.createEl("button", { cls: "pbm-zoom-label", attr: { type: "button", "aria-label": "100%로 보기" } });
	on(zoomLabel, "click", () => setView(zoomAt(view, 1 / view.k, vw / 2, vh / 2)));
	tool("plus", "확대", () => zoomBy(ZOOM_STEP));
	bar.createDiv({ cls: "pbm-tool-sep" });
	tool("fit", "화면에 맞추기", () => fit());
	const miniBtn = tool("minimap", "미니맵", () => {
		showMini = !showMini;
		syncMini();
	});

	// legend
	const legend = root.createDiv({ cls: "pbm-legend" });
	const legendLine = (cls: string, text: string) => {
		const row = legend.createDiv({ cls: "pbm-legend-row" });
		const svg = svgEl(doc, "svg", { class: "pbm-legend-line", viewBox: "0 0 28 8", "aria-hidden": "true" });
		svg.appendChild(svgEl(doc, "path", { d: "M1 4 H27", class: `pbm-edge ${cls}` }));
		row.appendChild(svg);
		row.createSpan({ text });
	};
	legendLine("pbm-edge-solid", "실선 · 진행률에 반영 (하위 목표·프로젝트)");
	legendLine("pbm-edge-dashed", "점선 · 관련 업무 (진행률과 별개)");
	const hRow = legend.createDiv({ cls: "pbm-legend-row pbm-legend-health" });
	for (const h of ["on-track", "at-risk", "off-track"]) {
		const item = hRow.createSpan({ cls: "pbm-legend-h" });
		item.createSpan({ cls: "pbm-dot", attr: { "data-health": h } });
		item.createSpan({ text: HEALTH_LABEL[h] });
	}

	// minimap
	const MINI_W = mobile ? 150 : 196;
	const MINI_H = mobile ? 100 : 128;
	const mini = root.createDiv({ cls: "pbm-minimap" });
	const miniSvg = svgEl(doc, "svg", { width: MINI_W, height: MINI_H, viewBox: `0 0 ${MINI_W} ${MINI_H}` });
	mini.appendChild(miniSvg);
	const miniG = svgEl(doc, "g");
	const miniView = svgEl(doc, "rect", { class: "pbm-mm-view", "vector-effect": "non-scaling-stroke" });
	miniSvg.append(miniG, miniView);

	// ── content ──

	function renderContent(): void {
		nodeLayer.empty();
		while (edgeSvg.firstChild) edgeSvg.removeChild(edgeSvg.firstChild);
		const b = layout.bounds;
		edgeSvg.setAttribute("width", String(b.x + b.w + 40));
		edgeSvg.setAttribute("height", String(b.y + b.h + 40));
		const closedKeys = new Set(layout.nodes.filter((n) => closedNode(n)).map((n) => n.key));
		for (const e of layout.edges) {
			const cls = `pbm-edge pbm-edge-${e.kind}${closedKeys.has(e.to) ? " is-closed" : ""}`;
			edgeSvg.appendChild(svgEl(doc, "path", { d: e.d, class: cls }));
		}
		for (const n of layout.nodes) renderNode(n);
		renderMini();
	}

	function closedNode(n: MapNode): boolean {
		return isClosed(n.main?.status ?? n.sub?.status ?? "");
	}

	function place(el: HTMLElement, n: MapNode): void {
		el.style.left = `${n.x}px`;
		el.style.top = `${n.y}px`;
		el.style.width = `${n.w}px`;
		el.style.height = `${n.h}px`;
	}

	function healthDot(parentEl: HTMLElement, health: string, closed: boolean): void {
		const h = closed ? "" : health;
		parentEl.createSpan({ cls: "pbm-dot", attr: { "data-health": h || "none", "aria-label": HEALTH_LABEL[h] ?? "판단 없음" } });
	}

	function progressRow(parentEl: HTMLElement, progress: number | null): void {
		const row = parentEl.createDiv({ cls: "pbm-progress" });
		const track = row.createDiv({ cls: "pbm-bar" + (progress === null ? " is-unknown" : "") });
		const pct = progress === null ? null : Math.max(0, Math.min(100, Math.round(progress)));
		if (pct !== null) track.createDiv({ cls: "pbm-bar-fill" }).style.width = `${pct}%`;
		row.createSpan({ cls: "pbm-pct", text: pct === null ? "미정" : `${pct}%` });
	}

	function statusTag(parentEl: HTMLElement, status: string): void {
		if (isClosed(status)) parentEl.createSpan({ cls: `pbm-result pbm-result-${status}`, text: CLOSED_LABEL[status] });
		else if (status === "paused") parentEl.createSpan({ cls: "pbm-result pbm-result-paused", text: "멈춤" });
	}

	function renderNode(n: MapNode): void {
		const el = nodeLayer.createDiv({ cls: `pbm-node pbm-${n.kind}` });
		el.dataset.key = n.key;
		place(el, n);
		let activate: (() => void) | null = null;

		if (n.kind === "root") {
			icon(el, "target", "pbm-root-icon");
			const t = el.createDiv({ cls: "pbm-root-text" });
			t.createDiv({ cls: "pbm-root-title", text: input.title ?? "목표" });
			t.createDiv({ cls: "pbm-root-sub", text: `Main ${n.childCount}개` });
		} else if (n.kind === "group") {
			icon(el, "inbox", "pbm-root-icon");
			const t = el.createDiv({ cls: "pbm-root-text" });
			t.createDiv({ cls: "pbm-root-title", text: "상위 목표 없음" });
			t.createDiv({ cls: "pbm-root-sub", text: `Sub ${n.childCount}개 · Main에 연결되지 않음` });
		} else if (n.main || n.sub) {
			const g = (n.main ?? n.sub) as MapMain | MapSub;
			const closed = isClosed(g.status);
			el.addClass("pbm-card");
			if (closed) el.addClass("is-closed");
			if (g.status === "paused") el.addClass("is-paused");
			el.dataset.health = closed ? "none" : g.health || "none";
			const head = el.createDiv({ cls: "pbm-card-head" });
			healthDot(head, g.health, closed);
			if (n.main?.area) head.createSpan({ cls: "pbm-area", text: n.main.area });
			head.createSpan({ cls: "pbm-id", text: g.id });
			head.createSpan({ cls: "pbm-spacer" });
			statusTag(head, g.status);
			el.createDiv({ cls: "pbm-title", text: g.title || g.id });
			progressRow(el, n.main ? n.main.progress : (n.sub?.progress ?? null));
			if (n.sub) {
				const s = n.sub;
				const meta = el.createDiv({ cls: "pbm-meta" });
				if (s.current || s.target) {
					const m = meta.createSpan({ cls: "pbm-metric" });
					m.createSpan({ cls: "pbm-cur", text: s.current || "?" });
					m.appendText(" → ");
					m.appendText(`${s.target || "?"}${s.unit ? ` ${s.unit}` : ""}`);
				}
				if (s.due) meta.createSpan({ cls: "pbm-due", text: `기한 ${s.due}` });
			}
			const id = g.id;
			activate = () => cb.openGoal(id);
			el.setAttr("aria-label", `${g.title || g.id} 열기`);
		} else if (n.related) {
			const r = n.related;
			el.addClass(`pbm-rel-${r.kind}`);
			icon(el, r.kind, "pbm-rel-icon");
			el.createSpan({ cls: "pbm-rel-label", text: r.label });
			if (r.oneSided && r.kind === "project") {
				const w = icon(el, "warn", "pbm-warn");
				w.setAttr("aria-label", "한쪽만 연결됨");
			}
			el.setAttr("aria-label", `${KIND_LABEL[r.kind]}: ${r.label}`);
			const path = r.path;
			if (path) activate = () => cb.openFile(path);
		}

		if (activate) {
			const act = activate;
			el.addClass("is-clickable");
			el.tabIndex = 0;
			el.setAttr("role", "button");
			on(el, "click", () => act());
			on<KeyboardEvent>(el, "keydown", (e) => {
				if (e.target !== el || (e.key !== "Enter" && e.key !== " ")) return;
				e.preventDefault();
				act();
			});
		}

		if (n.childCount) {
			const t = el.createEl("button", {
				cls: "pbm-toggle" + (n.collapsed ? " is-collapsed" : ""),
				attr: {
					type: "button",
					"aria-expanded": String(!n.collapsed),
					"aria-label": `${childNoun(n.kind)} ${n.childCount}개 ${n.collapsed ? "펼치기" : "접기"}`,
				},
			});
			icon(t, n.collapsed ? "right" : "down", "pbm-toggle-icon");
			t.createSpan({ text: String(n.childCount) });
			on<MouseEvent>(t, "click", (e) => {
				e.stopPropagation();
				toggle(n.key);
			});
			on<KeyboardEvent>(t, "keydown", (e) => e.stopPropagation());
		}
	}

	function toggle(key: string): void {
		const before = layout.nodes.find((n) => n.key === key);
		if (collapsed.has(key)) collapsed.delete(key);
		else collapsed.add(key);
		layout = layoutMap(input, collapsed);
		const after = layout.nodes.find((n) => n.key === key);
		// Keep the toggled card where it was on screen.
		if (before && after) view = { k: view.k, x: view.x + (before.x - after.x) * view.k, y: view.y + (before.y - after.y) * view.k };
		renderContent();
		applyView();
		const btn = nodeLayer.querySelector<HTMLElement>(`[data-key="${cssEscape(key)}"] .pbm-toggle`);
		btn?.focus({ preventScroll: true });
	}

	function renderMini(): void {
		while (miniG.firstChild) miniG.removeChild(miniG.firstChild);
		const { s, ox, oy } = minimapFit(layout.bounds, MINI_W, MINI_H);
		const b = layout.bounds;
		miniG.setAttribute("transform", `translate(${ox} ${oy}) scale(${s}) translate(${-b.x} ${-b.y})`);
		for (const n of layout.nodes) {
			const g = n.main ?? n.sub;
			const health = g && !isClosed(g.status) ? g.health || "none" : "none";
			miniG.appendChild(
				svgEl(doc, "rect", { x: n.x, y: n.y, width: n.w, height: n.h, rx: 8, class: `pbm-mm-node pbm-mm-${n.kind}`, "data-health": health }),
			);
		}
	}

	// ── view ──

	function applyView(): void {
		canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
		let g = GRID * view.k;
		while (g < 12) g *= 2;
		viewport.style.backgroundSize = `${g}px ${g}px`;
		viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
		zoomLabel.setText(`${Math.round(view.k * 100)}%`);
		if (vw && vh) {
			const { s, ox, oy } = minimapFit(layout.bounds, MINI_W, MINI_H);
			const r = visibleRect(view, vw, vh);
			miniView.setAttribute("x", String((r.x - layout.bounds.x) * s + ox));
			miniView.setAttribute("y", String((r.y - layout.bounds.y) * s + oy));
			miniView.setAttribute("width", String(r.w * s));
			miniView.setAttribute("height", String(r.h * s));
		}
	}

	function setView(v: View): void {
		view = v;
		applyView();
	}

	function fit(): void {
		if (!vw || !vh) return;
		setView(fitView(layout.bounds, vw, vh, mobile ? 20 : 40));
	}

	function zoomBy(factor: number): void {
		setView(zoomAt(view, factor, vw / 2, vh / 2));
	}

	function syncMini(): void {
		mini.toggleClass("is-hidden", !showMini);
		miniBtn.toggleClass("is-active", showMini);
		miniBtn.setAttr("aria-pressed", String(showMini));
	}

	// ── pan / pinch (pointer events; mouse, pen and touch) ──

	const pointers = new Map<number, { x: number; y: number }>();
	let gesture: AbortController | null = null;
	let origin = { x: 0, y: 0 };
	let start = { x: 0, y: 0, view };
	let pinch: { dist: number; mid: { x: number; y: number }; view: View } | null = null;
	let moved = false;

	const local = (e: PointerEvent) => ({ x: e.clientX - origin.x, y: e.clientY - origin.y });
	const twoPoints = () => {
		const [a, b] = [...pointers.values()];
		return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
	};
	const restartSingle = () => {
		const p = [...pointers.values()][0];
		if (p) start = { x: p.x, y: p.y, view };
		pinch = null;
	};

	on<PointerEvent>(viewport, "pointerdown", (e) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		if (pointers.size === 0) {
			const r = viewport.getBoundingClientRect();
			origin = { x: r.left, y: r.top };
			moved = false;
		}
		pointers.set(e.pointerId, local(e));
		if (pointers.size === 1) restartSingle();
		else if (pointers.size === 2) {
			const t = twoPoints();
			pinch = { ...t, view };
			moved = true;
		}
		if (!gesture) {
			gesture = new AbortController();
			const opts = { signal: gesture.signal };
			win.addEventListener("pointermove", onMove as EventListener, opts);
			win.addEventListener("pointerup", onUp as EventListener, opts);
			win.addEventListener("pointercancel", onUp as EventListener, opts);
		}
	});

	function onMove(e: PointerEvent): void {
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, local(e));
		if (pinch && pointers.size >= 2) {
			const t = twoPoints();
			const k = clampZoom(pinch.view.k * (t.dist / pinch.dist));
			const cx = (pinch.mid.x - pinch.view.x) / pinch.view.k;
			const cy = (pinch.mid.y - pinch.view.y) / pinch.view.k;
			setView({ k, x: t.mid.x - cx * k, y: t.mid.y - cy * k });
			return;
		}
		const p = pointers.get(e.pointerId);
		if (!p) return;
		const dx = p.x - start.x;
		const dy = p.y - start.y;
		if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
		if (!moved) {
			moved = true;
			viewport.addClass("is-panning");
		}
		setView({ k: start.view.k, x: start.view.x + dx, y: start.view.y + dy });
	}

	function onUp(e: PointerEvent): void {
		if (!pointers.delete(e.pointerId)) return;
		if (pointers.size === 1) restartSingle();
		if (pointers.size === 0) endGesture();
	}

	function endGesture(): void {
		gesture?.abort();
		gesture = null;
		pinch = null;
		pointers.clear();
		viewport.removeClass("is-panning");
	}

	// A press that turned into a pan is not a click on the card under it.
	on<MouseEvent>(
		viewport,
		"click",
		(e) => {
			if (!moved) return;
			moved = false;
			e.stopPropagation();
			e.preventDefault();
		},
		{ capture: true },
	);

	// Obsidian mobile opens the sidebars on horizontal swipes; keep those inside the map.
	on(viewport, "touchstart", (e) => e.stopPropagation(), { passive: true });
	on(viewport, "touchmove", (e) => e.stopPropagation(), { passive: true });

	// Wheel: plain = pan (trackpad scroll), ctrl/⌘ = zoom (trackpad pinch arrives as ctrl+wheel).
	on<WheelEvent>(
		viewport,
		"wheel",
		(e) => {
			e.preventDefault();
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh || 400 : 1;
			const dx = e.deltaX * unit;
			const dy = e.deltaY * unit;
			if (e.ctrlKey || e.metaKey) {
				const r = viewport.getBoundingClientRect();
				const d = Math.max(-60, Math.min(60, dy));
				setView(zoomAt(view, Math.exp(-d * 0.01), e.clientX - r.left, e.clientY - r.top));
			} else if (e.shiftKey && !dx) {
				setView({ ...view, x: view.x - dy });
			} else {
				setView({ ...view, x: view.x - dx, y: view.y - dy });
			}
		},
		{ passive: false },
	);

	// ── minimap: click or drag to move the view ──

	let miniDrag = false;
	const miniMove = (e: PointerEvent) => {
		const r = miniSvg.getBoundingClientRect();
		const { s, ox, oy } = minimapFit(layout.bounds, MINI_W, MINI_H);
		const cx = (e.clientX - r.left - ox) / s + layout.bounds.x;
		const cy = (e.clientY - r.top - oy) / s + layout.bounds.y;
		setView(centerOn(view, cx, cy, vw, vh));
	};
	on<PointerEvent>(mini, "pointerdown", (e) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		miniDrag = true;
		mini.setPointerCapture(e.pointerId);
		miniMove(e);
	});
	on<PointerEvent>(mini, "pointermove", (e) => {
		if (miniDrag) miniMove(e);
	});
	const miniEnd = (e: PointerEvent) => {
		miniDrag = false;
		if (mini.hasPointerCapture(e.pointerId)) mini.releasePointerCapture(e.pointerId);
	};
	on(mini, "pointerup", miniEnd);
	on(mini, "pointercancel", miniEnd);

	// ── size: fit once the viewport has a size, keep the minimap frame in step ──

	const ro = new ResizeObserver(() => {
		vw = viewport.clientWidth;
		vh = viewport.clientHeight;
		if (!vw || !vh) return;
		if (!fitted) {
			fitted = true;
			fit();
		} else applyView();
	});
	ro.observe(viewport);

	renderContent();
	syncMini();
	applyView();

	return {
		destroy() {
			ro.disconnect();
			gesture?.abort();
			gesture = null;
			ac.abort();
			root.remove();
		},
	};
}

function cssEscape(s: string): string {
	return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
