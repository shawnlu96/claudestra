/** PM brake for code v3 auto cards: v3 releases build on the executor's own restate record, so the PM needs a way to stop that. */
import { recordRestateBrake } from "../lib/ledger-scheduler-write.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function brake(c: LedgerCli, op: "restate_hold" | "restate_released", text: string, what: string) {
  const task = c.task(c.p.pos[1]);
  c.requireRealPm(task.project, what);
  return { ok: true, ...recordRestateBrake(c.db, c.ctx(), { taskId: task.id, op, text }) };
}

export const RESTATE_CMDS: Record<string, CommandSpec> = {
  "restate-hold": {
    valued: ["reason"], bools: [],
    usage: "restate-hold <task> --reason <为什么拦>（PM 拦住 code v3 自动卡：开工单发出前都能拦，restate-release 放行）",
    run: (c) => brake(c, "restate_hold", c.need("reason"), "拦住复述"),
  },
  "restate-release": {
    valued: ["text"], bools: [],
    usage: "restate-release <task> [--text <放行意见>]（解除 restate-hold；在 restate 阶段也可用 restate-approve）",
    run: (c) => brake(c, "restate_released", c.p.flags.text ?? "PM 放行复述", "放行复述"),
  },
};
