import { test } from "node:test";
import assert from "node:assert/strict";
import { BOTTOM_ZONE, ENTER_ROOM_LINES, planCaretScroll, REST_AT } from "../src/ui/autogrow.ts";

// Pane of 1000px, 30px lines, scrolled to 500.
const base = { scrollTop: 500, paneHeight: 1000, lineHeight: 30, enterAtEnd: false };

test("autogrow: caret in the comfortable zone never scrolls", () => {
	assert.equal(planCaretScroll({ ...base, caretTop: 0 }), null);
	assert.equal(planCaretScroll({ ...base, caretTop: 400 }), null);
	assert.equal(planCaretScroll({ ...base, caretTop: 1000 * BOTTOM_ZONE - 1 }), null);
});

test("autogrow: caret in the bottom 30% lands at 60% from the top", () => {
	const caretTop = 950;
	const target = planCaretScroll({ ...base, caretTop });
	assert.equal(target, 500 + caretTop - 1000 * REST_AT);
	// Exactly at the zone edge counts as inside it.
	assert.equal(planCaretScroll({ ...base, caretTop: 700 }), 500 + 700 - 600);
	// Never negative.
	assert.equal(planCaretScroll({ ...base, scrollTop: 0, paneHeight: 100, caretTop: 70 }), 10);
});

test("autogrow: Enter at the end keeps ~3 lines visible beneath the new line", () => {
	// New line at 650 (above the 70% zone) with 30px lines: 650 + 30 + 90 = 770 ≤ 1000 → no scroll.
	assert.equal(planCaretScroll({ ...base, caretTop: 650, enterAtEnd: true }), null);
	// Small pane (mobile): line at 160 of 250 → 160 + 30 + 3*30 = 280 > 250 → scroll by 30.
	assert.equal(planCaretScroll({ ...base, paneHeight: 250, caretTop: 160, enterAtEnd: true }), 530);
	assert.equal(ENTER_ROOM_LINES, 3);
	// Without Enter the same position is left alone.
	assert.equal(planCaretScroll({ ...base, paneHeight: 250, caretTop: 160 }), null);
	// A zero-height pane (hidden) is ignored.
	assert.equal(planCaretScroll({ ...base, paneHeight: 0, caretTop: 10, enterAtEnd: true }), null);
});
