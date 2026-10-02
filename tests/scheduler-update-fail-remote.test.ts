import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { bounceReceipt, parseBounceReceipt, updateOrBounce } from "../src/lib/scheduler-merge-conflict.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { autoFixture, H2 } from "./scheduler-auto-helpers.js";

test("GitHub update refusal with a foreign SHA reaches the lease holder and claim unchanged", async () => {
  const f = autoFixture();
  try {
    const base = "b".repeat(40), foreign = "c".repeat(40), branch = "lend/T1-abcd";
    const error = `GitHub update refused: expected commit ${foreign}, please retry`;
    const run = { taskId: "T1", reviewedHead: H2, prRef: "https://github.com/o/r/pull/7", phase: "updating" } as MergeRun;
    let receipt = "";
    await updateOrBounce(run, {
      updateBranch: async () => { throw new Error(error); }, inspect: async () => { throw new Error("read unavailable"); },
      freshness: async () => ({ behindBy: 0, mainHead: base }), carryReview: async () => ({ ok: false, reason: "unused" }), merge: async () => H2,
    }, async (_phase, r) => { receipt = r!; return run; }, () => false);
    const bounce = parseBounceReceipt(receipt)!;
    expect(bounce).toMatchObject({ cause: "update_fail", error });
    expect(receipt).toBe(bounceReceipt(bounce));
    const spec = join(f.dir, "spec.md");
    writeFileSync(spec, "规格：修复更新分支失败");
    f.db.run("UPDATE tasks SET stage='fix', stageBefore='merge', round=1, headSHA=?, branch=?, pr=?, spec=? WHERE id='T1'",
      [H2, branch, run.prRef, spec]);
    f.db.run("UPDATE task_workflows SET authorFamily='codex' WHERE taskId='T1'");
    holdWriteLease(f.db, f.task(), { peer: "mate", fp: "abcd-ef01-2345-6789", branch, repo: "o/r" }, 1000);
    insertEvent(f.db, { actor: "scheduler", now: 1001 }, { project: "p", target: "T1", kind: "stage", text: receipt,
      data: { from: "merge", to: "fix", round: 1, mergeBounce: bounce } }, true);
    recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "boot", seq: 1, paused: null,
      slots: { codex: { total: 1, busy: 0 }, claude: { total: 0, busy: 0 } },
      grant: { until: 100_000, roles: ["write"], repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 10 } }, 1001);
    const borrow = [{ peer: "mate", projects: ["p"], roles: ["write" as const], maxOpen: 1 }];
    const remote = { mode: "balance" as const, roles: ["write" as const], poolTimeoutMin: 15, repo: "o/r" };
    const policy = { maxActiveWorkers: 2, remote };
    const lend = { borrow: async () => borrow, notifyPm: async () => {}, schedulerPolicy: () => policy,
      result: { reportDir: () => f.dir, writeReport: (path: string, text: string) => writeFileSync(path, text),
        sign: () => { throw new Error("claim does not sign verdicts"); },
        peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async () => ({ ok: true as const, head: base }) } };
    const cli = (...args: string[]) => f.cliWith({ lend }, "scheduler", ...args);
    const tick = await schedulerAutoTick(f.db, { p: policy }, { ...f.tickDeps, borrow: async () => borrow,
      manager: (...args) => cli(...args.slice(1)) as Promise<Record<string, any>> });
    expect(tick.failed).toEqual([]);
    expect(tick.cards[0]).toMatchObject({ step: "pool_pooled" });
    const [order] = listLendOrders(f.db, "T1");
    expect(order).toMatchObject({ step: "fix", peer: "mate", head: H2, branch });
    expect(order.text).toContain("更新分支失败");
    expect(order.text).toContain(error.replace(foreign, `${foreign.slice(0, 12)}(SHA 已缩为 12 位)`));
    expect(order.text).not.toContain(foreign);
    expect(order.text).not.toContain("git fetch");
    expect(order.text).toContain("refs/remotes/origin/HEAD");
    const claim = await f.cliWith({ lend }, "owner", "lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId: order.orderId, worker: "fixer" }));
    expect(claim).toMatchObject({ ok: true, order: order.wire, text: order.text });
  } finally { f.close(); }
});
