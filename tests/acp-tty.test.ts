import { describe, expect, test } from "bun:test";
import { transcriptOfEntry } from "../src/lib/acp/transcript.ts";
import { dim } from "../src/lib/acp/tty-layout.ts";
import { createTtyScreen } from "../src/lib/acp/tty-screen.ts";
import { elapsed, fitWidth, foldsOf, statusText, type TurnState } from "../src/lib/acp/tty-status.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { termText } from "./helpers/acp-tty-term.ts";
import { renderFixtures } from "./helpers/acp-transcript-fixtures.ts";

// ACP 窗口的 TTY 画法：底部一行状态（空闲 / 思考中 + 计时 / 等待审批 / 排队），内容写在它上面
const IDLE: TurnState = { busy: false, queued: 0, permissions: 0 };
const at = new Date(2026, 9, 7, 12, 0, 0);

function screen(cols = 80) {
  const st = { state: { ...IDLE }, now: 0, cols, out: "" };
  const s = createTtyScreen({ write: (x) => void (st.out += x), columns: () => st.cols }, () => st.state, () => st.now);
  return { st, s, view: () => termText(st.out) };
}

describe("ACP 窗口状态行", () => {
  test("四种状态：空闲、思考中带计时、等待审批优先、排队数", () => {
    expect(statusText(IDLE, 0)).toBe("· 空闲");
    expect(statusText({ busy: true, queued: 0, permissions: 0 }, 12_400)).toBe("✻ 思考中… 12s（Esc 打断）");
    expect(statusText({ busy: true, queued: 2, permissions: 0 }, 125_000)).toBe("✻ 思考中… 2m 05s · 排队 2 条（Esc 打断）");
    expect(statusText({ busy: true, queued: 1, permissions: 1 }, 5_000)).toBe("⏸ 等待审批（到网页卡片作答） · 排队 1 条");
    expect(elapsed(-5)).toBe("0s");
  });

  test("折行数照 tmux 重排的折法算（实测 tmux 3.6a：审批行在 22 列折成 3 行，「等」×20 折成 3 行，40 个 a 折成 2 行）", () => {
    expect(foldsOf(statusText({ busy: true, queued: 1, permissions: 1 }, 0), 22)).toBe(2);
    expect(foldsOf("等".repeat(20), 22)).toBe(2);
    expect(foldsOf("a".repeat(40), 22)).toBe(1);
    expect(foldsOf("abcd", 4)).toBe(0);
  });

  test("按显示宽度截断：中文算两格，留一格不碰行尾", () => {
    expect(fitWidth("✻ 思考中… 12s", 10)).toBe("✻ 思考中…");
    expect(fitWidth("abc", 80)).toBe("abc");
  });

  test("内容写在状态行上面；计时只在变了的那秒重画；回合结束回到空闲", () => {
    const { st, s, view } = screen();
    s.show("> owner：查一下", at);
    expect(view()).toBe("[12:00:00] > owner：查一下\n· 空闲");
    st.state = { busy: true, queued: 0, permissions: 0 };
    s.tick();
    st.now = 400;
    const before = st.out.length;
    s.tick();
    expect(st.out.length).toBe(before); // 同一秒内不重画
    st.now = 3_200;
    s.tick();
    expect(view()).toEndWith("\n✻ 思考中… 3s（Esc 打断）");
    s.show("● Bash(ls)", at);
    st.state = { ...IDLE, queued: 0 };
    s.tick();
    expect(view()).toBe("[12:00:00] > owner：查一下\n           ● Bash(ls)\n· 空闲");
    s.close();
    expect(view()).toEndWith("● Bash(ls)\n");
  });

  test("变窄：终端把放不下的旧状态行折成几行，光标在最后一折上——每折都擦掉，再画截短的新状态", () => {
    const { st, s } = screen(40);
    st.state = { busy: true, queued: 3, permissions: 0 };
    s.tick();
    const old = statusText(st.state, 0);
    st.cols = 12;
    const mark = st.out.length;
    s.resize();
    const folds = foldsOf(old, 12);
    expect(folds).toBeGreaterThan(1);
    expect(st.out.slice(mark)).toBe(`\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(folds)}${dim(fitWidth(old, 12))}`);
    expect(Bun.stringWidth(fitWidth(old, 12))).toBeLessThan(12);
  });

  test("流式续写：同一条消息就地续在下面，终稿不重复；整屏对照", () => {
    const { s, view } = screen();
    const t = createAcpTranslator(() => "T");
    const updates = [
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "先看两处：\n1. 放锁" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "条件\n2. 续" } },
      { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "约" } },
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: "git diff --stat", status: "in_progress" },
    ];
    for (const u of updates) {
      t.push(u).flatMap(transcriptOfEntry).forEach((i) => s.show(i, at));
      s.update(u, at);
    }
    expect(view()).toBe("[12:00:00] ● 先看两处：\n             1. 放锁条件\n             2. 续约\n           ● Bash(git diff --stat)\n· 空闲");
  });

  test("非 TTY（测试、日志）退回纯文本：一个控制序列都没有", () => {
    expect(renderFixtures()).not.toContain("\x1b");
  });
});
