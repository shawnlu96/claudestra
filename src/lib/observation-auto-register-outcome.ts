/** Spec-only conclusions and bounded extension policy, kept apart from the manual plan lifecycle. */
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { automaticKeys, observationSpecReader, onlyAutomaticWork, specDigest, type ObservationSpecReader } from "./observation-auto-register-spec.js";
import { targetLabel, type ObservationPlan, type PlansDoc, type PlanEvidence } from "./observation-plan.js";
import { closeObservationTodos, recordObservationTodo } from "./pm-todo-observation.js";
import { highRiskRecoveryKey } from "./recovery-key-class.js";
import { postVerifySection, postVerifyDoneKey } from "./scheduler-post-verify-ledger.js";

export function specAuthorizationStale(db: Database, p: ObservationPlan, read: ObservationSpecReader = observationSpecReader): { code: string; reason: string } | null {
  if (!p.authorization) return null;
  const task = getTask(db, p.taskId), spec = read(p.taskId);
  if (!spec || specDigest(spec.text) !== p.authorization.digest) return { code: "spec_changed", reason: "规格内容摘要已变或规格不可读" };
  if (task?.stage !== "verified") return { code: "stage_changed", reason: "卡已不在 verified" };
  if (p.by !== p.authorization.pm || (task.pm && task.pm !== p.by)) return { code: "authorization_changed", reason: "卡 PM 与规格授权绑定不符" };
  return null;
}

export function riskVerdict(p: ObservationPlan, e: PlanEvidence): { code: string; reason: string } | null {
  if (!p.authorization || p.target.kind !== "recovery" || !highRiskRecoveryKey(p.target.key)) return null;
  return e.to - e.from >= 24 * 3600_000 && e.records.length >= 3 ? null
    : { code: "insufficient_risk_samples", reason: "高风险恢复键须观察至少 24 小时且有至少 3 条样本" };
}
export const mayExtendObservation = (p: ObservationPlan, code?: string): boolean => !!p.authorization && (p.extensions ?? 0) < 2
  && (code === "no_samples" || code === "insufficient_risk_samples");

export function extendObservation(db: Database, ctx: WriteCtx, p: ObservationPlan, reason: string): string {
  p.extensions = (p.extensions ?? 0) + 1;
  p.dueAt += p.hours * 3600_000;
  delete p.dryRun;
  delete p.extensionSentAt;
  const text = `观察期顺延 ${p.id} 第 ${p.extensions}/2 次：${reason}；新到期 ${new Date(p.dueAt).toISOString()}`;
  appendEvent(db, { ...ctx, dedupKey: `observation-extend:${p.id}:${p.extensions}` }, { project: p.project, target: p.taskId, kind: "note", text,
    data: { op: "observation_extend", plan: p.id, extension: p.extensions, dueAt: p.dueAt, reason } });
  recordObservationTodo(db, ctx, p, "observation_extended", text);
  return text;
}

export function finishAutomaticObservation(db: Database, ctx: WriteCtx, p: ObservationPlan, doc: PlansDoc, read: ObservationSpecReader = observationSpecReader): void {
  if (!p.authorization) return;
  closeObservationTodos(db, ctx, p);
  const spec = read(p.taskId);
  if (!spec || specDigest(spec.text) !== p.authorization.digest || !onlyAutomaticWork(spec.text, p.project)) return;
  const keys = automaticKeys(postVerifySection(spec.text) ?? "", p.project);
  if (!keys.every((key) => doc.plans.some((other) => other.taskId === p.taskId && other.verifiedAt === p.verifiedAt && other.status === "promoted"
    && targetLabel(other.target) === `recovery:${key}`))) return;
  appendEvent(db, { ...ctx, dedupKey: postVerifyDoneKey(p.taskId) }, { project: p.project, target: p.taskId, kind: "note",
    text: "规格授权的开关均已自动转正，上线后 PM 待办完成", data: { op: "post_verify_done", plan: p.id } });
}
