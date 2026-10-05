/**
 * MTR1: a card that lent its merge slot to a train gets it back before fresh merge plans, end to end through schedulerPass
 * (tests/scheduler-merge-reclaim-world.ts), plus the guards of the reclaim step itself (lib/scheduler-merge-reclaim.ts).
 * The production pass order frees a deployed member's slot in deployTick, after mergeTick looked at the lender: before MTR1
 * the auto tick planned a fresh card onto it every time, so with fresh arrivals the lender never merged.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { HOLD_LIMIT_MS, SLOT_YIELD } from "../src/lib/scheduler-merge-train-hold.js";
import { reclaimLentSlots } from "../src/lib/scheduler-merge-reclaim.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { reclaimWorld, starvation, type ReclaimWorld, type WorldOpts } from "./scheduler-merge-reclaim-world.ts";
import { testChildEnv } from "./test-env.ts";

const overlapT1 = (n: number) => (n === 3 ? "src/1.ts" : `src/${n}.ts`); // T3 overlaps T1, so it can't share the train's car
const world = (o: Partial<WorldOpts> = {}) => reclaimWorld({ store: "memory", deploy: true, files: overlapT1, ...o });
const WITH_DEPLOY = ["match-head:T1", "deploy:T1", "match-head:T2", "deploy:T2", "update:T3", "serial-merge:T3", "deploy:T3"];
/** The PM notices of the T1+T2 train the pass's own tick formed, tested green and settled (ids masked). */
const TRAIN_MERGED = ["T1: 组车 2 张：T1、T2，起点 main 000000000000", "T1: 车厢 <train>（T1、T2）CI 绿",
  "T1: 结束（merged）：合并 T1、T2，退回 （无），串行 （无），CI 1 次"];
const core = ({ calls, t3, turns, trainDone }: Awaited<ReturnType<typeof starvation>>) => ({ calls, t3, turns, trainDone });
const merges = (calls: string[]) => calls.filter((c) => /^(serial-merge|match-head):/.test(c)).map((c) => c.split(":")[1]);

