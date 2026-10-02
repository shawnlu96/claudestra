import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createTransactionOwner, parseDTO, parseCommand, v2ObjectDigest, type V2TransactionBackend,
  type V2TransactionScope, type V2Command, type V2Statement,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures";
import { createIntentDomain, intentActionDigest, intentAuthorizationDigest, intentSchema, intentStatements, type IntentCommand, type IntentPorts } from "../src/shared-ledger/intents";

const fixture = <K extends keyof typeof V2_DTO_FIXTURES>(name: K) => parseDTO(name, structuredClone(V2_DTO_FIXTURES[name].valid));
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const dependencyDigest = v2ObjectDigest([]);
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  db.run("CREATE TABLE inputs (teamId TEXT, projectId TEXT, kind TEXT, body TEXT)");
  db.run("CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, teamId TEXT, projectId TEXT, body TEXT)");
  const fixtures = {
    task: fixture("task"), feature: { ...fixture("feature"), authorityMode: "execution" },
    workflow: fixture("workflow"), lease: fixture("lease"), dependencies: [], owner: true,
    ask: fixture("ask"),
  };
  for (const [kind, body] of Object.entries(fixtures)) db.run("INSERT INTO inputs VALUES ('team', 'project', ?, ?)", [kind, JSON.stringify(body)]);
  const extra: Record<string, V2Statement> = {
    "fixture.read": { mode: "read", sql: "SELECT body FROM inputs WHERE teamId = $teamId AND projectId = $projectId AND kind = $kind" },
    "fixture.write": { mode: "write", sql: "UPDATE inputs SET body = $body WHERE teamId = $teamId AND projectId = $projectId AND kind = $kind" },
    "fixture.event": { mode: "write", sql: "INSERT INTO audit (teamId, projectId, body) VALUES ($teamId, $projectId, $body)" },
    "fixture.seq": { mode: "read", sql: "SELECT max(seq) AS seq FROM audit WHERE teamId = $teamId AND projectId = $projectId" },
  };
  const owner = createTransactionOwner(db as unknown as V2TransactionBackend, { ...intentStatements, ...extra }, intentSchema);
  const read = (ctx: Parameters<IntentPorts["readCurrent"]>[0], kind: string) =>
    JSON.parse((ctx.all("fixture.read", { kind })[0] as { body: string }).body);
  let eventFailure = false;
  const ports: IntentPorts = {
    readCurrent(ctx) { return { task: read(ctx, "task"), feature: read(ctx, "feature"), workflow: read(ctx, "workflow"),
      lease: read(ctx, "lease"), dependencies: read(ctx, "dependencies") }; },
    readAsk(ctx) { return read(ctx, "ask"); },
    isOwner(ctx) { return read(ctx, "owner"); },
    appendEvent(ctx, event) {
      ctx.run("fixture.event", { body: JSON.stringify(event) });
      if (eventFailure) throw Error("event failure");
      return (ctx.all("fixture.seq")[0] as { seq: number }).seq;
    },
  };
  const domain = createIntentDomain(ports);
  const scope: { -readonly [K in keyof V2TransactionScope]: V2TransactionScope[K] } = { teamId: "team", projectId: "project", serviceGeneration: 1, epoch: 1, bootId: "boot-local", now: 1000,
    actor: { ...fixture("actor"), actions: ["intent.create", "intent.check", "intent.cancel", "operation.result", "operation.reconcile"] } };
  const names = [...Object.keys(intentStatements), ...Object.keys(extra)];
  db.transaction(() => owner.installSchema(ctx => domain.installSchema(ctx)))();
  const execute = (command: V2Command, tail?: () => void) => db.transaction(() => owner.inCallerTransaction(scope, names, ctx => {
    const result = domain.applyInTransaction(ctx, command as IntentCommand); tail?.(); return result;
  }))();
  const set = (kind: string, body: unknown) => db.run("UPDATE inputs SET body = ? WHERE kind = ?", [JSON.stringify(body), kind]);
  const get = (kind: string) => JSON.parse((db.query("SELECT body FROM inputs WHERE kind = ?").get(kind) as { body: string }).body);
  const count = (table: string) => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const command = (type: IntentCommand["type"], payload: unknown) => parseCommand({
    type, teamId: scope.teamId, projectId: scope.projectId, requestId: "request",
    serviceGeneration: scope.serviceGeneration, epoch: scope.epoch, bootId: scope.bootId, payload,
  });
  const versions = { taskId: "task", expectedRev: 1, expectedSpecRev: 1, expectedWorkflowRev: 1 };
  const create = (patch: Record<string, unknown> = {}) => command("intent.create", {
    ...versions, action: "dispatch", node: "write", operationId: "operation", head: fixtures.task.head, round: 0,
    dependencyDigest, authorizationAskId: null, authorizationDigest: null, resources: [fixture("resourceKey")], ...patch,
  });
  const check = (patch: Record<string, unknown> = {}) => command("intent.check", {
    ...versions, intentId: "operation", operationId: "operation", authorizationAskId: null, authorizationDigest: null, ...patch,
  });
  const result = (patch: Record<string, unknown> = {}) => ({ ...fixture("operationResult"), intentId: "operation", ...patch });
  const report = (patch: Record<string, unknown> = {}) => command("operation.result", { result: result(patch) });
  const cancel = () => command("intent.cancel", { ...versions, intentId: "operation", operationId: "operation", reason: "owner reconciled cancellation" });
  const approve = () => {
    const bind = { ...fixture("authorizationBind"), sharedDigest: fixtures.task.spec.originalDigest,
      actionDigest: intentActionDigest({ action: "merge", node: "write", head: fixtures.task.head, round: 0, resources: [fixture("resourceKey")] }) };
    set("task", { ...fixtures.task, spec: { ...fixtures.task.spec, visibility: "approved_copy", artifactId: "artifact", sharedDigest: bind.sharedDigest } });
    set("ask", { ...fixture("ask"), state: "answered", answer: { kind: "option", optionId: "approve" }, answeredAt: 1000,
      answeredBy: "person", decision: "approved", bind });
    return { authorizationAskId: "ask", authorizationDigest: intentAuthorizationDigest(bind) };
  };
  const reconcile = (state: "succeeded" | "failed" = "succeeded") => command("operation.reconcile", {
    ...versions, intentId: "operation", operationId: "operation", authorizationAskId: "ask",
    result: result({ state, approvalAskId: "ask", epoch: scope.epoch, bootId: scope.bootId, serviceGeneration: scope.serviceGeneration }),
  });
  const start = () => { execute(create()); execute(check()); };
  return { db, domain, owner, scope, names, execute, create, check, report, cancel, reconcile, approve, set, get, count, start,
    failEvent: () => { eventFailure = true; } };
}

