/**
 * The read map's fuse on the merge train (merge-arch-SELECT4; rules: ci-io-map-fuse.ts, records: ci-io-map-fuse-ledger.ts).
 * stepTesting asks it once per red verdict, before the re-run / bisect decision, so a red attempt that a re-run later turns green
 * is still looked at. It returns nothing and never throws (a lost lease, SchedulerStopped, is the one thing passed on): the train
 * goes on exactly as it would without it.
 * - off (or an unreadable policy): nothing is read, written or recorded.
 * - observe: the evidence is read and one deduped note says what on would do; no variable write, no notice.
 * - on: with evidence, CI_IO_MAP is read again right before the write and only an `on` is written down to observe; anything else
 *   is already safe and only recorded. The write is confirmed by reading it back; only then is it recorded and PM told. A write
 *   that failed, timed out or did not read back as observe is recorded as unconfirmed and PM is told exactly that.
 * Every GitHub call goes through the train's guarded gh port, so the lease is checked before and after each of them, and the
 * repository is the project's configured one. GitHub has no compare-and-set for a repository variable: the re-read and the lease
 * only order this scheduler's own writes; a PM changing the variable at the same moment is not excluded, which is why the only
 * value ever written is the safe one and the notice carries the time and both values.
 * A case that could not be settled (run still going, a read or the write failed) stays open in the ledger; a red run that could not
 * even be read at the verdict is kept as a run reference. Both, and PM notices that were recorded but not sent, are taken up by
 * `carry`, which the train tick calls for every project on every leased pass, whether or not a car is red: an open case RETRIES
 * times in all, a run reference and a notice for a day, each at most once per RETRY_GAP_MS.
 * S2D2: `carry` runs ahead of the tick's own skip gate, so every car is asked about its own members. While one of them is skip the
 * car is held: nothing of it is read, the variable is not written, no case is settled and no notice is sent. What is open stays
 * open, untried, and is taken up again once the members are local; the route is asked again right before the write and each notice.
 */
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { RecoveryMode } from "./recovery-policy.js";
import type { TrainCar, TrainCheck, TrainState } from "./scheduler-merge-train.js";
import { caseId, evidenceKey, failedTestFiles, isMemberRun, judgePlan, loweredText, OWNER_REPO, sameText, scopeDigest, scopeJob, testedCommit, trainRunProblem, unconfirmedText,
  type CiIoMapFuseGh, type FuseCase, type FuseEvidence, type FuseMember, type FuseRef, type FuseRun, type Omission } from "./ci-io-map-fuse.js";
import type { FuseLedger } from "./ci-io-map-fuse-ledger.js";
import { aliasPick, sameRepo } from "./repo-alias.js";

export interface FusePort {
  mode(project: string): RecoveryMode;
  /** The project's configured repository (never the train state's or a PR link's); null = unknown, nothing is done. */
  projectRepo(project: string): string | null;
  gh: CiIoMapFuseGh;
  ledger: FuseLedger;
  now(): number;
  /** The existing PM notice, under the pass's lease. */
  pm(project: string, members: readonly string[], text: string): Promise<void>;
  /** S2D2: the card's route is skip. A car carrying one is held (see above). */
  skip(taskId: string): boolean;
}
/** The red-verdict hook, and `carry`: what earlier passes left open in this project (on only; like the hook it throws only on a lost lease). */
export type CiIoMapFuseHook = ((s: TrainState, car: TrainCar, checks: readonly TrainCheck[]) => Promise<void>) & { carry(project: string): Promise<void> };

const DAY_MS = 24 * 3_600_000, RETRY_GAP_MS = 10 * 60_000, RETRIES = 3, NOTICE_SETTLE_MS = 60_000;
/** Wall-clock budget of one case's reads; how many open cases / run references one pass takes up; how far back a run's attempts are read. */
const READ_BUDGET_MS = 90_000, CARRY_MAX = 3, ATTEMPTS_BACK = 5;
const inBudget = (deadline: number): void => { if (Date.now() > deadline) throw new Error("这一轮核对超过时间预算"); };
const errText = (e: unknown) => (e as Error).message.trim().split("\n")[0]?.slice(0, 200) ?? "";
const stopped = (e: unknown): void => { if (e instanceof SchedulerStopped) throw e; };
const held = (port: FusePort, members: readonly (string | FuseMember)[]): boolean => members.some((m) => port.skip(typeof m === "string" ? m : m.taskId));
const log = (c: FuseCase, text: string) => console.log(`🧯 [ci-io-map-fuse] ${c.project} 列车 ${c.train} 车厢 ${c.car} run ${c.runId}#${c.attempt}：${text}`);

