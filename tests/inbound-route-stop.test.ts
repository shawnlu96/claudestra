/**
 * jrt-stale-lifts-stop（第 3 轮对抗审查）：叫停之前押着的 owner 旧消息，叫停之后才投出时不能解除「停」——
 * 否则 Autopilot 随后替人续上。真的 preemptForHuman / turnCuts / yieldReason；押着的消息由入站路由判了排队（on 档）。
 */
import { afterAll, expect, test } from "bun:test";
import { configureInboundRoute } from "../src/bridge/inbound-route.js";
import { preemptForHuman } from "../src/bridge/preempt.js";
import type { Envelope } from "../src/bridge/router.js";
import { turnCuts } from "../src/bridge/turn-cuts.js";
import { yieldReason } from "../src/lib/autopilot-run.js";

afterAll(() => configureInboundRoute({ readMode: () => "off", now: () => Date.now() }));
const owner = { kind: "user", userId: "u1", username: "owner", channelId: "c-o" };
const env = (ch: string, id: string, content: string, ts: number, route?: object): Envelope =>
  ({ from: owner, to: { kind: "local", channelId: ch, agentName: "agent-pm", ws: {} }, intent: "request", content,
    meta: { messageId: id, threadId: `t-${id}`, ts: new Date(ts).toISOString(), triggerKind: "user_discord", ...(route ? { inboundRoute: route } : {}) } }) as unknown as Envelope;
/** owner 的「停」打断了一回合（preemptForHuman 发键后记的那一条，这里直接记、不发键） */
function ownerStops(ch: string): void {
  turnCuts.noteHuman(ch, true);
  turnCuts.record({ channelId: ch, agent: "agent-pm", cause: "stopword", byMessageId: `stop-${ch}`, byName: "owner", tools: { inflight: [] }, interrupted: true });
}
const autopilot = (ch: string) => yieldReason({ turnBusy: false, online: true, interruptHold: turnCuts.interruptHold(ch) }, 1e13);

test("停之前判了排队的 owner 旧消息，停之后投出：仍 stopped，Autopilot 仍 human_stopped", async () => {
  configureInboundRoute({ readMode: () => "on", now: () => 0 });
  const ch = "c-stale-stop";
  const old = env(ch, "m-old", "辛苦了，回头看", Date.now() - 60_000, { action: "queue", p: 0.97 });
  await preemptForHuman(old, ch, "agent-pm"); // 到达：判了排队，押着
  ownerStops(ch);
  expect(turnCuts.interruptHold(ch)).toBe("stopped");
  await preemptForHuman(old, ch, "agent-pm"); // 回合结束 flush 投出旧消息
  expect(turnCuts.interruptHold(ch)).toBe("stopped");
  expect(autopilot(ch)).toBe("human_stopped");
});

test("对照：停之后 owner 新开口的消息照旧解除「停」", async () => {
  configureInboundRoute({ readMode: () => "on", now: () => 0 });
  const ch = "c-fresh-after-stop";
  ownerStops(ch);
  await preemptForHuman(env(ch, "m-new", "好了继续吧", Date.now() + 1_000, { action: "queue", p: 0.97 }), ch, "agent-pm");
  expect(turnCuts.interruptHold(ch)).toBeNull();
});