describe("MTR1 a lender takes its slot back before fresh merge plans (full pass)", () => {
  test("deploy releases the slot after mergeTick: the lender reclaims it in the same pass, then update-branch, CI and its own merge; fresh cards wait, then merge too", async () => {
    const w = world();
    try {
      const r = await starvation(w);
      expect(core(r)).toEqual({ calls: WITH_DEPLOY, t3: "merged", turns: ["yield", "reclaim"], trainDone: true });
      expect([r.trainLog, r.fresh > 0]).toEqual([TRAIN_MERGED, true]); // the in-pass tick formed and settled the train; fresh cards were waiting
      expect(w.events.slice(0, 8).map((e) => e.kind)).toEqual(["form", "hold", "ci", "hold", "merge", "merge", "cleanup", "done"]);
      for (let i = 0; i < 12 && w.phase("F2") !== "merged"; i++) await w.pass();
      expect(merges(w.hub.calls)).toEqual(["T1", "T2", "T3", "F1", "F2"]); // fresh arrivals are served after it, in their own order
    } finally { w.close(); }
  });

  test("merge without deploy: the member settles inside mergeTick after the lender's turn, and the reclaim still comes before the auto tick", async () => {
    const w = world({ deploy: false });
    try {
      expect(core(await starvation(w))).toEqual({ calls: ["match-head:T1", "match-head:T2", "update:T3", "serial-merge:T3"], t3: "merged",
        turns: ["yield", "reclaim"], trainDone: true });
    } finally { w.close(); }
  });

  test("file train store handed in, daemon restarts in the middle (new ledger connection and cursor): the same bounded recovery", async () => {
    for (const at of [2, 4, 5]) {
      const w = world({ store: "file" });
      try {
        expect(core(await starvation(w, { between: (i) => { if (i === at) w.restart(); } }))).toEqual({ calls: WITH_DEPLOY, t3: "merged",
          turns: ["yield", "reclaim"], trainDone: true });
      } finally { w.close(); }
    }
  });

  test("every phase yields its budget each pass: the reclaim does not wait for a share and the lender still merges first", async () => {
    const w = world();
    try {
      const r = await starvation(w, { passes: 40, budgetMs: 1 });
      expect([r.t3, r.turns]).toEqual(["merged", ["yield", "reclaim"]]);
      expect(merges(r.calls)).toEqual(["T1", "T2", "T3"]);
    } finally { w.close(); }
  });

  test("default store path: a non-test child (temp HOME / state / runtime / TMPDIR, no env file, gh / launchctl stubs that fail) recovers the lender", () => {
    const root = mkdtempSync(join(tmpdir(), "mtr1-child-")), bin = join(root, "bin"), stubLog = join(root, "stub.log");
    try {
      for (const d of ["home", "state", "runtime", "tmp", "bin"]) mkdirSync(join(root, d));
      for (const c of ["gh", "launchctl"]) {
        writeFileSync(join(bin, c), `#!/bin/sh\necho "${c} $*" >> "${stubLog}"\nexit 1\n`);
        chmodSync(join(bin, c), 0o755);
      }
      const env = testChildEnv({ PATH: `${bin}:${process.env.PATH}`, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
        CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "runtime") });
      delete env.CLAUDESTRA_TEST; delete env.NODE_ENV; // the only way to reach defaultTrainStore(): a process the guard does not call a test
      const r = Bun.spawnSync({ cmd: [process.execPath, "--no-env-file", join(REPO_ROOT, "tests/scheduler-merge-reclaim-world.ts")], cwd: REPO_ROOT, env });
      const out = r.stdout.toString().trim().split("\n").at(-1)!;
      expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
      const got = JSON.parse(out);
      expect(core(got)).toEqual({ calls: WITH_DEPLOY, t3: "merged", turns: ["yield", "reclaim"], trainDone: true });
      expect(got.trainLog).toEqual(TRAIN_MERGED); // the train was formed and stepped by the pass's own tick on the default state-dir file
      expect(existsSync(join(root, "state", "merge-train", "p.json"))).toBe(true); // the default file store under the temp state dir
      expect(existsSync(stubLog) ? readFileSync(stubLog, "utf8") : "").toBe(""); // nothing leaked to GitHub or launchd
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("MTR1 full pass: train void / timeout, a merge in flight, a changed head, a paused workflow", () => {
  const intentStatus = (w: ReclaimWorld, id: string) =>
    (w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(w.intentOf(id)) as { status: string } | null)?.status ?? null;

  test("train void (a member's head moved): the tick voids it, the slot holder goes serial, then the lender reclaims before the fresh cards", async () => {
    const w = world();
    try {
      const r = await starvation(w, { between: (i) => { if (i === 0) w.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T2'").run("f".repeat(40)); } });
      expect(core(r)).toEqual({ calls: ["serial-merge:T1", "deploy:T1", "update:T3", "serial-merge:T3", "deploy:T3"], t3: "merged",
        turns: ["yield", "reclaim"], trainDone: true });
      expect(r.trainLog[1]).toContain("作废：T2 已离开合并队列：head 变成 ffffffffffff");
      expect([r.fresh > 0, w.phase("T2"), merges(r.calls)]).toEqual([true, null, ["T1", "T3"]]); // T2 waits for a review of its new head
    } finally { w.close(); }
  });

  test("train past its hold limit while settling: the deploy frees the slot and the lender reclaims it ahead of the member and fresh cards; the gate voids the train", async () => {
    const w = world();
    try {
      const r = await starvation(w, { between: (i) => { if (i === 1) w.store.save({ ...w.store.load("p")!, startedAt: Date.now() - HOLD_LIMIT_MS - 60_000 }); } });
      expect(core(r)).toEqual({ calls: ["match-head:T1", "deploy:T1", "update:T3", "serial-merge:T3", "deploy:T3"], t3: "merged",
        turns: ["yield", "reclaim"], trainDone: true });
      expect(w.events.filter((e) => e.kind === "void").map((e) => e.text)).toEqual([expect.stringContaining("列车超时")]); // the lender's own gate voided it
      expect(r.fresh > 0).toBe(true);
    } finally { w.close(); }
  });

  test("a member's merge in flight when the service stops: the slot stays with it (no reclaim, no cancel); the restart verifies it, its deploy frees the slot, the lender reclaims", async () => {
    const w = world();
    const seen: unknown[] = [];
    try {
      const r = await starvation(w, { between: (i) => {
        if (i === 0) w.hub.stopIn = { name: "T2", merged: true };
        if (w.phase("T2") === "merging") seen.push([w.slot(), w.turns("T3"), intentStatus(w, "T2")]);
      } });
      expect(seen).toEqual([["T2", ["yield"], "submitted"]]);
      expect(core(r)).toEqual({ calls: ["match-head:T1", "deploy:T1", "match-head:T2", "stopped", "deploy:T2", "update:T3", "serial-merge:T3", "deploy:T3"],
        t3: "merged", turns: ["yield", "reclaim"], trainDone: true });
      expect(r.trainLog).toEqual(TRAIN_MERGED);
    } finally { w.close(); }
  });

  test("a merge in flight GitHub never confirms: the run goes unknown and keeps the slot, the queue freezes; the lender is not reclaimed, merged or cancelled", async () => {
    const w = world();
    try {
      const r = await starvation(w, { between: (i) => { if (i === 0) w.hub.stopIn = { name: "T2", merged: false }; } });
      expect(core(r)).toEqual({ calls: ["match-head:T1", "deploy:T1", "stopped"], t3: "unknown", turns: ["yield"], trainDone: false });
      expect([w.slot(), w.phase("T2"), intentStatus(w, "T2"), intentStatus(w, "T3")]).toEqual(["T2", "unknown", "submitted", "submitted"]);
    } finally { w.close(); }
  });

  test("the lender's head changes while it is lent: mergeTick freezes it (old review void), the queue freezes; it is never reclaimed or merged at either head", async () => {
    const w = world();
    try {
      const r = await starvation(w, { between: (i) => { if (i === 0) w.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T3'").run("e".repeat(40)); } });
      expect(core(r)).toEqual({ calls: [], t3: "unknown", turns: ["yield"], trainDone: false });
      expect(w.slot()).toBe("T1"); // the member's merge intent, held by the frozen queue, not taken by the lender
      expect(w.hub.calls.filter((c) => c.endsWith(":T3"))).toEqual([]);
    } finally { w.close(); }
  });

  test("the lender's workflow paused (manual) and resumed: its unsent merge is cancelled, never reclaimed; the members still merge; on resume no automatic re-plan", async () => {
    const w = world();
    try {
      for (const id of ["T1", "T2", "T3"]) w.card(id);
      await w.begin("T3");
      w.hub.pending = true;
      await w.pass();
      w.hub.pending = false;
      w.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T3'").run();
      for (let i = 0; i < 3; i++) await w.pass();
      expect([w.phase("T3"), intentStatus(w, "T3"), w.turns("T3")]).toEqual(["resolved", "cancelled", ["yield"]]);
      w.db.query("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T3'").run();
      for (let i = 0; i < 5; i++) await w.pass();
      expect([w.hub.calls, w.slot(), w.turns("T3"), w.store.load("p")?.phase]).toEqual([["match-head:T1", "deploy:T1", "match-head:T2", "deploy:T2"], null, ["yield"], "done"]);
      const rejected = listEvents(w.db, { project: "p", target: "T3" }).filter((e) => e.data.op === "plan_rejected").map((e) => e.data.reason);
      expect(rejected.at(-1)).toContain("请 PM 手动核对并接管");
    } finally { w.close(); }
  });
});

/** T3 lent its slot to a testing T1+T2 train; then the train is over and the slot free, unless a check says otherwise. */
async function lent(o: Partial<WorldOpts> = {}): Promise<ReclaimWorld & { free(): void }> {
  const w = world(o);
  for (const id of ["T1", "T2", "T3"]) w.card(id);
  await w.begin("T3");
  w.hub.pending = true;
  await w.pass(); // the in-pass train tick forms T1+T2; T3 lends its slot
  expect([w.slot(), w.turns("T3")]).toEqual(["T1", ["yield"]]);
  const free = () => {
    w.db.query("DELETE FROM scheduler_resources WHERE resource='merge:p'").run();
    w.store.save({ ...w.store.load("p")!, phase: "done" });
  };
  return Object.assign(w, { free });
}
const reclaim = (w: ReclaimWorld, store = w.store, manager = w.manager) => reclaimLentSlots(w.db, ["p"], manager, store);
const none = { reclaimed: [], failed: [] };

describe("MTR1 reclaim guards", () => {
  test("a train still holding keeps the slot away; past its limit, or done, it does not", async () => {
    const w = await lent();
    try {
      w.db.query("DELETE FROM scheduler_resources WHERE resource='merge:p'").run();
      expect(await reclaim(w)).toEqual(none); // testing
      w.store.save({ ...w.store.load("p")!, phase: "settling" });
      expect(await reclaim(w)).toEqual(none);
      w.store.save({ ...w.store.load("p")!, startedAt: Date.now() - HOLD_LIMIT_MS - 60_000 });
      expect(await reclaim(w)).toEqual({ reclaimed: ["T3"], failed: [] });
      expect(w.slot()).toBe("T3");
    } finally { w.close(); }
  });

  test("a busy slot (a merge in flight or a fresh plan) is waited for, never taken; no store or an unreadable train file decides nothing", async () => {
    const w = await lent();
    try {
      w.free();
      w.card("F9");
      await w.begin("F9"); // a fresh plan took the free slot first
      expect(await reclaim(w)).toEqual(none);
      expect(w.slot()).toBe("F9");
      w.db.query(`UPDATE scheduler_merges SET phase='merging' WHERE intentId='${w.intentOf("F9")}'`).run(); // its merge is in flight
      expect(await reclaim(w)).toEqual(none);
      expect([w.slot(), w.phase("F9")]).toEqual(["F9", "merging"]);
      w.db.query("DELETE FROM scheduler_resources WHERE resource='merge:p'").run();
      expect(await reclaimLentSlots(w.db, ["p"], w.manager, null)).toEqual(none);
      expect(await reclaim(w, { ...w.store, load: () => { throw new Error("合并列车状态文件损坏"); } })).toEqual(none);
      expect([w.slot(), w.turns("T3")]).toEqual([null, ["yield"]]);
    } finally { w.close(); }
  });

  test("the run must still be valid: manual workflow, changed head, frozen queue, an unknown intent or a run past await_ci is not taken back", async () => {
    const w = await lent();
    try {
      w.free();
      const intent = w.intentOf("T3")!, head = getMergeRun(w.db, intent)!.reviewedHead;
      const checks: [string, string][] = [
        ["UPDATE task_workflows SET mode='manual' WHERE taskId='T3'", "UPDATE task_workflows SET mode='auto' WHERE taskId='T3'"],
        [`UPDATE tasks SET headSHA='${"e".repeat(40)}' WHERE id='T3'`, `UPDATE tasks SET headSHA='${head}' WHERE id='T3'`],
        [`INSERT INTO meta (project,key,value) VALUES ('p','queueFrozen','{"frozen":true,"reason":"x","since":1}')`, "DELETE FROM meta WHERE key='queueFrozen'"],
        [`UPDATE scheduler_intents SET status='unknown' WHERE id='${intent}'`, `UPDATE scheduler_intents SET status='submitted' WHERE id='${intent}'`],
        [`UPDATE scheduler_merges SET phase='merging' WHERE intentId='${intent}'`, `UPDATE scheduler_merges SET phase='ready' WHERE intentId='${intent}'`],
        [`UPDATE scheduler_merges SET phase='updating' WHERE intentId='${intent}'`, `UPDATE scheduler_merges SET phase='ready' WHERE intentId='${intent}'`],
      ];
      for (const [spoil, mend] of checks) {
        w.db.query(spoil).run();
        expect([spoil, await reclaim(w)]).toEqual([spoil, none]);
        expect(w.slot()).toBeNull();
        w.db.query(mend).run();
      }
      expect(await reclaim(w)).toEqual({ reclaimed: ["T3"], failed: [] });
    } finally { w.close(); }
  });

  test("only a run whose latest slot turn is a yield: a run that never lent, or already took it back, is not one", async () => {
    const w = await lent();
    try {
      w.free();
      expect(await reclaim(w)).toEqual({ reclaimed: ["T3"], failed: [] });
      w.db.query("DELETE FROM scheduler_resources WHERE resource='merge:p'").run(); // the slot vanished some other way
      expect(await reclaim(w)).toEqual(none);
      w.card("T4");
      await w.begin("T4"); // holds the slot, never lent it
      w.db.query("DELETE FROM scheduler_resources WHERE resource='merge:p'").run();
      expect(await reclaim(w)).toEqual(none);
    } finally { w.close(); }
  });

  test("one at a time, in the order the runs entered the merge queue; the next lender waits until the first one settles", async () => {
    const w = await lent();
    try {
      w.free();
      w.card("T4");
      const t4 = await w.begin("T4");
      w.db.query(`UPDATE scheduler_intents SET eventSeq = 9 WHERE id = '${t4}'`).run(); // T3 (seq 2) entered first
      expect((await w.manager("ledger", "scheduler-merge-step", t4, "--from", "ready", "--to", "ready", "--rev", String(getMergeRun(w.db, t4)!.rev),
        "--receipt", `${SLOT_YIELD}x`)).ok).toBe(true);
      expect(await reclaim(w)).toEqual({ reclaimed: ["T3"], failed: [] });
      expect(await reclaim(w)).toEqual(none);
      await w.manager("ledger", "scheduler-settle", w.intentOf("T3")!, "--from", "submitted", "--to", "cancelled", "--receipt", "test");
      expect(await reclaim(w)).toEqual({ reclaimed: ["T4"], failed: [] });
    } finally { w.close(); }
  });

  test("two reclaim steps racing for one free slot: the ledger CAS lets exactly one win, the loser waits without a failure", async () => {
    const w = await lent();
    try {
      w.free();
      const slow = async (...a: string[]) => { await Bun.sleep(10); return w.manager(...a); };
      const [a, b] = await Promise.all([reclaim(w, w.store, slow), reclaim(w, w.store, slow)]);
      expect([...a.reclaimed, ...b.reclaimed]).toEqual(["T3"]);
      expect([...a.failed, ...b.failed]).toEqual([]);
      expect([w.slot(), w.turns("T3")]).toEqual(["T3", ["yield", "reclaim"]]);
    } finally { w.close(); }
  });
});
