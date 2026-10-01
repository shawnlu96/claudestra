/**
 * i28-M11：reply 结果里的押后提醒——本频道押着 check_inbox 领得到的消息时，末尾加「 · 押后 N 条（owner 1、卡片答复 1、peer 2），调 check_inbox 领」；
 * 只报计数和类别，不带正文；队列为空时逐字照旧，askIdOfReplyResult 照样认得出 askId。
 */
import { describe, expect, test } from "bun:test";
import { HeldQueue, heldTally, type HeldItem } from "../src/bridge/held-queue.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { askIdOfReplyResult, heldHint, replyResultText } from "../src/lib/reply-ask-schema.js";

const ws = {} as never;
const to = { kind: "local", agentName: "agent-me", channelId: "c-me", ws } as LocalEndpoint;
function mk(content: string, from: Envelope["from"], triggerKind: Envelope["meta"]["triggerKind"] = "agent_tool"): HeldItem {
  return { env: { from, to, intent: "request", content, meta: { messageId: `m-${content}`, triggerKind, ts: "", threadId: "t" } } as Envelope, to, heldAt: 0 };
}
const OWNER_API: Envelope["from"] = { kind: "api", tokenId: "owner:self", name: "owner", owner: true };

describe("replyResultText 的押后提醒", () => {
  test("没有 held / 空对象 / 全是 0 / 认不出：逐字和原来一样", () => {
    const base = { messageIds: ["1", "2"], askId: "ask_ab12", askHash: "h1" };
    const old = 'Sent message(s): ["1","2"] · ask ask_ab12 · askHash h1';
    for (const held of [undefined, null, {}, { owner: 0, peer: 0 }, "3", { owner: "1" }, { peer: -1 }, { agent: 1.5 }]) {
      expect(replyResultText({ ...base, held })).toBe(old);
    }
    expect(replyResultText({ messageIds: ["1"] })).toBe('Sent message(s): ["1"]');
  });

  test("有押后：末尾带总数和各类计数（固定顺序），askId 照样解析", () => {
    const text = replyResultText({ messageIds: ["1"], askId: "ask_ab12", held: { peer: 2, ask: 1, owner: 1, agent: 3 } });
    expect(text).toBe('Sent message(s): ["1"] · ask ask_ab12 · 押后 7 条（owner 1、卡片答复 1、peer 2、agent 3），调 check_inbox 领');
    expect(askIdOfReplyResult({ content: [{ type: "text", text }] })).toBe("ask_ab12");
    expect(askIdOfReplyResult({ content: replyResultText({ messageIds: ["1"], held: { owner: 1 } }) })).toBeNull();
  });

  test("只认四个类别的计数，别的字段（哪怕是正文）不进提醒", () => {
    expect(heldHint({ owner: 1, content: "秘密正文", other: 5 })).toBe(" · 押后 1 条（owner 1），调 check_inbox 领");
  });
});

describe("heldTally / HeldQueue.stat", () => {
  test("按类别数押着、check_inbox 领得到的；租约内的、bridge 通知、guest 不数；正文不出现", () => {
    const leased = { ...mk("leased-peer", { kind: "api", tokenId: "tok-p", name: "He", peer: "He" }), lease: { batchId: "b", at: Date.now() } };
    const items = [
      mk("owner-secret", { kind: "user", userId: "u1" } as Envelope["from"]),
      mk("ask-secret", OWNER_API, "ask_answer"),
      mk("peer-secret", { kind: "api", tokenId: "tok-p", name: "He", peer: "He" }),
      leased,
      mk("agent-secret", { kind: "local", agentName: "agent-x", channelId: "c-x", ws }),
      mk("note", { kind: "bridge", label: "ledger" }, "bridge_synth"),
      mk("guest", { kind: "api", tokenId: "tok-g", name: "guest" }),
    ];
    expect(heldTally(items)).toEqual({ owner: 1, ask: 1, peer: 1, agent: 1 });
    const q = new HeldQueue(null);
    q.set("c-me", items);
    expect(q.stat("c-me")).toEqual({ owner: 1, ask: 1, peer: 1, agent: 1 });
    expect(q.stat("c-other")).toEqual({});
    expect(replyResultText({ messageIds: [], held: q.stat("c-other") })).toBe("Sent message(s): []");
    expect(replyResultText({ messageIds: [], held: q.stat("c-me") })).not.toContain("secret");
  });
});
