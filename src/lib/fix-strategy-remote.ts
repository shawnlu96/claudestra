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
import { reclaimForFamilySwap, resumedReclaimGate, retireReclaimedPeerAuthor } from "./lend-reclaim-scheduler.js";
import { remoteOrder, offerConvergence } from "./fix-strategy-remote-order.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { getLendPeer } from "./ledger-lend-peers.js";
import { FIX_STRATEGY_RULE } from "./fix-strategy.js";
import type { LedgerTask } from "./ledger-stages.js";
import { chunkInputs } from "./order-wire-chunks.js";
import { localWriterCount } from "./scheduler-pool-facts.js";
import { explicitLocal } from "./scheduler-local-pin.js";
import { localSwapAuthority, localSwapCreate, localSwapOf, localSwapReady, localSwapReclaimEdge, localSwapWait, reclaimedBefore, retireLocalAuthor } from "./recovery-fix-local-swap-run.js";
import type { LocalSwapEvidence } from "./recovery-fix-local-swap.js";
import { reclaimLocalFixEdge, reclaimLocalFixGate } from "./recovery-reclaim-local-fix.js";
import type { SwapGate, SwapHalt } from "./fix-strategy-guard.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import type { ForeignTreePort } from "./fix-strategy-worktree.js";
import { liveSessionAt } from "./fix-tree-proof.js";
import { selfHealMode, selfHealSample } from "./fix-swap-halfbuilt-sample.js";

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
  if (explicitLocal(task.extra)) {
    // A local-only card's convergence fix waits for this machine; a local refusal is never a reason to send it out.
    return waitForPeer(db, ctx, intent, material.family, `${material.family} 修复等待：本机：${localReason}；本卡固定本机（placement=local / localAuthorOnly），不外派`, context, deps);
  }
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

type AfterReclaim = { claim: string; bound: string; gate?: SwapGate };
const OTHER_FAMILY: AfterReclaim = { claim: "peer family swap", bound: "收回后新家族本机会话已绑定" };

/** The isolation gate an author tree had before the wrap: none = authorTree's own「缺旧作者停止执行门」refusal, word for word. */
const NO_STOP_GATE: SwapGate = () => ({ halted: "drift", reason: "缺旧作者停止执行门，不隔离" });

/**
 * SWAPFIX1 9a, shared by the local swap (fix-strategy-runtime.ts fixSwapStep) and the remote one (localAfterReclaim): the replacement
 * author's tree open may take over another old local author's clean tree at the target (fixLocalSwap, never on a manual card),
 * sampled once per card + head; the judgment itself is fix-tree-proof.ts's. The returned gate is `base` plus, once a tree was taken
 * over, the takeover's own permission read again synchronously at the create and bind edges: the switch still on and no live
 * session but this intent's own author in the tree (the tree's proof was taken before awaits that can outlive it). The takeover is
 * journaled on the intent (`tree-adopt`), so a later tick that skips the tree open (creating already claimed) still re-proves it
 * (round-2 P1 tree-adoption-resume); `bound` applies it to a created session right before the caller binds it (tree-final-proof).
 */
export function withForeignTree(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, deps: ConvergenceLifecycle,
  base?: SwapGate): { deps: ConvergenceLifecycle; gate?: SwapGate; adoption(): SwapHalt | null; bound<T extends object>(ref: T): T | { wait: string; tree: true } } {
  const open = deps.authorTree, head = intent.head;
  if (!open || !head) return { deps, gate: base, adoption: () => null, bound: (ref) => ref };
  const own = `agent-cv-${task.id.toLowerCase()}-fix-${intent.eventSeq}`; // createConvergenceWorker's name for this intent's author
  let adopted: string | null = null;
  const mode = () => getWorkflow(db, task.id)?.mode === "auto" ? selfHealMode(db, task.project, "fixLocalSwap") : "off";
  const foreign: ForeignTreePort = {
    mode,
    live: (dir) => liveSessionAt(deps.registry().filter((r) => r.name !== own), dir),
    sample: (at, dir) => {
      if (at === "on") { adopted = dir; convergenceEvent(db, ctx, intent, "tree-adopt", { dir }); }
      selfHealSample(db, at, { project: task.project, key: "fixLocalSwap", taskId: task.id, head, action: "tree-adopt",
        text: `收回旧树 ${dir}（干净、在本卡分支、HEAD 是已审修复 head、无活会话）交给新作者`, data: { intentId: intent.id, dir } }, ctx.now ?? Date.now());
    },
  };
  const adoption = (): SwapHalt | null => {
    const dir = adopted ?? getEventByDedup(db, `scheduler:${intent.id}:tree-adopt`)?.data.dir;
    if (typeof dir !== "string") return null;
    if (mode() !== "on") return { halted: "drift", reason: `fixLocalSwap 已不在 on，不把旧作者工作树 ${dir} 交给新作者` };
    const holder = foreign.live(dir);
    return holder ? { halted: "drift", reason: `旧作者工作树 ${dir} 已是活会话 ${holder} 的工作目录，不交给新作者` } : null;
  };
  // a created session is bound only while the takeover still holds; read with no await before the caller's bind
  const bound = <T extends object>(ref: T): T | { wait: string; tree: true } => {
    const halt = "sessionId" in ref ? adoption() : null;
    return halt ? { wait: halt.reason, tree: true } : ref;
  };
  const gate: SwapGate = (after) => base?.(after) ?? adoption();
  if (base?.stopWire !== undefined) gate.stopWire = base.stopWire;
  return { gate, adoption, bound, deps: { ...deps, artifactGate: deps.artifactGate ?? base ?? NO_STOP_GATE,
    authorTree: (source, target, recorded) => { adopted = null; return open(source, { ...target, foreign }, recorded); } } };
}

