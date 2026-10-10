import { describe, expect, test } from "bun:test";
import { classifyPromptError, failureEntry, type AcpFailure } from "../src/lib/acp/failures.ts";
import { ACP_PROTOCOL_VERSION } from "../src/lib/acp/protocol.ts";
import { AcpSession, CLIENT_CAPABILITIES } from "../src/lib/acp/session.ts";
import { AcpTurnLoop } from "../src/lib/acp/turn.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import type { PermissionCard } from "../src/lib/acp/permissions.ts";

const SID = "019a0000-0000-7000-8000-000000000001";
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 假适配器：记下宿主发出的每条消息；reply / raw 模拟适配器输出，close 模拟进程退出；onWrite 在记下之后调（抛错 = 写出后线路抛错） */
function fakeAdapter(opts: { permission?: (c: PermissionCard) => Promise<string | null>; onWrite?: (m: any) => void } = {}) {
  const sent: any[] = [];
  let onData: (c: string) => void = () => {};
  let onClose: (w: string) => void = () => {};
  const write = (l: string) => {
    const m = JSON.parse(l);
    sent.push(m);
    opts.onWrite?.(m);
  };
  const wire: RpcWire = { write, onData: (cb) => (onData = cb as any), onClose: (cb) => (onClose = cb), close: () => {} };
  const updates: any[] = [];
  const session = new AcpSession(wire, { onUpdate: (u) => updates.push(u), onPermission: opts.permission ?? (async () => null), log: () => {} });
  const last = (method: string) => [...sent].reverse().find((m) => m.method === method);
  const raw = (...msgs: object[]) => onData(msgs.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
  const reply = (method: string, result: unknown) => raw({ id: last(method).id, result });
  const status = (type: string, sessionId = SID) => ({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type } } } } },
  });
  return { session, sent, updates, last, raw, reply, status, close: (w = "exit 1") => onClose(w) };
}

async function attached(f: ReturnType<typeof fakeAdapter>, resume = true) {
  const init = f.session.initialize();
  const agentCapabilities = { loadSession: true, sessionCapabilities: resume ? { resume: {} } : {} };
  f.reply("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities, _meta: { steering: { supported: true } } });
  const caps = await init;
  const a = f.session.attach(SID, "/w", caps.resume);
  f.reply(caps.resume ? "session/resume" : "session/load", {
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol", name: "sol" }, { value: "gpt-5.6-luna", name: "luna" }] }],
  });
  await a;
}

describe("AcpSession · 起步", () => {
  test("initialize 声明 AIR sessionFailure + 终端输出增量；steering 按适配器声明", async () => {
    const f = fakeAdapter();
    await attached(f);
    expect(f.last("initialize").params.clientCapabilities).toEqual(CLIENT_CAPABILITIES);
    expect(CLIENT_CAPABILITIES._meta.terminal_output_delta).toBe(true);
    expect(f.session.steering).toBe(true);
    expect(f.last("session/resume").params).toEqual({ sessionId: SID, cwd: "/w", mcpServers: [] });
    expect(f.session.configOptions.map((o) => o.id)).toEqual(["model"]);
  });

  test("没有 resume 能力就用 session/load", async () => {
    const f = fakeAdapter();
    await attached(f, false);
    expect(f.last("session/load")).toBeTruthy();
  });

  test("fork 能力和新线程 id 都按 ACP 回包确认", async () => {
    const f = fakeAdapter();
    const init = f.session.initialize();
    f.reply("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {}, fork: {} } } });
    expect(await init).toEqual({ resume: true, fork: true });
    const fork = f.session.fork(SID, "/w");
    expect(f.last("session/fork").params).toEqual({ sessionId: SID, cwd: "/w", mcpServers: [] });
    const newId = "019a0000-0000-7000-8000-000000000002";
    f.reply("session/fork", { sessionId: newId });
    expect(await fork).toBe(newId);
    expect(f.session.sessionId).toBe(newId);
    const repeated = f.session.fork(SID, "/w");
    f.reply("session/fork", { sessionId: SID });
    await expect(repeated).rejects.toThrow("新的 sessionId");
  });

  test("别的会话的更新不进来；本会话的原样交给宿主", async () => {
    const f = fakeAdapter();
    await attached(f);
    const other = { method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "plan" } } };
    f.raw(other, { method: "session/update", params: { sessionId: SID, update: { sessionUpdate: "plan", entries: [] } } });
    expect(f.updates).toEqual([{ sessionUpdate: "plan", entries: [] }]);
  });
});

