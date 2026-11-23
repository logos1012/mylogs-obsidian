import { test } from "node:test";
import assert from "node:assert/strict";
import { readMilestones, changeMilestones, milestoneSummary, milestoneSplit, milestoneKind, formatMetricValue, metricMeasure, parseMetricNumber } from "../src/projects/milestones.ts";

const hub = [
	"---", "type: project", "id: P-shop", "---", "# 온라인 판매", "", "## 마일스톤",
	"<!-- 사용자가 정한 중요한 도달 상태 -->",
	"- [ ] 자사몰 오픈 완료: 아임웹 결제 테스트 통과 (due:: 2026-11-25) (ms:: M-3f9a1c20) (aim:: M-b71e04d2)",
	"    - 메모: 결제 대행 심사 중",
	"- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과) (ms:: M-b71e04d2) (current:: 0) (target:: 1) (unit:: 건) (period:: 누적) (as_of:: 2026-11-23)",
	"",
	"- [x] 최근 30일 순이익 100만 원 (due:: 2026-12-11) (kind:: 결과) (current:: 1,200,000) (target:: 1000000) (unit:: 원) (period:: 최근 30일)",
	"- [ ] 테스트 제품 3개 확정 (kind:: 기타)",
	"", "## 할 일", "- [ ] 자사몰 세팅", "",
].join("\n");

const items = () => readMilestones(hub).items;
const lineOf = (text: string, part: string) => readMilestones(text).items.find(i => i.text.includes(part))!;
/** Lines of the file other than the one that should change. */
const others = (a: string, b: string) => { const x = a.split("\n"), y = b.split("\n"); return x.filter((l, i) => l !== y[i]).length; };

test("kind: (kind:: 성과) and the older 결과 are 성과 지표; anything else is 마일스톤", () => {
	assert.deepEqual(items().map(milestoneKind), ["milestone", "metric", "metric", "milestone"]);
	assert.equal(milestoneKind(readMilestones("## 마일스톤\n- [ ] 그냥 줄\n").items[0]), "milestone");
	assert.equal(readMilestones("## 마일스톤\n- [ ] 그냥 줄\n").items[0].kind, undefined);
});

test("metric fields: commas, negatives, decimals; a bad number is an issue, not a crash", () => {
	const [, order, profit] = items();
	assert.deepEqual([order.current, order.target, order.unit, order.period, order.asOf, order.ms], [0, 1, "건", "누적", "2026-11-23", "M-b71e04d2"]);
	assert.equal(profit.current, 1200000); assert.equal(profit.target, 1000000);
	assert.equal(items()[0].aim, "M-b71e04d2"); assert.equal(items()[0].ms, "M-3f9a1c20");
	assert.equal(parseMetricNumber("-3.5"), -3.5); assert.equal(parseMetricNumber("1,000,000.25"), 1000000.25);
	for (const bad of ["", "abc", "1,00", "1.2.3", "10%"]) assert.equal(parseMetricNumber(bad), undefined, bad);
	const odd = readMilestones("## 마일스톤\n- [ ] 첫 주문 (kind:: 성과) (current:: 많음) (target:: 1) (as_of:: 어제)\n").items[0];
	assert.equal(odd.current, undefined); assert.equal(odd.target, 1); assert.equal(odd.asOf, undefined);
	assert.match(odd.fieldIssue!, /현재 값을 숫자로/); assert.match(odd.fieldIssue!, /YYYY-MM-DD/);
	assert.equal(odd.text, "첫 주문");
});

test("title: every inline field is left out of the text shown", () => {
	assert.deepEqual(items().map(i => i.text), ["자사몰 오픈 완료: 아임웹 결제 테스트 통과", "첫 주문", "최근 30일 순이익 100만 원", "테스트 제품 3개 확정"]);
	assert.equal(items()[0].due, "2026-11-25");
	assert.equal(readMilestones("## 마일스톤\n- [ ] 앞 (start:: 3) 뒤\n").items[0].text, "앞 뒤");
});

