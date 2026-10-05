import { describe, expect, test } from "bun:test";
import { createRpcPeer, lineSplitter, METHOD_NOT_FOUND, RpcError, type RpcWire } from "../src/lib/acp/rpc.ts";

/** 内存线路：sent 收我们写出去的行，feed 模拟对端发来的行，close 模拟子进程退出，closedBy 记本端主动断开的原因 */
function memWire() {
  const sent: any[] = [];
  const closedBy: string[] = [];
  let onData: (c: string | Uint8Array) => void = () => {};
  let onClose: (w: string) => void = () => {};
  const wire: RpcWire = {
    write: (line) => sent.push(JSON.parse(line)),
    onData: (cb) => (onData = cb),
    onClose: (cb) => (onClose = cb),
    close: (why) => closedBy.push(why),
  };
  return {
    wire,
    sent,
    closedBy,
    feed: (m: object | string) => onData((typeof m === "string" ? m : JSON.stringify(m)) + "\n"),
    raw: (c: string | Uint8Array) => onData(c),
    close: (w = "exit") => onClose(w),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const quiet = { log: () => {} };

describe("lineSplitter", () => {
  test("跨 chunk 的半行攒着，空行丢掉，字节流按 UTF-8 解", () => {
    const lines: string[] = [];
    const push = lineSplitter((l) => lines.push(l));
    push('{"a":');
    push('1}\n\n{"b"');
    push(new TextEncoder().encode(':"中文"}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":"中文"}']);
  });

  test("没有换行的半行攒过上限 → onOverflow，之后再来什么都不吐（审查探针：8 个 1 MiB 块不再被攒着）", () => {
    const got: string[] = [];
    const why: string[] = [];
    const push = lineSplitter((l) => got.push(l), 4 * 1024 * 1024, (w) => why.push(w));
    const piece = "x".repeat(1024 * 1024);
    for (let i = 0; i < 8; i++) push(piece);
    push("\n");
    push('{"ok":1}\n');
    expect(got).toEqual([]);
    expect(why.length).toBe(1);
    expect(why[0]).toContain("4194304");
    expect(why[0].length).toBeLessThan(400); // 日志只留截断摘要
  });

  test("一个 chunk 里的整行超限同样拦下，前面的正常行照吐；按字节算（中文 3 字节）", () => {
    const got: string[] = [];
    const why: string[] = [];
    const push = lineSplitter((l) => got.push(l), 10, (w) => why.push(w));
    push("ok\n中文中文\nlater\n"); // 「中文中文」12 字节 > 10
    expect(got).toEqual(["ok"]);
    expect(why.length).toBe(1);
  });

  test("刚好等于上限的行放行", () => {
    const got: string[] = [];
    const push = lineSplitter((l) => got.push(l), 6, () => {});
    push("中文\n");
    expect(got).toEqual(["中文"]);
  });
});

describe("createRpcPeer", () => {
  test("请求带递增 id，响应按 id 回到对应的 promise；result:null 合法", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    const a = rpc.request("initialize", { protocolVersion: 1 });
    const b = rpc.request("session/new", { cwd: "/x" });
    const c = rpc.request("session/set_mode", {});
    expect(m.sent.map((s) => [s.jsonrpc, s.id, s.method])).toEqual([["2.0", 1, "initialize"], ["2.0", 2, "session/new"], ["2.0", 3, "session/set_mode"]]);
    m.feed({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } });
    m.feed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    m.feed({ jsonrpc: "2.0", id: 3, result: null });
    expect(await a).toEqual({ protocolVersion: 1 });
    expect(await b).toEqual({ sessionId: "s" });
    expect(await c).toBeNull();
  });

  test("错误响应变成 RpcError，code / data 原样保留（额度、未登录靠它们认）", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    const p = rpc.request("session/prompt", {});
    m.feed({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: { codexErrorInfo: "usageLimitExceeded" } } });
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe(-32603);
    expect(e.data).toEqual({ codexErrorInfo: "usageLimitExceeded" });
  });

  test("畸形响应不算成功（审查探针 {\"id\":1}）：缺 jsonrpc、result/error 都没有或都有、error 缺 code，一律让请求失败", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    const cases = [
      { id: 1 },
      { jsonrpc: "2.0", id: 2 },
      { jsonrpc: "2.0", id: 3, result: 1, error: { code: 1, message: "x" } },
      { jsonrpc: "2.0", id: 4, error: { message: "no code" } },
      { id: 5, result: {} },
    ];
    const reqs = cases.map((_, i) => rpc.request(`m${i}`).then(() => "resolved", (e) => e.message));
    for (const c of cases) m.feed(c);
    for (const r of await Promise.all(reqs)) expect(r).toContain("不合规");
  });

  test("对端的请求：有处理器回结果，没有回 -32601，处理器抛错回错误，缺 jsonrpc 回 -32600——绝不悬着", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    rpc.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
    rpc.onRequest("boom", () => {
      throw new RpcError(-32602, "bad", { x: 1 });
    });
    m.feed({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {} });
    m.feed({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: {} });
    m.feed({ jsonrpc: "2.0", id: 9, method: "boom" });
    m.feed({ id: 10, method: "session/request_permission" });
    await tick();
    // 回答是异步的，先后不保证：按 id 排好再比
    expect([...m.sent].sort((x, y) => x.id - y.id)).toEqual([
      { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: 8, error: { code: METHOD_NOT_FOUND, message: "method not found: fs/read_text_file" } },
      { jsonrpc: "2.0", id: 9, error: { code: -32602, message: "bad", data: { x: 1 } } },
      { jsonrpc: "2.0", id: 10, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } },
    ]);
  });

  test("通知分发给处理器，不回任何东西；坏行、缺 jsonrpc 的通知、数组只记日志", async () => {
    const m = memWire();
    const logs: string[] = [];
    const rpc = createRpcPeer(m.wire, { log: (s) => logs.push(s) });
    const got: any[] = [];
    rpc.onNotification("session/update", (p) => got.push(p));
    m.feed({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "plan" } } });
    m.feed({ method: "session/update", params: { forged: true } });
    m.feed("not json");
    m.feed("[1,2]");
    await tick();
    expect(got).toEqual([{ update: { sessionUpdate: "plan" } }]);
    expect(m.sent).toEqual([]);
    expect(logs.length).toBe(3);
  });

  test("通知不带 params 字段就不写 params；超时的请求单独失败，迟到的响应只记日志", async () => {
    const m = memWire();
    const logs: string[] = [];
    const rpc = createRpcPeer(m.wire, { log: (s) => logs.push(s) });
    rpc.notify("session/cancel", { sessionId: "s" });
    expect(m.sent[0]).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
    const p = rpc.request("slow", undefined, { timeoutMs: 5 });
    expect(m.sent[1]).toEqual({ jsonrpc: "2.0", id: 1, method: "slow" });
    expect(await p.catch((e) => e.message)).toContain("超时");
    m.feed({ jsonrpc: "2.0", id: 1, result: null });
    expect(logs.some((l) => l.includes("没人等"))).toBe(true);
  });

  test("流断了：在途请求全部失败，之后的请求直接拒绝，也不再往外写", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    const p = rpc.request("session/prompt", {});
    m.close("code 1");
    expect(await p.catch((e) => e.message)).toContain("code 1");
    expect(rpc.closed).toBe(true);
    expect(await rpc.request("x").catch((e) => e.message)).toContain("已断");
    rpc.notify("session/cancel", {});
    expect(m.sent.length).toBe(1);
  });

  test("对端输出超长行：整条连接作废（在途请求失败、线路被本端断开），日志只留摘要，不截断后接着解析", async () => {
    const m = memWire();
    const logs: string[] = [];
    const rpc = createRpcPeer(m.wire, { log: (s) => logs.push(s), maxLineBytes: 1024 });
    const p = rpc.request("session/prompt", {});
    m.raw(`{"jsonrpc":"2.0","id":1,"result":"${"y".repeat(4096)}`);
    expect(await p.catch((e) => e.message)).toContain("超长行");
    expect(rpc.closed).toBe(true);
    expect(m.closedBy).toEqual(["line too long"]);
    expect(logs.length).toBe(1);
    expect(logs[0].length).toBeLessThan(400);
    m.raw('"}\n');
    expect(logs.length).toBe(1);
  });
});

