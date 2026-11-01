/**
 * 콘텐츠 스튜디오 connections.
 *
 *   data.json (synced with the vault)   bucket · region · prefix · Airtable base/table — not secret
 *   this device's local storage          AWS access key · secret · webhook addresses · Airtable token
 *
 * Secrets never go into the vault: it syncs through Google Drive and will be shipped as a product.
 */

import { type App, Notice, requestUrl, Setting } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import type { ChannelKey } from "./model.ts";
import { isS3Ready, listObjects, type S3Config, type Send } from "./s3.ts";

export interface StudioSecrets {
	s3KeyId: string;
	s3Secret: string;
	airtableToken: string;
	webhook: Record<ChannelKey, string>;
}

const KEY = "mylogs-studio-secrets";

export function loadSecrets(app: App): StudioSecrets {
	const raw = (app.loadLocalStorage(KEY) ?? {}) as Partial<StudioSecrets>;
	return { s3KeyId: raw.s3KeyId ?? "", s3Secret: raw.s3Secret ?? "", airtableToken: raw.airtableToken ?? "", webhook: { li: "", th: "", ig: "", ...(raw.webhook ?? {}) } };
}

export function saveSecrets(app: App, s: StudioSecrets): void {
	app.saveLocalStorage(KEY, s);
}

export function s3Config(plugin: MyLogsPlugin): S3Config {
	const st = plugin.settings.studio;
	const sec = loadSecrets(plugin.app);
	return { bucket: st.s3Bucket.trim(), region: st.s3Region.trim(), prefix: st.s3Prefix.trim().replace(/^\/+|\/+$/g, ""), accessKeyId: sec.s3KeyId.trim(), secretAccessKey: sec.s3Secret.trim() };
}

/** Obsidian `requestUrl` (no CORS) as the S3 module's `send`. */
export const obsidianSend: Send = async (r) => {
	const res = await requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body, throw: false });
	return { status: res.status, text: res.text ?? "" };
};

export function renderStudioSettings(el: HTMLElement, plugin: MyLogsPlugin): void {
	const s = plugin.settings;
	const app = plugin.app;
	new Setting(el).setName("콘텐츠 스튜디오").setHeading();
	el.createEl("p", {
		cls: "setting-item-description",
		text: "퍼스널 브랜딩 스튜디오의 미디어(S3)·발행(웹훅)·발행 결과(Airtable) 연결. 키와 웹훅 주소는 볼트가 아니라 이 기기에만 저장돼요 — 기기마다 한 번씩 넣어 주세요.",
	});
	const text = (name: string, desc: string, get: () => string, set: (v: string) => void, secret = false, ph = "") =>
		new Setting(el)
			.setName(name)
			.setDesc(desc)
			.addText((t) => {
				t.setPlaceholder(ph)
					.setValue(get())
					.onChange(async (v) => {
						set(v.trim());
						if (!secret) await plugin.saveSettings();
					});
				if (secret) t.inputEl.type = "password";
			});
	const sec = loadSecrets(app);
	const saveSec = () => saveSecrets(app, sec);
	text("S3 버킷", "미디어를 올릴 버킷", () => s.studio.s3Bucket, (v) => (s.studio.s3Bucket = v), false, "예: kimharu-media");
	text("S3 리전", "", () => s.studio.s3Region, (v) => (s.studio.s3Region = v), false, "ap-northeast-2");
	text("S3 폴더", "이 아래 YYYY/MM/에 올려요. 공개로 읽히는 폴더여야 Make·인스타그램이 가져가요.", () => s.studio.s3Prefix, (v) => (s.studio.s3Prefix = v.replace(/^\/+|\/+$/g, "")), false, "studio");
	text("AWS 액세스 키 ID", "이 기기에만 저장", () => sec.s3KeyId, (v) => ((sec.s3KeyId = v), saveSec()), true);
	text("AWS 시크릿 키", "이 기기에만 저장", () => sec.s3Secret, (v) => ((sec.s3Secret = v), saveSec()), true);
	new Setting(el)
		.setName("S3 연결 확인")
		.setDesc("폴더 목록을 한 번 읽어 봐요.")
		.addButton((b) =>
			b.setButtonText("확인").onClick(async () => {
				const c = s3Config(plugin);
				if (!isS3Ready(c)) return void new Notice("버킷·리전·키를 모두 넣어 주세요.");
				try {
					const list = await listObjects(c, obsidianSend, `${c.prefix}/`, 50);
					new Notice(`S3 연결 OK · ${c.prefix}/ 아래 파일 ${list.length}${list.length >= 50 ? "+" : ""}개`);
				} catch (e) {
					new Notice(`S3: ${e instanceof Error ? e.message : String(e)}`, 10000);
				}
			}),
		);
	text("링크드인 웹훅", "「예약 보내기」가 보낼 곳 (Make)", () => sec.webhook.li, (v) => ((sec.webhook.li = v), saveSec()), true, "https://hook.…make.com/…");
	text("스레드 웹훅", "Make → Buffer (타래를 못 받으면 Make → Threads API)", () => sec.webhook.th, (v) => ((sec.webhook.th = v), saveSec()), true, "https://hook.…make.com/…");
	text("인스타그램 웹훅", "API Gateway → Lambda", () => sec.webhook.ig, (v) => ((sec.webhook.ig = v), saveSec()), true, "https://….execute-api.….amazonaws.com/…");
	text("Airtable 베이스 ID", "「발행 결과」 표가 있는 베이스 (app…)", () => s.studio.airtableBase, (v) => (s.studio.airtableBase = v), false, "app…");
	text("Airtable 표 이름", "칸: id · status · url · error · at", () => s.studio.airtableTable, (v) => (s.studio.airtableTable = v || "발행 결과"), false, "발행 결과");
	text("Airtable 토큰", "읽기 권한만 있으면 돼요. 이 기기에만 저장", () => sec.airtableToken, (v) => ((sec.airtableToken = v), saveSec()), true, "pat…");
}