describe("intent atomic admission", () => {
  test("creates intent, project resource and shared event inside caller transaction", () => {
    const s = setup(), out = s.execute(s.create());
    expect(out.intent.status).toBe("pending"); expect(out.intent.eventSeq).toBe(1);
    expect(out.intent.operationId).toBe("operation"); expect(out.intent.epoch).toBe(1);
    expect(s.count("v2_intents")).toBe(1); expect(s.count("v2_intent_resources")).toBe(1); expect(s.count("audit")).toBe(1);
  });
  const cases: [string, (s: ReturnType<typeof setup>) => void, string][] = [
    ["rev", s => s.set("task", { ...s.get("task"), rev: 2 }), "conflict"],
    ["specRev", s => s.set("task", { ...s.get("task"), specRev: 2 }), "conflict"],
    ["workflowRev", s => s.set("workflow", { ...s.get("workflow"), rev: 2 }), "conflict"],
    ["workflow specRev", s => s.set("workflow", { ...s.get("workflow"), specRev: 2 }), "conflict"],
    ["dependencies", s => s.set("dependencies", [{ ...fixture("dependency"), fromTask: "prerequisite", toTask: "task" }]), "dependency_blocked"],
    ["epoch", s => s.set("lease", { ...s.get("lease"), epoch: 2 }), "stale_epoch"],
    ["boot", s => s.set("lease", { ...s.get("lease"), bootId: "boot-other" }), "stale_epoch"],
    ["generation", s => s.set("lease", { ...s.get("lease"), serviceGeneration: 2 }), "stale_generation"],
    ["expiry", s => { s.scope.now = 61000; }, "lease_expired"],
    ["home", s => { s.scope.actor.instanceId = "peer-a"; }, "wrong_home"],
    ["project", s => s.set("task", { ...s.get("task"), projectId: "other" }), "forbidden"],
    ["planning", s => s.set("feature", { ...s.get("feature"), authorityMode: "planning" }), "execution_not_shared"],
  ];
  for (const [label, alter, error] of cases) test(`${label} mismatch writes neither intent nor event`, () => {
    const s = setup(); alter(s);
    expect(() => s.execute(s.create())).toThrow(error);
    expect(s.count("v2_intents")).toBe(0); expect(s.count("audit")).toBe(0); expect(s.count("v2_intent_resources")).toBe(0);
  });
  test("dependency digest must match the full current incoming set", () => {
    const s = setup(), dependencies = [{ ...fixture("dependency"), fromTask: "prerequisite", toTask: "task", state: "done" }];
    s.set("dependencies", dependencies);
    expect(() => s.execute(s.create())).toThrow("dependency_blocked");
    expect(s.execute(s.create({ dependencyDigest: v2ObjectDigest(dependencies) })).intent.status).toBe("pending");
  });
  test("event failure rolls back all writes", () => {
    const s = setup(); s.failEvent(); expect(() => s.execute(s.create())).toThrow("event failure");
    expect(s.count("v2_intents")).toBe(0); expect(s.count("audit")).toBe(0);
  });
  test("later sibling or receipt failure rolls back intents/resources/events", () => {
    const s = setup(); expect(() => s.execute(s.create(), () => { throw Error("receipt failure"); })).toThrow("receipt failure");
    for (const table of ["v2_intents", "v2_intent_resources", "audit"]) expect(s.count(table)).toBe(0);
  });
  test("rejects fabricated or closed transaction contexts", () => {
    const s = setup(); expect(() => s.domain.applyInTransaction({} as never, s.create() as IntentCommand)).toThrow("transaction_required");
    expect(() => s.owner.inCallerTransaction(s.scope, s.names, ctx => s.domain.applyInTransaction(ctx, s.create() as IntentCommand)))
      .toThrow("transaction_required");
  });
});

