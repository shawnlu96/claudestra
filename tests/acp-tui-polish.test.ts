import { describe, expect, test } from "bun:test";
import { createPiEventMapper } from "../src/lib/acp/pi-adapter/map.ts";
import { createTuiScreen } from "../src/lib/acp/tui/screen.ts";
import { transcriptOfEntry, transcriptOfStop } from "../src/lib/acp/transcript.ts";
import type { TurnState } from "../src/lib/acp/tty-status.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { termText } from "./helpers/acp-tty-term.ts";

// ATUI-2：实际用下来的毛病——思考的位置和截断、块之间的空行、回合分隔线的长度

const IDLE: TurnState = { busy: false, queued: 0, permissions: 0 };
const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv";

/** 照宿主的顺序喂：更新先过翻译器、条目经 transcript 成段 show，再把原始更新交 update（host.ts onUpdate） */
function rig(cols = 60) {
  let out = "";
  const s = createTuiScreen({ write: (x) => void (out += x), columns: () => cols, rows: () => 60 }, () => IDLE, () => 0, () => ({ text: "", permission: null }));
  const t = createAcpTranslator(() => "T", { from: "claudestra-meta" });
  const feed = (u: Record<string, unknown>) => {
    for (const e of t.push(u)) for (const i of transcriptOfEntry(e)) s.show(i);
    s.update(u);
  };
  const end = () => {
    for (const e of t.flush()) for (const i of transcriptOfEntry(e)) s.show(i);
    s.show(transcriptOfStop({ event: "Stop", stopHookActive: false }));
  };
  return { s, feed, end, view: () => termText(out).split("\n") };
}
const display = (text: string) => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text }, _meta: { claudestra: { display: true } } });
const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text } });

describe("思考块", () => {
  test("Pi 端到端：provider 流结束才发 thinking_end，思考仍画在回复前面", () => {
    const r = rig();
    const pi = createPiEventMapper();
    const partial = { content: [{ type: "thinking", thinking: "先看 diff。\n再看测试。" }, { type: "text", text: "" }] };
    const evs = [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先看 diff。\n再看测试。" }, message: partial },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "结论：没问题。\n" }, message: partial },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "先看 diff。\n再看测试。" }, message: partial },
      { type: "message_end", message: { role: "assistant", content: partial.content, stopReason: "stop" } },
    ];
    for (const ev of evs) for (const u of pi.push(ev)) r.feed(u);
    r.end();
    const v = r.view();
    const think = v.indexOf("✻ 先看 diff。"), answer = v.indexOf("● 结论：没问题。");
    expect(think).toBeGreaterThanOrEqual(0);
    expect(v[think + 1]).toBe("  再看测试。"); // 多行思考按行显示，续行对齐在 ✻ 后面
    expect(answer).toBeGreaterThan(think);
    expect(v.filter((l) => l.includes("先看 diff"))).toHaveLength(1); // 底栏不再预览一遍
  });

  test("只有一行：完整显示、按宽度折行，不出省略号", () => {
    const r = rig(52);
    const line = "这是一行比较长的思考，".repeat(9);
    r.feed(display(line));
    r.end();
    const text = r.view().join("\n");
    expect(text).not.toContain("…（共");
    expect(text.replace(/\n {2}/g, "")).toContain(`✻ ${line}`);
  });

  test("超过上限才折叠，并写清原本多少：多行写「共 N 行」，一行写「共 N 字」", () => {
    const many = rig();
    many.feed(display(Array.from({ length: 10 }, (_, i) => `第 ${i} 步`).join("\n")));
    many.end();
    expect(many.view()).toContain("  第 3 步…（共 10 行）");
    const wide = rig(200);
    wide.feed(display("想".repeat(300)));
    wide.end();
    expect(wide.view().join("\n")).toContain("…（共 300 字）");
  });

  test("先打码再截断：思考原文里的密钥不出现", () => {
    const r = rig();
    r.feed(display(`password=\n${SECRET}\n下一步`));
    r.end();
    expect(r.view().join("\n")).not.toContain(SECRET);
  });

  test("没有原文跟着的思考段（进度提示、回放）照段画", () => {
    const r = rig();
    r.s.show("✻ 正在自动压缩上下文…");
    r.s.update({ sessionUpdate: "session_info_update" });
    expect(r.view()).toContain("✻ 正在自动压缩上下文…");
  });
});

describe("留白", () => {
  test("正文、工具组、思考之间各空一行；工具组内不空", () => {
    const r = rig();
    r.feed(chunk("先看看。\n"));
    r.feed({ sessionUpdate: "tool_call", toolCallId: "a", kind: "execute", title: "ls", status: "in_progress" });
    r.feed({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
    r.feed(display("再想想"));
    r.feed({ sessionUpdate: "tool_call", toolCallId: "b", kind: "read", title: "a.ts", status: "in_progress" });
    r.feed({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed" });
    r.end();
    const v = r.view();
    const at = (p: string) => v.findIndex((l) => l.startsWith(p));
    for (const p of ["✓ Bash(ls)", "✻ 再想想", "✓ Read(a.ts)", "── 回合结束"]) expect({ p, before: v[at(p) - 1] }).toEqual({ p, before: "" });
    expect(v[at("✓ Bash(ls)") + 1]).toStartWith("  ⎿ ");
  });

  test("回合分隔线满宽（和输入框的线一样长），后面空一行再接输入框", () => {
    for (const cols of [52, 120]) {
      const r = rig(cols);
      r.feed(chunk("好了。\n"));
      r.end();
      const v = r.view();
      const i = v.findIndex((l) => l.startsWith("── 回合结束"));
      expect(Bun.stringWidth(v[i]!)).toBe(cols - 1);
      expect(v[i + 1]).toBe("");
      expect(v[i + 2]).toBe("─".repeat(cols - 1));
    }
  });
});
