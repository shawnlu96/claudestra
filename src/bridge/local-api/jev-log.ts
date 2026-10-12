/**
 * GET /api/v1/jev/log[?limit=N] → 设置页「Jev 调用记录」（owner 2026-09-28：守门对用户无打扰，出了问题分不清是 Jev 挂了降级
 * 还是判定通过了）。读 guard-log.jsonl 尾部：每条判定一行（pass / flag / block / error），放行 / 丢弃按 id 并回那条判定。
 * 只读、manage 凭据才给（含发送方名与消息预览）。解析是纯函数 parseJevLog，tests/local-api-jev-log.test.ts。
 */
import { open, stat } from "node:fs/promises";
import { canManage } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { GUARD_LOG_PATH } from "../chat-guard.js";

/** 只读尾部这么多字节：一行约 300 B，够几千条；文件无限增长也不会把整份读进内存 */
const TAIL_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

export interface JevLogItem {
  ts: string;
  id: string;
  agent: string;
  sender: { name: string; trust: string; kind: string };
  verdict: "pass" | "flag" | "block" | "error";
  /** 最高分的那个探针（error 时没有） */
  top?: { id: string; score: number | null };
  ms?: number;
  tokens?: number;
  error?: string;
  preview?: string;
  /** block 之后 owner 的处理；没有 = 仍待放行或早于记录 */
  action?: "released" | "dropped";
  by?: string;
  actedAt?: string;
}
export interface JevLogStats { total: number; pass: number; flag: number; block: number; error: number; avgMs: number | null }

type Raw = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const VERDICTS = new Set(["pass", "flag", "block", "error"]);

function toItem(r: Raw): JevLogItem | null {
  const verdict = str(r.verdict);
  if (!VERDICTS.has(verdict)) return null;
  const s = (r.sender ?? {}) as Raw;
  const hits = Array.isArray(r.hits) ? (r.hits as Raw[]) : [];
  const top = hits.reduce<Raw | null>((a, h) => ((num(h.score) ?? -1) > (num(a?.score) ?? -1) ? h : a), null);
  return {
    ts: str(r.ts), id: str(r.id), agent: str(r.agent), verdict: verdict as JevLogItem["verdict"],
    sender: { name: str(s.name) || "?", trust: str(s.trust) || "unknown", kind: str(s.kind) },
    ...(top ? { top: { id: str(top.id), score: num(top.score) ?? null } } : {}),
    ...(num(r.ms) !== undefined ? { ms: num(r.ms) } : {}),
    ...(num(r.tokens) !== undefined ? { tokens: num(r.tokens) } : {}),
    ...(str(r.error) ? { error: str(r.error) } : {}),
    ...(str(r.preview) ? { preview: str(r.preview) } : {}),
  };
}

/** 新的在前；首行可能被尾部截断，解析不了的行直接跳过 */
export function parseJevLog(text: string, limit = DEFAULT_LIMIT): { items: JevLogItem[]; stats: JevLogStats } {
  const judged: JevLogItem[] = [];
  const byId = new Map<string, JevLogItem>();
  for (const line of text.split("\n")) {
    let r: Raw;
    try {
      r = JSON.parse(line) as Raw;
    } catch {
      continue; // 空行 / 尾部截断的半行：跳过不影响其余记录
    }
    const action = str(r.action);
    if (action === "released" || action === "dropped") {
      const hit = byId.get(str(r.id));
      if (hit) Object.assign(hit, { action, ...(str(r.by) ? { by: str(r.by) } : {}), actedAt: str(r.ts) });
      continue;
    }
    const item = toItem(r);
    if (!item) continue;
    judged.push(item);
    if (item.id) byId.set(item.id, item);
  }
  const items = judged.slice(-limit).reverse();
  const count = (v: JevLogItem["verdict"]) => items.filter((i) => i.verdict === v).length;
  const timed = items.filter((i) => typeof i.ms === "number");
  const avgMs = timed.length ? Math.round(timed.reduce((a, i) => a + (i.ms ?? 0), 0) / timed.length) : null;
  return { items, stats: { total: items.length, pass: count("pass"), flag: count("flag"), block: count("block"), error: count("error"), avgMs } };
}

async function readTail(path: string): Promise<string> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return ""; // 还没有任何判定（从没开过守门）：空记录，不是错误
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

let logPath = GUARD_LOG_PATH;
/** 单测指到临时文件；生产不调 */
export function setJevLogPathForTest(p: string | undefined): void {
  logPath = p ?? GUARD_LOG_PATH;
}

export async function handleJevLog(req: Request, path: string, principal: Principal, url: URL): Promise<Response | null> {
  if (path !== "/jev/log" || req.method !== "GET") return null;
  if (!canManage(principal)) return forbidden("the Jev call log requires a credential with manage grant");
  const asked = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : DEFAULT_LIMIT;
  return apiJson(200, { ok: true, ...parseJevLog(await readTail(logPath), limit) });
}