/** end = this case is settled for this mode; retry = it could not be read or written yet. */
type Outcome = { end: string; note?: boolean } | { retry: string } | { hold: true };
/**
 * Per process: cases already settled (a held car is asked again every pass; nothing is read twice for it) and how often and when
 * an open case, run reference or notice was last tried. Losing it on a restart costs one more read; every effect is deduped in the ledger.
 */
const settled = new Set<string>(), tried = new Map<string, { n: number; at: number }>();
const remember = (id: string) => { if (settled.size >= 2000) settled.clear(); settled.add(id); };
const due = (id: string, now: number): boolean => { const seen = tried.get(id); return !seen || now - seen.at >= RETRY_GAP_MS; };
const mark = (id: string, now: number, n = 1) => { if (tried.size >= 2000) tried.clear(); tried.set(id, { n, at: now }); };

const fuseSameRepo = (site: string, a: string, b: string) => aliasPick(`ci-io-map-fuse-run.${site}`, sameText(a, b), sameText(a, b) || sameRepo(a, b)); // REPOMERGE1
const prNumber = (m: FuseMember, repo: string): number | null => {
  const hit = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(m.prRef);
  return hit && fuseSameRepo("prNumber", hit[1]!, repo) ? Number(hit[2]) : null;
};

/** One member's frozen plans on its exact head: the ones that left out failing files, and why the others are no evidence. */
async function memberPlans(gh: CiIoMapFuseGh, repo: string, m: FuseMember, files: readonly string[],
  deadline: number): Promise<{ omissions: Omission[]; bad: string[] }> {
  const pr = prNumber(m, repo), omissions: Omission[] = [], bad: string[] = [];
  if (pr === null) return { omissions, bad: [`${m.taskId} 的 PR 不在 ${repo}`] };
  const runs = (await gh.headRuns(repo, m.head)).filter((r) => isMemberRun(r, repo, m.head, pr));
  if (!runs.length) bad.push(`${m.taskId} 没有绑定到 PR #${pr}、head ${m.head.slice(0, 12)} 的成功 ci.yml 运行`);
  for (const run of runs) {
    inBudget(deadline);
    const scope = scopeJob(await gh.attemptJobs(repo, run.id, run.attempt));
    if ("bad" in scope) { bad.push(`${m.taskId} run ${run.id}：${scope.bad}`); continue; }
    if (scope.full) continue;
    const scopeLog = await gh.jobLog(repo, scope.job.id), digest = scopeLog.truncated ? null : scopeDigest(scopeLog.text);
    if (!digest) { bad.push(`${m.taskId} run ${run.id}：ci scope 检查的日志里读不出唯一的计划 digest`); continue; }
    const v = judgePlan(await gh.planArtifact(repo, run.id), digest, m.head, files);
    if (v.kind === "bad") bad.push(`${m.taskId} run ${run.id}：${v.why}`);
    if (v.kind !== "omits") continue;
    omissions.push({ taskId: m.taskId, prRef: m.prRef, pr, head: m.head, runId: run.id, attempt: run.attempt, digest, mapSha: v.mapSha,
      tests: v.tests, testCount: v.tests.length, omitted: v.omitted });
  }
  return { omissions, bad };
}

/**
 * The commit the train run really tested. Its head_sha is only what triggered it; the jobs check out the draft PR's synthetic merge,
 * which the run's own plan froze: the digest its scope check printed in this attempt, and the plan artifact that hashes to it.
 */
async function trainTested(gh: CiIoMapFuseGh, c: FuseCase, head: string): Promise<{ sha: string; digest: string } | { bad: string }> {
  const scope = scopeJob(await gh.attemptJobs(c.repo, c.runId, c.attempt));
  if ("bad" in scope) return scope;
  if (!scope.full) return { bad: "列车 run 的计划不是全量" };
  const log = await gh.jobLog(c.repo, scope.job.id), digest = log.truncated ? null : scopeDigest(log.text);
  if (!digest) return { bad: "ci scope 检查的日志里读不出唯一的计划 digest" };
  const tested = testedCommit(await gh.planArtifact(c.repo, c.runId), digest, head);
  return "bad" in tested ? tested : { sha: tested.sha, digest };
}

