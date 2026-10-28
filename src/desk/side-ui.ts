import type { SideMode } from "../side.ts";
import { tip } from "../ui/tip.ts";
import type { SideCounts } from "./side-filter.ts";

/**
 * A day's 개인 · 회사 count in its head. 전체: both, so a squeezed personal side shows as a number.
 * 개인 / 회사: the hidden side folded to its count (it is not gone, only out of this mode).
 */
export function renderSideCount(head: HTMLElement, c: SideCounts | undefined, mode: SideMode): void {
	if (!c) return;
	if (mode === "전체") {
		if (!c.회사) return;
		const el = head.createSpan({ cls: "ml-side-count" });
		el.createSpan({ cls: "is-personal", text: String(c.개인) });
		el.createSpan({ cls: "is-work", text: String(c.회사) });
		tip(el, `개인 ${c.개인} · 회사 ${c.회사}`);
		return;
	}
	const other = mode === "개인" ? "회사" : "개인";
	if (!c[other]) return;
	const el = head.createSpan({ cls: `ml-side-hidden is-${other === "회사" ? "work" : "personal"}`, text: `${other} ${c[other]}` });
	tip(el, `${other} 일 ${c[other]}개는 ${mode} 모드에서 접어 두었어요`);
}
