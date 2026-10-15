import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { priorityStallTick } from "../src/lib/ledger-priority-stall-tick.js";
import { PRIORITY_STALL_MS } from "../src/lib/ledger-priority-stall.js";
import { runLedger } from "../src/manager/ledger.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";

let db: Database, now: number;
const pm = "agent-pm", t0 = 1000;
const evidence = { ownerWords: "now", ownerAt: t0, sourceRef: "test:owner" };
beforeEach(() => { db = openLedger(":memory:"); now = t0 + PRIORITY_STALL_MS; });
afterEach(() => closeLedger(":memory:"));

function setup(counts: number[]) {
  const ids: string[] = [], projects: SchedulerConfig["projects"] = {};
  counts.forEach((count, index) => {
    const project = `budget-${index}`;
    projects[project] = { maxActiveWorkers: 3 } as SchedulerConfig["projects"][string];
    setMeta(db, { actor: "owner", now: t0 }, { project, key: "pms", value: [pm] });
    setPriorityMode(db, { actor: pm, project, now: t0, dedupKey: `mode-${project}` },
      { mechanism: "priorityStall", mode: "on", rev: 0, evidence });
    for (let i = 0; i < count; i++) {
      const id = `${project}-${i}`;
      ids.push(id);
      createTask(db, { actor: pm, now: t0 }, { project, id, kind: "code", title: id, pm });
      setPriority(db, { actor: pm, project, now: t0, dedupKey: id },
        { target: { kind: "task", id }, band: "now", rev: 0, evidence });
    }
  });
  return { ids, config: { projects } as SchedulerConfig };
}

function probe(budgetMs?: number, cost = 10) {
  const seen: string[] = [];
  return { seen, ports: { budgetMs, now: () => now, active: () => {},
    manager: async (...args: string[]) => { seen.push(args[2]); now += cost; return { ok: true, claims: [] }; } } };
}

test("50 still-due targets across projects resume 10 at a time without repeats", async () => {
  const { ids, config } = setup([15, 35]), { seen, ports } = probe(100);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (let round = 1; round <= 5; round++) {
      expect(await priorityStallTick(db, config, ports)).toEqual([]);
      expect(seen).toEqual(ids.slice(0, round * 10));
    }
    expect(new Set(seen).size).toBe(50);
    expect(log).toHaveBeenCalledTimes(5);
    expect(log.mock.calls[0][0]).toContain("processed=10 remaining=40");
  } finally { log.mockRestore(); }
});

test("default total budget is 60 seconds", async () => {
  const { ids, config } = setup([4]), { seen, ports } = probe(undefined, 30_000);
  await priorityStallTick(db, config, ports);
  expect(seen).toEqual(ids.slice(0, 2));
});

test("removed pending target does not reset progress to the front", async () => {
  const { ids, config } = setup([5]), { seen, ports } = probe(10);
  await priorityStallTick(db, config, ports);
  db.query("UPDATE tasks SET stage='verified' WHERE id=?").run(ids[1]);
  await priorityStallTick(db, config, ports);
  expect(seen).toEqual([ids[0], ids[2]]);
});

test.each([5, 1000])("budget %i finishes the current target including notification receipt", async (budgetMs) => {
  const { ids, config } = setup([2]);
  const commands: string[] = [], notices: string[] = [];
  const ports = { budgetMs, active: () => {}, now: () => now,
    notify: async (claim: { basis: { taskId: string | null } }) => { notices.push(claim.basis.taskId!); },
    manager: async (...args: string[]) => {
      commands.push(`${args[2]}:${JSON.parse(args[args.indexOf("--data") + 1]).op}`);
      now += 10;
      return runLedger(args.slice(1), { db, actor: "scheduler", projectIds: Object.keys(config.projects), now: () => now,
        autoDispatch: () => true, autoProjects: () => Object.keys(config.projects),
        loadRegistry: async () => ({ agents: {}, socket: "" }), saveRegistry: async () => {} });
    } };
  expect(await priorityStallTick(db, config, ports)).toEqual([]);
  const processed = budgetMs === 5 ? ids.slice(0, 1) : ids;
  expect(notices).toEqual(processed);
  expect(commands).toEqual(processed.flatMap((id) => ["claim", "heal", "claim", "check", "finish"].map((op) => `${id}:${op}`)));
  if (budgetMs === 5) expect(await priorityStallTick(db, config, ports)).toEqual([]);
  expect(notices).toEqual(ids);
});
