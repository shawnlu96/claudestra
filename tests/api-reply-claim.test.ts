/**
 * 同一个 API 调用方连发几条请求时，agent 的 reply 记到哪条、剩下的在 Stop 时回什么（lib/pending-reply-scope.ts claimApiReply +
 * bridge/stop-settle.ts takeApiWaiters，bridge.ts deliverToApi / Stop 兜底就是这两处的组合）。
 * 2026-10-04 现场：peer 同一 token 连发通知 + 提问，agent 只 reply 一次 → 答复记到了先来的通知上，提问在 Stop 被回成空；
 * 之后 reply_to 指向已经答过的请求再发一次（带附件），工具回「Sent」，对方什么都没收到。
 */
import { describe, expect, test } from "bun:test";
import { claimApiReply } from "../src/lib/pending-reply-scope.js";
import { apiFallbackEvent, takeApiWaiters, type ApiWaiter, type StopTurn } from "../src/bridge/stop-settle.js";

const CH = "c-debug";
const req = (n: number): ApiWaiter => ({ agentChannelId: CH, agentName: "agent-claudestra-debug", threadId: `thr-${n}`, tokenId: "tok", messageId: `api_${n}` });
type Settled = { result: { reply: string | null }; ts: number; tokenId?: string; agentChannelId?: string; messageId?: string };
const noSettled = () => new Map<string, Settled>();
const by = (extra: Partial<Parameters<typeof claimApiReply>[2]> = {}) => ({ tokenId: "tok", channelId: CH, ...extra });
const stop = (text: string | null = null): StopTurn => ({ cid: CH, stopChannelId: CH, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text } });

describe("现场复现：两条请求、agent 只 reply 一次", () => {
  test("答复记到最新那条（提问），先来的通知在 Stop 收到明确说明，不是空", () => {
    const queue = [req(1), req(2)];
    const claim = claimApiReply(queue, noSettled(), by());
    expect(claim.taken?.messageId).toBe("api_2");
    expect(claim.warning).toContain("api_1");
    expect(claim.warning).toContain("reply_to");

    const queues = new Map([["tok|c-debug", queue]]);
    const [settled] = takeApiWaiters(queues, stop(null), true);
    expect(settled.waiter.messageId).toBe("api_1");
    expect(settled.result.reply).toContain("没有单独答复");
    expect(settled.result.reply).toContain("thr-2");
    expect(settled.result).toMatchObject({ viaFallback: true, siblingThreadId: "thr-2" });
  });
});

describe("claimApiReply：在等的请求", () => {
  test("只有一条在等：照旧认领，不提醒、不记 sibling", () => {
    const queue = [req(1)];
    expect(claimApiReply(queue, noSettled(), by())).toEqual({ taken: req(1) });
    expect(queue).toEqual([]);
  });

  test("带 reply_to 指向第一条：只解开第一条，第二条留着、记上 sibling", () => {
    const queue = [req(1), req(2)];
    const claim = claimApiReply(queue, noSettled(), by({ replyTo: "api_1" }));
    expect(claim.taken?.messageId).toBe("api_1");
    expect(claim.warning).toBeUndefined();
    expect(queue.map((p) => p.messageId)).toEqual(["api_2"]);
    expect(queue[0].siblingThreadId).toBe("thr-1");
  });

  test("带 reply_to 但对不上：哪条都不解开；网页 / API 调用方给 warning，peer 报错", () => {
    const queue = [req(1), req(2)];
    const web = claimApiReply(queue, noSettled(), by({ replyTo: "api_9" }));
    expect(web.taken).toBeUndefined();
    expect(web.error).toBeUndefined();
    expect(web.warning).toContain("api_1、api_2");
    const peer = claimApiReply(queue, noSettled(), by({ replyTo: "api_9", peer: "shawn" }));
    expect(peer.taken).toBeUndefined();
    expect(peer.error).toContain("收不到");
    expect(queue.map((p) => p.messageId)).toEqual(["api_1", "api_2"]);
    expect(queue.every((p) => !p.siblingThreadId)).toBe(true);
  });

  test("最新那条还押着、没送到 agent 手上：认看到过的最新一条，押着的不列进提醒", () => {
    const queue = [req(1), req(2), req(3)];
    const claim = claimApiReply(queue, noSettled(), by({ unseen: new Set(["api_3"]) }));
    expect(claim.taken?.messageId).toBe("api_2");
    expect(claim.warning).toContain("api_1");
    expect(claim.warning).not.toContain("api_3");
    expect(queue.find((p) => p.messageId === "api_3")?.siblingThreadId).toBeUndefined();
  });

  test("一条都没看到过：退回最早一条（与改前一致），没人可提醒", () => {
    const queue = [req(1), req(2)];
    expect(claimApiReply(queue, noSettled(), by({ unseen: new Set(["api_1", "api_2"]) }))).toEqual({ taken: req(1) });
  });

  test("bridge 的作废回显（inReplyTo）只认那一条、对不上谁也不认，不记 sibling、不提醒（adv5）", () => {
    const queue = [req(1), req(2), req(3)];
    expect(claimApiReply(queue, noSettled(), by({ inReplyTo: "api_2", peer: "shawn" }))).toEqual({ taken: req(2) });
    expect(claimApiReply(queue, noSettled(), by({ inReplyTo: "gone", peer: "shawn" }))).toEqual({ taken: undefined });
    expect(queue.map((p) => [p.messageId, p.siblingThreadId])).toEqual([["api_1", undefined], ["api_3", undefined]]);
  });
});

