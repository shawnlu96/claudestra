import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { priorityStallBases } from "../src/lib/ledger-priority-stall-read.js";
import { priorityStallTick } from "../src/lib/ledger-priority-stall-tick.js";
import { PRIORITY_STALL_MS } from "../src/lib/ledger-priority-stall.js";
import { runLedger } from "../src/manager/ledger.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";

let db: Database;
const project = "verified", pm = "agent-pm", t0 = 1000;
const evidence = { ownerWords: "now", ownerAt: t0, sourceRef: "test:owner" };
beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, { actor: "owner", now: t0 }, { project, key: "pms", value: [pm] });
  for (const id of ["upstream", "target"]) createTask(db, { actor: pm, now: t0 }, { project, id, kind: "code", title: id, pm });
  addDep(db, { actor: pm, now: t0 }, { from: "upstream", to: "target", when: "upstream deployed" });
  setPriority(db, { actor: pm, project, now: t0, dedupKey: "now" },
    { target: { kind: "task", id: "target" }, band: "now", rev: 0, evidence });
  setPriorityMode(db, { actor: pm, project, now: t0, dedupKey: "mode" }, { mechanism: "priorityStall", mode: "on", rev: 0, evidence });
});
afterEach(() => closeLedger(":memory:"));

test.each(["verified", "build", "review", "merge"])("now %s card with unmet dependency has correct eligibility", (stage) => {
  db.query("UPDATE tasks SET stage=? WHERE id='target'").run(stage);
  const basis = priorityStallBases(db, project)[0];
  expect(basis.why).toContain("依赖没满足：upstream");
  expect(basis.eligible).toBe(stage !== "verified");
});

test("verified card emits no stall commands or notices across escalation windows", async () => {
  db.query("UPDATE tasks SET stage='verified' WHERE id='target'").run();
  const config = { projects: { [project]: { maxActiveWorkers: 3 } } } as unknown as SchedulerConfig;
  let now = t0, calls = 0, notices = 0;
  const ports = { active: () => {}, now: () => now, notify: async () => { notices++; },
    manager: async (...args: string[]) => {
      calls++;
      return runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [project], now: () => now,
        autoDispatch: () => true, autoProjects: () => [project],
        loadRegistry: async () => ({ agents: {}, socket: "" }), saveRegistry: async () => {} });
    } };
  for (let window = 1; window <= 4; window++) {
    now = t0 + window * PRIORITY_STALL_MS;
    expect(await priorityStallTick(db, config, ports)).toEqual([]);
  }
  expect(notices).toBe(0);
  expect(calls).toBe(0);
});
