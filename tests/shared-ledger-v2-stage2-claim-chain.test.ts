/** S2F5 验收线 1–3：客户端真实函数（S2Q 认领、X8 发送闸、S2J 合并）发出的命令序列跑在 S2C 上。
 * 只用合成夹具（tests/helpers/shared-ledger-v2-fake-center*），不读生产、不连网络。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { executeSchedulerCentral } from "../src/lib/scheduler-central.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import type { MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import { configureSchedulerV2Merge, parseSchedulerV2MergeSha, withSchedulerV2Merge } from "../src/lib/scheduler-v2-merge.js";
import { claimChain, type ChainAction } from "./helpers/shared-ledger-v2-fake-center-chain.js";

const cleanup: (() => void)[] = [];
afterEach(() => { configureSchedulerV2Merge(null); for (const close of cleanup.splice(0)) close(); });
function chain(action: ChainAction) {
  const c = claimChain(action);
  cleanup.push(c.close);
  return c;
}
/** The intent never left the lease term it was created in, and that term is the only one the center ever opened. */
function expectOneLiveTerm(c: ReturnType<typeof chain>) {
  const rows = c.center.rows();
  expect([rows.leaseTermSeq, rows.leaseTerms.get("T1"), rows.intentTerms.get(c.id)]).toEqual([1, 1, 1]);
  expect(rows.leases.get("T1")!.expiresAt).toBeGreaterThan(c.center.time);
}

describe("S2F5：认领过的意图在发送前后反复核验", () => {
  const cases: [number, "dispatch" | "review"][] = [[1, "dispatch"], [2, "review"]];
  for (const [line, action] of cases) {
    test(`[验收线 ${line}] ${action}：S2Q 认领 + X8 发送前后各核一次，发送 1 次，结果记完意图 done、资源释放`, async () => {
      const c = chain(action);
      expect(await c.claim()).toMatchObject({ ok: true, intent: { id: c.id, status: "submitted" } });
      expect(c.centerIntent()).toMatchObject({ status: "submitted", attempts: 1 });
      let sends = 0;
      const outcome = await executeSchedulerCentral(c.context(), c.runtime, c.journal, async () => {
        sends++;
        return { state: "succeeded", head: c.head, summary: "worker 已收单", artifactIds: [] };
      }, () => c.center.time);
      expect(outcome).toMatchObject({ state: "succeeded", reported: true, replayed: false, resourceHeld: false, reason: "recorded_result" });
      expect(sends).toBe(1);
      expect(c.served("intent.check")).toEqual([200, 200, 200]);
      expect(c.served("authorization.check")).toEqual([200, 200]);
      expect(c.served("operation.result")).toEqual([200]);
      expect(c.centerIntent()).toMatchObject({ id: c.id, operationId: c.id, status: "done", attempts: 1 });
      expect(c.center.rows().resources).toEqual([]);
      expect(c.center.rows().operationResults.get(c.id)).toMatchObject({ state: "succeeded", summary: "worker 已收单" });
      expectOneLiveTerm(c);
    });
  }

  test("[验收线 3] merge：认领后 S2J 列车门与实际合并前各核一次，合并 1 次，结果带 mergeSha，意图 done", async () => {
    const c = chain("merge"), PR = "https://github.com/team/repository/pull/1", SHA = "c".repeat(40);
    expect(await c.claim()).toMatchObject({ ok: true, intent: { id: c.id, status: "submitted" } });
    configureSchedulerV2Merge({
      route: () => "central", taskForPr: () => ({ taskId: "T1", projectId: "p", featureId: "feature-chain" }),
      context: (_task, head) => head === c.head ? c.context() : null, runtime: () => c.runtime, journal: c.journal,
    });
    let merges = 0;
    const external: MergeExternal = {
      inspect: async () => ({ state: merges ? "MERGED" : "OPEN", head: c.head, branch: "feat/example", base: "main", draft: false,
        crossRepository: false, mergeState: "CLEAN", mergeSha: merges ? SHA : null, checks: [{ name: "check", bucket: "pass" }] }),
      freshness: async () => ({ behindBy: 0, mainHead: SHA }), carryReview: async () => ({ ok: false, reason: "synthetic" }),
      updateBranch: async () => { throw new Error("no update expected"); },
      merge: async (pr, head) => { expect([pr, head]).toEqual([PR, c.head]); merges++; return SHA; },
    };
    const wrapped = withSchedulerV2Merge(external, { repoDir: "/synthetic/repository", requiredChecks: ["check"], maxActiveWorkers: 1 });
    const run: MergeRun = { intentId: c.id, taskId: "T1", project: "p", prRef: PR, reviewedHead: c.head, expectedBranch: "feat/example",
      requiredChecks: "check", phase: "await_ci", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };

    expect(await wrapped.train!(run)).toBeNull(); // not "wait": the gate's check passed and there is no train behind it
    expect(c.served("intent.check")).toEqual([200, 200]);
    expect(merges).toBe(0);
    expect(await wrapped.merge(PR, c.head)).toBe(SHA);
    expect(merges).toBe(1);
    expect(c.served("intent.check")).toEqual([200, 200, 200]);
    expect(c.served("authorization.check")).toEqual([200, 200]);
    expect(c.served("operation.result")).toEqual([200]);
    const result = c.center.rows().operationResults.get(c.id)!;
    expect(result).toMatchObject({ state: "succeeded", head: c.head });
    expect(parseSchedulerV2MergeSha(result.summary)).toBe(SHA);
    expect(c.centerIntent()).toMatchObject({ status: "done", attempts: 1 });
    expect(c.center.rows().resources).toEqual([]);
    expectOneLiveTerm(c);
  });
});
