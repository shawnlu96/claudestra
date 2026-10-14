/**
 * 底栏的固定部分：多行输入框（上下两道线，中间是正在打的字，粘贴进来的换行照样分行）和状态栏（忙闲 / 审批 / 压缩、排队、上下文、模型、effort）。
 * 每行只占一行（不折），放不下就截；状态栏按重要性丢：先丢按键提示，再丢 effort、模型、上下文，忙闲和排队最后丢。
 * 输入框最多 INPUT_ROWS 行，超出的显示末尾（光标在最后，正在打的字要看得见），上面注明还有几行。tests/acp-tui-footer.test.ts。
 */
import type { TurnState } from "../tty-status.js";
import { elapsed } from "../tty-status.js";
import type { SessionInfo } from "./live.js";
import { fitLine, renderPara, sgr, span, widthOf, type Span } from "./text.js";

/** 输入框里显示的内容（tty-input.ts draft()）：permission = 有审批在等且还没打字时的作答提示 */
export interface InputDraft {
  text: string;
  permission: string | null;
}

const INPUT_ROWS = 6;
const CURSOR = sgr("7", " ");

const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n));

/** short：窄屏只留百分比 */
function ctxText(ctx: SessionInfo["ctx"], short = false): string {
  if (!ctx) return "";
  if (!ctx.size) return `上下文 ${k(ctx.used)}`;
  const pct = `上下文 ${Math.min(100, Math.round((ctx.used / ctx.size) * 100))}%`;
  return short ? pct : `${pct}（${k(ctx.used)}/${k(ctx.size)}）`;
}

/** 模型值可能是「提供方/模型」：状态栏只显示最后一段（选项全名在网页设置页） */
const shortModel = (m: string): string => m.slice(m.lastIndexOf("/") + 1);

export function statusLine(s: TurnState, info: SessionInfo, busyMs: number, cols: number): string {
  const state: Span = s.permissions > 0 ? span("⏸ 等待审批", "1;33")
    : info.compacting ? span("📦 压缩中…", "1;35")
    : s.busy ? span(`✻ 思考中… ${elapsed(busyMs)}`, "1;33") : span("● 空闲", "32");
  // 越靠后越先丢
  const parts = (short: boolean): Span[] => [
    state,
    ...(s.queued > 0 ? [span(`排队 ${s.queued} 条`, "36")] : []),
    ...(info.ctx ? [span(ctxText(info.ctx, short))] : []),
    ...(info.model ? [span(shortModel(info.model))] : []),
    ...(info.effort ? [span(info.effort)] : []),
    ...(s.permissions > 0 ? [span("y/n/序号 + 回车作答，网页卡片也能答")] : s.busy ? [span("Esc 打断")] : []),
  ];
  const join = (ps: Span[]): Span[] => ps.flatMap((p, i) => (i ? [span(" · ", "2"), p.s ? p : { ...p, s: "2" }] : [p]));
  const fits = (ps: Span[]) => widthOf(join(ps)) <= cols - 1;
  const drop = (ps: Span[]): Span[] => (ps.length > 1 && !fits(ps) ? drop(ps.slice(0, -1)) : ps);
  const [full, short] = [drop(parts(false)), drop(parts(true))]; // 上下文只留百分比能多放下几项就用短的
  return fitLine(join(short.length > full.length ? short : full), cols);
}

/** 输入框：线 / 内容（❯ 起头，续行缩进两格）/ 线；内容按宽度折，最多 INPUT_ROWS 行 */
export function inputBox(d: InputDraft, cols: number): string[] {
  const rule = sgr("2", "─".repeat(Math.max(1, cols - 1)));
  if (d.permission && !d.text) return [rule, ...renderPara({ lead: [span("❯ ", "1;33")], body: [span(d.permission, "33")] }, cols).slice(0, 2), rule];
  const lines = d.text.replace(/\r\n?/g, "\n").split("\n");
  const rows = lines.flatMap((l, i) => renderPara({ lead: [span(i ? "  " : "❯ ", i ? undefined : "1")], body: [span(l)] }, cols - 1));
  rows[rows.length - 1] += CURSOR; // 折行按 cols - 1 排，给假光标留一格
  const shown = rows.length > INPUT_ROWS ? [sgr("2", `  … 上面还有 ${rows.length - INPUT_ROWS + 1} 行`), ...rows.slice(-(INPUT_ROWS - 1))] : rows;
  return [rule, ...shown, rule];
}
