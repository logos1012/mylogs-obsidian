/**
 * Media for posts: the S3 picker (최근 7일 · 30일, 날짜별) and local uploads (drop / file input →
 * S3 → the https address). Nothing is copied into the vault.
 */

import { type App, Modal, moment, Notice, setIcon } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { isS3Ready, listRecent, mimeOf, putObject, type S3Object, uploadKey } from "./s3.ts";
import { obsidianSend, s3Config } from "./settings.ts";
import { isVideo } from "./model.ts";

const ACCEPT = "image/*,video/*,.heic,.pdf";

/** Upload local files; returns their addresses in order (failed ones are left out with a Notice). */
export async function uploadFiles(plugin: MyLogsPlugin, files: File[], onStep?: (msg: string) => void): Promise<string[]> {
	const c = s3Config(plugin);
	if (!isS3Ready(c)) {
		new Notice("설정 › 콘텐츠 스튜디오에서 S3 버킷과 키를 넣어 주세요.", 8000);
		return [];
	}
	const out: string[] = [];
	for (const [i, f] of files.entries()) {
		onStep?.(`${f.name} 올리는 중… (${i + 1}/${files.length})`);
		try {
			const buf = await f.arrayBuffer();
			out.push(await putObject(c, obsidianSend, uploadKey(c, f.name), buf, f.type || mimeOf(f.name)));
		} catch (e) {
			new Notice(`${f.name}: ${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}
	onStep?.("");
	return out;
}

/** A hidden file input; resolves the chosen files. */
export function chooseFiles(multiple = true): Promise<File[]> {
	return new Promise((resolve) => {
		const input = createEl("input", { attr: { type: "file", accept: ACCEPT } });
		input.multiple = multiple;
		input.addEventListener("change", () => resolve([...(input.files ?? [])]));
		input.click();
	});
}

/** Make `el` accept dropped files. */
export function dropZone(el: HTMLElement, onFiles: (files: File[]) => void): void {
	el.addEventListener("dragover", (ev) => {
		if (!ev.dataTransfer?.types.includes("Files")) return;
		ev.preventDefault();
		el.addClass("is-drop");
	});
	el.addEventListener("dragleave", () => el.removeClass("is-drop"));
	el.addEventListener("drop", (ev) => {
		if (!ev.dataTransfer?.files.length) return;
		ev.preventDefault();
		el.removeClass("is-drop");
		onFiles([...ev.dataTransfer.files]);
	});
}

export function thumb(parent: HTMLElement, url: string, cls = "st-thumb"): HTMLElement {
	const box = parent.createDiv({ cls });
	if (isVideo(url)) {
		box.addClass("is-video");
		const v = box.createEl("video", { attr: { src: url, preload: "metadata", muted: "", playsinline: "" } });
		v.muted = true;
		box.createSpan({ cls: "st-vbadge", text: "▶" });
	} else if (/\.pdf(\?|$)/i.test(url)) {
		box.addClass("is-doc");
		box.createSpan({ text: "PDF" });
	} else box.createEl("img", { attr: { src: url, alt: "", loading: "lazy", draggable: "false" } });
	return box;
}

const nameOf = (key: string) => decodeURIComponent(key.slice(key.lastIndexOf("/") + 1)).replace(/^\d{8}-\d{6}-/, "");
const sizeOf = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

/** 「S3에서 고르기」. Resolves the chosen addresses in the order they were picked ([] = cancelled). */
export function pickMedia(plugin: MyLogsPlugin, opts: { multiple?: boolean } = {}): Promise<string[]> {
	return new Promise((resolve) => new S3PickerModal(plugin.app, plugin, opts.multiple ?? true, resolve).open());
}

class S3PickerModal extends Modal {
	private days = 7;
	private kind: "all" | "image" | "video" = "all";
	private q = "";
	private items: S3Object[] = [];
	private chosen: string[] = [];
	private loading = false;
	private status = "";
	private done = false;

	constructor(
		app: App,
		private plugin: MyLogsPlugin,
		private multiple: boolean,
		private resolve: (urls: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("mylogs-studio-modal", "st-s3");
		this.titleEl.setText("미디어 고르기");
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) this.resolve([]);
	}

	private async load(): Promise<void> {
		const c = s3Config(this.plugin);
		if (!isS3Ready(c)) {
			this.status = "설정 › 콘텐츠 스튜디오에서 S3 버킷과 키를 넣어 주세요.";
			this.render();
			return;
		}
		this.loading = true;
		this.render();
		try {
			this.items = await listRecent(c, obsidianSend, this.days);
			this.status = "";
		} catch (e) {
			this.status = e instanceof Error ? e.message : String(e);
		}
		this.loading = false;
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const c = s3Config(this.plugin);
		el.createDiv({ cls: "st-faint st-small", text: `S3 · ${c.bucket}/${c.prefix}/` });
		const top = el.createDiv({ cls: "st-row st-wrap st-s3top" });
		const seg = top.createDiv({ cls: "st-seg" });
		for (const d of [7, 30]) {
			const b = seg.createEl("button", { cls: d === this.days ? "is-on" : "", text: `최근 ${d}일`, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.days = d;
				void this.load();
			});
		}
		const kinds = top.createDiv({ cls: "st-chips" });
		const count = (k: string) => this.items.filter((o) => k === "all" || (k === "video") === isVideo(o.key)).length;
		for (const [k, label] of [["all", "전체"], ["image", "이미지"], ["video", "영상"]] as const) {
			const b = kinds.createEl("button", { cls: k === this.kind ? "is-on" : "", text: `${label} ${count(k)}`, attr: { type: "button" } });
			b.addEventListener("click", () => {
				this.kind = k;
				this.render();
			});
		}
		top.createDiv({ cls: "st-grow" });
		const q = top.createEl("input", { cls: "st-search", attr: { type: "search", placeholder: "파일 이름 찾기…" } });
		q.value = this.q;
		q.addEventListener("input", () => {
			this.q = q.value;
			this.renderGrid(grid);
		});

		if (this.status) el.createDiv({ cls: "st-banner", text: this.status });
		const grid = el.createDiv({ cls: "st-s3body" });
		if (this.loading) grid.createDiv({ cls: "st-faint", text: "불러오는 중…" });
		else this.renderGrid(grid);

		const drop = el.createDiv({ cls: "st-s3drop" });
		setIcon(drop.createSpan(), "upload");
		drop.createSpan({ text: " 여기에 파일을 끌어 놓거나 " });
		const pick = drop.createEl("a", { text: "파일 고르기" });
		drop.createSpan({ text: ` — ${c.prefix}/${moment().format("YYYY/MM")}/에 올리고 바로 고른 상태가 돼요` });
		const prog = drop.createDiv({ cls: "st-small st-muted" });
		const up = async (files: File[]) => {
			const urls = await uploadFiles(this.plugin, files, (m) => prog.setText(m));
			if (!urls.length) return;
			this.chosen.push(...urls);
			await this.load();
		};
		pick.addEventListener("click", () => void chooseFiles(this.multiple).then(up));
		dropZone(drop, (f) => void up(f));

		const foot = el.createDiv({ cls: "st-row st-s3foot" });
		foot.createSpan({ cls: "st-grow st-small st-muted", text: `${this.chosen.length}개 고름 · 고른 순서대로 들어가요` });
		const cancel = foot.createEl("button", { text: "취소", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		const ok = foot.createEl("button", { cls: "mod-cta", text: "넣기", attr: { type: "button" } });
		ok.disabled = !this.chosen.length;
		ok.addEventListener("click", () => {
			this.done = true;
			this.resolve([...this.chosen]);
			this.close();
		});
	}

	private renderGrid(grid: HTMLElement): void {
		grid.empty();
		const q = this.q.trim().toLowerCase();
		const shown = this.items.filter((o) => (this.kind === "all" || (this.kind === "video") === isVideo(o.key)) && (!q || nameOf(o.key).toLowerCase().includes(q)));
		if (!shown.length) {
			grid.createDiv({ cls: "st-faint st-pad", text: this.items.length ? "맞는 파일이 없어요." : `최근 ${this.days}일에 올린 파일이 없어요. 아래에 끌어 놓아 올려 보세요.` });
			return;
		}
		const groups = new Map<string, S3Object[]>();
		for (const o of shown) {
			const day = moment(o.modified).format("YYYY-MM-DD");
			groups.set(day, [...(groups.get(day) ?? []), o]);
		}
		const today = moment().format("YYYY-MM-DD");
		for (const [day, list] of groups) {
			const g = grid.createDiv({ cls: "st-dgroup" });
			g.createEl("h4", { text: day === today ? `오늘 ${moment(day).format("M/D")}` : moment(day).format("M/D (dd)") });
			const row = g.createDiv({ cls: "st-s3grid" });
			for (const o of list) {
				const at = this.chosen.indexOf(o.url);
				const it = row.createDiv({ cls: `st-it${at >= 0 ? " is-sel" : ""}` });
				thumb(it, o.url, "st-im");
				if (at >= 0) it.createSpan({ cls: "st-order", text: String(at + 1) });
				const nm = it.createDiv({ cls: "st-nm", text: nameOf(o.key) });
				nm.createSpan({ text: `${sizeOf(o.size)} · ${moment(o.modified).format("HH:mm")}` });
				it.addEventListener("click", () => {
					const i = this.chosen.indexOf(o.url);
					if (i >= 0) this.chosen.splice(i, 1);
					else if (this.multiple) this.chosen.push(o.url);
					else this.chosen = [o.url];
					this.render();
				});
			}
		}
	}
}
