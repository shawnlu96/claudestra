/**
 * Automatic fix reassignment (i28-RA1), after the relay order is delivered: the card now points at the new lender's PR, so the
 * old PR is closed with a comment that links the new one. Runs after every `ledger scheduler-pool` step (idempotent: one
 * closed event per relay, a failed gh call is retried next pass). The lab's local bare repositories have no PRs.
 * tests/lend-fix-reassign.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { labGitRoot } from "./lend-git.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { prCoordinates } from "./scheduler-pool-facts.js";
import { FIX_RELAY_CLOSED_OP, fixRelays } from "./lend-fix-reassign-event.js";

export type Gh = (args: string[]) => Promise<BoundedResult>;
const realGh: Gh = (args) => runBounded(["gh", ...args], { env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeoutMs: 60_000 });
const closedKey = (seq: number): string => `scheduler:fix-relay-closed:${seq}`;

/** Closes the PR a delivered relay left behind; returns what it did (null = nothing to do). */
export async function closeRelayedPr(db: Database, ctx: WriteCtx, taskId: string | undefined, gh: Gh = realGh): Promise<string | null> {
  const task = taskId ? getTask(db, taskId) : null;
  const r = task ? fixRelays(db, task.id).at(-1) : undefined;
  if (!task || !r || r.oldPr === null || getEventByDedup(db, closedKey(r.seq)) || labGitRoot()) return null;
  const now = prCoordinates(task.pr);
  if (task.branch !== r.toBranch || !now || now.pr === r.oldPr) return null;
  const old = String(r.oldPr), repo = r.repo;
  const body = `本卡（${task.id}）的修复已自动改派：${r.from} → ${r.to}，从 ${r.head.slice(0, 12)} 接力，接力 PR：#${now.pr}（base main）。这个 PR 由系统关闭。`;
  let closed = await gh(["pr", "close", old, "--repo", repo, "--comment", body]);
  if (closed.code !== 0) {
    const state = await gh(["pr", "view", old, "--repo", repo, "--json", "state", "--jq", ".state"]);
    if (state.code !== 0 || !/^(CLOSED|MERGED)$/.test(state.stdout.trim())) return `关旧 PR #${old} 没成功，下轮再试：${(closed.stderr || closed.stdout).trim().slice(0, 200)}`;
    closed = await gh(["pr", "comment", old, "--repo", repo, "--body", body]);
    if (closed.code !== 0) return `旧 PR #${old} 已关，留评论没成功，下轮再试`;
  }
  tx(db, () => {
    if (getEventByDedup(db, closedKey(r.seq))) return;
    insertEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: closedKey(r.seq) }, { project: task.project, target: task.id, kind: "scheduler",
      text: `接力 PR #${now.pr} 已接上，旧 PR #${old} 已关闭并留言指向新 PR`, data: { op: FIX_RELAY_CLOSED_OP, relaySeq: r.seq, oldPr: r.oldPr, newPr: now.pr } }, true);
  });
  return `旧 PR #${old} 已关闭，评论指向 #${now.pr}`;
}
