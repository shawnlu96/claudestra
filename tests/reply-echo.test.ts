/**
 * 「回复被 agent 复述一遍」的去重判据（web 侧纯逻辑）。
 *
 * 现场（owner 2026-09-22「你看看回复这两种形式是不是都不太对」）：pi_bn_market_maker
 * 10:32 那一轮——
 *   02:32:32  assistant  [thinking] [tool:memory_write] [tool:reply]
 *   02:32:41  assistant  [text(1147)]        ← 同一段话又写了一遍
 * 两份**逐字节相同**（去空白后 884 == 884）。
 *
 * 判据刻意严：藏错了等于把真内容吞掉，漏判只是多显示一份。所以下面既测「该藏的藏」，
 * 也花同样多的格子测「不该藏的一定不藏」。
 */
import { describe, test, expect } from "bun:test";
import {
  isReplyEcho,
  replyEchoMessageIds,
  isEchoSegment,
  ECHO_MIN_CHARS,
  postReplyFolds,
} from "@/features/chat/reply-echo";

const LONG = "**没出问题** —— 那段报错是我自己复核脚本的两条「防呆守卫」拒绝了写入，不是仓库坏了。说清楚：两个 AssertionError 是我的脚本主动中止。";

describe("isReplyEcho", () => {
  test("逐字节相同 → 是复述（现场就是这一格）", () => {
    expect(isReplyEcho(LONG, LONG)).toBe(true);
  });

  test("只差空白/换行 → 仍是复述", () => {
    expect(isReplyEcho(LONG, LONG.replace(/。/g, "。\n\n"))).toBe(true);
  });

  test("只差 markdown 强调符号 → 仍是复述（复述时 ** 常有增减）", () => {
    expect(isReplyEcho(LONG, LONG.replace(/\*\*/g, ""))).toBe(true);
  });

  test("一方是另一方的前缀且长度差不到一成 → 是复述（末尾少一句）", () => {
    const short = LONG.slice(0, Math.floor(LONG.length * 0.93));
    expect(isReplyEcho(short, LONG)).toBe(true);
  });

  // ── 以下都是「绝不能藏」 ──
  test("前缀但短很多 → 不是复述（那可能是真的摘要/另一段话）", () => {
    expect(isReplyEcho(LONG.slice(0, 40), LONG)).toBe(false);
  });

  test("内容不同 → 不是复述", () => {
    expect(isReplyEcho(LONG, "我先去把 CI 跑一遍，跑完再回来说结论，大概两分钟。别的先不动。")).toBe(false);
  });

  test("太短不判（短句撞相同的概率高得多）", () => {
    const tiny = "已发出。";
    expect(tiny.replace(/\s+/g, "").length).toBeLessThan(ECHO_MIN_CHARS);
    expect(isReplyEcho(tiny, tiny)).toBe(false);
  });

  test("空串不判", () => {
    expect(isReplyEcho("", LONG)).toBe(false);
    expect(isReplyEcho(LONG, "")).toBe(false);
  });
});

describe("isEchoSegment（形态①：同一条消息里）", () => {
  const msg = {
    id: "a1",
    role: "assistant",
    segments: [
      { kind: "reply", text: LONG },
      { kind: "text", text: LONG },
    ],
  };

  test("text 段复述了本条的 reply 段 → 藏它", () => {
    expect(isEchoSegment(msg, LONG)).toBe(true);
  });

  test("别的叙述不藏", () => {
    expect(isEchoSegment(msg, "顺手把 lockfile 也还原了。")).toBe(false);
  });

  test("挂在 replyText 上的旧快照同样认", () => {
    expect(isEchoSegment({ id: "a2", role: "assistant", replyText: LONG }, LONG)).toBe(true);
  });
});

