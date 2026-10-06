/**
 * agent 发来的入站气泡默认折叠（NAR1，owner 2026-10-06 03:50「pm 内的这种 agent 发来的信息默认折叠」）。
 * 只折机器发的长消息：本人、真人、peer-<token>（背后可能是人）不折；超短的不出折叠条。
 */
import { describe, expect, test } from "bun:test";
import { foldsInbound, INBOUND_FOLD_MIN_CHARS } from "../web/features/chat/inbound-fold";
import { renderBouncePush, renderDriftPush, renderMergedPush, renderReviewPush } from "../src/lib/peer-pr-message";

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

  test("peer-<token> 发来的调度器 / 自动定长消息折叠（抬头取自真实渲染函数，改了抬头这里先红）", () => {
    const counts = { verdict: "changes", p0: 0, p1: 1, p2: 0, round: 1 };
    const review = renderReviewPush({ number: 715, taskId: "PNF1", head: "a".repeat(40), counts, maxRounds: 3, replyTo: "agent-x", report: "## P1\n细节", masked: 0 });
    const bounce = renderBouncePush(715, { cause: "ci_fail", prHead: "b".repeat(40), checks: [{ name: "check", link: "" }] }, "agent-x");
    const tell = "【自动定】PNF1 你的提问（ask a1）PM 15 分钟没回，测试类扩围已自动批准：tests/x.test.ts 已追加进本卡范围（fileGlobs），规格末尾追加了「自动定」一节。照常继续。";
    for (const text of [review, bounce, renderDriftPush(715, "c".repeat(40), "d".repeat(40), "agent-x"), tell]) {
      expect(foldsInbound("peer-Shawn", text)).toBe(true);
    }
    expect(foldsInbound("peer-Shawn", `  ${review}`)).toBe(true);
  });

  test("peer-<token> 的真人消息、抬头只在中间出现、短的调度器通知不折", () => {
    expect(foldsInbound("peer-Shawn", "PR #715 我看了，P1 那条是误报，第二轮你直接合吧，有问题再找我。今晚我都在线，Discord 也能找到我，别等太久哈。")).toBe(false);
    expect(foldsInbound("peer-Shawn", "我转一下调度器刚发的：\n[Claudestra 调度器 · PR #715] 已合并\n第三行")).toBe(false);
    expect(foldsInbound("peer-Shawn", "[Claudestra] 我自己写的方括号\n第二行\n第三行")).toBe(false);
    expect(foldsInbound("peer-Shawn", "[Claudestra 调度器 今天收到这个通知，我想问一下\n这不是代码生成的抬头\n请看我的问题")).toBe(false);
    expect(foldsInbound("peer-Shawn", "[Claudestra 调度器· PR #715 我手打的\n第二行\n第三行")).toBe(false);
    expect(foldsInbound("peer-Shawn", renderMergedPush(715, "e".repeat(40), "agent-x"))).toBe(false);
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
