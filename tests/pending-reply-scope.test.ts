/**
 * pendingReplies 作用域判据的单测。
 *
 * 两条都是「频道对得上 ≠ 人对得上 / 标记对得上」的老坑，PR #18 审出来的：
 * ① `skipInterAgentWatchdog` 被 HTTP 入站恒设 true，拿它当 oneShot 用会让整个
 *    Web 端失去「忘了 reply」的 Stop 拦截；
 * ② 销账不验欠账人，会把别的 agent 的欠账顺手销掉。
 */
import { describe, test, expect } from "bun:test";
import { dropPendingsForChannel, dropVoidedPendings, takeApiPending, hangsInterAgentWatchdog, hangsPendingReply, nudgesForOrigin, ownsPendingReply, pendingKeysOwedBy, type ThreadEnds } from "../src/lib/pending-reply-scope.js";
import { pickUnrepliedForNudge } from "../src/lib/reply-nudge.js";

describe("hangsPendingReply", () => {
  test("Web/API 入站：即便 skipInterAgentWatchdog=true 也要挂（补 reply 拦截靠它）", () => {
    expect(hangsPendingReply("request", "api", true)).toBe(true);
  });

  test("agent→agent 的 oneShot：不挂（caller 不期待回应）", () => {
    expect(hangsPendingReply("request", "local", true)).toBe(false);
  });

  test("agent→agent 的普通请求：照挂", () => {
    expect(hangsPendingReply("request", "local", undefined)).toBe(true);
    expect(hangsPendingReply("request", "local", false)).toBe(true);
  });

  test("Discord 人类用户：照挂", () => {
    expect(hangsPendingReply("request", "user", undefined)).toBe(true);
  });

  test("非 request（response / notification / broadcast）一律不挂", () => {
    expect(hangsPendingReply("response", "local", undefined)).toBe(false);
    expect(hangsPendingReply("notification", "user", undefined)).toBe(false);
    expect(hangsPendingReply("broadcast", "api", true)).toBe(false);
  });
});

describe("ownsPendingReply", () => {
  const wsA = { id: "A" };
  const wsC = { id: "C" };

  test("自己欠的 → 可以销", () => {
    expect(ownsPendingReply(wsA, wsA)).toBe(true);
  });

  test("别人欠的 → 不许销（B 欠 C 的账，A 发消息给 B 时不能顺手清掉）", () => {
    expect(ownsPendingReply(wsC, wsA)).toBe(false);
  });

  test("取不到欠账人时不销 —— undefined === undefined 的陷阱", () => {
    expect(ownsPendingReply(undefined, undefined)).toBe(false);
    expect(ownsPendingReply(null, null)).toBe(false);
  });

  /**
   * 2026-09-22 实测的那一幕（这条判据的第三个消费点：`reply` 分支）。
   *
   * Web/API 用户的回信地址是 `api:<tokenId>`——**同一个 token 跟几个 agent 说话，
   * 共用这一个 key**。所以「无条件 delete」在 Web 端不是理论风险，是日常：
   *   10:59:48  用户问 mm-pm        → pendingReplies["api:tok_…"].targetWs = mm-pm
   *   11:00:0x  claudestra-debug 在**自己**频道 reply(chat_id="api:tok_…") → 销账
   *   11:01:00  mm-pm 的 Stop 零拦截 ⇒ 它「只打字不 reply」没人纠正
   *             ⇒ 用户看到 1267 字答复全是灰字旁白、没有正文
   *
   * 判据下的正确行为：debug 的 ws ≠ 欠账人 mm-pm 的 ws ⇒ 不许销。
   */
  test("Web token 共用一个 key：别的 agent 回复不能销掉这个 agent 的欠账", () => {
    const wsDebug = { id: "claudestra-debug" };
    const wsMmPm = { id: "mm-pm" };
    // pendingReplies["api:tok_…"] 的欠账人是 mm-pm
    expect(ownsPendingReply(wsMmPm, wsDebug)).toBe(false); // debug 回复 → 不许销
    expect(ownsPendingReply(wsMmPm, wsMmPm)).toBe(true);   // mm-pm 自己回复 → 销
  });
});

/**
 * key 从「回信地址」改成 threadId 之后，销账一律按「欠账人 + 回信地址」找。
 *
 * 这两格就是 2026-09-22 实测那两层后果：
 *   ① 别的 agent 回复同一个 Web 用户，不能销掉这个 agent 的欠账；
 *   ② 同一个 token 同时问两个 agent，两条账要同时存在（旧 key 下后挂的会覆盖先挂的）。
 */
