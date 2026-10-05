/**
 * 回合中途插进来的入站不切回合（NAR1，owner 2026-10-06 03:48 截图）：
 *   reply → check_inbox → audit-codex 的消息（check_inbox 领出的）→ check_inbox(ack) → 英文总结
 * 那段总结是 reply 之后的旁白，按 09-29 的规则默认收起；修前被中途那条消息提前结账、落进「没有 reply 的新回合」→ 展开。
 * 判据见 web/features/chat/reply-echo.ts midTurnInsert：只认服务端按记录本身标出的两种（seq 带小数 / midTurn），
 * 不按 turnMs 推断（PR #709 r1 P1：turn_duration 落在窗口外，开新回合的入站被当成中途，新回合的旁白被误收、刷新后又不一样）。
 */
import { describe, expect, test } from "bun:test";
import { postReplyFolds, type EchoCandidate } from "../web/features/chat/reply-echo";
import { toChatMessages, type NeutralMessage } from "../web/lib/chat/history-shape";
import { mergeContiguousAssistant, dropCoveredDelta } from "../web/features/chat/live-merge";
import { parseHistoryLines } from "../src/lib/session-history-parse";
import type { ChatMessage } from "../web/features/chat/type";

const SID = "5f0c2a8e-0000-4000-8000-000000000001";
const AGENT = { from: "agent-claudestra-audit-codex", fromId: "agent" };
const SELF = new Set(["api:owner:self"]);
const tool = (name: string) => ({ name, summary: name });
const SUMMARY = "**Summary**: audit found 2 P2s, both cosmetic.";

