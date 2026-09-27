/**
 * AI 消息的段按时间分组（纯函数，无 import，tests/web-time-groups.test.ts）——PC 端侧槽时间标签的「轨道」：
 * 每组一个 relative 包装 + 一个 sticky 标签，组滚过时标签贴顶跟随、被下一组的标签顶走。
 * 不按段逐个给标签（owner 2026-09-27：一轮回复里几十个单行的旁白 / 工具行，逐个标时间又挤又吵）。
 *
 * 开新组的规则：第一段必开；回复正文（reply）必开；其余段与当前组起点相比时间差 ≥ gapMs 才开
 * （连续 tool call 都在几秒内，天然并进上一组）。没有时间的段不开组。空 reply 段不渲染，也不开组。
 */
export type LeadKind = "narr" | "note" | "body" | "tool";

export type SegLike =
  | { kind: "text"; ts?: string; progress?: boolean }
  | { kind: "tools"; tools: { ts?: string }[] }
  | { kind: "reply"; text?: string; ts?: string };

export interface SegGroup {
  /** 段下标区间 [start, end) */
  start: number;
  end: number;
  /** 组的时间 = 首段时间；首组没有时回退到消息时间 */
  ts?: string;
  /** 首段类型，标签按它对齐第一行 */
  lead: LeadKind;
}

export const GROUP_GAP_MS = 2 * 60_000;

function segTs(s: SegLike): string | undefined {
  return s.kind === "tools" ? s.tools[0]?.ts : s.ts;
}

function leadOf(s: SegLike): LeadKind {
  if (s.kind === "tools") return "tool";
  if (s.kind === "reply") return "body";
  return s.progress ? "note" : "narr";
}

function ms(iso?: string): number | null {
  if (!iso) return null;
  const n = new Date(iso).getTime();
  return Number.isFinite(n) ? n : null;
}

export function groupSegments(segs: SegLike[], fallbackTs?: string, gapMs = GROUP_GAP_MS): SegGroup[] {
  const out: SegGroup[] = [];
  let groupMs: number | null = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = segTs(s);
    const t = ms(ts);
    const emptyReply = s.kind === "reply" && !s.text?.trim();
    const open =
      out.length === 0 ||
      (!emptyReply && s.kind === "reply") ||
      (t !== null && groupMs !== null && t - groupMs >= gapMs);
    if (open) {
      out.push({ start: i, end: i + 1, ts: ts ?? (out.length === 0 ? fallbackTs : undefined), lead: leadOf(s) });
      groupMs = t ?? (out.length === 1 ? ms(fallbackTs) : groupMs);
    } else {
      out[out.length - 1].end = i + 1;
    }
  }
  return out;
}
