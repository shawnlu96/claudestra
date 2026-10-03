/**
 * i28-FB1: a fix order starts from the PR branch's actual head. Before the pool step puts out a fix to the write-lease holder, the
 * branch's remote head is read with RA1's shared gh API probe and, when it differs from the
 * card's head, compared on GitHub (gh api compare): a descendant (card-merge's update-branch merge commit, a previous worker's push
 * whose delivery was refused) moves the card's head there with an event naming both heads; diverged / unknown keeps today's
 * behaviour and leaves PM a visible alarm. A peer that still reports not_started because the start does not match keeps the
 * write lease once per round: the scheduler re-offers (refreshing the start), the second mismatch goes back to PM as before.
 * A fix whose write lease is with no peer while the card's executor is a local agent goes straight to that agent, never the pool.
 * No lend protocol change. tests/lend-fix-start.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import { heldLease, type WriteOffer } from "./ledger-lend-lease.js";
import type { LendNotice, LendOrder } from "./ledger-lend.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import type { Gh } from "./lend-fix-reassign-pr.js";
import { labGitRoot } from "./lend-git.js";
import type { WriteProbe } from "./lend-write-materials.js";
import { runBounded } from "./run-bounded.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";

export const FIX_START_MOVED_OP = "fix_start_moved";
export const FIX_START_ALARM_OP = "fix_start_alarm";
export const FIX_START_RETRY_OP = "fix_start_retry";
/** The lender's push probe text for a non-fast-forward (lend-push.ts `failed`): the branch moved past the order's start. */
const START_MISMATCH = /不是这一单的起点/;
const SHA40 = /^[0-9a-f]{40}$/;
const realGh: Gh = (args) => runBounded(["gh", ...args], { env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeoutMs: 60_000 });

/** ok = adopt `head` (a descendant of `from`); not ok = keep the card's head and alarm PM. */
export type FixStart = { ok: true; from: string; head: string } | { ok: false; from: string; head: string | null; why: string };
type FixStartWrite = WriteOffer & { fixStart?: FixStart };

