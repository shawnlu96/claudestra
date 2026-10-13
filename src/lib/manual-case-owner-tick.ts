/**
 * merge-arch-OWN1 backfill pass, run by the existing manual-recovery wiring (scheduler-recovery-ports.ts) after MAN2 and the evidence
 * mechanisms. Per project the manualCaseOwnership switch decides: off reads nothing; observe hands each episode's would-be assignment to
 * the leased writer once; on has the writer record the default once per episode. The writer re-derives everything in its transaction;
 * this pass only picks candidates. A card's refusal or error stays that card's: MAN2's outcomes and the other cards still go through.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import { getEventByDedup, getMeta, getTask, LedgerError, listEvents } from "./ledger-store.js";
import type { ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { MANUAL_CASE_KEY, manualCaseOwnershipMode, pendingDefault } from "./manual-case-owner.js";
import { observeActionKey } from "./manual-case-owner-write.js";
import { observeDedupKey } from "./recovery-policy.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export interface ManualCaseOwnerOutcome { project: string; taskId?: string; mode: "on" | "observe" | "off"; action: string; why: string }
export interface ManualCaseOwnerDeps {
  /** `scheduler-manual-case-default <args>` through the leased writer */
  write: (args: string[]) => Promise<Record<string, unknown>>;
  policy?: ExplicitPolicyPort;
  yieldNow?: () => boolean;
}

export async function manualCaseOwnerTick(db: Database, projects: readonly string[], d: ManualCaseOwnerDeps): Promise<ManualCaseOwnerOutcome[]> {
  const out: ManualCaseOwnerOutcome[] = [];
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_workflows'").get()) return out;
  for (const project of projects) {
    const m = manualCaseOwnershipMode(project, d.policy);
    if (m.mode !== "on" && m.mode !== "observe") { // off calls nothing; an unreadable policy also writes nothing, but says so
      if (m.mode === "error") console.error(`⚠️ [scheduler] ${project} 缺省处置补记停手：${m.why}`);
      out.push({ project, mode: "off", action: m.mode === "error" ? "error" : "none", why: m.why });
      continue;
    }
    const mode = m.mode, meta = getMeta(db, project);
    const ids = db.query("SELECT taskId FROM task_workflows WHERE project = ? AND mode = 'manual' ORDER BY taskId").all(project) as { taskId: string }[];
    for (const { taskId } of ids) {
      if (d.yieldNow?.()) return out;
      const task = getTask(db, taskId), wf = getWorkflow(db, taskId);
      if (!task || !wf) continue;
      const p = pendingDefault(task, wf.mode, listEvents(db, { project, target: taskId }), meta);
      if (!p.ok) continue;
      if (mode === "observe" && getEventByDedup(db, observeDedupKey({ project, mechanism: MANUAL_CASE_KEY, target: taskId, actionKey: observeActionKey(p.value) }))) {
        continue;
      }
      try {
        const r = await d.write([taskId, "--entry-seq", String(p.value.entrySeq), "--workflow-rev", String(wf.rev), "--mode", mode]);
        const action = mode === "on" ? (r.recorded === true ? "assigned" : "assigned_before") : (r.recorded === true ? "would_assign" : "observed_before");
        out.push({ project, taskId, mode, action, why: `#${p.value.entrySeq} → ${p.value.who}（${p.value.role}），${new Date(p.value.dueAt).toISOString()} 前响应` });
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        console.error(`⚠️ [scheduler] ${taskId} 缺省处置${mode === "on" ? "补记" : "观察"}没记上（下一轮重试）：${(e as Error).message}`);
        out.push({ project, taskId, mode, action: e instanceof LedgerError ? "refused" : "error", why: (e as Error).message });
      }
    }
  }
  return out;
}
