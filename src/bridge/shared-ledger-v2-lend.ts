import {
  LedgerLendCentralClient, type LendCentralSharedResult, type LendCentralTransport,
} from "../lib/ledger-lend-central.js";
import type { LendCentralGrantDeps } from "../lib/ledger-lend-central-checks.js";
import { LendCentralOutbox } from "../lib/ledger-lend-central-state.js";
import { fail } from "../lib/shared-ledger-contract-v2.js";
import { LendCentralJournal, type LendCentralJournalEntry } from "./shared-ledger-v2-lend-journal.js";

export interface LendCentralPort {
  mode(projectId: string): "off" | "observe" | "on";
  transportFor(projectId: string): LendCentralTransport | null;
  grant: LendCentralGrantDeps;
  outboxDir: string;
}
/** All callbacks read trusted home records. Worker JSON supplies neither bindings nor shared content. */
export interface LendCentralRoutingPort {
  route(taskId: string): "local" | "skip" | "central";
  bindingFor(orderId: string): LendCentralJournalEntry | null;
  sharedResult(entry: LendCentralJournalEntry): LendCentralSharedResult;
  skipReason?(taskId: string): "migrating" | "unavailable";
  observe?(decision: { orderId: string; taskId: string; route: "local" | "skip" | "central" }): void;
}
let central: LendCentralPort | null = null;
let routing: LendCentralRoutingPort | null = null;

export class LendCentralMigrating extends Error {
  readonly code = "migrating";
  readonly status = 409;
  constructor() { super("migrating"); }
}
function held(r: LendCentralRoutingPort, taskId: string): never {
  if (r.skipReason?.(taskId) === "migrating") throw new LendCentralMigrating();
  return fail("unavailable");
}

export function configureLendCentral(port: LendCentralPort | null): void { central = port; }
export function configureLendCentralRouting(port: LendCentralRoutingPort | null): void { routing = port; }
export function lendCentralRoutingEnabled(): boolean { return routing !== null; }

/** Ignore unsolicited central metadata; wire fields are still validated by the existing strict parsers. */
export function lendCentralWire(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { binding: _b, sharedResult: _s, result: _r, artifactIds: _a, ...wire } = raw as Record<string, unknown>;
  return wire;
}

export interface BoundLendCentral {
  entry: LendCentralJournalEntry;
  client: LedgerLendCentralClient;
  transport: LendCentralTransport;
  sharedResult(): LendCentralSharedResult;
}
/** null means the original path; skip is held and must never fall through to local task writes. */
export async function openLendCentral(orderId: string, localTaskId?: string, peer?: string): Promise<BoundLendCentral | null> {
  const r = routing, p = central;
  if (!r) return null;
  // Read the original journal before asking for a current lease. An absent fresh binding cannot erase an old one.
  const journal = p ? new LendCentralJournal(p.outboxDir) : null;
  const pinned = journal?.read(null, orderId) ?? null;
  const fresh = pinned ? null : r.bindingFor(orderId);
  const ref = pinned ?? fresh;
  // Reject another authenticated peer before observing, routing or writing the original binding.
  if (ref && peer !== undefined && ref.binding.peer !== peer) return fail("forbidden");
  const taskId = ref?.localTaskId ?? localTaskId;
  if (!taskId) return null;
  const decision = r.route(taskId);
  r.observe?.({ orderId, taskId, route: decision });
  if (decision === "local") return null;
  if (decision === "skip") return held(r, taskId);
  if (!p || !ref || p.mode(ref.localProjectId) !== "on") return fail("unavailable");
  const transport = p.transportFor(ref.localProjectId);
  if (!transport || !journal) return fail("unavailable");
  const entry = await journal.pin(ref);
  // A grant/switch may be revoked while the client awaits an online read or its outbox lock.
  const admitted = () => {
    if (central !== p || routing !== r || r.route(entry.localTaskId) !== "central"
      || p.mode(entry.localProjectId) !== "on") return fail("unavailable");
  };
  const checked: LendCentralTransport = {
    receipt: id => { admitted(); return transport.receipt(id); },
    view: id => { admitted(); return transport.view(id); },
    command: c => { admitted(); return transport.command(c); },
  };
  return { entry, transport: checked, client: new LedgerLendCentralClient(entry.binding, checked, p.grant, new LendCentralOutbox(p.outboxDir)),
    sharedResult: () => structuredClone(r.sharedResult(entry)) };
}

/** Explicit recovery is the only path which may resubmit a pending command. */
export async function recoverLendCentral(orderId: string, kind: "claim" | "result", resubmit = false) {
  const bound = await openLendCentral(orderId);
  if (!bound) return fail("unavailable");
  return bound.client.recover(kind, resubmit);
}
