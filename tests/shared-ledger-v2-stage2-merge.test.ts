import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureSchedulerV2Merge, parseSchedulerV2MergeSha, SchedulerV2MergeWait,
  withSchedulerV2Merge, wrapSchedulerV2MergeGh, reconcileSchedulerV2MergeOutbox,
  type SchedulerV2MergePort } from "../src/lib/scheduler-v2-merge.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { type MergeRun } from "../src/lib/scheduler-merge.js";
import { SchedulerCentralJournal } from "../src/lib/scheduler-central-journal.js";
import { parseSchedulerCentralContext, type SchedulerCentralCommand } from "../src/lib/scheduler-central-context.js";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { parseAuthorizationBind, parseCommand, parseReceipt, V2ContractError, v2ObjectDigest, type V2Command, type V2OperationResult,
} from "../src/lib/shared-ledger-contract-v2.js";
import { testChildEnv } from "./test-env.js";

const H = "b".repeat(40), M = "c".repeat(40), PR = "https://github.com/team/repository/pull/1";
const project = { repoDir: "/synthetic/repository", requiredChecks: ["check"], maxActiveWorkers: 1 };
const dirs: string[] = [], databases: Database[] = [];
function receiptFor(command: V2Command, corrupt = false) {
  const operationId = "operationId" in command.payload ? command.payload.operationId
    : "result" in command.payload ? command.payload.result.operationId : null;
  return parseReceipt({ ...V2_DTO_FIXTURES.receipt.valid as object, requestId: command.requestId, command: command.type,
    commandDigest: corrupt ? "f".repeat(64) : v2ObjectDigest(command),
    result: { entityId: "task", rev: 1, specRev: 1, version: null, epoch: command.epoch, operationId } });
}
afterEach(() => {
  configureSchedulerV2Merge(null);
  for (const db of databases.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(train: "serial" | "train" = "serial") {
  const dir = mkdtempSync(join(tmpdir(), "stage2-merge-")); dirs.push(dir);
  const db = new Database(join(dir, "ledger.sqlite")); databases.push(db);
  db.exec("CREATE TABLE tasks(id TEXT, featureId TEXT, project TEXT, pr TEXT); CREATE TABLE events(text TEXT)");
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?)").run("task", "feature", "project", PR);
  const bind = parseAuthorizationBind((V2_DTO_FIXTURES.authorizationBind.valid));
  const context = parseSchedulerCentralContext({ teamId: "team", projectId: "project", serviceGeneration: 1, epoch: 1,
    bootId: "boot-local", homeInstanceId: "local", taskId: "task", intentId: "merge-intent", operationId: "merge-operation",
    taskRev: 1, specRev: 1, workflowRev: 1, head: H, action: "merge", authorizationAskId: "ask",
    authorizationDigest: v2ObjectDigest(bind), authorizationBind: bind });
  const state = { mode: "on" as "off" | "observe" | "on", execution: true, migrating: false, held: true,
    missing: false, rejection: null as "authorization_expired" | "authorization_mismatch" | null,
    failMerge: false, dropResult: false, corruptReceipt: false };
  const log: string[] = [], commands: SchedulerCentralCommand[] = [], observations: string[] = [];
  const center = { result: null as V2OperationResult | null };
  const journal = new SchedulerCentralJournal(join(dir, "journal"));
  let snapshot: PrSnapshot = { state: "OPEN", head: H, branch: "feat/example", base: "main", draft: false,
    crossRepository: false, mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }] };
  const runtime = { instanceId: "local", lock: { held: () => state.held }, client: { async command(command: SchedulerCentralCommand) {
    parseCommand(command); commands.push(command); log.push(command.type);
    if (state.rejection && command.type === "authorization.check") throw new V2ContractError(state.rejection);
    if (command.type === "operation.result") {
      center.result = command.payload.result;
      if (state.dropResult) throw Error("lost response");
    }
    return receiptFor(command, state.corruptReceipt);
  } } };
  const external: MergeExternal = {
    inspect: async () => { log.push("inspect"); return snapshot; },
    freshness: async () => ({ behindBy: 0, mainHead: M }),
    carryReview: async () => ({ ok: false, reason: "synthetic" }),
    updateBranch: async () => { log.push("updateBranch"); },
    merge: async (pr, head) => {
      expect([pr, head]).toEqual([PR, H]); log.push("merge");
      expect(journal.read(context)?.steps[0]?.state).toBe("started");
      if (state.failMerge) throw Error("gh merge timeout");
      snapshot = { ...snapshot, state: "MERGED", mergeSha: M }; return M;
    },
    ...(train === "train" ? { train: async () => { log.push("train"); return "cleared" as const; } } : {}),
  };
  const port: SchedulerV2MergePort = {
    taskForPr: (pr) => {
      const row = db.query("SELECT * FROM tasks WHERE pr=?").get(pr) as { id: string; project: string; featureId: string } | null;
      return row ? { taskId: row.id, projectId: row.project, featureId: row.featureId } : null;
    },
    route: () => state.migrating ? "skip" : !state.execution ? "local" : state.mode === "on" ? "central" : "skip",
    context: () => state.missing ? null : context, runtime: () => runtime, journal,
    reconcile: async () => { log.push("reconcile"); return center.result; },
    observe: (d) => observations.push(d.reason),
  };
  configureSchedulerV2Merge(port);
  const wrapped = () => withSchedulerV2Merge(external, project);
  const base: MergeRun = { intentId: context.intentId, taskId: "task", project: "project", prRef: PR, reviewedHead: H,
    expectedBranch: "feat/example", requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
  return { dir, db, state, log, commands, observations, context, runtime, journal, external, port, wrapped, base };
}

for (const train of ["serial", "train"] as const) {
  for (const blocked of ["skip", "migrating", "missing", "authorization_expired", "authorization_mismatch"] as const) {
    test(`${train}: ${blocked} waits without changing the merge queue, then approval unblocks`, async () => {
      const h = harness(train);
      h.external.freshness = async () => ({ behindBy: 1, mainHead: M });
      if (blocked === "skip") h.state.mode = "off";
      else if (blocked === "migrating") h.state.migrating = true;
      else if (blocked === "missing") h.state.missing = true;
      else h.state.rejection = blocked;
      let row = { ...h.base };
      const advance = async (_from: MergeRun["phase"], to: MergeRun["phase"], _rev: number, reason?: string, sha?: string) => {
        h.log.push(`queue:${to}`); row = { ...row, phase: to, rev: row.rev + 1, reason: reason ?? null, mergeSha: sha ?? null }; return row;
      };
      const wrapped = h.wrapped();
      expect(await wrapped.train!(row)).toBe("wait");
      await driveMerge(row, wrapped, advance);
      expect(row.phase).toBe("ready");
      expect(h.log).not.toContain("merge"); expect(h.log).not.toContain("updateBranch");
      expect(h.log).not.toContain("queue:unknown"); expect(h.observations.at(-1)).toContain("等待中心合并：");
      if (["skip", "migrating", "missing"].includes(blocked)) expect(h.commands).toEqual([]);
      h.state.mode = "on"; h.state.migrating = false; h.state.missing = false; h.state.rejection = null;
      h.external.freshness = async () => ({ behindBy: 0, mainHead: M });
      await driveMerge(row, h.wrapped(), advance);
      if (row.phase === "await_ci") await driveMerge(row, h.wrapped(), advance);
      expect(row.phase).toBe("merged"); expect(row.mergeSha).toBe(M);
      expect(h.log.filter(x => x === "merge")).toHaveLength(1);
      expect(h.commands.some(c => (c.type as string) === "intent.create")).toBe(false);
    });
  }
}

test("merge checks exact owner binding and existing intent before effect, then reports the SHA", async () => {
  const h = harness(), wrapped = h.wrapped();
  expect(wrapped.inspect).toBe(h.external.inspect); expect(wrapped.freshness).toBe(h.external.freshness);
  expect(wrapped.carryReview).toBe(h.external.carryReview);
  expect(await wrapped.merge(PR, H)).toBe(M);
  expect(h.log).toEqual(["authorization.check", "intent.check", "merge", "operation.result"]);
  const authorization = h.commands[0];
  expect(authorization?.type).toBe("authorization.check");
  if (authorization?.type === "authorization.check") expect(authorization.payload.action).toBe("merge");
  const result = h.journal.read(h.context)!.result!;
  expect(result.head).toBe(H); expect(result.summary).toBe(`mergeSha:${M}`);
  expect(parseSchedulerV2MergeSha(result.summary)).toBe(M);
  expect(h.db.query("SELECT * FROM events").all()).toEqual([]);
});

test("fresh check IDs prevent reusing an earlier authorization receipt", async () => {
  const h = harness();
  await h.wrapped().train!(h.base); await h.wrapped().train!(h.base);
  expect(new Set(h.commands.map(c => c.requestId)).size).toBe(4);
});

test("observe hints contain fixed reasons, never the transport's raw PR or center message", async () => {
  const h = harness();
  h.runtime.client.command = async () => { throw Error(`private center response ${PR}`); };
  expect(await h.wrapped().train!(h.base)).toBe("wait");
  expect(h.observations).toEqual(["等待中心合并：unavailable"]);
});

test("trusted task lookup can bind a different local feature ID to its center feature", async () => {
  const h = harness();
  h.port.taskForPr = () => ({ taskId: "task", projectId: "project", featureId: "local-feature", centerFeatureId: "feature" });
  expect(await h.wrapped().merge(PR, H)).toBe(M);
});

for (const mutation of ["head", "feature", "ask", "lock", "receipt"] as const) {
  test(`invalid ${mutation} never sends merge or update`, async () => {
    const h = harness();
    if (mutation === "head") h.context.head = M;
    else if (mutation === "feature") h.port.taskForPr = () => ({ taskId: "task", projectId: "project", featureId: "other-feature" });
    else if (mutation === "ask") h.context.authorizationAskId = "";
    else if (mutation === "lock") h.state.held = false;
    else h.state.corruptReceipt = true;
    expect(await h.wrapped().train!(h.base)).toBe("wait");
    await expect(h.wrapped().merge(PR, H)).rejects.toBeInstanceOf(SchedulerV2MergeWait);
    await expect(h.wrapped().updateBranch(PR)).rejects.toBeInstanceOf(SchedulerV2MergeWait);
    expect(h.log).not.toContain("merge"); expect(h.log).not.toContain("updateBranch");
  });
}

test("timeout is durable unknown; a recreated wrapper reconciles first without retrying", async () => {
  const h = harness(); h.state.failMerge = true;
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("unknown_operation");
  expect(h.journal.read(h.context)?.result?.state).toBe("unknown");
  h.port.journal = new SchedulerCentralJournal(join(h.dir, "journal"));
  h.log.length = 0;
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("unknown_operation");
  expect(h.log).toEqual(["reconcile"]);
});

test("lost result receipt keeps unknown; reconciliation accepts only matching center success and PR SHA", async () => {
  const h = harness(); h.state.dropResult = true;
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("结果回执未确认");
  const result = h.journal.read(h.context)!.result!;
  expect(h.journal.read(h.context)?.state).toBe("unknown");
  h.state.dropResult = false;
  h.port.reconcile = async () => ({ ...result, intentId: "other-intent" });
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("对账结果与原意图不符");
  h.port.reconcile = async () => result;
  h.log.length = 0;
  expect(await h.wrapped().merge(PR, H)).toBe(M);
  expect(h.log).toEqual(["inspect"]); expect(h.journal.read(h.context)?.state).toBe("confirmed");
});

test("a crash after claiming cannot resend an operation even if no result exists", async () => {
  const h = harness(); h.journal.begin(h.context);
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("unknown_operation");
  expect(h.log).toEqual(["reconcile"]);
});

test("update-branch checks owner and intent; it cannot report the merge operation as completed", async () => {
  const h = harness(); await h.wrapped().updateBranch(PR);
  expect(h.log).toEqual(["inspect", "authorization.check", "intent.check", "updateBranch"]);
  expect(h.journal.read(h.context)?.result).toBeNull();
  await expect(h.wrapped().updateBranch(PR)).rejects.toThrow("须对账");
  expect(h.log.filter(x => x === "updateBranch")).toHaveLength(1);
});

test("routing is recalculated after online checks and immediately before sending", async () => {
  const h = harness(), send = h.runtime.client.command;
  h.runtime.client.command = async c => { const receipt = await send(c); if (c.type === "intent.check") h.state.migrating = true; return receipt; };
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("skip");
  expect(h.log).not.toContain("merge"); expect(h.journal.read(h.context)).toBeNull();
});

test("in-flight lease loss retains unknown rather than clearing resources", async () => {
  const h = harness(), merge = h.external.merge;
  h.external.merge = async (pr, head) => { const sha = await merge(pr, head); h.state.held = false; return sha; };
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("unknown_operation");
  expect(h.journal.read(h.context)?.result?.state).toBe("unknown");
});

test("optional central wiring missing holds without center requests", async () => {
  for (const key of ["context", "runtime", "journal"] as const) {
    const h = harness(); delete h.port[key];
    expect(await h.wrapped().train!(h.base)).toBe("wait");
    expect(h.commands).toEqual([]); expect(h.log).toEqual([]);
  }
});

for (const mode of ["off", "observe", "on"] as const) {
  test(`${mode}: legacy readers and mutations pass through; execution sends nothing unless on`, async () => {
    const h = harness(); h.state.execution = false; h.state.mode = mode;
    const wrapped = h.wrapped();
    await wrapped.inspect(PR); await wrapped.freshness(PR, H); await wrapped.carryReview(PR, H, M);
    await wrapped.updateBranch(PR);
    // The synthetic external checks the durable central claim only on the central path.
    h.external.merge = async () => { h.log.push("merge"); return M; };
    expect(await wrapped.merge(PR, H)).toBe(M);
    expect(h.log).toEqual(["inspect", "updateBranch", "merge"]); expect(h.commands).toEqual([]);
    expect(h.observations).toEqual(["local：沿用阶段一合并路径", "local：沿用阶段一合并路径"]);
    expect(h.db.query("SELECT * FROM events").all()).toEqual([]);
    h.state.execution = true;
    if (mode !== "on") {
      expect(await wrapped.train!(h.base)).toBe("wait");
      expect(h.commands).toEqual([]);
    }
  });
}

for (const execution of [false, true]) {
  test(`migrating ${execution ? "execution" : "planning"} holds both effects with zero transport`, async () => {
    const h = harness(); h.state.execution = execution; h.state.migrating = true;
    expect(await h.wrapped().train!(h.base)).toBe("wait");
    await expect(h.wrapped().merge(PR, H)).rejects.toThrow("skip");
    await expect(h.wrapped().updateBranch(PR)).rejects.toThrow("skip");
    expect(h.commands).toEqual([]); expect(h.log).toEqual([]);
  });
}

test("mergeSha parsing requires one exact standalone lowercase line", () => {
  expect(parseSchedulerV2MergeSha(`ok\nmergeSha:${M}\ncompleted`)).toBe(M);
  for (const summary of [`prefix mergeSha:${M}`, `mergeSha:${M.toUpperCase()}`, `mergeSha:${M}\nmergeSha:${M}`, `mergeSha:${H.slice(1)}`]) {
    expect(parseSchedulerV2MergeSha(summary)).toBeNull();
  }
});

test("null port consults only isolated projection: execution unavailable, planning passes, migrating holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stage2-merge-unwired-")); dirs.push(dir);
  const db = new Database(join(dir, "ledger.sqlite"));
  db.exec("PRAGMA user_version=1; CREATE TABLE tasks(id TEXT, featureId TEXT, project TEXT, pr TEXT)");
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?)").run("task", "feature", "project", PR); db.close();
  const script = `import {configureSchedulerV2Merge,withSchedulerV2Merge} from './src/lib/scheduler-v2-merge.ts';
    configureSchedulerV2Merge(null);let effects=0;
    const external={merge:async()=>{effects++;return '${M}'},updateBranch:async()=>{effects++},inspect:async()=>({head:'${H}'})};
    const wrapped=withSchedulerV2Merge(external,{repoDir:'/synthetic/repository'});
    let error='';try{await wrapped.merge('${PR}/','${H}');await wrapped.updateBranch('${PR}')}catch(e){error=e.message}
    console.log(JSON.stringify({effects,error}));`;
  for (const [mode, migrating, expected] of [["execution", false, "unavailable"], ["planning", false, ""],
    ["planning", true, "migrating"], ["execution", true, "migrating"]] as const) {
    writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { feature: {
      authorityMode: mode, sharedPlanning: true, ...(migrating ? { migrating: { batchId: "batch", kind: "home" } } : {}),
    } } }));
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], {
      env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
    const result = JSON.parse(stdout);
    expect(result.effects).toBe(expected ? 0 : 2); expect(result.error).toContain(expected);
  }
});

