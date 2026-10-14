/**
 * dispatch-recovery-PRIVSTART1 wiring (验收线 5): privateStartPlacement observe's record goes out through the scheduler's start hook
 * (scheduler-autostart-deps.ts flushReviewLocal), as the scheduler identity's `ledger scheduler-recovery-observe` on a real temp ledger.
 * The production policy reader (no recovery-policy entry = observe) and the real startPlacement queue it; one note per card and spec
 * revision; a refused start (等 either way, PM 10:5x) queues and writes nothing; a record whose card never appears is dropped, not retried forever.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { listEvents } from "../src/lib/ledger-store.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { resetReviewLocalObserved } from "../src/lib/scheduler-agent-pool-review-local.js";
import { resetWriteLocalObserved } from "../src/lib/scheduler-agent-pool-write-local.js";
import { autostartHooks } from "../src/lib/scheduler-autostart-deps.js";
import type { RemotePolicy, SchedulerConfig } from "../src/lib/scheduler-config.js";
import { privateStartPending, resetPrivateStartObserved, startPlacement } from "../src/lib/scheduler-placement-start.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const PRIV = ["repo:o/priv/src/a.ts"];
const remote: RemotePolicy = { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15, localPriority: "first" };
const config = { enabled: false, autoDispatch: false, projects: {} } as unknown as SchedulerConfig;
const pace = { yieldNow: () => false, cursor: {} };

const reset = () => { resetPrivateStartObserved(); resetWriteLocalObserved(); resetReviewLocalObserved(); rmSync(RECOVERY_POLICY_PATH, { force: true }); };
beforeEach(reset);
afterEach(reset);

test("observe 经生产 start hook 写出一条观察；同卡同规格版本重复算不重复记；卡始终没建的观察丢掉", async () => {
  const f = autoFixture();
  try {
    // no peer at all: this machine has room, so the start stays local; peers only would wait
    const place = (card: string) => startPlacement(f.db, { policy: () => ({ remote, maxWorkers: 2 }), borrow: async (): Promise<BorrowEntry[]> => [],
      originRepo: async () => "o/priv", now: () => 1000 }, { project: "p", repoDir: "/r", fileGlobs: PRIV, want: "auto", card }, true);
    expect(await place("T1")).toMatchObject({ where: "local" });
    expect(await place("p-never")).toMatchObject({ where: "local" });
    expect(privateStartPending()).toHaveLength(2);

    const calls: string[][] = [];
    const ledger = async (...args: string[]) => { calls.push(args); return f.cli("scheduler", ...args.slice(1)); };
    const hooks = autostartHooks({ db: f.db, ledger, active: () => {}, lease: undefined });
    await hooks.start(config, pace);
    await place("T1"); // the next tick computes the same card again
    await hooks.start(config, pace);
    await hooks.start(config, pace);

    const notes = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.actor).toBe("scheduler");
    expect(notes[0]!.data).toMatchObject({ mechanism: "privateStartPlacement" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 7)).toEqual(["ledger", "scheduler-recovery-observe", "T1", "--mechanism", "privateStartPlacement", "--action-key", "private-start:s1"]);
    expect(calls[0]![8]).toStartWith("私仓卡只放 peer 时放到 等（现在放 local）");
    expect(privateStartPending()).toEqual([]); // p-never: card never created, dropped after two drains

    // a new spec revision is a new record
    f.db.run("UPDATE tasks SET specRev = 2 WHERE id = 'T1'");
    await place("T1");
    await hooks.start(config, pace);
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe")).toHaveLength(2);
    expect(calls.map((c) => c[6])).toEqual(["private-start:s1", "private-start:s2"]);
  } finally { f.close(); }
});

test("台账写口拒（busy）：观察留在队里，下一轮再写", async () => {
  const f = autoFixture();
  try {
    await startPlacement(f.db, { policy: () => ({ remote, maxWorkers: 2 }), borrow: async (): Promise<BorrowEntry[]> => [], originRepo: async () => "o/priv",
      now: () => 1000 }, { project: "p", repoDir: "/r", fileGlobs: PRIV, want: "auto", card: "T1" }, true);
    let ok = false;
    const ledger = async (...args: string[]) => (ok ? f.cli("scheduler", ...args.slice(1)) : { ok: false, error: "busy" });
    const hooks = autostartHooks({ db: f.db, ledger, active: () => {}, lease: undefined });
    await hooks.start(config, pace);
    expect(privateStartPending()).toHaveLength(1);
    ok = true;
    await hooks.start(config, pace);
    expect(privateStartPending()).toEqual([]);
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe")).toHaveLength(1);
  } finally { f.close(); }
});

test("observe：实际放置为「等」（refused、没建卡）时不排、不写任何观察，也不报错", async () => {
  const f = autoFixture();
  try {
    const off: RemotePolicy = { ...remote, localPriority: "off" };
    const placed = await startPlacement(f.db, { policy: () => ({ remote: off, maxWorkers: 0 }), borrow: async (): Promise<BorrowEntry[]> => [],
      originRepo: async () => "o/priv", now: () => 1000 }, { project: "p", repoDir: "/r", fileGlobs: PRIV, want: "auto", card: "future-private-card" }, true);
    expect(placed).toMatchObject({ where: "refused" });
    expect(privateStartPending()).toEqual([]);
    const calls: string[][] = [];
    const ledger = async (...args: string[]) => { calls.push(args); return f.cli("scheduler", ...args.slice(1)); };
    const hooks = autostartHooks({ db: f.db, ledger, active: () => {}, lease: undefined });
    await hooks.start(config, pace);
    await hooks.start(config, pace);
    expect(calls).toEqual([]);
    expect(listEvents(f.db, { project: "p", target: "future-private-card" })).toEqual([]);
  } finally { f.close(); }
});
