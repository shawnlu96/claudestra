/**
 * A red merge train car is classified before it is bisected (merge-arch-CLASS1), recovery key ciTrainFailureClass (absent = observe):
 * - off, no port, no run calls on the gh, or anything here throwing: the engine goes on exactly as before (redCar: pin / split).
 * - observe: one deduped ledger note of the re-run on would send and why; then the same bisect.
 * - on: a red whose log is only untouched test timeouts (CIF1's rule), only valid known flaky tests (CIF8's list) or a definite
 *   environment fault (ci-failure-class.ts), in a completed first attempt of the car's own run, is re-run once. "Untouched" is
 *   judged against the union of every member's files. The claim is durable before `gh run rerun` is sent and shares CIF1's
 *   budget (scheduler-train-ci-rerun-state.ts), so a restart, a second process or a failed rerun call never sends a second one.
 *   Only a newer attempt of that run is the re-run's result: green → the car is green; red again, never started within
 *   RERUN_SETTLE_MS, not eligible, or unknown → the same bisect. A re-run that went green proves nothing about the test.
 *   An environment fault that cannot be re-run or is still there after it → giveUp (members serial, PM alarm): no card is
 *   pinned by tests that never ran. That holds for a run a person re-ran too: it is never re-run again, its head's budget is
 *   written down as spent, and its last attempt is still read for the environment fault.
 * Nothing here touches another car or moves `startedAt`: the train deadline and the hold limit count exactly as before, and a
 * main / head drift voids the train before this is asked. Waiting for a re-run ends at the car timeout counted from the car's
 * start, whatever the checks show: under trainCiTimeout on the car goes to TRAINHANG's own cancel + diagnosis (carTimedOut, this
 * car's runs only), otherwise the wait just ends (red → the same bisect).
 */
import { classifyFailedLog, type FailureClass } from "./ci-failure-class.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { RERUN_SETTLE_MS } from "./scheduler-merge-ci-rerun.js";
import type { TrainCar, TrainCheck, TrainGh, TrainState } from "./scheduler-merge-train.js";
import { contentKey, KIND_TEXT, type RerunKind, type RerunMember, type TrainCiClassPort, type TrainRerunRecord } from "./scheduler-train-ci-rerun-state.js";
import { carTimedOut, ciTimeoutMode, type TimeoutOps, type TrainCiTimeoutPort } from "./train-ci-timeout.js";

export type { TrainCiClassPort } from "./scheduler-train-ci-rerun-state.js";

/** GitHub calls of this module (scheduler-merge-train-gh.ts); a run is only ever read through the car's own `train/` branch. */
export interface TrainRerunGh {
  /** Throws unless the run's head branch is `branch`. `attempt` > 1 = it was re-run (by this, or by a person). */
  runAttempt(repo: string, run: number, branch: string): Promise<{ attempt: number; status: string; conclusion: string }>;
  /** `gh run view --log-failed`, whole; throws when it may have been cut. */
  failedLog(repo: string, run: number): Promise<string>;
  rerunFailed(repo: string, run: number): Promise<void>;
}
interface Deps { gh: TrainGh; now(): number; ciClass?: TrainCiClassPort; ciTimeout?: TrainCiTimeoutPort }

/**
 * A red car whose run is still going is waited for only this long after the car's CI started (well inside the car timeout);
 * past it the red is bisected as before, so a hung sibling job never keeps a red car (and the slot) waiting.
 */
export const RUN_FINISH_WAIT_MS = 30 * 60_000;
/** The engine's car timeout (scheduler-merge-train.ts TRAIN_CI_TIMEOUT_MS, as scheduler-merge-train-hold.ts mirrors it): no wait here outlasts it. */
const CAR_CI_TIMEOUT_MS = 60 * 60_000;
const errText = (e: unknown) => (e as Error).message.trim().split("\n")[0]?.slice(0, 200) ?? "";
const rerunGh = (gh: TrainGh): TrainRerunGh | null => {
  const g = gh as TrainGh & Partial<TrainRerunGh>;
  return g.runAttempt && g.failedLog && g.rerunFailed ? (g as TrainGh & TrainRerunGh) : null;
};
const membersOf = (s: TrainState, car: TrainCar): RerunMember[] =>
  car.members.map((id) => ({ taskId: id, head: s.members.find((m) => m.taskId === id)!.head }));
const label = (s: TrainState, car: TrainCar) => `车厢 ${car.id}（${car.members.join("、")}）`;

interface Plan { kind: RerunKind; runId: number; link: string; reason: string; files: string[] }
/** `manual` = the run was re-run by somebody else (attempt past the first, no claim of this car). */
type Judged = ({ plan: Plan } | { wait: true } | { no: string; env?: string }) & { manual?: { run: string; attempt: number } };

/** The one Actions run of this repo behind every failed check, or null. */
function runOf(s: TrainState, checks: readonly TrainCheck[]): number | null {
  const ids = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) =>
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/\S*)?$/.exec(c.link ?? "")).map((m) => (m && m[1] === s.repo ? Number(m[2]) : null));
  return ids.length && ids[0] !== null && ids.every((id) => id === ids[0]) && Number.isSafeInteger(ids[0]) ? ids[0] : null;
}