/** The evidence of one case, read from GitHub only; nothing is written. */
async function gather(gh: CiIoMapFuseGh, c: FuseCase, first?: FuseRun): Promise<{ evidence: FuseEvidence } | Outcome> {
  const run = first ?? await gh.ciRun(c.repo, c.runId, c.attempt), problem = trainRunProblem(run, c);
  if (problem) return { end: problem };
  if (run.status !== "completed") return { retry: "列车 run 还没跑完" };
  if (run.conclusion !== "failure") return { end: `列车 run 的结论是 ${run.conclusion || "（空）"}，不是失败` };
  const files = failedTestFiles(await gh.attemptFailedLog(c.repo, c.runId, c.attempt));
  if (!files) return { end: "完整失败日志里定位不到失败的测试文件（安装 / typecheck / guard / 网络等不算读取图漏检）", note: true };
  const omissions: Omission[] = [], bad: string[] = [], retry: string[] = [], deadline = Date.now() + READ_BUDGET_MS;
  for (const m of c.members) {
    try { inBudget(deadline); const got = await memberPlans(gh, c.repo, m, files, deadline); omissions.push(...got.omissions); bad.push(...got.bad); }
    catch (e) { stopped(e); retry.push(`${m.taskId} 的计划没读成：${errText(e)}`); }
  }
  if (!omissions.length) {
    if (retry.length) return { retry: retry.join("；") };
    return bad.length ? { end: bad.join("；"), note: true } : { end: "成员的计划都选了失败文件、是全量，或没有实际使用读取图" };
  }
  const tested = await trainTested(gh, c, run.head);
  if ("bad" in tested) return { end: `列车 run 自己的计划核不出实际测试的提交：${tested.bad}`, note: true };
  return { evidence: { repo: c.repo, project: c.project, train: c.train, car: c.car, members: c.members.map((m) => m.taskId),
    run: { id: run.id, attempt: run.attempt, head: run.head, tested: tested.sha, planDigest: tested.digest }, files, omissions } };
}

/** One PM notice; a failure, or a member that is skip, leaves it owed (ci-io-map-fuse-ledger.ts) for a later pass. */
async function tell(port: FusePort, project: string, members: readonly string[], key: string, text: string): Promise<void> {
  try { if (held(port, members)) return; await port.pm(project, members, text); port.ledger.sent(project, key); }
  catch (e) { stopped(e); console.error(`⚠️ [ci-io-map-fuse] ${project} 的 PM 通知没发出去，后面的轮次再发：${errText(e)}`); }
}

async function lowered(port: FusePort, c: FuseCase, key: string, e: FuseEvidence, result: "lowered" | "settled"): Promise<Outcome> {
  const at = port.now(), notice = loweredText(e, at, result === "settled");
  const wrote = port.ledger.done(c, key, e, result, { before: "on", after: "observe", at, notice });
  if (wrote) await tell(port, c.project, e.members, wrote, notice);
  return { end: "CI_IO_MAP 已从 on 退回 observe，读回确认" };
}

/**
 * on, with evidence. The variable is read right before the write: only `on` is written down. The record of the try is durable
 * before the write, the record of success only after the read-back.
 */
async function act(port: FusePort, c: FuseCase, e: FuseEvidence): Promise<Outcome> {
  const { gh, ledger } = port, key = evidenceKey(e);
  if (ledger.isDone(key)) return { end: "这份证据已经处理过" };
  const before = await gh.ioMapVar(c.repo);
  if (before !== "on") {
    ledger.done(c, key, e, "already_safe", { before, after: before, at: port.now() });
    return { end: `CI_IO_MAP 已在安全档（${before ?? "未设置"}），不改` };
  }
  ledger.pend(c);
  if (held(port, c.members)) return { hold: true }; // S2D2: a member turned skip while the evidence was read
  ledger.tryWrite(c, key, e);
  let why = "", after: string | null | undefined;
  try { await gh.lowerIoMapVar(c.repo); } catch (err) { stopped(err); why = `写变量失败：${errText(err)}`; }
  try { after = await gh.ioMapVar(c.repo); } catch (err) { stopped(err); why = `${why ? `${why}；` : ""}写后读回失败：${errText(err)}`; }
  if (after === "observe") return lowered(port, c, key, e, "lowered");
  why ||= "写后读回的不是 observe";
  const shown = after === undefined ? "（没读到）" : after ?? "（未设置）", at = port.now(), notice = unconfirmedText(e, at, why, shown);
  const wrote = ledger.failed(c, key, e, why, { before, after: after ?? null, at, notice });
  if (wrote) await tell(port, c.project, e.members, wrote, notice);
  return { retry: why };
}

