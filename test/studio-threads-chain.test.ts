import { test } from "node:test";
import assert from "node:assert/strict";
import {
	appliedLabel,
	blocksNow,
	buildPayload,
	channelByKey,
	FAST_POLL_MS,
	fastPollEvery,
	interpretResultGet,
	needsFastPoll,
	parsePost,
	parseResultJson,
	postProblems,
	postSkeleton,
	postState,
	resultPatch,
	resultReadPlan,
	setFm,
	setPostBody,
	shouldRememberPoll,
	threadsCancelNote,
	threadsDraft,
	threadsProblems,
	threadsResendBlock,
	threadsResultNote,
	THREADS_UNKNOWN_NOTE,
} from "../src/studio/model.ts";

const TH = channelByKey("th");
const LI = channelByKey("li");
const prefix = "https://example-bucket.s3.ap-northeast-2.amazonaws.com/artifacts/studio/";
const later = "2026-11-01 21:06";
const now = Date.parse("2026-11-01T12:00:00.000Z"); // 21:00 KST

type Part = { text: string; media: string[] };
const fileOf = (id: string, parts: Part[], fm: Record<string, string | string[]> = {}) => setFm(setPostBody(postSkeleton(TH, id, []), TH, { parts }), { scheduled: later, ...fm });

test("스레드 타래: payload는 파트 1을 최상위에, 2..N을 parts에", () => {
	const parts: Part[] = [
		{ text: "첫 글", media: [`${prefix}2026/11/a.jpg`] },
		{ text: "둘째", media: [] },
		{ text: "셋째", media: [`${prefix}2026/11/b.png`, `${prefix}2026/11/c.mp4`] },
	];
	const p = parsePost("x/2026-11-01 t.md", fileOf("C-20261101-09", parts, { topic: "기록", alt: ["첫 사진"] }), TH);
	const pay = buildPayload(p);
	assert.equal(pay.text, "첫 글");
	assert.deepEqual(pay.media, [{ url: `${prefix}2026/11/a.jpg`, alt: "첫 사진" }]);
	assert.deepEqual(pay.parts, [
		{ text: "둘째", media: [] },
		{ text: "셋째", media: [`${prefix}2026/11/b.png`, `${prefix}2026/11/c.mp4`] },
	]);
	assert.equal(pay.topic, "기록");
	const json = JSON.parse(JSON.stringify(pay)) as { parts: object[] };
	assert.deepEqual(Object.keys(json.parts[0]).sort(), ["media", "text"]);
	// 단일 글: parts 키 자체가 없음, 나머지는 예전과 같음
	const one = buildPayload(parsePost("x/t.md", fileOf("C-1", [parts[0]]), TH));
	assert.equal("parts" in one, false);
	assert.equal(one.text, "첫 글");
	// 취소: 예전과 같음
	const cancel = buildPayload(p, "cancel");
	assert.equal("parts" in cancel, false);
	assert.equal(cancel.action, "cancel");
	assert.equal(cancel.text, "");
	// 지금 발행: 같은 payload, at만 다름
	const nowPay = buildPayload({ ...p, scheduled: "2026-11-01 21:02" });
	assert.deepEqual(nowPay.parts, pay.parts);
	assert.equal(nowPay.at, "2026-11-01T21:02:00+09:00");
});

