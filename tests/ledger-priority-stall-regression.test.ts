import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openLedger, closeLedger, getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask, setMeta, appendEvent, deliver, moveStage } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { fallbackToManual } from "../src/lib/scheduler-fallback.js";
import { MERGE_RETRY_PREFIX } from "../src/lib/scheduler-autostart-resume.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { openAsk, listAsks } from "../src/lib/ledger-asks.js";
import { priorityStallBases } from "../src/lib/ledger-priority-stall-read.js";
import { claimPriorityStalls, finishPriorityStall } from "../src/lib/ledger-priority-stall-store.js";
import { priorityStallCommand } from "../src/lib/ledger-priority-stall-command.js";
import { priorityStallTick } from "../src/lib/ledger-priority-stall-tick.js";
import { PRIORITY_STALL_MS as W, isPriorityStallProgress } from "../src/lib/ledger-priority-stall.js";
import { runLedger } from "../src/manager/ledger.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";

let db: Database, now: number;
const project = "prio", pm = "agent-pm", t0 = 1000;
const evidence = { ownerWords: "now", ownerAt: t0, sourceRef: "test:owner" };
const ctx = () => ({ actor: "scheduler", now });
const config = { enabled: true, autoDispatch: true, projects: { [project]: { maxActiveWorkers: 3 } } } as unknown as SchedulerConfig;
const svc = { autoDispatch: true, projects: [project], maxWorkers: () => 3 };
const manager = (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [project],
  autoDispatch: () => true, autoProjects: () => [project], now: () => now,
  loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
beforeEach(() => {
  db = openLedger(":memory:"); now = t0;
  db.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm] });
  createTask(db, { actor: pm, now }, { project, id: "T", kind: "code", title: "task", pm, agent: "agent-exec" });
  setPriority(db, { actor: pm, project, now, dedupKey: "band" }, { target: { kind: "task", id: "T" }, band: "now", rev: 0, evidence });
  setPriorityMode(db, { actor: pm, project, now, dedupKey: "mode" }, { mechanism: "priorityStall", mode: "on", rev: 0, evidence });
});
afterEach(() => closeLedger(":memory:"));