describe("AcpSession · prompt 结果", () => {
  test("end_turn → done；cancelled → cancelled", async () => {
    const f = fakeAdapter();
    await attached(f);
    const a = f.session.prompt("hi");
    expect(f.last("session/prompt").params).toEqual({ sessionId: SID, prompt: [{ type: "text", text: "hi" }] });
    f.reply("session/prompt", { stopReason: "end_turn" });
    expect(await a).toEqual({ kind: "done" });
    const b = f.session.prompt("x");
    f.reply("session/prompt", { stopReason: "cancelled" });
    expect(await b).toEqual({ kind: "cancelled" });
  });

  test("AIR 失败 → quota（按 id）；legacy 错误 → quota（按回合）；-32000 → auth", async () => {
    const f = fakeAdapter();
    await attached(f);
    const a = f.session.prompt("a");
    const sessionFailure = { id: "t1:error", revision: 1, category: "limit", severity: "error", title: "You've hit your usage limit.", actions: [] };
    f.reply("session/prompt", { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure } } } });
    expect(await a).toMatchObject({ kind: "failed", failure: { kind: "quota", key: "air:t1:error" } });
    const b = f.session.prompt("b");
    f.raw({ id: f.last("session/prompt").id, error: { code: -32603, message: "Internal error", data: { codexErrorInfo: "usageLimitExceeded", message: "limit" } } });
    expect(await b).toMatchObject({ kind: "failed", failure: { kind: "quota", message: "limit" } });
    const c = f.session.prompt("c");
    f.raw({ id: f.last("session/prompt").id, error: { code: -32000, message: "Authentication required" } });
    expect(await c).toMatchObject({ kind: "failed", failure: { kind: "auth" } });
  });
});