test("CI gh wrapper blocks a missing owner grant and uses the same checks when granted", async () => {
  const h = harness(), ghCalls: string[] = [];
  const gh = { mainSince: async () => ({ mergeBase: H, mainHead: M, commits: [] }), fileCommits: async () => [],
    updateBranch: async () => { ghCalls.push("gh-update"); } };
  const wrapped = wrapSchedulerV2MergeGh(gh, project, h.external);
  expect(wrapped.mainSince).toBe(gh.mainSince); expect(wrapped.fileCommits).toBe(gh.fileCommits);
  h.state.missing = true;
  await wrapped.updateBranch("team/repository", "1", H);
  expect(ghCalls).toEqual([]); expect(h.commands).toEqual([]);
  expect(h.observations.at(-1)).toContain("等待中心合并：");
  h.state.missing = false; await wrapped.updateBranch("team/repository", "1", H);
  expect(h.commands.map(c => c.type)).toEqual(["authorization.check", "intent.check"]);
  expect(ghCalls).toEqual(["gh-update"]);
});

test("CI gh legacy errors still propagate", async () => {
  const h = harness(); h.state.execution = false;
  const gh = { mainSince: async () => ({ mergeBase: H, mainHead: M, commits: [] }), fileCommits: async () => [],
    updateBranch: async () => { throw Error("legacy gh error"); } };
  await expect(wrapSchedulerV2MergeGh(gh, project, h.external).updateBranch("team/repository", "1", H)).rejects.toThrow("legacy gh error");
});

