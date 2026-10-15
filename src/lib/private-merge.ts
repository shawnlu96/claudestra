/**
 * merge-arch-MERGEAUTO1 · the merge driver's private branch (scheduler-merge-driver.ts driveMerge, first thing in its try): a run whose
 * PR is in a private repository with a checkout here, under privateRepoMerge=on, is merged by "check head + check CI + match-head
 * merge" in that checkout, on the same merge run (phases, receipts, merge slot, bounce, merged / deploy outbox) as any other card.
 * No update-branch, no train, no union: only
 * 1. serial — one run per private repository at a time (private-merge-ledger.ts privateMergeTurn), the rest wait;
 * 2. the PR — MERGED at the reviewed head with a merge commit (PM merged it by hand) is recorded merged, no gh pr merge; CLOSED,
 *    base not main, or merged at another head goes to PM; OPEN at another head goes back to review (await_review, the drift rule);
 *    a draft or a mergeability GitHub has not computed waits; CONFLICTING bounces as a conflict;
 * 3. CI — main's required status checks; none readable (no protection / no permission) = every check finished green and at least
 *    one passed, no check at all goes to PM 「私仓没有可核的 CI」; running checks wait, at most 2 hours per head, then PM once; a red
 *    one bounces to fix through the ledger's own bounce, the run's check list first set to the private repository's verified
 *    required checks (private-merge-ledger.ts privateBounceChecks), so the ledger's name gate takes the private repository's own names;
 * 4. the merge — claim `merging`, the driver's recheck, `gh pr merge --match-head-commit <reviewed head>`, then a read back: only a
 *    MERGED PR at that head with a merge commit is `merged`.
 * gh failing (any step) is retried next pass; the 3rd in a row on one head goes to PM. Going to PM is the driver's own foreign_repo
 * hand-over (fallback manual first, then an unsent unknown the ledger ends as cancelled: no freeze). Off / observe / no checkout /
 * a manual merge request (mmq:) / no hand-over hook: null, the driver's old path (ForeignRepoError → foreign_repo) runs unchanged.
 * tests/private-merge*.test.ts.
 */
import { prCoordinates, privateCardRepo } from "./card-repo.js";
import { getTask } from "./ledger-store.js";
import { MERGE_NOT_SENT, requestSeqOf } from "./manual-merge-queue-facts.js";
import { bounceReceipt } from "./scheduler-merge-conflict.js";
import type { ForeignEscalate, Recheck } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";
import { projectRepoFor } from "./scheduler-foreign-repo.js";
import { privateMergeMode, privateMergePorts, privateMergeVerdict, recordPrivateMerge } from "./private-merge-gate.js";
import { isGhFail, privateGh, type GhFail, type PrivateCheck, type PrivateGh, type PrivatePr } from "./private-merge-gh.js";
import { narrowPrivateOnce, privateBounceChecks, privateMergeTurn } from "./private-merge-ledger.js";

