/** Oversized serial CI logs: one bounded download per failed job per pass, with the same readers in observe and on. */
import type { Database } from "bun:sqlite";
import { recordObserved, recoveryPolicy, type ObservedAction, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import type { MergeRun } from "./scheduler-merge.js";
import { GATE, GATE_VERDICT, PREFIX, STAMP } from "./scheduler-merge-ci-rerun-log.js";
import { cutFailedJobLog } from "./scheduler-merge-ci-log-cut.js";

export const LOG_LIMIT = 900 * 1024;
export const JOB_LOG_MAX = 8 * 1024 * 1024;
const LOG_TOO_LONG = "失败日志太长，可能被截断";
interface FailedJob { id: number; name: string; failedSteps: string[] }
interface JobFacts extends FailedJob { bytes: number; keptBytes: number; unknownStep: boolean }
export interface PerJobLog { log: string; jobs: JobFacts[]; gateSkipped: boolean }
interface LogPort {
  failedLog(repo: string, runId: string): Promise<string>;
  perJobLog?(repo: string, runId: string, attempt: number): Promise<PerJobLog>;
}
export interface LogJudgment { wouldKind: "rerun" | "flaky" | "behind" | "bounce"; why: string; cases?: string[]; files?: string[] }
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
interface Context { policy: RecoveryPolicyPort; record: (a: ObservedAction) => Promise<void>; active: () => void }
let context: Context | undefined;
const stopErrors = new WeakSet<object>();
const cache = new Map<string, Promise<PerJobLog>>(), logged = new Set<string>(), attempts = new Map<string, number>();

/** Query-only passes use their guarded manager; tests write to their isolated ledger directly. */
export function openCiLogPerJob(db: Database | null, policy: RecoveryPolicyPort = recoveryPolicy, manager?: Manager, active: () => void = () => {}): void {
  cache.clear(); attempts.clear();
  context = undefined;
  if (!db) { logged.clear(); return; }
  context = { policy, active, record: manager ? async (a) => {
    const r = await manager("ledger", "scheduler-recovery-observe", a.target, "--mechanism", a.mechanism, "--action-key", a.actionKey,
      "--action", a.action, "--data", JSON.stringify(a.data ?? {})).catch((e: unknown) => { assertCiLogActive(); throw e; });
    assertCiLogActive();
    if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
  } : async (a) => void recordObserved(db, a, Date.now()) };
}

/** Injected pass ownership checks avoid coupling the log reader to the maintenance and merge runtime. */
function assertCiLogActive(): void {
  try { context?.active(); }
  catch (e) { if (e && typeof e === "object") stopErrors.add(e); throw e; }
}
/** Only this reader's ownership failures escape its callers; unrelated legacy read errors keep their old bounce. */
export function rethrowCiLogStop(e: unknown): void {
  if (e && typeof e === "object" && stopErrors.has(e)) throw e;
}

/** The legacy adapter still rejects its bounded whole-run output, including for other consumers of that port. */
export function checkedFailedLog(log: string): string {
  if (Buffer.byteLength(log) >= LOG_LIMIT) throw new Error(LOG_TOO_LONG);
  return log;
}

function failedJobs(raw: string, attempt: number): FailedJob[] {
  const json = JSON.parse(raw) as { attempt?: unknown; jobs?: unknown };
  if (json.attempt !== attempt) throw new Error("run 已被重跑，attempt 与读取时不一致");
  if (!Array.isArray(json.jobs)) throw new Error("gh run view 没给出 jobs");
  const jobs: FailedJob[] = [];
  for (const job of json.jobs) {
    if (!job || typeof job !== "object" || typeof job.conclusion !== "string") throw new Error("jobs JSON 格式不合法");
    // Whole-run --log-failed also includes interrupted jobs. Test failures from the remaining jobs cannot account for them;
    // keep the legacy whole-log overflow bounce rather than deciding from an incomplete failure-only concatenation.
    if (["timed_out", "cancelled", "action_required"].includes(job.conclusion)) throw new Error(LOG_TOO_LONG);
    if (job.conclusion !== "failure") continue;
    if (!Number.isSafeInteger(job.databaseId) || job.databaseId <= 0 || typeof job.name !== "string" || !Array.isArray(job.steps) ||
      job.steps.some((s: { name?: unknown; conclusion?: unknown } | null) => !s || typeof s.name !== "string" || typeof s.conclusion !== "string")) {
      throw new Error("失败 job JSON 格式不合法");
    }
    jobs.push({ id: job.databaseId, name: job.name, failedSteps: job.steps.filter((s: { conclusion: string }) => s.conclusion === "failure")
      .map((s: { name: string }) => s.name) });
  }
  if (!jobs.length) throw new Error("失败 job 列表为空");
  return jobs;
}

function unknownGate(job: FailedJob, log: string): { unknownStep: boolean; skip: boolean } {
  const lines = log.split(/\r?\n/).filter((l) => l.trim());
  const unknownStep = lines.length > 0 && lines.every((l) => PREFIX.exec(l)?.[2] === "UNKNOWN STEP");
  const verdict = lines.some((l) => GATE_VERDICT.test(l.replace(PREFIX, "").replace(STAMP, "")));
  return { unknownStep, skip: job.name === GATE.job && job.failedSteps.length === 1 && job.failedSteps[0] === GATE.step && unknownStep && verdict };
}

/** Structured gh argv, 8 MiB per job. A full buffer, even exactly full, is not complete evidence. */
export async function readPerJobLog(command: typeof runBounded, repo: string, runId: string, attempt: number): Promise<PerJobLog> {
  const gh = async (args: string[], maxBytes?: number) => {
    const r = await command(["gh", ...args], { timeoutMs: 120_000, maxBytes,
      env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh run view 失败：${r.stderr.trim().slice(0, 300) || `exit ${r.code}`}`);
    return r;
  };
  const listed = await gh(["run", "view", runId, "--repo", repo, "--json", "jobs,attempt"]);
  if (listed.truncated) throw new Error("失败 jobs JSON 可能被截断");
  const jobs = failedJobs(listed.stdout, attempt), facts: JobFacts[] = [], parts: string[] = [];
  let gateSkipped = false;
  for (const job of jobs) {
    const r = await gh(["run", "view", "--repo", repo, "--job", String(job.id), "--log-failed"], JOB_LOG_MAX);
    if (r.truncated || Buffer.byteLength(r.stdout) >= JOB_LOG_MAX) throw new Error(`失败 job ${job.name} 的日志超过 8 MiB`);
    const { unknownStep, skip } = unknownGate(job, r.stdout), kept = cutFailedJobLog(r.stdout);
    facts.push({ ...job, bytes: Buffer.byteLength(r.stdout), keptBytes: Buffer.byteLength(kept), unknownStep });
    if (skip) gateSkipped = true;
    else parts.push(kept);
  }
  const log = parts.join("\n");
  if (Buffer.byteLength(log) >= LOG_LIMIT) throw new Error("按 job 截取后仍超过 900 KiB");
  return { log, jobs: facts, gateSkipped };
}

function cachedJobs(gh: LogPort, repo: string, runId: string, attempt: number): Promise<PerJobLog> {
  const key = JSON.stringify([repo, runId, attempt]);
  let read = cache.get(key);
  if (!read) {
    read = gh.perJobLog ? gh.perJobLog(repo, runId, attempt) : Promise.reject(new Error("CI 端口不支持按 job 读日志"));
    cache.set(key, read);
  }
  return read;
}

function actionText(j: LogJudgment): string {
  if (j.wouldKind === "rerun") return `重跑：${j.cases?.length ?? 0} 个超时用例`;
  if (j.wouldKind === "flaky") return `交 CIF8 判已知偶发：${j.files?.join("、")}`;
  if (j.wouldKind === "behind") return `合入 main：${j.files?.join("、")}`;
  return `退回：${j.why}`;
}

async function observe(run: MergeRun, layer: "cif1" | "cif2", runId: string, attempt: number, facts: PerJobLog | undefined, j: LogJudgment): Promise<void> {
  if (!context) return;
  const action = `按 job 截取后本会 ${actionText(j)}`.replace(/\s+/g, " ").slice(0, 560);
  try {
    await context.record({ project: run.project, target: run.taskId, mechanism: "ciLogPerJob", actionKey: `${layer}:${runId}`, action,
      data: { runId, attempt, jobs: facts?.jobs ?? [], gateSkipped: facts?.gateSkipped ?? false, ...j,
        why: j.why.slice(0, 600), cases: j.cases?.slice(0, 40).map((s) => s.slice(0, 200)), files: j.files?.slice(0, 40).map((s) => s.slice(0, 200)) } });
  } catch (e) {
    assertCiLogActive();
    console.error(`⚠️ [merge] ${run.taskId} ciLogPerJob 观察记录没写下：${(e as Error).message.slice(0, 300)}`);
  }
}

/** Both readers pass their existing judgment here; observe evaluates it without any claims or effectful steps. */
export async function judgeCiLog<T>(run: MergeRun, repo: string, runId: string, expectedAttempt: number | (() => Promise<number>), gh: LogPort, layer: "cif1" | "cif2",
  judge: (log: string) => Promise<T>, describe: (answer: T) => LogJudgment): Promise<T> {
  let whole: string | undefined;
  try { whole = checkedFailedLog(await gh.failedLog(repo, runId)); }
  catch (e) { if ((e as Error).message !== LOG_TOO_LONG) throw e; } // Only whole-run overflow opens this recovery path.
  if (whole !== undefined) return judge(whole);
  const mode = (context?.policy ?? recoveryPolicy)(run.project, "ciLogPerJob").mode;
  if (mode === "off") throw new Error(LOG_TOO_LONG);
  const attemptKey = `${repo}/${runId}`;
  const readAttempt = async () => {
    const attempt = typeof expectedAttempt === "number" ? expectedAttempt : attempts.get(attemptKey) ?? await expectedAttempt();
    attempts.set(attemptKey, attempt);
    return attempt;
  };
  if (mode === "on") {
    try {
      const attempt = await readAttempt();
      const facts = await cachedJobs(gh, repo, runId, attempt);
      const key = `${repo}/${runId}/${attempt}`;
      if (!logged.has(key)) {
        if (logged.size >= 500) logged.clear();
        logged.add(key);
        console.log(`🧾 [merge] ${run.taskId} 失败日志超限，按 job 截取 ${Math.ceil(Buffer.byteLength(facts.log) / 1024)} KB 判定（${facts.jobs.length} 个 job）`);
      }
      return await judge(facts.log);
    } catch (e) { assertCiLogActive(); throw e; }
  }
  let facts: PerJobLog | undefined, judgment: LogJudgment, attempt = typeof expectedAttempt === "number" ? expectedAttempt : attempts.get(attemptKey) ?? 0;
  try { attempt = await readAttempt(); facts = await cachedJobs(gh, repo, runId, attempt); judgment = describe(await judge(facts.log)); }
  catch (e) {
    assertCiLogActive();
    judgment = { wouldKind: "bounce", why: (e as Error).message };
  }
  await observe(run, layer, runId, attempt, facts, judgment);
  throw new Error(LOG_TOO_LONG);
}
