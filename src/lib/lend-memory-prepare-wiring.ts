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
  materialRev: number | null; discarded?: string; spec: string; readSpec: () => string | null; prepared: LendPreparation;
}
const mode = (task: LedgerTask) => recoveryPolicy(task.project, KEY).mode;
const injection = (task: LedgerTask) => recoveryPolicy(task.project, "memoryLendInjection").mode;
const basis = (t: LedgerTask, head = true) => JSON.stringify([t.id, t.project, t.specRev, t.round, t.stage, ...(head ? [t.headSHA] : [])]);
const acts = (p: PreparedOffer) => p.mode === "on" && p.injection === "on" && mode(p.task) === "on" && injection(p.task) === "on";

/** Revision-only changes do not invalidate semantic input; the canonical offer still checks its own eligibility facts. */
function drift(p: PreparedOffer, task: LedgerTask | null, head = true): string | undefined {
  if (!task || basis(task, head) !== basis(p.task, head)) return "派单绑定在准备期间漂移";
  try { if (p.readSpec() !== p.spec) return "规格正文在准备期间漂移"; }
  catch (e) { return `规格在准备期间漂移或读取失败：${(e as Error).message}`; }
}

/** No ledger write (including rank/observation notes) is permitted before the offer succeeds. */
export async function prepareLendOffer(db: Database, task: LedgerTask, head: string | null, spec: string | null,
  readSpec: () => string | null, deps: EnsureDeps = {}): Promise<PreparedOffer | null> {
  const step = stepOfStage(task.stage), m = mode(task), upstream = injection(task);
  if (!step || !spec || m === "off" || upstream === "off") return null;
  if (db.inTransaction) throw new Error("出借记忆准备不能持有台账事务");
  const atStart = getTask(db, task.id);
  const prepared: PreparedOffer = { task, head, step, mode: m, injection: upstream, spec, readSpec, materialRev: atStart?.rev ?? null,
    prepared: { inputs: {}, startedAt: Date.now() } };
  const reason = drift(prepared, atStart);
  if (reason && acts(prepared)) throw new LedgerError("conflict", reason);
  if (reason) return { ...prepared, discarded: reason };
  return { ...prepared, prepared: await prepareLendMemory(db, task, step, head, deps) };
}

/** The callback is deliberately synchronous: no other offer can see this call's preparation while it waits for I/O. */
export function commitLendOffer<T>(db: Database, prepared: PreparedOffer | null, offer: (snapshot?: LedgerTask) => T): T {
  if (!prepared) return offer();
  const current = getTask(db, prepared.task.id), reason = prepared.discarded ?? drift(prepared, current);
  if (reason && acts(prepared)) throw new LedgerError("conflict", reason);
  const previous = active.get(db);
  active.set(db, reason ? { ...prepared, discarded: reason } : prepared);
  // Only refresh revisions changed during memory I/O; material-I/O drift must still reach the canonical CLI guard.
  const snapshot = current && prepared.materialRev === prepared.task.rev && basis(current) === basis(prepared.task) ? current : prepared.task;
  try { return offer(snapshot); } finally {
    if (previous) active.set(db, previous); else active.delete(db);
  }
}

/** The offer's existing transaction rechecks eligibility; this checks the preparation's identity inside that same transaction. */
export function lendOfferMemory(db: Database, task: LedgerTask, step: LendStep, orderId: string,
  made: { wire: OrderWire; whole: OrderWire }, opts: { now?: number } = {}): LendMemory | null {
  const p = active.get(db), current = mode(task), upstream = injection(task);
  if (!p || current === "off" || upstream === "off") return lendMemory(db, task, step, orderId, made, opts);
  if (p.task.id !== task.id) return lendMemory(db, task, step, orderId, made, opts);
  const reason = p.discarded ?? (p.step !== step ? "挂单步骤在准备期间漂移" : drift(p, task, false));
  if (reason && acts(p)) throw new LedgerError("conflict", reason);
  // An in-transaction fix-start/relay head adoption invalidates semantic inputs, but preserves the synchronous baseline.
  const moved = p.head !== made.wire.head || p.task.headSHA !== task.headSHA;
  const preparation = reason || moved ? null : p.prepared;
  if (preparation && acts(p)) return lendMemory(db, task, step, orderId, made, { ...opts, preparation });
  const baseline = lendMemory(db, task, step, orderId, made, opts);
  if (current !== "observe" || !baseline) return baseline;
  const candidate = preparation ? lendMemory(db, task, step, orderId, made, { ...opts, preparation }) : null;
  return { ...baseline, commit: (sent) => {
    baseline.commit(sent);
    recordObserved(db, { project: task.project, mechanism: KEY, target: task.id, actionKey: orderId,
      action: "出借语义准备与同步基线判定差异", data: { orderId, step, specRev: task.specRev, round: task.round, head: made.wire.head,
        baseline: baseline.sample, prepared: candidate?.sample, changed: JSON.stringify(baseline.sample) !== JSON.stringify(candidate?.sample),
        ...(reason || moved || preparation?.error ? { reason: reason ?? (moved ? "事务内 head 漂移，沿用同步基线" : preparation?.error) } : {}) } }, opts.now ?? Date.now());
  } };
}
