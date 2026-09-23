/**
 * 并发对齐拿同一个旧游标拉回同一段差量 → 不能整段重复（2026-09-23 owner 截图：按钮消息 + 两个
 * 工具卡片叠了 4 遍；当时页面 70s 冻结 + 服务重启，反复 reconnect(full) / 唤醒差量 / 7s 心跳并发）。
 */
import { describe, expect, test } from "bun:test";
import { dropCoveredDelta, mergeContiguousAssistant } from "@/features/chat/live-merge";
import type { ChatMessage } from "@/features/chat/type";

const SID = "51fef248";
const u = (seq: number, content: string): ChatMessage => ({ id: `h${seq}`, role: "user", content, sid: SID, seqEnd: seq } as ChatMessage);
const a = (seq: number, seqEnd: number, content: string): ChatMessage =>
  ({ id: `h${seq}`, role: "assistant", content, sid: SID, seqEnd } as ChatMessage);

describe("dropCoveredDelta", () => {
  const base = [a(71200, 71240, "上一轮"), u(71247, "[button:push_only_mine_fix]"), a(71250, 71262, "两个 Bash")];

  test("过期差量（同一段又拉回来一次）整段丢掉，合流后不重复", () => {
    const stale = [u(71247, "[button:push_only_mine_fix]"), a(71250, 71262, "两个 Bash")];
    const kept = dropCoveredDelta(base, stale);
    expect(kept).toEqual([]);
    expect(mergeContiguousAssistant(base, kept)).toHaveLength(3);
  });

  test("部分重叠：只留游标之后的新记录", () => {
    const delta = [a(71250, 71262, "两个 Bash"), a(71274, 71280, "新的工具")];
    expect(dropCoveredDelta(base, delta).map((m) => m.id)).toEqual(["h71274"]);
  });

  test("别的会话 / 没有 seq 的不动（交给轮转与时间戳规则）", () => {
    const other = { ...a(10, 12, "新会话"), sid: "other" } as ChatMessage;
    const noSeq = { id: "live-1", role: "assistant", content: "直播" } as ChatMessage;
    expect(dropCoveredDelta(base, [other, noSeq])).toHaveLength(2);
  });
});
