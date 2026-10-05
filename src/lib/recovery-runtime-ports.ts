/**
 * Recovery composite ports (dispatch-recovery-AUDP): one injected recovery-policy read (CFG's recoveryPolicy(project, mechanism)
 * shape) handed to the four verified recovery leaves through their own interfaces — MAT writeMaterials, MODEL recordModelOutcome,
 * ASKR sweepReminders and its notice gate, PLAN planGapTick. Inputs, permissions, CAS and dedup stay in the leaves; this file adds
 * no algorithm, threshold, config, store, tick or second mechanism list. Every leaf call reads the port afresh (no snapshot cache).
 * Without a port each leaf keeps its own observe default (manualAfterMs null = unset); a port that throws or answers an illegal
 * value reaches every leaf as a throw, so each falls back to off through its own path, and the reason goes to `onDiag`.
 * MODEL gets no refusal-approval port: a provider safety refusal stays evidence + manual hold, never a retry or family switch.
 * Not called in production: AUD injects CFG's recoveryPolicy and wires these exits; until then nothing here runs.
 * tests/recovery-runtime-ports.test.ts.
 */
import type { Database } from "bun:sqlite";
import { sweepReminders, type ReminderOutcome, type ReminderPorts } from "./ask-recovery.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerTask } from "./ledger-stages.js";
import { writeMaterials, type WriteMaterial, type WriteProbe } from "./lend-write-materials.js";
import { planGapTick, type PlanGapDeps, type PlanGapOutcome } from "./recovery-plan-gap.js";
import { recordModelOutcome, type OutcomeInput, type OutcomeRecord, type RecoveryPolicy, type RecoveryPolicyPort } from "./scheduler-model-outcome.js";

/** The mechanism keys as MODEL's port already names them (not a second list). */
export type RecoveryMechanism = Parameters<RecoveryPolicyPort>[1];
export interface RecoveryPolicyDiag { project: string; mechanism: RecoveryMechanism; reason: string }

export interface RecoveryRuntimeOptions {
  /** CFG's recoveryPolicy; absent = every leaf observes as it does today. */
  policy?: RecoveryPolicyPort;
  /** Told whenever the port throws or answers an illegal value (the leaf then runs off); a throwing sink is ignored. */
  onDiag?: (d: RecoveryPolicyDiag) => void;
}

export interface RecoveryRuntimePorts {
  /** MAT: a lent write / fix order's materials (lend-write-materials.ts), `materials` policy. */
  writeMaterials(db: Database, task: LedgerTask, q: { peer: string; repo: string; base: string }, probe: WriteProbe): Promise<WriteMaterial | null>;
  /** MODEL: record a dispatched order's model outcome (scheduler-model-outcome.ts), `modelOutcome` policy, no approval port. */
  recordModelOutcome(db: Database, ctx: WriteCtx, input: OutcomeInput): OutcomeRecord;
  /** ASKR: the ports for ask-expire's setAskReminderPorts / noticeBlocker / noticeGateNow, `askReminder` policy; a passed policy is dropped. */
  askReminderPorts(base: Omit<ReminderPorts, "policy">): ReminderPorts;
  /** ASKR: one reminder sweep over expired asks with those ports. */
  sweepAskReminders(db: Database, base: Omit<ReminderPorts, "policy">, now?: number): Promise<ReminderOutcome[]>;
  /** PLAN: one plan-gap pass (recovery-plan-gap.ts), `planGap` policy; a passed policy is dropped. */
  planGapTick(deps: Omit<PlanGapDeps, "policy">): Promise<PlanGapOutcome[]>;
}

const MODES: readonly unknown[] = ["on", "observe", "off"];

function illegal(p: unknown): string | null {
  if (!p || typeof p !== "object") return `不是对象：${JSON.stringify(p) ?? String(p)}`;
  const { mode, manualAfterMs: ms } = p as Record<string, unknown>;
  if (!MODES.includes(mode)) return `mode 不合法：${JSON.stringify(mode) ?? String(mode)}`;
  if (!(ms === null || (typeof ms === "number" && Number.isFinite(ms) && ms >= 0))) return `manualAfterMs 不合法：${JSON.stringify(ms) ?? String(ms)}`;
  return null;
}

/** The injected port, read on every call; an illegal answer becomes a throw so each leaf's own catch turns it off. */
function checked(port: RecoveryPolicyPort, onDiag: RecoveryRuntimeOptions["onDiag"]): RecoveryPolicyPort {
  const tell = (d: RecoveryPolicyDiag) => { try { onDiag?.(d); } catch { /* a broken sink must not change the policy outcome */ } };
  return (project, mechanism) => {
    let p: RecoveryPolicy;
    try {
      p = port(project, mechanism);
    } catch (e) {
      tell({ project, mechanism, reason: `读恢复策略失败，按 off：${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
      throw e;
    }
    const bad = illegal(p);
    if (bad) {
      const reason = `恢复策略值不合法，按 off：${bad}`.slice(0, 300);
      tell({ project, mechanism, reason });
      throw new Error(reason);
    }
    return { mode: p.mode, manualAfterMs: p.manualAfterMs };
  };
}

export function createRecoveryRuntimePorts(opts: RecoveryRuntimeOptions = {}): RecoveryRuntimePorts {
  const policy = opts.policy ? checked(opts.policy, opts.onDiag) : undefined;
  const askReminderPorts = (base: Omit<ReminderPorts, "policy">): ReminderPorts => {
    const { policy: _ignored, ...rest } = base as ReminderPorts;
    return policy ? { ...rest, policy } : rest;
  };
  return {
    writeMaterials: (db, task, q, probe) => writeMaterials(db, task, q, probe, policy),
    recordModelOutcome: (db, ctx, input) => recordModelOutcome(db, ctx, input, policy),
    askReminderPorts,
    sweepAskReminders: (db, base, now) => sweepReminders(db, askReminderPorts(base), now),
    planGapTick: (deps) => planGapTick({ ...deps, policy }),
  };
}
