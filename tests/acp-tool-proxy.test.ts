import { afterEach, describe, expect, test } from "bun:test";
import { startToolProxy, type ToolProxy } from "../src/lib/acp/tool-proxy.ts";

let proxy: ToolProxy | null = null;
const opened: WebSocket[] = [];
afterEach(() => {
  for (const ws of opened.splice(0)) ws.close();
  proxy?.close();
  proxy = null;
});

function setup(toBridge: (f: Record<string, unknown>) => boolean = () => true, clean = false) {
  const upstream: Record<string, any>[] = [];
  const logs: string[] = [];
  proxy = startToolProxy({ channelId: "local-acp-1", toBridge: (f) => (upstream.push(f), toBridge(f)), log: (m) => logs.push(m), clean });
  return { proxy, upstream, logs };
}

/** 连上代理，收到的帧攒在 got 里；next() 等下一帧 */
async function connect(url: string) {
  const ws = new WebSocket(url);
  opened.push(ws);
  const got: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiters.shift();
    if (w) w(m);
    else got.push(m);
  };
  await new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("connect failed")))));
  const next = () => (got.length ? Promise.resolve(got.shift()) : new Promise<any>((r) => waiters.push(r)));
  return { ws, next, send: (m: object) => ws.send(JSON.stringify(m)) };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("工具代理：锁紧", () => {
  test("只绑 127.0.0.1，URL 带一次性 token", () => {
    const { proxy } = setup();
    expect(proxy.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/);
  });

  test("不带 token / token 不对 → 401，连不上", async () => {
    const { proxy } = setup();
    const base = proxy.url.replace(/\?t=.*$/, "");
    expect((await fetch(base.replace("ws:", "http:"))).status).toBe(401);
    expect((await fetch(`${base.replace("ws:", "http:")}?t=${"0".repeat(48)}`)).status).toBe(401);
    await expect(connect(`${base}?t=nope`)).rejects.toThrow();
  });

  test("register 就地回 registered、ping 就地回 pong，都不往上转", async () => {
    const { proxy, upstream } = setup();
    const c = await connect(proxy.url);
    c.send({ type: "register", channelId: "local-acp-1", runtime: "codex" });
    expect(await c.next()).toEqual({ type: "registered", channelId: "local-acp-1" });
    c.send({ type: "ping" });
    expect(await c.next()).toEqual({ type: "pong" });
    await tick();
    expect(upstream).toEqual([]);
  });

  test("白名单外的帧（create_channel 之类）丢掉记日志，不转", async () => {
    const { proxy, upstream, logs } = setup();
    const c = await connect(proxy.url);
    c.send({ type: "create_channel", requestId: "req_1", name: "evil" });
    c.send({ type: "reply", chatId: "x", text: "no request id" });
    await tick();
    expect(upstream).toEqual([]);
    expect(logs.length).toBe(2);
  });
});

describe("工具代理：转发", () => {
  test("reply 按连接改写 requestId 上送；bridge 的回包按改写后的 id 回到原连接、恢复原 id", async () => {
    const { proxy, upstream } = setup();
    const c = await connect(proxy.url);
    c.send({ type: "reply", requestId: "req_1", chatId: "api:owner", text: "好了" });
    await tick();
    expect(upstream.length).toBe(1);
    expect(upstream[0]).toMatchObject({ type: "reply", chatId: "api:owner", text: "好了" });
    expect(upstream[0].requestId).not.toBe("req_1");
    expect(proxy.onBridgeFrame({ type: "response", requestId: upstream[0].requestId, result: { messageIds: ["m1"] } })).toBe(true);
    expect(await c.next()).toEqual({ type: "response", requestId: "req_1", result: { messageIds: ["m1"] } });
    // 不是代理转上去的回包：交还宿主自己处理
    expect(proxy.onBridgeFrame({ type: "response", requestId: "host_1", result: null })).toBe(false);
    expect(proxy.onBridgeFrame({ type: "message", content: "x" })).toBe(false);
  });

  test("两个 channel-server（Codex 子线程各起一个）都从 req_1 数：回包不串", async () => {
    const { proxy, upstream } = setup();
    const a = await connect(proxy.url);
    const b = await connect(proxy.url);
    a.send({ type: "reply", requestId: "req_1", chatId: "c", text: "from a" });
    b.send({ type: "reply", requestId: "req_1", chatId: "c", text: "from b" });
    await tick();
    const [ua, ub] = [upstream.find((u) => u.text === "from a")!, upstream.find((u) => u.text === "from b")!];
    expect(ua.requestId).not.toBe(ub.requestId);
    proxy.onBridgeFrame({ type: "response", requestId: ub.requestId, result: "B" });
    proxy.onBridgeFrame({ type: "response", requestId: ua.requestId, result: "A" });
    expect(await a.next()).toEqual({ type: "response", requestId: "req_1", result: "A" });
    expect(await b.next()).toEqual({ type: "response", requestId: "req_1", result: "B" });
  });

  test("宿主和 bridge 的连接没好：就地回错误；断线时在途请求一律回错误，不干等", async () => {
    let up = false;
    const { proxy } = setup(() => up);
    const c = await connect(proxy.url);
    c.send({ type: "fetch_messages", requestId: "req_1", channel: "x" });
    expect((await c.next()).error).toContain("还没好");
    up = true;
    c.send({ type: "react", requestId: "req_2", chatId: "x", messageId: "m", emoji: "👍" });
    await tick();
    proxy.failInFlight("bridge 断开");
    expect(await c.next()).toEqual({ type: "response", requestId: "req_2", error: "bridge 断开" });
  });
});

