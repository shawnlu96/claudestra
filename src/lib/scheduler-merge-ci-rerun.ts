/**
 * Red required CI that only timed out in tests this PR does not touch is re-run once per PR head instead of bouncing to fix
 * (i28-CIF1). Driver side reads the failed log and decides; the claim goes through the ledger before `gh run rerun` is sent,
 * so a second red on the same head (or a failed rerun call) bounces exactly as before. Every doubt bounces (fail-closed).
 * tests/scheduler-merge-ci-rerun.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import type { EventKind } from "./ledger-stages.js";
import { runBounded } from "./run-bounded.js";
import { isTestProcess } from "./test-guard.js";
import { parseFailedLog, type CiFailure } from "./scheduler-merge-ci-rerun-log.js";
import type { MergeBounce } from "./scheduler-merge-conflict.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

/** The GitHub calls this needs; a test (or another host) puts its own on the external as `ciRerun`. */
export interface CiRerunGh {
  /** `attempt` > 1 means the run was already re-run; `status` is "completed" once that attempt ended, with its `conclusion`. */
  runAttempt(repo: string, runId: string): Promise<{ attempt: number; status: string; conclusion: string }>;
  failedLog(repo: string, runId: string): Promise<string>;
  prFiles(prRef: string): Promise<string[]>;
  rerunFailed(repo: string, runId: string): Promise<void>;
}
type FailedCheck = MergeBounce["checks"][number];
type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
type ToReceipt = (b: MergeBounce) => string;

/** runBounded stops reading at 1 MiB: a log near that may be cut, and the cut part could hold a non-timeout failure. */
const LOG_LIMIT = 900 * 1024;
/** gh pr view lists at most 100 files; a list that long may be cut, and a cut list could miss the timed-out file. */
const FILES_LIMIT = 100;
const oneLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 300) ?? "";

