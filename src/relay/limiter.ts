/** 滑动窗口计数（docs/relay/protocol.md §3.4、§4）。每个配额一个实例，内存里最多 limit 个时间戳 */
export class SlidingWindow {
  private hits: number[] = [];
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  tryAcquire(now = Date.now()): boolean {
    const floor = now - this.windowMs;
    while (this.hits.length && this.hits[0] <= floor) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  /** 窗口里已经没有命中：这个窗口可以被丢掉 */
  idle(now = Date.now()): boolean {
    return !this.hits.some((t) => t > now - this.windowMs);
  }
}

/** 按键（IP、指纹）各一个窗口；不活跃的键定期清掉，免得握手洪水把 Map 撑大 */
export class KeyedWindows {
  private readonly map = new Map<string, SlidingWindow>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  tryAcquire(key: string, now = Date.now()): boolean {
    let w = this.map.get(key);
    if (!w) this.map.set(key, (w = new SlidingWindow(this.limit, this.windowMs)));
    return w.tryAcquire(now);
  }

  sweep(now = Date.now()): void {
    for (const [k, w] of this.map) if (w.idle(now)) this.map.delete(k);
  }
}