test("스레드 타래: 파트별 검증", () => {
	const base = { topic: "", scheduled: later, id: "C-20261101-09" };
	const check = (parts: { text: string; media: (string | { url: string; alt?: string })[] }[], mediaPrefix = prefix) =>
		threadsProblems({ ...base, text: parts[0].text, media: parts[0].media, partsCount: parts.length, parts }, { now, mediaPrefix });
	const ok = (t = "글"): Part => ({ text: t, media: [] });
	assert.deepEqual(check([ok(), ok("가".repeat(500))]), []);
	assert.deepEqual(check([ok(), ok("가".repeat(501))]), ["2번째 글: 본문이 500자를 넘어요: 501/500 (이모티콘은 바이트 수로 셈)"]);
	assert.ok(check([ok(), ok("😀".repeat(126))]).some((x) => x.startsWith("2번째 글: 본문이 500자")));
	assert.deepEqual(check([ok(), ok(""), ok()]), ["2번째 글: 글과 미디어가 모두 비어 있어요."]);
	assert.deepEqual(check([ok(""), ok()]), ["1번째 글: 글과 미디어가 모두 비어 있어요."]);
	// 텍스트 없이 미디어만 있는 파트: 파트 1이든 뒤 파트든 통과
	const img = (n: string): Part => ({ text: "", media: [`${prefix}2026/11/${n}.jpg`] });
	assert.deepEqual(check([img("a"), ok()]), []);
	assert.deepEqual(check([ok(), img("b"), img("c")]), []);
	assert.deepEqual(check([img("a"), img("b")]), []);
	// 단일 글 규칙과 같음: 미디어만 있는 글은 통과, 둘 다 비면 같은 문구 (번호 없이)
	assert.deepEqual(check([img("a")]), []);
	assert.deepEqual(check([ok("")]), ["글과 미디어가 모두 비어 있어요."]);
	assert.deepEqual(check(Array.from({ length: 20 }, () => ok())), []);
	assert.ok(check(Array.from({ length: 21 }, () => ok())).some((x) => /20개까지/.test(x) && /21개/.test(x)));
	// 미디어 규칙은 파트마다
	assert.deepEqual(check([ok(), { text: "", media: [`${prefix}2026/11/a.webp`] }]), []);
	assert.ok(check([ok(), { text: "글", media: [`${prefix}a.pdf`] }]).some((x) => x.startsWith("2번째 글: 지원하지 않는 미디어")));
	assert.ok(check([ok(), { text: "글", media: ["https://other.example/a.jpg"] }]).some((x) => x.startsWith("2번째 글: 허용되지 않은")));
	assert.ok(check([ok(), { text: "글", media: Array.from({ length: 21 }, (_, i) => `${prefix}${i}.jpg`) }]).some((x) => x.startsWith("2번째 글: 미디어가 너무 많음")));
	const links = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(" ");
	assert.ok(check([ok(), ok(links)]).some((x) => x.startsWith("2번째 글: 링크")));
	// S3 설정이 없으면 뒤 파트 미디어도 막음 (문구는 한 번)
	assert.equal(check([ok(), { text: "글", media: [`${prefix}a.jpg`] }], "").filter((x) => /S3/.test(x)).length, 1);
	// 파일 → postProblems: 「이어쓰기는 아직」 차단 없음
	const p = parsePost("x/t.md", fileOf("C-20261101-09", [ok("하나"), ok("둘")]), TH);
	assert.deepEqual(postProblems(p, { now, mediaPrefix: prefix }), []);
	assert.equal(threadsDraft(p).partsCount, 2);
});