describe("claimApiReply：没有在等的请求（reply_to 指向已结掉的 / 根本没在等）", () => {
  const settledWith = (reply: string | null, ts = 0) => new Map<string, Settled>([["thr-1", { result: { reply }, ts, tokenId: "tok", agentChannelId: CH, messageId: "api_1" }]]);

  test("reply_to 指向已经答过的（现场：6 分钟后带附件再答一次）：peer 报错说清楚，网页给 warning", () => {
    const peer = claimApiReply([], settledWith("第一次的答复", 0), by({ replyTo: "api_1", peer: "shawn", now: 6 * 60_000 }));
    expect(peer.error).toContain("6 分钟前已经回过");
    expect(peer.error).toContain("收不到");
    expect(peer.taken).toBeUndefined();
    const web = claimApiReply([], settledWith("第一次的答复"), by({ replyTo: "api_1" }));
    expect(web.error).toBeUndefined();
    expect(web.warning).toContain("已经回过");
  });

  test("reply_to 指向兜底结成空的（对方还在轮询那个 thread）：写回原 thread，能真正送到", () => {
    expect(claimApiReply([], settledWith(null), by({ replyTo: "api_1", peer: "shawn" }))).toEqual({ threadId: "thr-1" });
  });

  test("别的 token / 别的 agent 的同名请求不认", () => {
    const other = new Map<string, Settled>([["thr-1", { result: { reply: null }, ts: 0, tokenId: "tok", agentChannelId: "c-else", messageId: "api_1" }]]);
    expect(claimApiReply([], other, by({ replyTo: "api_1", peer: "shawn" })).error).toContain("对不上");
  });

  test("peer 没有在等的请求、也没带 reply_to：报错；有空着等补答的就列出来", () => {
    expect(claimApiReply([], noSettled(), by({ peer: "shawn" })).error).toContain("没有在等你答复的请求");
    expect(claimApiReply([], settledWith(null), by({ peer: "shawn" })).error).toContain("等补答的：api_1");
  });

  test("网页 / API 调用方的主动消息（没在等、没带 reply_to）：照旧投，不提醒", () => {
    expect(claimApiReply([], noSettled(), by())).toEqual({});
  });
});

describe("Stop 兜底", () => {
  test("有 drain 文字：照旧回 drain 文字（不管有没有 sibling）", () => {
    const queues = new Map([["k", [{ ...req(1), siblingThreadId: "thr-2" }]]]);
    expect(takeApiWaiters(queues, stop("打字没 reply 的话"), true)[0].result).toEqual(
      { threadId: "thr-1", agent: "agent-claudestra-debug", viaFallback: true, reply: "打字没 reply 的话" });
  });

  test("这一回合没回过这个调用方：照旧 reply:null（对方据此知道是空回合、继续等补答）", () => {
    expect(takeApiWaiters(new Map([["k", [req(1)]]]), stop(null), true)[0].result).toEqual(
      { threadId: "thr-1", agent: "agent-claudestra-debug", viaFallback: true, reply: null });
  });

  test("事件里不放那句说明（网页会把它接在 agent 的回复后面），带 siblingThreadId；日志写明结局", () => {
    const [{ waiter, result }] = takeApiWaiters(new Map([["k", [{ ...req(1), siblingThreadId: "thr-2" }]]]), stop(null), true);
    const { data, label } = apiFallbackEvent(waiter, result);
    expect(data).toMatchObject({ text: "", siblingThreadId: "thr-2", viaFallback: true, threadId: "thr-1" });
    expect(label).toContain("thr-2");
    expect(apiFallbackEvent(req(3), { threadId: "thr-3", agent: "a", viaFallback: true, reply: null }).label).toBe("no-text");
  });
});
