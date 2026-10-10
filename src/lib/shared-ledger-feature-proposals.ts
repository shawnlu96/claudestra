/** N7B center client for the N7K feature-proposal contract (schemaVersion 1). Wire shapes come only from
 * shared-ledger-contract-v2-feature-proposals.ts; this file adds the center paths and the response checks.
 * Center routes (N7C, the only four the center serves; anything else is 404):
 * POST /v1/feature-proposals (body FeatureProposal → record), GET /v1/feature-proposals/operations/{operationId} (→ record;
 * 403 = no record or not this caller's), GET /v1/feature-proposals/projects/{projectId} (→ {policy, proposals: record[]}),
 * POST /v1/feature-proposals/decisions/{proposalId} (body ProposalDecision with the same proposalId → record).
 * record = {proposal, proposalId, proposalRev, proposer{personId, instanceId, type}, operation: ProposalOperation}.
 * Identity is the signed credential; nothing here authenticates or authorizes.
 */
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import { requestSharedLedger, SharedLedgerRemoteError, SharedLedgerUnavailable, type SharedLedgerTransportOptions } from "./shared-ledger-client-transport.js";
import {
  FEATURE_PROPOSAL_SCHEMA_VERSION, parseFeatureProposal, parseFeatureProposalError, parseProposalDecision, parseProposalOperation,
  parseProposalPolicy, proposalDigest, type FeatureProposal, type FeatureProposalError, type ProposalDecision, type ProposalOperation,
  type ProposalPolicy,
} from "./shared-ledger-contract-v2-feature-proposals.js";

export interface FeatureProposalScope { centerId: string; teamId: string; projectId: string }
/** One center proposal row as N7C returns it, after the checks in recordFor. */
export interface ProposalRecord {
  proposal: FeatureProposal; proposalId: string; proposalRev: number;
  proposer: { type: "person" | "service"; personId: string | null; instanceId: string | null }; operation: ProposalOperation;
}
export interface ProposalList { policy: ProposalPolicy; proposals: ProposalRecord[] }
/** The center answered with a body whose schemaVersion this client does not speak (older or newer center). */
export class FeatureProposalUnsupported extends SharedLedgerRemoteError {
  constructor() { super(0, { error: "unsupported feature proposal schemaVersion" }); this.message = "unsupported feature proposal schemaVersion"; }
}
/** A validated center rejection; only the fixed contract code / reason are kept. */
export class FeatureProposalRejected extends SharedLedgerRemoteError {
  constructor(status: number, readonly error: FeatureProposalError | null) { super(status, error ?? { error: "shared ledger rejected" }); }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const speaks = (raw: unknown) => isObject(raw) && raw.schemaVersion === FEATURE_PROPOSAL_SCHEMA_VERSION;
/** The transport turns any success-parser throw into "unavailable", so an unknown version travels out as this marker. */
const UNSUPPORTED = Object.freeze({ unsupported: true });
class Unsupported extends Error {}
const checked = <T>(raw: unknown): T => {
  if (raw === UNSUPPORTED) throw new FeatureProposalUnsupported();
  return raw as T;
};
/** Success parsers throw Unsupported for a version mismatch anywhere in the body; everything else is "unavailable". */
const parsing = <T>(parse: (raw: unknown) => T) => (_status: number, raw: unknown): T | typeof UNSUPPORTED => {
  try { return parse(raw); } catch (e) { if (e instanceof Unsupported) return UNSUPPORTED; throw e; }
};
async function rejection(status: number, response: Response): Promise<unknown> {
  let raw: unknown;
  try { raw = await response.json(); } catch { raw = undefined; }
  if (raw && typeof raw === "object" && "schemaVersion" in raw && !speaks(raw)) throw new FeatureProposalUnsupported();
  let parsed: FeatureProposalError | null = null;
  try { parsed = parseFeatureProposalError(raw); } catch { /* a legacy / malformed body keeps only the status */ }
  throw new FeatureProposalRejected(status, parsed);
}
export { rejection as featureProposalRejection };
function optId(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !ID.test(v)) throw new SharedLedgerUnavailable();
  return v;
}
const sameScope = (a: FeatureProposalScope, b: FeatureProposalScope) => a.centerId === b.centerId && a.teamId === b.teamId && a.projectId === b.projectId;
/** Unwraps one record: operation v1 (a bare top-level operation is the pre-N7C shape → unsupported), same scope,
 * proposalRev positive, record.proposalId = operation.proposalId, digest of record.proposal = operation.proposalDigest. */