async function settle(port: FusePort, c: FuseCase, mode: RecoveryMode, first?: FuseRun): Promise<Outcome> {
  if (mode === "on") { // a write an earlier pass sent and never recorded as done: observe now means it took
    const left = port.ledger.unsettled(c);
    if (left && await port.gh.ioMapVar(c.repo) === "observe") return lowered(port, c, left.key, left.evidence, "settled");
  }
  const got = await gather(port.gh, c, first);
  if (!("evidence" in got)) return got;
  if (mode === "on") return act(port, c, got.evidence);
  port.ledger.observe(got.evidence, evidenceKey(got.evidence));
  return { end: "observe：记下本可退回 observe" };
}

/** One case, once: settled cases are skipped, an open one is tried again only after RETRY_GAP_MS and gives up after RETRIES. */
async function attempt(port: FusePort, c: FuseCase, mode: RecoveryMode, first?: FuseRun): Promise<void> {
  const id = `${mode}:${caseId(c)}`, seen = tried.get(id), now = port.now();
  if (held(port, c.members)) return void (mode === "on" && port.ledger.pend(c)); // S2D2: kept open, untried
  if (settled.has(id)) return void (mode === "on" && port.ledger.close(c, "本进程已核过")); // opened again from a run reference
  if (!due(id, now)) return;
  let out: Outcome;
  try { out = await settle(port, c, mode, first); } catch (e) { stopped(e); out = { retry: errText(e) }; }
  if ("hold" in out) return;
  const n = (seen?.n ?? 0) + 1, gaveUp = "retry" in out && n >= RETRIES;
  const text = "end" in out ? out.end : out.retry;
  log(c, "end" in out ? text : `${gaveUp ? "放弃" : "稍后再核"}：${text}`);
  if ("retry" in out && !gaveUp) {
    mark(id, now, n);
    if (mode === "on") port.ledger.pend(c);
    return;
  }
  remember(id); tried.delete(id);
  if (mode !== "on") return;
  if (gaveUp || ("end" in out && out.note)) port.ledger.skip(c, text);
  port.ledger.close(c, text);
}

/**
 * A run reference read back: every completed failed attempt of the run (the latest ATTEMPTS_BACK) is opened as a pending case, which
 * `carry` then judges like any other; one the hook already judged is deduped by its case id. Throws while the run cannot be read or
 * its latest attempt is still going, so the reference stays open.
 */
async function reopen(port: FusePort, ref: FuseRef): Promise<string> {
  const latest = await port.gh.ciRun(ref.repo, ref.runId), failed: number[] = [];
  for (let n = latest.attempt; n >= 1 && n > latest.attempt - ATTEMPTS_BACK; n--) {
    const run = n === latest.attempt ? latest : await port.gh.ciRun(ref.repo, ref.runId, n);
    if (run.status !== "completed" || run.conclusion !== "failure") continue;
    port.ledger.pend({ ...ref, attempt: n });
    failed.push(n);
  }
  if (latest.status !== "completed") throw new Error("列车 run 最新一次还没跑完");
  return failed.length ? `失败的是第 ${failed.reverse().join("、")} 次` : "没有已完成的失败 attempt";
}

