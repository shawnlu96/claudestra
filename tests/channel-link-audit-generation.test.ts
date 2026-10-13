/**
 * hardening-LINKGEN1（审计 A14-04）：channel-server 的 bridge 链路单飞 + 按代次隔离回调。
 * 30s fallback 与迟到的 MCP initialized 都走 connect()；旧 socket / 旧 timer 的迟到回调不能擦掉新一代的
 * registered / 请求队列 / keepalive，也不能再发起一代。全部用假 socket + 假时钟，不碰网络。
 */
import { describe, expect, test } from "bun:test";
import { ChannelLink, GRACE_QUEUE_MS, KEEPALIVE_MS, STABLE_HOLD_MS, type LinkSocket, type LinkTimers } from "../src/lib/channel-link-generation.ts";
import { shouldConnectBridge } from "../src/lib/channel-mode.ts";

class FakeSocket implements LinkSocket {
  readyState = 0;
  sent: any[] = [];
  closedByUs: number | null = null;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.closedByUs = code; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  /** 对端 / 网络关闭：真 WebSocket 会依次 onerror（异常时）→ onclose。 */
  drop(code = 1006, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
  fail() { this.readyState = 3; this.onerror?.(new Error("ECONNREFUSED")); this.onclose?.({ code: 1006, reason: "" }); }
  ofType(t: string) { return this.sent.filter((m) => m.type === t); }
}

class FakeClock implements LinkTimers {
  now = 0;
  private seq = 0;
  private readonly jobs = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.jobs.set(id, { at: this.now + ms, fn }); return id as any; }
  setInterval(fn: () => void, ms: number) { const id = ++this.seq; this.jobs.set(id, { at: this.now + ms, fn, every: ms }); return id as any; }
  clearTimeout(t: any) { this.jobs.delete(t as number); }
  clearInterval(t: any) { this.jobs.delete(t as number); }
  get size() { return this.jobs.size; }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      this.now = job.at;
      if (job.every) job.at += job.every;
      else this.jobs.delete(id);
      job.fn();
    }
    this.now = end;
  }
}

