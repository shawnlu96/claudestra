import { describe, expect, test } from "bun:test";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { configureSchedulerV2Intents, withSchedulerV2Intents, type SchedulerV2IntentRoute } from "../src/lib/scheduler-v2-intent.js";
import type { WorkerSession } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

/**
 * Real schedulerAutoTick dispatching a review on a route=local card: the worker handed out is the original object (验收线 5),
 * and the route moves to skip / central while the claim (pending→submitted) is being written, or right after it (the driver's
 * refusalLapse awaits before the send). The send guard refuses; the driver cancels the claim (未投递) through S2Q.
 */
describe("S2I route recheck at the send (real schedulerAutoTick, original local worker)", () => {
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
        const original = (ref: Parameters<typeof f.tickDeps.worker>[0]) => {
          const key = `${ref.taskId}:${ref.role}:${ref.sessionId}`;
          if (!originals.has(key)) originals.set(key, f.tickDeps.worker(ref));
          return originals.get(key)!;
        };
        const deps = withSchedulerV2Intents({ ...f.tickDeps, worker: original });
        const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, { ...deps, worker: (ref) => {
          const w = deps.worker(ref);
          if (!("manual" in w)) { expect(w).toBe(original(ref) as WorkerSession); handed.push(w); }
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
});