async function recoveryHarness() {
  const h = harness(); h.state.dropResult = true;
  await expect(h.wrapped().merge(PR, H)).rejects.toThrow("结果回执未确认");
  h.state.dropResult = false;
  const calls: Extract<V2Command, { type: "operation.reconcile" }>[] = [];
  h.port.contextForIntent = () => h.context; h.port.prForIntent = () => PR;
  h.port.reconcileCommand = async command => { parseCommand(command); calls.push(command); return receiptFor(command); };
  return { ...h, calls };
}

test("restart recovery reconciles GitHub success once using an owner client; repeats are idempotent", async () => {
  const h = await recoveryHarness();
  h.port.journal = new SchedulerCentralJournal(join(h.dir, "journal"));
  const result = await reconcileSchedulerV2MergeOutbox(h.context.intentId, h.external);
  expect(result).toEqual({ state: "succeeded", reason: "reconciled", mergeSha: M });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.payload.result.head).toBe(H);
  expect(h.calls[0]?.payload.result.summary).toBe(`mergeSha:${M}`);
  expect(h.journal.read(h.context)?.state).toBe("confirmed");
  expect((await reconcileSchedulerV2MergeOutbox(h.context.intentId, h.external)).state).toBe("succeeded");
  expect(h.calls).toHaveLength(1);
});

