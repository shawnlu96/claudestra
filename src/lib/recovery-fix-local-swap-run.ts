/**
 * fixLocalSwap's runtime half: what the CONV2 materials step, the reclaim authority and every later effect edge read. The intent was
 * planned on a live fact; from the materials event on, the pinned evidence (round, head, spec, source peer, families) plus the switch
 * must still hold, so a takeover never outlives its trigger and an off / observe switch stops the next effect: the switch and pins are
 * read synchronously at the archive / kill / tree / create edges themselves (localSwapGate, localSwapLifecycle), and the trigger
 * itself once more inside the reclaim's transactions (localSwapTrigger). Local refusals wait with one journaled reason per reason;
 * nothing here sends the material out again. tests/recovery-fix-local-swap*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { isLocalSwapIntent, localQuotaRefusal, localSwapMode, localSwapPorts, priorLocalReclaim, remoteHeadPeer, type GitSync, type LocalSwapEvidence } from "./recovery-fix-local-swap.js";
import { statePath } from "./paths.js";
import { git, type Git } from "./scheduler-review-worktree.js";
import { fixTreePath } from "./fix-strategy-worktree.js";
import { retryWorktreeDirty, retryWorktreeDirtySync } from "./scheduler-create-retry-worktree.js";

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
  if (remoteHeadPeer(db, task) !== ev.peer) return `当前 head 不是原作者 ${ev.peer} 交付的，不接手`;
  const lease = heldLease(db, task);
  const events = listEvents(db, { project: task.project, target: task.id });
  if (lease ? lease.peer !== ev.peer : !priorLocalReclaim(events, task)) {
    return lease ? `写租约已转到 ${lease.peer}（不是原作者 ${ev.peer}），不接手、不覆盖` : "写租约不在原作者 peer 上且没有本链的正式收回证据，不接手";
  }
  return null;
}

/**
 * The reclaim's trigger re-read (review r1 trigger-expired): the live fact must still be the one the evidence froze — same source,
 * window, clock start, material and peer, ripe under on. The returned check is synchronous, so the reclaim calls it inside its own
 * transactions after every await (remote head, clean-stop wait). A chain past its own reclaim is not re-judged: the lease is no
 * longer the peer's and the takeover continues on the post-reclaim authority (localSwapAuthority) alone.
 */
export async function localSwapTrigger(db: Database, task: LedgerTask, ev: LocalSwapEvidence, context: RemoteConvergenceContext,
  now: () => number): Promise<() => string | null> {
  const { autoSnapshot } = await import("./scheduler-auto-snapshot.js");
  return () => {
    const t = mustTask(db, task.id);
    if (priorLocalReclaim(listEvents(db, { project: t.project, target: t.id }), t)) return null;
    const f = autoSnapshot(db, t, { registry: [], maxWorkers: context.maxWorkers, now: now(),
      pool: context.remote ? { remote: context.remote, borrow: [...context.borrow] } : undefined }).localSwap;
    const c = f?.candidate;
    if (!f || !c || !f.ripe || f.mode !== "on") return `本机接手触发已失效，不收回：${f?.why ?? "没有候选"}`;
    if (c.source !== ev.source || c.window !== ev.window || c.sinceSeq !== ev.sinceSeq || c.material !== ev.material || c.peer !== ev.peer) {
      return "本机接手触发已变（来源 / 窗口 / 计时起点 / 材料 / peer 与冻结证据不同），不收回";
    }
    return null;
  };
}

/**
 * The edge gate the CONV2 retire and create steps call synchronously right before archive, kill, the kill receipt and create
 * (review r1 policy-edge): the switch and pins first, then CONV2's own swap gate (its stopWire travels on to the manager child).
 */
export function localSwapGate(db: Database, intent: SchedulerIntent, ev: LocalSwapEvidence, base?: SwapGate, extra?: () => string | null): SwapGate {
  const gate: SwapGate = (after) => {
    const why = localSwapAuthority(db, mustTask(db, intent.taskId), ev) ?? extra?.() ?? null;
    return why ? { halted: "drift", reason: why } : base?.(after) ?? null;
  };
  if (base?.stopWire !== undefined) gate.stopWire = base.stopWire;
  return gate;
}

/**
 * CONV2's lifecycle and create gate for this takeover: createConvergenceWorker asks localFamilyWait first and synchronously runs on
 * to the author tree, so the switch and pins read there are the tree's own edge. The positive quota proof is read again once the
 * author tree returns (review r2 quota-edge: the last await before the create), and the create edge's synchronous gate refuses on
 * it; the same gate then re-proves the opened author tree synchronously (review r3 dirty-preflight), so neither proof is a sample
 * taken before the other one's await. Nothing else of the lifecycle changes.
 */
