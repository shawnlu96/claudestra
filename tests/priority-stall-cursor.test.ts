/**
 * STALLCUR1: a SchedulerStopped mid-scan keeps the interrupted target and the tail (recovery key priorityStallCursor), so
 * repeated maintenance stops never starve the tail. Driven through the real entry priorityStallTick; the switch is injected.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { priorityStallTick } from "../src/lib/ledger-priority-stall-tick.js";
import { PRIORITY_STALL_MS } from "../src/lib/ledger-priority-stall.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { runLedger } from "../src/manager/ledger.js";

let db: Database, now: number;
const pm = "agent-pm", t0 = 1000;
const evidence = { ownerWords: "now", ownerAt: t0, sourceRef: "test:owner" };
beforeEach(() => { db = openLedger(":memory:"); now = t0 + PRIORITY_STALL_MS; });
afterEach(() => closeLedger(":memory:"));

function setup(counts: number[]) {
  const ids: string[] = [], projects: SchedulerConfig["projects"] = {};
  counts.forEach((count, index) => {
    const project = `cur-${index}`;
    projects[project] = { maxActiveWorkers: 3 } as SchedulerConfig["projects"][string];
    setMeta(db, { actor: "owner", now: t0 }, { project, key: "pms", value: [pm] });
    setPriorityMode(db, { actor: pm, project, now: t0, dedupKey: `mode-${project}` }, { mechanism: "priorityStall", mode: "on", rev: 0, evidence });
    for (let i = 0; i < count; i++) {
      const id = `${project}-${i}`;
      ids.push(id);
      createTask(db, { actor: pm, now: t0 }, { project, id, kind: "code", title: id, pm });
      setPriority(db, { actor: pm, project, now: t0, dedupKey: id }, { target: { kind: "task", id }, band: "now", rev: 0, evidence });
    }
  });
  return { ids, config: { projects } as SchedulerConfig };
}

const policy = (mode: () => RecoveryMode): RecoveryPolicyPort => () => ({ mode: mode(), manualAfterMs: null, source: "config" });
const observed = () => listEvents(db).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "priorityStallCursor");

/**
 * claims: [] = one claim command per target, two active() calls around it. stop(n) throws at the n-th active() call of a round
 * (odd = before the manager call, even = after it returned); undefined = no stop.
 */
function probe(mode: () => RecoveryMode = () => "on") {
  const seen: string[] = [];
  let calls = 0, stopAt: number | undefined, fail: string | undefined;
  const ports = { now: () => now, recovery: policy(mode),
    active: () => { if (++calls === stopAt) throw new SchedulerStopped("maintenance"); },
    manager: async (...args: string[]) => { seen.push(args[2]); now += 1; return args[2] === fail ? { ok: false, error: "boom" } : { ok: true, claims: [] }; } };
  const round = async (stop?: number, failId?: string) => {
    calls = 0; stopAt = stop; fail = failId;
    try { return { failed: await priorityStallTick(db, config0!, ports), stopped: false }; }
    catch (e) { if (!(e instanceof SchedulerStopped)) throw e; return { failed: [], stopped: true }; }
  };
  return { seen, round };
}
let config0: SchedulerConfig | undefined;

test("[验收线 1/2] repeated stops in the middle: the tail is reached, nothing completed is re-queued", async () => {
  const { ids, config } = setup([3, 3, 3]); config0 = config;
  const { seen, round } = probe();
  // Every round is stopped before the third target's command: two targets finish per round.
  for (let r = 0; r < 5; r++) expect((await round(5)).stopped).toBe(true);
  // Five stopped rounds cover all nine in order; baseline: [0,1,0,1,...] — the tail is never scanned.
  expect(seen.slice(0, 9)).toEqual(ids);
  expect(seen.slice(9)).toEqual([ids[0]]); // after the tail the natural order wraps to the front
});

test("[验收线 2/3] stop after the manager returned: that target is retried first, the tail follows; bounded rounds", async () => {
  const { ids, config } = setup([2, 3, 2]); config0 = config;
  const { seen, round } = probe();
  for (let r = 0; r < 4; r++) expect((await round(6)).stopped).toBe(true);
  // Each stopped round's last target (already sent) leads the next round once; never a target from before it.
  expect(seen.slice(0, 10)).toEqual([ids[0], ids[1], ids[2], ids[2], ids[3], ids[4], ids[4], ids[5], ids[6], ids[6]]);
  expect(new Set(seen)).toEqual(new Set(ids));
});

test("[验收线 2] interrupted at the head, middle and tail of the current queue", async () => {
  const { ids, config } = setup([2, 2, 2]); config0 = config;
  const { seen, round } = probe();
  await round(1); // head, before any command: the whole queue stays
  expect(seen).toEqual([]);
  await round(5); // middle: ids 0,1 done, stopped before 2
  expect(seen).toEqual(ids.slice(0, 2));
  await round(7); // tail of [2..5]: 2,3,4 done, stopped before 5
  expect(seen).toEqual(ids.slice(0, 5));
  expect((await round()).stopped).toBe(false); // resume: 5 first, then the natural order again from the front
  expect(seen.slice(5)).toEqual([ids[5], ...ids.slice(0, 5)]);
  seen.length = 0;
  await round(); // natural end left no cursor: a full round from the front
  expect(seen).toEqual(ids);
});

