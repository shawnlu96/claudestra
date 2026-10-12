/**
 * Producer half of merge/deploy detachment. DEPLOY2 must register its consumer in each writer process before on can act.
 * A pending event is permanent evidence, never a deploy command. Only the fresh merged transaction may detach; old rows
 * continue through the old deploy journal. queueVersion is the merge intent's eventSeq (the durable queue admission order).
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { actorMaySchedule, settleIntent } from "./ledger-scheduler-settle.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { getEventByDedup, getMeta, getTask, LedgerError } from "./ledger-store.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig, type DeployTarget, type SchedulerConfig } from "./scheduler-config.js";
import type { MergeRun } from "./scheduler-merge.js";
import { gateEventData } from "./shared-ledger-v2-write-gate.js";

export const MERGE_DEPLOY_PRODUCER = Object.freeze({ capability: "merge-deploy-outbox-producer", protocolVersion: 1 as const });
export const DEPLOY_PENDING_CONSUMER = Object.freeze({ capability: "deploy-pending-consumer", protocolVersion: 1 as const });
type Capability = { capability: string; protocolVersion: number };
export interface MergeDeployOutboxPorts {
  policy: RecoveryPolicyPort;
  config: () => SchedulerConfig;
  /** Registration means the writer's runtime includes DEPLOY2, not merely a config flag claiming it does. */
  consumer: (project: string) => Capability | null;
}
const ports = new WeakMap<Database, MergeDeployOutboxPorts>();
const defaults: MergeDeployOutboxPorts = { policy: recoveryPolicy, config: readSchedulerConfig, consumer: () => null };

/** Database-scoped wiring avoids a process-wide switch; reopening a writer requires registering the consumer again. */
export function configureMergeDeployOutbox(db: Database, injected: Partial<MergeDeployOutboxPorts>): void {
  ports.set(db, { ...(ports.get(db) ?? defaults), ...injected });
}

export interface MergeDeployGate { mode: RecoveryMode; consumerReady: boolean; enabled: boolean }
/** The prediction does not need DEPLOY2; acting always needs on and an explicitly registered compatible consumer. */
export function mergeDeployDetachGate(db: Database, project: string): MergeDeployGate {
  const p = ports.get(db) ?? defaults, mode = p.policy(project, "mergeDeployDetach").mode;
  if (mode === "off") return { mode, consumerReady: false, enabled: false };
  let consumer: Capability | null;
  try { consumer = p.consumer(project); }
  catch (e) {
    // An unavailable capability registry retains the old protocol, including a verified merged receipt.
    console.error(`[merge-deploy-outbox] 消费能力不可读，保留旧槽协议：${(e as Error).message}`);
    consumer = null;
  }
  const consumerReady = consumer?.capability === DEPLOY_PENDING_CONSUMER.capability && consumer.protocolVersion === 1;
  return { mode, consumerReady, enabled: mode === "on" && consumerReady };
}

export interface DeployPending {
  op: "deploy_pending";
  protocolVersion: 1;
  producer: string;
  intentId: string;
  task: string;
  project: string;
  repository: string;
  mergeSha: string;
  reviewedHead: string;
  queueVersion: number;
  mergedEventSeq: number;
  deploymentPolicy: { repoDir: string; target: DeployTarget };
}
const pendingKey = (intentId: string) => `scheduler:${intentId}:deploy_pending:v1`;
const sha = (value: string | null): value is string => !!value && /^[a-f0-9]{40}$/i.test(value);
const runOf = (db: Database, intentId: string) =>
  db.prepare("SELECT * FROM scheduler_merges WHERE intentId=?").get(intentId) as MergeRun | null;

function localCard(db: Database, project: string, target: string): boolean {
  // Probe local note permission rather than replay admission: executor merge rights never grant deployment authority.
  try { gateEventData(db, { actor: "scheduler" }, { project, target, kind: "note" }); return true; }
  catch (e) {
    // A skip / protected card is a retained prediction, never permission to detach through another path.
    if (e instanceof LedgerError && e.code === "forbidden") return false;
    throw e;
  }
}

/** Read only: callers receive a copy, so changing a snapshot never changes the permanent event. */
export function getDeployPending(db: Database, intentId: string): DeployPending | null {
  const event = getEventByDedup(db, pendingKey(intentId));
  if (!event) return null;
  const data = event.data as unknown as DeployPending;
  if (event.kind !== "scheduler" || data.op !== "deploy_pending" || data.protocolVersion !== 1 || data.intentId !== intentId
    || data.producer !== MERGE_DEPLOY_PRODUCER.capability || data.project !== event.project || data.task !== event.target
    || !sha(data.mergeSha) || !sha(data.reviewedHead) || typeof data.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(data.repository)
    || !Number.isSafeInteger(data.queueVersion) || data.queueVersion < 1 || !Number.isSafeInteger(data.mergedEventSeq) || data.mergedEventSeq < 1
    || typeof data.deploymentPolicy?.repoDir !== "string" || !data.deploymentPolicy.target) {
    throw new LedgerError("dedup_mismatch", "部署待办幂等键已被不相符的记录占用");
  }
  return data;
}