test("edit keeps every field of the line exactly; only the date changes when given", () => {
	const m = readMilestones(hub), order = lineOf(hub, "첫 주문");
	const next = changeMilestones(hub, m.source, { kind: "edit", line: order.line, text: "첫 주문 받기" });
	assert.ok(next.includes("- [ ] 첫 주문 받기 (due:: 2026-11-30) (kind:: 성과) (ms:: M-b71e04d2) (current:: 0) (target:: 1) (unit:: 건) (period:: 누적) (as_of:: 2026-11-23)\n"));
	assert.equal(others(hub, next), 1);
	const dated = changeMilestones(hub, m.source, { kind: "edit", line: order.line, text: "첫 주문", due: "2026-12-01" });
	assert.ok(dated.includes("- [ ] 첫 주문 (due:: 2026-12-01) (kind:: 성과) (ms:: M-b71e04d2) (current:: 0)"));
	const undated = changeMilestones(hub, m.source, { kind: "edit", line: order.line, text: "첫 주문", due: "" });
	assert.ok(undated.includes("- [ ] 첫 주문 (kind:: 성과) (ms:: M-b71e04d2)"));
	const first = lineOf(hub, "자사몰");
	assert.ok(changeMilestones(hub, m.source, { kind: "edit", line: first.line, text: "자사몰 오픈" }).includes("- [ ] 자사몰 오픈 (due:: 2026-11-25) (ms:: M-3f9a1c20) (aim:: M-b71e04d2)\n    - 메모"));
	// A field written without the plugin's spacing stays as written.
	const raw = "## 마일스톤\n- [ ] 검수 (ms::M-1) (due:: 2026-11-05)\n";
	assert.equal(changeMilestones(raw, readMilestones(raw).source, { kind: "edit", line: 1, text: "검수 통과" }), "## 마일스톤\n- [ ] 검수 통과 (ms::M-1) (due:: 2026-11-05)\n");
});

test("setKind adds or removes only (kind:: 성과) on that line; value fields stay", () => {
	const m = readMilestones(hub), first = lineOf(hub, "자사몰"), order = lineOf(hub, "첫 주문"), other = lineOf(hub, "테스트 제품");
	const metric = changeMilestones(hub, m.source, { kind: "setKind", line: first.line, to: "metric" });
	assert.ok(metric.includes("- [ ] 자사몰 오픈 완료: 아임웹 결제 테스트 통과 (due:: 2026-11-25) (kind:: 성과) (ms:: M-3f9a1c20) (aim:: M-b71e04d2)\n"));
	assert.equal(others(hub, metric), 1);
	const back = changeMilestones(hub, m.source, { kind: "setKind", line: order.line, to: "milestone" });
	assert.ok(back.includes("- [ ] 첫 주문 (due:: 2026-11-30) (ms:: M-b71e04d2) (current:: 0) (target:: 1) (unit:: 건) (period:: 누적) (as_of:: 2026-11-23)\n"));
	assert.equal(others(hub, back), 1);
	assert.equal(changeMilestones(hub, m.source, { kind: "setKind", line: order.line, to: "metric" }), hub);
	// `(kind:: 기타)` is a 마일스톤; turning it into a 성과 지표 rewrites that one field.
	assert.ok(changeMilestones(hub, m.source, { kind: "setKind", line: other.line, to: "metric" }).includes("- [ ] 테스트 제품 3개 확정 (kind:: 성과)\n"));
	const plain = "## 마일스톤\n- [ ] 첫 주문\n";
	assert.equal(changeMilestones(plain, plain, { kind: "setKind", line: 1, to: "metric" }), "## 마일스톤\n- [ ] 첫 주문 (kind:: 성과)\n");
	assert.equal(changeMilestones("## 마일스톤\n- [ ] 첫 주문 (kind:: 성과)\n", "## 마일스톤\n- [ ] 첫 주문 (kind:: 성과)\n", { kind: "setKind", line: 1, to: "milestone" }), plain);
});

