/** Family swaps keep one convergence intent alive until remote delivery, preventing ordinary dispatch from duplicating the order. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import type { SchedulerIntent, AuthorFamily } from "./ledger-scheduler.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { convergenceEvent, createConvergenceWorker, type ConvergenceLifecycle } from "./fix-strategy-lifecycle.js";
import { bindFixReplacement } from "./scheduler-sessions.js";
import { remoteContext, convergencePlacement, type RemoteConvergenceContext } from "./fix-strategy-remote-context.js";
import { placeFor } from "./scheduler-family-pick.js";
import { heldLease, writeOrderWire, lastReviewOf } from "./ledger-lend-lease.js";
import { reclaimForFamilySwap } from "./lend-reclaim-scheduler.js";
import { remoteOrder, offerConvergence } from "./fix-strategy-remote-order.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { getLendPeer } from "./ledger-lend-peers.js";
import { FIX_STRATEGY_RULE } from "./fix-strategy.js";
import type { LedgerTask } from "./ledger-stages.js";
import { chunkInputs } from "./order-wire-chunks.js";
import { localWriterCount } from "./scheduler-pool-facts.js";

type Material = { path: string; family: AuthorFamily };
type MaterialReader = (db: Database, ctx: WriteCtx, intent: SchedulerIntent, source: string, deps: ConvergenceLifecycle) => Promise<Material>;

/** Only known historical commit coordinates get short refs; arbitrary hexadecimal report text still hits the secret gate. */
function shortHistoricalRefs(db: Database, task: LedgerTask, text: string): string {
  const heads = listEvents(db, { project: task.project, target: task.id }).flatMap((e) =>
    e.kind === "deliver" ? [e.data.headSHA] : e.kind === "review" ? [e.data.head] : []);
  for (const head of new Set(heads)) if (typeof head === "string" && head !== task.headSHA && /^[0-9a-f]{40}$/.test(head)) {
    text = text.split(head).join(head.slice(0, 12));
  }
  return text;
}

async function waitForPeer(db: Database, ctx: WriteCtx, intent: SchedulerIntent, family: AuthorFamily, reason: string,
  context: RemoteConvergenceContext, deps: ConvergenceLifecycle) {
  const key = `convergence-wait:${intent.taskId}:s${intent.specRev}:r${mustTask(db, intent.taskId).round}:${family}`;
  if (!getEventByDedup(db, key)) {
    try {
      await context.notify(reason); deps.active();
      tx(db, () => {
        if (!getEventByDedup(db, key)) insertEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: key },
          { project: intent.project, target: intent.taskId, kind: "scheduler", text: reason, data: { op: "convergence_wait", family, intentId: intent.id } }, true);
      });
    } catch (e) { console.warn(`convergence PM notice failed; will retry: ${(e as Error).message}`); }
  }
  return { ok: true, step: "waiting", detail: reason };
}

function strategyRecord(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, material: Material, peer: string): void {
  if (getEventByDedup(db, `scheduler:${intent.id}:remote-strategy`)) return;
  const evidence = getEventByDedup(db, `scheduler:${intent.id}:materials`)!.data;
  insertEvent(db, { ...ctx, dedupKey: `scheduler:${intent.id}:remote-strategy` }, { project: task.project, target: task.id,
    kind: "scheduler", text: "远端新修复单；先红后绿，交付写测试名", data: { op: "fix_strategy", intentId: intent.id,
      specRev: task.specRev, round: task.round, head: task.headSHA, mode: evidence.mode, family: material.family,
      material: material.path, findings: evidence.findings, peer } }, true);
  db.query("UPDATE task_workflows SET authorFamily = ?, rev = rev + 1, updatedAt = ? WHERE taskId = ?")
    .run(material.family, ctx.now ?? Date.now(), task.id);
}

async function syncFix(db: Database, ctx: WriteCtx, intent: SchedulerIntent, deps: ConvergenceLifecycle) {
  const o = remoteOrder(db, intent.id)!;
  if (o.status === "done") {
    convergenceEvent(db, ctx, intent, "replacement", { orderId: o.orderId, family: o.family, peer: o.peer });
    settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "done", receipt: "远端新修复会话已交付" });
    return { ok: true, step: "session", detail: "远端新修复会话已交付" };
  }
  if (o.status === "unknown") {
    settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "unknown", receipt: "远端修复租约过期，交PM核对" });
  } else if (["cancelled", "released"].includes(o.status)) {
    const context = await remoteContext(db, mustTask(db, intent.taskId), deps); deps.active();
    return waitForPeer(db, ctx, intent, o.family, `${o.family} 修复等待：${o.peer} 已${o.status}（${o.reason ?? "未给原因"}）；保留绑定单和材料，交PM核对`, context, deps);
  }
  return { ok: true, step: "waiting", detail: `远端修复单 ${o.orderId}：${o.status}` };
}