/** Shared production probe for FB1 and RA1; GitHub credentials suffice without a Git HTTPS credential helper. */
export function ghFixStartProbe(probe: WriteProbe, gh: Gh = realGh): WriteProbe {
  if (labGitRoot()) return probe;
  return { ...probe, remoteHead: async (repo, branch) => {
    const r = await gh(["api", `repos/${repo}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, "--jq", ".object.sha"]);
    const head = r.stdout.trim();
    return r.code === 0 && !r.timedOut && SHA40.test(head) ? { ok: true, head }
      : { ok: false, error: `gh head 查询失败：${(r.timedOut ? "超时" : r.stderr || r.stdout || "空 head").trim().slice(0, 200)}` };
  } };
}

/** The PR branch's current head against the card's: null = same head (nothing to do). */
export async function probeFixStart(repo: string, branch: string, from: string, remoteHead: WriteProbe["remoteHead"], gh: Gh = realGh): Promise<FixStart | null> {
  const r = await remoteHead(repo, branch);
  if (!r.ok || !SHA40.test(r.head)) return { ok: false, from, head: null, why: `查不到 PR 分支 ${branch} 的远端完整 head（${r.ok ? r.head : r.error}）` };
  if (r.head === from) return null;
  const c = await gh(["api", `repos/${repo}/compare/${from}...${r.head}`, "--jq", ".status"]);
  const status = c.code === 0 ? c.stdout.trim() : "";
  if (status === "ahead") return { ok: true, from, head: r.head };
  const why = c.code !== 0 ? `gh compare 失败：${(c.timedOut ? "超时" : c.stderr || c.stdout).trim().slice(0, 200)}`
    : status === "diverged" ? "与卡上 head 已分叉" : `比较结果是 ${status.slice(0, 40) || "（空）"}，不是卡上 head 的后代`;
  return { ok: false, from, head: r.head, why: `PR 分支 ${branch} 的远端 head ${r.head.slice(0, 12)} ${why}` };
}

/** The pool step's fix materials, outside the transaction: a fix going back to the lease holder carries its probed start. */
export async function withFixStart<W extends WriteOffer | null>(db: Database, task: LedgerTask, peer: string, write: W,
  probe: Pick<WriteProbe, "remoteHead">, gh?: Gh): Promise<W> {
  const lease = write && task.stage === "fix" ? heldLease(db, task) : null;
  if (!lease || lease.peer !== peer || !task.headSHA || !SHA40.test(task.headSHA) || labGitRoot()) return write;
  const fixStart = await probeFixStart(lease.repo, lease.branch, task.headSHA, probe.remoteHead, gh);
  return fixStart ? { ...write, fixStart } as W : write;
}

/** Inside the pool step's transaction, before the order is cut: adopt a descendant head, or alarm PM once. Returns the card now. */
export function adoptFixStart(db: Database, ctx: WriteCtx, task: LedgerTask, write: WriteOffer | null): LedgerTask {
  const s = (write as FixStartWrite | null)?.fixStart;
  if (!s || task.headSHA !== s.from) return task;
  const now = ctx.now ?? Date.now();
  if (s.ok) {
    const key = `scheduler:fix-start:${task.id}:${s.from}:${s.head}`;
    if (getEventByDedup(db, key)) return task;
    db.prepare("UPDATE tasks SET headSHA = ?, rev = rev + 1, updatedAt = ? WHERE id = ? AND headSHA = ?").run(s.head, now, task.id, s.from);
    const reason = "PR 分支远端已比卡上 head 新（update-branch 的合并提交或上一个 worker 推过的提交），修复单从远端 head 起";
    insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `修复单起点跟上 PR 分支：${s.from.slice(0, 12)} → ${s.head.slice(0, 12)}（${reason}）`,
      data: { op: FIX_START_MOVED_OP, oldHead: s.from, newHead: s.head, reason, round: task.round, specRev: task.specRev } }, true);
    return getTask(db, task.id) ?? task;
  }
  const key = `scheduler:fix-start-alarm:${task.id}:r${task.round}:${createHash("sha256").update(`${s.from}:${s.head ?? ""}:${s.why}`).digest("hex").slice(0, 24)}`;
  if (!getEventByDedup(db, key)) {
    insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `修复单起点没跟 PR 分支：${s.why}。仍按卡上 head ${s.from.slice(0, 12)} 派，对方若报起点不符会退给你核对`,
      data: { op: FIX_START_ALARM_OP, head: s.from, remoteHead: s.head, why: s.why, round: task.round, specRev: task.specRev } }, true);
  }
  return task;
}

/**
 * A scheduler fix order released not_started because its start did not match, the first time this round: the write lease stays,
 * one event marks the retry (the planner then does not count this attempt, see startRetried) and PM gets a notice. null = the
 * caller ends the lease as before (another reason, a manual offer, or already retried this round).
 */
export function fixStartRetry(db: Database, ctx: WriteCtx, o: LendOrder, detail: string | null, now: number): LendNotice | null {
  if (o.step !== "fix" || o.createdBy !== "scheduler" || !START_MISMATCH.test(detail ?? "")) return null;
  const task = getTask(db, o.taskId);
  if (!task || heldLease(db, task)?.peer !== o.peer) return null;
  const key = `scheduler:fix-start-retry:${o.taskId}:s${o.specRev}:r${o.round}`;
  if (getEventByDedup(db, key)) return null;
  insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: o.project, target: o.taskId, kind: "scheduler",
    text: `修复单 ${o.orderId} 被 ${o.peer} 退回：起点不符。写租约保留，下一轮刷新起点后自动重挂一次`,
    data: { op: FIX_START_RETRY_OP, orderId: o.orderId, peer: o.peer, head: o.head, round: o.round, specRev: o.specRev } }, true);
  return { project: o.project, taskId: o.taskId, text: `出借单 ${o.orderId}（${o.taskId} 修复单）${o.peer} 报起点不符（PR 分支被推过）。` +
    "写租约保留，调度刷新起点后自动重挂一次；同一轮再不符才退给你" };
}

/**
 * This pool intent's order was the one released for a start mismatch and retried: not a spent attempt for placement.
 * The link key is scheduler-pool-facts.ts poolLinkKey, spelled out here: importing it would close a module cycle.
 */
export function startRetried(events: readonly LedgerEvent[], intentId: string): boolean {
  const orderId = events.find((e) => e.kind === "scheduler" && e.dedupKey === `scheduler:${intentId}:pool`)?.data.orderId;
  return typeof orderId === "string" && events.some((e) => e.kind === "scheduler" && e.data.op === FIX_START_RETRY_OP && e.data.orderId === orderId);
}

/** i28-FB1 goal 4 (the caller skips pinned cards): a fix with no write lease at any peer whose executor is a local agent goes to that agent, not the pool. */
export const localFixOwner = (s: PlannerSnapshot): boolean =>
  s.task.stage === "fix" && !s.pool?.writeLeasePeer && !!s.task.agent && s.task.assigneeKind !== "peer_agent";