describe("authorization revalidation", () => {
  test("merge requires live owner-approved matching content and revisions", () => {
    const s = setup(), auth = s.approve();
    expect(s.execute(s.create({ action: "merge", ...auth })).intent.authorizationAskId).toBe("ask");
    s.execute(s.check(auth));
  });
  for (const [label, patch, error] of [
    ["expired", { expiresAt: 1000, bind: { expiresAt: 1000 } }, "invalid_field"],
    ["rejected", { decision: "rejected" }, "authorization_mismatch"],
    ["action content", { bind: { actionDigest: "c".repeat(64) } }, "authorization_mismatch"],
    ["revision", { bind: { taskRev: 2 } }, "authorization_mismatch"],
    ["head", { bind: { head: "c".repeat(40) } }, "authorization_mismatch"],
    ["action", { bind: { actions: ["release"] } }, "authorization_mismatch"],
  ] as const) test(`${label} authorization writes no intent/event`, () => {
    const s = setup(); s.approve(); const ask = s.get("ask");
    const next = { ...ask, ...patch, bind: { ...ask.bind, ...("bind" in patch ? patch.bind : {}) } };
    s.set("ask", next);
    expect(() => s.execute(s.create({ action: "merge", authorizationAskId: "ask", authorizationDigest: v2ObjectDigest(next.bind) }))).toThrow(error);
    expect(s.count("v2_intents")).toBe(0); expect(s.count("audit")).toBe(0);
  });
  test("expiry and owner membership are checked online before the side effect", () => {
    const s = setup(), auth = s.approve(); s.execute(s.create({ action: "merge", ...auth }));
    s.set("owner", false); expect(() => s.execute(s.check(auth))).toThrow("authorization_mismatch");
    s.set("owner", true); s.scope.now = 100000;
    s.set("lease", { ...s.get("lease"), renewedAt: 100000, expiresAt: 160000 });
    expect(() => s.execute(s.check(auth))).toThrow("authorization_expired"); expect(s.count("audit")).toBe(1);
  });
  test("approval binds the precise action resource scope, not just the action name", () => {
    const s = setup(), auth = s.approve();
    expect(() => s.execute(s.create({ action: "merge", ...auth,
      resources: [{ ...fixture("resourceKey"), path: "src/unapproved.ts" }] }))).toThrow("authorization_mismatch");
    expect(s.count("audit")).toBe(0);
  });
  test("a well-formed expired approval writes neither intent nor event", () => {
    const s = setup(), auth = s.approve(); s.scope.now = 100000;
    s.set("lease", { ...s.get("lease"), renewedAt: 100000, expiresAt: 160000 });
    expect(() => s.execute(s.create({ action: "merge", ...auth }))).toThrow("authorization_expired");
    expect(s.count("v2_intents")).toBe(0); expect(s.count("audit")).toBe(0);
  });
  test("auto dispatch requires authorization, no null approval bypass", () => {
    const s = setup(); s.set("workflow", { ...s.get("workflow"), mode: "auto" });
    expect(() => s.execute(s.create())).toThrow("authorization_mismatch"); expect(s.count("audit")).toBe(0);
  });
});

