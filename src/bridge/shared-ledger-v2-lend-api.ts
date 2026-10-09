import { randomUUID } from "node:crypto";
import { signPurpose } from "../lib/instance-key.js";
import { checkView } from "../lib/ledger-lend-central-checks.js";
import { getLendOrder, type LendOrder } from "../lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../lib/ledger-lend-result.js";
import { parseLendRequest } from "../lib/lend-wire.js";
import { parseV2Request } from "../lib/lend-wire-v2.js";
import { payloadSha } from "../lib/lend-submit.js";
import { fail, V2ContractError } from "../lib/shared-ledger-contract-v2.js";
import { apiJson } from "./api-respond.js";
import { ledgerDb } from "./ledger-feed.js";
import { LendCentralMigrating, lendCentralRoutingEnabled, lendCentralWire, openLendCentral, type BoundLendCentral } from "./shared-ledger-v2-lend.js";

export interface LendCentralApiDeps {
  order(orderId: string): LendOrder | null;
  sign(fields: string[]): { key: string; sig: string } | null;
}
const deps: LendCentralApiDeps = {
  order: id => { const db = ledgerDb(); return db ? getLendOrder(db, id) : null; },
  sign: fields => signPurpose(RECEIPT_PURPOSE, fields),
};
const success = (fields: Record<string, unknown>): Response => apiJson(200, { ok: true, v: 1, ...fields });
const pending = (status: string, requestId: string): Response => apiJson(503, { ok: false, code: "unavailable", error: status, requestId });

async function lease(bound: BoundLendCentral) {
  const b = bound.entry.binding;
  const view = checkView(b, await bound.transport.view(b.order.orderId), true);
  const current = view.lease;
  if (!current) return fail("stale_order");
  return { gen: current.leaseGen, expiresAt: current.expiresAt, ms: current.leaseMs };
}
async function checkedBound(id: string, peer: string, d: LendCentralApiDeps): Promise<BoundLendCentral | null> {
  return openLendCentral(id, d.order(id)?.taskId, peer);
}
async function beat(raw: unknown, peer: string, d: LendCentralApiDeps): Promise<Response | null> {
  const parsed = parseV2Request("beat", raw);
  if (!parsed.ok) return fail("invalid_field");
  let bound: BoundLendCentral | null = null;
  for (const o of parsed.value.orders) {
    const candidate = await checkedBound(o.orderId, peer, d);
    if (!candidate) continue;
    if (parsed.value.orders.length !== 1) return fail("forbidden");
    bound = candidate;
  }
  if (!bound) return null;
  await bound.client.beat(raw, `lend-beat:${randomUUID()}`);
  return success({ orders: [{ orderId: parsed.value.orders[0]!.orderId, verdict: "ok", lease: await lease(bound) }] });
}
async function result(bound: BoundLendCentral, raw: unknown, text: string, d: LendCentralApiDeps): Promise<Response> {
  const outcome = await bound.client.result(raw, bound.sharedResult());
  if (outcome.status !== "confirmed") return pending(outcome.status, outcome.requestId);
  const { orderId } = bound.entry.binding.order;
  // The lender verifies this receipt against the local taskId in its original claim wire.
  const taskId = bound.entry.localTaskId;
  const sha256 = payloadSha(text), eventSeq = outcome.receipt.serverSeq;
  const signed = d.sign([orderId, sha256, String(eventSeq), taskId]);
  if (!signed) return fail("unavailable");
  return success({ receipt: { orderId, taskId, sha256, eventSeq, ...signed } });
}
async function command(endpoint: "claim" | "lease" | "result", raw: unknown, text: string, peer: string, d: LendCentralApiDeps) {
  const id = (raw as { orderId?: unknown } | null)?.orderId;
  if (typeof id !== "string") return null; // The original parser owns malformed requests which cannot identify an order.
  const bound = await checkedBound(id, peer, d);
  if (!bound) return null;
  if (endpoint === "result") return result(bound, raw, text, d);
  if (endpoint === "claim") {
    const outcome = await bound.client.claim(raw);
    if (outcome.status !== "confirmed") return pending(outcome.status, outcome.requestId);
    // S2F must reconcile the central claim into the home order projection and exclude execution orders from legacy poll/push.
    // Mutating the home ledger here would bypass the S2G/S2P authority gates.
    const local = d.order(id);
    if (!local) return fail("unavailable");
    return success({ order: local.wire, text: local.text, sha256: local.sha256, lease: await lease(bound),
      ...(local.branch ? { write: { branch: local.branch, base: local.base } } : {}) });
  }
  const parsed = parseLendRequest("lease", raw);
  if (!parsed.ok) return fail("invalid_field");
  if (parsed.value.action !== "renew") return fail("unknown_operation");
  await bound.client.beat({ v: 1, orders: [{ orderId: id, gen: parsed.value.gen, phase: "working", lastActivityAt: 0, excerpt: "" }] },
    `lend-beat:${randomUUID()}`);
  return success({ lease: await lease(bound) });
}

/** Called after the existing peer/E2E/signature gate. null is exact legacy passthrough, including unconfigured routing. */
export async function sharedLendApi(endpoint: string, text: string, peer: string, d = deps): Promise<Response | null> {
  if (!lendCentralRoutingEnabled() || !["claim", "lease", "result", "beat"].includes(endpoint)) return null;
  try {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return null; /* Legacy parser returns the original invalid-JSON refusal. */ }
    raw = lendCentralWire(raw);
    return endpoint === "beat" ? await beat(raw, peer, d)
      : await command(endpoint as "claim" | "lease" | "result", raw, text, peer, d);
  } catch (error) {
    if (error instanceof V2ContractError || error instanceof LendCentralMigrating) return apiJson(error.status, { ok: false, code: error.code, error: error.message });
    console.warn(`⚠️ [lend central] ${String(error)}`);
    return apiJson(503, { ok: false, code: "unavailable", error: "中心出借 journal 或传输不可用" });
  }
}
