/**
 * 上下文占用色阶(1M 窗口——Fable 5 的上下文不是 200k;此前按 200k 算,
 * 389k 的会话直接爆表深红,实际才 39%,正是「变红太快」的根因)。
 * owner 2026-07-14 指定绝对档位:
 *   ≥750k(75%) deep —— 深红,该压缩了
 *   ≥500k(50%) high —— 红
 *   ≥200k(20%) mid  —— 黄,开始留意
 *   其余         none —— 不打扰
 * 各处(顶栏徽章/侧栏背景条/用量面板 Bar)按档位映射自己的样式,
 * 「深红」用 error 实色/加深透明度表达——daisyUI 没有深红 token,
 * 实色块与浅色块的对比在明暗两主题下都成立。
 */
export type CtxLevel = "deep" | "high" | "mid" | "none";

/** 上下文窗口参考刻度(Fable 5 = 1M tokens) */
export const CTX_WINDOW = 1_000_000;

/**
 * v2.21.3+ save-compact 时机建议(owner 2026-09-03 拍板):按任务边界压,上下文只
 * 决定「找边界的紧迫程度」。刻度与 ctxLevel 同一套,顶栏徽章点开渲染成表。
 * 理由:摘要输出预算固定,输入越大丢得越多;压缩耗时随上下文线性增长(149K 用了
 * 141s);CC 在 ~967K 裸压且不存记忆。
 */
export const CTX_ADVICE: { level: CtxLevel; range: string; advice: string }[] = [
  { level: "none", range: "< 200K", advice: "不用管" },
  { level: "mid", range: "200K – 500K", advice: "开始留意:下一个自然收尾点就存记忆 + Compact" },
  { level: "high", range: "500K – 750K", advice: "下一个边界必压;别在这个区间开新的大任务" },
  { level: "deep", range: "≥ 750K", advice: "别等了,找个句号就压" },
];

export function ctxLevel(tokens: number): CtxLevel {
  if (tokens >= 750_000) return "deep";
  if (tokens >= 500_000) return "high";
  if (tokens >= 200_000) return "mid";
  return "none";
}
