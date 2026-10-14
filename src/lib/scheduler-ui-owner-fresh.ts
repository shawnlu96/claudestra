/**
 * UIOWNCARRY2: before the scheduler opens an owner screenshot ask on an ownerVisual card it first brings the PR up to the current main,
 * so the owner's approval does not have to be re-shot at merge time. Pieces:
 * - fact (scheduler-snapshot.ts): for a review-stage ownerVisual UI card, whether the PR head contains the remote's current main
 *   (git ls-remote in the project's repoDir, missing objects fetched); unreadable = unknown, which asks as before.
 * - plan (scheduler-plan.ts reviewPass → ownerFreshStep): under `on` a behind head gets a `merge` intent at node OWNER_FRESH_NODE in
 *   place of the ask. The merge tick begins it through beginMergeRun (stage review, no owner approval yet: ownerFreshRefusal) and drives
 *   it with the merge driver's own update-branch and review_carry proof (carryReview: the same review_carry + merge_phase pair that
 *   scheduler-review.ts carriedHead already trusts, no second rule). The driver ends the run right before claimAndMerge (ownerFreshEnd):
 *   it never claims `merging`, never merges, and the card stays in review. Conflict / red CI end it through the CIF gate and the bounce
 *   receipt (ownerFreshClose), the card back to fix like a merge bounce; a moved head voids it (ownerFreshVoid), card untouched.
 * - after (ownerFreshClose done): UIOWNCARRY1's renderInputs on the head the screenshots were registered at vs the new head, one
 *   `ui_owner_fresh` record. Same → the next plan opens the ask on the new head with the card's digest; different or unreadable → escalate
 *   to PM to re-shoot on the new head, no ask.
 * Switch `uiOwnerAskFresh` (recovery-keys.ts): off = as before; observe = as off plus one observation per behind owner ask (opened in
 * scheduler-apply.ts openSchedulerUiAsk); on = all of the above. PM screenshot acceptance and non-ownerVisual cards are never touched.
 * tests/scheduler-ui-owner-fresh*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { canTransition, nextTaskState, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { gitIn, type GitRead } from "./scheduler-ui-carry-proof.js";
import { ownerVisualOf } from "./scheduler-ui-merge-refusal.js";
import { renderInputs } from "./scheduler-ui-review-carry.js";
import { bounceReceipt, cancelMergeRun, manualCancel, MAX_MERGE_BOUNCES, parseBounceReceipt } from "./scheduler-merge-conflict.js";
import { ciBehindClaim } from "./scheduler-merge-ci-behind.js";
import { ciCancelGate } from "./scheduler-merge-ci-cancel.js";
import { gateReceipt } from "./scheduler-merge-ci-receipt.js";
import type { MergeRun } from "./scheduler-merge.js";
import { MANUAL_MERGE_NODE } from "./manual-merge-queue-facts.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";

/** ledger-tx insertEvent, handed in by scheduler-merge.ts (only write modules import ledger-tx; tests/ledger-migrate.test.ts). */
export type WriteEvent = Parameters<typeof ciBehindClaim>[6];
const KEY = "uiOwnerAskFresh";
/** The plan node of a "bring the PR up to main, do not merge" run; part of its intent key (`…:ui_owner_fresh:a<n>`). */
export const OWNER_FRESH_NODE = "ui_owner_fresh";
const FRESH_OP = "ui_owner_fresh";
const MAIN_REF = "refs/remotes/origin/main";
/** The driver's receipt for a finished run (scheduler-merge-driver.ts claimAndMerge, before any claim). */
export const OWNER_FRESH_DONE = "只追 main 完成：PR 已含 main 且 CI 全绿，不合并，回 review 发 owner 截图 ask";
const OWNER_FRESH_RESHOOT = "main 改了界面输入，要在新 head 重拍截图";
/** Chases per review entry; past this (main keeps moving) the ask goes out as before. */
const MAX_CHASES = 2;
const SHA = /^[a-f0-9]{40}$/;
const short = (s: string | null | undefined) => (s ?? "").slice(0, 12);

