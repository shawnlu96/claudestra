/**
 * T68f r3 P1 (T68f-r3-adv.md): the real scheduler daemon runs merge + observe + auto under the one maintenance lease that
 * update also takes. Each case starts `src/scheduler.ts` in a private state dir with a stub bridge on a free port, so a
 * dispatch can only ever reach the stub; the ledger is the daemon's own, written through the real ledger CLI.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { acquireLock } from "../src/lib/file-lock.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import { cleanupDaemons, dispatched, intents, setup, start, until, type Svc } from "./scheduler-daemon-harness.js";

afterEach(cleanupDaemons);

describe("the scheduler daemon's whole pass lives under the maintenance lease", () => {
  test("while update holds the lease an auto card gets no session, no plan and no order; once released it is driven", async () => {
    const s = setup(["T1"]);
    const update = await acquireLock(s.lockPath, 0);
    expect(update).not.toBeNull();
    start(s);
    await Bun.sleep(3500);
    expect(update!.held()).toBe(true);
    expect(s.frames).toEqual([]);
    expect(intents(s)).toEqual([]);
    update!.release();
    expect(await until(() => dispatched(s).length > 0, 20_000)).toBe(true);
    expect(dispatched(s)[0]).toMatchObject({ targetName: "agent-task-0" });
  }, 40_000);

  test("losing the lease mid-submit ends the pass: the next card is not dispatched and the daemon stops", async () => {
    const s = setup(["T1", "T2"]);
    s.onDispatch = async () => {
      writeFileSync(join(s.lockPath, "owner"), "update-took-over");
      await Bun.sleep(300);
    };
    start(s);
    expect(await until(() => dispatched(s).length > 0, 20_000)).toBe(true);
    expect(await until(() => s.child!.exitCode !== null, 10_000)).toBe(true);
    expect(dispatched(s)).toHaveLength(1);
    const first = dispatched(s)[0].targetName === "agent-task-0" ? "T1" : "T2";
    expect(intents(s).filter((i) => i.taskId !== first && i.action === "dispatch")).toEqual([]);
  }, 40_000);

  test("a stop signal mid-submit ends the pass the same way", async () => {
    const s = setup(["T1", "T2"]);
    s.onDispatch = async () => {
      s.child!.kill("SIGTERM");
      await Bun.sleep(300);
    };
    start(s);
    expect(await until(() => dispatched(s).length > 0, 20_000)).toBe(true);
    expect(await until(() => s.child!.exitCode !== null, 10_000)).toBe(true);
    expect(dispatched(s)).toHaveLength(1);
    const first = dispatched(s)[0].targetName === "agent-task-0" ? "T1" : "T2";
    expect(intents(s).filter((i) => i.taskId !== first && i.action === "dispatch")).toEqual([]);
    expect(await s.stderr).toBe("");
  }, 40_000);

  // T68f r4 P1-1: the check sits inside the bridge client's onopen, right before the frame; one per source of "stopped"
  const STOPS: Record<string, (s: Svc) => void> = {
    "maintenance lease taken over": (s) => writeFileSync(join(s.lockPath, "owner"), "update-took-over"),
    "SIGTERM": (s) => { s.child!.kill("SIGTERM"); },
    "scheduler.pid taken over": (s) => writeFileSync(join(s.state, "scheduler.pid", "owner"), "another-scheduler"),
  };

  /** Stops the service once, while the first WebSocket (an order or a PM notice) is still in its handshake. */
  async function stopDuringHandshake(s: Svc, stop: (s: Svc) => void): Promise<void> {
    let stopped = false;
    s.onUpgrade = async () => {
      if (stopped) return;
      stopped = true;
      expect(s.frames).toEqual([]);
      stop(s);
      await Bun.sleep(300);
    };
    start(s);
    expect(await until(() => stopped, 20_000)).toBe(true);
    expect(await until(() => s.child!.exitCode !== null, 10_000)).toBe(true);
    expect(s.frames).toEqual([]);
  }

  for (const [name, stop] of Object.entries(STOPS)) {
    test(`stopped during an order's handshake (${name}): the frame is never sent, the next card is not dispatched`, async () => {
      const s = setup(["T1", "T2"]);
      await stopDuringHandshake(s, stop);
      expect(intents(s).filter((i) => i.taskId === "T2" && i.action === "dispatch")).toEqual([]);
    }, 40_000);
  }

  test("stopped during the PM notice's handshake: the notice is never sent", async () => {
    const s = setup(["T1"], { ghost: true });
    await stopDuringHandshake(s, STOPS["maintenance lease taken over"]);
    expect(intents(s)).toEqual([expect.objectContaining({ taskId: "T1", action: "ensure_session", status: "cancelled" })]);
  }, 40_000);

  // T68f r6: auto dispatch is off by default until T68h; merge and observe still run
  test("with autoDispatch absent the real daemon drives no auto card: no session, no plan, no order", async () => {
    const s = setup(["T1"], { autoDispatch: false });
    start(s);
    await Bun.sleep(3500);
    expect(s.child!.exitCode).toBeNull();
    expect(s.frames).toEqual([]);
    expect(intents(s)).toEqual([]);
  }, 40_000);

  test("a pass with autoDispatch off never builds or calls the auto deps; with it on they are built once", async () => {
    const s = setup([]), db = openLedger(join(s.state, "ledger.sqlite"));
    try {
      let built = 0;
      const opts = { assertOwner: () => {}, maintenance: { path: s.lockPath, marker: join(s.state, "update.marker") },
        autoDeps: () => { built++; return {} as AutoTickDeps; } };
      const config = { enabled: true, pollMs: 1000, projects: {} };
      expect(await schedulerPass(db, { ...config, autoDispatch: false }, opts)).toEqual({ ran: true, failed: [] });
      expect(built).toBe(0);
      await schedulerPass(db, { ...config, autoDispatch: true }, opts);
      expect(built).toBe(1);
    } finally { closeLedger(join(s.state, "ledger.sqlite")); }
  });
});