test("스레드 타래: 결과 파일 (하위호환, partial, 파트별 실패, 취소)", () => {
	const three: Part[] = [{ text: "a", media: [] }, { text: "b", media: [] }, { text: "c", media: [] }];
	const th = parsePost("x/t.md", fileOf("C-TH-2", three, { stage: "예약", sent: "2026-11-01 21:00" }), TH);
	const read = (o: object) => parseResultJson(JSON.stringify({ id: "C-TH-2", ...o }))!;
	// status + url만 있는 예전 형식은 그대로
	const old = read({ status: "published", url: "https://t/1", error: null, at: "2026-11-01 21:07" });
	assert.deepEqual(old, { id: "C-TH-2", status: "published", url: "https://t/1", error: "", at: "2026-11-01 21:07" });
	assert.equal(threadsResultNote(old), "");
	assert.deepEqual(resultPatch(th, old), { published: "2026-11-01", url: "https://t/1", stage: "발행", error: null });
	// 전부 게시: 경고 없음
	const full = read({ status: "published", url: "https://t/1", at: "2026-11-01 21:07", total: 3, published_count: 3, parts: [{ index: 1, status: "published", id: "1", url: "https://t/1" }, { index: 2, status: "published" }, { index: 3, status: "published" }] });
	assert.equal(full.total, 3);
	assert.equal(full.publishedCount, 3);
	assert.deepEqual(full.parts?.[0], { index: 1, status: "published", id: "1", url: "https://t/1", error: "" });
	assert.equal(threadsResultNote(full), "");
	assert.deepEqual(resultPatch(th, full), { published: "2026-11-01", url: "https://t/1", stage: "발행", error: null });
	// partial: 발행 + 「3개 중 2개 게시」
	const partial = read({ status: "partial", url: "https://t/1", at: "2026-11-01 21:08", total: 3, published_count: 2, error: "part 3", parts: [{ index: 1, status: "published", url: "https://t/1" }, { index: 2, status: "published" }, { index: 3, status: "failed", error: "rate limit" }] });
	const note = "타래 3개 중 2개 게시 · 3번째 글 실패: rate limit";
	assert.equal(threadsResultNote(partial), note);
	const patch = resultPatch(th, partial)!;
	assert.deepEqual(patch, { published: "2026-11-01", url: "https://t/1", stage: "발행", error: null, warning: note });
	assert.equal(appliedLabel(patch), `일부 발행 반영 (${note})`);
	assert.equal(resultPatch({ ...th, published: "2026-11-01", url: "https://t/1", warning: note }, partial), null);
	const st = postState({ ...th, stage: "발행", published: "2026-11-01", url: "https://t/1", warning: note });
	assert.equal(st.kind, "published");
	assert.equal(st.name, "일부 발행");
	assert.equal(st.detail, note);
	assert.equal(postState({ ...th, stage: "발행", published: "2026-11-01", url: "https://t/1", warning: "" }).name, "발행됨");
	// partial without counts: 「n개 중 m개」는 parts에서 셈
	assert.equal(threadsResultNote(read({ status: "partial", url: "u", parts: [{ index: 1, status: "published" }, { index: 2, status: "failed", error: "x" }] })), "타래 2개 중 1개 게시 · 2번째 글 실패: x");
	// 0-based index, 최상위 url 없으면 파트 1 url
	const zero = read({ status: "partial", at: "2026-11-01 21:08", parts: [{ index: 0, status: "published", url: "https://t/0" }, { index: 1, status: "failed" }, { index: 2, status: "cancelled" }] });
	assert.equal(threadsResultNote(zero), "타래 3개 중 1개 게시 · 2번째 글 실패: 이유 없음 · 나머지는 취소됨");
	assert.equal(resultPatch(th, zero)?.url, "https://t/0");
	// 부분 게시 후 취소: 다듬기로 되돌리지 않고 일부 발행
	const cancelledAfter = read({ status: "취소", url: "https://t/1", at: "2026-11-01 21:09", total: 3, published_count: 1 });
	assert.deepEqual(resultPatch(th, cancelledAfter), { published: "2026-11-01", url: "https://t/1", stage: "발행", error: null, warning: "타래 3개 중 1개 게시 · 나머지는 취소됨" });
	// 아무것도 안 올라간 취소는 예전과 같음
	const cancelled = read({ status: "취소", at: "2026-11-01 21:09", total: 3, published_count: 0 });
	assert.deepEqual(resultPatch(th, cancelled), { stage: "다듬기", sent: null, error: null, cancelled: "2026-11-01 21:09", now: null });
	// failed: 파트별 실패를 이유에 붙임
	const failed = read({ status: "failed", error: "token", at: "2026-11-01 21:09", total: 3, published_count: 0, parts: [{ index: 1, status: "failed", error: "token" }] });
	assert.deepEqual(resultPatch(th, failed), { error: "token · 타래 3개 중 0개 게시 · 1번째 글 실패: token" });
	// failed인데 일부가 올라갔으면 일부 발행
	const failedAfter = read({ status: "failed", url: "https://t/1", at: "2026-11-01 21:09", total: 3, published_count: 2, parts: [{ index: 3, status: "failed", error: "x" }] });
	assert.equal(resultPatch(th, failedAfter)?.stage, "발행");
	// 이상한 값은 버림 (예전 형식과 같은 모양)
	assert.deepEqual(read({ status: "published", url: "u", total: "x", published_count: -1, parts: "no" }), { id: "C-TH-2", status: "published", url: "u", error: "", at: "" });
});

