/**
 * The auto tick's and auto deps' hooks for peer PR cards (i28-A2 §3 §6). Non-peer cards get null / their old value back from
 * every function here, so their behaviour is unchanged. A peer card in fix waits for the peer tick (there is no local author to
 * dispatch to); one in review with this round's verdict waits until the peer tick has re-read the PR head after that verdict.
 * That check lives in process memory: after a service restart it is empty, which reads as "not checked" and keeps holding.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { hasRoundVerdict, peerPrOf } from "./peer-pr-ledger.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { fixBounce } from "./scheduler-merge-conflict.js";
import { listEvents } from "./ledger-store.js";
import type { Git } from "./scheduler-review-worktree.js";

const checked = new WeakMap<Database, Map<string, { seq: number; head: string }>>();

/** The peer tick read the PR after the verdict at `verdictSeq` and found it still at `head`. */
export function markHeadChecked(db: Database, taskId: string, verdictSeq: number, head: string): void {
  const m = checked.get(db) ?? new Map<string, { seq: number; head: string }>();
  checked.set(db, m);
  m.set(taskId, { seq: verdictSeq, head });
}

export function headChecked(db: Database, task: LedgerTask, verdictSeq: number): boolean {
  const c = checked.get(db)?.get(task.id);
  return !!c && c.seq >= verdictSeq && c.head === task.headSHA;
}

/** Why the planner must not run for this card this pass; null = plan as usual (every non-peer card). */
export function peerPrHold(db: Database, task: LedgerTask): string | null {
  if (!peerPrOf(task)) return null;
  if (task.stage === "fix") {
    const bounce = fixBounce(listEvents(db, { project: task.project, target: task.id }), task.stage);
    return bounce ? `peer PR 卡因合并${bounce.cause === "conflict" ? "冲突" : "前 CI 失败"}退回 fix：等对方往 PR 推新 head（不派本机作者）`
      : "peer PR 卡在 fix：等对方往 PR 推新 head（peer tick 处理，不派作者）";
  }
  if (task.stage !== "review") return null;
  const verdict = hasRoundVerdict(db, task);
  if (!verdict || headChecked(db, task, verdict.seq)) return null;
  return "peer PR 本轮结论已出：等 peer tick 在结论之后现查 PR head 仍是卡上的 head 再放行";
}

/** A peer card's reviewer worktree comes from scheduler.json's repoDir (there is no local author); null = not a peer card. */
export function peerPrRepoDir(task: LedgerTask, read = readSchedulerConfig): string | null {
  if (!peerPrOf(task)) return null;
  try { return read().projects[task.project]?.repoDir ?? null; } catch (e) {
    console.error(`⚠️ [peer-pr] 读 scheduler.json 失败，${task.id} 的审查目录建不了：${(e as Error).message}`);
    return null;
  }
}

/** Before pinning a peer card's reviewer: the head must already be a local commit (the peer tick fetched it). No fetch here. */
export async function peerPrHeadMissing(task: LedgerTask, head: string, git: Git, read = readSchedulerConfig): Promise<string | null> {
  if (!peerPrOf(task)) return null;
  const dir = peerPrRepoDir(task, read);
  if (!dir) return `${task.id} 是 peer PR 卡，但 scheduler.json 里没有项目 ${task.project} 的 repoDir`;
  const r = await git(["-C", dir, "cat-file", "-e", `${head}^{commit}`]);
  return r.code === 0 ? null : `PR head ${head.slice(0, 12)} 不在本地仓库（peer tick 还没取到），不派审，交 PM`;
}
