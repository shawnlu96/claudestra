import { describe, expect, test } from "bun:test";
import {
  V2_DTO_SCHEMAS, V2_ERROR_STATUS, V2_COMMAND_NAMES, V2_COMMAND_POLICY, V2_SCHEMA_VERSION,
  parseCommand, parseError, parseFence, parseTaskPatch, parseResourceKey, resourceKey, parseCapability,
  parseActor, parseArtifact, parseAsk, parseProposal, parseGeneration, parseLease, parseLendLease,
  parseTask, parseStep, parseWorkflow, parseDependency, parseIntent, assertFence, v2ObjectDigest, resourcesOverlap,
  text, array, id, object, optional, positive, bounded, V2ContractError, type V2DTOs, type V2ErrorCode,
} from "../src/lib/shared-ledger-contract-v2";
import {
  V2_DTO_FIXTURES, V2_COMMAND_FIXTURES, V2_ERROR_FIXTURES, V2_FENCE_FIXTURES, V2_INSTANCE_LABELS,
} from "../src/lib/shared-ledger-contract-v2-fixtures";

const sample = <K extends keyof V2DTOs>(kind: K): V2DTOs[K] => structuredClone(V2_DTO_FIXTURES[kind].valid) as V2DTOs[K];
const invalid = (fn: () => unknown, code: V2ErrorCode = "invalid_field") => {
  try { fn(); throw Error("accepted invalid input"); }
  catch (e) { expect(e).toBeInstanceOf(V2ContractError); expect((e as V2ContractError).code).toBe(code); }
};
describe("V2 frozen DTO/command fixtures", () => {
  test("schema version and public fixture labels", () => {
    expect(V2_SCHEMA_VERSION).toBe(2);
    expect(Object.values(V2_INSTANCE_LABELS)).toEqual(["本机", "peer A", "peer B"]);
    expect(Object.keys(V2_DTO_FIXTURES).sort()).toEqual(Object.keys(V2_DTO_SCHEMAS).sort());
  });
  for (const [name, schema] of Object.entries(V2_DTO_SCHEMAS)) {
    const fixture = V2_DTO_FIXTURES[name as keyof typeof V2_DTO_FIXTURES];
    test(`${name}: legal and illegal fixture, strict unknown/type/required fields`, () => {
      expect(schema(fixture.valid) as unknown).toEqual(fixture.valid);
      expect(() => schema(fixture.invalid)).toThrow();
      for (const value of [null, false, 1, "text", []]) expect(() => schema(value)).toThrow();
      const valid = fixture.valid as Record<string, unknown>;
      for (const key of Object.keys(valid)) {
        const removed = { ...valid }; delete removed[key];
        expect(() => schema(removed)).toThrow();
      }
    });
  }
  test("all commands and error codes have fixtures", () => {
    expect(V2_COMMAND_FIXTURES.map(f => f.type)).toEqual([...V2_COMMAND_NAMES]);
    expect(V2_ERROR_FIXTURES.map(f => f.code).sort()).toEqual((Object.keys(V2_ERROR_STATUS) as V2ErrorCode[]).sort());
    for (const f of V2_ERROR_FIXTURES) {
      expect(parseError(f.valid)).toEqual(f.valid);
      invalid(() => parseError(f.invalid));
      expect(new V2ContractError(f.code as keyof typeof V2_ERROR_STATUS).status).toBe(f.status);
    }
    invalid(() => parseError({ code: "made_up", requestId: null, message: "" }));
  });
  for (const fixture of V2_COMMAND_FIXTURES) {
    test(`${fixture.type}: strict payload and verified identity boundary`, () => {
      expect(parseCommand(fixture.valid)).toEqual(fixture.valid);
      invalid(() => parseCommand(fixture.invalid));
      for (const key of ["actor", "role", "personId", "instanceId", "owner"]) {
        invalid(() => parseCommand({ ...fixture.valid, [key]: "owner" }));
      }
      invalid(() => parseCommand({ ...fixture.valid, epoch: 0 }));
      invalid(() => parseCommand({ ...fixture.valid, serviceGeneration: 0 }));
      invalid(() => parseCommand({ ...fixture.valid, bootId: "" }));
    });
  }
});
test("generic PATCH cannot change execution, authority or arbitrary extra", () => {
  for (const field of ["stage", "head", "headSHA", "homeInstanceId", "epoch", "executor", "authorization", "workflow", "mode", "extra", "specRev"]) {
    invalid(() => parseTaskPatch({ title: "allowed", [field]: "forbidden" }));
  }
  expect(parseTaskPatch({ plan: "shared planning text" })).toEqual({ plan: "shared planning text" });
  invalid(() => parseTaskPatch({}));
  invalid(() => parseTaskPatch({ title: "x".repeat(301) }));
});
test("resource keys are canonical, scoped, and independent of host paths", () => {
  const valid = sample("resourceKey");
  expect(parseResourceKey(valid)).toEqual(valid);
  for (const path of ["/tmp/repo", "C:/repo", "C:\\repo", "\\\\host\\share", "~/repo", "../repo", "src/../secret", "./src", "src//file", "src/%2e%2e/file", "file:", "src\\file"]) {
    invalid(() => parseResourceKey({ ...valid, path }));
  }
  invalid(() => parseResourceKey({ ...valid, repository: "/tmp/repository" }));
  invalid(() => parseResourceKey({ ...valid, kind: "repository" }));
  const first = parseResourceKey(valid);
  expect(resourceKey(first)).not.toBe(resourceKey(parseResourceKey({ ...valid, projectId: "other" })));
  expect(resourcesOverlap(first, parseResourceKey({ ...valid, projectId: "other" }))).toBe(false);
  const wholeRepo = parseResourceKey({ teamId: first.teamId, projectId: first.projectId, repository: first.repository, kind: "repository" });
  expect(resourcesOverlap(first, wholeRepo)).toBe(true);
  expect(resourcesOverlap(first, parseResourceKey({ ...valid, path: "src/other.ts" }))).toBe(false);
  invalid(() => parseResourceKey({ ...valid, path: "src/**" }));
});
test("schemas reject non-wire objects, overflow, control characters and sparse arrays", () => {
  const parser = object({ a: id, n: positive, note: optional(text(10)) });
  for (const n of [-1, 0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) invalid(() => parser({ a: "x", n }));
  invalid(() => parser(Object.create({ a: "x", n: 1 })));
  invalid(() => parser({ a: "x", n: 1, [Symbol("hidden")]: true }));
  invalid(() => parser(Object.defineProperty({ a: "x", n: 1 }, "note", { get: () => "secret", enumerable: true })));
  invalid(() => text(10)("bad\0text"));
  invalid(() => array(id)(new Array(1)));
  invalid(() => bounded(text(1000), 10)("a".repeat(20)), "payload_too_large");
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  invalid(() => bounded(object({}))(cyclic));
});
test("central leases reject changed home, long TTL and backwards times", () => {
  const lease = sample("lease");
  invalid(() => parseLease({ ...lease, holderInstanceId: "peer-b" }));
  invalid(() => parseLease({ ...lease, expiresAt: lease.renewedAt + 60001 }));
  invalid(() => parseLease({ ...lease, renewedAt: 999 }));
  invalid(() => parseLendLease({ ...sample("lendLease"), expiresAt: 1000 }));
  expect(parseFence(V2_FENCE_FIXTURES.valid)).toEqual(V2_FENCE_FIXTURES.valid);
  invalid(() => parseFence(V2_FENCE_FIXTURES.invalid));
  for (const field of ["epoch", "bootId", "serviceGeneration"] as const) {
    const old = V2_FENCE_FIXTURES.valid;
    const supplied = { ...old, [field]: field === "bootId" ? "old-boot" : 2 };
    invalid(() => assertFence(old, supplied), field === "serviceGeneration" ? "stale_generation" : "stale_epoch");
  }
  assertFence(V2_FENCE_FIXTURES.valid, V2_FENCE_FIXTURES.valid);
});
test("restored generation is newer and frozen; backward generation cannot resume", () => {
  const generation = sample("generation");
  const restoredFrom = { serviceGeneration: 1, serverSeq: 9, snapshotDigest: "a".repeat(64) };
  invalid(() => parseGeneration({ ...generation, restoredFrom }));
  invalid(() => parseGeneration({ ...generation, serviceGeneration: 2, restoredFrom }));
  expect(parseGeneration({ ...generation, serviceGeneration: 2, state: "frozen", restoredFrom }).state).toBe("frozen");
  expect(parseGeneration({ ...generation, serviceGeneration: 2, restoredFrom, restoreReconciledAt: 2000 }).state).toBe("active");
});
test("business asks exclude permissions/AUQ and bind answer time/content", () => {
  const ask = sample("ask");
  for (const source of ["permission", "auq", "codex", "reply"]) invalid(() => parseAsk({ ...ask, source }));
  invalid(() => parseAsk({ ...ask, expiresAt: 999 }));
  invalid(() => parseAsk({ ...ask, bind: { ...ask.bind, expiresAt: 100001 } }));
  invalid(() => parseAsk({ ...ask, featureId: "other" }));
  invalid(() => parseAsk({ ...ask, options: [...ask.options, ...ask.options] }));
  const answered = { ...ask, state: "answered", answer: { kind: "option", optionId: "approve" },
    answeredBy: "person", answeredAt: 2000, decision: "approved" };
  expect(parseAsk(answered).answeredBy).toBe("person");
  invalid(() => parseAsk({ ...answered, answeredAt: ask.expiresAt }));
  invalid(() => parseAsk({ ...answered, answer: { kind: "option", optionId: "missing" } }));
  invalid(() => parseAsk({ ...answered, answer: { kind: "text", text: "approve" } }));
});
test("artifact hashes are separate, content-addressed approved copies", () => {
  const artifact = sample("artifact");
  expect(Object.isFrozen(parseArtifact(artifact))).toBe(true);
  expect(artifact.originalDigest).not.toBe(artifact.sharedDigest);
  invalid(() => parseArtifact({ ...artifact, bytes: 5 }));
  invalid(() => parseArtifact({ ...artifact, content: "xxxx" }));
  invalid(() => parseArtifact({ ...artifact, digest: "a".repeat(64) }));
  invalid(() => parseArtifact({ ...artifact, specRev: null }));
  invalid(() => parseArtifact({ ...artifact, path: "/tmp/report" }));
});
test("typed named metadata and scoped service identity cannot carry local privilege", () => {
  invalid(() => parseTask({ ...sample("task"), extra: { arbitrary: true } }));
  invalid(() => parseTask({ ...sample("task"), stage: "blocked" }));
  invalid(() => parseStep({ ...sample("step"), claims: { terminal: "secret" } }));
  invalid(() => parseWorkflow({ ...sample("workflow"), fallback: ["codex", "codex"] }));
  invalid(() => parseDependency({ ...sample("dependency"), toTask: "task" }));
  invalid(() => parseActor({ ...sample("actor"), serviceId: "service" }));
  invalid(() => parseActor({ ...sample("actor"), projects: ["*"] }));
  expect(V2_COMMAND_POLICY["dag.decide"].actor).toBe("owner");
  expect(V2_COMMAND_POLICY["task.set"].actor).toBe("member");
});
test("intent resources/approvals and proposal DAGs are structurally valid", () => {
  const intent = sample("intent"), proposal = sample("proposal");
  invalid(() => parseIntent({ ...intent, action: "merge" }));
  invalid(() => parseIntent({ ...intent, resources: [...intent.resources, ...intent.resources] }));
  invalid(() => parseIntent({ ...intent, resources: [{ ...intent.resources[0], projectId: "other" }] }));
  invalid(() => parseProposal({ ...proposal, version: 4 }));
  expect(() => parseProposal({ ...proposal, nodes: [{ ...proposal.nodes[0], deps: ["write"] }] })).toThrow();
  invalid(() => parseCapability({ enabled: true, code: "forbidden", reason: "" }));
  invalid(() => parseCapability({ enabled: false, code: null, reason: "" }));
  expect(v2ObjectDigest({ a: 1, b: 2 })).toBe(v2ObjectDigest({ b: 2, a: 1 }));
});
