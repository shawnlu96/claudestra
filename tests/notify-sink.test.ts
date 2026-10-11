/**
 * 外部通知渠道的出口（src/bridge/notify/sink.ts）：待你处理按派发器判定 + 渠道的「只在我离开时推」、类型勾选、停用、
 * 不带正文（渠道级与全局）、Talk @ 受在不在管而安全提醒不受、同一条 ask 只推一次、重试与频控、最近结果。假 fetch 记下请求。
 */
import { describe, expect, test } from "bun:test";
import { createChannelSink, recentResults, sendToChannel, type SinkDeps, type SinkMsg } from "../src/bridge/notify/sink.js";
import { normalizeChannel, type NotifyChannel, type NotifyFile } from "../src/lib/notify-channels.js";
import type { Presence } from "../src/lib/owner-presence.js";

let seq = 0;
/** 每个用例用新的渠道 id：最近结果与频控是模块级的 */
const ntfy = (over: Record<string, unknown> = {}): NotifyChannel => {
  const c = normalizeChannel({ id: `ch${String(++seq).padStart(6, "0")}`, kind: "ntfy", topic: "t", ...over });
  if (typeof c === "string") throw new Error(c);
  return c;
};
const MSG: SinkMsg = { title: "待你处理 · agent-x", body: "要不要发版？", url: "/chat?ask=a1", tag: "cstra-ask-a1-open" };
const flush = () => new Promise((r) => setTimeout(r, 20));

function harness(channels: NotifyChannel[], over: Partial<SinkDeps> & { status?: number[]; presence?: () => Presence } = {}) {
  const calls: { url: string; topic: string; title: string; message: string; click?: string }[] = [];
  const statuses = [...(over.status ?? [])];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, ...JSON.parse(String(init.body)) });
    return new Response("{}", { status: statuses.shift() ?? 200 });
  }) as unknown as typeof fetch;
  const file: NotifyFile = { channels };
  const sink = createChannelSink({ read: () => file, fetch: fakeFetch, linkBase: () => "https://relay.example", fp: "fp1", retryDelayMs: 1, log: () => {}, ...over });
  return { sink, calls };
}
const ask = (id: string, urgency: "normal" | "urgent" = "normal") => ({ id, state: "open" as const, kind: "decide" as const, urgency });

describe("待你处理", () => {
  test("push 推给所有勾了 ask 的渠道；banner 只推给关了「只在我离开时推」的；none 不推", async () => {
    const away = ntfy();
    const always = ntfy({ onlyWhenAway: false });
    const noAsk = ntfy({ types: ["system"] });
    const { sink, calls } = harness([away, always, noAsk]);
    sink.ask(ask("a1"), "push", false, MSG);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ title: "待你处理 · agent-x", message: "要不要发版？", click: "https://relay.example/chat?ask=a1&fp=fp1" });
    calls.length = 0;
    sink.ask(ask("a2"), "banner", false, MSG);
    sink.ask(ask("a3"), "none", false, MSG);
    await flush();
    expect(calls).toHaveLength(1);
  });
  test("指给 owner 本人的指派事项按 push 算；同一条 ask 同一状态只推一次；停用的渠道不推", async () => {
    const { sink, calls } = harness([ntfy(), ntfy({ enabled: false })]);
    sink.ask(ask("b1"), "none", true, MSG);
    sink.ask(ask("b1"), "push", false, MSG);
    await flush();
    expect(calls).toHaveLength(1);
  });
});

describe("不带正文", () => {
  test("渠道开了「不带正文」或全局「推送不带正文」开着：只剩 Claudestra · 类型，链接回首页", async () => {
    const { sink, calls } = harness([ntfy({ hideContent: true })]);
    sink.ask(ask("c1"), "push", false, MSG);
    const g = harness([ntfy()], { noContent: () => true });
    g.sink.notice("security", { title: "新设备已配对", body: "「iPhone」刚配对了这台电脑", url: "/chat", tag: "cstra-notice-1" });
    await flush();
    for (const c of [...calls, ...g.calls]) {
      expect(c.title.startsWith("Claudestra · ")).toBe(true);
      expect(JSON.stringify(c)).not.toMatch(/agent-x|发版|iPhone|ask=/);
      expect(c.click).toBe("https://relay.example/chat?fp=fp1");
    }
    expect(calls).toHaveLength(1);
    expect(g.calls).toHaveLength(1);
  });
});

describe("系统提醒", () => {
  test("Talk @ 在 owner 正在用时不推给「只在我离开时推」的渠道；安全提醒照推", async () => {
    const { sink, calls } = harness([ntfy({ types: ["talk", "security"] })], { presence: () => "active" });
    sink.notice("talk", { ...MSG, title: "A @ 了你" });
    sink.notice("security", { ...MSG, title: "新设备已配对" });
    await flush();
    expect(calls.map((c) => c.title)).toEqual(["新设备已配对"]);
  });
});

