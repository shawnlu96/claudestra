import { afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { getIntent, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { parseCommand, parseReceipt, v2ObjectDigest, type V2Command, type V2Fence } from "../src/lib/shared-ledger-contract-v2.js";
import { withSchedulerV2LedgerCmds, type SchedulerV2ExecutorCall, type SchedulerV2LedgerPort } from "../src/lib/scheduler-v2-ledger-cmds.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
export const FENCE = { serviceGeneration: 1, epoch: 1, bootId: "boot-one" };
export function coded(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
export function seq(db: Database): number {
  return (db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
}

/** A recording scope models event fencing and rollback on this synthetic database; production write gates are not imported. */
function fakeScope<T>(fn: () => T): T {
  const { db, ref } = (fn as SchedulerV2ExecutorCall<T>).executor;
  return db.transaction(() => {
    const before = seq(db);
    db.run("DROP TRIGGER events_no_update");
    const result = fn();
    db.query("UPDATE events SET data=json_set(data, '$.fence', json(?), '$.claimFence', json(?)) WHERE seq > ? AND kind='scheduler'")
      .run(JSON.stringify(ref.fence), JSON.stringify(ref.claimFence), before);
    db.run("CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END");
    return result;
  }).immediate();
}

export function ledgercmdFixture() {
  const f = autoFixture();
  cleanup.push(f.close);
  f.db.query("UPDATE tasks SET extra=? WHERE id='T1'").run(JSON.stringify({ ...f.task().extra, sharedFeatureId: "feature-one" }));
  let fence: V2Fence | null = { ...FENCE }, route: "central" | "local" | "skip" = "central";
  let reject: string | null = null, scopeReject: string | null = null;
  const requests: V2Command[] = [], scopes: unknown[] = [], observations: string[] = [], projected = new Map<string, SchedulerIntent>();
  const proposedResources = new Map<string, readonly string[]>();
  let syncs = 0, managerCalls = 0, projectStage: string | null = null;
  const seed = (id: string, action: SchedulerIntent["action"], status: SchedulerIntent["status"] = "pending", node = "write") => {
    const task = f.task();
    const row: SchedulerIntent = { id, taskId: task.id, project: task.project, node, action, recipient: action === "dispatch" ? task.agent : null,
      causalSeq: seq(f.db), eventSeq: seq(f.db), taskRev: task.rev, specRev: task.specRev, head: task.headSHA, templateVersion: 2,
      status, attempts: status === "submitted" ? 1 : 0, receipt: null, reason: `${action} plan`, createdAt: 1000, updatedAt: 1000 };
    projected.set(id, row);
    return row;
  };
  const port: SchedulerV2LedgerPort = {
    route: () => route, db: () => f.db, fence: () => fence, registryPath: f.registryPath,
    context: () => fence && ({ teamId: "team", projectId: "center-project", serviceGeneration: fence.serviceGeneration,
      bootId: fence.bootId, homeInstanceId: "home", fence: { ...fence } }),
    scope: fn => { scopes.push((fn as SchedulerV2ExecutorCall<unknown>).executor.ref); if (scopeReject) throw coded(scopeReject); return fakeScope(fn); },
    observe: (_task, code) => { observations.push(code); },
    verify: async () => ({ ok: true, result: "pass", checks: [], checklistSource: "fixture" }),
    planData: (_project, _task, id, resources) => {
      proposedResources.set(id, resources);
      return { dependencyDigest: "d".repeat(64), resources: resources.filter(key => !key.includes(":"))
        .map(path => ({ teamId: "team", projectId: "center-project", repository: "example/repo", kind: "file", path })) };
    },
    clientFor: () => ({ command: async input => {
      const command = parseCommand(input);
      requests.push(command);
      if (reject) throw coded(reject);
      let id = "T1";
      if (command.type === "intent.create") {
        id = command.payload.operationId;
        seed(id, command.payload.action as SchedulerIntent["action"], "pending", command.payload.node);
      } else if (command.type === "intent.check" || command.type === "intent.cancel") {
        id = command.payload.intentId;
        projected.get(id)!.status = command.type === "intent.check" ? "submitted" : "cancelled";
      } else if (command.type === "operation.result") {
        id = command.payload.result.intentId;
        projected.get(id)!.status = command.payload.result.state === "unknown" ? "unknown" : "done";
      } else if (command.type === "task.stage") projectStage = command.payload.to;
      return parseReceipt({ schemaVersion: 2, teamId: command.teamId, projectId: command.projectId, serviceGeneration: command.serviceGeneration,
        requestId: command.requestId, personId: "person", instanceId: "home", commandDigest: v2ObjectDigest(command), command: command.type,
        serverSeq: requests.length, committedAt: 2000, result: { entityId: id, rev: 1, specRev: 1, version: null, epoch: command.epoch,
          operationId: command.type.startsWith("intent.") || command.type === "operation.result" ? id : null } });
    } }),
    sync: async () => {
      syncs++;
      for (const row of projected.values()) {
        f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,recipient,causalSeq,eventSeq,taskRev,specRev,head,
          templateVersion,status,attempts,receipt,reason,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,updatedAt=excluded.updatedAt`)
          .run(...Object.values(row));
        if (["done", "cancelled"].includes(row.status)) f.db.query("DELETE FROM scheduler_resources WHERE intentId=?").run(row.id);
        else for (const resource of proposedResources.get(row.id) ?? []) {
          f.db.query("INSERT OR IGNORE INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt,scope) VALUES ('p',?,'T1',?,1000,'intent')")
            .run(resource, row.id);
        }
      }
      if (projectStage) { f.db.query("UPDATE tasks SET stage=?,rev=rev+1 WHERE id='T1'").run(projectStage); projectStage = null; }
      f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (2000,'fake-projection','p','T1','task','projection',?)")
        .run(JSON.stringify({ op: "center-projection", centerSeq: syncs }));
    },
  };
  const manager = withSchedulerV2LedgerCmds(async (...args) => { managerCalls++; return f.tickDeps.manager(...args); }, port);
  const plan = (id: string, action: string, node = "restate", resources = "task:s1") => ["ledger", "scheduler-plan", "T1", "--id", id,
    "--rev", String(f.task().rev), "--workflow-rev", "1", "--seq", String(seq(f.db)), "--node", node, "--action", action,
    "--reason", `${action} plan`, ...(resources ? ["--resources", resources] : [])];
  const settle = (id: string, from: string, to: string) => manager("ledger", "scheduler-settle", id, "--from", from, "--to", to, "--receipt", "evidence");
  return { f, port, manager, plan, settle, requests, scopes, observations, seed, projected,
    counters: () => ({ syncs, managerCalls }), setFence: (value: V2Fence | null) => { fence = value; },
    setRoute: (value: typeof route) => { route = value; }, reject: (code: string | null) => { reject = code; },
    rejectScope: (code: string | null) => { scopeReject = code; }, intent: (id: string) => getIntent(f.db, id) };
}
