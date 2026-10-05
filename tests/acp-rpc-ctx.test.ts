// rpc.ts 的两项可选扩展：处理器的同步回复（ctx.respond / fail）和 app-server 方言。缺省路径由 tests/acp-rpc.test.ts 原样锁住。
import { describe, expect, test } from "bun:test";
import { createRpcPeer, METHOD_NOT_FOUND, type RpcWire } from "../src/lib/acp/rpc.ts";

/** 内存线路：lines 记写出的原始行（断言真实写出顺序和字节），feed 模拟对端发来的一段字节 */
function memWire() {
  const lines: string[] = [];
  let onData: (c: string | Uint8Array) => void = () => {};
  const wire: RpcWire = { write: (l) => void lines.push(l), onData: (cb) => (onData = cb), onClose: () => {}, close: () => {} };
  return { wire, lines, sent: () => lines.map((l) => JSON.parse(l)), feed: (chunk: string) => onData(chunk) };
}
const line = (m: object) => `${JSON.stringify(m)}\n`;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {} };

describe("同步回复 ctx", () => {
  /**
   * 适配器的样子：宿主发来 steer，处理器转发 turn/start 给 app-server；start 回包和 turn/completed 挤在同一个 chunk 里，
   * completed 会引出一条发给宿主的通知。用 ctx.respond 时宿主线路上回包必须排在通知前面；只靠返回值时是反的（这正是要修的时序）。
   */
  async function steerOrder(useCtx: boolean): Promise<string[]> {
    const host = memWire();
    const app = memWire();
    const toHost = createRpcPeer(host.wire, quiet);
    const toApp = createRpcPeer(app.wire, quiet);
    toHost.onRequest("_session/steering", (_p, ctx) => {
      return new Promise((resolve) => {
        void toApp.request("turn/start", {}, { onResult: () => (useCtx ? ctx.respond({ outcome: "startedNewTurn" }) : resolve({ outcome: "startedNewTurn" })) });
      });
    });
    toApp.onNotification("turn/completed", () => toHost.notify("session/update", { update: "idle" }));
    host.feed(line({ jsonrpc: "2.0", id: 7, method: "_session/steering", params: {} }));
    await tick();
    const startId = app.sent()[0].id;
    app.feed(line({ jsonrpc: "2.0", id: startId, result: { turn: { id: "T1" } } }) + line({ jsonrpc: "2.0", method: "turn/completed", params: {} }));
    await tick(20);
    return host.sent().map((m) => ("id" in m ? `response:${m.result.outcome}` : `notify:${m.method}`));
  }

  test("onResult 里 ctx.respond：同一个 chunk 里回包先于随后那行引出的通知写出", async () => {
    expect(await steerOrder(true)).toEqual(["response:startedNewTurn", "notify:session/update"]);
  });

  test("对照：只靠返回值回包会晚于通知（ctx 解决的就是这个顺序）", async () => {
    expect(await steerOrder(false)).toEqual(["notify:session/update", "response:startedNewTurn"]);
  });

  const once: [string, (p: unknown, ctx: { respond(r: unknown): void; fail(e: unknown): void }) => unknown, "result" | "error"][] = [
    ["respond 之后 return 别的值", (_p, c) => (c.respond({ a: 1 }), { b: 2 }), "result"],
    ["respond 之后 throw", (_p, c) => {
      c.respond({ a: 1 });
      throw new Error("x");
    }, "result"],
    ["respond 之后 fail", (_p, c) => {
      c.respond({ a: 1 });
      c.fail(new Error("x"));
    }, "result"],
    ["respond 两次", (_p, c) => {
      c.respond({ a: 1 });
      c.respond({ a: 2 });
    }, "result"],
    ["fail 之后 respond、再 return", (_p, c) => {
      c.fail(new Error("坏了"));
      c.respond({ a: 1 });
      return { b: 2 };
    }, "error"],
    ["异步：等一会儿 respond，之后 resolve 别的值", async (_p, c) => {
      await tick(1);
      c.respond({ a: 1 });
      return { b: 2 };
    }, "result"],
  ];
  for (const [name, h, kind] of once) {
    test(`每个请求只写出一次：${name}`, async () => {
      const m = memWire();
      createRpcPeer(m.wire, quiet).onRequest("m", h);
      m.feed(line({ jsonrpc: "2.0", id: 1, method: "m" }));
      await tick(10);
      expect(m.sent()).toHaveLength(1);
      if (kind === "result") expect(m.sent()[0].result).toEqual({ a: 1 });
      else expect(m.sent()[0].error.message).toBe("坏了");
    });
  }
});

describe("app-server 方言", () => {
  test("写出不带 jsonrpc 字段：请求、通知、响应、错误都是", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, { ...quiet, dialect: "app-server" });
    rpc.onRequest("echo", (p) => p);
    void rpc.request("initialize", { a: 1 });
    rpc.notify("initialized");
    m.feed(line({ id: 9, method: "echo", params: { x: 1 } }) + line({ id: 10, method: "nope" }));
    await tick();
    expect(m.lines.every((l) => !l.includes("jsonrpc"))).toBe(true);
    // -32601 当场回，echo 的回包要等处理器的 promise：两条回包的先后不是这里要锁的
    expect(m.sent().slice(0, 2)).toEqual([{ id: 1, method: "initialize", params: { a: 1 } }, { method: "initialized" }]);
    expect(m.sent().slice(2)).toHaveLength(2);
    expect(m.sent()).toContainEqual({ id: 9, result: { x: 1 } });
    expect(m.sent()).toContainEqual({ id: 10, error: { code: METHOD_NOT_FOUND, message: "method not found: nope" } });
  });

  test("读入缺 jsonrpc 照收（响应、通知、请求）；带了但不是 2.0 的照旧不合规", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, { ...quiet, dialect: "app-server" });
    const got: unknown[] = [];
    rpc.onNotification("turn/started", (p) => void got.push(p));
    rpc.onRequest("ask", () => ({ ok: true }));
    const r = rpc.request("thread/start", {});
    const bad = rpc.request("thread/read", {});
    m.feed(line({ id: 1, result: { thread: { id: "t" } } }) + line({ method: "turn/started", params: { n: 1 } }) + line({ id: 5, method: "ask" }));
    m.feed(line({ jsonrpc: "1.0", id: 2, result: {} }));
    expect(await r).toEqual({ thread: { id: "t" } });
    await expect(bad).rejects.toThrow("不合规的响应");
    await tick();
    expect(got).toEqual([{ n: 1 }]);
    expect(m.sent().at(-1)).toEqual({ id: 5, result: { ok: true } });
  });

  test("缺省方言没变：缺 jsonrpc 的响应仍让请求失败，写出仍带 jsonrpc", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    const r = rpc.request("x", {});
    m.feed(line({ id: 1, result: {} }));
    await expect(r).rejects.toThrow("缺 jsonrpc");
    expect(m.sent()[0].jsonrpc).toBe("2.0");
  });

  test("没注册的通知交给 onUnhandledNotification；不传时照旧静默丢掉", async () => {
    const m = memWire();
    const seen: string[] = [];
    createRpcPeer(m.wire, { ...quiet, dialect: "app-server", onUnhandledNotification: (method) => void seen.push(method) });
    m.feed(line({ method: "thread/realtime/started", params: {} }));
    expect(seen).toEqual(["thread/realtime/started"]);
  });
});