describe("AcpSession · 外部回合的结束（按序号关联，Shawn 复审要求 1、2）", () => {
  test("steer 不设局部超时：结果未明时不能把同一消息再当 prompt 投递", async () => {
    const f = fakeAdapter();
    await attached(f);
    const request = f.session.rpc.request.bind(f.session.rpc);
    let timeout: number | undefined = -1;
    (f.session.rpc as any).request = (method: string, params: unknown, opts: { timeoutMs?: number }) => {
      if (method === "_session/steering") timeout = opts.timeoutMs;
      return request(method, params, opts);
    };
    const pending = f.session.steer("late reply");
    expect(timeout).toBeUndefined();
    f.reply("_session/steering", { outcome: "injected" });
    expect(await pending).toEqual({ outcome: "injected" });
  });
  test("startedNewTurn 的回包和那一轮的 idle 同一个 chunk 到：不漏等", async () => {
    const f = fakeAdapter();
    await attached(f);
    const s = f.session.steer("B");
    await tick();
    f.raw({ id: f.last("_session/steering").id, result: { outcome: "startedNewTurn" } }, f.status("active"), f.status("idle"));
    const r = await s;
    expect(r.outcome).toBe("startedNewTurn");
    expect(r.outcome === "startedNewTurn" && (await r.done)).toEqual({ kind: "done" });
  });

  test("steer 之前的 idle（上一轮的）不算数：要等回包之后的那个", async () => {
    const f = fakeAdapter();
    await attached(f);
    f.raw(f.status("active"), f.status("idle"));
    const s = f.session.steer("B");
    await tick();
    f.raw({ id: f.last("_session/steering").id, result: { outcome: "startedNewTurn" } }, f.status("active"));
    const r = (await s) as { outcome: "startedNewTurn"; done: Promise<unknown> };
    let settled = false;
    void r.done.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    f.raw(f.status("idle"));
    expect(await r.done).toEqual({ kind: "done" });
  });

  test("外部回合进行中打断 → cancelled；systemError → failed", async () => {
    const f = fakeAdapter();
    await attached(f);
    const s = f.session.steer("B");
    await tick();
    f.raw({ id: f.last("_session/steering").id, result: { outcome: "startedNewTurn" } });
    const r = (await s) as { outcome: "startedNewTurn"; done: Promise<unknown> };
    f.session.cancel();
    expect(f.last("session/cancel")).toMatchObject({ params: { sessionId: SID } });
    f.raw(f.status("idle"));
    expect(await r.done).toEqual({ kind: "cancelled" });

    const s2 = f.session.steer("C");
    await tick();
    f.raw({ id: f.last("_session/steering").id, result: { outcome: "startedNewTurn" } }, f.status("systemError"));
    const r2 = (await s2) as { outcome: "startedNewTurn"; done: Promise<unknown> };
    expect(await r2.done).toMatchObject({ kind: "failed" });
  });

  test("适配器退出：外部回合的等待以失败兑现，在途的 prompt / steer 也都结束，没有永远等不到的调用", async () => {
    const f = fakeAdapter();
    await attached(f);
    const s = f.session.steer("B");
    await tick();
    f.raw({ id: f.last("_session/steering").id, result: { outcome: "startedNewTurn" } });
    const r = (await s) as { outcome: "startedNewTurn"; done: Promise<unknown> };
    const p = f.session.prompt("later");
    const s2 = f.session.steer("C");
    f.close("exit 137");
    expect(await r.done).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("exit 137") } });
    expect(await p).toMatchObject({ kind: "failed", failure: { kind: "error" } });
    // 在途的 steer 已经写给适配器：结果不明，不再 reject（reject 会让调度器把它改回 prompt 重发）
    expect(await s2).toMatchObject({ outcome: "deliveredUnknown", failure: { message: expect.stringContaining("exit 137") } });
  });

  test("injected / 其它结果照原样", async () => {
    const f = fakeAdapter();
    await attached(f);
    const s = f.session.steer("B");
    await tick();
    f.reply("_session/steering", { outcome: "injected" });
    expect(await s).toEqual({ outcome: "injected" });
    const t = f.session.steer("C");
    await tick();
    f.reply("_session/steering", { outcome: "failed" });
    expect(await t).toEqual({ outcome: "failed" });
  });
});

