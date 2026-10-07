/** N7B center client for the N7K feature-proposal contract (schemaVersion 1). Wire shapes come only from
 * shared-ledger-contract-v2-feature-proposals.ts; this file adds the center paths and the response checks.
 * Center routes (N7C): POST /v1/projects/{projectId}/feature-proposals (body FeatureProposal → ProposalOperation),
 * GET .../feature-proposals/operations/{operationId} (→ ProposalOperation, 404 = no record; on POST 404 = route missing),
 * POST .../feature-proposals/{proposalId}/decision (body ProposalDecision → ProposalOperation).
 * Identity is the signed credential; nothing here authenticates or authorizes.
 */
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import { requestSharedLedger, SharedLedgerRemoteError, SharedLedgerUnavailable, type SharedLedgerTransportOptions } from "./shared-ledger-client-transport.js";
import {
  FEATURE_PROPOSAL_SCHEMA_VERSION, parseFeatureProposal, parseFeatureProposalError, parseProposalDecision, parseProposalOperation,
  proposalDigest, type FeatureProposal, type FeatureProposalError, type ProposalDecision, type ProposalOperation,
} from "./shared-ledger-contract-v2-feature-proposals.js";

export interface FeatureProposalScope { centerId: string; teamId: string; projectId: string }
/** The center answered with a body whose schemaVersion this client does not speak (older or newer center). */
export class FeatureProposalUnsupported extends SharedLedgerRemoteError {
  constructor() { super(0, { error: "unsupported feature proposal schemaVersion" }); this.message = "unsupported feature proposal schemaVersion"; }
}
/** A validated center rejection; only the fixed contract code / reason are kept. */
export class FeatureProposalRejected extends SharedLedgerRemoteError {
  constructor(status: number, readonly error: FeatureProposalError | null) { super(status, error ?? { error: "shared ledger rejected" }); }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const speaks = (raw: unknown) => !!raw && typeof raw === "object" && !Array.isArray(raw)
  && (raw as { schemaVersion?: unknown }).schemaVersion === FEATURE_PROPOSAL_SCHEMA_VERSION;
/** The transport turns any success-parser throw into "unavailable", so an unknown version travels out as this marker. */
const UNSUPPORTED = Object.freeze({ unsupported: true });
const checked = <T>(raw: unknown): T => {
  if (raw === UNSUPPORTED) throw new FeatureProposalUnsupported();
  return raw as T;
};
async function rejection(status: number, response: Response): Promise<unknown> {
  let raw: unknown;
  try { raw = await response.json(); } catch { raw = undefined; }
  if (raw && typeof raw === "object" && "schemaVersion" in raw && !speaks(raw)) throw new FeatureProposalUnsupported();
  let parsed: FeatureProposalError | null = null;
  try { parsed = parseFeatureProposalError(raw); } catch { /* a legacy / malformed body keeps only the status */ }
  throw new FeatureProposalRejected(status, parsed);
}
/** Same scope, same operation; a published row must carry the feature it published. */
function operationFor(scope: FeatureProposalScope, operationId: string) {
  return (_status: number, raw: unknown): ProposalOperation | typeof UNSUPPORTED => {
    if (!speaks(raw)) return UNSUPPORTED;
    const op = parseProposalOperation(raw);
    if (op.centerId !== scope.centerId || op.teamId !== scope.teamId || op.projectId !== scope.projectId || op.operationId !== operationId) {
      throw new SharedLedgerUnavailable();
    }
    return op;
  };
}
const base = (scope: FeatureProposalScope) => {
  if (!ID.test(scope.projectId)) throw new Error("invalid project");
  return `/v1/projects/${scope.projectId}/feature-proposals`;
};

export class SharedLedgerFeatureProposalClient {
  constructor(private connection: SharedLedgerConnection, private key: InstanceKey, private options: SharedLedgerTransportOptions = {}) {}

  private scope(s: FeatureProposalScope): FeatureProposalScope {
    if (s.centerId !== this.connection.centerId || s.teamId !== this.connection.teamId) throw new Error("credential scope mismatch");
    return s;
  }

  /** Sends exactly the given body; the returned operation must bind the same digest (same operationId + other digest = conflict). */
  async submit(proposal: FeatureProposal, now: number): Promise<ProposalOperation> {
    const body = parseFeatureProposal(proposal, now), scope = this.scope(body), digest = proposalDigest(body);
    const op = checked<ProposalOperation>(await requestSharedLedger({ ...this.connection }, this.key, this.options, "POST", base(scope), body,
      undefined, rejection, undefined, operationFor(scope, body.operationId)));
    if (op.state !== "conflict" && op.proposalDigest !== digest) throw new SharedLedgerUnavailable();
    return op;
  }

  /** null = the center has no record of this operation (it never arrived). */
  async status(scope: FeatureProposalScope, operationId: string): Promise<ProposalOperation | null> {
    if (!ID.test(operationId)) throw new Error("invalid operation");
    try {
      return checked<ProposalOperation>(await requestSharedLedger({ ...this.connection }, this.key, this.options, "GET",
        `${base(this.scope(scope))}/operations/${operationId}`, undefined, undefined, rejection, undefined, operationFor(scope, operationId)));
    } catch (e) {
      if (e instanceof FeatureProposalRejected && e.status === 404) return null;
      throw e;
    }
  }

  /** Forwards one decision; the approver is whoever the credential is. Never retried here. */
  async decide(scope: FeatureProposalScope, decision: ProposalDecision): Promise<ProposalOperation> {
    const d = parseProposalDecision(decision);
    const raw = checked<ProposalOperation>(await requestSharedLedger({ ...this.connection }, this.key, this.options, "POST",
      `${base(this.scope(scope))}/${d.proposalId}/decision`, d, undefined, rejection, undefined,
      (_s, body) => speaks(body) ? parseProposalOperation(body) : UNSUPPORTED));
    if (raw.centerId !== scope.centerId || raw.teamId !== scope.teamId || raw.projectId !== scope.projectId) throw new SharedLedgerUnavailable();
    return raw;
  }
}
