/**
 * /api/v1 的限速桶（bridge/api-auth.ts 在验签、防重放之后调）：选桶、按容量扣次数、429 记日志。
 * owner 本人的所有设备共用 owner:self 一个桶，容量固定 600——和这次请求来自满权设备还是受限设备（effectivePrincipal
 * 把 role 降成 external）无关；以前按「第一个请求」的 role 定容量，受限设备先到就把整个 owner 锁在 120。
 * 其他 principal（peer token、普通 token、guest 设备）的 key 和容量与原来一样：key = tokenIdOf，owner 角色 600、其余 120。
 * 已有桶容量和算出来的不一致时就地改容量，窗口内已计的次数保留（tests/api-rate-bucket.test.ts）。
 */
import { tokenIdOf, type Principal } from "./principals.js";
import { OWNER_PRINCIPAL_ID } from "./devices.js";
import { ApiRejectCounter, cachedRejectPolicy, type ApiRejectCounterOptions } from "./api-rate-reject-counter.js";

// 120/min：默认 30 在 web 重度使用下会被打爆——SSE 重连风暴循环触发 429 → 直播流死掉（2026-07-14 真机）。owner 再放大 5 倍：
// 手机 + 电脑 + 侧栏轮询共用一个身份
export const API_RATE_LIMIT_PER_MIN = 120;
const OWNER_RATE_LIMIT_PER_MIN = 600;
const WINDOW_MS = 60_000;
const LOG_EVERY_MS = 60_000;

/**
 * 选桶。传降级前的 principal 或 effectivePrincipal 都行：owner:self 只看 id（降级不改 id），
 * 其余照原来的口径（key 不变、容量按 role）。
 */
export function apiRateBucket(p: Principal): { key: string; limit: number } {
  if (p.id === OWNER_PRINCIPAL_ID) return { key: tokenIdOf(p), limit: OWNER_RATE_LIMIT_PER_MIN };
  return { key: tokenIdOf(p), limit: p.role === "owner" ? OWNER_RATE_LIMIT_PER_MIN : API_RATE_LIMIT_PER_MIN };
}

/** 日志里的身份：只给类别和人类可读名，不给 token / token id / 设备 id */
function rateWho(p: Principal): string {
  if (p.id === OWNER_PRINCIPAL_ID) return "owner";
  if (p.peer) return `peer:${p.peer}`;
  return `token:${p.name || "unnamed"}`;
}

/**
 * 路由模板：只留 /api/v1 下的路径，查询串丢掉；像 id 的段（带数字、大写、下划线、转义或过长）换成 :id，
 * token id、设备 id 这类随机串不会原样进日志
 */
export function routeTemplate(pathname: string): string {
  const path = pathname.split("?")[0]!;
  const rest = path.startsWith("/api/v1/") ? path.slice("/api/v1/".length) : path;
  const segs = rest.split("/").filter(Boolean).map((s) => (/^[a-z]+(?:[.-][a-z]+)*$/.test(s) && s.length <= 32 ? s : ":id"));
  return (rest === path ? "/" : "/api/v1/") + segs.join("/");
}

/** 滑动窗口：容量可调，调的时候窗口内已计的次数不动；被拒的次数另记，只用于日志里的 n */
export class ApiRateBucket {
  private hits: number[] = [];
  private rejects: ApiRejectCounter;
  lastLogAt = Number.NEGATIVE_INFINITY;
  constructor(public limit: number, options?: ApiRejectCounterOptions) { this.rejects = new ApiRejectCounter(options); }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.hits.length > 0 && this.hits[0]! <= cutoff) this.hits.shift();
  }

  tryAcquire(now: number): boolean {
    this.prune(now);
    if (this.hits.length >= this.limit) {
      this.rejects.update(now, true);
      return false;
    }
    this.hits.push(now);
    this.rejects.prune(now);
    return true;
  }

  /** 窗口内已放行的次数 */
  used(now: number): number {
    this.prune(now);
    this.rejects.prune(now);
    return this.hits.length;
  }

  /** 放行滑窗 + 拒绝诊断；on 的拒绝部分为 60 个一秒桶，可提前不足 1 秒过期，切结构时重新计数 */
  attempts(now: number): number {
    this.prune(now);
    return this.hits.length + this.rejects.update(now);
  }
}

export interface ApiRateLimiter {
  /** 扣一次。放行返回 null；超限返回桶的实际容量（429 文案用），并按桶每分钟最多记一行日志 */
  charge(p: Principal, pathname: string, now?: number): { limit: number } | null;
  buckets: Map<string, ApiRateBucket>;
}

export function createApiRateLimiter(log: (line: string) => void = (line) => console.warn(line), options?: ApiRejectCounterOptions): ApiRateLimiter {
  const buckets = new Map<string, ApiRateBucket>();
  const shared = { ...options, policy: cachedRejectPolicy(options) };
  return {
    buckets,
    charge(p, pathname, now = Date.now()) {
      const { key, limit } = apiRateBucket(p);
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = new ApiRateBucket(limit, { ...shared, target: key })));
      else if (bucket.limit !== limit) bucket.limit = limit; // 旧容量（如被锁在 120 的 owner 桶）就地调整，不清零
      if (bucket.tryAcquire(now)) return null;
      if (now - bucket.lastLogAt >= LOG_EVERY_MS) {
        bucket.lastLogAt = now;
        log(`[api-rate] 429 who=${rateWho(p)} path=${routeTemplate(pathname)} n=${bucket.attempts(now)} limit=${bucket.limit}`);
      }
      return { limit: bucket.limit };
    },
  };
}
