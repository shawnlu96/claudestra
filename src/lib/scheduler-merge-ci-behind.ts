/**
 * Red required CI whose failing test files this PR does not touch, and that main has changed since the PR's merge-base, is
 * fixed by merging main in (update-branch, pinned to the reviewed head) instead of bouncing to fix (i28-CIF2). It runs where
 * CIF1 would bounce: CIF1 first (timeouts → rerun), then this layer. Once per merge run and per head: the claim goes through
 * the ledger (phase → updating) before update-branch is sent, and the next red on the new head bounces as before (no CIF1
 * rerun either). The moved head is carried by the existing "only merged main in" check (scheduler-merge-driver.ts movedHead),
 * so no re-review; a new head already red when first seen is carried, then bounced there, instead of going unknown.
 * Every doubt bounces (fail-closed). tests/scheduler-merge-ci-behind.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import type { EventKind } from "./ledger-stages.js";
import { runBounded } from "./run-bounded.js";
import { isTestProcess } from "./test-guard.js";
import { parseFailedLog } from "./scheduler-merge-ci-rerun-log.js";
import { ciRerunClaim, ciRerunGh, ciRerunOrBounce, parseRerunReceipt, type CiRerunGh } from "./scheduler-merge-ci-rerun.js";
import type { MergeBounce } from "./scheduler-merge-conflict.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

/** The GitHub calls this layer adds to CIF1's; a test (or another host) puts its own on the external as `ciBehind`. */
export interface CiBehindGh {
  /** Commits on main since the merge-base with `head` (GitHub compare `head...main`), with the main head they end at. */
  mainSince(repo: string, head: string): Promise<{ mergeBase: string; mainHead: string; commits: string[] }>;
  /** Commits reachable from `mainHead` that changed `file`, newest first. */
  fileCommits(repo: string, file: string, mainHead: string): Promise<string[]>;
  /** REST update-branch with `expected_head_sha`: GitHub refuses it once the head moved. */
  updateBranch(repo: string, pull: string, expectedHead: string): Promise<void>;
}
type FailedCheck = MergeBounce["checks"][number];
type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
type ToReceipt = (b: MergeBounce) => string;

const SHA = /^[a-f0-9]{40}$/i;
const sameSha = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const oneLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 300) ?? "";
const short = (s: string) => s.slice(0, 12);
/** More failing files than this is not "one stale test main already fixed". */
const MAX_FILES = 10;
/** A per-file history longer than one page may hide the commit; the intersection then misses it and the card bounces. */
const PER_PAGE = 100;

