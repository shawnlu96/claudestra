/**
 * The two ledger-internal effects of an auto card: a template stage move and the owner's UI screenshot ask. Both run
 * only under the scheduler identity and re-plan inside their own write transaction: the planner, run now as if this
 * intent did not exist, must emit exactly this intent again. A card that moved, a replaced verdict or a changed head
 * makes the intent stale, and it is refused rather than applied. The intent is settled in the same transaction.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { bindHash } from "./ask-bind.js";
import { getAsk, openAskFull, type Ask } from "./ledger-asks.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerTask, Stage } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { applyMove } from "./ledger-write.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { planScheduler, type PlannerDecision } from "./scheduler-plan.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";
import { UI_ASK_ACTION } from "./scheduler-ui-gate.js";
import { convergeFollowUp } from "./review-converge-followup.js";

const UI_APPROVE = "scheduler_ui_approve";
/** Moves the engine may make itself; build/fix→review is the worker's deliver, merge→live is the merge queue's. */
const ENGINE_MOVES: ReadonlySet<string> = new Set(["restate>build", "review>fix", "review>merge"]);

type Planned = Extract<PlannerDecision, { kind: "intent" }>;

function claimable(db: Database, ctx: WriteCtx, id: string, action: SchedulerIntent["action"]): SchedulerIntent | "done" {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "只有调度服务身份能执行调度意图");
  const intent = getIntent(db, id);
  if (!intent || intent.action !== action) throw new LedgerError("not_found", `没有这个 ${action} 调度意图`);
  if (intent.status === "done" && getEventByDedup(db, `scheduler:${id}:done`)) return "done";
  if (intent.status !== "pending") throw new LedgerError("conflict", `调度意图当前是 ${intent.status}，不能执行`);
  return intent;
}

function replanned(db: Database, intent: SchedulerIntent, opts: SnapshotOpts): { task: LedgerTask; plan: Planned } {
  const task = mustTask(db, intent.taskId);
  const workflow = getWorkflow(db, task.id);
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev) throw new LedgerError("conflict", "任务已不在当前规格的自动流程");
  if (task.rev !== intent.taskRev || task.specRev !== intent.specRev || task.headSHA !== intent.head) {
    throw new LedgerError("conflict", "卡在意图之后被改过（rev / specRev / head），意图作废");
  }
  const plan = planScheduler(autoSnapshot(db, task, opts, intent.id));
  if (plan.kind !== "intent" || plan.id !== intent.id || plan.action !== intent.action || plan.node !== intent.node) {
    throw new LedgerError("conflict", "按当前台账重算的计划已不是这个意图");
  }
  return { task, plan };
}

function settleDone(db: Database, ctx: WriteCtx, id: string, receipt: string): void {
  settleIntent(db, ctx, { id, from: "pending", to: "submitted", receipt });
  settleIntent(db, ctx, { id, from: "submitted", to: "done", receipt });
}

export function applySchedulerStage(db: Database, ctx: WriteCtx, input: { intentId: string; to: Stage }, opts: SnapshotOpts): { task: LedgerTask; duplicate: boolean } {
  return tx(db, () => {
    const intent = claimable(db, ctx, input.intentId, "stage");
    if (intent === "done") return { task: mustTask(db, getIntent(db, input.intentId)!.taskId), duplicate: true };
    const { task, plan } = replanned(db, intent, opts);
    if (plan.targetStage !== input.to) throw new LedgerError("conflict", `计划的目标阶段是 ${plan.targetStage ?? "（无）"}，不是 ${input.to}`);
    if (!ENGINE_MOVES.has(`${task.stage}>${input.to}`)) throw new LedgerError("forbidden", `调度器不能推 ${task.stage}→${input.to}`);
    // Role only feeds the legality table here; the template allowlist and the re-plan above are the real gate.
    const why = plan.pmDiffNotice ? `${plan.reason}；留有 P2，PM 看 diff` : plan.reason;
    const moved = applyMove(db, ctx, task, { from: task.stage, to: input.to }, true, why, "pm");
    convergeFollowUp(db, ctx, moved.task, plan.downgrade); // 本轮降级：事件 + drafts 草稿 + 子 DAG 后续节点（review-converge-followup.ts）
    settleDone(db, ctx, intent.id, `stage ${task.stage}→${input.to}; event ${moved.event.seq}`);
    return { task: moved.task, duplicate: false };
  });
}

