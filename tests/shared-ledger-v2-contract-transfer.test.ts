import { expect, test } from "bun:test";
import {
  parseDTO, type V2DTOs, type V2Snapshot, type V2MigrationManifest, type V2Event,
  parseSnapshot, parseMigrationManifest, parseMigration, parseMigrationResult,
  parseIdMapping, parseReceiptLookup, parseCapabilities, capabilities, parseEvent, assertRows, executionRows,
  V2_COMMAND_SCHEMAS, V2_COMMAND_NAMES, V2_LEASE_MS, V2_RENEW_MS, v2ManifestDigest, parseCommand,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES, V2_COMMAND_FIXTURES, V2_ERROR_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures";
const sample = <K extends keyof V2DTOs>(kind: K): V2DTOs[K] => structuredClone(V2_DTO_FIXTURES[kind].valid) as V2DTOs[K];
function manifest(): V2MigrationManifest { return sample("migrationManifest"); }
function resign<T extends { manifestDigest: string }>(value: T): T { value.manifestDigest = v2ManifestDigest(value); return value; }
test("typed DTO registry and named command schemas match parser entry points", () => {
  const task: V2DTOs["task"] = parseDTO("task", sample("task"));
  expect(task.homeInstanceId).toBe("local");
  for (const f of V2_COMMAND_FIXTURES) {
    expect(V2_COMMAND_SCHEMAS[f.type](f.valid)).toEqual(parseCommand(f.valid));
  }
  expect(V2_LEASE_MS).toBe(60000); expect(V2_RENEW_MS).toBe(15000);
  expect(Object.keys(executionRows)).toContain("resources");
  for (const f of V2_ERROR_FIXTURES) expect(() => parseDTO("task", f.invalid)).toThrow();
});
test("snapshot rows share one authorized project and one service sequence", () => {
  const snapshot: V2Snapshot = sample("snapshot");
  expect(parseSnapshot(snapshot).tasks.length).toBe(1);
  expect(() => parseSnapshot({ ...snapshot, serverSeq: 0 })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, tasks: [{ ...snapshot.tasks[0], projectId: "other" }] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, events: [{ ...snapshot.events[0], seq: 2 }] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, receipts: [{ ...snapshot.receipts[0], projectId: "other" }] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, events: [...snapshot.events, ...snapshot.events] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, receipts: [...snapshot.receipts, ...snapshot.receipts] })).toThrow();
  assertRows(parseSnapshot(snapshot), "team", "project");
});
test("snapshot referential integrity rejects orphaned rows and local/source identities", () => {
  const snapshot = sample("snapshot");
  for (const key of ["features", "tasks", "items", "intents", "lendOrders"]) {
    expect(() => parseSnapshot({ ...snapshot, [key]: [] })).toThrow();
  }
  expect(() => parseSnapshot({ ...snapshot, asks: [{ ...snapshot.asks[0], taskId: "missing", bind: { ...snapshot.asks[0].bind, taskId: "missing" } }] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, dags: [{ featureId: "feature", dag: { ...snapshot.dags[0].dag,
    bindings: [{ nodeKey: "write", taskId: "missing" }] } }] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, resources: [{ ...snapshot.resources[0], operationId: "wrong" }] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, lendClaims: [{ ...snapshot.lendClaims[0], taskId: "missing" }] })).toThrow();
  for (const delta of [{ leaseGen: 2 }, { specRev: 2 }, { round: 1 }, { epoch: 2 }, { head: "c".repeat(40) }]) {
    expect(() => parseSnapshot({ ...snapshot, lendClaims: [{ ...snapshot.lendClaims[0], ...delta }] })).toThrow();
  }
  expect(() => parseSnapshot({ ...snapshot, resources: [{ ...snapshot.resources[0], epoch: 2 }] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, dags: [] })).toThrow();
});
test("dependency cycles, duplicate rows and duplicate locks cannot enter snapshots", () => {
  const snapshot = sample("snapshot");
  expect(() => parseSnapshot({ ...snapshot, tasks: [...snapshot.tasks, ...snapshot.tasks] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, steps: [...snapshot.steps, ...snapshot.steps] })).toThrow();
  expect(() => parseSnapshot({ ...snapshot, resources: [...snapshot.resources, ...snapshot.resources] })).toThrow();
  const taskTwo = { ...snapshot.tasks[0], id: "task-two" };
  const dep = sample("dependency");
  const cyclic = { ...snapshot, tasks: [...snapshot.tasks, taskTwo], dependencies: [dep, { ...dep, fromTask: "task-two", toTask: "task" }] };
  expect(() => parseSnapshot(cyclic)).toThrow();
  expect(parseSnapshot({ ...cyclic, dependencies: [dep] }).dependencies.length).toBe(1);
});
test("unknown operation keeps its resources even without a live scheduler lease", () => {
  const snapshot = sample("snapshot");
  const unknown = { ...snapshot, intents: [{ ...snapshot.intents[0], status: "unknown" }],
    resources: [{ ...snapshot.resources[0], state: "unknown" }] };
  expect(parseSnapshot(unknown).leases).toEqual([]);
  expect(() => parseSnapshot({ ...unknown, resources: [] })).toThrow();
  expect(() => parseSnapshot({ ...unknown, resources: snapshot.resources })).toThrow();
});
test("migration is an entire fenced feature group with complete mappings and approved material", () => {
  const m = manifest();
  expect(parseMigrationManifest(m).featureIds).toEqual(["feature"]);
  expect(parseMigration({ mode: "dry-run", manifest: m }).mode).toBe("dry-run");
  for (const key of ["dispatchPaused", "workersSettled", "unknownReconciled", "specsComplete", "reviewsComplete", "localWriteGateInstalled", "leasesMustBeAcquired"]) {
    expect(() => parseMigrationManifest(resign({ ...m, evidence: { ...m.evidence, [key]: false } }))).toThrow();
  }
  expect(() => parseMigrationManifest(resign({ ...m, featureIds: [] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, featureIds: ["other"] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, leases: [sample("lease")] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, proposals: [sample("proposal")] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, tasks: [sample("task")] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, mappings: m.mappings.slice(1) }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, mappings: [...m.mappings, m.mappings[0]] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, mappings: [{ ...m.mappings[0], sourceInstanceId: "peer-a" }, ...m.mappings.slice(1)] }))).toThrow();
  expect(() => parseMigrationManifest({ ...m, frozenAt: 2000 })).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, scheduler_sessions: [] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, lendOrders: [{ ...m.lendOrders[0], status: "unknown" }] }))).toThrow();
  expect(() => parseMigrationManifest(resign({ ...m, evidence: { ...m.evidence, oldOrders: "settled" } }))).toThrow();
});
test("approved spec copy cannot drift from its task/revision/digest", () => {
  const m = manifest();
  for (const change of [{ artifactId: "missing" }, { sharedDigest: "c".repeat(64) }]) {
    expect(() => parseMigrationManifest(resign({ ...m, tasks: [{ ...m.tasks[0], spec: { ...m.tasks[0].spec, ...change } }] }))).toThrow();
  }
  expect(() => parseMigrationManifest(resign({ ...m, artifacts: [{ ...m.artifacts[0], specRev: 2 }] }))).toThrow();
});
test("capabilities are explicit for every command; default build opens no execution", () => {
  const disabled = capabilities();
  expect(Object.keys(disabled)).toEqual([...V2_COMMAND_NAMES]);
  expect(Object.values(disabled).every(c => !c.enabled)).toBe(true);
  expect(capabilities(["task.set"])["task.set"].enabled).toBe(true);
  expect(() => parseCapabilities({ ...disabled, terminal: { enabled: true, code: null, reason: "" } })).toThrow();
  const absent = { ...disabled }; delete (absent as Partial<typeof disabled>)["task.set"];
  expect(() => parseCapabilities(absent)).toThrow();
});
test("migration responses, identity-scoped receipts and observations have strict parsers", () => {
  const m = manifest(), r = sample("receipt");
  for (const mapping of m.mappings) expect(parseIdMapping(mapping)).toEqual(mapping);
  const response = { schemaVersion: 2 as const, teamId: "team", projectId: "project", batchId: "batch", manifestDigest: m.manifestDigest,
    serviceGeneration: 1, serverSeq: 1, committedAt: 1000, mappings: m.mappings, featureIds: ["feature"] };
  expect(parseMigrationResult(response)).toEqual(response);
  expect(() => parseMigrationResult({ ...response, extra: true })).toThrow();
  const lookup = { teamId: "team", projectId: "project", requestId: "request", status: "committed", receipt: r };
  expect(parseReceiptLookup(lookup).receipt).toEqual(r);
  expect(() => parseReceiptLookup({ ...lookup, status: "unknown" })).toThrow();
  expect(() => parseReceiptLookup({ ...lookup, receipt: null })).toThrow();
  expect(() => parseReceiptLookup({ ...lookup, requestId: "wrong" })).toThrow();
  expect(() => parseReceiptLookup({ ...lookup, receipt: { ...r, teamId: "other" } })).toThrow();
  const event: V2Event = parseEvent({ ...sample("event"), head: "b".repeat(40) });
  expect(event.head).toHaveLength(40);
  expect(() => parseEvent({ ...sample("event"), data: { shell: "secret" } })).toThrow();
});
test("command structural relations reject drift before transaction composition", () => {
  const command = (type: (typeof V2_COMMAND_NAMES)[number]) => structuredClone(V2_COMMAND_FIXTURES.find(f => f.type === type)!.valid) as any;
  for (const [type, change] of [
    ["task.spec", { nextSpecRev: 3 }], ["task.stage", { to: "spec" }], ["dep.set", { toTask: "task" }],
    ["workflow.set", { mode: "auto" }], ["home.change", { nextEpoch: 1 }], ["dag.propose", { version: 4 }],
    ["task.deliver", { orderId: "order" }], ["intent.create", { action: "merge" }], ["lend.create", { step: "write" }],
  ] as const) {
    const c = command(type); c.payload = { ...c.payload, ...change }; expect(() => parseCommand(c)).toThrow();
  }
  for (const type of ["operation.result", "lend.result", "artifact.put"] as const) {
    const c = command(type), key = type === "artifact.put" ? "artifact" : "result";
    c.payload[key].teamId = "other"; expect(() => parseCommand(c)).toThrow();
  }
  const c = command("operation.result"); c.payload.result.epoch = 2; expect(() => parseCommand(c)).toThrow();
});