test("[验收线 3] pending target turned verified / off, budget then stop, ordinary failure", async () => {
  const { ids, config } = setup([2, 3]); config0 = config;
  const { seen, round } = probe();
  await round(3); // ids[0] done, stopped before ids[1]
  db.query("UPDATE tasks SET stage='verified' WHERE id=?").run(ids[1]);
  setPriorityMode(db, { actor: pm, project: "cur-0", now, dedupKey: "off-0" }, { mechanism: "priorityStall", mode: "off", rev: 1, evidence }); // upstream switch
  const r = await round(undefined, ids[3]); // a plain failure on one target does not block the rest
  expect(r.failed.map((f) => f.taskId)).toEqual([ids[3]]);
  expect(seen).toEqual([ids[0], ids[2], ids[3], ids[4]]);
});

test("[验收线 3] budget exhaustion followed by a stop keeps the budget tail position", async () => {
  const { ids, config } = setup([5]); config0 = config;
  const seen: string[] = [];
  let calls = 0, stopAt: number | undefined;
  const ports = { now: () => now, budgetMs: 10, recovery: policy(() => "on"),
    active: () => { if (++calls === stopAt) throw new SchedulerStopped("m"); },
    manager: async (...args: string[]) => { seen.push(args[2]); now += 10; return { ok: true, claims: [] }; } };
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await priorityStallTick(db, config, ports); // budget: ids[0] only
    calls = 0; stopAt = 1;
    await expect(priorityStallTick(db, config, ports)).rejects.toBeInstanceOf(SchedulerStopped); // stopped at ids[1]
    calls = 0; stopAt = undefined;
    await priorityStallTick(db, config, ports);
    expect(seen).toEqual([ids[0], ids[1]]);
  } finally { log.mockRestore(); }
});

test("[验收线 3] partly committed target resumes from its claim: heal is not redone, one note", async () => {
  const { ids, config } = setup([2]);
  const commands: string[] = [];
  let stopAfter: string | undefined, last = "";
  const ports = { now: () => now, recovery: policy(() => "on"),
    active: () => { if (last === stopAfter) { stopAfter = undefined; throw new SchedulerStopped("m"); } },
    manager: async (...args: string[]) => {
      last = `${args[2]}:${JSON.parse(args[args.indexOf("--data") + 1]).op}`; commands.push(last); now += 10;
      return runLedger(args.slice(1), { db, actor: "scheduler", projectIds: Object.keys(config.projects), now: () => now,
        autoDispatch: () => true, autoProjects: () => Object.keys(config.projects),
        loadRegistry: async () => ({ agents: {}, socket: "" }), saveRegistry: async () => {} });
    } };
  stopAfter = `${ids[0]}:heal`; // manager committed the heal, then the stop
  await expect(priorityStallTick(db, config, ports)).rejects.toBeInstanceOf(SchedulerStopped);
  last = "";
  expect(await priorityStallTick(db, config, ports)).toEqual([]);
  expect(commands).toEqual([`${ids[0]}:claim`, `${ids[0]}:heal`, `${ids[0]}:claim`, `${ids[0]}:note`,
    ...["claim", "heal", "claim", "note"].map((op) => `${ids[1]}:${op}`)]);
  const notes = listEvents(db).filter((e) => e.data.namespace === "priority-stall-note").map((e) => e.target);
  expect(notes).toEqual(ids);
});

test("[验收线 4] off = baseline restart from the front; observe = same commands plus one deduped sample per project", async () => {
  const runs: Record<string, string[]> = {};
  for (const mode of ["off", "observe"] as const) {
    closeLedger(":memory:"); db = openLedger(":memory:"); now = t0 + PRIORITY_STALL_MS;
    const { ids, config } = setup([2, 2]); config0 = config;
    const { seen, round } = probe(() => mode);
    await round(5); await round(5); // both stopped before the third target
    runs[mode] = seen;
    expect(seen).toEqual([...ids.slice(0, 2), ...ids.slice(0, 2)]);
    // observe: stopped at cur-1-0 both times, same revision → one sample for cur-1, identities only
    expect(observed().map((e) => [e.project, e.data.remaining])).toEqual(mode === "observe" ? [["cur-1", 2]] : []);
    if (mode === "observe") expect(JSON.stringify(observed()[0].data)).not.toContain("title");
  }
  expect(runs.observe).toEqual(runs.off);
});

test("[验收线 4] switching while running takes effect at the next stop without restart; per-project modes", async () => {
  const { ids, config } = setup([2, 2]); config0 = config;
  let mode: RecoveryMode = "off";
  const { seen, round } = probe(() => mode);
  await round(3); // off: dropped
  mode = "on";
  await round(3); // on: ids[0] again (front), stopped before ids[1] → kept
  await round();
  expect(seen).toEqual([ids[0], ids[0], ids[1], ids[2], ids[3], ids[0]]);
  // cur-0 off, cur-1 on: only cur-1's unfinished targets lead the next round
  const seen3: string[] = [];
  let calls = 0;
  const ports = { now: () => now, recovery: ((p: string) => ({ mode: p === "cur-0" ? "off" : "on", manualAfterMs: null, source: "config" })) as RecoveryPolicyPort,
    active: () => { if (++calls === 1) throw new SchedulerStopped("m"); },
    manager: async (...args: string[]) => { seen3.push(args[2]); return { ok: true, claims: [] }; } };
  await expect(priorityStallTick(db, config, ports)).rejects.toBeInstanceOf(SchedulerStopped);
  calls = 1;
  await priorityStallTick(db, config, ports);
  expect(seen3).toEqual([ids[2], ids[3], ids[0], ids[1]]);
});
