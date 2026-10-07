/**
 * MAINP2 formal PM main-carry transaction: a `merge` card whose head moved only by ≤16 pure-main merges (reviewMainCarryProof,
 * Git evidence only) keeps its real PASS after this module re-reads the PASS, its report, family / exemption / pool receipt,
 * UI / hold / journal / freeze and the task CAS, then (policy mainCarry=on) writes the head move + one `review_main_carry`
 * decision in one transaction. Never a review / submit / order / retire, never a scheduler event. tests/review-main-carry-manual*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { busyAsLedgerError, getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent, setTask } from "./ledger-write.js";
import { diagnoseManual } from "./manual-reason.js";
import { readReviewReport } from "./peer-pr-tick.js";
import { claimsPoolReview, poolReviewRefusal } from "./pool-review-proof.js";
import { mainCarryMode } from "./recovery-main-carry-policy.js";
import type { RecoveryPolicyPort } from "./recovery-policy.js";
import { reviewMainCarryProof, type MainCarryInput, type MainCarryProof } from "./review-main-carry-proof.js";
import { verdictKey } from "./review-verdict.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { mergeReviewProof } from "./scheduler-merge.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { exemptVerdict } from "./scheduler-review-swap.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

export const MAIN_CARRY_OP = "review_main_carry";
export const MAX_CARRY_HOPS = 16;
const SHA = /^[a-f0-9]{40}$/;
const PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/;
/** One key per (card, old head, new head): a replay or a concurrent twin finds it, a different carry never reuses it. */
export const mainCarryKey = (taskId: string, from: string, to: string): string => `main-carry:${taskId}:${from}:${to}`;

/** Where the PASS came from, read from the review event itself — never from a caller's claim. `lend` = a PM `lend-offer` pool order (MCRY1). */
type CarrySourceKind = "mcp" | "pool" | "lend" | "cli";
export interface ManualCarryRequest {
  taskId: string; oldHead: string; newHead: string; mainHead: string; specRev: number; round: number; reviewSeq: number; rev: number;
}
export interface CarryGate {
  task: LedgerTask; review: ReviewFacts; sourceKind: CarrySourceKind; base: string; carries: readonly LedgerEvent[]; repository: string; reportSha256: string | null;
}
type Proof = MainCarryProof | Readonly<{ ok: false; reason: string }>;
export type ProveCarry = (input: MainCarryInput) => Promise<Proof>;

const conflict = (why: string): never => { throw new LedgerError("conflict", `正式沿用审查拒绝：${why}`); };
const lower = (s: string) => s.toLowerCase();

/**
 * The formal PM carries that lead from the round's review head to the task's current head, oldest first, or null when one is
 * malformed. A carry counts only with its own key, the task-set head move by the same actor right before it (one transaction),
 * this round and spec revision, the review it names, and no delivery after that review.
 */
export function formalCarries(task: Pick<LedgerTask, "id" | "round" | "specRev" | "headSHA">, events: readonly LedgerEvent[]):
  { base: string | null; carries: LedgerEvent[] } | null {
  const carries: LedgerEvent[] = [];
  let at = task.headSHA;
  for (let i = events.length - 1; i >= 0 && at; i--) {
    const e = events[i]!;
    if (e.kind !== "decision" || e.data.op !== MAIN_CARRY_OP || e.data.to !== at) continue;
    const from = e.data.from, move = events[i - 1];
    if (typeof from !== "string" || !SHA.test(from) || e.dedupKey !== mainCarryKey(task.id, from, at) ||
      e.data.round !== task.round || e.data.specRev !== task.specRev || !move || move.seq !== e.seq - 1 || move.kind !== "task" ||
      move.actor !== e.actor || (move.data.patch as { headSHA?: unknown } | undefined)?.headSHA !== at) return null;
    if (carries.length >= MAX_CARRY_HOPS * 4) return null;
    carries.unshift(e);
    at = from;
  }
  if (!carries.length) return { base: at, carries };
  const review = events.findLast((e) => e.kind === "review" && e.data.round === task.round);
  if (!review || carries[0]!.data.sourceReviewSeq !== review.seq || carries[0]!.seq < review.seq ||
    carries.some((c) => c.data.sourceReviewSeq !== review.seq) || events.some((e) => e.kind === "deliver" && e.seq > review.seq)) return null;
  return { base: at, carries };
}

