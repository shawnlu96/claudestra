/**
 * MAINCIW [验收线 1] pause and [验收线 2] in-flight runs / trains, through the real schedulerPass with fake GitHub ports
 * (tests/scheduler-main-ci-wiring-world.test.ts). Each "on" expectation is red before the change: the same input formed a train,
 * claimed / began merges, or bounced / froze the await_ci run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { mainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

let w: MainCiWorld, saved: string | null;
beforeEach(() => { saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; w = mainCiWorld(); });
afterEach(() => {
  w.close();
  if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true }); else writeFileSync(RECOVERY_POLICY_PATH, saved);
});

const merges = (calls: string[]) => calls.filter((c) => /^(update|serial-merge|match-head):/.test(c));
const bounces = () => w.db.query("SELECT COUNT(*) AS n FROM events WHERE kind='scheduler' AND json_extract(data,'$.op')='merge_conflict'").get() as { n: number };
const runs = () => (w.db.query("SELECT COUNT(*) AS n FROM scheduler_merges").get() as { n: number }).n;
const pauseMarkers = (id: string) => w.taskEvents(id).filter((e) => e.data.op === "merge_unsent_cancel");

describe("[验收线 1] main red pauses train, claim, begin and every GitHub write", () => {
  test("on: no train, no begin, zero update / rerun / merge, no bounce, queue not frozen, intent stays pending", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1"); w.card("T2");
    w.ci.bySha.set(w.hub.main, "failure");
    const calls = [...await w.pass(), ...await w.pass(), ...await w.pass()];
    expect(w.store.load("p")).toBeNull();
    expect(merges(calls)).toEqual([]);
    expect(runs()).toBe(0);
    expect(w.managerLog.filter((a) => a[1] === "scheduler-merge-begin")).toEqual([]);
    // the auto tick still plans the merge (planner untouched); mergeTick leaves it pending: no claim
    const intent = w.intentOf("T1") ?? w.intentOf("T2");
    expect(intent?.status).toBe("pending");
    expect(bounces().n).toBe(0);
    expect(w.frozen()).toBe(false);
    expect(w.ci.reads.filter((r) => r.endsWith("/git/ref/heads/main")).length).toBeGreaterThan(0);
  });

  test("before the change (off): the same input forms the train", async () => {
    writePolicy({ mainCiPause: "off" });
    w.card("T1"); w.card("T2");
    w.ci.bySha.set(w.hub.main, "failure");
    w.hub.pending = true;
    await w.pass();
    expect(w.store.load("p")?.phase).toBe("testing");
  });

  test("a card in review is still planned while main is red (write / review keep going)", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1"); w.card("T2");
    w.card("R1", "review");
    w.ci.bySha.set(w.hub.main, "failure");
    const plannedBefore = (w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId='R1'").get() as { n: number }).n;
    await w.pass();
    const planned = w.db.query("SELECT action FROM scheduler_intents WHERE taskId='R1' AND action != 'merge'").all() as { action: string }[];
    expect(planned.length).toBeGreaterThanOrEqual(plannedBefore);
    expect(w.db.query("SELECT 1 FROM scheduler_intents WHERE taskId='R1' AND action='merge'").get()).toBeNull();
    expect(w.taskEvents("R1").some((e) => e.data.op === "merge_unsent_cancel")).toBe(false);
  });
});

describe("[验收线 2] in-flight runs end as main_ci_pause cancellations; trains void without a culprit", () => {
  test("ready → cancelled main_ci_pause: slot freed, no freeze, not counted, card stays in merge", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    const intent = await w.begin("T1");
    w.ci.bySha.set(w.hub.main, "failure");
    const calls = await w.pass();
    expect(merges(calls)).toEqual([]);
    expect((w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent) as { status: string }).status).toBe("cancelled");
    const marker = pauseMarkers("T1").at(-1)!;
    expect(marker.data).toMatchObject({ counted: false, cause: "main_ci_pause", phase: "ready" });
    expect(String(marker.data.receipt)).toStartWith("main_ci_pause：");
    expect(w.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(intent)).toBeNull();
    expect(w.frozen()).toBe(false);
    expect(bounces().n).toBe(0);
    expect(w.db.query("SELECT stage FROM tasks WHERE id='T1'").get()).toEqual({ stage: "merge" });
  });

  test("await_ci with a red PR head (main red): cancelled, never bounced to fix, never frozen", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    const intent = await w.begin("T1");
    await w.step(intent, "ready", "await_ci");
    w.ci.bySha.set(w.hub.main, "failure");
    w.ci.prChecks.set("T1", "fail");
    const calls = await w.pass();
    expect(merges(calls)).toEqual([]);
    expect(w.phase("T1") === null || w.intentOf("T1")!.status !== "submitted").toBe(true);
    expect(pauseMarkers("T1").at(-1)!.data).toMatchObject({ counted: false, phase: "await_ci" });
    expect(bounces().n).toBe(0);
    expect(w.frozen()).toBe(false);
    expect(w.db.query("SELECT stage FROM tasks WHERE id='T1'").get()).toEqual({ stage: "merge" });
  });

  test("before the change (off): the same await_ci run goes back to fix or freezes", async () => {
    writePolicy({ mainCiPause: "off", mergeUnsentCancel: "off" });
    w.card("T1");
    const intent = await w.begin("T1");
    await w.step(intent, "ready", "await_ci");
    w.ci.bySha.set(w.hub.main, "failure");
    w.ci.prChecks.set("T1", "fail");
    await w.pass();
    expect(pauseMarkers("T1")).toEqual([]);
    const ended = w.taskEvents("T1").filter((e) => e.data.op === "merge_phase" && ["resolved", "unknown"].includes(String(e.data.to)) ||
      e.data.op === "merge_conflict" || e.data.op === "ci_rerun");
    expect(ended.length + (w.frozen() ? 1 : 0)).toBeGreaterThan(0);
  });

  test("updating: read back only, no new request, no bounce; the next await_ci gate cancels", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    const intent = await w.begin("T1");
    await w.step(intent, "ready", "updating");
    w.ci.bySha.set(w.hub.main, "failure");
    w.ci.prChecks.set("T1", "fail");
    const first = await w.pass();
    expect(merges(first)).toEqual([]);
    expect(bounces().n).toBe(0);
    expect(w.taskEvents("T1").some((e) => e.data.op === "merge_phase" && e.data.from === "updating" && e.data.to === "await_ci")).toBe(true);
    const second = await w.pass();
    expect(merges(second)).toEqual([]);
    expect(pauseMarkers("T1").at(-1)!.data).toMatchObject({ phase: "await_ci", counted: false });
    expect(w.frozen()).toBe(false);
  });

  test("merging: only the read-back, journalled as before", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    const intent = await w.begin("T1");
    await w.step(intent, "ready", "await_ci");
    await w.step(intent, "await_ci", "merging");
    w.ci.bySha.set(w.hub.main, "failure");
    const calls = await w.pass();
    expect(merges(calls)).toEqual([]);
    expect(w.phase("T1")).toBe("unknown"); // the old journal: a merge maybe sent and not seen merged is never retried
    expect(pauseMarkers("T1")).toEqual([]);
  });

  test("a testing train is voided: no culprit, no member bounced, members stay in merge", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1"); w.card("T2");
    w.hub.pending = true;
    await w.pass();
    expect(w.store.load("p")?.phase).toBe("testing");
    w.ci.bySha.set(w.hub.main, "failure");
    w.hub.pending = false;
    await w.pass();
    const s = w.store.load("p")!;
    expect(s.outcome).toBe("void");
    expect(s.bounced).toEqual([]);
    expect(w.events.some((e) => e.kind === "void" && e.data?.cause === "main_ci_pause")).toBe(true);
    expect(bounces().n).toBe(0);
    for (const id of ["T1", "T2"]) expect(w.db.query("SELECT stage FROM tasks WHERE id=?").get(id)).toEqual({ stage: "merge" });
  });
});
