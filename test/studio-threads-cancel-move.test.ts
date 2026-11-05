import { test } from "node:test";
import assert from "node:assert/strict";
import {
	appliedLabel,
	canMoveToNewPost,
	cancelMayBeLate,
	cancelPatch,
	channelByKey,
	isCancelPending,
	isPartialNote,
	movePlan,
	needsFastPoll,
	parsePost,
	parseResultJson,
	postProblems,
	postSkeleton,
	postState,
	readFm,
	resultPatch,
	resultReadPlan,
	seededPostText,
	setFm,
	setPostBody,
	threadsCarryOver,
	threadsResendBlock,
	THREADS_UNKNOWN_NOTE,
	type Post,
	type ResultRow,
} from "../src/studio/model.ts";

const TH = channelByKey("th");
const LI = channelByKey("li");
const prefix = "https://example-bucket.s3.ap-northeast-2.amazonaws.com/artifacts/studio/";
const ID = "C-20261101-09";
const SCHED = "2026-11-01 21:00";
const now = Date.parse("2026-11-01T12:05:00.000Z"); // 21:05 KST, 5 minutes after the time

type Part = { text: string; media: string[] };
const PARTS: Part[] = [
	{ text: "첫 글", media: [`${prefix}2026/11/a.jpg`] },
	{ text: "둘째", media: [] },
	{ text: "셋째", media: [`${prefix}2026/11/b.png`] },
];

const postOf = (fm: Record<string, string | string[]> = {}, parts: Part[] = PARTS, ch = TH): Post =>
	parsePost(
		"스튜디오/02 게시물/스레드/2026-11-01 타래 글.md",
		setFm(setPostBody(postSkeleton(ch, ID, ["[[글감 2026-11#^g1]]"]), ch, ch.key === "th" ? { parts } : { text: parts[0].text }), {
			stage: "예약",
			scheduled: SCHED,
			sent: "2026-11-01 20:30",
			topic: "기록",
			alt: ["첫 사진"],
			...fm,
		}),
		ch,
	);

/** Apply a frontmatter patch the way `patchPost` does, then read the post back. */
const applied = (p: Post, patch: Record<string, string | string[] | null>): Post => {
	const raw = setPostBody(postSkeleton(p.channel, p.id, p.from), p.channel, { parts: p.parts });
	const base = setFm(raw, { stage: p.stage, scheduled: p.scheduled, sent: p.sent, cancelled: p.cancelled, warning: p.warning, error: p.error, published: p.published, url: p.url, topic: p.topic, alt: p.alt });
	return parsePost(p.path, setFm(base, patch), p.channel);
};

const result = (o: Record<string, unknown>): ResultRow => {
	const r = parseResultJson(JSON.stringify({ id: ID, at: "2026-11-01 21:04", ...o }));
	assert.ok(r);
	return r;
};

const cancelledLate = () => applied(postOf(), cancelPatch(postOf(), "2026-11-01 21:05", now));

test("예약 취소: 시각 전이면 예전과 같음 (sent 지움), 시각이 지났으면 sent·id 유지", () => {
	const before = Date.parse("2026-11-01T11:50:00.000Z"); // 20:50 KST
	assert.equal(cancelMayBeLate(postOf(), before), false);
	assert.deepEqual(cancelPatch(postOf(), "2026-11-01 20:50", before), { stage: "다듬기", sent: null, error: null, cancelled: "2026-11-01 20:50", now: null });
	// 1분 안쪽은 늦을 수 있다고 봄
	assert.equal(cancelMayBeLate(postOf(), Date.parse("2026-11-01T11:59:30.000Z")), true);
	// 시각이 지남: sent 키 자체를 건드리지 않음
	const late = cancelPatch(postOf(), "2026-11-01 21:05", now);
	assert.deepEqual(late, { stage: "다듬기", error: null, cancelled: "2026-11-01 21:05", now: null });
	const p = cancelledLate();
	assert.equal(p.sent, "2026-11-01 20:30");
	assert.equal(p.id, ID);
	assert.equal(p.stage, "다듬기");
	assert.equal(isCancelPending(p), true);
	// 시각을 읽을 수 없으면 안전한 쪽(늦음)
	assert.equal(cancelMayBeLate(postOf({ scheduled: "" }), now), true);
	// 다른 채널, 안 보낸 글: 예전과 같음
	assert.equal(cancelMayBeLate(postOf({}, PARTS, LI), now), false);
	assert.equal(cancelMayBeLate(postOf({ sent: "" }), now), false);
});

