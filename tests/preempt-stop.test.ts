/**
 * bridge/preempt.ts 的 owner「停」（adv5 P1 / P2-1）：Pi 正在处理别的 agent 的请求时 owner 叫停——停止按钮、网页停字、API 停字——
 * agent 间的待回账都要在发中止之前清掉（Pi 停下马上报 Stop，晚一步看门狗就拿旧账把它催起一轮）；
 * API 停字自己的同步等待在中止之前登记（叫停引起的那次 Stop 的兜底收尾跳过它，bridge.ts 用 stopWaitIds），留给停字那一轮去答，
 * 那一轮迟迟不来才结成一句「已叫停」。看门狗在「叫停后的第一次 Stop」不催那一半在 bridge.ts Stop hook（afterAbort），这里测停之前就清账这一半。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import { interruptGate } from "../src/bridge/interrupt-gate.js";
import { holdStopWait, setExtensionSocket, stopWaitIds } from "../src/bridge/pi-abort.js";
import { manualInterrupt, preemptForHuman, setStopHooks } from "../src/bridge/preempt.js";
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
  setExtensionSocket(() => undefined, { deliver: async (e) => void delivered.push(e), ownerId: () => "owner", books: () => books });
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
