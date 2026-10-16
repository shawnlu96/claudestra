/**
 * 插队的确认账（bridge/steer-cc.ts + lib/steer-cc.ts）：版本闸、CC 那边的状态判定；没确认的插队不让目标别的输出被当成对插队方的答复
 * （回程簿 / Stop drain 用真模块）；Stop 时 CC 插队按状态补投原文进押后队列、去重、不催看门狗；账落盘（重启还在）、24 小时有效、
 * StopFailure 留账。会话记录是替身。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { afterInsertSend, configureInboundRoute, routeProbeFor } from "../src/bridge/inbound-route.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { answerableUnmixed, noteDelivered, settleStopTurn } from "../src/bridge/stop-settle.js";
import {
  ccInsertAllowed, configureSteerCc, dropInserts, insertUnseenFrom, isInsertRedelivery, noteInsert, openInsertBook, settleInsertReply, settleInsertsAtStop,
} from "../src/bridge/steer-cc.js";
import { requestStillHeld } from "../src/lib/held-pac.js";
import { CC_INSERT_MIN_VERSION, ccInsertState, ccInToolWindow, ccVersionOf, needsRedeliver, redeliverHead, versionAtLeast } from "../src/lib/steer-cc.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/inbound-route/cc-midturn-2.1.302.json"), "utf8")) as { cases: { scenario: string; token: string; records: object[] }[] };
const caseOf = (s: string) => fixture.cases.find((c) => c.scenario === s)!;
const tailOf = (s: string): string => caseOf(s).records.map((r) => JSON.stringify(r)).join("\n");
const attached = (id: string) => JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: `<channel message_id="${id}">x</channel>` } });

describe("版本闸（lib）", () => {
  test("正式版 x.y.z 比较；预发布版 / 认不出 = 不够", () => {
    expect(versionAtLeast("2.1.302", CC_INSERT_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.310", CC_INSERT_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.2.0", CC_INSERT_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.301", CC_INSERT_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("2.1.302-beta", CC_INSERT_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("2.1.303-rc.1", CC_INSERT_MIN_VERSION)).toBe(false);
    expect(versionAtLeast(null, CC_INSERT_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("v2.1.302", CC_INSERT_MIN_VERSION)).toBe(false);
  });
  test("运行中的版本取尾部最后一条", () => {
    expect(ccVersionOf('{"version":"2.1.247"}\n{"version":"2.1.302"}\n')).toBe("2.1.302");
    expect(ccVersionOf("{}")).toBeNull();
  });
});

describe("工具执行窗口（lib ccInToolWindow，夹具是实测记录）", () => {
  const upTo = (s: string, n: number) => caseOf(s).records.slice(0, n).map((r) => JSON.stringify(r)).join("\n");
  test("tool_use 已出、结果没回：在窗口里（只有这时插队会插进当前回合）", () => {
    expect(ccInToolWindow(upTo("tool", 2))).toBe(true);
  });
  test("结果回来了 / 推理中还没调工具 / 新一轮开始：不在", () => {
    expect(ccInToolWindow(tailOf("tool"))).toBe(false);
    expect(ccInToolWindow(upTo("reason", 1))).toBe(false);
    expect(ccInToolWindow(`${upTo("tool", 2)}\n${JSON.stringify({ type: "user", message: { role: "user", content: "新的一轮" } })}`)).toBe(false);
    expect(ccInToolWindow("")).toBe(false);
  });
});

describe("CC 那边的状态（lib ccInsertState，夹具是实测记录）", () => {
  test("工具间隙插进来的（附件）：补", () => {
    expect(ccInsertState(tailOf("tool"), caseOf("tool").token)).toBe("attached");
    expect(needsRedeliver("attached")).toBe(true);
  });
  test("推理窗口到的：Stop 时还排在 CC 队列里 → 不补；之后作为正常一轮投过 → 不补", () => {
    const enqOnly = caseOf("reason").records.slice(0, 2).map((r) => JSON.stringify(r)).join("\n");
    expect(ccInsertState(enqOnly, caseOf("reason").token)).toBe("queued");
    expect(ccInsertState(tailOf("reason"), caseOf("reason").token)).toBe("delivered");
    expect(needsRedeliver("queued") || needsRedeliver("delivered")).toBe(false);
  });
  test("工具结果里碰巧出现同一个 id 不算正常投过；没有它 = 没落盘（补）", () => {
    const toolResult = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: 'grep: message_id="Q1"' }] } });
    expect(ccInsertState(`${toolResult}\n${tailOf("tool")}`, "Q1")).toBe("absent");
    expect(needsRedeliver("absent")).toBe(true);
  });
  test("抬头：插进过回合的说「已作为附件送达过」，没落盘的不这么说", () => {
    expect(redeliverHead("attached")).toContain("已作为附件送达过");
    expect(redeliverHead("absent")).not.toContain("附件");
  });
});

// ── bridge ──────────────────────────────────────────────────────────────
const T = "ch-t", X = "ch-x";
const to = { kind: "local", channelId: T, agentName: "agent-t", ws: { send() {} } } as unknown as LocalEndpoint;
const AGENT_X = { kind: "local", channelId: X, agentName: "agent-x" };
let tail: string | null = "", clock = 1_000_000, held: Envelope[] = [], flushes = 0;
const sink = () => ({ held: { holdEnv: (e: Envelope) => held.push(e) }, flush: () => void flushes++, to });
const env = (id: string, via: "steer" | "channel" = "channel", from: Record<string, unknown> = AGENT_X): Envelope =>
  ({
    from, to, intent: "request", content: `问题 ${id}`,
    meta: { messageId: id, threadId: `t-${id}`, triggerKind: "agent_tool", ts: "x", inboundRoute: { action: "insert", p: 0.9, via } },
  }) as unknown as Envelope;
afterAll(() => {
  openInsertBook(null);
  configureSteerCc({ tail: async () => null, now: () => Date.now() });
  configureInboundRoute({ readMode: () => "off", now: () => Date.now() });
});
beforeEach(() => {
  tail = ""; held = []; flushes = 0; clock += 3 * 86_400_000;
  configureSteerCc({ tail: async () => tail, now: () => clock });
  openInsertBook(null);
});

describe("CC 能不能插（bridge 取数：版本闸 + 工具窗口）", () => {
  const inTool = (v: string) => `${caseOf("tool").records.slice(0, 2).map((r) => JSON.stringify({ ...r, version: v })).join("\n")}`;
  test("2.1.302 且正在执行工具才直投；不在工具窗口 / 读不到 / 更低 / 预发布 / 读失败 = 插不进", async () => {
    tail = inTool("2.1.302");
    expect(await ccInsertAllowed(T)).toBe(true);
    tail = tailOf("tool").split("\n").map((l) => l.replace(/^\{/, '{"version":"2.1.302",')).join("\n"); // 工具结果已回
    expect(await ccInsertAllowed(T)).toBe(false);
    tail = inTool("2.1.300");
    expect(await ccInsertAllowed(T)).toBe(false);
    tail = inTool("2.1.302-beta");
    expect(await ccInsertAllowed(T)).toBe(false);
    tail = null;
    expect(await ccInsertAllowed(T)).toBe(false);
    configureSteerCc({ tail: async () => { throw new Error("EACCES"); } });
    expect(await ccInsertAllowed(T)).toBe(false);
  });
});

/** bridge.ts 的回程簿口径：stillHeld = 押后队列（这里空）+ 没确认的插队 */
function callHarness() {
  const book = new AgentCallBook(null);
  const stillHeld = (r: { messageId?: string; callerChannelId: string }) => requestStillHeld(r, insertUnseenFrom(T));
  const pushed: { to: string; body: string }[] = [];
  const deps = {
    answerable: (c: string) => answerableUnmixed(book, c, stillHeld), waiting: (c: string) => book.waiting(c, stillHeld), rearmResume: () => {},
    consume: (c: string, pac: { callerChannelId: string }) => void book.consume(c, pac.callerChannelId, pac as never),
    pushBack: async (pac: { callerChannelId: string }, _c: string, body: string) => void pushed.push({ to: pac.callerChannelId, body }),
    unattributed: () => {}, nudgeAmbiguous: () => {}, takeApiErrorNotice: () => [], markApiError: () => undefined, clearWithheld: () => {},
    notify: async () => {}, metric: () => {}, recovered: () => {},
  };
  const stop = (text: string) => settleStopTurn(deps as never, { cid: T, stopChannelId: T, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text } });
  return { book, stillHeld, pushed, stop };
}

