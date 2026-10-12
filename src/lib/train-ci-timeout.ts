/**
 * Merge train CI timeout recovery (dispatch-recovery-TRAINHANG1), recovery key trainCiTimeout (default observe):
 * - off: a car past TRAIN_CI_TIMEOUT_MS voids the train exactly as before (scheduler-merge-train.ts stepTesting).
 * - observe: the same void, plus one deduped ledger note of what on would do; nothing cancelled, nothing split.
 * - on: the car's own runs (its `train/` branch only, never an author PR or main) are listed with their jobs, cancelled, and
 *   rechecked on later ticks until GitHub reports them finished; only then is the car diagnosed (train-ci-timeout-diag.ts) and
 *   handed to the engine's failCar, the same split / pin / give-up path as a red car, so a hanging card is bisected down and
 *   bounced (ci_fail) like a failing one. A cancel that fails or never settles, a car whose jobs only queued, the train deadline:
 *   giveUp (members serial, PM alarm = judge), never a guess. Every train exit also cancels the runs still on its branches.
 * The engine calls in through carTimedOut / carTimeoutStep / exitCancel and lends its own steps as TimeoutOps.
 */
import type { Database } from "bun:sqlite";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { trainMode } from "./scheduler-merge-train-switch.js";
import type { TrainCar, TrainCheck, TrainDeps, TrainEventKind, TrainState } from "./scheduler-merge-train.js";
import { diagnose, errText, type HungJob, type JobLog } from "./train-ci-timeout-diag.js";

export interface TrainRun { id: number; url: string; status: string }
export interface TrainJob { id: number; name: string; status: string }
/** GitHub Actions calls of this recovery (scheduler-merge-train-gh.ts); runs are only ever looked up by a `train/` branch. */
export interface TrainRunsGh {
  branchRuns(repo: string, branch: string): Promise<TrainRun[]>;
  runJobs(repo: string, run: number): Promise<TrainJob[]>;
  /** finished = GitHub refused because the run had already completed: as good as cancelled. */
  cancelRun(repo: string, run: number): Promise<"requested" | "finished">;
  jobLog(repo: string, job: number): Promise<JobLog>;
  /** One run's status, looked up by id and checked against its `train/` branch. */
  runStatus(repo: string, run: number, branch: string): Promise<string>;
}
/** The tick's policy port (trainCiTimeoutPort); tests pass a fake. */
export interface TrainCiTimeoutPort { mode(project: string): RecoveryMode; observe(s: TrainState, car: TrainCar, action: string): void }

type Cancel = "pending" | "confirmed" | "unconfirmed";
/** Saved before any cancel is sent, so a restart rechecks instead of re-listing; `checks` stay as GitHub reported them (pending). */
export interface CarTimeout {
  at: number; checks: { name: string; link: string }[]; runs: { id: number; url: string }[]; hung: HungJob[]; notes: string[];
  cancel: Cancel; rechecks: number; receipts: string[]; diag?: string;
}
/** `unlisted` = train branches whose runs could not be listed yet: retried each recheck, judged if still unlisted at the end. */
export interface ExitCancel {
  runs: { id: number; url: string; branch: string }[]; cancel: Cancel; rechecks: number; receipts: string[]; unlisted?: string[]; error?: string;
}

/** The engine's own steps, lent so the timeout reuses them instead of copying them. */
export interface TimeoutOps<D> {
  failCar(s: TrainState, car: TrainCar, failed: { name: string; link: string }[], summary: string, deps: D, timeout: boolean): Promise<void>;
  giveUp(s: TrainState, deps: D, why: string): Promise<void>;
  emit(s: TrainState, deps: D, kind: TrainEventKind, text: string, data?: Record<string, unknown>, notify?: boolean, alarm?: boolean): Promise<void>;
  save(s: TrainState, deps: D): void;
}
type Deps = Pick<TrainDeps, "gh" | "ciTimeout" | "now">;

/** Ticks a requested cancel may stay unconfirmed before PM is asked to judge (GitHub usually stops a run within a minute). */
export const CANCEL_RECHECKS = 6;
const httpsLink = (l: unknown) => (typeof l === "string" && /^https:\/\/\S+$/.test(l) ? l : "");

/** Runs only through a gh that has the run methods and while the train itself is on; anything missing = off. */
function runsGh(deps: Deps): TrainRunsGh | null {
  const g = deps.gh;
  return g.branchRuns && g.runJobs && g.cancelRun && g.jobLog && g.runStatus ? (g as TrainRunsGh) : null;
}
export function ciTimeoutMode(s: TrainState, deps: Deps): RecoveryMode {
  if (!deps.ciTimeout || !runsGh(deps) || trainMode(s.project) !== "on") return "off";
  return deps.ciTimeout.mode(s.project);
}

/** Cancel every run, each on its own (one refusal never keeps another runner busy); a receipt per run, the failures joined or null. */
async function cancelAll(gh: TrainRunsGh, repo: string, runs: readonly { id: number }[], receipts: string[]): Promise<string | null> {
  const failed: string[] = [];
  for (const r of runs) {
    try { receipts.push(`${r.id}:${await gh.cancelRun(repo, r.id)}`); }
    catch (e) { receipts.push(`${r.id}:failed`); failed.push(`取消 run ${r.id} 失败：${errText(e)}`); }
  }
  return failed.length ? failed.join("；") : null;
}

