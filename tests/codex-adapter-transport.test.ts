// codex 适配器传输层（app-server.ts）：握手、调用校验、反向请求、时限、退出、通知分类；外加真实子进程下的方言与独立进程组。
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAdapter } from "../src/lib/acp/adapter-proc.ts";
import { createAppServer, type NotificationEvent, ProtocolError, spawnAppServer } from "../src/lib/acp/codex-adapter/app-server.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import { testChildEnv } from "./test-env.ts";

/** 假 app-server（内存线路）：sent 是我们写出的原始行，reply 按 method 自动回包，feed 模拟它发来的一行，exit 模拟进程退出 */
function fakeServer() {
  const lines: string[] = [];
  const reply = new Map<string, (params: any) => unknown>();
  let onData: (c: string | Uint8Array) => void = () => {};
  let onClose: (why: string) => void = () => {};
  const feed = (m: object | string) => onData(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  const wire: RpcWire = {
    write: (l) => {
      lines.push(l);
      const m = JSON.parse(l);
      const h = m.method !== undefined && m.id !== undefined ? reply.get(m.method) : undefined;
      if (h) queueMicrotask(() => feed({ id: m.id, result: h(m.params) }));
    },
    onData: (cb) => (onData = cb),
    onClose: (cb) => (onClose = cb),
    close: () => {},
  };
  return { wire, lines, sent: () => lines.map((l) => JSON.parse(l)), reply, feed, exit: (why: string) => onClose(why) };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const INIT_RESULT = { codexHome: "/tmp/x", platformFamily: "unix", platformOs: "macos", userAgent: "fake" };
const TURN = { id: "T1", items: [], status: "inProgress" };
const START = {
  threadId: "th",
  input: [{ type: "text" as const, text: "hi", text_elements: [] as [] }],
  approvalPolicy: "never" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: { type: "dangerFullAccess" as const },
  summary: "auto" as const,
  effort: null,
  model: "gpt-x",
};

describe("握手", () => {
  test("initialize 带 experimentalApi:true，写出不带 jsonrpc；回包缺 jsonrpc 照收；之后发 initialized", async () => {
    const f = fakeServer();
    f.reply.set("initialize", () => INIT_RESULT);
    const app = createAppServer(f.wire);
    expect(await app.initialize({ name: "claudestra", version: "1" })).toMatchObject(INIT_RESULT);
    expect(f.lines.every((l) => !l.includes("jsonrpc"))).toBe(true);
    expect(f.sent()).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "claudestra", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } } },
      { method: "initialized" },
    ]);
  });

  test("sendInitialized:false 时只发 initialize", async () => {
    const f = fakeServer();
    f.reply.set("initialize", () => INIT_RESULT);
    await createAppServer(f.wire, { sendInitialized: false }).initialize({ name: "c", version: "1" });
    expect(f.sent().map((m) => m.method)).toEqual(["initialize"]);
  });

  test("握手超时：不回包就按时限失败，不挂着（I13）", async () => {
    const f = fakeServer();
    const app = createAppServer(f.wire, { timeouts: { initialize: 20 } });
    await expect(app.initialize({ name: "c", version: "1" })).rejects.toThrow("initialize 超时（20ms）");
  });
});

