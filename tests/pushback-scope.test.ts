/**
 * send_to_agent 回推归属判据的单测。
 *
 * 核心要挡住的是 owner 2026-09-18 实报的那个形态：**caller 自己那条 reply 被当成
 * target 的答复推回给自己**（带 intent=response + caller 自己填的 expecting）。
 * caller 看不出那是回声，会据此动手。
 */

import { describe, test, expect } from "bun:test";
import { isTargetsOwnReply, isOwnStopChannel } from "../src/lib/pushback-scope.js";

const CA = "1000000000000000001"; // caller 的频道
const CB = "1000000000000000002"; // target 的频道
const API = "api:tok_abc";

describe("isTargetsOwnReply", () => {
  test("target 在自己频道里回答 → 算答复", () => {
    expect(isTargetsOwnReply(CB, CB)).toBe(true);
  });

  test("caller 把 reply 发到 target 频道 → **不算**（本次 bug 的正主）", () => {
    // A 先 send_to_agent(B)（pending key = CB），随后 A 自己 reply 到 CB。
    // 旧代码只看 msg.chatId===CB 就命中 pending，把 A 自己的话推回给 A。
    expect(isTargetsOwnReply(CB, CA)).toBe(false);
  });

  test("target 把 reply 发到 caller 频道 → 不算（与旧行为一致，本来就取不到 pending）", () => {
    expect(isTargetsOwnReply(CA, CB)).toBe(false);
  });

  test("agent 回给网页/API 用户 → 不算", () => {
    expect(isTargetsOwnReply(API, CB)).toBe(false);
  });

  test("认不出发送方频道时不算（宁可不推，也不能推错人的话）", () => {
    expect(isTargetsOwnReply(CB, "")).toBe(false);
  });

  test("chat_id 为空不算", () => {
    expect(isTargetsOwnReply("", CA)).toBe(false);
  });
});

describe("isOwnStopChannel", () => {
  const wsA = { id: "A" };
  const wsB = { id: "B" };

  test("Stop 报的就是这条频道 → 算自己的", () => {
    expect(isOwnStopChannel(CB, CB, wsB, wsB)).toBe(true);
  });

  test("同一个 ws 挂的另一条频道（sameWsChannels）→ 算自己的", () => {
    const CB2 = "1000000000000000003";
    expect(isOwnStopChannel(CB2, CB, wsB, wsB)).toBe(true);
  });

  test("别人的 intendedReplyChannel → **不算**（用 A 的收尾去回答 B 的提问）", () => {
    // channelsToClear 里混进了 pendingReplies 的 intendedReplyChannel，
    // 那是 caller 的频道，ws 也是 caller 的。
    expect(isOwnStopChannel(CA, CB, wsB, wsA)).toBe(false);
  });

  test("两边 ws 都认不出来时不算 —— undefined === undefined 的陷阱", () => {
    // 这一条是实现里唯一容易写错的地方：少一个 stopWs 非空判断就恒为 true
    expect(isOwnStopChannel(CA, CB, undefined, undefined)).toBe(false);
    expect(isOwnStopChannel(CA, CB, null, null)).toBe(false);
  });

  test("Stop 侧认不出 ws，但频道号对得上 → 仍算自己的", () => {
    expect(isOwnStopChannel(CB, CB, undefined, undefined)).toBe(true);
  });

  test("空频道号不算", () => {
    expect(isOwnStopChannel("", CB, wsB, wsB)).toBe(false);
  });
});
