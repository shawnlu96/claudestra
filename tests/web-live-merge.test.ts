import { describe, expect, test } from "bun:test";
import {
  coveredByCursor,
  pruneLiveBubbles,
  mergeContiguousAssistant,
  historyHasReply,
} from "../web/features/chat/live-merge";
import type { ChatMessage } from "../web/features/chat/type";

const SID = "d9b485ef-dcd2-4609-8e0a-07c6a5515a99";

function hist(firstSeq: number, seqEnd: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `h${firstSeq}`,
    role: "assistant",
    content: "",
    segments: [],
    ts: "2026-09-17T11:43:28.389Z",
    sid: SID,
    seqEnd,
    ...extra,
  };
}

/** 直播气泡:进度句(seq 6786) + 三个 Bash(6787/6790/6793)——owner 截图那一组 */
function live(extra: Partial<ChatMessage> = {}): ChatMessage {
  const tools = [
    { name: "Bash", summary: "用青岛机器对照测…", state: "done" as const, seq: 6787 },
    { name: "Bash", summary: "复测上海到日本…", state: "done" as const, seq: 6790 },
    { name: "Bash", summary: "探测专线入口端口…", state: "running" as const, seq: 6793 },
  ];
  return {
    id: "m42",
    role: "assistant",
    content: "",
    streamed: true,
    ts: "2026-09-17T11:43:35.000Z",
    sid: SID,
    seqEnd: 6793,
    segments: [
      { kind: "text", text: "已确认 rel_nodeclient 是中转服务节点客户端…", progress: true, seq: 6786 },
      { kind: "tools", tools },
    ],
    toolCalls: tools,
    ...extra,
  };
}

describe("coveredByCursor — 差量先到、事件后到", () => {
  const cursor = { sid: SID, lastSeq: 6797 };
  test("同会话 seq ≤ 游标 → 已在历史里", () => {
    expect(coveredByCursor(cursor, { seq: 6793, sid: SID })).toBe(true);
    expect(coveredByCursor(cursor, { seq: 6797, sid: SID })).toBe(true);
  });
  test("seq 在游标之后 → 新内容,要画", () => {
    expect(coveredByCursor(cursor, { seq: 6798, sid: SID })).toBe(false);
  });
  test("没 seq / 没 sid / 会话不同 / 没游标 → 不判覆盖(退回老规则)", () => {
    expect(coveredByCursor(cursor, { sid: SID })).toBe(false);
    expect(coveredByCursor(cursor, { seq: 1 })).toBe(false);
    expect(coveredByCursor(cursor, { seq: 1, sid: "other" })).toBe(false);
    expect(coveredByCursor(null, { seq: 1, sid: SID })).toBe(false);
  });
});

describe("pruneLiveBubbles — 事件先到、差量后到", () => {
  test("差量把整组记录以历史形态拉进来 → 直播气泡整泡丢弃(不再看时间戳)", () => {
    // 直播气泡 ts 比历史首条晚 6.6s——老的 ±5s 规则会把它留下成两份
    const delta = [hist(6785, 6797)];
    const kept = pruneLiveBubbles([live()], delta, { sid: SID, lastSeq: 6797 }, delta);
    expect(kept).toEqual([]);
  });

  test("部分覆盖 → 只剥掉 seq ≤ 游标的段/工具,余下的留着继续流", () => {
    const delta = [hist(6785, 6790)];
    const kept = pruneLiveBubbles([live()], delta, { sid: SID, lastSeq: 6790 }, delta);
    expect(kept).toHaveLength(1);
    const m = kept[0];
    expect(m.segments).toEqual([
      { kind: "tools", tools: [{ name: "Bash", summary: "探测专线入口端口…", state: "running", seq: 6793 }] },
    ]);
    expect(m.toolCalls).toHaveLength(1);
    expect(m.content).toBe("");
    expect(m.id).toBe("m42"); // 还是同一个直播气泡,渲染不跳
  });

  test("部分覆盖时叙述文本按段剥:content 跟着重算", () => {
    const b = live({
      segments: [
        { kind: "text", text: "先看一下。", seq: 6786 },
        { kind: "text", text: "再改一下。", seq: 6800 },
      ],
      toolCalls: undefined,
      content: "先看一下。再改一下。",
      seqEnd: 6800,
    });
    const delta = [hist(6785, 6790)];
    const kept = pruneLiveBubbles([b], delta, { sid: SID, lastSeq: 6790 }, delta);
    expect(kept).toHaveLength(1);
    expect(kept[0].segments).toEqual([{ kind: "text", text: "再改一下。", seq: 6800 }]);
    expect(kept[0].content).toBe("再改一下。");
  });

  test("没带 seq 的老气泡退回时间戳规则:比差量末条 assistant 晚 5s 以上才留", () => {
    const untagged = live({ seqEnd: undefined, segments: [{ kind: "text", text: "x" }], toolCalls: undefined });
    const delta = [hist(6785, 6797)]; // ts 11:43:28.389;直播 ts 11:43:35 → 差 6.6s → 留
    expect(pruneLiveBubbles([untagged], delta, { sid: SID, lastSeq: 6797 }, delta)).toHaveLength(1);
    const late = { ...untagged, ts: "2026-09-17T11:43:30.000Z" }; // 差 1.6s → 丢
    expect(pruneLiveBubbles([late], delta, { sid: SID, lastSeq: 6797 }, delta)).toHaveLength(0);
  });

  test("会话不同(游标属于另一个 session)→ 不按 seq 比,退回时间戳规则", () => {
    const delta = [hist(10, 12, { sid: "other-session" })];
    const kept = pruneLiveBubbles([live()], delta, { sid: "other-session", lastSeq: 12 }, delta);
    expect(kept).toHaveLength(1); // ts 差 6.6s → 时间戳规则留下
  });

  test("全被覆盖但 reply 段(bridge 直投,无 seq)历史里还没有 → 只留 reply 段,seqEnd 保留待下次对账", () => {
    const b = live({
      segments: [...(live().segments ?? []), { kind: "reply", text: "结论:跨境拥塞。" }],
      replyText: "结论:跨境拥塞。",
    });
    const delta = [hist(6785, 6797)];
    const kept = pruneLiveBubbles([b], delta, { sid: SID, lastSeq: 6797 }, delta);
    expect(kept).toHaveLength(1);
    expect(kept[0].segments).toEqual([{ kind: "reply", text: "结论:跨境拥塞。" }]);
    expect(kept[0].toolCalls).toBeUndefined();
    expect(kept[0].seqEnd).toBe(6793);
    // 下一次差量把 reply 也带进历史了 → 整泡丢
    const delta2 = [hist(6785, 6805, { segments: [{ kind: "reply", text: "结论:跨境拥塞。" }] })];
    expect(pruneLiveBubbles(kept, delta2, { sid: SID, lastSeq: 6805 }, delta2)).toEqual([]);
  });

  test("没有游标 → 一律时间戳规则", () => {
    const delta = [hist(6785, 6797)];
    expect(pruneLiveBubbles([live()], delta, null, delta)).toHaveLength(1);
  });
});

