/**
 * HDG-1 验收追加 1: the two gates hold at the authoritative writes, not only in the planner's advice — a local merge intent
 * (planIntent / requireReviewedMerge), a merge run start (beginMergeRun), a running merge's drift check (mergeRunDrift, up to the
 * last read before GitHub) and the manual queue's claim (claimManualMerge / requestRefusal). Only a run begun before the hold went on
 * is exempt from the hold; an intent planned but not begun waits in the merge pass. Real ledger + fake GitHub world.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { claimManualMerge } from "../src/lib/manual-merge-queue.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { getMergeRun, mergeRunDrift } from "../src/lib/scheduler-merge.js";
import { setHandoffHold } from "../src/lib/scheduler-merge-handoff.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  writePolicy("on");
}
const hold = (on: boolean) => setHandoffHold(w.db, { actor: PM, now: Date.now() }, { project: "p", on, reason: on ? "本地继续做，交接排队" : "" });
const lastSeq = () => (w.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
/** The auto tick's own write for a merge intent (Card.plan → `ledger scheduler-plan`), with fresh revs. */
const planMerge = (id: string) => planIntent(w.db, { actor: "scheduler", now: Date.now() }, { id: `auto-merge-${id}`, taskId: id,
  taskRev: getTask(w.db, id)!.rev, workflowRev: 1, causalSeq: lastSeq(), node: "merge_deploy", action: "merge", reason: "合并", resources: ["merge:p"] });
/** A submitted merge intent created at `at` holding the slot, as the merge controller would claim it; then the run start. */
async function beginAt(id: string, at: number) {
  const task = getTask(w.db, id)!, intent = `merge-${id}`;
  w.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,
    createdAt,updatedAt) VALUES (?,?,'p','merge_deploy','merge',3,2,?,1,?,2,'pending','merge',?,?)`).run(intent, id, task.rev, task.headSHA, at, at);
  w.db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,?)").run(id, intent, at);
  await w.manager("ledger", "scheduler-settle", intent, "--from", "pending", "--to", "submitted", "--receipt", "merge controller claimed");
  return { intent, begin: await w.manager("ledger", "scheduler-merge-begin", intent, "--required-checks", "check") };
}
/** Production passes until the card's run merged (at most `n`); the GitHub effects they made. */
async function passes(id: string, n = 12) {
  const calls: string[] = [];
  for (let i = 0; i < n && w.phase(id) !== "merged"; i++) calls.push(...await w.pass());
  return calls;
}
/** A1 on node A and B1 on node B of one feature, no dependency between them. */
function feature() {
  const id = createFeature(w.db, { actor: "owner", now: Date.now() }, { project: "p", slug: "HDG", title: "HDG" }).row.id;
  initDag(w.db, { actor: "owner", now: Date.now() }, { id, rev: 1, nodes: [{ key: "A", taskId: "A1", fileGlobs: ["src/a.ts"] }, { key: "B", taskId: "B1", fileGlobs: ["src/b.ts"] }] });
  return id;
}

describe("local merge writes", () => {
  test("hold on before the intent: the merge intent write refuses it; off: accepted", () => {
    setup();
    w.card("A1");
    hold(true);
    expect(() => planMerge("A1")).toThrow(/handoff_hold：项目暂停交接（agent-pm）：本地继续做，交接排队/);
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action = 'merge'").get()).toEqual({ n: 0 });
    hold(false);
    expect(planMerge("A1").intent).toMatchObject({ action: "merge", status: "pending" });
  });

  test("under the hold no run starts, whenever its intent was planned; a run begun before the hold goes on to merge", async () => {
    setup();
    w.card("A1");
    hold(true);
    const early = await beginAt("A1", 100); // planned long before the hold went on, submitted after it: a new effect all the same
    expect(early.begin).toMatchObject({ ok: false, error: expect.stringMatching(/^handoff_hold：/) });
    expect(getMergeRun(w.db, early.intent)).toBeNull();
    w.db.query("DELETE FROM scheduler_resources WHERE intentId = ?").run(early.intent); // the refused intent's slot, freed for the next case

    hold(false);
    w.card("A2");
    const intent = await w.begin("A2");
    hold(true);
    expect(mergeRunDrift(w.db, getMergeRun(w.db, intent)!)).toBeNull(); // begun before the hold: exempt, never recalled
    await passes("A2");
    expect(w.phase("A2")).toBe("merged");
  });

  test("an intent planned before the hold waits in the merge pass, unsubmitted; off, the next pass merges it", async () => {
    setup();
    w.card("A1");
    const { intent } = planMerge("A1");
    hold(true);
    expect(await passes("A1", 3)).toEqual([]);
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(intent.id)).toEqual({ status: "pending" });
    expect(getMergeRun(w.db, intent.id)).toBeNull();
    hold(false);
    expect(await passes("A1")).toContain("serial-merge:A1");
    expect(w.phase("A1")).toBe("merged");
  });

  test("feature batch: a sibling not reviewed refuses the intent; reviewed, it is accepted; falling back stops the run before GitHub", async () => {
    setup();
    w.card("A1"); w.card("B1");
    feature();
    w.db.query("UPDATE tasks SET stage = 'review' WHERE id = 'B1'").run();
    expect(() => planMerge("A1")).toThrow(/feature_siblings_pending：.*B（B1 review）/);
    w.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'B1'").run();
    const { intent, begin } = await beginAt("A1", Date.now());
    expect(begin).toMatchObject({ ok: true });
    expect(mergeRunDrift(w.db, getMergeRun(w.db, intent)!)).toBeNull();
    w.db.query("UPDATE tasks SET stage = 'fix', round = 2 WHERE id = 'B1'").run();
    const run = getMergeRun(w.db, intent)!;
    expect(mergeRunDrift(w.db, run)).toMatch(/^feature_siblings_pending：.*B（B1 fix）/);
    // claimed as merging, the last read before the merge API still stops it; a merging run that may have sent is not recalled
    expect(mergeRunDrift(w.db, { ...run, phase: "merging", beforeSend: true })).toMatch(/^feature_siblings_pending：/);
    expect(mergeRunDrift(w.db, { ...run, phase: "merging" })).toBeNull();
  });
});

describe("manual merge queue", () => {
  test("a request queued before the hold is not claimed while it is on; off, the next claim takes it", async () => {
    setup();
    const m = await manualCard(w, "M");
    expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    hold(true);
    const claim = () => claimManualMerge(w.db, { actor: "scheduler", now: Date.now() }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] });
    expect(claim()).toMatchObject({ claimed: false });
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'M'").get()).toEqual({ n: 0 });
    await w.pass();
    expect(w.hub.calls.filter((c) => c.endsWith("merge:M"))).toEqual([]);
    expect(listEvents(w.db, { project: "p", target: "M" }).some((e) => e.data.op === "manual_merge_claim")).toBe(false);
    hold(false);
    expect(claim()).toMatchObject({ claimed: true });
  });
});