/** The current round's review as it covers the task head, through engine carries (currentReviewFacts) and formal PM carries. */
export function carriedReview(task: LedgerTask, events: readonly LedgerEvent[]):
  { kind: "facts"; facts: ReviewFacts; base: string; carries: readonly LedgerEvent[] } | { kind: "refused"; reason: string } {
  const chain = formalCarries(task, events);
  if (!chain || !chain.base) return { kind: "refused", reason: "正式沿用链不完整或与本轮审查对不上" };
  const read = currentReviewFacts({ ...task, headSHA: chain.base }, events);
  if (read.kind !== "facts") return { kind: "refused", reason: read.kind === "none" ? "本轮没有审查结论" : read.reason };
  return { kind: "facts", facts: read.facts, base: chain.base, carries: chain.carries };
}

function sourceKindOf(db: Database, task: LedgerTask, ev: LedgerEvent, facts: ReviewFacts, workflow: Pick<TaskWorkflow, "authorFamily">): CarrySourceKind {
  if (ev.data.lend !== undefined || claimsPoolReview({ reviewer: facts.reviewer, session: facts.reviewerSessionId })) {
    const pool = poolReviewRefusal(db, task, workflow, facts);
    if (!pool) return "pool";
    const pm = poolReviewRefusal(db, task, workflow, facts, { pmOffered: true }); // the same proof for a PM-offered order; neither passes for the other
    return pm ? conflict(`${pool}；按 PM 出借单核：${pm}`) : "lend";
  }
  const orderId = ev.data.orderId;
  if (ev.data.via === "mcp" && typeof orderId === "string" && ev.dedupKey === verdictKey({ orderId, head: facts.head }) && ev.actor === facts.reviewer) return "mcp";
  // A CLI row (no MCP ticket, no pool receipt) is only the reviewer's own record or a PM / master / owner transcription.
  if (ev.actor !== facts.reviewer && !isManager(db, ev.actor, task)) conflict(`来源审查 #${ev.seq} 既不是审查员本人记的也不是 PM 代记`);
  return "cli";
}

/**
 * The PASS's own report, read where reports live (ledger/reviews, peer-pr-tick.ts readReviewReport). A local PASS (MCP ticket or
 * CLI row) needs it readable and non-empty, and a CLI row's report must name the head it passed; the pool PASS is already bound
 * to its report bytes by its signed receipt (poolReviewRefusal); a PM lend order's report must also be on disk. Returns its sha256.
 */
function reportEvidence(facts: ReviewFacts, kind: CarrySourceKind): string | null {
  if (kind === "pool") return null;
  const r = readReviewReport(facts.reportPath);
  if ("error" in r) return conflict(`来源审查 #${facts.eventSeq} 的报告原件：${r.error}`);
  if (!r.text.trim()) conflict(`来源审查 #${facts.eventSeq} 的报告原件是空的`);
  if (kind === "cli" && !r.text.toLowerCase().includes(facts.head.slice(0, 12))) conflict(`来源审查 #${facts.eventSeq} 的报告没写它审的 head ${facts.head.slice(0, 12)}`);
  return createHash("sha256").update(r.text).digest("hex");
}

const ACTIVE_RUN = ["ready", "updating", "await_review", "await_ci", "merging", "unknown"];
function mergeJournalRefusal(db: Database, taskId: string): string | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return null;
  const rows = db.prepare("SELECT intentId, phase FROM scheduler_merges WHERE taskId = ?").all(taskId) as { intentId: string; phase: string }[];
  const open = rows.find((r) => ACTIVE_RUN.includes(r.phase));
  if (open) return open.phase === "unknown" ? `合并 journal ${open.intentId} 结果不明，先结清` : `引擎合并 ${open.intentId} 正在 ${open.phase}，沿用由引擎自己做`;
  const slot = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_resources'").get()
    ? db.prepare("SELECT resource FROM scheduler_resources WHERE taskId = ? AND resource LIKE 'merge:%'").get(taskId) as { resource: string } | null : null;
  return slot ? `本卡占着合并槽 ${slot.resource}（列车 / 引擎在用），不另走手动沿用` : null;
}

