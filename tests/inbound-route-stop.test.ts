/**
 * 入站路由与「停」：
 * - jrt-stale-lifts-stop（r3）：叫停之前判了排队、押着的 owner 旧消息，叫停之后才投出时不能解除「停」（否则 Autopilot 随后替人续上）；
 * - jrt-stop-refresh-blocks-go（r4）：缺省 off 档与改动前一致——停字之后 owner 新说的话照旧解除，哪怕停字被押住后再放出、
 *   或停字的打断闸还在等、下一条在叫停记录之后才处理。判据是「这一封第一次到达时算过开口」，不比时间戳。
 * 真的 preemptForHuman / turnCuts / flushHeld / yieldReason；打断闸替身不碰 tmux。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { configureInboundRoute } from "../src/bridge/inbound-route.js";
import { interruptGate } from "../src/bridge/interrupt-gate.js";
import { holdNotingStop, preemptForHuman, setStopHooks } from "../src/bridge/preempt.js";
import { isHumanRequest, type Envelope } from "../src/bridge/router.js";
import { turnCuts } from "../src/bridge/turn-cuts.js";
import { yieldReason } from "../src/lib/autopilot-run.js";
import type { RouteMode } from "../src/lib/inbound-route.js";

const realPreempt = interruptGate.preempt;
let mode: RouteMode = "off";
beforeAll(() => setStopHooks({ clearAgentPendings: () => undefined }));
afterEach(() => { interruptGate.preempt = realPreempt; });
afterAll(() => configureInboundRoute({ readMode: () => "off", now: () => Date.now() }));
/** 打断闸替身：目标空闲（停字照样记一条「停」），不碰 tmux */
const idleGate = () => { interruptGate.preempt = async () => ({ fired: false, why: "not_busy" }); };
const useMode = (m: RouteMode) => { mode = m; configureInboundRoute({ readMode: () => mode, now: () => 0 }); };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner = { kind: "user", userId: "u1", username: "owner", channelId: "c-o" };
let n = 0;
const mk = (ch: string, content: string, route?: object): Envelope =>
  ({ from: owner, to: { kind: "local", channelId: ch, agentName: "agent-pm", ws: { tag: ch } }, intent: "request", content,
    meta: { messageId: `m${++n}`, threadId: `t${n}`, ts: new Date().toISOString(), triggerKind: "user_discord", ...(route ? { inboundRoute: route } : {}) } }) as unknown as Envelope;
const autopilot = (ch: string) => yieldReason({ turnBusy: false, online: true, interruptHold: turnCuts.interruptHold(ch) }, 1e13);
/** owner 的「停」打断了一回合（preemptForHuman 发键后记的那一条，这里直接记、不发键） */
function ownerStops(ch: string): void {
  turnCuts.noteHuman(ch, true);
  turnCuts.record({ channelId: ch, agent: "agent-pm", cause: "stopword", byMessageId: `stop-${ch}`, byName: "owner", tools: { inflight: [] }, interrupted: true });
}
/** 押后队列放出（Stop / 压缩结束 / 出闸）：投递层替身先走 preemptForHuman，和 deliverToLocal 同一处 */
async function release(q: HeldQueue, ch: string): Promise<void> {
  clearOpenedBy();
  const deliver: FlushDeps["deliver"] = async (env) => {
    if (isHumanRequest(env)) await preemptForHuman(env, ch, "agent-pm");
    return { envelope: env, outcome: { kind: "sent" } };
  };
  await flushHeld({ held: q, compacting: () => false, working: async () => false, isHumanRequest, client: () => ({ ws: { tag: ch } as never }), deliver,
    stoppedAt: (c) => turnCuts.stoppedAt(c), touch: () => {}, settled: async () => true, agentBatch: () => false, render: async (e) => e.content, mirror: () => {} }, ch, "release");
}

test("r3 jrt-stale-lifts-stop：停之前判了排队的 owner 旧消息，停之后投出：仍 stopped，Autopilot 仍 human_stopped", async () => {
  useMode("on");
  const ch = `c-stale-${Date.now()}`;
  const old = mk(ch, "辛苦了，回头看", { action: "queue", p: 0.97 });
  await preemptForHuman(old, ch, "agent-pm"); // 到达：判了排队，押着（这一次算 owner 开口）
  ownerStops(ch);
  expect(turnCuts.interruptHold(ch)).toBe("stopped");
  await preemptForHuman(old, ch, "agent-pm"); // 回合结束 flush 投出旧消息
  expect(turnCuts.interruptHold(ch)).toBe("stopped");
  expect(autopilot(ch)).toBe("human_stopped");
});

test("对照：停之后 owner 新开口的消息（on 档判了排队）照旧解除「停」", async () => {
  useMode("on");
  const ch = `c-fresh-${Date.now()}`;
  ownerStops(ch);
  await preemptForHuman(mk(ch, "好了继续吧", { action: "queue", p: 0.97 }), ch, "agent-pm");
  expect(turnCuts.interruptHold(ch)).toBeNull();
});

for (const via of ["wall", "compact"] as const) {
  test(`r4 jrt-stop-refresh-blocks-go（off 档）：${via === "wall" ? "撞墙画面" : "压缩中"}押住「停」+「继续」，放出后叫停解除（同改动前）`, async () => {
    useMode("off");
    idleGate();
    const ch = `c-${via}-${Date.now()}`;
    const q = new HeldQueue(null);
    const stop = mk(ch, "停");
    if (via === "wall") holdNotingStop(q, stop, { channelId: ch }, "agent-pm", undefined); // 撞墙画面：一个键不发，当场记叫停、押住
    else { await preemptForHuman(stop, ch, "agent-pm"); q.holdEnv(stop); } // 压缩中：抢占不打断但记叫停，然后押住
    await sleep(20);
    const go = mk(ch, "算了，继续做吧");
    if (via === "compact") await preemptForHuman(go, ch, "agent-pm"); // 压缩中到达时先走一遍抢占判断
    q.holdEnv(go);
    await sleep(20);
    await release(q, ch); // 停字放出时再记一次「停」、刷新叫停时刻；紧跟的「继续」照旧解除
    expect(turnCuts.interruptHold(ch)).toBeNull();
    expect(autopilot(ch)).toBeNull();
  });
}

test("r4 jrt-stop-refresh-blocks-go（off 档）：停字之后 100ms 的下一条在叫停记录之后才处理，照旧解除", async () => {
  useMode("off");
  const ch = `c-race-${Date.now()}`;
  interruptGate.preempt = async (_c, _a, o) => (o?.stop ? (await sleep(300), { fired: true }) : { fired: false, why: "cooldown" });
  const p = preemptForHuman(mk(ch, "停"), ch, "agent-pm");
  await sleep(100);
  const go = mk(ch, "改成先做 B"); // 停字之后 100ms 发出
  await p; // 停字的叫停记录落在这之后
  await preemptForHuman(go, ch, "agent-pm"); // 下载附件 / 等 Jev 之后才走到这里
  expect(turnCuts.interruptHold(ch)).toBeNull();
});