test("늦은 취소: 결과를 계속 읽고, 결과 대기로 보이고, 같은 id로 다시 보내지 않음", () => {
	const p = cancelledLate();
	const row = { id: p.id, channel: "th", stage: p.stage, sent: p.sent, published: p.published, warning: p.warning, cancelled: p.cancelled };
	assert.deepEqual(resultReadPlan([row]).map((x) => x.key), ["studio/results/threads/C-20261101-09.json"]);
	assert.equal(resultReadPlan([row], { fast: true }).length, 1);
	// 예전 취소(sent 없음)는 읽지 않음
	assert.equal(resultReadPlan([{ ...row, sent: "" }]).length, 0);
	const s = postState(p, now);
	assert.equal(s.kind, "cancelled");
	assert.equal(s.name, "취소 · 결과 확인 중");
	assert.match(threadsResendBlock(p), /결과가 올 때까지 같은 글은 다시 보낼 수 없어요/);
	assert.ok(postProblems(p, { now, mediaPrefix: prefix }).some((x) => x.level === "block" && /새 글로 옮기기/.test(x.text)));
	assert.equal(canMoveToNewPost(p), true);
	// 90초 확인은 켜지 않음 (10분 · 수동 읽기로 확인)
	assert.equal(needsFastPoll(p, now), false);
});

test("늦은 취소 뒤 결과: 일부 게시면 요약과 함께 일부 발행, 아무것도 없으면 조용히 정리", () => {
	const p = cancelledLate();
	// 취소 + published_count만 (total·parts 없음): 그래도 일부 발행
	const onlyCount = resultPatch(p, result({ status: "취소", published_count: 2, url: "https://www.threads.net/@me/post/1" }));
	assert.ok(onlyCount);
	assert.equal(onlyCount.stage, "발행");
	assert.equal(onlyCount.url, "https://www.threads.net/@me/post/1");
	assert.match(String(onlyCount.warning), /^타래 일부 게시\(2개\) · 나머지는 취소됨$/);
	assert.ok(isPartialNote(String(onlyCount.warning)));
	assert.match(appliedLabel(onlyCount), /^일부 발행 반영/);
	const up = applied(p, onlyCount);
	assert.equal(postState(up, now).name, "일부 발행");
	assert.equal(canMoveToNewPost(up), true);
	assert.match(threadsResendBlock(up), /일부가 이미 Threads에 올라가서/);
	// total + parts: 「3개 중 1개 게시」 요약
	const full = resultPatch(
		p,
		result({
			status: "취소",
			total: 3,
			published_count: 1,
			parts: [
				{ index: 1, status: "published", url: "https://www.threads.net/@me/post/1" },
				{ index: 2, status: "cancelled" },
				{ index: 3, status: "cancelled" },
			],
		}),
	);
	assert.ok(full);
	assert.equal(full.stage, "발행");
	assert.equal(full.warning, "타래 3개 중 1개 게시 · 나머지는 취소됨");
	// partial 상태에 숫자가 없어도 발행됨으로 숨기지 않음
	const bare = resultPatch(p, result({ status: "partial", url: "https://www.threads.net/@me/post/1" }));
	assert.ok(bare && isPartialNote(String(bare.warning)));
	// 아무것도 안 올라감 (취소): sent만 지우고 stage는 사람이 고른 대로
	const none = resultPatch(p, result({ status: "취소", published_count: 0 }));
	assert.deepEqual(none, { sent: null, error: null, now: null });
	assert.equal(appliedLabel(none), "취소 확인 (올라간 글 없음)");
	const settled = applied(p, none);
	assert.equal(isCancelPending(settled), false);
	assert.equal(postState(settled, now).name, "취소됨");
	assert.equal(threadsResendBlock(settled), "");
	assert.equal(canMoveToNewPost(settled), false);
	assert.equal(resultReadPlan([{ id: ID, channel: "th", stage: settled.stage, sent: settled.sent, published: "", cancelled: settled.cancelled }]).length, 0);
	// 실패 · 0개: 이유는 남기고 정리
	assert.deepEqual(resultPatch(p, result({ status: "failed", error: "토큰 만료" })), { sent: null, error: "토큰 만료" });
	// 결과 불명: 결과 불명으로 남고 계속 막힘
	const unk = resultPatch(p, result({ status: "결과 불명" }));
	assert.ok(unk && String(unk.warning).startsWith(THREADS_UNKNOWN_NOTE));
	const unkPost = applied(p, unk);
	assert.equal(postState(unkPost, now).kind, "unknown");
	assert.notEqual(threadsResendBlock(unkPost), "");
	// 보낸 시각보다 오래된 결과는 무시
	assert.equal(resultPatch(p, result({ status: "취소", published_count: 2, at: "2026-11-01 20:00" })), null);
});