export function localSwapCreate(db: Database, intent: SchedulerIntent, ev: LocalSwapEvidence, deps: ConvergenceLifecycle,
  base: SwapGate | undefined, now: () => number, source: string | null): { lifecycle: ConvergenceLifecycle; gate: SwapGate } {
  let quota: string | null = "本机额度尚未在作者工作树之后复核";
  const lifecycle: ConvergenceLifecycle = { ...deps,
    localFamilyWait: (task, family) => localSwapAuthority(db, mustTask(db, task.id), ev) ?? deps.localFamilyWait?.(task, family) ?? null,
    authorTree: deps.authorTree && (async (source, target, recorded) => {
      const tree = await deps.authorTree!(source, target, recorded);
      quota = await localQuotaRefusal(db, intent.project, ev.family, now());
      return tree;
    }) };
  const gate = localSwapGate(db, intent, ev, base, () => {
    const why = quota ?? treeProofSync(db, mustTask(db, intent.taskId), source, deps);
    return why && `本机接手等待（不外派）：${why}`;
  });
  return { lifecycle, gate };
}

/**
 * Read-only, before any reclaim or retirement (review r1 dirty-preflight): the canonical author tree, if present, has no edits and sits
 * at the reviewed head, and the source has no local card branch elsewhere — uncommitted or unpushed work is never taken over. The
 * tree step (fix-strategy-worktree.ts) re-checks at create; this only keeps a refusal from costing the peer its lease first.
 */
const real = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };

/**
 * The project main tree that owns `dir`, spelled the way the scheduler's dependency links name it (same reading as
 * fix-strategy-worktree.ts ownerRepo, which the adopt path passes): retryWorktreeDirty then exempts exactly those two links and
 * nothing else (review r2 dependency-links). No main tree = no exemption.
 */
async function treeOwner(g: Git, dir: string): Promise<string | undefined> {
  return ownerOf(dir, await g(["-C", dir, "worktree", "list", "--porcelain"]));
}

function ownerOf(dir: string, list: { code: number; out: string }): string | undefined {
  const first = list.code === 0 ? list.out.trim().split("\n\n")[0].split("\n") : [];
  const main = first[0]?.startsWith("worktree ") && !first.includes("bare") ? first[0].slice(9) : undefined;
  if (!main) return undefined;
  for (const [sub, up] of [["node_modules", 1], [join("web", "node_modules"), 2]] as const) {
    const dest = join(dir, sub);
    let to: string;
    try { to = resolve(dirname(dest), readlinkSync(dest)); } catch { continue; }
    let repo = to;
    for (let i = 0; i < up; i++) repo = dirname(repo);
    if (resolve(repo, sub) === to && real(repo) === real(main)) return repo;
  }
  return main;
}

async function treeRefusal(db: Database, task: LedgerTask, source: string | null, deps: ConvergenceLifecycle): Promise<string | null> {
  const g = localSwapPorts(db).git ?? git;
  const dir = fixTreePath(deps.worktreeRoot ?? statePath("worktrees"), task.id);
  if (!dir) return "卡号不能安全映射到作者工作树目录";
  if (existsSync(dir)) {
    const dirty = await retryWorktreeDirty(g, dir, await treeOwner(g, dir));
    if (dirty) return dirty;
    const sha = await g(["-C", dir, "rev-parse", "--verify", "HEAD"]);
    if (sha.code !== 0) return `作者工作树 ${dir} 读不了 HEAD，保留等待核对`;
    if (sha.out !== task.headSHA) return `作者工作树 ${dir} 在 ${sha.out.slice(0, 12)}，不是已审修复 head（可能有未推送成果），保留等待核对`;
  }
  if (source && task.branch) {
    const local = await g(["-C", source, "rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`]);
    if (local.code === 0 && local.out && local.out !== task.headSHA) {
      return `本地分支 ${task.branch} 在 ${local.out.slice(0, 12)}，不是已审修复 head（可能有未推送成果），保留等待核对`;
    }
  }
  return null;
}

const spawnGit: GitSync = (args) => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.exitCode === 0 ? r.stdout.toString() : r.stderr.toString().trim() };
};

/**
 * The commit-edge author-tree proof (review r3 dirty-preflight / quota-edge): no await at all, so the reclaim transaction and the
 * create gate read it at the very point they act, after the quota proof's await. The canonical complete dirty proof runs
 * synchronously here as well: ignored files, disk/blob changes, hidden index flags and submodules cannot bypass the edge.
 */
