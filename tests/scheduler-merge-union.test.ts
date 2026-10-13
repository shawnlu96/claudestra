/**
 * KEYUNION1 through the real merge driver with stubbed git ports: mergeUnion off is today's conflict bounce with no trial at all,
 * observe tries, notes would / would-not once and still bounces, on claims `updating` and pushes; the next pass carries the moved
 * head into await_ci on the existing update-branch road. A head that moved before the push is never pushed over.
 */
import { describe, expect, test } from "bun:test";
import { driveMerge, type MergeExternal, type PrSnapshot, type ReviewCarry } from "../src/lib/scheduler-merge-driver.js";
import { MERGE_UNION_KEY, useMergeUnionPorts, type MergeUnionPorts, type UnionNote } from "../src/lib/scheduler-merge-union.js";
import type { UnionPushInput, UnionTrial, UnionTrialInput } from "../src/lib/scheduler-merge-union-git.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import type { MergePhase, MergeRun } from "../src/lib/scheduler-merge.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";

const HEAD = "a".repeat(40), MAIN = "b".repeat(40), MERGED = "c".repeat(40);
const PR_REF = "https://github.com/example/union/pull/7";
const CONFLICT = `退回 fix（conflict）：PR head ${HEAD}，main head ${MAIN}`;
const OK: UnionTrial = { ok: true, mergeSha: MERGED, mainHead: MAIN, files: ["src/lib/recovery-keys.ts"], proof: "干净合并：…" };
const OTHER: UnionTrial = { ok: false, reason: "冲突不只在 union 文件：src/x.ts", mainHead: MAIN, files: ["src/lib/recovery-keys.ts", "src/x.ts"] };

interface Seen { trials: UnionTrialInput[]; pushes: UnionPushInput[]; notes: UnionNote[]; steps: { to: MergePhase; receipt?: string; newHead?: string }[] }

async function drive(opts: { mode: RecoveryMode; trial?: UnionTrial; push?: { ok: true } | { ok: false; moved: boolean; reason: string };
  direct?: boolean; phase?: MergePhase; pr?: Partial<PrSnapshot>; after?: Partial<PrSnapshot>; carry?: ReviewCarry; carryMode?: RecoveryMode; noteFails?: boolean }) {
  const seen: Seen = { trials: [], pushes: [], notes: [], steps: [] };
  let run = { intentId: "i", taskId: "t", project: "p", prRef: PR_REF, expectedBranch: "card", reviewedHead: HEAD, requiredChecks: "test",
    phase: opts.phase ?? "ready", rev: 1, mergeSha: null, reason: null, unknownSince: null } as unknown as MergeRun;
  let pr: PrSnapshot = { state: "OPEN", head: HEAD, branch: "card", crossRepository: false, base: "main", draft: false, mergeState: "DIRTY",
    mergeSha: null, checks: [], ...opts.pr };
  const external: MergeExternal = { inspect: async () => pr, freshness: async () => ({ behindBy: 1, mainHead: MAIN }),
    carryReview: async () => opts.carry ?? { ok: false, reason: "no carry" }, updateBranch: async () => { throw new Error("no update-branch"); },
    merge: async () => { throw new Error("no merge"); }, direct: () => opts.direct ?? true, unknownRereadMs: 0 };
  const ports: Partial<MergeUnionPorts> = { mode: () => opts.mode, repoDir: () => "/repo", carryMode: () => opts.carryMode ?? "on",
    trial: async (i) => { seen.trials.push(i); return opts.trial ?? OK; },
    push: async (i) => { seen.pushes.push(i); if (opts.after) pr = { ...pr, ...opts.after }; return opts.push ?? { ok: true }; },
    note: async (n) => { seen.notes.push(n); if (opts.noteFails) throw new Error("ledger down"); } };
  using _ports = useMergeUnionPorts(ports);
  const final = await driveMerge(run, external, async (_from, to, _rev, receipt, _sha, newHead) => {
    seen.steps.push({ to, receipt, ...(newHead ? { newHead } : {}) });
    run = { ...run, phase: to, rev: run.rev + 1, ...(to === "await_ci" && newHead ? { reviewedHead: newHead } : {}) };
    return run;
  });
  return { ...seen, final };
}

