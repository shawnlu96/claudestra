/** 撞额度撤续跑：已经押进队里（目标压缩中 / 回合中）还没发的「继续」要撤掉，别的押后消息不动（bridge/quota-wall-wiring.ts dropHeldResume） */
import { describe, expect, test } from "bun:test";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { flushHeld } from "../src/bridge/held-flush.js";
import { dropHeldResume } from "../src/bridge/quota-wall-wiring.js";
import type { Envelope } from "../src/bridge/router.js";

const env = (from: Envelope["from"], content: string): Envelope => ({
  from, to: { kind: "local", channelId: "c1", ws: undefined as never }, intent: "notification", content,
  meta: { messageId: `m_${content}`, triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: "t", waitForIdle: true },
});

describe("dropHeldResume", () => {
  test("server_error 的续跑被押在队里、随后撞额度：撤掉它，压缩结束 flush 只发别的押后消息", async () => {
    const held = new HeldQueue(null);
    held.holdEnv(env({ kind: "bridge", label: "api-error-resume" }, "继续（server_error）"));
    held.holdEnv(env({ kind: "user", userId: "u", username: "owner", channelId: "c1" } as Envelope["from"], "owner 的话"));
    expect(dropHeldResume(held, "c1")).toBe(1);
    expect(dropHeldResume(held, "c1")).toBe(0);
    const sent: Envelope[] = [];
    await flushHeld({
      held, compacting: () => false, working: async () => false, isHumanRequest: () => false,
      client: () => ({ ws: {} as never }), touch: () => {},
      deliver: async (e: Envelope) => (sent.push(e), { envelope: e, outcome: { kind: "sent" } }),
    } as unknown as Parameters<typeof flushHeld>[0], "c1", "after compaction");
    expect(sent.map((e) => e.content)).toEqual(["owner 的话"]);
  });

  test("别的频道、别的 bridge 通知不动", () => {
    const held = new HeldQueue(null);
    held.holdEnv(env({ kind: "bridge", label: "turn-cuts" }, "打断收尾提醒"));
    expect(dropHeldResume(held, "c1")).toBe(0);
    expect(dropHeldResume(held, "other")).toBe(0);
    expect(held.get("c1")).toHaveLength(1);
  });
});
