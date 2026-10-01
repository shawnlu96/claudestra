import { describe, expect, test } from "bun:test";
import {
  SharedLedgerError, SHARED_LEDGER_CAPABILITIES, SHARED_LEDGER_COMMANDS, SHARED_LEDGER_DISABLED_ACTIONS,
  SHARED_LEDGER_SCHEMA_VERSION, SHARED_LEDGER_STALE_MS, SHARED_LEDGER_ERROR_STATUS,
} from "../src/lib/shared-ledger-contract.js";
import { parseSharedLedgerCommand, parseSharedLedgerEnvelope, assertSharedLedgerMutation } from "../src/lib/shared-ledger-contract-validation.js";
import { parseSharedLedgerResponse } from "../src/lib/shared-ledger-contract-responses.js";
import { parseSharedLedgerImport, parseSharedLedgerProjection, sharedLedgerManifestDigest, sharedLedgerProjectionDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import { sharedLedgerCommandDigest } from "../src/lib/shared-ledger-auth.js";
import * as fixtures from "../src/lib/shared-ledger-contract-fixtures.js";

const commands = fixtures.SHARED_LEDGER_COMMAND_FIXTURES;
function rejected(fn: () => unknown, code: SharedLedgerError["code"] = "invalid_field") {
  try { fn(); throw new Error("unexpected success"); }
  catch (e) { expect(e).toBeInstanceOf(SharedLedgerError); expect((e as SharedLedgerError).code).toBe(code); }
}

describe("frozen V1 fixtures", () => {
  test("all request/response fixtures validate with matching digests and versions", () => {
    expect(commands.map((c) => parseSharedLedgerEnvelope(c, parseSharedLedgerCommand).payload.type)).toEqual([...SHARED_LEDGER_COMMANDS]);
    const transfers = [
      parseSharedLedgerEnvelope(fixtures.SHARED_LEDGER_IMPORT_FIXTURE, parseSharedLedgerImport),
      parseSharedLedgerEnvelope(fixtures.SHARED_LEDGER_PROJECTION_FIXTURE, parseSharedLedgerProjection),
    ];
    expect(transfers).toHaveLength(2);
    const checks = {
      features: fixtures.SHARED_LEDGER_LIST_FIXTURE, feature: fixtures.SHARED_LEDGER_FEATURE_FIXTURE,
      command: fixtures.SHARED_LEDGER_RESULT_FIXTURE, receipt: fixtures.SHARED_LEDGER_RECEIPT_FIXTURE,
      error: fixtures.SHARED_LEDGER_CONFLICT_FIXTURE, import: fixtures.SHARED_LEDGER_IMPORT_RESULT_FIXTURE,
      projection: fixtures.SHARED_LEDGER_PROJECTION_RESULT_FIXTURE,
    };
    for (const kind of Object.keys(checks) as (keyof typeof checks)[]) expect(parseSharedLedgerResponse(kind, checks[kind])).toEqual(checks[kind]);
    expect(parseSharedLedgerResponse("receipt", fixtures.SHARED_LEDGER_UNKNOWN_RECEIPT_FIXTURE)).toEqual(fixtures.SHARED_LEDGER_UNKNOWN_RECEIPT_FIXTURE);
    expect(sharedLedgerCommandDigest(commands[3])).toBe(fixtures.SHARED_LEDGER_RESULT_FIXTURE.commandDigest);
    expect(sharedLedgerManifestDigest(fixtures.SHARED_LEDGER_IMPORT_FIXTURE.payload.manifest)).toBe(fixtures.SHARED_LEDGER_IMPORT_RESULT_FIXTURE.manifestDigest);
    expect(sharedLedgerProjectionDigest(fixtures.SHARED_LEDGER_PROJECTION_FIXTURE.payload)).toBe(fixtures.SHARED_LEDGER_PROJECTION_RESULT_FIXTURE.digest);
    expect(fixtures.SHARED_LEDGER_RESULT_FIXTURE.result).toEqual({ featureId: "feature-a", rev: 8, version: 2 });
    const detail = parseSharedLedgerResponse("feature", fixtures.SHARED_LEDGER_FEATURE_FIXTURE);
    expect(detail.dag.bindings[0].taskId).toBe(detail.tasks[0].taskId);
    expect(detail.tasks[0].sourceTaskId).not.toBe(detail.tasks[0].taskId);
  });
  test("execution capabilities carry disabled reasons; schema and freshness are explicit", () => {
    expect(SHARED_LEDGER_SCHEMA_VERSION).toBe(1);
    expect(SHARED_LEDGER_STALE_MS).toBe(30_000);
    for (const action of SHARED_LEDGER_DISABLED_ACTIONS) {
      expect(SHARED_LEDGER_CAPABILITIES[action]).toMatchObject({ enabled: false, code: "execution_not_shared" });
      expect(SHARED_LEDGER_CAPABILITIES[action].reason.length).toBeGreaterThan(0);
    }
  });
  test("all errors have stable HTTP status, and conflicts require a coherent authorized snapshot", () => {
    for (const code of Object.keys(SHARED_LEDGER_ERROR_STATUS) as SharedLedgerError["code"][]) {
      const status = SHARED_LEDGER_ERROR_STATUS[code];
      expect(new SharedLedgerError(code).status).toBe(status);
      if (code !== "conflict") expect(parseSharedLedgerResponse("error", { code, status, message: code }).code).toBe(code);
    }
    rejected(() => parseSharedLedgerResponse("error", { ...fixtures.SHARED_LEDGER_CONFLICT_FIXTURE, currentRev: 999 }));
    rejected(() => parseSharedLedgerResponse("error", { code: "conflict", status: 409 }));
    rejected(() => parseSharedLedgerResponse("error", { code: "forbidden", status: 200, message: "bad" }));
  });
});

describe("strict planning write whitelist", () => {
  test("unknown commands and extra fields at every nesting level are rejected", () => {
    rejected(() => parseSharedLedgerCommand({ ...commands[0].payload, type: "sql" }));
    for (const extra of ["stage", "head", "actor", "role", "owner", "extra", "authorityMode", "__proto__", "constructor"]) {
      rejected(() => parseSharedLedgerCommand({ ...commands[0].payload, [extra]: "owner" }));
    }
    rejected(() => parseSharedLedgerCommand({ ...commands[1].payload, patch: { title: "valid", stage: "done" } }));
    rejected(() => parseSharedLedgerCommand({ ...commands[1].payload, patch: {} }));
    rejected(() => parseSharedLedgerCommand({ ...commands[2].payload, nodes: [{ key: "x", taskId: "injected", oneLine: "x", deps: [], fileGlobs: [], estimate: "" }] }));
    rejected(() => parseSharedLedgerEnvelope({ ...commands[0], role: "owner" }, parseSharedLedgerCommand));
  });
  test("execution operations and scopeChange fail with execution_not_shared", () => {
    for (const type of [...SHARED_LEDGER_DISABLED_ACTIONS, "task.set", "task.start", "task.stage", "dag.approve", "dag.scopeChange", "start_node"]) {
      rejected(() => parseSharedLedgerCommand({ requestId: "a", type }), "execution_not_shared");
    }
    for (const scopeChange of [true, false]) rejected(() => parseSharedLedgerCommand({ ...commands[3].payload, scopeChange }), "execution_not_shared");
  });
  test("CAS/request identity fields are mandatory, finite integers and not coerced", () => {
    for (const field of ["requestId", "projectId", "expectedRev", "baseVersion"]) {
      const bad: Record<string, unknown> = { ...commands[3].payload };
      delete bad[field];
      rejected(() => parseSharedLedgerCommand(bad));
    }
    for (const expectedRev of [-1, 0, 1.5, NaN, Infinity, 2 ** 53, "7"]) rejected(() => parseSharedLedgerCommand({ ...commands[3].payload, expectedRev }));
    rejected(() => parseSharedLedgerCommand({ ...commands[2].payload, baseVersion: 1 }));
    rejected(() => parseSharedLedgerCommand({ ...commands[3].payload, baseVersion: 0 }));
    rejected(() => parseSharedLedgerCommand(Object.create(commands[0].payload)));
  });
  test("DAG rejects missing refs, cycles, duplicate keys/deps and absolute or parent-relative file paths", () => {
    const node = { key: "a", oneLine: "a", deps: [] as string[], fileGlobs: [], estimate: "" };
    for (const nodes of [[node, node], [{ ...node, deps: ["unknown"] }], [{ ...node, deps: ["a"] }],
      [{ ...node, deps: ["b"] }, { ...node, key: "b", deps: ["a"] }],
      [node, { ...node, key: "b", deps: ["a", "a"] }]]) rejected(() => parseSharedLedgerCommand({ ...commands[2].payload, nodes }));
    for (const file of ["/Users/private/repo", "../secret", "src/../secret", "C:/secret", "~/secret", "src\\secret"]) {
      rejected(() => parseSharedLedgerCommand({ ...commands[2].payload, nodes: [{ ...node, fileGlobs: [file] }] }));
    }
  });
  test("bound node content/deps/estimate/files and bindings remain frozen; free nodes can change", () => {
    const current = structuredClone(fixtures.SHARED_LEDGER_FEATURE_FIXTURE);
    const cmd = parseSharedLedgerCommand(commands[3].payload);
    expect(() => assertSharedLedgerMutation(cmd, current, false)).not.toThrow();
    if (cmd.type !== "dag.rewrite") throw new Error("fixture type");
    for (const patch of [{ oneLine: "changed" }, { estimate: "9h" }, { fileGlobs: ["other/**"] }, { deps: ["C2"] }]) {
      rejected(() => assertSharedLedgerMutation({ ...cmd, nodes: [{ ...cmd.nodes[0], ...patch }, cmd.nodes[1]] }, current, false), "execution_not_shared");
    }
    rejected(() => assertSharedLedgerMutation({ ...cmd, nodes: [] }, current, false), "execution_not_shared");
    rejected(() => assertSharedLedgerMutation({ ...cmd, expectedRev: 1 }, current, false), "conflict");
    rejected(() => assertSharedLedgerMutation({ ...cmd, baseVersion: 2 }, current, false), "conflict");
    rejected(() => assertSharedLedgerMutation(cmd, current, true), "pending_proposal");
    rejected(() => assertSharedLedgerMutation({ ...cmd, projectId: "other" }, current, false), "forbidden");
    current.feature.authorityMode = "source";
    rejected(() => assertSharedLedgerMutation(cmd, current, false), "execution_not_shared");
  });
  test("inconsistent response versions, execution authority and extra response fields fail validation", () => {
    const f = structuredClone(fixtures.SHARED_LEDGER_FEATURE_FIXTURE);
    f.dag.version = 3;
    rejected(() => parseSharedLedgerResponse("feature", f));
    rejected(() => parseSharedLedgerResponse("features", { ...fixtures.SHARED_LEDGER_LIST_FIXTURE, localPath: "/private" }));
    rejected(() => parseSharedLedgerResponse("features", { ...fixtures.SHARED_LEDGER_LIST_FIXTURE,
      features: [{ ...f.feature, authorityMode: "execution" }] }));
  });
});

describe("import and read-only projection boundaries", () => {
  test("dry-run/commit share manifest identity and reject digest tampering", () => {
    const imported = fixtures.SHARED_LEDGER_IMPORT_FIXTURE.payload;
    expect(parseSharedLedgerImport({ ...imported, mode: "commit" }).manifestDigest).toBe(imported.manifestDigest);
    rejected(() => parseSharedLedgerImport({ ...imported, manifestDigest: "0".repeat(64) }));
    const changed = structuredClone(imported);
    changed.manifest.features[0].title = "changed";
    rejected(() => parseSharedLedgerImport(changed));
  });
  test("pending proposals, unknown fields, discontinuous versions and missing bindings reject entire import", () => {
    for (const mutate of [
      (v: any) => { v.manifest.features[0].versions[0].version = 2; },
      (v: any) => { v.manifest.features[0].versions[0].bindings[0].taskId = "missing"; },
      (v: any) => { v.manifest.features[0].projection.tasks[0].deps = ["missing"]; },
      (v: any) => { v.manifest.features[0].projection.tasks[0].extra = { token: "secret" }; },
      (v: any) => { v.manifest.features[0].authorityMode = "execution"; },
    ]) {
      const value = structuredClone(fixtures.SHARED_LEDGER_IMPORT_FIXTURE.payload);
      mutate(value);
      rejected(() => parseSharedLedgerImport(value));
    }
    const pending = structuredClone(fixtures.SHARED_LEDGER_IMPORT_FIXTURE.payload) as any;
    pending.manifest.features[0].pendingProposal = true;
    rejected(() => parseSharedLedgerImport(pending), "pending_proposal");
  });
  test("projection digest ignores observation time, but includes independent step revisions and source watermarks", () => {
    const value = structuredClone(fixtures.SHARED_LEDGER_PROJECTION_FIXTURE.payload);
    const digest = sharedLedgerProjectionDigest(value);
    value.observedAt += 1000;
    expect(sharedLedgerProjectionDigest(value)).toBe(digest);
    value.tasks[0].steps[0].sourceRev++;
    expect(sharedLedgerProjectionDigest(value)).not.toBe(digest);
    value.sourceSeq++;
    expect(sharedLedgerProjectionDigest(value)).not.toBe(digest);
  });
  test("projection whitelist rejects raw data, steps beyond watermark and rollback within a batch", () => {
    const value = fixtures.SHARED_LEDGER_PROJECTION_FIXTURE.payload;
    rejected(() => parseSharedLedgerProjection({ ...value, dag: [] }));
    rejected(() => parseSharedLedgerProjection({ ...value, previousSourceSeq: 31 }));
    rejected(() => parseSharedLedgerProjection({ ...value, tasks: [{ ...value.tasks[0], sourceSeq: 31 }] }));
    rejected(() => parseSharedLedgerProjection({ ...value, tasks: [{ ...value.tasks[0],
      steps: [{ sourceStepId: "step-a", sourceRev: 3, sourceSeq: 31, state: "done" }] }] }));
    rejected(() => parseSharedLedgerProjection({ ...value, events: [{ ...value.events[0], data: { raw: "unfiltered" } }] }));
  });
});
