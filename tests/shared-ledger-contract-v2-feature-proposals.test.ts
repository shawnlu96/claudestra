import { describe, expect, test } from "bun:test";
import {
  FEATURE_PROPOSAL_ERROR_REASONS, FEATURE_PROPOSAL_LIMITS, FEATURE_PROPOSAL_SCHEMA_VERSION, PROPOSAL_APPROVERS, PROPOSAL_OPERATION_STATES,
  FEATURE_BASE_DIGEST_FIELDS, classifyProposalOperation, defaultProposalPolicy, featureBaseDigest, featureProposalError, parseFeatureHomeBind, parseFeatureProposal,
  parseFeatureProposalError, parseProposalDecision, parseProposalOperation, parseProposalPolicy, proposalApprovalDigest,
  proposalDigest, proposedVersion,
} from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import {
  FEATURE_PROPOSAL_FIXTURE_DIGESTS, FEATURE_PROPOSAL_FIXTURE_NOW, createFeatureProposalFixtures,
} from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import { SHARED_LEDGER_ERROR_STATUS, type SharedLedgerErrorCode } from "../src/lib/shared-ledger-contract.js";
import { V2ContractError, type V2ErrorCode } from "../src/lib/shared-ledger-contract-v2-validation.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";

function invalid(fn: () => unknown, code: V2ErrorCode = "invalid_field") {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(V2ContractError);
  expect((caught as V2ContractError).code).toBe(code);
  expect((caught as Error).message).toBe(code);
}
const reversed = (o: object) => Object.fromEntries(Object.entries(o).reverse());
const now = FEATURE_PROPOSAL_FIXTURE_NOW;

describe("P1-1 strict parsers: positive round-trip", () => {
  test("proposal new/revise round-trip field by field", () => {
    const f = createFeatureProposalFixtures();
    for (const p of [f.newProposal, f.reviseProposal]) {
      const parsed = parseFeatureProposal(JSON.parse(JSON.stringify(p)), now);
      expect(parsed).toEqual(p);
      for (const key of Object.keys(p)) expect((parsed as Record<string, unknown>)[key]).toEqual((p as Record<string, unknown>)[key]);
    }
    expect(f.newProposal.schemaVersion).toBe(FEATURE_PROPOSAL_SCHEMA_VERSION);
    expect(proposedVersion(f.newProposal)).toBe(1);
    expect(proposedVersion(f.reviseProposal)).toBe(4);
    expect(parseFeatureProposal({ ...f.newProposal, nodes: [] }, now).nodes).toEqual([]);
  });
  test("decision, policy, operation, home bind, error round-trip", () => {
    const f = createFeatureProposalFixtures();
    for (const d of [f.approve, f.reject, { ...f.approve, homeInstanceId: undefined }]) expect(parseProposalDecision(d)).toEqual(d);
    expect(parseProposalPolicy(f.policies.default)).toEqual(f.policies.default);
    expect(parseProposalPolicy(f.policies.relaxed)).toEqual(f.policies.relaxed);
    expect(f.operations.map(o => o.state)).toEqual([...PROPOSAL_OPERATION_STATES]);
    for (const o of f.operations) expect(parseProposalOperation(o)).toEqual(o);
    expect(parseFeatureHomeBind(f.homeBind)).toEqual(f.homeBind);
    for (const code of Object.keys(SHARED_LEDGER_ERROR_STATUS) as SharedLedgerErrorCode[]) {
      const e = featureProposalError(code);
      expect(parseFeatureProposalError(e)).toEqual(e);
      expect(e.status).toBe(SHARED_LEDGER_ERROR_STATUS[code]);
    }
  });
});

