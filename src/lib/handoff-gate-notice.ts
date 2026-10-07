/**
 * Spec HDG-1 #7: part of a feature batch is already with the repository owner and a sibling of that batch is no longer reviewed
 * (back in fix / review, or a node added since). The rest keep waiting (handoff-gate-plan.ts) and nothing handed is recalled; PM
 * hears once per regression — the escalate event's dedup key names each pending sibling at its stage and round.
 * tests/handoff-gate-regress.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import { featureGate } from "./handoff-gate.js";
import { batchHanded, batchPending, nodeLabel } from "./handoff-gate-plan.js";

/** Records the escalation and returns its text the first time; null when nothing regressed or PM already heard of it. */
export function recordFeatureRegress(db: Database, task: LedgerTask, now: number): string | null {
  const f = featureGate(db, task);
  const pending = f ? batchPending(f) : [], handed = f ? batchHanded(f) : [];
  if (!f || !pending.length || !handed.length) return null;
  const key = `handoff-gate:regress:${f.featureId}:${pending.map((n) => `${n.key}=${n.taskId ?? "planned"}:${n.stage}:r${n.round ?? 0}`).join(",")}`;
  const text = `[调度引擎] feature ${f.featureId} 已交出 ${handed.map((n) => `${n.taskId}@${(n.head ?? "").slice(0, 12)}`).join("、")}，` +
    `同批的 ${pending.map(nodeLabel).join("、")} 又没审过：同批其余的继续等，已交出的不自动撤回，要不要请仓库方暂缓合并由 PM 定`;
  return withLedgerWriter(db, (w) => tx(w, () => {
    if (getEventByDedup(w, key)) return null;
    insertEvent(w, { actor: "scheduler", now, dedupKey: key }, { project: task.project, target: task.id, kind: "escalate", text,
      data: { to: "pm", reason: text, auto: true, op: "feature_handoff_regress", featureId: f.featureId,
        handed: handed.map((n) => `${n.taskId}@${n.head ?? ""}`), pending: pending.map((n) => n.key) } }, true);
    return text;
  }));
}
