/**
 * agent 发来的入站气泡默认折叠（NAR1，owner 2026-10-06 03:50「pm 内的这种 agent 发来的信息默认折叠」）。
 * 只折机器发的长消息：本人、真人、peer-<token>（背后可能是人）不折；超短的不出折叠条。
 */
import { describe, expect, test } from "bun:test";
import { foldsInbound, INBOUND_FOLD_MIN_CHARS } from "../web/features/chat/inbound-fold";

const LONG = "NAR1 复述（等放行）\n\n① 回合判据\n- check_inbox 领出的消息 seq 带小数\n② 改哪里\n③ 怎么证明";

describe("foldsInbound", () => {
  test("本地 agent / 大总管 / 对方的 agent / bridge 来源的长消息折叠", () => {
    for (const from of ["agent-task-clr1", "task-clr1(agent)", "master", "peer Shawn/claudestra", "bridge:ia-watchdog"]) {
      expect(foldsInbound(from, LONG)).toBe(true);
    }
  });

  test("本人（没有 from）、真人、peer-<token>、收件箱兜底不折", () => {
    expect(foldsInbound(undefined, LONG)).toBe(false);
    for (const from of ["heliumorz", "peer-Shawn", "收件箱", "owner"]) expect(foldsInbound(from, LONG)).toBe(false);
  });

  test("两行以内且不长的不出折叠条；超过两行或单行很长的折", () => {
    expect(foldsInbound("agent-x", "交付了，head abc123")).toBe(false);
    expect(foldsInbound("agent-x", "第一行\n第二行")).toBe(false);
    expect(foldsInbound("agent-x", "第一行\n第二行\n第三行")).toBe(true);
    expect(foldsInbound("agent-x", "长".repeat(INBOUND_FOLD_MIN_CHARS))).toBe(false);
    expect(foldsInbound("agent-x", "长".repeat(INBOUND_FOLD_MIN_CHARS + 1))).toBe(true);
    expect(foldsInbound("agent-x", "  短消息带空白  \n\n")).toBe(false);
  });
});