export function treeProofSync(db: Database, task: LedgerTask, source: string | null, deps: ConvergenceLifecycle): string | null {
  const g = localSwapPorts(db).gitSync ?? spawnGit;
  const dir = fixTreePath(deps.worktreeRoot ?? statePath("worktrees"), task.id);
  if (!dir) return "卡号不能安全映射到作者工作树目录";
  if (existsSync(dir)) {
    const owner = ownerOf(dir, g(["-C", dir, "worktree", "list", "--porcelain"]));
    const dirty = retryWorktreeDirtySync((args) => {
      const r = g(args);
      return { ...r, out: r.out.endsWith("\0") ? r.out : r.out.trim() };
    }, dir, owner);
    if (dirty) return dirty;
    const sha = g(["-C", dir, "rev-parse", "--verify", "HEAD"]);
    if (sha.code !== 0) return `作者工作树 ${dir} 读不了 HEAD，保留等待核对`;
    if (sha.out.trim() !== task.headSHA) return `作者工作树 ${dir} 在 ${sha.out.trim().slice(0, 12)}，不是已审修复 head（可能有未推送成果），保留等待核对`;
  }
  if (source && task.branch) {
    const local = g(["-C", source, "rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`]);
    const at = local.out.trim();
    if (local.code === 0 && at && at !== task.headSHA) {
      return `本地分支 ${task.branch} 在 ${at.slice(0, 12)}，不是已审修复 head（可能有未推送成果），保留等待核对`;
    }
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

/**
 * One journaled event per distinct reason (dedup on the intent), then the same wait text every pass. The create edge's refusal is
 * journaled by CONV2's own wait (fix-strategy-lifecycle.ts, `wait:<hash>`) with the same text; that one counts too.
 */
function waitOnce(db: Database, ctx: WriteCtx, intent: SchedulerIntent, reason: string): { ok: true; step: "waiting"; detail: string } {
  const hash = createHash("sha256").update(reason).digest("hex").slice(0, 16), key = `local-swap-wait:${hash}`;
  if (!getEventByDedup(db, `scheduler:${intent.id}:${key}`) && !getEventByDedup(db, `scheduler:${intent.id}:wait:${hash}`)) {
    convergenceEvent(db, ctx, intent, key, { reason });
  }
  return { ok: true, step: "waiting", detail: reason };
}

/**
 * Before the reclaim, before the claim and again before the retirement and create: switch and pins, the family's local write
 * authorization, a live local writer slot, no file-lock conflict, a positive quota proof and, until this chain's own create begins, a
 * clean author tree (treeRefusal) — an earlier reclaim receipt never skips it (review r2 dirty-preflight). Any refusal waits locally;
 * it is never a reason to go remote.
 */
export async function localSwapReady(db: Database, ctx: WriteCtx, intent: SchedulerIntent, ev: LocalSwapEvidence,
  context: RemoteConvergenceContext, deps: ConvergenceLifecycle): Promise<{ ok: true; step: "waiting"; detail: string } | null> {
  const task = mustTask(db, intent.taskId);
  const why = localSwapAuthority(db, task, ev) ?? deps.localFamilyWait?.(task, ev.family) ??
    (localWriterCount(db, task.project, task.id) >= context.maxWorkers ? "本机写槽已满或不接新写者" : null) ??
    (locksBusy(db, task) ? "文件锁被别的卡占着" : null) ?? await localQuotaRefusal(db, task.project, ev.family, ctx.now ?? Date.now()) ??
    (getEventByDedup(db, `scheduler:${intent.id}:creating`) ? null : await treeRefusal(db, task, context.source, deps));
  deps.active();
  return why ? waitOnce(db, ctx, intent, `本机接手等待（不外派）：${why}`) : null;
}

/**
 * The reclaim's last awaited edge (review r2 / r3 dirty-preflight / quota-edge): once the remote head is read, the awaited author-tree
 * proof, then the positive quota proof as the very last await; what returns is the synchronous author-tree proof the reclaim
 * transaction re-reads at its commit point (treeProofSync), so a quota lapse during the tree's git and a write during the quota
 * read both refuse before the lease moves. A refusal is the same journaled local wait as localSwapReady's.
 */
export async function localSwapReclaimEdge(db: Database, ctx: WriteCtx, intent: SchedulerIntent, ev: LocalSwapEvidence,
  context: RemoteConvergenceContext, deps: ConvergenceLifecycle): Promise<string | (() => string | null)> {
  const task = mustTask(db, intent.taskId);
  const wait = (why: string) => waitOnce(db, ctx, intent, `本机接手等待（不外派）：${why}`).detail;
  const why = await treeRefusal(db, task, context.source, deps) ?? await localQuotaRefusal(db, task.project, ev.family, ctx.now ?? Date.now());
  deps.active();
  if (why) return wait(why);
  return () => {
    const late = treeProofSync(db, mustTask(db, intent.taskId), context.source, deps);
    return late && wait(late);
  };
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
 * retires one: archive, then a gated stop, each on its own pass; the returned gate re-checks the switch, pins and stop before create
 * and bind. With no local author to retire the gate is the switch and pins alone (localSwapGate).
 */
export async function retireLocalAuthor(db: Database, ctx: WriteCtx, id: string, ev: LocalSwapEvidence, deps: ConvergenceLifecycle): Promise<{ wait: string } | { gate: SwapGate }> {
  const intent = convergenceIntent(db, ctx, id, "fix_swap"), row = getSchedulerSession(db, intent.taskId, "author");
  if (!row || row.state === "retired" || row.transport === "peer") return { gate: localSwapGate(db, intent, ev) };
  const gate = localSwapGate(db, intent, ev, swapGate(db, intent, row, deps.registry));
  const wait = await stopConvergenceAuthor(db, ctx, intent, { ...row, role: "author" }, deps, gate);
  return wait ? { wait } : { gate };
}
