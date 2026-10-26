import { test } from "node:test";
import assert from "node:assert/strict";
import { filterPickItems, keyboardInset, LONG_PRESS_MS, LongPress, MOVE_SLOP_PX, visibleWindow } from "../src/ui/mobile-core.ts";

// ── long press ──

test("long press: fires once after the delay, then up reports long", () => {
	const lp = new LongPress();
	lp.down(100, 100, 0);
	assert.equal(lp.tick(LONG_PRESS_MS - 1), false);
	assert.equal(lp.state, "pressing");
	assert.equal(lp.tick(LONG_PRESS_MS), true);
	assert.equal(lp.tick(LONG_PRESS_MS + 50), false, "fires only once");
	assert.equal(lp.state, "fired");
	assert.equal(lp.up(), "long");
	assert.equal(lp.state, "idle");
});

test("long press: a short press is a tap", () => {
	const lp = new LongPress();
	lp.down(10, 10, 1000);
	assert.equal(lp.tick(1200), false);
	assert.equal(lp.up(), "tap");
});

test("long press: moving more than the slop cancels (scroll), small jitter does not", () => {
	const lp = new LongPress();
	lp.down(50, 50, 0);
	assert.equal(lp.move(50 + MOVE_SLOP_PX, 50 - MOVE_SLOP_PX), false, "within slop");
	assert.equal(lp.state, "pressing");
	assert.equal(lp.move(50, 50 + MOVE_SLOP_PX + 1), true, "beyond slop");
	assert.equal(lp.state, "cancelled");
	assert.equal(lp.tick(LONG_PRESS_MS * 2), false, "a cancelled press never fires");
	assert.equal(lp.up(), "none");
});

test("long press: cancel (second finger, scroll) before the delay prevents firing", () => {
	const lp = new LongPress();
	lp.down(0, 0, 0);
	lp.cancel();
	assert.equal(lp.tick(LONG_PRESS_MS), false);
	assert.equal(lp.up(), "none");
});

test("long press: moves after firing are ignored; origin is the press point", () => {
	const lp = new LongPress(300, 5);
	lp.down(7, 9, 0);
	assert.equal(lp.tick(300), true);
	assert.equal(lp.move(200, 200), false);
	assert.deepEqual(lp.origin, { x: 7, y: 9 });
	assert.equal(lp.up(), "long");
});

test("long press: a new press after an old one starts clean", () => {
	const lp = new LongPress();
	lp.down(0, 0, 0);
	lp.move(100, 100);
	lp.up();
	lp.down(0, 0, 5000);
	assert.equal(lp.tick(5000 + LONG_PRESS_MS), true);
});

// ── keyboard ──

test("keyboardInset: hidden part of the layout viewport, 0 when the web view resized", () => {
	assert.equal(keyboardInset(800, 500, 0), 300);
	assert.equal(keyboardInset(800, 500, 100), 200, "visual viewport scrolled down");
	assert.equal(keyboardInset(500, 500, 0), 0, "web view already resized");
	assert.equal(keyboardInset(800, 799.6, 0), 0, "rounding noise");
	assert.equal(keyboardInset(800, 900, 0), 0, "never negative");
});

test("visibleWindow: pane clipped to the visual viewport", () => {
	assert.deepEqual(visibleWindow(100, 900, 0, 500), { top: 100, height: 400 }, "keyboard covers the pane bottom");
	assert.deepEqual(visibleWindow(100, 400, 0, 800), { top: 100, height: 300 }, "pane fully visible");
	assert.deepEqual(visibleWindow(0, 900, 200, 400), { top: 200, height: 400 }, "visual viewport scrolled");
	assert.deepEqual(visibleWindow(700, 900, 0, 500), { top: 700, height: 0 }, "pane fully hidden");
});

// ── picker ──

test("filterPickItems: empty query keeps all; matches label or sub, case-insensitive", () => {
	const items = [{ label: "보류", sub: "하기로 했지만 미룬 일" }, { label: "Wall", sub: "미래의 달" }, { label: "오늘" }];
	assert.equal(filterPickItems(items, "  ").length, 3);
	assert.deepEqual(
		filterPickItems(items, "wall").map((i) => i.label),
		["Wall"],
	);
	assert.deepEqual(
		filterPickItems(items, "미래").map((i) => i.label),
		["Wall"],
	);
	assert.deepEqual(filterPickItems(items, "zzz"), []);
});
