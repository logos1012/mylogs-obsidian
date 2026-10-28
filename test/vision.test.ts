import { test } from "node:test";
import assert from "node:assert/strict";
import { imageName, moveCard, parseVisionBoard, setAffirmation, setCards, streak, visionPath, visionSkeleton } from "../src/vision/model.ts";
import { addDays } from "../src/parser.ts";

// 김하루's board (가상 예시).
const BOARD = `---
type: vision-board
flywheel: F-4
updated: 2026-10-29
---
# Vision Board

## 비전

### 제주 책방
![[00 Vision Board/images/2026-10-29 제주 책방.png]]
바다가 보이는 작은 책방에서
첫 손님을 맞는다.

### 마라톤 완주
결승선을 웃으며 넘는다.

## 확언

나는 매일 조금씩 나아간다.

나는 **이미** 그 길 위에 있다.

## 변경 기록
- 2026-10-29: 만듦 (플러그인)
`;

test("parseVisionBoard: flywheel, cards (image + multi-line sentence), whole affirmation", () => {
	const b = parseVisionBoard(BOARD);
	assert.equal(b.flywheel, "F-4");
	assert.deepEqual(b.cards, [
		{ title: "제주 책방", image: "00 Vision Board/images/2026-10-29 제주 책방.png", text: "바다가 보이는 작은 책방에서\n첫 손님을 맞는다." },
		{ title: "마라톤 완주", image: "", text: "결승선을 웃으며 넘는다." },
	]);
	assert.equal(b.affirmation, "나는 매일 조금씩 나아간다.\n\n나는 **이미** 그 길 위에 있다.");
});

test("parseVisionBoard: no file / empty sections", () => {
	assert.deepEqual(parseVisionBoard(null), { flywheel: "", cards: [], affirmation: "" });
	const b = parseVisionBoard(visionSkeleton("2026-10-29"));
	assert.deepEqual(b, { flywheel: "", cards: [], affirmation: "" });
});

test("setCards round-trips and keeps the other sections", () => {
	const b = parseVisionBoard(BOARD);
	const out = setCards(BOARD, moveCard(b.cards, 1, 0));
	const again = parseVisionBoard(out);
	assert.deepEqual(again.cards.map((c) => c.title), ["마라톤 완주", "제주 책방"]);
	assert.equal(again.cards[1].image, b.cards[0].image);
	assert.equal(again.affirmation, b.affirmation);
	assert.ok(out.includes("## 변경 기록\n- 2026-10-29: 만듦"));
	assert.equal(setCards(BOARD, b.cards), BOARD, "same cards → same text");
});

test("setCards / setAffirmation on a fresh skeleton", () => {
	let t = visionSkeleton("2026-10-29", "F-4");
	t = setCards(t, [{ title: "알프스", image: "a.png", text: "걷는다." }]);
	t = setAffirmation(t, "나는 한다.\n\n나는 된다.");
	const b = parseVisionBoard(t);
	assert.equal(b.flywheel, "F-4");
	assert.deepEqual(b.cards, [{ title: "알프스", image: "a.png", text: "걷는다." }]);
	assert.equal(b.affirmation, "나는 한다.\n\n나는 된다.");
	assert.ok(t.indexOf("## 확언") < t.indexOf("## 변경 기록"));
});

test("setAffirmation adds the section before 변경 기록 when missing", () => {
	const t = "---\ntype: vision-board\n---\n# Vision Board\n\n## 비전\n\n## 변경 기록\n- x\n";
	const out = setAffirmation(t, "나는 쓴다.");
	assert.ok(out.indexOf("## 확언") < out.indexOf("## 변경 기록"));
	assert.equal(parseVisionBoard(out).affirmation, "나는 쓴다.");
});

test("moveCard clamps", () => {
	const cs = ["a", "b", "c"].map((title) => ({ title, image: "", text: "" }));
	assert.deepEqual(moveCard(cs, 0, 9).map((c) => c.title), ["b", "c", "a"]);
	assert.deepEqual(moveCard(cs, 2, -3).map((c) => c.title), ["c", "a", "b"]);
	assert.deepEqual(moveCard(cs, 5, 0), cs);
});

test("streak counts back from today, or from yesterday while today is open", () => {
	const done = new Set(["2026-10-27", "2026-10-28"]);
	assert.equal(streak((d) => done.has(d), "2026-10-29", addDays), 2);
	done.add("2026-10-29");
	assert.equal(streak((d) => done.has(d), "2026-10-29", addDays), 3);
	assert.equal(streak(() => false, "2026-10-29", addDays), 0);
});

test("visionPath / imageName", () => {
	assert.equal(visionPath("00 Vision Board/"), "00 Vision Board/Vision Board.md");
	assert.equal(imageName("2026-10-29", "제주/책방: 첫날?", "JPG"), "2026-10-29 제주 책방 첫날.jpg");
	assert.equal(imageName("2026-10-29", "", ""), "2026-10-29 vision.png");
});
