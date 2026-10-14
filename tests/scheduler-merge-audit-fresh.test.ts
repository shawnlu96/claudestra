/**
 * dispatch-recovery-MRGFRESH1 (audit a03 A03-03): the serial merge path compares the main its CI went green against with one
 * more freshness read taken after the `merging` claim. main moving while the claim is awaited leaves an explicit unsent
 * receipt and no merge call; the next attempt refreshes. Train and mergeDirect members are not judged by "behind = 0".
 * The real driver over a fake GitHub port and a synthetic journal; one case over the real ledger CLI in a temp dir. No network.
 */
import { describe, expect, test } from "bun:test";
import { MERGE_NOT_SENT } from "../src/lib/manual-merge-queue-facts.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { readyChecks, withReady } from "./scheduler-merge-ci-ready-kit.test.js";

const H = "a".repeat(40), MERGED = "b".repeat(40), M0 = "0".repeat(40), M1 = "1".repeat(40);
const base: MergeRun = { intentId: "i", taskId: "T1", project: "p", prRef: "https://github.com/a/b/pull/1",
  reviewedHead: H, expectedBranch: "task/T1", requiredChecks: "check", phase: "await_ci", rev: 1, mergeSha: null,
  reason: null, createdAt: 1, updatedAt: 1 };
const pr = (p: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: H, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...p });

/** A fake GitHub whose main can be pushed from inside any journal write (the awaited claim), and a journal that records the order. */
function world(initial: MergeRun = base) {
  let row = { ...initial };
  const gh = { main: M0, behind: 0, snapshot: pr() };
  const calls: string[] = [];
  const hooks: { onJournal?: (to: MergeRun["phase"]) => void | Promise<void> } = {};
  const ops: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return gh.snapshot; },
    freshness: async (_, head) => { expect(head).toBe(H); calls.push(`fresh:${gh.main.slice(0, 1)}/${gh.behind}`); return { behindBy: gh.behind, mainHead: gh.main }; },
    carryReview: async () => ({ ok: false, reason: "不沿用" }),
    updateBranch: async () => { calls.push("update"); },
    merge: async (_, expectedHead) => { expect(expectedHead).toBe(H); calls.push("merge"); gh.snapshot = pr({ state: "MERGED", mergeSha: MERGED }); return MERGED; },
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string) => {
    expect([from, rev]).toEqual([row.phase, row.rev]);
    await Bun.sleep(0); // the claim is a real await: other writers get their turn inside it
    row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null, mergeSha: mergeSha ?? row.mergeSha };
    calls.push(`journal:${to}`);
    await hooks.onJournal?.(to);
    return row;
  };
  const push = () => { gh.main = M1; gh.behind = 1; };
  const merges = () => calls.filter((c) => c === "merge").length;
  return { get row() { return row; }, set row(r: MergeRun) { row = r; }, gh, calls, hooks, ops, advance, push, merges };
}

