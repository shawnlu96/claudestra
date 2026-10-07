import { describe, expect, test } from "bun:test";
import { createTextStream } from "../src/lib/acp/transcript-stream.ts";
import { transcriptOfEntry } from "../src/lib/acp/transcript.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";

// TTY 窗口的正文流式续写：只吐整行；终稿到了只补没显示的部分；拼起来必须和非 TTY 的整段显示一字不差
const chunk = (messageId: string, text: string) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
const SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

/** 按宿主的顺序喂：先显示翻译器吐出的条目（上一条的终稿），再给这条 update 续流；返回窗口里出现的段 */
function feed(updates: unknown[]): string[] {
  const t = createAcpTranslator(() => "T"), s = createTextStream(), out: string[] = [];
  const show = (entries: Record<string, unknown>[]) => entries.flatMap(transcriptOfEntry).forEach((i) => out.push(...s.settle(i)));
  for (const u of updates) {
    show(t.push(u));
    out.push(...s.chunk(u));
  }
  show(t.flush());
  return out;
}
const whole = (updates: unknown[]): string[] => {
  const t = createAcpTranslator(() => "T");
  return [...updates.flatMap((u) => t.push(u)), ...t.flush()].flatMap(transcriptOfEntry);
};
const pieces = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

describe("ACP 正文流式续写", () => {
  test("整行一到就显示，同一条消息续在下面；终稿只补最后半行", () => {
    const out = feed([chunk("m1", "第一行\n第"), chunk("m1", "二行\n\n第三"), chunk("m1", "行没完")]);
    expect(out).toEqual(["● 第一行", "  第二行", "\n  第三行没完"]); // 行尾的空行先压着，后面有字了才跟着出来（终稿会剪掉结尾空行）
    expect(out.join("\n")).toBe(whole([chunk("m1", "第一行\n第二行\n\n第三行没完")]).join("\n"));
  });

  test("一行的消息流不出东西，终稿整段出现；换消息、出工具调用各自成段", () => {
    const out = feed([
      chunk("m1", "看一下"), chunk("m1", "。"),
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: "ls", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      chunk("m2", "好了\n收"), chunk("m3", "下一条"),
    ]);
    expect(out).toEqual(["● 看一下。", "● Bash(ls)", "  ⎿ 无输出", "● 好了", "  收", "● 下一条"]);
  });

  test("任意切法拼起来都和整段显示一样（含行尾空行、超长截断；截断注记在流式时另起一行）", () => {
    const same = (lines: string[]) => lines.join("\n").replace(/\n {2}(…（共 \d+ 行）)$/, "$1");
    const texts = [
      Array.from({ length: 300 }, (_, i) => `第 ${i} 行`).join("\n"),
      "  开头有空白\n\n中间空行\n结尾换行\n\n",
      `${"长".repeat(5_990)}\n超出 6000 字的这一行只在终稿里出现\n后面`,
    ];
    for (const text of texts) for (const size of [1, 3, 7, 64, 5_000]) {
      const updates = pieces(text, size).map((p) => chunk("m", p));
      expect(same(feed(updates))).toBe(whole(updates).join("\n"));
    }
  });

  test("密钥被切在任何位置都不出现在流出的行里", () => {
    const text = `配置如下\napi_key=${SECRET}\nAuthorization: Bearer ${SECRET}\n完`;
    for (const size of [1, 2, 5, 11]) {
      const out = feed(pieces(text, size).map((p) => chunk("m", p))).join("\n");
      expect(out).not.toContain("sk-abc");
      expect(out).toContain("api_key=[redacted]");
    }
  });

  test("流着时插进来的别的段照常显示；终稿对不上（不是这条的前缀）就整段重显示", () => {
    const s = createTextStream();
    expect(s.chunk(chunk("m", "a\nb\n"))).toEqual(["● a", "  b"]);
    expect(s.settle("> owner：插话")).toEqual(["> owner：插话"]);
    expect(s.settle("● x\n  y")).toEqual(["● x\n  y"]);
    expect(s.settle("● 下一段")).toEqual(["● 下一段"]); // 流已关：原样
    expect(s.chunk({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "x\n" } })).toEqual([]);
  });
});