/**
 * The claimed runs not yet `completed`, each read by id (a run absent from a branch listing proves nothing); a run whose status
 * could not be read counts as still running, so only a completed status ever confirms a cancel.
 */
async function stillRunning<R extends { id: number }>(gh: TrainRunsGh, repo: string, branch: (r: R) => string, runs: readonly R[]): Promise<R[]> {
  const live: R[] = [];
  for (const r of runs) {
    try { if ((await gh.runStatus(repo, r.id, branch(r))) !== "completed") live.push(r); }
    catch (e) { live.push(r); console.error(`⚠️ [merge-train] 复核 run ${r.id} 失败，按未停下处理，下一轮再核：${errText(e)}`); }
  }
  return live;
}

/**
 * The car's CI is pending past the car timeout. off / observe: false, the caller voids as before (observe records first).
 * on: claim, snapshot the jobs and request the cancel; true = handled (carTimeoutStep confirms it on the next ticks).
 */
export async function carTimedOut<D extends Deps>(s: TrainState, car: TrainCar, checks: readonly TrainCheck[], deps: D,
  ops: TimeoutOps<D>): Promise<boolean> {
  const mode = ciTimeoutMode(s, deps);
  if (mode === "observe") observe(s, car, deps);
  if (mode !== "on") return false;
  const gh = runsGh(deps)!;
  let runs: TrainRun[];
  try { runs = (await gh.branchRuns(s.repo, car.branch)).filter((r) => r.status !== "completed"); }
  catch (e) { await ops.giveUp(s, deps, `车厢 ${car.id} CI 超时，列不出它的 run（${errText(e)}），runner 是否释放不明，未定位`); return true; }
  if (!runs.length) { await ops.giveUp(s, deps, `车厢 ${car.id} CI 超时，分支上没有在跑的 run，未定位`); return true; }
  const hung: HungJob[] = [], notes: string[] = [];
  for (const r of runs) {
    try {
      for (const j of await gh.runJobs(s.repo, r.id)) {
        if (j.status !== "completed") hung.push({ run: r.id, runUrl: r.url, job: j.id, name: j.name, started: j.status === "in_progress" });
      }
    } catch (e) { notes.push(`run ${r.id} 的 job 列表未取到：${errText(e, 60)}`); }
  }
  car.timeout = { at: deps.now(), checks: checks.filter((c) => c.bucket === "pending").map((c) => ({ name: c.name, link: httpsLink(c.link) })),
    runs: runs.map((r) => ({ id: r.id, url: r.url })), hung, notes, cancel: "pending", rechecks: 0, receipts: [] };
  ops.save(s, deps); // the claim lands before any cancel, so a restart rechecks these runs instead of listing new ones
  await ops.emit(s, deps, "ci", `车厢 ${car.id}（${car.members.join("、")}）CI 超时，取消它的 ${runs.length} 个 run，确认停下后按组合红分裂`,
    { car: car.id, level: car.level, result: "timeout", runs: car.timeout.runs }, true);
  const failed = await cancelAll(gh, s.repo, runs, car.timeout.receipts);
  if (failed) return unconfirmed(s, car, deps, ops, failed);
  ops.save(s, deps);
  return true;
}

async function unconfirmed<D extends Deps>(s: TrainState, car: TrainCar, deps: D, ops: TimeoutOps<D>, why: string): Promise<true> {
  car.timeout!.cancel = "unconfirmed";
  await ops.giveUp(s, deps, `车厢 ${car.id} CI 超时，${why}，runner 可能仍被占用，未定位`);
  return true;
}

/**
 * A car with a saved timeout claim. false = trainCiTimeout is no longer on: the caller voids as off does. Otherwise recheck the
 * cancel (re-sending it, at most CANCEL_RECHECKS ticks), then diagnose once and fail the car through the engine's failCar.
 */
export async function carTimeoutStep<D extends Deps>(s: TrainState, car: TrainCar, deps: D, ops: TimeoutOps<D>): Promise<boolean> {
  const t = car.timeout!;
  if (t.cancel === "unconfirmed") return true; // giveUp already ended the testing
  if (ciTimeoutMode(s, deps) !== "on") return false;
  const gh = runsGh(deps)!;
  if (t.cancel === "pending") {
    const live = await stillRunning(gh, s.repo, () => car.branch, t.runs);
    if (live.length) {
      if (++t.rechecks >= CANCEL_RECHECKS) return unconfirmed(s, car, deps, ops, `取消请求后复核 ${t.rechecks} 次仍未确认停下`);
      const failed = await cancelAll(gh, s.repo, live, t.receipts);
      if (failed) return unconfirmed(s, car, deps, ops, failed);
      ops.save(s, deps);
      return true;
    }
    t.cancel = "confirmed";
    t.diag = await diagnose(t.hung, (job) => gh.jobLog(s.repo, job), t.notes);
    ops.save(s, deps); // confirmed + diagnosis survive a restart; the car stays in ci until failCar's save, so it is failed exactly once
  }
  if (t.hung.length && !t.hung.some((h) => h.started)) {
    await ops.giveUp(s, deps, `车厢 ${car.id} CI 超时但 job 一直在排队、没开跑（不是代码挂住），未定位`);
    return true;
  }
  const runUrl = t.hung.find((h) => h.started)?.runUrl ?? t.runs[0]?.url ?? "";
  await ops.failCar(s, car, t.checks.map((c) => ({ name: c.name, link: runUrl || c.link })), t.diag ?? "", deps, true);
  return true;
}

