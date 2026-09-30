/**
 * bridge/preempt.ts sentBeforeStop / noteAtSend（T13f r2 P1）：号在请求进 bridge 时就领，之后传图、下载附件、答卡片的 await 里
 * 后到的「停」可能先走完——号的先后和投递的先后不再一致。先到、停之后才投的那条：agent 收到的要带「停之前发的，先别照做」抬头，
 * 也不能再当开口去抢占（再发一次键、写「处理完接着做被打断的事」），不然 owner 最后一句是停，agent 收到的最后一句是继续，接着干。
 * 前两条是审查员的探针（rv-t13f-cc-work/head/tests/zz-r2-probe.test.ts）改写的，断言 agent 实际收到的正文。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { interruptGate } from "../src/bridge/interrupt-gate.js";
import { createInterruptGate } from "../src/lib/interrupt-gate.js";
import { setExtensionSocket } from "../src/bridge/pi-abort.js";
import { manualInterrupt, noteAtSend, preemptForHuman, setStopHooks, waitsForIdle } from "../src/bridge/preempt.js";
import { flushHeld } from "../src/bridge/held-flush.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { isHumanRequest, type Delivery } from "../src/bridge/router.js";
import { holdsUntilIdle } from "../src/lib/turn-state.js";
import { arrivalOf, stampArrival } from "../src/bridge/arrival-stamp.js";
import { turnCuts } from "../src/bridge/turn-cuts.js";
import type { Envelope } from "../src/bridge/router.js";

const CC = "cc-before-stop-ch";
const log: string[] = [];
const orig = { preempt: interruptGate.preempt, manual: interruptGate.manual };
beforeAll(() => {
  setExtensionSocket(() => undefined, { deliver: async () => undefined, ownerId: () => "owner", books: () => ({}) as never, hold: () => {} });
  setStopHooks({ clearAgentPendings: () => undefined });
  interruptGate.preempt = async (_c, _a, o) => (log.push(o?.stop ? "esc(stop)" : "esc(preempt)"), { fired: true });
  interruptGate.manual = async () => (log.push("esc(manual)"), { keys: ["Escape"] });
});
afterAll(() => void Object.assign(interruptGate, orig));

type Kind = "api" | "bridge";
const env = (id: string, text: string, req: object, o: { intent?: string; kind?: Kind } = {}): Envelope => ({
  from: o.kind === "bridge" ? { kind: "bridge", label: "t" } : { kind: "api", name: "owner", tokenId: "tok-owner", owner: true },
  to: { kind: "local", channelId: CC, agentName: "agent-cc" }, intent: o.intent ?? "request", content: text,
  meta: { messageId: id, triggerKind: "api_user", ts: new Date().toISOString(), threadId: `thr-${id}`, arrivalSeq: stampArrival(req) },
}) as unknown as Envelope;
/** agent 收到的正文和 channel 属性（bridge.ts deliverToLocal：不带抬头渲染好的正文，ws.send 前一刻拼抬头） */
const received = (e: Envelope) => {
  const meta: Record<string, string> = {};
  return { body: noteAtSend(e, CC, "正文", meta), meta };
};
const fresh = () => (turnCuts.forget(CC), (log.length = 0));
/** 先后两个请求进来（a 先 b 后），各自在入口领号 */
const arrive = () => [{}, {}].map((r) => (stampArrival(r), r));