describe("调用", () => {
  test("回包合格：onResult 在回包到达时同步拿到校验后的结果，先于 promise", async () => {
    const f = fakeServer();
    f.reply.set("turn/start", () => ({ turn: TURN }));
    const order: string[] = [];
    const p = createAppServer(f.wire).call("turn/start", START, { onResult: (r) => void order.push(`hook:${r.turn.id}`) });
    order.push(`resolved:${(await p).turn.status}`);
    expect(order).toEqual(["hook:T1", "resolved:inProgress"]);
    expect(f.sent()[0].params).toEqual(START);
  });

  test("回包不合 schema（封闭枚举出现不认识的值）→ ProtocolError，onResult 不调", async () => {
    const f = fakeServer();
    f.reply.set("turn/start", () => ({ turn: { ...TURN, status: "weird" } }));
    let hooked = false;
    const err = await createAppServer(f.wire)
      .call("turn/start", START, { onResult: () => void (hooked = true) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err.message).toContain("turn.status");
    expect(err.raw).toEqual({ turn: { ...TURN, status: "weird" } });
    expect(hooked).toBe(false);
  });

  test("出站严格：多带字段或缺字段当场抛，什么都不写出", () => {
    const f = fakeServer();
    const app = createAppServer(f.wire);
    expect(() => app.call("turn/interrupt", { threadId: "th", turnId: "T1", extra: 1 } as never)).toThrow();
    expect(() => app.call("turn/start", { ...START, model: undefined } as never)).toThrow();
    expect(f.lines).toEqual([]);
  });

  test("调用超时按 USED 的缺省值或覆盖值失败", async () => {
    const f = fakeServer();
    const app = createAppServer(f.wire, { timeouts: { "thread/read": 15 } });
    await expect(app.call("thread/read", { threadId: "th" })).rejects.toThrow("thread/read 超时（15ms）");
    await expect(app.call("thread/read", { threadId: "th" }, { timeoutMs: 5 })).rejects.toThrow("超时（5ms）");
  });
});

describe("反向请求", () => {
  test("没注册的回 -32601（不带 jsonrpc）", async () => {
    const f = fakeServer();
    createAppServer(f.wire);
    f.feed({ id: 41, method: "item/tool/call", params: {} });
    await tick();
    expect(f.sent()).toEqual([{ id: 41, error: { code: -32601, message: "method not found: item/tool/call" } }]);
  });

  test("注册的：参数校验后交给处理器，回包按严格 schema 校验", async () => {
    const f = fakeServer();
    const app = createAppServer(f.wire);
    const seen: unknown[] = [];
    app.handle("item/commandExecution/requestApproval", (req) => {
      seen.push(req);
      return { decision: "cancel" };
    });
    f.feed({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "th", turnId: "T1", itemId: "i1", startedAtMs: 1 } });
    f.feed({ id: 8, method: "item/commandExecution/requestApproval", params: { threadId: "th" } });
    await tick();
    expect(f.sent()).toEqual([{ id: 7, result: { decision: "cancel" } }, { id: 8, result: { decision: "cancel" } }]);
    expect(seen[0]).toMatchObject({ ok: true, corr: { threadId: "th", turnId: "T1" } });
    expect(seen[1]).toMatchObject({ ok: false, corr: { threadId: "th" } });
  });

  test("处理器回了 schema 不收的值 → 回错误，不把坏值发出去", async () => {
    const f = fakeServer();
    const app = createAppServer(f.wire);
    app.handle("item/fileChange/requestApproval", () => ({ decision: "maybe" }) as never);
    f.feed({ id: 3, method: "item/fileChange/requestApproval", params: { threadId: "th", turnId: "T1", itemId: "i", startedAtMs: 1 } });
    await tick();
    expect(f.sent()[0]).toMatchObject({ id: 3, error: { code: -32603 } });
  });
});

describe("通知", () => {
  function collect() {
    const f = fakeServer();
    const app = createAppServer(f.wire);
    const evs: NotificationEvent[] = [];
    app.onNotification((e) => void evs.push(e));
    return { f, app, evs };
  }

  test("合格的带类型化 params 和类别；不合格的带原因和松散读出的关联字段", () => {
    const { f, evs } = collect();
    f.feed({ method: "turn/completed", params: { threadId: "th", turn: { ...TURN, status: "completed" } } });
    f.feed({ method: "turn/completed", params: { threadId: "th", turn: { id: "T2", status: "weird" } } });
    expect(evs[0]).toMatchObject({ method: "turn/completed", cls: "L", ok: true, corr: { threadId: "th", turnId: "T1" } });
    expect(evs[1]).toMatchObject({ method: "turn/completed", cls: "L", ok: false, corr: { threadId: "th", turnId: "T2" } });
    expect(evs[1]!.ok === false && evs[1]!.problem).toContain("turn.status");
  });

  test("O 类：不认识的通知、不认识的 item 类型只计数不交出去", () => {
    const { f, app, evs } = collect();
    f.feed({ method: "thread/realtime/started", params: {} });
    f.feed({ method: "thread/realtime/started", params: {} });
    f.feed({ method: "item/started", params: { threadId: "th", turnId: "T1", startedAtMs: 1, item: { type: "reasoning", id: "r" } } });
    expect(evs).toEqual([]);
    expect(app.ignored()).toEqual({ "通知 thread/realtime/started": 2, "item 类型 reasoning": 1 });
  });

  test("item 事件按成员校验：contextCompaction 归 L 类，正文归 C 类，成员字段坏了是 C 类失败", () => {
    const { f, evs } = collect();
    const base = { threadId: "th", turnId: "T1", startedAtMs: 1 };
    f.feed({ method: "item/started", params: { ...base, item: { type: "contextCompaction", id: "c" } } });
    f.feed({ method: "item/completed", params: { ...base, completedAtMs: 2, item: { type: "agentMessage", id: "m", text: "好" } } });
    f.feed({ method: "item/completed", params: { ...base, completedAtMs: 2, item: { type: "agentMessage", id: "m" } } });
    expect(evs.map((e) => [e.method, e.cls, e.ok])).toEqual([
      ["item/started", "L", true],
      ["item/completed", "C", true],
      ["item/completed", "C", false],
    ]);
    expect(evs[1]!.ok && evs[1]!.params).toMatchObject({ item: { type: "agentMessage", text: "好" } });
  });
});

