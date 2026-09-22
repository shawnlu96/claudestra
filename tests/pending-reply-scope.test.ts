/**
 * pendingReplies 作用域判据的单测。
 *
 * 两条都是「频道对得上 ≠ 人对得上 / 标记对得上」的老坑，PR #18 审出来的：
 * ① `skipInterAgentWatchdog` 被 HTTP 入站恒设 true，拿它当 oneShot 用会让整个
 *    Web 端失去「忘了 reply」的 Stop 拦截；
 * ② 销账不验欠账人，会把别的 agent 的欠账顺手销掉。
 */
import { describe, test, expect } from "bun:test";
import { hangsPendingReply, ownsPendingReply, pendingKeysOwedBy } from "../src/lib/pending-reply-scope.js";

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
