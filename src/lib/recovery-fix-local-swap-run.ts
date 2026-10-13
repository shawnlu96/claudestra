/**
 * fixLocalSwap's runtime half: what the CONV2 materials step, the reclaim authority and every later effect edge read. The intent was
 * planned on a live fact; from the materials event on, the pinned evidence (round, head, spec, source peer, families) plus the switch
 * must still hold, so a takeover never outlives its trigger and an off / observe switch stops the next effect. Local refusals wait
 * with one journaled reason per reason; nothing here sends the material out again. tests/recovery-fix-local-swap*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import { getWorkflow, resourceKey, resourcesOverlap, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { heldLease } from "./ledger-lend-lease.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { FixStrategy } from "./fix-strategy.js";
import type { ReviewFacts } from "./scheduler-review.js";
import { convergenceEvent, stopConvergenceAuthor, type ConvergenceLifecycle } from "./fix-strategy-lifecycle.js";
import { swapGate, type SwapGate } from "./fix-strategy-guard.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { convergenceIntent } from "./fix-strategy-remote-intent.js";
import type { RemoteConvergenceContext } from "./fix-strategy-remote-context.js";
import { localWriterCount } from "./scheduler-pool-facts.js";
import { isLocalSwapIntent, localQuotaRefusal, localSwapMode, priorLocalReclaim, type LocalSwapEvidence } from "./recovery-fix-local-swap.js";

export const localSwapEvidenceOf = (db: Database, intentId: string): LocalSwapEvidence | null =>
  (getEventByDedup(db, `scheduler:${intentId}:materials`)?.data.localSwap as LocalSwapEvidence | undefined) ?? null;

/**
 * The pinned evidence still holds now: the switch is on, the card is the same auto fix round on the same head and spec, the head is
 * still the peer family's, and the write lease is the original holder's (or this chain's own reclaim already ended it). null = holds.
 */
export function localSwapAuthority(db: Database, task: LedgerTask, ev: LocalSwapEvidence): string | null {
  if (localSwapMode(db, task.project) !== "on") return `fixLocalSwap 已切到 ${localSwapMode(db, task.project)}，停在下一副作用前`;
  if (getWorkflow(db, task.id)?.mode !== "auto") return "卡已不在 auto（PM 接管或 manual），不接手";
  if (task.stage !== "fix" || task.round !== ev.round || task.specRev !== ev.specRev || task.headSHA !== ev.head) return "卡的阶段 / 轮次 / 规格 / head 已变，旧接手计划失效";
  if (remoteHeadFamily(db, task) !== ev.fromFamily) return "当前 head 的作者家族已不是触发时的 peer 家族";
  const lease = heldLease(db, task);
  const events = listEvents(db, { project: task.project, target: task.id });
  if (lease ? lease.peer !== ev.peer : !priorLocalReclaim(events, task)) {
    return lease ? `写租约已转到 ${lease.peer}（不是原作者 ${ev.peer}），不接手、不覆盖` : "写租约不在原作者 peer 上且没有本链的正式收回证据，不接手";
  }
  return null;
}

/** Materials-time strategy: the live fact (planned under on) or, once frozen, the pinned evidence; never a faked streak. */
export async function localSwapStrategy(db: Database, intent: SchedulerIntent, task: LedgerTask, facts: ReviewFacts,
  context: () => Promise<RemoteConvergenceContext>, now: number): Promise<FixStrategy & { evidence: LocalSwapEvidence }> {
  const frozen = localSwapEvidenceOf(db, intent.id);
  let ev = frozen;
  if (!ev) {
    const c = await context();
    const { autoSnapshot } = await import("./scheduler-auto-snapshot.js");
    const snap = autoSnapshot(db, task, { registry: [], maxWorkers: c.maxWorkers, now, pool: c.remote ? { remote: c.remote, borrow: c.borrow } : undefined });
    const f = snap.localSwap;
    if (!f?.candidate || !f.ripe || f.mode !== "on") throw new LedgerError("conflict", `本机接手条件不再成立：${f?.why ?? "没有候选"}`);
    ev = f.candidate;
  }
  if (intent.head !== ev.head) throw new LedgerError("conflict", "本机接手意图的 head 与触发证据不符");
  const why = localSwapAuthority(db, task, ev);
  if (why) throw new LedgerError("conflict", why);
  const findings = facts.findings.filter((f) => f.severity === "P1" && ev!.findings.some((x) => x.findingId === f.findingId));
  if (!findings.length) throw new LedgerError("conflict", "触发证据里的 P1 不在当前有效审查里");
  return { mode: "other_family", family: ev.family, findings: findings.map((finding) => ({ finding, streak: 1 })), evidence: ev };
}

