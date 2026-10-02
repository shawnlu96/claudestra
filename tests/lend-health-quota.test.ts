import { afterEach, expect, test } from "bun:test";
import { pausedUntil, PAUSE_FALLBACK_MS, quotaViewOf } from "../src/lib/lend-health.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { harness } from "./lend-harness.js";
const journals: ReturnType<typeof harness>[] = [];
function setup() { const h = harness(); journals.push(h); return h; }
afterEach(() => { for (const h of journals.splice(0)) h.db.close(); });
test("known-full observation prevents polling and claiming before reset, then expires", async () => {
  const h = setup();
  const until = h.d.now() + 60_000;
  h.health.quota = quotaViewOf({ status: "known", source: "live", observedAt: h.d.now(), plan: null, reason: null,
    windows: [{ id: "week", kind: "week", usedPct: 100, resetsAtMs: until, resetPassed: false }] });
  await h.tick();
  expect(pausedUntil(h.db, h.d.now())).toBe(until);
  expect(h.calls).toEqual([]);
  h.advanceTime(60_000);
  await h.tick();
  expect(pausedUntil(h.db, h.d.now())).toBeNull();
  expect(h.ops()).toContain("poll");
  await h.tick();
  expect(getOrder(h.db, "o1")?.state).toBe("claimed");
});
for (const full of [null, false]) test(`observation full=${full} does not pause`, async () => {
  const h = setup();
  h.health.quota = { full, observedAt: h.d.now(), resetsAt: null };
  await h.tick();
  expect(pausedUntil(h.db, h.d.now())).toBeNull();
  expect(h.ops()).toContain("poll");
});
test("missing or unreadable quota is unknown", async () => {
  const h = setup();
  h.d.codexQuota = async () => { throw new Error("fixture read failure"); };
  await h.tick();
  expect(pausedUntil(h.db, h.d.now())).toBeNull();
  expect(h.ops()).toContain("poll");
  expect(h.log.lines.some((s) => s.includes("fixture read failure"))).toBe(true);
});
test("no-reset full reading uses fallback without sliding the existing deadline", async () => {
  const h = setup();
  h.health.quota = { full: true, observedAt: h.d.now(), resetsAt: null };
  const until = h.d.now() + PAUSE_FALLBACK_MS;
  await h.tick();
  h.advanceTime(1000);
  await h.tick();
  expect(pausedUntil(h.db, h.d.now())).toBe(until);
});
test("full observation blocks an already admitted order before claim", async () => {
  const h = setup();
  await h.tick();
  expect(getOrder(h.db, "o1")?.state).toBe("asked");
  h.health.quota = { full: true, observedAt: h.d.now(), resetsAt: h.d.now() + 60_000 };
  await h.tick();
  expect(h.ops()).not.toContain("claim");
  expect(getOrder(h.db, "o1")?.state).toBe("asked");
  h.advanceTime(1000);
  h.health.quota = { full: false, observedAt: h.d.now(), resetsAt: null };
  await h.tick();
  expect(pausedUntil(h.db, h.d.now())).toBeNull();
  expect(getOrder(h.db, "o1")?.state).toBe("claimed");
});
