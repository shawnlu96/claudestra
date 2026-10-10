/**
 * MTRBUD1: a phase with work starts at least one card per pass even when its wall-clock floor is gone before its first check
 * (docs/design/merge-reclaim-budget-diagnosis.md §4 C0–C5). The clock is a controlled `now` handed to passPace only; mergeTick
 * and deployTick run on the MTR1 world (real ledger CLI, real train tick, fake GitHub / deploy jobs), the same ports schedulerPass uses.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { passPace, type TickPace } from "../src/lib/scheduler-yield.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.ts";

/** Every reading is 5 ms later: each phase's floor and the pass deadline are gone before the phase's first check. */
const lateClock = () => { let t = 1_000_000; return () => (t += 5); };

describe("MTRBUD1 passPace: the phase's first check never yields for the budget", () => {
  test("floor and deadline already past at the first check: the first card starts, the next one yields", () => {
    const pace = passPace({}, { budgetMs: 1, now: lateClock() });
    for (const phase of [pace.phase(), pace.phase()]) expect([phase.yieldNow(), phase.yieldNow(), phase.yieldNow()]).toEqual([false, true, true]);
  });

  test("a waiting update still yields at once; a zero, negative or non-numeric budget keeps its old answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "mtrbud1-req-")), request = join(dir, "m.req");
    try {
      writeFileSync(request, "1");
      expect(passPace({}, { budgetMs: 60_000, request, now: Date.now }).phase().yieldNow()).toBe(true);
      expect(passPace({}, { budgetMs: 1, request, now: lateClock() }).phase().yieldNow()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    for (const budgetMs of [0, -5]) expect(passPace({}, { budgetMs, now: () => 1_000 }).phase().yieldNow()).toBe(true);
    expect(passPace({}, { budgetMs: Number.NaN, now: lateClock() }).phase().yieldNow()).toBe(false); // as before: NaN never compares past
  });
});

/** MTR1's start: T3 (overlapping T1) holds the slot at ready and lends it to the T1+T2 train the pass's own tick formed. */
async function lent(): Promise<ReclaimWorld> {
  const w = reclaimWorld({ store: "memory", deploy: true, files: (n) => (n === 3 ? "src/1.ts" : `src/${n}.ts`) });
  for (const id of ["T1", "T2", "T3"]) w.card(id);
  await w.begin("T3");
  w.hub.pending = true;
  await w.pass();
  w.hub.pending = false;
  expect([w.turns("T3"), w.slot(), w.phase("T3"), w.hub.calls]).toEqual([["yield"], "T1", "ready", []]);
  return w;
}

/** `passes` passes of train tick → mergeTick (phase #0) → deployTick (phase #1), each phase's pace from `pace(cursor)`. */
async function drive(w: ReclaimWorld, passes: number, pace: (cursor: Record<string, string | undefined>) => { phase(): TickPace }) {
  const cursor: Record<string, string | undefined> = {}, handled: number[][] = [];
  for (let i = 0; i < passes; i++) {
    await w.trainTick();
    const p = pace(cursor);
    const merge = await mergeTick(w.db, w.config, w.manager, w.external, () => {}, p.phase(), w.store);
    const deploy = await deployTick(w.db, w.config, { manager: w.manager, jobs: w.deployJobs, assertActive: () => {}, now: Date.now }, p.phase());
    handled.push([merge, deploy]);
  }
  return handled;
}

describe("MTRBUD1 merge / deploy phases past their floor: the lender first in line does not take the only card every pass", () => {
  test("old red: each phase starts a card; the cursor moves past the waiting lender to the member, which merges and deploys", async () => {
    const w = await lent();
    try {
      const late = lateClock();
      const handled = await drive(w, 3, (cursor) => passPace(cursor, { budgetMs: 1, now: late }));
      // before MTRBUD1 every pass was [0, 0] and the calls stayed empty for good (the lender at eventSeq 2 came first and the
      // merge phase yielded before it; deployTick asked before skipping it)
      expect(w.hub.calls).toEqual(["match-head:T1", "deploy:T1"]);
      expect(handled[0]).toEqual([1, 0]); // pass 1: the merge phase's one card is the lender, which only waits
      expect([w.phase("T1"), w.phase("T3"), w.turns("T3"), w.slot()]).toEqual(["merged", "ready", ["yield"], null]); // deploy done frees the slot; reclaim is the pass's later step
    } finally { w.close(); }
  });

  test("an update waiting, an outside pace that yields or skips, a zero budget: no card starts, as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mtrbud1-req-")), request = join(dir, "m.req");
    writeFileSync(request, "1");
    const paces: [string, (cursor: Record<string, string | undefined>) => { phase(): TickPace }][] = [
      ["update", (cursor) => passPace(cursor, { budgetMs: 1, request, now: lateClock() })],
      ["zero budget", (cursor) => passPace(cursor, { budgetMs: 0, now: lateClock() })],
      ["outside yield", (cursor) => ({ phase: () => ({ cursor, yieldNow: () => true }) })],
      ["outside skip", (cursor) => ({ phase: () => ({ cursor, yieldNow: () => false, skipTask: () => true }) })],
    ];
    try {
      for (const [why, pace] of paces) {
        const w = await lent();
        try {
          expect([why, await drive(w, 3, pace), w.hub.calls, w.phase("T1"), w.turns("T3")]).toEqual([why, [[0, 0], [0, 0], [0, 0]], [], null, ["yield"]]);
        } finally { w.close(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the member's head moved: its first card still goes through the drift gate, nothing is merged or deployed", async () => {
    const w = await lent();
    try {
      w.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run("f".repeat(40));
      const late = lateClock();
      await drive(w, 3, (cursor) => passPace(cursor, { budgetMs: 1, now: late }));
      expect(w.hub.calls).toEqual([]);
      expect(w.phase("T1")).not.toBe("merged");
      expect([w.phase("T3"), w.turns("T3")]).toEqual(["ready", ["yield"]]);
    } finally { w.close(); }
  });

  test("ample budget: the cursor changes nothing, both phases go through every intent in eventSeq order as before", async () => {
    const w = await lent();
    try {
      const handled = await drive(w, 3, (cursor) => passPace(cursor, { budgetMs: 60_000 }));
      expect(w.hub.calls).toEqual(["match-head:T1", "deploy:T1"]);
      expect(handled[0]).toEqual([2, 0]); // the lender and the member, in one pass
    } finally { w.close(); }
  });
});
