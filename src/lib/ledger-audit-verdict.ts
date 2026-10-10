/** Read-only review verdict diagnostics; assignments after a verdict mean the PM has already acted. */
import type { AuditFinding } from "./ledger-audit.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";

export function reviewReassigned(events: readonly LedgerEvent[], review: LedgerEvent, round: number, stepAt?: number): boolean {
  // seq distinguishes an assignment and a verdict written in the same millisecond; pending peer steps may predate the verdict.
  return (stepAt !== undefined && stepAt > review.ts) || events.some((e) => e.seq > review.seq && e.data.round === round &&
    (e.kind === "dispatch" || (e.kind === "step" && e.data.op === "assign" && ["review", "final_review"].includes(String(e.data.step)))));
}

export function reviewVerdictFinding(task: LedgerTask, review: LedgerEvent, now: number, threshold: number):
  (Omit<AuditFinding, "project" | "notify" | "key"> & { keyParts: (string | number)[] }) | null {
  if (now - review.ts <= threshold) return null;
  const { id, round } = task, { verdict, p0, p1, p2, path } = review.data;
  const report = typeof path === "string" && path ? `看报告 ${path}` : "补齐报告路径并看报告";
  return {
    rule: "review_verdict_idle", taskId: id, since: review.ts, keyParts: [id, `r${round}`, review.seq],
    detail: `${id} 第 ${round} 轮审查结论 ${String(verdict)}（P0 ${String(p0 ?? 0)} / P1 ${String(p1 ?? 0)} / P2 ${String(p2 ?? 0)}）已 ${Math.floor((now - review.ts) / 60_000)} 分钟，卡还在 review`,
    suggestion: `${report}，推 fix 或开下一轮`,
  };
}
