import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";

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
  setMeta(db, owner, { project: "project", key: "pms", value: ["agent-pm", author.agent] });
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
    reviewEvidence: { wireDigest: v2ObjectDigest(verdict), sameFamily: null },
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
  const pm = { ...author, agent: "agent-pm" };
  configureSharedExecEntry({ ...port, toolContext: async call => { expect(call).toEqual(pm); return context; } });
  expect(await dagToolHandlers(d).start_node!(pm, { featureId: "feature", key: "write", spec: "synthetic/spec.md" })).toMatchObject({ ok: true });
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
test("R1 start-gate-bypass: unrelated worker is forbidden before context in central and local routes", async () => {
  const worker = { ...author, agent: "agent-worker" };
  configureSharedExecEntry({ ...port, toolContext: async () => { state.contexts++; return context; } });
  const no = () => { throw Error("unexpected local action"); };
  const d: DagToolDeps = { db: () => db, manager: async () => no(), callerProject: () => "project", startEnv: no, stepIO: no };
  for (const route of ["central", "local"] as const) {
    state.route = route;
    expect(await dagToolHandlers(d).start_node!(worker, { featureId: "feature", key: "write" })).toMatchObject({ code: "forbidden" });
  }
  expect(state.contexts).toBe(0); expect(sent).toEqual([]);
});
test("R1 verdict-self-review-bypass: an assigned reviewer who wrote the card cannot send task.review", async () => {
  db.run("UPDATE tasks SET stage='review', headSHA=? WHERE id='task'", [head]);
  assignStep(db, { actor: "agent-pm", now: 1200 }, { taskId: "task", step: "review", executorKind: "agent", executor: author.agent });
  configureSharedExecEntry({ ...port, toolContext: async () => { state.contexts++; return context; } });
  expect(await reviewToolHandlers(async () => { throw Error("unexpected local writer"); }, { get: () => db })
    .submit_verdict!(author, verdict)).toMatchObject({ code: "self_review" });
  expect(state.contexts).toBe(0); expect(sent).toEqual([]);
});
test("R1 corrupt mode state is distinguished from center unavailability and never authorizes fallback", async () => {
  configureSharedExecEntry(null);
  writeFileSync(join(dir, "shared-ledger-modes.json"), "{ not json");
  const modeOf = (fid: string) => readSharedLedgerMode(fid, dir);
  expect(await sharedExecDeliver(author, wire, { db, modeOf })).toMatchObject({ code: "mode_unreadable" });
  expect(await sharedExecStart(author, getFeature(db, "feature")!, "write", {}, { db, modeOf })).toMatchObject({ code: "mode_unreadable" });
  const no = () => { throw Error("unexpected local action"); };
  const d: DagToolDeps = { db: () => db, modeOf, manager: async () => no(), callerProject: () => "project", startEnv: no, stepIO: no };
  expect(await dagToolHandlers(d).start_node!({ ...author, agent: "agent-pm" }, { featureId: "feature", key: "write" }))
    .toMatchObject({ code: "mode_unreadable" });
  expect(sent).toEqual([]);
});
test("R1 disputes and memory refs are explicitly refused before any central mapping or write", async () => {
  for (const extra of [
    { disputes: [{ findingId: "lease-race", reason: "reproduction disproves it" }] },
    { memoryRefs: [{ id: "s2ee-m1", use: "applied" }] },
  ]) expect(await sharedExecDeliver(author, { ...wire, ...extra }, deps())).toMatchObject({ code: "unsupported" });
  expect(state.contexts).toBe(0); expect(sent).toEqual([]);
});
test("R1 findings require a matching structured review artifact acknowledgement", async () => {
  db.run("UPDATE tasks SET stage='review', headSHA=? WHERE id='task'", [head]);
  assignStep(db, { actor: "agent-pm", now: 1200 }, { taskId: "task", step: "review", executorKind: "agent", executor: reviewer.agent });
  const w = { ...verdict, verdict: "changes", p1: 1,
    findings: [{ findingId: "one", family: "authz", severity: "P1", probe: "repro", description: "explained", pitfall: true }] };
  expect(await sharedExecVerdict(reviewer, w, deps())).toMatchObject({ code: "unsupported" });
  context.reviewEvidence = undefined;
  expect(await sharedExecVerdict(reviewer, verdict, deps())).toMatchObject({ code: "unsupported" });
  expect(sent).toEqual([]);
});
test("R1 acknowledged review artifact retains findings/counts and trusted sameFamily", async () => {
  db.run("UPDATE tasks SET stage='review', headSHA=? WHERE id='task'", [head]);
  assignStep(db, { actor: "agent-pm", now: 1200 }, { taskId: "task", step: "review", executorKind: "agent", executor: reviewer.agent });
  const artifacts: unknown[] = [];
  configureSharedExecEntry({ ...port, toolContext: async (_call, _tool, _target, w) => {
    const parsed = w as { findings: unknown[]; p0: number; p1: number; p2: number };
    artifacts.push({ findings: parsed.findings, p0: parsed.p0, p1: parsed.p1, p2: parsed.p2, sameFamily: false });
    context.reviewEvidence = { wireDigest: v2ObjectDigest(w), sameFamily: false };
    return context;
  } });
  const w = { ...verdict, verdict: "changes", p1: 1, findings: [
    { findingId: "one", family: "authz", severity: "P1", probe: "repro", description: "explained", pitfall: true },
  ] };
  expect(await sharedExecVerdict(reviewer, w, { ...deps(), registry: [{ name: author.agent, runtime: "codex" }] }))
    .toMatchObject({ ok: true, sameFamily: false });
  expect(artifacts).toMatchObject([{ p0: 0, p1: 1, p2: 0, sameFamily: false, findings: [{ findingId: "one", pitfall: true, description: "explained" }] }]);
  expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ type: "task.review", payload: { reportArtifactId: "review-artifact" } });
});
test("R1 same-family review remains permitted but a false artifact family acknowledgement is refused", async () => {
  db.run("UPDATE tasks SET stage='review', headSHA=? WHERE id='task'", [head]);
  assignStep(db, { actor: "agent-pm", now: 1200 }, { taskId: "task", step: "review", executorKind: "agent", executor: reviewer.agent });
  configureSharedExecEntry({ ...port, toolContext: async () => context });
  const call = { ...reviewer, family: "codex" }, local = { ...deps(), registry: [{ name: author.agent, runtime: "codex" as const }] };
  context.reviewEvidence = { wireDigest: v2ObjectDigest(verdict), sameFamily: false };
  expect(await sharedExecVerdict(call, verdict, local)).toMatchObject({ code: "unsupported" }); expect(sent).toEqual([]);
  context.reviewEvidence.sameFamily = true;
  expect(await sharedExecVerdict(call, verdict, local)).toMatchObject({ ok: true, sameFamily: true });
});
test("R1 reviewer becomes an author during artifact mapping: repeat self-review guard before send", async () => {
  db.run("UPDATE tasks SET stage='review', headSHA=? WHERE id='task'", [head]);
  assignStep(db, { actor: "agent-pm", now: 1200 }, { taskId: "task", step: "review", executorKind: "agent", executor: reviewer.agent });
  configureSharedExecEntry({ ...port, toolContext: async () => {
    assignStep(db, { actor: "agent-pm", now: 1250 }, { taskId: "task", step: "fix", executorKind: "agent", executor: reviewer.agent });
    return context;
  } });
  expect(await sharedExecVerdict(reviewer, verdict, deps())).toMatchObject({ code: "self_review" });
  expect(sent).toEqual([]);
});
test("R1 PM revoked during context or after task.new cannot send the next central write", async () => {
  const f = getFeature(db, "feature")!;
  const revoke = () => setMeta(db, { actor: "owner", now: 1350 }, { project: "project", key: "pms", value: ["agent-pm"] });
  configureSharedExecEntry({ ...port, toolContext: async () => { revoke(); return context; } });
  expect(await sharedExecStart(author, f, "write", {}, deps())).toMatchObject({ code: "forbidden" }); expect(sent).toEqual([]);
  setMeta(db, { actor: "owner", now: 1400 }, { project: "project", key: "pms", value: ["agent-pm", author.agent] });
  const clientFor = port.clientFor;
  configureSharedExecEntry({ ...port, clientFor: (p, project) => {
    const client = clientFor(p, project)!;
    return { ...client, command: async c => { const r = await client.command(c); revoke(); return r; } };
  } });
  expect(await sharedExecStart(author, f, "write", {}, deps())).toMatchObject({ code: "forbidden" });
  expect(sent.map(c => c.type)).toEqual(["task.new"]);
});
test("S2E2 deliver: author swapped or order invalidated during context await sends zero task.deliver", async () => {
  const warn = console.warn, logged: unknown[][] = [];
  console.warn = (...a: unknown[]) => { logged.push(a); };
  try {
    const changes = [
      () => assignStep(db, { actor: "agent-pm", now: 1250 }, { taskId: "task", step: "write", executorKind: "agent", executor: "agent-other" }),
      () => db.run("UPDATE tasks SET stage='review' WHERE id='task'"),
      () => db.run("UPDATE tasks SET round=1 WHERE id='task'"),
    ];
    for (const change of changes) {
      configureSharedExecEntry({ ...port, toolContext: async () => { change(); return context; } });
      expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ ok: false, code: "not_current_order" });
      expect(sent).toEqual([]); expect(state.writes).toBe(0);
      assignStep(db, { actor: "agent-pm", now: 1300 }, { taskId: "task", step: "write", executorKind: "agent", executor: author.agent });
      db.run("UPDATE tasks SET stage='build', round=0 WHERE id='task'");
    }
    expect(logged).toEqual(changes.map(() => ["shared execution deliver refused: order changed during context lookup"]));
  } finally { console.warn = warn; }
  configureSharedExecEntry(port);
  expect(await sharedExecDeliver(author, wire, deps())).toMatchObject({ ok: true }); expect(sent.map(c => c.type)).toEqual(["task.deliver"]);
});
