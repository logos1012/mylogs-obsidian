/**
 * S3 for the studio's media (AWS Signature V4, Web Crypto — desktop and phone).
 *
 * The plugin keeps no AWS keys in the vault: the access key lives in this device's local storage
 * (`./settings.ts`). Uploads go under `<prefix>/YYYY/MM/`; the bucket serves that prefix publicly,
 * so a post keeps the plain https address and Make · Buffer · Lambda can fetch it.
 *
 * Pure module apart from the injected `send` (Obsidian `requestUrl` in the plugin, `fetch` in tests).
 */

export interface S3Config {
	bucket: string;
	region: string;
	/** `artifacts/studio` — no slashes at the ends. */
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export interface S3Object {
	key: string;
	url: string;
	size: number;
	/** ISO time. */
	modified: string;
}

export type Send = (req: { url: string; method: string; headers: Record<string, string>; body?: ArrayBuffer }) => Promise<{ status: number; text: string }>;

const enc = new TextEncoder();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(data: ArrayBuffer | string): Promise<string> {
	const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
	return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const raw = (key instanceof Uint8Array ? key : new Uint8Array(key)) as Uint8Array<ArrayBuffer>;
	const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", k, enc.encode(data) as Uint8Array<ArrayBuffer>);
}

/** RFC 3986 (what S3 signs): everything but `A-Z a-z 0-9 - _ . ~` is %-encoded. */
export function uriEncode(s: string, keepSlash = false): string {
	return [...enc.encode(s)]
		.map((b) => {
			const c = String.fromCharCode(b);
			if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === "/")) return c;
			return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
		})
		.join("");
}

export const host = (c: S3Config) => `${c.bucket}.s3.${c.region}.amazonaws.com`;

/** Public address of a key. */
export const publicUrl = (c: S3Config, key: string) => `https://${host(c)}/${uriEncode(key, true)}`;

/** `20260114T051200Z` and `20260114`. */
function stamp(now: Date): { amz: string; day: string } {
	const amz = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	return { amz, day: amz.slice(0, 8) };
}

/** Signed request headers for one S3 call. */
export async function sign(c: S3Config, req: { method: string; key: string; query?: Record<string, string>; headers?: Record<string, string>; body?: ArrayBuffer }, now = new Date()): Promise<{ url: string; headers: Record<string, string> }> {
	const { amz, day } = stamp(now);
	const payloadHash = req.body ? await sha256(req.body) : await sha256("");
	const h: Record<string, string> = { host: host(c), "x-amz-content-sha256": payloadHash, "x-amz-date": amz };
	for (const [k, v] of Object.entries(req.headers ?? {})) h[k.toLowerCase()] = v.trim();
	const names = Object.keys(h).sort();
	const canonicalHeaders = names.map((n) => `${n}:${h[n]}\n`).join("");
	const signedHeaders = names.join(";");
	const q = Object.entries(req.query ?? {})
		.map(([k, v]) => [uriEncode(k), uriEncode(v)])
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");
	const path = "/" + uriEncode(req.key, true);
	const canonical = [req.method, path, q, canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const scope = `${day}/${c.region}/s3/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amz, scope, await sha256(canonical)].join("\n");
	let k = await hmac(enc.encode(`AWS4${c.secretAccessKey}`), day);
	k = await hmac(k, c.region);
	k = await hmac(k, "s3");
	k = await hmac(k, "aws4_request");
	const signature = hex(await hmac(k, toSign));
	const out: Record<string, string> = {};
	for (const n of names) if (n !== "host") out[n] = h[n];
	out.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return { url: `https://${host(c)}${path}${q ? `?${q}` : ""}`, headers: out };
}

const MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	heic: "image/heic",
	mp4: "video/mp4",
	mov: "video/quicktime",
	m4v: "video/x-m4v",
	webm: "video/webm",
	pdf: "application/pdf",
};

export const mimeOf = (name: string) => MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** `<prefix>/2026/01/20260114-141230-save-1200.png` */
export function uploadKey(c: S3Config, name: string, now = new Date()): string {
	const k = new Date(now.getTime() + 9 * 3600_000).toISOString(); // Asia/Seoul
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
	const stem = (dot > 0 ? name.slice(0, dot) : name)
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}._-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60) || "media";
	return `${c.prefix}/${k.slice(0, 4)}/${k.slice(5, 7)}/${k.slice(0, 10).replace(/-/g, "")}-${k.slice(11, 19).replace(/:/g, "")}-${stem}${ext ? `.${ext}` : ""}`;
}

export async function putObject(c: S3Config, send: Send, key: string, body: ArrayBuffer, contentType: string): Promise<string> {
	const s = await sign(c, { method: "PUT", key, headers: { "content-type": contentType }, body });
	const r = await send({ url: s.url, method: "PUT", headers: s.headers, body });
	if (r.status < 200 || r.status >= 300) throw new Error(`S3 올리기 실패 (${r.status}) ${s3Error(r.text)}`);
	return publicUrl(c, key);
}

