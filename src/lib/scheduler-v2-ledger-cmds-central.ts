import type { Database } from "bun:sqlite";
import { getIntent, getWorkflow, resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import { getEventByDedup, getTask, LedgerError, toEvent } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { parseCommand, parseReceipt, parseResource, v2ObjectDigest, fail, type V2Command, type V2ResourceKey } from "./shared-ledger-contract-v2.js";
import { schedulerV2LedgerFlags, type SchedulerV2LedgerCall } from "./scheduler-v2-ledger-cmds-args.js";
import type { SchedulerV2LedgerContext, SchedulerV2LedgerPort } from "./scheduler-v2-ledger-cmds.js";

const planFlags = ["id", "rev", "workflow-rev", "seq", "node", "action", "recipient", "reason", "resources"];
type ResourceRow = { resource: string; acquiredAt: number; scope: string };

function projectedResources(db: Database, context: SchedulerV2LedgerContext, task: LedgerTask, intentId: string): V2ResourceKey[] {
  const rows = db.query("SELECT resource, acquiredAt, scope FROM scheduler_resources WHERE intentId = ? ORDER BY resource").all(intentId) as ResourceRow[];
  return rows.map(row => {
    const raw: unknown = JSON.parse(row.resource);
    const key = Array.isArray(raw) ? {
      teamId: raw[0], projectId: raw[1], repository: raw[2], kind: raw[3], ...(raw[3] === "file" ? { path: raw[4] } : {}),
    } : raw;
    return parseResource({ key, taskId: task.id, intentId, operationId: intentId, ...context.fence,
      scope: row.scope, state: "held", acquiredAt: row.acquiredAt }).key;
  });
}

function planVersions(db: Database, task: LedgerTask, p: ReturnType<typeof schedulerV2LedgerFlags>): void {
  const workflow = getWorkflow(db, task.id);
  const seq = (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(task.project) as { seq: number }).seq;
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev
    || p.integer("rev") !== task.rev || p.integer("workflow-rev") !== workflow.rev || p.integer("seq") !== seq) {
    throw new LedgerError("conflict", "任务、流程或项目事件已前进");
  }
  p.need("reason");
  const live = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND id != ? AND status IN ('pending','submitted','unknown')")
    .get(task.id, p.need("id"));
  if (live) throw new LedgerError("conflict", "任务已有未结调度意图");
  const proposed = p.flags.resources?.split(",").map(value => resourceKey(value.trim())) ?? [];
  if (proposed.includes(null)) throw new LedgerError("invalid", "资源名不合法");
  const held = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ?").all(task.project) as { resource: string; taskId: string }[];
  if (held.some(row => row.taskId !== task.id && proposed.some(key => resourcesOverlap(key!, row.resource)))) {
    throw new LedgerError("conflict", "本机资源被其他卡占用");
  }
}

/** Build only X0 commands. Snapshot data and proposal translation come from the trusted injection, never a worker reply. */
function commandFor(db: Database, port: SchedulerV2LedgerPort, context: SchedulerV2LedgerContext,
  task: LedgerTask, call: SchedulerV2LedgerCall, args: readonly string[]): V2Command | null {
  const workflow = getWorkflow(db, task.id), intent = call.intentId ? getIntent(db, call.intentId) : null;
  const versions = { taskId: task.id, expectedRev: task.rev, expectedSpecRev: task.specRev, expectedWorkflowRev: workflow?.rev };
  const id = call.command === "scheduler-plan" ? schedulerV2LedgerFlags(args, planFlags).need("id") : intent?.id;
  const data = id ? getEventByDedup(db, `scheduler:${id}`)?.data ?? {} : {};
  const authorization = { authorizationAskId: data.authorizationAskId ?? null, authorizationDigest: data.authorizationDigest ?? null };
  let type: V2Command["type"], payload: unknown;
  if (call.command === "scheduler-plan") {
    const p = schedulerV2LedgerFlags(args, planFlags);
    planVersions(db, task, p);
    const snapshot = port.planData?.(task.project, task.id, id!, p.flags.resources?.split(",").map(value => value.trim()) ?? []);
    const dependencyDigest = data.dependencyDigest ?? snapshot?.dependencyDigest;
    const resources = snapshot?.resources ?? projectedResources(db, context, task, id!);
    if (p.flags.resources && !snapshot) return null;
    type = "intent.create";
    payload = { ...versions, action: p.need("action"), node: p.need("node"), operationId: id,
      head: task.headSHA, round: task.round, dependencyDigest, ...authorization, resources };
  } else if (call.command === "scheduler-settle") {
    const p = schedulerV2LedgerFlags(args, ["from", "to", "receipt"]), from = p.need("from"), to = p.need("to");
    if (!intent || intent.status !== from) throw new LedgerError("conflict", "意图状态已前进");
    const transitions: Record<string, string[]> = { pending: ["submitted", "unknown", "cancelled"], submitted: ["done", "unknown", "cancelled"] };
    if (from === "unknown" || !(transitions[from] ?? []).includes(to)) {
      throw new LedgerError("forbidden", "调度服务不能结算结果不明的意图或此状态转换");
    }
    if (to === "submitted") {
      type = "intent.check";
      payload = { ...versions, intentId: id, operationId: id, ...authorization };
    } else if (to === "cancelled") {
      type = "intent.cancel";
      payload = { ...versions, intentId: id, operationId: id, reason: p.flags.receipt ?? intent.reason };
    } else {
      type = "operation.result";
      payload = { result: { teamId: context.teamId, projectId: context.projectId, ...context.fence,
        operationId: id, intentId: id, taskId: task.id, state: to === "done" ? "succeeded" : "unknown", head: intent.head,
        approvalAskId: authorization.authorizationAskId, summary: p.flags.receipt ?? intent.receipt ?? "", artifactIds: [], observedAt: intent.updatedAt } };
    }
  } else {
    const p = schedulerV2LedgerFlags(args, call.command === "verify" ? ["dedup", "evidence", "waive", "text"] : ["to", "max-workers"],
      call.command === "verify" ? ["dry-run"] : []);
    if (call.command === "verify" && task.stage !== "live") throw new LedgerError("invalid", "任务不在 live，不能进 verified");
    type = "task.stage";
    payload = { ...versions, from: task.stage, to: call.command === "verify" ? "verified" : p.need("to"),
      round: task.round, authorizationAskId: authorization.authorizationAskId };
  }
  try {
    return parseCommand({ teamId: context.teamId, projectId: context.projectId, ...context.fence,
      requestId: `s2q:${v2ObjectDigest({ type, taskId: task.id, id, payload })}`, type, payload });
  } catch {
    // Incomplete or unmappable snapshot fields cannot authorize a center request; hold the card for S2F/PM.
    return null;
  }
}

