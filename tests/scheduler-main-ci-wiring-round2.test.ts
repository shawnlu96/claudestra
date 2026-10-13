/**
 * MAINCIW merge invariants, through the real pass / CLI (fixture: tests/scheduler-main-ci-wiring-world.test.ts):
 * [验收线 4] a paused pending intent lends the slot to a repair card bound after it, and takes it back on resume;
 * [验收线 4] a revoke after the gate said go stops the run before any merge; [验收线 2] a ledger head drift while paused cancels, never freezes.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { useMainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

const world = useMainCiWorld();
let w: MainCiWorld;
beforeEach(() => { w = world(); });

const merges = (calls: string[]) => calls.filter((c) => /^(update|serial-merge|match-head):/.test(c));
const passes = async (n: number) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push(...await w.pass()); return out; };
const slotHolder = () => (w.db.query("SELECT taskId FROM scheduler_resources WHERE project='p' AND resource='merge:p'").get() as { taskId: string } | null)?.taskId ?? null;
const statusOf = (intent: string) => (w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent) as { status: string }).status;
const begins = (task: string) => w.managerLog.filter((a) => a[1] === "scheduler-merge-begin" && w.intentOf(task)?.id === a[2]).length;

describe("[验收线 4] pending-slot: a paused pending intent holds no slot against a bound repair card", () => {
  test("D pending before C is bound: C plans, merges; D never begins while paused, then takes the slot back and merges", async () => {
    writePolicy({ mainCiPause: "on" });
    w.ci.defaultCi = "failure";
    w.card("D");
    await passes(2);
    const d = w.intentOf("D")!;
    expect(d.status).toBe("pending");
    expect(slotHolder()).toBe("D");
    const c = w.card("C");
    expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"])).toMatchObject({ ok: true });
    const calls = await passes(8);
    expect(merges(calls)).toEqual(["serial-merge:C"]);
    expect(w.intentOf("D")).toEqual({ id: d.id, status: "pending" });
    expect(begins("D")).toBe(0);
    expect(w.frozen()).toBe(false);
    expect(w.taskEvents("D").filter((e) => e.data.op === "main_ci_slot").map((e) => e.data.turn)).toEqual(["lend"]);
    w.ci.defaultCi = "success"; // the repair landed: main green, D goes on with the slot it takes back
    const after = await passes(4);
    expect(merges(after).filter((m) => m.startsWith("serial-merge:"))).toEqual(["serial-merge:D"]); // after an update: main moved when C merged
    expect(w.taskEvents("D").filter((e) => e.data.op === "main_ci_slot").map((e) => e.data.turn)).toEqual(["lend", "take"]);
  });

  test("lend-slot is refused for an intent that does not hold the slot, and take-slot for one that never lent", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("D");
    const intent = `merge-D`;
    w.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,
      createdAt,updatedAt) VALUES (?,?,'p','merge_deploy','merge',3,2,2,1,'x',2,'pending','merge',100,100)`).run(intent, "D");
    const op = (o: string) => w.ledger("scheduler", ["scheduler-main-ci", "p", "--op", o, "--intent", intent]);
    expect(await op("lend-slot")).toMatchObject({ ok: false, code: "conflict" });
    expect(await op("take-slot")).toMatchObject({ ok: false, code: "conflict" });
    expect(await w.ledger("agent-pm", ["scheduler-main-ci", "p", "--op", "take-slot", "--intent", intent])).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("[验收线 4] repair-revoke: the binding is re-read before every effect claim", () => {
  test("PM revokes C's binding during the drive's first PR read: no merge sent, run cancelled main_ci_pause, no freeze", async () => {
    writePolicy({ mainCiPause: "on" });
    const c = w.card("C");
    w.ci.defaultCi = "failure";
    expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"])).toMatchObject({ ok: true });
    const intent = await w.begin("C");
    await w.step(intent, "ready", "await_ci");
    let revoked = false;
    w.ci.onInspect = async (pr) => {
      if (revoked || pr !== c.prRef) return;
      revoked = true;
      expect(await w.ledger("agent-pm", ["main-ci-repair", "C", "--revoke", "--reason", "换人修"])).toMatchObject({ ok: true });
    };
    const calls = await w.pass();
    expect(revoked).toBe(true);
    expect(merges(calls)).toEqual([]);
    expect(statusOf(intent)).toBe("cancelled");
    expect(w.taskEvents("C").filter((e) => e.data.op === "merge_unsent_cancel").at(-1)!.data).toMatchObject({ counted: false, cause: "main_ci_pause" });
    expect(w.frozen()).toBe(false);
  });

  test("without a revoke the bound card still merges through the same guarded claims", async () => {
    writePolicy({ mainCiPause: "on" });
    const c = w.card("C");
    w.ci.defaultCi = "failure";
    await w.ledger("agent-pm", ["main-ci-repair", "C", "--head", c.head, "--main", w.hub.main, "--reason", "修 main"]);
    const intent = await w.begin("C");
    await w.step(intent, "ready", "await_ci");
    expect(merges(await w.pass())).toEqual(["serial-merge:C"]);
  });
});

describe("[验收线 2] pause-slot: a ledger head drift while paused is a main_ci_pause cancel", () => {
  for (const unsent of ["off", "on"] as const) {
    test(`mergeUnsentCancel=${unsent}: cancelled, slot freed, not counted, no freeze`, async () => {
      writePolicy({ mainCiPause: "on", mergeUnsentCancel: unsent });
      w.card("T1");
      const intent = await w.begin("T1");
      w.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(w.newSha()); // the ledger head moved on
      w.ci.bySha.set(w.hub.main, "failure");
      const calls = await w.pass();
      expect(merges(calls)).toEqual([]);
      expect(statusOf(intent)).toBe("cancelled");
      expect(w.db.query("SELECT 1 FROM scheduler_resources WHERE intentId=?").get(intent)).toBeNull();
      expect(w.taskEvents("T1").filter((e) => e.data.op === "merge_unsent_cancel").at(-1)!.data).toMatchObject({ counted: false, cause: "main_ci_pause" });
      expect(w.frozen()).toBe(false);
    });
  }

  test("observe: the drift freezes exactly as before (no main_ci_pause cancel)", async () => {
    writePolicy({ mainCiPause: "observe", mergeUnsentCancel: "off" });
    w.card("T1");
    const intent = await w.begin("T1");
    w.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(w.newSha());
    w.ci.bySha.set(w.hub.main, "failure");
    await w.pass();
    expect(statusOf(intent)).toBe("submitted");
    expect(w.phase("T1")).toBe("unknown");
    expect(w.frozen()).toBe(true);
  });
});
