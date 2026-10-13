/**
 * merge-arch-VIEW1 [验收线 5]: `ledger manual-queue` next to the live paths on the real pass world (tests/scheduler-merge-reclaim-world.ts):
 * the merge slot held by a serial merge run, a PM manual merge request, the pass (train tick, manual claim, auto tick, deploy tick) and
 * PM workflow-resume. Reading before / after each of them holds no slot, cancels nothing and writes nothing; what they did shows up in
 * the next read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { ManualCaseRow } from "../src/lib/manual-case-view.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

/** PM's CLI with the scheduler switches on (workflow-resume needs them). */
const pm = (...args: string[]) => runLedger(args, { db: w.db, actor: PM, projectIds: ["p"], autoProjects: () => ["p"], autoDispatch: () => true,
  loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, any>>;
const read = async () => {
  const r = await ledgerAs(w, PM, "manual-queue", "--project", "p") as { ok: boolean; active: ManualCaseRow[]; terminal: ManualCaseRow[] };
  expect(r).toMatchObject({ ok: true });
  return r;
};
const rowOf = (r: Awaited<ReturnType<typeof read>>, id: string) => [...r.active, ...r.terminal].find((x) => x.taskId === id);

/** Slot, intents, merge runs, workflows, cards and the event log: anything a read must not move. */
function facts(db: Database) {
  const all = (sql: string) => db.query(sql).all();
  return { resources: all("SELECT * FROM scheduler_resources ORDER BY resource"), intents: all("SELECT * FROM scheduler_intents ORDER BY id"),
    merges: all("SELECT * FROM scheduler_merges ORDER BY intentId"), workflows: all("SELECT * FROM task_workflows ORDER BY taskId"),
    tasks: all("SELECT * FROM tasks ORDER BY id"), events: (db.query("SELECT COUNT(*) AS n, MAX(seq) AS s FROM events").get()) };
}
/** Read twice around nothing: the state is the same before and after, so the read took no slot and wrote nothing. */
async function readStill() {
  const before = facts(w.db);
  const r = await read();
  await read();
  expect(facts(w.db)).toEqual(before);
  return r;
}

describe("[验收线 5] coexisting with the slot, manual requests, the pass and PM resume", () => {
  test("reads around a held slot, a manual request, passes and a PM resume change nothing and see the new facts", async () => {
    w = reclaimWorld({ store: "memory", deploy: true });
    setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
    writePolicy("on");
    const a = w.card("A");
    const m = await manualCard(w, "M");
    let r = await readStill();
    expect(rowOf(r, "M")).toMatchObject({ reasonCode: "pm_takeover", request: null });
    expect(rowOf(r, "A")).toBeUndefined();

    // a serial merge run holds the slot; PM queues M behind it
    await w.begin("A");
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true });
    r = await readStill();
    expect(w.slot()).toBe("A");
    expect(rowOf(r, "M")!.request).toMatchObject({ state: "queued" });
    expect(rowOf(r, "M")!.request!.why).toContain("A");

    // the pass drives the train / merge / deploy ticks; reads before and after leave it alone and see its outcome
    for (let i = 0; i < 6; i++) { await w.pass(); await readStill(); }
    const after = await read();
    const req = rowOf(after, "M")!.request!;
    expect(req).toMatchObject({ state: "merged" });
    expect(getTask(w.db, a.taskId)!.stage).toBe("live"); // the auto card behind the slot merged and deployed meanwhile
    expect(rowOf(after, "M")).toMatchObject({ reasonCode: "pm_takeover", terminal: false });

    // PM hands a manual card back: the next read no longer lists it as manual
    const b = w.card("B");
    expect(await pm("workflow-set", "B", "--rev", String(getTask(w.db, "B")!.rev), "--workflow-rev", String(getWorkflow(w.db, "B")!.rev),
      "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "人工",
      "--reason", "pm_hold: 先停一下")).toMatchObject({ ok: true });
    expect(rowOf(await readStill(), b.taskId)).toMatchObject({ reasonCode: "pm_hold", owner: { who: PM } });
    expect(await pm("workflow-resume", "B", "--rev", String(getTask(w.db, "B")!.rev), "--workflow-rev", String(getWorkflow(w.db, "B")!.rev),
      "--reason", "PM 交回")).toMatchObject({ ok: true });
    expect(rowOf(await readStill(), b.taskId)).toBeUndefined();
  });
});
