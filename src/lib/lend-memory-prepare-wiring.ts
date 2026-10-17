/** Preparation stays invocation-local; only a synchronous offer may expose it to the transactional renderer. */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask, LedgerError } from "./ledger-store.js";
import { stepOfStage, type LendStep } from "./lend-git.js";
import { lendMemory, prepareLendMemory, type LendPreparation, type LendMemory } from "./memory-retrieve-lend.js";
import type { EnsureDeps } from "./memory-retrieve-order.js";
import type { OrderWire } from "./order-wire.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";

const KEY = "memoryLendPrepare";
const active = new WeakMap<Database, PreparedOffer>();
interface PreparedOffer {
  task: LedgerTask; head: string | null; step: LendStep; mode: RecoveryMode; injection: RecoveryMode;
  spec: string; readSpec: () => string | null; prepared: LendPreparation;
}
const mode = (task: LedgerTask) => recoveryPolicy(task.project, KEY).mode;
const injection = (task: LedgerTask) => recoveryPolicy(task.project, "memoryLendInjection").mode;
const basis = (t: LedgerTask) => JSON.stringify([t.id, t.project, t.rev, t.specRev, t.round, t.stage, t.headSHA]);

/** No ledger write (including rank/observation notes) is permitted before the offer succeeds. */
export async function prepareLendOffer(db: Database, task: LedgerTask, head: string | null, spec: string | null,
  readSpec: () => string | null, deps: EnsureDeps = {}): Promise<PreparedOffer | null> {
  const step = stepOfStage(task.stage), m = mode(task), upstream = injection(task);
  if (!step || !spec || m === "off" || upstream === "off") return null;
  if (db.inTransaction) throw new Error("出借记忆准备不能持有台账事务");
  if (basis(getTask(db, task.id) ?? task) !== basis(task) || readSpec() !== spec) {
    throw new LedgerError("conflict", "准备记忆前派单材料已漂移，请重读后再挂单");
  }
  return { task, head, step, mode: m, injection: upstream, spec, readSpec, prepared: await prepareLendMemory(db, task, step, head, deps) };
}

/** The callback is deliberately synchronous: no other offer can see this call's preparation while it waits for I/O. */
export function commitLendOffer<T>(db: Database, prepared: PreparedOffer | null, offer: () => T): T {
  if (!prepared) return offer();
  const current = getTask(db, prepared.task.id);
  if (!current || basis(current) !== basis(prepared.task) || prepared.readSpec() !== prepared.spec) {
    throw new LedgerError("conflict", "准备记忆期间派单材料已漂移，请重读后再挂单");
  }
  const previous = active.get(db);
  active.set(db, prepared);
  try { return offer(); } finally {
    if (previous) active.set(db, previous); else active.delete(db);
  }
}

/** The offer's existing transaction rechecks eligibility; this checks the preparation's identity inside that same transaction. */
export function lendOfferMemory(db: Database, task: LedgerTask, step: LendStep, orderId: string,
  made: { wire: OrderWire; whole: OrderWire }, opts: { now?: number } = {}): LendMemory | null {
  const p = active.get(db), current = mode(task), upstream = injection(task);
  if (!p || current === "off" || upstream === "off") return lendMemory(db, task, step, orderId, made, opts);
  if (p.task.id !== task.id || p.task.specRev !== task.specRev || p.task.round !== task.round || p.step !== step || p.readSpec() !== p.spec) {
    throw new LedgerError("conflict", "写事务内派单材料已漂移，请重新准备");
  }
  // Fix-start adoption can legitimately move the head inside the offer; discard its now-unbound semantic result.
  const moved = p.head !== made.wire.head || p.task.headSHA !== task.headSHA;
  const preparation = moved ? { inputs: {}, error: "写事务内 head 已漂移，丢弃准备结果", startedAt: p.prepared.startedAt } : p.prepared;
  if (p.mode === "on" && current === "on" && p.injection === upstream) return lendMemory(db, task, step, orderId, made, { ...opts, preparation });
  const baseline = lendMemory(db, task, step, orderId, made, opts);
  if (current !== "observe" || !baseline) return baseline;
  const candidate = lendMemory(db, task, step, orderId, made, { ...opts, preparation });
  return { ...baseline, commit: (sent) => {
    baseline.commit(sent);
    recordObserved(db, { project: task.project, mechanism: KEY, target: task.id, actionKey: orderId,
      action: "出借语义准备与同步基线判定差异", data: { orderId, step, specRev: task.specRev, round: task.round, head: made.wire.head,
        baseline: baseline.sample, prepared: candidate?.sample, changed: JSON.stringify(baseline.sample) !== JSON.stringify(candidate?.sample),
        ...(preparation.error ? { reason: preparation.error } : {}) } }, opts.now ?? Date.now());
  } };
}
