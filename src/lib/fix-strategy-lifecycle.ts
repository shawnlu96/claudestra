import { readSchedulerConfig } from "./scheduler-config.js";
import { localFamilyRefusal } from "./scheduler-local-families-placement.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { CLAIM_LEASE_MS } from "./scheduler-dispatch.js";
/** Narrow lifecycle effects for convergence workers; every external effect is leased and journaled before proceeding. */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { resolveBunPath } from "./bun-path.js";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { statePath } from "./paths.js";
import { readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import { assertSchedulerLease } from "./scheduler-lease-env.js";
import { reviewSwapManagerEnv } from "./scheduler-review-swap-runtime.js";
import { archiveReceipt, killOutcome, readLiveAgents, type RetireDeps } from "./scheduler-retire.js";
import { git, openReviewWorktree, type Git, type Pinned } from "./scheduler-review-worktree.js";
import { fixTreePath, lsRemoteHead, openFixWorktree, type FixTreeTarget, type OriginHead } from "./fix-strategy-worktree.js";
import { heldLease } from "./ledger-lend-lease.js";
import { withCodexSlot } from "./scheduler-local-runtime-slots.js";
import type { SessionRef } from "./worker-session.js";
import { sameAuthor, sessionStop, SHARED_AUTHOR, sharedHolder, stopRefusal, type SwapGate } from "./fix-strategy-guard.js";

export interface ConvergenceLifecycle {
  manager(...args: string[]): Promise<Record<string, unknown>>;
  registry(): RegistryAgent[];
  agents: RetireDeps["agents"];
  active(): void;
  /**
   * The final stop of one named session, used by the gated fix swap. It must itself refuse when the agent no longer runs
   * `sessionId` or the gate's admitted ownership pins: the child rechecks them after its own awaits. The production factory sets it; an in-memory
   * facade leaves it out, and then the swap falls back to its `manager("kill", agent)`.
   */
  stop?(old: { agent: string; sessionId: string }, gate?: SwapGate): Promise<Record<string, unknown>>;
  open(source: string, dir: string, head: string | null): Promise<{ dir: string } | { manual: string }>;
  /** The replacement author's own card-branch tree; `source` is read-only (fix-strategy-worktree.ts). */
  authorTree?(source: string, target: FixTreeTarget, recorded: string | null): Promise<Pinned>;
  registryPath?: string;
  slotLockPath?: string;
  worktreeRoot?: string;
  materialRoot?: string;
  readReport?(path: string): Promise<string>;
  diffSummary?(source: string, from: string | null, to: string): Promise<string>;
  localFamilyWait?(task: LedgerTask, family: AuthorFamily): string | null;
}

const leasedGit: Git = async (args) => { assertSchedulerLease(); const result = await git(args); assertSchedulerLease(); return result; };
const leasedOrigin: OriginHead = async (cwd, branch) => { assertSchedulerLease(); const head = await lsRemoteHead(cwd, branch); assertSchedulerLease(); return head; };

export function convergenceLifecycle(): ConvergenceLifecycle {
  const manager: ConvergenceLifecycle["manager"] = async (...args) => { assertSchedulerLease();
    const result = await runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
      env: reviewSwapManagerEnv(), timeoutMs: 90_000 });
    assertSchedulerLease(); return result;
  };
  return { authorTree: (source, target, recorded) => openFixWorktree(leasedGit, source, target, recorded, leasedOrigin),
    localFamilyWait: (task, family) => localFamilyRefusal({ remote: readSchedulerConfig().projects[task.project]?.remote ?? null }, "review", family),
    registry: readRegistryAgentsSync, agents: readLiveAgents, active: assertSchedulerLease, stop: sessionStop(manager),
    manager, open: async (source, dir, head) => openReviewWorktree(source, dir, head, leasedGit) };
}

export const convergenceEvent = (db: Database, ctx: WriteCtx, intent: SchedulerIntent, effect: string, data: Record<string, unknown>) =>
  tx(db, () => {
    const current = getIntent(db, intent.id);
    if (ctx.actor !== "scheduler" || !current || current.taskId !== intent.taskId || current.project !== intent.project ||
      !["fix_swap", "arbitrate"].includes(current.action) || !["pending", "submitted"].includes(current.status) ||
      (data.op !== undefined && data.op !== "arbiter_delivery")) throw new LedgerError("forbidden", "收敛效果只由调度服务为当前已认领意图记录");
    return insertEvent(db, { ...ctx, dedupKey: `scheduler:${intent.id}:${effect}` }, { project: intent.project, target: intent.taskId,
      kind: "scheduler", text: `收敛会话 ${effect}`, data: { ...data, op: data.op ?? "convergence_effect", intentId: intent.id } }, true);
  });

