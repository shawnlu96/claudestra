/**
 * `rename.browserProtocol`：off / observe / on，缺省与写错都是 off。接收（双认）与新写入分开批准：
 *   "on"                         = 只开接收（新族 cookie / CSRF 头 / handoff 键 / scheme 照认），仍只写旧族；
 *   { receive: "on", write: "on" } = 另外开新写入（cookie 两族一起种、邀请页给新 scheme）。write 只在 receive=on 时算数。
 * observe 不改变认证、响应头与 SW 行为，只记一行「on 会怎么判」。
 */
import { readConfigSync } from "../config-store.js";

type BrowserMode = "off" | "observe" | "on";
export interface BrowserPolicy { receive: BrowserMode; write: BrowserMode }
export const BROWSER_OFF: BrowserPolicy = { receive: "off", write: "off" };

const mode = (v: unknown): BrowserMode => v === "on" || v === "observe" ? v : "off";

export function parseBrowserProtocol(config: unknown): BrowserPolicy {
  const rename = config && typeof config === "object" ? (config as { rename?: unknown }).rename : null;
  const value = rename && typeof rename === "object" ? (rename as { browserProtocol?: unknown }).browserProtocol : null;
  if (typeof value === "string") return { receive: mode(value), write: "off" };
  const o = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const receive = mode(o.receive);
  return { receive, write: receive === "on" ? mode(o.write) : "off" };
}

/** 每个浏览器请求都要判：config.json 最多一秒读一次 */
let cached: { at: number; policy: BrowserPolicy } | null = null;
let override: BrowserPolicy | undefined;
export function browserPolicy(now = Date.now()): BrowserPolicy {
  if (override) return override;
  if (cached && now - cached.at < 1000) return cached.policy;
  let policy = BROWSER_OFF;
  try { policy = parseBrowserProtocol(readConfigSync()); } catch { /* 读不出配置 = off：老行为 */ }
  cached = { at: now, policy };
  return policy;
}
/** 单测钉档位；undefined = 回到读 config.json。生产不调 */
export function setBrowserPolicyForTest(p: BrowserPolicy | undefined): void { override = p; cached = null; }

/** 观察记录只含判断，不含 cookie 值、头值、URL */
export function observeBrowser(area: string, verdict: string): void {
  console.info(`[floka-browser] observe ${area}: ${verdict}`);
}
