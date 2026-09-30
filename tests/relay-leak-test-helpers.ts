/**
 * 「中继看不到内层」这类断言的共用件。中继能看到的是 URL、每个 header 的名和值、body，三样都要记下来查；
 * needle 必须是 ≥12 字节的随机或唯一标记（短串会在 base64 密文里偶然出现而假红），按 UTF-8 原始字节比（中文经 latin1 字符串永远匹配不上）。
 * 除原文外还查常见的无密钥可逆编码（base64 / base64url / hex / 百分号 / JSON \uXXXX，大小写混用也算）；压缩、分段、异或这类更深的藏法不在范围内。
 */
import { randomBytes } from "node:crypto";

/** 每次跑都不同的标记，带前缀方便看报错 */
export const mark = (prefix: string) => `${prefix}-${randomBytes(16).toString("hex")}`;

/** 中继眼里的一次请求 / 响应：URL 与全部 header 一段，body 一段 */
export function relayBytes(url: string, headers: Headers | Record<string, string>, body: ArrayBuffer | Uint8Array): Buffer[] {
  const pairs = headers instanceof Headers ? [...headers] : Object.entries(headers);
  return [Buffer.from([url, ...pairs.map(([k, v]) => `${k}: ${v}`)].join("\n"), "utf8"), Buffer.from(body instanceof Uint8Array ? body : new Uint8Array(body))];
}

export const relayView = async (m: Request | Response) => relayBytes(m.url, m.headers, await m.clone().arrayBuffer());

/**
 * needle 在更大的 base64 串里时，按它起始字节对 3 取余有三种对齐。每种对齐只取不受前后字节影响的整组字符：
 * 对齐 0 取完整分组、不带填充（带填充 / 不带填充的整段编码都以它开头）；对齐 1、2 前面补字节后丢掉第一组。
 */
function base64Cores(b: Buffer, enc: "base64" | "base64url"): string[] {
  return [0, 1, 2].map((k) => {
    const padded = Buffer.concat([Buffer.alloc(k), b]);
    const core = padded.subarray(0, Math.floor(padded.length / 3) * 3).toString(enc).replace(/=+$/, "");
    return k ? core.slice(4) : core;
  });
}

/** 一个 needle 的原文和各种可逆编码形式：[编码名, 字节, 在哪份归一化副本里查]；hex、\uXXXX 取小写，和转小写的副本比 */
function encodedForms(needle: string): [string, Buffer, "exact" | "lower"][] {
  const b = Buffer.from(needle, "utf8");
  const u = Array.from({ length: needle.length }, (_, i) => `\\u${needle.charCodeAt(i).toString(16).padStart(4, "0")}`).join("");
  return [
    ["raw", b, "exact"],
    ...base64Cores(b, "base64").map((s, k): [string, Buffer, "exact"] => [`base64@${k}`, Buffer.from(s), "exact"]),
    ...base64Cores(b, "base64url").map((s, k): [string, Buffer, "exact"] => [`base64url@${k}`, Buffer.from(s), "exact"]),
    ["hex", Buffer.from(b.toString("hex")), "lower"],
    ["\\uXXXX", Buffer.from(u), "lower"],
  ];
}

/**
 * 大小写可以逐位混用的编码不枚举组合，先归一再比：合法的 %XX（大小写任意）解码回原字节，encodeURIComponent 与逐字节百分号都归到原文；
 * hex、\uXXXX 在 ASCII 转小写的副本里查。解码整个 body 也不会误报：命中仍要求 ≥12 字节的随机 needle 完整出现。
 */
const pctDecode = (s: Buffer) => Buffer.from(s.toString("latin1").replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
const asciiLower = (s: Buffer) => Buffer.from(s.toString("latin1").replace(/[A-Z]/g, (c) => c.toLowerCase()), "latin1");

/** 哪些 needle（以哪种形式）出现在中继看到的字节里；needle 太短会在密文里偶然撞上，直接报错 */
export function leakedIn(seen: Buffer[], needles: string[]): string[] {
  for (const n of needles) if (Buffer.byteLength(n) < 12) throw new Error(`leak needle too short: ${n}`);
  const decoded = seen.map(pctDecode), views = { exact: [...seen, ...decoded], lower: [...seen, ...decoded].map(asciiLower) };
  return needles.flatMap((n) => encodedForms(n).filter(([, f, v]) => views[v].some((s) => s.includes(f))).map(([k]) => `${n} (${k})`));
}
