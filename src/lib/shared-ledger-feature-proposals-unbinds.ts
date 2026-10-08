/** N7X5 center client for revoking a home bind (N7X5C implements the center side). Body = FeatureHomeUnbind, exactly the 8
 * contract fields (shared-ledger-contract-v2-feature-proposals.ts).
 * POST /v1/feature-proposals/unbinds → V1 command result (requestId = operationId, commandDigest = v2ObjectDigest(body),
 * result {featureId, rev, version}: rev after the revoke, version unchanged); GET /v1/feature-proposals/unbinds/{operationId}
 * → V1 receipt (committed + that result | unknown, also after a center rollback: resend the same op and body).
 * Rejections carry the proposal error body (FeatureProposalRejected, fixed code / reason only); 404 only means the center does
 * not serve this endpoint. Any echo that does not match the body sent is "unavailable": nothing local may move on it.
 */
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import type { SharedLedgerCommandResult } from "./shared-ledger-contract.js";
import { requestSharedLedger, SharedLedgerUnavailable, type SharedLedgerTransportOptions } from "./shared-ledger-client-transport.js";
import { parseSharedLedgerResponse } from "./shared-ledger-contract-responses.js";
import { parseFeatureHomeUnbind, type FeatureHomeUnbind } from "./shared-ledger-contract-v2-feature-proposals.js";
import { v2ObjectDigest } from "./shared-ledger-contract-v2-integrity.js";
import { FeatureProposalRejected, featureProposalRejection, FeatureProposalUnsupported } from "./shared-ledger-feature-proposals.js";

const ROOT = "/v1/feature-proposals/unbinds";
/** Digest the center stores for the unbind and echoes as commandDigest. */
export const homeUnbindDigest = (body: unknown): string => v2ObjectDigest(parseFeatureHomeUnbind(body));

/** A rejection keeps its HTTP status: a body in an unknown schemaVersion keeps only the status (no code), never the status-0
 * "unsupported" marker — only a real 404 means the center does not serve unbinds. */
async function rejection(status: number, response: Response): Promise<unknown> {
  try { return await featureProposalRejection(status, response); }
  catch (e) { throw e instanceof FeatureProposalUnsupported ? new FeatureProposalRejected(status, null) : e; }
}

/** The result must be this operation, this digest, this feature and version. */
function echoed(body: FeatureHomeUnbind, digest: string, r: SharedLedgerCommandResult): SharedLedgerCommandResult {
  if (r.requestId !== body.operationId || r.commandDigest !== digest || r.result.featureId !== body.featureId || r.result.version !== body.version) {
    throw new SharedLedgerUnavailable();
  }
  return r;
}

export class SharedLedgerHomeUnbindClient {
  constructor(private connection: SharedLedgerConnection, private key: InstanceKey, private options: SharedLedgerTransportOptions = {}) {}

  private request<T>(method: "GET" | "POST", path: string, payload: unknown, parse: (raw: unknown) => T): Promise<T> {
    return requestSharedLedger({ ...this.connection }, this.key, this.options, method, path, payload, undefined, rejection,
      undefined, (_status, raw) => parse(raw)) as Promise<T>;
  }

  /** One POST of exactly this body (a resend is the same body; the transport gives every attempt a new nonce). */
  unbind(input: FeatureHomeUnbind): Promise<SharedLedgerCommandResult> {
    const body = parseFeatureHomeUnbind(input), digest = homeUnbindDigest(body);
    return this.request("POST", ROOT, body, (raw) => echoed(body, digest, parseSharedLedgerResponse("command", raw)));
  }

  /** null = the center has no committed unbind for this operation (unknown, including after a center rollback). */
  status(input: FeatureHomeUnbind): Promise<SharedLedgerCommandResult | null> {
    const body = parseFeatureHomeUnbind(input), digest = homeUnbindDigest(body);
    return this.request("GET", `${ROOT}/${body.operationId}`, undefined, (raw) => {
      const r = parseSharedLedgerResponse("receipt", raw);
      if (r.status === "unknown") { if (r.requestId !== body.operationId) throw new SharedLedgerUnavailable(); return null; }
      return echoed(body, digest, r.receipt);
    });
  }
}
