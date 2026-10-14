import type { TaskUsageSummary, UsageFamily } from "@/lib/api/usage-task";
import { fillParams } from "@/lib/i18n-fill";
import type { Tr } from "./collab-model";

export function taskTokenText(tokens: number, tr: Tr = fillParams): string {
  return tokens < 10_000 ? tr("不到 1 万") : tr("{n} 万", { n: Math.round(tokens / 10_000).toLocaleString("en-US") });
}
export function taskUsageLines(summary: TaskUsageSummary, tr: Tr = fillParams): string[] {
  const lines: string[] = [];
  for (const family of ["claude", "codex"] as UsageFamily[]) {
    const usage = summary.families[family];
    if (!usage || usage.totalTokens <= 0) continue;
    const estimate = summary.weekEstimate[family];
    const share = estimate ? tr(estimate.estimatePct === null ? "约占本周额度不到 1%" : "约占本周额度 {n}%", { n: estimate.estimatePct ?? "" }) : "";
    const text = tr("{family} 约 {tokens} token", { family: family === "claude" ? "Claude" : "Codex", tokens: taskTokenText(usage.totalTokens, tr) });
    lines.push([text, share].filter(Boolean).join(" · "));
  }
  if (!lines.length) lines.push(tr("还没有用量记录"));
  const orders = Object.values(summary.lent).reduce((n, row) => n + (row?.unreportedOrders ?? (row?.tokensReported ? 0 : row?.orders ?? 0)), 0);
  if (orders > 0) lines.push(tr("另有 {n} 单在其他成员机器上跑，用量对方没回传", { n: orders }));
  const date = summary.unavailableBefore ?? (summary.hasArchive ? summary.detailFrom : null);
  if (date) lines.push(tr("早于 {date} 的部分已不可查", { date }));
  return lines;
}
