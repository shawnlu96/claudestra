/**
 * merge-arch-EFFAUTO1 · red CI that fails only on the effect-site inventory counts is fixed by the scheduler itself, not bounced.
 * The merge queue's CI-red decision (scheduler-merge-ci-rerun.ts ciRerunOrBounce) asks effCountRefreshStep right before a
 * ci_fail would bounce to fix, with the failures parseFailedLog read, or (a bounce decided before the log was read, e.g. a run
 * already re-run: attempt > 1) a reader of the run's current failed log (currentCountFailures), called only when the key is not off.
 * The count class is the log's, never the rerun count's. Only when every failure belongs to one of COUNT_GROUPS (and the log
 * parsed) does anything happen. Recovery key effCountRefresh (default observe): off = null at once, the old bounce.
 * observe = try it in a scratch worktree (effect-count-refresh-git.ts), note would-refresh / would-not and why (exit code,
 * changed files, SKIPAUTO1 class), then null. on = a refreshable head whose branch is still the CI head is claimed `updating`
 * and the count-only commit pushed; the next pass meets the moved head on the driver's existing update-branch road (movedHead).
 * Anything else notes why and the bounce runs as before, receipt unchanged. One try per card and head in this process; a head
 * that is itself a refresh commit is never refreshed again (the git side refuses it), so a second count red goes back to fix.
 * tests/effect-count-refresh*.test.ts.
 */
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { parseFailedLog, type CiFailure } from "./scheduler-merge-ci-rerun-log.js";
import type { PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";
import { pushCountRefresh, remoteBranchHead, trialCountRefresh, REFRESH_SUBJECT, type RefreshPush, type RefreshPushInput, type RefreshTrial,
  type RefreshTrialInput } from "./effect-count-refresh-git.js";

export const EFF_COUNT_REFRESH_KEY = "effCountRefresh" as const;
/** The inventory tests a count-only red fails in: file → describe group (a case is the group itself or `group > …`). */
const COUNT_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  "tests/shared-ledger-v2-stage2-skip-paths.test.ts": "S2D2 effect-site inventory",
  "tests/skip-effects.test.ts": "EFFCNT1 real inventory end to end",
});
const LEAD = "效果点计数自动刷新";
type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface RefreshNote { taskId: string; actionKey: string; action: string; data: Record<string, unknown> }

/** Everything the step reaches outside itself; tests swap parts with useEffCountRefreshPorts. */
export interface EffCountRefreshPorts {
  mode(project: string): RecoveryMode;
  repoDir(project: string): string | null;
  trial(input: RefreshTrialInput): Promise<RefreshTrial>;
  remoteHead(repoDir: string, branch: string): Promise<string | null>;
  push(input: RefreshPushInput): Promise<RefreshPush>;
  note(note: RefreshNote): Promise<void>;
}

let writer: Manager | null = null;
const DEFAULT_PORTS: EffCountRefreshPorts = {
  /** Read every pass, never throws: an unreadable policy is off (the old bounce). */
  mode: (project) => {
    try {
      const p = recoveryPolicy(project, EFF_COUNT_REFRESH_KEY);
      return p.source === "error" ? "off" : p.mode;
    } catch { return "off"; } // an unreadable policy file stops the mechanism; the bounce it falls back to is the old behaviour
  },
  repoDir: (project) => readSchedulerConfig().projects[project]?.repoDir ?? null,
  trial: (input) => trialCountRefresh(input),
  remoteHead: (repoDir, branch) => remoteBranchHead(repoDir, branch),
  push: (input) => pushCountRefresh(input),
  note: async (n) => {
    if (!writer) throw new Error("合并 tick 没有绑定台账写口");
    const r = await writer("ledger", "scheduler-recovery-observe", n.taskId, "--mechanism", EFF_COUNT_REFRESH_KEY, "--action-key", n.actionKey,
      "--action", n.action, "--data", JSON.stringify(n.data));
    if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
  },
};
let ports: EffCountRefreshPorts = DEFAULT_PORTS;
/** card:head pairs already tried in this process (spec 6: one try per card and head). */
const tried = new Set<string>();
/** card:head → when its refresh commit was pushed: GitHub may still show the old red head for a moment after the push. */
const pushedAt = new Map<string, number>();
/** How long the `updating` run waits for GitHub to show the pushed head before the old red counts again (as BEHIND_SETTLE_MS). */
const PUSH_SETTLE_MS = 10 * 60_000;

