/**
 * MRGRECLAIM1: a manual merge request the pass claims (after its mergeTick, before the auto tick) is driven again in the same
 * pass when mergeDirect is on, like a slot taken back (MERGEFAST2/3). The claim begins the run in the same transaction, so
 * mergeAgain's query never saw it and the merge waited a whole pass. Real schedulerPass + real ledger CLI + fake GitHub, with
 * the switches claude-orchestrator runs with (`live`: mergeTrain off, direct merge wired to mergeDirect).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs } from "./manual-merge-queue-world.test.js";

type Mode = "on" | "observe" | "off";
const PM = "agent-pm";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const policy = (queue: Mode, direct: Mode) =>
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: queue, mergeDirect: direct } } } }));
const merges = () => w.hub.calls.filter((c) => c === "serial-merge:M" || c === "match-head:M").length;
const intentStatus = (id: string) => (w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(id) as { status: string } | null)?.status ?? null;
const frozen = () => w.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'queueFrozen'").get();
const claimed = (a: string[], r: Record<string, unknown>) => a[1] === "manual-merge-claim" && r.claimed === true;

/** A manual card M the PM asked to merge, queued; the policy file as given. */
async function queued(direct: Mode) {
  w = reclaimWorld({ store: "memory", live: true });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  policy("on", direct);
  const m = await manualCard(w, "M");
  expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
}

/** Real passes until one claims M (`act` runs right after the claim returns); the claimed intent, at the end of that pass. */
async function claimPass(act: () => void = () => {}) {
  let done = false;
  for (let i = 0; i < 4 && !done; i++) await w.pass({ afterManager: (a, r) => { if (!done && claimed(a, r)) { done = true; act(); } } });
  expect(done).toBe(true);
  return w.intentOf("M")!;
}

describe("MRGRECLAIM1 a manual claim is driven in the pass that claims it (mergeDirect on)", () => {
  test("[验收线 1] the claiming pass merges M once, intent done, slot free; another pass sends nothing", async () => {
    await queued("on");
    const intent = await claimPass();
    expect([w.phase("M"), merges(), intentStatus(intent), w.slot()]).toEqual(["merged", 1, "done", null]);
    await w.pass();
    expect(merges()).toBe(1);
  }, 30_000);

  for (const direct of ["off", "observe"] as const) {
    test(`[验收线 2] mergeDirect ${direct}: the claiming pass leaves the run at ready, 0 merges; later it merges exactly once`, async () => {
      await queued(direct);
      await claimPass();
      expect([w.phase("M"), merges()]).toEqual(["ready", 0]);
      for (let i = 0; i < 6 && w.phase("M") !== "merged"; i++) await w.pass();
      await w.pass();
      expect([w.phase("M"), merges()]).toEqual(["merged", 1]);
    }, 30_000);
  }

  for (const to of ["off", "observe"] as const) {
    test(`[验收线 3] manualMergeQueue on → ${to} right after the claim: the extra tick's recheck resolves the run, nothing is sent`, async () => {
      await queued("on");
      const intent = await claimPass(() => policy(to, "on"));
      expect([getMergeRun(w.db, intent)?.phase, intentStatus(intent), w.slot(), merges(), frozen()]).toEqual(["resolved", "cancelled", null, 0, null]);
    }, 30_000);
  }
});
