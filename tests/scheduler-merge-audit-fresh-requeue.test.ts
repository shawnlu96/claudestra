/**
 * dispatch-recovery-MRGFRESH1 round 2 (review P1 auto-unsent-freezes): an auto card whose post-claim main read refuses the
 * merge must not freeze the queue. The real ledger CLI in-process, the real auto planner and merge tick, a fake GitHub port
 * whose main is pushed from inside the `merging` claim write. Temp ledger and temp recovery policy only; no network.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { MERGE_NOT_SENT } from "../src/lib/manual-merge-queue-facts.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { getMeta, listEvents } from "../src/lib/ledger-store.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";

const M0 = "0".repeat(40), M1 = "e".repeat(40), MERGED = "f".repeat(40);
const T0 = Date.UTC(2026, 9, 14);
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/mrgfresh1" } } });
let savedPolicy: string | null;
beforeEach(() => { savedPolicy = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; });
afterEach(() => {
  setSystemTime();
  if (savedPolicy === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
  else writeFileSync(RECOVERY_POLICY_PATH, savedPolicy);
});

async function fixture(policy: "on" | "observe" | "off") {
  const f = autoFixture();
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeUnsentCancel: policy } } } }));
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  await f.tick();
  expect((await f.review("pass", H1, [])).ok).toBe(true);
  await f.tick();
  f.db.query("UPDATE tasks SET pr=?, branch=? WHERE id='T1'").run("https://github.com/example/repo/pull/1", "task/T1");
  await f.tick();
  const hub = { main: M0, behind: 0, sent: [] as string[], mergeFails: false, onClaim: undefined as undefined | (() => void) };
  const gh: MergeExternal = {
    inspect: async () => ({ state: "OPEN", head: f.task().headSHA!, branch: "task/T1", base: "main", draft: false,
      crossRepository: false, mergeState: "CLEAN", checks: [{ name: "check", bucket: "pass" }], mergeSha: null }),
    freshness: async () => ({ behindBy: hub.behind, mainHead: hub.main }),
    carryReview: async () => ({ ok: false, reason: "unused" }),
    updateBranch: async () => { hub.sent.push("update-branch"); },
    merge: async () => { hub.sent.push("merge"); if (hub.mergeFails) throw new Error("gh api PUT merge 超时"); return MERGED; },
  };
  const intent = () => f.intents().filter((i) => i.action === "merge" && getIntent(f.db, i.id)?.taskId === "T1").at(-1)!.id;
  const run = () => getMergeRun(f.db, intent())!;
  const mergeTick = async (at: number) => {
    setSystemTime(new Date(at));
    await schedulerMergeTick(f.db, config, async (...args) => {
      const r = await f.cliWith({ now: () => Date.now() }, "scheduler", ...args.slice(1));
      if (args.includes("merging")) hub.onClaim?.(); // inside the awaited claim: the claim is on disk, the merge call not yet made
      return r;
    }, () => gh);
  };
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const markers = () => events().filter((e) => e.data.op === "merge_unsent_cancel");
  const frozen = () => getMeta(f.db, "p").queueFrozen.frozen;
  const decide = () => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
  /** Ready → await_ci on one tick, then await_ci → merging claim on the next. */
  const toClaim = async (at: number) => {
    await mergeTick(at);
    expect(run().phase).toBe("await_ci");
    await mergeTick(at + 1);
  };
  return { ...f, hub, gh, intent, run, mergeTick, events, markers, frozen, decide, toClaim };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function withFixture(policy: "on" | "observe" | "off", body: (f: F) => Promise<void>) {
  const f = await fixture(policy);
  try { await body(f); } finally { f.close(); }
}

