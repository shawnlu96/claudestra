/**
 * What a review order tells the reviewer about convergence (i28-CONV1). Local (review-order.ts) and pool (ledger-lend.ts)
 * orders call this one function, so both say the same thing the planner enforces (review-converge.ts). Each line stays under
 * WIRE_LIMITS.line; the scope line appears from SCOPE_ROUND on. tests/review-converge.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import { prevReviewedHead, SCOPE_ROUND } from "./review-converge.js";
import { rebaseScopeLines } from "./scheduler-review-rebase.js";

export const BASIS_LINE = "P1 带 basis=\"acceptance:<N>\"（违反规格验收线 N）或 \"regression\"（本卡 diff 引入的正确性/安全 bug，含上轮修复）；" +
  "无 basis 字段时在 probe/说明开头写「[验收线 N]」/「[回归]」。无依据 P1 按 P2：不挡合并，另开后续节点。" +
  "示例：{findingId:\"lease-race\",family:\"concurrency\",severity:\"P1\",basis:\"acceptance:2\"," +
  "probe:\"src/lib/x.ts:40 两次 tick 抢同一意图\",description:\"…\"}";

/** Free text reaches fix orders verbatim; local evidence stays local and display abbreviations never apply to tool identity fields. */
export const HASH_LINE = "probe、description、报告正文：哈希/摘要/随机串只写前 16 位，git 提交号用 12–16 位短号；" +
  "本机证据位置用 <scratchpad>/相对路径，当前审查会话展示仅前8位。完整值留本机原始工件，自检勿贴完整本机路径、用户名/主机名/系统临时绝对前缀(闸未必拦)。" +
  "正式 head/orderId/sessionId/身份签名保持完整，reportPath 传真实完整绝对路径；完整长十六进制被外发闸整单拒收。";

/** The scope line for a round ≥ SCOPE_ROUND order; null before that or when last round's head is unknown. */
export function scopeLine(round: number, events: readonly LedgerEvent[], head: string): string | null {
  const from = round >= SCOPE_ROUND ? prevReviewedHead(events, round) : null;
  if (round < SCOPE_ROUND) return null;
  if (!from) return `第 ${round} 轮起只审修复：上轮已审 head → 本轮 head 的 diff + 上轮未关 findings 定向复验；上轮 head 缺失，先核对，勿扩围。`;
  // Full heads live in structured fields; order text uses git short refs so the peer secret gate can scan every free-text field.
  return `第 ${round} 轮起只审修复：git diff ${from.slice(0, 12)}..${head.slice(0, 12)}（上轮已审 head → 本轮 head）+ 单上未关 findings 定向复验；` +
    "新 P1 的 probe 文件在 diff 外且 basis 非 regression，自动降 P2；probe 写明路径。";
}

/** Lines a review order carries, in order: the basis rule, the short-hash rule, then (from SCOPE_ROUND) the scope. */
export function convergeOrderLines(round: number, events: readonly LedgerEvent[], head: string): string[] {
  const rebase = rebaseScopeLines(round, events, head); // merge driver moved the head: scope = PR vs main (i28-RH1)
  if (rebase) return [BASIS_LINE, HASH_LINE, ...rebase];
  const scope = scopeLine(round, events, head);
  return scope ? [BASIS_LINE, HASH_LINE, scope] : [BASIS_LINE, HASH_LINE];
}