/**
 * Read-only: every fact the transaction needs, or a LedgerError. Run once before the proof (fast refusal) and again inside the
 * write transaction, so nothing that changed while git ran can slip through.
 */
export function manualCarryGate(db: Database, actor: string, req: ManualCarryRequest, now: number): CarryGate {
  if (actor === "scheduler") throw new LedgerError("forbidden", "调度引擎的沿用只走 scheduler-merge-step，不冒用 PM 正式入口");
  const task = mustTask(db, req.taskId);
  if (!actorMayConfigure(db, actor, task.project)) {
    throw new LedgerError("forbidden", `正式沿用审查要项目 ${task.project} 的 PM（调度助理除外）/ master / owner（你是 ${actor}）`);
  }
  for (const [k, v] of [["old", req.oldHead], ["new", req.newHead], ["main", req.mainHead]] as const) {
    if (typeof v !== "string" || !SHA.test(v)) throw new LedgerError("invalid", `--${k} 要是完整小写 40 位 SHA`);
  }
  if (![req.specRev, req.round, req.reviewSeq, req.rev].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new LedgerError("invalid", "specRev / round / review-seq / rev 要是非负整数");
  if (task.stage !== "merge") conflict(`任务在 ${task.stage}，不在 merge`);
  if (task.rev !== req.rev) conflict(`任务 rev 已是 ${task.rev}（你带的是 ${req.rev}）`);
  if (task.headSHA !== req.oldHead) conflict(`台账 head 是 ${task.headSHA?.slice(0, 12) ?? "空"}，不是原 head ${req.oldHead.slice(0, 12)}`);
  if (task.specRev !== req.specRev || task.round !== req.round) conflict(`规格 / 轮次已变（specRev ${task.specRev} round ${task.round}）`);
  return reviewGate(db, task, now, req.reviewSeq);
}

/**
 * The ledger side of every merge gate for the task as it stands (no request CAS): PR, workflow, freeze, engine journal / slot,
 * owner hold, the round's PASS through formal carries, auto review proof, family / exemption, source kind, report, UI.
 * manualCarryGate and the PM merge preflight (review-main-carry-manual-merge.ts) both end here.
 */
export function reviewGate(db: Database, task: LedgerTask, now: number, reviewSeq?: number): CarryGate {
  const repository = PR.exec(task.pr ?? "")?.[1];
  if (!repository) conflict("任务没有合法的 GitHub PR");
  const workflow = getWorkflow(db, task.id);
  if (workflow && workflow.specRev !== task.specRev) conflict("流程规格版本与任务不一致");
  if (getMeta(db, task.project).queueFrozen.frozen) conflict("项目合并队列已冻结");
  const journal = mergeJournalRefusal(db, task.id);
  if (journal) conflict(journal);
  const events = listEvents(db, { project: task.project, target: task.id });
  const hold = diagnoseManual({ task, events });
  if (hold?.code === "owner_hold") conflict("owner hold 中，要 owner 明确放行");
  const read = carriedReview(task, events);
  if (read.kind !== "facts") return conflict(read.reason);
  const { facts, base, carries } = read;
  if (reviewSeq !== undefined && facts.eventSeq !== reviewSeq) conflict(`本轮当前审查结论是 #${facts.eventSeq}，不是 #${reviewSeq}`);
  if (facts.verdict !== "pass") conflict(`来源审查结论是 ${facts.verdict}，不是 pass`);
  if (facts.findings.some((f) => f.severity === "P0" || f.severity === "P1")) conflict("来源审查仍有 P0/P1");
  const at = { ...task, headSHA: base }; // the head the PASS was written for: every review gate below reads it there
  const ev = events.find((e) => e.seq === facts.eventSeq)!;
  if (workflow?.mode === "auto") {
    try { mergeReviewProof(db, at, workflow); } catch (e) { conflict((e as Error).message); }
  }
  const author = remoteHeadFamily(db, at) ?? workflow?.authorFamily ?? null;
  if (!author) conflict("缺作者模型家族证据（旧手工卡不回填历史）");
  if (facts.reviewerFamily === author && !exemptVerdict(db, at, facts)) conflict("审查员与作者同家族且没有 owner 当前有效的豁免");
  const sourceKind = sourceKindOf(db, at, ev, facts, { authorFamily: author! });
  const reportSha256 = reportEvidence(facts, sourceKind);
  if (workflow?.template === "ui") {
    const ui = uiMergeRefusal(db, task, now);
    if (ui) conflict(`UI 截图验收：${ui}`);
  }
  return { task, review: facts, sourceKind, base, carries, repository: repository!, reportSha256 };
}

/** The proof must be exactly for this request: same heads, the caller's actual main, a complete bounded chain. */
function checkProof(req: ManualCarryRequest, proof: MainCarryProof): void {
  const chain = proof.chain;
  if (lower(proof.oldHead) !== req.oldHead || lower(proof.newHead) !== req.newHead || lower(proof.mainHead) !== req.mainHead) conflict("证明的 head / main 与请求不一致");
  if (!chain.length || chain.length > MAX_CARRY_HOPS || !/^[a-f0-9]{64}$/.test(proof.diffHash)) conflict("证明链为空、超长或缺净 diff 摘要");
  let at = req.oldHead;
  for (const hop of chain) {
    if (hop.previousHead !== at || !SHA.test(hop.head) || !SHA.test(hop.mainParent)) conflict("证明链不连续");
    at = hop.head;
  }
  if (at !== req.newHead) conflict("证明链没走到新 head");
}

export type CarryOutcome =
  | { status: "noop"; reason: string }
  | { status: "off"; reason: string }
  | { status: "refused"; reason: string }
  | { status: "observe"; plan: CarryPlan }
  | { status: "carried"; plan: CarryPlan; eventSeq: number; taskRev: number; duplicate: boolean };
interface CarryPlan {
  taskId: string; from: string; to: string; mainHead: string; mainParent: string; diffHash: string; hops: number;
  chain: { head: string; previousHead: string; mainParent: string }[]; sourceReviewSeq: number; sourceKind: CarrySourceKind;
  reportSha256: string | null; reviewer: string; reviewerFamily: string; round: number; specRev: number;
}

const planOf = (gate: CarryGate, proof: MainCarryProof): CarryPlan => ({
  taskId: gate.task.id, from: proof.oldHead, to: proof.newHead, mainHead: proof.mainHead, mainParent: proof.mainParent, diffHash: proof.diffHash,
  hops: proof.chain.length, chain: proof.chain.map((h) => ({ head: h.head, previousHead: h.previousHead, mainParent: h.mainParent })),
  sourceReviewSeq: gate.review.eventSeq, sourceKind: gate.sourceKind, reportSha256: gate.reportSha256, reviewer: gate.review.reviewer, reviewerFamily: gate.review.reviewerFamily,
  round: gate.task.round, specRev: gate.task.specRev,
});

const samePlan = (prev: LedgerEvent, plan: CarryPlan): boolean => (["from", "to", "mainHead", "diffHash", "sourceReviewSeq"] as const)
  .every((k) => prev.data[k] === plan[k]);

/** The same carry already written under its key (a replay, or the concurrent twin that won): report it, write nothing. */
function replayed(db: Database, req: ManualCarryRequest, diffHash?: string): Extract<CarryOutcome, { status: "carried" }> | null {
  const key = mainCarryKey(req.taskId, req.oldHead, req.newHead), prev = getEventByDedup(db, key);
  if (!prev) return null;
  if (prev.kind !== "decision" || prev.data.op !== MAIN_CARRY_OP || prev.target !== req.taskId || prev.data.mainHead !== req.mainHead ||
    prev.data.sourceReviewSeq !== req.reviewSeq || (diffHash !== undefined && prev.data.diffHash !== diffHash)) {
    throw new LedgerError("dedup_mismatch", `${key} 已被别的沿用用过`);
  }
  return { status: "carried", plan: prev.data.plan as CarryPlan, eventSeq: prev.seq, taskRev: mustTask(db, req.taskId).rev, duplicate: true };
}

/**
 * The write: one immediate transaction re-reads the policy and every gate fact, then moves the head through setTask (task CAS)
 * and appends the carry decision under its key. A replay of the same carry answers duplicate; anything changed writes nothing.
 */
export function applyManualCarry(db: Database, ctx: WriteCtx, req: ManualCarryRequest, proof: MainCarryProof,
  opts: { policy?: RecoveryPolicyPort } = {}): Extract<CarryOutcome, { status: "carried" }> {
  const now = ctx.now ?? Date.now(), key = mainCarryKey(req.taskId, req.oldHead, req.newHead);
  return busyAsLedgerError("写入", () => db.transaction(() => {
    const dup = replayed(db, req, proof.diffHash);
    if (dup) return dup;
    const mode = mainCarryMode(mustTask(db, req.taskId).project, opts.policy);
    if (mode.mode !== "on") conflict(`mainCarry 策略是 ${mode.mode}${mode.diagnostic ? `（${mode.diagnostic}）` : ""}，不写`);
    const gate = manualCarryGate(db, ctx.actor, req, now);
    checkProof(req, proof);
    const plan = planOf(gate, proof);
    const moved = setTask(db, { actor: ctx.actor, now }, { id: req.taskId, rev: req.rev, patch: { headSHA: req.newHead } });
    const ev = appendEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: gate.task.project, target: gate.task.id, kind: "decision",
      text: `PM 正式沿用审查：${req.oldHead.slice(0, 12)} → ${req.newHead.slice(0, 12)}（${plan.hops} 跳纯 main 合并，净 diff 一致，来源审查 #${plan.sourceReviewSeq}）`,
      data: { op: MAIN_CARRY_OP, carrySource: "pm", from: plan.from, to: plan.to, mainHead: plan.mainHead, mainParent: plan.mainParent,
        diffHash: plan.diffHash, sourceReviewSeq: plan.sourceReviewSeq, sourceKind: plan.sourceKind, reportSha256: plan.reportSha256, round: plan.round, specRev: plan.specRev,
        chain: plan.chain, plan } });
    if (ev.duplicate || !samePlan(ev.event, plan)) throw new LedgerError("dedup_mismatch", `${key} 已被别的沿用用过`);
    return { status: "carried" as const, plan, eventSeq: ev.event.seq, taskRev: moved.row.rev, duplicate: false };
  }).immediate());
}