describe("replyEchoMessageIds（形态②：紧随其后的独立消息）", () => {
  test("reply 之后那条纯 text 复述 → 整条藏掉", () => {
    const ids = replyEchoMessageIds([
      { id: "u1", role: "user", content: "问题" },
      { id: "a1", role: "assistant", replyText: LONG },
      { id: "a2", role: "assistant", segments: [{ kind: "text", text: LONG }] },
    ]);
    expect([...ids]).toEqual(["a2"]);
  });

  test("带工具卡的那条不藏（还有别的内容要看）", () => {
    const ids = replyEchoMessageIds([
      { id: "a1", role: "assistant", replyText: LONG },
      { id: "a2", role: "assistant", segments: [{ kind: "text", text: LONG }], toolCalls: [{}] },
    ]);
    expect(ids.size).toBe(0);
  });

  test("自己也带 reply 的那条不藏（它是新的一份回复，不是复述）", () => {
    const ids = replyEchoMessageIds([
      { id: "a1", role: "assistant", replyText: LONG },
      { id: "a2", role: "assistant", replyText: LONG, segments: [{ kind: "text", text: LONG }] },
    ]);
    expect(ids.has("a2")).toBe(false);
  });

  test("用户插话后清账——跨回合说同样的话不算复述", () => {
    const ids = replyEchoMessageIds([
      { id: "a1", role: "assistant", replyText: LONG },
      { id: "u1", role: "user", content: "再说一遍刚才那段" },
      { id: "a2", role: "assistant", segments: [{ kind: "text", text: LONG }] },
    ]);
    expect(ids.size).toBe(0);
  });

  test("进度句不当复述处理（它本来就是更弱一档的斜体小字）", () => {
    const ids = replyEchoMessageIds([
      { id: "a1", role: "assistant", replyText: LONG },
      { id: "a2", role: "assistant", segments: [{ kind: "text", text: LONG, progress: true }] },
    ]);
    expect(ids.size).toBe(0);
  });

  test("没有 reply 在前 → 什么都不藏", () => {
    const ids = replyEchoMessageIds([
      { id: "a1", role: "assistant", segments: [{ kind: "text", text: LONG }] },
      { id: "a2", role: "assistant", segments: [{ kind: "text", text: LONG }] },
    ]);
    expect(ids.size).toBe(0);
  });
});

describe("postReplyFolds：reply 之后的旁白默认收起（不看文字是否相同）", () => {
  test("紧跟 reply 的纯旁白收整条；两次 reply 之间的过程旁白不收；本轮最后一次 reply 之后的都收", () => {
    const folds = postReplyFolds([
      { id: "a1", role: "assistant", segments: [{ kind: "text", text: "Checking CI" }, { kind: "reply", text: "发版完成" }] },
      { id: "a2", role: "assistant", segments: [{ kind: "text", text: "Release is out and verified" }] },
      { id: "a3", role: "assistant", segments: [{ kind: "text", text: "Main CI passed" }] },
      { id: "a4", role: "assistant", replyText: "旧快照的回复" },
      { id: "u1", role: "user", content: "好" },
      { id: "a5", role: "assistant", segments: [{ kind: "text", text: "新回合开头的旁白" }] },
      { id: "a6", role: "assistant", segments: [{ kind: "reply", text: "回复" }] },
      { id: "a7", role: "assistant", segments: [{ kind: "text", text: "reply 后带工具的，文字也收" }], toolCalls: [{}] },
    ]);
    expect([...folds]).toEqual([["a2", -1], ["a7", -1]]);
  });

  test("reply → 记记忆 → 改文件 → 英文总结（dynamic-workflow 现场）：中间隔了工具也收", () => {
    const folds = postReplyFolds([
      { id: "r", role: "assistant", segments: [{ kind: "reply", text: "两项实测都做完了" }] },
      { id: "t1", role: "assistant", segments: [], toolCalls: [{}] },
      { id: "t2", role: "assistant", segments: [], toolCalls: [{}] },
      { id: "s", role: "assistant", segments: [{ kind: "text", text: "I ran both checks: one real call each to Claude and Codex" }] },
      { id: "n", role: "user", content: "<task-notification>" },
      { id: "x", role: "assistant", segments: [{ kind: "text", text: "下一轮的旁白照常显示" }] },
    ]);
    expect(folds.get("s")).toBe(-1);
    expect(folds.has("x")).toBe(false);
  });

  test("直播态同一条消息里：最后一个 reply 段之后的 text 段收，之前的不收；reply 之后只有工具就不记", () => {
    const seg = (kind: string, text = "x") => ({ kind, text });
    const folds = postReplyFolds([
      { id: "m", role: "assistant", segments: [seg("text"), seg("reply"), seg("text"), seg("reply"), seg("tools"), seg("text")] },
      { id: "k", role: "user", content: "好" },
      { id: "q", role: "assistant", segments: [seg("text"), seg("reply"), seg("tools")] },
    ]);
    expect(folds.get("m")).toBe(3);
    expect(folds.has("q")).toBe(false);
  });
});
