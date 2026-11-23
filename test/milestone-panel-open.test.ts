import { test } from "node:test";
import assert from "node:assert/strict";
import { milestonePanelOpen } from "../src/projects/milestone-links.ts";

// 「할 일 n/m」 panel: open by default when 묶음 are linked; the user's fold sticks for the session.
test("milestone panel: open by default when the 마일스톤 has linked 묶음", () => {
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 2), true);
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 1, new Set()), true);
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 1, new Set(["ms-other"])), true, "another 마일스톤's fold does not close this one");
});

test("milestone panel: closed with no linked 묶음 or no id", () => {
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 0), false);
	assert.equal(milestonePanelOpen(undefined, 3), false);
	assert.equal(milestonePanelOpen("", 3), false);
});

test("milestone panel: closed after the user folds it, open again after unfolding", () => {
	const collapsed = new Set<string>();
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 2, collapsed), true);
	collapsed.add("ms-a1b2c3d4"); // chip tapped: fold
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 2, collapsed), false);
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 5, collapsed), false, "stays folded when more 묶음 arrive on a re-render");
	collapsed.delete("ms-a1b2c3d4"); // chip tapped again, or 「+ 할 일」 / 「기존 묶음 연결」
	assert.equal(milestonePanelOpen("ms-a1b2c3d4", 2, collapsed), true);
});