describe("没确认的插队不被误认作答复对象（P1-1）", () => {
  test("owner 开的回合里插进 X 的请求：T 回 owner、Stop 时 drain 都不推给 X，槽保留；补投投到后下一轮真答 X 能推回去", async () => {
    const h = callHarness();
    noteDelivered(T, { kind: "user", owner: true, channelId: T }, clock, true); // owner 开的这一轮（Discord：chat_id = T 自己的频道）
    h.book.add(T, { callerChannelId: X, callerName: "agent-x", targetName: "agent-t", ts: clock }, "mX");
    noteDelivered(T, { kind: "local", channelId: X }, clock + 1, false, true); // 回合中插队送到
    noteInsert(env("mX"), T);
    settleInsertReply(T, { chatId: T }); // T reply(chat_id=T) 回 owner：不算回 X
    expect(answerableUnmixed(h.book, T, h.stillHeld)).toBeUndefined(); // bridge.ts reply 分支 answerablePac：不认 X
    await h.stop("owner 那件事做完了：密码轮换已完成");
    expect(h.pushed).toHaveLength(0);
    expect(h.book.slot(T, X)).toBeDefined();

    tail = attached("mX");
    expect((await settleInsertsAtStop(T, sink())).redelivered).toBe(1); // 同一个 Stop：补投原文进押后队列
    // 补投那封投到了（出队）、T 下一轮答 X：账已结，drain 兜底推回给 X
    noteDelivered(T, { kind: "local", channelId: X }, clock + 10, true, true);
    await h.stop("答复 X：用方案 B");
    expect(h.pushed.map((p) => p.to)).toEqual([X]);
  });

  test("T 回合中直接回 X（send_to_agent 给它 / reply 到它的频道）：销账，精确取槽照常", () => {
    const h = callHarness();
    h.book.add(T, { callerChannelId: X, callerName: "agent-x", targetName: "agent-t", ts: clock }, "mX");
    noteInsert(env("mX"), T);
    expect(h.book.exact(T, X, h.stillHeld)).toBeUndefined(); // 没确认前精确取也不认（bridge 里销账在取槽之前）
    settleInsertReply(T, { target: "x" });
    expect(h.book.exact(T, X, h.stillHeld)?.callerChannelId).toBe(X);
    noteInsert(env("mY"), T);
    settleInsertReply(T, { chatId: X });
    expect(insertUnseenFrom(T)).toEqual([]);
  });

  test("steer 插队（Pi / ACP）同样记账；Stop 时只销账、不补投、不压看门狗", async () => {
    noteInsert(env("mS", "steer"), T);
    expect(insertUnseenFrom(T).map((u) => u.messageId)).toEqual(["mS"]);
    expect(await settleInsertsAtStop(T, sink())).toEqual({ redelivered: 0, quiet: false });
    expect(insertUnseenFrom(T)).toEqual([]);
    expect(held).toHaveLength(0);
  });
});