const planOf = (cls: FailureClass, listed: string[] | null): Pick<Plan, "kind" | "reason" | "files"> | null => {
  if (cls.kind === "timeout") return { kind: "timeout", files: cls.files, reason: `所有失败都是测试超时，且都不在车厢成员的改动里：${cls.cases.join("、")}`.slice(0, 300) };
  if (cls.kind === "known_flaky") {
    const reason = `失败的测试文件都在有效的已知偶发清单里，且都不在车厢成员的改动里：${listed?.join("、")}`.slice(0, 300);
    return listed && { kind: "known_flaky", files: cls.files, reason };
  }
  return cls.kind === "env" ? { kind: "env", files: [], reason: `${cls.signature}（失败步骤 ${cls.step}）`.slice(0, 300) } : null;
};

/**
 * Whether this red may be re-run, read from GitHub and the ledger; nothing is written. A run somebody already re-ran is never
 * re-run, but its log is still read: `env` says the tests could not run, which no bisect may pin on a member.
 */
async function judge(s: TrainState, car: TrainCar, checks: readonly TrainCheck[], gh: TrainRerunGh, port: TrainCiClassPort, now: number): Promise<Judged> {
  const runId = runOf(s, checks);
  if (runId === null) return { no: "失败检查不是同一个本仓 Actions run" };
  const at = await gh.runAttempt(s.repo, runId, car.branch), link = `https://github.com/${s.repo}/actions/runs/${runId}`;
  const manual = at.attempt === 1 ? {} : { manual: { run: link, attempt: at.attempt } };
  if (at.status !== "completed") return now - car.startedAt < RUN_FINISH_WAIT_MS ? { wait: true, ...manual } : { no: "run 迟迟没有跑完", ...manual };
  const members = s.members.filter((m) => car.members.includes(m.taskId));
  if (members.length !== car.members.length || members.some((m) => !Array.isArray(m.files) || !m.files.length)) return { no: "车厢成员的改动文件不全", ...manual };
  const cls = classifyFailedLog(await gh.failedLog(s.repo, runId), new Set(members.flatMap((m) => m.files)));
  const plan = planOf(cls, cls.kind === "known_flaky" ? port.listed(s.project, cls.files) : null);
  if (!plan) {
    return { no: cls.kind === "known_flaky" ? "失败的测试文件不都在有效的已知偶发清单里" : cls.kind === "code" || cls.kind === "unknown" ? cls.why : "不合资格", ...manual };
  }
  const env = plan.kind === "env" ? { env: plan.reason } : {};
  if (at.attempt !== 1) return { no: `run 已被重跑过（第 ${at.attempt} 次）`, ...env, ...manual };
  const spent = port.spent(membersOf(s, car));
  if (spent) return { no: `${spent} 这个 head 的自动重跑已经用过`, ...env };
  return { plan: { ...plan, runId, link } };
}

/** The environment keeps the tests from running: nobody is pinned, the batch goes serial and the PM on duty decides. */
async function toPm<D extends Deps>(s: TrainState, car: TrainCar, deps: D, ops: TimeoutOps<D>, why: string): Promise<true> {
  await ops.giveUp(s, deps, `${label(s, car)}环境故障，测试没能跑完（${why}），不按没执行的测试定位`);
  return true;
}

/**
 * The car already claimed its re-run: only a newer attempt of that run is its result. true = held (PM has the batch),
 * "wait" = the result is not there yet, false = the engine judges.
 */
async function afterRerun<D extends Deps>(s: TrainState, car: TrainCar, checks: readonly TrainCheck[], green: boolean, prior: TrainRerunRecord,
  gh: TrainRerunGh, deps: D, ops: TimeoutOps<D>): Promise<boolean | "wait"> {
  if (prior.content !== contentKey(s.base, membersOf(s, car))) return false; // evidence of other content: void, the engine judges as before
  const runId = Number(/\/(\d+)$/.exec(prior.run)?.[1]);
  const at = await gh.runAttempt(s.repo, runId, car.branch);
  if (at.attempt <= prior.attempt) {
    if (deps.now() - prior.ts < RERUN_SETTLE_MS) return "wait"; // the rerun may not have shown up yet
    if (!green) return prior.kind === "env" ? toPm(s, car, deps, ops, `重跑没有开始 ${prior.run}`) : false; // the first red stands
    await ops.giveUp(s, deps, `${label(s, car)}检查变绿，但认领的重跑 ${prior.run} 没有新一次结果，未定位`);
    return true;
  }
  if (at.status !== "completed") return "wait";
  if (green) return false; // the new attempt is over and every required check passed: the car is green
  if (at.conclusion === "success") return runOf(s, checks) === runId && "wait"; // the red shown is still that run's old attempt: wait for the checks
  if (prior.kind !== "env") return false; // red again: bisect
  const again = classifyFailedLog(await gh.failedLog(s.repo, runId), new Set());
  return again.kind === "env" ? toPm(s, car, deps, ops, `重跑后仍是 ${again.signature}，失败步骤 ${again.step}，${prior.run}`) : false;
}