describe("发送", () => {
  test("5xx 重试一次后成功；4xx 不重试；结果记进最近结果", async () => {
    const c = ntfy();
    const { calls } = harness([]);
    let n = 0;
    const flaky = (async () => new Response("", { status: n++ === 0 ? 502 : 200 })) as unknown as typeof fetch;
    expect(await sendToChannel(c, { type: "system", title: "x", body: "y", tag: "t", ts: 1 }, { fetch: flaky, retryDelayMs: 1 })).toEqual({ ok: true, status: 200 });
    expect(n).toBe(2);
    let m = 0;
    const bad = (async () => (m++, new Response("", { status: 401 }))) as unknown as typeof fetch;
    expect(await sendToChannel(c, { type: "system", title: "x", body: "y", tag: "t", ts: 1 }, { fetch: bad, retryDelayMs: 1 })).toEqual({ ok: false, status: 401, error: "HTTP 401" });
    expect(m).toBe(1);
    expect(calls).toHaveLength(0);
  });
  test("网络错误不抛，记成失败；每个渠道每分钟最多 20 条，超出的记 rate_limited", async () => {
    const c = ntfy({ types: ["system"] });
    let attempts = 0;
    const boom = (async () => {
      attempts++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { sink } = harness([c], { fetch: boom, now: () => 5_000_000 });
    for (let i = 0; i < 20; i++) sink.notice("system", { ...MSG, tag: `t${i}` });
    await flush();
    sink.notice("system", { ...MSG, tag: "t20" });
    await flush();
    expect(attempts).toBe(40); // 20 条各重试一次；第 21 条没发
    const rs = recentResults()[c.id];
    expect(rs).toHaveLength(20); // 只留最近 20 条
    expect(rs[0].error).toBe("rate_limited");
    expect(rs.slice(1).every((r) => r.error === "ECONNREFUSED" && !r.ok)).toBe(true);
  });
});

describe("接进推送派发器", () => {
  test("onAsk 把判定交给渠道（owner 在用 = banner）；notice 带上类型，缺省 system", async () => {
    const { createDispatcher } = await import("../src/bridge/push/dispatcher.js");
    const { closeWebState, openWebState } = await import("../src/lib/web-state.js");
    const got: unknown[][] = [];
    const channels = { ask: (...a: unknown[]) => void got.push(["ask", ...a]), notice: (...a: unknown[]) => void got.push(["notice", ...a]) };
    const sent = async () => ({ ok: true, gone: false });
    const sender = { webPushKeys: () => [], config: () => ({ mode: "direct", webPush: null, apns: false }), sendWebPush: sent, sendApns: sent };
    const db = openWebState(":memory:");
    const d = createDispatcher({ db, sender: sender as never, isOwnerChat: () => false, channels: channels as never, log: () => {} });
    const a = { id: "k1", fromAgent: "agent-x", title: "要不要发版？", state: "open" as const, kind: "decide" as const, blocking: true, urgency: "normal" as const, assignee: null };
    expect(await d.onAsk(a, "active")).toBe("banner");
    await d.notice({ title: "新设备已配对", body: "x", kind: "security" });
    await d.notice({ title: "状态文件不见了", body: "y" });
    d.stop();
    closeWebState(":memory:");
    expect(got[0]).toEqual(["ask", a, "banner", false, { title: "待你处理 · agent-x", body: "要不要发版？", url: "/chat?ask=k1", tag: "cstra-ask-k1-open" }]);
    expect(got.slice(1).map((g) => [g[1], (g[2] as { title: string }).title])).toEqual([["security", "新设备已配对"], ["system", "状态文件不见了"]]);
  });
});

test("失败原因里的请求地址换成主机名（webhook 地址带 token）", async () => {
  const c = normalizeChannel({ id: "hookscrub01", kind: "webhook", url: "https://hooks.example.com/services/T0/B0/SECRETTOKEN" });
  if (typeof c === "string") throw new Error(c);
  const boom = (async (url: string) => {
    throw new Error(`connect failed: ${url}`);
  }) as unknown as typeof fetch;
  const r = await sendToChannel(c, { type: "system", title: "x", body: "y", tag: "t", ts: 1 }, { fetch: boom, retryDelayMs: 1 });
  expect(r.error).toBe("connect failed: hooks.example.com");
});

test("非 2xx 记一句回包原因，回包里的 device key 只留尾四位", async () => {
  const c = normalizeChannel({ id: "barkreason1", kind: "bark", deviceKey: "AbCdEf123456" });
  if (typeof c === "string") throw new Error(c);
  const bad = (async () => new Response(JSON.stringify({ code: 400, message: "failed to get [AbCdEf123456] device token" }), { status: 400 })) as unknown as typeof fetch;
  const r = await sendToChannel(c, { type: "system", title: "x", body: "y", tag: "t", ts: 1 }, { fetch: bad, retryDelayMs: 1 });
  expect(r).toEqual({ ok: false, status: 400, error: "HTTP 400 · failed to get […3456] device token" });
});
