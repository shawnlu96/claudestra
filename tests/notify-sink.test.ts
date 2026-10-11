/**
 * 外部通知渠道的出口（src/bridge/notify/sink.ts）：待你处理按派发器判定 + 渠道的「只在我离开时推」、类型勾选、停用、
 * 不带正文（渠道级与全局）、Talk @ 受在不在管而安全提醒不受、ask 按渠道去重（banner 后再 push 还能推）、once 提醒重试不重推、
 * 频控（含测试发送）、出口异常不挡 Web Push、最近结果。HTTP 细节在 notify-transport.test.ts。假 fetch 记下请求，假 DNS 不出网。
 */
import { describe, expect, test } from "bun:test";
import { createChannelSink, recentResults, sendTest, type SinkDeps, type SinkMsg } from "../src/bridge/notify/sink.js";
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
  const deps: SinkDeps = { read: () => file, fetch: fakeFetch, lookup: async () => ["203.0.113.7"], linkBase: () => "https://relay.example", fp: "fp1", retryDelayMs: 1, log: () => {}, ...over };
  const sink = createChannelSink(deps);
  return { sink, calls, deps };
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

describe("Codex 对抗审查 notify r1 #5–#8", () => {
  test("#7 banner 时被跳过的渠道，同一条 ask 之后以 push 再来还能推；已经推过的渠道不重推", async () => {
    const away = ntfy();
    const always = ntfy({ onlyWhenAway: false });
    const { sink, calls } = harness([away, always]);
    sink.ask(ask("r7"), "banner", false, MSG);
    await flush();
    expect(calls).toHaveLength(1); // 只有 always
    sink.ask(ask("r7"), "push", false, MSG);
    await flush();
    expect(calls).toHaveLength(2); // away 这次补上，always 不重推
  });
  test("#6 带 once 的提醒：送到过的渠道重试时不再发；没送到的照发", async () => {
    const good = ntfy({ types: ["system"] });
    const { sink, calls } = harness([good]);
    sink.notice("system", MSG, "quota-1");
    await flush();
    sink.notice("system", MSG, "quota-1");
    await flush();
    expect(calls).toHaveLength(1);
    const failing = ntfy({ types: ["system"] });
    const f = harness([failing], { status: [500, 500] });
    f.sink.notice("system", MSG, "quota-2");
    await flush();
    f.sink.notice("system", MSG, "quota-2");
    await flush();
    expect(f.calls).toHaveLength(3); // 第一次 500 + 重试 500，第二次重发成功
  });
  test("#8 测试发送与正式发送共用每渠道频控；草稿另有全局每分钟 10 条", async () => {
    const c = ntfy();
    const { deps } = harness([c], { now: () => 7_000_000 });
    for (let i = 0; i < 20; i++) expect((await sendTest(c, deps)).ok).toBe(true);
    expect((await sendTest(c, deps)).error).toBe("rate_limited");
    const drafts = Array.from({ length: 11 }, () => ntfy());
    const rs = [];
    for (const d of drafts) rs.push(await sendTest(d, { ...deps, now: () => 8_000_000 }, true));
    expect(rs.filter((r) => r.error === "rate_limited")).toHaveLength(1);
  });
  test("#5 外部渠道抛错不挡 Web Push / APNs", async () => {
    const { createDispatcher } = await import("../src/bridge/push/dispatcher.js");
    const { closeWebState, openWebState } = await import("../src/lib/web-state.js");
    const { savePushSubscription } = await import("../src/lib/push-store.js");
    const db = openWebState(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } }, "Mozilla/5.0 (Macintosh)");
    let web = 0;
    const sender = {
      webPushKeys: () => ["K"], config: () => ({ mode: "direct", webPush: { vapidPublicKey: "K" }, apns: false }),
      sendWebPush: async () => (web++, { ok: true, gone: false, status: 201 }), sendApns: async () => ({ ok: true, gone: false }),
    };
    const boom = () => {
      throw new TypeError("Invalid URL");
    };
    const logs: string[] = [];
    const d = createDispatcher({ db, sender: sender as never, isOwnerChat: () => false, channels: { ask: boom, notice: boom }, log: (m) => void logs.push(m) });
    expect(await d.notice({ title: "新设备已配对", body: "x", kind: "security" })).toEqual({ sent: 1, failed: 0 });
    d.stop();
    closeWebState(":memory:");
    expect(web).toBe(1);
    expect(logs.some((l) => l.includes("外部通知渠道出错"))).toBe(true);
  });
  test("#5 配置文件里写坏的 openUrl 读出来按没填处理", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { readNotifyFile } = await import("../src/lib/notify-store.js");
    const p = join(mkdtempSync(join(tmpdir(), "notify-store-")), "notify-channels.json");
    writeFileSync(p, JSON.stringify({ channels: [{ id: "abcdef12", kind: "ntfy", topic: "t" }], openUrl: "not a url" }));
    const f = readNotifyFile(p);
    expect(f.channels).toHaveLength(1);
    expect(f).not.toHaveProperty("openUrl");
  });
});
