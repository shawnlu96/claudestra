/** One queue chooses the next slot owner; every writer asks again under its existing SQLite transaction. */
import { ownerPorts, ownerRepository, queueOwnerMode } from "./merge-queue-owner-context.js";
import { bindOwnerWrites } from "./merge-queue-owner-hooks.js";
import type { Database } from "bun:sqlite";
import { getIntent, type SchedulerIntent } from "./ledger-scheduler.js";
import { getMeta, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { mergeQueueFacts, unifiedQueueMode, type QueueEntry } from "./merge-queue-facts.js";
import { manualQueueMode, requestAt, type ManualRequest } from "./manual-merge-queue-facts.js";
import type { TrainSignal, Turn } from "./manual-merge-queue.js";
import { cardRepo, projectRepo, projectRepoFor } from "./scheduler-foreign-repo.js";
import { getMergeRun, mergeRunDrift } from "./scheduler-merge.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";
import { ridesTrain, trainHolds } from "./scheduler-merge-train-hold.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
import { mainCiLent, ownerMainCiPaused, ownerRepairs } from "./merge-queue-owner-main-ci.js";

import { OWNER_FRESH_NODE, ownerFreshRefusal } from "./scheduler-ui-owner-fresh.js";

export interface OwnerPick { entry: QueueEntry | null; intentId: string | null; reason: string }
const none = (reason: string): OwnerPick => ({ entry: null, intentId: null, reason });
/** A known repository must have exactly one local project exit, even if the other project's switch is off. */
function ownership(project: string, p: ReturnType<typeof ownerPorts>): { repo: string | null; why: string | null } {
  const cfg = p.config.projects[project];
  if (cfg?.mergeHandoff) return { repo: null, why: "mergeHandoff：由仓库方合并" };
  const repo = projectRepo(cfg, { fresh: true }) ?? projectRepoFor(project);
  if (!repo) return { repo: null, why: "项目 repository 未核实" };
  const owners = Object.entries(p.config.projects).filter(([name, c]) => !c.mergeHandoff &&
    (projectRepo(c, { fresh: true }) ?? projectRepoFor(name))?.toLowerCase() === repo.toLowerCase()).map(([name]) => name);
  return { repo: repo.toLowerCase(), why: owners.length > 1 ? `repository ${repo} 多项目出口冲突：${owners.sort().join("、")}` : null };
}
const liveIntents = (db: Database, project: string): SchedulerIntent[] => db.query(`SELECT * FROM scheduler_intents WHERE project = ?
  AND action = 'merge' AND status IN ('pending','submitted','unknown') ORDER BY eventSeq`).all(project) as SchedulerIntent[];

/** A running entry is not necessarily eligible: QUEUE1 preserves its visibility even after a hold or freeze. */
function eligible(db: Database, e: QueueEntry, intent: SchedulerIntent | undefined, now: number): boolean {
  if (e.state === "excluded" || e.state === "blocked" || getMeta(db, e.project).queueFrozen.frozen) return false;
  const events = listEvents(db, { project: e.project, target: e.taskId });
  if (events.findLast((x) => x.kind === "scheduler" && x.data.op === "workflow")?.data.hold) return false;
  // Fresh intents still pass through MAINCIW's existing begin gate; only a paused lender must wait here.
  if (!intent) return e.state === "ready";
  if (ownerMainCiPaused(db, e.project, e.taskId, e.head ?? "")) return false;
  const run = getMergeRun(db, intent.id);
  return !!run && ["ready", "await_ci"].includes(run.phase) && !mergeRunDrift(db, run, now);
}

/** Reads only. Existing uncertainty/ownership wins; otherwise QUEUE1's stable version sequence chooses among eligible entries. */
export function pickMergeQueueOwner(db: Database, project: string, now = Date.now()): OwnerPick {
  const p = ownerPorts(db), own = ownership(project, p);
  if (own.why) { console.warn(`[merge-owner] ${project} ${own.why}`); return none(own.why); }
  if (unifiedQueueMode(project, p.policy) === "off") return none("unifiedMergeQueue 未就绪");
  const entries = mergeQueueFacts(db, project, now, { repo: () => own.repo, handoff: (id) => !!p.config.projects[id]?.mergeHandoff })
    .filter((e) => !schedulerV2SkipTask(db, e.taskId));
  const intents = liveIntents(db, project);
  const uncertain = intents.find((i) => i.status === "unknown" || ["merging", "unknown", "updating"].includes(getMergeRun(db, i.id)?.phase ?? ""));
  if (uncertain) return { entry: entries.find((e) => e.taskId === uncertain.taskId) ?? null, intentId: uncertain.id, reason: "先核实在途运行" };
  const holder = db.query("SELECT intentId FROM scheduler_resources WHERE project = ? AND resource = ?")
    .get(project, `merge:${project}`) as { intentId: string } | null;
  if (holder) return { entry: entries.find((e) => e.taskId === getIntent(db, holder.intentId)?.taskId) ?? null,
    intentId: holder.intentId, reason: "既有意图持槽，先结清" };
  const unbegun = intents.find((i) => !getMergeRun(db, i.id) && !mainCiLent(db, project, i.id));
  if (unbegun) return { entry: entries.find((e) => e.taskId === unbegun.taskId) ?? null, intentId: unbegun.id, reason: "既有意图待恢复，不建第二意图" };
  let train;
  try { train = (p.trains ?? defaultTrainStore())?.load(project); } catch { return none("列车状态不可读，不能认领"); }
  const repairs = ownerRepairs(db, project, own.repo!);
  const ordered = [...entries].sort((a, b) => Number(repairs.has(b.taskId)) - Number(repairs.has(a.taskId)));
  const entry = ordered.find((e) => e.repository === own.repo && (e.source !== "manual" || manualQueueMode(project, p.policy) === "on") &&
    eligible(db, e, intents.find((i) => i.taskId === e.taskId), now) &&
    (!train || !trainHolds(train, now) || ridesTrain(train, e.taskId, e.head)));
  if (!entry) {
    const refresh = intents.find((i) => {
      if (i.node !== OWNER_FRESH_NODE) return false;
      const run = getMergeRun(db, i.id);
      return run && ["ready", "await_ci"].includes(run.phase) && !mergeRunDrift(db, run, now);
    });
    if (refresh) return { entry: null, intentId: refresh.id, reason: "既有只追 main 运行，空闲时恢复" };
  }
  return entry ? { entry, intentId: intents.find((i) => i.taskId === entry.taskId)?.id ?? null, reason: "最早有效版本（保留 yielded 队位）" }
    : none("没有可认领版本");
}

/** auto planIntent's final write fence; the caller already owns BEGIN IMMEDIATE and the scheduler lease. */
export function requireMergeQueueOwner(db: Database, taskId: string, action: string, now: number, intentId?: string, node?: string): void {
  if (action !== "merge") return;
  const task = getTask(db, taskId);
  if (!task || queueOwnerMode(db, task.project) !== "on") return;
  if (schedulerV2SkipTask(db, taskId)) throw new LedgerError("conflict", "shared-ledger skip：不认领合并槽");
  const pick = pickMergeQueueOwner(db, task.project, now);
  // UI refreshes use this slot to update a review-stage PR, never to merge; they may use an otherwise idle queue.
  const refresh = (node ?? (intentId ? getIntent(db, intentId)?.node : null)) === OWNER_FRESH_NODE;
  if (refresh && !ownerFreshRefusal(db, task) && cardRepo(task) === ownerRepository(db, task.project)?.toLowerCase() &&
    !pick.entry && (intentId ? pick.intentId === intentId : pick.reason === "没有可认领版本")) return;
  if (pick.entry?.taskId !== taskId || (intentId ? pick.intentId !== intentId : pick.intentId !== null)) {
    throw new LedgerError("conflict", `统一合并队列：${pick.reason}${pick.entry ? `（${pick.entry.taskId} 先）` : ""}`);
  }
}

/** Replaces only the claim's decision, never manualTurn's read-only queue view (which QUEUE1 itself uses). */
export function ownerManualTurn(db: Database, project: string, train: TrainSignal, now: number): Turn | null {
  if (queueOwnerMode(db, project) !== "on" || manualQueueMode(project) !== "on") return null;
  const pick = pickMergeQueueOwner(db, project, now), e = pick.entry;
  if (!e || e.source !== "manual" || e.manualRequestSeq === null || pick.intentId) return { kind: "none" };
  const req: ManualRequest | null = requestAt(db, e.manualRequestSeq);
  if (!req) return { kind: "none" };
  return { kind: "due", req, wait: train === "corrupt" ? "列车状态不可读" : null };
}

bindOwnerWrites({ require: requireMergeQueueOwner, manual: ownerManualTurn });
