import { describe, expect, test } from "bun:test";
import { SCHEDULER_V2_LEDGER_COMMANDS } from "../src/lib/scheduler-v2-ledger-cmds-args.js";
import { withSchedulerV2LedgerCmds } from "../src/lib/scheduler-v2-ledger-cmds.js";
import { createTask } from "../src/lib/ledger-write.js";
import { FENCE, ledgercmdFixture, ledgercmdReviewedMerge, seq } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";

describe("stage2 central ledger commands", () => {
  test("dispatch creates one central intent, then sync supplies the old plan reply", async () => {
    const s = ledgercmdFixture();
    const result = await s.manager(...s.plan("dispatch-one", "dispatch", "restate", "task:s1,src/lib/x.ts"));
    expect(result).toMatchObject({ ok: true, duplicate: false, intent: { id: "dispatch-one", taskId: "T1", action: "dispatch", status: "pending" } });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ type: "intent.create", payload: { operationId: "dispatch-one", resources: [{ kind: "file", path: "src/lib/x.ts" }] } });
    expect(s.counters()).toEqual({ syncs: 1, managerCalls: 0 });
    expect(s.scopes).toHaveLength(0);
  });

  test("center errors preserve the exact code and leave the ledger untouched", async () => {
    const s = ledgercmdFixture(), before = seq(s.f.db);
    s.reject("stale_epoch");
    expect(await s.manager(...s.plan("denied", "dispatch"))).toEqual({ ok: false, code: "stale_epoch" });
    expect(s.intent("denied")).toBeNull();
    expect(seq(s.f.db)).toBe(before);
    expect(s.counters()).toEqual({ syncs: 0, managerCalls: 0 });
  });

  test.each(["done", "unknown", "cancelled"])("settle %s maps to the right center command and syncs", async to => {
    const s = ledgercmdFixture();
    await s.manager(...s.plan("one", "dispatch"));
    expect(await s.settle("one", "pending", "submitted")).toMatchObject({ ok: true, intent: { status: "submitted" } });
    expect(s.requests[1].type).toBe("intent.check");
    expect(await s.settle("one", "submitted", to)).toMatchObject({ ok: true, intent: { status: to } });
    expect(s.requests[2].type).toBe(to === "cancelled" ? "intent.cancel" : "operation.result");
    expect(s.counters()).toEqual({ syncs: 3, managerCalls: 0 });
  });

  test("stage and verify go through task.stage and reread the projected task", async () => {
    const s = ledgercmdFixture();
    s.seed("stage-one", "stage"); await s.port.sync("p", "feature-one");
    expect(await s.manager("ledger", "scheduler-stage", "stage-one", "--to", "build")).toMatchObject({ ok: true, task: { stage: "build" }, duplicate: false });
    expect(s.requests.at(-1)).toMatchObject({ type: "task.stage", payload: { from: "spec", to: "build" } });
    s.f.db.query("UPDATE tasks SET stage='live' WHERE id='T1'").run();
    expect(await s.manager("ledger", "verify", "T1")).toMatchObject({ ok: true, moved: true, task: { stage: "verified" } });
    expect(s.requests.at(-1)).toMatchObject({ type: "task.stage", payload: { to: "verified" } });
    expect(s.counters().managerCalls).toBe(0);
  });

  test("missing context, client, plan data and merge authorization hold without requests", async () => {
    for (const missing of ["context", "client", "plan", "authorization"]) {
      const s = ledgercmdFixture();
      if (missing === "context") delete s.port.context;
      if (missing === "client") s.port.clientFor = () => null;
      if (missing === "plan") delete s.port.planData;
      expect(await s.manager(...s.plan("missing", missing === "authorization" ? "merge" : "dispatch"))).toEqual({ ok: false, code: "v2_unmapped" });
      expect(s.requests).toHaveLength(0);
      expect(s.counters()).toEqual({ syncs: 0, managerCalls: 0 });
    }
  });

  test("every classified command on a central card avoids the real manager", async () => {
    const s = ledgercmdFixture();
    s.seed("intent", "dispatch"); await s.port.sync("p", "feature-one");
    for (const [command, entry] of Object.entries(SCHEDULER_V2_LEDGER_COMMANDS)) {
      const args = ["ledger", command, entry.target === "intent" ? "intent" : "T1"];
      if (entry.target === "order") args[2] = "lend:T1:s1:r1:a0";
      if (entry.target === "session-intent") args.push("--intent", "intent");
      const result = await s.manager(...args);
      expect(result.ok, command).toBe(false);
      if (entry.handling === "unmapped") expect(result.code, command).toBe("v2_unmapped");
    }
    expect(s.counters().managerCalls).toBe(0);
  });

  test("local/skip, off and missing intent calls preserve the exact returned object", async () => {
    const s = ledgercmdFixture(), sentinel = { ok: true, opaque: {} }, calls: string[][] = [];
    const manager = withSchedulerV2LedgerCmds(async (...args) => { calls.push(args); return sentinel; }, s.port);
    for (const route of ["local", "skip"] as const) {
      s.setRoute(route);
      expect(await manager(...s.plan("one", "dispatch"))).toBe(sentinel);
    }
    s.setRoute("central");
    expect(await manager("ledger", "scheduler-settle", "not-projected", "--from", "pending", "--to", "submitted")).toBe(sentinel);
    expect(calls).toHaveLength(3);
    expect(s.requests).toHaveLength(0);
  });

  test("verification dry-run and failed checklists never send task.stage", async () => {
    const s = ledgercmdFixture(), before = seq(s.f.db);
    expect(await s.manager("ledger", "verify", "T1", "--dry-run")).toMatchObject({ ok: true, dryRun: true, task: "T1", checks: [] });
    s.port.verify = async () => ({ ok: true, result: "fail", checks: ["red check"] });
    expect(await s.manager("ledger", "verify", "T1")).toMatchObject({ ok: false, code: "unverified", moved: false });
    delete s.port.verify;
    expect(await s.manager("ledger", "verify", "T1", "--dry-run")).toEqual({ ok: false, code: "v2_unmapped" });
    expect(s.requests).toHaveLength(0);
    expect(seq(s.f.db)).toBe(before);
  });

  test("invalid snapshot fields and local resource conflicts fail before a center request", async () => {
    const s = ledgercmdFixture(), planData = s.port.planData!;
    s.port.planData = (...args) => ({ ...planData(...args)!, dependencyDigest: "invalid-digest" });
    expect(await s.manager(...s.plan("bad", "dispatch"))).toEqual({ ok: false, code: "v2_unmapped" });
    s.port.planData = planData;
    createTask(s.f.db, { actor: "owner", now: 2000 }, { project: "p", id: "another-card", title: "other", kind: "code" });
    s.f.db.query("INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt) " +
      "VALUES ('other','another-card','p','write','ensure_session',1,1,1,1,2,'done','other',1000,1000)").run();
    s.f.db.query("INSERT INTO scheduler_resources VALUES ('p','src/lib/x.ts','another-card','other',1000,'intent')").run();
    expect(await s.manager(...s.plan("busy", "dispatch", "restate", "src/lib/x.ts"))).toEqual({ ok: false, code: "conflict" });
    expect(s.requests).toHaveLength(0);
  });

  test("a mismatched receipt never triggers projection sync", async () => {
    const s = ledgercmdFixture(), client = s.port.clientFor("p")!;
    s.port.clientFor = () => ({ command: async command => ({ ...await client.command(command), requestId: "wrong-request" }) });
    expect(await s.manager(...s.plan("one", "dispatch"))).toEqual({ ok: false, code: "dedup_mismatch" });
    expect(s.intent("one")).toBeNull();
    expect(s.counters().syncs).toBe(0);
  });

  test.each(["dispatch", "stage", "review", "merge", "verify"])("plan %s uses intent.create with recorded authorization", async action => {
    const s = ledgercmdFixture();
    if (action === "merge") await ledgercmdReviewedMerge(s);
    s.f.db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (1000,'fake-projection','p','T1','scheduler','',?,?)")
      .run(JSON.stringify({ authorizationAskId: "owner-ask", authorizationDigest: "a".repeat(64) }), "scheduler:planned");
    expect(await s.manager(...s.plan("planned", action, action === "merge" ? "merge_deploy" : "restate"))).toMatchObject({ ok: true, intent: { action } });
    expect(s.requests[0]).toMatchObject({ type: "intent.create", payload: { action, authorizationAskId: "owner-ask", authorizationDigest: "a".repeat(64) } });
    expect(s.counters().managerCalls).toBe(0);
  });

  test("a failed sync cannot return a successful old command reply", async () => {
    const s = ledgercmdFixture();
    s.port.sync = async () => { throw new Error("offline projection"); };
    expect(await s.manager(...s.plan("one", "dispatch"))).toEqual({ ok: false, code: "unavailable" });
    expect(s.intent("one")).toBeNull();
    expect(s.requests).toHaveLength(1);
    expect(s.counters().managerCalls).toBe(0);
  });

  test("switch or lease changes while checking verification stop the subsequent center write", async () => {
    for (const change of ["switch", "lease", "epoch"]) {
      const s = ledgercmdFixture();
      s.f.db.query("UPDATE tasks SET stage='live' WHERE id='T1'").run();
      s.port.verify = async () => {
        if (change === "switch") s.setRoute("skip");
        else s.setFence(change === "lease" ? null : { ...FENCE, epoch: 2 });
        return { ok: true, result: "pass" };
      };
      expect(await s.manager("ledger", "verify", "T1")).toEqual({ ok: false,
        code: change === "switch" ? "v2_unmapped" : change === "lease" ? "lease_lost" : "stale_epoch" });
      expect(s.requests).toHaveLength(0);
      expect(s.f.task().stage).toBe("live");
    }
  });
});

