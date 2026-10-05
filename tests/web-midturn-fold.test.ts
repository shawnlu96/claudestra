/**
 * 回合中途插进来的入站不切回合（NAR1，owner 2026-10-06 03:48 截图）：
 *   reply → check_inbox → audit-codex 的消息（check_inbox 领出的）→ check_inbox(ack) → 英文总结
 * 那段总结是 reply 之后的旁白，按 09-29 的规则默认收起；修前被中途那条消息提前结账、落进「没有 reply 的新回合」→ 展开。
 * 判据见 web/features/chat/reply-echo.ts midTurnInsert；history（整段 toChatMessages）与直播（差量拼接 + 直播气泡）两条路径结果要一致。
 */
import { describe, expect, test } from "bun:test";
import { postReplyFolds, type EchoCandidate } from "../web/features/chat/reply-echo";
import { toChatMessages, type NeutralMessage } from "../web/lib/chat/history-shape";
import { mergeContiguousAssistant, dropCoveredDelta } from "../web/features/chat/live-merge";
import type { ChatMessage } from "../web/features/chat/type";

const SID = "5f0c2a8e-0000-4000-8000-000000000001";
const AGENT = { from: "agent-claudestra-audit-codex", fromId: "agent" };
const tool = (name: string) => ({ name, summary: name });

/** 截图那一轮 + owner 开的下一轮。inboxSeq：领出的消息挂在工具结果行上（14.01）；整数 = CC 队列吸收的 */
function records(inboxSeq: number, withTurnMs = true): NeutralMessage[] {
  const ms = (n: number) => (withTurnMs ? { turnMs: n } : {});
  return [
    { seq: 10, role: "user", text: "查一下审计结论" },
    { seq: 11, role: "assistant", text: "Checking the audit", tools: [tool("Bash")] },
    { seq: 12, role: "assistant", replyText: "审计结论在路上，先回你一句" },
    { seq: 13, role: "assistant", tools: [tool("mcp__claudestra__check_inbox")] },
    { seq: inboxSeq, role: "user", text: "审计报告：两条 P2，详见附件", ...AGENT },
    { seq: 15, role: "assistant", tools: [tool("mcp__claudestra__check_inbox")] },
    { seq: 16, role: "assistant", text: "**Summary**: audit found 2 P2s, both cosmetic.", ...ms(5000) },
    { seq: 18, role: "user", text: "好，下一件" },
    { seq: 19, role: "assistant", text: "新回合开头的过程旁白", tools: [tool("Read")] },
    { seq: 20, role: "assistant", replyText: "第二件做完了", ...ms(3000) },
  ];
}

/** 默认收起的旁白正文（message-list 的口径：-1 = 整条的 text 段，否则这一段之后的 text 段） */
function foldedTexts(view: ChatMessage[]): string[] {
  const folds = postReplyFolds(view as EchoCandidate[]);
  const out: string[] = [];
  for (const m of view) {
    const p = folds.get(m.id);
    if (p === undefined) continue;
    (m.segments ?? []).forEach((s, i) => {
      if (s.kind === "text" && (p === -1 || i > p)) out.push(s.text);
    });
  }
  return out;
}

const SUMMARY = "**Summary**: audit found 2 P2s, both cosmetic.";

describe("回合中途插入不切回合（history 整段）", () => {
  test("截图序列：check_inbox 领出的消息（seq 带小数）之后的总结默认收起", () => {
    const view = toChatMessages(records(14.01), { sid: SID });
    expect(view.map((m) => m.id)).toEqual(["h10", "h11", "h14.01", "h15", "h18", "h19"]);
    expect(foldedTexts(view)).toEqual([SUMMARY]);
  });

  test("CC 队列吸收的（整数 seq、前一个 assistant 没有回合结束标记）同样不切", () => {
    expect(foldedTexts(toChatMessages(records(14), { sid: SID }))).toEqual([SUMMARY]);
  });

  test("owner 发新消息开新回合：上一回合的结账不变，新回合开头、reply 之前的旁白不收", () => {
    const folds = postReplyFolds(toChatMessages(records(14.01), { sid: SID }) as EchoCandidate[]);
    expect(folds.has("h19")).toBe(false);
    expect([...folds.keys()]).toEqual(["h15"]);
  });

  test("agent 开新回合（前一回合有 turnMs）：照旧结账，新回合的过程旁白不收", () => {
    const view = toChatMessages(
      [
        { seq: 1, role: "assistant", replyText: "交付了" },
        { seq: 2, role: "assistant", text: "the reply is out", turnMs: 900 },
        { seq: 3, role: "user", text: "审查结论：通过", ...AGENT },
        { seq: 4, role: "assistant", text: "Reading the review", tools: [tool("Read")] },
        { seq: 5, role: "assistant", replyText: "收到审查结论", turnMs: 1200 },
      ],
      { sid: SID },
    );
    // seq 1、2 同一回合并成一泡：reply 段之后的那段 text 收；seq 4 是新回合 reply 之前的过程旁白，不收
    expect(foldedTexts(view)).toEqual(["the reply is out"]);
  });

  test("Pi / Codex（列表里没有 turnMs）：整数 seq 的入站照旧当边界；带小数的仍不切", () => {
    expect(foldedTexts(toChatMessages(records(14, false), { sid: SID }))).toEqual([]);
    expect(foldedTexts(toChatMessages(records(14.01, false), { sid: SID }))).toEqual([SUMMARY]);
  });

  test("本人消息永远是边界：前一个 assistant 没有回合结束标记也照样结账", () => {
    const view = toChatMessages(records(14), { sid: SID }).map((m) => (m.id === "h14" ? { ...m, from: undefined } : m));
    expect(foldedTexts(view)).toEqual([]);
  });
});

describe("直播路径与 history 一致", () => {
  test("7s 差量逐段拼接 + 尾部直播气泡，收起结果与刷新后的 history 相同", () => {
    const all = records(14.01);
    // 第一拍差量到 check_inbox 领出的消息为止；后面那段还在直播气泡里（事件先到、差量没追上）
    let view: ChatMessage[] = [];
    for (const chunk of [all.slice(0, 2), all.slice(2, 5)]) {
      const delta = toChatMessages(chunk, { sid: SID, tail: false });
      view = mergeContiguousAssistant(view, dropCoveredDelta(view, delta));
    }
    const liveBubble: ChatMessage = {
      id: "live-1",
      role: "assistant",
      content: SUMMARY,
      streamed: false,
      turnDone: true,
      turnMs: 5000,
      segments: [
        { kind: "tools", tools: [{ name: "mcp__claudestra__check_inbox", summary: "", state: "done", seq: 15 }] },
        { kind: "text", text: SUMMARY, seq: 16 },
      ],
    };
    const live = [...view, liveBubble];
    expect(live.map((m) => m.id)).toEqual(["h10", "h11", "h14.01", "live-1"]);
    expect(foldedTexts(live)).toEqual(foldedTexts(toChatMessages(all.slice(0, 7), { sid: SID })));
    expect(foldedTexts(live)).toEqual([SUMMARY]);
  });

  test("回合进行中（还没有 turnMs）：check_inbox 领出的消息照样不切，直播尾巴的总结已收起", () => {
    const view = toChatMessages(records(14.01).slice(0, 5), { sid: SID, tail: false });
    const tail: ChatMessage = { id: "live-2", role: "assistant", content: SUMMARY, streamed: true, segments: [{ kind: "text", text: SUMMARY }] };
    expect(foldedTexts([...view, tail])).toEqual([SUMMARY]);
  });
});
