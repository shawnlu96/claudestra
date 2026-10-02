/** Dispute validation and its audit event share the delivery transaction; no new tables or schema migration. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { parseDisputes, validateDisputes, type FindingDispute } from "./review-arbiter.js";

export function deliverDisputes(db: Database, ctx: WriteCtx, task: LedgerTask, raw: unknown, text?: string): { disputes?: FindingDispute[] } {
  const events = listEvents(db, { project: task.project, target: task.id });
  const repair = events.some((e) => e.data.op === "fix_strategy" && e.data.specRev === task.specRev && e.data.round === task.round);
  if (task.stage === "fix" && repair && !/复现测试(?:名)?[:：]\s*\S+/.test(text ?? "")) {
    throw new LedgerError("invalid", "换会话修复交付说明必须写「复现测试：<测试名>」，并说明先红后绿结果");
  }
  if (raw === undefined) return {};
  let decoded = raw;
  if (typeof raw === "string") {
    try { decoded = JSON.parse(raw); } catch { throw new LedgerError("invalid", "--disputes 要是 JSON 数组"); }
  }
  const disputes = parseDisputes(decoded);
  if (!disputes.length) return { disputes };
  if (task.stage !== "fix") throw new LedgerError("invalid", "disputes 只收修复阶段交付");
  const read = currentReviewFacts(task, events);
  validateDisputes(disputes, read.kind === "facts" ? read.facts : null, events, task.specRev);
  for (const dispute of disputes) {
    const finding = read.kind === "facts" ? read.facts.findings.find((f) => f.findingId === dispute.findingId)! : null;
    insertEvent(db, { ...ctx, dedupKey: `dispute:${task.id}:s${task.specRev}:${dispute.findingId}` }, {
      project: task.project, target: task.id, kind: "scheduler", text: dispute.reason,
      data: { op: "finding_dispute", ...dispute, family: finding!.family, specRev: task.specRev, round: task.round,
        head: task.headSHA, reviewerSessionId: read.kind === "facts" ? read.facts.reviewerSessionId : null,
        reportPath: read.kind === "facts" ? read.facts.reportPath : "", findings: finding ? [finding] : [] },
    }, true);
  }
  return { disputes };
}