describe("onResult 同步钩子（steer 回包那一刻就登记等待）", () => {
  test("回包与紧跟其后的通知在同一个 chunk 里：钩子先于下一行的通知处理器跑", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    const order: string[] = [];
    rpc.onNotification("session/update", () => order.push("idle-update"));
    const p = rpc.request("_session/steering", {}, { onResult: (r: any) => order.push(`hook:${r.outcome}`) });
    m.raw('{"jsonrpc":"2.0","id":1,"result":{"outcome":"startedNewTurn"}}\n{"jsonrpc":"2.0","method":"session/update","params":{}}\n');
    expect(order).toEqual(["hook:startedNewTurn", "idle-update"]);
    expect(await p).toEqual({ outcome: "startedNewTurn" });
  });

  test("钩子抛错不影响结果交付；错误回包不调钩子", async () => {
    const m = memWire();
    const logs: string[] = [];
    const rpc = createRpcPeer(m.wire, { log: (s) => logs.push(s) });
    let called = 0;
    const ok = rpc.request("a", {}, { onResult: () => { called++; throw new Error("boom"); } });
    const bad = rpc.request("b", {}, { onResult: () => called++ });
    m.feed({ jsonrpc: "2.0", id: 1, result: 7 });
    m.feed({ jsonrpc: "2.0", id: 2, error: { code: 1, message: "x" } });
    expect(await ok).toBe(7);
    expect(await bad.catch((e) => e.code)).toBe(1);
    expect(called).toBe(1);
    expect(logs.some((l) => l.includes("钩子出错"))).toBe(true);
  });
});