test("새 글로 옮기기: 글별 상태를 모두 알면 안 올라간 글만", () => {
	const p = applied(postOf(), { stage: "발행", published: "2026-11-01", warning: "타래 3개 중 1개 게시 · 2번째 글 실패: 시간 초과 · 나머지는 취소됨" });
	assert.equal(canMoveToNewPost(p), true);
	const r = result({
		status: "partial",
		total: 3,
		published_count: 1,
		parts: [
			{ index: 1, status: "published", url: "u1" },
			{ index: 2, status: "failed", error: "시간 초과" },
			{ index: 3, status: "skipped" },
		],
	});
	const plan = movePlan(p, r);
	assert.ok(plan);
	assert.equal(plan.carry.mode, "remaining");
	assert.deepEqual(plan.carry.from, [2, 3]);
	assert.deepEqual(plan.seed.parts, [PARTS[1], PARTS[2]]);
	assert.match(plan.carry.note, /2, 3번째 글\(2개\)만 옮겼어요/);
	assert.equal(plan.title, "타래 글 이어서");
	// 1번 글이 빠지면 alt(1번 글 미디어용)는 안 옮김, 주제는 옮김
	assert.deepEqual(plan.seed.fm, { topic: "기록" });
	assert.deepEqual(plan.seed.from, ["[[글감 2026-11#^g1]]", "[[스튜디오/02 게시물/스레드/2026-11-01 타래 글|타래 글 (원본)]]"]);

	// 새 파일 내용: 새 id, 파트 순서, 원본 링크, 단계 초안
	const text = seededPostText(TH, "C-20261106-01", plan.seed);
	const made = parsePost("스튜디오/02 게시물/스레드/2026-11-06 타래 글 이어서.md", text, TH);
	assert.equal(made.id, "C-20261106-01");
	assert.equal(made.stage, "초안");
	assert.equal(made.sent, "");
	assert.equal(made.topic, "기록");
	assert.deepEqual(made.parts, [PARTS[1], PARTS[2]]);
	assert.deepEqual(made.from, plan.seed.from);
	assert.deepEqual(readFm(text).alt, undefined);
	assert.equal(canMoveToNewPost(made), false);

	// 0-based 결과 파일도 같은 뜻
	const zero = movePlan(p, result({ status: "partial", parts: [{ index: 0, status: "published" }, { index: 1, status: "published" }, { index: 2, status: "cancelled" }] }));
	assert.deepEqual(zero?.carry.from, [3]);
	// 모두 올라감 → 옮길 것 없음
	assert.equal(movePlan(p, result({ status: "published", parts: [1, 2, 3].map((index) => ({ index, status: "published" })) })), null);
	// 1번 글부터 안 올라갔으면 alt도 옮김
	const first = movePlan(p, result({ status: "failed", parts: [1, 2, 3].map((index) => ({ index, status: "failed" })) }));
	assert.deepEqual(first?.seed.fm, { topic: "기록", alt: ["첫 사진"] });
});

test("새 글로 옮기기: 결과 불명 · 글별 상태 모름이면 전체 복사하고 알림", () => {
	const p = applied(postOf(), { warning: `${THREADS_UNKNOWN_NOTE} · 응답 없음` });
	assert.equal(canMoveToNewPost(p), true);
	const cases: [ResultRow | null, RegExp][] = [
		[null, /결과 파일을 읽지 못했어요/],
		[result({ status: "결과 불명", parts: [{ index: 1, status: "published" }] }), /결과 불명이에요/],
		[result({ status: "partial", published_count: 1 }), /글별 상태가 없어요/],
		[result({ status: "partial", total: 4, parts: [{ index: 1, status: "published" }] }), /글 수\(4\)와 지금 글 수\(3\)가 달라요/],
		[result({ status: "partial", parts: [{ index: 1, status: "published" }, { index: 2, status: "failed" }] }), /3번째 글의 결과가 없어요/],
		[result({ status: "partial", parts: [{ index: 1, status: "published" }, { index: 2, status: "결과 불명" }, { index: 3, status: "cancelled" }] }), /2번째 글의 결과가 「결과 불명」/],
		[result({ id: "C-other", status: "partial" }), /결과 파일을 읽지 못했어요/],
		[result({ status: "partial", at: "2026-11-01 19:00", parts: [1, 2, 3].map((index) => ({ index, status: index === 1 ? "published" : "failed" })) }), /결과 파일을 읽지 못했어요/],
	];
	for (const [r, why] of cases) {
		const plan = movePlan(p, r);
		assert.ok(plan);
		assert.equal(plan.carry.mode, "all");
		assert.deepEqual(plan.seed.parts, PARTS);
		assert.match(plan.carry.note, why);
		assert.match(plan.carry.note, /타래 전체\(3개\)를 복사했어요/);
		assert.deepEqual(plan.seed.fm, { topic: "기록", alt: ["첫 사진"] });
	}
	// threadsCarryOver는 원본 배열을 공유하지 않음
	const c = threadsCarryOver(p, null);
	c.parts[0].media.push("x");
	assert.equal(p.parts[0].media.length, 1);
});

test("새 글로 옮기기 버튼: 막힌 스레드 글에만", () => {
	assert.equal(canMoveToNewPost(postOf()), false); // 예약됨 (보통)
	assert.equal(canMoveToNewPost(applied(postOf(), { stage: "발행", published: "2026-11-01", url: "u" })), false); // 전부 발행
	assert.equal(canMoveToNewPost(applied(postOf(), cancelPatch(postOf(), "2026-11-01 20:50", Date.parse("2026-11-01T11:50:00.000Z")))), false); // 시각 전 취소
	assert.equal(canMoveToNewPost({ ...postOf(), channel: LI, warning: "타래 3개 중 1개 게시" }), false);
});