function locksBusy(db: Database, task: LedgerTask): boolean {
  const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string").map(resourceKey) : [];
  const held = db.query("SELECT resource FROM scheduler_resources WHERE project = ? AND taskId != ?").all(task.project, task.id) as { resource: string }[];
  return globs.includes(null) || held.some((h) => globs.some((g) => resourcesOverlap(g!, h.resource)));
}

/** One journaled event per distinct reason (dedup on the intent), then the same wait text every pass. */
function waitOnce(db: Database, ctx: WriteCtx, intent: SchedulerIntent, reason: string): { ok: true; step: "waiting"; detail: string } {
  const key = `local-swap-wait:${createHash("sha256").update(reason).digest("hex").slice(0, 16)}`;
  if (!getEventByDedup(db, `scheduler:${intent.id}:${key}`)) convergenceEvent(db, ctx, intent, key, { reason });
  return { ok: true, step: "waiting", detail: reason };
}

/**
 * Before the reclaim, before the claim and again before the create: switch and pins, the family's local write authorization, a live
 * local writer slot, no file-lock conflict and a positive quota proof. Any refusal waits locally; it is never a reason to go remote.
 */
export async function localSwapReady(db: Database, ctx: WriteCtx, intent: SchedulerIntent, ev: LocalSwapEvidence,
  context: RemoteConvergenceContext, deps: ConvergenceLifecycle): Promise<{ ok: true; step: "waiting"; detail: string } | null> {
  const task = mustTask(db, intent.taskId);
  const why = localSwapAuthority(db, task, ev) ?? deps.localFamilyWait?.(task, ev.family) ??
    (localWriterCount(db, task.project, task.id) >= context.maxWorkers ? "本机写槽已满或不接新写者" : null) ??
    (locksBusy(db, task) ? "文件锁被别的卡占着" : null) ?? await localQuotaRefusal(db, task.project, ev.family, ctx.now ?? Date.now());
  deps.active();
  return why ? waitOnce(db, ctx, intent, `本机接手等待（不外派）：${why}`) : null;
}

/** A local create that waits stays local: journaled once, never remoteFixFallback. */
export const localSwapWait = (db: Database, ctx: WriteCtx, intent: SchedulerIntent, reason: string) =>
  waitOnce(db, ctx, intent, `本机接手等待（不外派）：${reason}`);

/** Whether this intent is a fixLocalSwap one with frozen evidence (the materials step ran). */
export const localSwapOf = (db: Database, intent: SchedulerIntent): LocalSwapEvidence | null =>
  isLocalSwapIntent(intent) ? localSwapEvidenceOf(db, intent.id) : null;

/** A scheduler reclaim of this round by an earlier attempt of this chain: the new attempt resumes after it, never reclaims twice. */
export const reclaimedBefore = (db: Database, task: LedgerTask): LedgerEvent | null =>
  priorLocalReclaim(listEvents(db, { project: task.project, target: task.id }), task);


/**
 * The card's still-bound local author (the restate-time session the peer write replaced) is retired the way CONV2's local swap
 * retires one: archive, then a gated stop, each on its own pass; the returned gate re-checks the stop before create and bind.
 */
export async function retireLocalAuthor(db: Database, ctx: WriteCtx, id: string, deps: ConvergenceLifecycle): Promise<{ wait: string } | { gate?: SwapGate }> {
  const intent = convergenceIntent(db, ctx, id, "fix_swap"), row = getSchedulerSession(db, intent.taskId, "author");
  if (!row || row.state === "retired" || row.transport === "peer") return {};
  const gate = swapGate(db, intent, row, deps.registry);
  const wait = await stopConvergenceAuthor(db, ctx, intent, { ...row, role: "author" }, deps, gate);
  return wait ? { wait } : { gate };
}
