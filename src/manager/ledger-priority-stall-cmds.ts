import { priorityStallCommand, type StallCommand } from "../lib/ledger-priority-stall-command.js";
import { setPriorityStallThreshold, priorityStallThreshold } from "../lib/ledger-priority-stall-store.js";
import { recordPriorityNow } from "../lib/scheduler-priority-now-record.js";
import { LedgerError } from "../lib/ledger-store.js";
import { readSchedulerConfig } from "../lib/scheduler-config.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const service = (c: LedgerCli) => ({ autoDispatch: c.deps.autoDispatch?.() === true, projects: c.deps.autoProjects?.() ?? [],
  maxWorkers: (p: string) => readSchedulerConfig().projects[p]?.maxActiveWorkers ?? 0 });

export const PRIORITY_STALL_CMDS: Record<string, CommandSpec> = {
  "scheduler-priority-stall": {
    valued: ["project", "data", "dedup", "rev"],
    usage: "scheduler-priority-stall <task|-> --project P --data JSON --dedup KEY --rev N（调度服务专用）",
    run(c) {
      c.deps.assertLease?.();
      return priorityStallCommand(c.db, c.ctx(), c.project(), c.p.pos[1] ?? "-", JSON.parse(c.need("data")) as StallCommand, service(c), Number(c.need("rev")), () => c.deps.assertLease?.());
    },
  },
  "scheduler-priority-now": {
    valued: ["project", "data", "dedup"],
    usage: "scheduler-priority-now <feature> --project P --data JSON --dedup KEY（调度服务专用）",
    run(c) { c.deps.assertLease?.(); return recordPriorityNow(c.db, c.ctx(), c.project(), c.p.pos[1] ?? "", JSON.parse(c.need("data")), service(c), () => c.deps.assertLease?.()); },
  },
  "priority-stall-threshold": {
    valued: ["project", "reason", "dedup"],
    usage: "priority-stall-threshold <milliseconds> --project P --reason TEXT --dedup KEY",
    run(c) {
      if (!c.p.pos[1]) return { ok: true, milliseconds: priorityStallThreshold(c.db, c.project()) };
      if (c.deps.actor !== "owner") throw new LedgerError("forbidden", "停滞门槛只由 owner 配置");
      if (!c.ctx().dedupKey) throw new LedgerError("invalid", "需 --dedup");
      setPriorityStallThreshold(c.db, c.ctx(), c.project(), Number(c.p.pos[1]), c.need("reason"));
      return { ok: true };
    },
  },
};