describe("先到、叫停之后才投的：抬头写停之前发的，不再抢占（T13f r2 P1）", () => {
  test("A：先到「继续+图」（上传慢），后到的「停」字先走完；继续晚投", async () => {
    fresh();
    const [goReq, stopReq] = arrive();
    await preemptForHuman(env("s", "停", stopReq), CC, "agent-cc");
    const go = env("g", "继续，看这张图", goReq);
    await preemptForHuman(go, CC, "agent-cc");
    expect(log).toEqual(["esc(stop)"]); // 继续没有再打断一次
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
    const { body, meta } = received(go);
    expect(body).toStartWith("[⏹ 这条是叫停之前发来的，停之后才送到");
    expect(body).toContain("先别照做，问用户还要不要");
    expect(body).not.toContain("接着做被打断的事");
    expect(meta.interrupt_note).toBe("true");
  });

  test("B：先到「继续」，后按的停止按钮先走完；继续晚投", async () => {
    fresh();
    const [goReq, stopReq] = arrive();
    await manualInterrupt(CC, "master:agent-cc", "claude-code", "agent-cc", "api", { owner: true }, arrivalOf(stopReq));
    const go = env("g2", "继续", goReq);
    await preemptForHuman(go, CC, "agent-cc");
    expect(log).toEqual(["esc(manual)"]);
    expect(received(go).body).toContain("叫停之前");
  });

  test("停在继续投递途中的 await 里才走完（继续已经抢占过、写了「接着做」）：ws.send 前一刻改成停之前发的", async () => {
    fresh();
    const [goReq, stopReq] = arrive();
    const go = env("g3", "继续", goReq);
    await preemptForHuman(go, CC, "agent-cc");
    expect(go.meta.interruptNote).toContain("接着做被打断的事");
    await manualInterrupt(CC, "master:agent-cc", "claude-code", "agent-cc", "api", { owner: true }, arrivalOf(stopReq));
    const { body } = received(go);
    expect(body).toStartWith("[⏹ 这条是叫停之前");
    expect(body).not.toContain("⚡"); // 只留一块抬头：历史只剥一块（lib/inbound-body.ts）
  });

  test("答卡片（response，sendCalm 直投、不经抢占）：先作答、后到的停先走完 → 答复带停之前发的", async () => {
    fresh();
    const [answerReq, stopReq] = arrive();
    await preemptForHuman(env("s4", "停", stopReq), CC, "agent-cc");
    expect(received(env("a4", "用户选了：批准", answerReq, { intent: "response" })).body).toContain("叫停之前");
  });

  test("对照：停之后才到的继续照常——不加抬头、解除叫停", async () => {
    fresh();
    const [stopReq, goReq] = arrive();
    await preemptForHuman(env("s5", "停", stopReq), CC, "agent-cc");
    const go = env("g5", "继续", goReq);
    await preemptForHuman(go, CC, "agent-cc");
    expect(turnCuts.interruptHold(CC)).toBeNull();
    const { body, meta } = received(go);
    expect(body).not.toContain("叫停之前");
    expect(meta.interrupt_note === "true").toBe(!!go.meta.interruptNote);
  });

  test("bridge 自己的通知、停字本身不加；押后队列已经加过的不重复加、也不再抢占", async () => {
    fresh();
    const [heldReq, noticeReq, oldStopReq, stopReq] = [...arrive(), ...arrive()];
    await preemptForHuman(env("s6", "停", stopReq), CC, "agent-cc");
    expect(received(env("n6", "提醒", noticeReq, { kind: "bridge" })).body).toBe("正文");
    expect(received(env("s6old", "停", oldStopReq)).body).not.toContain("叫停之前");
    const held = env("h6", "继续", heldReq);
    [held.meta.interruptNote, held.meta.sentBeforeStop] = ["[⏹ 这条是叫停之前（10:00）发来的，押到现在才送到]", true]; // held-flush.ts 加的
    log.length = 0;
    await preemptForHuman(held, CC, "agent-cc");
    expect(log).toEqual([]);
    expect(received(held).body).toStartWith("[⏹ 这条是叫停之前（10:00）");
  });
});

/**
 * T13f r3 P1：停之前到的人类消息不抢占，就不能在回合中途投——CC 回合起始的推理流里收到的 channel 通知会被静默丢掉。
 * 目标忙时押到空闲（bridge.ts deliverToLocal 用 waitsForIdle 判押，held-flush 忙时不投它），出队时仍带抬头、仍不抢占。
 * 第一条是审查员的探针（rv-t13f-cc-work/head/tests/zz-r3-busy.test.ts）改写的
 */
describe("停之前到的人类消息：忙时押、闲了投、带抬头、零按键（T13f r3 P1）", () => {
  const busy = { main: "busy", bg: false } as const;
  const idle = { main: "idle", bg: false } as const;

  test("停投出去、agent 正在回应「已停」；晚到的「继续」既不打断，也押到空闲", async () => {
    fresh();
    const [goReq, stopReq] = arrive();
    await preemptForHuman(env("s7", "停", stopReq), CC, "agent-cc");
    log.length = 0;
    const go = env("g7", "继续，看这张图", goReq);
    await preemptForHuman(go, CC, "agent-cc");
    expect(log).toEqual([]);
    expect(holdsUntilIdle(go.from.kind, waitsForIdle(go, CC), busy)).toBe(true);
    expect(holdsUntilIdle(go.from.kind, waitsForIdle(go, CC), idle)).toBe(false);
  });

  test("对照：停之后才到的继续照旧不押（靠抢占）；bridge 通知照旧看 waitForIdle", async () => {
    fresh();
    const [stopReq, goReq, noticeReq] = [...arrive(), {}];
    stampArrival(noticeReq);
    await preemptForHuman(env("s8", "停", stopReq), CC, "agent-cc");
    const go = env("g8", "继续", goReq);
    expect(holdsUntilIdle(go.from.kind, waitsForIdle(go, CC), busy)).toBe(false);
    const notice = env("n8", "提醒", noticeReq, { kind: "bridge" });
    expect(waitsForIdle(notice, CC)).toBe(false);
    notice.meta.waitForIdle = true;
    expect(waitsForIdle(notice, CC)).toBe(true);
  });

  test("押着的这条：目标忙时 flush 不投它，空闲了才投；投出去带抬头、不发键", async () => {
    fresh();
    const [goReq, stopReq] = arrive();
    await preemptForHuman(env("s9", "停", stopReq), CC, "agent-cc");
    log.length = 0;
    const go = env("g9", "继续", goReq);
    const held = new HeldQueue(null);
    const to = go.to as never;
    held.set(CC, [{ env: go, to, heldAt: Date.now() }]);
    go.meta.sentBeforeStop = waitsForIdle(go, CC); // deliverToLocal 判押时打上的标，跟着押后条目
    const got: string[] = [];
    let working = true;
    const deps = {
      held, compacting: () => false, working: async () => working, isHumanRequest, client: () => ({ ws: {} as never }), touch: () => undefined,
      stopMark: (c: string) => turnCuts.stopMark(c), settled: async () => true,
      deliver: async (e: Envelope): Promise<Delivery> => {
        await preemptForHuman(e, CC, "agent-cc");
        got.push(noteAtSend(e, CC, "正文", {}));
        return { envelope: e, outcome: { kind: "sent" } };
      },
    };
    await flushHeld(deps, CC, "sweep");
    expect(got).toEqual([]);
    expect(held.get(CC)?.length).toBe(1);
    working = false;
    await flushHeld(deps, CC, "stop");
    expect(got.length).toBe(1);
    expect(got[0]).toStartWith("[⏹ 这条是叫停之前");
    expect(log).toEqual([]);
    expect(held.get(CC)).toBeUndefined();
  });
});

