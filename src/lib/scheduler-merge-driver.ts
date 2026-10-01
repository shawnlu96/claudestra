/** One bounded merge step per call. All external effects are preceded by a durable phase claim; `merged` is terminal. */
import type { MergeRun, MergePhase } from "./scheduler-merge.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export interface PrSnapshot {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  branch: string;
  crossRepository: boolean;
  base: string;
  draft: boolean;
  mergeState: string;
  mergeSha: string | null;
  checks: readonly { name: string; bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" }[];
}
export interface MergeExternal {
  inspect(pr: string): Promise<PrSnapshot>;
  updateBranch(pr: string): Promise<void>;
  merge(pr: string, expectedHead: string): Promise<string>;
}
export type MergeAdvance = (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;

const sameHead = (run: MergeRun, pr: PrSnapshot): boolean => pr.head.toLowerCase() === run.reviewedHead.toLowerCase();
const green = (run: MergeRun, checks: PrSnapshot["checks"]): boolean =>
  run.requiredChecks.split(",").every((name) => checks.some((c) => c.name === name && c.bucket === "pass")) &&
  checks.every((c) => c.bucket !== "fail" && c.bucket !== "cancel" && c.bucket !== "pending");
const short = (s: string) => s.slice(0, 12);
const failed = (checks: PrSnapshot["checks"]): boolean => checks.some((c) => c.bucket === "fail" || c.bucket === "cancel");
/** UNSTABLE = mergeable but some check isn't green yet (CI still running); a failed/cancelled check is a real anomaly. */
const unstableWait = (pr: PrSnapshot): "wait" | "failed" | null => pr.mergeState !== "UNSTABLE" ? null : failed(pr.checks) ? "failed" : "wait";

/** A changed head always returns to review; an unobserved merge is never retried. */
export async function driveMerge(run: MergeRun, external: MergeExternal, advance: MergeAdvance,
  assertActive: () => void = () => {}): Promise<MergeRun> {
  let current = run;
  const step = async (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => {
    assertActive();
    current = await advance(current.phase, to, current.rev, receipt, mergeSha, newHead);
    return current;
  };
  if (["merged", "unknown", "resolved", "await_review"].includes(run.phase)) return run;
  try {
    if (run.phase === "ready") {
      const pr = await external.inspect(run.prRef);
      if (pr.state !== "OPEN" || pr.crossRepository || pr.base !== "main" || pr.branch !== run.expectedBranch || !sameHead(run, pr)) {
        return step("unknown", `PR 状态、base 或审查 head 已变：${pr.state}/${pr.base}/${short(pr.head)}`);
      }
      if (pr.draft) return run;
      if (pr.mergeState === "BEHIND") {
        const claimed = await step("updating");
        assertActive();
        await external.updateBranch(run.prRef);
        return claimed;
      }
      if (pr.mergeState === "UNKNOWN") return run; // GitHub 尚未算出 mergeability，下一轮只读重查
      if (unstableWait(pr) === "failed") return step("unknown", "CI 失败或取消");
      if (pr.mergeState !== "CLEAN" && pr.mergeState !== "UNSTABLE") return step("unknown", `PR mergeState=${pr.mergeState}`);
      return step("await_ci", `PR ${short(pr.head)} 可合并，等待 CI`);
    }
    if (run.phase === "updating") {
      const pr = await external.inspect(run.prRef);
      if (pr.state !== "OPEN" || pr.base !== "main" || pr.crossRepository || pr.branch !== run.expectedBranch) return step("unknown", "更新分支后 PR 状态、分支或 base 已变");
      if (!sameHead(run, pr)) return step("await_review", `update-branch 改了 head：${short(pr.head)}，旧审查失效`, undefined, pr.head);
      if (pr.draft) return run;
      if (pr.mergeState === "BEHIND") return run; // GitHub 更新仍在进行，下一轮只读检查
      if (pr.mergeState === "UNKNOWN") return run;
      if (unstableWait(pr) === "failed") return step("unknown", "更新分支后 CI 失败或取消");
      if (pr.mergeState !== "CLEAN" && pr.mergeState !== "UNSTABLE") return step("unknown", `更新分支后 mergeState=${pr.mergeState}`);
      return step("await_ci", `head ${short(pr.head)} 未变，等待 CI`);
    }
    if (run.phase === "await_ci") {
      const pr = await external.inspect(run.prRef);
      // ready never journals await_ci for a draft, so a draft here is a change; UNSTABLE must not hide it behind the draft wait.
      if (pr.draft && pr.mergeState === "UNSTABLE") return step("unknown", "等 CI 时 PR 变成了 draft");
      if (pr.draft && sameHead(run, pr) && pr.state === "OPEN" && !pr.crossRepository &&
        pr.base === "main" && pr.branch === run.expectedBranch) return run;
      if (pr.mergeState === "UNKNOWN" && sameHead(run, pr) && pr.state === "OPEN" && !pr.draft && !pr.crossRepository &&
        pr.base === "main" && pr.branch === run.expectedBranch) return run;
      const unstable = unstableWait(pr); // The final pre-merge check below still demands CLEAN, so waiting here never merges early.
      if (unstable && sameHead(run, pr) && pr.state === "OPEN" && !pr.draft && !pr.crossRepository &&
        pr.base === "main" && pr.branch === run.expectedBranch) return unstable === "wait" ? run : step("unknown", "CI 失败或取消");
      if (!sameHead(run, pr) || pr.state !== "OPEN" || pr.draft || pr.crossRepository || pr.base !== "main" || pr.branch !== run.expectedBranch || pr.mergeState !== "CLEAN") {
        return step("unknown", "CI 前 PR/head/base/mergeability 变了");
      }
      if (pr.checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return step("unknown", "CI 失败或取消");
      if (!green(run, pr.checks)) return run;
      await step("merging", `CI 全绿：${pr.checks.map((c) => c.name).join(", ").slice(0, 300)}`);
      const fresh = await external.inspect(run.prRef);
      if (fresh.state !== "OPEN" || !sameHead(run, fresh) || fresh.branch !== run.expectedBranch || fresh.base !== "main" ||
        fresh.draft || fresh.crossRepository || fresh.mergeState !== "CLEAN" || !green(run, fresh.checks)) {
        return step("unknown", "合并前最后一次核对发现 PR/head/CI 已变");
      }
      assertActive();
      const mergeSha = await external.merge(run.prRef, run.reviewedHead);
      if (!/^[a-f0-9]{40}$/i.test(mergeSha)) return step("unknown", "merge API 未确认完整合并 SHA");
      const merged = await external.inspect(run.prRef);
      if (merged.state !== "MERGED" || merged.base !== "main" || !sameHead(run, merged) || merged.mergeSha !== mergeSha) {
        return step("unknown", "合并后 PR 目标分支、head 或合并提交无法核实");
      }
      return step("merged", `PR 已合并 ${short(mergeSha)}，待 PM 部署`, mergeSha);
    }
    if (run.phase === "merging") {
      const pr = await external.inspect(run.prRef);
      return pr.state === "MERGED" && pr.base === "main" && pr.mergeSha && /^[a-f0-9]{40}$/i.test(pr.mergeSha) && sameHead(run, pr)
        ? step("merged", `重启后核实 PR 已合并 ${short(pr.mergeSha)}，待 PM 部署`, pr.mergeSha)
        : step("unknown", "合并曾发出但未能核实结果，不重复 gh pr merge");
    }
    return run;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // Shutdown or lost ownership leaves the journal for the new controller to reconcile.
    if (["unknown", "merged"].includes(current.phase)) throw e;
    return step("unknown", `外部步骤失败：${(e as Error).message.slice(0, 450)}`);
  }
}