/** One merge tick's ledger writer (`using` in mergeTick), cleared when the tick ends so no later driver writes through it. */
export function bindEffCountRefreshSink(manager: Manager, assertActive: () => void): Disposable {
  const mine: Manager = async (...args) => { assertActive(); return manager(...args); };
  writer = mine;
  return { [Symbol.dispose]: () => { if (writer === mine) writer = null; } };
}
/** Tests: replace some ports (and start from no tried heads) until disposed. */
export function useEffCountRefreshPorts(over: Partial<EffCountRefreshPorts>): Disposable {
  const before = ports, seen = [...tried];
  ports = { ...before, ...over };
  tried.clear(); pushedAt.clear();
  return { [Symbol.dispose]: () => { ports = before; tried.clear(); pushedAt.clear(); seen.forEach((k) => tried.add(k)); } };
}

type Failures = readonly CiFailure[] | null | undefined;
/** The failures the CI-red decision read, or a reader of them when it bounced before reading the log. */
export type CountFailures = Failures | (() => Promise<Failures>);
const RUN_LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/\S*)?$/;

/**
 * A reader of the current failed log of the one Actions run behind every failed check (`gh run view --log-failed` is the latest
 * attempt's), parsed as CIF1 parses it; several runs, no run link or any read error is null (not count-only: the old bounce).
 */
export function currentCountFailures(checks: readonly { link: string }[], gh: { failedLog(repo: string, runId: string): Promise<string> }):
  () => Promise<Failures> {
  return async () => {
    const runs = checks.map((c) => RUN_LINK.exec(c.link));
    if (!runs.length || runs.some((m) => !m) || new Set(runs.map((m) => `${m![1]}/${m![2]}`)).size !== 1) return null;
    try { return parseFailedLog(await gh.failedLog(runs[0]![1]!, runs[0]![2]!)); } catch { return null; }
  };
}

/** Every failure is a case of one of the two inventory groups; an empty or unparsed list never is. */
export function countOnlyRed(failures: readonly CiFailure[] | null | undefined): boolean {
  return !!failures?.length && failures.every((f) => {
    const group = COUNT_GROUPS[f.file];
    return !!group && (f.name === group || f.name.startsWith(`${group} > `)) && !f.timedOut;
  });
}

const short = (s: string) => s.slice(0, 12);
const repoOf = (prRef: string): string | null => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1] ?? null;
/** The run's own open PR at the head CI ran on, in a phase that may claim `updating`. */
const untouched = (run: MergeRun, pr: PrSnapshot): boolean => (run.phase === "ready" || run.phase === "await_ci") && pr.state === "OPEN" &&
  !pr.crossRepository && pr.base === "main" && pr.branch === run.expectedBranch && pr.head.toLowerCase() === run.reviewedHead.toLowerCase();
const entriesText = (t: Extract<RefreshTrial, { ok: true }>) => t.entries.map((e) => `${e.file} "${e.from}"→"${e.to}"`).join("，");

/**
 * A note never changes the merge path: a failed write is only logged. A lost lease still stops the pass, at the driver's next
 * step (each step asserts the lease first), so this module needs no import of the maintenance lock (that import is a cycle).
 */
async function note(run: MergeRun, kind: string, action: string, data: Record<string, unknown>): Promise<void> {
  try {
    await ports.note({ taskId: run.taskId, actionKey: `${kind}.${short(run.reviewedHead)}`, action, data });
  } catch (e) {
    console.error(`⚠️ [eff-count-refresh] ${run.taskId} 观察记录失败（不影响合并队列原路径）：${(e as Error).message.slice(0, 200)}`);
  }
}

/**
 * null = carry on to the old bounce, receipt unchanged; a run = this step claimed `updating` and pushed the count-only commit,
 * or (the push refused after the claim) `bounce` ended it as before.
 */
