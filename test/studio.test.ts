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
	unmarkWritten,
	blocksNow,
	channelMinLeadMs,
	defaultSchedule,
	FORMATS,
	leadProblem,
	prefillSchedule,
	SCHEDULE_PRESETS,
	schedulePresetAt,
	newPostId,
	parseGlgam,
	parsePost,
	parseSources,
	lumiSearchPrompt,
	isReferenceSource,
	postProblems,
	postSkeleton,
	readFm,
	appliedLabel,
	FAST_POLL_MS,
	fastPollEvery,
	formatPollHit,
	formatPollSummary,
	immediateAt,
	interpretIntake,
	postState,
	resultReadPlan,
	SEND_NOW_BUTTON_CLASS,
	SEND_NOW_MENU_CLASS,
	interpretResultGet,
	isAbsentResult,
	needsFastPoll,
	parseResultJson,
	pollFoundCount,
	resultBody,
	resultPatch,
	shouldRememberPoll,
	shouldThrottlePoll,
	rewriteSources,
	webhookHeaders,
	setFm,
	setPostBody,
	threadsDraft,
	threadsProblems,
	threadsTextLength,
	threadsUniqueLinks,
	threadsUploadProblem,
	underSource,
	withBlock,
} from "../src/studio/model.ts";
import { DEFAULT_S3_PREFIX, getObject, migrateS3Prefix, parseList, resultObjectKey, uploadKey, uriEncode, type Send } from "../src/studio/s3.ts";

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
	assert.equal(postProblems(ok, { now: Date.parse("2026-01-17T00:00:00+09:00") }).filter((x) => x.level === "block").length, 0);
});

test("스레드: a post over 500 characters blocks sending", () => {
	const t = setFm(setPostBody(postSkeleton(TH, "C-1", []), TH, { parts: [{ text: "가".repeat(501), media: [] }] }), { scheduled: "2026-01-15 07:30" });
	const p = parsePost("x/t.md", t, TH);
	assert.ok(postProblems(p, { now: Date.parse("2026-01-15T00:00:00+09:00") }).some((x) => x.level === "block" && /500자/.test(x.text)));
	const pay = buildPayload(p);
	assert.equal(pay.parts, undefined);
	assert.equal(pay.channel, "threads");
	assert.equal(pay.text, "가".repeat(501));
	assert.equal(pay.action, "schedule");
});

test("발행 결과: published, failed, 취소; at earlier than sent is ignored", () => {
	const t = `---\nid: C-20260114-02\nstage: 예약\nscheduled: "2026-01-16 08:00"\nsent: "2026-01-14 14:10"\n---\n\n## 본문\n\n글\n`;
	const p = parsePost("x/t.md", t, LI);
	const published = { published: "2026-01-16", url: "https://www.linkedin.com/feed/update/urn/", stage: "발행", error: null };
	assert.deepEqual(resultPatch(p, { id: p.id, status: "published", url: published.url, error: "", at: "2026-01-16 08:05" }), published);
	assert.deepEqual(resultPatch(p, { id: p.id, status: "발행", url: "https://lnkd.in/x", error: "", at: "2026-01-16T08:00:05+09:00" }), { published: "2026-01-16", url: "https://lnkd.in/x", stage: "발행", error: null });
	assert.deepEqual(resultPatch(p, { id: p.id, status: "ok", url: "https://lnkd.in/ok", error: "", at: "2026-01-16 08:05" }), { ...published, url: "https://lnkd.in/ok" });
	assert.deepEqual(resultPatch(p, { id: p.id, status: "failed", url: "", error: "이미지 비율", at: "2026-01-16 08:00" }), { error: "이미지 비율" });
	assert.deepEqual(resultPatch(p, { id: p.id, status: "실패", url: "", error: "", at: "2026-01-16T08:00:05" }), { error: "이유 없음" });
	assert.deepEqual(resultPatch(p, { id: p.id, status: "취소", url: "", error: "ignored", at: "2026-01-16 09:00" }), { stage: "다듬기", sent: null, error: null, cancelled: "2026-01-16 09:00", now: null });
	// same minute as sent is not earlier
	assert.deepEqual(resultPatch(p, { id: p.id, status: "취소", url: "", error: "", at: "2026-01-14 14:10" }), { stage: "다듬기", sent: null, error: null, cancelled: "2026-01-14 14:10", now: null });
	assert.equal(resultPatch(p, { id: p.id, status: "published", url: "u", error: "", at: "2026-01-10 08:00" }), null);
	assert.equal(resultPatch(p, { id: p.id, status: "취소", url: "", error: "", at: "2026-01-14 14:09" }), null);
	assert.equal(resultPatch(p, { id: p.id, status: "failed", url: "", error: "x", at: "2026-01-14 14:09" }), null);
	assert.equal(resultPatch({ ...p, sent: "" }, { id: p.id, status: "published", url: "u", error: "", at: "2026-01-16 08:00" }), null);
	const row = parseResultJson(`{"id":"C-20260114-02","status":"published","url":"https://www.linkedin.com/feed/update/urn/","error":null,"at":"2026-01-16 08:05"}`);
	assert.deepEqual(row, { id: "C-20260114-02", status: "published", url: "https://www.linkedin.com/feed/update/urn/", error: "", at: "2026-01-16 08:05" });
	assert.equal(parseResultJson("not-json"), null);
});

