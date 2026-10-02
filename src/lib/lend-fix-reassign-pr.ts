/**
 * Automatic fix reassignment, after the relay order is delivered: the card points at the new lender's PR, so the old PR is closed
 * with a comment that links the new one. Idempotent (one closed event per relay); while it is pending the tick retries it every
 * pass (lend-fix-reassign-tick.ts), so a failed gh call is never final. The lab's local bare repositories have no PRs.
 */import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { labGitRoot } from "./lend-git.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { prCoordinates } from "./scheduler-pool-facts.js";
import { FIX_RELAY_CLOSED_OP, fixRelays, type FixRelay } from "./lend-fix-reassign-event.js";
import type { LedgerTask } from "./ledger-stages.js";

export type Gh = (args: string[]) => Promise<BoundedResult>;
const realGh: Gh = (args) => runBounded(["gh", ...args], { env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeoutMs: 60_000 });
const closedKey = (seq: number): string => `scheduler:fix-relay-closed:${seq}`;

/** The relay whose old PR still has to be closed now that the card points at the new PR, or null. */
export function relayPrPending(db: Database, task: LedgerTask): { relay: FixRelay; newPr: number } | null {
  const r = fixRelays(db, task.id).at(-1), now = prCoordinates(task.pr);
  if (!r || r.oldPr === null || getEventByDedup(db, closedKey(r.seq)) || labGitRoot()) return null;
  return task.branch === r.toBranch && now && now.pr !== r.oldPr ? { relay: r, newPr: now.pr } : null;
}

/** Closes the PR a delivered relay left behind. null = nothing to do; closed = false: gh failed, the next pass retries. */
export async function closeRelayedPr(db: Database, ctx: WriteCtx, taskId: string | undefined, gh: Gh = realGh): Promise<{ closed: boolean; text: string } | null> {
  const task = taskId ? getTask(db, taskId) : null;
  const pending = task && relayPrPending(db, task);
  if (!task || !pending) return null;
  const r = pending.relay, now = { pr: pending.newPr };
  const old = String(r.oldPr), repo = r.repo;
  const body = `本卡（${task.id}）的修复已自动改派：${r.from} → ${r.to}，从 ${r.head.slice(0, 12)} 接力，接力 PR：#${now.pr}（base main）。这个 PR 由系统关闭。`;
  let closed = await gh(["pr", "close", old, "--repo", repo, "--comment", body]);
  if (closed.code !== 0) {
    const state = await gh(["pr", "view", old, "--repo", repo, "--json", "state", "--jq", ".state"]);
    if (state.code !== 0 || !/^(CLOSED|MERGED)$/.test(state.stdout.trim())) return { closed: false, text: `关旧 PR #${old} 没成功，下轮再试：${(closed.stderr || closed.stdout).trim().slice(0, 200)}` };
    closed = await gh(["pr", "comment", old, "--repo", repo, "--body", body]);
    if (closed.code !== 0) return { closed: false, text: `旧 PR #${old} 已关，留评论没成功，下轮再试` };
  }
  tx(db, () => {
    if (getEventByDedup(db, closedKey(r.seq))) return;
    insertEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: closedKey(r.seq) }, { project: task.project, target: task.id, kind: "scheduler",
      text: `接力 PR #${now.pr} 已接上，旧 PR #${old} 已关闭并留言指向新 PR`, data: { op: FIX_RELAY_CLOSED_OP, relaySeq: r.seq, oldPr: r.oldPr, newPr: now.pr } }, true);
  });
  return { closed: true, text: `旧 PR #${old} 已关闭，评论指向 #${now.pr}` };
}