export interface MergeDeployPrediction { wouldRelease: boolean; reason: string; pending?: DeployPending }
const retain = (reason: string): MergeDeployPrediction => ({ wouldRelease: false, reason });

/** All facts are re-read under the landing transaction by the producer; this read-only view is also usable by DEPLOY2. */
export function predictMergeDeployDetach(db: Database, intentId: string): MergeDeployPrediction {
  const intent = getIntent(db, intentId);
  if (!intent || intent.action !== "merge" || intent.status !== "submitted") return retain("merge 意图不在 submitted");
  const run = runOf(db, intentId);
  if (!run || run.phase !== "merged" || !sha(run.mergeSha)) return retain("缺完整 merged 事实");
  const task = getTask(db, run.taskId), workflow = getWorkflow(db, run.taskId);
  if (!task || run.taskId !== intent.taskId || run.project !== intent.project || task.project !== run.project) return retain("任务或项目不匹配");
  if (!localCard(db, task.project, task.id)) return retain("skip 卡");
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || intent.specRev !== task.specRev) return retain("流程或规格不匹配");
  // A carried head is pinned on the merge run and task, while the immutable intent may still name the original head.
  if (task.stage !== "merge" || !sha(run.reviewedHead) || task.headSHA !== run.reviewedHead
    || task.pr !== run.prRef || task.branch !== run.expectedBranch) return retain("阶段、审查 head、PR 或分支不匹配");
  if (getMeta(db, task.project).queueFrozen.frozen) return retain("项目队列冻结");
  if (db.query("SELECT 1 FROM scheduler_deploys WHERE intentId=?").get(intentId)) return retain("已有旧部署日志");
  if (!db.query("SELECT 1 FROM scheduler_resources WHERE intentId=? AND project=? AND resource=? AND scope='intent'")
    .get(intentId, run.project, `merge:${run.project}`)) return retain("未持有意图合并槽");
  const event = getEventByDedup(db, `scheduler:${intentId}:merge:merged`);
  if (!event || event.kind !== "scheduler" || event.project !== run.project || event.target !== run.taskId
    || event.data.op !== "merge_phase" || event.data.intentId !== intentId || event.data.from !== "merging"
    || event.data.to !== "merged" || event.data.mergeSha !== run.mergeSha) return retain("缺已核对 merged 回执");
  const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(run.prRef)?.[1];
  if (!repository || !Number.isSafeInteger(intent.eventSeq) || intent.eventSeq < 1) return retain("仓库或队列版本无效");
  const p = ports.get(db) ?? defaults;
  const policy = policyOf(p, run.project);
  if (!policy?.deploy || policy.mergeHandoff) return retain("由 PM 部署或仓库 owner 合并");
  const pending: DeployPending = { op: "deploy_pending", protocolVersion: 1, producer: MERGE_DEPLOY_PRODUCER.capability,
    intentId, task: run.taskId, project: run.project, repository, mergeSha: run.mergeSha, reviewedHead: run.reviewedHead,
    queueVersion: intent.eventSeq, mergedEventSeq: event.seq, deploymentPolicy: { repoDir: policy.repoDir,
      target: { ...policy.deploy, restartLabels: [...policy.deploy.restartLabels],
        ...(policy.deploy.relayArgv ? { relayArgv: [...policy.deploy.relayArgv] } : {}) } } };
  return { wouldRelease: true, reason: "登记部署待办后结清 merge", pending };
}

function policyOf(p: MergeDeployOutboxPorts, project: string): SchedulerConfig["projects"][string] | null {
  try { const config = p.config(); return config.enabled ? config.projects[project] ?? null : null; }
  catch (e) {
    // Bad local config must retain the old protocol rather than reject a verified merge receipt.
    console.error(`[merge-deploy-outbox] 配置不可读，保留旧槽协议：${(e as Error).message}`);
    return null;
  }
}

type PendingWriter = (db: Database, ctx: WriteCtx,
  event: { project: string; target: string; kind: "scheduler"; text: string; data: Record<string, unknown> }, primary: boolean) => LedgerEvent;

