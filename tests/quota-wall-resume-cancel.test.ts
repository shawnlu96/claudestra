/** 撞额度撤续跑（bridge/quota-wall-wiring.ts）：只撤自己那份计划；押在队里的直接撤下，队外的由 resumeStillWanted 在最终发送前拦 */
import { describe, expect, test } from "bun:test";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { flushHeld } from "../src/bridge/held-flush.js";
import { cancelResumePlan, rebuildResumePlans, resumeStillWanted, trackResumePlan } from "../src/bridge/quota-wall-wiring.js";
import type { Envelope } from "../src/bridge/router.js";

const env = (from: Envelope["from"], id: string, ch = "c1"): Envelope => ({
  from, to: { kind: "local", channelId: ch, ws: undefined as never }, intent: "notification", content: id,
  meta: { messageId: id, triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: "t", waitForIdle: true },
});
const resume = (id: string, ch = "c1") => env({ kind: "bridge", label: "api-error-resume" }, id, ch);

describe("续跑计划的撤销", () => {
  test("押在队里（目标压缩中）时撞额度：撤下这一份，压缩结束 flush 只发 owner 的话", async () => {
    const held = new HeldQueue(null);
    trackResumePlan("c1", "plan1");
    held.holdEnv(resume("plan1"));
    held.holdEnv(env({ kind: "user", userId: "u", username: "owner", channelId: "c1" } as Envelope["from"], "owner 的话"));
    expect(cancelResumePlan(held, "c1")).toBe("plan1");
    expect(cancelResumePlan(held, "c1")).toBeNull(); // 只撤一次
    const sent: Envelope[] = [];
    await flushHeld({
      held, compacting: () => false, working: async () => false, isHumanRequest: () => false,
      client: () => ({ ws: {} as never }), touch: () => {},
      deliver: async (e: Envelope) => (sent.push(e), { envelope: e, outcome: { kind: "sent" } }),
    } as unknown as Parameters<typeof flushHeld>[0], "c1", "after compaction");
    expect(sent.map((e) => e.content)).toEqual(["owner 的话"]);
  });

  test("投递途中（还没入队、还没 ws.send）撞额度：最终发送前 resumeStillWanted 拦下这一份，别的续跑 / 别的消息不受影响", () => {
    const held = new HeldQueue(null);
    trackResumePlan("c2", "plan2");
    expect(resumeStillWanted(resume("plan2", "c2"))).toBe(true);
    cancelResumePlan(held, "c2");
    expect(resumeStillWanted(resume("plan2", "c2"))).toBe(false);
    expect(resumeStillWanted(resume("plan3", "c2"))).toBe(false); // 未知计划不放行
    trackResumePlan("c2", "plan3");
    expect(resumeStillWanted(resume("plan3", "c2"))).toBe(true); // 之后新挂的计划照常
    trackResumePlan("c2", "plan4");
    expect(resumeStillWanted(resume("plan3", "c2"))).toBe(false); // 被新计划顶掉的旧信封也不发
    expect(resumeStillWanted(env({ kind: "bridge", label: "turn-cuts" }, "plan2", "c2"))).toBe(true);
  });

  test("撤销只认计划 id：别的 bridge 通知不动", () => {
    const held = new HeldQueue(null);
    held.holdEnv(env({ kind: "bridge", label: "turn-cuts" }, "cut"));
    trackResumePlan("c1", "new");
    cancelResumePlan(held, "c1");
    expect((held.get("c1") ?? []).map((i) => i.env.meta.messageId)).toEqual(["cut"]);
  });

  test("第 5 轮 P2-1：重启后从押后队列恢复的续跑，计划跟着重建——撞额度照样撤得掉", () => {
    const held = new HeldQueue(null); // 相当于从盘上恢复出来的队列
    held.holdEnv(resume("before-restart", "c3"));
    expect(rebuildResumePlans(held)).toBe(1); // 启动时 planOf 先清空再重建
    expect(resumeStillWanted(resume("before-restart", "c3"))).toBe(true);
    expect(cancelResumePlan(held, "c3")).toBe("before-restart");
    expect(held.get("c3") ?? []).toHaveLength(0);
    expect(resumeStillWanted(resume("before-restart", "c3"))).toBe(false);
  });
});
