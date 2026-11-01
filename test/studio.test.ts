import { test } from "node:test";
import assert from "node:assert/strict";
import {
	appendGlgam,
	buildPayload,
	candidateLink,
	candidatesOf,
	channelByKey,
	DEFAULT_SOURCES,
	formatGlgam,
	glgamSkeleton,
	markDropped,
	markWritten,
	newPostId,
	parseGlgam,
	parsePost,
	parseSources,
	postProblems,
	postSkeleton,
	readFm,
	resultPatch,
	rewriteSources,
	setFm,
	setPostBody,
	underSource,
	withBlock,
} from "../src/studio/model.ts";
import { parseList, uploadKey, uriEncode } from "../src/studio/s3.ts";

const LI = channelByKey("li");
const TH = channelByKey("th");
const IG = channelByKey("ig");

// 김하루's posts (「MyLogs 배포 설계」 「6」)
const BOT_POST = `---
published:
url:
---

## 본문

저는 읽을거리를 저장만 한 날을 '한 날'로 치지 않습니다.

작년에 저장한 글이 1,200개였습니다.
`;

test("post: a bot-made file (published/url only) reads as 초안 with its 본문", () => {
	const p = parsePost("12 Flywheel/퍼스널 브랜딩/02 산출물/링크드인/2026-01-14 저장만 한 날은 한 날이 아니다.md", BOT_POST, LI);
	assert.equal(p.stage, "초안");
	assert.equal(p.date, "2026-01-14");
	assert.equal(p.title, "저장만 한 날은 한 날이 아니다");
	assert.equal(p.format, "글만");
	assert.match(p.text, /^저는 읽을거리를/);
	assert.match(p.text, /1,200개였습니다\.$/);
});

test("post: published wins over stage; lists and quoted values", () => {
	const t = `---\nid: C-20260113-01\nchannel: 링크드인\nstage: 예약\nmedia: ["https://x.s3.ap-northeast-2.amazonaws.com/studio/a.png"]\nfrom: ["[[글감 2026-01#^g1, 2]]"]\nscheduled: "2026-01-13 08:00"\npublished: 2026-01-13\nurl: https://www.linkedin.com/feed/1\n---\n\n## 본문\n\n노트 무덤에서 나오는 법\n`;
	const p = parsePost("a/2026-01-13 노트 무덤.md", t, LI);
	assert.equal(p.stage, "발행");
	assert.equal(p.scheduled, "2026-01-13 08:00");
	assert.deepEqual(p.media, ["https://x.s3.ap-northeast-2.amazonaws.com/studio/a.png"]);
	assert.deepEqual(p.from, ["[[글감 2026-01#^g1, 2]]"]);
});

