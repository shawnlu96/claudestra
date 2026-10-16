/**
 * jrt-forward-inherits-route（r4 P2）：A 收到的 owner 消息在 on 档被判了排队（结论写在信封上），A 用 forward_to_agent 转给 B——
 * 转出的信封不带 A 的结论，到 B 那里重新判（B 的忙闲、B 的排队）；切回 off 后在 B 也照「转交只保留抢占」走。
 */
import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { handleForward, initForward, rememberInbound } from "../src/bridge/forward.js";
import { configureInboundRoute, routeAdmitsWhileBusy } from "../src/bridge/inbound-route.js";
import type { Envelope } from "../src/bridge/router.js";
import { routeEligible } from "../src/lib/inbound-route.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";

afterAll(() => configureInboundRoute({ readMode: () => "off", now: () => Date.now() }));

test("转出的信封不带原目标的入站路由结论：B 那里重新问 Jev，off 档照旧抢占", async () => {
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: { "agent-a": { channelId: "ch-a", status: "active" }, "agent-b": { channelId: "ch-b", status: "active" } } }));
  const wsA = { tag: "a" }, wsB = { tag: "b" };
  const sent: Envelope[] = [];
  initForward({
    clients: new Map([["ch-a", { ws: wsA }], ["ch-b", { ws: wsB }]]) as never, deliver: async (e: Envelope) => void sent.push(e),
    pendingReplies: new Map(), pendingThreads: new Map(), emitEvent: () => {}, discord: null, controlChannelId: "",
  } as never);
  const env = {
    from: { kind: "user", userId: "u1", username: "owner", channelId: "ch-a" }, to: { kind: "local", channelId: "ch-a", agentName: "agent-a", ws: wsA },
    intent: "request", content: "把登录页改成深色", meta: { messageId: "m1", threadId: "t1", ts: new Date().toISOString(), triggerKind: "user_discord" },
  } as unknown as Envelope;
  rememberInbound(env, "ch-a"); // deliverToLocal 先记（引用）
  env.meta.inboundRoute = { action: "queue", p: 0.95, noted: true }; // 随后 routeInbound 按 A 的忙闲把结论写到同一个信封上
  await handleForward(wsA as never, { messageId: "m1", target: "b", reason: "归 B 管" });
  const fwd = sent[0];
  expect(fwd).toBeDefined();
  expect(fwd.meta.inboundRoute).toBeUndefined();
  expect(routeEligible(fwd, false)).toBe(true);
  configureInboundRoute({ readMode: () => "off" });
  expect(routeAdmitsWhileBusy(fwd)).toBe(true);
});
