/** Scheduler-only recovery commands; the canonical library writers own transaction fences and event contents. */
import { LedgerError } from "../lib/ledger-store.js";
import { writeManualResume, writeReviewDowngrade, writeReviewHold, type RecoveryFence } from "../lib/scheduler-recovery-write.js";
import type { LedgerCli } from "./ledger-context.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const FENCE_FLAGS = ["rev", "workflow-rev", "head", "round", "spec-rev"];

function integer(c: LedgerCli, flag: string, min: number) {
  const n = intFlag(c.p, flag);
  if (n === undefined || n < min) throw new LedgerError("invalid", `要带 --${flag} >= ${min}`);
  return n;
}

function fence(c: LedgerCli): RecoveryFence {
  if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "恢复写口只给调度服务");
  const task = c.task(c.p.pos[1]);
  if (c.deps.autoDispatch?.() !== true || !c.deps.autoProjects?.().includes(task.project)) throw new LedgerError("forbidden", "本项目未启用自动调度");
  const head = c.need("head");
  if (head !== "-" && !/^[a-f0-9]{40}$/.test(head)) throw new LedgerError("invalid", "head 要是完整小写 SHA 或 -");
  return { taskId: task.id, taskRev: integer(c, "rev", 1), workflowRev: integer(c, "workflow-rev", 1), head: head === "-" ? null : head,
    round: integer(c, "round", 0), specRev: integer(c, "spec-rev", 1) };
}

const active = (c: LedgerCli) => () => {
  c.deps.assertLease?.();
  const project = c.task(c.p.pos[1]).project;
  if (c.deps.autoDispatch?.() !== true || !c.deps.autoProjects?.().includes(project)) throw new LedgerError("forbidden", "本项目未启用自动调度");
};

export const SCHEDULER_RECOVERY_CMDS: Record<string, CommandSpec> = {
  "scheduler-manual-resume": {
    valued: [...FENCE_FLAGS, "mode", "reason", "max-workers"], bools: [],
    usage: "scheduler-manual-resume <task> --rev N --workflow-rev N --head SHA|- --round N --spec-rev N --mode on|observe --reason R --max-workers N",
    run(c) {
      const f = fence(c), mode = c.need("mode"), maxWorkers = integer(c, "max-workers", 0);
      if (!["on", "observe"].includes(mode) || maxWorkers > 64) throw new LedgerError("invalid", "mode 要 on/observe，max-workers 要 0..64（两家族各 0..32）");
      return writeManualResume(c.db, c.ctx(), { ...f, mode: mode as "on" | "observe", reason: c.need("reason"), maxWorkers }, active(c));
    },
  },
  "scheduler-review-hold": {
    valued: [...FENCE_FLAGS, "action", "review-seq"], bools: [],
    usage: "scheduler-review-hold <task> --rev N --workflow-rev N --head SHA --round N --spec-rev N --review-seq N --action prepare|informed",
    run(c) {
      const f = fence(c), action = c.need("action");
      if (!["prepare", "informed"].includes(action)) throw new LedgerError("invalid", "action 要 prepare/informed");
      return writeReviewHold(c.db, c.ctx(), { ...f, action: action as "prepare" | "informed", reviewSeq: integer(c, "review-seq", 1) }, active(c));
    },
  },
  "scheduler-review-downgrade": {
    valued: [...FENCE_FLAGS, "review-seq"], bools: [],
    usage: "scheduler-review-downgrade <task> --rev N --workflow-rev N --head SHA --round N --spec-rev N --review-seq N",
    run(c) { return writeReviewDowngrade(c.db, c.ctx(), { ...fence(c), reviewSeq: integer(c, "review-seq", 1) }, active(c)); },
  },
};
