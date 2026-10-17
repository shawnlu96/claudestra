/** Reset → real scheduler snapshot → quota-line cache → GET view, with fake upstream and temporary files only. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleQuotaApi, makeQuotaApi } from "../src/bridge/local-api/quota.js";
import { makeLendQuotaLinesApi } from "../src/bridge/local-api/lend-quota-lines.js";
import { createQuotaService, setQuotaServiceForTest } from "../src/bridge/quota-service.js";
import * as inventory from "../src/lib/ai-quota.js";
import { readInventoryQuota } from "../src/lib/ai-quota.js";
import * as facts from "../src/lib/lend-quota-line-facts.js";
import { effectivePrincipal } from "../src/lib/devices.js";
import { codexUsageBody, fakePost, jsonResponse, okRoutes, T0 } from "./quota-fixtures.js";
import { harness } from "./quota-scheduler-harness.js";

const readActualInventory = readInventoryQuota;
const child = process.env.QRS_FACTS_FIXTURE === "1";
const fixtureTest = test.skipIf(!child);
const dirs: string[] = [];
let restore = () => {};
afterEach(() => restore());
test.skipIf(child)("isolated reset → quota-lines with the real inventory cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "qrs-cache-"));
  try {
    const run = Bun.spawnSync([process.execPath, "test", import.meta.filename], {
      env: { ...process.env, QRS_FACTS_FIXTURE: "1", CLAUDESTRA_STATE_DIR: dir },
      stdout: "pipe", stderr: "pipe",
    });
    const output = Buffer.concat([run.stdout, run.stderr]).toString();
    if (run.exitCode !== 0) console.error(output);
    expect(run.exitCode).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
afterEach(() => {
  setQuotaServiceForTest(null);
  facts.resetQuotaFactsForTest();
  if (child) rmSync(facts.QUOTA_LINE_FACTS_PATH, { force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const owner = effectivePrincipal({
  principal: { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01" },
  credential: { id: "d", v: 1, type: "bearer", hash: "h", deviceName: "fixture", createdAt: "2026-01-01", expiresAt: "2099-01-01",
    grant: { agents: ["*"], manage: true, terminal: true } },
});

async function setup(code = "reset") {
  const dir = mkdtempSync(join(tmpdir(), "qrs-reset-"));
  dirs.push(dir);
  let posted = false, reads = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => h.now);
  const h = harness((url) => {
    if (!url.endsWith("/wham/usage")) return okRoutes(url);
    return jsonResponse(200, codexUsageBody({
      rate_limit_reset_credits: { available_count: 1, applicable_available_count: posted ? 0 : 1 },
      rate_limit: { allowed: posted, limit_reached: !posted,
        secondary_window: { used_percent: posted ? 0 : 100, limit_window_seconds: 604800, reset_at: (T0 + 86400_000) / 1000 } },
    }));
  }, undefined, fakePost(() => {
    posted = code === "reset" || code === "already_redeemed";
    h.advance(10); // reset happens before the post-consume usage observation
    return code === "timeout" ? jsonResponse(500, {}) : jsonResponse(200, { code, windows_reset: posted ? 1 : 0 });
  }));
  const svc = createQuotaService({
    now: () => h.now, makeScheduler: () => h.scheduler, readEnabled: () => true, writeEnabled: async () => {},
    local: async () => ({ claudeCache: null, codexRollout: null, extra: [] }), afterTick: async () => {},
    setTimer: () => 0, clearTimer: () => {},
  });
  setQuotaServiceForTest(svc);
  await svc.retry("codex");
  const read = spyOn(inventory, "readInventoryQuota").mockImplementation(() => {
    reads++;
    return readActualInventory({ now: h.now, enabled: () => true, loadState: h.store.load, claudeCache: () => null, codexRollout: async () => null });
  });
  restore = () => { read.mockRestore(); clock.mockRestore(); };
  await facts.refreshQuotaFacts(h.now);
  const api = makeLendQuotaLinesApi({
    linesPath: join(dir, "lines.json"), lendPath: join(dir, "lend.json"), now: () => h.now,
    facts: (now) => facts.refreshQuotaFacts(now), context: async () => ({ contacts: [], projects: [] }), actual: () => [],
  });
  const view = async () => {
    const r = await api(new Request("http://fixture/lend/quota-lines"), "/lend/quota-lines", owner);
    const body = await r!.json() as { families: { family: string; weekUsedPct: number; observedAt: number; state: string }[] };
    return body.families.find((f) => f.family === "codex")!;
  };
  const reset = (refresh?: () => Promise<unknown>) => (refresh ? makeQuotaApi(refresh) : handleQuotaApi)(
    new Request("http://fixture/quota/codex/reset-credit", { method: "POST", body: "{}" }),
    "/quota/codex/reset-credit", owner,
  );
  return { reset, view, reads: () => reads, h };
}

for (const code of ["reset", "already_redeemed"]) {
  fixtureTest(`${code}: quota-lines changes from 100% stop to 0% immediately with a post-reset observedAt`, async () => {
    const s = await setup(code);
    expect(await s.view()).toMatchObject({ weekUsedPct: 100, state: "stop" });
    const resetAt = s.h.now;
    const r = await s.reset();
    expect(await r!.json()).toMatchObject({ ok: true, result: { status: "done", code } });
    expect(await s.view()).toMatchObject({ weekUsedPct: 0, state: "below" });
    expect((await s.view()).observedAt).toBeGreaterThan(resetAt);
    expect(facts.factsNow(s.h.now).codex?.weekUsedPct).toBe(0);
  });
}
for (const code of ["timeout", "nothing_to_reset", "no_credit"]) {
  fixtureTest(`${code}: does not invalidate the quota-line cache`, async () => {
    const s = await setup(code);
    await s.view();
    const before = s.reads();
    let refreshed = false;
    await s.reset(async () => { refreshed = true; });
    expect(refreshed).toBe(false);
    expect(s.reads()).toBe(before);
    expect(facts.factsNow(s.h.now).codex?.weekUsedPct).toBe(100);
  });
}
fixtureTest("supplemental refresh failure preserves the successful reset response", async () => {
  const s = await setup();
  const r = await s.reset(async () => { throw new Error("fixture refresh failure"); });
  expect(await r!.json()).toMatchObject({ ok: true, result: { status: "done", code: "reset" } });
});
