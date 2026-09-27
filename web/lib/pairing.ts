/**
 * 配对页的纯逻辑（docs/design-hosted-frontend.md §4）：二维码片段解析、挑战应答的 HMAC、短码整形、设备名。
 * 与 bridge 的 src/lib/pairing-codes.ts 同一算法：hmac = base64url(HMAC-SHA256(key = base64url 解出的秘密, message = challenge))。
 * WebCrypto 在 bun 里也有，tests/web-pairing.test.ts 拿 node:crypto 对拍。
 */
export const FP_RE = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;
const CODE_CHARS = /[^A-HJ-NP-Z2-9]/g;
const B64URL_RE = /^[A-Za-z0-9_-]{16,}$/;

/** `#<fp>.<secret>`（新二维码 / 链接）→ {fp, secret}；别的片段 → null */
export function parsePairFragment(hash: string): { fp: string; secret: string } | null {
  const raw = hash.replace(/^#/, "").trim();
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const fp = raw.slice(0, dot).toLowerCase();
  const secret = raw.slice(dot + 1);
  return FP_RE.test(fp) && B64URL_RE.test(secret) ? { fp, secret } : null;
}

/** 老链接 `#<8 位短码>`（中继 /c/<code> 的 302）→ 整形后的短码；不是短码 → "" */
export function codeFromFragment(hash: string): string {
  const raw = hash.replace(/^#/, "").trim();
  if (raw.includes(".")) return "";
  const s = compactCode(raw);
  return s.length === 8 ? s : "";
}

/** 用户随手输的 → 大写、只留短码字母表、最多 8 位，中间一杠 */
export function formatCode(raw: string): string {
  const s = compactCode(raw);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export function compactCode(raw: string): string {
  return raw.toUpperCase().replace(CODE_CHARS, "").slice(0, 8);
}

/** 返回 Uint8Array<ArrayBuffer>（不是 ArrayBufferLike）：WebCrypto 的 BufferSource 参数在 TS 5.9 下只认这个 */
export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 秘密只在浏览器里：对 bridge 发的挑战做 HMAC，只有结果出门 */
export async function hmacProof(secretB64url: string, challenge: string): Promise<string> {
  // 根 tsconfig 无 dom lib：BufferSource 不可用，Uint8Array 本身就是合法的 raw key 材料
  const key = await crypto.subtle.importKey("raw", base64urlToBytes(secretB64url), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(challenge));
  return bytesToBase64url(sig);
}

/** 默认设备名「iPhone · Safari」这种：设备清单里一眼认得出是哪台；用户可改 */
export function defaultDeviceName(ua: string, platform = ""): string {
  const device = /iPad/i.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))
    ? "iPad"
    : /iPhone/i.test(ua)
      ? "iPhone"
      : /Android/i.test(ua)
        ? "Android"
        : /Windows/i.test(ua)
          ? "Windows"
          : /Macintosh|Mac OS/i.test(ua)
            ? "Mac"
            : /Linux/i.test(ua)
              ? "Linux"
              : platform || "Device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua) && !/Chromium/.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  return browser ? `${device} · ${browser}` : device;
}

/** 本机回环打开的页面：direct 模式下可以一键配对（bridge 只认真实回环 socket） */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}
