import { describe, expect, test } from "bun:test";
import { hashCred, type CredRecord } from "../src/lib/caller-cred.ts";
import { IDENTITY_UNVERIFIED, resolveCallerIdentity, type CallerIdentity } from "../src/lib/caller-identity.ts";
import { identityFlags, ledgerArgs, ledgerFamily, ledgerWrite } from "../src/lib/order-ledger-exit.ts";
import { routeOrderTool, type OrderToolHandler, type VerifiedCall } from "../src/lib/order-tool-route.ts";
import { isOrderTool, ORDER_TOOLS, orderTool } from "../src/lib/order-tools.ts";

const TA = "a".repeat(64);
const creds: Record<string, CredRecord> = { [hashCred(TA)]: { agent: "agent-a", family: "claude-code", sessionId: "launch-a", issuedAt: "t" } };
const agents = [{ name: "agent-a", channelId: "ch-a", sessionId: "now-a" }, { name: "agent-b", channelId: "ch-b", sessionId: "now-b", runtime: "codex" }];
const who = (credHash: string | undefined, channelId: string, downgraded = false): CallerIdentity =>
  resolveCallerIdentity({ credHash, channelId, downgraded }, { creds, agents, controlChannelId: "ctl" });

function recorder() {
  const calls: { call: VerifiedCall; args: unknown }[] = [];
  const h: OrderToolHandler = async (call, args) => (calls.push({ call, args }), { ok: true, echoed: true });
  return { calls, handlers: { take_order: h, deliver: h, ask: h } };
}

describe("routeOrderTool：身份门在 handler 之前", () => {
  test("已验证 → handler 拿到的 agent / 会话 / 家族 / 频道都来自身份", async () => {
    const { calls, handlers } = recorder();
    const r = await routeOrderTool("take_order", who(hashCred(TA), "ch-a"), "ch-a", { agent: "agent-b", sessionId: "forged" }, handlers);
    expect(r).toEqual({ ok: true, echoed: true });
    expect(calls[0].call).toEqual({ agent: "agent-a", sessionId: "now-a", family: "claude-code", channelId: "ch-a" });
  });

  test.each([
    ["没有凭据", () => who(undefined, "ch-a")],
    ["A 的凭据注册在 B 的频道（串单）", () => who(hashCred(TA), "ch-b")],
    ["凭据已被新启动顶掉", () => who(hashCred("d".repeat(64)), "ch-a")],
    ["ACP 代理降级（callerDowngraded）", () => who(hashCred(TA), "ch-a", true)],
  ])("%s → identity_unverified，handler 一次都不调", async (_n, make) => {
    const { calls, handlers } = recorder();
    for (const tool of ["take_order", "deliver", "ask", "nope"]) {
      const r = await routeOrderTool(tool, make(), "ch-a", {}, handlers);
      expect(r).toMatchObject({ ok: false, code: IDENTITY_UNVERIFIED });
    }
    expect(calls).toEqual([]);
  });

  test("已验证但没有频道 → 拒（不让 manager 以 owner 身份写）", async () => {
    const { calls, handlers } = recorder();
    expect(await routeOrderTool("deliver", who(hashCred(TA), "ch-a"), undefined, {}, handlers)).toMatchObject({ ok: false, code: IDENTITY_UNVERIFIED });
    expect(calls).toEqual([]);
  });

  test("不认识的工具名 / 原型链上的名字 → unknown_tool", async () => {
    const { handlers } = recorder();
    for (const t of ["nope", "toString", "__proto__", 42]) {
      expect(await routeOrderTool(t, who(hashCred(TA), "ch-a"), "ch-a", {}, handlers)).toMatchObject({ ok: false, code: "unknown_tool" });
    }
  });
});

describe("写台账出口", () => {
  const call: VerifiedCall = { agent: "agent-a", sessionId: "s1", family: "claude-code", channelId: "ch-a" };

  test("子进程以调用方频道跑；每次都带 dedup；自由文本用 --k=v", async () => {
    const seen: { args: string[]; ch: string }[] = [];
    const r = await ledgerWrite(call, async (args, ch) => (seen.push({ args, ch }), { ok: true, duplicate: false }), "deliver", "T1",
      { from: "build", text: "--from fix 开头也不是旗标", evidence: undefined }, "k1");
    expect(r).toEqual({ ok: true, duplicate: false });
    expect(seen).toEqual([{ args: ["ledger", "deliver", "T1", "--from=build", "--text=--from fix 开头也不是旗标", "--dedup=k1"], ch: "ch-a" }]);
  });

  test("manager 拒绝原样转成 {ok:false, code, error}；没频道不跑", async () => {
    expect(await ledgerWrite(call, async () => ({ ok: false, code: "conflict", error: "阶段不对" }), "deliver", "T1", {}, "k")).toEqual({ ok: false, code: "conflict", error: "阶段不对" });
    expect(await ledgerWrite(call, async () => ({ ok: false, error: "x" }), "deliver", "T1", {}, "k")).toMatchObject({ code: "ledger" });
    let ran = false;
    expect(await ledgerWrite({ ...call, channelId: "" }, async () => ((ran = true), { ok: true }), "deliver", "T1", {}, "k")).toMatchObject({ ok: false });
    expect(ran).toBe(false);
  });

  test("会话 / 家族只来自身份；缺一项 → null", () => {
    expect(identityFlags(call)).toEqual({ session: "s1", family: "claude" });
    expect(identityFlags({ ...call, family: "codex" })).toEqual({ session: "s1", family: "codex" });
    expect(identityFlags({ ...call, family: "pi" })).toBeNull();
    expect(identityFlags({ ...call, sessionId: null })).toBeNull();
    expect(ledgerFamily({ family: null })).toBeNull();
    expect(ledgerArgs("review", "T1", {}, "d")).toEqual(["ledger", "review", "T1", "--dedup=d"]);
  });
});

describe("channel-server 侧：一种帧透传", () => {
  test("三个执行者工具、两个审查员工具（T97）都登记了", () => {
    expect(ORDER_TOOLS.map((t) => t.name)).toEqual(["take_order", "deliver", "ask", "take_review", "submit_verdict"]);
    expect(isOrderTool("deliver")).toBe(true);
    expect(isOrderTool("whoami")).toBe(false);
  });

  test("参数原样装进 order_tool 帧；ok=false 标 isError；请求失败也是 isError", async () => {
    const sent: any[] = [];
    const ok = await orderTool(async (m) => (sent.push(m), { ok: true, order: null }), "take_order", undefined);
    expect(sent[0]).toEqual({ type: "order_tool", tool: "take_order", args: {} });
    expect(ok.isError).toBeUndefined();
    const no = await orderTool(async () => ({ ok: false, code: IDENTITY_UNVERIFIED, error: "x" }), "deliver", { v: 1 });
    expect(no.isError).toBe(true);
    expect(JSON.parse(no.content[0].text)).toMatchObject({ code: IDENTITY_UNVERIFIED });
    const boom = await orderTool(async () => { throw new Error("Bridge 请求超时"); }, "ask", {});
    expect(boom).toMatchObject({ isError: true, content: [{ text: "Bridge 请求超时" }] });
  });
});
