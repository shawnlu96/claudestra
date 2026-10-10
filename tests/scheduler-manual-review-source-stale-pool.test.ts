/**
 * AUTOACK1 [验收线 1] (stale-pool-1): the round's scheduler pool review is done on the same head, then PM takes the card over, puts a
 * new review in the lend pool and the peer's signed ticket is adopted on the hand-back. The older pool order no longer carries the
 * current verdict, so it must not shadow the adopted source: planner, merge intent write and merge begin all pass.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { beginMergeRun, mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { currentPooledReviewer } from "../src/lib/scheduler-pool-facts.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { B_WORKER } from "./pool-review-proof-helpers.js";
import { events, finding, lendWorld, PEER, peerReview, plan, resume, toManual, type Fx } from "./scheduler-manual-review-source-fixture.test.js";

let f: Fx;
afterEach(() => f?.close());

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };

test("[验收线 1] a done scheduler pool order of the same round / head does not shadow the adopted newer peer ticket", async () => {
  f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7', branch = 'task/T1' WHERE id = 'T1'", [spec]);
  await toBuild(f);
  await f.tick(); // write order
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  const w = lendWorld(f);
  const borrow = async (): Promise<BorrowEntry[]> => [{ peer: PEER, projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const tick = async () => (await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 0, remote: REMOTE } },
    { ...f.tickDeps, manager: (...args: string[]) => w.cli("scheduler", ...args.slice(1)), borrow })).cards[0];
  expect(await tick()).toMatchObject({ step: "pool_pooled" });
  const old = listLendOrders(f.db, "T1").at(-1)!;
  const claimed = await w.cli("owner", "lend-claim", "--", PEER, JSON.stringify({ v: 1, orderId: old.orderId, worker: B_WORKER }));
  expect((await w.b.answer(claimed as never, { verdict: "changes", findings: [finding("old-pool", "P1")] }, (body) => w.cli("owner", "lend-write", "--", PEER, JSON.stringify(body)))).r)
    .toMatchObject({ ok: true });
  expect(await tick()).toMatchObject({ step: "pool_done" });
  await toManual(f); // PM takes over before the scheduler acts on the pool verdict
  const orderId = await peerReview(f);
  expect(orderId).not.toBe(old.orderId);
  expect(await resume(f)).toMatchObject({ ok: true });
  const verdict = events(f).findLast((e) => e.kind === "review")!;
  const reviewer = `peer:${PEER}`;
  expect(verdict.data).toMatchObject({ reviewer, reviewerSessionId: `lend:${PEER}:${orderId}`, head: H1, round: 1 });
  // the older done pool order is still this round's and head's pool reviewer, on another session
  expect(currentPooledReviewer(f.db, f.task())).toMatchObject({ sessionId: `lend:${PEER}:${old.orderId}` });
  expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ reviewSeq: verdict.seq, orderId });
  expect(plan(f)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await f.tick()).toMatchObject({ step: "merge_queue" });
  const merge = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge'").get() as { id: string };
  settleIntent(f.db, { actor: "scheduler", now: 7_000_000 }, { id: merge.id, from: "pending", to: "submitted", receipt: "claimed" });
  expect(mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ eventSeq: verdict.seq, reviewer });
  expect(beginMergeRun(f.db, { actor: "scheduler", now: 7_000_010 }, merge.id, ["test"])).toMatchObject({ duplicate: false, run: { phase: "ready", reviewedHead: H1 } });
});