/** Receipt confirmation precedes projection sync; every success row is reread from that projection. */
export async function schedulerV2LedgerCentral(db: Database, port: SchedulerV2LedgerPort, context: SchedulerV2LedgerContext,
  task: LedgerTask, call: SchedulerV2LedgerCall, args: readonly string[], held: () => Record<string, unknown>): Promise<Record<string, unknown>> {
  const fence = port.fence(task.featureId ?? task.extra.sharedFeatureId as string);
  if (!fence) return { ok: false, code: "lease_lost" };
  if (v2ObjectDigest(fence) !== v2ObjectDigest(context.fence)
    || context.serviceGeneration !== fence.serviceGeneration || context.bootId !== fence.bootId) return { ok: false, code: "stale_epoch" };
  let verification: Record<string, unknown> | undefined;
  if (call.command === "verify") {
    const p = schedulerV2LedgerFlags(args, ["dedup", "evidence", "waive", "text"], ["dry-run"]);
    if (p.flags.waive) throw new LedgerError("forbidden", "调度服务不可豁免检查");
    if (!port.verify) return held();
    verification = await port.verify(task, args);
    if (p.switches.has("dry-run")) return { ...verification, dryRun: true, task: task.id };
    if (verification.ok !== true || verification.result !== "pass") {
      return { ...verification, ok: false, code: verification.code ?? "unverified", moved: false, task };
    }
  }
  const client = port.clientFor(task.project);
  if (!client) return held();
  const duplicate = call.command === "scheduler-plan" && !!getIntent(db, schedulerV2LedgerFlags(args, planFlags).need("id"));
  let command: V2Command | null;
  try { command = commandFor(db, port, context, task, call, args); }
  catch (error) {
    if (error instanceof LedgerError) throw error;
    return held(); // Corrupt/missing projected resource metadata must not be sent as a different resource grant.
  }
  if (!command) return held();
  const currentFence = port.fence(task.featureId ?? task.extra.sharedFeatureId as string);
  if (port.route(task.id) !== "central") return held();
  if (!currentFence) return { ok: false, code: "lease_lost" };
  if (v2ObjectDigest(currentFence) !== v2ObjectDigest(context.fence)) return { ok: false, code: "stale_epoch" };
  const receipt = parseReceipt(await client.command(command));
  if (receipt.requestId !== command.requestId || receipt.command !== command.type || receipt.commandDigest !== v2ObjectDigest(command)
    || receipt.teamId !== command.teamId || receipt.projectId !== command.projectId || receipt.serviceGeneration !== command.serviceGeneration
    || receipt.result.epoch !== command.epoch) fail("dedup_mismatch");
  const operationId = "operationId" in command.payload ? command.payload.operationId
    : "result" in command.payload ? command.payload.result.operationId : null;
  if (receipt.result.operationId !== operationId) fail("dedup_mismatch");
  await port.sync(task.project, task.featureId ?? task.extra.sharedFeatureId as string);
  if (call.command === "scheduler-plan" || call.command === "scheduler-settle") {
    const id = call.command === "scheduler-plan" ? schedulerV2LedgerFlags(args, planFlags).need("id") : call.intentId!;
    const projected = getIntent(db, id);
    if (!projected) return held();
    return { ok: true, intent: projected, ...(call.command === "scheduler-plan" ? { duplicate } : {}) };
  }
  const projected = getTask(db, task.id);
  if (!projected) return held();
  if (call.command !== "verify") return { ok: true, task: projected, duplicate: false };
  const event = db.query("SELECT * FROM events WHERE target=? AND json_extract(data, '$.op')='center-projection' ORDER BY seq DESC LIMIT 1")
    .get(task.id) as Record<string, unknown> | null;
  if (!event) return held();
  return { ...verification, ok: true, moved: true, task: projected, event: toEvent(event), duplicate: false };
}
