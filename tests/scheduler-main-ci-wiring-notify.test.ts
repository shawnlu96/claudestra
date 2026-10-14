/**
 * MAINCIW [验收线 5] PM notices (claimed in the ledger first, once per main / per hour, never to the owner) and [验收线 6] the mainCiPause
 * switch (observe = old scheduling plus one note per (mainSha, state); off = no read at all), through the real pass.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { mainCiWorld, writePolicy, type MainCiWorld } from "./scheduler-main-ci-wiring-world.test.ts";

let w: MainCiWorld, saved: string | null;
const opened: MainCiWorld[] = [];
beforeEach(() => { saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH, "utf8") : null; w = mainCiWorld(); opened.push(w); });
afterEach(() => {
  for (const x of opened.splice(0)) x.close();
  if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true }); else writeFileSync(RECOVERY_POLICY_PATH, saved);
});

const MIN = 60_000;
const passes = async (x: MainCiWorld, n: number) => { const out: string[] = []; for (let i = 0; i < n; i++) out.push(...await x.pass()); return out; };
const observations = (x: MainCiWorld) => x.db.query(`SELECT text FROM events WHERE kind='note' AND json_extract(data,'$.op')='recovery_observe'
  AND json_extract(data,'$.mechanism')='mainCiPause'`).all() as { text: string }[];
const ownerAsks = (x: MainCiWorld) => (x.db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n;

describe("[验收线 5] notices to the project PM only, claimed before they are sent", () => {
  test("one red main = one notice: more passes, a restart and two concurrent passes never resend", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1"); w.card("T2");
    const x = w.hub.main;
    w.ci.bySha.set(x, "failure");
    await passes(w, 3);
    w.restart();
    await passes(w, 2);
    expect(w.notices).toHaveLength(1);
    const text = w.notices[0]!;
    expect(text).toStartWith("p: [主线 CI]");
    for (const part of [x.slice(0, 12), "check=failure", "ledger main-ci status --project p", "ledger main-ci-repair <卡> --head"]) expect(text).toContain(part);
    expect(ownerAsks(w)).toBe(0);
  });

  test("two processes racing on the same red main: exactly one claim, one notice", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    w.ci.bySha.set(w.hub.main, "failure");
    const other = new LedgerReader(w.path);
    try { await Promise.all([w.pass(), w.pass({ reader: other })]); } finally { other.close(); }
    expect(w.notices).toHaveLength(1);
    expect(w.db.query("SELECT COUNT(*) AS n FROM events WHERE dedupKey LIKE 'main-ci-notify:%'").get()).toEqual({ n: 1 });
  });

  test("read failures: nothing before 15 minutes, one at 15, then at most one an hour (fake clock)", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    w.ci.fail = true;
    const at = async (mins: number) => { w.clock.now += mins * MIN; await w.pass(); return w.notices.length; };
    expect(await at(0)).toBe(0);
    expect(await at(14)).toBe(0);
    expect(await at(2)).toBe(1);   // 16 min
    expect(await at(30)).toBe(1);  // 46 min
    expect(await at(20)).toBe(1);  // 66 min: same hourly window
    expect(await at(15)).toBe(2);  // 81 min: next window
    expect(w.notices[1]).toContain("持续读不到");
    expect(ownerAsks(w)).toBe(0);
  });

  test("a completed read resets the failure clock", async () => {
    writePolicy({ mainCiPause: "on" });
    w.card("T1");
    w.ci.fail = true;
    await w.pass();
    w.clock.now += 10 * MIN; w.ci.fail = false; await w.pass();
    w.clock.now += 10 * MIN; w.ci.fail = true; await w.pass();
    w.clock.now += 10 * MIN; await w.pass();
    expect(w.notices).toHaveLength(0);
  });
});

describe("[验收线 6] mainCiPause switch", () => {
  const scenario = async (x: MainCiWorld, mode: RecoveryMode) => {
    writePolicy({ mainCiPause: mode });
    x.card("T1"); x.card("T2");
    x.ci.bySha.set(x.hub.main, "failure");
    x.hub.pending = true;
    const calls = await passes(x, 2);
    x.hub.pending = false;
    calls.push(...await passes(x, 6));
    const s = x.store.load("p");
    const phases = (x.db.query("SELECT taskId, phase FROM scheduler_merges ORDER BY taskId, createdAt").all() as unknown[]);
    return { calls, train: s && { phase: s.phase, outcome: s.outcome, members: s.members.map((m) => m.taskId) }, phases, events: x.events.map((e) => e.kind) };
  };

  test("observe is the old scheduling verbatim, plus exactly one 本会暂停 note per (mainSha, state) and the PM notice", async () => {
    const a = await scenario(w, "observe");
    expect(observations(w)).toHaveLength(1);
    expect(observations(w)[0]!.text).toContain("本会 暂停：");
    expect(w.notices).toHaveLength(1);
    expect(w.notices[0]).toContain("观察期");
    w.restart();
    await passes(w, 2);
    expect(observations(w)).toHaveLength(1); // replay never duplicates
    const off = mainCiWorld(); opened.push(off); // the fixture's gh / clock ports are per process: the observe world is done reading
    expect(await scenario(off, "off")).toEqual(a);
  });

  test("observe's notice is only recorded, so switching to on for the same red main still sends the pause notice once", async () => {
    writePolicy({ mainCiPause: "observe" });
    w.card("T1");
    const red = w.hub.main;
    w.ci.bySha.set(red, "failure");
    w.hub.pending = true; // 卡的 CI 还没出结果：observe 照旧调度，但这两轮合不进 main
    await passes(w, 2);
    expect(w.notices).toHaveLength(1);
    writePolicy({ mainCiPause: "on" });
    await passes(w, 3);
    expect(w.hub.main).toBe(red);
    expect(w.notices).toHaveLength(2);
    expect(w.notices[1]).not.toContain("观察期");
  });

  test("off: zero main / check reads, zero notes, zero notices", async () => {
    await scenario(w, "off");
    expect(w.ci.reads).toEqual([]);
    expect(observations(w)).toEqual([]);
    expect(w.notices).toEqual([]);
  });

  test("mergeUnsentCancel off does not matter: mainCiPause on still cancels unsent without freezing", async () => {
    writePolicy({ mainCiPause: "on", mergeUnsentCancel: "off" });
    w.card("T1");
    const intent = await w.begin("T1");
    w.ci.bySha.set(w.hub.main, "failure");
    await w.pass();
    expect((w.db.query("SELECT status FROM scheduler_intents WHERE id=?").get(intent) as { status: string }).status).toBe("cancelled");
    expect(w.taskEvents("T1").filter((e) => e.data.op === "merge_unsent_cancel").at(-1)!.data).toMatchObject({ counted: false, cause: "main_ci_pause" });
    expect(w.frozen()).toBe(false);
  });
});
