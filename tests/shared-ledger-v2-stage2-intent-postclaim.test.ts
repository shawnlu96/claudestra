import { describe, expect, test } from "bun:test";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { configureSchedulerV2Intents, withSchedulerV2Intents } from "../src/lib/scheduler-v2-intent.js";
import type { WorkerSession } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

/**
 * Real schedulerAutoTick dispatching a review on a route=local card whose worker is frozen: S2I hands out that very object
 * (验收线 5: object equality, no copy, no member replaced), the review goes out through it once and the center sees nothing.
 */
describe("S2I route=local pass-through with an immutable worker (real schedulerAutoTick)", () => {
  test("frozen local worker: same object handed out, one send, zero center requests", async () => {
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
        const w = deps.worker(ref);
        if (!("manual" in w)) { expect(w).toBe(original(ref) as WorkerSession); expect(Object.isFrozen(w)).toBe(true); handed.push(w); }
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
