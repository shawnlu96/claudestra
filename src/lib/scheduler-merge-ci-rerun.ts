/**
 * Red required CI that only timed out in tests this PR does not touch is re-run once per PR head instead of bouncing to fix
 * (i28-CIF1). Driver side reads the failed log and decides; the claim goes through the ledger before `gh run rerun` is sent,
 * so a second red on the same head (or a failed rerun call) bounces exactly as before. Every doubt bounces (fail-closed).
 * tests/scheduler-merge-ci-rerun.test.ts.
 */
import type { Database } from "bun:sqlite";
import { firstAsserted, firstTouched } from "./ci-failure-class.js";
import { knownFlakyBase, knownFlakyClaim, knownFlakyRerun, type KnownFlakyRed } from "./ci-known-flaky-rerun.js";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import type { EventKind } from "./ledger-stages.js";
import { rethrowCiLogStop, checkedFailedLog, judgeCiLog, readPerJobLog, type PerJobLog } from "./scheduler-merge-ci-log-read.js";
import { runBounded } from "./run-bounded.js";
import { isTestProcess } from "./test-guard.js";
import { currentCountFailures, effCountRefreshStep } from "./effect-count-refresh.js";
import { ciClaimJournal, settledUnsentClaims } from "./scheduler-ci-claim-unsent.js";
import { parseFailedLog, type CiFailure } from "./scheduler-merge-ci-rerun-log.js";
import { RECEIPT_MAX } from "./scheduler-merge-ci-receipt.js";
import { CANCEL_RERUN_TEXT, cancelClaimBase, cancelManualReceipt } from "./scheduler-merge-ci-cancel-judge.js";
import { sendDecision, type DecisionTrail } from "./ci-main-fix-retry-decision.js";
import type { MergeBounce } from "./scheduler-merge-conflict.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

/** The GitHub calls this needs; a test (or another host) puts its own on the external as `ciRerun`. */
export interface CiRerunGh {
  /**
   * `attempt` > 1 means the run was already re-run; `status` is "completed" once that attempt ended, with its `conclusion`.
   * `headSha` is the commit the run tested: a rerun is only ever sent for a run of the reviewed head (merge-arch-CICANCEL1).
   */
  runAttempt(repo: string, runId: string): Promise<{ attempt: number; status: string; conclusion: string; headSha: string }>;
  failedLog(repo: string, runId: string): Promise<string>;
  perJobLog?(repo: string, runId: string, attempt: number): Promise<PerJobLog>;
  prFiles(prRef: string): Promise<string[]>;
  rerunFailed(repo: string, runId: string): Promise<void>;
}
type FailedCheck = MergeBounce["checks"][number];
type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
type ToReceipt = (b: MergeBounce) => string;

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
      const raw = JSON.parse(await gh("run", "view", runId, "--repo", repo, "--json", "attempt,status,conclusion,headSha")) as
        { attempt?: unknown; status?: unknown; conclusion?: unknown; headSha?: unknown };
      if (!Number.isSafeInteger(raw.attempt) || typeof raw.status !== "string") throw new Error("gh run view 没给出 attempt / status");
      if (typeof raw.headSha !== "string" || !/^[a-f0-9]{40}$/i.test(raw.headSha)) throw new Error("gh run view 没给出 run 的 headSha");
      return { attempt: raw.attempt as number, status: raw.status, conclusion: typeof raw.conclusion === "string" ? raw.conclusion : "", headSha: raw.headSha };
    },
    async failedLog(repo, runId) {
      const log = await gh("run", "view", runId, "--repo", repo, "--log-failed");
      return checkedFailedLog(log);
    },
    perJobLog: (repo, runId, attempt) => readPerJobLog(command, repo, runId, attempt),
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
export const ciRerunGhOf = (external: MergeExternal): CiRerunGh | null =>
  (external as MergeExternal & { ciRerun?: CiRerunGh }).ciRerun ?? (isTestProcess() ? null : ciRerunGh());

export const CI_RUN_LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/\S*)?$/;
export interface RerunPlan { repo: string; runId: string; link: string; checks: string[]; cases: string[] }
type Decision = { kind: "rerun"; plan: RerunPlan } | { kind: "wait" } | { kind: "bounce"; why: string; flaky?: KnownFlakyRed };

