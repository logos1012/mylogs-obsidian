import { nameProblem } from "../projects/model.ts";
import { getFmValue, setFmValue } from "../projects/ops.ts";
import { getSectionContent, replaceSectionContent } from "../writer.ts";
import { applyGoalChange, editGoalNote, sectionAsLines, toBullets, type GoalChange } from "./goal-edit.ts";
import { type Goal, isIsoDate, toNum, parseFrontmatterText, parseGoal } from "./model.ts";

export const INLINE_LABELS = {
	title: "제목", area: "영역", period: "기간", why: "왜 이 목표인가", vision: "달성한 모습",
	criteria: "달성 기준", memo: "메모", retro: "종료 회고", baseline: "시작 값", current: "현재 값",
	target: "목표 값 / 달성 조건", unit: "단위", due: "기한", weight: "가중치", measure: "측정 방식", kind: "종류",
} as const;
export type InlineGoalField = keyof typeof INLINE_LABELS;
const SECTIONS: Partial<Record<InlineGoalField, string>> = { why: "왜 이 목표인가", vision: "달성한 모습", criteria: "달성 기준", memo: "메모", retro: "종료 회고" };
function section(text: string, field: InlineGoalField): string | undefined {
	const name = SECTIONS[field];
	return field === "why" && getSectionContent(text, name!) === null && getSectionContent(text, "왜") !== null ? "왜" : name;
}
export function inlineValue(text: string, field: InlineGoalField): string {
	const name = section(text, field); return name ? sectionAsLines(text, name) : getFmValue(text, field);
}
/** Preserve comments and formatting when checking conflicts, even if hidden in the display. */
export function inlineToken(text: string, field: InlineGoalField): string {
	const name = section(text, field); return name ? getSectionContent(text, name) ?? "" : getFmValue(text, field);
}
export function editInlineGoal(text: string, path: string, field: InlineGoalField, expected: string, value: string, today: string): { text: string; goal: Goal } {
	const before = parseGoal(parseFrontmatterText(text).data, path);
	if (!before) throw new Error("목표 노트를 다시 열어 주세요.");
	if (inlineToken(text, field) !== expected) throw new Error("이 항목이 다른 곳에서 바뀌었어요. 입력은 남겨뒀습니다. 취소 후 최신 값을 확인해 주세요.");
	const main = before.type === "main-goal", name = section(text, field), v = value.trim();
	if (main && ["baseline", "current", "target", "unit", "due", "weight", "measure", "kind", "criteria", "memo"].includes(field)) throw new Error("하위 목표에서만 수정하는 항목이에요.");
	if (!main && ["why", "vision", "period"].includes(field)) throw new Error("상위 목표에서만 수정하는 항목이에요.");
	if (!name && /[\r\n]/.test(v)) throw new Error("한 줄로 입력해 주세요.");
	if (field === "title") { const error = nameProblem(v); if (error) throw new Error(error.replace("이름", "제목")); }
	if (field === "due" && v) {
		const date = new Date(`${v}T00:00:00Z`);
		if (!isIsoDate(v) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== v) throw new Error("기한은 실제 날짜를 YYYY-MM-DD로 적어 주세요.");
	}
	if (field === "weight" && v && (toNum(v) === null || toNum(v)! <= 0)) throw new Error("가중치는 0보다 큰 숫자예요.");
	if (field === "measure" && !["", "metric", "milestone"].includes(v)) throw new Error("측정 방식을 골라 주세요.");
	if (field === "kind" && !["", "outcome", "performance"].includes(v)) throw new Error("종류를 골라 주세요.");
	const numeric = before.measure === "metric" && ["baseline", "current", "target"].includes(field);
	if (numeric && v && toNum(v) === null) throw new Error("수치 목표의 값은 숫자로 적어 주세요. 모르면 비워 둘 수 있어요.");
	if (inlineValue(text, field) === v) return { text, goal: before };
	let out: string;
	if (name) out = setFmValue(replaceSectionContent(text, name, toBullets(v)), "updated", today);
	else if (field === "current") out = applyGoalChange(text, path, { current: v, log: { date: today, text: v ? `현재 값 ${before.current || "미정"} → ${v}${before.unit ? ` ${before.unit}` : ""}` : "현재 값을 미정으로 변경", value: numeric ? v : undefined, verify: "보고됨", evidence: "MyLogs 플러그인, 사용자 입력" } }, today).text;
	else if (field === "period") out = setFmValue(setFmValue(text, "period", JSON.stringify(v)), "updated", today);
	else out = editGoalNote(text, path, { [field]: numeric && v ? String(toNum(v)) : v } as GoalChange, today).text;
	const goal = parseGoal(parseFrontmatterText(out).data, path);
	if (!goal) throw new Error("저장할 목표를 읽을 수 없어요.");
	return { text: out, goal };
}
