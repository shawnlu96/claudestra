/**
 * ACP 窗口是 TTY 时一段会话怎么排、怎么上色（tty-screen.ts 用；非 TTY 不走这里，照旧 transcript.ts 的纯文本，测试快照和日志靠那个）。
 * 宽屏（≥ NARROW_COLS 列）去掉颜色后和纯文本逐字一样；窄屏（手机网页终端约 52 列）不留 11 格时间列：段落起点（正文 / 收到的消息）
 * 上面单起一行暗色时间，其余行不带；工具行顶格、结果行缩一格；自己按宽度折行并悬挂缩进到正文开头（交给终端折会顶回第 0 列）。
 * 颜色最后才加：打码、截断、折行都按纯文本算，每行自带复位，擦行重画不受影响。tests/acp-tty-layout.test.ts。
 */
import { createStampParts, STAMP_PAD } from "./transcript.js";

const NARROW_COLS = 80;

type Kind = "inbound" | "tool" | "text" | "result" | "error" | "fail" | "dim" | "plain";

const sgr = (code: string, s: string): string => (s ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string): string => sgr("2", s);

/** 条目种类看段首：transcript.ts 各 transcriptOf* 的前缀 */
function kindOf(item: string): Kind {
  if (item.startsWith("> ")) return "inbound";
  if (/^● (?:[\w/.:-]+\(|计划(?:\n|$))/u.test(item)) return "tool";
  if (item.startsWith("● ")) return "text";
  if (item.startsWith("  ⎿ ✗")) return "error";
  if (item.startsWith("  ⎿ ")) return "result";
  if (/^(?:⛔|🔑|❌|── 回合失败)/u.test(item)) return "fail";
  if (/^(?:── |✻ )/u.test(item)) return "dim";
  return "plain";
}

/** 照 CC CLI：工具 ● 绿、工具名加粗；正文 ● 加粗；收到的消息青色（来源加粗）；结果、分隔、思考暗色；失败红。续行只带底色 */
function paint(kind: Kind, line: string, first: boolean): string {
  switch (kind) {
    case "tool": {
      const m = first ? /^● ([^(\n]+)/u.exec(line) : null;
      return m ? `${sgr("32", "●")} ${sgr("1", m[1]!)}${line.slice(m[0].length)}` : line;
    }
    case "text":
      return first && line.startsWith("● ") ? `${sgr("1", "●")}${line.slice(1)}` : line;
    case "inbound": {
      const cut = first ? line.indexOf("：") + 1 : 0;
      return `${sgr("1;36", line.slice(0, cut))}${sgr("36", line.slice(cut))}`;
    }
    case "result":
    case "dim":
      return sgr("2", line);
    case "error":
    case "fail":
      return sgr("31", line);
    default:
      return line;
  }
}

/** 窄屏把结果段整体左移一格（⎿ 在第 1 列、正文第 3 列）、计划步骤缩一格：续行都不超过 3 格 */
function narrowIndent(kind: Kind, lines: string[]): string[] {
  if (kind === "result" || kind === "error") return lines.map((l, i) => (i ? l.replace(/^ {4}/, "   ") : l.slice(1)));
  if (kind === "tool") return lines.map((l, i) => (i ? l.replace(/^ {2}/, " ") : l));
  return lines;
}

/** 悬挂缩进到这么宽：行首空白加一个前缀符号（● ⎿ > ✓ 等） */
const LEAD = /^ *(?:[●⎿>✻✓▸·✗⛔🔑❌] )?/u;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 按显示宽度折成几行（中文两格；留一格，和状态行 fitWidth 一样不碰行尾），折下来的行缩进到正文开头，断点处的空格不要 */
export function hangWrap(line: string, cols: number): string[] {
  const limit = Math.max(1, cols - 1);
  if (Bun.stringWidth(line) <= limit) return [line];
  const hang = " ".repeat(Math.min(Bun.stringWidth(LEAD.exec(line)![0]), Math.floor(limit / 2)));
  const out: string[] = [];
  let cur = "", w = 0;
  for (const { segment: ch } of GRAPHEMES.segment(line)) { // 按字素簇：组合 emoji（👩‍💻）不拆开，带变体选择符的（❤️）按整簇量宽
    const cw = Bun.stringWidth(ch);
    if (w + cw > limit && cur.trim()) {
      out.push(cur.trimEnd());
      [cur, w] = [hang, hang.length];
      if (ch === " ") continue;
    }
    cur += ch;
    w += cw;
  }
  return [...out, cur];
}

/** 一个窗口一个实例（时间列记着上一行的分钟）；cols 每段现取，窗口变宽变窄后下一段就换排法 */
export function createTtyLayout(): (item: string, cols: number, at?: Date) => string {
  const stamp = createStampParts();
  return (item, cols, at) => {
    const kind = kindOf(item), p = stamp(item, at);
    if (cols >= NARROW_COLS) {
      const head = p.head.trim() ? dim(p.head) : p.head;
      return `${p.gap ? "\n" : ""}${head}${p.lines.map((l, i) => paint(kind, l, !i)).join(`\n${STAMP_PAD}`)}`;
    }
    const lines = narrowIndent(kind, p.lines).flatMap((l, i) => hangWrap(l, cols).map((w, j) => paint(kind, w, !i && !j)));
    return [...(p.gap ? [""] : []), ...(p.para ? [dim(p.time)] : []), ...lines].join("\n");
  };
}