/**
 * The re-run's result is awaited, but never past the car timeout (TRAINHANG's clock: the car's own start, which a re-run does
 * not move). A red or stale check next to a job that hangs is not `pending` to the engine, so its own timeout would not fire:
 * past the limit the checks that did not pass go to carTimedOut as what they are, not final. trainCiTimeout not on → the wait
 * ends: the first red stands (bisect); a green nobody could confirm goes to PM.
 */
async function waitRerun<D extends Deps>(s: TrainState, car: TrainCar, checks: readonly TrainCheck[], green: boolean, prior: TrainRerunRecord,
  deps: D, ops: TimeoutOps<D>): Promise<boolean> {
  if (deps.now() - car.startedAt <= CAR_CI_TIMEOUT_MS) return true;
  if (ciTimeoutMode(s, deps) === "on") {
    return carTimedOut(s, car, checks.map((c) => (c.bucket === "fail" || c.bucket === "cancel" ? { ...c, bucket: "pending" as const } : c)), deps, ops);
  }
  if (green) await ops.giveUp(s, deps, `${label(s, car)}检查变绿，但认领的重跑 ${prior.run} 到车厢时限仍没有跑完，未定位`);
  return green;
}

async function classify<D extends Deps>(s: TrainState, car: TrainCar, checks: readonly TrainCheck[], green: boolean, deps: D,
  ops: TimeoutOps<D>): Promise<boolean> {
  const port = deps.ciClass, gh = rerunGh(deps.gh);
  if (!port || !gh) return false;
  const mode = port.mode(s.project);
  if (mode === "off") return false;
  const prior = port.claimOf(s.project, s.id, car.id);
  if (prior) { // observe never waits: the budget is spent, so no note either
    const held = mode === "on" && await afterRerun(s, car, checks, green, prior, gh, deps, ops);
    return held === "wait" ? waitRerun(s, car, checks, green, prior, deps, ops) : held;
  }
  if (green) return false;
  const j = await judge(s, car, checks, gh, port, deps.now());
  if (mode === "on" && j.manual) port.seen({ project: s.project, train: s.id, car: car.id, members: membersOf(s, car), ...j.manual });
  if ("wait" in j) return mode === "on";
  if ("no" in j) return mode === "on" && j.env ? toPm(s, car, deps, ops, `${j.env}；${j.no}`) : false;
  const { plan } = j;
  if (mode !== "on") {
    port.observe(s.project, s.id, car.id, `重跑${label(s, car)}的 CI 一次（判为${KIND_TEXT[plan.kind]}：${plan.reason}）${plan.link}（这次仍旧二分）`.slice(0, 500),
      { train: s.id, car: car.id, members: car.members, run: plan.link, class: plan.kind, files: plan.files });
    return false;
  }
  const got = port.claim({ project: s.project, train: s.id, car: car.id, base: s.base, members: membersOf(s, car), run: plan.link, attempt: 1,
    kind: plan.kind, files: plan.files, reason: plan.reason });
  if (got !== "claimed") return plan.kind === "env" ? toPm(s, car, deps, ops, `${plan.reason}；自动重跑已经用过`) : false;
  try { await gh.rerunFailed(s.repo, plan.runId); }
  catch (e) {
    console.error(`⚠️ [merge-train] ${label(s, car)}的 gh run rerun 失败，不再重跑：${errText(e)}`);
    return plan.kind === "env" ? toPm(s, car, deps, ops, `${plan.reason}；重跑没发出去`) : false;
  }
  await ops.emit(s, deps, "ci", `${label(s, car)}CI 红判为${KIND_TEXT[plan.kind]}，自动重跑一次，等新一次结果再判：${plan.reason} ${plan.link}`,
    { car: car.id, level: car.level, result: "rerun", class: plan.kind, run: plan.link }, true);
  return true;
}

/**
 * Asked by stepTesting for a car whose checks came back red or green. true = hold the car this tick (a re-run is awaited, or the
 * batch was handed to PM); false = the engine goes on as it always did (red → redCar, green → green). Never throws: a missing
 * port, a GitHub or ledger error, or an unreadable log is false, so a red car is bisected and nothing can stall here.
 */
export async function carFailureClass<D extends Deps>(s: TrainState, car: TrainCar, checks: readonly TrainCheck[], verdict: "red" | "green", deps: D,
  ops: TimeoutOps<D>): Promise<boolean> {
  try { return await classify(s, car, checks, verdict === "green", deps, ops); }
  catch (e) {
    // A lost lease ends the pass; and once giveUp ended the testing, its own failure (a save, a notice) is the engine's.
    if (e instanceof SchedulerStopped || s.phase !== "testing") throw e;
    console.error(`⚠️ [merge-train] ${label(s, car)}的失败分类没判成，按原路处理：${errText(e)}`);
    return false;
  }
}