describe("stage2 executor bookkeeping", () => {
  test("ensure plan/claim/bind/done writes fenced events and resource locks without center or sync", async () => {
    const s = ledgercmdFixture();
    expect(await s.manager(...s.plan("ensure-one", "ensure_session"))).toMatchObject({ ok: true, duplicate: false });
    expect(s.f.db.query("SELECT intentId FROM scheduler_resources WHERE resource='task:s1'").get()).toEqual({ intentId: "ensure-one" });
    await s.settle("ensure-one", "pending", "submitted");
    expect(await s.manager("ledger", "scheduler-session-bind", "T1", "--role", "author", "--intent", "ensure-one",
      "--agent", "agent-task-one", "--session", "s-one", "--family", "claude", "--transport", "acp"))
      .toMatchObject({ ok: true, session: { createIntentId: "ensure-one", state: "active" } });
    await s.settle("ensure-one", "submitted", "done");
    expect(s.f.db.query("SELECT * FROM scheduler_resources WHERE intentId='ensure-one'").all()).toHaveLength(0);
    const events = s.f.db.query("SELECT json_extract(data, '$.fence') AS fence FROM events WHERE kind='scheduler' AND actor='scheduler'").all() as { fence: string }[];
    expect(events).toHaveLength(4);
    for (const event of events) expect(JSON.parse(event.fence)).toEqual(FENCE);
    expect(s.requests).toHaveLength(0);
    expect(s.counters()).toEqual({ syncs: 0, managerCalls: 0 });
  });

  test("missing scope and missing lease do not write", async () => {
    const s = ledgercmdFixture(), before = seq(s.f.db), scope = s.port.scope;
    delete s.port.scope;
    expect(await s.manager(...s.plan("ensure-one", "ensure_session"))).toEqual({ ok: false, code: "v2_unmapped" });
    s.port.scope = scope; s.setFence(null);
    // A present context allows the adapter to distinguish lost lease from missing wiring.
    s.port.context = () => ({ teamId: "team", projectId: "center-project", serviceGeneration: 1, bootId: "boot-one", homeInstanceId: "home", fence: FENCE });
    expect(await s.manager(...s.plan("ensure-one", "ensure_session"))).toEqual({ ok: false, code: "lease_lost" });
    expect(seq(s.f.db)).toBe(before);
    expect(s.scopes).toHaveLength(0);
  });

  test.each(["epoch", "bootId", "serviceGeneration"])("changed %s refuses bind/done/cancelled but permits unknown", async field => {
    const s = ledgercmdFixture();
    await s.manager(...s.plan("ensure-one", "ensure_session")); await s.settle("ensure-one", "pending", "submitted");
    s.setFence({ ...FENCE, [field]: field === "bootId" ? "boot-two" : 2 });
    const before = seq(s.f.db);
    expect(await s.manager("ledger", "scheduler-session-bind", "T1", "--role", "author", "--intent", "ensure-one",
      "--agent", "agent-task-one", "--session", "s-one", "--family", "claude", "--transport", "acp")).toEqual({ ok: false, code: "stale_claim" });
    for (const to of ["done", "cancelled"]) expect(await s.settle("ensure-one", "submitted", to)).toEqual({ ok: false, code: "stale_claim" });
    expect(seq(s.f.db)).toBe(before);
    expect(await s.settle("ensure-one", "submitted", "unknown")).toMatchObject({ ok: true, intent: { status: "unknown" } });
    expect(s.requests).toHaveLength(0);
  });

  test("scope rejection is returned unchanged and rolls back the write", async () => {
    const s = ledgercmdFixture();
    s.rejectScope("forbidden");
    expect(await s.manager(...s.plan("ensure-one", "ensure_session"))).toEqual({ ok: false, code: "forbidden" });
    expect(s.intent("ensure-one")).toBeNull();
  });

  test("retire, session-retire and settle remain local with the original claim", async () => {
    const s = ledgercmdFixture();
    await s.manager(...s.plan("ensure-one", "ensure_session")); await s.settle("ensure-one", "pending", "submitted");
    await s.manager("ledger", "scheduler-session-bind", "T1", "--role", "author", "--intent", "ensure-one",
      "--agent", "agent-task-one", "--session", "s-one", "--family", "claude", "--transport", "acp");
    await s.settle("ensure-one", "submitted", "done");
    s.f.db.query("UPDATE tasks SET stage='verified' WHERE id='T1'").run();
    expect(await s.manager("ledger", "scheduler-retire", "T1")).toMatchObject({ ok: true, intent: { action: "retire", status: "submitted" } });
    for (const effect of ["archive", "kill"]) {
      expect(await s.manager("ledger", "scheduler-session-retire", "T1", "--role", "author", "--intent", "retire:T1", "--effect", effect,
        "--receipt", "retired evidence")).toMatchObject({ ok: true });
    }
    expect(await s.settle("retire:T1", "submitted", "done")).toMatchObject({ ok: true });
    expect(s.requests).toHaveLength(0);
    expect(s.counters()).toEqual({ syncs: 0, managerCalls: 0 });
  });
});