type Step = (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;

const PRIVATE_WAIT_LIMIT_MS = 2 * 3_600_000;
const PRIVATE_GH_FAIL_LIMIT = 3;
const NO_CI_REASON = "私仓没有可核的 CI";
const SHA = /^[a-f0-9]{40}$/i;
const short = (s: string) => s.slice(0, 12);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const red = (c: PrivateCheck) => c.bucket === "fail" || c.bucket === "cancel";

/** Passes in a row that met a gh failure, per run and head; a pass that ends otherwise (wait, bounce, merged, PM) clears it. In memory: a restart only gives a few more retries. */
const ghFails = new Map<string, { head: string; n: number }>();
export function resetPrivateMergeForTest(): void { ghFails.clear(); }

/** red: the failed names and the verified required list they belong to (protection's, or every check seen when none is readable). */
type CiVerdict = { go: string[] } | { wait: string } | { red: string[]; verified: string[] } | { pm: string };
/** Required checks when main's protection names them; else every check finished green and at least one passed. */
function privateCi(required: readonly string[] | null, checks: readonly PrivateCheck[]): CiVerdict {
  if (required) {
    const failed = required.filter((n) => checks.some((c) => c.name === n && red(c)));
    if (failed.length) return { red: failed, verified: [...required] };
    const open = required.filter((n) => !checks.some((c) => c.name === n) || checks.some((c) => c.name === n && c.bucket !== "pass"));
    return open.length ? { wait: `必过检查未完成：${open.join("、").slice(0, 200)}` } : { go: [...required] };
  }
  if (!checks.length) return { pm: NO_CI_REASON };
  const failed = [...new Set(checks.filter(red).map((c) => c.name))];
  if (failed.length) return { red: failed, verified: [...new Set(checks.map((c) => c.name))] };
  if (checks.some((c) => c.bucket === "pending")) return { wait: "checks 还在跑" };
  const passed = [...new Set(checks.filter((c) => c.bucket === "pass").map((c) => c.name))];
  return passed.length ? { go: passed } : { pm: NO_CI_REASON };
}

interface Ctx {
  run: MergeRun; step: Step; assertActive: () => void; recheck: Recheck; foreign: ForeignEscalate;
  repo: string; head: string; gh: PrivateGh;
}

const note = (c: Ctx, key: string, action: string, data: Record<string, unknown> = {}) =>
  recordPrivateMerge(c.run.project, c.run.taskId, `${c.head}:${key}`, action, { head: c.head, repo: c.repo, intentId: c.run.intentId, outcome: key, ...data });

/** To PM through the driver's own foreign_repo hand-over; nothing merged, so the ledger cancels the run without a freeze. */
async function toPm(c: Ctx, why: string): Promise<MergeRun> {
  note(c, "pm", `交 PM：${why}`);
  ghFails.delete(c.run.intentId);
  const reason = `foreign_repo：卡在 ${c.repo}，私仓自动合并停下：${why}；由 PM 核对后按该仓库流程处理`;
  await c.foreign(c.run, reason);
  return c.step("unknown", `${MERGE_NOT_SENT}：${reason}`);
}

async function ghFailed(c: Ctx, f: GhFail): Promise<MergeRun> {
  const prev = ghFails.get(c.run.intentId), n = prev && same(prev.head, c.head) ? prev.n + 1 : 1;
  ghFails.set(c.run.intentId, { head: c.head, n });
  note(c, `gh-fail-${n}`, `gh 出错（${f.fail}），第 ${n} 次，下轮重试`);
  return n >= PRIVATE_GH_FAIL_LIMIT ? toPm(c, `gh 连续 ${n} 次出错：${f.fail}`) : c.run;
}

/** Waiting is bounded per head from its first wait note: past the limit it goes to PM once. */
async function waitOr(c: Ctx, why: string): Promise<MergeRun> {
  ghFails.delete(c.run.intentId);
  const since = note(c, "wait", `等待：${why}`);
  if (since !== null && privateMergePorts().now() - since >= PRIVATE_WAIT_LIMIT_MS) {
    return toPm(c, `等了 ${PRIVATE_WAIT_LIMIT_MS / 3_600_000} 小时仍未就绪：${why}`);
  }
  return c.run;
}

/** ready → await_ci (the ledger's only way to merging), carrying what this pass saw. */
const toAwaitCi = async (c: Ctx, receipt: string) => c.run.phase === "ready" ? (c.run = await c.step("await_ci", receipt)) : c.run;

async function recordMerged(c: Ctx, sha: string, receipt: string, byPm: boolean): Promise<MergeRun> {
  if (c.run.phase !== "merging") {
    await toAwaitCi(c, `私仓 PR ${short(c.head)} 已合并，核实合并提交`);
    c.run = await c.step("merging", `私仓 PR 已由 PM 手动合并 ${short(sha)}，不发 gh pr merge，按已合并记账`);
  }
  ghFails.delete(c.run.intentId);
  note(c, byPm ? "merged-by-pm" : "merged", byPm ? `PM 已手动合并 ${short(sha)}，按已合并记账` : `已自动合并 ${short(sha)}（match-head ${short(c.head)}）`, { mergeSha: sha });
  return c.step("merged", receipt, sha);
}

/** The bounce receipt the ledger re-parses; a red CI first carries the private repository's verified names into the run's list. */
async function bounce(c: Ctx, cause: "conflict" | "ci_fail", failed: string[] = [], verified: string[] = []): Promise<MergeRun> {
  if (cause === "ci_fail") {
    const db = privateMergePorts().ledger();
    // over 20 checks seen without protection: only the failed ones are carried (each is a verified required check either way)
    const undo = db && (privateBounceChecks(db, c.run, verified, c) ?? privateBounceChecks(db, c.run, failed, c));
    if (!undo) return toPm(c, `私仓必过检查失败（${failed.join("、").slice(0, 200)}），检查名无法记入合并退回`);
    ghFails.delete(c.run.intentId);
    note(c, "bounce-ci", `必过检查失败，退回 fix：${failed.join("、").slice(0, 200)}`);
    try {
      return await c.step("resolved", bounceReceipt({ cause, prHead: c.head, mainHead: null, checks: failed.map((name) => ({ name, link: "" })) }));
    } catch (e) {
      undo();
      throw e;
    }
  }
  const main = await c.gh.mainHead();
  if (isGhFail(main)) return ghFailed(c, main);
  ghFails.delete(c.run.intentId);
  note(c, "bounce-conflict", `和 main ${short(main)} 冲突，退回 fix`);
  return c.step("resolved", bounceReceipt({ cause, prHead: c.head, mainHead: main, checks: [] }));
}

/** Claimed (or found) merging: the recheck, the head-pinned merge, and a read back that alone can say merged. */
async function send(c: Ctx, checks: string[]): Promise<MergeRun> {
  if (c.run.phase !== "merging") c.run = await c.step("merging", `私仓 CI 全绿：${checks.join(", ")}`.slice(0, 300));
  c.assertActive();
  const drift = c.recheck({ ...c.run, beforeSend: true });
  if (drift) return c.step("unknown", `${MERGE_NOT_SENT}：${drift}`);
  const sent = await c.gh.merge(c.run.reviewedHead);
  c.assertActive();
  const after = await c.gh.pr();
  if (!isGhFail(after) && after.state === "MERGED" && same(after.head, c.head) && after.base === "main" && after.mergeSha) {
    return recordMerged(c, after.mergeSha, `私仓 PR 已合并 ${short(after.mergeSha)}（match-head ${short(c.head)}），不走本项目自动部署`, false);
  }
  return ghFailed(c, isGhFail(sent) ? sent : isGhFail(after) ? after : { fail: "gh pr merge 后 PR 未显示已合并" });
}

async function openPr(c: Ctx, pr: PrivatePr): Promise<MergeRun> {
  if (pr.draft) return waitOr(c, "PR 是 draft");
  if (pr.mergeable === "CONFLICTING") return c.run.phase === "merging" ? toPm(c, "合并发出后 PR 与 main 冲突") : bounce(c, "conflict");
  const required = await c.gh.required();
  if (isGhFail(required)) return ghFailed(c, required);
  const checks = await c.gh.checks();
  if (isGhFail(checks)) return ghFailed(c, checks);
  const ci = privateCi(required, checks);
  if ("pm" in ci) return toPm(c, ci.pm);
  if ("red" in ci) return c.run.phase === "merging" ? toPm(c, `合并发出后必过检查失败：${ci.red.join("、").slice(0, 200)}`) : bounce(c, "ci_fail", ci.red, ci.verified);
  if ("wait" in ci) return waitOr(c, ci.wait);
  if (pr.mergeable !== "MERGEABLE") return waitOr(c, "GitHub 还没算出能否合并");
  await toAwaitCi(c, `私仓 PR ${short(c.head)} 可合并，CI 全绿（${required ? "分支保护的必过检查" : "全部 check"}）`);
  return send(c, ci.go);
}

async function drive(c: Ctx): Promise<MergeRun> {
  const pr = await c.gh.pr();
  if (isGhFail(pr)) return ghFailed(c, pr);
  if (pr.state === "MERGED") {
    if (pr.mergeSha && same(pr.head, c.head) && pr.base === "main") {
      return recordMerged(c, pr.mergeSha, `私仓 PR 已合并 ${short(pr.mergeSha)}，不走本项目自动部署`, c.run.phase !== "merging");
    }
    return toPm(c, pr.mergeSha && same(pr.head, c.head) ? "PR 合并进的不是 main" : "PR 已合并，但合并的不是审查通过的 head");
  }
  if (pr.state === "CLOSED") return toPm(c, "PR 已关闭");
  if (pr.base !== "main") return toPm(c, "PR 的 base 不是 main");
  if (!same(pr.head, c.head)) {
    if (c.run.phase === "merging") return toPm(c, "合并发出后 PR head 变了");
    note(c, "review", `PR head 变成 ${short(pr.head)}，旧审查失效，回审`, { newHead: pr.head });
    return c.step("await_review", `私仓 PR 作者推了新 head：原 head ${c.head} → 新 head ${pr.head}，旧审查失效`, undefined, pr.head);
  }
  return openPr(c, pr);
}

/** The driver's call; null = not this path (the old driver path runs). */
export async function privateMergeDrive(run: MergeRun, step: Step, assertActive: () => void, recheck: Recheck,
  foreign?: ForeignEscalate): Promise<MergeRun | null> {
  if (!foreign || requestSeqOf(run.intentId) !== null || !["ready", "await_ci", "merging"].includes(run.phase)) return null;
  const coords = prCoordinates(run.prRef), repo = coords?.repo.toLowerCase(), own = projectRepoFor(run.project)?.toLowerCase();
  if (!coords || !repo || !own || own === repo || !SHA.test(run.reviewedHead)) return null;
  const mode = privateMergeMode(run.project);
  if (mode === "off") return null;
  const ports = privateMergePorts(), db = ports.ledger(), task = db && getTask(db, run.taskId);
  if (!db || !task || privateCardRepo(task)?.toLowerCase() !== repo) return null;
  const v = privateMergeVerdict(task), head = run.reviewedHead;
  if (!v) return null;
  if (mode === "observe") {
    recordPrivateMerge(run.project, run.taskId, `h-${head}`, "refused" in v ? `不能自动合并：${v.refused}` : "自动合并", { head, repo, mode });
    return null;
  }
  if ("refused" in v) {
    recordPrivateMerge(run.project, run.taskId, `${head}:pm`, `交 PM：${v.refused}`, { head, repo, intentId: run.intentId, outcome: "pm" });
    return null;
  }
  const c: Ctx = { run, step, assertActive, recheck, foreign, repo, head, gh: privateGh(ports.command, v.dir, repo, coords.pr) };
  const turn = privateMergeTurn(db, repo);
  if (turn && turn.intentId !== run.intentId) {
    note(c, "wait-serial", `同仓 ${turn.taskId} 正在合并，等它结束`, { other: turn.taskId });
    return run;
  }
  if (run.phase === "ready") await narrowPrivateOnce(db, task, v.dir, assertActive);
  assertActive();
  return drive(c);
}
