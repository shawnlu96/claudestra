/** Scheduler-only recovery commands; the canonical library writers own transaction fences and event contents. */
import { getWorkflow } from "../lib/ledger-scheduler.js";
import { LedgerError } from "../lib/ledger-store.js";
import { manualRecoveryMechanism, proveRecovery, recoveryMark, type ExternalSnapshot } from "../lib/manual-recovery-release.js";
import { writeManualRecovery, writeManualResume, writeReviewDowngrade, writeReviewHold, type RecoveryFence } from "../lib/scheduler-recovery-write.js";
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

/**
 * `--mechanism`: no caller-supplied fact is taken (no --reason, no approval / CI flag). This leased CLI reads the mechanism's external
 * evidence itself, proves, then the writer re-proves the same snapshot inside its transaction.
 */
async function manualRecovery(c: LedgerCli, f: RecoveryFence, id: string, mode: "on" | "observe", maxWorkers: number) {
  if (c.p.flags.reason !== undefined) throw new LedgerError("invalid", "扩展恢复不收 --reason：理由由证明生成");
  const m = manualRecoveryMechanism(id);
  if (!m) throw new LedgerError("not_found", `没有登记的恢复机制 ${id}`);
  const lease = active(c), task = c.task(f.taskId);
  lease();
  const mark = recoveryMark(c.db, task, getWorkflow(c.db, task.id), id);
  if (!mark.ok) throw new LedgerError("conflict", `manual 扩展恢复不成立：${mark.why}`);
  let external: ExternalSnapshot | null = null;
  if (m.readEvidence) {
    try { external = await m.readEvidence(task); } catch (e) { throw new LedgerError("conflict", `机制 ${id} 读外部证据失败，不恢复：${(e as Error).message}`); }
  }
  lease();
  const fresh = c.task(f.taskId), pre = proveRecovery(c.db, fresh, getWorkflow(c.db, fresh.id), id, external);
  if (pre.kind === "refused") throw new LedgerError("conflict", `manual 扩展恢复不成立：${pre.why}`);
  if (pre.proof.factSeq !== mark.factSeq) throw new LedgerError("conflict", `读外部证据期间卡上有新事实（#${mark.factSeq}→#${pre.proof.factSeq}），下一轮重读`);
  return writeManualRecovery(c.db, c.ctx(), { ...f, mechanism: id, mode, maxWorkers, fingerprint: pre.proof.fingerprint, external }, lease);
}

export const SCHEDULER_RECOVERY_CMDS: Record<string, CommandSpec> = {
  "scheduler-manual-resume": {
    valued: [...FENCE_FLAGS, "mode", "reason", "max-workers", "mechanism"], bools: [],
    usage: "scheduler-manual-resume <task> --rev N --workflow-rev N --head SHA|- --round N --spec-rev N --mode on|observe (--reason R | --mechanism M) --max-workers N",
    run(c) {
      const f = fence(c), mode = c.need("mode"), maxWorkers = integer(c, "max-workers", 0);
      if (!["on", "observe"].includes(mode) || maxWorkers > 64) throw new LedgerError("invalid", "mode 要 on/observe，max-workers 要 0..64（两家族各 0..32）");
      if (c.p.flags.mechanism !== undefined) return manualRecovery(c, f, c.need("mechanism"), mode as "on" | "observe", maxWorkers);
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
