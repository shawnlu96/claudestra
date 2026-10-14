/** Convergence effects enter the same leased CLI boundary as ordinary session/dispatch work. */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getIntent, type SchedulerIntent } from "./ledger-scheduler.js";
import { listEvents } from "./ledger-store.js";
import type { AutoTickDeps } from "./scheduler-auto-tick.js";
import { arbiterBinding, arbiterOrder } from "./review-arbiter-runtime.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { stallCleared, stallFacts, stallFailed, stallFromReceipt, stallKey, stallNotice, stallObserveNotice, stallReason, stallSettleReceipt,
  stallTold, uncounted, type StallFacts } from "./fix-strategy-stall.js";
type Notice = (db: Database, deps: AutoTickDeps, key: string, pending?: { task: LedgerTask; text: string; informed?: () => Promise<void> }) => Promise<boolean>;
type ConvCard = { db: Database; task: LedgerTask; deps: AutoTickDeps; opts: import("./scheduler-snapshot.js").SnapshotOpts };
type Outcome = { taskId: string; step: string; detail: string };

/**
 * convergenceStall: a convergence CLI failing past the fix-strategy-stall.ts thresholds goes to PM — on: unknown (if already
 * submitted), fallback-manual, one notice; observe: one notice and held; off: held as before. A refused write is retried next tick.
 */
async function stalled(card: ConvCard, intent: SchedulerIntent, result: Record<string, unknown>, notice: Notice): Promise<Outcome> {
  const out = (step: string, detail: string) => ({ taskId: card.task.id, step, detail });
  const mode = (card.deps.recoveryPolicy ?? recoveryPolicy)(card.task.project, "convergenceStall").mode;
  if (mode === "off" || uncounted(result.code)) return out("held", String(result.error));
  const key = stallKey(card.task.id, intent.id), now = card.deps.now(), stall = stallFailed(card.db, key, result.error, now);
  const current = getIntent(card.db, intent.id) ?? intent;
  if (!stall) return out("held", String(result.error));
  if (current.status !== "pending" && current.status !== "submitted") { stallCleared(card.db, key); return out("held", String(result.error)); }
  const f = stallFacts(card.task.id, intent, stall, now);
  if (mode !== "on") {
    if (!stall.told) { stallTold(card.db, key); await notice(card.db, card.deps, `${key}\nconvergence-stall`, { task: card.task, text: stallObserveNotice(f, current.status) }); }
    return out("held", String(result.error));
  }
  const unknown = current.status === "submitted";
  if (unknown && (await card.deps.manager("ledger", "scheduler-settle", intent.id, "--from", "submitted", "--to", "unknown",
    "--receipt", stallSettleReceipt(f))).ok !== true) return out("held", "收敛卡住：意图记 unknown 没写上，下个 tick 重试");
  return handBack(card, f, unknown, notice);
}

/** fallback-manual, then one notice; a refusal holds and the next tick retries (an unknown one through resumeStallFallback). */
async function handBack(card: ConvCard, f: StallFacts, unknown: boolean, notice: Notice): Promise<Outcome> {
  const out = (step: string, detail: string) => ({ taskId: card.task.id, step, detail });
  const fallback = await card.deps.manager("ledger", "scheduler-fallback-manual", card.task.id, "--reason", stallReason(f, unknown), "--intent", f.intentId);
  if (fallback.ok !== true) return out("held", `收敛卡住，退回人工没写上（下个 tick 重试）：${String(fallback.error)}`);
  const key = stallKey(card.task.id, f.intentId);
  stallCleared(card.db, key);
  if (fallback.duplicate !== true) await notice(card.db, card.deps, `${key}\nconvergence-stall`, { task: card.task, text: stallNotice(f, unknown) });
  return out("manual", stallReason(f, unknown));
}

/**
 * Card.step calls this before its unknown gate: an intent this mechanism already recorded unknown (its receipt mark) whose
 * fallback was refused would otherwise sit there forever. Only the fallback is retried — never the convergence itself; any
 * other unknown intent (null here) stays with PM. tests/fix-strategy-stall.test.ts.
 */