describe("pendingKeysOwedBy", () => {
  const wsDebug = { id: "claudestra-debug" };
  const wsMmPm = { id: "mm-pm" };
  const WEB = "api:tok_a375704d";

  /** 同一个 Web token 同时问了两个 agent —— 旧 key 下这是不可能存在的状态 */
  const book = (): [string, { targetWs: unknown; intendedReplyChannel: string }][] => [
    ["thr_1", { targetWs: wsMmPm, intendedReplyChannel: WEB }],
    ["thr_2", { targetWs: wsDebug, intendedReplyChannel: WEB }],
    ["thr_3", { targetWs: wsMmPm, intendedReplyChannel: "1546121533422964768" }],
  ];

  test("只销自己欠这个地址的那条", () => {
    expect(pendingKeysOwedBy(book(), wsDebug, WEB)).toEqual(["thr_2"]);
    expect(pendingKeysOwedBy(book(), wsMmPm, WEB)).toEqual(["thr_1"]);
  });

  test("地址不同的欠账不动（同一个 agent 可以同时欠 Web 和 Discord）", () => {
    expect(pendingKeysOwedBy(book(), wsMmPm, "1546121533422964768")).toEqual(["thr_3"]);
  });

  test("同一个 agent 欠同一个地址两条（两个 thread）→ 一起销", () => {
    const two: [string, { targetWs: unknown; intendedReplyChannel: string }][] = [
      ["thr_a", { targetWs: wsMmPm, intendedReplyChannel: WEB }],
      ["thr_b", { targetWs: wsMmPm, intendedReplyChannel: WEB }],
    ];
    expect(pendingKeysOwedBy(two, wsMmPm, WEB)).toEqual(["thr_a", "thr_b"]);
  });

  test("没欠账 / 认不出欠账人 / 地址为空 → 什么都不销", () => {
    expect(pendingKeysOwedBy(book(), { id: "someone-else" }, WEB)).toEqual([]);
    expect(pendingKeysOwedBy(book(), undefined, WEB)).toEqual([]);
    expect(pendingKeysOwedBy(book(), null, WEB)).toEqual([]);
    expect(pendingKeysOwedBy(book(), wsMmPm, "")).toEqual([]);
  });
});

describe("N7：kill 之后的欠账 + 拦截只追非 agent 来源", () => {
  // 09-28 17:00:09 实况：T3 的请求投给 PM → pendingReplies{targetWs=PM, 回信=T3 频道}；17:02:34 kill T3；17:05:24 PM 的 Stop 被拦
  const PM = { tag: "pm-ws" };
  const T5 = { tag: "t5-ws" };
  type Entry = { targetWs: unknown; intendedReplyChannel: string; ts: number; fromKind?: string };
  const local = (channelId: string) => ({ kind: "local", channelId });
  function state() {
    const replies = new Map<string, Entry>([
      ["thr-t3", { targetWs: PM, intendedReplyChannel: "c-t3", ts: 1, fromKind: "local" }],
      ["thr-owner", { targetWs: PM, intendedReplyChannel: "api:owner", ts: 2, fromKind: "api" }],
      ["thr-pm", { targetWs: T5, intendedReplyChannel: "c-pm", ts: 3, fromKind: "local" }],
    ]);
    const threads = new Map<string, ThreadEnds>([
      ["thr-t3", { request: { from: local("c-t3"), to: local("c-pm") } }],
      ["thr-to-t3", { request: { from: local("c-pm"), to: local("c-t3") } }],
      ["thr-owner", { request: { from: { kind: "api" }, to: local("c-pm") } }],
    ]);
    // 看门狗以接收方频道为 key：T3 发给 PM 的还没回应；PM 发给 T5 的还没回应；旧条目没有 fromChannelId
    const watchdogs = new Map<string, { fromChannelId?: string }>([["c-pm", { fromChannelId: "c-t3" }], ["c-t5", { fromChannelId: "c-pm" }], ["c-x", {}]]);
    return { replies, threads, watchdogs };
  }
  const stopPick = (replies: Map<string, Entry>, ws: unknown, originFilter: boolean) =>
    pickUnrepliedForNudge(
      [...replies].filter(([, p]) => p.targetWs === ws && (!originFilter || nudgesForOrigin(p.fromKind))).map(([key, p]) => ({ key, ts: p.ts })),
      { event: "Stop", stopHookActive: false, now: 10_000 },
    );

  test("cleanup 销掉回信地址是它的欠账、发给它和由它发起的 thread、它发出去的看门狗；别人的不动", () => {
    const { replies, threads, watchdogs } = state();
    expect(dropPendingsForChannel(replies, threads, watchdogs, "c-t3")).toBe(4);
    expect([...replies.keys()]).toEqual(["thr-owner", "thr-pm"]);
    expect([...threads.keys()]).toEqual(["thr-owner"]);
    expect([...watchdogs.keys()]).toEqual(["c-t5", "c-x"]);
  });

  test("cleanup 之后 PM 的 Stop 不再被逼着 reply 到已删的频道（不加来源过滤也成立）", () => {
    const { replies, threads, watchdogs } = state();
    replies.delete("thr-owner");
    expect(stopPick(replies, PM, false)?.key).toBe("thr-t3");
    dropPendingsForChannel(replies, threads, watchdogs, "c-t3");
    expect(stopPick(replies, PM, false)).toBeNull();
    expect(watchdogs.has("c-pm")).toBe(false); // 看门狗也不会再催 PM 回一个已销毁的 agent
  });

  test("拦截对 agent 来源不触发（T5 被逼着 reply 到 PM 频道）；人类 / peer / bridge 照拦", () => {
    const { replies } = state();
    expect(stopPick(replies, T5, true)).toBeNull();
    expect(stopPick(replies, PM, true)?.key).toBe("thr-owner");
    expect(nudgesForOrigin("local")).toBe(false);
    for (const k of ["user", "api", "bridge", undefined]) expect(nudgesForOrigin(k)).toBe(true);
  });
});