describe("AcpSession · 用户输入已写出、拿不到可信结果（CX-H）", () => {
  const UNKNOWN = { kind: "error", retry: false, deliveryUnknown: true };
  /** 适配器收到这条输入几次（prompt 和 steering 都算） */
  const receipts = (f: ReturnType<typeof fakeAdapter>, text: string) => f.sent.filter((m) => m.params?.prompt?.[0]?.text === text).length;
  const badReply = (f: ReturnType<typeof fakeAdapter>, method: string) => f.raw({ id: f.last(method).id, result: { outcome: "injected" }, error: { code: 1, message: "x" } });
  const throwOn = (method: string) => (m: any) => {
    if (m.method === method) throw new Error("EPIPE");
  };
  /** 真调度器 + 真会话：prompts 记调度器开过的每一轮，failures 记出的卡 */
  function looped(f: ReturnType<typeof fakeAdapter>) {
    const prompts: string[] = [];
    const failures: AcpFailure[] = [];
    const loop = new AcpTurnLoop({
      prompt: (t) => (prompts.push(t), f.session.prompt(t)), steer: (t) => f.session.steer(t), reportStop: async () => ({}), onFailure: (x) => void failures.push(x), log: () => {},
    });
    return { loop, prompts, failures };
  }

  test("prompt 写出后适配器退出：不可重试（不 60s 续跑），卡上写明可能已执行、没有自动重发，附原文", async () => {
    const f = fakeAdapter();
    await attached(f);
    const p = f.session.prompt("rm -rf build && deploy");
    f.close("exit 137");
    const o = (await p) as { kind: "failed"; failure: AcpFailure };
    expect(o).toMatchObject({ kind: "failed", failure: UNKNOWN });
    expect(o.failure.message).toContain("可能已经被执行");
    expect(o.failure.message).toContain("没有自动重发");
    expect(o.failure.message).toContain("rm -rf build && deploy");
    expect(o.failure.message).toContain("exit 137");
    expect(failureEntry(o.failure, "t")).toMatchObject({ isApiErrorMessage: false });
  });

  test("prompt 写出后超时 / 回包不合规 / 线路写入抛错：一律结果不明", async () => {
    const timeout = fakeAdapter();
    await attached(timeout);
    expect(await timeout.session.prompt("a", 5)).toMatchObject({ kind: "failed", failure: { ...UNKNOWN, message: expect.stringContaining("超时") } });
    const bad = fakeAdapter();
    await attached(bad);
    const p = bad.session.prompt("b");
    badReply(bad, "session/prompt");
    expect(await p).toMatchObject({ kind: "failed", failure: { ...UNKNOWN, message: expect.stringContaining("不合规") } });
    const thrown = fakeAdapter({ onWrite: throwOn("session/prompt") });
    await attached(thrown);
    expect(await thrown.session.prompt("c")).toMatchObject({ kind: "failed", failure: { ...UNKNOWN, message: expect.stringContaining("EPIPE") } });
    expect(receipts(thrown, "c")).toBe(1);
  });

  test("steer 写出后断线 / 回包不合规 / 写入抛错 / 适配器明说 deliveredUnknown：回 deliveredUnknown，不 reject", async () => {
    const gone = fakeAdapter();
    await attached(gone);
    const s1 = gone.session.steer("a");
    gone.close("exit 9");
    expect(await s1).toMatchObject({ outcome: "deliveredUnknown", failure: { ...UNKNOWN, message: expect.stringContaining("exit 9") } });
    const bad = fakeAdapter();
    await attached(bad);
    const s2 = bad.session.steer("b");
    badReply(bad, "_session/steering");
    expect(await s2).toMatchObject({ outcome: "deliveredUnknown", failure: UNKNOWN });
    const thrown = fakeAdapter({ onWrite: throwOn("_session/steering") });
    await attached(thrown);
    expect(await thrown.session.steer("c")).toMatchObject({ outcome: "deliveredUnknown", failure: UNKNOWN });
    const said = fakeAdapter();
    await attached(said);
    const s4 = said.session.steer("d");
    said.reply("_session/steering", { outcome: "deliveredUnknown", message: "pi prompt 超时（30000ms）" });
    expect(await s4).toMatchObject({ outcome: "deliveredUnknown", failure: { ...UNKNOWN, message: expect.stringContaining("30000ms") } });
  });

  /** steer 写出之后的几种「拿不到可信结果」：opts 改线路，answer 是适配器回的东西（不给 = 线路自己出错，不用回） */
  const steerFaults: Record<string, { opts?: Parameters<typeof fakeAdapter>[0]; answer?: (f: ReturnType<typeof fakeAdapter>) => void }> = {
    回包不合规: { answer: (f) => badReply(f, "_session/steering") },
    写入抛错: { opts: { onWrite: throwOn("_session/steering") } },
    "结果是 null": { answer: (f) => f.reply("_session/steering", null) },
    "结果是 {}": { answer: (f) => f.reply("_session/steering", {}) },
    "outcome 认不出": { answer: (f) => f.reply("_session/steering", { outcome: "queuedSomewhere" }) },
  };
  for (const [mode, how] of Object.entries(steerFaults)) {
    test(`整条链：steer ${mode} 时不改回 prompt，适配器只收到这条输入一次、只出一张卡`, async () => {
      const f = fakeAdapter(how.opts);
      await attached(f);
      const h = looped(f);
      expect(await h.loop.submit("A")).toBe("prompt");
      const b = h.loop.submit("B");
      await tick();
      how.answer?.(f);
      await b;
      f.reply("session/prompt", { stopReason: "end_turn" }); // A 收尾：以前 B 在这之后被当 prompt 重发
      await tick();
      await tick();
      expect(receipts(f, "B")).toBe(1);
      expect(h.prompts).toEqual(["A"]);
      expect(h.failures).toEqual([expect.objectContaining({ ...UNKNOWN, message: expect.stringContaining("B") })]);
      expect(h.loop.busy).toBe(false);
    });
  }

  test("整条链：prompt 和 steer 都在途时适配器退出 → 两张卡、都不可重试，steer 那条不改回 prompt", async () => {
    const f = fakeAdapter();
    await attached(f);
    const h = looped(f);
    await h.loop.submit("A");
    const b = h.loop.submit("B");
    await tick();
    f.close("exit 137");
    await b;
    await tick();
    expect(h.prompts).toEqual(["A"]);
    expect(h.failures).toHaveLength(2);
    expect(h.failures.every((x) => x.kind === "error" && x.retry === false && x.deliveryUnknown)).toBe(true);
    expect(new Set(h.failures.map((x) => x.key)).size).toBe(2);
  });

  test("steer 回包合规但结果认不出（null / {} / 认不出的 outcome）→ deliveredUnknown；failed / deferred 照旧 failed", async () => {
    for (const result of [null, {}, { outcome: "queuedSomewhere" }]) {
      const f = fakeAdapter();
      await attached(f);
      const s = f.session.steer("x");
      f.reply("_session/steering", result);
      expect(await s).toMatchObject({ outcome: "deliveredUnknown", failure: { ...UNKNOWN, message: expect.stringContaining("认不出") } });
    }
    for (const outcome of ["failed", "deferred"]) {
      const f = fakeAdapter();
      await attached(f);
      const s = f.session.steer("y");
      f.reply("_session/steering", { outcome });
      expect(await s).toEqual({ outcome: "failed" });
    }
  });

  test("prompt 回包合规但结果认不出（{} / null / 认不出的 stopReason）：不报 done，按投递不明；合法终态照旧 done", async () => {
    for (const result of [{}, null, { stopReason: "weird" }]) {
      const f = fakeAdapter();
      await attached(f);
      const p = f.session.prompt("a");
      f.reply("session/prompt", result);
      expect(await p).toMatchObject({ kind: "failed", failure: { ...UNKNOWN, message: expect.stringContaining("认不出") } });
    }
    const f = fakeAdapter();
    await attached(f);
    for (const stopReason of ["end_turn", "max_tokens", "max_turn_requests", "refusal"]) {
      const p = f.session.prompt("b");
      f.reply("session/prompt", { stopReason });
      expect(await p).toEqual({ kind: "done" });
    }
  });

  test("适配器明说投递不明但错误消息为空：prompt / steer 照样按投递不明，文案有兜底", async () => {
    const f = fakeAdapter();
    await attached(f);
    const quiet = (method: string) => f.raw({ id: f.last(method).id, error: { code: -32603, message: "", data: { deliveryUnknown: true } } });
    const p = f.session.prompt("a");
    quiet("session/prompt");
    expect(await p).toMatchObject({ kind: "failed", failure: { ...UNKNOWN, message: expect.stringContaining("对端没说明原因") } });
    const s = f.session.steer("b");
    quiet("_session/steering");
    expect(await s).toMatchObject({ outcome: "deliveredUnknown", failure: { ...UNKNOWN, message: expect.stringContaining("对端没说明原因") } });
  });

  test("保持原样：写出之前连接已断（sent:false）→ prompt 照旧可续跑，steer 照旧抛错（调度器改回 prompt）", async () => {
    const f = fakeAdapter();
    await attached(f);
    f.close("exit 1");
    const o = (await f.session.prompt("x")) as { kind: "failed"; failure: AcpFailure };
    expect(o.failure).toEqual({ kind: "error", key: expect.stringMatching(/^rpc:/), message: "acp 连接已断，session/prompt 发不出去" });
    expect(failureEntry(o.failure, "t")).toMatchObject({ isApiErrorMessage: true });
    expect(await f.session.steer("y").catch((e) => e.message)).toBe("acp 连接已断，_session/steering 发不出去");
  });

  test("保持原样：适配器明确回的结果——AIR 可重试照旧可续跑；steer 的 JSON-RPC 错误照旧抛错", async () => {
    const f = fakeAdapter();
    await attached(f);
    const p = f.session.prompt("a");
    const sessionFailure = { id: "t9:error", revision: 1, category: "network", severity: "error", title: "stream disconnected", actions: ["retry"] };
    f.reply("session/prompt", { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure } } } });
    const o = (await p) as { kind: "failed"; failure: AcpFailure };
    expect(o.failure).toEqual({ kind: "error", key: "air:t9:error", message: "stream disconnected", retry: true });
    expect(failureEntry(o.failure, "t")).toMatchObject({ isApiErrorMessage: true });
    const s = f.session.steer("b");
    f.raw({ id: f.last("_session/steering").id, error: { code: -32603, message: "no active turn" } });
    expect(await s.catch((e) => e.message)).toBe("no active turn");
  });

  test("保持原样：initialize 在途断线，错误文字与分类逐字不变", async () => {
    const f = fakeAdapter();
    const init = f.session.initialize();
    f.close("exit 1");
    const e = await init.catch((x) => x);
    expect(e.message).toBe("acp 连接断了（exit 1）");
    expect(String(e)).toBe("Error: acp 连接断了（exit 1）");
    expect(classifyPromptError(e, "start#1")).toEqual({ kind: "error", key: "rpc:start#1", message: "acp 连接断了（exit 1）" });
  });
});

