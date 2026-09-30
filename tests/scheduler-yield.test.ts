/**
 * T68h scope 2 (T68f-r4-adv.md ④): update is not starved by back-to-back scheduler passes, a pass has a time budget, and
 * a pass cut short resumes after the last card it handled. Real maintenance locks and a real ledger; only the ledger CLI
 * (the `manager` of the pass) is a stub that takes its time.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { acquireMaintenance } from "../src/lib/scheduler-maintenance.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import { maintenanceRequested, passPace, REQUEST_FRESH_MS, rotateAfter } from "../src/lib/scheduler-yield.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function world(cards: number) {
  const root = mkdtempSync(join(tmpdir(), "t68h-yield-")); roots.push(root);
  const ledger = join(root, "ledger.sqlite"), db = openLedger(ledger);
  let now = Date.now();
  for (let i = 0; i < cards; i++) {
    const id = `T${String(i).padStart(2, "0")}`;
    createTask(db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code" });
    setWorkflow(db, { actor: "owner", now: (now += 10) }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "observe",
      authorFamily: "claude", fallback: "人工" });
  }
  const maintenance = { path: join(root, "maint.lock"), marker: join(root, "update.marker"), request: join(root, "maint.request") };
  return { root, ledger, db, maintenance, updateOpts: { ...maintenance, reader: new LedgerReader(join(root, "none.sqlite")) } };
}

const config = { enabled: true, pollMs: 1000, autoDispatch: false, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["c"], repoDir: "/x" } } };

describe("maintenance fairness and the pass budget", () => {
  test("rotation starts after the last handled key and wraps; a vanished key skips nothing", () => {
    const k = (s: string) => s;
    expect(rotateAfter(["b", "a", "c"], k, undefined)).toEqual(["a", "b", "c"]);
    expect(rotateAfter(["a", "b", "c"], k, "a")).toEqual(["b", "c", "a"]);
    expect(rotateAfter(["a", "c", "d"], k, "b")).toEqual(["c", "d", "a"]);
    expect(rotateAfter(["a", "b"], k, "z")).toEqual(["a", "b"]);
  });

  test("the pace yields once the budget is spent or an update request is fresh, not for a stale one", () => {
    const w = world(0);
    let t = 1_000_000;
    const pace = passPace({}, { budgetMs: 100, request: w.maintenance.request, now: () => t });
    expect(pace.yieldNow()).toBe(false);
    t += 100;
    expect(pace.yieldNow()).toBe(true);
    writeFileSync(w.maintenance.request, "1");
    expect(maintenanceRequested(w.maintenance.request)).toBe(true);
    const old = new Date(Date.now() - REQUEST_FRESH_MS - 1000);
    utimesSync(w.maintenance.request, old, old);
    expect(maintenanceRequested(w.maintenance.request)).toBe(false);
  });

  test("a fresh update request keeps the scheduler from starting a pass", async () => {
    const w = world(0);
    writeFileSync(w.maintenance.request, "1");
    expect(await acquireMaintenance("scheduler", w.maintenance)).toBeNull();
    rmSync(w.maintenance.request);
    const lease = await acquireMaintenance("scheduler", w.maintenance);
    expect(lease).not.toBeNull();
    lease!.release();
  });

  test("under back-to-back passes an update gets the lease within one card step; the next pass resumes after the cut", async () => {
    const w = world(8);
    const seen: string[] = [];
    const manager = async (...args: string[]) => { seen.push(args[2]); await Bun.sleep(250); return { ok: true, duplicate: true }; };
    const cursor: Record<string, string | undefined> = {};
    let stop = false, passes = 0;
    const loop = (async () => {
      while (!stop) {
        const r = await schedulerPass(w.db, config, { assertOwner: () => {}, manager, maintenance: w.maintenance, cursor, budgetMs: 60_000 });
        if (r.ran) passes++;
        await Bun.sleep(5);
      }
    })();
    await Bun.sleep(700);
    expect(await acquireMaintenance("update", w.updateOpts)).toBeNull(); // no wait: refused while a pass runs, as before
    const t0 = Date.now();
    const update = await acquireMaintenance("update", { ...w.updateOpts, waitMs: 10_000 });
    const waited = Date.now() - t0;
    expect(update).not.toBeNull();
    expect(waited).toBeLessThan(1_500);
    const cut = seen.length;
    expect(cut).toBeLessThan(8);
    expect(maintenanceRequested(w.maintenance.request)).toBe(false);
    update!.release();
    await Bun.sleep(900);
    stop = true;
    await loop;
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(seen[cut]).toBe(`T${String(cut).padStart(2, "0")}`); // resumed with the next card, not from T00
    closeLedger(w.ledger);
  }, 30_000);

  test("a pass stops starting cards once its budget is spent; the rest go first next pass", async () => {
    const w = world(6);
    const seen: string[] = [];
    const manager = async (...args: string[]) => { seen.push(args[2]); await Bun.sleep(120); return { ok: true, duplicate: true }; };
    const cursor: Record<string, string | undefined> = {};
    await schedulerPass(w.db, config, { assertOwner: () => {}, manager, maintenance: w.maintenance, cursor, budgetMs: 300 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(6);
    const first = seen.length;
    await schedulerPass(w.db, config, { assertOwner: () => {}, manager, maintenance: w.maintenance, cursor, budgetMs: 60_000 });
    expect(seen.slice(first, 6)).toEqual(["T00", "T01", "T02", "T03", "T04", "T05"].slice(first));
    closeLedger(w.ledger);
  });
});
