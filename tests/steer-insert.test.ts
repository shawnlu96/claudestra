/**
 * 插队（Pi / ACP 的 steer）确认账（bridge/steer-insert.ts）：目标明确回给插队方之前，这一轮和之后任何一轮的回 owner / drain 收尾都不被
 * 当成对插队方的答复（回程簿 / Stop 结算用真模块，场景是第 2 轮对抗审查 B 组探针的两个变体，断言反转）；明确回复才销账；账落盘、24 小时、
 * 只在 kill 时整本销。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { afterInsertSend, configureInboundRoute } from "../src/bridge/inbound-route.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { answerableUnmixed, noteDelivered, settleStopTurn } from "../src/bridge/stop-settle.js";
import { configureSteerInsert, dropInserts, insertUnseenFrom, noteInsert, openInsertBook, settleInsertReply } from "../src/bridge/steer-insert.js";
import { requestStillHeld } from "../src/lib/held-pac.js";

let seq = 0, clock = 1_000_000;
const ids = (t: string) => insertUnseenFrom(t).map((u) => u.messageId);

function world() {
  const T = `ch-t-${++seq}`, X = `ch-x-${seq}`, Y = `ch-y-${seq}`;
  const to = { kind: "local", channelId: T, agentName: "agent-t", ws: { send() {} } } as unknown as LocalEndpoint;
  const book = new AgentCallBook(null);
  /** bridge.ts 的回程簿口径：stillHeld = 押后队列（这里空）+ 没确认的插队 */
  const stillHeld = (r: { messageId?: string; callerChannelId: string }) => requestStillHeld(r, insertUnseenFrom(T));
  const pushed: { to: string; body: string }[] = [];
  let ambiguous = 0;
  const deps = {
    answerable: (c: string) => answerableUnmixed(book, c, stillHeld), waiting: (c: string) => book.waiting(c, stillHeld), rearmResume: () => {},
    consume: (c: string, pac: { callerChannelId: string }) => void book.consume(c, pac.callerChannelId, pac as never),
    pushBack: async (pac: { callerChannelId: string }, _c: string, body: string) => void pushed.push({ to: pac.callerChannelId, body }),
    unattributed: () => {},
    nudgeAmbiguous: (c: string) => void (ambiguous += book.takeAmbiguity(c, stillHeld).length), // bridge.ts nudgeAmbiguousCallers 同口径
    takeApiErrorNotice: () => [], markApiError: () => undefined, clearWithheld: () => {},
    notify: async () => {}, metric: () => {}, recovered: () => {},
  };
  const stop = (text: string) => settleStopTurn(deps as never, { cid: T, stopChannelId: T, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text } });
  const steerEnv = (id: string): Envelope => ({
    from: { kind: "local", channelId: X, agentName: "agent-x" }, to, intent: "request", content: `X 的问题 ${id}`,
    meta: { messageId: id, threadId: `t-${id}`, triggerKind: "agent_tool", ts: "x", inboundRoute: { action: "insert", p: 0.9, via: "steer" } },
  }) as unknown as Envelope;
  /** owner 开回合 A，X 的请求以 steer 插进来，T 在自己频道回 owner（这一下也清掉了看门狗），回合 A 结束 */
  const turnA = async (id: string) => {
    noteDelivered(T, { kind: "user", owner: true, channelId: T }, clock, true);
    book.add(T, { callerChannelId: X, callerName: "agent-x", targetName: "agent-t", ts: clock }, id);
    noteDelivered(T, { kind: "local", channelId: X }, clock + 1, false, true);
    noteInsert(steerEnv(id), T);
    settleInsertReply(T, { chatId: T });
    expect(answerableUnmixed(book, T, stillHeld)).toBeUndefined();
    await stop("owner 的 A 件事做完了");
  };
  return { T, X, Y, to, book, stillHeld, pushed, stop, steerEnv, turnA, ambiguous: () => ambiguous };
}

afterAll(() => {
  openInsertBook(null);
  configureSteerInsert({ now: () => Date.now() });
  configureInboundRoute({ readMode: () => "off", now: () => Date.now() });
});
beforeEach(() => {
  clock += 3 * 86_400_000;
  configureSteerInsert({ now: () => clock });
  openInsertBook(null);
});

