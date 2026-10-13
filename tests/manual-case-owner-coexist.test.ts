/**
 * merge-arch-OWN1 next to the live paths (tests/scheduler-merge-reclaim-world.ts: serial merge slot, PM manual merge request, the pass
 * with its train / merge / deploy / auto ticks, PM workflow-resume) and its wiring: the V2 command map, the skip inventory, the service
 * command list, the recovery key and the leased writer's checks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { manualCaseOwnerTick } from "../src/lib/manual-case-owner-tick.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { manualResumeManagerTick, recoveryWrite } from "../src/lib/scheduler-recovery-ports.js";
import { SCHEDULER_V2_LEDGER_COMMANDS } from "../src/lib/scheduler-v2-ledger-cmds-args.js";
import { SKIP_LEDGER_COMMANDS, SKIP_LEDGER_DYNAMIC } from "../src/lib/scheduler-v2-skip-paths.js";
import { SCHEDULER_SERVICE_COMMANDS } from "../src/lib/shared-ledger-gate-cli-services.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { ledgerAs, manualCard, requestArgs } from "./manual-merge-queue-world.test.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";

const PM = "agent-pm", CMD = "scheduler-manual-case-default";
let w: ReclaimWorld | undefined;
afterEach(() => { w?.close(); w = undefined; rmSync(RECOVERY_POLICY_PATH, { force: true }); });
const policy = (keys: Record<string, string>, p: Record<string, unknown> = {}) =>
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { ...p, keys } } }));
const pm = (world: ReclaimWorld, ...args: string[]) => runLedger(args, { db: world.db, actor: PM, projectIds: ["p"], autoProjects: () => ["p"], autoDispatch: () => true,
  loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;
const records = (db: Database, id: string) => listEvents(db, { project: "p", target: id }).filter((e) => e.data.op === "manual_case_set");
/** Slot, intents, merge runs, workflows and cards: what this card must never move. */
const live = (db: Database) => ["scheduler_resources", "scheduler_intents", "scheduler_merges", "task_workflows", "tasks"]
  .map((t) => db.query(`SELECT * FROM ${t}`).all());

describe("[验收线 5] next to the slot, manual merge requests, the pass and PM hand-back", () => {
  test("backfill takes no slot, cancels no request or intent; the pass runs as before; PM resume ends the episode", async () => {
    w = reclaimWorld({ store: "memory", deploy: true });
    const world = w;
    setMeta(world.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
    policy({ manualMergeQueue: "on", manualCaseOwnership: "on" });
    const a = world.card("A");
    const m = await manualCard(world, "M");
    await world.begin("A");
    expect(await ledgerAs(world, PM, ...requestArgs(m))).toMatchObject({ ok: true });
    // the backfill alone, on the leased writer: one decision event, nothing else moves
    const before = live(world.db), max = (world.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
    const out = await manualCaseOwnerTick(world.db, ["p"], { write: (args) => recoveryWrite(world.manager, CMD, args, true) });
    expect(out).toEqual([expect.objectContaining({ taskId: "M", mode: "on", action: "assigned" })]);
    expect(live(world.db)).toEqual(before);
    expect(world.slot()).toBe("A");
    expect(listEvents(world.db, { project: "p" }).filter((e) => e.seq > max).map((e) => [e.kind, e.data.op])).toEqual([["decision", "manual_case_set"]]);
    // the pass drives train / merge / deploy / auto ticks: the request merges, A goes live, the record is not written again
    for (let i = 0; i < 6; i++) await world.pass();
    const q = await ledgerAs(world, PM, "manual-queue", "--project", "p") as { active: { taskId: string; request: { state: string } | null }[] };
    expect(q.active.find((x) => x.taskId === "M")!.request).toMatchObject({ state: "merged" });
    expect(getTask(world.db, a.taskId)!.stage).toBe("live");
    expect(records(world.db, "M")).toHaveLength(1);
    // PM holds B, the pass backfills it once, PM hands it back: the episode ends and nothing more is written for it
    const b = world.card("B");
    expect(await pm(world, "workflow-set", "B", "--rev", String(getTask(world.db, "B")!.rev), "--workflow-rev", String(getWorkflow(world.db, "B")!.rev),
      "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工", "--reason", "pm_hold: 先停一下")).toMatchObject({ ok: true });
    await world.pass();
    expect(records(world.db, b.taskId)).toHaveLength(1);
    expect(await pm(world, "workflow-resume", "B", "--rev", String(getTask(world.db, "B")!.rev), "--workflow-rev", String(getWorkflow(world.db, "B")!.rev),
      "--reason", "PM 交回")).toMatchObject({ ok: true });
    for (let i = 0; i < 2; i++) await world.pass();
    expect(getWorkflow(world.db, "B")!.mode).toBe("auto");
    expect(records(world.db, b.taskId)).toHaveLength(1);
  });
});

describe("[验收线 6] V2 map / skip inventory / service list / recovery key / lease", () => {
  test("the command is registered once everywhere it must be, the key exactly once", () => {
    expect(SCHEDULER_V2_LEDGER_COMMANDS[CMD]).toEqual({ target: "task", handling: "unmapped" });
    expect(SKIP_LEDGER_COMMANDS[CMD]).toBe("task");
    expect(SKIP_LEDGER_DYNAMIC["scheduler-recovery-ports.ts"]).toContain(CMD);
    expect(SCHEDULER_SERVICE_COMMANDS.has(CMD)).toBe(true);
    expect(SCHEDULER_SERVICE_COMMANDS.has("manual-case-set")).toBe(false);
    expect(RECOVERY_KEYS.filter((k) => k === "manualCaseOwnership")).toHaveLength(1);
  });

  test("lease lost / dispatch off / not the scheduler: refused with zero writes; the tick stops on a lost lease, a held card stays its own", async () => {
    const f = autoFixture();
    try {
      policy({ manualCaseOwnership: "on" });
      expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev), "--template", "code",
        "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工", "--reason", "spec_drift: 规格改了")).toMatchObject({ ok: true });
      const entry = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "scheduler")!.seq;
      const args = ["T1", "--entry-seq", String(entry), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev), "--mode", "on"];
      const seq = () => (f.db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s, s = seq();
      expect(await f.cliWith({ assertLease: () => { throw new SchedulerLeaseLost("租约没了"); } }, "scheduler", CMD, ...args)).toMatchObject({ ok: false, code: "lease-lost" });
      expect(await f.cliWith({ autoDispatch: () => false }, "scheduler", CMD, ...args)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("pm", CMD, ...args)).toMatchObject({ ok: false, code: "forbidden" });
      expect(seq()).toBe(s);
      const tick = (manager: (...a: string[]) => Promise<Record<string, unknown>>) =>
        manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now });
      const held = async (...a: string[]) => (a[1] === CMD ? { ok: false, code: "v2_unmapped", error: "中央映射" } : f.tickDeps.manager(...a));
      await tick(held); // a held card is that card's refusal: the tick goes on and writes nothing
      expect(seq()).toBe(s);
      await expect(tick(async (...a) => (a[1] === CMD ? { ok: false, code: "lease-lost", error: "租约没了" } : f.tickDeps.manager(...a))))
        .rejects.toBeInstanceOf(SchedulerStopped);
      expect(seq()).toBe(s);
      await tick(f.tickDeps.manager);
      expect(records(f.db, "T1")).toHaveLength(1);
    } finally { f.close(); }
  });
});
