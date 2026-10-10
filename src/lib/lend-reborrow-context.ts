/** In-process preparation capability, consumed only inside the canonical offer transaction; never persisted as authority. */
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import type { ReborrowFacts } from "./lend-reborrow-facts.js";
import type { ReborrowBinding } from "./lend-reborrow-marker.js";
import { prepareReborrowSource, type ReborrowSource, type ReborrowSourceProbe } from "./lend-reborrow-source.js";

export interface ReborrowContext { facts: ReborrowFacts; source: ReborrowSource }
const prepared = new WeakSet<ReborrowContext>();

function freeze(value: object): void {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
}

export async function prepareReborrowContext(facts: ReborrowFacts, probe: ReborrowSourceProbe): Promise<ReborrowContext> {
  const copy = structuredClone(facts), source = await prepareReborrowSource(copy, probe);
  const context = { facts: copy, source };
  freeze(context);
  prepared.add(context);
  return context;
}

/** A JSON file or an old event cannot impersonate fresh source verification. The caller still verifies PM/borrow authority. */
export function assertReborrowContext(task: LedgerTask, peer: string, context: ReborrowContext): void {
  if (!prepared.has(context) || context.facts.task.id !== task.id || context.facts.lease.peer !== peer) {
    throw new LedgerError("forbidden", "恢复上下文未经本次真实来源核验");
  }
  if (JSON.stringify(task) !== JSON.stringify(context.facts.task)) throw new LedgerError("conflict", "恢复上下文的任务快照已改变");
}

/** The single place a verified context becomes the order's marker binding; a CONV source can only produce the strict v2 marker. */
export function reborrowBindingOf(context: ReborrowContext): ReborrowBinding {
  const f = context.facts;
  return { orderId: f.previous.orderId, gen: f.previous.leaseGen, reclaimSeq: f.reclaim.seq,
    ...(f.conv ? { conv: { from: f.conv.from, to: f.conv.to } } : {}) };
}