describe("MRGFRESH1 串行合并：claim 之后重核 main", () => {
  test("[验收线 1] merging claim 的 await 里 main 从 M0 推到 M1：零次 merge，留未发出回执，下一次尝试走刷新", async () => {
    const w = world();
    w.hooks.onJournal = (to) => { if (to === "merging") w.push(); };
    await driveMerge(w.row, w.ops, w.advance);
    expect(w.merges()).toBe(0);
    expect(w.calls).toEqual(["inspect", "fresh:0/0", "inspect", "journal:merging", "fresh:1/1", "journal:unknown"]);
    expect(w.row.phase).toBe("unknown");
    expect(w.row.reason).toBe(`${MERGE_NOT_SENT}：领取 merging 期间 main 已变：CI 全绿时 main ${M0}，发出前 main ${M1}，落后 1 个提交`);
    expect(w.row.mergeSha).toBeNull();
    // the unsent run is terminal for the driver: no later round sends for it
    await driveMerge(w.row, w.ops, w.advance);
    expect(w.merges()).toBe(0);
    // the attempt that follows (same head, same GitHub) starts from ready, reads the head as behind and refreshes instead of merging
    const next = world({ ...base, intentId: "i2", phase: "ready" });
    next.push();
    await driveMerge(next.row, next.ops, next.advance);
    expect(next.calls).toEqual(["inspect", "fresh:1/1", "journal:updating", "update"]);
    expect(next.row.phase).toBe("updating");
  });

  test("[验收线 1] main 头变了但 compare 仍报落后 0（main 被改写）也算漂移；读数失败或无效同样未发出，不当成可能已发", async () => {
    const rewritten = world();
    rewritten.hooks.onJournal = (to) => { if (to === "merging") rewritten.gh.main = M1; };
    await driveMerge(rewritten.row, rewritten.ops, rewritten.advance);
    expect([rewritten.merges(), rewritten.row.phase]).toEqual([0, "unknown"]);
    expect(rewritten.row.reason).toStartWith(`${MERGE_NOT_SENT}：领取 merging 期间 main 已变：`);

    const down = world();
    let reads = 0;
    const real = down.ops.freshness;
    down.ops.freshness = async (p, h) => { if (++reads === 2) throw new Error("gh compare\n 超时\u2028"); return real(p, h); };
    await driveMerge(down.row, down.ops, down.advance);
    expect([down.merges(), down.row.phase]).toEqual([0, "unknown"]);
    expect(down.row.reason).toBe(`${MERGE_NOT_SENT}：领取 merging 后读不到 main：gh compare 超时`);

    for (const bad of [{ behindBy: 0, mainHead: "main" }, { behindBy: -1, mainHead: M0 }, { behindBy: Number.NaN, mainHead: M0 }]) {
      const w = world();
      let n = 0;
      w.ops.freshness = async () => (++n === 2 ? bad : { behindBy: 0, mainHead: M0 });
      await driveMerge(w.row, w.ops, w.advance);
      expect([w.merges(), w.row.phase, w.row.reason]).toEqual([0, "unknown", `${MERGE_NOT_SENT}：领取 merging 后读不到 main：读数无效`]);
    }
  });

  test("[验收线 1] 重核期间丢了租约：不发 merge、不写 unknown，留给新控制方核对", async () => {
    const w = world();
    let active = true, reads = 0;
    const real = w.ops.freshness;
    w.ops.freshness = async (p, h) => { if (++reads === 2) active = false; return real(p, h); };
    await expect(driveMerge(w.row, w.ops, w.advance, () => { if (!active) throw new SchedulerStopped("lease lost"); })).rejects.toThrow(/lease lost/);
    expect(w.merges()).toBe(0);
    expect(w.row.phase).toBe("merging");
    const stop = world();
    reads = 0;
    stop.ops.freshness = async () => { if (++reads === 2) throw new SchedulerStopped("stopping"); return { behindBy: 0, mainHead: M0 }; };
    await expect(driveMerge(stop.row, stop.ops, stop.advance)).rejects.toThrow(/stopping/);
    expect([stop.merges(), stop.row.phase]).toEqual([0, "merging"]);
  });

  test("[验收线 1] 真实台账 CLI + 假 gh：claim 落盘后 main 前进 → PUT merge 零次，运行以「合并未发出」结束，之后不重发", async () => {
    await withReady(async (f) => {
      f.hub.snapshot.checks = readyChecks("pass", "pass"); f.hub.snapshot.mergeState = "CLEAN";
      await f.tick(); expect(f.row().phase).toBe("await_ci");
      f.hooks.afterWrite = (args) => { if (args.includes("merging")) f.hub.behind = 1; };
      await f.tick();
      expect(f.sent()).toEqual([]);
      expect(f.row().phase).toBe("unknown");
      expect(f.row().reason).toStartWith(`${MERGE_NOT_SENT}：领取 merging 期间 main 已变：`);
      expect(f.row().reason).toEndWith("落后 1 个提交");
      expect(f.row().mergeSha).toBeNull();
      f.hooks.afterWrite = undefined; f.hub.behind = 0;
      await f.tick(); await f.tick();
      expect(f.sent()).toEqual([]);
    });
  }, 180_000);

  test("[验收线 2] main、head、CI 都没动：恰好一次 merge，claim 后的 main 读数排在 merge 之前、台账重核之后才发", async () => {
    const w = world();
    const order: string[] = [];
    const recheck = (run: MergeRun) => { order.push(`recheck:${run.beforeSend === true}@${w.calls.length}`); return null; };
    await driveMerge(w.row, w.ops, w.advance, () => {}, recheck);
    expect(w.calls).toEqual(["inspect", "fresh:0/0", "inspect", "journal:merging", "fresh:0/0", "merge", "inspect", "journal:merged"]);
    expect(order).toEqual(["recheck:true@5"]); // after the post-claim read, right before the merge call
    expect([w.merges(), w.row.phase, w.row.mergeSha]).toEqual([1, "merged", MERGED]);
    await driveMerge(w.row, w.ops, w.advance, () => {}, recheck);
    expect(w.merges()).toBe(1);
  });

  test("[验收线 2] 台账漂移仍拒：claim 后 main 没动、台账重核拒绝 → 零次 merge，回执是台账原因", async () => {
    const w = world();
    await driveMerge(w.row, w.ops, w.advance, () => {}, (run) => (run.beforeSend ? "任务 head 已变化，旧审查失效" : null));
    expect([w.merges(), w.row.phase, w.row.reason]).toEqual([0, "unknown", `${MERGE_NOT_SENT}：任务 head 已变化，旧审查失效`]);
    expect(w.calls).toEqual(["inspect", "fresh:0/0", "inspect", "journal:merging", "fresh:0/0", "journal:unknown"]);
  });

  test("[验收线 2] PR head / base 在最后一次核对漂移仍拒：不领 merging、不发 merge", async () => {
    for (const moved of [pr({ head: "c".repeat(40) }), pr({ base: "release" }), pr({ checks: [{ name: "check", bucket: "pending" }] })]) {
      const w = world();
      let reads = 0;
      w.ops.inspect = async () => { w.calls.push("inspect"); return ++reads === 1 ? pr() : moved; };
      await driveMerge(w.row, w.ops, w.advance);
      expect([w.merges(), w.row.phase, w.row.reason]).toEqual([0, "unknown", "合并前最后一次核对发现 PR/head/CI 已变"]);
      expect(w.calls).not.toContain("journal:merging");
    }
  });

  test("[验收线 2] 重启看到 merging：可能已发，只核实不重发，也不拿 main 读数把它改判成未发出", async () => {
    const w = world({ ...base, phase: "merging" });
    w.push();
    await driveMerge(w.row, w.ops, w.advance);
    expect(w.calls).toEqual(["inspect", "journal:unknown"]);
    expect(w.row.reason).toBe("合并曾发出但未能核实结果，不重复 gh pr merge");
    expect(w.row.reason).not.toContain(MERGE_NOT_SENT);
    const landed = world({ ...base, phase: "merging" });
    landed.gh.snapshot = pr({ state: "MERGED", mergeSha: MERGED });
    await driveMerge(landed.row, landed.ops, landed.advance);
    expect([landed.merges(), landed.row.phase, landed.row.mergeSha]).toEqual([0, "merged", MERGED]);
  });

  test("等 CI 时已经落后（claim 之前）照旧走刷新：updating + update-branch，不领 merging", async () => {
    const w = world();
    w.push();
    await driveMerge(w.row, w.ops, w.advance);
    expect(w.calls).toEqual(["inspect", "fresh:1/1", "journal:updating", "update"]);
  });

  test("列车成员凭整车联合证明合并：claim 前重问列车，不拿串行的 behind=0 判它，main 在 claim 期间前进也照发", async () => {
    const w = world();
    let asked = 0;
    w.ops.train = async () => { asked++; w.calls.push("train"); return "cleared"; };
    w.hooks.onJournal = (to) => { if (to === "merging") w.push(); };
    await driveMerge(w.row, w.ops, w.advance);
    expect(w.calls).toEqual(["inspect", "train", "fresh:0/0", "inspect", "train", "journal:merging", "merge", "inspect", "journal:merged"]);
    expect([asked, w.merges(), w.row.phase]).toEqual([2, 1, "merged"]);
    // a train voided before the claim still sends nothing and claims nothing
    const voided = world();
    let n = 0;
    voided.ops.train = async () => (++n === 1 ? "cleared" : "wait");
    await driveMerge(voided.row, voided.ops, voided.advance);
    expect([voided.merges(), voided.row.phase]).toEqual([0, "await_ci"]);
    // behind main with a still-cleared train: the joint proof stands, no refresh, no serial re-read
    const behind = world();
    behind.push();
    behind.ops.train = async () => "cleared";
    await driveMerge(behind.row, behind.ops, behind.advance);
    expect(behind.calls).toEqual(["inspect", "fresh:1/1", "inspect", "journal:merging", "merge", "inspect", "journal:merged"]);
  });

  test("mergeDirect 不追 main：不读 freshness，BEHIND 照合", async () => {
    const w = world();
    w.ops.direct = () => true;
    w.gh.snapshot = pr({ mergeState: "BEHIND" });
    w.hooks.onJournal = (to) => { if (to === "merging") w.push(); };
    await driveMerge(w.row, w.ops, w.advance);
    expect(w.calls.filter((c) => c.startsWith("fresh"))).toEqual([]);
    expect([w.merges(), w.row.phase]).toEqual([1, "merged"]);
  });
});