/** The before / after images the owner is asked to look at: at least two, each an existing file, or the ask is not opened. */
export function screenshotRefs(task: LedgerTask): { refs: string[] } | { missing: string } {
  const refs = Array.isArray(task.extra.screenshots) ? task.extra.screenshots.filter((s): s is string => typeof s === "string") : [];
  if (refs.length < 2) return { missing: `${task.id} 没有前后两张截图（extra.screenshots），不能请 owner 只看一串摘要` };
  const gone = refs.filter((r) => !existsSync(r));
  return gone.length ? { missing: `截图文件不在：${gone.slice(0, 3).join(", ")}` } : { refs: refs.slice(0, 6) };
}

/** The screenshot ask this intent opened, when it can no longer be answered (expired, withdrawn, superseded). */
export function deadUiAsk(db: Database, intentId: string, now: number): Ask | null {
  const row = db.query("SELECT id FROM asks WHERE dedupKey = ?").get(`scheduler:${intentId}:ui-ask`) as { id: string } | null;
  const ask = row && getAsk(db, row.id);
  return ask && ask.state !== "answered" && (ask.state !== "open" || ask.expiresAt <= now) ? ask : null;
}

function askText(task: LedgerTask, bind: NonNullable<Planned["askBind"]>, refs: string[]): { title: string; body: string } {
  return {
    title: `${task.id} 合并前请看前后截图`,
    body: [`审查已通过（head ${bind.head.slice(0, 12)}，规格第 ${bind.specRev} 版）。批准后调度器才把它送进合并队列。`,
      "截图：", ...refs.map((s) => `- ${s}`), `截图摘要：${bind.screenshotsDigest}`].join("\n"),
  };
}

export function openSchedulerUiAsk(db: Database, ctx: WriteCtx, input: { intentId: string }, opts: SnapshotOpts): { ask: Ask; duplicate: boolean } {
  return tx(db, () => {
    const intent = claimable(db, ctx, input.intentId, "ask");
    const dedupKey = `scheduler:${input.intentId}:ui-ask`;
    if (intent === "done") {
      const row = db.query("SELECT id FROM asks WHERE dedupKey = ?").get(dedupKey) as { id: string } | null;
      const ask = row && getAsk(db, row.id);
      if (!ask) throw new LedgerError("conflict", "意图已结但找不到它开的 ask");
      return { ask, duplicate: true };
    }
    const { task, plan } = replanned(db, intent, opts);
    if (!plan.askBind) throw new LedgerError("conflict", "计划里没有截图授权的绑定");
    const bind = { action: UI_ASK_ACTION, params: { ...plan.askBind }, approve: [UI_APPROVE] };
    const shots = screenshotRefs(task);
    if ("missing" in shots) throw new LedgerError("invalid", shots.missing);
    const text = askText(task, plan.askBind, shots.refs);
    const { ask } = openAskFull(db, {
      project: task.project, taskId: task.id, source: "system", kind: "authorize", fromAgent: "scheduler", createdBy: "system:scheduler",
      blocking: true, title: text.title, body: text.body, context: plan.reason, dedupKey, askKey: `${UI_ASK_ACTION}:${task.id}`,
      options: [{ type: "buttons", buttons: [{ id: UI_APPROVE, label: "批准合并", style: "success" }, { id: "scheduler_ui_reject", label: "不批准", style: "danger" }] }],
      bind: { ...bind, paramsHash: bindHash(bind, "scheduler") },
    }, ctx.now ?? Date.now());
    settleDone(db, ctx, intent.id, `ask:${ask.id}`);
    return { ask, duplicate: false };
  });
}
