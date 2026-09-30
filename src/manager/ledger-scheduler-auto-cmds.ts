/** Auto-mode CLI: PM releases a restate; the scheduler identity applies its only ledger-internal effects (stage move, screenshot ask). */
import { getWorkflow } from "../lib/ledger-scheduler.js";
import { STAGES, type Stage } from "../lib/ledger-stages.js";
import { LedgerError } from "../lib/ledger-store.js";
import { appendEvent } from "../lib/ledger-write.js";
import { applySchedulerStage, openSchedulerUiAsk } from "../lib/scheduler-apply.js";
import { intFlag } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** Auto snapshots read only ledger bindings, so the registry is not consulted; capacity comes from the service policy. */
function planOpts(c: LedgerCli) {
  const max = intFlag(c.p, "max-workers") ?? 2;
  if (max < 0 || max > 32) throw new LedgerError("invalid", "--max-workers 要在 0–32（0 = 本机不开 worker，i28-R9）");
  return { registry: [], maxWorkers: max, now: c.deps.now() };
}

export const SCHEDULER_AUTO_CMDS: Record<string, CommandSpec> = {
  "restate-approve": {
    valued: ["text", "dedup"], bools: [],
    usage: "restate-approve <task> [--text <放行意见>]（PM 放行自动卡的复述；调度器据此推 restate→build）",
    run(c) {
      const task = c.task(c.p.pos[1]);
      c.requireRealPm(task.project, "放行复述");
      if (getWorkflow(c.db, task.id)?.mode !== "auto") throw new LedgerError("invalid", `${task.id} 不是自动卡：人工卡照旧用 stage --from restate --to build`);
      if (task.stage !== "restate") throw new LedgerError("conflict", `${task.id} 当前在 ${task.stage}，不在 restate`);
      const r = appendEvent(c.db, c.ctx(), { project: task.project, target: task.id, kind: "decision", text: c.p.flags.text ?? "PM 放行复述",
        data: { op: "restate_approved", specRev: task.specRev, transcribed: c.deps.actor !== "owner" } });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
  "scheduler-stage": {
    valued: ["to", "max-workers"], bools: [],
    usage: "scheduler-stage <intent-key> --to build|fix|merge [--max-workers N]（调度服务专用：按模板推自动卡，事务内重算计划核对）",
    run(c) {
      const to = c.need("to");
      if (!STAGES.includes(to as Stage)) throw new LedgerError("invalid", `未知阶段 ${to}`);
      const r = applySchedulerStage(c.db, c.ctx(), { intentId: c.p.pos[1] ?? "", to: to as Stage }, planOpts(c));
      return { ok: true, ...r };
    },
  },
  "scheduler-ui-ask": {
    valued: ["max-workers"], bools: [],
    usage: "scheduler-ui-ask <intent-key> [--max-workers N]（调度服务专用：给 UI 卡开 owner 前后截图授权 ask）",
    run(c) {
      const r = openSchedulerUiAsk(c.db, c.ctx(), { intentId: c.p.pos[1] ?? "" }, planOpts(c));
      return { ok: true, askId: r.ask.id, duplicate: r.duplicate };
    },
  },
};
