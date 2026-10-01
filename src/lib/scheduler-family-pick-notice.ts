/** A locally disabled review stays automatic while its cross-family capacity notice is delivered once per round/head. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PlannerDecision } from "./scheduler-plan.js";

interface NoticeDeps { notifyPm(task: LedgerTask, text: string): Promise<void>; manager(...args: string[]): Promise<Record<string, unknown>> }
const noticeKey = (t: LedgerTask): string => `family-wait:${t.id}:s${t.specRev}:r${t.round}:${t.headSHA}`;

/** Structural CLI port keeps lib independent of manager; only the scheduler can record this narrow notice. */
interface NoticeCommand {
  db: Database; p: { pos: string[] }; ctx(): WriteCtx; need(flag: string): string; task(id: string | undefined): LedgerTask;
}

export const familyWaitCommand = {
  valued: ["rev", "text", "phase"], bools: [], usage: "scheduler-family-wait <task> --rev N --phase pending|sent --text <inform>",
  run(c: NoticeCommand): Record<string, unknown> {
    return c.db.transaction(() => {
      const ctx = c.ctx(), task = c.task(c.p.pos[1]), phase = c.need("phase"), text = c.need("text");
      if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "审查等待通知只由调度服务记账");
      if (phase !== "pending" && phase !== "sent") throw new LedgerError("invalid", "phase must be pending|sent");
      if (task.stage !== "review" || task.rev !== Number(c.need("rev")) || getWorkflow(c.db, task.id)?.mode !== "auto") {
        throw new LedgerError("conflict", "卡已不在这次自动审查等待状态");
      }
      if (!text.trim() || text.length > 4000) throw new LedgerError("invalid", "inform must contain 1..4000 characters");
      const key = noticeKey(task), pending = getEventByDedup(c.db, key);
      if (phase === "sent" && !pending) throw new LedgerError("conflict", "通知尚未记账");
      return { ok: true, ...appendEvent(c.db, { ...ctx, dedupKey: phase === "sent" ? `${key}:sent` : key }, {
        project: task.project, target: task.id, kind: "note", data: { op: `family_wait_${phase}`, kind: "inform" }, text: pending?.text ?? text,
      }) };
    }).immediate();
  },
};

export async function informFamilyWait(db: Database, task: LedgerTask, wait: Extract<PlannerDecision, { kind: "wait" }>,
  remote: RemotePolicy | undefined, deps: NoticeDeps): Promise<void> {
  if (task.stage !== "review" || wait.code !== "placement" || remote?.localPriority !== "off" || remote.mode === "off") return;
  const key = noticeKey(task);
  if (getEventByDedup(db, `${key}:sent`)) return;
  const text = getEventByDedup(db, key)?.text ?? `[调度引擎] ${task.id} 审查等待可用的跨家族 peer；本机审查已关闭，保持自动调度。${wait.reason}`;
  const mark = (phase: string) => deps.manager("ledger", "scheduler-family-wait", task.id, "--rev", String(task.rev), "--phase", phase, "--text", text);
  const pending = await mark("pending");
  if (pending.ok !== true) { console.error(`⚠️ [scheduler] 审查等待通知未记账，下轮重试：${String(pending.error)}`); return; }
  try {
    await deps.notifyPm(task, text);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] 跨家族审查等待通知失败，下轮重试：${(e as Error).message}`);
    return;
  }
  const sent = await mark("sent");
  if (sent.ok !== true) console.error(`⚠️ [scheduler] 审查等待通知已发送但标记未记账，下轮可能重发：${String(sent.error)}`);
}
