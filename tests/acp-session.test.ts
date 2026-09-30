import { describe, expect, test } from "bun:test";
import { AcpSession, CLIENT_CAPABILITIES } from "../src/lib/acp/session.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import type { PermissionCard } from "../src/lib/acp/permissions.ts";

const SID = "019a0000-0000-7000-8000-000000000001";
const tick = () => new Promise((r) => setTimeout(r, 0));

/** 假适配器：记下宿主发出的每条消息；reply / raw 模拟适配器输出，close 模拟进程退出 */
function fakeAdapter(opts: { permission?: (c: PermissionCard) => Promise<string | null> } = {}) {
  const sent: any[] = [];
  let onData: (c: string) => void = () => {};
  let onClose: (w: string) => void = () => {};
  const wire: RpcWire = { write: (l) => sent.push(JSON.parse(l)), onData: (cb) => (onData = cb as any), onClose: (cb) => (onClose = cb), close: () => {} };
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
  f.reply("initialize", { agentCapabilities: { sessionCapabilities: resume ? { resume: {} } : {} }, _meta: { steering: { supported: true } } });
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
    f.reply("initialize", { agentCapabilities: { sessionCapabilities: { resume: {}, fork: {} } } });
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
    expect(await s2.catch((e) => e.message)).toContain("exit 137");
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