/**
 * Archive, then stop, one session; each pass does at most one of them. With a `gate` (the fix swap passes fix-strategy-guard.ts)
 * every manager call and every receipt is preceded, with no await in between, by the ledger gate and the registry's current
 * session: an inventory read before the await proves nothing about the moment the effect runs.
 */
export async function stopConvergenceAuthor(db: Database, ctx: WriteCtx, intent: SchedulerIntent,
  old: SessionRef | null, deps: ConvergenceLifecycle, gate?: SwapGate): Promise<string | null> {
  if (!old) return null;
  if (old.transport === "peer") return "旧作者是 peer 会话，不能通过本机 lifecycle 停止；先核对写租约";
  if (sharedHolder(db, old.agent, intent.taskId)) return SHARED_AUTHOR;
  const edge = (): string | null => {
    deps.active();
    if (!gate) return null;
    return gate()?.reason ?? (deps.registry().find((r) => r.name === old.agent)?.sessionId !== old.sessionId ? "旧作者当前会话已变化，不碰新会话" : null);
  };
  const archived = getEventByDedup(db, `scheduler:${intent.id}:archive`), killed = getEventByDedup(db, `scheduler:${intent.id}:kill`);
  // The receipts name the agent and session they were taken for: a binding made since (PM's manual author) is not the one this intent stops.
  if ([archived, killed].some((e) => e && !sameAuthor(e.data, old))) return "本意图已归档 / 停止的是另一个会话，现作者绑定不是它要换的，不归档、不停止";
  const row = (await deps.agents()).find((r) => r.name === old.agent); deps.active();
  if (!row || row.sessionId !== old.sessionId) return "旧作者当前会话已变化或不可核实，不归档、不停止";
  let halt: string | null;
  if (!archived) {
    if ((halt = edge())) return halt;
    const receipt = await deps.manager("archive", old.agent); deps.active();
    if (receipt.ok !== true) return `旧作者归档未完成：${String(receipt.error ?? receipt.note)}`;
    if ((halt = edge())) return halt;
    convergenceEvent(db, ctx, intent, "archive", { receipt: archiveReceipt(receipt), agent: old.agent, sessionId: old.sessionId });
    return "旧作者已归档，下轮确认停止";
  }
  // The inventory answers below may be older than the registry by the time they are returned: the receipt and the create that
  // follows it rest on the gate's synchronous read of the stopped session, taken with no await before them.
  if (killed) return gate?.("stopped")?.reason ?? null;
  const before = (await deps.agents()).find((r) => r.name === old.agent); deps.active();
  if (!before || before.sessionId !== old.sessionId) return "停止前作者会话已变化，不碰新会话";
  if (before.status !== "stopped" || before.pending || before.window) {
    if ((halt = edge())) return halt;
    const stopped = await (gate && deps.stop ? deps.stop({ agent: old.agent, sessionId: old.sessionId }, gate) : deps.manager("kill", old.agent)); deps.active();
    const refusal = stopRefusal(stopped); // identity mismatch / restart lock: the port touched nothing it was not sure of; wait, no kill by name
    if (refusal) return refusal;
    const outcome = killOutcome(stopped);
    if (!("receipt" in outcome)) return "busy" in outcome ? outcome.busy : outcome.failed;
  }
  const after = (await deps.agents()).find((r) => r.name === old.agent); deps.active();
  if (after && (after.status !== "stopped" || after.pending || after.window)) return "旧作者尚未完全停止，下轮复验";
  if (after && after.sessionId !== old.sessionId) return "停止后该名字下已是另一个会话，不记停止回执";
  deps.active();
  if ((halt = gate?.("stopped")?.reason ?? null)) return halt;
  convergenceEvent(db, ctx, intent, "kill", { receipt: "旧作者归档后已确认停止", agent: old.agent, sessionId: old.sessionId });
  return null;
}

/**
 * Every permission the author tree and its create rest on, read fresh from the ledger: auto mode, no held peer write lease,
 * and the card exactly as the stored intent pins it (a peer reclaim re-pins taskRev on the stored intent). null = may proceed.
 */
function authorGate(db: Database, intent: SchedulerIntent): string | null {
  const task = getTask(db, intent.taskId), now = getIntent(db, intent.id);
  if (!task || getWorkflow(db, task.id)?.mode !== "auto") return "卡不在 auto 模式，不建修复作者工作树";
  if (heldLease(db, task)) return "peer 写租约仍有效、未收回，不建本机修复作者工作树";
  if (!now || now.head !== intent.head || task.headSHA !== now.head || task.specRev !== now.specRev || task.rev !== now.taskRev) return "卡的 head / 规格 / 版本已变化，不建修复作者工作树";
  return null;
}

/**
 * Journal the target before any git effect; a retry re-verifies only that recorded tree. Off/observe cards, a held peer write
 * lease or a changed card never reach git, and the gate is read again once git returns. A tree refusal is `tree: true`:
 * callers wait for PM instead of placing elsewhere.
 */