/** Both gates at one edge, the first refusal winning; the swap gate's stop wire rides on. */
function bothGates(a?: SwapGate, b?: SwapGate): SwapGate | undefined {
  if (!a || !b) return a ?? b;
  const gate: SwapGate = (after) => a(after) ?? b(after);
  if (a.stopWire !== undefined) gate.stopWire = a.stopWire;
  return gate;
}

/**
 * After the write lease is gone (one reclaim, never two): claim, build the local author with the material's family and bind it.
 * label.gate (no swap) is re-read at the create, bind and remote-fallback edges, the way a swap's localSwapGate / localSwapAuthority are.
 */
async function localAfterReclaim(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, material: Material, source: string,
  context: RemoteConvergenceContext, deps: ConvergenceLifecycle, swap: LocalSwapEvidence | null, label: AfterReclaim) {
  if (intent.status === "pending") settleIntent(db, ctx, { id: intent.id, from: "pending", to: "submitted", receipt: `claimed; ${label.claim}` });
  const late = swap && await localSwapReady(db, ctx, intent, swap, context, deps);
  if (late) return late;
  // every archive / kill / tree / create edge re-reads the switch and pins itself (localSwapGate / localSwapCreate)
  const retired: { wait: string } | { gate?: SwapGate } = swap ? await retireLocalAuthor(db, ctx, intent.id, swap, deps) : {};
  if ("wait" in retired) return { ok: true, step: "waiting", detail: retired.wait };
  const edge = swap && localSwapCreate(db, intent, swap, deps, retired.gate, () => ctx.now ?? Date.now(), source);
  // a resumed reclaim's gate (label.gate) rides the swap's create edge too; the tree takeover's permission rides both
  const tree = withForeignTree(db, ctx, intent, task, edge ? edge.lifecycle : deps, edge ? bothGates(edge.gate, label.gate) : label.gate);
  const local = localWriterCount(db, task.project, task.id) >= context.maxWorkers ? { wait: "本机写槽已满或不接新写者" }
    : await createConvergenceWorker(db, ctx, edge ? getIntent(db, intent.id)! : intent, mustTask(db, task.id), material.family, source, "author", tree.deps, tree.gate);
  if ("tree" in local) return { ok: true, step: "manual" in local ? "manual" : "waiting", detail: local.wait };
  if (swap && "wait" in local) return localSwapWait(db, ctx, intent, local.wait);
  const halt = swap && !("wait" in local) ? localSwapAuthority(db, mustTask(db, task.id), swap) : null;
  if (halt) return localSwapWait(db, ctx, intent, halt);
  // also before a refused local build falls back remote: a fresh peer order would take a held lease the switch no longer allows
  const drift = label.gate?.("stopped") ?? tree.adoption();
  if (drift) return { ok: true, step: "waiting", detail: drift.reason };
  if (!("wait" in local)) {
    bindFixReplacement(db, ctx, intent.id, local, material.path, deps.registryPath);
    settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "done", receipt: label.bound });
    return { ok: true, step: "session", detail: label.bound };
  }
  return remoteFixFallback(db, ctx, intent, material, deps, local.wait, context);
}

export async function remoteAuthorFix(db: Database, ctx: WriteCtx, intent: SchedulerIntent, deps: ConvergenceLifecycle, read: MaterialReader) {
  if (remoteOrder(db, intent.id)) return syncFix(db, ctx, intent, deps);
  const task = mustTask(db, intent.taskId), context = await remoteContext(db, task, deps); deps.active();
  if (!context.source) return { ok: true, step: "waiting", detail: "缺作者 checkout，不能准备远端修复材料" };
  const material = await read(db, ctx, intent, context.source, deps); deps.active();
  const evidence = getEventByDedup(db, `scheduler:${intent.id}:materials`)!.data;
  if (evidence.mode === "other_family") {
    // GATESWAP1: a fixLocalSwap takeover proves local readiness before the reclaim and the claim, and never falls back remote.
    const swap = localSwapOf(db, intent);
    const ready = swap && await localSwapReady(db, ctx, intent, swap, context, deps);
    if (ready) return ready;
    const skip = !!swap && !!reclaimedBefore(db, task);
    const wait = skip ? null : await reclaimForFamilySwap(db, ctx, intent.id, context, deps.active,
      swap ? () => localSwapReclaimEdge(db, ctx, intent, swap, context, deps) : undefined);
    if (wait) return { ok: true, step: "waiting", detail: wait };
    // SWAPFIX1 9b: no reclaim of this intent's own = it resumed an earlier one, whose every fact is read again at create and bind
    const resumed = skip ? undefined : resumedReclaimGate(db, ctx, intent.id);
    return localAfterReclaim(db, ctx, intent, task, material, context.source, context, deps, swap, resumed ? { ...OTHER_FAMILY, gate: resumed } : OTHER_FAMILY);
  }
  if (!heldLease(db, task)) {
    const gate = reclaimLocalFixGate(db, ctx, intent, task, material.family);
    if (!gate.act) throw new LedgerError("conflict", `原作者在peer但缺held写租约，不另派写者${gate.why}`);
    retireReclaimedPeerAuthor(db, ctx, intent.id, task.id); // the lease is already gone: never reclaim a second time
    return localAfterReclaim(db, ctx, intent, task, material, context.source, context, deps, null,
      { claim: "reclaimed same-family fix", bound: "收回后同家族本机会话已绑定", gate: reclaimLocalFixEdge(db, task.id, gate.reclaim.seq) });
  }
  return remoteFixFallback(db, ctx, intent, material, deps, "原作者在peer，同家族换新单派回租约方", context);
}
