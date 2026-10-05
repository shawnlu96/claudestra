/**
 * GET /api/v1/agents 的会话尾读：全局有界并发 + 同键进行中复用 + 短缓存（agents-list-route.ts 调用）。
 * 并发预算是模块级的：几个客户端同时冷请求也只共用 8 路、同一个会话只读一次；按调用各开一组 lane 的话
 * N 个冷请求会并起 8N 路、同一批文件重复读 N 遍。缓存键 = 名字 + 运行时 + cwd + sessionId：换会话立即失效；
 * 值只有尾部解析结果，不含任何授权判断（scope 由调用方先筛，这里拿到的都是已放行的目标）。
 * 读失败记日志、值记 null：字段显示 unknown，不编 0 / 空；同键在缓存 TTL 内不会再读，日志也就不会刷屏。
 */
import { constants as fsConstants, accessSync, statSync } from "node:fs";
import { findSessionJsonlBySessionId, sessionJsonlPath } from "../lib/session-source.js";
import { sessionTailInfo, type SessionTailInfo } from "../lib/session-tail.js";

export interface TailTarget {
  name: string;
  runtime?: string;
  cwd: string;
  sessionId: string;
  /** 推不出路径时按 id 全库找（Codex 的 rollout）。已停的出借 worker 不该走到这里：几百个的全库扫描正是故障根因 */
  findById?: boolean;
}

export interface TailIo {
  resolve: (t: TailTarget) => string | null;
  read: (path: string) => Promise<SessionTailInfo | null>;
  now: () => number;
  warn: (msg: string) => void;
}

/** 同时在读的会话文件数（全局）：超过磁盘并发收益很小，太小又回到串行（tests/api-agents-list-recovery.test.ts 同值） */
const TAIL_CONCURRENCY = 8;
/** 短缓存：侧栏轮询 / 多端同时刷新共用一次读；比它长会让 ctx 徽章明显滞后 */
const TAIL_CACHE_TTL_MS = 3_000;
const MAX_ENTRIES = 4_000;

interface CacheEntry {
  at: number;
  info: SessionTailInfo | null;
}

const cache = new Map<string, CacheEntry>();
/** 同键正在读的 Promise：并发冷请求复用同一次读，而不是各读一遍 */
const inflight = new Map<string, Promise<SessionTailInfo | null>>();

const tailCacheKey = (t: TailTarget): string => [t.name, t.runtime ?? "", t.cwd, t.sessionId].join("\u0000");

const isAbsent = (e: unknown): boolean => (e as { code?: string }).code === "ENOENT" || (e as { code?: string }).code === "ENOTDIR";

/**
 * lib/session-tail.ts 把所有文件错误吞成 null（改它不在本卡范围）。这里对 null 补一次 stat，把「文件不存在」
 * （已归档 / 清理过的会话，列表里的正常状态，不记）和「存在却读不了」（目录 / 无权限 / 读错）分开，
 * 后者抛给 readOne 记日志——否则生产里的读失败永远到不了外层的 catch。
 */
async function readTailOrThrow(path: string): Promise<SessionTailInfo | null> {
  const info = await sessionTailInfo(path);
  if (info) return info;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (e) {
    if (isAbsent(e)) return null;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${path} 不是普通文件`);
  accessSync(path, fsConstants.R_OK);
  throw new Error(`${path} 存在且可读，但读取失败（具体错误被 lib/session-tail.ts 吞掉）`);
}

const defaultTailIo: TailIo = {
  resolve: (t) => sessionJsonlPath(t.runtime, t.cwd, t.sessionId) ?? (t.findById ? findSessionJsonlBySessionId(t.runtime, t.sessionId) : null),
  read: readTailOrThrow,
  now: () => Date.now(),
  warn: (msg) => console.warn(msg),
};

// 全局读槽：release 时把槽直接交给排队者（不先减再加），两个 acquire 抢同一个空槽时才不会超出上限
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (active < TAIL_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function evictExpired(now: number, ttl: number): void {
  if (cache.size < MAX_ENTRIES) return;
  for (const [k, v] of cache) if (now - v.at >= ttl) cache.delete(k);
  // 仍然太多（TTL 内就有几千个不同会话）：按插入顺序丢最旧的一半，缓存只是省读、不是真相
  if (cache.size >= MAX_ENTRIES) for (const k of [...cache.keys()].slice(0, cache.size >> 1)) cache.delete(k);
}

async function readUncached(t: TailTarget, io: TailIo, key: string, now: number, ttl: number): Promise<SessionTailInfo | null> {
  let info: SessionTailInfo | null = null;
  await acquire();
  try {
    const path = io.resolve(t);
    info = path ? await io.read(path) : null;
  } catch (e) {
    // 坏文件 / 读失败：字段降级为 unknown（null），不猜 0；缓存记下 null，TTL 内不再重读也不再记
    io.warn(`⚠️ [agents-list] ${t.name} 会话尾读失败（字段按 unknown 显示）: ${(e as Error).message}`);
  } finally {
    release();
    inflight.delete(key);
  }
  evictExpired(now, ttl);
  cache.set(key, { at: now, info });
  return info;
}

function readOne(t: TailTarget, io: TailIo, ttl: number): Promise<SessionTailInfo | null> {
  const key = tailCacheKey(t);
  const now = io.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return Promise.resolve(hit.info);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = readUncached(t, io, key, now, ttl);
  inflight.set(key, p);
  return p;
}

/**
 * 读一批目标的会话尾，返回 name → 尾信息（没有文件 / 读失败 → null，调用方照 unknown 展示）。
 * 同名目标只读一次（同一请求里活列表与 stopped 列表不会重叠，但调用方不必保证）。
 */
export async function readSessionTails(targets: TailTarget[], io: TailIo = defaultTailIo): Promise<Map<string, SessionTailInfo | null>> {
  const uniq = new Map<string, TailTarget>();
  for (const t of targets) if (!uniq.has(t.name)) uniq.set(t.name, t);
  const infos = await Promise.all([...uniq.values()].map((t) => readOne(t, io, TAIL_CACHE_TTL_MS)));
  return new Map([...uniq.keys()].map((name, i) => [name, infos[i] ?? null]));
}
