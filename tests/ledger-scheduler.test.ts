import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { activationSeq, getIntent, getWorkflow, schedulerProjectView } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "t68-ledger-"));
  const path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  const owner = { actor: "owner", now: 10 };
  const one = createTask(db, owner, { project: "p", id: "T1", title: "one", kind: "code", agent: "agent-one" }).row;
  const two = createTask(db, owner, { project: "p", id: "T2", title: "two", kind: "code", agent: "agent-two" }).row;
  const workflow = (id: string, rev = 1) => setWorkflow(db, owner, {
    taskId: id, taskRev: rev, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "收窄到只报错",
  }).workflow;
  const seq = () => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, dir, path, one, two, owner, workflow, seq, close };
}

describe("T68 durable scheduler facts", () => {
  test("only fresh code cards can opt in; PM configuration is versioned and written to events", () => {
    const f = fixture();
    try {
      expect(activationSeq(f.db)).toBe(0);
      const first = f.workflow("T1");
      expect([first.mode, first.rev, first.specRev]).toEqual(["auto", 1, 1]);
      expect(f.workflow("T1")).toEqual(first);
      expect(() => setWorkflow(f.db, { actor: "agent-one" }, {
        taskId: "T1", taskRev: 1, template: "code", templateVersion: 2,
        mode: "auto", authorFamily: "claude", fallback: "x",
      })).toThrow(/只有项目 PM/);
      expect(() => setWorkflow(f.db, f.owner, {
        taskId: "T2", taskRev: 1, template: "code", templateVersion: 2,
        mode: "auto", authorFamily: "claude", fallback: "",
      })).toThrow(/退路方案/);
      expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'scheduler' AND target = 'T1'").get()).toEqual({ n: 1 });
    } finally { f.close(); }
  });

  test("activation watermark excludes a pre-existing spec card", () => {
    const f = fixture();
    try {
      f.db.query("UPDATE scheduler_meta SET value = ? WHERE key = 'activationSeq'").run(String(f.seq()));
      expect(() => f.workflow("T1")).toThrow(/迁移后新建/);
      expect(getWorkflow(f.db, "T1")).toBeNull();
    } finally { f.close(); }
  });

  test("same-version scheduler table without eventSeq is repaired and backfilled from its decision event", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      const planned = planIntent(f.db, f.owner, { id: "legacy:T1", taskId: "T1", taskRev: 1, workflowRev: w.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch", reason: "legacy" }).intent;
      f.db.exec("DROP INDEX scheduler_intents_task");
      f.db.exec("ALTER TABLE scheduler_intents DROP COLUMN eventSeq");
      closeLedger(f.path);
      const repaired = openLedger(f.path);
      expect(getIntent(repaired, planned.id)?.eventSeq).toBe(planned.eventSeq);
    } finally { f.close(); }
  });

  test("migration turns an existing dispatch file claim into a card lease", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      planIntent(f.db, f.owner, { id: "old-dispatch", taskId: "T1", taskRev: 1, workflowRev: w.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch", reason: "legacy", resources: ["task:t1", "src/bridge.ts"] });
      f.db.exec(`CREATE TABLE legacy_resources (project TEXT NOT NULL, resource TEXT NOT NULL,
        taskId TEXT NOT NULL REFERENCES tasks(id), intentId TEXT NOT NULL REFERENCES scheduler_intents(id),
        acquiredAt INTEGER NOT NULL, PRIMARY KEY (project, resource));
        INSERT INTO legacy_resources SELECT project, resource, taskId, intentId, acquiredAt FROM scheduler_resources;
        DROP TABLE scheduler_resources;
        ALTER TABLE legacy_resources RENAME TO scheduler_resources;`);
      closeLedger(f.path);
      const repaired = openLedger(f.path);
      expect(repaired.query("SELECT resource, scope FROM scheduler_resources WHERE intentId = 'old-dispatch' ORDER BY resource").all())
        .toEqual([{ resource: "src/bridge.ts", scope: "card" }, { resource: "task:t1", scope: "intent" }]);
    } finally { f.close(); }
  });

  test("decision, intent and resource claim are atomic; replay does not write another event", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      const input = { id: "t68:T1:write:1", taskId: "T1", taskRev: 1, workflowRev: w.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch" as const, recipient: "agent-one",
        reason: "build 阶段派写", resources: ["src/lib/ledger-store.ts"] };
      const first = planIntent(f.db, f.owner, input);
      expect(first.duplicate).toBe(false);
      expect(first.intent.status).toBe("pending");
      expect(planIntent(f.db, f.owner, input).duplicate).toBe(true);
      expect(() => planIntent(f.db, f.owner, { ...input, resources: ["src/lib/other.ts"] })).toThrow(/intent key 已用于/);
      expect(f.db.query("SELECT COUNT(*) AS n FROM events WHERE dedupKey = ?").get(`scheduler:${input.id}`)).toEqual({ n: 1 });
      expect(f.db.query("SELECT taskId FROM scheduler_resources WHERE resource = ?").get(input.resources[0])).toEqual({ taskId: "T1" });
      const other = f.workflow("T2");
      expect(() => planIntent(f.db, f.owner, { ...input, id: "t68:T2:write:1", taskId: "T2", workflowRev: other.rev,
        causalSeq: f.seq(), recipient: "agent-two" })).toThrow(/T1 占用/);
      expect(getIntent(f.db, "t68:T2:write:1")).toBeNull();
    } finally { f.close(); }
  });

  test("scheduler identity is narrow and PM decisions keep their real actor", () => {
    const f = fixture();
    try {
      const a = f.workflow("T1"), b = f.workflow("T2");
      planIntent(f.db, f.owner, { id: "manual:T1", taskId: "T1", taskRev: 1, workflowRev: a.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch", reason: "PM manual plan" });
      expect(f.db.query("SELECT actor, json_extract(data, '$.manual') AS manual FROM events WHERE dedupKey = 'scheduler:manual:T1'").get())
        .toEqual({ actor: "owner", manual: 1 });
      planIntent(f.db, { actor: "scheduler" }, { id: "auto:T2", taskId: "T2", taskRev: 1, workflowRev: b.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch", reason: "automatic plan" });
      expect(f.db.query("SELECT actor, json_extract(data, '$.manual') AS manual FROM events WHERE dedupKey = 'scheduler:auto:T2'").get())
        .toEqual({ actor: "scheduler", manual: null });
      expect(() => setWorkflow(f.db, { actor: "scheduler" }, { taskId: "T1", taskRev: 1, workflowRev: a.rev,
        template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude", fallback: "stop" })).toThrow(/只有项目 PM/);
      settleIntent(f.db, { actor: "scheduler" }, { id: "auto:T2", from: "pending", to: "submitted" });
      expect(f.db.query("SELECT actor FROM events WHERE dedupKey = 'scheduler:auto:T2:submitted'").get()).toEqual({ actor: "scheduler" });
    } finally { f.close(); }
  });

  test("dispatch leases survive receipts; file leases last until the card reaches live", () => {
    const f = fixture();
    try {
      const a = f.workflow("T1"), b = f.workflow("T2");
      planIntent(f.db, { actor: "scheduler" }, { id: "lease:T1", taskId: "T1", taskRev: 1, workflowRev: a.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch", reason: "write",
        resources: ["task:t1", "slot:p:0", "src/bridge.ts"] });
      settleIntent(f.db, { actor: "scheduler" }, { id: "lease:T1", from: "pending", to: "submitted" });
      settleIntent(f.db, { actor: "scheduler" }, { id: "lease:T1", from: "submitted", to: "done", receipt: "派单回执" });
      expect(f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = 'T1' ORDER BY resource").all())
        .toEqual([{ resource: "slot:p:0" }, { resource: "src/bridge.ts" }]);
      expect(() => planIntent(f.db, { actor: "scheduler" }, { id: "lease:T2", taskId: "T2", taskRev: 1,
        workflowRev: b.rev, causalSeq: f.seq(), node: "write", action: "dispatch", reason: "write",
        resources: ["slot:p:0", "src/bridge.ts"] })).toThrow(/T1 占用/);
      f.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'T1'").run();
      moveStage(f.db, f.owner, { taskId: "T1", from: "merge", to: "live" });
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE taskId = 'T1'").get()).toEqual({ n: 0 });
      expect(planIntent(f.db, { actor: "scheduler" }, { id: "lease:T2", taskId: "T2", taskRev: 1,
        workflowRev: b.rev, causalSeq: f.seq(), node: "write", action: "dispatch", reason: "write",
        resources: ["slot:p:0", "src/bridge.ts"] }).intent.status).toBe("pending");
    } finally { f.close(); }
  });

  test("an orphaned unknown write is cancelled when PM advances the card to live", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      planIntent(f.db, { actor: "scheduler" }, { id: "uncertain:T1", taskId: "T1", taskRev: 1,
        workflowRev: w.rev, causalSeq: f.seq(), node: "write", action: "dispatch", reason: "write", resources: ["src/bridge.ts"] });
      settleIntent(f.db, { actor: "scheduler" }, { id: "uncertain:T1", from: "pending", to: "unknown", receipt: "投递结果不明" });
      expect(() => settleIntent(f.db, { actor: "scheduler" }, { id: "uncertain:T1", from: "unknown", to: "done", receipt: "x" }))
        .toThrow(/只有 PM/);
      f.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'T1'").run();
      moveStage(f.db, f.owner, { taskId: "T1", from: "merge", to: "live" });
      expect(getIntent(f.db, "uncertain:T1")).toMatchObject({ status: "cancelled", receipt: expect.stringContaining("卡已 live") });
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE taskId = 'T1'").get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });

  test("subsequent dispatches cannot accumulate another worker slot and can reuse the existing card slot", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      const plan = (id: string, slot: string) => planIntent(f.db, { actor: "scheduler" }, {
        id, taskId: "T1", taskRev: 1, workflowRev: w.rev, causalSeq: f.seq(),
        node: "fix", action: "dispatch", reason: "fix", resources: [slot, "src/bridge.ts"],
      });
      plan("write:T1", "slot:p:0");
      settleIntent(f.db, { actor: "scheduler" }, { id: "write:T1", from: "pending", to: "submitted" });
      settleIntent(f.db, { actor: "scheduler" }, { id: "write:T1", from: "submitted", to: "done", receipt: "delivered" });
      expect(() => plan("fix:T1:new", "slot:p:1")).toThrow(/最多持有一个 worker 槽/);
      expect(plan("fix:T1:reuse", "slot:p:0").intent.status).toBe("pending");
      expect(f.db.query("SELECT resource FROM scheduler_resources WHERE taskId='T1' AND resource LIKE 'slot:%'").all())
        .toEqual([{ resource: "slot:p:0" }]);
    } finally { f.close(); }
  });

  test("switching an in-progress card to manual does not silently lend out its pending dispatch file claim", () => {
    const f = fixture();
    try {
      const a = f.workflow("T1"), b = f.workflow("T2");
      planIntent(f.db, { actor: "scheduler" }, { id: "pending:T1", taskId: "T1", taskRev: 1, workflowRev: a.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch", reason: "pending",
        resources: ["task:t1", "slot:p:0", "src/bridge.ts"] });
      const moved = moveStage(f.db, f.owner, { taskId: "T1", from: "spec", to: "restate" }).row;
      setWorkflow(f.db, f.owner, { taskId: "T1", taskRev: moved.rev, workflowRev: a.rev,
        template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude", fallback: "PM 接手", reason: "PM 接手核对" });
      expect(f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = 'T1' ORDER BY resource").all())
        .toEqual([{ resource: "slot:p:0" }, { resource: "src/bridge.ts" }]);
      expect(() => planIntent(f.db, { actor: "scheduler" }, { id: "pending:T2", taskId: "T2", taskRev: 1,
        workflowRev: b.rev, causalSeq: f.seq(), node: "write", action: "dispatch", reason: "pending",
        resources: ["src/bridge.ts"] })).toThrow(/T1 占用/);
    } finally { f.close(); }
  });

  test("glob and exact file claims overlap; distinct resources on one task still cannot create a second live action", () => {
    const f = fixture();
    try {
      const a = f.workflow("T1"), b = f.workflow("T2");
      planIntent(f.db, f.owner, { id: "glob:T1", taskId: "T1", taskRev: 1, workflowRev: a.rev, causalSeq: f.seq(),
        node: "write", action: "dispatch", reason: "write", resources: ["src/lib/*"] });
      expect(() => planIntent(f.db, f.owner, { id: "glob:T2", taskId: "T2", taskRev: 1, workflowRev: b.rev,
        causalSeq: f.seq(), node: "write", action: "dispatch", reason: "write", resources: ["SRC/LIB/ledger-store.ts"] })).toThrow(/重叠/);
      expect(() => planIntent(f.db, f.owner, { id: "other:T1", taskId: "T1", taskRev: 1, workflowRev: a.rev,
        causalSeq: f.seq(), node: "review", action: "review", reason: "review", resources: ["reviewer:codex"] })).toThrow(/已有未结调度意图/);
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents").get()).toEqual({ n: 1 });
    } finally { f.close(); }
  });

  test("the same padded plan replays and the DAG chooses event order when timestamps tie", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      const first = { id: "z", taskId: "T1", taskRev: 1, workflowRev: w.rev,
        causalSeq: f.seq(), node: " write ", action: "dispatch" as const, reason: " first " };
      const a = planIntent(f.db, f.owner, first);
      expect(planIntent(f.db, f.owner, first).duplicate).toBe(true);
      settleIntent(f.db, f.owner, { id: a.intent.id, from: "pending", to: "cancelled" });
      const b = planIntent(f.db, { actor: "owner", now: a.intent.createdAt }, { ...first, id: "a", causalSeq: f.seq(), reason: "second" });
      expect(b.intent.eventSeq).toBeGreaterThan(a.intent.eventSeq);
      expect(schedulerProjectView(f.db, "p").tasks.find((x) => x.taskId === "T1")?.latestIntent?.id).toBe("a");
    } finally { f.close(); }
  });

  test("dependency and queue changes invalidate a plan under the write transaction", () => {
    const f = fixture();
    try {
      const w = f.workflow("T2");
      const seq = f.seq();
      addDep(f.db, f.owner, { from: "T1", to: "T2", when: "T1 上线" });
      const input = { id: "t68:T2:write:1", taskId: "T2", taskRev: 1, workflowRev: w.rev,
        causalSeq: seq, node: "write", action: "dispatch" as const, reason: "派写" };
      expect(() => planIntent(f.db, f.owner, input)).toThrow(/项目事件已前进/);
      expect(() => planIntent(f.db, f.owner, { ...input, causalSeq: f.seq() })).toThrow(/前置挡住/);
      expect(getIntent(f.db, input.id)).toBeNull();
    } finally { f.close(); }
  });

  test("PM can pause an in-progress card; pending intents and their locks are cancelled together", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      planIntent(f.db, f.owner, { id: "pause:T1", taskId: "T1", taskRev: 1, workflowRev: w.rev,
        causalSeq: f.seq(), node: "restate", action: "dispatch", reason: "派复述", resources: ["task:T1"] });
      const moved = moveStage(f.db, { actor: "agent-one" }, { taskId: "T1", from: "spec", to: "restate" }).row;
      const next = setWorkflow(f.db, f.owner, { taskId: "T1", taskRev: moved.rev, workflowRev: w.rev,
        template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude", fallback: "收窄到只报错", reason: "PM 暂停" });
      expect(next.workflow.mode).toBe("manual");
      expect(getIntent(f.db, "pause:T1")?.status).toBe("cancelled");
      expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE taskId = 'T1'").get()).toEqual({ n: 0 });
      expect(() => setWorkflow(f.db, f.owner, { taskId: "T1", taskRev: moved.rev, workflowRev: next.workflow.rev,
        template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "收窄到只报错" })).toThrow(/重新自动接管/);
    } finally { f.close(); }
  });

  test("unknown external result keeps lock; confirmed completion releases it and appears on DAG view", () => {
    const f = fixture();
    try {
      const w = f.workflow("T1");
      const id = "t68:T1:review:1";
      planIntent(f.db, f.owner, { id, taskId: "T1", taskRev: 1, workflowRev: w.rev,
        causalSeq: f.seq(), node: "review", action: "review", reason: "跨模型审查", resources: ["reviewer:codex"] });
      settleIntent(f.db, f.owner, { id, from: "pending", to: "submitted", receipt: "dispatch-order:1" });
      settleIntent(f.db, f.owner, { id, from: "submitted", to: "unknown", receipt: "回执未明" });
      const view = schedulerProjectView(f.db, "p");
      const row = view.tasks.find((x) => x.taskId === "T1");
      expect([row?.latestIntent?.status, row?.resources, row?.waitReason]).toEqual(["unknown", ["reviewer:codex"], "外部结果不明：跨模型审查"]);
      expect(view.asOfSeq).toBe(f.seq());
      expect(schedulerProjectView(f.db, "p").tasks.find((x) => x.taskId === "T1")?.waitReason).toBe("外部结果不明：跨模型审查");
      settleIntent(f.db, f.owner, { id, from: "unknown", to: "done", receipt: "台账 review seq 9" });
      expect(schedulerProjectView(f.db, "p").tasks.find((x) => x.taskId === "T1")?.resources).toEqual([]);
    } finally { f.close(); }
  });

  test("two CLI processes racing for one resource admit exactly one", async () => {
    const f = fixture();
    try {
      const w1 = f.workflow("T1"), w2 = f.workflow("T2");
      const seq = f.seq();
      closeLedger(f.path);
      const file = join(f.dir, "race.ts");
      const lib = join(import.meta.dir, "../src/lib");
      writeFileSync(file, `import { openLedger } from ${JSON.stringify(join(lib, "ledger-store.ts"))};\n` +
        `import { planIntent } from ${JSON.stringify(join(lib, "ledger-scheduler-write.ts"))};\n` +
        `const db=openLedger(${JSON.stringify(f.path)});\n` +
        `try { planIntent(db,{actor:'owner'},{id:'race:'+process.argv[2],taskId:process.argv[2],taskRev:1,` +
        `workflowRev:1,causalSeq:${seq},node:'write',action:'dispatch',reason:'race',resources:['hot:file']});` +
        `console.log('ok') } catch(e) { console.log(e.code || 'error') }\n`);
      expect([w1.rev, w2.rev]).toEqual([1, 1]);
      const processes = ["T1", "T2"].map((id) => Bun.spawn([process.execPath, file, id], { stdout: "pipe", stderr: "pipe" }));
      const outputs = await Promise.all(processes.map(async (p) => {
        const out = await new Response(p.stdout).text();
        expect(await p.exited).toBe(0);
        return out.trim();
      }));
      expect(outputs.sort()).toEqual(["conflict", "ok"]);
      const db = openLedger(f.path);
      expect((db.query("SELECT COUNT(*) AS n FROM scheduler_resources").get() as { n: number }).n).toBe(1);
    } finally { f.close(); }
  });
});
