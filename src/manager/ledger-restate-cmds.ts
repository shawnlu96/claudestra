/** PM brake for code v3 auto cards: v3 releases build on the executor's own restate record, so the PM needs a way to stop that. */
import { getWorkflow } from "../lib/ledger-scheduler.js";
import { LedgerError } from "../lib/ledger-store.js";
import { appendEvent } from "../lib/ledger-write.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export const RESTATE_CMDS: Record<string, CommandSpec> = {
  "restate-hold": {
    valued: ["reason", "dedup"], bools: [],
    usage: "restate-hold <task> --reason <为什么拦>（PM 拦住 code v3 自动卡：复述后不自动开工，restate-approve 放行）",
    run(c: LedgerCli) {
      const task = c.task(c.p.pos[1]);
      c.requireRealPm(task.project, "拦住复述");
      const workflow = getWorkflow(c.db, task.id);
      if (workflow?.mode !== "auto" || workflow.templateVersion !== 3) {
        throw new LedgerError("invalid", `${task.id} 不是 code v3 自动卡：v2 本来就等 restate-approve，人工卡不经调度器`);
      }
      // After restate the scheduler may already have moved the card; a hold there would stop nothing, so refuse instead of pretending.
      if (task.stage !== "spec" && task.stage !== "restate") throw new LedgerError("conflict", `${task.id} 已在 ${task.stage}，复述闸已过；要停请用 workflow-set --mode manual`);
      const r = appendEvent(c.db, c.ctx(), { project: task.project, target: task.id, kind: "decision", text: c.need("reason"),
        data: { op: "restate_hold", specRev: task.specRev } });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
};