describe("MRGFRESH1 auto 卡领取 merging 后 main 已变：不冻结，按未发出重排，下一次尝试刷新", () => {
  test("[验收线 1] 真实台账 + 规划 + 合并 tick：零次 merge，队列不冻结，同卡重排，新尝试从 ready 读到落后就 update-branch", async () => {
    await withFixture("on", async (f) => {
      f.hub.onClaim = () => { f.hub.main = M1; f.hub.behind = 1; };
      const first = f.intent();
      await f.toClaim(T0);
      expect(f.hub.sent).toEqual([]);
      expect(f.frozen()).toBe(false);
      expect(f.run().phase).toBe("resolved");
      expect(f.run().reason).toContain(`${MERGE_NOT_SENT}：领取 merging 期间 main 已变：CI 全绿时 main ${M0}，发出前 main ${M1}，落后 1 个提交`);
      expect(getIntent(f.db, first)?.status).toBe("cancelled");
      expect(f.markers()).toHaveLength(1);
      expect(f.markers()[0]!.data).toMatchObject({ intentId: first, phase: "merging", counted: true, cause: "main_moved_at_claim",
        receipt: expect.stringMatching(new RegExp(`^${MERGE_NOT_SENT}：领取 merging 期间 main 已变：`)) });
      // the real failed run is requeued by the planner, not a hand-made synthetic run
      f.hub.onClaim = undefined;
      expect(f.decide()).toMatchObject({ kind: "intent", action: "merge" });
      expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      const next = f.intent();
      expect(next).not.toBe(first);
      await f.mergeTick(T0 + 10); // the new run starts at ready, reads the branch as behind and refreshes instead of merging
      expect(f.hub.sent).toEqual(["update-branch"]);
      expect(f.run().phase).toBe("updating");
      expect(f.frozen()).toBe(false);
    });
  });

  test("[验收线 1] 领取后读不到 main 同样按未发出重排，不冻结", async () => {
    await withFixture("on", async (f) => {
      let reads = 0;
      const real = f.gh.freshness;
      f.gh.freshness = async (p, h) => { if (++reads === 3) throw new Error("gh compare 超时"); return real(p, h); };
      await f.toClaim(T0);
      expect([f.hub.sent, f.frozen(), f.run().phase]).toEqual([[], false, "resolved"]);
      expect(f.markers().map((m) => m.data.receipt)).toEqual([`${MERGE_NOT_SENT}：领取 merging 后读不到 main：gh compare 超时`]);
      expect(f.decide()).toMatchObject({ kind: "intent", action: "merge" });
    });
  });
});

describe("MRGFRESH1 其他原因的 auto merging→unknown 照旧冻结", () => {
  test("[验收线 2] merge API 已调用但失败：可能已发，冻结队列，没有 marker，不重排、不重发", async () => {
    await withFixture("on", async (f) => {
      f.hub.mergeFails = true;
      await f.toClaim(T0);
      expect(f.hub.sent).toEqual(["merge"]);
      expect(f.run().phase).toBe("unknown");
      expect(f.frozen()).toBe(true);
      expect(f.markers()).toHaveLength(0);
      await f.mergeTick(T0 + 5);
      expect(f.hub.sent).toEqual(["merge"]);
    });
  });

  test("[验收线 2] 重启看到 merging（可能已发）：mergingStep 的回执不是未发出，冻结，即使 main 已经前进", async () => {
    await withFixture("on", async (f) => {
      await f.mergeTick(T0);
      expect(f.run().phase).toBe("await_ci");
      // the claim lands, then the controller dies before anything else is journalled
      f.hub.onClaim = () => { throw new Error("controller crashed after claim"); };
      await f.mergeTick(T0 + 1).catch(() => {});
      f.hub.onClaim = undefined;
      expect(f.run().phase).toBe("merging");
      f.hub.main = M1; f.hub.behind = 1;
      await f.mergeTick(T0 + 2);
      expect(f.run().phase).toBe("unknown");
      expect(f.run().reason).not.toContain(MERGE_NOT_SENT);
      expect([f.frozen(), f.markers().length, f.hub.sent]).toEqual([true, 0, []]);
    });
  });

  test("[验收线 2] 恢复开关 observe / off：照旧冻结；observe 只记一条观察", async () => {
    for (const policy of ["observe", "off"] as const) await withFixture(policy, async (f) => {
      f.hub.onClaim = () => { f.hub.main = M1; f.hub.behind = 1; };
      await f.toClaim(T0);
      expect([f.hub.sent, f.run().phase, f.frozen(), f.markers().length]).toEqual([[], "unknown", true, 0]);
      expect(f.events().filter((e) => e.data.op === "recovery_observe" && e.data.cause === "main_moved_at_claim")).toHaveLength(policy === "observe" ? 1 : 0);
    });
  });
});
