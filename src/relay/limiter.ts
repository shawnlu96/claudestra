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

/** 认不出的地址写法共用的限流键 */
const UNPARSED_IP_KEY = "(unparsed)";

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseV4(s: string): number[] | null {
  const m = V4_RE.exec(s);
  const o = m ? m.slice(1).map(Number) : null;
  return o && o.every((n) => n <= 255) ? o : null;
}

/** IPv6 文本 → 8 个 16 位组（末尾可带点分 IPv4）；写法不合法返回 null */
function parseV6(s: string): number[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string): number[] | null => {
    const out: number[] = [];
    const parts = h ? h.split(":") : [];
    for (const [i, g] of parts.entries()) {
      const v4 = i === parts.length - 1 && g.includes(".") ? parseV4(g) : null;
      if (v4) out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      else if (/^[0-9a-f]{1,4}$/.test(g)) out.push(parseInt(g, 16));
      else return null;
    }
    return out;
  };
  const head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...Array<number>(fill).fill(0), ...tail] : null;
}

/** 内嵌 IPv4 的 IPv6（::ffff:0:0/96、::ffff:0:0:0/96、64:ff9b::/96、::/96）→ 那个 IPv4；不是返回 null */
function embeddedV4(g: number[]): string | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = (zero(0, 5) && g[5] === 0xffff) || (zero(0, 4) && g[4] === 0xffff && g[5] === 0) ||
    (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) || zero(0, 6);
  return embedded ? [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".") : null;
}

/**
 * 按 IP 计数的配额用的键：IPv6 取前 64 位（一台设备通常分到整段 /64，逐地址计数换个后缀就是新桶）；
 * IPv4 与各种内嵌 IPv4 的 IPv6 写法（映射、NAT64、兼容地址）按那个 IPv4，否则 NAT64 后面所有 IPv4 客户端会挤进一个 /64 桶；
 * 反代写成带端口的（`1.2.3.4:5678`、`[v6]:443`）去掉端口，不然每换一个源端口就是新桶。
 * 认不出的写法一律归 UNPARSED_IP_KEY 共用一个桶：原样当键的话每换一种写法就是新桶，等于绕开限额。
 */
export function ipLimitKey(ip: string): string {
  const raw = ip.trim().toLowerCase();
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(raw) ?? /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  const s = (withPort ? withPort[1] : raw).replace(/%.*$/, "");
  const v4 = parseV4(s);
  if (v4) return v4.join(".");
  const g = s.includes(":") ? parseV6(s) : null;
  if (!g) return UNPARSED_IP_KEY;
  return embeddedV4(g) ?? `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
