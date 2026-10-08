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
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { statePath } from "./paths.js";
import { readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import { assertSchedulerLease } from "./scheduler-lease-env.js";
import { reviewSwapManagerEnv } from "./scheduler-review-swap-runtime.js";
import { archiveReceipt, killOutcome, readLiveAgents, type RetireDeps } from "./scheduler-retire.js";
import { git, openReviewWorktree, type Git, type Pinned } from "./scheduler-review-worktree.js";
import { fixTreePath, openFixWorktree, type FixTreeTarget } from "./fix-strategy-worktree.js";
import { heldLease } from "./ledger-lend-lease.js";
import { withCodexSlot } from "./scheduler-local-runtime-slots.js";
import type { SessionRef } from "./worker-session.js";

export interface ConvergenceLifecycle {
  manager(...args: string[]): Promise<Record<string, unknown>>;
  registry(): RegistryAgent[];
  agents: RetireDeps["agents"];
  active(): void;
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

export function convergenceLifecycle(): ConvergenceLifecycle {
  return { authorTree: (source, target, recorded) => openFixWorktree(leasedGit, source, target, recorded),
    localFamilyWait: (task, family) => localFamilyRefusal({ remote: readSchedulerConfig().projects[task.project]?.remote ?? null }, "review", family),
    registry: readRegistryAgentsSync, agents: readLiveAgents, active: assertSchedulerLease,
    manager: async (...args) => { assertSchedulerLease();
      const result = await runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
        env: reviewSwapManagerEnv(), timeoutMs: 90_000 });
      assertSchedulerLease(); return result;
    }, open: async (source, dir, head) => openReviewWorktree(source, dir, head, leasedGit) };
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

export async function stopConvergenceAuthor(db: Database, ctx: WriteCtx, intent: SchedulerIntent,
  old: SessionRef | null, deps: ConvergenceLifecycle): Promise<string | null> {
  if (!old) return null;
  if (old.transport === "peer") return "旧作者是 peer 会话，不能通过本机 lifecycle 停止；先核对写租约";
  const shared = db.query(`SELECT taskId FROM scheduler_sessions WHERE agent = ? AND state != 'retired'
    AND (taskId != ? OR role != 'author') UNION SELECT id FROM tasks WHERE agent = ? AND id != ? AND stage NOT IN ('verified','done','cancelled')`)
    .get(old.agent, intent.taskId, old.agent, intent.taskId);
  if (shared) return "旧作者会话还被其他卡或审查绑定使用，不能停止";
  const row = (await deps.agents()).find((r) => r.name === old.agent); deps.active();
  if (!row || row.sessionId !== old.sessionId) return "旧作者当前会话已变化或不可核实，不归档、不停止";
  if (!getEventByDedup(db, `scheduler:${intent.id}:archive`)) {
    const receipt = await deps.manager("archive", old.agent); deps.active();
    if (receipt.ok !== true) return `旧作者归档未完成：${String(receipt.error ?? receipt.note)}`;
    convergenceEvent(db, ctx, intent, "archive", { receipt: archiveReceipt(receipt), sessionId: old.sessionId });
    return "旧作者已归档，下轮确认停止";
  }
  if (getEventByDedup(db, `scheduler:${intent.id}:kill`)) return null;
  const before = (await deps.agents()).find((r) => r.name === old.agent); deps.active();
  if (!before || before.sessionId !== old.sessionId) return "停止前作者会话已变化，不碰新会话";
  if (before.status !== "stopped" || before.pending || before.window) {
    const outcome = killOutcome(await deps.manager("kill", old.agent)); deps.active();
    if (!("receipt" in outcome)) return "busy" in outcome ? outcome.busy : outcome.failed;
  }
  const after = (await deps.agents()).find((r) => r.name === old.agent); deps.active();
  if (after && (after.status !== "stopped" || after.pending || after.window)) return "旧作者尚未完全停止，下轮复验";
  convergenceEvent(db, ctx, intent, "kill", { receipt: "旧作者归档后已确认停止", sessionId: old.sessionId });
  return null;
}

/**
 * Journal the target before any git effect; a retry re-verifies only that recorded tree. Off/observe cards, a held peer write
 * lease or a changed card never reach git. A tree refusal is `tree: true`: callers wait for PM instead of placing elsewhere.
 */
async function authorTree(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, source: string,
  deps: ConvergenceLifecycle): Promise<{ dir: string } | { wait: string; tree: true }> {
  const stop = (wait: string) => ({ wait, tree: true as const });
  if (getWorkflow(db, task.id)?.mode !== "auto") return stop("卡不在 auto 模式，不建修复作者工作树");
  if (heldLease(db, task)) return stop("peer 写租约仍有效、未收回，不建本机修复作者工作树");
  const now = getIntent(db, intent.id); // a peer reclaim re-pins taskRev on the stored intent after the caller loaded it
  if (!now || task.headSHA !== now.head || task.specRev !== now.specRev || task.rev !== now.taskRev) return stop("卡的 head / 规格 / 版本已变化，不建修复作者工作树");
  const root = deps.worktreeRoot ?? statePath("worktrees"), dir = fixTreePath(root, task.id);
  if (!dir) return stop("卡号不能安全映射到作者工作树目录");
  const prior = getEventByDedup(db, `scheduler:${intent.id}:worktree`);
  if (prior && (prior.data.dir !== dir || prior.data.head !== intent.head || prior.data.branch !== task.branch)) return stop("本意图记录的作者工作树与当前目标不符，等待核对");
  if (!prior) convergenceEvent(db, ctx, intent, "worktree", { dir, head: intent.head, branch: task.branch });
  deps.active();
  const target = { taskId: task.id, branch: task.branch, head: intent.head, root };
  const opened = deps.authorTree ? await deps.authorTree(source, target, dir) : { manual: "缺作者工作树端口" };
  deps.active();
  return "manual" in opened ? stop(opened.manual) : opened;
}

export async function createConvergenceWorker(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask,
  family: AuthorFamily, source: string, role: "author" | "reviewer", deps: ConvergenceLifecycle): Promise<SessionRef | { wait: string; tree?: true }> {
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
    const create = async () => {
      deps.active(); convergenceEvent(db, ctx, intent, "creating", { agent: name, family, dir: dir.dir });
      const result = await deps.manager("create", name, dir.dir, "--project", task.project, "--task", `${task.id} 收敛`,
        "--card", task.id, "--card-role", role === "author" ? "author" : "other", ...runtime);
      deps.active(); return result;
    };
    const created = family === "codex" ? await withCodexSlot(create, { registryPath: deps.registryPath, lockPath: deps.slotLockPath, ledgerPath: db.filename }) : await create();
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
