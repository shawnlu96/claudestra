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
    expect(answerableUnmixed(book, T, stillHeld)).toBeUndefined(); // T reply(chat_id=T) 回 owner：bridge.ts reply 分支 answerablePac 不认 X
    await stop("owner 的 A 件事做完了");
  };
  /**
   * T 明确回给 X（bridge.ts route_to_agent / reply 到 X 频道两处的先后）：显式视图取精确回程槽（不撤插队保护）→ 投递（期间可插一段，比如 Stop）
   * → 投到了才一起消化回程槽并销插队账；没投到什么都不动
   */
  const explicitReply = async (outcome: "sent" | "error" | "dropped", during?: () => Promise<unknown>) => {
    const answering = book.exact(T, X, (r) => requestStillHeld(r, insertUnseenFrom(T, X)));
    await during?.();
    if (outcome !== "sent") return answering;
    if (answering) book.consume(T, X, answering);
    settleInsertReply(T, X);
    return answering;
  };
  return { T, X, Y, to, book, stillHeld, pushed, stop, steerEnv, turnA, explicitReply, ambiguous: () => ambiguous };
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
    expect((await w.explicitReply("sent"))?.callerChannelId).toBe(w.X); // send_to_agent 给 X 投到了：精确取槽推回、消化、销账
    expect(w.book.slot(w.T, w.X)).toBeUndefined();
    expect(ids(w.T)).toEqual([]);
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

  test("销账只认回给插队方本人：回别人不动；同一个 X 发的几条一起销", () => {
    const w = world();
    noteInsert(w.steerEnv("a"), w.T);
    noteInsert(w.steerEnv("b"), w.T);
    settleInsertReply(w.T, "c-owner");
    settleInsertReply(w.T, w.Y);
    expect(ids(w.T).sort()).toEqual(["a", "b"]);
    settleInsertReply(w.T, w.X);
    expect(ids(w.T)).toEqual([]);
  });
});

describe("明确回复：投递成功才确认（Shawn PR1689-r1 premature-insert-ack）", () => {
  test("显式视图：精确取得到 X 的槽，同时隐式答复的保护还在", async () => {
    const w = world();
    await w.turnA("p1");
    expect(w.book.exact(w.T, w.X, (r) => requestStillHeld(r, insertUnseenFrom(w.T, w.X)))?.callerChannelId).toBe(w.X);
    expect(answerableUnmixed(w.book, w.T, w.stillHeld)).toBeUndefined();
    expect(ids(w.T)).toEqual(["p1"]);
  });

  test("send_to_agent 给 X 没投到（not_connected / X 不在 = error / dropped）：确认账保留，之后 owner 回合的 drain 不推给 X", async () => {
    for (const outcome of ["error", "dropped"] as const) {
      const w = world();
      await w.turnA(`p2-${outcome}`);
      await w.explicitReply(outcome);
      expect(ids(w.T)).toEqual([`p2-${outcome}`]);
      expect(w.book.slot(w.T, w.X)).toBeDefined();
      noteDelivered(w.T, { kind: "user", owner: true, channelId: w.T }, clock + 60_000, true);
      await w.stop("owner 的 C 件事：内部数据");
      expect(w.pushed).toHaveLength(0);
    }
  });

  test("投递途中碰上 Stop（deliver 的 await 里）：旧槽不被隐式结算；投到之后才确认", async () => {
    const w = world();
    await w.turnA("p3");
    await w.explicitReply("sent", async () => {
      await w.stop("owner 那件事的收尾");
      expect(w.pushed).toHaveLength(0);
      expect(w.book.slot(w.T, w.X)).toBeDefined();
    });
    expect(w.book.slot(w.T, w.X)).toBeUndefined();
    expect(ids(w.T)).toEqual([]);
  });

  test("reply 到 X 频道那条路转发失败：同样保留保护（answering 不消化、不销账）", async () => {
    const w = world();
    await w.turnA("p4");
    const answering = await w.explicitReply("error");
    expect(answering?.callerChannelId).toBe(w.X);
    expect(w.book.slot(w.T, w.X)).toBeDefined();
    expect(ids(w.T)).toEqual(["p4"]);
    await w.stop("之后一轮的收尾");
    expect(w.pushed).toHaveLength(0);
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