describe("工具代理：调用方身份（T85）", () => {
  test("Codex 起的 channel-server 转上去不带降级标；shell 起的 / 没登记的一律带 callerDowngraded；自带的身份字段丢掉", async () => {
    const { proxy, upstream } = setup();
    const mcp = await connect(proxy.url);
    mcp.send({ type: "register", channelId: "local-acp-1", runtime: "codex" });
    await mcp.next();
    mcp.send({ type: "whoami", requestId: "req_1", callerCred: "f".repeat(64), callerDowngraded: false });
    const shell = await connect(proxy.url);
    shell.send({ type: "register", channelId: "local-acp-1", runtime: "codex", outsideMcpLauncher: true });
    await shell.next();
    shell.send({ type: "whoami", requestId: "req_1" });
    const bare = await connect(proxy.url);
    bare.send({ type: "whoami", requestId: "req_1" });
    await tick(50);
    expect(upstream).toHaveLength(3);
    const [a, b, c] = upstream;
    expect(a).toEqual({ type: "whoami", requestId: expect.stringMatching(/^acp\d+_req_1$/) });
    expect(b).toMatchObject({ type: "whoami", callerDowngraded: true });
    expect(c).toMatchObject({ type: "whoami", callerDowngraded: true });
  });

  test("派单工具帧 order_tool（T96）同样转上去：Codex 起的不带降级标，shell 起的带 callerDowngraded，自报 false 被丢掉", async () => {
    const { proxy, upstream } = setup();
    const mcp = await connect(proxy.url);
    mcp.send({ type: "register", channelId: "local-acp-1", runtime: "codex" });
    await mcp.next();
    mcp.send({ type: "order_tool", requestId: "req_1", tool: "take_order", args: {} });
    const shell = await connect(proxy.url);
    shell.send({ type: "register", channelId: "local-acp-1", runtime: "codex", outsideMcpLauncher: true });
    await shell.next();
    shell.send({ type: "order_tool", requestId: "req_1", tool: "deliver", args: { v: 1 }, callerDowngraded: false });
    await tick(50);
    expect(upstream).toEqual([
      { type: "order_tool", requestId: expect.stringMatching(/^acp\d+_req_1$/), tool: "take_order", args: {} },
      { type: "order_tool", requestId: expect.stringMatching(/^acp\d+_req_1$/), tool: "deliver", args: { v: 1 }, callerDowngraded: true },
    ]);
  });
});

describe("工具代理：出借 worker（clean 宿主，i28-W4）", () => {
  test("频道类帧一律不转：reply / route_to_agent / forward_to_agent / fleet_* / project_info / check_inbox 都就地回错误、记日志", async () => {
    const { proxy, upstream, logs } = setup(() => true, true);
    const c = await connect(proxy.url);
    c.send({ type: "register", channelId: "local-acp-1", runtime: "codex" });
    await c.next();
    const types = ["reply", "route_to_agent", "forward_to_agent", "fleet_state", "fleet_run", "project_info", "check_inbox", "fetch_messages", "list_channels"];
    types.forEach((type, i) => c.send({ type, requestId: `req_${i}` }));
    for (let i = 0; i < types.length; i++) {
      const r = await c.next();
      expect(r.type).toBe("response");
      expect(r.error).toContain("出借 worker 不转发");
    }
    await tick();
    expect(upstream).toEqual([]);
    expect(logs.filter((l) => l.includes("出借 worker 不转发")).length).toBe(types.length);
  });

  test("派单帧只转 lend 档的五个工具：DAG / PM 工具（plan_feature 等）就地拒，不往上转", async () => {
    const { proxy, upstream } = setup(() => true, true);
    const c = await connect(proxy.url);
    c.send({ type: "register", channelId: "local-acp-1", runtime: "codex" });
    await c.next();
    for (const tool of ["plan_feature", "rewrite_dag", "start_node", "show_dag", "fleet"]) {
      c.send({ type: "order_tool", requestId: `r_${tool}`, tool, args: {} });
      expect((await c.next()).error).toContain(tool);
    }
    c.send({ type: "order_tool", requestId: "req_1", tool: "take_review", args: {} });
    c.send({ type: "order_tool", requestId: "req_2", tool: "submit_verdict", args: { v: 1 } });
    c.send({ type: "whoami", requestId: "req_3" });
    await tick(50);
    expect(upstream.map((u) => u.tool ?? u.type)).toEqual(["take_review", "submit_verdict", "whoami"]);
  });

  test("不 clean 时照旧转 reply（回归）", async () => {
    const { proxy, upstream } = setup(() => true, false);
    const c = await connect(proxy.url);
    c.send({ type: "reply", requestId: "req_1", chatId: "c", text: "x" });
    await tick();
    expect(upstream).toHaveLength(1);
  });
});