function recordFor(scope: FeatureProposalScope, raw: unknown): ProposalRecord {
  if (!isObject(raw)) throw new SharedLedgerUnavailable();
  if (!("operation" in raw) && "schemaVersion" in raw) throw new Unsupported();
  if (!speaks(raw.operation)) throw new Unsupported();
  const operation = parseProposalOperation(raw.operation);
  const { proposalId, proposalRev, proposer } = raw;
  if (typeof proposalId !== "string" || !ID.test(proposalId) || proposalId !== operation.proposalId) throw new SharedLedgerUnavailable();
  if (typeof proposalRev !== "number" || !Number.isSafeInteger(proposalRev) || proposalRev < 1) throw new SharedLedgerUnavailable();
  if (!isObject(proposer) || (proposer.type !== "person" && proposer.type !== "service")) throw new SharedLedgerUnavailable();
  if (isObject(raw.proposal) && "schemaVersion" in raw.proposal && !speaks(raw.proposal)) throw new Unsupported();
  if (proposalDigest(raw.proposal) !== operation.proposalDigest) throw new SharedLedgerUnavailable();
  const proposal = raw.proposal as FeatureProposal;
  if (!sameScope(operation, scope) || !sameScope(proposal, scope) || proposal.operationId !== operation.operationId) throw new SharedLedgerUnavailable();
  return { proposal, proposalId, proposalRev, proposer: { type: proposer.type, personId: optId(proposer.personId), instanceId: optId(proposer.instanceId) }, operation };
}
const ROOT = "/v1/feature-proposals";
const pathId = (v: string, what: string) => { if (!ID.test(v)) throw new Error(`invalid ${what}`); return v; };

export class SharedLedgerFeatureProposalClient {
  constructor(private connection: SharedLedgerConnection, private key: InstanceKey, private options: SharedLedgerTransportOptions = {}) {}

  private scope(s: FeatureProposalScope): FeatureProposalScope {
    if (s.centerId !== this.connection.centerId || s.teamId !== this.connection.teamId) throw new Error("credential scope mismatch");
    return s;
  }
  private request<T>(method: "GET" | "POST", path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
    return requestSharedLedger({ ...this.connection }, this.key, this.options, method, path, body, undefined, rejection, undefined, parsing(parse))
      .then(raw => checked<T>(raw));
  }

  /** Sends exactly the given body; the returned record must be this operation with the same digest. A center that has
   * this operationId replays it regardless of the clock; same operationId + other digest is a 409 conflict.
   * A first send checks the clock here; a resend (the center may already have it) checks only the shape. */
  async submit(proposal: FeatureProposal, now: number, opts: { resend?: boolean } = {}): Promise<ProposalRecord> {
    const digest = proposalDigest(proposal), body = opts.resend ? proposal : parseFeatureProposal(proposal, now), scope = this.scope(body);
    return this.request("POST", ROOT, body, raw => {
      const r = recordFor(scope, raw);
      if (r.operation.operationId !== body.operationId || r.operation.proposalDigest !== digest) throw new SharedLedgerUnavailable();
      return r;
    });
  }

  /** null = the center has no record of this operation for this caller (N7C answers 403 for both). */
  async status(scope: FeatureProposalScope, operationId: string): Promise<ProposalRecord | null> {
    const s = this.scope(scope);
    pathId(operationId, "operation");
    try {
      return await this.request("GET", `${ROOT}/operations/${operationId}`, undefined, raw => {
        const r = recordFor(s, raw);
        if (r.operation.operationId !== operationId) throw new SharedLedgerUnavailable();
        return r;
      });
    } catch (e) {
      if (e instanceof FeatureProposalRejected && e.status === 403) return null;
      throw e;
    }
  }

  /** The project's proposals as the center lists them for this caller, with the effective approval policy. */
  async listProject(scope: FeatureProposalScope): Promise<ProposalList> {
    const s = this.scope(scope);
    return this.request("GET", `${ROOT}/projects/${pathId(s.projectId, "project")}`, undefined, raw => {
      if (!isObject(raw) || !Array.isArray(raw.proposals)) throw new SharedLedgerUnavailable();
      if (!speaks(raw.policy)) throw new Unsupported();
      const policy = parseProposalPolicy(raw.policy);
      if (!sameScope(policy, s)) throw new SharedLedgerUnavailable();
      return { policy, proposals: raw.proposals.map(p => recordFor(s, p)) };
    });
  }

  /** Forwards one decision for proposalId; the approver is whoever the credential is. Never retried here. */
  async decide(scope: FeatureProposalScope, proposalId: string, decision: ProposalDecision): Promise<ProposalRecord> {
    const d = parseProposalDecision(decision), s = this.scope(scope);
    if (d.proposalId !== proposalId) throw new Error("decision proposalId mismatch"); // the center would 403 it anyway
    return this.request("POST", `${ROOT}/decisions/${pathId(proposalId, "proposal")}`, d, raw => {
      const r = recordFor(s, raw);
      if (r.proposalId !== proposalId) throw new SharedLedgerUnavailable();
      return r;
    });
  }
}
