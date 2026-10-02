import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  createTransactionOwner, parseArtifact, parseAsk, parseFeature, parseTask, parseWorkflow, parseCommand, v2ContentDigest,
  type V2Artifact, type V2Ask, type V2TransactionBackend, type V2TransactionContext, type V2TransactionScope,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures";
import { createArtifactDomain, type ArtifactPutCommand } from "../src/shared-ledger/artifacts";
import { artifactSchemaStatements, artifactStatements } from "../src/shared-ledger/artifacts/schema";
import type { ArtifactReaders } from "../src/shared-ledger/artifacts/approval";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function artifact(changes: Partial<V2Artifact> = {}): V2Artifact {
  const result = { ...parseArtifact(V2_DTO_FIXTURES.artifact.valid), ...changes };
  const digest = v2ContentDigest(result.content);
  return { ...result, digest, sharedDigest: digest, bytes: new TextEncoder().encode(result.content).length };
}
function approved(copy = artifact()): V2Ask {
  const ask = parseAsk(V2_DTO_FIXTURES.ask.valid);
  return parseAsk({ ...ask, id: copy.approvalAskId, taskId: copy.taskId,
    state: "answered", answer: { kind: "option", optionId: "approve" }, decision: "approved", answeredBy: copy.approvedBy, answeredAt: 1000,
    bind: { ...ask.bind!, taskId: copy.taskId, specRev: copy.specRev ?? 1, head: copy.head,
      originalDigest: copy.originalDigest, sharedDigest: copy.sharedDigest, actionDigest: copy.sharedDigest,
      redactionVersion: copy.redactionVersion, actions: ["artifact.share"] } });
}
function setup(copy = artifact()) {
  const db = new Database(":memory:"); databases.push(db);
  const scope: V2TransactionScope = { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, now: 2000,
    actor: { kind: "person", personId: "person", instanceId: "local", serviceId: null, representedPersonId: null,
      orderId: null, projects: ["project"], actions: ["artifact.put"] } };
  const statements = { ...artifactStatements,
    "fixture.get": { mode: "read" as const, sql: `SELECT body FROM artifact_test_rows
      WHERE teamId = $teamId AND projectId = $projectId AND kind = $kind AND id = $id` } };
  const owner = createTransactionOwner(db as unknown as V2TransactionBackend, statements, artifactSchemaStatements);
  db.run("CREATE TABLE artifact_test_rows (teamId TEXT, projectId TEXT, kind TEXT, id TEXT, body TEXT, PRIMARY KEY (teamId, projectId, kind, id))");
  function putRow(kind: string, id: string, body: unknown, project = "project") {
    db.query("INSERT OR REPLACE INTO artifact_test_rows VALUES (?, ?, ?, ?, ?)").run("team", project, kind, id, JSON.stringify(body));
  }
  function read(context: V2TransactionContext, kind: string, id: string): unknown {
    const row = context.all("fixture.get", { kind, id })[0] as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  const readers: ArtifactReaders = {
    readAsk: (context, id) => read(context, "ask", id) as V2Ask | null,
    readTask: (context, id) => { const row = read(context, "task", id); return row === null ? null : parseTask(row); },
    readFeature: (context, id) => { const row = read(context, "feature", id); return row === null ? null : parseFeature(row); },
    readWorkflow: (context, id) => { const row = read(context, "workflow", id); return row === null ? null : parseWorkflow(row); },
    isProjectOwner: (context, id) => read(context, "owner", id) === true,
  };
  function run<T>(fn: (context: V2TransactionContext) => T, activeScope = scope) {
    return db.transaction(() => owner.inCallerTransaction(activeScope, Object.keys(statements), fn))();
  }
  function command(value = copy): ArtifactPutCommand {
    return parseCommand({ ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, requestId: "upload", type: "artifact.put", payload: { artifact: value } }) as ArtifactPutCommand;
  }
  // Domain construction precedes schema installation below; readers never touch another domain's tables directly.
  function install() { db.transaction(() => owner.installSchema(context => domain.installSchema(context)))(); }
  const domain = createArtifactDomain(readers);
  install();
  putRow("task", "task", V2_DTO_FIXTURES.task.valid);
  putRow("feature", "feature", V2_DTO_FIXTURES.feature.valid);
  putRow("workflow", "task", V2_DTO_FIXTURES.workflow.valid);
  putRow("ask", copy.approvalAskId, approved(copy)); putRow("owner", "person", true);
  return { db, owner, domain, scope, run, command, putRow, install,
    put: (value = copy) => run(context => domain.applyInTransaction(context, command(value))),
    get: (id = copy.artifactId, activeScope = scope) => run(context => domain.readInTransaction(context, id), activeScope) };
}

test("approved copy stores every frozen field, dual digests and idempotent retries", () => {
  const s = setup(), copy = artifact();
  expect(s.put()).toEqual({ artifact: copy, inserted: true });
  expect(s.get()).toEqual(copy);
  expect(s.put()).toEqual({ artifact: copy, inserted: false });
  expect(s.db.query("SELECT originalDigest, sharedDigest, visibility FROM v2_artifacts").get()).toEqual({
    originalDigest: copy.originalDigest, sharedDigest: copy.sharedDigest, visibility: "approved_copy" });
  expect(copy.originalDigest).not.toBe(copy.sharedDigest);
  s.install();
  expect(s.db.query("SELECT count(*) AS n FROM v2_artifacts").get()).toEqual({ n: 1 });
});
for (const changes of [
  { kind: "report" }, { taskId: "task-two" }, { specRev: 2 }, { head: "c".repeat(40) },
  { originalDigest: "d".repeat(64) }, { content: "another approved copy" }, { redactionVersion: 2 },
  { approvalAskId: "ask-two" }, { approvedBy: "person-two" }, { createdAt: 1001 }, { mediaType: "text/plain" },
] satisfies Partial<V2Artifact>[]) {
  test(`same id cannot change ${Object.keys(changes)[0]}`, () => {
    const s = setup(); s.put();
    expect(() => s.put(artifact(changes))).toThrow("dedup_mismatch");
    expect(s.get()).toEqual(artifact());
  });
}
for (const changes of [
  { digest: "e".repeat(64) }, { sharedDigest: "e".repeat(64) }, { bytes: 99 }, { visibility: "original" },
  { content: "changed without updating hash" }, { specRev: null, head: null }, { unknown: "extra field" },
]) {
  test(`reject malformed artifact: ${Object.keys(changes).join(",")}`, () => {
    const s = setup();
    expect(() => s.put({ ...artifact(), ...changes } as V2Artifact)).toThrow("invalid_field");
    expect(() => s.get()).toThrow("not_found");
  });
}
for (const state of ["open", "expired", "cancelled"] as const) {
  test(`reject ${state} approval`, () => {
    const s = setup(), ask = parseAsk(V2_DTO_FIXTURES.ask.valid);
    s.putRow("ask", "ask", { ...ask, state });
    expect(() => s.put()).toThrow("authorization_mismatch");
  });
}
for (const changes of [
  { decision: "rejected" }, { decision: "acknowledged" }, { answeredBy: "person-two" }, { projectId: "other" },
  { teamId: "other" }, { id: "ask-two" }, { answeredAt: 2001 },
] satisfies Partial<V2Ask>[]) {
  test(`reject invalid approval ${JSON.stringify(changes)}`, () => {
    const s = setup(); s.putRow("ask", "ask", { ...approved(), ...changes });
    expect(() => s.put()).toThrow("authorization_mismatch");
  });
}
for (const changes of [
  { actions: ["merge"] }, { taskId: "task-two" }, { originalDigest: "b".repeat(64) },
  { sharedDigest: "b".repeat(64) }, { actionDigest: "b".repeat(64) }, { redactionVersion: 2 },
  { taskRev: 2 }, { specRev: 2 }, { workflowRev: 2 }, { baseVersion: 2 }, { homeInstanceId: "peer-a" }, { head: "c".repeat(40) },
]) {
  test(`approval bind cannot drift: ${Object.keys(changes)[0]}`, () => {
    const s = setup(), ask = approved();
    s.putRow("ask", "ask", { ...ask, taskId: changes.taskId ?? ask.taskId, bind: { ...ask.bind, ...changes } });
    expect(() => s.put()).toThrow("authorization_mismatch");
  });
}
for (const [kind, id] of [["ask", "ask"], ["task", "task"], ["feature", "feature"], ["workflow", "task"], ["owner", "person"]]) {
  test(`missing authoritative ${kind} blocks upload`, () => {
    const s = setup(); s.db.query("DELETE FROM artifact_test_rows WHERE kind = ? AND id = ?").run(kind!, id!);
    expect(() => s.put()).toThrow("authorization_mismatch");
  });
}
test("expired approvals cannot create copies; committed retries remain idempotent", () => {
  const s = setup(); s.put();
  const expired = { ...s.scope, now: 100000 };
  expect(s.run(context => s.domain.applyInTransaction(context, s.command()), expired).inserted).toBe(false);
  expect(() => s.run(context => s.domain.applyInTransaction(context, s.command(artifact({ artifactId: "new-copy" }))), expired))
    .toThrow("authorization_expired");
});
test("changed redaction/content requires a new matching approval", () => {
  const s = setup(); s.put();
  for (const change of [{ content: "new redacted meaning" }, { redactionVersion: 2 }]) {
    const next = artifact({ artifactId: "copy-two", ...change });
    expect(() => s.put(next)).toThrow("authorization_mismatch");
  }
  const next = artifact({ artifactId: "copy-two", content: "new redacted meaning", redactionVersion: 2, approvalAskId: "ask-two", specRev: 2 });
  const task = parseTask(V2_DTO_FIXTURES.task.valid), workflow = parseWorkflow(V2_DTO_FIXTURES.workflow.valid);
  s.putRow("task", "task", { ...task, specRev: 2 }); s.putRow("workflow", "task", { ...workflow, specRev: 2 });
  s.putRow("ask", "ask-two", approved(next));
  expect(s.put(next).inserted).toBe(true);
  expect(s.get()).toEqual(artifact());
});
test("report can bind head without specRev; changed head cannot reuse approval", () => {
  const copy = artifact({ kind: "report", specRev: null, head: "b".repeat(40) });
  const s = setup(copy), ask = approved(copy);
  s.putRow("ask", "ask", { ...ask, bind: { ...ask.bind, specRev: null } });
  expect(s.put().inserted).toBe(true);
  expect(() => s.put(artifact({ ...copy, artifactId: "another", head: "c".repeat(40) }))).toThrow("authorization_mismatch");
});
for (const content of [
  "/tmp/private", "see /tmp/private", "[report](/tmp/private)", "路径：/tmp/private", "/", "file:///tmp/private", "FILE://peer-a/private",
  "C:\\private\\report", "C:/private/report", "\\\\peer-a\\private", "//peer-a/private", "~/private", "peer-a:/private",
  "user@peer-a:private/report", "ssh://peer-a/private", "sftp://peer-a/private", "vscode://file/tmp/private",
  "user@peer-a:report", "peer-a:report.md", "\\private\\report",
  "%2ftmp%2fprivate", "%252ftmp%252fprivate", "&#47;tmp/private", "&#x2f;tmp/private", "&sol;tmp/private",
  '{"path":"\\u002ftmp/private"}', '{"path":"\\/tmp\\/private"}', "fi\u200ble:///tmp/private", "／tmp／private",
  "-/tmp/private", "--output=/tmp/private", "/private-dir", "/tmp", "$HOME/private/report", "$TMPDIR/foo", "${HOME}/private/report",
  "%USERPROFILE%\\private\\report", "../../../../../../Users/local/.ssh/id_rsa", "../private", "src/../../private",
  "..\\..\\private", "./../../private", "%2e%2e%2fprivate", "-&#47;tmp/private", "/code-review/private",
  "see `\\n/private` path", "http://localhost:8080/Users/local/x", "http://127.0.0.1/Users/local/secret",
  "https://LOCALHOST./private", "http://127.1/private", "http://2130706433/private", "http://0x7f000001/private",
  "http://10.0.0.1/private", "http://172.16.0.1/private", "http://172.31.255.255/private", "http://192.168.1.1/private",
  "http://169.254.1.1/private", "http://100.64.0.1/private", "http://0.0.0.0/private", "http://[::1]/private",
  "http://[::ffff:127.0.0.1]/private", "http://[::ffff:192.168.1.1]/private", "http://[fc00::1]/private",
  "http://[fe80::1]/private", "http://peer-a/private", "http://peer-a.local/private", "http://a.localhost/private",
  "[reference](http://%6cocalhost/private)", "https://localhost@example.invalid/private",
]) {
  test(`reject machine path ${JSON.stringify(content)}`, () => {
    const copy = artifact({ content }), s = setup(copy);
    expect(() => s.put()).toThrow("invalid_field");
    expect(() => s.get()).toThrow("not_found");
  });
}
for (const content of [
  "规格获准共享副本，全文仅在主场", "relative src/example.ts", "原文 / 共享副本哈希分列", "**报告**\n\n本机、peer A、peer B",
  "run /code-review on PR", "invoke /review on PR", "TODO:fix.this", "see `\\n` escape", "escapes `\\r` and `\\t`", "src/../docs/report.md",
  "[public](https://example.invalid/docs/report.md)", "http://172.32.0.1/docs", "https://192.169.1.1/docs",
  "https://[2001:db8::1]/docs", "https://localhost.example.invalid/docs",
]) {
  test(`approved path-free text remains copy: ${content}`, () => {
    const s = setup(artifact({ content }));
    expect(s.put().artifact.visibility).toBe("approved_copy");
    expect(parseTask(V2_DTO_FIXTURES.task.valid).spec.visibility).toBe("home_only");
  });
}
test("foreign project/team and missing artifact ids are indistinguishable", () => {
  const s = setup(); s.put();
  for (const scope of [{ ...s.scope, projectId: "other", actor: { ...s.scope.actor, projects: ["other"] } }, { ...s.scope, teamId: "other" }]) {
    for (const id of ["artifact", "absent"]) expect(() => s.get(id, scope)).toThrow("not_found");
  }
  const noAccess = { ...s.scope, actor: { ...s.scope.actor, projects: [] } };
  for (const id of ["artifact", "absent"]) expect(() => s.get(id, noAccess)).toThrow("forbidden");
  for (const id of ["task", "absent"]) {
    expect(() => s.run(context => s.domain.readSpecInTransaction(context, id), noAccess)).toThrow("forbidden");
  }
});
test("scope, action grants, actor home and fences come from transaction context", () => {
  const s = setup();
  for (const patch of [{ projectId: "other" }, { teamId: "other" }]) {
    const copy = artifact(patch), command = { ...s.command(), ...patch, payload: { artifact: copy } };
    expect(() => s.run(context => s.domain.applyInTransaction(context, command))).toThrow("forbidden");
  }
  for (const patch of [{ serviceGeneration: 2 }, { epoch: 2 }, { bootId: "other" }]) {
    expect(() => s.run(context => s.domain.applyInTransaction(context, { ...s.command(), ...patch }))).toThrow(
      "serviceGeneration" in patch ? "stale_generation" : "stale_epoch");
  }
  s.scope.actor.actions = []; expect(() => s.put()).toThrow("forbidden");
  s.scope.actor.actions = ["artifact.put"]; s.scope.actor.instanceId = "peer-a";
  expect(() => s.put()).toThrow("wrong_home");
});
test("immutable triggers reject updates and deletes", () => {
  const s = setup(); s.put();
  expect(() => s.db.run("UPDATE v2_artifacts SET content = 'replacement'")).toThrow("immutable artifact");
  expect(() => s.db.run("DELETE FROM v2_artifacts")).toThrow("immutable artifact");
});
test("artifact, approval and receipt writes roll back together on any domain error", () => {
  const s = setup();
  s.putRow("ask", "ask", V2_DTO_FIXTURES.ask.valid);
  expect(() => s.run(context => {
    s.db.query("UPDATE artifact_test_rows SET body = ? WHERE kind = 'ask'").run(JSON.stringify(approved()));
    s.domain.applyInTransaction(context, s.command());
    s.db.query("INSERT INTO artifact_test_rows VALUES ('team', 'project', 'receipt', 'upload', '{}')").run();
    throw new Error("later domain failed");
  })).toThrow("later domain failed");
  expect(() => s.get()).toThrow("not_found");
  expect(s.db.query("SELECT count(*) AS n FROM artifact_test_rows WHERE kind = 'receipt'").get()).toEqual({ n: 0 });
  expect(s.db.query("SELECT json_extract(body, '$.state') AS state FROM artifact_test_rows WHERE kind = 'ask'").get()).toEqual({ state: "open" });
});
test("no fake/out-of-transaction or escaped transaction context can read/write", () => {
  const s = setup(); let leaked!: V2TransactionContext;
  expect(() => s.domain.applyInTransaction({ assertActive() {} } as V2TransactionContext, s.command())).toThrow("transaction_required");
  s.run(context => { leaked = context; });
  expect(() => s.domain.readInTransaction(leaked, "artifact")).toThrow("transaction_closed");
  expect(() => s.domain.applyInTransaction(leaked, s.command())).toThrow("transaction_closed");
});

test("home-only spec metadata never presents a summary as original/full content", () => {
  const s = setup(), task = parseTask(V2_DTO_FIXTURES.task.valid), copy = artifact();
  const read = (id = "task") => s.run(context => s.domain.readSpecInTransaction(context, id));
  expect(read()).toEqual({ visibility: "home_only", label: "全文仅在主场", summary: task.spec.summary, artifact: null });
  s.put();
  s.putRow("task", "task", { ...task, spec: { ...task.spec, visibility: "approved_copy", artifactId: copy.artifactId, sharedDigest: copy.sharedDigest } });
  expect(read()).toEqual({ visibility: "approved_copy", label: "获准共享副本；全文仅在主场", summary: task.spec.summary, artifact: copy });
  expect(() => read("absent")).toThrow("not_found");
  s.putRow("task", "task", { ...task, projectId: "other" }); expect(() => read()).toThrow("not_found");
});
test("spec read rejects mismatched artifact references instead of relabeling a summary", () => {
  const s = setup(), task = parseTask(V2_DTO_FIXTURES.task.valid); s.put();
  for (const patch of [{ sharedDigest: "b".repeat(64) }, { originalDigest: "b".repeat(64) }, { artifactId: "absent" }]) {
    s.putRow("task", "task", { ...task, spec: { ...task.spec, visibility: "approved_copy", artifactId: "artifact",
      sharedDigest: artifact().sharedDigest, ...patch } });
    expect(() => s.run(context => s.domain.readSpecInTransaction(context, "task"))).toThrow("not_found");
  }
});
test("SQLite REPLACE cannot bypass immutability when recursive triggers are disabled", () => {
  const s = setup(); s.put();
  expect(() => s.db.run("INSERT OR REPLACE INTO v2_artifacts SELECT * FROM v2_artifacts")).toThrow("immutable artifact");
  expect(s.get()).toEqual(artifact());
});
for (const field of ["artifactId", "taskId", "approvedBy", "approvalAskId"] as const) {
  test(`path checks also cover ${field}`, () => {
    const s = setup(); expect(() => s.put(artifact({ [field]: "file:private" }))).toThrow("invalid_field");
  });
}
test("path checks preserve repository-relative references and public web links", () => {
  const copy = artifact({ content: "profile: copy\n[source](src/example.ts) [reference](https://example.invalid/docs)" });
  const s = setup(copy); expect(s.put().inserted).toBe(true);
});
test("current source/task/feature/workflow changes invalidate an otherwise approved copy", () => {
  const task = parseTask(V2_DTO_FIXTURES.task.valid), feature = parseFeature(V2_DTO_FIXTURES.feature.valid);
  const workflow = parseWorkflow(V2_DTO_FIXTURES.workflow.valid);
  for (const [kind, id, row] of [
    ["task", "task", { ...task, rev: 2 }], ["task", "task", { ...task, specRev: 2 }],
    ["task", "task", { ...task, spec: { ...task.spec, originalDigest: "b".repeat(64) } }],
    ["feature", "feature", { ...feature, currentVersion: 2 }], ["workflow", "task", { ...workflow, rev: 2 }],
  ] as const) {
    const s = setup(); s.putRow(kind, id, row); expect(() => s.put()).toThrow("authorization_mismatch");
  }
  const s = setup(); s.putRow("feature", "feature", { ...feature, epoch: 2 }); expect(() => s.put()).toThrow("stale_epoch");
});
test("scoped services can share approved copies from peer A without claiming the home", () => {
  const s = setup();
  const service: V2TransactionScope = { ...s.scope, actor: { ...s.scope.actor, kind: "service", serviceId: "service",
    instanceId: "peer-a", representedPersonId: "person", orderId: "order" } };
  expect(s.run(context => s.domain.applyInTransaction(context, s.command()), service).inserted).toBe(true);
});

test("an already used approval id cannot acquire a new semantic bind even if its source row is replaced", () => {
  const s = setup(); s.put();
  for (const change of [{ content: "different meaning" }, { redactionVersion: 2 }]) {
    const copy = artifact({ artifactId: "copy-two", ...change });
    s.putRow("ask", "ask", approved(copy));
    expect(() => s.put(copy)).toThrow("authorization_mismatch");
  }
  expect(s.get()).toEqual(artifact());
});

for (const kind of ["review", "report", "evidence"] as const) {
  test(`an approval used for spec cannot be reused for ${kind}`, () => {
    const s = setup(); s.put();
    const copy = artifact({ artifactId: "copy-two", kind });
    expect(() => s.put(copy)).toThrow("authorization_mismatch");
    expect(() => s.get(copy.artifactId)).toThrow("not_found");
    const newlyApproved = { ...copy, approvalAskId: "ask-two" };
    s.putRow("ask", "ask-two", approved(newlyApproved));
    expect(s.put(newlyApproved).inserted).toBe(true);
  });
}
test("one approval can still bind another id with identical content and kind", () => {
  const s = setup(); s.put();
  expect(s.put(artifact({ artifactId: "copy-two" })).inserted).toBe(true);
});