async function authorTree(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, source: string,
  deps: ConvergenceLifecycle): Promise<{ dir: string } | { wait: string; tree: true }> {
  const stop = (wait: string) => ({ wait, tree: true as const });
  const gate = authorGate(db, intent);
  if (gate) return stop(gate);
  const root = deps.worktreeRoot ?? statePath("worktrees"), dir = fixTreePath(root, task.id);
  if (!dir) return stop("卡号不能安全映射到作者工作树目录");
  const prior = getEventByDedup(db, `scheduler:${intent.id}:worktree`);
  if (prior && (prior.data.dir !== dir || prior.data.head !== intent.head || prior.data.branch !== task.branch)) return stop("本意图记录的作者工作树与当前目标不符，等待核对");
  if (!prior) convergenceEvent(db, ctx, intent, "worktree", { dir, head: intent.head, branch: task.branch });
  deps.active();
  const target = { taskId: task.id, branch: task.branch, head: intent.head, root };
  const opened = deps.authorTree ? await deps.authorTree(source, target, dir) : { manual: "缺作者工作树端口" };
  deps.active();
  if ("manual" in opened) return stop(opened.manual);
  const late = authorGate(db, intent);
  return late ? stop(late) : opened;
}

export async function createConvergenceWorker(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask,
  family: AuthorFamily, source: string, role: "author" | "reviewer", deps: ConvergenceLifecycle,
  gate?: SwapGate): Promise<SessionRef | { wait: string; tree?: true }> {
  const blocked = deps.localFamilyWait?.(task, family);
  if (blocked) return { wait: blocked };
  const name = `agent-cv-${task.id.toLowerCase()}-${role === "author" ? "fix" : "arb"}-${intent.eventSeq}`;
  const started = getEventByDedup(db, `scheduler:${intent.id}:creating`);
  let row = deps.registry().find((r) => r.name === name);
  if (!started && row) throw new LedgerError("conflict", "收敛会话名已被其他会话占用");
  if (!started) {
    const dir = role === "author" ? await authorTree(db, ctx, intent, task, source, deps)
      : await deps.open(source, join(deps.worktreeRoot ?? statePath("worktrees"), `arb-${task.id}-${intent.eventSeq}`), intent.head);
    deps.active();
    if ("wait" in dir) return dir;
    if ("manual" in dir) return { wait: dir.manual };
    const runtime = family === "codex" ? ["--runtime", "codex", "--transport", "acp"] : [];
    let refused: string | null = null; // the gate again at the effect edge: a codex slot wait or the tree may have taken a while
    const create = async () => {
      deps.active();
      if (role === "author" && (refused = authorGate(db, intent) ?? gate?.("stopped")?.reason ?? null)) return { kind: "wait", reason: refused };
      convergenceEvent(db, ctx, intent, "creating", { agent: name, family, dir: dir.dir });
      const result = await deps.manager("create", name, dir.dir, "--project", task.project, "--task", `${task.id} 收敛`,
        "--card", task.id, "--card-role", role === "author" ? "author" : "other", ...runtime);
      deps.active(); return result;
    };
    const created = family === "codex" ? await withCodexSlot(create, { registryPath: deps.registryPath, lockPath: deps.slotLockPath, ledgerPath: db.filename }) : await create();
    if (refused) return { wait: refused, tree: true };
    if ("kind" in created && created.kind === "wait") return { wait: String(created.reason) };
    if (!("ok" in created) || created.ok !== true) return { wait: "新会话创建未确认，不重复创建" };
    row = deps.registry().find((r) => r.name === name);
  }
  if (!row?.sessionId) {
    const begun = getEventByDedup(db, `scheduler:${intent.id}:creating`);
    if (begun && (ctx.now ?? Date.now()) - begun.ts >= CLAIM_LEASE_MS) {
      settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "unknown", receipt: "新收敛会话创建已认领但未确认 session id，不重复创建" });
    }
    return { wait: "新会话创建已记，等待 registry session id；不重复创建" };
  }
  const actual = row.runtime === "codex" ? "codex" : row.runtime === undefined || row.runtime === "claude-code" ? "claude" : null;
  if (actual !== family || row.status === "stopped") throw new LedgerError("conflict", "新会话 runtime 或状态不符");
  const made = getEventByDedup(db, `scheduler:${intent.id}:creating`)?.data.dir;
  if (role === "author" && (typeof made !== "string" || row.cwd !== made)) throw new LedgerError("conflict", "新作者会话目录不是本意图建的工作树");
  return { taskId: task.id, role, agent: name, sessionId: row.sessionId, family, transport: row.transport === "acp" ? "acp" : "tmux" };
}
