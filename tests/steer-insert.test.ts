/**
 * 插队（Pi / ACP 的 steer）确认账（bridge/steer-insert.ts）：目标明确回给插队方之前，这一轮和之后任何一轮的回 owner / drain 收尾都不被
 * 当成对插队方的答复（回程簿 / Stop 结算用真模块，场景是第 2 轮对抗审查 B 组探针的两个变体，断言反转）；明确回复才销账；账落盘、24 小时、
 * 只在 kill 时整本销。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { afterInsertSend, configureInboundRoute, routeHolds } from "../src/bridge/inbound-route.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { answerableUnmixed, noteDelivered, settleStopTurn } from "../src/bridge/stop-settle.js";
import { configureSteerInsert, dropInserts, insertIdsFrom, insertUnseenFrom, noteInsert, openInsertBook, settleInsertReply } from "../src/bridge/steer-insert.js";
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
   * T 明确回给 X（bridge.ts route_to_agent / reply 到 X 频道两处的先后）：显式视图取精确回程槽（不撤插队保护）+ 插队快照 → 投递（期间可插
   * 一段，比如 Stop / X 又插进来一条）→ 投到了才一起消化回程槽并销快照里的插队账；没投到什么都不动
   */
  const explicitReply = async (outcome: "sent" | "error" | "dropped", during?: () => Promise<unknown>) => {
    const answering = book.exact(T, X, (r) => requestStillHeld(r, insertUnseenFrom(T, X)));
    const snap = insertIdsFrom(T, X);
    await during?.();
    if (outcome !== "sent") return answering;
    if (answering) book.consume(T, X, answering);
    settleInsertReply(T, snap);
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

  test("快照只取这个插队方的；销账只销快照里的 message_id", () => {
    const w = world();
    noteInsert(w.steerEnv("a"), w.T);
    noteInsert(w.steerEnv("b"), w.T);
    expect(insertIdsFrom(w.T, w.Y)).toEqual([]);
    expect(insertIdsFrom(w.T, w.X).sort()).toEqual(["a", "b"]);
    settleInsertReply(w.T, []);
    settleInsertReply(w.T, ["a"]);
    expect(ids(w.T)).toEqual(["b"]);
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

  test("A 投递 await 期间 X 又插进来 B：A 投到后只销 A，B 的确认账和回程槽都还在，owner 回合的 drain 不推给 X（PR1689-r2）", async () => {
    const w = world();
    await w.turnA("pA");
    await w.explicitReply("sent", async () => {
      w.book.add(w.T, { callerChannelId: w.X, callerName: "agent-x", targetName: "agent-t", ts: clock + 5 }, "pB");
      noteInsert(w.steerEnv("pB"), w.T);
    });
    expect(ids(w.T)).toEqual(["pB"]);
    expect(w.book.slot(w.T, w.X)).toBeDefined(); // A 消化了，B 那条请求还挂着
    noteDelivered(w.T, { kind: "user", owner: true, channelId: w.T }, clock + 60_000, true);
    await w.stop("owner 的 D 件事");
    expect(w.pushed).toHaveLength(0);
    expect(w.book.slot(w.T, w.X)).toBeDefined();
  });

  test("没有回程槽（answering 为空）时投到了：也只销快照里的，await 期间新插的保留", async () => {
    const w = world();
    noteInsert(w.steerEnv("q1"), w.T); // X 的插队没有挂回程槽（oneShot 等）
    await w.explicitReply("sent", async () => void noteInsert(w.steerEnv("q2"), w.T));
    expect(ids(w.T)).toEqual(["q2"]);
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
  test("JRT-4：Y 开轮后三秒内 X 插队不吞 Y 的 drain 兜底", async () => {
    const w = world();
    w.book.add(w.T, { callerChannelId: w.Y, callerName: "agent-y", targetName: "agent-t", ts: clock }, "original-y");
    noteDelivered(w.T, { kind: "local", channelId: w.Y }, clock, true, true);
    w.book.add(w.T, { callerChannelId: w.X, callerName: "agent-x", targetName: "agent-t", ts: clock }, "insert-x");
    noteInsert(w.steerEnv("insert-x"), w.T);
    noteDelivered(w.T, { kind: "local", channelId: w.X }, clock + 1, false, true);
    await w.stop("给 Y 的答复");
    expect(w.pushed.map((p) => p.to)).toEqual([w.Y]);
    expect(w.book.slot(w.T, w.X)).toBeDefined();
  });

  test("JRT-4：逐条丢弃坏 from，保留同本的好记录，读账不抛错", () => {
    const w = world();
    const path = join(mkdtempSync(join(tmpdir(), "insert-malformed-")), "book.json");
    writeFileSync(path, JSON.stringify({ [w.T]: {
      good: { env: w.steerEnv("good"), at: clock },
      bad: { env: { ...w.steerEnv("bad"), from: null }, at: clock },
    } }));
    openInsertBook(path);
    expect(() => ids(w.T)).not.toThrow();
    expect(ids(w.T)).toEqual(["good"]);
  });

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
    const j = w.steerEnv("j"), k = w.steerEnv("k");
    expect(routeHolds(j, busy) || routeHolds(k, busy)).toBe(false);
    expect(afterInsertSend(j, busy, 50, { holdEnv: () => 0 })).toBe(false);
    expect(afterInsertSend(k, busy, 0, { holdEnv: (e: Envelope) => held.push(e) })).toBe(true);
    expect(ids(w.T)).toEqual(["j"]);
    expect(held.map((e) => e.meta.messageId)).toEqual(["k"]);
  });

  test("判插队放行后、送出前热切到 off / observe：照样记账；目标回合 Stop 收尾不推给插队方，明确回复才解除（INSERTMODE1）", async () => {
    for (const later of ["off", "observe"] as const) {
      const w = world();
      let mode: "on" | "off" | "observe" = "on";
      configureInboundRoute({ readMode: () => mode, now: () => clock });
      const busy = { main: "busy" as const, bg: false };
      noteDelivered(w.T, { kind: "user", owner: true, channelId: w.T }, clock, true);
      const e = w.steerEnv(`hot-${later}`);
      w.book.add(w.T, { callerChannelId: w.X, callerName: "agent-x", targetName: "agent-t", ts: clock }, e.meta.messageId);
      expect(routeHolds(e, busy)).toBe(false); // on 档判插队放行
      mode = later;
      clock += 3_000; // 跨过档位缓存 2 秒，判定到 ws.send 之间切了档
      expect(afterInsertSend(e, busy, 80, { holdEnv: () => 0 })).toBe(false);
      noteDelivered(w.T, { kind: "local", channelId: w.X }, clock + 1, false, true);
      expect(ids(w.T)).toEqual([e.meta.messageId]);
      await w.stop("owner 的 A 件事做完了");
      expect(w.pushed).toHaveLength(0);
      expect(w.book.slot(w.T, w.X)).toBeDefined();
      expect((await w.explicitReply("sent"))?.callerChannelId).toBe(w.X);
      expect(ids(w.T)).toEqual([]);
    }
  });
});