export function ciBehindGh(command: typeof runBounded = runBounded): CiBehindGh {
  const gh = async (...args: string[]) => {
    const r = await command(["gh", ...args], { env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 120_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh ${args.slice(0, 2).join(" ")} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  const shas = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && SHA.test(s));
  return {
    async mainSince(repo, head) {
      const raw = JSON.parse(await gh("api", `repos/${repo}/compare/${head}...main`, "--jq",
        "{base: .merge_base_commit.sha, commits: [.commits[].sha]}")) as { base?: unknown; commits?: unknown };
      if (typeof raw.base !== "string" || !SHA.test(raw.base) || !shas(raw.commits)) throw new Error("gh compare 没给出 merge-base / main 提交");
      return { mergeBase: raw.base, mainHead: raw.commits.at(-1) ?? raw.base, commits: raw.commits };
    },
    async fileCommits(repo, file, mainHead) {
      const raw = JSON.parse(await gh("api", "-X", "GET", `repos/${repo}/commits`, "-f", `sha=${mainHead}`, "-f", `path=${file}`,
        "-F", `per_page=${PER_PAGE}`, "--jq", "[.[].sha]")) as unknown;
      if (!shas(raw)) throw new Error("gh commits 没给出提交列表");
      return raw;
    },
    async updateBranch(repo, pull, expectedHead) {
      await gh("api", "-X", "PUT", `repos/${repo}/pulls/${pull}/update-branch`, "-f", `expected_head_sha=${expectedHead}`);
    },
  };
}

type Hosted = MergeExternal & { ciRerun?: CiRerunGh; ciBehind?: CiBehindGh };
/** Without both on the external, a test process never reaches the real gh: the bounce stays as it always was there. */
const ghsOf = (external: MergeExternal): { log: CiRerunGh; gh: CiBehindGh } | null => {
  const h = external as Hosted;
  const log = h.ciRerun ?? (isTestProcess() ? null : ciRerunGh());
  const gh = h.ciBehind ?? (isTestProcess() ? null : ciBehindGh());
  return log && gh ? { log, gh } : null;
};

const RUN_LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/\S*)?$/;
const PULL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;
export interface BehindPlan { repo: string; pull: string; link: string; prHead: string; mainHead: string; checks: string[];
  /** failing test file → main commits (short SHA) since the merge-base that changed it */
  files: Record<string, string[]> }

/** Every failing test file is outside the PR and was changed on main since the merge-base; anything else is the reason to bounce. */
async function planBehind(run: MergeRun, pr: PrSnapshot, checks: FailedCheck[], log: CiRerunGh, gh: CiBehindGh): Promise<BehindPlan | string> {
  const pull = PULL.exec(run.prRef);
  if (!pull) return "PR URL 不合法";
  const runs = checks.map((c) => RUN_LINK.exec(c.link));
  if (!runs.length || runs.some((m) => !m)) return "失败检查没有 Actions run 链接";
  if (new Set(runs.map((m) => `${m![1]}/${m![2]}`)).size !== 1) return "失败检查分属多个 run";
  const [repo, runId] = [runs[0]![1]!, runs[0]![2]!];
  if (repo.toLowerCase() !== pull[1]!.toLowerCase()) return "run 与 PR 不在同一仓库";
  const failures = parseFailedLog(await log.failedLog(repo, runId));
  if (!failures) return "失败日志解析不出 bun test 的失败用例";
  const files = [...new Set(failures.map((f) => f.file))];
  if (files.length > MAX_FILES) return `失败的测试文件超过 ${MAX_FILES} 个`;
  const touched = new Set(await log.prFiles(run.prRef));
  const own = files.find((f) => touched.has(f));
  if (own) return `失败的测试文件 ${own} 在本 PR 改动里`;
  const since = await gh.mainSince(repo, pr.head);
  if (!since.commits.length) return "PR 不落后 main";
  const onMain = new Set(since.commits.map((c) => c.toLowerCase()));
  const byFile: Record<string, string[]> = {};
  for (const file of files) {
    const hits = (await gh.fileCommits(repo, file, since.mainHead)).filter((c) => onMain.has(c.toLowerCase()));
    if (!hits.length) return `main 在 merge-base 之后没改过 ${file}`;
    byFile[file] = hits.map(short);
  }
  return { repo, pull: pull[2]!, link: `https://github.com/${repo}/actions/runs/${runId}`, prHead: pr.head, mainHead: since.mainHead,
    checks: checks.map((c) => c.name), files: byFile };
}

/**
 * Driver side of a ci_fail on the untouched reviewed head, in place of CIF1's entry. A head this layer already sent
 * update-branch for (run in `updating`, its claim as the reason) is re-claimed, so the ledger decides wait vs bounce; else
 * CIF1 runs with its plain bounce routed through `behindOrBounce`.
 */
export async function ciBehindOrRerun(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, checks: FailedCheck[],
  toReceipt: ToReceipt): Promise<MergeRun> {
  const bounceReceipt = toReceipt({ cause: "ci_fail", prHead: pr.head, mainHead: null, checks });
  const pending = run.phase === "updating" && run.reason ? parseBehindReceipt(run.reason) : null;
  if (pending && sameSha(pending.prHead, pr.head)) return step("resolved", run.reason!); // GitHub has not moved the head yet
  const routed: Step = (to, receipt) => to === "resolved" && receipt === bounceReceipt && run.phase !== "updating"
    ? behindOrBounce(run, pr, external, step, checks, bounceReceipt) : step(to, receipt);
  return ciRerunOrBounce(run, pr, external, routed, checks, toReceipt);
}

async function behindOrBounce(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, checks: FailedCheck[],
  bounceReceipt: string): Promise<MergeRun> {
  const bounce = (why: string) => {
    console.error(`⚠️ [merge] ${run.taskId} CI 红，不自动合入 main，退回 fix：${why}`);
    return step("resolved", bounceReceipt);
  };
  const ghs = ghsOf(external);
  if (!ghs) return step("resolved", bounceReceipt);
  let plan: BehindPlan | string;
  try {
    plan = await planBehind(run, pr, checks, ghs.log, ghs.gh);
  } catch (e) {
    plan = `读 CI / main 失败：${oneLine((e as Error).message)}`;
  }
  if (typeof plan === "string") return bounce(plan);
  const receipt = behindReceipt(plan);
  if (receipt.length > RECEIPT_MAX) return bounce("证据超过回执长度");
  const claimed = await step("resolved", receipt);
  if (claimed.phase !== "updating") return claimed; // the ledger bounced it: this run / head already merged main in once
  try {
    await ghs.gh.updateBranch(plan.repo, plan.pull, plan.prHead);
    return claimed;
  } catch (e) {
    return bounce(`update-branch 失败：${oneLine((e as Error).message)}`);
  }
}

const LEAD = "CI 落后 main，自动合入 main（失败测试本卡没碰、main 已改过）";
const RECEIPT_MAX = 600;
export const behindReceipt = (p: Pick<BehindPlan, "prHead" | "mainHead" | "link" | "checks" | "files">): string =>
  `${LEAD}：PR head ${p.prHead}，main head ${p.mainHead}，run ${p.link}，失败检查 ${JSON.stringify(p.checks)}，失败文件 ${JSON.stringify(p.files)}`;
const RECEIPT = new RegExp(`^${LEAD}：PR head ([a-f0-9]{40})，main head ([a-f0-9]{40})，` +
  "run (https://github\\.com/[\\w.-]+/[\\w.-]+/actions/runs/\\d+)，失败检查 (\\[.*?\\])，失败文件 (\\{.*\\})$");
export function parseBehindReceipt(receipt: string): Pick<BehindPlan, "prHead" | "mainHead" | "link" | "checks" | "files"> | null {
  const m = RECEIPT.exec(receipt);
  if (!m) return null;
  try {
    const [checks, files] = [JSON.parse(m[4]!), JSON.parse(m[5]!)] as unknown[];
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x);
    if (!strings(checks) || !files || typeof files !== "object" || Array.isArray(files)) return null;
    const entries = Object.entries(files as Record<string, unknown>);
    if (!entries.length || entries.some(([f, c]) => !f || !strings(c))) return null;
    return { prHead: m[1]!, mainHead: m[2]!, link: m[3]!, checks, files: files as Record<string, string[]> };
  } catch {
    return null; // Malformed JSON is no claim: closeMergeRun then refuses it as a bounce receipt without evidence.
  }
}

