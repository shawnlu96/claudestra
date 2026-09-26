/**
 * 在途请求表（docs/relay/protocol.md §3.4）。一条 pending = 发起方 + 接收方 + id，两种来源：
 *   - peer：发起方是另一台实例的连接（fromConn），键 `${发起方指纹}|${id}`；
 *   - 隧道：发起方是中继自己替浏览器发的（fromConn 为 null，from = "relay"），响应交给 waiter 回调。
 * 生命周期：head（等 res 头，timeoutMs）→ stream（res.more 之后等 data / end，空闲 streamIdleMs、总长 streamMaxMs）→ 完成。
 * 任一方断线就把涉及它的 pending 全清掉：不缓存、不重传，与直连 HTTP 断线是同一种失败。
 */
import type { ResFrame } from "../lib/relay-protocol.js";

/** 隧道请求的接收端：中继 front 把 res / data / end / 失败翻译成浏览器那边的 Response 与流 */
interface FrontWaiter {
  head(res: ResFrame): void;
  data(bytes: Uint8Array): void;
  end(): void;
  fail(code: string, message?: string): void;
}

export interface Pending<C> {
  key: string;
  id: string;
  from: string;
  to: string;
  fromConn: C | null;
  toConn: C;
  waiter?: FrontWaiter;
  state: "head" | "stream";
  startedAt: number;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
  handlers: PendingHandlers<C>;
}

export interface PendingHandlers<C> {
  /** head 阶段超过 timeoutMs 没有 res */
  onTimeout(p: Pending<C>): void;
  /** stream 阶段空闲超过 streamIdleMs，或总长超过 streamMaxMs */
  onStreamTimeout(p: Pending<C>, why: "stream_idle" | "stream_max"): void;
}

export interface RouterLimits {
  streamIdleMs: number;
  streamMaxMs: number;
}

export class Router<C> {
  private readonly pending = new Map<string, Pending<C>>();

  constructor(private readonly limits: RouterLimits) {}

  get size(): number {
    return this.pending.size;
  }

  private static key(from: string, id: string): string {
    return `${from}|${id}`;
  }

  has(from: string, id: string): boolean {
    return this.pending.has(Router.key(from, id));
  }

  get(from: string, id: string): Pending<C> | null {
    return this.pending.get(Router.key(from, id)) ?? null;
  }

  /** 某连接作为发起方在飞的请求数（每连接 64） */
  inflightOf(conn: C): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.fromConn === conn) n++;
    return n;
  }

  add(p: Pick<Pending<C>, "id" | "from" | "to" | "fromConn" | "toConn" | "waiter">, timeoutMs: number, h: PendingHandlers<C>): Pending<C> {
    const key = Router.key(p.from, p.id);
    const now = Date.now();
    const full: Pending<C> = {
      ...p,
      key,
      state: "head",
      startedAt: now,
      lastActivity: now,
      handlers: h,
      timer: setTimeout(() => {
        if (this.remove(full)) h.onTimeout(full);
      }, timeoutMs),
    };
    this.pending.set(key, full);
    return full;
  }

  /** res 头到了但正文还在流（res.more）：换成空闲计时 + 总长计时 */
  headArrived(p: Pending<C>): void {
    const h = p.handlers;
    clearTimeout(p.timer);
    p.state = "stream";
    p.lastActivity = Date.now();
    p.timer = setTimeout(() => this.idleCheck(p, h), this.limits.streamIdleMs);
    p.maxTimer = setTimeout(() => {
      if (this.remove(p)) h.onStreamTimeout(p, "stream_max");
    }, this.limits.streamMaxMs);
  }

  private idleCheck(p: Pending<C>, h: PendingHandlers<C>): void {
    const left = this.limits.streamIdleMs - (Date.now() - p.lastActivity);
    if (left > 50) {
      p.timer = setTimeout(() => this.idleCheck(p, h), left);
      return;
    }
    if (this.remove(p)) h.onStreamTimeout(p, "stream_idle");
  }

  /** 流上有 data 经过：刷新空闲时间（计时器到点时再看，不每帧重设 timer） */
  activity(p: Pending<C>): void {
    p.lastActivity = Date.now();
  }

  /** 完成（res 无 more、end、cancel、error）：从表里拿掉并停掉计时 */
  remove(p: Pending<C>): boolean {
    if (!this.pending.delete(p.key)) return false;
    clearTimeout(p.timer);
    if (p.maxTimer) clearTimeout(p.maxTimer);
    return true;
  }

  /** 连接断了：清掉它作为发起方或接收方的全部 pending，交给调用方通知另一头 */
  dropConn(conn: C): Pending<C>[] {
    const out: Pending<C>[] = [];
    for (const p of [...this.pending.values()]) {
      if (p.fromConn !== conn && p.toConn !== conn) continue;
      this.remove(p);
      out.push(p);
    }
    return out;
  }

  clear(): void {
    for (const p of [...this.pending.values()]) this.remove(p);
  }
}
