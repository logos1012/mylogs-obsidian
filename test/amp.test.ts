import { test } from "node:test";
import assert from "node:assert/strict";
import { addSources, answerUsed, insertAfter, parseAmp, parseJsonReply, reviewItems, setMessage, setQuestions, setReview, shareFromAnswers } from "../src/studio/amp.ts";
import { channelByKey, parsePost, setPostBody } from "../src/studio/model.ts";

const LI = channelByKey("li");
// 김하루 (「MyLogs 배포 설계」 「6」)
const POST = `---\nid: C-20260114-02\nchannel: 링크드인\nstage: 초안\n---\n\n## 본문\n\n저는 저장만 한 날을 '한 날'로 치지 않습니다.\n`;

test("메시지 · 질문 · 검토 · 자료 sit after 본문 and do not change it", () => {
	let t = setMessage(POST, '저장은 한 일이 아니다');
	t = setQuestions(t, [
		{ text: "저장해 두면 언젠가 쓰지 않나요?", use: true, by: "나", answer: "작년에 1,200개를 저장했고\n다시 연 건 40개였다." },
		{ text: "어떤 앱에 저장하세요?", use: false, by: "AI·실무자", answer: "" },
	]);
	t = setReview(t, "2026-01-14 15:20", [
		{ mark: "x", lens: "후킹", finding: "첫 줄이 멈추게 해요", ask: "", at: "", why: "", ok: true },
		{ mark: " ", lens: "근거·디테일", finding: "숫자가 내 경우뿐", ask: "다른 사람도 그런가요?", at: "저장만 한 날을 '한 날'로 (안) 치지", why: "", ok: false },
	]);
	t = addSources(t, [{ quote: "저장한 항목 중 일부만 다시 열렸다", title: "읽기 연구", url: "https://example.org/a", outlet: "예시 연구소", year: "2024", found: "2026-01-14" }]);
	const p = parsePost("x/2026-01-14 t.md", t, LI);
	assert.equal(p.text, "저는 저장만 한 날을 '한 날'로 치지 않습니다.");
	const a = parseAmp(t);
	assert.equal(a.message, "저장은 한 일이 아니다");
	assert.deepEqual(a.questions[0], { text: "저장해 두면 언젠가 쓰지 않나요?", use: true, by: "나", answer: "작년에 1,200개를 저장했고\n다시 연 건 40개였다." });
	assert.deepEqual(a.questions[1], { text: "어떤 앱에 저장하세요?", use: false, by: "AI·실무자", answer: "" });
	assert.equal(a.review?.stamp, "2026-01-14 15:20");
	assert.equal(a.review?.items[0].ok, true);
	assert.equal(a.review?.items[1].ask, "다른 사람도 그런가요?");
	assert.equal(a.review?.items[1].at, "저장만 한 날을 '한 날'로 （안） 치지");
	assert.deepEqual(a.sources[0], { quote: "저장한 항목 중 일부만 다시 열렸다", title: "읽기 연구", url: "https://example.org/a", outlet: "예시 연구소", year: "2024", found: "2026-01-14" });
	assert.match(t, /## 본문[\s\S]*## 메시지[\s\S]*## 질문[\s\S]*## 검토 2026-01-14 15:20[\s\S]*## 자료/);
	// editing 본문 keeps the other sections; a new review replaces the old one
	const t2 = setReview(setPostBody(t, LI, { text: "새 원고" }), "2026-01-14 16:00", []);
	assert.equal(parseAmp(t2).questions.length, 2);
	assert.equal((t2.match(/## 검토/g) ?? []).length, 1);
	assert.equal(parsePost("x/t.md", t2, LI).text, "새 원고");
	// same source twice → once
	assert.equal(parseAmp(addSources(t, [parseAmp(t).sources[0]])).sources.length, 1);
});

test("AI answers: JSON out of chatter; review keeps only passages that are in the manuscript, at most 8 gaps", () => {
	assert.deepEqual(parseJsonReply<{ question: string }>('네!\n```json\n{"question": "누구에게요?"}\n```'), { question: "누구에게요?" });
	const body = "첫 줄입니다.\n\n이렇게 하니 삶이 달라졌습니다.";
	const items = reviewItems(
		{ lenses: [{ lens: "후킹", ok: "좋아요", gaps: [] }, { lens: "근거·디테일", ok: null, gaps: [{ finding: "무엇이 달라졌나", ask: "뭐가요?", at: "삶이 달라졌습니다" }, { finding: "x", ask: "", at: "원고에 없는 구절" }, ...Array(9).fill({ finding: "f" })] }] },
		body,
	);
	assert.equal(items.filter((g) => !g.ok).length, 8);
	assert.equal(items[1].at, "삶이 달라졌습니다");
	assert.equal(items[2].at, "");
});

test("엮기: answers already used; share of the manuscript from answers; insert after a passage", () => {
	const ans = "작년에 1,200개를 저장했다. 다시 연 건 40개였다.";
	const body = "저는 기준을 바꿨습니다.\n\n작년에 1,200개를 저장했다. 다시 연 건 40개였다!";
	assert.equal(answerUsed(ans, body), true);
	assert.equal(answerUsed("전혀 다른 이야기를 길게 적은 답입니다.", body), false);
	assert.equal(shareFromAnswers(body, [{ text: "q", use: true, by: "나", answer: ans }]) > 50, true);
	assert.equal(insertAfter("가 문단.\n\n나 문단입니다.\n\n다 문단.", "나 문단", "새 문장."), "가 문단.\n\n나 문단입니다.\n\n새 문장.\n\n다 문단.");
	assert.equal(insertAfter("가 문단.", "", "새 문장."), "가 문단.\n\n새 문장.");
});
