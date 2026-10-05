/**
 * MQ1 integration: the real schedulerPass (train tick → mergeTick → deployTick → reclaim → manual claim → auto tick) on a temporary
 * ledger, fake GitHub (tests/scheduler-merge-reclaim-world.ts), the policy read from the test state dir's recovery-policy.json
 * (the pass's default port), PM requests through the real ledger CLI. Auto candidates keep arriving. off (the old path): trains
 * form back to back and the manual card never gets the slot. on: the queue head merges after the current train, before the next.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { listEvents } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { trainHolds } from "../src/lib/scheduler-merge-train-hold.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const policy = writePolicy;
const as = (actor: string, ...args: string[]) => ledgerAs(w, actor, ...args);

function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
}

/** Passes with one fresh auto card arriving whenever no train holds; returns the effects and how many trains formed. */
async function run(passes: number, until: () => boolean) {
  let fresh = 0;
  const arrive = () => { const s = w.store.load("p"); if (!s || !trainHolds(s, Date.now())) w.card(`F${++fresh}`); };
  for (let i = 0; i < passes && !until(); i++) await w.pass({ arrive });
  return { calls: w.hub.calls, trains: w.events.filter((e) => e.kind === "form").length };
}

describe("manual head vs continuous trains (real pass, fake GitHub)", () => {
  for (const mode of ["off", "observe"] as const) {
    test(`${mode}: the old path — trains keep forming, the manual card never gets the slot, nothing is sent for it`, async () => {
      setup(); policy(mode);
      for (const id of ["A1", "A2"]) w.card(id);
      const m = manualCard(w, "M");
      expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
      const r = await run(14, () => false);
      expect(r.trains).toBeGreaterThanOrEqual(2); // waited past more than one train
      expect(r.calls.filter((c) => c.endsWith(":M"))).toEqual([]);
      expect(w.intentOf("M")).toBeNull();
      expect(w.slot()).not.toBe("M");
      const observed = listEvents(w.db, { project: "p", target: "M" }).filter((e) => e.data.op === "recovery_observe");
      expect(observed.length).toBe(mode === "observe" ? 1 : 0); // observe: one deduped would-be line, however many passes
    }, 60_000);
  }

  test("on: the head merges after the current train and before the next one forms; auto cards go on afterwards", async () => {
    setup(); policy("on");
    for (const id of ["A1", "A2"]) w.card(id);
    w.hub.pending = true;
    await w.pass(); // train 1 forms with A1 + A2 and tests
    w.hub.pending = false;
    const m = manualCard(w, "M");
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    const r = await run(16, () => w.events.filter((e) => e.kind === "form").length >= 2 && w.phase("M") === "merged");
    const mergeOf = (id: string) => r.calls.findIndex((c) => c.endsWith(`merge:${id}`));
    expect(w.phase("M")).toBe("merged");
    expect(r.calls.filter((c) => c === "serial-merge:M")).toHaveLength(1); // exactly one external merge for the manual card
    expect(mergeOf("A1")).toBeLessThan(mergeOf("M"));
    expect(mergeOf("A2")).toBeLessThan(mergeOf("M"));
    const trainForms = w.events.filter((e) => e.kind === "form");
    expect(trainForms.length).toBeGreaterThanOrEqual(2); // the auto cards are not starved
    const second = trainForms[1]!.at, mergedAt = listEvents(w.db, { project: "p", target: "M" }).find((e) => e.data.op === "merge_phase" && e.data.to === "merged")!.ts;
    expect(mergedAt).toBeLessThanOrEqual(second);
    // ownership: the run is the manual request's own intent, settled; the slot is not left behind
    const intent = w.intentOf("M")!;
    expect(intent).toMatch(/^mmq:\d+$/);
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(intent)).toEqual({ status: "done" });
    expect(w.slot()).not.toBe("M");
    // no engine review proof was forged for the manual card
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'M' AND action != 'merge'").get()).toEqual({ n: 0 });
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_sessions WHERE taskId = 'M'").get()).toEqual({ n: 0 });
  }, 60_000);

  test("on: two requests go one per turn in queue order, an auto turn between them; a restart keeps the places", async () => {
    setup(); policy("on");
    const m1 = manualCard(w, "M1"), m2 = manualCard(w, "M2");
    expect(await as(PM, ...requestArgs(m1))).toMatchObject({ ok: true });
    expect(await as(PM, ...requestArgs(m2))).toMatchObject({ ok: true });
    expect(await as(PM, ...requestArgs(m2))).toMatchObject({ ok: true, duplicate: true }); // same binding again: same request
    for (const id of ["A1", "A2"]) w.card(id);
    w.restart();
    for (let i = 0; i < 16 && w.phase("M2") !== "merged"; i++) { await w.pass(); if (i === 3) w.restart(); }
    const calls = w.hub.calls, at = (s: string) => calls.findIndex((c) => c.endsWith(s));
    expect([w.phase("M1"), w.phase("M2")]).toEqual(["merged", "merged"]);
    // M2 waited while main moved, so its run updated the branch once (head kept) before its one merge
    expect(calls.filter((c) => c.endsWith(":M1") || c.endsWith(":M2"))).toEqual(["serial-merge:M1", "update:M2", "serial-merge:M2"]);
    expect(at("merge:M1")).toBeLessThan(at("merge:A1"));
    expect(at("merge:A1")).toBeLessThan(at("merge:M2")); // the auto cards had their turn between the two manual ones
  }, 60_000);
});
