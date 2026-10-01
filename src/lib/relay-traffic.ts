/**
 * 中继上行流量账（bridge → 中继那条 WebSocket）：入站请求按「方法 + 去掉查询串的路径」聚合正文字节、帧数、取消 / 失败、
 * 状态码；长连接（SSE）跨窗口照记，每个窗口里的字节就是它这一分钟的量。心跳节拍上结算，窗口满 60 s 出一行，只在有入站流量时出。
 * 慢上行（跨境、丢包）上排队的是我们自己发的字节，这一行用来回答「是谁占满了上行」。不碰网络、不打日志——
 * 摘要字符串交给调用方（lib/relay-client.ts）记；路径里不留查询串，长随机段折成 :id，日志里不会出现 token / 短码。
 */

type TrafficOutcome = "ok" | "cancelled" | "lost" | "failed" | "broken";

export interface TrafficRecord {
  /** 发出去一帧响应正文（字节 = 解码后的正文，不含 base64 与帧头） */
  sent(bytes: number): void;
  /** 收尾；只认第一次（取消 / 断线会先于处理流程的收尾到达） */
  end(outcome: TrafficOutcome, status?: number): void;
}

interface PathAgg {
  n: number;
  bytes: number;
  frames: number;
  cancelled: number;
  failed: number;
  maxMs: number;
  codes: Map<number, number>;
}

interface Live {
  key: string;
  startedAt: number;
}

export interface TrafficOptions {
  windowMs: number;
  topN: number;
}

const DEFAULTS: TrafficOptions = { windowMs: 60_000, topN: 6 };
const QUIET_BYTES = 4096;

/**
 * 去查询串 / 片段；≥6 位纯数字、≥16 位且带数字 / 大小写混排 / 下划线的段（会话 id、交接口令、构建哈希）折成 :id：
 * 同类请求不散成几十行，可能的凭据也不进日志。agent 名是小写加连字符，留着——看的就是哪个会话在拉
 */
export function trafficPath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] || "/";
  const opaque = (s: string) => /^\d{6,}$/.test(s) || (s.length >= 16 && (/[\d_]/.test(s) || (/[A-Z]/.test(s) && /[a-z]/.test(s))));
  const segs = bare.split("/").map((s) => (opaque(s) ? ":id" : s));
  const out = segs.join("/");
  return out.length > 80 ? `${out.slice(0, 77)}...` : out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export class RelayTraffic {
  private aggs = new Map<string, PathAgg>();
  private readonly live = new Set<Live>();
  private windowStart: number;
  private wire = 0;
  private wireFrames = 0;
  private late = 0;
  private readonly o: TrafficOptions;

  constructor(private readonly now: () => number = Date.now, o: Partial<TrafficOptions> = {}) {
    this.o = { ...DEFAULTS, ...o };
    this.windowStart = now();
  }

  /** 每一帧上行（任何类型）的线上字节，含心跳、peer 请求 */
  onWire(bytes: number): void {
    this.wire += bytes;
    this.wireFrames++;
  }

  /** 中继回 unknown_request：这帧到时请求已经超时 / 被取消，字节白传了 */
  onLate(): void {
    this.late++;
  }

  open(method: string, path: string): TrafficRecord {
    const rec: Live = { key: `${method.toUpperCase()} ${trafficPath(path)}`, startedAt: this.now() };
    this.live.add(rec);
    this.agg(rec.key).n++;
    let done = false;
    return {
      sent: (bytes) => {
        if (done) return;
        const a = this.agg(rec.key);
        a.bytes += bytes;
        a.frames++;
      },
      end: (outcome, status) => {
        if (done) return;
        done = true;
        this.live.delete(rec);
        const a = this.agg(rec.key);
        a.maxMs = Math.max(a.maxMs, this.now() - rec.startedAt);
        if (outcome === "cancelled" || outcome === "lost") a.cancelled++;
        if (outcome === "failed" || outcome === "broken") a.failed++;
        if (status !== undefined && status >= 400) a.codes.set(status, (a.codes.get(status) ?? 0) + 1);
      },
    };
  }

  /** 窗口满了就出摘要（没有入站流量 → null，计数照样清零）；心跳节拍调它，不另开定时器 */
  tick(): string | null {
    return this.now() - this.windowStart >= this.o.windowMs ? this.flush() : null;
  }

  /** 立刻结算当前窗口（断线时调：断线前那段积压正是要看的） */
  flush(): string | null {
    const now = this.now();
    const secs = Math.max(1, Math.round((now - this.windowStart) / 1000));
    const aggs = this.aggs;
    const { wire, wireFrames, late } = this;
    this.aggs = new Map();
    this.windowStart = now;
    this.wire = this.wireFrames = this.late = 0;
    const openBy = new Map<string, number>();
    for (const l of this.live) openBy.set(l.key, (openBy.get(l.key) ?? 0) + 1);
    let body = 0, reqs = 0, cancelled = 0, failed = 0;
    for (const a of aggs.values()) {
      body += a.bytes;
      reqs += a.n;
      cancelled += a.cancelled;
      failed += a.failed;
    }
    // 只有长连接在发心跳（几个 SSE 每 5 s 一行注释）的分钟不出行：开着网页时每分钟都有，刷屏没信息量
    if (!reqs && !late && !cancelled && !failed && body < QUIET_BYTES) return null;
    const top = [...aggs.entries()].sort((x, y) => y[1].bytes - x[1].bytes).slice(0, this.o.topN).map(([k, a]) => item(k, a, openBy.get(k) ?? 0));
    const head = `上行 ${secs}s：ws ${fmtBytes(wire)}/${wireFrames} 帧（${fmtBytes(Math.round(wire / secs))}/s，含 base64 与帧头）；` +
      `入站正文 ${fmtBytes(body)}，新请求 ${reqs}（取消 ${cancelled}，失败 ${failed}），在途 ${this.live.size}；迟到帧 ${late}`;
    return top.length ? `${head} ｜ ${top.join(" · ")}` : head;
  }

  private agg(key: string): PathAgg {
    let a = this.aggs.get(key);
    if (!a) {
      a = { n: 0, bytes: 0, frames: 0, cancelled: 0, failed: 0, maxMs: 0, codes: new Map() };
      this.aggs.set(key, a);
    }
    return a;
  }
}

function item(key: string, a: PathAgg, open: number): string {
  const bits = [`×${a.n}`];
  if (open) bits.push(`在途${open}`);
  if (a.cancelled) bits.push(`取消${a.cancelled}`);
  if (a.failed) bits.push(`失败${a.failed}`);
  for (const [code, n] of a.codes) bits.push(`${code}×${n}`);
  if (a.maxMs >= 1000) bits.push(`最长${(a.maxMs / 1000).toFixed(1)}s`);
  return `${key} ${fmtBytes(a.bytes)}/${a.frames}帧（${bits.join(" ")}）`;
}