/**
 * The whole formal entry: policy → gate → canonical multi-hop proof (local Git only; a thrown read is a refusal) → observe reports,
 * on writes. 0 hops (new = old) is reported, never a new carry.
 */
export async function runManualCarry(db: Database, ctx: WriteCtx, req: ManualCarryRequest,
  deps: { repoDir: string; prove?: ProveCarry; policy?: RecoveryPolicyPort }): Promise<CarryOutcome> {
  const now = ctx.now ?? Date.now();
  const project = mustTask(db, req.taskId).project;
  const dup = replayed(db, req);
  if (dup) return dup;
  const mode = mainCarryMode(project, deps.policy);
  if (mode.mode === "off") return { status: "off", reason: `mainCarry 策略是 off${mode.diagnostic ? `（${mode.diagnostic}）` : ""}，不沿用、不写` };
  const gate = manualCarryGate(db, ctx.actor, req, now);
  if (req.oldHead === req.newHead) return { status: "noop", reason: "新 head 就是审查过的 head，不新造沿用" };
  let proof: Proof;
  try {
    proof = await (deps.prove ?? reviewMainCarryProof)({ repoDir: deps.repoDir, repository: gate.repository, base: "main",
      mainHead: req.mainHead, oldHead: req.oldHead, newHead: req.newHead });
  } catch (e) {
    return { status: "refused", reason: `证明读取失败：${(e as Error).message.replace(/\s+/g, " ").slice(0, 300)}` };
  }
  if (!proof.ok) return { status: "refused", reason: proof.reason };
  checkProof(req, proof);
  if (mode.mode === "observe") return { status: "observe", plan: planOf(gate, proof) };
  return applyManualCarry(db, ctx, req, proof, { policy: deps.policy });
}