export async function remoteFixFallback(db: Database, ctx: WriteCtx, intent: SchedulerIntent, material: Material,
  deps: ConvergenceLifecycle, localReason: string, supplied?: RemoteConvergenceContext) {
  if (remoteOrder(db, intent.id)) return syncFix(db, ctx, intent, deps);
  const task = mustTask(db, intent.taskId), context = supplied ?? await remoteContext(db, task, deps); deps.active();
  const { facts, reasons } = convergencePlacement(db, task, context, material.family, "write", ctx.now ?? Date.now());
  const lease = heldLease(db, task);
  if (lease) facts.pin = `peer:${lease.peer}`;
  if (facts.remote) facts.remote = { ...facts.remote, writeFamilies: [material.family], localPriority: "off" };
  const placed = placeFor(facts, "write", material.family);
  if (placed.kind !== "peer" || !context.spec || !task.branch) {
    const why = `${material.family} 修复等待：本机：${localReason}；${reasons.join("；") || "没有借入peer"}；` +
      (!context.spec ? "缺规格原文" : !task.branch ? "缺本卡分支" : placed.reason);
    return waitForPeer(db, ctx, intent, material.family, why, context, deps);
  }
  const peer = placed.peer, fp = getLendPeer(db, peer)?.fp;
  if (!fp) return waitForPeer(db, ctx, intent, material.family, `${peer} 缺钉住的实例指纹`, context, deps);
  offerConvergence(db, ctx, intent, context, peer, material.family, (current, orderId) => {
    const history = readFileSync(material.path, "utf8"), previous = lastReviewOf(db, current);
    const wire = writeOrderWire(current, { orderId, step: "fix", head: current.headSHA!, branch: current.branch!, base: "main",
      spec: context.spec!, report: null, findings: previous.findings, repo: facts.repo!, pr: Number(current.pr?.match(/\/pull\/(\d+)/)?.[1]) || null });
    wire.inputs.push(...chunkInputs([["历轮报告、修复diff摘要、复现probe", shortHistoricalRefs(db, current, history)]]));
    wire.acceptance.push(FIX_STRATEGY_RULE);
    wire.convergence = { kind: "fix", intentId: intent.id, branch: current.branch!, peer, proto: 3, held: true };
    strategyRecord(db, ctx, intent, current, material, peer);
    return wire;
  });
  return { ok: true, step: "pooled", detail: `${material.family} 修复新单挂给 ${peer}` };
}

export const hasRemoteFix = (db: Database, id: string): boolean => !!remoteOrder(db, id);

export async function remoteAuthorFix(db: Database, ctx: WriteCtx, intent: SchedulerIntent, deps: ConvergenceLifecycle, read: MaterialReader) {
  if (remoteOrder(db, intent.id)) return syncFix(db, ctx, intent, deps);
  const task = mustTask(db, intent.taskId), context = await remoteContext(db, task, deps); deps.active();
  if (!context.source) return { ok: true, step: "waiting", detail: "缺作者 checkout，不能准备远端修复材料" };
  const material = await read(db, ctx, intent, context.source, deps); deps.active();
  const evidence = getEventByDedup(db, `scheduler:${intent.id}:materials`)!.data;
  if (evidence.mode === "other_family") {
    const wait = await reclaimForFamilySwap(db, ctx, intent.id, context, deps.active);
    if (wait) return { ok: true, step: "waiting", detail: wait };
    if (intent.status === "pending") settleIntent(db, ctx, { id: intent.id, from: "pending", to: "submitted", receipt: "claimed; peer family swap" });
    const local = localWriterCount(db, task.project, task.id) >= context.maxWorkers ? { wait: "本机写槽已满或不接新写者" }
      : await createConvergenceWorker(db, ctx, intent, mustTask(db, task.id), material.family, context.source, "author", deps);
    if ("tree" in local) return { ok: true, step: "waiting", detail: local.wait };
    if (!("wait" in local)) {
      bindFixReplacement(db, ctx, intent.id, local, material.path, deps.registryPath);
      settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "done", receipt: "收回后新家族本机会话已绑定" });
      return { ok: true, step: "session", detail: "收回后新家族本机会话已绑定" };
    }
    return remoteFixFallback(db, ctx, intent, material, deps, local.wait, context);
  }
  if (!heldLease(db, task)) throw new LedgerError("conflict", "原作者在peer但缺held写租约，不另派写者");
  return remoteFixFallback(db, ctx, intent, material, deps, "原作者在peer，同家族换新单派回租约方", context);
}