/** One workflow run behind every failed check, read from GitHub; anything else is a bounce with the reason. */
async function decide(run: MergeRun, checks: FailedCheck[], gh: CiRerunGh, trail?: DecisionTrail): Promise<Decision> {
  const runs = checks.map((c) => CI_RUN_LINK.exec(c.link));
  if (!runs.length || runs.some((m) => !m)) return { kind: "bounce", why: "失败检查没有 Actions run 链接" };
  const ids = new Set(runs.map((m) => `${m![1]}/${m![2]}`));
  if (ids.size !== 1) return { kind: "bounce", why: "失败检查分属多个 run" };
  const [repo, runId] = [runs[0]![1]!, runs[0]![2]!];
  const { attempt, status, conclusion, headSha } = await gh.runAttempt(repo, runId);
  if (trail) [trail.run, trail.attempt] = [`https://github.com/${repo}/actions/runs/${runId}`, attempt];
  // CICANCEL1: a check link may point at another head's run (an older head re-run by hand); re-running it would cancel this
  // head's CI. Neither CIF1 nor CIF8 (reached only from here) acts on it: wait, the next tick reads the checks again.
  if (headSha.toLowerCase() !== run.reviewedHead.toLowerCase()) return { kind: "wait" };
  // CIWAIT1: a required check can turn red while other jobs of the run are still going, and gh refuses the failed log until the
  // run ends. Nothing is read, re-run or bounced before that, whatever the attempt: the next tick reads the run again.
  if (status !== "completed") return { kind: "wait" };
  // The run went green but the PR checks still show the old red for a moment: wait for them to catch up.
  if (conclusion === "success") return { kind: "wait" };
  // A re-run that ended red is the second red.
  if (attempt > 1) return { kind: "bounce", why: `run 已重跑过（第 ${attempt} 次仍红）` };
  return judgeCiLog(run, repo, runId, attempt, gh, "cif1", (log) => judgeRerunLog(log, run, checks, gh, repo, runId, trail),
    (d) => d.kind === "rerun" ? { wouldKind: "rerun", why: "只因本卡没碰的测试超时", cases: d.plan.cases } :
      { wouldKind: d.kind === "bounce" && d.flaky ? "flaky" : "bounce", why: d.kind === "bounce" ? d.why : "等待",
        files: d.kind === "bounce" ? [...new Set(d.flaky?.failures.map((f) => f.file))] : undefined });
}