/**
 * Before cleanup closes the PRs: cancel what still runs on this train's branches (every exit: merged, void, serial).
 * true = wait for the next tick. Each run is cancelled on its own and a branch that cannot be listed is retried; whatever is
 * still running or unlisted after CANCEL_RECHECKS is a PM alarm, and cleanup goes on.
 */
export async function exitCancel<D extends Deps>(s: TrainState, deps: D, ops: TimeoutOps<D>): Promise<boolean> {
  if (s.ciExit && s.ciExit.cancel !== "pending") return false;
  if (ciTimeoutMode(s, deps) !== "on") return false;
  const gh = runsGh(deps)!, first = !s.ciExit;
  const x = s.ciExit ??= { runs: [], cancel: "pending", rechecks: 0, receipts: [], unlisted: s.cars.filter((c) => c.created).map((c) => c.branch) };
  const claimed = [...x.runs], fresh = await listUnlisted(gh, s.repo, x);
  ops.save(s, deps); // claimed before any cancel
  if (fresh.length) await ops.emit(s, deps, "cleanup", `列车退出，取消仍在跑的 ${fresh.length} 个 run`, { runs: fresh });
  const live = [...(await stillRunning(gh, s.repo, (r) => r.branch, claimed)), ...fresh];
  if (!live.length && !x.unlisted?.length) { x.cancel = "confirmed"; ops.save(s, deps); return false; }
  if (!first && ++x.rechecks >= CANCEL_RECHECKS) {
    const left = [live.length ? `run ${live.map((r) => r.id).join("、")} 仍未确认停下` : "", x.unlisted?.length ? `列不出 ${x.unlisted.join("、")} 上的 run` : ""];
    return exitUnconfirmed(s, deps, ops, `复核 ${x.rechecks} 次后，${left.filter(Boolean).join("，")}${x.error ? `（最近错误：${x.error}）` : ""}`);
  }
  const failed = await cancelAll(gh, s.repo, live, x.receipts);
  if (failed) x.error = failed; // the others were still cancelled; this one is re-sent next tick and judged if it never stops
  ops.save(s, deps);
  return true;
}

/** List the branches not listed yet: their unfinished runs join the claim (returned); a branch that fails stays for the next tick. */
async function listUnlisted(gh: TrainRunsGh, repo: string, x: ExitCancel): Promise<ExitCancel["runs"]> {
  const fresh: ExitCancel["runs"] = [], left: string[] = [];
  for (const branch of x.unlisted ?? []) {
    try {
      for (const r of await gh.branchRuns(repo, branch)) if (r.status !== "completed" && !x.runs.some((c) => c.id === r.id)) fresh.push({ id: r.id, url: r.url, branch });
    } catch (e) { left.push(branch); x.error = `列不出 ${branch} 上的 run：${errText(e, 60)}`; }
  }
  x.unlisted = left;
  x.runs.push(...fresh);
  return fresh;
}

async function exitUnconfirmed<D extends Deps>(s: TrainState, deps: D, ops: TimeoutOps<D>, why: string): Promise<false> {
  s.ciExit!.cancel = "unconfirmed";
  ops.save(s, deps);
  await ops.emit(s, deps, "alarm", `列车退出时${why}，runner 可能仍被占用，请 PM 看看`, { reason: why }, true, true);
  return false;
}

function observe(s: TrainState, car: TrainCar, deps: Deps): void {
  try { deps.ciTimeout!.observe(s, car, `取消车厢 ${car.id}（${car.members.join("、")}）的 CI run，确认停下后按组合红二分（这次仍旧作废）`); }
  catch (e) { console.error(`⚠️ [merge-train] trainCiTimeout 观察记录没写上（照旧作废）：${errText(e)}`); } // observe never changes the void
}

/** The production port: policy read every call (bad file = off), observe = one ledger note per train car. */
export function trainCiTimeoutPort(db: Database, now: () => number, policy: RecoveryPolicyPort = recoveryPolicy): TrainCiTimeoutPort {
  return {
    mode: (project) => policy(project, "trainCiTimeout").mode,
    observe: (s, car, action) => {
      recordObserved(db, { project: s.project, mechanism: "trainCiTimeout", target: "", actionKey: `train-timeout:${s.id}:${car.id}`, action,
        data: { train: s.id, car: car.id, members: car.members } }, now());
    },
  };
}