describe("退出", () => {
  test("进程没了：onExit 带原因，在途调用失败，之后的调用直接失败", async () => {
    const f = fakeServer();
    const app = createAppServer(f.wire);
    const whys: string[] = [];
    app.onExit((w) => void whys.push(w));
    const pending = app.call("model/list", { cursor: null, limit: null });
    f.exit("exit 1");
    await expect(pending).rejects.toThrow("acp 连接断了（exit 1）");
    await expect(app.call("model/list", { cursor: null, limit: null })).rejects.toThrow("连接已断");
    expect(whys).toEqual(["exit 1"]);
    expect(app.closed).toBe(true);
  });
});

describe("真实子进程", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-transport-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** 子进程自己报 pid 和进程组：detached 时自成一组（pgid = pid），缺省时留在测试进程的组里 */
  async function pidAndGroup(detached: boolean): Promise<[number, number]> {
    const proc = spawnAdapter(["sh", "-c", "ps -o pid= -o pgid= -p $$"], testChildEnv(), dir, () => {}, "t", detached ? { detached: true } : {});
    let out = "";
    proc.wire.onData((c) => void (out += typeof c === "string" ? c : new TextDecoder().decode(c)));
    await proc.exited;
    await tick(20);
    const [pid, pgid] = out.trim().split(/\s+/).map(Number);
    return [pid!, pgid!];
  }

  test("spawnAdapter：stderr 先打码再截 300 字，密钥跨在截断处也不留前缀", async () => {
    const logs: string[] = [];
    const line = `${"z".repeat(290)} sk-abcdefghijklmnopqrstuvwxyz123456`;
    const proc = spawnAdapter(["sh", "-c", `echo '${line}' >&2`], testChildEnv(), dir, (m) => logs.push(m), "t");
    await proc.exited;
    await tick(50);
    expect(logs.join("\n")).toContain("zzzz");
    expect(logs.join("\n")).not.toContain("sk-abc");
  });

  test("spawnAdapter：detached 起在独立进程组，缺省不变", async () => {
    const [pid, pgid] = await pidAndGroup(true);
    expect(pgid).toBe(pid);
    const [pid2, pgid2] = await pidAndGroup(false);
    expect(pgid2).not.toBe(pid2);
  });

  test("spawnAppServer：`<codex> app-server` 走真实 stdio 握手（对端不带 jsonrpc），进程在自己的进程组里", async () => {
    const fake = join(dir, "fake-codex");
    writeFileSync(
      fake,
      `#!${process.execPath}
if (process.argv[2] !== "app-server") process.exit(2);
const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]);
for await (const chunk of process.stdin) for (const l of String(chunk).split("\\n").filter(Boolean)) {
  const m = JSON.parse(l);
  if (m.method !== "initialize") continue;
  const result = { ...${JSON.stringify(INIT_RESULT)}, pid: process.pid, pgid: Number(String(ps.stdout).trim()), sawJsonrpc: "jsonrpc" in m };
  process.stdout.write(JSON.stringify({ id: m.id, result }) + "\\n");
}
`,
    );
    chmodSync(fake, 0o755);
    const app = spawnAppServer({ codexPath: fake, env: testChildEnv(), cwd: dir, log: () => {} });
    try {
      const r = (await app.initialize({ name: "c", version: "1" })) as Record<string, unknown>;
      expect(r.sawJsonrpc).toBe(false);
      expect(r.pgid).toBe(r.pid);
    } finally {
      app.proc.stop();
      await app.proc.exited;
    }
  });
});