describe("P1-1 strict parsers: negative cases", () => {
  test("shared invalid proposal fixtures all fail with their code", () => {
    const f = createFeatureProposalFixtures();
    expect(f.invalid.length).toBeGreaterThan(20);
    for (const probe of f.invalid) invalid(() => parseFeatureProposal(probe.value, now), probe.code);
  });
  test("every required proposal field is required; non-JSON shapes fail", () => {
    const f = createFeatureProposalFixtures();
    for (const p of [f.newProposal, f.reviseProposal]) {
      for (const key of Object.keys(p)) {
        const missing: Record<string, unknown> = { ...p }; delete missing[key];
        invalid(() => parseFeatureProposal(missing, now));
      }
      for (const bad of [null, [], "x", 1, Object.create(p), Object.defineProperty({ ...p }, "hidden", { value: 1 })]) {
        invalid(() => parseFeatureProposal(bad, now));
      }
    }
  });
  test("bad clock input is rejected", () => {
    const f = createFeatureProposalFixtures();
    for (const bad of [-1, 1.5, NaN]) invalid(() => parseFeatureProposal(f.newProposal, bad));
  });
  test("decision: unknown field, identity, reject with home rewrite or empty reason, bad digest", () => {
    const f = createFeatureProposalFixtures();
    for (const bad of [
      { ...f.approve, approvedBy: "person-demo" }, { ...f.approve, personId: "person-demo" }, { ...f.approve, decision: "maybe" },
      { ...f.reject, homeInstanceId: "instance-demo-b" }, { ...f.reject, reason: "" }, { ...f.approve, proposalDigest: "A".repeat(64) },
      { ...f.approve, proposalRev: 0 }, { ...f.approve, reason: "x".repeat(FEATURE_PROPOSAL_LIMITS.reason + 1) },
    ]) invalid(() => parseProposalDecision(bad));
  });
  test("policy: default is project_owner; relaxation needs a signing owner", () => {
    const f = createFeatureProposalFixtures();
    expect(PROPOSAL_APPROVERS[0]).toBe("project_owner");
    const { schemaVersion: _v, ...scope } = f.scope;
    expect(defaultProposalPolicy(scope)).toEqual(f.policies.default);
    for (const bad of [
      { ...f.policies.relaxed, setBy: null }, { ...f.policies.relaxed, rev: 0 }, { ...f.policies.default, setBy: "person-demo-owner" },
      { ...f.policies.default, approvers: "anyone" }, { ...f.policies.default, approvers: ["project_owner"] },
    ]) invalid(() => parseProposalPolicy(bad));
    expect(parseProposalPolicy({ ...f.policies.relaxed, approvers: "project_owner", rev: 2 }).setBy).toBe("person-demo-owner");
  });
  test("operation: state/field consistency", () => {
    const f = createFeatureProposalFixtures();
    const [pending, , published] = f.operations;
    for (const bad of [
      { ...pending!, proposalId: null }, { ...pending!, version: 1 }, { ...published!, version: null }, { ...published!, featureId: null },
      { ...pending!, state: "done" }, { ...pending!, operationId: "op demo" },
    ]) invalid(() => parseProposalOperation(bad));
  });
  test("home bind and error: unknown field, wrong status, echoed reason", () => {
    const f = createFeatureProposalFixtures();
    for (const bad of [{ ...f.homeBind, extra: 1 }, { ...f.homeBind, expectedRev: 0 }, { ...f.homeBind, nodeKey: "a b" }]) {
      invalid(() => parseFeatureHomeBind(bad));
    }
    const e = featureProposalError("forbidden");
    for (const bad of [{ ...e, status: 404 }, { ...e, reason: "op demo/../secret" }, { ...e, code: "teapot" }, { ...e, detail: "x" }]) {
      invalid(() => parseFeatureProposalError(bad));
    }
    for (const reason of Object.values(FEATURE_PROPOSAL_ERROR_REASONS)) expect(reason.length).toBeGreaterThan(0);
  });
});

