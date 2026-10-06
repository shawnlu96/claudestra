/** In-process REBOR2 capability: only a context prepared here, in this process, may reach the canonical offer transaction. */
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import type { Reborrow2Facts } from "./lend-reborrow2-facts.js";
import type { Reborrow2Binding } from "./lend-reborrow2-marker.js";
import { prepareReborrow2Source, type Reborrow2Source, type Reborrow2SourceProbe } from "./lend-reborrow2-source.js";

export interface Reborrow2Context { facts: Reborrow2Facts; source: Reborrow2Source }
const prepared = new WeakSet<Reborrow2Context>();

function freeze(value: object): void {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
}

export async function prepareReborrow2Context(facts: Reborrow2Facts, probe: Reborrow2SourceProbe): Promise<Reborrow2Context> {
  const copy = structuredClone(facts), source = await prepareReborrow2Source(copy, probe);
  const context = { facts: copy, source };
  freeze(context);
  prepared.add(context);
  return context;
}

/** A JSON file, an old event or a REBOR v1 context cannot impersonate fresh REBOR2 source verification. */
export function assertReborrow2Context(task: LedgerTask, peer: string, context: Reborrow2Context): void {
  if (!prepared.has(context) || context.facts.task.id !== task.id || context.facts.target.peer !== peer) {
    throw new LedgerError("forbidden", "终态接续上下文未经本次真实来源核验");
  }
  if (JSON.stringify(task) !== JSON.stringify(context.facts.task)) throw new LedgerError("conflict", "终态接续上下文的任务快照已改变");
}

export function reborrow2Binding(c: Reborrow2Context): Reborrow2Binding {
  const f = c.facts;
  return { orderId: f.previous.orderId, gen: f.previous.leaseGen, peer: f.samePeer ? "same" : "cross", end: f.end, src: f.lease.branch, ended: f.lease.updatedAt };
}