describe("hangsInterAgentWatchdog（N7 复核 P2-5）", () => {
  test("被 kill 的 A 押在 B 队列里的消息，A 死后才投出：内容照投，但不给 B 挂看门狗", () => {
    expect(hangsInterAgentWatchdog(false, undefined, false)).toBe(false);
  });
  test("发送方在线的普通请求照挂；发给自己、oneShot 不挂", () => {
    expect(hangsInterAgentWatchdog(false, undefined, true)).toBe(true);
    expect(hangsInterAgentWatchdog(true, undefined, true)).toBe(false);
    expect(hangsInterAgentWatchdog(false, true, true)).toBe(false);
  });
});

describe("dropVoidedPendings（T13a adv4：叫停作废的消息不再被催）", () => {
  const books = () => {
    const dropped: string[] = [];
    return {
      dropped,
      pendingReplies: new Map<string, { msgId: string; threadId?: string }>([["t1", { msgId: "m1", threadId: "t1" }], ["t2", { msgId: "m2", threadId: "t2" }]]),
      pendingThreads: new Map<string, unknown>([["t1", {}], ["t2", {}]]),
      pendingInterAgentMsg: new Map<string, { fromChannelId?: string; ts: number }>([["pi", { ts: 100 }]]),
      pendingAgentCalls: { dropRequest: (t: string, c: string, id: string) => void dropped.push(`${t}<-${c}:${id}`) },
    };
  };
  test("补答账按 msgId 销、连同 thread；别的欠账不动", () => {
    const b = books();
    expect(dropVoidedPendings(b, "pi", [{ messageId: "m1" }], 200)).toBe(1);
    expect([...b.pendingReplies.keys()]).toEqual(["t2"]);
    expect([...b.pendingThreads.keys()]).toEqual(["t2"]);
  });
  test("看门狗：发送方都没频道（非 agent 来源）不算对上；对上且挂在叫停之前才销；回程槽只撤 agent 来源那一条", () => {
    const b = books();
    dropVoidedPendings(b, "pi", [{ messageId: "m9" }], 200);
    expect(b.pendingInterAgentMsg.has("pi")).toBe(true); // undefined === undefined 不能当成同一个发送方
    b.pendingInterAgentMsg.set("pi", { fromChannelId: "ag", ts: 300 });
    dropVoidedPendings(b, "pi", [{ messageId: "m8", agentChannel: "ag" }], 200);
    expect(b.pendingInterAgentMsg.has("pi")).toBe(true); // 叫停之后才挂的是新请求
    expect(dropVoidedPendings(b, "pi", [{ messageId: "m7", agentChannel: "ag" }], 300)).toBe(1);
    expect(b.pendingInterAgentMsg.has("pi")).toBe(false);
    expect(b.dropped).toEqual(["pi<-ag:m8", "pi<-ag:m7"]);
  });
});

describe("takeApiPending（adv5：作废回显不能认领同一 token 的别的请求）", () => {
  test("普通回复先来先答；带 inReplyTo 只认那一条，对不上谁也不认", () => {
    const q = [{ messageId: "sync1", n: 1 }, { messageId: "c3", n: 2 }, { n: 3 }];
    expect(takeApiPending(q, "c3")?.n).toBe(2);
    expect(takeApiPending(q, "gone")).toBeUndefined();
    expect(q.map((p) => p.n)).toEqual([1, 3]);
    expect(takeApiPending(q)?.n).toBe(1);
  });
});