type WriteEvent = (db: Database, ctx: WriteCtx, e: { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> },
  primary: boolean) => unknown;

/** How long after the claim GitHub may still show the old head; past it the update evidently never happened. */
export const BEHIND_SETTLE_MS = 10 * 60_000;

/** The driver's view of "this run sent update-branch itself": `updating` with this layer's claim as the reason. */
export const behindUpdating = (run: MergeRun): boolean => run.phase === "updating" && !!run.reason && !!parseBehindReceipt(run.reason);

/**
 * Ledger side, inside closeMergeRun's transaction, wrapping CIF1's claim (null passes through: CIF1 claimed). A CIF1 rerun
 * claim in a run that already merged main in → the ci_fail bounce: the new head's red goes back to fix, no rerun (spec 3).
 * Not a claim → the receipt unchanged. A first claim on a ready / await_ci run whose intent and head never had one → phase `updating`
 * (rev+1, the claim as reason) and the event, null. The same claim re-sent while `updating` within BEHIND_SETTLE_MS →
 * nothing written, null: the driver keeps waiting for the new head. Anything else → the ci_fail bounce receipt.
 */
export function ciBehindClaim(db: Database, ctx: WriteCtx, row: MergeRun, raw: string, drift: string | null, toReceipt: ToReceipt,
  writeEvent: WriteEvent): string | null {
  const rerun = parseRerunReceipt(raw);
  const receipt = rerun && behindOf(db, row, false)
    ? toReceipt({ cause: "ci_fail", prHead: rerun.prHead, mainHead: null, checks: rerun.checks.map((name) => ({ name, link: rerun.link })) })
    : ciRerunClaim(db, ctx, row, raw, drift, toReceipt, writeEvent);
  const claim = receipt === null ? null : parseBehindReceipt(receipt);
  if (!claim) return receipt;
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  if (!sameSha(claim.prHead, row.reviewedHead) || claim.checks.some((c) => !row.requiredChecks.split(",").includes(c))) {
    throw new LedgerError("invalid", "CI 落后 main 回执的 head / 检查名与本次合并不符");
  }
  const bounce = toReceipt({ cause: "ci_fail", prHead: claim.prHead, mainHead: null, checks: claim.checks.map((name) => ({ name, link: claim.link })) });
  const now = ctx.now ?? Date.now();
  const prior = behindOf(db, row);
  if (row.phase === "updating") {
    return prior && sameSha(prior.prHead, claim.prHead) && row.reason === receipt && now - prior.ts < BEHIND_SETTLE_MS ? null : bounce;
  }
  if (prior || (row.phase !== "ready" && row.phase !== "await_ci")) return bounce;
  db.prepare("UPDATE scheduler_merges SET phase='updating', rev=rev+1, reason=?, unknownSince=NULL, updatedAt=? WHERE intentId=?")
    .run(receipt, now, row.intentId);
  const commits = [...new Set(Object.values(claim.files).flat())];
  writeEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:ci_behind` }, {
    project: row.project, target: row.taskId, kind: "scheduler",
    text: `合并队列：CI 只红在本卡没碰、main 已改过的测试（${Object.keys(claim.files).join("、")}），自动合入 main 再等 CI（main ${commits.join("、")}）`,
    data: { op: "merge_ci_behind", intentId: row.intentId, from: row.phase, to: "updating", prHead: claim.prHead, oldHead: claim.prHead,
      // update-branch has not run yet; the head it produces is recorded by the review_carry (or await_review) event of this intent.
      newHead: null, mainHead: claim.mainHead, run: claim.link, checks: claim.checks, files: claim.files, commits,
      reason: "失败的测试文件都不在本 PR 改动里，且 main 在 merge-base 之后都改过" },
  }, true);
  return null;
}

/** One per merge run and one per head (`byHead`): the new head's red, or a later run on the same head, bounces. */
const behindOf = (db: Database, row: MergeRun, byHead = true): { ts: number; prHead: string } | null => db.query(`SELECT ts,
  json_extract(data,'$.prHead') AS prHead FROM events WHERE target=? AND kind='scheduler' AND json_extract(data,'$.op')='merge_ci_behind'
  AND (json_extract(data,'$.intentId')=? OR (? AND lower(json_extract(data,'$.prHead'))=lower(?))) ORDER BY seq LIMIT 1`)
  .get(row.taskId, row.intentId, byHead ? 1 : 0, row.reviewedHead) as { ts: number; prHead: string } | null;