test("발행 결과 GetObject: 404 and 403 AccessDenied/NoSuchKey mean no result yet", async () => {
	const denied = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`;
	const noKey = `<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`;
	const badSig = `<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>`;
	assert.equal(isAbsentResult(404, ""), true);
	assert.equal(isAbsentResult(403, denied), true);
	assert.equal(isAbsentResult(403, noKey), true);
	assert.equal(isAbsentResult(403, badSig), false);
	assert.equal(isAbsentResult(500, denied), false);
	const c = { bucket: "example-bucket", region: "ap-northeast-2", prefix: "artifacts/studio", accessKeyId: "TESTACCESSKEY", secretAccessKey: "test-secret-not-real" };
	const read = async (status: number, text: string) => {
		const key = resultObjectKey("C-20260116-01");
		assert.equal(key, "studio/results/C-20260116-01.json");
		const send: Send = async (req) => {
			assert.equal(req.method, "GET");
			assert.equal(req.url, "https://example-bucket.s3.ap-northeast-2.amazonaws.com/studio/results/C-20260116-01.json");
			assert.equal(req.url.includes("artifacts"), false);
			assert.match(req.headers.authorization ?? "", /^AWS4-HMAC-SHA256 /);
			return { status, text };
		};
		const res = await getObject(c, send, key);
		return interpretResultGet(res.status, res.text);
	};
	assert.equal((await read(404, "")).kind, "missing");
	assert.equal((await read(403, denied)).kind, "missing");
	assert.equal((await read(403, noKey)).kind, "missing");
	assert.equal((await read(403, badSig)).kind, "error");
	assert.equal((await read(500, "nope")).kind, "error");
	const ok = await read(200, `{"id":"C-20260116-01","status":"취소","url":"","error":"","at":"2026-01-16 09:00"}`);
	assert.deepEqual(ok, { kind: "ok", row: { id: "C-20260116-01", status: "취소", url: "", error: "", at: "2026-01-16 09:00" } });
	assert.equal(resultObjectKey("a/b"), "");
	assert.equal(resultObjectKey(".."), "");
});

test("linkedin webhook header: x-studio-key only when the linkedin key is set", () => {
	assert.deepEqual(webhookHeaders("li", "studio-key"), { "x-studio-key": "studio-key" });
	assert.deepEqual(webhookHeaders("li", "  studio-key  "), { "x-studio-key": "studio-key" });
	assert.deepEqual(webhookHeaders("li", ""), {});
	assert.deepEqual(webhookHeaders("li", "   "), {});
	assert.deepEqual(webhookHeaders("th", "studio-key"), { "x-studio-key": "studio-key" });
	assert.deepEqual(webhookHeaders("th", ""), {});
	assert.deepEqual(webhookHeaders("ig", "studio-key"), { "x-studio-key": "studio-key" });
	assert.deepEqual(webhookHeaders("ig", "  studio-key  "), { "x-studio-key": "studio-key" });
	assert.deepEqual(webhookHeaders("ig", ""), {});
	assert.deepEqual(webhookHeaders("ig", "   "), {});
});

test("s3 prefix: default is artifacts/studio; only the old default studio migrates", () => {
	assert.equal(DEFAULT_S3_PREFIX, "artifacts/studio");
	assert.equal(migrateS3Prefix(undefined), "artifacts/studio");
	assert.equal(migrateS3Prefix(null), "artifacts/studio");
	assert.equal(migrateS3Prefix("studio"), "artifacts/studio");
	assert.equal(migrateS3Prefix(" studio "), "artifacts/studio");
	assert.equal(migrateS3Prefix("studio/"), "artifacts/studio");
	assert.equal(migrateS3Prefix("/studio"), "artifacts/studio");
	assert.equal(migrateS3Prefix("my-folder"), "my-folder");
	assert.equal(migrateS3Prefix("studio/custom"), "studio/custom");
	assert.equal(migrateS3Prefix("artifacts/studio"), "artifacts/studio");
	assert.equal(migrateS3Prefix(""), "");
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

test("candidates: Flywheel 기록 dated by ### headings; AI 뉴스 by top-level items; files", () => {
	const rec = `# 운동 기록 2026-01\n\n### 2026-01-05\n- 걷기 15분, 별일 없음\n\n### 2026-01-12\n- 10km 완주! 다음엔 서브 1시간\n`;
	const c = candidatesOf(DEFAULT_SOURCES[1], "12 Flywheel/운동/01 기록/운동 기록 2026-01.md", rec, 0, "2026-01-08");
	assert.deepEqual(c.map((x) => [x.date, x.text]), [["2026-01-12", "10km 완주! 다음엔 서브 1시간"]]);
	const news = [
		"# AI 뉴스 브리핑 2026-01-14",
		"",
		"## 오늘의 셋",
		"1. **데스크톱 에이전트 공개 — 프로그램을 직접 눌러 준다**",
		"   - **무슨 일**: 에이전트가 화면을 보고 클릭한다",
		"   - [공식 자료](https://example.com/a)",
		"",
		"## 새 기술·제품",
		"- **동네 서점 지도 앱 출시** — 배경: 김하루가 즐겨 쓰는 앱",
		"",
		"## 뺀 것",
		"- 광고 게시물 약 10건",
		"",
		"## 입문자를 위한 다시 읽기",
		"### 1. 데스크톱 에이전트가 뭐야?",
		"- 쉬운 설명",
	].join("\n");
	const n = candidatesOf(DEFAULT_SOURCES[2], "07 Shelf/LLM Wiki/raw/articles/ai-news/2026-01-14_AI 뉴스 브리핑.md", news, 0, "2026-01-08");
	assert.deepEqual(
		n.map((x) => [x.where, x.text, x.why, x.line]),
		[
			["오늘의 셋", "데스크톱 에이전트 공개 — 프로그램을 직접 눌러 준다", "무슨 일: 에이전트가 화면을 보고 클릭한다", 3],
			["새 기술·제품", "동네 서점 지도 앱 출시", "배경: 김하루가 즐겨 쓰는 앱", 8],
		],
	);
	assert.equal(candidateLink(n[0], "gn1"), "07 Shelf/LLM Wiki/raw/articles/ai-news/2026-01-14_AI 뉴스 브리핑#^gn1");
	assert.equal(withBlock("1. **데스크톱 에이전트 공개**", "gn1"), "1. **데스크톱 에이전트 공개** ^gn1");
	const f = candidatesOf(DEFAULT_SOURCES[3], "07 Shelf/LLM Wiki/wiki/concepts/노트 무덤.md", `---\ntitle: 노트 무덤\n---\n모으기만 하고 잇지 못한 노트.\n`, Date.UTC(2026, 0, 11), "2026-01-08");
	assert.deepEqual(f.map((x) => [x.text, x.date, x.line]), [["노트 무덤", "2026-01-11", -1]]);
});

