// StPageFlip's ES module build ships without types next to it (MIT, github.com/Nodlik/StPageFlip).
declare module "page-flip/dist/js/page-flip.module.js" {
	export class PageFlip {
		constructor(el: HTMLElement, settings: Record<string, unknown>);
		loadFromHTML(items: HTMLElement[]): void;
		turnToPage(page: number): void;
		flipNext(corner?: string): void;
		flipPrev(corner?: string): void;
		getPageCount(): number;
		getCurrentPageIndex(): number;
		on(event: "flip" | "changeOrientation" | "changeState" | "init" | "update", cb: (e: { data: unknown }) => void): this;
		destroy(): void;
	}
}
