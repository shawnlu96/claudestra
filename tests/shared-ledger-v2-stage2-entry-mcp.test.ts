import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createTask, deliver, setMeta } from "../src/lib/ledger-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { deliverOrder, type DeliverDeps } from "../src/lib/order-deliver.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { parseCommand, parseReceipt, v2ObjectDigest, type V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_COMMAND_FIXTURES, V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { configureSharedExecEntry, type EntrySwitch, type EntryToolContext, type SharedExecEntryPort } from "../src/bridge/shared-ledger-v2-entry.js";
import { sharedExecDeliver, sharedExecStart, sharedExecVerdict } from "../src/bridge/shared-ledger-v2-entry-mcp.js";
import { reviewToolHandlers } from "../src/bridge/review-tools.js";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";

const owner = { actor: "owner", now: 1000 };
const author: VerifiedCall = { agent: "agent-author", sessionId: "author-session", family: "codex", channelId: "author-channel" };
const reviewer: VerifiedCall = { agent: "agent-reviewer", sessionId: "review-session", family: "claude-code", channelId: "review-channel" };
const head = "b".repeat(40), orderId = "task:write:r0";
const wire = { v: 1, orderId, head, evidence: "synthetic/evidence.md", summary: "ready", selfCheck: "passed" };
const verdict = { v: 1, orderId: "task:review:r0", head, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "synthetic/review.md" };
let dir: string, db: Database, state: { route: "local" | "central" | "skip"; mode: EntrySwitch; migrating: boolean; contexts: number; writes: number };
let sent: V2Command[], context: EntryToolContext, port: SharedExecEntryPort;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "s2e-mcp-")); db = openLedger(join(dir, "ledger.sqlite"));
  db.run("INSERT INTO ledger_instance (key,value) VALUES ('origin','s2ee')");
  setMeta(db, owner, { project: "project", key: "pms", value: ["agent-pm"] });
  db.run("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) VALUES " +
    "('feature','project','synthetic','','active',1,1,'owner',1000,1000)");
  createTask(db, owner, { project: "project", id: "task", title: "synthetic", kind: "code" });
  assignStep(db, { actor: "agent-pm", now: 1100 }, { taskId: "task", step: "write", executorKind: "agent", executor: author.agent });
  db.run("UPDATE tasks SET stage='build', featureId='feature', agent=?, branch='feat/synthetic' WHERE id='task'", [author.agent]);
  state = { route: "central", mode: "on", migrating: false, contexts: 0, writes: 0 }; sent = [];
  const taskNew = V2_COMMAND_FIXTURES.find(f => f.type === "task.new")!.valid;
  context = {
    principal: { id: "token:synthetic-service", role: "external", agents: [author.agent], createdAt: "synthetic" },
    project: "project", requestKey: "synthetic-operation",
    scope: { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE }, task: { id: "task", rev: 7, specRev: 3, workflowRev: 4, round: 1, head },
    order: { id: null, leaseGen: null }, artifactIds: ["artifact"], reportArtifactId: "review-artifact",
    delivery: { head, pr: "https://github.com/team/repository/pull/1" },
    start: { featureId: "feature", expectedRev: 1, baseVersion: 1, nodeKey: "write",
      payload: taskNew.type === "task.new" ? taskNew.payload : (() => { throw Error("fixture"); })() },
  };
  port = {
    mode: () => state.mode, route: () => state.route, featureRoute: () => state.route, holdReason: () => state.migrating ? "migrating" : null,
    clientFor: (p, project) => {
      expect(p).toBe(context.principal); expect(project).toBe("project");
      return {
        command: async (c) => {
          state.writes++; sent.push(parseCommand(c));
          return parseReceipt({ ...V2_DTO_FIXTURES.receipt.valid as object, requestId: c.requestId, command: c.type, commandDigest: v2ObjectDigest(c),
            result: { entityId: c.type === "task.new" ? "new-task" : "task", rev: 2, specRev: 1, version: null, epoch: c.epoch, operationId: null } });
        }, queryAsk: async () => { throw Error("unexpected ask"); },
      };
    },
    snapshot: async () => { throw Error("unexpected snapshot"); }, receipt: async () => { throw Error("unexpected receipt"); },
    toolContext: async (call, tool, target, w) => {
      state.contexts++; expect(call).toEqual(tool === "submit_verdict" ? reviewer : author);
      expect(target).toBe(tool === "start_node" ? "feature" : "task");
      expect(w).not.toHaveProperty("actor");
      return context;
    },
  };
  configureSharedExecEntry(port);
});
afterEach(() => { configureSharedExecEntry(null); closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); });
const deps = () => ({ db, modeOf: () => ({ authorityMode: "source" as const, sharedPlanning: false }) });
function localDelivery(onWrite: () => void): DeliverDeps {
  return { db, remoteHead: async () => ({ ok: true, head }),
    findPr: async () => ({ ok: true, rows: [{ url: "https://github.com/team/repository/pull/1",
      baseRefName: "main", headRefOid: head, isCrossRepository: false }] }),
    run: async () => {
      onWrite();
      const r = deliver(db, { actor: author.agent, now: 1300 }, { taskId: "task", headSHA: head, moveFrom: "build" });
      return { ok: true, duplicate: r.duplicate, event: r.event, task: r.row };
    } };
}
test("deliver dispatches execution to task.deliver with trusted versions/artifacts; local writer spy zero", async () => {
  let localWrites = 0;
  const result = await sharedExecDeliver(author, wire, deps()) ?? await deliverOrder(author, wire, localDelivery(() => { localWrites++; }));
  expect(result.ok).toBe(true); expect(localWrites).toBe(0); expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "task.deliver", payload: { taskId: "task", expectedRev: 7, expectedSpecRev: 3,
    expectedWorkflowRev: 4, round: 1, orderId: null, leaseGen: null, artifactIds: ["artifact"], head } });
  expect(JSON.stringify(sent)).not.toContain(wire.evidence);
});
test("non-execution deliver retains real local exit exactly once in every switch mode", async () => {
  state.route = "local";
  for (const mode of ["off", "observe", "on"] as const) {
    state.mode = mode;
    db.run("UPDATE tasks SET stage='build', round=0 WHERE id='task'");
    db.run("UPDATE task_steps SET state='assigned' WHERE taskId='task' AND step='write'");
    let localWrites = 0;
    await (await sharedExecDeliver(author, wire, deps()) ?? deliverOrder(author, wire, localDelivery(() => { localWrites++; })));
    expect(localWrites).toBe(1);
  }
  expect(sent).toEqual([]); expect(state.contexts).toBe(0);
});
test("null/missing context, off, observe and migrating hold execution with zero center or local writes", async () => {
  configureSharedExecEntry(null);
  expect(await sharedExecDeliver(author, wire, { db, modeOf: () => ({ authorityMode: "execution", sharedPlanning: true }) }))
    .toMatchObject({ ok: false, code: "unavailable" });
  configureSharedExecEntry({ ...port, toolContext: undefined });
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ ok: false, code: "v2_unmapped" });
  configureSharedExecEntry(port);
  state.mode = "off";
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ ok: false, code: "unavailable" });
  state.mode = "observe";
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ ok: false, code: "execution_not_shared" });
  state.mode = "on"; state.route = "skip"; state.migrating = true;
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ ok: false, code: "migrating" });
  expect(state.writes).toBe(0); expect(state.contexts).toBe(0);
});
test("stale/wrong caller, origin head, missing artifacts and invalid PR prevent center delivery", async () => {
  expect(await sharedExecDeliver({ ...author, agent: "agent-other" }, wire, deps())).toMatchObject({ code: "not_current_order" });
  context.delivery!.head = "c".repeat(40);
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ code: "head_mismatch" });
  context.delivery!.head = head; context.delivery!.pr = "https://other.invalid/pull/1";
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ code: "pr_unverifiable" });
  context.artifactIds = undefined;
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ code: "v2_unmapped" });
  expect(state.writes).toBe(0);
});
test("submit_verdict handler uses task.review, authenticated review slot and artifact, never local manager", async () => {
  db.run("UPDATE tasks SET stage='review', headSHA=? WHERE id='task'", [head]);
  assignStep(db, { actor: "agent-pm", now: 1200 }, { taskId: "task", step: "review", executorKind: "agent", executor: reviewer.agent });
  let localWrites = 0;
  const handlers = reviewToolHandlers(async () => { localWrites++; return { ok: true }; }, { get: () => db });
  expect(await handlers.submit_verdict!(reviewer, verdict)).toMatchObject({ ok: true });
  expect(sent[0]).toMatchObject({ type: "task.review", payload: { verdict: "pass", reportArtifactId: "review-artifact", head } });
  expect(localWrites).toBe(0);
  expect(await sharedExecVerdict({ ...reviewer, sessionId: null }, verdict, deps())).toMatchObject({ code: "identity_incomplete" });
  context.task!.head = "c".repeat(40);
  expect(await sharedExecVerdict(reviewer, verdict, deps())).toMatchObject({ code: "head_mismatch" });
  expect(state.writes).toBe(1);
});
test("actual start_node handler performs task.new + dag.bind without local manager/worktree/agent actions", async () => {
  let localActions = 0;
  const no = () => { localActions++; throw Error("unexpected local start"); };
  const d: DagToolDeps = { db: () => db, manager: async () => no(), callerProject: () => "project", startEnv: no, stepIO: no };
  expect(await dagToolHandlers(d).start_node!(author, { featureId: "feature", key: "write", spec: "synthetic/spec.md" })).toMatchObject({ ok: true });
  expect(sent.map(c => c.type)).toEqual(["task.new", "dag.bind"]);
  expect(sent[1]).toMatchObject({ payload: { taskId: "new-task", expectedTaskRev: 2, featureId: "feature", nodeKey: "write" } });
  expect(localActions).toBe(0); expect(JSON.stringify(sent)).not.toContain("synthetic/spec.md");
});
test("start retry uses stable request ids; authority revoked after creation prevents bind", async () => {
  const f = getFeature(db, "feature")!;
  expect(await sharedExecStart(author, f, "write", {}, deps())).toMatchObject({ ok: true });
  const ids = sent.map(c => c.requestId); sent = [];
  expect(await sharedExecStart(author, f, "write", {}, deps())).toMatchObject({ ok: true });
  expect(sent.map(c => c.requestId)).toEqual(ids); sent = [];
  configureSharedExecEntry({ ...port, toolContext: async () => context });
  expect(await sharedExecStart({ ...author, sessionId: "next-session" }, f, "write", {}, deps())).toMatchObject({ ok: true });
  expect(sent.map(c => c.requestId)).toEqual(ids); sent = [];
  const clientFor = port.clientFor;
  configureSharedExecEntry({ ...port, clientFor: (p, project) => {
    const client = clientFor(p, project)!;
    return { ...client, command: async c => { const r = await client.command(c); state.mode = "off"; return r; } };
  } });
  expect(await sharedExecStart(author, f, "write", {}, deps())).toMatchObject({ code: "unavailable" });
  expect(sent.map(c => c.type)).toEqual(["task.new"]);
});
test("migration during context await holds all MCP writes, including first start command", async () => {
  configureSharedExecEntry({ ...port, toolContext: async () => {
    state.route = "skip"; state.migrating = true; return context;
  } });
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ code: "migrating" });
  state.route = "central"; state.migrating = false;
  expect(await sharedExecStart(author, getFeature(db, "feature")!, "write", {}, deps())).toMatchObject({ code: "migrating" });
  expect(sent).toEqual([]);
});