test("루미 search prompt: sessions and AI 뉴스 always, own words vs 자료 quoted differently", () => {
	const off = DEFAULT_SOURCES.map((s) => ({ ...s, on: s.key !== "news" }));
	const p = lumiSearchPrompt("동네 서점", off);
	assert.match(p, /^\[콘텐츠 스튜디오 · 글감 찾기\] 동네 서점/);
	const own = p.split("\n").find((l) => l.startsWith("- 내 글 소스:"))!;
	const ref = p.split("\n").find((l) => l.startsWith("- 자료 소스:"))!;
	assert.match(own, /AI 대화\(10 Archive Box\/Sessions\/\)/);
	assert.match(own, /Daily Pad\(04 Daily Pad\/\)/);
	assert.match(own, /사용자\(나\)가 직접 한 말만/);
	assert.equal(own.match(/10 Archive Box\/Sessions/g)!.length, 1);
	assert.match(ref, /AI 뉴스\(07 Shelf\/LLM Wiki\/raw\/articles\/ai-news\/\)/);
	assert.match(ref, /LLM Wiki\(07 Shelf\/LLM Wiki\/wiki\/concepts\/\)/);
	assert.match(ref, /\[자료\]/);
	assert.doesNotMatch(own, /ai-news|LLM Wiki/);
	assert.match(lumiSearchPrompt("x", []), /AI 뉴스\(07 Shelf\/LLM Wiki\/raw\/articles\/ai-news\/\)/);
	assert.ok(isReferenceSource({ key: "wiki" }) && !isReferenceSource({ key: "daily" }));
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

test("delete a post: its 글감 drops the link, back to 대기 when none is left", () => {
	const base = "- [ ] 기준을 낮추면 꾸준해진다 (src:: diary) (added:: 2026-01-14) ^g1";
	const two = markWritten(markWritten(base, "[[s/02 산출물/링크드인/2026-01-14 기준|링크드인]]"), "[[s/02 산출물/스레드/2026-01-14 기준|스레드]]");
	const one = unmarkWritten(two, "s/02 산출물/링크드인/2026-01-14 기준.md");
	assert.equal(one, "- [>] 기준을 낮추면 꾸준해진다 → [[s/02 산출물/스레드/2026-01-14 기준|스레드]] (src:: diary) (added:: 2026-01-14) ^g1");
	assert.equal(unmarkWritten(one, "s/02 산출물/스레드/2026-01-14 기준.md"), base);
});

test("default 예약: today at the next full hour (KST), late night → tomorrow 08:00", () => {
	assert.equal(defaultSchedule(new Date("2026-01-14T05:20:00Z")), "2026-01-14 15:00");
	assert.equal(defaultSchedule(new Date("2026-01-14T14:30:00Z")), "2026-01-15 08:00");
});

test("예약 시각 미리 채우기: local time rounded up to the next minute", () => {
	const at = (h: number, min: number, s = 0, ms = 0, day = 1) => new Date(2026, 10, day, h, min, s, ms);
	assert.equal(prefillSchedule(at(12, 0, 0, 0)), "2026-11-01 12:00");
	assert.equal(prefillSchedule(at(12, 0, 0, 1)), "2026-11-01 12:01");
	assert.equal(prefillSchedule(at(12, 4, 59, 999)), "2026-11-01 12:05");
	assert.equal(prefillSchedule(at(23, 59, 1, 0)), "2026-11-02 00:00");
});

test("예약 프리셋: 5분 뒤는 5분 더한 뒤 다음 분으로 올림", () => {
	const at = (h: number, min: number, s = 0, ms = 0) => new Date(2026, 10, 1, h, min, s, ms);
	assert.deepEqual(SCHEDULE_PRESETS.map((x) => x.label), ["5분 뒤", "오전 7시", "점심 12시", "퇴근 5시 반"]);
	assert.equal(schedulePresetAt("plus5", "li", at(12, 0, 0, 0)), "2026-11-01 12:05");
	assert.equal(schedulePresetAt("plus5", "th", at(12, 0, 0, 1)), "2026-11-01 12:06");
	assert.equal(schedulePresetAt("plus5", "ig", at(12, 0, 59, 0)), "2026-11-01 12:06");
	assert.equal(schedulePresetAt("plus5", "li", at(23, 55, 0, 0)), "2026-11-02 00:00");
	assert.equal(schedulePresetAt("plus5", "ig", at(23, 56, 30, 0)), "2026-11-02 00:02");
});

test("예약 프리셋: 고정 시각은 채널 여유(li·th 60초, ig 120초) 안이면 내일", () => {
	assert.equal(channelMinLeadMs("li"), 60_000);
	assert.equal(channelMinLeadMs("th"), 60_000);
	assert.equal(channelMinLeadMs("ig"), 120_000);
	const at = (h: number, min: number, s = 0, ms = 0, day = 1) => new Date(2026, 10, day, h, min, s, ms);
	assert.equal(schedulePresetAt("am7", "li", at(6, 58, 0)), "2026-11-01 07:00");
	assert.equal(schedulePresetAt("am7", "th", at(6, 58, 0)), "2026-11-01 07:00");
	assert.equal(schedulePresetAt("am7", "ig", at(6, 58, 0)), "2026-11-01 07:00");
	assert.equal(schedulePresetAt("am7", "li", at(6, 59, 0)), "2026-11-01 07:00");
	assert.equal(schedulePresetAt("am7", "ig", at(6, 59, 0)), "2026-11-02 07:00");
	assert.equal(schedulePresetAt("am7", "li", at(6, 59, 0, 1)), "2026-11-02 07:00");
	assert.equal(schedulePresetAt("am7", "th", at(7, 0, 0)), "2026-11-02 07:00");
	assert.equal(schedulePresetAt("noon", "li", at(11, 59, 0)), "2026-11-01 12:00");
	assert.equal(schedulePresetAt("noon", "ig", at(11, 59, 0)), "2026-11-02 12:00");
	assert.equal(schedulePresetAt("noon", "ig", at(9, 0, 0)), "2026-11-01 12:00");
	assert.equal(schedulePresetAt("pm1730", "li", at(17, 29, 0)), "2026-11-01 17:30");
	assert.equal(schedulePresetAt("pm1730", "th", at(17, 29, 0)), "2026-11-01 17:30");
	assert.equal(schedulePresetAt("pm1730", "ig", at(17, 29, 0)), "2026-11-02 17:30");
	assert.equal(schedulePresetAt("pm1730", "li", at(17, 30, 0)), "2026-11-02 17:30");
	assert.equal(schedulePresetAt("pm1730", "ig", at(18, 0, 0, 0, 30)), "2026-12-01 17:30");
	assert.equal(schedulePresetAt("am7", "li", new Date(2026, 11, 31, 8, 0, 0)), "2027-01-01 07:00");
});

test("발행 결과 throttle: an all-miss round does not start the 5-minute wait", () => {
	const t0 = 1_700_000_000_000;
	let last = 0;
	const remember = (eligible: number, found: number, now: number) => {
		if (shouldRememberPoll(eligible, found)) last = now;
	};
	remember(1, pollFoundCount([{ kind: "missing" }, { kind: "missing" }]), t0);
	assert.equal(last, 0);
	assert.equal(shouldThrottlePoll(last, t0 + 30_000, false), false);
	remember(1, pollFoundCount([{ kind: "applied" }, { kind: "missing" }]), t0);
	assert.equal(shouldThrottlePoll(last, t0 + 60_000, false), true);
	assert.equal(shouldThrottlePoll(last, t0 + 60_000, true), false);
	assert.equal(shouldThrottlePoll(last, t0 + 5 * 60_000, false), false);
	let none = 0;
	if (shouldRememberPoll(0, 0)) none = t0;
	assert.equal(shouldThrottlePoll(none, t0 + 1_000, false), true);
	assert.equal(shouldRememberPoll(2, pollFoundCount([{ kind: "unchanged" }])), true);
	assert.equal(shouldRememberPoll(2, pollFoundCount([{ kind: "error" }])), false);
});

test("발행 결과 fast re-poll: past-scheduled 예약 posts only, every 90s", () => {
	const at = Date.parse("2026-11-01T12:06:00.000Z");
	assert.equal(FAST_POLL_MS, 90_000);
	const post = { stage: "예약", sent: "2026-11-01 21:04", published: "", id: "C-20261101-08", scheduled: "2026-11-01 21:06", error: "" };
	assert.equal(needsFastPoll(post, at - 1), false);
	assert.equal(needsFastPoll(post, at), true);
	assert.equal(needsFastPoll({ ...post, scheduled: "2026-11-01 21:07" }, at), false);
	assert.equal(needsFastPoll({ ...post, stage: "다듬기" }, at + 60_000), false);
	assert.equal(needsFastPoll({ ...post, published: "2026-11-01" }, at + 60_000), false);
	assert.equal(needsFastPoll({ ...post, sent: "" }, at + 60_000), false);
	assert.equal(needsFastPoll({ ...post, id: "" }, at + 60_000), false);
	assert.equal(needsFastPoll({ ...post, error: "이미지 비율" }, at + 60_000), false);
	assert.equal(fastPollEvery([post], at + 60_000), 90_000);
	assert.equal(fastPollEvery([{ ...post, scheduled: "2026-11-01 22:00" }], at), null);
});

test("발행 결과 summary: per-id outcome, and json fallback when text is empty", () => {
	const published = { id: "C-20261101-08", kind: "applied" as const, detail: appliedLabel({ stage: "발행", published: "2026-11-01", url: "https://www.linkedin.com/feed/update/x/", error: null }) };
	assert.equal(formatPollHit(published), "C-20261101-08: 발행 반영");
	assert.equal(formatPollHit({ id: "C-20261101-08", kind: "missing", detail: "403 AccessDenied" }), "C-20261101-08: 결과 파일 없음(또는 권한 없음) (403 AccessDenied)");
	assert.equal(formatPollHit({ id: "C-20261101-09", kind: "error", detail: "500 InternalError" }), "C-20261101-09: 오류 500 InternalError");
	assert.equal(formatPollSummary([published, { id: "C-20261101-08", kind: "missing", detail: "404" }]), "C-20261101-08: 발행 반영\nC-20261101-08: 결과 파일 없음(또는 권한 없음) (404)");
	assert.equal(appliedLabel({ stage: "다듬기", sent: null, error: null }), "취소 반영");
	assert.equal(appliedLabel({ error: "이유 없음" }), "실패 반영");
	const json = { id: "C-20261101-08", status: "published", url: "https://www.linkedin.com/feed/update/x/", error: null, at: "2026-11-01 21:06" };
	const fromJson = parseResultJson(resultBody({ text: "", json }));
	assert.equal(fromJson?.status, "published");
	assert.equal(fromJson?.error, "");
	assert.equal(fromJson?.at, "2026-11-01 21:06");
	assert.equal(resultBody({ text: "  {\"id\":\"keep\"}  ", json: { id: "drop" } }).trim(), "{\"id\":\"keep\"}");
	assert.equal(resultBody({ text: "", json: null }), "");
	assert.equal(parseResultJson(resultBody({ text: "\uFEFF{\"id\":\"C-1\",\"status\":\"published\",\"url\":\"u\",\"error\":null,\"at\":\"2026-11-01 21:06\"}" }))?.id, "C-1");
});

test("스레드: payload, limits, result path, cancel", () => {
	const prefix = "https://example-bucket.s3.ap-northeast-2.amazonaws.com/artifacts/studio/";
	const now = Date.parse("2026-11-01T12:00:00.000Z"); // 21:00 KST
	const later = "2026-11-01 21:06";
	const media = (n: number) => Array.from({ length: n }, (_, i) => `${prefix}2026/11/p${i}.jpg`);
	const post = (over: Partial<ReturnType<typeof threadsDraft>> = {}) => {
		const d = { text: "안녕", media: [] as (string | { url: string; alt?: string })[], partsCount: 1, topic: "", scheduled: later, id: "C-20261101-08", ...over };
		return threadsProblems(d, { now, mediaPrefix: prefix });
	};
	assert.equal(threadsTextLength("안녕"), 2);
	assert.equal(threadsTextLength("😀"), 4);
	assert.equal(threadsTextLength("👨‍👩‍👧"), 18);
	assert.equal(threadsTextLength("가".repeat(500)), 500);
	assert.equal(threadsTextLength("😀".repeat(125)), 500);
	assert.deepEqual(post({ text: "가".repeat(500) }), []);
	assert.ok(post({ text: "가".repeat(501) }).some((x) => /500자/.test(x)));
	assert.ok(post({ text: "😀".repeat(126) }).some((x) => /500자/.test(x)));
	const five = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`).join(" ");
	assert.deepEqual(post({ text: five }), []);
	assert.equal(threadsUniqueLinks("http://A.com http://a.com.").length, 1);
	assert.ok(post({ text: `${five} https://example.com/5` }).some((x) => /링크/.test(x)));
	assert.deepEqual(post({ text: "", media: media(20) }), []);
	assert.ok(post({ text: "", media: media(21) }).some((x) => /미디어가 너무 많음/.test(x)));
	assert.deepEqual(post({ text: "", media: [] }), ["글과 미디어가 모두 비어 있어요."]);
	assert.deepEqual(post({ text: "글", media: [`${prefix}a.webp`] }), []);
	assert.ok(post({ text: "글", media: [`${prefix}a.pdf`] }).some((x) => /지원하지 않는 미디어/.test(x)));
	assert.ok(post({ text: "글", media: [`${prefix}../secret.jpg`] }).some((x) => /허용되지 않은/.test(x)));
	assert.ok(post({ text: "글", media: ["https://other.example/a.jpg"] }).some((x) => /허용되지 않은/.test(x)));
	assert.deepEqual(post({ text: "글", media: [{ url: `${prefix}a.jpg`, alt: "가".repeat(1000) }] }), []);
	assert.ok(post({ text: "글", media: [{ url: `${prefix}a.jpg`, alt: "가".repeat(1001) }] }).some((x) => /alt/.test(x)));
	assert.deepEqual(post({ topic: "기록" }), []);
	assert.deepEqual(post({ topic: "a".repeat(50) }), []);
	assert.ok(post({ topic: "a".repeat(51) }).some((x) => /주제/.test(x)));
	assert.ok(post({ topic: "a.b" }).some((x) => /주제/.test(x)));
	assert.ok(post({ topic: "a&b" }).some((x) => /주제/.test(x)));
	assert.deepEqual(post({ partsCount: 2, parts: [{ text: "하나", media: [] }, { text: "둘", media: [] }] }), []);
	assert.deepEqual(post({ scheduled: "2026-11-01 21:01" }), []);
	assert.ok(post({ scheduled: "2026-11-01 21:00" }).some((x) => /1분/.test(x)));
	assert.equal(threadsUploadProblem("a.jpg", 8 * 1024 * 1024), null);
	assert.ok(threadsUploadProblem("a.jpg", 8 * 1024 * 1024 + 1)?.includes("8MB"));
	assert.equal(threadsUploadProblem("a.mp4", 1024 * 1024 * 1024), null);
	assert.ok(threadsUploadProblem("a.mov", 1024 * 1024 * 1024 + 1)?.includes("1GB"));
	assert.equal(threadsUploadProblem("a.gif", 1), null);
	assert.equal(resultObjectKey("C-20261101-08", "li"), "studio/results/C-20261101-08.json");
	assert.equal(resultObjectKey("C-20261101-08", "th"), "studio/results/threads/C-20261101-08.json");
	assert.equal(resultObjectKey("_token", "th"), "");
	assert.equal(resultObjectKey("TEST-THREADS-001", "th"), "");
	const file = setFm(setPostBody(postSkeleton(TH, "C-20261101-08", []), TH, { parts: [{ text: "한 줄", media: [`${prefix}a.png`] }, { text: "둘", media: [] }] }), { topic: "기록", scheduled: later, alt: ["설명"] });
	const parsed = parsePost("x/2026-11-01 t.md", file, TH);
	const schedule = buildPayload(parsed);
	assert.equal(schedule.action, "schedule");
	assert.equal(schedule.channel, "threads");
	assert.equal(schedule.title, parsed.title);
	assert.equal(schedule.text, "한 줄");
	assert.deepEqual(schedule.parts, [{ text: "둘", media: [] }]);
	assert.deepEqual(schedule.media, [{ url: `${prefix}a.png`, alt: "설명" }]);
	assert.equal(schedule.topic, "기록");
	assert.equal(schedule.text.includes(parsed.title), false);
	const cancel = buildPayload(parsed, "cancel");
	assert.equal(cancel.action, "cancel");
	assert.equal(cancel.channel, "threads");
	assert.equal(cancel.id, "C-20261101-08");
	assert.deepEqual(cancel.media, []);
	assert.equal(cancel.parts, undefined);
});

test("지금 발행 시각, 접수 응답, 예약 상태, 인스타 결과 키, 최소 여유", () => {
	const t = new Date("2026-11-01T12:00:10.000Z"); // 21:00:10 KST
	assert.equal(immediateAt("li", t), "2026-11-01 21:02");
	assert.equal(immediateAt("th", t), "2026-11-01 21:02");
	assert.equal(immediateAt("ig", t), "2026-11-01 21:03");
	assert.equal(immediateAt("li", new Date("2026-11-01T11:58:50.000Z")), "2026-11-01 21:00");
	assert.equal(resultObjectKey("C-20261101-08", "ig"), "studio/results/instagram/C-20261101-08.json");
	assert.equal(resultObjectKey("C-20261101-08", "instagram"), "studio/results/instagram/C-20261101-08.json");
	assert.equal(resultObjectKey("C-20261101-08", "li"), "studio/results/C-20261101-08.json");
	const failed = interpretIntake(200, JSON.stringify({ status: "failed", error: "본문이 너무 김" }));
	assert.equal(failed.ok, false);
	assert.equal(failed.failed, true);
	assert.equal(failed.error, "본문이 너무 김");
	const ok = interpretIntake(200, JSON.stringify({ ok: true, schedule: "th-C-1", at: "2026-11-01 21:06" }));
	assert.equal(ok.ok, true);
	assert.equal(ok.schedule, "th-C-1");
	assert.equal(ok.at, "2026-11-01 21:06");
	const warned = interpretIntake(200, JSON.stringify({ ok: true, warning: "이미지가 잘릴 수 있어요" }));
	assert.equal(warned.ok, true);
	assert.equal(warned.warning, "이미지가 잘릴 수 있어요");
	const bad = interpretIntake(400, JSON.stringify({ ok: false, error: "at must be at least 1 minute in the future (KST)" }));
	assert.equal(bad.ok, false);
	assert.equal(bad.error, "at must be at least 1 minute in the future (KST)");
	const base = { stage: "초안", sent: "", published: "", scheduled: "", url: "", error: "", cancelled: "" };
	assert.equal(postState(base).name, "예약 전");
	const when = Date.parse("2026-11-01T12:00:00.000Z"); // 21:00 KST
	assert.equal(postState({ ...base, stage: "예약", sent: "2026-11-01 20:00", scheduled: "2026-11-01 21:06" }, when).name, "예약됨");
	assert.equal(postState({ ...base, stage: "예약", sent: "2026-11-01 20:00", scheduled: "2026-11-01 21:06" }, when).detail, "11/1 21:06");
	assert.equal(postState({ ...base, stage: "예약", sent: "2026-11-01 20:50", scheduled: "2026-11-01 21:00" }, when).name, "발행 중");
	assert.equal(postState({ ...base, stage: "발행", published: "2026-11-01", url: "https://example.com/p", sent: "2026-11-01 20:00", scheduled: "2026-11-01 21:00" }, when).name, "발행됨");
	assert.equal(postState({ ...base, stage: "예약", sent: "2026-11-01 20:00", scheduled: "2026-11-01 21:06", error: "이유\n둘째" }, when).name, "실패");
	assert.equal(postState({ ...base, stage: "예약", sent: "2026-11-01 20:00", scheduled: "2026-11-01 21:06", error: "이유\n둘째" }, when).detail, "이유");
	assert.equal(postState({ ...base, stage: "다듬기", cancelled: "2026-11-01 21:10" }, when).name, "취소됨");
	const li = parsePost("x/t.md", setFm(setPostBody(postSkeleton(LI, "C-1", []), LI, { text: "본문" }), { scheduled: "2026-11-01 21:00" }), LI);
	const now = Date.parse("2026-11-01T11:59:30.000Z"); // 20:59:30 KST, 30s before 21:00
	assert.ok(postProblems(li, { now }).some((x) => /1분 뒤/.test(x.text)));
	assert.equal(postProblems(li, { now: Date.parse("2026-11-01T11:58:00.000Z") }).some((x) => /1분 뒤/.test(x.text)), false);
	const ig = parsePost("x/t.md", setFm(setPostBody(postSkeleton(IG, "C-2", []), IG, { text: "캡션" }), { scheduled: "2026-11-01 21:00", media: ["https://example.com/a.jpg"] }), IG);
	assert.ok(postProblems(ig, { now: Date.parse("2026-11-01T11:58:30.000Z") }).some((x) => /2분 뒤/.test(x.text)));
	assert.equal(postProblems(ig, { now: Date.parse("2026-11-01T11:57:00.000Z") }).some((x) => /2분 뒤/.test(x.text)), false);
});

test("수동 발행 결과 읽기: 지난 인스타 글도 instagram/ 키로 published를 반영", () => {
	const past = "2026-11-01 20:00";
	const future = "2026-11-01 23:00";
	const plan = resultReadPlan([
		{ id: "C-IG-1", channel: "ig", stage: "예약", sent: "2026-11-01 19:50", published: "", scheduled: past },
		{ id: "C-LI-1", channel: "li", stage: "예약", sent: "2026-11-01 19:50", published: "", scheduled: future },
		{ id: "C-TH-1", channel: "th", stage: "예약", sent: "2026-11-01 19:50", published: "", scheduled: past },
		{ id: "C-IG-2", channel: "ig", stage: "발행", sent: "2026-11-01 19:50", published: "2026-11-01", scheduled: past },
		{ id: "C-IG-3", channel: "ig", stage: "예약", sent: "", published: "", scheduled: past },
	]);
	assert.deepEqual(
		plan.map((x) => x.key),
		["studio/results/instagram/C-IG-1.json", "studio/results/C-LI-1.json", "studio/results/threads/C-TH-1.json"],
	);
	const ig = parsePost(
		"x/2026-11-01 인스타.md",
		setFm(setPostBody(postSkeleton(IG, "C-IG-1", []), IG, { text: "캡션" }), { stage: "예약", scheduled: past, sent: "2026-11-01 19:50", media: ["https://example.com/a.jpg"] }),
		IG,
	);
	assert.equal(ig.channel.key, "ig");
	assert.equal(ig.stage, "예약");
	const row = parseResultJson(`{"id":"C-IG-1","status":"published","url":"https://www.instagram.com/p/example/","error":null,"at":"2026-11-01 20:01"}`);
	if (!row) throw new Error("result json");
	assert.deepEqual(resultPatch(ig, row), { published: "2026-11-01", url: "https://www.instagram.com/p/example/", stage: "발행", error: null });
	assert.equal(formatPollHit({ id: "C-IG-1", kind: "missing", detail: "403 AccessDenied" }), "C-IG-1: 결과 파일 없음(또는 권한 없음) (403 AccessDenied)");
	assert.equal(isAbsentResult(403, "<Error><Code>AccessDenied</Code></Error>"), true);
});

test("지금 발행 control is a tinted button class, not ghost text", () => {
	assert.match(SEND_NOW_BUTTON_CLASS, /\bst-btn\b/);
	assert.match(SEND_NOW_BUTTON_CLASS, /\bst-now\b/);
	assert.equal(SEND_NOW_BUTTON_CLASS.includes("is-ghost"), false);
	assert.equal(SEND_NOW_MENU_CLASS, "st-now-menu");
});


test("링크드인 FORMATS에 링크가 있고 FM·페이로드가 article을 실어요", () => {
	assert.deepEqual(FORMATS.li, ["글만", "링크", "이미지", "문서", "영상"]);
	const t = `---
id: C-20261112-02
channel: 링크드인
format: 링크
stage: 초안
link: https://n.news.naver.com/article/047/0002534981?sid=102
link_title: AI 전문가도 사라진다
link_description: 본문 요약
link_thumbnail: https://example.com/thumb.jpg
scheduled: "2026-11-12 08:00"
---

## 본문

기사 소개 글
`;
	const p = parsePost("x/2026-11-12 AI.md", t, LI);
	assert.equal(p.format, "링크");
	assert.equal(p.link, "https://n.news.naver.com/article/047/0002534981?sid=102");
	assert.equal(p.linkTitle, "AI 전문가도 사라진다");
	assert.equal(p.linkDescription, "본문 요약");
	assert.equal(p.linkThumbnail, "https://example.com/thumb.jpg");
	const pay = buildPayload(p);
	assert.equal(pay.format, "링크");
	assert.deepEqual(pay.media, []);
	assert.deepEqual(pay.article, {
		source: "https://n.news.naver.com/article/047/0002534981?sid=102",
		title: "AI 전문가도 사라진다",
		description: "본문 요약",
		thumbnail: "https://example.com/thumb.jpg",
	});
	const bare = parsePost(
		"x/t.md",
		setFm(setPostBody(postSkeleton(LI, "C-L", []), LI, { text: "본문" }), {
			format: "링크",
			link: "https://example.com/a",
			scheduled: "2026-11-12 08:00",
		}),
		LI,
	);
	const barePay = buildPayload(bare);
	assert.deepEqual(barePay.article, { source: "https://example.com/a" });
	assert.equal("title" in (barePay.article ?? {}), false);
	assert.equal(JSON.stringify(barePay).includes('"media":[]'), true);
});

test("링크드인 기존 형식 페이로드에 article 키가 없어요 (회귀)", () => {
	const mk = (format: string, media: string[] = []) =>
		parsePost(
			"x/t.md",
			setFm(setPostBody(postSkeleton(LI, "C-1", []), LI, { text: "본문입니다." }), {
				format,
				scheduled: "2026-11-10 08:00",
				...(media.length ? { media } : {}),
			}),
			LI,
		);
	for (const [format, media] of [
		["글만", [] as string[]],
		["이미지", ["https://b.s3.ap-northeast-2.amazonaws.com/studio/a.png"]],
		["문서", ["https://b.s3.ap-northeast-2.amazonaws.com/studio/a.pdf"]],
		["영상", ["https://b.s3.ap-northeast-2.amazonaws.com/studio/a.mp4"]],
	] as const) {
		const pay = buildPayload(mk(format, [...media]));
		const json = JSON.stringify(pay);
		assert.equal(json.includes('"article"'), false, format);
		assert.equal(pay.format, format);
		assert.equal(pay.text, "본문입니다.");
		assert.deepEqual(pay.media, [...media]);
		assert.equal(pay.at, "2026-11-10T08:00:00+09:00");
		assert.equal(pay.channel, "linkedin");
	}
});

test("링크드인 링크 검증과 영상 10분 lead", () => {
	const base = setPostBody(postSkeleton(LI, "C-1", []), LI, { text: "본문" });
	const noLink = parsePost("x/t.md", setFm(base, { format: "링크", scheduled: "2026-11-12 08:00" }), LI);
	assert.ok(postProblems(noLink).some((x) => x.level === "block" && x.text.includes("기사 주소")));
	const bad = parsePost("x/t.md", setFm(base, { format: "링크", link: "not-a-url", scheduled: "2026-11-12 08:00" }), LI);
	assert.ok(postProblems(bad).some((x) => x.level === "block" && x.text.includes("올바르지 않")));
	const ok = parsePost(
		"x/t.md",
		setFm(base, { format: "링크", link: "https://example.com/a", scheduled: "2026-12-01 08:00" }),
		LI,
	);
	assert.equal(
		postProblems(ok, { now: Date.parse("2026-11-01T00:00:00+09:00") }).some((x) => x.text.includes("기사")),
		false,
	);

	assert.equal(channelMinLeadMs("li", "영상"), 600_000);
	assert.equal(channelMinLeadMs("li", "글만"), 60_000);
	assert.equal(channelMinLeadMs("li"), 60_000);
	assert.equal(channelMinLeadMs("th", "영상"), 60_000);
	assert.equal(channelMinLeadMs("ig"), 120_000);

	const now = Date.parse("2026-11-01T12:00:00+09:00");
	assert.equal(leadProblem("li", "2026-11-01 12:05", now, "영상"), "예약 시각은 지금보다 10분 뒤여야 해요.");
	assert.equal(leadProblem("li", "2026-11-01 12:10", now, "영상"), null);
	assert.equal(leadProblem("li", "2026-11-01 12:00", now, "글만"), "예약 시각은 지금보다 1분 뒤여야 해요.");
	assert.equal(leadProblem("li", "2026-11-01 12:01", now, "글만"), null);
	assert.equal(leadProblem("ig", "2026-11-01 12:01", now), "예약 시각은 지금보다 2분 뒤여야 해요.");

	const t = new Date("2026-11-01T12:00:10.000Z"); // 21:00:10 KST
	assert.equal(immediateAt("li", t, "글만"), "2026-11-01 21:02");
	assert.equal(immediateAt("li", t), "2026-11-01 21:02");
	assert.equal(immediateAt("li", t, "영상"), "2026-11-01 21:11");

	const at = (h: number, min: number, s = 0, ms = 0) => new Date(2026, 10, 1, h, min, s, ms);
	assert.equal(schedulePresetAt("am7", "li", at(6, 55, 0), "영상"), "2026-11-02 07:00");
	assert.equal(schedulePresetAt("am7", "li", at(6, 55, 0), "글만"), "2026-11-01 07:00");
	assert.equal(schedulePresetAt("am7", "li", at(6, 50, 0), "영상"), "2026-11-01 07:00");

	assert.equal(blocksNow([{ level: "block", text: "예약 시각은 지금보다 10분 뒤여야 해요." }]), false);
	assert.equal(blocksNow([{ level: "block", text: "기사 주소를 넣어 주세요." }]), true);
});


test("링크드인 결과 warning: 파싱·반영·상태 유지, 빈 article 키 없음", () => {
	const absent = parseResultJson(`{"id":"C-1","status":"published","url":"https://www.linkedin.com/feed/update/x/","error":null,"at":"2026-11-12 08:05"}`);
	assert.equal(absent?.warning, undefined);
	const empty = parseResultJson(`{"id":"C-1","status":"published","url":"https://www.linkedin.com/feed/update/x/","error":null,"at":"2026-11-12 08:05","warning":""}`);
	assert.equal(empty?.warning, undefined);
	const warned = parseResultJson(`{"id":"C-1","status":"published","url":"https://www.linkedin.com/feed/update/x/","error":null,"at":"2026-11-12 08:05","warning":"썸네일 업로드에 실패해 미리보기 없이 올렸어요"}`);
	assert.equal(warned?.warning, "썸네일 업로드에 실패해 미리보기 없이 올렸어요");
	assert.equal(warned?.status, "published");

	const t = `---\nid: C-1\nstage: 예약\nscheduled: "2026-11-12 08:00"\nsent: "2026-11-11 20:00"\n---\n\n## 본문\n\n글\n`;
	const p = parsePost("x/t.md", t, LI);
	const patch = resultPatch(p, warned!);
	assert.deepEqual(patch, {
		published: "2026-11-12",
		url: "https://www.linkedin.com/feed/update/x/",
		stage: "발행",
		error: null,
		warning: "썸네일 업로드에 실패해 미리보기 없이 올렸어요",
	});
	assert.equal(appliedLabel(patch!), "발행 반영");
	assert.equal(resultPatch({ ...p, published: "2026-11-12", url: warned!.url, stage: "발행", warning: warned!.warning! }, warned!), null);
	assert.deepEqual(resultPatch(p, absent!), {
		published: "2026-11-12",
		url: "https://www.linkedin.com/feed/update/x/",
		stage: "발행",
		error: null,
	});

	const noSource = parsePost(
		"x/t.md",
		setFm(setPostBody(postSkeleton(LI, "C-L", []), LI, { text: "본문" }), { format: "링크", scheduled: "2026-11-12 08:00" }),
		LI,
	);
	const pay = buildPayload(noSource);
	assert.equal("article" in pay, false);
	assert.deepEqual(pay.media, []);
	const withEmptyOpts = parsePost(
		"x/t.md",
		setFm(setPostBody(postSkeleton(LI, "C-L2", []), LI, { text: "본문" }), {
			format: "링크",
			link: "https://example.com/a",
			link_title: "",
			link_description: "  ",
			link_thumbnail: "",
			scheduled: "2026-11-12 08:00",
		}),
		LI,
	);
	const art = buildPayload(withEmptyOpts).article!;
	assert.deepEqual(art, { source: "https://example.com/a" });
	assert.equal(JSON.stringify(art).includes('""'), false);
	assert.equal("title" in art, false);
	assert.equal("description" in art, false);
	assert.equal("thumbnail" in art, false);
});


test("링크드인 「링크」에서 다른 형식으로 바꾸면 남은 link는 무시해요", () => {
	const img = "https://b.s3.ap-northeast-2.amazonaws.com/studio/a.png";
	const p = parsePost(
		"x/t.md",
		setFm(setPostBody(postSkeleton(LI, "C-1", []), LI, { text: "본문" }), {
			format: "이미지",
			media: [img],
			link: "not-a-url",
			scheduled: "2026-12-01 08:00",
		}),
		LI,
	);
	const pay = buildPayload(p);
	assert.equal(JSON.stringify(pay).includes('"article"'), false);
	assert.deepEqual(pay.media, [img]);
	assert.equal(postProblems(p, { now: Date.parse("2026-11-01T00:00:00+09:00") }).some((x) => x.text.includes("기사")), false);
});