test("스레드 타래: 미디어만 있는 파트 (파일 → payload)", () => {
	const parts: Part[] = [
		{ text: "", media: [`${prefix}2026/11/a.jpg`] },
		{ text: "둘째", media: [] },
		{ text: "", media: [`${prefix}2026/11/b.mp4`] },
	];
	const p = parsePost("x/t.md", fileOf("C-20261101-09", parts), TH);
	assert.deepEqual(p.parts, parts);
	assert.deepEqual(postProblems(p, { now, mediaPrefix: prefix }), []);
	const pay = buildPayload(p);
	assert.equal(pay.text, "");
	assert.deepEqual(pay.media, [`${prefix}2026/11/a.jpg`]);
	assert.deepEqual(pay.parts, [{ text: "둘째", media: [] }, { text: "", media: [`${prefix}2026/11/b.mp4`] }]);
	// 둘 다 빈 파트는 막음
	const bad = parsePost("x/t.md", fileOf("C-20261101-09", [parts[0], { text: "", media: [] }]), TH);
	assert.deepEqual(postProblems(bad, { now, mediaPrefix: prefix }).map((x) => x.text), ["2번째 글: 글과 미디어가 모두 비어 있어요."]);
});

test("스레드 타래: 결과가 늦어도 실패로 보지 않음 (폴링)", () => {
	const twenty = Array.from({ length: 20 }, (_, i): Part => ({ text: `글 ${i + 1}`, media: [] }));
	const th = parsePost("x/t.md", fileOf("C-TH-4", twenty, { stage: "예약", sent: "2026-11-01 20:50", scheduled: "2026-11-01 21:00" }), TH);
	// 예약 시각 30분 뒤에도 결과 파일이 없으면 「발행 중」 + 빠른 확인 유지 (마감 없음)
	const late = now + 30 * 60_000;
	assert.equal(postState(th, late).kind, "going");
	assert.equal(needsFastPoll(th, late), true);
	assert.equal(fastPollEvery([th], late), FAST_POLL_MS);
	assert.equal(needsFastPoll(th, now + 6 * 3600_000), true);
	// 결과 파일 없음 (404, 403 AccessDenied/NoSuchKey) = 아직, 실패 아님
	for (const [status, body] of [[404, ""], [403, "<Error><Code>AccessDenied</Code></Error>"], [403, "<Error><Code>NoSuchKey</Code></Error>"]] as const) {
		assert.deepEqual(interpretResultGet(status, body), { kind: "missing" });
	}
	assert.equal(interpretResultGet(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>").kind, "error");
	// 결과 없음 라운드는 스로틀을 걸지 않음
	assert.equal(shouldRememberPoll(1, 0), false);
	// 마지막에 한 번 써진 결과 (at이 sent보다 몇 분 뒤)는 그대로 반영
	const done = parseResultJson(JSON.stringify({ id: "C-TH-4", status: "published", url: "https://t/1", at: "2026-11-01 21:09", total: 20, published_count: 20 }))!;
	assert.equal(resultPatch(th, done)?.stage, "발행");
	// 실패는 결과 파일이 있을 때만
	assert.equal(postState({ ...th, error: "token" }, late).kind, "failed");
	assert.equal(needsFastPoll({ ...th, error: "token" }, late), false);
});

test("스레드 타래: 취소 안내 문구", () => {
	const th = parsePost("x/t.md", fileOf("C-TH-3", [{ text: "a", media: [] }, { text: "b", media: [] }]), TH);
	assert.match(threadsCancelNote(th), /남은 글만 멈춰요/);
	assert.equal(threadsCancelNote({ ...th, parts: [th.parts[0]] }), "");
	assert.equal(threadsCancelNote({ ...th, channel: LI }), "");
});

test("스레드 타래: 서버 결과 parts[].index는 1부터 (파트 1 포함)", () => {
	const three: Part[] = [{ text: "a", media: [] }, { text: "b", media: [] }, { text: "c", media: [] }];
	const th = parsePost("x/t.md", fileOf("C-TH-5", three, { stage: "예약", sent: "2026-11-01 21:00" }), TH);
	// 서버가 실제로 쓰는 형태: index 1 = 파트 1, 최상위 url 없음
	const r = parseResultJson(
		JSON.stringify({
			id: "C-TH-5",
			status: "partial",
			url: null,
			error: "part 2 failed",
			at: "2026-11-01 21:08",
			total: 3,
			published_count: 1,
			parts: [
				{ index: 1, status: "published", id: "179001", url: "https://t/p1", error: null },
				{ index: 2, status: "failed", id: null, url: null, error: "rate limit" },
				{ index: 3, status: "cancelled", id: null, url: null, error: null },
			],
		}),
	)!;
	assert.deepEqual(r.parts?.map((x) => x.index), [1, 2, 3]);
	const note = "타래 3개 중 1개 게시 · 2번째 글 실패: rate limit · 나머지는 취소됨";
	assert.equal(threadsResultNote(r), note);
	assert.deepEqual(resultPatch(th, r), { published: "2026-11-01", url: "https://t/p1", stage: "발행", error: null, warning: note });
	// 파트 1이 실패면 url 없음 (index 1을 파트 1로 읽음, 파트 2의 url을 가져오지 않음)
	const failedFirst = parseResultJson(JSON.stringify({ id: "C-TH-5", status: "partial", at: "2026-11-01 21:08", parts: [{ index: 1, status: "failed", error: "x" }, { index: 2, status: "published", url: "https://t/p2" }] }))!;
	assert.equal(resultPatch(th, failedFirst)?.url, "");
	assert.match(threadsResultNote(failedFirst), /1번째 글 실패: x/);
	// index가 빠진 항목은 1부터의 위치로
	const noIndex = parseResultJson(JSON.stringify({ id: "C-TH-5", status: "partial", parts: [{ status: "published", url: "https://t/p1" }, { status: "failed", error: "y" }] }))!;
	assert.deepEqual(noIndex.parts?.map((x) => x.index), [1, 2]);
	assert.equal(threadsResultNote(noIndex), "타래 2개 중 1개 게시 · 2번째 글 실패: y");
});

test("스레드 타래: 결과 불명", () => {
	const two: Part[] = [{ text: "a", media: [] }, { text: "b", media: [] }];
	const th = parsePost("x/t.md", fileOf("C-TH-6", two, { stage: "예약", sent: "2026-11-01 20:50", scheduled: "2026-11-01 21:00" }), TH);
	const read = (o: object) => parseResultJson(JSON.stringify({ id: "C-TH-6", at: "2026-11-01 21:05", ...o }))!;
	// url 없음: 실패도 발행도 아님, 단계·sent 유지
	const bare = resultPatch(th, read({ status: "결과 불명" }))!;
	assert.deepEqual(bare, { warning: THREADS_UNKNOWN_NOTE, error: null });
	assert.equal(THREADS_UNKNOWN_NOTE, "결과 불명 · Threads에서 직접 확인해 주세요");
	assert.equal(appliedLabel(bare), "반영");
	// url 있으면 유지, 서버 error·파트 요약은 뒤에 붙음
	const withUrl = read({ status: "결과 불명", url: "https://t/1", error: "timeout", total: 2, published_count: 1, parts: [{ index: 1, status: "published", url: "https://t/1" }, { index: 2, status: "결과 불명" }] });
	const patch = resultPatch(th, withUrl)!;
	assert.deepEqual(patch, { warning: `${THREADS_UNKNOWN_NOTE} · timeout · 타래 2개 중 1개 게시 · 2번째 글 결과 불명`, error: null, url: "https://t/1" });
	// 이미 반영됐으면 다시 쓰지 않음
	const unk = { ...th, warning: patch.warning as string, url: "https://t/1" };
	assert.equal(resultPatch(unk, withUrl), null);
	// 상태 배지: 결과 불명 (실패·발행 아님), 취소 뒤에도 결과 불명
	const st = postState(unk, now + 10 * 60_000);
	assert.equal(st.kind, "unknown");
	assert.equal(st.name, "결과 불명");
	assert.match(st.detail, /^결과 불명 · Threads에서 직접 확인해 주세요/);
	assert.equal(postState({ ...unk, stage: "다듬기", sent: "", cancelled: "2026-11-01 21:10" }).kind, "unknown");
	// 손으로 발행 처리하면 발행됨
	assert.equal(postState({ ...unk, stage: "발행", published: "2026-11-01" }).kind, "published");
	// 빠른 재확인 멈춤, 일반(10분·스로틀) 확인과 수동 읽기에는 남음
	const late = now + 30 * 60_000;
	assert.equal(needsFastPoll(th, late), true);
	assert.equal(needsFastPoll(unk, late), false);
	assert.equal(fastPollEvery([unk], late), null);
	const row = { id: unk.id, channel: "th", stage: unk.stage, sent: unk.sent, published: unk.published, warning: unk.warning };
	assert.equal(resultReadPlan([row]).length, 1);
	assert.equal(resultReadPlan([row], { fast: true }).length, 0);
	assert.equal(resultReadPlan([{ ...row, warning: "" }], { fast: true }).length, 1);
	// 나중에 서버가 published로 고쳐 쓰면 발행으로
	assert.equal(resultPatch(unk, read({ status: "published", url: "https://t/1" }))?.stage, "발행");
	// 영문 unknown도 같음
	assert.equal(resultPatch(th, read({ status: "unknown" }))?.warning, THREADS_UNKNOWN_NOTE);
});

test("스레드 타래: 일부 게시·결과 불명 글은 같은 id로 다시 보내지 않음", () => {
	const two: Part[] = [{ text: "a", media: [] }, { text: "b", media: [] }];
	const th = parsePost("x/t.md", fileOf("C-TH-7", two, { stage: "예약", sent: "2026-11-01 20:50" }), TH);
	const ctx = { now, mediaPrefix: prefix };
	// 보통 글, 0개 게시 실패: 다시 보낼 수 있음
	assert.equal(threadsResendBlock(th), "");
	assert.deepEqual(postProblems(th, ctx), []);
	const failed0 = resultPatch(th, parseResultJson(JSON.stringify({ id: "C-TH-7", status: "failed", error: "token", total: 2, published_count: 0 }))!)!;
	const failedPost = { ...th, error: failed0.error as string };
	assert.equal(threadsResendBlock(failedPost), "");
	// 결과 불명
	const unk = { ...th, warning: THREADS_UNKNOWN_NOTE };
	assert.match(threadsResendBlock(unk), /결과 불명인 글은 다시 보낼 수 없어요/);
	const probs = postProblems(unk, ctx);
	assert.equal(probs.length, 1);
	assert.equal(probs[0].level, "block");
	assert.equal(blocksNow(probs), true);
	// 일부 게시 (partial → 발행 + 경고)
	const partial = resultPatch(th, parseResultJson(JSON.stringify({ id: "C-TH-7", status: "partial", url: "https://t/1", total: 2, published_count: 1, parts: [{ index: 1, status: "published" }, { index: 2, status: "failed", error: "x" }] }))!)!;
	const part = { ...th, stage: "발행" as const, published: partial.published as string, warning: partial.warning as string };
	assert.match(threadsResendBlock(part), /일부가 이미 Threads에 올라가서/);
	assert.ok(postProblems(part, ctx).some((x) => x.level === "block" && /새 글을 만들어/.test(x.text)));
	// failed인데 published_count 없이 parts로만 일부 게시가 보이는 경우도 일부 발행 → 막힘
	const failedUp = resultPatch(th, parseResultJson(JSON.stringify({ id: "C-TH-7", status: "failed", url: "https://t/1", parts: [{ index: 1, status: "published", url: "https://t/1" }, { index: 2, status: "failed", error: "x" }] }))!)!;
	assert.equal(failedUp.stage, "발행");
	assert.notEqual(threadsResendBlock({ ...th, stage: "발행", published: failedUp.published as string, warning: failedUp.warning as string }), "");
	// 다 올라간 글도 막음 (편집기 버튼은 이미 꺼져 있음 → 문구는 문제 목록에 넣지 않음)
	const full = { ...th, stage: "발행" as const, published: "2026-11-01", warning: "" };
	assert.notEqual(threadsResendBlock(full), "");
	assert.deepEqual(postProblems(full, ctx), []);
	// id는 바꾸지 않음 (새 id로 다시 보내면 파트 1이 두 번 올라감)
	assert.equal(buildPayload(unk).id, "C-TH-7");
	// 다른 채널은 영향 없음
	assert.equal(threadsResendBlock({ ...unk, channel: LI }), "");
});