async function judgeRerunLog(log: string, run: MergeRun, checks: FailedCheck[], gh: CiRerunGh, repo: string, runId: string,
  trail?: DecisionTrail): Promise<Decision> {
  const failures = parseFailedLog(log);
  if (!failures) return { kind: "bounce", why: "失败日志解析不出 bun test 的失败用例" };
  if (trail) trail.files = [...new Set(failures.map((f) => f.file))].sort();
  const asserted = firstAsserted(failures);
  if (asserted) return { kind: "bounce", why: `有非超时失败：${asserted.name}`, flaky: { repo, runId, failures } }; // CIF8
  const own = firstTouched(failures, new Set(await gh.prFiles(run.prRef)));
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
  toReceipt: ToReceipt, trail?: DecisionTrail): Promise<MergeRun> {
  const bounce = () => step("resolved", toReceipt({ cause: "ci_fail", prHead: pr.head, mainHead: null, checks }));
  const gh = ciRerunGhOf(external);
  if (!gh) return bounce();
  if (!run.reason?.startsWith(WAIT_LEAD)) {
    const links = checks.map((c) => CI_RUN_LINK.exec(c.link));
    if (links.length && links.every((m) => m && m[1] === links[0]![1] && m[2] === links[0]![2])) {
      const link = `https://github.com/${links[0]![1]}/actions/runs/${links[0]![2]}`;
      // CIFLEN1: a query that cannot fit the gate stands for no claim either (claims fit with the prefix): skip it, decide reads the run.
      const query = fitRerunReceipt(pr.head, { link, checks: checks.map((c) => c.name), cases: [] });
      if (query) run = await step("resolved", `${QUERY_LEAD}${query}`);
    }
  }
  const pending = pendingRerun(run, pr, checks);
  if (pending) return awaitRerun(run, pending, gh, step, bounce, async () => await effCountRefreshStep(run, pr, step, currentCountFailures(checks, gh), bounce) ?? bounce(), trail);
  let decision: Decision;
  try {
    decision = await decide(run, checks, gh, trail);
  } catch (e) {
    rethrowCiLogStop(e);
    decision = { kind: "bounce", why: `读 CI 失败：${oneLine((e as Error).message)}` };
  }
  if (decision.kind === "wait") return run;
  if (decision.kind === "bounce") {
    const refreshed = await effCountRefreshStep(run, pr, step, decision.flaky?.failures ?? currentCountFailures(checks, gh), bounce); if (refreshed) return refreshed; // EFFAUTO1: count-only red
    trail?.note("cif1", false, decision.why);
    const flaky = decision.flaky && await knownFlakyRerun({ run, prHead: pr.head, checks: checks.map((c) => c.name), gh, step, receiptOf: rerunReceipt }, decision.flaky);
    if (decision.flaky) trail?.note("cif8", !!flaky, flaky ? "失败测试都在有效的已知偶发清单里" : "不按已知偶发重跑（开关没开、不在有效清单或判不成）");
    if (flaky) {
      if (flaky.phase !== "resolved") await sendDecision(flaky, pr.head, trail, step);
      return flaky;
    }
    console.error(`⚠️ [merge] ${run.taskId} CI 红，不自动重跑，退回 fix：${decision.why}`);
    return bounce();
  }
  const receipt = fitRerunReceipt(pr.head, decision.plan);
  if (!receipt) {
    console.error(`⚠️ [merge] ${run.taskId} CI 红，不自动重跑，退回 fix：失败检查和 run 超过回执长度（${RECEIPT_MAX} 字）`);
    trail?.note("cif1", false, "失败检查和 run 超过回执长度");
    return bounce();
  }
  trail?.note("cif1", true, "所有失败都是本卡没碰的测试超时");
  await sendDecision(run, pr.head, trail, step);
  const rev = run.rev;
  const claimed = await step("resolved", receipt);
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

/** The ledger restores this cache from its durable claim after phase changes clear the reason; head/run must still match. */
function pendingRerun(run: MergeRun, pr: PrSnapshot, checks: FailedCheck[]): { receipt: string; repo: string; runId: string } | null {
  if (!run.reason?.startsWith(WAIT_LEAD)) return null;
  const receipt = run.reason.slice(WAIT_LEAD.length);
  const claim = parseRerunReceipt(claimBase(receipt));
  if (!claim || claim.prHead.toLowerCase() !== pr.head.toLowerCase()) return null;
  const m = CI_RUN_LINK.exec(claim.link);
  const runOf = (link: string) => CI_RUN_LINK.exec(link)?.slice(1, 3).join("/");
  if (!m || checks.some((c) => runOf(c.link) !== `${m[1]}/${m[2]}`)) return null;
  return { receipt, repo: m[1]!, runId: m[2]! };
}

/**
 * After the rerun was sent only a newer attempt of the run (attempt > 1: a run that was re-run before is never re-run, so the
 * claimed one was attempt 1) is its result. The old attempt still showing → re-send the same claim: within RERUN_SETTLE_MS the
 * ledger leaves the run waiting (reason 等 CI 重跑开始), past it the ledger bounces (重跑没有开始). Never a second rerun.
 */
async function awaitRerun(run: MergeRun, pending: { receipt: string; repo: string; runId: string }, gh: CiRerunGh, step: Step,
  bounce: () => Promise<MergeRun>, redBounce: () => Promise<MergeRun>, trail?: DecisionTrail): Promise<MergeRun> {
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
    if (trail) [trail.run, trail.attempt] = [`https://github.com/${pending.repo}/actions/runs/${pending.runId}`, latest.attempt];
    trail?.note("cif1", false, `run 已重跑过（第 ${latest.attempt} 次仍红）`);
    return redBounce(); // EFFAUTO1: the rerun's red is classified by its log too (count-only → refresh), else the same bounce
  }
  const claimed = await step("resolved", pending.receipt);
  if (claimed.phase === "resolved") console.error(`⚠️ [merge] ${run.taskId} CI 红，退回 fix：重跑没有开始（${RERUN_SETTLE_MS / 60_000} 分钟后仍是旧 attempt）`);
  return claimed;
}

