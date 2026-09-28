/**
 * bridge/held-flush.ts：押后队列投递的交错场景（codex 2026-09-28 复核要求的集成测试）——
 * 投到一半目标又忙只留原条、计时不变、不 touch；await 期间被别处摘掉的不投；租约内不投；忙时只投人类消息；
 * 不在线 / 压缩中 / 别人正在投都不动；投递报错留着下次再投。
 */
import { describe, expect, test } from "bun:test";
import { flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, INBOX_LEASE_MS, type HeldItem } from "../src/bridge/held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";

const ws = { tag: "target-ws" } as never;
const item = (content: string, from: "local" | "user" = "local", heldAt = 1000): HeldItem => ({
  env: {
    from: from === "local" ? { kind: "local", agentName: "agent-codex", channelId: "c-codex", ws } : { kind: "user", userId: "u1", username: "owner" },
    to: { kind: "local", agentName: "agent-me", channelId: "c-me", ws },
    intent: "request", content,
    meta: { messageId: `m-${content}`, triggerKind: "agent_tool", ts: "2026-09-28T00:00:00Z", threadId: `thr-${content}` },
  } as Envelope,
  to: { kind: "local", agentName: "agent-me", channelId: "c-me", ws } as LocalEndpoint,
  heldAt,
});
const sent = (env: Envelope, note?: string): Delivery => ({ envelope: env, outcome: { kind: "sent", ...(note ? { note } : {}) } });

function harness(items: HeldItem[], over: Partial<FlushDeps> = {}) {
  const held = new HeldQueue(null);
  held.set("c-me", items);
  const delivered: string[] = [];
  const touched: string[] = [];
  const deps: FlushDeps = {
    held,
    compacting: () => false,
    working: async () => false,
    isHumanRequest: (env) => env.from.kind === "user",
    client: () => ({ ws }),
    deliver: async (env) => {
      delivered.push(String(env.content));
      return sent(env);
    },
    touch: (c) => touched.push(c),
    ...over,
  };
  return { held, deps, delivered, touched, contents: () => (held.get("c-me") ?? []).map((i) => String(i.env.content)) };
}

describe("flushHeld", () => {
  test("空闲：逐条投、每条先 touch 再出队", async () => {
    const h = harness([item("a"), item("b")]);
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["a", "b"]);
    expect(h.touched).toEqual(["c-me", "c-me"]);
    expect(h.contents()).toEqual([]);
  });

  test("投完第一条目标又忙：第二条原条目留着、heldAt 不变、不 touch、不重复入队", async () => {
    const h = harness([item("a"), item("b", "local", 1234)]);
    let n = 0;
    h.deps.deliver = async (env) => {
      if (n++ === 0) return sent(env);
      h.held.holdEnv(env); // 和 deliverToLocal 见目标在忙时一样，把同一封再押一次
      return sent(env, "queued");
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.touched).toEqual(["c-me"]);
    const q = h.held.get("c-me")!;
    expect(q.map((i) => i.env.content)).toEqual(["b"]);
    expect(q[0].heldAt).toBe(1234);
  });

  test("await 期间被别处摘掉（24 小时放弃 / kill 清理）的不再投", async () => {
    const h = harness([item("a"), item("b")]);
    h.deps.deliver = async (env) => {
      h.delivered.push(String(env.content));
      const b = h.held.get("c-me")!.find((i) => i.env.content === "b")!;
      h.held.remove("c-me", b); // 投 a 的同时，别处把 b 摘了
      return sent(env);
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["a"]);
    expect(h.contents()).toEqual([]);
  });

  test("投递途中（deliver 自己的 await 里）这条被摘掉：守卫返回 false，deliverToLocal 据此既不发也不押回", async () => {
    const h = harness([item("a")]);
    let guardSaw: boolean | undefined;
    h.deps.deliver = async (env, _to, stillWanted) => {
      expect(stillWanted?.()).toBe(true); // 进来时还在
      h.held.remove("c-me", h.held.get("c-me")![0]); // 模拟 await 期间 kill 清理
      guardSaw = stillWanted?.();
      return { envelope: env, outcome: { kind: "dropped", reason: "已从押后队列撤下" } };
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(guardSaw).toBe(false);
    expect(h.touched).toEqual([]);
    expect(h.contents()).toEqual([]);
  });

  test("check_inbox 租约内的不投，过期的照投", async () => {
    const now = Date.now();
    const leased = { ...item("leased"), lease: { batchId: "inbox_x", at: now } };
    const expired = { ...item("expired"), lease: { batchId: "inbox_y", at: now - INBOX_LEASE_MS - 1 } };
    const h = harness([leased, expired, item("plain")]);
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["expired", "plain"]);
    expect(h.contents()).toEqual(["leased"]);
  });

  test("目标在回合中：只投人类消息，agent 消息留着", async () => {
    const h = harness([item("agent-msg"), item("human-msg", "user")], { working: async () => true });
    await flushHeld(h.deps, "c-me", "compact_end");
    expect(h.delivered).toEqual(["human-msg"]);
    expect(h.contents()).toEqual(["agent-msg"]);
  });

  test("额度闸里的频道：目标空闲也只投人类消息，agent 消息不投（不会每分钟投一次再被押回来）", async () => {
    const h = harness([item("agent-msg"), item("human-msg", "user")], { walled: async () => true });
    await flushHeld(h.deps, "c-me", "sweep");
    expect(h.delivered).toEqual(["human-msg"]);
    expect(h.contents()).toEqual(["agent-msg"]);
  });

  test("不在线 / 压缩中 / 别人正在投：一条都不动", async () => {
    const offline = harness([item("a")], { client: () => undefined });
    await flushHeld(offline.deps, "c-me", "stop");
    const compacting = harness([item("a")], { compacting: () => true });
    await flushHeld(compacting.deps, "c-me", "stop");
    const claimed = harness([item("a")]);
    claimed.held.claim("c-me");
    await flushHeld(claimed.deps, "c-me", "stop");
    for (const h of [offline, compacting, claimed]) {
      expect(h.delivered).toEqual([]);
      expect(h.contents()).toEqual(["a"]);
    }
  });

  test("投递报错：留在队里、不 touch，后面的照投；结束后释放频道锁", async () => {
    const h = harness([item("bad"), item("good")]);
    h.deps.deliver = async (env) => {
      if (env.content === "bad") return { envelope: env, outcome: { kind: "error", error: new Error("ws closed") } };
      h.delivered.push(String(env.content));
      return sent(env);
    };
    await flushHeld(h.deps, "c-me", "stop");
    expect(h.delivered).toEqual(["good"]);
    expect(h.touched).toEqual(["c-me"]);
    expect(h.contents()).toEqual(["bad"]);
    expect(h.held.claim("c-me")).toBe(true);
  });
});