/**
 * T13f 终审 P1：入口时还没有停，普通消息照常去抢占；gate 判完忙闲、下层正等窗口 / 锁 / 间隔时，owner 在终端按了 Esc（watcher 记下
 * 比它晚的停）。发键那一刻（wanted）要撤回、一个键都不发——人的 Esc 已让 CC 空闲，再来一发会开 Rewind；键发出后收尾那一拍里才停的，
 * 不记抢占 cut（盖掉停的 cut、回合结束还提醒「接着做」）。真实 createInterruptGate，只把发键的 await 换成可控的。
 * 第一条是审查员的探针（rv-t13f-work/probe-final-stale-preempt.ts）改写的
 */
describe("入口之后、发键之前才叫停：普通抢占撤回（T13f 终审 P1）", () => {
  const terminalStop = () =>
    turnCuts.record({ channelId: CC, agent: "agent-cc", cause: "terminal", tools: { inflight: [] }, stopOrder: turnCuts.arrivals.backdate(Date.now(), true) });
  /** 下层发键前停在 during() 上；settle = 键发出后收尾那一拍（SETTLE_MS）里要做的事 */
  const realGate = (h: { during?: () => void; settle?: () => void }) => {
    const r = { sends: 0, hasWanted: false };
    interruptGate.preempt = createInterruptGate({
      resolve: async () => ({ win: "private", runtime: "claude-code" }), probe: async () => ({ main: r.sends ? "idle" : "busy", bg: false }),
      sleep: async () => h.settle?.(), onPreempted: () => undefined,
      interrupt: async (_w, _r, _c, _k, wanted) => {
        r.hasWanted = !!wanted;
        await Promise.resolve(h.during?.());
        if (wanted && !wanted()) throw Object.assign(new Error("withdrawn"), { name: "KeyWithdrawnError" });
        r.sends++;
        return ["Escape"];
      },
    }).preempt;
    return r;
  };
  afterAll(() => void (interruptGate.preempt = orig.preempt));

  test("下层等着发键时终端记停：零键、不记抢占、停着；忙时押、闲时带「停之前」抬头", async () => {
    fresh();
    const r = realGate({ during: terminalStop });
    const go = env("g10", "继续", ((q) => (stampArrival(q), q))({}));
    await preemptForHuman(go, CC, "agent-cc");
    expect(r).toEqual({ sends: 0, hasWanted: true });
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
    expect(turnCuts.get(CC)?.cause).toBe("terminal");
    expect(holdsUntilIdle(go.from.kind, waitsForIdle(go, CC), { main: "busy", bg: false })).toBe(true);
    const { body, meta } = received(go);
    expect(body).toStartWith("[⏹ 这条是叫停之前");
    expect(body).not.toContain("接着做被打断的事");
    expect(meta.interrupt_note).toBe("true");
  });

  test("键发出后收尾那一拍里才记停：不记抢占 cut，停的 cut 留着、回合结束不提醒续做", async () => {
    fresh();
    let stopped = false;
    const r = realGate({ settle: () => void (!stopped && r.sends && ((stopped = true), terminalStop())) });
    const go = env("g11", "继续", ((q) => (stampArrival(q), q))({}));
    await preemptForHuman(go, CC, "agent-cc");
    expect(r.sends).toBe(1);
    expect(turnCuts.get(CC)?.cause).toBe("terminal");
    expect(received(go).body).toStartWith("[⏹ 这条是叫停之前");
    expect(turnCuts.onStop(CC, "Stop", "agent-cc")).toBeNull();
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
  });

  test("对照：发键途中没人叫停，照常抢占、记抢占 cut", async () => {
    fresh();
    const r = realGate({});
    const go = env("g12", "继续", ((q) => (stampArrival(q), q))({}));
    await preemptForHuman(go, CC, "agent-cc");
    expect(r).toEqual({ sends: 1, hasWanted: true });
    expect(turnCuts.get(CC)?.cause).toBe("preempt");
    expect(received(go).body).toContain("接着做被打断的事");
  });
});