describe("operation receipts and uncertainty", () => {
  test("stable operationId deduplicates create even across new request IDs", () => {
    const s = setup(), first = s.execute(s.create());
    expect(s.execute({ ...s.create(), requestId: "retry" })).toEqual(first);
    expect(s.count("audit")).toBe(1);
    expect(() => s.execute(s.create({ node: "review" }))).toThrow("dedup_mismatch");
  });
  test("repeat results return the original epoch-bearing receipt without new bookkeeping", () => {
    const s = setup(); s.start(); const first = s.execute(s.report());
    expect(first.result?.epoch).toBe(1); expect(first.intent.status).toBe("done");
    expect(s.execute(s.report({ summary: "duplicate observation", state: "failed" }))).toEqual(first);
    expect(s.count("v2_operation_results")).toBe(1); expect(s.count("audit")).toBe(3); expect(s.count("v2_intent_resources")).toBe(0);
  });
  test("check and remote side effect are non-atomic, no general exactly-once guarantee", () => {
    const s = setup(); s.start();
    expect(() => s.execute(s.check())).toThrow("unknown_operation");
    const unknown = s.execute(s.report({ state: "unknown", summary: "remote response lost" }));
    expect(unknown.intent.status).toBe("unknown"); expect(s.count("v2_intent_resources")).toBe(1);
    expect(s.execute(s.report())).toEqual(unknown);
    expect(() => s.execute(s.check())).toThrow("unknown_operation");
  });
  test("lease expiry retains unknown resources and never creates another attempt", () => {
    const s = setup(); s.start(); s.scope.now = 61000;
    s.execute(s.report({ state: "unknown" }));
    expect(s.execute(s.create()).intent.attempts).toBe(1);
    expect(() => s.execute(s.check())).toThrow("lease_expired");
    s.set("lease", { ...s.get("lease"), renewedAt: 61000, expiresAt: 121000 });
    expect(() => s.execute(s.create({ operationId: "second" }))).toThrow("resource_busy");
    expect(s.count("v2_intent_resources")).toBe(1);
    const resource = JSON.parse((s.db.query("SELECT body FROM v2_intent_resources").get() as { body: string }).body);
    expect(resource.state).toBe("unknown");
  });
  for (const state of ["succeeded", "failed"] as const) test(`explicit ${state} reconciliation releases resources once`, () => {
    const s = setup(); s.start(); s.execute(s.report({ state: "unknown" })); s.approve();
    const out = s.execute(s.reconcile(state)); expect(out.intent.status).toBe("done"); expect(out.result?.state).toBe(state);
    expect(s.count("v2_intent_resources")).toBe(0); expect(s.count("audit")).toBe(4);
    expect(s.execute(s.reconcile(state))).toEqual(out); expect(s.count("audit")).toBe(4);
    s.execute(s.create({ operationId: "next" }));
  });
  test("owner can explicitly reconcile cancellation; member cannot release unknown", () => {
    const s = setup(); s.start(); s.execute(s.report({ state: "unknown" }));
    s.set("owner", false); expect(() => s.execute(s.cancel())).toThrow("forbidden");
    expect(s.count("v2_intent_resources")).toBe(1); s.set("owner", true);
    const out = s.execute(s.cancel()); expect(out.intent.status).toBe("cancelled"); expect(s.count("v2_intent_resources")).toBe(0);
    expect(s.execute(s.report())).toEqual(out); expect(s.execute(s.cancel())).toEqual(out);
  });
  test("expired lease still permits explicit owner reconciliation without granting a new attempt", () => {
    const s = setup(); s.start(); s.execute(s.report({ state: "unknown" })); s.approve(); s.scope.now = 61000;
    expect(s.execute(s.reconcile()).result?.state).toBe("succeeded");
    expect(s.count("v2_intent_resources")).toBe(0);
    expect(() => s.execute(s.create({ operationId: "next" }))).toThrow("lease_expired");
  });
  test("reconciliation cannot alias the outer task or operation identifiers", () => {
    const s = setup(); s.start(); s.approve(); s.execute(s.reconcile());
    const command = s.reconcile() as Extract<IntentCommand, { type: "operation.reconcile" }>;
    expect(() => s.execute({ ...command, payload: { ...command.payload, taskId: "other" } })).toThrow("conflict");
    expect(() => s.execute({ ...command, payload: { ...command.payload, operationId: "other" } })).toThrow("conflict");
  });
  test("missing receipt can be explicitly reconciled from submitted", () => {
    const s = setup(); s.start(); s.approve(); s.execute(s.reconcile()); expect(s.count("v2_intent_resources")).toBe(0);
  });
  test("failed final observation settles intent and preserves failure in receipt", () => {
    const s = setup(); s.start(); const out = s.execute(s.report({ state: "failed" }));
    expect(out.intent.status).toBe("done"); expect(out.result?.state).toBe("failed"); expect(s.count("v2_intent_resources")).toBe(0);
  });
  test("result event failure rolls back receipt, intent and resource release", () => {
    const s = setup(); s.start(); s.failEvent(); expect(() => s.execute(s.report())).toThrow("event failure");
    expect(s.count("v2_operation_results")).toBe(0); expect(s.count("v2_intent_resources")).toBe(1); expect(s.count("audit")).toBe(2);
  });
  test("wrong epoch cannot submit or retrieve an operation receipt", () => {
    const s = setup(); s.start(); s.execute(s.report()); s.scope.epoch = 2;
    expect(() => s.execute(s.report({ epoch: 2 }))).toThrow("stale_epoch"); expect(s.count("audit")).toBe(3);
  });
  for (const fence of [{ epoch: 2 }, { bootId: "boot-next" }, { serviceGeneration: 2 }])
    test(`unknown must be reconciled before ${Object.keys(fence)[0]} advances`, () => {
      const s = setup(); s.start(); s.execute(s.report({ state: "unknown" })); s.approve();
      Object.assign(s.scope, fence);
      const command = s.reconcile() as Extract<IntentCommand, { type: "operation.reconcile" }>;
      const adjusted = { ...command, payload: { ...command.payload, result: { ...command.payload.result, ...fence } } };
      expect(() => s.execute(adjusted)).toThrow("serviceGeneration" in fence ? "stale_generation" : "stale_epoch");
      expect(s.count("v2_intent_resources")).toBe(1); expect(s.count("audit")).toBe(3);
    });
  test("a pending intent cannot claim that a side effect finished", () => {
    const s = setup(); s.execute(s.create()); expect(() => s.execute(s.report())).toThrow("conflict");
  });
});