export async function deleteObject(c: S3Config, send: Send, key: string): Promise<void> {
	const s = await sign(c, { method: "DELETE", key });
	const r = await send({ url: s.url, method: "DELETE", headers: s.headers });
	if (r.status >= 300) throw new Error(`S3 지우기 실패 (${r.status}) ${s3Error(r.text)}`);
}

/** Every object under `prefix` (paged). */
export async function listObjects(c: S3Config, send: Send, prefix: string, max = 2000): Promise<S3Object[]> {
	const out: S3Object[] = [];
	let token = "";
	while (out.length < max) {
		const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
		if (token) query["continuation-token"] = token;
		const s = await sign(c, { method: "GET", key: "", query });
		const r = await send({ url: s.url, method: "GET", headers: s.headers });
		if (r.status !== 200) throw new Error(`S3 목록 실패 (${r.status}) ${s3Error(r.text)}`);
		out.push(...parseList(c, r.text));
		token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(r.text)?.[1] ?? "";
		if (!token) break;
	}
	return out;
}

const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function parseList(c: S3Config, xml: string): S3Object[] {
	const out: S3Object[] = [];
	for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const key = unxml(/<Key>([^<]*)<\/Key>/.exec(m[1])?.[1] ?? "");
		if (!key || key.endsWith("/")) continue;
		out.push({ key, url: publicUrl(c, key), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] ?? 0), modified: /<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] ?? "" });
	}
	return out;
}

/** Objects of the last `days` days (newest first): lists only the month folders that can hold them. */
export async function listRecent(c: S3Config, send: Send, days: number, now = new Date()): Promise<S3Object[]> {
	const since = new Date(now.getTime() - days * 86400_000);
	const months = new Set<string>();
	for (let t = since.getTime(); t <= now.getTime() + 86400_000; t += 86400_000) {
		const k = new Date(t + 9 * 3600_000).toISOString();
		months.add(`${k.slice(0, 4)}/${k.slice(5, 7)}`);
	}
	const all: S3Object[] = [];
	for (const m of months) all.push(...(await listObjects(c, send, `${c.prefix}/${m}/`)));
	return all.filter((o) => o.modified >= since.toISOString()).sort((a, b) => b.modified.localeCompare(a.modified));
}

function s3Error(xml: string): string {
	const code = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
	const msg = /<Message>([^<]+)<\/Message>/.exec(xml)?.[1];
	return [code, msg].filter(Boolean).join(": ");
}

export const isS3Ready = (c: S3Config) => !!(c.bucket && c.region && c.accessKeyId && c.secretAccessKey);

/** Upload folder default. Results are not stored under this prefix. */
export const DEFAULT_S3_PREFIX = "artifacts/studio";
/** 0.39.0 default. Only this exact saved value is rewritten. */
export const LEGACY_S3_PREFIX = "studio";

/**
 * `undefined` (never saved) and the old default `studio` become `artifacts/studio`.
 * Any other saved value, including empty, is kept. Surrounding slashes are stripped
 * the same way the settings field does, so `studio/` is still the old default.
 */
export function migrateS3Prefix(saved: string | undefined | null): string {
	if (saved == null) return DEFAULT_S3_PREFIX;
	const prefix = saved.trim().replace(/^\/+|\/+$/g, "");
	if (prefix === LEGACY_S3_PREFIX) return DEFAULT_S3_PREFIX;
	return prefix;
}

/** Publish results. Not derived from `S3Config.prefix` — that folder is uploads only. */
export const RESULT_PREFIX = "studio/results";

/**
 * LinkedIn: `studio/results/{id}.json`. Threads (`th`): `studio/results/threads/{id}.json`.
 * Empty for a bad id, a `_…` object (`_token.json`), or the leftover test id.
 */
export function resultObjectKey(id: string, channel = ""): string {
	const safe = id.trim();
	if (!safe || /[\\/\u0000]/.test(safe) || safe === "." || safe === ".." || safe.startsWith("_") || safe === "TEST-THREADS-001") return "";
	if (channel === "th" || channel === "threads") return `${RESULT_PREFIX}/threads/${safe}.json`;
	return `${RESULT_PREFIX}/${safe}.json`;
}

/** Public base of uploaded media, from the user's bucket · region · folder. No hard-coded host. */
export function publicPrefix(c: { bucket: string; region: string; prefix: string }): string {
	const bucket = c.bucket.trim();
	const region = c.region.trim();
	const prefix = c.prefix.trim().replace(/^\/+|\/+$/g, "");
	if (!bucket || !region || !prefix) return "";
	return `https://${bucket}.s3.${region}.amazonaws.com/${prefix}/`;
}

/** Signed GetObject. HTTP status is returned as-is (404 / 403 are not thrown). */
export async function getObject(c: S3Config, send: Send, key: string): Promise<{ status: number; text: string }> {
	const signed = await sign(c, { method: "GET", key });
	return send({ url: signed.url, method: "GET", headers: signed.headers });
}
