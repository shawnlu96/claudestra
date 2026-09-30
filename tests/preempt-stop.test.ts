/**
 * bridge/preempt.ts 的 owner「停」（adv5 P1 / P2-1）：Pi 正在处理别的 agent 的请求时 owner 叫停——停止按钮、网页停字、API 停字——
 * agent 间的待回账都要在发中止之前清掉（Pi 停下马上报 Stop，晚一步看门狗就拿旧账把它催起一轮）；
 * API 停字自己的同步等待在中止之前登记（叫停引起的那次 Stop 的兜底收尾跳过它，bridge.ts 用 stopWaitIds），留给停字那一轮去答，
 * 那一轮迟迟不来才结成一句「已叫停」。看门狗在「叫停后的第一次 Stop」不催那一半在 bridge.ts Stop hook（afterAbort），这里测停之前就清账这一半。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import { interruptGate } from "../src/bridge/interrupt-gate.js";
import { holdStopWait, setExtensionSocket, stopWaitIds } from "../src/bridge/pi-abort.js";
import { holdNotingStop, interruptAgentByName, manualInterrupt, noteHeldStop, onCodexInterrupt, preemptForHuman, setStopHooks } from "../src/bridge/preempt.js";
import { arrivalOf, stampArrival } from "../src/bridge/arrival-stamp.js";
import { registerInteractionHandlers } from "../src/bridge/discord-interactions.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnCuts } from "../src/bridge/turn-cuts.js";
import type { Envelope } from "../src/bridge/router.js";
import { ownStateFilesPerTest } from "./state-files.ts";

const CH = "pi-stop-ch";
const log: string[] = [];
const delivered: Envelope[] = [];
type Wait = { messageId?: string; waitUntil?: number; resolve?: unknown };
const apiQueues = new Map<string, Wait[]>();
const books = {
  pendingReplies: new Map(), pendingThreads: new Map(), pendingInterAgentMsg: new Map(),
  pendingAgentCalls: { dropRequest: () => undefined }, pendingApiRequests: apiQueues,
};
const orig = { preempt: interruptGate.preempt, manual: interruptGate.manual };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 每条用例自己写一份只有 agent-pi 的 registry，跑完还原
ownStateFilesPerTest([REGISTRY_PATH], () =>
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: { "agent-pi": { channelId: CH, runtime: "pi", status: "active" } } })));

beforeAll(() => {
  setExtensionSocket(() => undefined, { deliver: async (e) => void delivered.push(e), ownerId: () => "owner", books: () => books, hold: () => {} });
  setStopHooks({ clearAgentPendings: (ch) => void log.push(`clear:${ch}`) });
  // 发键处换成记一笔：看清账和中止谁先谁后；中止那一刻停字自己的同步等待登记了没有（那一刻 Pi 报的 Stop 要跳过它）
  interruptGate.preempt = async () => (log.push(`abort(skip=${[...stopWaitIds(CH)].join(",")})`), { fired: true });
  interruptGate.manual = async () => (log.push("abort"), { keys: ["abort"] });
});
afterAll(() => {
  Object.assign(interruptGate, orig);
});

const stopEnv = (id: string, owner: boolean, text = "停"): Envelope =>
  ({
    from: { kind: "api", name: owner ? "owner" : "guest", tokenId: owner ? "tok-owner" : "tok-guest", owner },
    to: { kind: "local", channelId: CH, agentName: "agent-pi" }, intent: "request", content: text,
    meta: { messageId: id, triggerKind: "api_user", ts: new Date().toISOString(), threadId: `thr-${id}` },
  }) as unknown as Envelope;

describe("Pi 在处理别的 agent 的请求时 owner 叫停：先清 agent 间的待回账，再发中止", () => {
  test("停止按钮", async () => {
    log.length = 0;
    await manualInterrupt(CH, "master:agent-pi", "pi", "agent-pi", "button");
    expect(log).toEqual([`clear:${CH}`, "abort"]);
  });

  test("网页停字（wait:0，没有同步等待）：先清账；不登记、不另发答复", async () => {
    log.length = 0;
    delivered.length = 0;
    apiQueues.set(`tok-owner|${CH}`, [{ messageId: "s-web" }]); // wait:0 也进队列，只是不标 waitUntil
    await preemptForHuman(stopEnv("s-web", true), CH, "agent-pi");
    expect(log).toEqual([`clear:${CH}`, "abort(skip=)"]);
    expect(delivered).toEqual([]);
    apiQueues.clear();
  });

  test("API 停字（wait>0）：先清账；中止之前就登记了它自己的同步等待（那次 Stop 跳过它），它留在账上等停字那一轮答", async () => {
    log.length = 0;
    delivered.length = 0;
    // 真实时序（adv6 P2）：api-routes 先把请求放进队列、标 waitUntil，再 deliver（抢占在 deliver 里跑），resolve 要等 deliver 返回后才挂
    apiQueues.set(`tok-owner|${CH}`, [{ messageId: "other-req", waitUntil: Date.now() + 60_000, resolve: () => undefined }, { messageId: "s-api", waitUntil: Date.now() + 60_000 }]);
    await preemptForHuman(stopEnv("s-api", true), CH, "agent-pi");
    expect(log).toEqual([`clear:${CH}`, "abort(skip=s-api)"]);
    expect(apiQueues.get(`tok-owner|${CH}`)?.map((p) => p.messageId)).toEqual(["other-req", "s-api"]);
    expect(delivered).toEqual([]); // 不马上回：停字那一轮会答
    apiQueues.clear();
  });

  test("非 owner：停字按普通消息、按停止只打断这一回合——都不清 owner 这边的待回账", async () => {
    log.length = 0;
    await preemptForHuman(stopEnv("g1", false), CH, "agent-pi");
    await manualInterrupt(CH, "master:agent-pi", "pi", "agent-pi", "api", { owner: false, name: "guest" });
    expect(log.some((l) => l.startsWith("clear:"))).toBe(false);
  });
});

describe("agent 转交来的 owner 原话不算 owner 在这里开口（wf2 stop-semantics-6）", () => {
  const fwd = (id: string, text: string) => ({ ...stopEnv(id, true, text), meta: { ...stopEnv(id, true, text).meta, forwarded: true } }) as Envelope;
  test("转交的普通话不解除「停」、转交的停字不记成叫停；owner 自己说的照常", async () => {
    turnCuts.forget(CH);
    turnCuts.record({ channelId: CH, agent: "agent-pi", cause: "manual", tools: { inflight: [] } });
    await preemptForHuman(fwd("f1", "继续部署"), CH, "agent-pi");
    expect(turnCuts.interruptHold(CH)).toBe("stopped");
    await preemptForHuman(stopEnv("o1", true, "继续部署"), CH, "agent-pi");
    expect(turnCuts.interruptHold(CH)).toBeNull();
    turnCuts.forget(CH);
    await preemptForHuman(fwd("f2", "停"), CH, "agent-pi");
    expect(turnCuts.interruptHold(CH)).toBeNull();
  });
});

describe("停字那一轮迟迟不来：超时结成「已叫停」，不回 null", () => {
  test("超时还在账上 → 发一条带 inReplyTo 的 response（deliverToApi 按它认领）；登记随之撤掉", async () => {
    delivered.length = 0;
    apiQueues.set(`tok-owner|${CH}`, [{ messageId: "s-late", waitUntil: Date.now() + 60_000 }]); // resolve 还没挂也要登记上
    const settle = holdStopWait(stopEnv("s-late", true), CH, "agent-pi", 10);
    expect(stopWaitIds(CH).has("s-late")).toBe(true);
    settle?.("[⏹ bridge] 已叫停 agent-pi：Pi 回执：已中止当前回合。");
    await sleep(40);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ intent: "response", content: expect.stringContaining("已叫停 agent-pi"), to: { kind: "api", tokenId: "tok-owner" } });
    expect(delivered[0].meta.inReplyTo).toBe("s-late");
    expect(stopWaitIds(CH).has("s-late")).toBe(false);
    apiQueues.clear();
  });

  test("超时前停字那一轮已经答了（不在账上）→ 不再发", async () => {
    delivered.length = 0;
    apiQueues.set(`tok-owner|${CH}`, [{ messageId: "s-done", waitUntil: Date.now() + 60_000 }]);
    const settle = holdStopWait(stopEnv("s-done", true), CH, "agent-pi", 10);
    settle?.("已叫停");
    apiQueues.clear(); // 那一轮的回复认领走了
    await sleep(40);
    expect(delivered).toEqual([]);
    expect(stopWaitIds(CH).has("s-done")).toBe(false);
  });

  test("调用方等得比兜底短（wait=3 秒）：赶在它到期前回「已叫停」，不让它拿到 timedOut", async () => {
    delivered.length = 0;
    apiQueues.set(`tok-owner|${CH}`, [{ messageId: "s-short", waitUntil: Date.now() + 1_550 }]);
    holdStopWait(stopEnv("s-short", true), CH, "agent-pi")?.("已叫停");
    await sleep(80);
    expect(delivered.map((e) => e.meta.inReplyTo)).toEqual(["s-short"]);
    apiQueues.clear();
  });
});

describe("停在撞墙等待画面上（T24 wf3 delivery-hold-4 / 执行者主意 2）：一个键都不发，但 owner 的「停」当场记下", () => {
  const CC = "cc-wall-ch";
  const env = (id: string, owner: boolean, text = "停"): Envelope => ({ ...stopEnv(id, owner, text), to: { kind: "local", channelId: CC, agentName: "agent-cc" } }) as Envelope;
  test("owner 的停字被押住：清 agent 间待回账、记叫停（Autopilot 让位），抬头写停在等待画面、没有在跑", () => {
    log.length = 0;
    const e = env("held-stop", true);
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    expect(log).toEqual([`clear:${CC}`]);
    expect(turnCuts.stopMark(CC)?.at).toBeNumber();
    expect(e.meta.interruptNote).toContain("撞墙等待画面");
    expect(e.meta.interruptNote).not.toContain("没能替你打断");
  });
  test("同一条停字每分钟重投又押回来：只记第一次，停之后才来的 agent 回程槽不被清掉（T24 审查 P2-2）", () => {
    log.length = 0;
    const e = env("held-stop-again", true);
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    expect(log).toEqual([`clear:${CC}`]);
  });
  test("非 owner 的停、owner 的普通消息：不记叫停", () => {
    log.length = 0;
    for (const e of [env("g-stop", false), env("o-msg", true, "看一下日志")]) {
      noteHeldStop(e, "cc-other", "agent-cc", "claude-code");
      expect(e.meta.interruptNote).toBeUndefined();
    }
    expect(log).toEqual([]);
    expect(turnCuts.stopMark("cc-other")).toBeUndefined();
  });
  test("押住时记过的停字，最终送达（出闸 / 菜单关掉后）不再清一次槽：停之后才来的回程留着（T24 复核 P2-1）", async () => {
    log.length = 0;
    const e = env("held-then-sent", true);
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    await preemptForHuman(e, CC, "agent-cc");
    expect(log.filter((l) => l.startsWith("clear:"))).toEqual([`clear:${CC}`]);
    await preemptForHuman(env("fresh-stop", true), CC, "agent-cc"); // 对照：没押过的停照常清
    expect(log.filter((l) => l.startsWith("clear:"))).toEqual([`clear:${CC}`, `clear:${CC}`]);
  });
  test("押住时先打标再落盘：bridge 重启后从盘上恢复的同一条停字不再记、不再清（T24 复核 P2-2）", () => {
    log.length = 0;
    const p = join(mkdtempSync(join(tmpdir(), "held-stop-")), "held.json");
    const e = { ...env("persisted-stop", true), to: { kind: "local", channelId: CC, agentName: "agent-cc" } } as Envelope;
    holdNotingStop(new HeldQueue(p), e, { channelId: CC }, "agent-cc", "claude-code");
    const back = new HeldQueue(p).get(CC)![0]!.env;
    expect(back.meta.heldStopNoted).toBe(true);
    noteHeldStop(back, CC, "agent-cc", "claude-code");
    expect(log).toEqual([`clear:${CC}`]);
  });
  test("老版本落盘、没打标的停字：重启后再押一次，标记要写回盘，再重启也不丢（T24 复核 P2）", () => {
    log.length = 0;
    const p = join(mkdtempSync(join(tmpdir(), "held-old-")), "held.json");
    const e = { ...env("old-stop", true), to: { kind: "local", channelId: CC, agentName: "agent-cc" } } as Envelope;
    new HeldQueue(p).holdEnv(e); // 老版本：押住了但没有 heldStopNoted
    const q = new HeldQueue(p);
    const restored = q.get(CC)![0]!.env;
    holdNotingStop(q, restored, { channelId: CC }, "agent-cc", "claude-code"); // 重启后的扫描再押一次（同一封）
    expect(new HeldQueue(p).get(CC)![0]!.env.meta.heldStopNoted).toBe(true);
    expect(new HeldQueue(p).get(CC)!.length).toBe(1);
  });
  test("抢占复核时画面刚变成撞墙等待（闸回 wall_wait）：preemptForHuman 回 wall_wait，不写「没能打断」的抬头，交给调用方押住", async () => {
    interruptGate.preempt = async () => ({ fired: false, why: "wall_wait" });
    try {
      const e = env("race-stop", true);
      expect(await preemptForHuman(e, CC, "agent-cc")).toBe("wall_wait");
      expect(e.meta.interruptNote).toBeUndefined();
      expect(await preemptForHuman(env("race-msg", true, "看一下"), CC, "agent-cc")).toBe("wall_wait");
    } finally {
      interruptGate.preempt = async () => (log.push(`abort(skip=${[...stopWaitIds(CH)].join(",")})`), { fired: true });
    }
  });
});


/**
 * T13f：「停」和 owner 开口 / 作答的先后只比到达序号（lib/arrival-order.ts），不比墙钟毫秒。
 * T13e r1–r4 的时序探针：押住的旧停晚投、await 中作答（押住的 / 新来的）、同一毫秒两种先后、作答先到但回调晚走完。
 */
