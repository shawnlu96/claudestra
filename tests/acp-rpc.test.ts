import { describe, expect, test } from "bun:test";
import { createRpcPeer, lineSplitter, METHOD_NOT_FOUND, RpcError, type RpcWire } from "../src/lib/acp/rpc.ts";

/** 内存线路：sent 收我们写出去的行，feed 模拟对端发来的行，close 模拟子进程退出 */
function memWire() {
  const sent: any[] = [];
  let onLine: (l: string) => void = () => {};
  let onClose: (w: string) => void = () => {};
  const wire: RpcWire = {
    write: (line) => sent.push(JSON.parse(line)),
    onLine: (cb) => (onLine = cb),
    onClose: (cb) => (onClose = cb),
  };
  return { wire, sent, feed: (m: object | string) => onLine(typeof m === "string" ? m : JSON.stringify(m)), close: (w = "exit") => onClose(w) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("lineSplitter", () => {
  test("跨 chunk 的半行攒着，空行丢掉，字节流按 UTF-8 解", () => {
    const lines: string[] = [];
    const push = lineSplitter((l) => lines.push(l));
    push('{"a":');
    push('1}\n\n{"b"');
    push(new TextEncoder().encode(':"中文"}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":"中文"}']);
  });
});

describe("createRpcPeer", () => {
  test("请求带递增 id，响应按 id 回到对应的 promise", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, () => {});
    const a = rpc.request("initialize", { protocolVersion: 1 });
    const b = rpc.request("session/new", { cwd: "/x" });
    expect(m.sent.map((s) => [s.jsonrpc, s.id, s.method])).toEqual([["2.0", 1, "initialize"], ["2.0", 2, "session/new"]]);
    m.feed({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } });
    m.feed({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    expect(await a).toEqual({ protocolVersion: 1 });
    expect(await b).toEqual({ sessionId: "s" });
  });

  test("错误响应变成 RpcError，code / data 原样保留（额度、未登录靠它们认）", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, () => {});
    const p = rpc.request("session/prompt", {});
    m.feed({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error", data: { codexErrorInfo: "usageLimitExceeded" } } });
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe(-32603);
    expect(e.data).toEqual({ codexErrorInfo: "usageLimitExceeded" });
  });

  test("对端的请求：有处理器回结果，没有回 -32601，处理器抛错回错误——绝不悬着", async () => {
    const m = memWire();
    const rpc = createRpcPeer(m.wire, () => {});
    rpc.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
    rpc.onRequest("boom", () => {
      throw new RpcError(-32602, "bad", { x: 1 });
    });
    m.feed({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: {} });
    m.feed({ jsonrpc: "2.0", id: 8, method: "fs/read_text_file", params: {} });
    m.feed({ jsonrpc: "2.0", id: 9, method: "boom" });
    await tick();
    // 回答是异步的，先后不保证：按 id 排好再比
    expect([...m.sent].sort((x, y) => x.id - y.id)).toEqual([
      { jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: 8, error: { code: METHOD_NOT_FOUND, message: "method not found: fs/read_text_file" } },
      { jsonrpc: "2.0", id: 9, error: { code: -32602, message: "bad", data: { x: 1 } } },
    ]);
  });

  test("通知分发给处理器，不回任何东西；坏行只记日志", async () => {
    const m = memWire();
    const logs: string[] = [];
    const rpc = createRpcPeer(m.wire, (s) => logs.push(s));
    const got: any[] = [];
    rpc.onNotification("session/update", (p) => got.push(p));
    m.feed({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "plan" } } });
    m.feed("not json");
    await tick();
    expect(got).toEqual([{ update: { sessionUpdate: "plan" } }]);
    expect(m.sent).toEqual([]);
    expect(logs.some((l) => l.includes("not json"))).toBe(true);
  });

  test("通知不带 params 字段就不写 params；超时的请求单独失败，迟到的响应只记日志", async () => {
    const m = memWire();
    const logs: string[] = [];
    const rpc = createRpcPeer(m.wire, (s) => logs.push(s));
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
    const rpc = createRpcPeer(m.wire, () => {});
    const p = rpc.request("session/prompt", {});
    m.close("code 1");
    expect(await p.catch((e) => e.message)).toContain("code 1");
    expect(rpc.closed).toBe(true);
    expect(await rpc.request("x").catch((e) => e.message)).toContain("已断");
    rpc.notify("session/cancel", {});
    expect(m.sent.length).toBe(1);
  });
});
