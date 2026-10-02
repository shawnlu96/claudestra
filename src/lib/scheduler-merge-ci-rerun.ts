/**
 * Red required CI that only timed out in tests this PR does not touch is re-run once per PR head instead of bouncing to fix
 * (i28-CIF1). Driver side reads the failed log and decides; the claim goes through the ledger before `gh run rerun` is sent,
 * so a second red on the same head (or a failed rerun call) bounces exactly as before. Every doubt bounces (fail-closed).
 * tests/scheduler-merge-ci-rerun.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { runBounded } from "./run-bounded.js";
import { isTestProcess } from "./test-guard.js";
import { parseFailedLog, type CiFailure } from "./scheduler-merge-ci-rerun-log.js";
import type { MergeBounce } from "./scheduler-merge-conflict.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

/** The GitHub calls this needs; a test (or another host) puts its own on the external as `ciRerun`. */
export interface CiRerunGh {
  /** `attempt` > 1 means the run was already re-run; `status` is "completed" once that attempt ended. */
  runAttempt(repo: string, runId: string): Promise<{ attempt: number; status: string }>;
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
      const raw = JSON.parse(await gh("run", "view", runId, "--repo", repo, "--json", "attempt,status")) as { attempt?: unknown; status?: unknown };
      if (!Number.isSafeInteger(raw.attempt) || typeof raw.status !== "string") throw new Error("gh run view 没给出 attempt / status");
      return { attempt: raw.attempt as number, status: raw.status };
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
  const { attempt, status } = await gh.runAttempt(repo, runId);
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
  const claimed = await step("resolved", rerunReceipt(pr.head, decision.plan));
  if (claimed.phase === "resolved") return claimed; // this head was already re-run once: the ledger bounced it
  try {
    await gh.rerunFailed(decision.plan.repo, decision.plan.runId);
    return claimed;
  } catch (e) {
    console.error(`⚠️ [merge] ${run.taskId} gh run rerun 失败，退回 fix：${oneLine((e as Error).message)}`);
    return bounce();
  }
}

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

/**
 * Ledger side, inside closeMergeRun's transaction. Not a rerun claim → the receipt unchanged. A first claim for this head →
 * the event is written, the run keeps its phase (rev+1), null. A head that was re-run already → the ci_fail bounce receipt.
 */
export function ciRerunClaim(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, drift: string | null, toReceipt: ToReceipt): string | null {
  const claim = parseRerunReceipt(receipt);
  if (!claim) return receipt;
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  if (claim.prHead.toLowerCase() !== row.reviewedHead.toLowerCase() || claim.checks.some((c) => !row.requiredChecks.split(",").includes(c))) {
    throw new LedgerError("invalid", "CI 重跑回执的 head / 检查名与本次合并不符");
  }
  const checks = claim.checks.map((name) => ({ name, link: claim.link }));
  if (rerunOf(db, row.taskId, claim.prHead)) return toReceipt({ cause: "ci_fail", prHead: claim.prHead, mainHead: null, checks });
  const now = ctx.now ?? Date.now();
  db.prepare("UPDATE scheduler_merges SET rev=rev+1, updatedAt=? WHERE intentId=?").run(now, row.intentId);
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:ci_rerun:${claim.prHead}` }, {
    project: row.project, target: row.taskId, kind: "scheduler",
    text: `合并队列：CI 只因本卡没碰的测试超时而红，自动重跑一次（${claim.cases.join("、") || "用例见 run"}）${claim.link}`,
    data: { op: "merge_ci_rerun", intentId: row.intentId, phase: row.phase, prHead: claim.prHead, run: claim.link, checks: claim.checks,
      cases: claim.cases, reason: "所有失败都是超时，且失败的测试文件都不在本 PR 改动里" },
  }, true);
  return null;
}

const rerunOf = (db: Database, taskId: string, prHead: string): boolean => !!db.query(`SELECT 1 FROM events WHERE target=? AND kind='scheduler'
  AND json_extract(data,'$.op')='merge_ci_rerun' AND lower(json_extract(data,'$.prHead'))=lower(?) LIMIT 1`).get(taskId, prHead);
