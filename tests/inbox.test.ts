/**
 * bridge/inbox.ts：agent 调 check_inbox 取回排队给它的 agent 消息——取走即出队、和 Stop 投递共用频道锁、
 * 一次最多 10 条、人类消息不碰、认不出调用方就报错。
 */
import { describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";

const me = { tag: "claudestra-ws" } as never;
const item = (content: string, kind: "local" | "user" = "local", heldAt = 0): HeldItem => ({
  env: {
    from: kind === "local" ? { kind: "local", agentName: "agent-codex", channelId: "c-codex", ws: me } : { kind: "user", userId: "u1", username: "owner" },
    to: { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws: me },
    intent: "request", content,
    meta: { messageId: `m-${content}`, triggerKind: "agent_tool", ts: "2026-09-28T00:00:00Z", threadId: "thr_1" },
  } as HeldItem["env"],
  to: { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws: me },
  heldAt,
});

function setup(items: HeldItem[]) {
  const held = new HeldQueue(null);
  const calls = new AgentCallBook(null);
  if (items.length) held.set("c-me", items);
  calls.set("c-me", { callerChannelId: "c-codex", callerName: "agent-codex", targetName: "agent-claudestra", ts: 1 });
  const mirrored: string[] = [];
  initInbox({
    clients: new Map([["c-me", { ws: me }]]),
    held, calls,
    render: async (env) => `[🤖 来自 ${env.from.kind === "local" ? env.from.agentName : "?"}]\n${env.content}`,
    emitIn: (_c, env) => mirrored.push(String(env.content)),
  });
  return { held, calls, mirrored };
}

describe("takeInbox", () => {
  test("取回 agent 消息：带来源和 message_id、出队、网页镜像、回程失效钟重新起算；人类消息留在队里", async () => {
    const { held, calls, mirrored } = setup([item("复核意见 1", "local", 0), item("人类补充", "user"), item("复核意见 2", "local", 0)]);
    const r = await takeInbox(me, 5 * 60_000);
    if ("error" in r) throw new Error(r.error);
    expect(r.result.n).toBe(2);
    expect(r.result.text).toContain("取回 2 条");
    expect(r.result.text).toContain("来自 agent-codex · message_id=m-复核意见 1 · 排队 5 分钟");
    expect(r.result.text).toContain("复核意见 2");
    expect(held.get("c-me")!.map((i) => i.env.content)).toEqual(["人类补充"]);
    expect(mirrored).toEqual(["复核意见 1", "复核意见 2"]);
    expect(calls.get("c-me")!.ts).toBeGreaterThan(1);
  });

  test("一次最多 10 条，提示还剩几条", async () => {
    const { held } = setup(Array.from({ length: 12 }, (_, i) => item(`m${i}`)));
    const r = await takeInbox(me);
    if ("error" in r) throw new Error(r.error);
    expect(r.result.n).toBe(10);
    expect(r.result.text).toContain("还剩 2 条");
    expect(held.get("c-me")).toHaveLength(2);
  });

  test("空的 / 正在被 Stop 投递（频道锁被占）/ 认不出调用方", async () => {
    const { held } = setup([]);
    const empty = await takeInbox(me);
    expect("result" in empty && empty.result.text).toContain("收件箱是空的");
    held.set("c-me", [item("x")]);
    held.claim("c-me");
    const busy = await takeInbox(me);
    expect("result" in busy && busy.result.n).toBe(0);
    expect(held.get("c-me")).toHaveLength(1);
    held.release("c-me");
    const stranger = await takeInbox({ tag: "other" } as never);
    expect("error" in stranger).toBe(true);
  });
});
