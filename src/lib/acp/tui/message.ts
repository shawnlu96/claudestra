/**
 * 助手正文怎么落到屏上（screen.ts 用）：一条消息一个 Markdown 实例，左边留两格，首行是 ●（reply 绿色）。
 * 输入是正文段的行（transcript.ts 的 ● 段、transcript-stream.ts 流式吐出的整行）：「● 」起头的是新消息，其余是续行（去掉两格缩进）。
 * tests/acp-tui-screen.test.ts。
 */
import { createMarkdown, type MarkdownView } from "./markdown.js";
import { sgr } from "./text.js";

export function createMessageWriter(cols: () => number, gap: () => string[]) {
  let msg: { md: MarkdownView; rows: number; reply: boolean } | null = null;
  const rowsOf = (rows: string[]): string[] => rows.map((r) => {
    const lead = msg!.rows++ ? "  " : sgr(msg!.reply ? "1;32" : "1", "● ");
    return r ? lead + r : r;
  });
  const end = (): string[] => {
    if (!msg) return [];
    const out = rowsOf(msg.md.end(cols() - 2));
    msg = null;
    return out;
  };
  const start = (first: string): string[] => {
    const out = end();
    msg = { md: createMarkdown(), rows: 0, reply: first.startsWith("回复：") };
    return [...out, ...gap(), ...rowsOf(msg.md.feed(first, cols() - 2))];
  };
  const feed = (raw: string): string[] => (msg ? rowsOf(msg.md.feed(raw, cols() - 2)) : start(raw));
  return {
    open: (): boolean => msg !== null,
    lines: (lines: readonly string[]): string[] =>
      lines.flatMap((l) => (l.startsWith("● ") ? start(l.slice(2)) : feed(l.startsWith("  ") ? l.slice(2) : l))),
    end,
    /** 还压着的表格预览（底栏用） */
    pending: (): string[] => (msg ? msg.md.pending(cols() - 2).map((r) => (r ? `  ${r}` : r)) : []),
  };
}
