import { test } from "node:test";
import assert from "node:assert/strict";
import { articlePlace, bookLabel, bookMatches, countInbox, isFresh, parseShelfMap, spineLook, summaryOf } from "../src/shelf/model.ts";

// Shelf bookcase model. Fictional data only (김하루).
const MAP = `# Shelf 지도\n\n## 위키\n\n| 위키 | 범위 한 줄 | 키워드 | 인덱스 |\n|---|---|---|---|\n| 생활 위키 | 일반 지식 | cooking, travel | \`[[07 Shelf/생활 위키/wiki/index]]\` |\n| **Laws** | 법령·판례 | law | x |\n\n## 겹칠 때 정본\n\n| 주제 | 정본 | 이유 |\n|---|---|---|\n| 요리 | 생활 위키 | - |\n\n## 받은 자료\n\n- [[a|김하루 레시피]] — 생활 위키 · 미인제스트\n- [[b|판례 메모]] — Laws · 미인제스트\n- [[c|여행 메모]] — 생활 위키 · 인제스트\n`;

test("map rows come from 「위키」 only, inbox counts 미인제스트 lines per wiki", () => {
	assert.deepEqual(parseShelfMap(MAP).map((r) => r.name), ["생활 위키", "Laws"]);
	assert.equal(parseShelfMap(MAP)[0].scope, "일반 지식");
	assert.equal(countInbox(MAP, "생활 위키"), 1);
	assert.equal(countInbox(MAP, "Laws"), 1);
	assert.equal(parseShelfMap(null).length, 0);
});

test("labels, places, summary, search, freshness, spine geometry", () => {
	assert.equal(bookLabel("ai-economics"), "AI Economics");
	assert.equal(bookLabel("kpop"), "K-pop");
	assert.equal(bookLabel("cooking", "요리"), "요리");
	assert.deepEqual(articlePlace("concepts/cooking/불 조절.md"), { kind: "concepts", slug: "cooking" });
	assert.deepEqual(articlePlace("entitys/law/법원.md"), { kind: "entities", slug: "law" });
	assert.equal(articlePlace("index.md"), null);
	assert.equal(articlePlace("overview/x.md"), null);
	assert.equal(summaryOf("---\na: 1\n---\n\n# cooking MOC\n\n김하루의 [[wiki/x|집밥]] **기록**.\n\n## 소스\n"), "김하루의 집밥 기록.");
	assert.equal(summaryOf("# x", "요약"), "요약");
	const b = { wiki: "생활 위키", slug: "cooking", label: "Cooking", summary: "집밥", path: "", tags: ["요리"], articles: [], updated: "2026-10-25" };
	assert.ok(bookMatches(b, "요리") && bookMatches(b, "COOK 집밥") && !bookMatches(b, "travel"));
	assert.ok(isFresh("2026-10-25", "2026-10-28") && !isFresh("2026-10-01", "2026-10-28") && !isFresh("", "2026-10-28"));
	assert.deepEqual(spineLook("cooking", 9), spineLook("cooking", 9));
	assert.ok(spineLook("a", 0).width >= 24 && spineLook("a", 400).width <= 68);
	assert.ok(spineLook("a", 40).width > spineLook("a", 4).width);
});

test("reader: body without frontmatter and H1, title split, frontmatter lists, reading order", async () => {
	const { readerBody, splitTitle, nameList, readingOrder } = await import("../src/shelf/model.ts");
	assert.deepEqual(readerBody("---\ntype: concept\n---\n\n# 집밥 기록 (Home Cooking)\n\n김하루의 첫 문단.\n"), { title: "집밥 기록 (Home Cooking)", body: "김하루의 첫 문단.\n" });
	assert.deepEqual(readerBody("본문만"), { title: "", body: "본문만" });
	assert.deepEqual(splitTitle("집밥 기록 (Home Cooking)"), { main: "집밥 기록", sub: "Home Cooking" });
	assert.deepEqual(splitTitle("집밥"), { main: "집밥", sub: "" });
	assert.deepEqual(nameList(["[[불 조절|불]]", "raw/a.md"]), ["불 조절", "raw/a.md"]);
	assert.deepEqual(nameList("한 개"), ["한 개"]);
	assert.deepEqual(nameList(undefined), []);
	const a = (title: string, kind: "concepts" | "sources", updated: string) => ({ title, path: title, kind, updated });
	const book = { wiki: "w", slug: "s", label: "S", summary: "", path: "m", tags: [], updated: "", articles: [a("자료1", "sources", "2026-10-02"), a("개념1", "concepts", "2026-10-01"), a("개념2", "concepts", "2026-10-03")] };
	assert.deepEqual(readingOrder(book).map((x) => x.title), ["개념2", "개념1", "자료1"]);
});

