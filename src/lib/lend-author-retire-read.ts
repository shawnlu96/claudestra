/** External reads finish before any SQLite writer begins. No head is inferred from an ended lease. */
import type { Database } from "bun:sqlite";
import { remoteHeadAt } from "./lend-git.js";
import { runBounded } from "./run-bounded.js";
import { getTask } from "./ledger-store.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { RemoteHead } from "./order-deliver.js";
import { lendAuthorBasis, lendAuthorFence, lendAuthorOrders, type LendAuthorSample } from "./lend-author-retire-proof.js";

export type ReadLendHead = (repo: string, branch: string) => Promise<RemoteHead>;
export const readLendAuthorHead: ReadLendHead = (repo, branch) => remoteHeadAt(repo, branch, runBounded);
export async function sampleLendAuthor(db: Database, taskId: string, read: ReadLendHead = readLendAuthorHead,
  policy: RecoveryPolicyPort = recoveryPolicy, timeoutMs = 15_000): Promise<LendAuthorSample | undefined> {
  const t = getTask(db, taskId), s = getSchedulerSession(db, taskId, "author");
  if (!t || !s || s.transport !== "peer" || s.state === "retired" || policy(t.project, "lendAuthorRebuild").mode === "off") return;
  const sample: LendAuthorSample = { ...lendAuthorFence(t, s), basis: lendAuthorBasis(db, taskId), heads: [] };
  if (policy(t.project, "lendAuthorRebuild").mode !== "on") return sample;
  for (const o of lendAuthorOrders(db, taskId).filter(o => o.leaseGen > 0 && ["cancelled", "claimed", "unknown"].includes(o.status))) {
    if (!o.branch || sample.heads.some(h => h.repo === o.repo && h.branch === o.branch)) continue;
    if (sample.heads.length) break; // One remote read per candidate; another cancelled branch remains unproven.
    let head: string | null = null;
    try { const r = await readHeadWithin(read, o.repo, o.branch, timeoutMs); head = r.ok ? r.head : null; }
    catch (e) { console.warn(`lend author remote head unavailable: ${(e as Error).message}`); }
    sample.heads.push({ repo: o.repo, branch: o.branch, head });
  }
  return sample;
}

/** A stalled injected/read port cannot stall the scheduler pass beyond the existing remote-head budget. */
async function readHeadWithin(read: ReadLendHead, repo: string, branch: string, timeoutMs: number): Promise<RemoteHead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(repo, branch), new Promise<RemoteHead>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, error: "remote head timeout" }), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}
