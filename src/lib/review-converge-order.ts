/**
 * What a review order tells the reviewer about convergence (i28-CONV1). Local (review-order.ts) and pool (ledger-lend.ts)
 * orders call this one function, so both say the same thing the planner enforces (review-converge.ts). Each line stays under
 * WIRE_LIMITS.line; the scope line appears from SCOPE_ROUND on. tests/review-converge.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import { prevReviewedHead, SCOPE_ROUND } from "./review-converge.js";

export const BASIS_LINE = "每条 P1 都要挂依据：逐项结论带 basis = \"acceptance:<N>\"（违反规格「验收线」第 N 条）或 \"regression\"" +
  "（本卡 diff 引入的正确性 / 安全 bug，含上一轮修复引入的）；工具没有 basis 字段时在 probe 或说明开头写「[验收线 N]」/「[回归]」。" +
  "没挂依据的 P1 按 P2 计：不挡合并，另开后续节点。示例：{findingId:\"lease-race\", family:\"concurrency\", severity:\"P1\", " +
  "basis:\"acceptance:2\", probe:\"src/lib/x.ts:40 两次 tick 抢同一意图\", description:\"…\"}";

/** The scope line for a round ≥ SCOPE_ROUND order; null before that or when last round's head is unknown. */
export function scopeLine(round: number, events: readonly LedgerEvent[], head: string): string | null {
  const from = round >= SCOPE_ROUND ? prevReviewedHead(events, round) : null;
  if (round < SCOPE_ROUND) return null;
  if (!from) return `第 ${round} 轮起只审修复：上一轮审过的 head → 本轮 head 的 diff + 上一轮未关 findings 的定向复验；上轮 head 缺失，先核对，勿扩展审查范围。`;
  // Full heads live in structured fields; order text uses git short refs so the peer secret gate can scan every free-text field.
  return `第 ${round} 轮起只审修复：范围 = git diff ${from.slice(0, 12)}..${head.slice(0, 12)}（上一轮审过的 head → 本轮 head）+ 上一轮未关 findings 的定向复验（见单上 findings）。` +
    "diff 外新发现的 P1（probe 里的文件不在这次 diff 改动的文件里，且 basis 不是 regression）会自动降为 P2；probe 里写明文件路径。";
}

/** Lines a review order carries, in order: the basis rule, then (from SCOPE_ROUND) the scope. */
export function convergeOrderLines(round: number, events: readonly LedgerEvent[], head: string): string[] {
  const scope = scopeLine(round, events, head);
  return scope ? [BASIS_LINE, scope] : [BASIS_LINE];
}