/** CIF1's own claim inside a CIF8 (known flaky) or CICANCEL1 (cancelled run) claim; any other receipt unchanged. */
const claimBase = (receipt: string): string => knownFlakyBase(cancelClaimBase(receipt) ?? receipt);

/** Prefix of the run's reason while a claimed rerun has not shown up on GitHub yet; the claim receipt follows it. */
export const RERUN_WAIT = "等 CI 重跑开始";
const WAIT_LEAD = `${RERUN_WAIT}：`;
/** Claim lookup through the existing transaction channel restores the reason cache, never creates a claim or sends a rerun. */
const QUERY_LEAD = "查询 CI 重跑：";
export const RERUN_QUERY = QUERY_LEAD;
const LEAD = "CI 自动重跑（只因本卡没碰的测试超时）";
/** CIFLEN1: a claim is fitted so its query (prefix + claim) passes the gate too; claim and query share the one budget. */
const CLAIM_MAX = RECEIPT_MAX - QUERY_LEAD.length;
const CASE_MAX = 120;
const renderRerun = (prHead: string, plan: Pick<RerunPlan, "link" | "checks">, cases: string[]): string =>
  `${LEAD}：PR head ${prHead}，run ${plan.link}，失败检查 ${JSON.stringify(plan.checks)}，超时用例 ${JSON.stringify(cases)}`;
/**
 * The claim with as many whole cases as fit; null when head, run and every check name do not fit even without cases. Cases are
 * only the event's prose; head, run and checks are never cut (the ledger matches them), so such evidence goes back to fix instead.
 */
export function fitRerunReceipt(prHead: string, plan: Pick<RerunPlan, "link" | "checks" | "cases">): string | null {
  if (renderRerun(prHead, plan, []).length > CLAIM_MAX) return null;
  const kept: string[] = [];
  for (const c of plan.cases.map((x) => [...x].slice(0, CASE_MAX).join(""))) {
    if (renderRerun(prHead, plan, [...kept, c]).length > CLAIM_MAX) break;
    kept.push(c);
  }
  return renderRerun(prHead, plan, kept);
}
/** fitRerunReceipt, or the unfitted claim the gate refuses (CIF8 measures the length itself and then keeps its plain bounce). */
export const rerunReceipt = (prHead: string, plan: Pick<RerunPlan, "link" | "checks" | "cases">): string =>
  fitRerunReceipt(prHead, plan) ?? renderRerun(prHead, plan, []);
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
  const query = receipt.startsWith(QUERY_LEAD);
  const raw = query ? receipt.slice(QUERY_LEAD.length) : receipt;
  const claim = parseRerunReceipt(claimBase(raw)); // CIF8 / CICANCEL1: CIF1's claim plus the failing files / the cancel mark
  if (!claim) return receipt;
  // CICANCEL1: a cancelled run's claim the budget refuses goes to the PM (ciCancelGate), never back to fix
  const cancel = cancelClaimBase(raw) !== null;
  const toPm = (why: string) => cancelManualReceipt({ prHead: claim.prHead, link: claim.link, attempt: 1 }, why);
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  if (claim.prHead.toLowerCase() !== row.reviewedHead.toLowerCase() || claim.checks.some((c) => !row.requiredChecks.split(",").includes(c))) {
    throw new LedgerError("invalid", "CI 重跑回执的 head / 检查名与本次合并不符");
  }
  const checks = claim.checks.map((name) => ({ name, link: claim.link }));
  const now = ctx.now ?? Date.now();
  const prior = ciRerunSpent(db, row.taskId, claim.prHead);
  const bounce = toReceipt({ cause: "ci_fail", prHead: claim.prHead, mainHead: null, checks });
  if (query) {
    // Phase transitions erase the reason, but the append-only event remains authoritative. No matching event means no write.
    if (prior?.run === claim.link) {
      db.prepare("UPDATE scheduler_merges SET rev=rev+1, reason=? WHERE intentId=?").run(`${WAIT_LEAD}${raw}`, row.intentId);
    }
    return null;
  }
  if (prior && prior.run === claim.link) {
    if (now - prior.ts < RERUN_SETTLE_MS) return null;
    writeEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:ci_rerun_stale:${claim.prHead}` }, {
      project: row.project, target: row.taskId, kind: "scheduler",
      text: `合并队列：CI 重跑没有开始（发出重跑 ${RERUN_SETTLE_MS / 60_000} 分钟后 GitHub 仍是旧那次结果），${cancel ? "退人工" : "退回 fix"} ${claim.link}`,
      data: { op: "merge_ci_rerun_stale", intentId: row.intentId, prHead: claim.prHead, run: claim.link, since: prior.ts, reason: "重跑没有开始" },
    }, true);
    return cancel ? toPm("重跑没有开始") : bounce;
  }
  const flaky = cancel ? undefined : knownFlakyClaim(db, { ...ctx, now }, row, raw, claim, !!prior, writeEvent); // CIF8
  if (flaky === null) return null;
  if (prior) return cancel ? toPm("CI 被取消，本 head 已自动重跑过") : bounce;
  db.prepare("UPDATE scheduler_merges SET rev=rev+1, reason=?, updatedAt=? WHERE intentId=?").run(`${WAIT_LEAD}${receipt}`, now, row.intentId);
  writeEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:ci_rerun:${claim.prHead}` }, {
    project: row.project, target: row.taskId, kind: "scheduler",
    text: cancel ? `合并队列：${CANCEL_RERUN_TEXT}（必需检查只有取消、没有失败）${claim.link}`
      : flaky?.text ?? `合并队列：CI 只因本卡没碰的测试超时而红，自动重跑一次（${claim.cases.join("、") || "用例见 run"}）${claim.link}`,
    data: { op: "merge_ci_rerun", intentId: row.intentId, phase: row.phase, prHead: claim.prHead, run: claim.link, checks: claim.checks,
      cases: claim.cases, reason: cancel ? CANCEL_RERUN_TEXT : "所有失败都是超时，且失败的测试文件都不在本 PR 改动里", ...flaky?.data,
      ...(cancel ? { cancelled: true } : {}), ...ciClaimJournal(row.project) },
  }, true);
  return null;
}