test("move: the item and its indented lines go; comments, blank lines and the rest stay", () => {
	const m = readMilestones(hub), first = lineOf(hub, "자사몰"), profit = lineOf(hub, "순이익"), other = lineOf(hub, "테스트 제품");
	const down = changeMilestones(hub, m.source, { kind: "move", line: first.line, target: profit.line, place: "after" });
	assert.equal(down.split("\n").slice(7, 14).join("\n"), [
		"<!-- 사용자가 정한 중요한 도달 상태 -->",
		"- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과) (ms:: M-b71e04d2) (current:: 0) (target:: 1) (unit:: 건) (period:: 누적) (as_of:: 2026-11-23)",
		"",
		"- [x] 최근 30일 순이익 100만 원 (due:: 2026-12-11) (kind:: 결과) (current:: 1,200,000) (target:: 1000000) (unit:: 원) (period:: 최근 30일)",
		"- [ ] 자사몰 오픈 완료: 아임웹 결제 테스트 통과 (due:: 2026-11-25) (ms:: M-3f9a1c20) (aim:: M-b71e04d2)",
		"    - 메모: 결제 대행 심사 중",
		"- [ ] 테스트 제품 3개 확정 (kind:: 기타)",
	].join("\n"));
	assert.equal(down.length, hub.length);
	assert.ok(down.endsWith("\n## 할 일\n- [ ] 자사몰 세팅\n"));
	const up = changeMilestones(hub, m.source, { kind: "move", line: other.line, target: first.line, place: "before" });
	assert.deepEqual(readMilestones(up).items.map(i => i.text.slice(0, 4)), ["테스트 ", "자사몰 ", "첫 주문", "최근 3"]);
	assert.ok(up.includes("<!-- 사용자가 정한 중요한 도달 상태 -->\n- [ ] 테스트 제품"));
	// Already there: nothing changes.
	assert.equal(changeMilestones(hub, m.source, { kind: "move", line: first.line, target: lineOf(hub, "첫 주문").line, place: "before" }), hub);
	assert.equal(changeMilestones(hub, m.source, { kind: "move", line: first.line, target: first.line, place: "after" }), hub);
	// Changed elsewhere since it was shown: cancelled.
	assert.throws(() => changeMilestones(hub, m.source.replace("첫 주문", "첫 판매"), { kind: "move", line: first.line, target: profit.line, place: "after" }), /다른 곳/);
	assert.throws(() => changeMilestones(hub, m.source, { kind: "move", line: first.line, target: 999, place: "after" }), /찾지 못/);
	// A section at the end of a file without a final newline keeps it that way.
	const tail = "## 마일스톤\n- [ ] 가\n- [ ] 나";
	assert.equal(changeMilestones(tail, tail, { kind: "move", line: 2, target: 1, place: "before" }), "## 마일스톤\n- [ ] 나\n- [ ] 가");
	assert.equal(changeMilestones(tail, tail, { kind: "move", line: 1, target: 2, place: "after" }), "## 마일스톤\n- [ ] 나\n- [ ] 가");
	const crlf = hub.replaceAll("\n", "\r\n"), mc = readMilestones(crlf);
	assert.equal(changeMilestones(crlf, mc.source, { kind: "move", line: first.line, target: profit.line, place: "after" }), down.replaceAll("\n", "\r\n"));
});