describe("停字与开口按到达序号排先后（T13f）", () => {
  const CC = "cc-arrival-ch";
  const env = (id: string, text = "停"): Envelope => ({ ...stopEnv(id, true, text), to: { kind: "local", channelId: CC, agentName: "agent-cc" } }) as Envelope;
  const aborted = () => log.some((l) => l.startsWith("abort"));
  /** 作答（asks.ts commitAnswer）：入口领号，await 之后才 noteHuman */
  const answer = (order = turnCuts.arrivals.order()) => turnCuts.noteHuman(CC, false, order);
  const withGate = async (gate: typeof interruptGate.preempt, run: () => Promise<unknown>) => {
    interruptGate.preempt = gate;
    try {
      await run();
    } finally {
      interruptGate.preempt = async () => (log.push(`abort(skip=${[...stopWaitIds(CH)].join(",")})`), { fired: true });
    }
  };
  const fresh = () => (turnCuts.forget(CC), (log.length = 0));
  /** 发键处的替身：await 途中 owner 作答，然后照 wanted 决定发不发 */
  const answerMidGate = (seen?: { wanted: boolean }): typeof interruptGate.preempt => async (_ch, _a, opts) => {
    if (seen) seen.wanted = !!opts?.wanted;
    answer();
    if (opts?.wanted && !opts.wanted()) return { fired: false, why: "withdrawn" };
    return log.push("abort"), { fired: true };
  };

  test("r1 P1-1：押住停 → owner 答卡片 → 停出队：作废，不打断、不重新挂起", async () => {
    fresh();
    const e = env("r1");
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
    answer();
    expect(turnCuts.interruptHold(CC)).toBeNull();
    await preemptForHuman(e, CC, "agent-cc");
    expect(turnCuts.interruptHold(CC)).toBeNull();
    expect(aborted()).toBe(false);
    expect(e.meta.interruptNote).toContain("已作废");
  });

  test("r2 P1：押住的停出队后、发键前（gate 的 await 里）owner 作答：wanted 为假，不发键、不挂起", async () => {
    fresh();
    const e = env("r2");
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    await withGate(answerMidGate(), () => preemptForHuman(e, CC, "agent-cc"));
    expect(aborted()).toBe(false);
    expect(turnCuts.interruptHold(CC)).toBeNull();
    expect(e.meta.interruptNote).toContain("已作废");
    expect(e.meta.interruptNote).not.toContain("打断了");
  });

  test("r3 P1：新来的停（没押过）在 gate 的 await 里 owner 作答：同样带 wanted，不发键、不挂起、不写「已替你打断」", async () => {
    fresh();
    const e = env("r3");
    const seen = { wanted: false };
    await withGate(answerMidGate(seen), () => preemptForHuman(e, CC, "agent-cc"));
    expect(seen.wanted).toBe(true);
    expect(aborted()).toBe(false);
    expect(turnCuts.interruptHold(CC)).toBeNull();
    expect(e.meta.interruptNote).toContain("已作废");
    expect(e.meta.interruptNote).not.toContain("打断");
  });

  test("键发出之后 owner 才作答：不再挂起，抬头照实写打断了、已作废", async () => {
    fresh();
    const e = env("after-key");
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    await withGate(async () => (answer(), { fired: true }), () => preemptForHuman(e, CC, "agent-cc"));
    expect(turnCuts.interruptHold(CC)).toBeNull();
    expect(e.meta.interruptNote).toContain("打断了当时在跑的回合");
    expect(e.meta.interruptNote).toContain("已作废");
  });

  describe("同一毫秒（冻结时钟）", () => {
    const FROZEN = Date.parse("2026-09-30T08:00:00Z");
    let spy: ReturnType<typeof spyOn> | undefined;
    beforeEach(() => void (spy = spyOn(Date, "now").mockReturnValue(FROZEN)));
    afterEach(() => spy?.mockRestore());

    test("r3 P2-2：停先到、owner 同一毫秒后作答：作废", async () => {
      fresh();
      const e = env("same-ms-stop-first");
      noteHeldStop(e, CC, "agent-cc", "claude-code");
      answer();
      await preemptForHuman(e, CC, "agent-cc");
      expect(aborted()).toBe(false);
      expect(turnCuts.interruptHold(CC)).toBeNull();
      expect(e.meta.interruptNote).toContain("已作废");
    });

    test("r4 P1：owner 先作答、同一毫秒后说「停」：停有效——发键、挂起，抬头不写作废", async () => {
      fresh();
      answer();
      const e = env("same-ms-answer-first");
      await preemptForHuman(e, CC, "agent-cc");
      expect(aborted()).toBe(true);
      expect(turnCuts.interruptHold(CC)).toBe("stopped");
      expect(e.meta.interruptNote).not.toContain("作废");
    });

    test("作答先到、但回调 await 完才走到 noteHuman（停已经记下）：不解除后到的停", async () => {
      fresh();
      const early = turnCuts.arrivals.order(); // 作答入口领的号
      const e = env("answer-lands-late");
      await preemptForHuman(e, CC, "agent-cc");
      answer(early);
      expect(turnCuts.interruptHold(CC)).toBe("stopped");
    });

    test("停先到、作答的 noteHuman 在停的 gate await 里：作废（与墙钟无关）", async () => {
      fresh();
      const e = env("stop-then-answer-in-gate");
      e.meta.arrivalSeq = turnCuts.arrivals.take();
      await withGate(answerMidGate(), () => preemptForHuman(e, CC, "agent-cc"));
      expect(aborted()).toBe(false);
      expect(turnCuts.interruptHold(CC)).toBeNull();
    });
  });

  test("owner 在停之前开的口不作废它；叫停记录的位置是到达序号，不是投递时刻", async () => {
    fresh();
    answer();
    const e = env("held-valid");
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    answer(turnCuts.arrivals.order()); // 押着期间 owner 又说了一句 → 解除
    const e2 = env("newer-stop"); // 之后又说「停」：新的停
    await preemptForHuman(e2, CC, "agent-cc");
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
    log.length = 0;
    await preemptForHuman(e, CC, "agent-cc"); // 旧停这时才出队：它之后 owner 开过口 → 作废；但不盖掉新的停
    expect(aborted()).toBe(false);
    expect(e.meta.interruptNote).toContain("已作废");
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
    expect(turnCuts.stopMark(CC)?.order).toEqual({ seq: e2.meta.arrivalSeq! });
  });

  test("押下之前 owner 已经开过口（停在押住时就作废了）：不记停、不清账，投出去时写作废", async () => {
    fresh();
    const e = env("stale-at-hold");
    e.meta.arrivalSeq = turnCuts.arrivals.take();
    answer();
    noteHeldStop(e, CC, "agent-cc", "claude-code");
    expect(log).toEqual([]);
    expect(e.meta.heldStopNoted).toBeUndefined();
    expect(turnCuts.interruptHold(CC)).toBeNull();
    await preemptForHuman(e, CC, "agent-cc");
    expect(aborted()).toBe(false);
    expect(e.meta.interruptNote).toContain("已作废");
  });

  test("停止按钮：按下之后、发键的 await 里 owner 开了口 → 记停时带上解除；之前开的口不解除", async () => {
    fresh();
    interruptGate.manual = async () => (answer(), log.push("abort"), { keys: ["Escape"] });
    try {
      await manualInterrupt(CC, "master:agent-cc", "claude-code", "agent-cc", "button");
    } finally {
      interruptGate.manual = async () => (log.push("abort"), { keys: ["abort"] });
    }
    expect(turnCuts.interruptHold(CC)).toBeNull();
    fresh();
    answer();
    await manualInterrupt(CC, "master:agent-cc", "claude-code", "agent-cc", "button");
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
  });
});

