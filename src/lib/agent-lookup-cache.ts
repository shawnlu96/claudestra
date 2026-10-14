/**
 * bridge 按名字找 agent / 列 agent 时用的 `manager list` 短缓存：每次现起 `bun manager.ts list` 要 ~1.8s wall、~1.0s CPU，
 * 网页每个会话轮询 /pending 都起一个，就是 bridge CPU 常驻高位、消息同步慢的来源（tests/api-routes-agent-lookup.test.ts）。
 * 三条规矩：并发的请求合成一次子进程；结果最多用 LIST_CACHE_TTL_MS；registry.json 一变（create / kill / rename 都写它）立刻作废。
 * 失败不缓存：缓存的是 manager 的原始输出，调用方照旧经 listAgentsStrict 判失败（→ 503，错误文字不变），下一次请求重新起子进程。
 */
import { statSync } from "node:fs";
import { REGISTRY_PATH } from "./registry.js";

/** 缓存期上限（规格 ≤ 3s）。从结果拿到时算起；调长会让「刚起来 / 刚停的窗口」在网页上晚一拍 */
export const LIST_CACHE_TTL_MS = 3_000;

/** registry.json 的版本指纹：写入走 tmp+rename，mtime / size / inode 任一变就当新版本。读不到 stat 也是一个版本（"missing"） */
export function registryVersion(path = REGISTRY_PATH): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "missing"; // 文件还没建 / 正被替换：照样能比较，变回存在时版本不同、自然重读
  }
}

export interface ListCacheOpts {
  /** 原始 list 调用（生产 = runManager("list")），返回 manager 的 {ok, agents} */
  list: () => Promise<unknown>;
  /** 外部状态版本（生产 = registryVersion），变了就不用旧结果 */
  version?: () => string;
  ttlMs?: number;
  now?: () => number;
}

export interface ListCache {
  /** manager list 的原始输出（形如 {ok, agents}；抛错原样抛）。成功的结果在调用方之间共享，只读 */
  result(): Promise<unknown>;
}

export function createListCache(opts: ListCacheOpts): ListCache {
  const ttl = Math.min(opts.ttlMs ?? LIST_CACHE_TTL_MS, LIST_CACHE_TTL_MS);
  const now = opts.now ?? Date.now;
  const version = opts.version ?? (() => registryVersion());
  let entry: { at: number; version: string; result: unknown } | null = null;
  let inflight: { version: string; p: Promise<unknown> } | null = null;

  return {
    result() {
      const v = version();
      if (entry && entry.version === v && now() - entry.at < ttl) return Promise.resolve(entry.result);
      if (inflight && inflight.version === v) return inflight.p; // registry 在途中变了就不搭旧车
      const p = opts.list()
        .then((result) => {
          if (isUsableList(result)) entry = { at: now(), version: v, result }; // 失败不落缓存；版本是发起时的，registry 途中变了下次自然重读
          return result;
        })
        .finally(() => {
          if (inflight?.p === p) inflight = null;
        });
      inflight = { version: v, p };
      return p;
    },
  };
}

/** 判据与 run-manager.ts agentsFromList 的成功条件一致：{ok:false} / 缺 agents 数组都不算能用 */
function isUsableList(result: unknown): boolean {
  const r = result as { ok?: unknown; agents?: unknown } | null;
  return !!r && r.ok !== false && Array.isArray(r.agents);
}
