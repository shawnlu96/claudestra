/** PM brake for code v3 auto cards: v3 releases build on the executor's own restate record, so the PM needs a way to stop that. */
import { getWorkflow } from "../lib/ledger-scheduler.js";
import type { LedgerTask } from "../lib/ledger-stages.js";
import { LedgerError } from "../lib/ledger-store.js";
import { tx } from "../lib/ledger-tx.js";
import { appendEvent } from "../lib/ledger-write.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Re-read inside the write transaction so a concurrent planIntent either lands first (and we refuse) or conflicts on our event. */
function v3Card(c: LedgerCli, what: string): LedgerTask {
  const task = c.task(c.p.pos[1]);
  c.requireRealPm(task.project, what);
  const workflow = getWorkflow(c.db, task.id);
  if (workflow?.mode !== "auto" || workflow.templateVersion !== 3) {
    throw new LedgerError("invalid", `${task.id} 不是 code v3 自动卡：v2 本来就等 restate-approve，人工卡不经调度器`);
  }
  if (!["spec", "restate", "build"].includes(task.stage)) throw new LedgerError("conflict", `${task.id} 已在 ${task.stage}，复述闸已过；要停请用 workflow-set --mode manual`);
  // Any live write order (pending included: the tick may be sending it right now) means the brake can no longer stop it.
  const order = c.db.query(`SELECT id, status FROM scheduler_intents WHERE taskId = ? AND node = 'write' AND action = 'dispatch'
    AND specRev = ? AND status != 'cancelled' LIMIT 1`).get(task.id, task.specRev) as { id: string; status: string } | null;
  if (order) throw new LedgerError("conflict", `开工单 ${order.id} 已${order.status === "pending" ? "在发出中" : "发出"}，拦不住了；要停请用 workflow-set --mode manual`);
  return task;
}

export const RESTATE_CMDS: Record<string, CommandSpec> = {
  "restate-hold": {
    valued: ["reason", "dedup"], bools: [],
    usage: "restate-hold <task> --reason <为什么拦>（PM 拦住 code v3 自动卡：开工单发出前都能拦，restate-release 放行）",
    run(c: LedgerCli) {
      const reason = c.need("reason");
      const r = tx(c.db, () => {
        const task = v3Card(c, "拦住复述");
        return appendEvent(c.db, c.ctx(), { project: task.project, target: task.id, kind: "decision", text: reason,
          data: { op: "restate_hold", specRev: task.specRev } });
      });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
  "restate-release": {
    valued: ["text", "dedup"], bools: [],
    usage: "restate-release <task> [--text <放行意见>]（解除 restate-hold；在 restate 阶段也可用 restate-approve）",
    run(c: LedgerCli) {
      const r = tx(c.db, () => {
        const task = v3Card(c, "放行复述");
        return appendEvent(c.db, c.ctx(), { project: task.project, target: task.id, kind: "decision", text: c.p.flags.text ?? "PM 放行复述",
          data: { op: "restate_released", specRev: task.specRev } });
      });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
};