/** Structured argv like scheduler-merge-external.ts; `--repo` from the PR URL, so no checkout directory is needed. */
export function ciRerunGh(command: typeof runBounded = runBounded): CiRerunGh {
  const gh = async (...args: string[]) => {
    const r = await command(["gh", ...args], { env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 120_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh ${args.slice(0, 2).join(" ")} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  return {
    async runAttempt(repo, runId) {
      const raw = JSON.parse(await gh("run", "view", runId, "--repo", repo, "--json", "attempt,status,conclusion")) as
        { attempt?: unknown; status?: unknown; conclusion?: unknown };
      if (!Number.isSafeInteger(raw.attempt) || typeof raw.status !== "string") throw new Error("gh run view 没给出 attempt / status");
      return { attempt: raw.attempt as number, status: raw.status, conclusion: typeof raw.conclusion === "string" ? raw.conclusion : "" };
    },
    async failedLog(repo, runId) {
      const log = await gh("run", "view", runId, "--repo", repo, "--log-failed");
      if (Buffer.byteLength(log) >= LOG_LIMIT) throw new Error("失败日志太长，可能被截断");
      return log;
    },
    async prFiles(prRef) {
      const raw = JSON.parse(await gh("pr", "view", prRef, "--json", "files")) as { files?: { path?: unknown }[] };
      if (!Array.isArray(raw.files) || raw.files.some((f) => typeof f?.path !== "string")) throw new Error("gh pr view 没给出改动文件");
      if (raw.files.length >= FILES_LIMIT) throw new Error(`改动文件 ≥ ${FILES_LIMIT} 个，列表可能不全`);
      return raw.files.map((f) => f.path as string);
    },
    async rerunFailed(repo, runId) { await gh("run", "rerun", runId, "--failed", "--repo", repo); },
  };
}

/** Without a `ciRerun` on the external, a test process never reaches the real gh: the bounce stays as it always was there. */
const ghOf = (external: MergeExternal): CiRerunGh | null =>
  (external as MergeExternal & { ciRerun?: CiRerunGh }).ciRerun ?? (isTestProcess() ? null : ciRerunGh());

const RUN_LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/\S*)?$/;
export interface RerunPlan { repo: string; runId: string; link: string; checks: string[]; cases: string[] }
type Decision = { kind: "rerun"; plan: RerunPlan } | { kind: "wait" } | { kind: "bounce"; why: string };

/** One workflow run behind every failed check, read from GitHub; anything else is a bounce with the reason. */
async function decide(run: MergeRun, checks: FailedCheck[], gh: CiRerunGh): Promise<Decision> {
  const runs = checks.map((c) => RUN_LINK.exec(c.link));
  if (!runs.length || runs.some((m) => !m)) return { kind: "bounce", why: "失败检查没有 Actions run 链接" };
  const ids = new Set(runs.map((m) => `${m![1]}/${m![2]}`));
  if (ids.size !== 1) return { kind: "bounce", why: "失败检查分属多个 run" };
  const [repo, runId] = [runs[0]![1]!, runs[0]![2]!];
  const { attempt, status, conclusion } = await gh.runAttempt(repo, runId);
  // The run went green but the PR checks still show the old red for a moment: wait for them to catch up.
  if (status === "completed" && conclusion === "success") return { kind: "wait" };
  // A re-run that is still going can leave the old red on the PR for a moment; once it ends red, that is the second red.
  if (attempt > 1) return status === "completed" ? { kind: "bounce", why: `run 已重跑过（第 ${attempt} 次仍红）` } : { kind: "wait" };
  const failures = parseFailedLog(await gh.failedLog(repo, runId));
  if (!failures) return { kind: "bounce", why: "失败日志解析不出 bun test 的失败用例" };
  const asserted = failures.filter((f) => !f.timedOut);
  if (asserted.length) return { kind: "bounce", why: `有非超时失败：${asserted[0]!.name}` };
  const touched = new Set(await gh.prFiles(run.prRef));
  const own = failures.find((f) => touched.has(f.file));
  if (own) return { kind: "bounce", why: `超时的测试文件 ${own.file} 在本 PR 改动里` };
  return { kind: "rerun", plan: { repo, runId, link: `https://github.com/${repo}/actions/runs/${runId}`, checks: checks.map((c) => c.name),
    cases: failures.map(caseName) } };
}
const caseName = (f: CiFailure): string => `${f.file} > ${f.name}`;

/**
 * Driver side of a ci_fail on the untouched reviewed head: re-run once, wait, or bounce. The claim (a ledger event) is
 * committed first; the ledger turns a second claim on the same head into the bounce, so `gh run rerun` is sent at most once.
 */
export async function ciRerunOrBounce(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, checks: FailedCheck[],
  toReceipt: ToReceipt): Promise<MergeRun> {
  const bounce = () => step("resolved", toReceipt({ cause: "ci_fail", prHead: pr.head, mainHead: null, checks }));
  const gh = ghOf(external);
  if (!gh) return bounce();
  const pending = pendingRerun(run, pr, checks);
  if (pending) return awaitRerun(run, pending, gh, step, bounce);
  let decision: Decision;
  try {
    decision = await decide(run, checks, gh);
  } catch (e) {
    decision = { kind: "bounce", why: `读 CI 失败：${oneLine((e as Error).message)}` };
  }
  if (decision.kind === "wait") return run;
  if (decision.kind === "bounce") {
    console.error(`⚠️ [merge] ${run.taskId} CI 红，不自动重跑，退回 fix：${decision.why}`);
    return bounce();
  }
  const rev = run.rev;
  const claimed = await step("resolved", rerunReceipt(pr.head, decision.plan));
  if (claimed.phase === "resolved") return claimed; // this head was already re-run once: the ledger bounced it
  if (claimed.rev === rev) return claimed; // claimed moments ago, GitHub still shows the old attempt: keep waiting, no second rerun
  try {
    await gh.rerunFailed(decision.plan.repo, decision.plan.runId);
    return claimed;
  } catch (e) {
    console.error(`⚠️ [merge] ${run.taskId} gh run rerun 失败，退回 fix：${oneLine((e as Error).message)}`);
    return bounce();
  }
}

/**
 * The rerun this run already claimed on this head (ciRerunClaim keeps it as the run's reason), when the red checks still point at
 * that run. Null otherwise: the caller decides afresh and the ledger answers any second claim. Any phase: ready, updating and
 * await_ci all reach here, the claim keeps the phase, and every phase change rewrites the reason, so a claim reason is current.
 */
function pendingRerun(run: MergeRun, pr: PrSnapshot, checks: FailedCheck[]): { receipt: string; repo: string; runId: string } | null {
  if (!run.reason?.startsWith(WAIT_LEAD)) return null;
  const receipt = run.reason.slice(WAIT_LEAD.length);
  const claim = parseRerunReceipt(receipt);
  if (!claim || claim.prHead.toLowerCase() !== pr.head.toLowerCase()) return null;
  const m = RUN_LINK.exec(claim.link);
  const runOf = (link: string) => RUN_LINK.exec(link)?.slice(1, 3).join("/");
  if (!m || checks.some((c) => runOf(c.link) !== `${m[1]}/${m[2]}`)) return null;
  return { receipt, repo: m[1]!, runId: m[2]! };
}

/**
 * After the rerun was sent only a newer attempt of the run (attempt > 1: a run that was re-run before is never re-run, so the
 * claimed one was attempt 1) is its result. The old attempt still showing → re-send the same claim: within RERUN_SETTLE_MS the
 * ledger leaves the run waiting (reason 等 CI 重跑开始), past it the ledger bounces (重跑没有开始). Never a second rerun.
 */
async function awaitRerun(run: MergeRun, pending: { receipt: string; repo: string; runId: string }, gh: CiRerunGh, step: Step,
  bounce: () => Promise<MergeRun>): Promise<MergeRun> {
  let latest: Awaited<ReturnType<CiRerunGh["runAttempt"]>>;
  try {
    latest = await gh.runAttempt(pending.repo, pending.runId);
  } catch (e) {
    console.error(`⚠️ [merge] ${run.taskId} CI 重跑后读 run 失败，退回 fix：${oneLine((e as Error).message)}`);
    return bounce();
  }
  if (latest.attempt > 1) {
    if (latest.status !== "completed" || latest.conclusion === "success") return run; // still running, or green while the PR checks catch up
    console.error(`⚠️ [merge] ${run.taskId} CI 红，不自动重跑，退回 fix：run 已重跑过（第 ${latest.attempt} 次仍红）`);
    return bounce();
  }
  const claimed = await step("resolved", pending.receipt);
  if (claimed.phase === "resolved") console.error(`⚠️ [merge] ${run.taskId} CI 红，退回 fix：重跑没有开始（${RERUN_SETTLE_MS / 60_000} 分钟后仍是旧 attempt）`);
  return claimed;
}

/** Prefix of the run's reason while a claimed rerun has not shown up on GitHub yet; the claim receipt follows it. */
export const RERUN_WAIT = "等 CI 重跑开始";
const WAIT_LEAD = `${RERUN_WAIT}：`;
const LEAD = "CI 自动重跑（只因本卡没碰的测试超时）";
const RECEIPT_MAX = 600;
const CASE_MAX = 120;
export function rerunReceipt(prHead: string, plan: Pick<RerunPlan, "link" | "checks" | "cases">): string {
  const of = (cases: string[]) => `${LEAD}：PR head ${prHead}，run ${plan.link}，失败检查 ${JSON.stringify(plan.checks)}，超时用例 ${JSON.stringify(cases)}`;
  const kept: string[] = [];
  for (const c of plan.cases.map((x) => [...x].slice(0, CASE_MAX).join(""))) {
    if (of([...kept, c]).length > RECEIPT_MAX) break;
    kept.push(c);
  }
  return of(kept);
}
const RECEIPT = /^CI 自动重跑（只因本卡没碰的测试超时）：PR head ([a-f0-9]{40})，run (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+)，失败检查 (\[.*?\])，超时用例 (\[.*\])$/;
export function parseRerunReceipt(receipt: string): { prHead: string; link: string; checks: string[]; cases: string[] } | null {
  const m = RECEIPT.exec(receipt);
  if (!m) return null;
  try {
    const [checks, cases] = [JSON.parse(m[3]!), JSON.parse(m[4]!)] as unknown[];
    const strings = (v: unknown, min: number): v is string[] => Array.isArray(v) && v.length >= min && v.every((x) => typeof x === "string" && x);
    return strings(checks, 1) && strings(cases, 0) ? { prHead: m[1]!, link: m[2]!, checks, cases } : null;
  } catch {
    return null; // Malformed JSON is no claim: closeMergeRun then refuses it as a bounce receipt without evidence.
  }
}

type WriteEvent = (db: Database, ctx: WriteCtx, e: { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> },
  primary: boolean) => unknown;

/**
 * How long after a claim GitHub may still show the old attempt of the same run; past it the rerun evidently never started.
 * Same yardstick as BEHIND_SETTLE_MS (i28-CIF2): it waits for the rerun to start, not for CI to finish (that is TRAIN_CI_TIMEOUT_MS).
 */
export const RERUN_SETTLE_MS = 10 * 60_000;

/**
 * Ledger side, inside closeMergeRun's transaction. Not a rerun claim → the receipt unchanged. A first claim for this head →
 * the event is written, the run keeps its phase (rev+1) with `等 CI 重跑开始：<claim>` as its reason, null. The same run claimed
 * again within RERUN_SETTLE_MS (GitHub still shows attempt 1 after the rerun call) → nothing written, rev unchanged, null: the
 * driver keeps waiting. The same run past it → a `重跑没有开始` event and the ci_fail bounce receipt. Anything else on a head
 * that was re-run already → the ci_fail bounce receipt.
 * The event goes through `writeEvent`, the caller's own ledger-tx insertEvent: only the writer modules import ledger-tx.
 */
export function ciRerunClaim(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, drift: string | null, toReceipt: ToReceipt,
  writeEvent: WriteEvent): string | null {
  const claim = parseRerunReceipt(receipt);
  if (!claim) return receipt;
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  if (claim.prHead.toLowerCase() !== row.reviewedHead.toLowerCase() || claim.checks.some((c) => !row.requiredChecks.split(",").includes(c))) {
    throw new LedgerError("invalid", "CI 重跑回执的 head / 检查名与本次合并不符");
  }
  const checks = claim.checks.map((name) => ({ name, link: claim.link }));
  const now = ctx.now ?? Date.now();
  const prior = rerunOf(db, row.taskId, claim.prHead);
  const bounce = toReceipt({ cause: "ci_fail", prHead: claim.prHead, mainHead: null, checks });
  if (prior && prior.run === claim.link) {
    if (now - prior.ts < RERUN_SETTLE_MS) return null;
    writeEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:ci_rerun_stale:${claim.prHead}` }, {
      project: row.project, target: row.taskId, kind: "scheduler",
      text: `合并队列：CI 重跑没有开始（发出重跑 ${RERUN_SETTLE_MS / 60_000} 分钟后 GitHub 仍是旧那次结果），退回 fix ${claim.link}`,
      data: { op: "merge_ci_rerun_stale", intentId: row.intentId, prHead: claim.prHead, run: claim.link, since: prior.ts, reason: "重跑没有开始" },
    }, true);
    return bounce;
  }
  if (prior) return bounce;
  db.prepare("UPDATE scheduler_merges SET rev=rev+1, reason=?, updatedAt=? WHERE intentId=?").run(`${WAIT_LEAD}${receipt}`, now, row.intentId);
  writeEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:ci_rerun:${claim.prHead}` }, {
    project: row.project, target: row.taskId, kind: "scheduler",
    text: `合并队列：CI 只因本卡没碰的测试超时而红，自动重跑一次（${claim.cases.join("、") || "用例见 run"}）${claim.link}`,
    data: { op: "merge_ci_rerun", intentId: row.intentId, phase: row.phase, prHead: claim.prHead, run: claim.link, checks: claim.checks,
      cases: claim.cases, reason: "所有失败都是超时，且失败的测试文件都不在本 PR 改动里" },
  }, true);
  return null;
}

const rerunOf = (db: Database, taskId: string, prHead: string): { ts: number; run: string } | null => db.query(`SELECT ts,
  json_extract(data,'$.run') AS run FROM events WHERE target=? AND kind='scheduler' AND json_extract(data,'$.op')='merge_ci_rerun'
  AND lower(json_extract(data,'$.prHead'))=lower(?) ORDER BY seq LIMIT 1`).get(taskId, prHead) as { ts: number; run: string } | null;
