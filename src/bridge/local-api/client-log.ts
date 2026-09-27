/**
 * POST /api/v1/client-log：前端恢复动作 / 报错的存档（原 web BFF 的 client-log），iOS 上看不到 console，事故后靠它对时间线。
 * 体是纯文本（一行一条）或 { lines: string[] }；每行 ≤ 2 KB，每个凭据每分钟 ≤ 60 行（超出的丢，响应里报 dropped）。
 * 追加到 ~/.claude-orchestrator/web/client.log（与旧 BFF 同一个文件，排障工具不用换路径）。浏览器扩展注入脚本的报错不是我们的代码，丢。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../../lib/paths.js";
import { SlidingWindowLimiter, tokenIdOf, type Principal } from "../../lib/principals.js";
import { apiJson } from "../api-respond.js";

const LINE_MAX = 2048;
const LINES_PER_MIN = 60;
const BODY_MAX = 64 * 1024;
const EXTENSION_RE = /\b(chrome|moz|safari-web)-extension:\/\//;

const limiters = new Map<string, SlidingWindowLimiter>();
const DEFAULT_LOG = statePath("web", "client.log");
let logPath = DEFAULT_LOG;
/** 单测指到临时文件；生产不调 */
export function setClientLogPathForTest(path: string | undefined): void {
  logPath = path ?? DEFAULT_LOG;
}

/** 文本 → 按行；JSON → lines[]（兼容旧客户端的 { msg }）；JSON 但形状不对 → null */
export function parseClientLogLines(raw: string, contentType: string): string[] | null {
  if (!contentType.includes("application/json")) return raw.split(/\r?\n/);
  try {
    const j = JSON.parse(raw) as { lines?: unknown; msg?: unknown } | null;
    const lines = Array.isArray(j?.lines) ? j.lines : typeof j?.msg === "string" ? [j.msg] : null;
    return lines ? lines.filter((l): l is string => typeof l === "string") : null;
  } catch {
    return null; // 坏 JSON：调用方回 400
  }
}

/** 一行一条、控制字符去掉、换行折成 ⏎，超长截断 */
const sanitizeLine = (s: string): string => s.slice(0, LINE_MAX).replace(/\r?\n/g, " ⏎ ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export async function handleClientLog(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/client-log" || req.method !== "POST") return null;
  if (Number(req.headers.get("content-length") || 0) > BODY_MAX) return apiJson(413, { ok: false, error: "client-log body too large" });
  const raw = await req.text();
  if (raw.length > BODY_MAX) return apiJson(413, { ok: false, error: "client-log body too large" });
  const lines = parseClientLogLines(raw, req.headers.get("content-type") || "");
  if (!lines) return apiJson(400, { ok: false, error: "body must be text lines or {lines: string[]}" });
  const key = principal.credential ?? tokenIdOf(principal);
  let limiter = limiters.get(key);
  if (!limiter) limiters.set(key, (limiter = new SlidingWindowLimiter(LINES_PER_MIN)));
  const ua = (req.headers.get("user-agent") || "").slice(0, 40);
  const stamp = new Date().toISOString();
  const out: string[] = [];
  let dropped = 0;
  let limited = 0;
  for (const line of lines) {
    const msg = line.trim();
    if (!msg) continue;
    if (EXTENSION_RE.test(msg)) dropped++;
    else if (!limiter.tryAcquire()) limited++;
    else out.push(`${stamp} ${sanitizeLine(msg)} | ${ua}`);
  }
  if (out.length) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${out.join("\n")}\n`);
    } catch (e) {
      console.error(`⚠️ client.log 写入失败: ${(e as Error).message}`);
    }
  }
  if (!out.length && limited) return apiJson(429, { ok: false, error: `client-log rate limit (${LINES_PER_MIN} lines/min)`, written: 0, dropped: dropped + limited });
  return apiJson(200, { ok: true, written: out.length, dropped: dropped + limited });
}