describe("historyHasReply", () => {
  test("只看最近 6 条 assistant 历史气泡的 reply 段", () => {
    const h = [hist(1, 2, { segments: [{ kind: "reply", text: " 好的 " }] })];
    expect(historyHasReply(h, "好的")).toBe(true);
    expect(historyHasReply(h, "不好")).toBe(false);
    expect(historyHasReply([], "   ")).toBe(true); // 空 reply 无处可留
  });
});

describe("mergeContiguousAssistant — 差量续接同一回合", () => {
  test("历史尾 + 差量首都是同会话 assistant 历史气泡 → 拼成一泡(content \\n\\n、reply \\n、seqEnd 取新)", () => {
    const base = [
      { id: "h1", role: "user" as const, content: "查一下", sid: SID, seqEnd: 1 },
      hist(2, 9, { content: "先看。", segments: [{ kind: "text", text: "先看。" }], toolCalls: [{ name: "Read", summary: "a.ts", state: "done" }] }),
    ];
    const delta = [
      hist(12, 20, { content: "再改。", segments: [{ kind: "tools", tools: [{ name: "Edit", summary: "a.ts", state: "done" }] }, { kind: "reply", text: "改好了" }], replyText: "改好了", toolCalls: [{ name: "Edit", summary: "a.ts", state: "done" }] }),
      { id: "h21", role: "user" as const, content: "谢谢", sid: SID, seqEnd: 21 },
    ];
    const out = mergeContiguousAssistant(base, delta);
    expect(out.map((m) => m.id)).toEqual(["h1", "h2", "h21"]);
    const m = out[1];
    expect(m.content).toBe("先看。\n\n再改。");
    expect(m.replyText).toBe("改好了");
    expect(m.seqEnd).toBe(20);
    expect(m.segments).toHaveLength(3);
    expect(m.toolCalls).toHaveLength(2);
  });

  test("差量首条是 user → 不拼", () => {
    const base = [hist(2, 9)];
    const delta = [{ id: "h10", role: "user" as const, content: "补一句", sid: SID, seqEnd: 10 }, hist(11, 15)];
    expect(mergeContiguousAssistant(base, delta).map((m) => m.id)).toEqual(["h2", "h10", "h11"]);
  });

  test("会话不同 / 直播气泡 / seq 倒挂 → 不拼", () => {
    expect(mergeContiguousAssistant([hist(2, 9, { sid: "x" })], [hist(12, 20)])).toHaveLength(2);
    expect(mergeContiguousAssistant([live()], [hist(12, 20)])).toHaveLength(2);
    expect(mergeContiguousAssistant([hist(2, 30)], [hist(12, 20)])).toHaveLength(2);
  });

  test("空输入原样返回", () => {
    expect(mergeContiguousAssistant([], [hist(1, 2)])).toHaveLength(1);
    expect(mergeContiguousAssistant([hist(1, 2)], [])).toHaveLength(1);
  });
});