describe("投递状态（CX-H）：写出之后失去结果 = sent:true，没写出 = sent:false，文字不变", () => {
  test("写出后回包不合规 / 超时 / 断线 → RpcLostError sent:true；连接已断才发 → sent:false", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, quiet);
    const bad = rpc.request("a");
    m.feed({ jsonrpc: "2.0", id: 1 });
    const slow = rpc.request("b", undefined, { timeoutMs: 5 });
    const lost = rpc.request("c");
    const [e1, e2] = [await bad.catch((e) => e), await slow.catch((e) => e)];
    m.close("exit 3");
    const e3 = await lost.catch((e) => e);
    const e4 = await rpc.request("d").catch((e) => e);
    expect([e1, e2, e3, e4].map((e) => [e instanceof Error, e.sent, e.message])).toEqual([
      [true, true, "acp 对端回了不合规的响应（result 与 error 必须二选一）"],
      [true, true, "b 超时（5ms）"],
      [true, true, "acp 连接断了（exit 3）"],
      [true, false, "acp 连接已断，d 发不出去"],
    ]);
  });

  test("线路写入时抛错 → sent:true（可能写了一半），在途记录清掉；参数序列化失败（还没写）不算", async () => {
    const m = memWire();
    const logs: string[] = [];
    let boom = true;
    m.wire.write = (line) => {
      m.sent.push(JSON.parse(line));
      if (boom) throw new Error("EPIPE");
    };
    const rpc = createRpcPeer(m.wire, { log: (s) => logs.push(s) });
    const e = await rpc.request("e", undefined, { timeoutMs: 50 }).catch((x) => x);
    expect(e.sent).toBe(true);
    expect(e.message).toContain("EPIPE");
    boom = false;
    m.feed({ jsonrpc: "2.0", id: 1, result: null });
    expect(logs.some((l) => l.includes("没人等"))).toBe(true);
    const never = await rpc.request("f", { n: 1n }).catch((x) => x);
    expect(never.sent).toBeUndefined();
    expect(m.sent.length).toBe(1);
  });
});
