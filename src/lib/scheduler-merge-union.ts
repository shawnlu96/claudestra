/**
 * merge-arch-KEYUNION1 · the merge queue resolves a conflict that sits only in union-merged files (recovery-keys.ts) itself.
 * The driver asks mergeUnionStep on the direct path right before an untouched DIRTY PR would bounce as a conflict.
 * Recovery key mergeUnion (default observe): off = null at once, the old bounce. observe = try it locally
 * (scheduler-merge-union-git.ts), note would-resolve / would-not and why, then null. on = a resolvable PR is claimed `updating`
 * and the merge commit pushed to its branch; the next pass meets the moved head on the driver's existing update-branch road
 * (movedHead → main-carry proof → CI). Anything else notes "本地 union 解冲突没成：<why>" and the conflict bounce runs as before.
 */
import { mainCarryMergeMode } from "./review-main-carry-merge-proof.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { bounceStep } from "./scheduler-merge-conflict.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";
import { pushUnionMerge, trialUnionMerge, type UnionPush, type UnionPushInput, type UnionTrial, type UnionTrialInput } from "./scheduler-merge-union-git.js";

export const MERGE_UNION_KEY = "mergeUnion" as const;
export const UNION_FAILED = "本地 union 解冲突没成";
type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface UnionNote { taskId: string; actionKey: string; action: string; data: Record<string, unknown> }

/** Everything the step reaches outside itself; tests swap parts with useMergeUnionPorts. */
export interface MergeUnionPorts {
  mode(project: string): RecoveryMode;
  repoDir(project: string): string | null;
  carryMode(repoDir: string): RecoveryMode;
  trial(input: UnionTrialInput): Promise<UnionTrial>;
  push(input: UnionPushInput): Promise<UnionPush>;
  note(note: UnionNote): Promise<void>;
}

let writer: Manager | null = null;
const DEFAULT_PORTS: MergeUnionPorts = {
  /** Read every pass, never throws: an unreadable policy is off (the old bounce). */
  mode: (project) => {
    try {
      const p = recoveryPolicy(project, MERGE_UNION_KEY);
      return p.source === "error" ? "off" : p.mode;
    } catch { return "off"; } // an unreadable policy file stops the mechanism; the conflict bounce it falls back to is the old behaviour
  },
  repoDir: (project) => readSchedulerConfig().projects[project]?.repoDir ?? null,
  carryMode: (repoDir) => mainCarryMergeMode(repoDir),
  trial: (input) => trialUnionMerge(input),
  push: (input) => pushUnionMerge(input),
  note: async (n) => {
    if (!writer) throw new Error("合并 tick 没有绑定台账写口");
    const r = await writer("ledger", "scheduler-recovery-observe", n.taskId, "--mechanism", MERGE_UNION_KEY, "--action-key", n.actionKey,
      "--action", n.action, "--data", JSON.stringify(n.data));
    if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
  },
};
let ports: MergeUnionPorts = DEFAULT_PORTS;

/** One merge tick's ledger writer (`using` in mergeTick), cleared when the tick ends so no later driver writes through it. */
export function bindMergeUnionSink(manager: Manager, assertActive: () => void): Disposable {
  const mine: Manager = async (...args) => { assertActive(); return manager(...args); };
  writer = mine;
  return { [Symbol.dispose]: () => { if (writer === mine) writer = null; } };
}
/** Tests: replace some ports until disposed. */
export function useMergeUnionPorts(over: Partial<MergeUnionPorts>): Disposable {
  const before = ports;
  ports = { ...before, ...over };
  return { [Symbol.dispose]: () => { ports = before; } };
}

const short = (s: string) => s.slice(0, 12);
const repoOf = (prRef: string): string | null => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1] ?? null;
/** The run's own open PR at the reviewed head that GitHub refuses as DIRTY: the only case a conflict bounce would follow. */
const untouchedDirty = (run: MergeRun, pr: PrSnapshot): boolean => pr.mergeState === "DIRTY" && pr.state === "OPEN" && !pr.draft &&
  !pr.crossRepository && pr.base === "main" && pr.branch === run.expectedBranch && pr.head.toLowerCase() === run.reviewedHead.toLowerCase();

/** A note never changes the merge path: a failed write is logged, a lost lease still stops the pass. */
async function note(run: MergeRun, kind: string, action: string, data: Record<string, unknown>): Promise<void> {
  try {
    await ports.note({ taskId: run.taskId, actionKey: `${kind}.${short(run.reviewedHead)}.${short(String(data.mainHead ?? "-"))}`, action, data });
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [merge-union] ${run.taskId} 观察记录失败（不影响合并队列原路径）：${(e as Error).message.slice(0, 200)}`);
  }
}

/** null = carry on to the driver's conflict bounce; a run = this step claimed `updating` (pushed) or ended it. */
export async function mergeUnionStep(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, direct: boolean,
  assertActive: () => void = () => {}): Promise<MergeRun | null> {
  if (!direct || run.phase !== "ready" || !untouchedDirty(run, pr)) return null;
  const mode = ports.mode(run.project);
  if (mode === "off") return null;
  const repoDir = ports.repoDir(run.project), repository = repoOf(run.prRef);
  const carryMode = mode === "observe" ? "on" : repoDir ? ports.carryMode(repoDir) : "off"; // observe judges the both-on outcome
  const trial: UnionTrial = !repoDir || !repository ? { ok: false, reason: "项目没有 repoDir 或 PR 链接不是 GitHub PR" }
    : await ports.trial({ repoDir, repository, branch: run.expectedBranch, reviewedHead: run.reviewedHead.toLowerCase(), carryMode });
  assertActive();
  const facts = { mode, prHead: run.reviewedHead, mainHead: trial.mainHead ?? null, files: trial.files ?? [],
    ...(trial.ok ? { mergeSha: trial.mergeSha, proof: trial.proof } : { reason: trial.reason }) };
  if (mode === "observe") {
    await note(run, trial.ok ? "would" : "wouldnot", trial.ok ? `把 ${short(trial.mergeSha)}（union 合并 ${trial.files.join(", ")}）推到 PR 分支，不退回 fix`
      : `仍退回 fix：本地 union 解不了（${trial.reason}）`, facts);
    return null;
  }
  if (!trial.ok) {
    await note(run, "failed", `${UNION_FAILED}：${trial.reason}`, facts);
    return null;
  }
  return pushAndClaim(run, trial, repoDir!, external, step, assertActive, facts);
}

/** The durable `updating` claim precedes the push; a refused push re-reads the PR so an untouched DIRTY one bounces as before. */
async function pushAndClaim(run: MergeRun, trial: Extract<UnionTrial, { ok: true }>, repoDir: string, external: MergeExternal, step: Step,
  assertActive: () => void, facts: Record<string, unknown>): Promise<MergeRun> {
  const claimed = await step("updating", `本地 union 合并 main ${short(trial.mainHead)}：推 ${short(trial.mergeSha)} 到 PR 分支（${trial.files.join(", ")}）`);
  assertActive();
  const pushed = await ports.push({ repoDir, branch: run.expectedBranch, reviewedHead: run.reviewedHead.toLowerCase(), mergeSha: trial.mergeSha });
  if (pushed.ok) return claimed; // the next pass reads the moved head in updatingStep → movedHead (carry or re-review)
  await note(run, "failed", `${UNION_FAILED}：${pushed.reason}`, { ...facts, pushRefused: pushed.reason });
  const pr = await external.inspect(run.prRef);
  return (await bounceStep(claimed, pr, external, step)) ?? claimed; // not DIRTY + untouched any more: updatingStep judges it next pass
}