describe("AcpSession · 权限与配置", () => {
  test("权限请求交给宿主出卡：点了回 selected，超时 / 取消回 cancelled", async () => {
    let answer: string | null = "decline";
    const f = fakeAdapter({ permission: async () => answer });
    await attached(f);
    const options = [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }, { optionId: "decline", name: "Decline", kind: "reject_once" }];
    const req = { toolCall: { toolCallId: "c1", title: "rm -rf x", kind: "execute" }, options };
    f.raw({ id: 900, method: "session/request_permission", params: req });
    await tick();
    expect(f.sent.find((m) => m.id === 900)).toEqual({ jsonrpc: "2.0", id: 900, result: { outcome: { outcome: "selected", optionId: "decline" } } });
    answer = null;
    f.raw({ id: 901, method: "session/request_permission", params: req });
    await tick();
    expect(f.sent.find((m) => m.id === 901).result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("setConfig：不在选项里的本地就挡；合法的调 set_config_option 并更新缓存", async () => {
    const f = fakeAdapter();
    await attached(f);
    expect(await f.session.setConfig("model", "gpt-9")).toMatchObject({ ok: false });
    expect(f.last("session/set_config_option")).toBeUndefined();
    const p = f.session.setConfig("model", "gpt-5.6-luna");
    f.reply("session/set_config_option", { configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "gpt-5.6-luna", options: [{ value: "gpt-5.6-luna", name: "luna" }] }] });
    expect(await p).toEqual({ ok: true });
    expect(f.session.configOptions[0].currentValue).toBe("gpt-5.6-luna");
  });
});