test("real authorized autoResume preserves the heal episode through PM and owner", async () => {
  setWorkflow(db, { actor: pm, now }, { taskId: "T", taskRev: 1, template: "code", templateVersion: 2,
    mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
  db.query("UPDATE tasks SET stage='merge', headSHA=? WHERE id='T'").run("a".repeat(40));
  db.query(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES ('old','T',?,'merge_deploy','merge',1,1,1,1,?,2,'cancelled','merge',1,1)`).run(project, "a".repeat(40));
  fallbackToManual(db, { actor: "scheduler", now: ++now }, { taskId: "T", reason: `${MERGE_RETRY_PREFIX} cancelled` });
  moveStage(db, { actor: pm, now: ++now }, { taskId: "T", from: "merge", to: "fix" });
  deliver(db, { actor: "agent-exec", now: ++now }, { taskId: "T", headSHA: "b".repeat(40), moveFrom: "fix" });
  now += W;
  const c = claimPriorityStalls(db, ctx(), project)[0];
  const result = priorityStallCommand(db, { ...ctx(), dedupKey: "heal" }, project, "T", { op: "heal", key: c.basis.key, token: c.token }, svc);
  expect(getWorkflow(db, "T")?.mode).toBe("auto");
  expect(listEvents(db).findLast((e) => e.data.op === "workflow_resume")?.actor).toBe("scheduler");
  expect(result).toMatchObject({ result: "success", finished: true });
  expect(claimPriorityStalls(db, ctx(), project)).toEqual([]);
  now += W;
  const p = claimPriorityStalls(db, ctx(), project)[0];
  expect(p.action).toBe("pm"); expect(p.cycle.id).toBe(c.cycle.id);
  finishPriorityStall(db, ctx(), project, p.basis.key, p.token, "success", "sent");
  now += W;
  expect(claimPriorityStalls(db, ctx(), project)[0]?.action).toBe("owner");
});

test("disk restart after PM delivery and receipt failure never repeats the notification", async () => {
  const memory = db, root = mkdtempSync(join(tmpdir(), "stall-pm-restart-")), path = join(root, "ledger.sqlite");
  writeFileSync(path, db.serialize()); db = openLedger(path);
  try {
    now += W;
    let notices = 0, failReceipt = true;
    const ports = { now: () => now, active: () => {}, notify: async () => { notices++; },
      manager: async (...args: string[]) => {
        const input = JSON.parse(args[args.indexOf("--data") + 1]);
        if (failReceipt && input.op === "finish") return { ok: false, error: "receipt CAS conflict" };
        return manager(...args);
      } };
    await priorityStallTick(db, config, ports);
    expect(notices).toBe(1);
    closeLedger(path); db = openLedger(path);
    failReceipt = false; now += 5 * 60_000;
    await priorityStallTick(db, config, ports);
    now += 60_000; await priorityStallTick(db, config, ports);
    expect(notices).toBe(1);
    now = t0 + 2 * W; await priorityStallTick(db, config, ports);
    expect(notices).toBe(1); expect(listAsks(db, { project })).toHaveLength(1);
  } finally { closeLedger(path); db = memory; rmSync(root, { recursive: true, force: true }); }
});

test("unknown PM completion waits for owner without re-notifying", () => {
  now += W;
  const h = claimPriorityStalls(db, ctx(), project)[0];
  finishPriorityStall(db, ctx(), project, h.basis.key, h.token, "unavailable", "no action");
  const p = claimPriorityStalls(db, ctx(), project)[0];
  now += 5 * 60_000; expect(claimPriorityStalls(db, ctx(), project)).toEqual([]);
  now += 60_000; expect(claimPriorityStalls(db, ctx(), project)).toEqual([]);
  now = t0 + 2 * W;
  const owner = claimPriorityStalls(db, ctx(), project)[0];
  expect(owner.action).toBe("owner"); expect(owner.cycle.pm?.result).toBe("unknown");
  expect(finishPriorityStall(db, ctx(), project, p.basis.key, p.token, "success", "late")).toBe(false);
});

test("open task asks to another project PM survive PM handover; non-PM asks are excluded", () => {
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm, "agent-old-pm"] });
  openAsk(db, { project, taskId: "T", source: "reply", kind: "decide", title: "worker", assignee: "agent-exec" }, t0);
  const a = openAsk(db, { project, taskId: "T", source: "reply", kind: "decide", title: "scope", body: "Which scope?\nDetails", assignee: "agent-old-pm" }, t0);
  expect(priorityStallBases(db, project)[0].ask?.id).toBe(a.id);
});

test("idle ticks do not spawn a ledger command and terminal history is not monitored", async () => {
  for (let i = 0; i < 50; i++) {
    createTask(db, { actor: pm, now }, { project, id: `done-${i}`, kind: "code", title: "history" });
    db.query("UPDATE tasks SET stage='done' WHERE id=?").run(`done-${i}`);
    appendEvent(db, { actor: pm, now }, { project, target: `done-${i}`, kind: "note", text: "history" });
  }
  let calls = 0;
  expect(priorityStallBases(db, project)).toHaveLength(1);
  expect(await priorityStallTick(db, config, { active: () => {}, now: () => now,
    manager: async (...args) => { calls++; return manager(...args); } })).toEqual([]);
  expect(calls).toBe(0);
  expect(getTask(db, "T")).not.toBeNull();
});

test("only human workflow handbacks count as resolution progress", () => {
  for (const actor of [pm, "owner"]) expect(isPriorityStallProgress({ actor, kind: "scheduler", data: { op: "workflow_resume" } })).toBe(true);
  expect(isPriorityStallProgress({ actor: "scheduler", kind: "scheduler", data: { op: "workflow_resume" } })).toBe(false);
});
