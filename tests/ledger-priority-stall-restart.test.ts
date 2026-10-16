import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger, listEvents } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { claimPriorityStalls, finishPriorityStall, priorityStallOwner } from "../src/lib/ledger-priority-stall-store.js";
import { PRIORITY_STALL_MS as W } from "../src/lib/ledger-priority-stall.js";
import { priorityStallTick } from "../src/lib/ledger-priority-stall-tick.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { runLedger } from "../src/manager/ledger.js";
import { listAsks } from "../src/lib/ledger-asks.js";

const project = "prio", pm = "agent-pm", t0 = 1000;
const evidence = { ownerWords: "now", ownerAt: t0, sourceRef: "test:owner" };

test("disk restart and independent connections retain one heal claim; query_only reader uses CLI for PM/owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "priority-stall-disk-")), path = join(root, "ledger.sqlite");
  let writer = openLedger(path), reader: Database | null = null, second: Database | null = null, now = t0 + W, notices = 0;
  const ctx = () => ({ actor: "scheduler", now });
  try {
    writer.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
    setMeta(writer, { actor: "owner" }, { project, key: "pms", value: [pm] });
    createTask(writer, { actor: pm, now: t0 }, { project, id: "T", kind: "code", title: "task", pm });
    setPriority(writer, { actor: pm, project, now: t0, dedupKey: "band" }, { target: { kind: "task", id: "T" }, band: "now", rev: 0, evidence });
    setPriorityMode(writer, { actor: pm, project, now: t0, dedupKey: "mode" }, { mechanism: "priorityStall", mode: "on", rev: 0, evidence });
    const first = claimPriorityStalls(writer, ctx(), project)[0];
    second = new Database(path);
    expect(claimPriorityStalls(second, ctx(), project)).toEqual([]);
    second.close(); second = null;
    closeLedger(path); writer = openLedger(path);
    now += 5 * 60_000;
    const pmClaim = claimPriorityStalls(writer, ctx(), project)[0];
    expect(pmClaim.action).toBe("pm");
    expect(pmClaim.cycle.id).toBe(first.cycle.id);
    expect(pmClaim.cycle.heal?.result).toBe("unknown");
    expect(finishPriorityStall(writer, ctx(), project, first.basis.key, first.token, "success", "late callback")).toBe(false);
    finishPriorityStall(writer, ctx(), project, pmClaim.basis.key, pmClaim.token, "failed", "retry safely");
    reader = new Database(path, { readonly: true }); reader.exec("PRAGMA query_only=ON");
    const manager = async (...args: string[]) => runLedger(args.slice(1), { db: writer, actor: "scheduler", projectIds: [project],
      autoDispatch: () => true, autoProjects: () => [project], now: () => now,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} });
    const config = { enabled: true, autoDispatch: true, projects: { [project]: { maxActiveWorkers: 3 } } } as unknown as SchedulerConfig;
    const ports = { manager, active: () => {}, now: () => now, notify: async () => { notices++; } };
    const notes = () => listEvents(writer).filter((e) => e.data.namespace === "priority-stall-note");
    now += 60_000;
    expect(await priorityStallTick(reader, config, ports)).toEqual([]);
    expect(notices).toBe(0); expect(notes()).toHaveLength(1);
    expect(await priorityStallTick(reader, config, ports)).toEqual([]);
    expect(notices).toBe(0); expect(notes()).toHaveLength(1);
    now += W;
    // Simulate a restart after owner claim but before the atomic owner-ask transaction.
    const owner = claimPriorityStalls(writer, ctx(), project)[0];
    expect(owner.action).toBe("owner");
    now += 5 * 60_000;
    expect(await priorityStallTick(reader, config, ports)).toEqual([]);
    expect(listAsks(writer, { project, states: ["open"] })).toHaveLength(1);
    expect(priorityStallOwner(writer, ctx(), project, owner.basis.key, owner.token)).toBeNull();
  } finally { reader?.close(); second?.close(); closeLedger(path); rmSync(root, { recursive: true, force: true }); }
});
