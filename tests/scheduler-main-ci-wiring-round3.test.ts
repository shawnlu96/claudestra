/**
 * MAINCIW merge invariants, through the real pass / CLI (fixture: tests/scheduler-main-ci-wiring-world.test.ts):
 * [验收线 2] a paused run is judged on its own reviewed head: a binding on the card's new head does not keep an older run alive;
 * [验收线 4] a revoke during the updating claim's round trip stops the update-branch before it is sent.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { useMainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

const world = useMainCiWorld();
let w: MainCiWorld;
beforeEach(() => { w = world(); });

const merges = (calls: string[]) => calls.filter((c) => /^(update|serial-merge|match-head):/.test(c));
const statusOf = (intent: string) => (w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent) as { status: string }).status;
const pauseCancels = (task: string) => w.taskEvents(task).filter((e) => e.data.op === "merge_unsent_cancel" && e.data.cause === "main_ci_pause");

describe("[验收线 2] pause-slot: the run's reviewed head decides, not the task's", () => {
  for (const at of ["ready", "await_ci"] as const) {
    test(`${at}: T1's head moved and PM bound the new head; the old run is cancelled main_ci_pause, slot freed, no freeze`, async () => {
      writePolicy({ mainCiPause: "on", mergeUnsentCancel: "off" });
      w.card("T1");
      w.ci.defaultCi = "failure";
      const intent = await w.begin("T1");
      if (at === "await_ci") await w.step(intent, "ready", "await_ci");
      const head = w.newSha();
      w.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(head);
      expect(await w.ledger("agent-pm", ["main-ci-repair", "T1", "--head", head, "--main", w.hub.main, "--reason", "修 main"])).toMatchObject({ ok: true });
      const calls = await w.pass();
      expect(merges(calls)).toEqual([]);
      expect(statusOf(intent)).toBe("cancelled");
      expect(w.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(intent)).toBeNull();
      expect(pauseCancels("T1").at(-1)!.data).toMatchObject({ counted: false, intentId: intent });
      expect(w.frozen()).toBe(false);
      expect(w.db.query("SELECT stage FROM tasks WHERE id='T1'").get()).toEqual({ stage: "merge" });
    });
  }
});

describe("[验收线 4] repair-revoke: the binding is asked again right before update-branch is sent", () => {
  test("PM revokes C's binding while the updating claim's receipt is on its way: no update sent, run cancelled main_ci_pause, no freeze, no bounce", async () => {
    writePolicy({ mainCiPause: "on" });
    const c = w.card("C");
    w.ci.defaultCi = "failure";
    expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"])).toMatchObject({ ok: true });
    const intent = await w.begin("C");
    w.hub.synced.set(c.prRef, w.newSha()); // C's ready run is behind main: the drive claims updating, then updates the branch
    let revoked = false;
    w.ci.onReceipt = async (args) => {
      if (revoked || args[1] !== "scheduler-merge-step" || !args.includes("updating")) return;
      revoked = true;
      expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "换人修"])).toMatchObject({ ok: true });
    };
    const calls = await w.pass();
    expect(revoked).toBe(true);
    expect(merges(calls)).toEqual([]);
    expect(statusOf(intent)).toBe("cancelled");
    expect(pauseCancels("C").at(-1)!.data).toMatchObject({ counted: false, intentId: intent });
    expect(w.taskEvents("C").filter((e) => e.data.op === "merge_conflict")).toEqual([]);
    expect(w.frozen()).toBe(false);
    expect(w.db.query("SELECT stage FROM tasks WHERE id='C'").get()).toEqual({ stage: "merge" });
  });

  test("without a revoke the bound, behind card is updated as before", async () => {
    writePolicy({ mainCiPause: "on" });
    const c = w.card("C");
    w.ci.defaultCi = "failure";
    await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"]);
    await w.begin("C");
    w.hub.synced.set(c.prRef, w.newSha());
    expect(merges(await w.pass())).toEqual(["update:C"]);
    expect(w.phase("C")).toBe("updating");
  });
});
