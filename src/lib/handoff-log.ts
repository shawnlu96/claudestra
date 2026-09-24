/**
 * 跨实例交接记录：谁找谁、多久有回复、成没成。给「这张协作网络到底有没有人在用、好不好用」留真实数据。
 *
 * 一次交接 = 一条 request + 一条结局（reply / fallback / error / timeout），id 相同：
 * - 入站（dir=in）：peer 的 token 调我们 agent 的 /messages（api-routes 登记，id = threadId）→ 我们的 agent
 *   reply（bridge deliverToApi）或回合结束没 reply、由 Stop 兜底（R3，记 fallback）
 * - 出站（dir=out）：我们 agent 的 send_to_agent → peer（http-peer 的 callId；拿到回复 / 失败 / 超时）
 * 落盘 STATE_DIR/handoffs.jsonl，append-only，与 metrics.jsonl 分开：那个是运维事件流、测试和噪声多，
 * 这个要长期留、能直接拿来算。**不存正文**，只存长度。
 * 开始时间放内存：bridge 重启后到的结局没有 ms，汇总时只算有 ms 的。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statePath } from "./paths.js";

type HandoffDir = "in" | "out";
export type HandoffEvent = "request" | "reply" | "fallback" | "error" | "timeout";

export interface HandoffRecord {
  ts: string;
  id: string;
  dir: HandoffDir;
  peer: string;
  localAgent: string;
  remoteAgent?: string;
  event: HandoffEvent;
  /** request 到结局的毫秒（结局事件、且 bridge 没重启过才有） */
  ms?: number;
  /** 请求 / 回复正文的字符数 */
  chars?: number;
  /** 失败类别（auth / network / target / http / no_thread …） */
  detail?: string;
}

const HANDOFF_PATH = statePath("handoffs.jsonl");

type Base = Pick<HandoffRecord, "dir" | "peer" | "localAgent" | "remoteAgent">;
const open = new Map<string, { at: number; base: Base }>();
/** 出站轮询最长 2h + 回执，入站 pending 也是 2h：超过 3h 还没结局的就不等了 */
const OPEN_TTL_MS = 3 * 3600_000;

async function append(rec: HandoffRecord, path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(rec) + "\n");
  } catch (e) {
    console.warn(`[handoff] 记录写入失败（不影响消息本身）: ${(e as Error).message}`);
  }
}

/** 交接开始：落一条 request，记下开始时间 */
export async function handoffStart(id: string, base: Base, chars?: number, path = HANDOFF_PATH): Promise<void> {
  const now = Date.now();
  for (const [k, v] of open) if (now - v.at > OPEN_TTL_MS) open.delete(k);
  open.set(id, { at: now, base });
  await append({ ts: new Date(now).toISOString(), id, ...base, event: "request", ...(chars !== undefined ? { chars } : {}) }, path);
}

/** 交接结局：只认开过的 id（同一个 id 只结一次）；不认识的 id 返回 false、不落盘 */
export async function handoffEnd(
  id: string,
  event: Exclude<HandoffEvent, "request">,
  extra: { chars?: number; detail?: string } = {},
  path = HANDOFF_PATH,
): Promise<boolean> {
  const o = open.get(id);
  if (!o) return false;
  open.delete(id);
  const now = Date.now();
  await append({ ts: new Date(now).toISOString(), id, ...o.base, event, ms: now - o.at, ...extra }, path);
  return true;
}

export async function readHandoffs(sinceMs: number, path = HANDOFF_PATH): Promise<HandoffRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return []; // 还没有任何交接：文件不存在
  }
  const out: HandoffRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as HandoffRecord;
      if (Date.parse(r.ts) >= sinceMs) out.push(r);
    } catch {
      /* 半行（写到一半断电之类）：跳过这一条，其余照算 */
    }
  }
  return out;
}

interface HandoffStats {
  /** 发起的交接数（request 条数） */
  total: number;
  in: number;
  out: number;
  /** 有正式回复的（reply；fallback 单算） */
  replied: number;
  fallback: number;
  failed: number;
  /** 从请求到回复的中位数 / p90 毫秒（只算有 ms 的 reply） */
  medianMs: number | null;
  p90Ms: number | null;
}

export interface HandoffSummary extends HandoffStats {
  sinceMs: number;
  byPeer: Array<HandoffStats & { peer: string }>;
}

function pct(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function statsOf(recs: HandoffRecord[]): HandoffStats {
  const req = recs.filter((r) => r.event === "request");
  const replies = recs.filter((r) => r.event === "reply");
  const ms = replies.map((r) => r.ms).filter((m): m is number => typeof m === "number").sort((a, b) => a - b);
  return {
    total: req.length,
    in: req.filter((r) => r.dir === "in").length,
    out: req.filter((r) => r.dir === "out").length,
    replied: replies.length,
    fallback: recs.filter((r) => r.event === "fallback").length,
    failed: recs.filter((r) => r.event === "error" || r.event === "timeout").length,
    medianMs: pct(ms, 0.5),
    p90Ms: pct(ms, 0.9),
  };
}

/** 按时间窗汇总（总计 + 每个 peer），给 Peer 面板顶部的一行数字 */
export function summarizeHandoffs(recs: HandoffRecord[], sinceMs: number): HandoffSummary {
  const inWin = recs.filter((r) => Date.parse(r.ts) >= sinceMs);
  const peers = [...new Set(inWin.map((r) => r.peer))];
  return {
    sinceMs,
    ...statsOf(inWin),
    byPeer: peers.map((peer) => ({ peer, ...statsOf(inWin.filter((r) => r.peer === peer)) })).sort((a, b) => b.total - a.total),
  };
}
