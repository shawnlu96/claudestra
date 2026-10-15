/**
 * bridge 进程里唯一的 `manager list` 缓存：每次现起 `bun manager.ts list` 要 ~1.8s wall、~1.0s CPU，watcher 轮询、send_to_agent、
 * 网页 /agents 以前各起各的，空闲时也是一分钟十几个子进程。实例在 bridge/agent-lookup.ts，所有调用方经 management.runManager 取。
 * 规矩：并发读合成一次子进程；registry.json 一变（create / kill / rename 都写它）或显式 invalidate() 立刻作废；保底 TTL 兜 tmux 侧漂移。
 * 失败不缓存：调用方照旧经 agentsFromList / listAgentsStrict 判「不可用」（→ list_unavailable / 503）；只有同一 registry 版本、
 * 没被显式作废、拿到不满 LIST_STALE_FALLBACK_MS 的上一份好名单才顶上，绝不回空名单。
 */
import { statSync } from "node:fs";
import { REGISTRY_PATH } from "./registry.js";

/**
 * 保底缓存期。名单结构变化（增删改名、重启）靠 registry 指纹 + 写命令后的显式作废，TTL 只兜 tmux 侧的漂移（窗口自己死了、idle 位）。
 * 30s = 空闲时每分钟最多两次子进程（规格验收 4 ≤ 2）；调短子进程数回升，调长「窗口自己死了」在名单上晚得更久。
 */
export const LIST_CACHE_TTL_MS = 30_000;

/** 子进程失败（超时 / 崩溃）时上一份好名单能顶多久（从拿到时算）。超了照报不可用；窗口内名单最多和 TTL 再晚 30s */
export const LIST_STALE_FALLBACK_MS = 60_000;

/** registry.json 的版本指纹：写入走 tmp+rename，mtime / size / inode 任一变就当新版本。读不到 stat 也是一个版本（"missing"） */
export function registryVersion(path = REGISTRY_PATH): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}:${s.ino}`;
  } catch {
    return "missing"; // 文件还没建 / 正被替换：照样能比较，变回存在时版本不同、自然重读
  }
}

export interface ListCacheOpts<T> {
  /** 原始 list 调用（生产 = runManagerProcess(["list"])），返回 manager 的 {ok, agents} */
  list: () => Promise<T>;
  /** 外部状态版本（生产 = registryVersion），变了就不用旧结果 */
  version?: () => string;
  ttlMs?: number;
  staleMs?: number;
  now?: () => number;
}

export interface ListCache<T> {
  /** manager list 的原始输出（形如 {ok, agents}；抛错原样抛）。每次交出深拷贝，调用方随便改不会串到别人 */
  result(): Promise<T>;
  /** 写命令（create / kill / restart / rename…）跑完后调：丢掉缓存和兜底，在途的子进程结果也不再落缓存 */
  invalidate(): void;
}

export function createListCache<T>(opts: ListCacheOpts<T>): ListCache<T> {
  const ttl = opts.ttlMs ?? LIST_CACHE_TTL_MS;
  const staleMs = opts.staleMs ?? LIST_STALE_FALLBACK_MS;
  const now = opts.now ?? Date.now;
  const version = opts.version ?? (() => registryVersion());
  let gen = 0; // 显式作废的代数：作废前发起的子进程，结果不落缓存、不给作废后的读搭车
  let entry: { at: number; version: string; gen: number; result: T } | null = null;
  let inflight: { version: string; gen: number; p: Promise<T> } | null = null;

  const fallback = (v: string, g: number): T | null => (entry && entry.version === v && entry.gen === g && now() - entry.at < staleMs ? entry.result : null);

  function raw(): Promise<T> {
    const v = version();
    const g = gen;
    if (entry && entry.version === v && entry.gen === g && now() - entry.at < ttl) return Promise.resolve(entry.result);
    if (inflight && inflight.version === v && inflight.gen === g) return inflight.p; // registry 途中变了 / 被作废了就不搭旧车
    const p = opts.list()
      .then(
        (result) => {
          if (!isUsableList(result)) return fallback(v, g) ?? result;
          if (gen === g) entry = { at: now(), version: v, gen: g, result }; // 版本是发起时的，registry 途中变了下次自然重读
          return result;
        },
        (e: unknown) => {
          const f = fallback(v, g);
          if (f) return f;
          throw e;
        },
      )
      .finally(() => {
        if (inflight?.p === p) inflight = null;
      });
    inflight = { version: v, gen: g, p };
    return p;
  }

  return {
    result: () => raw().then((r) => structuredClone(r)),
    invalidate() {
      gen++;
      entry = null;
      inflight = null;
    },
  };
}

/** 判据与 run-manager.ts agentsFromList 的成功条件一致：{ok:false} / 缺 agents 数组都不算能用 */
function isUsableList(result: unknown): boolean {
  const r = result as { ok?: unknown; agents?: unknown } | null;
  return !!r && r.ok !== false && Array.isArray(r.agents);
}