/**
 * T13f r1 P1-1：号在请求进 bridge 的第一时间领（bridge/arrival-stamp.ts），之后读正文、下载附件、查 registry 的 await 不改它。
 * 每类入口两种处理先后都跑一遍：结论只看进来的先后（stamp 的顺序），不看谁先走完。
 */
describe("入口领号：先到的请求卡在 await 里、后到的先走完（T13f r1 P1-1）", () => {
  const CC = "cc-entry-ch";
  const env = (id: string, text: string, from: object): Envelope => {
    const e = { ...stopEnv(id, true, text), to: { kind: "local", channelId: CC, agentName: "agent-cc" } } as Envelope;
    e.meta.arrivalSeq = stampArrival(from); // bridge.ts messageCreate / api-routes 建信封时取的就是入口领的那个号
    return e;
  };
  const fresh = () => (turnCuts.forget(CC), (log.length = 0));
  /** 先后两个请求进来（a 先 b 后），各自领号；然后按 order 给的先后跑完 */
  const arrive = () => [{}, {}].map((r) => (stampArrival(r), r));
  const noted = (e: Envelope) => e.meta.interruptNote ?? "";

  test("消息（Web 读正文 / Discord 下载附件）：先到的「继续」晚走完，不解除后到的停", async () => {
    fresh();
    const [goReq, stopReq] = arrive();
    await preemptForHuman(env("s1", "停", stopReq), CC, "agent-cc");
    await preemptForHuman(env("g1", "继续", goReq), CC, "agent-cc");
    expect(turnCuts.interruptHold(CC)).toBe("stopped");
  });

  test("消息：先到的「停」晚走完（后到的继续已经投了）= 作废，不发键、不挂起", async () => {
    fresh();
    const [stopReq, goReq] = arrive();
    await preemptForHuman(env("g2", "继续", goReq), CC, "agent-cc");
    log.length = 0;
    const late = env("s2", "停", stopReq);
    await preemptForHuman(late, CC, "agent-cc");
    expect(log.some((l) => l.startsWith("abort"))).toBe(false);
    expect(turnCuts.interruptHold(CC)).toBeNull();
    expect(noted(late)).toContain("已作废");
  });

  test("停止按钮（Web / Discord）：先按的停在查 registry 的 await 里，后到的「继续」先走完 → 记停时带上解除；反过来停着", async () => {
    for (const [first, want] of [["stop", null], ["go", "stopped"]] as const) {
      fresh();
      const [a, b] = arrive();
      const [stopReq, goReq] = first === "stop" ? [a, b] : [b, a];
      const pressed = interruptAgentByName("agent-cc", CC, { owner: true }, arrivalOf(stopReq)); // 读 registry 是真 await
      await preemptForHuman(env(`g-${first}`, "继续", goReq), CC, "agent-cc");
      await pressed;
      expect(turnCuts.interruptHold(CC)).toBe(want);
    }
  });

  test("Codex 的打断回报：hook 请求进来时的号；查程序发键的 await 里 owner 说了继续 → 记停时带上解除", async () => {
    fresh();
    const [hookReq, goReq] = arrive();
    const reported = onCodexInterrupt(CC, "agent-cc", arrivalOf(hookReq));
    await preemptForHuman(env("g-codex", "继续", goReq), CC, "agent-cc");
    await reported;
    expect(turnCuts.get(CC)?.cause).toBe("codex_interrupt");
    expect(turnCuts.interruptHold(CC)).toBeNull();
  });

  test("Discord 交互：派发那一刻就领号（鉴权、查 registry、deferUpdate 之前）", () => {
    let dispatch: (i: object) => unknown = () => undefined;
    registerInteractionHandlers({ on: (_: string, fn: typeof dispatch) => void (dispatch = fn) } as never, {} as never);
    const click = { type: 3, channelId: null, user: { id: "u" } };
    dispatch(click);
    const later = turnCuts.arrivals.take();
    expect(arrivalOf(click).seq).toBeLessThan(later);
    expect(stampArrival(click)).toBe(arrivalOf(click).seq); // 同一个请求只认第一次领的号
  });
});
