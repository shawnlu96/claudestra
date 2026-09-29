/**
 * 「中继看不到内层」这类断言的共用件。中继能看到的是 URL、每个 header 的名和值、body，三样都要记下来查；
 * needle 必须是 ≥16 字节的随机标记（短串会在 base64 密文里偶然出现而假红），按 UTF-8 原始字节比（中文经 latin1 字符串永远匹配不上）。
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

/** 哪些 needle 出现在中继看到的字节里 */
export const leakedIn = (seen: Buffer[], needles: string[]) => needles.filter((n) => seen.some((b) => b.includes(Buffer.from(n, "utf8"))));