function observationData(intentId: string, gate: MergeDeployGate, predicted: MergeDeployPrediction): Record<string, unknown> {
  return { op: "merge_deploy_observe", protocolVersion: 1, intentId, ...gate,
    wouldRelease: predicted.wouldRelease, reason: predicted.reason };
}

/** Executor scopes only admit merge bookkeeping; retain their prediction in that immutable receipt instead of a new op. */
export function mergeDeployReceiptData(db: Database, data: Record<string, unknown>): Record<string, unknown> {
  if (data.op !== "merge_phase" || data.to !== "merged" || typeof data.intentId !== "string") return data;
  const intent = getIntent(db, data.intentId);
  if (!intent || localCard(db, intent.project, intent.taskId)) return data;
  const gate = mergeDeployDetachGate(db, intent.project);
  return gate.mode === "off" ? data : { ...data, mergeDeployObservation: observationData(intent.id, gate, retain("skip 卡")) };
}

function recordObservation(db: Database, ctx: WriteCtx, project: string, taskId: string, intentId: string,
  gate: MergeDeployGate, predicted: MergeDeployPrediction, writePending?: PendingWriter): void {
  const data = observationData(intentId, gate, predicted);
  try {
    if (!writePending) throw new LedgerError("conflict", "合并观察缺事务写入口");
    // A savepoint discards any partial observation write; its failure must never roll back the verified merge receipt.
    db.transaction(() => writePending(db, { ...ctx, dedupKey: `scheduler:${intentId}:merge_deploy_observe:v1` }, {
      project, target: taskId, kind: "scheduler", text: predicted.wouldRelease ? "合并落地观察：会释放" : "合并落地观察：会保留", data,
    }, true))();
  } catch (e) {
    // Observations do not authorize effects; retain the prediction in the log and let legacy merged landing commit.
    console.error(`[merge-deploy-outbox] 合并观察未写入，保留旧槽协议：${(e as Error).message}；预测=${JSON.stringify(data)}`);
  }
}

/** The merge writer supplies its guarded event insert; the reserved scheduler key cannot be forged by appending a note. */
export function registerMergedDeploy(db: Database, ctx: WriteCtx, intentId: string, writePending?: PendingWriter): void {
  if (!db.inTransaction) throw new LedgerError("conflict", "部署待办必须与 merged 落地同事务");
  const intent = getIntent(db, intentId);
  if (!intent || !actorMaySchedule(db, ctx.actor, intent.project)) throw new LedgerError("forbidden", "无权登记部署待办");
  if (!localCard(db, intent.project, intent.taskId)) return;
  const gate = mergeDeployDetachGate(db, intent.project);
  if (gate.mode === "off") return;
  const proof = getEventByDedup(db, `scheduler:${intentId}:merge:merged`);
  const latest = db.query("SELECT MAX(seq) AS seq FROM events").get() as { seq: number };
  if (!proof || proof.seq !== latest.seq || ctx.now === undefined || proof.ts !== ctx.now) return;
  const predicted = predictMergeDeployDetach(db, intentId);
  if (!gate.enabled || !predicted.wouldRelease) {
    recordObservation(db, ctx, intent.project, intent.taskId, intentId, gate, predicted, writePending);
    return;
  }
  const pending = predicted.pending!;
  const existing = getDeployPending(db, intentId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(pending)) throw new LedgerError("dedup_mismatch", "部署待办快照不可变");
  if (!writePending) throw new LedgerError("conflict", "部署待办缺事务写入口");
  if (!existing) writePending(db, { ...ctx, dedupKey: pendingKey(intentId) }, {
    project: intent.project, target: intent.taskId, kind: "scheduler", text: "合并落地：部署待办已登记", data: { ...pending },
  }, true);
  if (JSON.stringify(getDeployPending(db, intentId)) !== JSON.stringify(pending)) throw new LedgerError("conflict", "待办未持久登记，不能释放合并槽");
  settleIntent(db, ctx, { id: intentId, from: "submitted", to: "done", receipt: `merge:${pending.mergeSha}; deploy_pending:v1` });
}

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
/** The service's legacy settlement port. A detached merge is already done, with its permanent pending evidence. */
export async function settleMergedDeploy(db: Database, run: MergeRun, manager: Manager): Promise<void> {
  if (getIntent(db, run.intentId)?.status === "done" && getDeployPending(db, run.intentId)) return;
  const result = await manager("ledger", "scheduler-settle", run.intentId, "--from", "submitted", "--to", "done",
    "--receipt", `merge:${run.mergeSha}; 待 PM 部署`);
  if (result.ok !== true) throw new Error(`settle merge intent: ${String(result.error ?? "manager failed")}`);
}
