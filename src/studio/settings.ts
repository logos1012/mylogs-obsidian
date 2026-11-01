/**
 * 콘텐츠 스튜디오 connections.
 *
 *   data.json (synced with the vault)   bucket · region · prefix — not secret
 *   this device's local storage          AWS access key · secret · webhook addresses · LinkedIn x-studio-key
 *
 * Secrets never go into the vault: it syncs through Google Drive and will be shipped as a product.
 * Publish results are read from `studio/results/{id}.json` in the same bucket (not under the prefix).
 * Airtable is not used.
 */

import { type App, Notice, requestUrl, Setting } from "obsidian";
import type MyLogsPlugin from "../main.ts";
import { resultBody, type ChannelKey } from "./model.ts";
import { DEFAULT_S3_PREFIX, isS3Ready, listObjects, type S3Config, type Send } from "./s3.ts";

export interface StudioSecrets {
	s3KeyId: string;
	s3Secret: string;
	/** LinkedIn and Threads `x-studio-key`. Empty = do not send the header. */
	studioKey: string;
	/** Threads intake URL. Empty = do not send. Never a hard-coded endpoint. */
	threadsIntake: string;
	webhook: Record<ChannelKey, string>;
}

const KEY = "mylogs-studio-secrets";

export function loadSecrets(app: App): StudioSecrets {
	const raw = (app.loadLocalStorage(KEY) ?? {}) as Partial<StudioSecrets>;
	return { s3KeyId: raw.s3KeyId ?? "", s3Secret: raw.s3Secret ?? "", studioKey: raw.studioKey ?? "", threadsIntake: raw.threadsIntake ?? "", webhook: { li: "", th: "", ig: "", ...(raw.webhook ?? {}) } };
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
	return { status: res.status, text: resultBody(res) };
};

export function renderStudioSettings(el: HTMLElement, plugin: MyLogsPlugin): void {
	const s = plugin.settings;
	const app = plugin.app;
	new Setting(el).setName("콘텐츠 스튜디오").setHeading();
	el.createEl("p", {
		cls: "setting-item-description",
		text: "퍼스널 브랜딩 스튜디오의 미디어(S3)와 발행(웹훅) 연결. 발행 결과는 같은 버킷의 studio/results/{id}.json 을 읽어요 (업로드 폴더와 다른 키). 키·웹훅·x-studio-key 는 볼트가 아니라 이 기기에만 저장돼요 — 기기마다 한 번씩 넣어 주세요.",
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
	text("S3 버킷", "미디어를 올리고 발행 결과(studio/results/)를 읽는 버킷", () => s.studio.s3Bucket, (v) => (s.studio.s3Bucket = v), false, "버킷 이름");
	text("S3 리전", "", () => s.studio.s3Region, (v) => (s.studio.s3Region = v), false, "ap-northeast-2");
	text("S3 폴더", `미디어는 이 아래 YYYY/MM/에 올라요. 기본 ${DEFAULT_S3_PREFIX}. 발행 결과 파일은 이 폴더와 상관없이 studio/results/ 에 있어요.`, () => s.studio.s3Prefix, (v) => (s.studio.s3Prefix = v.replace(/^\/+|\/+$/g, "")), false, DEFAULT_S3_PREFIX);
	text("AWS 액세스 키 ID", "이 기기에만 저장. 권한: s3:PutObject artifacts/studio/* · s3:ListBucket (prefix artifacts/studio/) · s3:GetObject studio/results/*", () => sec.s3KeyId, (v) => ((sec.s3KeyId = v), saveSec()), true);
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
	text("링크드인 웹훅", "「예약 보내기」·「예약 취소」가 POST 할 곳 (API Gateway). 본문 형식은 그대로예요.", () => sec.webhook.li, (v) => ((sec.webhook.li = v), saveSec()), true, "https://….execute-api.….amazonaws.com/…");
	text("링크드인 키 (x-studio-key)", "값이 있으면 링크드인·스레드 예약·취소 POST에 헤더 x-studio-key 로 붙여요. 비우면 헤더를 안 보내요. 이 기기에만 저장", () => sec.studioKey, (v) => ((sec.studioKey = v), saveSec()), true);
	text("스레드 접수 주소", "스레드 「예약 보내기」·「예약 취소」가 POST 할 곳. 비어 있으면 보내지 않아요. 링크드인과 같은 x-studio-key 를 붙여요.", () => sec.threadsIntake, (v) => ((sec.threadsIntake = v), saveSec()), true, "https://….execute-api.….amazonaws.com/…");
	text("인스타그램 웹훅", "API Gateway → Lambda", () => sec.webhook.ig, (v) => ((sec.webhook.ig = v), saveSec()), true, "https://….execute-api.….amazonaws.com/…");
}
