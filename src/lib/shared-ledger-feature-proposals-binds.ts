/** N7X2 center client for the stage-one home bind (N7CB): the home instance tells the center which local card a node of a
 * center-planned feature opened as. Body = FeatureHomeBind, exactly the 7 contract fields (shared-ledger-contract-v2-feature-proposals.ts).
 * POST /v1/feature-proposals/binds → V1 command result (requestId = operationId, commandDigest = v2ObjectDigest(body),
 * result {featureId, rev, version}); GET /v1/feature-proposals/binds/{operationId} → V1 receipt (committed + that result | unknown).
 * Rejections carry the proposal error body (FeatureProposalRejected, fixed code / reason only). Any echo that does not match
 * the body sent is "unavailable": the outcome is unconfirmed and nothing local may move on it.
 */
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import type { SharedLedgerCommandResult } from "./shared-ledger-contract.js";
import { requestSharedLedger, SharedLedgerUnavailable, type SharedLedgerTransportOptions } from "./shared-ledger-client-transport.js";
import { parseSharedLedgerResponse } from "./shared-ledger-contract-responses.js";
import { parseFeatureHomeBind, type FeatureHomeBind } from "./shared-ledger-contract-v2-feature-proposals.js";
import { v2ObjectDigest } from "./shared-ledger-contract-v2-integrity.js";
import { featureProposalRejection } from "./shared-ledger-feature-proposals.js";

const ROOT = "/v1/feature-proposals/binds";
/** Digest the center stores for the bind and echoes as commandDigest. */
export const homeBindDigest = (body: unknown): string => v2ObjectDigest(parseFeatureHomeBind(body));

/** The result must be this operation, this digest, this feature and version. */
function echoed(body: FeatureHomeBind, digest: string, r: SharedLedgerCommandResult): SharedLedgerCommandResult {
  if (r.requestId !== body.operationId || r.commandDigest !== digest || r.result.featureId !== body.featureId || r.result.version !== body.version) {
    throw new SharedLedgerUnavailable();
  }
  return r;
}

export class SharedLedgerHomeBindClient {
  constructor(private connection: SharedLedgerConnection, private key: InstanceKey, private options: SharedLedgerTransportOptions = {}) {}

  private request<T>(method: "GET" | "POST", path: string, payload: unknown, parse: (raw: unknown) => T): Promise<T> {
    return requestSharedLedger({ ...this.connection }, this.key, this.options, method, path, payload, undefined, featureProposalRejection,
      undefined, (_status, raw) => parse(raw)) as Promise<T>;
  }

  /** One POST of exactly this body (a resend is the same body; the transport gives every attempt a new nonce). */
  bind(input: FeatureHomeBind): Promise<SharedLedgerCommandResult> {
    const body = parseFeatureHomeBind(input), digest = homeBindDigest(body);
    return this.request("POST", ROOT, body, (raw) => echoed(body, digest, parseSharedLedgerResponse("command", raw)));
  }

  /** null = the center has no committed bind for this operation (unknown, including after a center rollback). */
  status(input: FeatureHomeBind): Promise<SharedLedgerCommandResult | null> {
    const body = parseFeatureHomeBind(input), digest = homeBindDigest(body);
    return this.request("GET", `${ROOT}/${body.operationId}`, undefined, (raw) => {
      const r = parseSharedLedgerResponse("receipt", raw);
      if (r.status === "unknown") { if (r.requestId !== body.operationId) throw new SharedLedgerUnavailable(); return null; }
      return echoed(body, digest, r.receipt);
    });
  }
}