test("setFm: updates in place, inserts in order, removes, keeps other keys", () => {
	const t = `---\nid: C-1\nchannel: 링크드인\nstage: 초안\npublished:\nurl:\nmine: keep\n---\n\n## 본문\n\n글\n`;
	const out = setFm(t, { stage: "예약", scheduled: "2026-01-16 08:00", media: ["https://a/b.png"], url: null }, ["id", "channel", "format", "stage", "from", "media", "scheduled", "sent", "published", "url"]);
	const fm = readFm(out);
	assert.equal(fm.stage, "예약");
	assert.equal(fm.scheduled, "2026-01-16 08:00");
	assert.deepEqual(fm.media, ["https://a/b.png"]);
	assert.equal("url" in fm, false);
	assert.equal(fm.mine, "keep");
	assert.ok(out.indexOf("media:") > out.indexOf("stage:") && out.indexOf("scheduled:") < out.indexOf("published:"));
	assert.match(out, /\n---\n\n## 본문\n\n글\n$/);
});

test("setPostBody: 링크드인 본문 only; other sections stay", () => {
	const t = `---\nid: C-1\n---\n\n## 본문\n\n옛 글\n\n## 메모\n\n지우면 안 됨\n`;
	const out = setPostBody(t, LI, { text: "새 글\n둘째 줄" });
	assert.match(out, /## 본문\n\n새 글\n둘째 줄\n\n## 메모\n\n지우면 안 됨/);
	assert.ok(out.startsWith("---\nid: C-1\n---\n"));
});

test("setPostBody / parsePost: 스레드 타래 round trip with media per post", () => {
	const start = postSkeleton(TH, "C-20260114-02", ["[[글감 2026-01#^gab12]]"]);
	const parts = [
		{ text: "저장만 한 날은 '한 날'로 치지 않습니다.", media: ["https://b/1.jpg"] },
		{ text: "그래서 기준을 바꿨어요.\n여러분은요?", media: [] },
	];
	const out = setPostBody(start, TH, { parts });
	assert.match(out, /## 1\n\n저장만 한 날은[^\n]*\n\n!\[\]\(https:\/\/b\/1\.jpg\)\n\n## 2\n\n그래서/);
	const p = parsePost("x/2026-01-14 t.md", out, TH);
	assert.deepEqual(p.parts, parts);
	assert.equal(p.stage, "초안");
	// fewer parts → the extra section goes
	const one = parsePost("x/t.md", setPostBody(out, TH, { parts: [parts[0]] }), TH);
	assert.equal(one.parts.length, 1);
});

test("인스타그램: caption section, hashtags appended when sent, problems", () => {
	let t = postSkeleton(IG, "C-20260114-03", []);
	t = setPostBody(t, IG, { text: "작년에 저장한 글 1,200개." });
	t = setFm(t, { hashtags: ["기록습관", "독서기록"], scheduled: "2026-01-17 19:00" });
	const p = parsePost("x/2026-01-14 t.md", t, IG);
	assert.equal(p.format, "피드");
	assert.equal(p.ratio, "4:5");
	const pay = buildPayload(p);
	assert.equal(pay.text, "작년에 저장한 글 1,200개.\n\n#기록습관 #독서기록");
	assert.equal(pay.at, "2026-01-17T19:00:00+09:00");
	assert.equal(pay.channel, "instagram");
	assert.ok(postProblems(p).some((x) => x.level === "block" && /사진/.test(x.text)));
	const ok = parsePost("x/t.md", setFm(t, { media: ["https://b/1.jpg"] }), IG);
	assert.equal(postProblems(ok).filter((x) => x.level === "block").length, 0);
});

test("스레드: a post over 500 characters blocks sending", () => {
	const t = setFm(setPostBody(postSkeleton(TH, "C-1", []), TH, { parts: [{ text: "가".repeat(501), media: [] }] }), { scheduled: "2026-01-15 07:30" });
	const p = parsePost("x/t.md", t, TH);
	assert.ok(postProblems(p).some((x) => x.level === "block" && /500자/.test(x.text)));
	assert.equal(buildPayload(p).parts?.length, 1);
});

test("발행 결과: published row → url and stage; failure keeps stage; older rows ignored", () => {
	const t = `---\nid: C-20260114-02\nstage: 예약\nscheduled: "2026-01-16 08:00"\nsent: "2026-01-14 14:10"\n---\n\n## 본문\n\n글\n`;
	const p = parsePost("x/t.md", t, LI);
	assert.deepEqual(resultPatch(p, { id: p.id, status: "발행", url: "https://lnkd.in/x", error: "", at: "2026-01-16T08:00:05+09:00" }), { published: "2026-01-16", url: "https://lnkd.in/x", stage: "발행", error: null });
	assert.deepEqual(resultPatch(p, { id: p.id, status: "실패", url: "", error: "이미지 비율", at: "2026-01-16T08:00:05" }), { error: "이미지 비율" });
	assert.equal(resultPatch(p, { id: p.id, status: "발행", url: "u", error: "", at: "2026-01-10T08:00" }), null);
	assert.equal(resultPatch({ ...p, sent: "" }, { id: p.id, status: "발행", url: "u", error: "", at: "" }), null);
});

test("글감 lines: format, parse, written, dropped", () => {
	const line = formatGlgam({ text: "저장만 한 날은 한 날이 아니다 (메모)", src: "daily", from: ["04 Daily Pad/2026/2026-01-13#^g7k2ab"], added: "2026-01-14", block: "g0114a" });
	assert.equal(line, "- [ ] 저장만 한 날은 한 날이 아니다 (메모) (src:: daily) (from:: [[04 Daily Pad/2026/2026-01-13#^g7k2ab]]) (added:: 2026-01-14) ^g0114a");
	const file = appendGlgam(glgamSkeleton("2026-01", "2026-01-14"), line);
	const [g] = parseGlgam(file, "f.md");
	assert.equal(g.mark, " ");
	assert.equal(g.src, "daily");
	assert.equal(g.block, "g0114a");
	assert.deepEqual(g.from, ["04 Daily Pad/2026/2026-01-13#^g7k2ab"]);
	const w = markWritten(g.raw, "[[12 Flywheel/퍼스널 브랜딩/02 산출물/링크드인/2026-01-14 저장만|링크드인]]");
	const w2 = markWritten(w, "[[x/스레드/2026-01-14 저장만|스레드]]");
	const [g2] = parseGlgam(w2, "f.md");
	assert.equal(g2.mark, ">");
	assert.equal(g2.text, "저장만 한 날은 한 날이 아니다 (메모)");
	assert.deepEqual(g2.posts, ["12 Flywheel/퍼스널 브랜딩/02 산출물/링크드인/2026-01-14 저장만", "x/스레드/2026-01-14 저장만"]);
	assert.equal(g2.block, "g0114a");
	const [g3] = parseGlgam(markDropped(g.raw, "주제와 안 맞음"), "f.md");
	assert.equal(g3.mark, "-");
	assert.equal(g3.why, "주제와 안 맞음");
});

test("candidates: Daily Pad 메모·로그 lines, dated by file, fields stripped", () => {
	const src = DEFAULT_SOURCES[0];
	const pad = `---\ndate: 2026-01-13\n---\n# 2026-01-13 (화)\n\n## 개인 할 일\n- [ ] 뉴스레터 3호 초고\n\n## 메모\n- 저장만 한 날은 한 날로 치지 않기로 했다 (record:: [[x]]) ^fw-1\n- 짧음\n\n## 로그\n- 09:12 10km 완주 다음 날, 아침이 쉬웠다\n`;
	const c = candidatesOf(src, "04 Daily Pad/2026/2026-01-13.md", pad, 0, "2026-01-07");
	assert.deepEqual(
		c.map((x) => [x.where, x.text, x.block]),
		[
			["메모", "저장만 한 날은 한 날로 치지 않기로 했다", "fw-1"],
			["로그", "09:12 10km 완주 다음 날, 아침이 쉬웠다", ""],
		],
	);
	assert.equal(c[0].date, "2026-01-13");
	assert.equal(candidateLink(c[1], "gq1"), "04 Daily Pad/2026/2026-01-13#^gq1");
	assert.equal(candidatesOf(src, "04 Daily Pad/2026/2026-01-13.md", pad, 0, "2026-01-14").length, 0);
});

test("candidates: Flywheel 기록 dated by ### headings; AI 뉴스 by ### sections; files", () => {
	const rec = `# 운동 기록 2026-01\n\n### 2026-01-05\n- 걷기 15분, 별일 없음\n\n### 2026-01-12\n- 10km 완주! 다음엔 서브 1시간\n`;
	const c = candidatesOf(DEFAULT_SOURCES[1], "12 Flywheel/운동/01 기록/운동 기록 2026-01.md", rec, 0, "2026-01-08");
	assert.deepEqual(c.map((x) => [x.date, x.text]), [["2026-01-12", "10km 완주! 다음엔 서브 1시간"]]);
	const news = `# AI 뉴스 브리핑\n\n## 오늘의 셋\n\n### 1. 데스크톱 에이전트 공개\n- 프로그램을 직접 눌러 준다\n\n### 2. 레드팀 자동화\n본문\n\n## 뺀 것\n- x\n`;
	const n = candidatesOf(DEFAULT_SOURCES[2], "07 Shelf/LLM Wiki/raw/articles/ai-news/2026-01-14_AI 뉴스 브리핑.md", news, 0, "2026-01-08");
	assert.deepEqual(n.map((x) => x.text), ["1. 데스크톱 에이전트 공개", "2. 레드팀 자동화"]);
	assert.equal(candidateLink(n[0], ""), "07 Shelf/LLM Wiki/raw/articles/ai-news/2026-01-14_AI 뉴스 브리핑#1. 데스크톱 에이전트 공개");
	const f = candidatesOf(DEFAULT_SOURCES[3], "07 Shelf/LLM Wiki/wiki/concepts/노트 무덤.md", `---\ntitle: 노트 무덤\n---\n모으기만 하고 잇지 못한 노트.\n`, Date.UTC(2026, 0, 11), "2026-01-08");
	assert.deepEqual(f.map((x) => [x.text, x.date, x.line]), [["노트 무덤", "2026-01-11", -1]]);
});

test("sources: folder match with *, registry round trip keeps the log", () => {
	assert.ok(underSource("12 Flywheel/운동/01 기록/운동 기록 2026-01.md", "12 Flywheel/*/01 기록"));
	assert.ok(!underSource("12 Flywheel/운동/02 산출물/a.md", "12 Flywheel/*/01 기록"));
	assert.ok(underSource("04 Daily Pad/2026/2026-01-13.md", "04 Daily Pad"));
	const first = rewriteSources(null, DEFAULT_SOURCES, "2026-01-14", "처음 만듦");
	const more = rewriteSources(first, [...DEFAULT_SOURCES, { key: "club", name: "독서 모임", path: "05 Project Folders/개인/독서 모임/01 회의록", unit: "섹션", where: ["###"], on: false }], "2026-01-15", "독서 모임 더함");
	const back = parseSources(more);
	assert.equal(back.length, DEFAULT_SOURCES.length + 1);
	assert.deepEqual(back.at(-1), { key: "club", name: "독서 모임", path: "05 Project Folders/개인/독서 모임/01 회의록", unit: "섹션", where: ["###"], on: false });
	assert.deepEqual(back[0].where, ["## 메모", "## 로그"]);
	assert.match(more, /- 2026-01-15: 독서 모임 더함\n- 2026-01-14: 처음 만듦/);
	assert.equal(parseSources(null).length, DEFAULT_SOURCES.length);
});

test("block ids and post ids", () => {
	assert.equal(withBlock("- 메모 줄", "gab"), "- 메모 줄 ^gab");
	assert.equal(withBlock("- 메모 줄 ^fw-1", "gab"), "- 메모 줄 ^fw-1");
	assert.equal(newPostId("2026-01-14", ["C-20260114-01"]), "C-20260114-02");
});

test("s3: RFC 3986 keys, upload key under prefix/YYYY/MM (KST), list parsing", () => {
	assert.equal(uriEncode("studio/2026/01/저장 (1).png", true), "studio/2026/01/%EC%A0%80%EC%9E%A5%20%281%29.png");
	const c = { bucket: "kimharu-media", region: "ap-northeast-2", prefix: "studio", accessKeyId: "", secretAccessKey: "" };
	assert.equal(uploadKey(c, "아침 달리기!.JPG", new Date("2026-01-31T16:05:09Z")), "studio/2026/02/20260201-010509-아침-달리기.jpg");
	const xml = `<ListBucketResult><Contents><Key>studio/2026/01/a&amp;b.png</Key><LastModified>2026-01-14T05:00:00.000Z</LastModified><Size>820</Size></Contents><Contents><Key>studio/2026/01/</Key><Size>0</Size></Contents></ListBucketResult>`;
	assert.deepEqual(parseList(c, xml), [{ key: "studio/2026/01/a&b.png", url: "https://kimharu-media.s3.ap-northeast-2.amazonaws.com/studio/2026/01/a%26b.png", size: 820, modified: "2026-01-14T05:00:00.000Z" }]);
});
