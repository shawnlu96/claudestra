/**
 * GET /api/v1/agents 的会话尾读：有界并发 + 短缓存（agents-list-route.ts 调用）。
 * 197 个会话逐个 await 尾读要 27–45s，网页 5s 就超时；同一秒内几个客户端轮询又各自重读一遍。
 * 缓存键 = 名字 + 运行时 + cwd + sessionId：换会话立即失效；值只有尾部解析结果，不含任何授权判断
 * （scope 由调用方先筛，这里拿到的都是已放行的目标）。读失败记日志（同键 TTL 内一次）、值记 null：
 * 字段显示 unknown，不编 0 / 空。
 */
import { findSessionJsonlBySessionId, sessionJsonlPath } from "../lib/session-source.js";
import { sessionTailInfo, type SessionTailInfo } from "../lib/session-tail.js";

export interface TailTarget {
  name: string;
  runtime?: string;
  cwd: string;
  sessionId: string;
  /** 推不出路径时按 id 全库找（Codex 的 rollout）：只给活会话；已停会话的全库扫描正是故障根因 */
  findById?: boolean;
}

export interface TailIo {
  resolve: (t: TailTarget) => string | null;
  read: (path: string) => Promise<SessionTailInfo | null>;
  now: () => number;
  warn: (msg: string) => void;
}

/** 同时在读的会话文件数：超过磁盘并发收益很小，太小又回到串行（tests/api-agents-list-recovery.test.ts 同值） */
const TAIL_CONCURRENCY = 8;
/** 短缓存：侧栏轮询 / 多端同时刷新共用一次读；比它长会让 ctx 徽章明显滞后 */
const TAIL_CACHE_TTL_MS = 3_000;
const MAX_ENTRIES = 4_000;

interface CacheEntry {
  at: number;
  info: SessionTailInfo | null;
}

const cache = new Map<string, CacheEntry>();
/** 失败日志的节流：同键在 TTL 内只记一次（400 条会话坏一片时不刷屏） */
const warned = new Map<string, number>();

const tailCacheKey = (t: TailTarget): string => [t.name, t.runtime ?? "", t.cwd, t.sessionId].join("\u0000");

const defaultTailIo: TailIo = {
  resolve: (t) => sessionJsonlPath(t.runtime, t.cwd, t.sessionId) ?? (t.findById ? findSessionJsonlBySessionId(t.runtime, t.sessionId) : null),
  read: (path) => sessionTailInfo(path),
  now: () => Date.now(),
  warn: (msg) => console.warn(msg),
};

function evictExpired(now: number, ttl: number): void {
  if (cache.size < MAX_ENTRIES) return;
  for (const [k, v] of cache) if (now - v.at >= ttl) cache.delete(k);
  // 仍然太多（TTL 内就有几千个不同会话）：按插入顺序丢最旧的一半，缓存只是省读、不是真相
  if (cache.size >= MAX_ENTRIES) for (const k of [...cache.keys()].slice(0, cache.size >> 1)) cache.delete(k);
}

async function readOne(t: TailTarget, io: TailIo, ttl: number): Promise<SessionTailInfo | null> {
  const key = tailCacheKey(t);
  const now = io.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return hit.info;
  let info: SessionTailInfo | null = null;
  try {
    const path = io.resolve(t);
    info = path ? await io.read(path) : null;
  } catch (e) {
    // 坏文件 / 读失败：字段降级为 unknown（null），不猜 0；日志按键节流，免得坏一片时每次轮询都刷
    if ((warned.get(key) ?? -Infinity) + ttl <= now) {
      warned.set(key, now);
      io.warn(`⚠️ [agents-list] ${t.name} 会话尾读失败（字段按 unknown 显示）: ${(e as Error).message}`);
    }
  }
  evictExpired(now, ttl);
  cache.set(key, { at: now, info });
  return info;
}

/** 有界并发跑完 items（每个 worker 顺序取下一个），任一项的异常由 fn 自己兜住 */
async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(lanes);
}

/**
 * 读一批目标的会话尾，返回 name → 尾信息（没有文件 / 读失败 → null，调用方照 unknown 展示）。
 * 同名目标只读一次（同一请求里活列表与 stopped 列表不会重叠，但调用方不必保证）。
 */
export async function readSessionTails(
  targets: TailTarget[],
  io: TailIo = defaultTailIo,
  opts: { concurrency?: number; ttlMs?: number } = {},
): Promise<Map<string, SessionTailInfo | null>> {
  const out = new Map<string, SessionTailInfo | null>();
  const uniq = new Map<string, TailTarget>();
  for (const t of targets) if (!uniq.has(t.name)) uniq.set(t.name, t);
  await runBounded([...uniq.values()], opts.concurrency ?? TAIL_CONCURRENCY, async (t) => {
    out.set(t.name, await readOne(t, io, opts.ttlMs ?? TAIL_CACHE_TTL_MS));
  });
  return out;
}
