/**
 * 拒绝类日志的节流：每个 key 每分钟最多一行，下一行附上这期间被压下的条数。能被外部连发触发的日志（坏签名、非联系人帧）
 * 都走它，否则对方连发就能刷满 bridge 的 launchd 日志。key 数有上限：超了之后新 key 一律记在同一个溢出 key 下，
 * 多开身份绕不过节流（tests/log-throttle.test.ts）。
 */
export const OVERFLOW_KEY = "(其余来源)";

export class LogThrottle {
  private readonly last = new Map<string, { at: number; muted: number }>();
  constructor(private readonly everyMs = 60_000, private readonly maxKeys = 64) {}

  /** 这一条该打就返回之前被压下的条数（0 起）与实际用的 key；不该打返回 null */
  take(key: string, now = Date.now()): { key: string; muted: number } | null {
    if (!this.last.has(key) && this.last.size >= this.maxKeys) {
      for (const [k, v] of this.last) if (now - v.at >= this.everyMs) this.last.delete(k);
      if (this.last.size >= this.maxKeys) key = OVERFLOW_KEY;
    }
    const log = this.last.get(key);
    if (log && now - log.at < this.everyMs) {
      log.muted++;
      return null;
    }
    this.last.set(key, { at: now, muted: 0 });
    return { key, muted: log?.muted ?? 0 };
  }
}
