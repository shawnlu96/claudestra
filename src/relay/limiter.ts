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

/**
 * 反代之后的客户端地址：X-Forwarded-For 从右往左数第 hops 项（hops = 受信反代的层数，RELAY_TRUST_PROXY）。
 * 每层反代把它看到的对端追加在最右，更左边的是客户端自己写的，取最左一项等于让客户端自报地址、按 IP 的限额形同虚设。
 * 项数不到 hops（请求没经过全部受信层，或层数配多了）时最左那项可能是客户端写的，不认，和 hops 为 0、没有这个头一样
 * 返回 undefined（用连接对端，最坏是一群人共用反代的地址、限流偏严）。
 */
export function forwardedClientIp(xff: string | null | undefined, hops: number): string | undefined {
  if (hops <= 0 || !xff) return undefined;
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length >= hops ? parts[parts.length - hops] : undefined;
}

/**
 * 按 IP 计数的配额用的键：IPv6 取前 64 位（一台设备通常分到整段 /64，逐地址计数换个后缀就是新桶），
 * IPv4 与 IPv4 映射地址按原样的 IPv4；反代写成带端口的（`1.2.3.4:5678`、`[v6]:443`）去掉端口，不然每换一个源端口就是新桶。
 * 认不出的写法原样返回，只会更严不会合并别人。
 */
export function ipLimitKey(ip: string): string {
  const raw = ip.trim().toLowerCase();
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw) ?? /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  const s = (withPort ? withPort[1] : raw).replace(/%.*$/, "");
  if (!s.includes(":")) return s;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1];
  const halves = s.split("::");
  if (halves.length > 2) return s;
  const groups = (h: string) => (h ? h.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  const top = all.slice(0, 4);
  if (all.length !== 8 || top.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${top.map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