/** Read every time; an unreadable file / unknown key / throwing port is off. */
export function uiOwnerAskFreshMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { const p = policy(project, KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
}

/** The driver only sees the run: its intent key names the node. */
const isOwnerFreshRun = (intentId: string): boolean => new RegExp(`:${OWNER_FRESH_NODE}:a\\d+$`).test(intentId);
const freshIntent = (db: Database, intentId: string): boolean => getIntent(db, intentId)?.node === OWNER_FRESH_NODE;
/** The stage a merge run's card must be in: review for a fresh run, merge otherwise (beginMergeRun / mergeRunDrift / carryReview). */
export const runStage = (db: Database, intentId: string): "review" | "merge" => freshIntent(db, intentId) ? "review" : "merge";

// ---- fact ---------------------------------------------------------------------------------------------------------------------

/** contains: the head has main as an ancestor; null = could not tell (no repoDir, git failed, objects missing). */
export interface OwnerFreshFact { mode: RecoveryMode; contains: boolean | null; mainHead: string | null }
export interface OwnerFreshSnapshot { ownerFresh?: OwnerFreshFact }
export type MainContains = (project: string, head: string) => { contains: boolean | null; mainHead: string | null };

/** How long one remote read of main serves (per repoDir): snapshots are taken many times a tick, the remote moves on a minutes scale. */
const REMOTE_TTL_MS = 20_000;
const remoteMain = new Map<string, { at: number; head: string | null }>();

/**
 * The current main, not whatever this machine fetched last: the remote's refs/heads/main (git ls-remote, cached REMOTE_TTL_MS), its
 * commit and the PR head fetched into the repoDir when missing (the same `+refs/heads/main:refs/remotes/origin/main` refspec the
 * merge driver's carryReview fetches), then ancestry. Any failure (network, rate limit, no repoDir, objects missing) is null.
 */
const remoteMainContains: MainContains = (project, head) => {
  let repo: string | undefined;
  try { repo = readSchedulerConfig().projects[project]?.repoDir; } catch { repo = undefined; }
  if (!repo) return { contains: null, mainHead: null };
  const git = (timeout: number, ...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const now = Date.now();
  let cached = remoteMain.get(repo);
  if (!cached || now - cached.at > REMOTE_TTL_MS) {
    const r = git(15_000, "ls-remote", "--quiet", "origin", "refs/heads/main");
    const sha = r.status === 0 ? r.stdout.split(/\s+/)[0]?.trim().toLowerCase() ?? "" : "";
    cached = { at: now, head: SHA.test(sha) ? sha : null };
    remoteMain.set(repo, cached);
  }
  const mainHead = cached.head;
  if (!mainHead) return { contains: null, mainHead: null };
  const has = (sha: string) => git(10_000, "cat-file", "-e", `${sha}^{commit}`).status === 0;
  const want = [...(has(mainHead) ? [] : [`+refs/heads/main:${MAIN_REF}`]), ...(has(head) ? [] : [head])];
  if (want.length && git(60_000, "fetch", "--no-tags", "--quiet", "origin", ...want).status !== 0) return { contains: null, mainHead };
  if (!has(mainHead) || !has(head)) return { contains: null, mainHead };
  const r = git(10_000, "merge-base", "--is-ancestor", mainHead, head);
  return { contains: r.status === 0 ? true : r.status === 1 ? false : null, mainHead };
};

/** Only for a review-stage ownerVisual UI card with a head, and only while the switch is not off. */
export function ownerFreshFact(task: LedgerTask, template: string | undefined, ownerVisual: boolean, deps: { policy?: RecoveryPolicyPort;
  contains?: MainContains } = {}): OwnerFreshFact | undefined {
  if (template !== "ui" || !ownerVisual || task.stage !== "review" || !task.headSHA || !SHA.test(task.headSHA)) return undefined;
  const mode = uiOwnerAskFreshMode(task.project, deps.policy);
  if (mode === "off") return undefined;
  try { return { mode, ...(deps.contains ?? remoteMainContains)(task.project, task.headSHA) }; }
  catch { return { mode, contains: null, mainHead: null }; }
}

// ---- plan ---------------------------------------------------------------------------------------------------------------------

const own = (e: LedgerEvent, op: string): boolean => e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === op;
/**
 * The trusted record ownerFreshClose wrote for the run that ended on `head`, while it still speaks for the card's current screenshot
 * evidence: same digest, specRev and round, and no delivery registered screenshots after it (a re-shoot on the new head voids it).
 */
function freshRecord(task: LedgerTask, events: readonly LedgerEvent[], head: string): LedgerEvent | undefined {
  const rec = events.findLast((e) => own(e, FRESH_OP) && e.data.to === head && typeof e.data.intentId === "string" && isOwnerFreshRun(e.data.intentId) &&
    e.dedupKey === `scheduler:${e.data.intentId}:ui-owner-fresh`);
  if (!rec || rec.data.digest !== (task.extra.screenshotsDigest ?? null) || rec.data.specRev !== task.specRev || rec.data.round !== task.round) return undefined;
  return events.some((e) => e.seq > rec.seq && e.kind === "deliver" && e.data.uiEvidence != null) ? undefined : rec;
}

type Make = (node: string, reason: string) => PlannerDecision;
/**
 * reviewPass's owner ask, under `on`: re-shoot (escalate) when the last fresh run on this head saw the render inputs change; a fresh
 * run (via `make`) when the head lacks main; null = open the ask as before (fresh, unknown, observe, tried already on this head).
 */
export function ownerFreshStep(s: PlannerSnapshot & OwnerFreshSnapshot, make: Make): PlannerDecision | null {
  const f = s.ownerFresh, head = s.task.headSHA;
  if (!f || f.mode !== "on" || !s.ownerVisual || s.workflow?.template !== "ui" || s.task.stage !== "review" || !head) return null;
  const rec = freshRecord(s.task, s.events, head);
  if (rec && rec.data.renderSame !== true) {
    const why = typeof rec.data.why === "string" ? `：${rec.data.why}` : "";
    return { kind: "escalate", code: "ui_owner_reshoot", reason: `${OWNER_FRESH_RESHOOT}（head ${short(head)}）${why}`.slice(0, 500) };
  }
  if (f.contains !== false || s.queueFrozen) return null; // a frozen queue refuses merge intents: ask as before, never blocked
  const merged = s.events.findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;
  const entered = s.events.findLast((e) => e.kind === "stage" && e.data.to === "review")?.seq ?? 0;
  const tried = s.intents.filter((i) => i.node === OWNER_FRESH_NODE && i.taskId === s.task.id);
  const live = tried.findLast((i) => ["pending", "submitted", "unknown"].includes(i.status));
  if (live) return live.status === "unknown" ? { kind: "wait", code: "unknown_effect", reason: `只追 main 结果不明：${live.reason}` }
    : { kind: "wait", code: "in_flight", reason: "等待只追 main 的运行" };
  // a cancelled one since the last merge stage would make the ledger refuse every later merge intent of this round: ask as before
  if (tried.some((i) => i.head === head || (i.status === "cancelled" && i.causalSeq >= merged)) ||
    tried.filter((i) => i.causalSeq >= entered).length >= MAX_CHASES) return null;
  return make(OWNER_FRESH_NODE, `只追 main：head ${short(head)} 不含 main ${short(f.mainHead)}，先更新分支再请 owner 看截图`);
}

/** openSchedulerUiAsk, inside its transaction: under observe, one observation for an owner ask going out on a head behind main. */
export function observeOwnerFresh(db: Database, s: PlannerSnapshot & OwnerFreshSnapshot, now: number): void {
  const f = s.ownerFresh, head = s.task.headSHA;
  if (f?.mode !== "observe" || f.contains !== false || !s.ownerVisual || !head) return;
  recordObserved(db, { project: s.task.project, mechanism: KEY, target: s.task.id, actionKey: `ui-owner-fresh:${head}:${f.mainHead ?? "-"}`,
    action: `先追 main 再发 owner 截图 ask（head ${short(head)} 不含 main ${short(f.mainHead)}）`,
    data: { task: s.task.id, head, mainHead: f.mainHead, plan: "先追 main" } }, now);
}

// ---- ledger: begin / drift / plan write -----------------------------------------------------------------------------------------

/** What lets a fresh run exist (plan write, beginMergeRun, mergeRunDrift); null = may. The review / slot / PR checks stay the caller's. */
export function ownerFreshRefusal(db: Database, task: LedgerTask): string | null {
  if (task.stage !== "review") return `只追 main 只在 review 阶段，卡在 ${task.stage}`;
  if (getWorkflow(db, task.id)?.template !== "ui" || !ownerVisualOf(db, task, listEvents(db, { project: task.project, target: task.id }))) {
    return "只追 main 只给要 owner 看截图的 ui 卡（ownerVisual）";
  }
  return uiOwnerAskFreshMode(task.project) === "on" ? null : `${KEY} 不是 on`;
}

/**
 * The second lock (PM 补 2), independent of the driver's stop: advanceMergeRun's `→ merging` claim is allowed only for a card in the
 * merge stage whose intent is a merge node (merge_deploy, or PM's manual_merge). A refusal throws before anything is claimed or sent.
 */
export function mergeClaimRefusal(db: Database, row: MergeRun): string | null {
  const node = getIntent(db, row.intentId)?.node, stage = mustTask(db, row.taskId).stage;
  return stage === "merge" && (node === "merge_deploy" || node === MANUAL_MERGE_NODE) ? null
    : `只有 merge 阶段 merge_deploy 节点的运行能合并（本运行节点 ${node ?? "（无）"}、卡在 ${stage}），不合并`;
}

/** advanceMergeRun's `→ unknown` for a fresh run: nothing was ever sent to merge, so the run ends as failed (one record), no freeze. */
export function ownerFreshFail(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, insertEvent: WriteEvent): void {
  const now = ctx.now ?? Date.now(), why = receipt.replace(/\s+/g, " ").slice(0, 450);
  endFresh(db, ctx, row, `failed: ${why}`, "cancelled", now);
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:resolved` }, {
    project: row.project, target: row.taskId, kind: "scheduler", text: `只追 main：失败结束，未合并、不冻结队列（${why}）`,
    data: { op: "merge_phase", intentId: row.intentId, from: row.phase, to: "resolved", outcome: "fresh_failed", receipt: why },
  }, true);
}

/** ledger-scheduler-write.ts requireReviewedMerge for an OWNER_FRESH_NODE merge intent (UIOWNCARRY2's one call there): this replaces only
 * its stage / node line and the screenshot gate; the current head's passing review below it (currentReviewFacts) is checked as for any. */
export function requireOwnerFresh(db: Database, task: LedgerTask): void {
  const no = ownerFreshRefusal(db, task);
  if (no) throw new LedgerError("invalid", no);
}

// ---- driver --------------------------------------------------------------------------------------------------------------------

/** scheduler-merge-driver.ts claimAndMerge: a fresh run that got this far is up to date with green CI; end it before any claim. */
export const ownerFreshEnd = (run: Pick<MergeRun, "intentId">): string | null => isOwnerFreshRun(run.intentId) ? OWNER_FRESH_DONE : null;

// ---- ledger: end ---------------------------------------------------------------------------------------------------------------

function endFresh(db: Database, ctx: WriteCtx, row: MergeRun, reason: string, to: "done" | "cancelled", now: number): void {
  db.prepare("UPDATE scheduler_merges SET phase='resolved', rev=rev+1, reason=?, unknownSince=NULL, updatedAt=? WHERE intentId=?").run(reason, now, row.intentId);
  if (getIntent(db, row.intentId)?.status === "submitted") settleIntent(db, { ...ctx, now }, { id: row.intentId, from: "submitted", to, receipt: reason.slice(0, 600) });
  db.prepare("DELETE FROM scheduler_resources WHERE intentId=?").run(row.intentId);
}

/** The head the card's current screenshots were registered at: the delivery that registered this digest. */
function shotHead(events: readonly LedgerEvent[], digest: unknown): string | null {
  const d = events.findLast((e) => e.kind === "deliver" && (e.data.uiEvidence as { digest?: unknown } | undefined)?.digest === digest);
  const h = (d?.data.uiEvidence as { head?: unknown } | undefined)?.head ?? d?.data.head;
  return typeof h === "string" && SHA.test(h) ? h : null;
}

export interface FreshDeps { read?: (project: string) => GitRead }
const repoRead = (project: string): GitRead => {
  const repo = readSchedulerConfig().projects[project]?.repoDir;
  if (!repo) throw new Error("调度配置里没有本项目的 repoDir");
  return gitIn(repo);
};

/** UIOWNCARRY1's render inputs (renderInputs) at the screenshots' head and the new head. Never throws. */
function renderCompare(task: LedgerTask, events: readonly LedgerEvent[], from: string, deps: FreshDeps) {
  const shot = shotHead(events, task.extra.screenshotsDigest) ?? from, head = task.headSHA as string;
  const globs = task.extra.fileGlobs ?? [];
  if (!Array.isArray(globs) || globs.some((g) => typeof g !== "string")) return { shot, renderSame: false, why: "卡上 fileGlobs 不是字符串列表" };
  try {
    const read = (deps.read ?? repoRead)(task.project);
    const a = renderInputs(read, shot, globs as string[]), b = shot === head ? a : renderInputs(read, head, globs as string[]);
    return { shot, renderSame: a.digest === b.digest, renderInputs: { shot: a.digest, head: b.digest, count: b.count },
      ...(a.digest === b.digest ? {} : { why: "web/、资源、依赖与构建配置或本卡 fileGlobs 有变" }) };
  } catch (e) { return { shot, renderSame: false, why: `渲染输入核不了（${(e as Error).message.split("\n")[0]!.slice(0, 160)}）` }; }
}

/**
 * advanceMergeRun's `→ resolved` for a fresh run, in its transaction. OWNER_FRESH_DONE: intent done, slot freed, card stays in review,
 * one `ui_owner_fresh` record. Otherwise the merge path's own CIF gate (re-run / behind claims) and bounce receipt: the card goes
 * review → fix carrying the bounce, counted with merge bounces; a PM's switch to manual cancels it.
 */
export function ownerFreshClose(db: Database, ctx: WriteCtx, row: MergeRun, rawReceipt: string | undefined, drift: string | null,
  insertEvent: WriteEvent, deps: FreshDeps = {}): void {
  const now = ctx.now ?? Date.now(), card = (): LedgerTask => mustTask(db, row.taskId);
  if (rawReceipt === OWNER_FRESH_DONE) {
    if (drift) throw new LedgerError("conflict", `只追 main 运行已失效：${drift}`);
    const t = card(), intent = getIntent(db, row.intentId) as SchedulerIntent;
    if (t.stage !== "review" || t.headSHA !== row.reviewedHead) throw new LedgerError("conflict", "只追 main 收尾时任务阶段或 head 已变");
    const events = listEvents(db, { project: t.project, target: t.id });
    const cmp = renderCompare(t, events, intent.head ?? row.reviewedHead, deps);
    endFresh(db, ctx, row, `fresh: ${OWNER_FRESH_DONE}`, "done", now);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:resolved` }, {
      project: row.project, target: row.taskId, kind: "scheduler", text: `只追 main：结束（${OWNER_FRESH_DONE}）`,
      data: { op: "merge_phase", intentId: row.intentId, from: row.phase, to: "resolved", outcome: "fresh", receipt: OWNER_FRESH_DONE },
    }, true);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:ui-owner-fresh` }, {
      project: row.project, target: row.taskId, kind: "scheduler",
      text: cmp.renderSame ? `只追 main 到 ${short(t.headSHA)}：渲染输入与截图时一致，发 owner 截图 ask` : `只追 main 到 ${short(t.headSHA)}：${OWNER_FRESH_RESHOOT}`,
      data: { op: FRESH_OP, intentId: row.intentId, from: intent.head, to: t.headSHA, specRev: t.specRev, round: t.round,
        digest: t.extra.screenshotsDigest ?? null, ...cmp },
    }, true);
    return;
  }
  const receipt = gateReceipt(rawReceipt);
  const gated = ciCancelGate(db, ctx, row, receipt, drift, (r) => ciBehindClaim(db, ctx, row, r, drift, bounceReceipt, insertEvent), cancelMergeRun);
  if (gated === null) return;
  const b = parseBounceReceipt(gated);
  if (!b) {
    if (!manualCancel(db, row)) throw new LedgerError("conflict", "只追 main 运行只能正常收尾、带冲突 / CI 失败回执退 fix，或在 PM 切手动后结束");
    return cancelMergeRun(db, ctx, row, gated);
  }
  if (drift) throw new LedgerError("conflict", `只追 main 运行已失效：${drift}`);
  const t = card();
  if (b.prHead.toLowerCase() !== row.reviewedHead.toLowerCase() || (b.cause === "conflict" && !SHA.test(b.mainHead ?? "")) ||
    (b.cause === "ci_fail" && b.checks.some((c) => !row.requiredChecks.split(",").includes(c.name)))) {
    throw new LedgerError("invalid", "退回 fix 的回执缺证据，或 head / 检查名与本次运行不符");
  }
  const count = (db.query(`SELECT COUNT(*) AS n FROM events WHERE target = ? AND kind = 'scheduler'
    AND json_extract(data, '$.op') = 'merge_conflict'`).get(row.taskId) as { n: number }).n + 1;
  const escalated = count > MAX_MERGE_BOUNCES;
  endFresh(db, ctx, row, `${b.cause}: ${gated}`, "cancelled", now);
  if (!escalated) {
    if (t.stage !== "review" || t.headSHA !== row.reviewedHead || !canTransition(t, "fix", "pm").ok) throw new LedgerError("conflict", "退回 fix 时任务阶段或 head 已变");
    const next = nextTaskState(t, "fix");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, t.id);
    insertEvent(db, { actor: ctx.actor, now }, { project: t.project, target: t.id, kind: "stage",
      text: b.cause === "conflict" ? "只追 main：PR 和 main 冲突，退回 fix 解冲突" : b.cause === "update_fail" ? "只追 main：更新分支失败，退回 fix 合入 main" : "只追 main：PR 头 CI 失败，退回 fix",
      data: { from: "review", to: "fix", round: next.round, specRev: next.specRev, head: t.headSHA, mergeBounce: b, ownerFresh: true } }, false);
  }
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:conflict` }, {
    project: row.project, target: row.taskId, kind: "scheduler",
    text: escalated ? `只追 main：第 ${count} 次退回，交 PM` : `只追 main：退回 fix（${b.cause}，第 ${count} 次）`,
    data: { op: "merge_conflict", intentId: row.intentId, from: row.phase, cause: b.cause, prHead: b.prHead, mainHead: b.mainHead,
      checks: b.checks, count, escalated, ownerFresh: true },
  }, true);
}

/** advanceMergeRun's `→ await_review` for a fresh run: the head moved by something other than a pure main merge. The card is left
 * as it is (review, its head); the intent is cancelled and the slot freed, so the next plan asks as before. */
export function ownerFreshVoid(db: Database, ctx: WriteCtx, row: MergeRun, now: number): void {
  if (getIntent(db, row.intentId)?.status === "submitted") {
    settleIntent(db, { ...ctx, now }, { id: row.intentId, from: "submitted", to: "cancelled", receipt: "只追 main：head 被别的提交改动，不沿用，照旧发 ask" });
  }
  db.prepare("DELETE FROM scheduler_resources WHERE intentId=?").run(row.intentId);
}