test("날짜별 학습자료 모음: backticks, wiki links, bare folders; trailing slash; description after —", async () => {
	const { parseDatedCollections } = await import("../src/shelf/model.ts");
	const text = `# Shelf 지도\n\n## 위키\n\n| 위키 | 범위 |\n|---|---|\n| 생활 위키 | 일반 |\n\n## 날짜별 학습자료 모음\n\n- \`하루 신문 A1/\` — 김하루의 아침 신문 1면 공부\n- [[07 Shelf/영어 일기/Index|영어 일기]] — 매일 영어 한 쪽\n- 그림 연습/ — 하루 한 장\n- \`하루 신문 A1\` — 중복\n- 그냥 문장 — 폴더 아님\n\n## 받은 자료\n\n- \`밖/\` — 다른 절\n`;
	assert.deepEqual(parseDatedCollections(text), [
		{ name: "하루 신문 A1", description: "김하루의 아침 신문 1면 공부" },
		{ name: "영어 일기", description: "매일 영어 한 쪽" },
		{ name: "그림 연습", description: "하루 한 장" },
	]);
	assert.deepEqual(parseDatedCollections("## 날짜별 학습자료 모음\n\n| 폴더 | 설명 |\n|---|---|\n| `메모장/` | 표 설명 |\n"), [{ name: "메모장", description: "표 설명" }]);
	assert.deepEqual(parseDatedCollections(MAP), []);
	assert.deepEqual(parseDatedCollections(null), []);
});

test("날짜별 모음 → 칸: Index is the book, year-folder daily notes are 자료, newest first", async () => {
	const { buildCollection, isDailyNote } = await import("../src/shelf/model.ts");
	const base = "07 Shelf/하루 신문 A1/";
	const f = (rel: string, fm: Record<string, unknown> = {}) => ({ path: base + rel, basename: rel.split("/").pop()!.replace(/\.md$/, ""), fm });
	const files = [
		f("AGENTS.md"),
		f("하루 신문 A1 Index.md", { tags: ["뉴스"], type: "index" }),
		f("메모.md"),
		f("2026/2026-11-07 금리 동결.md", { type: "news-tutoring", date: "2026-11-07" }),
		f("2026/2026-11-08 환율.md", { title: "환율 1,400원" }),
		f("2026/정리.md"),
		f("2026/sub/2026-11-09 깊은 곳.md"),
		{ path: "07 Shelf/딴 모음/2026/2026-11-09 x.md", basename: "2026-11-09 x", fm: {} },
	];
	assert.ok(isDailyNote("2025/2025-12-31 송년.md") && !isDailyNote("2025-12-31.md") && !isDailyNote("2025/sub/2025-12-31.md") && !isDailyNote("26/2025-12-31.md"));
	const w = buildCollection({ name: "하루 신문 A1", description: "아침 1면" }, base, files);
	assert.equal(w.name, "하루 신문 A1");
	assert.equal(w.scope, "아침 1면");
	assert.equal(w.inbox, 0);
	assert.equal(w.books.length, 1);
	const b = w.books[0];
	assert.equal(b.path, base + "하루 신문 A1 Index.md");
	assert.equal(b.wiki, "하루 신문 A1");
	assert.equal(b.summary, "아침 1면");
	assert.deepEqual(b.tags, ["뉴스"]);
	assert.equal(b.updated, "2026-11-08");
	assert.deepEqual(b.articles.map((a) => [a.title, a.kind, a.updated]), [
		["환율 1,400원", "sources", "2026-11-08"],
		["2026-11-07 금리 동결", "sources", "2026-11-07"],
	]);
});

test("날짜별 모음 → 책 without Index: a `type: index` root note, else the newest daily; empty folder has no book", async () => {
	const { buildCollection } = await import("../src/shelf/model.ts");
	const base = "07 Shelf/영어 일기/";
	const row = { name: "영어 일기", description: "" };
	const d1 = { path: base + "2026/2026-11-01.md", basename: "2026-11-01", fm: {} };
	const d2 = { path: base + "2026/2026-11-03.md", basename: "2026-11-03", fm: {} };
	const home = { path: base + "목차.md", basename: "목차", fm: { type: "index" } };
	assert.equal(buildCollection(row, base, [d1, d2, home]).books[0].path, home.path);
	const fallback = buildCollection(row, base, [d1, d2]).books[0];
	assert.equal(fallback.path, d2.path);
	assert.equal(fallback.articles.length, 2);
	assert.deepEqual(buildCollection(row, base, [{ path: base + "AGENTS.md", basename: "AGENTS", fm: {} }]).books, []);
	const named = { path: base + "영어 일기 Index.md", basename: "영어 일기 Index", fm: {} };
	assert.equal(buildCollection(row, base, [d1, named]).books[0].path, named.path);
});