/** on: run references and cases earlier passes left open, then notices that were recorded but never sent. */
async function carryOn(port: FusePort, project: string, repo: string): Promise<void> {
  const now = port.now(), since = now - DAY_MS, mine = (r: FuseRef) => fuseSameRepo("carry", r.repo, repo) && !held(port, r.members);
  for (const { id, ref } of port.ledger.openRefs(project, since).filter((r) => mine(r.ref) && due(`ref:${r.id}`, now)).slice(0, CARRY_MAX)) {
    try { port.ledger.closeRef(project, id, await reopen(port, { ...ref, repo })); tried.delete(`ref:${id}`); }
    catch (e) { stopped(e); mark(`ref:${id}`, now); console.log(`🧯 [ci-io-map-fuse] ${project} 列车 ${ref.train} 车厢 ${ref.car} run ${ref.runId}：稍后再读：${errText(e)}`); }
  }
  const open = port.ledger.openCases(project, since).filter((c) => mine(c) && due(`on:${caseId(c)}`, now));
  for (const c of open.slice(0, CARRY_MAX)) await attempt(port, { ...c, repo }, "on");
  for (const n of port.ledger.owed(project, since, now - NOTICE_SETTLE_MS).filter((n) => !held(port, n.members) && due(`notice:${n.key}`, now))) {
    mark(`notice:${n.key}`, now);
    await tell(port, project, n.members, n.key, n.text);
  }
}

/** The Actions runs of this repo behind the checks that did not pass. */
function failedRuns(repo: string, checks: readonly TrainCheck[]): number[] {
  const ids = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) => {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/\S*)?$/.exec(c.link ?? "");
    return m && fuseSameRepo("failedRuns", m[1]!, repo) && Number.isSafeInteger(Number(m[2])) ? Number(m[2]) : null;
  });
  return [...new Set(ids.filter((id) => id !== null))];
}

export function ciIoMapFuseHook(port: FusePort): CiIoMapFuseHook {
  /** The mode and the project's configured repository; null = off, or nothing may be done. */
  const scope = (project: string, trainRepo?: string): { mode: "on" | "observe"; repo: string } | null => {
    const mode = port.mode(project);
    if (mode === "off") return null;
    const repo = port.projectRepo(project);
    if (repo && OWNER_REPO.test(repo) && (trainRepo === undefined || fuseSameRepo("scope", repo, trainRepo))) return { mode, repo };
    if (trainRepo !== undefined) console.error(`⚠️ [ci-io-map-fuse] ${project}：列车仓库 ${trainRepo} 不是项目配置的仓库，不核`);
    return null;
  };
  const hook = async (s: TrainState, car: TrainCar, checks: readonly TrainCheck[]): Promise<void> => {
    try {
      const at = scope(s.project, s.repo);
      if (!at) return;
      const { mode, repo } = at;
      const members = car.members.map((id) => s.members.find((m) => m.taskId === id)).filter((m) => !!m).map(({ taskId, prRef, head }) => ({ taskId, prRef, head }));
      for (const runId of failedRuns(repo, checks)) {
        const ref: FuseRef = { project: s.project, repo, train: s.id, car: car.id, branch: car.branch, runId, members };
        if (held(port, members)) { if (mode === "on") port.ledger.ref(ref); continue; } // S2D2: nothing read; the run is kept
        let run: FuseRun;
        try { run = await port.gh.ciRun(repo, runId); } catch (e) {
          stopped(e);
          // the attempt that is red now cannot be named yet: under on the run is kept, and carry reads its failed attempts back
          if (mode === "on") port.ledger.ref(ref);
          console.error(`⚠️ [ci-io-map-fuse] ${s.project} 车厢 ${car.id} 的 run ${runId} 没读到${mode === "on" ? "，已记下留给后面的轮次" : ""}：${errText(e)}`);
          continue;
        }
        await attempt(port, { ...ref, attempt: run.attempt }, mode, run);
      }
    } catch (e) {
      stopped(e);
      console.error(`⚠️ [ci-io-map-fuse] ${s.project} 车厢 ${car.id} 没核成，列车照常：${errText(e)}`);
    }
  };
  const carry = async (project: string): Promise<void> => {
    try {
      const at = scope(project);
      if (at?.mode === "on") await carryOn(port, project, at.repo);
    } catch (e) {
      stopped(e);
      console.error(`⚠️ [ci-io-map-fuse] ${project} 留下的没核成，下一轮再来：${errText(e)}`);
    }
  };
  return Object.assign(hook, { carry });
}

/** Tests only: the per-process memory, so one test's cases never read as settled in the next. */
export function resetFuseMemory(): void { settled.clear(); tried.clear(); }
