/** Absolute wall-clock caps, opt-in like scrub-perf-profile: a loaded CI shard must not turn a scrub regression check red. */
import { expect, test } from "bun:test";
import { scrub, SCRUB_PERF_CASES, scrubPerfPayload } from "./scrub-perf-fixture.test.ts";

for (const c of SCRUB_PERF_CASES) {
  test.skipIf(!process.env.SCRUB_PERF_PROFILE)(`${c.name} scrub within ${c.capMs} ms`, () => {
    const payload = scrubPerfPayload(c.strings());
    const started = performance.now();
    expect(scrub(payload)).toBe(c.verdict);
    const ms = performance.now() - started;
    console.log(JSON.stringify({ benchmark: c.name, ms: +ms.toFixed(2), capMs: c.capMs }));
    expect(ms).toBeLessThanOrEqual(c.capMs);
  }, 60_000);
}
