/**
 * ACP 终端视图的排字底座：带样式的文字片段（Span）→ 按显示宽度折好的终端行。别的 tui/ 模块只产出 Span，不自己拼控制序列。
 * 宽度一律按字素簇量（中日韩两格，组合 emoji 不拆），每行最多 cols - 1 格（留一格免得光标停在行尾的待折状态，\r 回不到行首）。
 * 颜色（SGR）每段自带复位，擦行重画、截断都不会把颜色漏到下一行。tests/acp-tui-text.test.ts。
 */

/** 一段同样式的文字；s 是 SGR 参数（"1" 粗、"2" 暗、"36" 青……），空 = 默认 */
export interface Span {
  t: string;
  s?: string;
}

/** 一个逻辑行：lead 只在第一折前面，cont 在折下来的各行前面（悬挂缩进 / 引用竖线） */
export interface Para {
  lead?: Span[];
  cont?: Span[];
  body: Span[];
}

interface Cell {
  ch: string;
  w: number;
  s: string;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const sgr = (s: string | undefined, t: string): string => (s && t ? `\x1b[${s}m${t}\x1b[0m` : t);
export const span = (t: string, s?: string): Span => (s ? { t, s } : { t });
/** 两层样式叠在一起（外层 + 内层） */
export const merge = (a?: string, b?: string): string | undefined => [a, b].filter(Boolean).join(";") || undefined;

function cellsOf(spans: readonly Span[]): Cell[] {
  const out: Cell[] = [];
  for (const sp of spans) {
    for (const { segment } of GRAPHEMES.segment(sp.t.replace(/\t/g, "  "))) {
      if (segment === "\n" || segment === "\r") continue;
      out.push({ ch: segment, w: Bun.stringWidth(segment), s: sp.s ?? "" });
    }
  }
  return out;
}

export const widthOf = (spans: readonly Span[]): number => cellsOf(spans).reduce((n, c) => n + c.w, 0);

/** 一串格子 → 带颜色的字串（相邻同样式合成一段） */
function serialize(cells: readonly Cell[]): string {
  let out = "", cur = "", style = "";
  for (const c of cells) {
    if (c.s !== style) {
      out += sgr(style, cur);
      [cur, style] = ["", c.s];
    }
    cur += c.ch;
  }
  return (out + sgr(style, cur)).trimEnd();
}

const CLOSING = /^[）」』】〉》。，、；：！？)\]}]$/u;

/** 按宽度切：优先断在空格处（英文单词不拆），一行里没有空格就硬切；断点处的空格不要。断点两边有宽字（中日韩）时就地断：
 * 中文本来就能在任意字间断，退回空格会把整段中文挤到下一行、上一行只剩个前缀（「✻」「abc」）。tests/acp-tui-text.test.ts */
function breakCells(cells: Cell[], first: number, rest: number): Cell[][] {
  const rows: Cell[][] = [];
  let i = 0, limit = first;
  while (i < cells.length) {
    let w = 0, j = i, space = -1;
    while (j < cells.length && w + cells[j]!.w <= limit) {
      if (cells[j]!.ch === " ") space = j;
      w += cells[j]!.w;
      j++;
    }
    if (j < cells.length && space > i && cells[j]!.ch !== " " && cells[j]!.w < 2 && cells[j - 1]!.w < 2) j = space;
    else if (j < cells.length && j - 1 > i && CLOSING.test(cells[j]!.ch) && cells[j - 1]!.ch !== " ") j--; // 闭合标点不单独落到行首
    if (j === i) j = i + 1; // 一个字比整行还宽（极窄窗口）：至少放一个，免得死循环
    rows.push(cells.slice(i, j));
    i = j;
    while (i < cells.length && cells[i]!.ch === " " && rows.length) i++;
    limit = rest;
  }
  return rows.length ? rows : [[]];
}

/** 一个逻辑行 → 终端里的若干行（每行宽度 ≤ cols - 1） */
export function renderPara(p: Para, cols: number): string[] {
  const max = Math.max(1, cols - 1);
  const lead = cellsOf(p.lead ?? []), cont = cellsOf(p.cont ?? p.lead?.map((x) => ({ t: " ".repeat(Bun.stringWidth(x.t)) })) ?? []);
  const lw = lead.reduce((n, c) => n + c.w, 0), cw = cont.reduce((n, c) => n + c.w, 0);
  const rows = breakCells(cellsOf(p.body), Math.max(1, max - lw), Math.max(1, max - cw));
  return rows.map((r, i) => serialize([...(i ? cont : lead), ...r]));
}

/** 只要一行：放不下就截断（底栏用；不折行，免得底栏高度跟着内容跳） */
export function fitLine(spans: readonly Span[], cols: number): string {
  const max = Math.max(1, cols - 1), out: Cell[] = [];
  let w = 0;
  for (const c of cellsOf(spans)) {
    if (w + c.w > max) break;
    out.push(c);
    w += c.w;
  }
  return serialize(out);
}

/** 去掉 SGR 颜色：量宽度、算折行用 */
export const stripSgr = (s: string): string => s.replace(/\x1b\[[\d;]*m/g, "");
