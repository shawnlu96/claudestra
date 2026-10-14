/**
 * 宿主交给窗口的一段（transcript.ts 的产物：已脱敏、已按上限截好）→ 认出是哪种元素，按元素画成终端行。
 * 只认段的格式（ACP 标准事件经 updates.ts 翻译后的统一形状），不认 harness：同一段不管从哪个适配器来，画出来逐字一样。
 * 正文段走 markdown.ts（screen.ts 里流式喂），工具调用在跑时进底栏（live.ts），这里只画落进滚动记录的定稿样子。tests/acp-tui-blocks.test.ts。
 */
import { renderPara, span, type Span } from "./text.js";

export type ItemKind = "message" | "tool" | "plan" | "result" | "inbound" | "thinking" | "permission" | "failure" | "stop" | "notice" | "plain";

const TOOL = /^● ([^\s(][^(\n]*)\((.*)\)$/su;

/** 段首认种类：格式见 transcript.ts 各 transcriptOf* / tty-input.ts permissionLines */
export function kindOf(item: string): ItemKind {
  if (item.startsWith("● 计划\n") || item === "● 计划") return "plan";
  if (/^● [\w/.:-]+\(/u.test(item) && TOOL.test(item) && !item.includes("\n")) return "tool";
  if (item.startsWith("● ")) return "message";
  if (item.startsWith("  ⎿ ")) return "result";
  if (item.startsWith("> ")) return "inbound";
  if (item.startsWith("✻ ")) return "thinking";
  if (item.startsWith("⏸ ")) return "permission";
  if (/^(?:⛔|🔑|❌)/u.test(item)) return "failure";
  if (/^── .+ ──$/u.test(item)) return "stop";
  if (item.startsWith("⏹ ")) return "notice";
  return "plain";
}

/** 工具段 → 名字和一句话摘要 */
export function toolOf(item: string): { name: string; arg: string } {
  const m = TOOL.exec(item);
  return m ? { name: m[1]!, arg: m[2]! } : { name: item.replace(/^● /, ""), arg: "" };
}

/** ACP 标准 ToolKind（schema 里的枚举）→ 给人看的类型 */
const KIND: Record<string, string> = {
  read: "读取", edit: "编辑", delete: "删除", move: "移动", search: "搜索", execute: "执行", think: "思考", fetch: "抓取", switch_mode: "切换模式", other: "其他",
};
const kindLabel = (kind: string | undefined): string => (kind ? KIND[kind] ?? "" : "");

export type ToolStatus = "running" | "ok" | "fail" | "lost";
const MARK: Record<ToolStatus, [string, string]> = { running: ["◐", "33"], ok: ["✓", "32"], fail: ["✗", "31"], lost: ["◌", "2"] };
const SPIN = ["◐", "◓", "◑", "◒"];

/** 工具头一行（不折，底栏和滚动记录同一个样子）：状态符号 + 名字(摘要) + 类型 + 进行中的计时 */
export function toolSpans(t: { name: string; arg: string; kind?: string; status: ToolStatus }, extra = "", tick = 0): Span[] {
  const [mark, color] = MARK[t.status];
  const label = kindLabel(t.kind);
  return [
    span(t.status === "running" ? SPIN[tick % SPIN.length]! : mark, color), span(" "), span(t.name, "1"),
    span(`(${t.arg})`), ...(label || extra ? [span(` · ${[label, extra].filter(Boolean).join(" · ")}`, "2")] : []),
  ];
}

export function toolRows(t: { name: string; arg: string; kind?: string; status: ToolStatus }, cols: number): string[] {
  const [head, ...rest] = toolSpans(t, t.status === "lost" ? "未完成" : "");
  return renderPara({ lead: [head!, rest[0]!], cont: [span("  ")], body: rest.slice(1) }, cols);
}

/** 结果段：「  ⎿ 」后面是摘要；失败的（✗）红色、留末尾几行；续行在 transcript.ts 里缩了 4 格 */
function resultRows(item: string, cols: number): string[] {
  const fail = item.startsWith("  ⎿ ✗");
  const lines = item.slice(4).replace(/^✗ /, "").split("\n").map((l, i) => (i ? l.replace(/^ {4}/, "") : l));
  const style = fail ? "31" : "2";
  return lines.flatMap((l, i) => renderPara({ lead: [span(i ? "    " : fail ? "  ⎿ ✗ " : "  ⎿ ", style)], cont: [span("    ")], body: [span(l, style)] }, cols));
}

const PLAN: Record<string, [string, string, string?]> = { "✓": ["✓", "32", "2"], "▸": ["▸", "33", "1"], "·": ["○", "2"] };

function planRows(item: string, cols: number): string[] {
  const steps = item.split("\n").slice(1);
  return [
    ...renderPara({ lead: [span("● ", "34")], body: [span("计划", "1"), span(` · ${steps.filter((s) => s.trim().startsWith("✓")).length}/${steps.length}`, "2")] }, cols),
    ...steps.flatMap((s) => {
      const m = /^\s*(✓|▸|·) (.*)$/u.exec(s);
      const [mark, color, text] = PLAN[m?.[1] ?? "·"]!;
      return renderPara({ lead: [span("  "), span(`${mark} `, color)], body: [span(m?.[2] ?? s.trim(), text)] }, cols);
    }),
  ];
}

const hhmm = (at: Date): string => at.toTimeString().slice(0, 5);

/** 收到的消息：青色竖线，首行是来源（加粗）和时间，正文跟在下面（不按 Markdown 解释：是人写的原话） */
function inboundRows(item: string, cols: number, at: Date): string[] {
  const cut = item.indexOf("：");
  const who = cut > 2 ? item.slice(2, cut) : "?";
  const body = (cut > 2 ? item.slice(cut + 1) : item.slice(2)).split("\n").map((l, i) => (i ? l.replace(/^ {2}/, "") : l));
  const bar = [span("┃ ", "36")];
  return [
    ...renderPara({ lead: bar, cont: bar, body: [span(who, "1;36"), span(` · ${hhmm(at)}`, "2")] }, cols),
    ...body.flatMap((l) => renderPara({ lead: bar, cont: bar, body: [span(l)] }, cols)),
  ];
}

/** 审批块：黄色框，选项一行一个，键位提示原文照搬（和输入行的作答规则是同一套，tty-input.ts） */
function permissionRows(item: string, cols: number): string[] {
  const lines = item.split("\n");
  const last = lines.length > 1 && /^\s*\[\d+\]/.test(lines.at(-1)!) ? lines.pop()! : "";
  const opts = [...last.matchAll(/\[(\d+)\] (.+?)(?=\s{2}\[\d+\]|（|$)/gu)].map((m) => `[${m[1]}] ${m[2]!.trim()}`);
  const hint = /（([^（]*)）\s*$/u.exec(last)?.[1];
  const bar = [span("│ ", "33")];
  return [
    ...renderPara({ body: [span("╭─ ", "33"), span("⏸ 需要审批", "1;33")] }, cols),
    ...renderPara({ lead: bar, cont: bar, body: [span(lines[0]!.replace(/^⏸ /, ""), "1")] }, cols),
    ...lines.slice(1).flatMap((l) => renderPara({ lead: bar, cont: bar, body: [span(l.trim())] }, cols)),
    ...opts.flatMap((o) => renderPara({ lead: bar, cont: bar, body: [span(o, "33")] }, cols)),
    ...(hint ? renderPara({ lead: bar, cont: bar, body: [span(hint, "2")] }, cols) : []),
    ...renderPara({ body: [span("╰─", "33")] }, cols),
  ];
}

/** 回合分隔：一道暗线，中间是结局和时间；打断黄、失败红 */
function stopRows(item: string, cols: number, at: Date): string[] {
  const label = item.replace(/^── | ──$/g, "");
  const color = /打断|中断/u.test(label) ? "33" : /失败/u.test(label) ? "31" : "2";
  const head = `── ${label} · ${at.toTimeString().slice(0, 8)} `;
  const fill = Math.max(2, Math.min(cols - 1, 48) - Bun.stringWidth(head));
  return renderPara({ body: [span(head, color), span("─".repeat(fill), "2")] }, cols);
}

/** 其余一行行照原样折：保留行首缩进当悬挂缩进 */
function plainRows(item: string, cols: number, style?: string): string[] {
  return item.split("\n").flatMap((l) => {
    const pad = /^\s*/.exec(l)![0];
    return renderPara({ lead: [span(pad)], cont: [span(pad || "  ")], body: [span(l.slice(pad.length), style)] }, cols);
  });
}

/** 定稿段（除了正文和工具：正文流式走 markdown，工具在 screen.ts 里配状态）→ 终端行 */
export function itemRows(kind: ItemKind, item: string, cols: number, at: Date): string[] {
  switch (kind) {
    case "plan": return planRows(item, cols);
    case "result": return resultRows(item, cols);
    case "inbound": return inboundRows(item, cols, at);
    case "thinking": return plainRows(item, cols, "2;3");
    case "permission": return permissionRows(item, cols);
    case "failure": return plainRows(item, cols, "31");
    case "stop": return stopRows(item, cols, at);
    case "notice": return plainRows(item, cols, "33");
    default: return plainRows(item, cols);
  }
}
