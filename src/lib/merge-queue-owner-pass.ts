/** Pass wiring: prediction has no claims; on uses the same slot turn as a train lender, under the pass lease. */
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import { mergeCandidates } from "./scheduler-merge-train-tick.js";
import { mergeFirst } from "./scheduler-merge-order.js";
import { manualQueueMode } from "./manual-merge-queue-facts.js";
import { manualTurn, trainSignal } from "./manual-merge-queue.js";
import { configuredOwnerMode, ownerFallbackReason, queueOwnerMode } from "./merge-queue-owner-context.js";
import { bindOwnerPass } from "./merge-queue-owner-hooks.js";
import { ownerMainCiDecision } from "./merge-queue-owner-main-ci.js";
import { pickMergeQueueOwner } from "./merge-queue-owner.js";
import { observeOwnerPriority } from "./merge-queue-owner-priority.js";
import { ownerMainCiPaused } from "./merge-queue-owner-main-ci.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";
import type { TrainStore } from "./scheduler-merge-train.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";
import { SLOT_YIELD } from "./scheduler-merge-train-hold.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";

type Advance = (from: MergePhase, to: MergePhase, rev: number, receipt?: string) => Promise<MergeRun>;
/** null = old slot/driver path; a run = leave this turn here (or the same intent with its slot lent). */
export async function ownerSlotTurn(db: Database, run: MergeRun, advance: Advance, now: number): Promise<MergeRun | null> {
  if (schedulerV2SkipTask(db, run.taskId)) return run;
  if (queueOwnerMode(db, run.project, run.taskId) !== "on" || !["ready", "await_ci"].includes(run.phase)) return null;
  const held = db.query("SELECT intentId FROM scheduler_resources WHERE project = ? AND resource = ?")
    .get(run.project, `merge:${run.project}`) as { intentId: string } | null;
  if (held?.intentId === run.intentId) {
    if (run.intentId.startsWith("mmq:") && ownerMainCiPaused(db, run.project, run.taskId, run.reviewedHead)) {
      return advance(run.phase, run.phase, run.rev, `${SLOT_YIELD}mergeQueueOwner：主线 CI 暂停，保留人工队位`);
    }
    return null; // the existing driver settles this intent; no preemption by a new arrival
  }
  if (held) return run;
  return pickMergeQueueOwner(db, run.project, now).intentId === run.intentId ? null : run;
}

/** The legacy pass would recover lenders first, then manualTurn, then the oldest auto card. */
function legacyChoice(db: Database, project: string, trains: TrainStore | null, now: number): string | null {
  const holder = db.query("SELECT taskId FROM scheduler_resources WHERE project = ? AND resource = ?").get(project, `merge:${project}`) as { taskId: string } | null;
  if (holder) return holder.taskId;
  const lender = db.query(`SELECT m.taskId FROM scheduler_merges m JOIN scheduler_intents i ON i.id = m.intentId WHERE m.project = ?
    AND i.status = 'submitted' AND m.phase IN ('ready','await_ci') AND (SELECT json_extract(data, '$.turn') FROM events
    WHERE target = m.taskId AND json_extract(data, '$.op') = 'merge_slot' AND json_extract(data, '$.intentId') = m.intentId
    ORDER BY seq DESC LIMIT 1) = 'yield' ORDER BY i.eventSeq LIMIT 1`).get(project) as { taskId: string } | null;
  if (lender) return lender.taskId;
  const turn = manualQueueMode(project) === "on" ? manualTurn(db, project, trainSignal(trains, project, now), now) : { kind: "none" as const };
  return turn.kind === "due" && !turn.wait ? turn.req.taskId : turn.kind === "active" ? turn.req.taskId
    : mergeFirst(db, mergeCandidates(db, project, { now }))[0]?.taskId ?? null;
}

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
/** scheduler-recovery-observe calls recordObserved in the ledger child; skip is checked before prediction and before the write. */
export async function observeMergeQueueOwner(db: Database, manager: Manager, project: string,
  trains: TrainStore | null = defaultTrainStore(), now = Date.now()): Promise<void> {
  const mode = configuredOwnerMode(db, project);
  if (mode === "off") return;
  try {
    const fallback = ownerFallbackReason(db, project);
    const old = legacyChoice(db, project, trains, now);
    if (fallback) {
      if (old) await recordOwnerChoice(db, manager, project, old, old, null, fallback);
      return;
    }
    // QUEUE1 excludes foreign cards. Record their legacy path without changing the local queue or granting eligibility.
    const foreign = db.query("SELECT id FROM tasks WHERE project = ? AND kind = 'code' AND stage = 'merge'").all(project) as { id: string }[];
    for (const { id } of foreign) {
      if (schedulerV2SkipTask(db, id)) continue;
      const reason = ownerFallbackReason(db, project, id);
      if (reason) await recordOwnerChoice(db, manager, project, id, id, null, reason);
    }
    if (mode === "on") await observeOwnerPriority(db, manager, project, (m) => pickMergeQueueOwner(db, project, now, m));
    if (mode !== "observe") return;
    const pick = pickMergeQueueOwner(db, project, now), target = pick.entry?.taskId ?? old;
    if (target && pick.entry?.taskId !== old) await recordOwnerChoice(db, manager, project, target, old, pick);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`[merge-owner] ${project} 观察未完成，旧路径继续：${String(e)}`);
  }
}

/** The existing ledger observation endpoint supplies recordObserved dedup; no new write path is introduced. */
async function recordOwnerChoice(db: Database, manager: Manager, project: string, target: string, old: string | null,
  pick: ReturnType<typeof pickMergeQueueOwner> | null, fallback?: string): Promise<void> {
  if (schedulerV2SkipTask(db, target) || (old && schedulerV2SkipTask(db, old))) return;
  const entry = pick?.entry, reason = fallback ?? pick!.reason;
  const intent = pick?.intentId ?? (db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND action = 'merge' ORDER BY eventSeq DESC LIMIT 1")
    .get(target) as { id: string } | null)?.id ?? "new";
  const task = getTask(db, target), version = entry?.versionSeq ?? task?.rev ?? 0;
  const key = `owner:${Bun.hash(`${intent}:${target}:${version}:${task?.headSHA}:${task?.specRev}:${old}:${reason}`).toString(36)}`;
  const result = await manager("ledger", "scheduler-recovery-observe", target, "--mechanism", "mergeQueueOwner", "--action-key", key,
    "--action", fallback ? `${fallback}，沿用旧合并路径` : `统一队列会选 ${entry?.taskId ?? "无人"}，旧选择 ${old ?? "auto"}：${reason}`,
    "--data", JSON.stringify({ chosen: entry?.taskId ?? null, old, intentId: pick?.intentId ?? null, versionSeq: version, head: task?.headSHA, reason }));
  if (result.ok !== true && result.held !== true) console.error(`[merge-owner] ${project} 观察记录失败：${String(result.error)}`);
}

bindOwnerPass({ slot: ownerSlotTurn, mainCi: ownerMainCiDecision });