describe("P1-2 digest stability", () => {
  test("fixture digests are the frozen literals", () => {
    const f = createFeatureProposalFixtures();
    expect(proposalDigest(f.newProposal)).toBe(FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal);
    expect(proposalDigest(f.reviseProposal)).toBe(FEATURE_PROPOSAL_FIXTURE_DIGESTS.reviseProposal);
    expect(proposalApprovalDigest(f.newProposal, f.approve)).toBe(FEATURE_PROPOSAL_FIXTURE_DIGESTS.approvalWithHomeRewrite);
  });
  test("field order does not change the digest (top level and inside nodes)", () => {
    const f = createFeatureProposalFixtures();
    for (const p of [f.newProposal, f.reviseProposal]) {
      expect(proposalDigest({ ...reversed(p), nodes: p.nodes.map(reversed) })).toBe(proposalDigest(p));
    }
  });
  test("changing any content field changes the digest", () => {
    const f = createFeatureProposalFixtures();
    const p = f.reviseProposal, base = proposalDigest(p);
    const changes: Record<string, unknown> = {
      centerId: "center-other", teamId: "team-other", projectId: "project-other", operationId: "op-other", featureId: "feature-other",
      baseVersion: 4, expectedRev: 8, baseDigest: "b".repeat(64), title: "其它", description: "其它", ownerWords: null,
      homeInstanceId: "instance-other", expiresAt: p.expiresAt + 1, nodes: p.nodes.slice(0, 2),
    };
    const seen = new Set([base]);
    for (const [key, value] of Object.entries(changes)) {
      const d = proposalDigest({ ...p, [key]: value });
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
    expect(Object.keys(changes).sort()).toEqual(Object.keys(p).filter(k => !["schemaVersion", "kind"].includes(k)).sort());
    const node = p.nodes[2]!;
    for (const edit of [{ deps: ["n1"] }, { fileGlobs: ["src/other/*.ts"] }, { oneLine: "改" }, { estimate: "L" }]) {
      const d = proposalDigest({ ...p, nodes: [p.nodes[0], p.nodes[1], { ...node, ...edit }] });
      expect(seen.has(d)).toBe(false);
      seen.add(d);
    }
    expect(proposalDigest({ ...f.newProposal, ownerWords: "" })).not.toBe(proposalDigest(f.newProposal));
  });
  test("identity fields cannot enter the body or the digest", () => {
    const f = createFeatureProposalFixtures();
    for (const key of ["personId", "serviceId", "instanceId", "proposedBy", "caller"]) {
      invalid(() => proposalDigest({ ...f.newProposal, [key]: "person-demo" }));
      invalid(() => parseFeatureProposal({ ...f.newProposal, [key]: "person-demo" }, now));
    }
  });
  test("approval digest binds home rewrite and the exact proposal digest", () => {
    const f = createFeatureProposalFixtures();
    const withRewrite = proposalApprovalDigest(f.newProposal, f.approve);
    const { homeInstanceId: _h, ...noRewrite } = f.approve;
    const plain = proposalApprovalDigest(f.newProposal, noRewrite);
    expect(plain).not.toBe(withRewrite);
    expect(proposalApprovalDigest(f.newProposal, { ...noRewrite, homeInstanceId: f.newProposal.homeInstanceId })).toBe(plain);
    invalid(() => proposalApprovalDigest(f.reviseProposal, f.approve));
    invalid(() => proposalApprovalDigest(f.newProposal, { ...f.reject, proposalDigest: f.approve.proposalDigest }));
  });
  test("same operationId: same digest replays, different digest conflicts", () => {
    const f = createFeatureProposalFixtures();
    const op = f.operations[0]!;
    expect(classifyProposalOperation(null, proposalDigest(f.newProposal))).toBe("new");
    expect(classifyProposalOperation(op, proposalDigest(f.newProposal))).toBe("replay");
    expect(classifyProposalOperation(op, proposalDigest({ ...f.newProposal, title: "改" }))).toBe("conflict");
    invalid(() => classifyProposalOperation(op, "not-a-digest"));
  });
});

describe("N7KD featureBaseDigest: revision base ignores progress fields", () => {
  const detail = () => createFeatureProposalFixtures().baseDetail;
  test("AC1 fixture detail digests to the fixture's expected value", () => {
    const d = detail(), { feature: f } = d;
    const planning = { id: f.id, projectId: f.projectId, title: f.title, description: f.description, rev: f.rev, version: f.version,
      authorityMode: f.authorityMode, homeInstanceId: f.homeInstanceId };
    expect(featureBaseDigest(d)).toBe(v2ObjectDigest({ feature: planning, dag: d.dag }));
    expect(featureBaseDigest(d)).toBe(FEATURE_PROPOSAL_FIXTURE_DIGESTS.featureBase);
    expect(Object.keys(planning).sort()).toEqual([...FEATURE_BASE_DIGEST_FIELDS].sort());
  });
  test("AC2 progress / projection fields alone never change the digest", () => {
    const d = detail(), base = featureBaseDigest(d);
    const progress = [
      { executorInstanceIds: [] }, { executorInstanceIds: ["instance-demo-a", "instance-demo-b"] }, { status: "done" as const },
      { counts: { total: 2, completed: 2, blocked: 0, missing: 0 } }, { projection: null },
      { projection: { ...d.feature.projection!, sourceSeq: 99, observedAt: now + 1, receivedAt: now + 2 } },
      { updatedBy: "person-demo-other" }, { updatedAt: now + 60_000 },
    ];
    for (const change of progress) expect(featureBaseDigest({ ...d, feature: { ...d.feature, ...change } })).toBe(base);
  });
  test("AC3 planning fields and every dag part change the digest", () => {
    const d = detail(), base = featureBaseDigest(d);
    const planning = [
      { title: "合成功能（改）" }, { description: "" }, { rev: 8 }, { version: 4 }, { authorityMode: "source" as const },
      { homeInstanceId: "instance-demo-b", projection: { ...d.feature.projection!, sourceInstanceId: "instance-demo-b" } },
    ];
    for (const change of planning) expect(featureBaseDigest({ ...d, feature: { ...d.feature, ...change } })).not.toBe(base);
    const dags = [
      { ...d.dag, version: 4 }, { ...d.dag, bindings: [] }, { ...d.dag, bindings: [...d.dag.bindings, { nodeKey: "n2", taskId: "task-demo-2" }] },
      { ...d.dag, nodes: [d.dag.nodes[0]!] }, { ...d.dag, nodes: [{ ...d.dag.nodes[0]!, oneLine: "改" }, d.dag.nodes[1]!] },
    ];
    for (const dag of dags) expect(featureBaseDigest({ ...d, dag })).not.toBe(base);
  });
  test("AC4 key order does not change the digest", () => {
    const d = detail();
    const shuffled = { dag: { ...reversed(d.dag), nodes: d.dag.nodes.map(reversed), bindings: d.dag.bindings.map(reversed) },
      feature: { ...reversed(d.feature), counts: reversed(d.feature.counts), projection: reversed(d.feature.projection!) } };
    expect(featureBaseDigest(shuffled as typeof d)).toBe(featureBaseDigest(d));
  });
  test("AC5 invalid detail throws instead of digesting", () => {
    const d = detail(), { title: _t, ...noTitle } = d.feature, { bindings: _b, ...noBindings } = d.dag;
    const bad: unknown[] = [
      null, {}, { feature: d.feature }, { dag: d.dag }, { ...d, extra: 1 },
      { ...d, feature: noTitle }, { ...d, feature: { ...d.feature, extra: 1 } }, { ...d, feature: { ...d.feature, rev: "7" } },
      { ...d, feature: { ...d.feature, status: "paused" } }, { ...d, feature: { ...d.feature, homeInstanceId: "bad id" } },
      { ...d, feature: { ...d.feature, projection: { ...d.feature.projection!, sourceInstanceId: "instance-demo-b" } } },
      { ...d, dag: noBindings }, { ...d, dag: { ...d.dag, extra: 1 } }, { ...d, dag: { ...d.dag, version: -1 } },
      { ...d, dag: { ...d.dag, nodes: [{ ...d.dag.nodes[0]!, deps: ["ghost"] }] } },
    ];
    for (const value of bad) invalid(() => featureBaseDigest(value as typeof d));
  });
});

describe("P1-3 shared fixtures are synthetic", () => {
  test("no real peer names, hosts or ids", () => {
    const text = JSON.stringify(createFeatureProposalFixtures());
    expect(text).not.toMatch(/MacBook|\.local\b|@|https?:|\/Users\/|peer:/i);
    const ids = [...text.matchAll(/"(?:centerId|teamId|projectId|operationId|featureId|homeInstanceId|proposalId|setBy|sourceTaskId)":"([^"]+)"/g)];
    expect(ids.length).toBeGreaterThan(10);
    for (const [, value] of ids) expect(value).toMatch(/demo|other/);
  });
});
