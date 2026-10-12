import {
  LedgerLendCentralClient, type LendCentralSharedResult, type LendCentralTransport,
} from "../lib/ledger-lend-central.js";
import type { LendCentralGrantDeps } from "../lib/ledger-lend-central-checks.js";
import { LendCentralOutbox } from "../lib/ledger-lend-central-state.js";
import type { PublishDenial } from "../lib/lend-push.js";
import { fail, V2ContractError } from "../lib/shared-ledger-contract-v2.js";
import { LendCentralJournal, type LendCentralJournalEntry } from "./shared-ledger-v2-lend-journal.js";

/** E16 ①: what the legacy path publishes for a write order (push the order branch, open or reuse its PR) before a result leaves. */
export interface LendCentralPublishWork { orderId: string; taskId: string; repository: string; branch: string; base: string; head: string; dir: string | null }
export type LendCentralPublished = { ok: true; pr: number | null } | { ok: false; error: string };
/** S2F6: re-reads this order right before a push / PR goes out (route and switch, the online order / lease view, the live grant);
 * null = still allowed. Its last await is the grant read, so a null answer is followed by the effect with no I/O in between. */
export type LendCentralPublishCheck = () => Promise<PublishDenial | null>;
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
  /** Injected by the composition root (S2F6). When present, a central write delivery publishes first and sends lend.result
   * only after it succeeded; a failed or throwing publish sends none. Absent = the delivery path as before S2F2. */
  publishWork?(work: LendCentralPublishWork, check: LendCentralPublishCheck): Promise<LendCentralPublished>;
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
  /** The routing port's publish with this order's check bound; a publish the check stopped throws the center's refusal code. */
  publishWork?(work: LendCentralPublishWork): Promise<LendCentralPublished>;
}
const DENIAL: Record<string, PublishDenial["kind"]> = { authorization_expired: "revoked", lease_expired: "expired", unavailable: "unknown", migrating: "unknown" };
/** null means the original path; skip is held and must never fall through to local task writes.
 * strictTaskId: a trusted binding naming another task than the local order is forbidden before routing, observing or pinning. */
export async function openLendCentral(orderId: string, localTaskId?: string, peer?: string, strictTaskId = false): Promise<BoundLendCentral | null> {
  const r = routing, p = central;
  if (!r) return null;
  // Read the original journal before asking for a current lease. An absent fresh binding cannot erase an old one.
  const journal = p ? new LendCentralJournal(p.outboxDir) : null;
  const pinned = journal?.read(null, orderId) ?? null;
  const fresh = pinned ? null : r.bindingFor(orderId);
  const ref = pinned ?? fresh;
  // Reject another authenticated peer before observing, routing or writing the original binding.
  if (ref && peer !== undefined && ref.binding.peer !== peer) return fail("forbidden");
  // Receipts are signed over ref.localTaskId; a binding naming another task would sign a receipt the lender rejects.
  if (strictTaskId && ref && localTaskId !== undefined && ref.localTaskId !== localTaskId) {
    console.warn("⚠️ [lend central] 中心绑定的 taskId 与本机订单不一致，已拒绝");
    return fail("forbidden");
  }
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
  const client = new LedgerLendCentralClient(entry.binding, checked, p.grant, new LendCentralOutbox(p.outboxDir));
  const publishWork = async (work: LendCentralPublishWork): Promise<LendCentralPublished> => {
    admitted();
    let refused: V2ContractError | LendCentralMigrating | null = null;
    // Preflight's answer goes stale over the publish's own awaits (view read, git, gh): each push / PR re-reads it first.
    const check: LendCentralPublishCheck = async () => {
      try { await client.live(); admitted(); return null; } catch (e) {
        if (e instanceof V2ContractError || e instanceof LendCentralMigrating) refused = e;
        const code = refused?.code ?? "unknown";
        return { kind: DENIAL[code] ?? (refused ? "changed" : "unknown"), reason: `中心复核没过：${refused ? code : String((e as Error)?.message ?? e)}`.slice(0, 300) };
      }
    };
    const out = await r.publishWork!(work, check);
    if (!out.ok && refused) throw refused;
    return out;
  };
  return { entry, transport: checked, client, sharedResult: () => structuredClone(r.sharedResult(entry)),
    publishWork: r.publishWork ? publishWork : undefined };
}

/** Explicit recovery is the only path which may resubmit a pending command. */
export async function recoverLendCentral(orderId: string, kind: "claim" | "result", resubmit = false) {
  const bound = await openLendCentral(orderId);
  if (!bound) return fail("unavailable");
  return bound.client.recover(kind, resubmit);
}
