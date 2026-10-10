import { describe, expect, test } from "bun:test";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { configureSchedulerV2Intents, withSchedulerV2Intents, type SchedulerV2IntentRoute } from "../src/lib/scheduler-v2-intent.js";
import type { WorkerSession } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

/**
 * Real schedulerAutoTick dispatching a review on a route=local card: the worker handed out forwards to the original, which is
 * never modified (验收线 5 as revised by PM 定 10-10),
 * and the route moves to skip / central while the claim (pending→submitted) is being written, or right after it (the driver's
 * refusalLapse awaits before the send). The send guard refuses; the driver cancels the claim (未投递) through S2Q.
 */
describe("S2I route recheck at the send (real schedulerAutoTick, forwarding local worker)", () => {
  for (const [to, when] of [["skip", "during"], ["central", "during"], ["skip", "after"], ["central", "after"]] as const) {
    test(`local review card switched to ${to} ${when} the claim: zero sends, zero center requests`, async () => {
      const f = autoFixture(), c = intentCenter(), observed: string[] = [];
      let route: SchedulerV2IntentRoute = "local";
      try {
        await toBuild(f);
        await f.tick(); // write order sent
        await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
        await f.tick(); // ensure reviewer
        const sends = f.sent.length;
        configureSchedulerV2Intents({ route: () => route, central: c.bound as never, observe: (_id, code) => { observed.push(code); },
          wrapManager: (m) => async (...args) => {
            const claim = args[4] === "pending" && args[6] === "submitted";
            if (claim && when === "during") route = to;
            const r = await m(...args);
            if (claim && when === "after") route = to;
            return r;
          } });
        const originals = new Map<string, ReturnType<typeof f.tickDeps.worker>>(), handed: WorkerSession[] = [];
        const submits = new Map<WorkerSession, WorkerSession["submit"]>();
        const original = (ref: Parameters<typeof f.tickDeps.worker>[0]) => {
          const key = `${ref.taskId}:${ref.role}:${ref.sessionId}`;
          if (!originals.has(key)) { const w = f.tickDeps.worker(ref); originals.set(key, w); if (!("manual" in w)) submits.set(w, w.submit); }
          return originals.get(key)!;
        };
        const deps = withSchedulerV2Intents({ ...f.tickDeps, worker: original });
        const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...deps, worker: (ref) => {
          const w = deps.worker(ref);
          if (!("manual" in w)) {
            const o = original(ref) as WorkerSession;
            expect(w).not.toBe(o); // 验收线 5 (PM 定 10-10): a forwarding object, the original untouched
            expect(o.submit).toBe(submits.get(o)!);
            handed.push(w);
          }
          return w;
        } });
        expect(r.failed).toEqual([]);
        expect(handed.length).toBeGreaterThan(0);
        expect(route as SchedulerV2IntentRoute).toBe(to); // the flip did happen at the claim
        expect(f.sent).toHaveLength(sends);
        expect(r.cards[0]).not.toMatchObject({ step: "sent" });
        expect(f.intents().at(-1)).toMatchObject({ action: "review", status: "cancelled" });
        expect(c.calls).toHaveLength(0);
        expect(observed).toContain(to === "skip" ? "skip" : "route_changed");
      } finally { configureSchedulerV2Intents(null); f.close(); }
    });
  }

  test("frozen local worker that stays local: original still frozen, same submit, one send, zero center requests", async () => {
    const f = autoFixture(), c = intentCenter(), wrapped: unknown[] = [];
    try {
      await toBuild(f);
      await f.tick(); // write order sent
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      await f.tick(); // ensure reviewer
      const sends = f.sent.length;
      configureSchedulerV2Intents({ route: () => "local", central: c.bound as never, wrapManager: (m) => { wrapped.push(m); return m; } });
      const originals = new Map<string, ReturnType<typeof f.tickDeps.worker>>(), handed: WorkerSession[] = [];
      const original = (ref: Parameters<typeof f.tickDeps.worker>[0]) => {
        const key = `${ref.taskId}:${ref.role}:${ref.sessionId}`;
        if (!originals.has(key)) originals.set(key, Object.freeze(f.tickDeps.worker(ref)));
        return originals.get(key)!;
      };
      const deps = withSchedulerV2Intents({ ...f.tickDeps, worker: original });
      const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...deps, worker: (ref) => {
        const o = original(ref), submit = "manual" in o ? null : o.submit, w = deps.worker(ref);
        if (!("manual" in w)) { expect(Object.isFrozen(o)).toBe(true); expect((o as WorkerSession).submit).toBe(submit!); handed.push(w); }
        return w;
      } });
      expect(r.failed).toEqual([]);
      expect(handed.length).toBeGreaterThan(0);
      expect(wrapped).toHaveLength(1);
      expect(f.sent).toHaveLength(sends + 1);
      expect(f.intents().at(-1)).toMatchObject({ action: "review", status: "done" });
      expect(c.calls).toHaveLength(0);
    } finally { configureSchedulerV2Intents(null); f.close(); }
  });
});
