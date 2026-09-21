/**
 * pendingReplies 作用域判据的单测。
 *
 * 两条都是「频道对得上 ≠ 人对得上 / 标记对得上」的老坑，PR #18 审出来的：
 * ① `skipInterAgentWatchdog` 被 HTTP 入站恒设 true，拿它当 oneShot 用会让整个
 *    Web 端失去「忘了 reply」的 Stop 拦截；
 * ② 销账不验欠账人，会把别的 agent 的欠账顺手销掉。
 */
import { describe, test, expect } from "bun:test";
import { hangsPendingReply, ownsPendingReply } from "../src/lib/pending-reply-scope.js";

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
});
