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