describe("至少送达一次（P1-2）", () => {
  test("补投进押后队列：新抬头、去掉插队结论、同一个 message_id、安排 flush；同一条只补一次", async () => {
    noteInsert(env("M1"), T);
    noteInsert(env("M1"), T); // 记两次（不该有）：按 message_id 只一笔
    tail = attached("M1");
    expect(await settleInsertsAtStop(T, sink())).toEqual({ redelivered: 1, quiet: false });
    expect(held).toHaveLength(1);
    expect(held[0]!.content).toBe(`${redeliverHead("attached")}\n\n问题 M1`);
    expect(held[0]!.meta.messageId).toBe("M1");
    expect(held[0]!.meta.inboundRoute).toBeUndefined();
    expect(held[0]!.to).toBe(to);
    expect(isInsertRedelivery(held[0]!)).toBe(true);
    expect(flushes).toBe(1);
    expect(await settleInsertsAtStop(T, sink())).toEqual({ redelivered: 0, quiet: false });
  });

  test("CC 还排着 / 已正常投过：不补，quiet（不催看门狗）", async () => {
    noteInsert(env("M4"), T);
    tail = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: '<channel message_id="M4">x</channel>' });
    expect(await settleInsertsAtStop(T, sink())).toEqual({ redelivered: 0, quiet: true });
    expect(flushes).toBe(0);
  });

  test("会话记录读不到：按没落盘补（宁可多送一次）", async () => {
    noteInsert(env("M3"), T);
    tail = null;
    expect((await settleInsertsAtStop(T, sink())).redelivered).toBe(1);
    expect(held[0]!.content.startsWith(redeliverHead("absent"))).toBe(true);
  });

  test("长回合：插队到 Stop 超过 30 分钟（2 小时）照补；超过 24 小时（同押后队列放弃）不补", async () => {
    noteInsert(env("M5"), T);
    clock += 2 * 3_600_000;
    tail = attached("M5");
    expect((await settleInsertsAtStop(T, sink())).redelivered).toBe(1);
    noteInsert(env("M6"), T);
    clock += 25 * 3_600_000;
    expect((await settleInsertsAtStop(T, sink())).redelivered).toBe(0);
  });

  test("bridge 重启：账落盘，重开后还在，照补", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "insert-book-")), "insert-pending.json");
    openInsertBook(path);
    noteInsert(env("M7"), T);
    openInsertBook(path); // 新进程读回（ws 已剥掉，补投用 Stop 那一刻的连接）
    expect(insertUnseenFrom(T).map((u) => u.messageId)).toEqual(["M7"]);
    tail = attached("M7");
    expect((await settleInsertsAtStop(T, sink())).redelivered).toBe(1);
    expect(held[0]!.to).toBe(to);
  });

  test("StopFailure / 叫停中止不调 settle：账留着，之后一次正常 Stop 再补；只有 kill（dropInserts）才销", async () => {
    noteInsert(env("M8"), T);
    // bridge.ts：event === "StopFailure" / afterAbort 时不调 settleInsertsAtStop；owner 打字 / 叫停不调 dropInserts（只在 /agent/cleanup）
    tail = attached("M8");
    expect((await settleInsertsAtStop(T, sink())).redelivered).toBe(1);
    noteInsert(env("M9"), T);
    dropInserts(T);
    expect(await settleInsertsAtStop(T, sink())).toEqual({ redelivered: 0, quiet: false });
  });
});

describe("接线", () => {
  test("afterInsertSend：送到了两种插法都记账", () => {
    configureInboundRoute({ readMode: () => "on", now: () => clock });
    const busy = { main: "busy" as const, bg: false };
    const q = { holdEnv: () => 0 };
    expect(afterInsertSend(env("N1"), busy, 50, q)).toBe(false);
    expect(afterInsertSend(env("N2", "steer"), busy, 50, q)).toBe(false);
    expect(insertUnseenFrom(T).map((u) => u.messageId).sort()).toEqual(["N1", "N2"]);
  });
  test("补投那封再到 deliverToLocal：不再问 Jev（目标又忙也不再插一次），bridge 重启后按抬头也认得", async () => {
    noteInsert(env("N3"), T);
    tail = null;
    await settleInsertsAtStop(T, sink());
    configureInboundRoute({ readMode: () => "on", probe: async () => ({ main: "busy", bg: false }), now: () => clock + 5_000 });
    expect(await routeProbeFor(held[0]!, to, "agent-t")).toBeNull();
    expect(isInsertRedelivery({ ...held[0]!, content: `${redeliverHead("absent")}\n\nx` } as Envelope)).toBe(true);
  });
});