test("setMetric writes current and as_of on that line only; target · unit · period separately", () => {
	const m = readMilestones(hub), order = lineOf(hub, "첫 주문"), profit = lineOf(hub, "순이익");
	const next = changeMilestones(hub, m.source, { kind: "setMetric", line: order.line, current: "3", asOf: "2026-11-24" });
	assert.ok(next.includes("- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과) (ms:: M-b71e04d2) (current:: 3) (target:: 1) (unit:: 건) (period:: 누적) (as_of:: 2026-11-24)\n"));
	assert.equal(others(hub, next), 1);
	const fresh = changeMilestones(hub, m.source, { kind: "setMetric", line: profit.line, current: "1,500,000", asOf: "2026-11-24" });
	assert.ok(fresh.includes("(current:: 1500000) (target:: 1000000) (unit:: 원) (period:: 최근 30일) (as_of:: 2026-11-24)\n"));
	const bare = "## 마일스톤\n- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과)\n";
	assert.equal(changeMilestones(bare, bare, { kind: "setMetric", line: 1, current: "0", asOf: "2026-11-23" }), "## 마일스톤\n- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과) (current:: 0) (as_of:: 2026-11-23)\n");
	assert.equal(changeMilestones(bare, bare, { kind: "setMetric", line: 1, target: "1,000,000", unit: "원", period: "최근 30일" }), "## 마일스톤\n- [ ] 첫 주문 (due:: 2026-11-30) (kind:: 성과) (target:: 1000000) (unit:: 원) (period:: 최근 30일)\n");
	assert.ok(changeMilestones(hub, m.source, { kind: "setMetric", line: order.line, unit: "", period: "" }).includes("(target:: 1) (as_of:: 2026-11-23)\n"));
	assert.throws(() => changeMilestones(hub, m.source, { kind: "setMetric", line: order.line, current: "많이", asOf: "2026-11-24" }), /숫자/);
	assert.throws(() => changeMilestones(hub, m.source, { kind: "setMetric", line: order.line, current: "1" }), /확인한 날/);
	assert.throws(() => changeMilestones(hub, m.source, { kind: "setMetric", line: order.line, unit: "원(세후)" }), /괄호/);
	assert.throws(() => changeMilestones(hub, m.source, { kind: "setMetric", line: lineOf(hub, "자사몰").line, current: "1", asOf: "2026-11-24" }), /성과 지표에서만/);
	assert.throws(() => changeMilestones(hub, "stale", { kind: "setMetric", line: order.line, current: "1", asOf: "2026-11-24" }), /다른 곳/);
});

test("원 reads in 만 / 억; other units follow the number", () => {
	assert.equal(formatMetricValue(1000000, "원"), "100만 원");
	assert.equal(formatMetricValue(15000000, "원"), "1,500만 원");
	assert.equal(formatMetricValue(120000000, "원"), "1억 2,000만 원");
	assert.equal(formatMetricValue(100000000, "원"), "1억 원");
	assert.equal(formatMetricValue(0, "원"), "0원");
	assert.equal(formatMetricValue(5000, "원"), "5,000원");
	assert.equal(formatMetricValue(12345, "원"), "1만 2,345원");
	assert.equal(formatMetricValue(-2000000, "원"), "-200만 원");
	assert.equal(formatMetricValue(3, "건"), "3건");
	assert.equal(formatMetricValue(1234.5, "개"), "1,234.5개");
	assert.equal(formatMetricValue(7), "7");
});

test("measure line, missing target, and reached (never checked by itself)", () => {
	const m = readMilestones("## 마일스톤\n- [ ] 순이익 (kind:: 성과) (current:: 0) (target:: 1000000) (unit:: 원) (period:: 최근 30일) (as_of:: 2026-11-23)\n- [ ] 첫 주문 (kind:: 성과) (current:: 2)\n- [ ] 첫 광고 (kind:: 성과) (current:: 2) (target:: 1) (unit:: 건)\n").items;
	assert.deepEqual(metricMeasure(m[0]), { text: "최근 30일 · 0원 / 100만 원 · 11/23 기준", ratio: 0, reached: false, missingTarget: false });
	assert.deepEqual(metricMeasure(m[1]), { text: "목표 값을 적어 주세요", reached: false, missingTarget: true });
	assert.equal(metricMeasure(m[2]).reached, true); assert.equal(metricMeasure(m[2]).ratio, 1); assert.equal(m[2].done, false);
});

test("counts: summary stays every top-level item; header splits by kind", () => {
	assert.deepEqual(milestoneSummary(items()), { done: 1, total: 4, label: "1/4 달성" });
	assert.equal(milestoneSplit(items()).label, "마일스톤 0/2 · 성과 지표 1/2");
	const plain = readMilestones("## 마일스톤\n- [x] 가\n- [ ] 나\n").items;
	assert.equal(milestoneSplit(plain).label, "1/2 달성");
	assert.equal(milestoneSplit([]).label, "미설정");
});
