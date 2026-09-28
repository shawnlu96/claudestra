/**
 * bridge/preempt.ts 的 owner「停」（adv5 P1 / P2-1）：Pi 正在处理别的 agent 的请求时 owner 叫停——停止按钮、网页停字、API 停字——
 * agent 间的待回账都要在发中止之前清掉（Pi 停下马上报 Stop，晚一步看门狗就拿旧账把它催起一轮）；
 * API 停字自己的同步等待在中止期间不在账上（那次 Stop 的兜底收尾结不到它），停完结成一句固定的「已叫停」。
 * 看门狗在「叫停后的第一次 Stop」不催那一半在 bridge.ts Stop hook（afterAbort），这里测的是停之前就清账这一半。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import { interruptGate } from "../src/bridge/interrupt-gate.js";
import { setExtensionSocket } from "../src/bridge/pi-abort.js";
import { manualInterrupt, preemptForHuman, setStopHooks } from "../src/bridge/preempt.js";
import type { Envelope } from "../src/bridge/router.js";

const CH = "pi-stop-ch";
const log: string[] = [];
const delivered: Envelope[] = [];
type Wait = { messageId?: string; resolve?: unknown };
const apiQueues = new Map<string, Wait[]>();
const books = {
  pendingReplies: new Map(), pendingThreads: new Map(), pendingInterAgentMsg: new Map(),
  pendingAgentCalls: { dropRequest: () => undefined }, pendingApiRequests: apiQueues,
};
let createdRegistry = false;
const orig = { preempt: interruptGate.preempt, manual: interruptGate.manual };

beforeAll(() => {
  if (!existsSync(REGISTRY_PATH)) {
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: { "agent-pi": { channelId: CH, runtime: "pi", status: "active" } } }));
    createdRegistry = true;
  }
  setExtensionSocket(() => undefined, { deliver: async (e) => void delivered.push(e), ownerId: () => "owner", books: () => books });
  setStopHooks({ clearAgentPendings: (ch) => void log.push(`clear:${ch}`) });
  // 发键处换成记一笔：看清账和中止谁先谁后；中止期间再看一眼停字自己的同步等待在不在账上（那一刻 Pi 报的 Stop 会结掉账上的）
  interruptGate.preempt = async () => {
    log.push(`abort(stopWaitOnBook=${[...apiQueues.values()].flat().some((p) => p.messageId === "s-api")})`);
    return { fired: true };
  };
  interruptGate.manual = async () => (log.push("abort"), { keys: ["abort"] });
});
afterAll(() => {
  Object.assign(interruptGate, orig);
  if (createdRegistry) rmSync(REGISTRY_PATH, { force: true }); // 测试自己在临时状态目录里建的，删掉免得影响别的用例
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

  test("网页停字（wait:0，没有同步等待）：先清账；不另发「已叫停」答复", async () => {
    log.length = 0;
    delivered.length = 0;
    await preemptForHuman(stopEnv("s-web", true), CH, "agent-pi");
    expect(log).toEqual([`clear:${CH}`, "abort(stopWaitOnBook=false)"]);
    expect(delivered).toEqual([]);
  });

  test("API 停字（wait>0）：先清账；中止期间它自己的同步等待不在账上，停完结成「已叫停」、按 inReplyTo 认领", async () => {
    log.length = 0;
    delivered.length = 0;
    const other = { messageId: "other-req", resolve: () => undefined };
    apiQueues.set(`tok-owner|${CH}`, [other, { messageId: "s-api", resolve: () => undefined }]);
    await preemptForHuman(stopEnv("s-api", true), CH, "agent-pi");
    expect(log).toEqual([`clear:${CH}`, "abort(stopWaitOnBook=false)"]);
    expect(apiQueues.get(`tok-owner|${CH}`)?.map((p) => p.messageId)).toEqual(["other-req", "s-api"]); // 放回去，deliverToApi 才认领得到
    expect(delivered).toHaveLength(1);
    const r = delivered[0];
    expect(r.intent).toBe("response");
    expect(r.meta.inReplyTo).toBe("s-api");
    expect(r.to).toMatchObject({ kind: "api", tokenId: "tok-owner" });
    expect(r.content).toContain("已叫停 agent-pi");
    apiQueues.clear();
  });

  test("非 owner：停字按普通消息、按停止只打断这一回合——都不清 owner 这边的待回账", async () => {
    log.length = 0;
    await preemptForHuman(stopEnv("g1", false), CH, "agent-pi");
    await manualInterrupt(CH, "master:agent-pi", "pi", "agent-pi", "api", { owner: false, name: "guest" });
    expect(log.some((l) => l.startsWith("clear:"))).toBe(false);
  });
});
