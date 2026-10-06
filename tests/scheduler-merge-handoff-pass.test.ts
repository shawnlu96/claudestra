/**
 * MHO1 through the real schedulerPass (tests/scheduler-merge-reclaim-world.ts: train tick → mergeTick → deployTick → reclaim →
 * auto tick, fake GitHub): the same ready cards that a local-merge project trains and merges are, with mergeHandoff, only
 * handed over — no train, no merge intent, no merge slot, no update-branch / merge call, and a merge run left from before the
 * switch is not driven. The local-merge world is the pin that the existing path is unchanged.
 */
import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { reclaimWorld } from "./scheduler-merge-reclaim-world.ts";

const handoffs = (w: ReturnType<typeof reclaimWorld>, id: string) => listEvents(w.db, { project: "p", target: id }).filter((e) => e.data.op === "merge_handoff");

describe("MHO1 merge handoff (full pass)", () => {
  test("two ready cards: local merge forms a train and merges both; mergeHandoff hands both over and touches no merge path", async () => {
    const local = reclaimWorld({ store: "memory" }), handed = reclaimWorld({ store: "memory", handoff: true });
    try {
      for (const w of [local, handed]) { w.card("T1"); w.card("T2"); }
      for (let i = 0; i < 12 && local.phase("T2") !== "merged"; i++) await local.pass();
      expect(local.hub.calls).toEqual(["match-head:T1", "match-head:T2"]);
      expect(local.events[0]?.kind).toBe("form");
      expect(handoffs(local, "T1")).toEqual([]);

      for (let i = 0; i < 3; i++) expect(await handed.pass()).toEqual([]);
      expect(handed.store.load("p")).toBeNull();
      expect(handed.events).toEqual([]);
      expect([handed.intentOf("T1"), handed.intentOf("T2"), handed.slot()]).toEqual([null, null, null]);
      for (const id of ["T1", "T2"]) {
        const task = getTask(handed.db, id)!;
        expect(handoffs(handed, id).map((e) => e.data.evidence)).toEqual([expect.objectContaining({ v: 1, head: task.headSHA, pr: task.pr,
          review: expect.objectContaining({ reviewerFamily: "codex", verdict: "pass" }) })]);
        expect(task.stage).toBe("merge");
      }
    } finally { local.close(); handed.close(); }
  });

  test("a merge run begun before the switch is neither driven nor reclaimed; its card goes to PM", async () => {
    const w = reclaimWorld({ store: "memory", handoff: true });
    try {
      w.card("T3");
      const intent = await w.begin("T3");
      expect(w.phase("T3")).toBe("ready");
      expect(await w.pass()).toEqual([]);
      expect(w.phase("T3")).toBe("ready");
      expect(w.intentOf("T3")).toBe(intent);
      expect(getWorkflow(w.db, "T3")?.mode).toBe("manual");
      expect(handoffs(w, "T3")).toEqual([]);
    } finally { w.close(); }
  });
});