test("lost reconcile response reuses exact request/digest and never resends merge", async () => {
  const h = await recoveryHarness(), original = h.port.reconcileCommand!;
  let drop = true;
  h.port.reconcileCommand = async command => { const receipt = await original(command); if (drop) throw Error("response lost"); return receipt; };
  expect((await reconcileSchedulerV2MergeOutbox(h.context.intentId, h.external)).state).toBe("wait");
  expect(h.journal.read(h.context)?.state).toBe("unknown");
  drop = false;
  expect((await reconcileSchedulerV2MergeOutbox(h.context.intentId, h.external)).state).toBe("succeeded");
  expect(h.calls).toHaveLength(2); expect(h.calls[0]).toEqual(h.calls[1]);
  expect(h.log.filter(x => x === "merge")).toHaveLength(1);
});

test("recovery requires wiring, current route, owner authorization and a matching receipt", async () => {
  for (const blocked of ["wiring", "skip", "authorization", "receipt"] as const) {
    const h = await recoveryHarness();
    if (blocked === "wiring") delete h.port.reconcileCommand;
    else if (blocked === "skip") h.state.migrating = true;
    else if (blocked === "authorization") h.state.rejection = "authorization_expired";
    else h.port.reconcileCommand = async c => { h.calls.push(c); return receiptFor(c, true); };
    h.commands.length = 0;
    expect((await reconcileSchedulerV2MergeOutbox(h.context.intentId, h.external)).state).toBe("wait");
    expect(h.journal.read(h.context)?.state).toBe("unknown");
    if (blocked !== "receipt") expect(h.calls).toEqual([]);
    if (["wiring", "skip"].includes(blocked)) expect(h.commands).toEqual([]);
  }
});
