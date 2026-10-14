/**
 * 助手正文的 Markdown → 终端行，逐行喂（流式时一行一行到，终稿只补剩下的行）：标题、列表、引用、粗体 / 斜体 / 行内代码 / 链接、
 * 带围栏的代码块（上下框 + 左竖线）、分隔线、表格。只有表格要等整张到齐才排得齐：表格行先压着（pending 给底栏预览），
 * 遇到非表格行或消息结束再出；放不下就改成逐行「表头：值」的竖排。输入是已脱敏、已截断的正文（transcript.ts / transcript-stream.ts），
 * 这里不再截，只排版。纯函数式状态，一条消息一个实例。tests/acp-tui-markdown.test.ts。
 */
import { merge, renderPara, span, widthOf, type Para, type Span } from "./text.js";

const INLINE = new RegExp([
  /(`+)([^`]+?)\1/, // 行内代码
  /\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/, // 粗体
  /(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w])/, // 斜体（snake_case、乘号不算）
  /\[([^\]\n]+)\]\(([^)\s]+)\)/, // 链接
].map((r) => r.source).join("|"), "g");
const STYLE = { code: "36", bold: "1", italic: "3", link: "4;34", url: "2", h1: "1;4", h2: "1", rule: "2", quote: "2", bullet: "33", fence: "2", table: "2" } as const;

/** 行内标记 → Span；base 是外层样式（标题、引用里的字跟着它） */
export function inline(text: string, base?: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > at) out.push(span(text.slice(at, m.index), base));
    if (m[2] !== undefined) out.push(span(m[2], merge(base, STYLE.code)));
    else if (m[3] ?? m[4]) out.push(...inline((m[3] ?? m[4])!, merge(base, STYLE.bold)));
    else if (m[5] ?? m[6]) out.push(...inline((m[5] ?? m[6])!, merge(base, STYLE.italic)));
    else out.push(span(m[7]!, merge(base, STYLE.link)), span(` (${m[8]})`, merge(base, STYLE.url)));
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(span(text.slice(at), base));
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

function itemPara(m: RegExpExecArray): Para {
  const depth = Math.min(4, Math.floor(m[1]!.replace(/\t/g, "  ").length / 2));
  const mark = /\d/.test(m[2]!) ? `${m[2]} ` : depth % 2 ? "◦ " : "• ";
  const pad = "  ".repeat(depth);
  return { lead: [span(pad), span(mark, STYLE.bullet)], cont: [span(pad + " ".repeat(Bun.stringWidth(mark)))], body: inline(m[3]!) };
}

/** 普通的一行（不在代码块、不是表格）→ 一个逻辑行 */
function linePara(raw: string, cols: number): Para {
  const h = HEADING.exec(raw);
  if (h) return { body: inline(h[2]!, h[1]!.length === 1 ? STYLE.h1 : STYLE.h2) };
  if (RULE.test(raw)) return { body: [span("─".repeat(Math.max(3, Math.min(cols - 1, 40))), STYLE.rule)] };
  const q = QUOTE.exec(raw);
  if (q) return { lead: [span("│ ", STYLE.quote)], cont: [span("│ ", STYLE.quote)], body: inline(q[1]!, STYLE.italic) };
  const it = ITEM.exec(raw);
  if (it) return itemPara(it);
  const indent = /^\s*/.exec(raw)![0];
  return { lead: [span(indent)], body: inline(raw.slice(indent.length)) };
}

const cellsOf = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

/** 表格：放得下就按列对齐（列间 │，表头下一道线），放不下改成每行一组「表头：值」 */
export function renderTable(rows: readonly string[], cols: number): string[] {
  const head = rows.length > 1 && TABLE_SEP.test(rows[1]!) ? cellsOf(rows[0]!) : null;
  const body = rows.filter((r, i) => !(head && i <= 1) && !TABLE_SEP.test(r)).map(cellsOf);
  const all = [...(head ? [head] : []), ...body].map((r) => r.map((c) => inline(c)));
  const n = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(1, ...all.map((r) => widthOf(r[i] ?? []))));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
  if (total <= cols - 1) {
    const line = (r: Span[][], s?: string): string =>
      renderPara({ body: r.flatMap((c, i) => [...(i ? [span(" │ ", STYLE.table)] : []), ...c.map((x) => ({ ...x, s: merge(s, x.s) })),
        span(" ".repeat(widths[i]! - widthOf(c)))]) }, cols)[0]!;
    const sep = renderPara({ body: [span(widths.map((w) => "─".repeat(w)).join("─┼─"), STYLE.table)] }, cols);
    return [...(head ? [line(all[0]!, "1"), ...sep] : []), ...all.slice(head ? 1 : 0).map((r) => line(r))];
  }
  const names = head ?? [];
  return body.flatMap((r) => r.flatMap((c, i) => renderPara(i === 0
    ? { lead: [span("• ", STYLE.bullet)], body: inline(c, "1") }
    : { lead: [span(`  ${names[i] ? `${names[i]}：` : ""}`, STYLE.table)], cont: [span("    ")], body: inline(c) }, cols)));
}

export interface MarkdownView {
  /** 一行原文 → 现在就能出的终端行（表格行先压着） */
  feed(raw: string, cols: number): string[];
  /** 消息结束：吐出压着的表格、补上没合上的代码框 */
  end(cols: number): string[];
  /** 还压着的表格的预览（底栏用，不进滚动记录） */
  pending(cols: number): string[];
}

export function createMarkdown(): MarkdownView {
  let fence: { mark: string } | null = null, table: string[] = [];
  const flushTable = (cols: number): string[] => {
    const rows = table;
    table = [];
    return rows.length ? renderTable(rows, cols) : [];
  };
  const bar = (raw: string, cols: number): string[] => renderPara({ lead: [span("│ ", STYLE.fence)], cont: [span("│ ", STYLE.fence)], body: [span(raw, STYLE.code)] }, cols);
  return {
    feed(raw, cols) {
      if (fence) {
        const close = FENCE.exec(raw);
        if (close && close[1]![0] === fence.mark[0] && close[1]!.length >= fence.mark.length && !close[2]) {
          fence = null;
          return [renderPara({ body: [span("╰─", STYLE.fence)] }, cols)[0]!];
        }
        return bar(raw, cols);
      }
      if (TABLE_ROW.test(raw) || (table.length === 1 && TABLE_SEP.test(raw))) return (table.push(raw), []);
      const out = flushTable(cols);
      const open = FENCE.exec(raw);
      if (open) {
        fence = { mark: open[1]! };
        return [...out, ...renderPara({ body: [span(`╭─${open[2] ? ` ${open[2]}` : ""}`, STYLE.fence)] }, cols)];
      }
      return [...out, ...(raw.trim() ? renderPara(linePara(raw, cols), cols) : [""])];
    },
    end(cols) {
      const out = flushTable(cols);
      if (fence) (fence = null), out.push(renderPara({ body: [span("╰─", STYLE.fence)] }, cols)[0]!);
      return out;
    },
    pending: (cols) => (table.length ? renderTable(table, cols) : []),
  };
}