export async function resumeStallFallback(card: ConvCard, open: SchedulerIntent | null, notice: Notice): Promise<Outcome | null> {
  if (open?.status !== "unknown" || (open.action !== "fix_swap" && open.action !== "arbitrate")) return null;
  if ((card.deps.recoveryPolicy ?? recoveryPolicy)(card.task.project, "convergenceStall").mode !== "on") return null;
  const f = stallFromReceipt(card.task.id, open);
  return f && handBack(card, f, true, notice);
}

export async function driveConvergence(card: ConvCard, intent: SchedulerIntent, notice: Notice): Promise<Outcome | null> {
  if (intent.action !== "fix_swap" && intent.action !== "arbitrate") return null;
  const out = (step: string, detail: string) => ({ taskId: card.task.id, step, detail });
  const result = await card.deps.manager("ledger", "scheduler-convergence", intent.id, "--max-workers", String(card.opts.maxWorkers));
  if (result.ok !== true && result.code === "too_large") {
    const text = `收敛单缩短后仍超限：specRev ${intent.specRev}，第 ${card.task.round} 轮；PM 核对后手工接续`;
    const args = ["ledger", "scheduler-plan-rejected", card.task.id, "--code", "too_large", "--text", text];
    const rec = await card.deps.manager(...args);
    if (rec.ok !== true) return out("held", `超限报警写入失败，下个 tick 重试：${String(rec.error)}`);
    // Delivery and receipt are separate: a crash between them may resend; without a receipt, restart must retry.
    if (rec.informed !== true) await notice(card.db, card.deps, `${card.task.id}\ntoo_large\n${text}`,
      { task: card.task, text: `[调度引擎] ${card.task.id} ${text}。${String(result.error)}`,
        informed: async () => { if ((await card.deps.manager(...args, "--informed")).ok !== true) throw new Error("超限通知回执写入失败，下个 tick 重试"); } });
  }
  if (result.ok !== true) return stalled(card, intent, result, notice);
  stallCleared(card.db, stallKey(card.task.id, intent.id));
  if (intent.action === "fix_swap" || result.step !== "ready") return out(String(result.step), String(result.detail));
  const last = listEvents(card.db, { project: card.task.project, target: card.task.id }).findLast((e) => e.data.op === "arbiter_delivery" && e.data.intentId === intent.id);
  if (last?.data.phase === "sent") return out("waiting", "独立仲裁单已发，等待有约束力的结论");
  if (last?.data.phase === "sending") {
    await card.deps.manager("ledger", "scheduler-settle", intent.id, "--from", "submitted", "--to", "unknown", "--receipt", "仲裁发送已认领但无回执，不重复投递");
    return out("held", "仲裁发送结果不明，不重复投递");
  }
  const ref = arbiterBinding(card.db, intent.id);
  if (!ref) return out("held", "仲裁会话绑定未落盘");
  const worker = card.deps.worker(ref);
  if ("manual" in worker) return out("held", worker.manual);
  const claimed = await card.deps.manager("ledger", "scheduler-arbiter-delivery", intent.id, "--phase", "sending");
  if (claimed.ok !== true) return out("held", "仲裁投递认领失败");
  const receipt = await worker.submit(ref, intent.id, arbiterOrder(card.db, intent.id));
  if (receipt.status === "unknown") {
    await card.deps.manager("ledger", "scheduler-settle", intent.id, "--from", "submitted", "--to", "unknown", "--receipt", receipt.reason);
    return out("held", receipt.reason);
  }
  if (receipt.status === "rejected") {
    await card.deps.manager("ledger", "scheduler-arbiter-delivery", intent.id, "--phase", "rejected");
    return out("waiting", receipt.reason);
  }
  const marked = await card.deps.manager("ledger", "scheduler-arbiter-delivery", intent.id, "--phase", "sent");
  if (marked.ok !== true) {
    await card.deps.manager("ledger", "scheduler-settle", intent.id, "--from", "submitted", "--to", "unknown", "--receipt", "仲裁投递已收下，但送达事件没记上");
    return out("held", "仲裁已发但回执未记录，不重复派单");
  }
  return out("sent", "已派独立跨模型新会话仲裁");
}