/** 截图那一轮 + owner 开的下一轮。inbox：领出的消息挂在工具结果行上（14.01）；否则是 CC 队列吸收的（整数 seq + midTurn） */
function records(inbox: boolean): NeutralMessage[] {
  const inserted = inbox ? { seq: 14.01 } : { seq: 14, midTurn: true };
  return [
    { seq: 10, role: "user", text: "查一下审计结论" },
    { seq: 11, role: "assistant", text: "Checking the audit", tools: [tool("Bash")] },
    { seq: 12, role: "assistant", replyText: "审计结论在路上，先回你一句" },
    { seq: 13, role: "assistant", tools: [tool("mcp__claudestra__check_inbox")] },
    { ...inserted, role: "user", text: "审计报告：两条 P2，详见附件", ...AGENT },
    { seq: 15, role: "assistant", tools: [tool("mcp__claudestra__check_inbox")] },
    { seq: 16, role: "assistant", text: SUMMARY, turnMs: 5000 },
    { seq: 18, role: "user", text: "好，下一件" },
    { seq: 19, role: "assistant", text: "新回合开头的过程旁白", tools: [tool("Read")] },
    { seq: 20, role: "assistant", replyText: "第二件做完了", turnMs: 3000 },
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

/** 按窗口逐段整形再拼（chat-store.syncDelta 的组装：dropCoveredDelta → mergeContiguousAssistant） */
function viaDeltas(windows: NeutralMessage[][]): ChatMessage[] {
  let view: ChatMessage[] = [];
  for (const w of windows) view = mergeContiguousAssistant(view, dropCoveredDelta(view, toChatMessages(w, { sid: SID, tail: false, selfIds: SELF })));
  return view;
}

describe("回合中途插入不切回合（history 整段）", () => {
  test("截图序列：check_inbox 领出的消息（seq 带小数）之后的总结默认收起", () => {
    const view = toChatMessages(records(true), { sid: SID });
    expect(view.map((m) => m.id)).toEqual(["h10", "h11", "h14.01", "h15", "h18", "h19"]);
    expect(foldedTexts(view)).toEqual([SUMMARY]);
  });

  test("服务端标了 midTurn 的（CC 队列吸收的）同样不切", () => {
    expect(foldedTexts(toChatMessages(records(false), { sid: SID }))).toEqual([SUMMARY]);
  });

  test("没标 midTurn 的整数 seq 入站（开新回合 / 老 bridge）照旧结账", () => {
    const view = toChatMessages(records(false).map((m) => ({ ...m, midTurn: undefined })), { sid: SID });
    expect(foldedTexts(view)).toEqual([]);
  });

  test("owner 发新消息开新回合：上一回合的结账不变，新回合开头、reply 之前的旁白不收", () => {
    const folds = postReplyFolds(toChatMessages(records(true), { sid: SID }) as EchoCandidate[]);
    expect([...folds.keys()]).toEqual(["h15"]);
  });

  test("r1 审查原样复现：结束标记缺了也不能判成中途——有没有 turnMs 结果都一样", () => {
    const recs: NeutralMessage[] = [
      { seq: 1, role: "assistant", text: "old", turnMs: 100 },
      { seq: 2, role: "user", text: "start" },
      { seq: 3, role: "assistant", replyText: "done" },
      { seq: 4, role: "user", text: "new task", from: "agent-x" },
      { seq: 5, role: "assistant", text: "new task reasoning" },
    ];
    const folds = (rs: NeutralMessage[]) => [...postReplyFolds(toChatMessages(rs, { sid: SID }) as EchoCandidate[])];
    expect(folds(recs)).toEqual([]);
    expect(folds(recs.map((m) => (m.seq === 3 ? { ...m, turnMs: 200 } : m)))).toEqual([]);
  });

  test("本人发的 midTurn 消息仍是边界", () => {
    const view = toChatMessages(records(false), { sid: SID }).map((m) => (m.id === "h14" ? { ...m, from: undefined } : m));
    expect(foldedTexts(view)).toEqual([]);
  });
});

describe("直播路径与 history 一致", () => {
  test("7s 差量逐段拼接 + 尾部直播气泡，收起结果与刷新后的 history 相同", () => {
    const all = records(true);
    const liveBubble: ChatMessage = {
      id: "live-1",
      role: "assistant",
      content: SUMMARY,
      streamed: false,
      turnDone: true,
      segments: [
        { kind: "tools", tools: [{ name: "mcp__claudestra__check_inbox", summary: "", state: "done", seq: 15 }] },
        { kind: "text", text: SUMMARY, seq: 16 },
      ],
    };
    const live = [...viaDeltas([all.slice(0, 2), all.slice(2, 5)]), liveBubble];
    expect(live.map((m) => m.id)).toEqual(["h10", "h11", "h14.01", "live-1"]);
    expect(foldedTexts(live)).toEqual(foldedTexts(toChatMessages(all.slice(0, 7), { sid: SID })));
    expect(foldedTexts(live)).toEqual([SUMMARY]);
  });

  test("回合进行中：check_inbox 领出的消息照样不切，直播尾巴的总结已收起", () => {
    const view = toChatMessages(records(true).slice(0, 5), { sid: SID, tail: false });
    const tail: ChatMessage = { id: "live-2", role: "assistant", content: SUMMARY, streamed: true, segments: [{ kind: "text", text: SUMMARY }] };
    expect(foldedTexts([...view, tail])).toEqual([SUMMARY]);
  });
});

/** 真 CC 会话记录的形状（channel 入站 isMeta、忙时的 queued_command 附件、turn_duration），从服务端解析一路走到收起判定 */
const channel = (user: string, userId: string, mid: string, text: string) => `<channel source="claudestra" user="${user}" user_id="${userId}" message_id="${mid}">\n${text}\n</channel>`;
const lines = [
  { type: "user", isMeta: true, message: { content: channel("owner", "api:owner:self", "m1", "查一下审计结论") } },
  { type: "assistant", message: { content: [{ type: "text", text: "Checking the audit" }, { type: "tool_use", id: "b1", name: "Bash", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "ok" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "mcp__claudestra__reply", input: { text: "审计结论在路上，先回你一句" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "sent" }] } },
  { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", prompt: channel("agent-claudestra-audit-codex", "agent", "m2", "审计报告：两条 P2") } },
  { type: "assistant", message: { content: [{ type: "text", text: SUMMARY }] } },
  { type: "system", subtype: "turn_duration", durationMs: 5000 },
  { type: "user", isMeta: true, message: { content: channel("agent-task-clr1", "agent", "m3", "CLR1 复述：…") } },
  { type: "assistant", message: { content: [{ type: "text", text: "新回合的过程旁白" }, { type: "tool_use", id: "rd", name: "Read", input: {} }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "rd", content: "ok" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "读完了，接着改" }] } },
  { type: "system", subtype: "turn_duration", durationMs: 4000 },
].map((r) => JSON.stringify(r));
const parse = (from: number, to: number) => parseHistoryLines(lines.slice(from, to), from, (n) => n, undefined) as NeutralMessage[];

describe("服务端解析 → 网页（真记录形状）", () => {
  test("queued_command 入站带 midTurn，isMeta 入站不带", () => {
    const users = parse(0, lines.length).filter((m) => m.role === "user");
    expect(users.map((m) => [m.seq, !!m.midTurn])).toEqual([[0, false], [5, true], [8, false]]);
  });

  test("整段读：中途那条之后的总结收起；agent 开的新回合（没有 reply）的过程旁白不收", () => {
    expect(foldedTexts(toChatMessages(parse(0, lines.length), { sid: SID, selfIds: SELF }))).toEqual([SUMMARY]);
  });

  test("r1 P1：turn_duration 落进下一个窗口（回填丢了），结果与整段读一样，新回合旁白不被误收", () => {
    const split = viaDeltas([parse(0, 7), parse(7, lines.length)]);
    expect(split.find((m) => m.id === "h6")?.turnMs).toBeUndefined(); // 回填确实丢了（整段读时 h6 带 5000）
    expect(foldedTexts(split)).toEqual([SUMMARY]);
  });
});