/** The merge train's own claim (scheduler-train-ci-rerun-state.ts): one note per member, same `prHead` / `run` fields as CIF1's event. */
export const TRAIN_RERUN_OP = "merge_train_ci_rerun";
/** A re-run of a car's run the train did not send (a person's): one note per member all the same, so the head's budget is spent. */
export const TRAIN_RERUN_SEEN_OP = "merge_train_ci_rerun_seen";
/**
 * The one automatic re-run a card's head gets, whoever spent it: this gate (CIF1 / CIF8), a merge train car the card rode in, or
 * a person re-running that car's run (merge-arch-CLASS1). A train's run link is never the serial claim's, so a head spent there
 * bounces here like any second red. Under ciClaimUnsent=on only a serial claim the main CI gate settled as never sent
 * (scheduler-ci-claim-unsent.ts) is skipped; train and manual reruns always count.
 */
export const ciRerunSpent = (db: Database, taskId: string, prHead: string): { ts: number; run: string } | null => {
  const rows = db.query(`SELECT seq, ts, project, kind, json_extract(data,'$.run') AS run FROM events WHERE target=? AND
    ((kind='scheduler' AND json_extract(data,'$.op')='merge_ci_rerun')
    OR (kind='note' AND actor='scheduler' AND json_extract(data,'$.op') IN ('${TRAIN_RERUN_OP}','${TRAIN_RERUN_SEEN_OP}')))
    AND lower(json_extract(data,'$.prHead'))=lower(?) ORDER BY seq`).all(taskId, prHead) as { seq: number; ts: number; project: string; kind: string; run: string }[];
  const settled = new Map<string, ReadonlySet<number>>();
  const hit = rows.find((r) => r.kind !== "scheduler" ||
    !(settled.get(r.project) ?? settled.set(r.project, settledUnsentClaims(db, r.project, taskId)).get(r.project)!).has(r.seq));
  return hit ? { ts: hit.ts, run: hit.run } : null;
};
