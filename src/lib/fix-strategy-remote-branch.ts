/** A card branch is authorized by the bound convergence order, never by widening the lend branch pattern. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getOrder, LEND_JOURNAL_PATH, type LendRow } from "./lend-journal.js";
import { heldLease } from "./ledger-lend-lease.js";
import { mustTask } from "./ledger-checks.js";
import { LEND_BRANCH_RE, lendBranch } from "./lend-git.js";
import type { OrderWire } from "./order-wire.js";
import { boundCardBranch } from "./lend-arbiter-wire.js";
import type { LendOrder } from "./ledger-lend.js";
import type { PushResult, PushTarget } from "./lend-push.js";
import type { BoundedResult } from "./run-bounded.js";
import { LedgerError } from "./ledger-store.js";

export const convergenceWriteMismatch = (order: OrderWire, branch: string | undefined, ordinary: () => string | null): string | null =>
  boundCardBranch(order, branch) ? null : ordinary();

function cardBranchDelivery(db: Database, o: LendOrder, fp: string, now: number): boolean {
  const task = mustTask(db, o.taskId), lease = heldLease(db, task);
  const peer = db.query("SELECT proto, helloAt FROM lend_peers WHERE peer = ?").get(o.peer) as { proto: number; helloAt: number } | null;
  return boundCardBranch(o.wire, o.branch) && task.branch === o.branch && lease?.peer === o.peer && lease.fp === fp &&
    lease.branch === o.branch && (peer?.proto ?? 1) >= 3 && !!peer && now - peer.helloAt <= 180_000;
}

export function deliveryBranchMatches(db: Database, o: LendOrder, fp: string | null, now: number): fp is string {
  return !!fp && (o.wire.convergence?.kind === "fix" ? cardBranchDelivery(db, o, fp, now) : lendBranch(o.taskId, fp) === o.branch);
}

export function assertConvergenceDeliveryLease(db: Database, o: LendOrder, now: number): void {
  if (o.wire.convergence?.kind !== "fix") return;
  const lease = heldLease(db, mustTask(db, o.taskId));
  if (!lease || !cardBranchDelivery(db, o, lease.fp, now)) throw new LedgerError("conflict", "card branch convergence lease no longer held");
}

function journalBranch(row: LendRow | null, branch: string, head?: string): boolean {
  if (!row || !["claimed", "cloned", "started", "result_pending"].includes(row.state) || (row.leaseUntil ?? 0) < Date.now() || !row.wire) return false;
  const order = row.wire.order as unknown as OrderWire;
  return row.wire.write?.branch === branch && boundCardBranch(order, branch) && (!head || order.head === head);
}

/** Read-only journal lookup: missing state never grants a custom branch and never creates a database. */
function journalCardBranch(orderId: string, branch: string, head?: string, path = LEND_JOURNAL_PATH): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try { return journalBranch(getOrder(db, orderId), branch, head); } finally { db.close(); }
}

export function cloneCardBranch(input: { orderId: string; head: string; write?: { branch: string } }): boolean {
  return !!input.write && journalCardBranch(input.orderId, input.write.branch, input.head);
}

export function pushCardBranch(t: PushTarget): boolean {
  return journalCardBranch(t.orderId, t.branch, t.orderHead);
}

/** A verified same-head retry resumes delivery without writing; competing updates still refuse even if fast-forwardable. */
export async function checkCardPushHead(t: PushTarget & { head: string }, git: (args: string[]) => Promise<BoundedResult>, url: string): Promise<PushResult | null> {
  if (LEND_BRANCH_RE.test(t.branch) && !/:cv:\d+$/.test(t.orderId)) return null;
  if (!pushCardBranch(t)) return { ok: false, reason: "card branch order is no longer leased", retry: false };
  const result = await git(["ls-remote", url, `refs/heads/${t.branch}`]);
  const lines = result.stdout.trim().split(/\n/);
  if (result.code === 0 && lines.length === 1 && lines[0] === `${t.head}\trefs/heads/${t.branch}`) return { ok: true };
  const expected = `${t.orderHead}\trefs/heads/${t.branch}`;
  return result.code === 0 && lines.length === 1 && lines[0] === expected ? null
    : { ok: false, reason: "remote card branch head changed or cannot be verified", retry: result.code !== 0 };
}