describe("mergeUnion in the merge driver", () => {
  test("the key exists and is a recovery key", () => {
    expect(RECOVERY_KEYS).toContain(MERGE_UNION_KEY);
  });

  test("[验收线 3] off: the conflict bounce exactly as before, no trial, no note, no push", async () => {
    const off = await drive({ mode: "off" });
    expect(off.steps).toEqual([{ to: "resolved", receipt: CONFLICT }]);
    expect([off.trials.length, off.notes.length, off.pushes.length]).toEqual([0, 0, 0]);
    const notDirect = await drive({ mode: "on", direct: false }); // mergeDirect off: the hook never runs either
    expect(notDirect.steps).toEqual([{ to: "resolved", receipt: CONFLICT }]);
    expect(notDirect.trials).toHaveLength(0);
  });

  test("[验收线 3] observe: tries once with the both-on carry mode, notes would-resolve and still bounces, nothing pushed", async () => {
    const r = await drive({ mode: "observe", carryMode: "observe" });
    expect(r.steps).toEqual([{ to: "resolved", receipt: CONFLICT }]);
    expect(r.trials).toEqual([{ repoDir: "/repo", repository: "example/union", branch: "card", reviewedHead: HEAD, carryMode: "on" }]);
    expect(r.pushes).toHaveLength(0);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({ taskId: "t", actionKey: `would.${HEAD.slice(0, 12)}.${MAIN.slice(0, 12)}`,
      data: { mode: "observe", prHead: HEAD, mainHead: MAIN, mergeSha: MERGED, files: ["src/lib/recovery-keys.ts"] } });
    expect(r.notes[0]!.action).toContain("不退回 fix");
  });

  test("[验收线 3] observe: an unresolvable conflict notes would-not with the reason", async () => {
    const r = await drive({ mode: "observe", trial: OTHER });
    expect(r.steps).toEqual([{ to: "resolved", receipt: CONFLICT }]);
    expect(r.notes.map((n) => [n.actionKey.split(".")[0], n.action])).toEqual([["wouldnot", "仍退回 fix：本地 union 解不了（冲突不只在 union 文件：src/x.ts）"]]);
  });

  test("[验收线 2] on: claims updating before the push, pushes the merge commit and does not bounce", async () => {
    const r = await drive({ mode: "on", carryMode: "observe" });
    expect(r.trials[0]!.carryMode).toBe("observe"); // on judges with the live mainCarryMerge mode the post-push carry will use
    expect(r.steps.map((s) => s.to)).toEqual(["updating"]);
    expect(r.steps[0]!.receipt).toContain(MERGED.slice(0, 12));
    expect(r.pushes).toEqual([{ repoDir: "/repo", branch: "card", reviewedHead: HEAD, mergeSha: MERGED }]);
    expect(r.notes).toHaveLength(0);
    expect(r.final.phase).toBe("updating");
  });

  test("[验收线 2] on, next pass: the pushed head goes the update-branch road — carried into await_ci, or back to review", async () => {
    const moved = { head: MERGED, mergeState: "CLEAN" };
    const carried = await drive({ mode: "on", phase: "updating", pr: moved,
      carry: { ok: true, reason: "干净合并", mainParent: MAIN, mainHead: MAIN, diffHash: "d".repeat(64) } });
    expect(carried.steps.map((s) => [s.to, s.newHead])).toEqual([["await_ci", MERGED]]);
    expect(carried.trials).toHaveLength(0);
    const refused = await drive({ mode: "on", phase: "updating", pr: moved, carry: { ok: false, reason: "净 diff 变了" } });
    expect(refused.steps.map((s) => [s.to, s.newHead])).toEqual([["await_review", MERGED]]);
  });

  test("[验收线 2] on: a conflict outside union files bounces to fix as before with a failure note, nothing pushed", async () => {
    const r = await drive({ mode: "on", trial: OTHER });
    expect(r.steps).toEqual([{ to: "resolved", receipt: CONFLICT }]);
    expect(r.pushes).toHaveLength(0);
    expect(r.notes.map((n) => n.action)).toEqual(["本地 union 解冲突没成：冲突不只在 union 文件：src/x.ts"]);
  });

  test("[验收线 4] the PR head is no longer the reviewed one: no trial and no push, the driver's moved-head road", async () => {
    const r = await drive({ mode: "on", pr: { head: MERGED } });
    expect([r.trials.length, r.pushes.length]).toEqual([0, 0]);
    expect(r.steps.map((s) => s.to)).toEqual(["await_review"]);
  });

  test("[验收线 4] the branch moved between trial and push: the push is refused, the original logic decides", async () => {
    const moved = { ok: false as const, moved: true, reason: "PR 分支已不在审过的 head（远端 dddddddddddd）" };
    const still = await drive({ mode: "on", push: moved }); // GitHub still shows the reviewed head DIRTY: the old conflict bounce
    expect(still.steps.map((s) => [s.to, s.receipt])).toEqual([["updating", expect.any(String)], ["resolved", CONFLICT]]);
    expect(still.notes.map((n) => n.action)).toEqual([`本地 union 解冲突没成：${moved.reason}`]);
    const author = await drive({ mode: "on", push: moved, after: { head: "d".repeat(40) } }); // the author's push: judged next pass
    expect(author.steps.map((s) => s.to)).toEqual(["updating"]);
    expect(author.final.phase).toBe("updating");
  });

  test("a failing note never changes the path", async () => {
    const r = await drive({ mode: "on", trial: OTHER, noteFails: true });
    expect(r.notes).toHaveLength(1);
    expect(r.steps).toEqual([{ to: "resolved", receipt: CONFLICT }]);
  });
});
