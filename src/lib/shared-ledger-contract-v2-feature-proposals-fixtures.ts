import type {
  FeatureHomeBind, FeatureProposalNew, FeatureProposalRevise, ProposalDecision, ProposalOperation, ProposalPolicy,
} from "./shared-ledger-contract-v2-feature-proposals.js";

/** Synthetic shared fixtures for N7C (vendored) and N7B: no real peer names, ids, keys or network.
 * `now` is fixed; parse with it. Expected digests are literals so another implementation can check the algorithm.
 */
export const FEATURE_PROPOSAL_FIXTURE_NOW = 1_000_000;
export const FEATURE_PROPOSAL_FIXTURE_DIGESTS = Object.freeze({
  newProposal: "79edaccedfd14fecd6a301c6158e0b67040cdb13f5d49bd8e43408567d797b91",
  reviseProposal: "ebaf7d9856bdc415194948d846b72a459eba75169af90ec78a47a5957ce5331a",
  approvalWithHomeRewrite: "4388803c5a5afb820a7bc4a71bfc2bdea31784ecaa432221f12693800963368f",
});

export function createFeatureProposalFixtures() {
  const now = FEATURE_PROPOSAL_FIXTURE_NOW;
  const scope = { schemaVersion: 1, centerId: "center-demo", teamId: "team-demo", projectId: "project-demo" } as const;
  const nodes = [
    { key: "n1", oneLine: "合成节点一", deps: [], fileGlobs: ["src/demo/*.ts"], estimate: "S" },
    { key: "n2", oneLine: "合成节点二", deps: ["n1"], fileGlobs: ["tests/demo-*.test.ts"], estimate: "M" },
  ];
  const newProposal: FeatureProposalNew = {
    ...scope, operationId: "op-demo-new", kind: "new", title: "合成功能", description: "合成描述",
    ownerWords: null, nodes, homeInstanceId: "instance-demo-a", expiresAt: now + 3_600_000,
  };
  const reviseProposal: FeatureProposalRevise = {
    ...scope, operationId: "op-demo-revise", kind: "revise", featureId: "feature-demo", baseVersion: 3, expectedRev: 7,
    baseDigest: "a".repeat(64), title: "合成功能", description: "合成描述（改）", ownerWords: "合成 owner 原话",
    nodes: [...nodes, { key: "n3", oneLine: "合成节点三", deps: ["n1", "n2"], fileGlobs: [], estimate: "" }],
    homeInstanceId: "instance-demo-a", expiresAt: now + 3_600_000,
  };
  const approve: ProposalDecision = {
    schemaVersion: 1, proposalId: "proposal-demo-1", decision: "approve", proposalDigest: FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal,
    proposalRev: 1, homeInstanceId: "instance-demo-b", reason: "",
  };
  const reject: ProposalDecision = {
    schemaVersion: 1, proposalId: "proposal-demo-2", decision: "reject", proposalDigest: FEATURE_PROPOSAL_FIXTURE_DIGESTS.reviseProposal,
    proposalRev: 2, reason: "合成驳回理由",
  };
  const policies: Record<"default" | "relaxed", ProposalPolicy> = {
    default: { ...scope, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 },
    relaxed: { ...scope, approvers: "member_self_publish", setBy: "person-demo-owner", rev: 1, updatedAt: now },
  };
  const operation = (state: ProposalOperation["state"], extra: Partial<ProposalOperation> = {}): ProposalOperation => ({
    ...scope, operationId: newProposal.operationId, proposalDigest: FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal, state,
    proposalId: "proposal-demo-1", featureId: null, version: null, updatedAt: now, ...extra,
  });
  const operations: ProposalOperation[] = [
    operation("pending_approval"), operation("approved", { featureId: "feature-demo-new" }),
    operation("published", { featureId: "feature-demo-new", version: 1 }), operation("rejected"), operation("expired"),
    operation("conflict", { proposalId: null }),
  ];
  const homeBind: FeatureHomeBind = {
    schemaVersion: 1, featureId: "feature-demo", expectedRev: 8, version: 4, nodeKey: "n3", sourceTaskId: "task-demo-1", operationId: "op-demo-bind",
  };
  return { now, scope, newProposal, reviseProposal, approve, reject, policies, operations, homeBind, invalid: invalidFixtures(newProposal, reviseProposal) };
}