function harness(opts: { mcpClosed?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const clock = new FakeClock();
  const state = { mcpClosed: opts.mcpClosed ?? false, exits: [] as string[], logs: [] as string[] };
  const link = new ChannelLink({
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    registerFrame: () => JSON.stringify({ type: "register", channelId: "ch-1" }),
    onInbound: () => {},
    isMcpClosed: () => state.mcpClosed,
    exit: (r) => { state.exits.push(r); },
    log: (l) => { state.logs.push(l); },
    timers: clock,
  });
  const last = () => sockets[sockets.length - 1]!;
  /** 打开最新的 socket 并回 registered。 */
  const register = () => { const s = last(); if (s.readyState === 0) s.open(); s.recv({ type: "registered", channelId: "ch-1" }); return s; };
  return { link, sockets, clock, state, last, register };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const quiet = (p: Promise<unknown>) => { p.catch(() => {}); return p; };

describe("[验收线 1] fallback 与迟到 initialized 单飞，旧回调不擦新一代", () => {
  test("fallback → A registered → 迟到 initialized：不另建 B，请求仍到 A", async () => {
    const h = harness();
    const fallback = quiet(h.link.connect()); // 30s 兜底先连
    const a = h.register();
    await fallback;
    const late = quiet(h.link.connect()); // 迟到的 oninitialized
    await late;
    expect(h.sockets.length).toBe(1);
    expect(h.link.isRegistered()).toBe(true);
    const r = h.link.request({ type: "reply", text: "hi" });
    const req = a.ofType("reply")[0];
    expect(req).toBeDefined();
    a.recv({ type: "response", requestId: req.requestId, result: { ok: 1 } });
    expect(await r).toEqual({ ok: 1 });
  });

  test("A 仍 connecting 时迟到 initialized：沿用同一尝试，两个调用方都在 A registered 时完成", async () => {
    const h = harness();
    const p1 = quiet(h.link.connect());
    const p2 = quiet(h.link.connect());
    expect(h.sockets.length).toBe(1);
    h.register();
    await Promise.all([p1, p2]);
    expect(h.sockets.length).toBe(1);
    expect(h.sockets[0]!.ofType("register").length).toBe(1);
  });

  test("双入口竞态后旧 A 的迟到 close/error 不擦当前链路：B 仍 registered、请求直达、无自我重连", async () => {
    const h = harness();
    quiet(h.link.connect());
    quiet(h.link.connect());
    for (const s of h.sockets) s.open();
    const b = h.register();
    const a = h.sockets[0]!;
    if (a !== b) { a.onerror?.(new Error("late")); a.drop(1000); } // 旧代码里会出现第二条 socket 与旧 A 的迟到回调
    expect(h.link.isRegistered()).toBe(true);
    void quiet(h.link.request({ type: "list_channels" }));
    expect(h.link.queuedCount()).toBe(0);
    expect(b.ofType("list_channels").length).toBe(1);
    h.clock.advance(120_000);
    expect(h.sockets.length).toBe(1);
  });

  test("A 断开、B 上任后，A 再来一次迟到 close/error/registered/replaced：B 的 registered/pending/keepalive 全保留", async () => {
    const h = harness();
    quiet(h.link.connect());
    const a = h.register();
    a.drop(1006); // 真当前断线 → 3s 后下一代
    h.clock.advance(3_000);
    expect(h.sockets.length).toBe(2);
    const b = h.register();
    const pending = quiet(h.link.request({ type: "project_info" }));
    expect(h.link.pendingCount()).toBe(1);
    a.onerror?.(new Error("late"));
    a.recv({ type: "replaced", reason: "stale" });
    a.recv({ type: "registered" });
    a.drop(4001);
    expect(h.link.isRegistered()).toBe(true);
    expect(h.link.pendingCount()).toBe(1);
    const req = b.ofType("project_info")[0];
    b.recv({ type: "response", requestId: req.requestId, result: "ok" });
    expect(await pending).toBe("ok");
    h.clock.advance(KEEPALIVE_MS);
    expect(b.ofType("ping").length).toBe(1);
    expect(a.ofType("ping").length).toBe(0);
    h.clock.advance(120_000);
    expect(h.sockets.length).toBe(2); // 旧 A 的回调没有再发起一代
  });

  test("旧 A 迟到 onopen（已不是当前代）：不发 register、直接关掉，不顶替当前 B", () => {
    const h = harness();
    quiet(h.link.connect());
    const a = h.last();
    a.drop(1006); // 连接中就断：A 失败
    h.clock.advance(3_000);
    const b = h.register();
    a.open();
    expect(a.ofType("register").length).toBe(0);
    expect(h.link.isRegistered()).toBe(true);
    expect(b.readyState).toBe(1);
  });
});

describe("[验收线 2] 原退避 / 恢复 / stdio 关闭 / inert", () => {
  test("真当前普通断线走 3s→6s 退避，失败连接下一次可恢复，registered 后退避复位", async () => {
    const h = harness();
    const first = h.link.connect();
    h.last().fail(); // 首次连不上：promise 拒绝但不锁死
    await expect(first).rejects.toBeDefined();
    h.clock.advance(2_999);
    expect(h.sockets.length).toBe(1);
    h.clock.advance(1);
    expect(h.sockets.length).toBe(2);
    h.last().fail();
    h.clock.advance(5_999);
    expect(h.sockets.length).toBe(2);
    h.clock.advance(1);
    expect(h.sockets.length).toBe(3);
    h.register().drop(1006);
    h.clock.advance(3_000); // 复位后又从 3s 起
    expect(h.sockets.length).toBe(4);
  });

  test("被顶替（4001）stdio 仍在：按 link-policy 退避重连；30s 稳定持有才清零顶替计数", () => {
    const h = harness();
    quiet(h.link.connect());
    h.register().drop(4001);
    h.clock.advance(3_000);
    h.register().drop(4001); // 没撑满 30s 又被踢 → 第 2 次，6s
    h.clock.advance(5_999);
    expect(h.sockets.length).toBe(2);
    h.clock.advance(1);
    h.register();
    h.clock.advance(STABLE_HOLD_MS);
    h.last().drop(4001); // 稳定持有过 30s → 计数归零，又是 3s
    h.clock.advance(3_000);
    expect(h.sockets.length).toBe(4);
    expect(h.state.exits).toEqual([]);
  });

  test("replaced 帧 + 普通 close code 也按顶替处理；被拒（4002）走普通退避且不退出", () => {
    const h = harness();
    quiet(h.link.connect());
    const a = h.register();
    a.recv({ type: "replaced", reason: "new" });
    a.drop(1000);
    expect(h.state.logs.some((l) => l.includes("被新连接顶替"))).toBe(true);
    h.clock.advance(3_000);
    h.last().open();
    h.last().drop(4002, "rejected");
    expect(h.state.logs.some((l) => l.includes("拒绝注册"))).toBe(true);
    h.clock.advance(3_000);
    expect(h.sockets.length).toBe(3);
    expect(h.state.exits).toEqual([]);
  });

  test("被顶替且 stdio 已关：退出并立刻拒绝排队请求，不再重连", async () => {
    const h = harness();
    quiet(h.link.connect());
    const a = h.register();
    h.state.mcpClosed = true;
    a.drop(1006);
    const queued = h.link.request({ type: "reply" });
    h.clock.advance(3_000);
    h.last().open();
    h.last().drop(4001);
    expect(h.state.exits.length).toBe(1);
    await expect(queued).rejects.toThrow("被新连接取代");
    h.clock.advance(120_000);
    expect(h.sockets.length).toBe(2);
  });

  test("真当前 socket 关闭正确拒绝 pending，grace 队列在下一代 registered 时重发", async () => {
    const h = harness();
    quiet(h.link.connect());
    const a = h.register();
    const inflight = h.link.request({ type: "reply" });
    a.drop(1006);
    await expect(inflight).rejects.toThrow("Bridge 连接断开");
    const queued = h.link.request({ type: "reply" });
    expect(h.link.queuedCount()).toBe(1);
    h.clock.advance(3_000);
    const b = h.register();
    const req = b.ofType("reply")[0];
    b.recv({ type: "response", requestId: req.requestId, result: "again" });
    expect(await queued).toBe("again");
  });

  test("grace 队列 15s 没恢复就拒绝", async () => {
    const h = harness();
    const q = h.link.request({ type: "reply" });
    h.clock.advance(GRACE_QUEUE_MS);
    await expect(q).rejects.toThrow("没恢复");
  });

  test("stdio 关闭 stop()：终止所有 timer、拒绝 pending 与队列，之后的迟到 close 不重连", async () => {
    const h = harness();
    quiet(h.link.connect());
    const a = h.register();
    const inflight = h.link.request({ type: "reply" });
    h.link.stop("MCP stdio 已关闭");
    await expect(inflight).rejects.toThrow("MCP stdio 已关闭");
    expect(h.clock.size).toBe(0);
    expect(a.closedByUs).toBe(1000);
    a.drop(1000);
    h.clock.advance(120_000);
    expect(h.sockets.length).toBe(1);
    await expect(h.link.connect()).rejects.toBeDefined();
    await flush();
  });

  test("退避等待中再调 connect（迟到 initialized）：不绕过退避，不提前建连", async () => {
    const h = harness();
    quiet(h.link.connect());
    h.register().drop(4001);
    await expect(h.link.connect()).rejects.toThrow("退避");
    expect(h.sockets.length).toBe(1);
    h.clock.advance(3_000);
    expect(h.sockets.length).toBe(2);
  });

  test("旧代的稳定持有 timer 不影响新代：A 未满 30s 被踢，B 刚上任时 A 的计时不会提前清零", () => {
    const h = harness();
    quiet(h.link.connect());
    h.register().drop(4001); // 计数 1
    h.clock.advance(3_000);
    h.register(); // A' 上任，挂 30s 稳定计时
    h.clock.advance(20_000);
    h.last().drop(4001); // 计数 2，A' 的计时作废
    h.clock.advance(6_000);
    h.register(); // B 上任，新的 30s 从现在起算
    h.clock.advance(STABLE_HOLD_MS - 1);
    h.last().drop(4001); // 计数 3 → 12s
    h.clock.advance(11_999);
    expect(h.sockets.length).toBe(3);
    h.clock.advance(1);
    expect(h.sockets.length).toBe(4);
  });

  test("inert 模式不连：构造链路本身不建 socket，channel-mode 判 inert 不连接", () => {
    const h = harness();
    h.clock.advance(120_000);
    expect(h.sockets.length).toBe(0);
    expect(shouldConnectBridge("inert")).toBe(false);
  });
});