export async function effCountRefreshStep(run: MergeRun, pr: PrSnapshot, step: Step, read: CountFailures,
  bounce: () => Promise<MergeRun>, assertActive: () => void = () => {}): Promise<MergeRun | null> {
  const head = run.reviewedHead.toLowerCase(), key = `${run.taskId}:${head}`;
  const since = run.phase === "updating" && pr.head.toLowerCase() === head ? pushedAt.get(key) : undefined;
  if (since !== undefined) return Date.now() - since < PUSH_SETTLE_MS ? run : null; // our push not on GitHub yet: wait, then the old bounce
  if (!untouched(run, pr) || (typeof read !== "function" && !countOnlyRed(read))) return null;
  const mode = ports.mode(run.project);
  if (mode === "off" || tried.has(key)) return null;
  const failures = typeof read === "function" ? await read() : read;
  if (!countOnlyRed(failures)) return null;
  tried.add(key);
  const repoDir = ports.repoDir(run.project), repository = repoOf(run.prRef);
  const trial: RefreshTrial = !repoDir || !repository ? { ok: false, reason: "项目没有 repoDir 或 PR 链接不是 GitHub PR" }
    : await ports.trial({ repoDir, repository, branch: run.expectedBranch, head });
  assertActive();
  const facts: Record<string, unknown> = { mode, prHead: head, cases: failures!.map((f) => `${f.file} > ${f.name}`).slice(0, 10),
    ...(trial.ok ? { refreshSha: trial.sha, files: trial.files, entries: trial.entries, classification: "纯计数改动（SKIPAUTO1）" }
      : { reason: trial.reason, exitCode: trial.exitCode ?? null, files: trial.files ?? [], classification: trial.classification ?? null }) };
  if (mode === "observe") {
    await note(run, trial.ok ? "would" : "wouldnot", trial.ok ? `本可修：把计数提交 ${short(trial.sha)}（${entriesText(trial)}）推到 PR 分支，不退回 fix`
      : `不可修，仍退回 fix：${trial.reason}`, facts);
    return null;
  }
  if (!trial.ok) {
    await note(run, "failed", `${LEAD}没成，退回 fix：${trial.reason}`, facts);
    return null;
  }
  return pushAndClaim(run, trial, repoDir!, step, bounce, assertActive, facts);
}

/** The remote is checked before the durable `updating` claim, and again by the push; a push refused after the claim bounces as before. */
async function pushAndClaim(run: MergeRun, trial: Extract<RefreshTrial, { ok: true }>, repoDir: string, step: Step, bounce: () => Promise<MergeRun>,
  assertActive: () => void, facts: Record<string, unknown>): Promise<MergeRun | null> {
  const head = run.reviewedHead.toLowerCase();
  let remote: string | null;
  try { remote = await ports.remoteHead(repoDir, run.expectedBranch); } catch (e) { remote = `读不到：${(e as Error).message.slice(0, 100)}`; }
  assertActive();
  if (remote !== head) {
    await note(run, "failed", `${LEAD}没推，照原逻辑处理：PR 分支已不在 CI 的 head（远端 ${remote?.slice(0, 40) ?? "无"}）`, { ...facts, remote });
    return null;
  }
  let claimed: MergeRun;
  try {
    claimed = await step("updating", `${LEAD}（CI 只红在效果点计数）：CI head ${head} → 计数提交 ${trial.sha}（${REFRESH_SUBJECT}；${entriesText(trial)}）`.slice(0, 600));
  } catch (e) { // e.g. the await_ci → updating cap (MAX_CI_REFRESHES): the bounce below; a lost lease throws again at its step
    await note(run, "failed", `${LEAD}没推，照原逻辑退回 fix：认领 updating 被拒（${(e as Error).message.slice(0, 200)}）`, facts);
    return null;
  }
  if (claimed.phase !== "updating") return claimed;
  assertActive();
  const pushed = await ports.push({ repoDir, branch: run.expectedBranch, head, sha: trial.sha });
  if (pushed.ok) {
    pushedAt.set(`${run.taskId}:${head}`, Date.now());
    // the next pass reads the moved head in updatingStep → movedHead; the evidence for the review is this note
    await note(run, "pushed", `已推计数提交 ${short(trial.sha)}：审过的 head → 新 head 只有这一个计数提交（${entriesText(trial)}）`,
      { ...facts, oldHead: head, newHead: trial.sha, onlyCountCommit: true });
    return claimed;
  }
  await note(run, "failed", `${LEAD}推送没成，退回 fix：${pushed.reason}`, { ...facts, pushRefused: pushed.reason });
  return bounce();
}