/** Each entry must fail parseFeatureProposal(value, now) with `code`. */
function invalidFixtures(n: FeatureProposalNew, r: FeatureProposalRevise) {
  const now = FEATURE_PROPOSAL_FIXTURE_NOW;
  const { featureId: _f, baseVersion: _b, expectedRev: _e, baseDigest: _d, ...reviseWithoutBase } = r;
  const node = n.nodes[0]!;
  const proposals: { label: string; code: "invalid_field" | "payload_too_large"; value: unknown }[] = [
    { label: "unknown field", code: "invalid_field", value: { ...n, extra: true } },
    { label: "identity in body: personId", code: "invalid_field", value: { ...n, personId: "person-demo" } },
    { label: "identity in body: instanceId", code: "invalid_field", value: { ...n, instanceId: "instance-demo-a" } },
    { label: "title too long", code: "invalid_field", value: { ...n, title: "x".repeat(301) } },
    { label: "empty title", code: "invalid_field", value: { ...n, title: "" } },
    { label: "description too long", code: "invalid_field", value: { ...n, description: "x".repeat(16_001) } },
    { label: "too many nodes", code: "invalid_field", value: { ...n, nodes: Array.from({ length: 201 }, (_, i) => ({ ...node, key: `k${i}` })) } },
    { label: "body too large", code: "payload_too_large", value: { ...n, ownerWords: "x".repeat(16_000), description: "x".repeat(16_000),
      nodes: Array.from({ length: 150 }, (_, i) => ({ ...node, key: `k${i}`, oneLine: "x".repeat(2000) })) } },
    { label: "new with baseVersion", code: "invalid_field", value: { ...n, baseVersion: 1 } },
    { label: "new with featureId", code: "invalid_field", value: { ...n, featureId: "feature-demo" } },
    { label: "revise missing baseVersion", code: "invalid_field", value: { ...r, baseVersion: undefined } },
    { label: "revise missing all base fields", code: "invalid_field", value: reviseWithoutBase },
    { label: "revise baseVersion zero", code: "invalid_field", value: { ...r, baseVersion: 0 } },
    { label: "unknown kind", code: "invalid_field", value: { ...n, kind: "delete" } },
    { label: "duplicate node key", code: "invalid_field", value: { ...n, nodes: [node, node] } },
    { label: "missing dep", code: "invalid_field", value: { ...n, nodes: [{ ...node, deps: ["ghost"] }] } },
    { label: "dependency cycle", code: "invalid_field", value: { ...n, nodes: [{ ...node, key: "a", deps: ["b"] }, { ...node, key: "b", deps: ["a"] }] } },
    { label: "duplicate fileGlob", code: "invalid_field", value: { ...n, nodes: [{ ...node, fileGlobs: ["a/*", "a/*"] }] } },
    { label: "absolute fileGlob", code: "invalid_field", value: { ...n, nodes: [{ ...node, fileGlobs: ["/etc/*"] }] } },
    { label: "expired", code: "invalid_field", value: { ...n, expiresAt: now } },
    { label: "expiry beyond max ttl", code: "invalid_field", value: { ...n, expiresAt: now + 7 * 24 * 3_600_000 + 1 } },
    { label: "expiresAt not integer", code: "invalid_field", value: { ...n, expiresAt: now + 0.5 } },
    { label: "expiresAt string", code: "invalid_field", value: { ...n, expiresAt: String(now + 1000) } },
    { label: "operationId with space", code: "invalid_field", value: { ...n, operationId: "op demo" } },
    { label: "operationId with slash", code: "invalid_field", value: { ...n, operationId: "op/demo" } },
    { label: "operationId leading dash", code: "invalid_field", value: { ...n, operationId: "-op-demo" } },
    { label: "wrong schemaVersion", code: "invalid_field", value: { ...n, schemaVersion: 2 } },
  ];
  return proposals;
}
