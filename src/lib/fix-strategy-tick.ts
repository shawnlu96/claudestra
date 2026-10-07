/** Convergence effects enter the same leased CLI boundary as ordinary session/dispatch work. */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import { listEvents } from "./ledger-store.js";
import type { AutoTickDeps } from "./scheduler-auto-tick.js";
import { arbiterBinding, arbiterOrder } from "./review-arbiter-runtime.js";
type Notice = (db: Database, deps: AutoTickDeps, key: string, pending?: { task: LedgerTask; text: string }) => Promise<boolean>;

export async function driveConvergence(card: { db: Database; task: LedgerTask; deps: AutoTickDeps; opts: import("./scheduler-snapshot.js").SnapshotOpts },
  intent: SchedulerIntent, notice: Notice): Promise<{ taskId: string; step: string; detail: string } | null> {
  if (intent.action !== "fix_swap" && intent.action !== "arbitrate") return null;
  const out = (step: string, detail: string) => ({ taskId: card.task.id, step, detail });
  const result = await card.deps.manager("ledger", "scheduler-convergence", intent.id, "--max-workers", String(card.opts.maxWorkers));
  if (result.ok !== true && result.code === "too_large") {
    const text = `收敛单缩短后仍超限：specRev ${intent.specRev}，第 ${card.task.round} 轮；PM 核对后手工接续`;
    const rec = await card.deps.manager("ledger", "scheduler-plan-rejected", card.task.id, "--code", "too_large", "--text", text);
    if (rec.ok !== true) return out("held", `超限报警写入失败，下个 tick 重试：${String(rec.error)}`);
    const key = `${card.task.id}\ntoo_large\n${text}`;
    await notice(card.db, card.deps, key, rec.duplicate === true ? undefined
      : { task: card.task, text: `[调度引擎] ${card.task.id} ${text}。${String(result.error)}` });
  }
  if (result.ok !== true) return out("held", String(result.error));
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
