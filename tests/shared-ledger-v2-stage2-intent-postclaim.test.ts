import { describe, expect, spyOn, test } from "bun:test";
import * as wiring from "../src/lib/scheduler-model-wiring.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { configureSchedulerV2Intents, withSchedulerV2Intents, type SchedulerV2IntentRoute } from "../src/lib/scheduler-v2-intent.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

/**
 * Real schedulerAutoTick dispatching a review on a route=local card: the claim (pending→submitted) succeeds while local, then
 * the driver awaits refusalLapse (a dynamic import + reviewMaterialCheck) before the send. The route moves to skip / central in
 * that window — only the original reviewMaterialCheck is wrapped, to flip the route once the review intent is submitted.
 */
describe("S2I route recheck at the send, after the claim (real schedulerAutoTick)", () => {
  for (const to of ["skip", "central"] as const) {
    test(`local review card switched to ${to} after the claim, during refusalLapse: zero sends, zero center requests`, async () => {
      const f = autoFixture(), c = intentCenter(), observed: string[] = [];
      let route: SchedulerV2IntentRoute = "local";
      const real = wiring.reviewMaterialCheck;
      const spy = spyOn(wiring, "reviewMaterialCheck").mockImplementation((db) => {
        if (f.intents().some((i) => i.action === "review" && i.status === "submitted")) route = to;
        return real(db);
      });
      try {
        await toBuild(f);
        await f.tick(); // write order sent
        await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
        await f.tick(); // ensure reviewer
        const sends = f.sent.length;
        configureSchedulerV2Intents({ route: () => route, wrapManager: (m) => m, central: c.bound as never, observe: (_id, code) => { observed.push(code); } });
        const r = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, withSchedulerV2Intents(f.tickDeps));
        expect(r.failed).toEqual([]);
        expect(route as SchedulerV2IntentRoute).toBe(to); // the flip did happen after the claim
        expect(f.sent).toHaveLength(sends);
        expect(r.cards[0]).not.toMatchObject({ step: "sent" });
        expect(f.intents().at(-1)).toMatchObject({ action: "review", status: "cancelled" });
        expect(c.calls).toHaveLength(0);
        expect(observed).toContain(to === "skip" ? "skip" : "route_changed");
      } finally { spy.mockRestore(); configureSchedulerV2Intents(null); f.close(); }
    });
  }
});