describe("portable scoped resources", () => {
  for (const path of ["/tmp/file", "C:/file", "C:\\file", "../file", "src/../file", "\\\\host\\file", "%2Ftmp/file", "~/file"])
    test(`rejects non-relative resource ${path}`, () => {
      const s = setup(); expect(() => s.execute(s.create({ resources: [{ ...fixture("resourceKey"), path }] }))).toThrow("invalid_field");
      expect(s.count("audit")).toBe(0);
    });
  test("repository locks overlap file locks in both directions", () => {
    const s = setup(), repository = { teamId: "team", projectId: "project", repository: "team/repository", kind: "repository" };
    s.execute(s.create()); expect(() => s.execute(s.create({ operationId: "repo", resources: [repository] }))).toThrow("resource_busy");
    const t = setup(); t.execute(t.create({ resources: [repository] }));
    expect(() => t.execute(t.create({ operationId: "file" }))).toThrow("resource_busy");
    expect(t.count("audit")).toBe(1);
  });
  test("different files and repositories may run concurrently", () => {
    const s = setup(); s.execute(s.create());
    s.execute(s.create({ operationId: "file-two", resources: [{ ...fixture("resourceKey"), path: "src/other.ts" }] }));
    s.execute(s.create({ operationId: "repo-two", resources: [{ ...fixture("resourceKey"), repository: "team/other" }] }));
    expect(s.count("v2_intent_resources")).toBe(3);
  });
  test("cross-project keys and duplicate resource aliases are rejected before writes", () => {
    const s = setup(); expect(() => s.execute(s.create({ resources: [{ ...fixture("resourceKey"), projectId: "other" }] }))).toThrow("invalid_field");
    expect(() => s.execute(s.create({ resources: [fixture("resourceKey"), fixture("resourceKey")] }))).toThrow("invalid_field");
    expect(s.count("audit")).toBe(0);
  });
});