describe("没确认的插队不被隐式答复（第 2 轮 P1-A）", () => {
  test("回合 A：回 owner、Stop drain 都不推给 X，槽保留；Stop 不销账", async () => {
    const w = world();
    await w.turnA("mS");
    expect(w.pushed).toHaveLength(0);
    expect(w.book.slot(w.T, w.X)).toBeDefined();
    expect(ids(w.T)).toEqual(["mS"]);
  });

  test("变体 1：owner 从网页开回合 B（不清 agent 间待回账），B 的 drain 不推给 X、不消化槽；T 之后明确回 X 才推回", async () => {
    const w = world();
    await w.turnA("mS");
    noteDelivered(w.T, { kind: "api", owner: true, tokenId: "tok-owner-web", name: "owner" } as never, clock + 60_000, true);
    expect(answerableUnmixed(w.book, w.T, w.stillHeld)).toBeUndefined();
    await w.stop("owner 的 B 件事：生产库密码已改");
    expect(w.pushed).toHaveLength(0);
    expect(w.book.slot(w.T, w.X)).toBeDefined();
    settleInsertReply(w.T, { target: "agent-x" }); // bridge.ts route_to_agent：先销账，再 exactPac 取槽推回
    expect(w.book.exact(w.T, w.X, w.stillHeld)?.callerChannelId).toBe(w.X);
  });

  test("变体 2：另一个 agent Y 开回合 B：X 的旧槽不挡 Y，Y 照常收到 drain 答复，X 的槽还在", async () => {
    const w = world();
    await w.turnA("mS2");
    w.book.add(w.T, { callerChannelId: w.Y, callerName: "agent-y", targetName: "agent-t", ts: clock }, "mY");
    noteDelivered(w.T, { kind: "local", channelId: w.Y }, clock + 60_000, true, true);
    await w.stop("答 Y：用方案 B");
    expect(w.pushed.map((p) => p.to)).toEqual([w.Y]);
    expect(w.ambiguous()).toBe(0);
    expect(w.book.slot(w.T, w.X)).toBeDefined();
    expect(w.book.waiting(w.T, w.stillHeld)).toHaveLength(0);
  });

  test("明确回复才算：reply 到 X 的频道 / send_to_agent 给 X（带不带 agent- 前缀）销账；回别人不算", () => {
    const w = world();
    noteInsert(w.steerEnv("a"), w.T);
    noteInsert(w.steerEnv("b"), w.T);
    settleInsertReply(w.T, { chatId: "c-owner" });
    settleInsertReply(w.T, { target: "agent-other" });
    expect(ids(w.T).sort()).toEqual(["a", "b"]);
    settleInsertReply(w.T, { chatId: w.X }); // 同一个 X 发的两条都算回了
    expect(ids(w.T)).toEqual([]);
    noteInsert(w.steerEnv("c"), w.T);
    settleInsertReply(w.T, { target: "x" });
    expect(ids(w.T)).toEqual([]);
  });
});

describe("账本", () => {
  test("同一条记两次只一笔；不是 insert / 不是本机 agent 的不记", () => {
    const w = world();
    noteInsert(w.steerEnv("d"), w.T);
    noteInsert(w.steerEnv("d"), w.T);
    expect(ids(w.T)).toEqual(["d"]);
    const q = w.steerEnv("e");
    q.meta.inboundRoute = { action: "queue", p: 0.9 };
    noteInsert(q, w.T);
    noteInsert({ ...w.steerEnv("f"), from: { kind: "user", userId: "u", channelId: "c" } } as unknown as Envelope, w.T);
    expect(ids(w.T)).toEqual(["d"]);
  });

  test("bridge 重启：账落盘，重开后还在（不会把没确认的放成「已看到」）", () => {
    const w = world();
    const path = join(mkdtempSync(join(tmpdir(), "insert-book-")), "insert-pending.json");
    openInsertBook(path);
    noteInsert(w.steerEnv("g"), w.T);
    openInsertBook(path);
    expect(ids(w.T)).toEqual(["g"]);
  });

  test("24 小时（同押后队列放弃）后不再算没确认；kill（dropInserts）整本销", () => {
    const w = world();
    noteInsert(w.steerEnv("h"), w.T);
    clock += 23 * 3_600_000;
    expect(ids(w.T)).toEqual(["h"]);
    clock += 2 * 3_600_000;
    expect(ids(w.T)).toEqual([]);
    noteInsert(w.steerEnv("i"), w.T);
    dropInserts(w.T);
    expect(ids(w.T)).toEqual([]);
  });

  test("afterInsertSend：回合中送到了才记账；ws 丢了（回 0）押回、不记", () => {
    const w = world();
    configureInboundRoute({ readMode: () => "on", now: () => clock });
    const busy = { main: "busy" as const, bg: false };
    const held: Envelope[] = [];
    expect(afterInsertSend(w.steerEnv("j"), busy, 50, { holdEnv: () => 0 })).toBe(false);
    expect(afterInsertSend(w.steerEnv("k"), busy, 0, { holdEnv: (e: Envelope) => held.push(e) })).toBe(true);
    expect(ids(w.T)).toEqual(["j"]);
    expect(held.map((e) => e.meta.messageId)).toEqual(["k"]);
  });
});
