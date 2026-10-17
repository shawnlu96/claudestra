/** Peer imports have no deploy journal: prove their current delivery, then run the ordinary completion checklist. */
import type { Database } from "bun:sqlite";
import { busyAsLedgerError, getTask, listTasks } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import { recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { ATTEMPT_OP, decideRetry } from "./peer-pr-verify-retry.js";
import { peerPrVerifyKey } from "./scheduler-verify-gate.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
import type { TickPace } from "./scheduler-yield.js";

interface Deps {
  manager: (...args: string[]) => Promise<Record<string, unknown>>;
  policy?: RecoveryPolicyPort; assertActive: () => void; now: () => number;
  /** peerPrVerifyBind only; not given = recovery-policy.json */
  bindPolicy?: RecoveryPolicyPort;
}
const KEY = "peerPrAutoVerify";

/** The pass is query_only. Reuse the short-lived writer, rechecking its lease and the card after acquiring the write lock. */
function claim(db: Database, taskId: string, key: string, d: Deps, pace?: TickPace): boolean {
  return withLedgerWriter(db, (writer) => busyAsLedgerError("写入", () => writer.transaction(() => {
    d.assertActive();
    const t = getTask(writer, taskId);
    if (!t || t.stage !== "live" || pace?.skipTask?.(taskId) || schedulerV2SkipTask(writer, taskId) || peerPrVerifyKey(writer, taskId) !== key) return false;
    const mode = (d.policy ?? recoveryPolicy)(t.project, KEY).mode;
    if (mode === "observe") {
      recordObserved(writer, { project: t.project, mechanism: KEY, target: taskId, actionKey: `verify:${t.headSHA}`,
        action: "核对 peer PR 上线检查，全过后推进 verified", data: { head: t.headSHA, key } }, d.now());
      return false;
    }
    if (mode !== "on") return false;
    // Attempt notes survive a restart (peer-pr-verify-retry.ts backs off per key); fail/unknown results themselves are never recorded.
    const now = d.now();
    const r = decideRetry(writer, t, key, now, d.bindPolicy);
    if (!r.go) return false;
    return !appendEvent(writer, { actor: "scheduler", now, dedupKey: r.dedupKey }, {
      project: t.project, target: taskId, kind: "note", text: "开始核对 peer PR 上线检查（只记通过）", data: { op: ATTEMPT_OP, key },
    }).duplicate;
  }).immediate()));
}

/** Runs after deploy reconciliation, independently of autoDispatch and the project's deploy configuration. */
export async function peerPrAutoVerify(db: Database, config: SchedulerConfig, d: Deps, pace?: TickPace): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [];
  for (const project of Object.keys(config.projects)) {
    if ((d.policy ?? recoveryPolicy)(project, KEY).mode === "off") continue;
    for (const t of listTasks(db, project).filter((t) => t.stage === "live" && t.extra.peerPr)) {
      if (pace?.yieldNow()) return failed;
      d.assertActive();
      if (pace?.skipTask?.(t.id) || schedulerV2SkipTask(db, t.id)) continue;
      try {
        const key = peerPrVerifyKey(db, t.id);
        if (!key || !claim(db, t.id, key, d, pace)) continue;
        d.assertActive();
        const r = await d.manager("ledger", "verify", t.id, "--dedup", key, "--pass-only");
        d.assertActive();
        if (r.ok !== true && r.code !== "unverified") failed.push({ taskId: t.id, error: String(r.error ?? r.code ?? "verify failed") });
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        failed.push({ taskId: t.id, error: (e as Error).message });
      }
    }
  }
  return failed;
}
