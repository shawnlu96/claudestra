import { afterEach, beforeEach, expect, test } from "bun:test";
import { helloBody } from "../src/lib/lend-hello.js";
import { pausedUntil, PAUSE_FALLBACK_MS } from "../src/lib/lend-health.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { lendPollCapacity, CLAUDE_LEND_TOKEN } from "../src/lib/lend-claude-worker-capacity.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { harness, polled, wire, TEXT, sha, FP } from "./lend-harness.js";

const original = process.env[CLAUDE_LEND_TOKEN];
const journals: ReturnType<typeof harness>[] = [];
beforeEach(() => { process.env[CLAUDE_LEND_TOKEN] = "fixture-token"; });
afterEach(() => {
  for (const h of journals.splice(0)) h.db.close();
  closeLedger(":memory:");
  if (original === undefined) delete process.env[CLAUDE_LEND_TOKEN]; else process.env[CLAUDE_LEND_TOKEN] = original;
});
function setup() {
  const h = harness({ entry: { families: { codex: 2, claude: 1 }, ordersPerDay: 20 } });
  journals.push(h);
  return h;
}
async function failStart(h: ReturnType<typeof harness>, error: string) {
  h.d.worker.create = async () => ({ ok: false, error });
  for (let i = 0; i < 4; i++) await h.tick();
}
for (const resetKnown of [true, false]) test(`bootstrap usage limit releases and freezes only Codex (reset known=${resetKnown})`, async () => {
  const h = setup();
  // Feed the quota only at create: a known-full initial observation must prevent claim altogether.
  const now = h.d.now();
  const until = now + (resetKnown ? 7200_000 : PAUSE_FALLBACK_MS);
  h.d.worker.create = async () => {
    h.health.quota = resetKnown ? { observedAt: now, full: true, resetsAt: until } : null;
    return { ok: false, error: "bootstrap: You've hit your usage limit. Try again later." };
  };
  for (let i = 0; i < 4; i++) await h.tick();
  expect(getOrder(h.db, "o1")?.state).toBe("released");
  expect(h.calls.filter((c) => c.op === "lease" && c.body.action === "release")).toHaveLength(1);
  expect(getOrder(h.db, "o1")?.reason).toContain("起 worker 失败");
  expect(pausedUntil(h.db, now)).toBe(until);
  const body = helloBody(h.db, h.lend.lend[0], now);
  expect(body.paused).toEqual({ reason: "codex_quota", until });
  expect(lendPollCapacity(h.lend.lend[0], h.db, now).families).toEqual({ codex: 0, claude: 1 });
  const ledger = openLedger(":memory:");
  expect(recordHello(ledger, "lender", null, { ...body, v: 1, boot: "fixture-boot", seq: 1 }, now).applied).toBe(true);
  const peers = borrowPeers(ledger, "p", [{ peer: "lender", projects: ["p"], roles: ["review"], maxOpen: 3 }], now);
  expect(peers[0].v2?.slots).toEqual({ codex: 0, claude: 1 });
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [{ ...polled("c1"), family: "claude" }], pollAfterMs: 30_000 } });
  // Use this fixture's registry so start recognition remains local to the same journal.
  h.d.worker.create = async (name, cwd) => { h.registry.set(name, { sessionId: "claude-fixture", cwd }); return { ok: true }; };
  h.advanceTime(60_000);
  for (let i = 0; i < 4; i++) await h.tick();
  expect(getOrder(h.db, "c1")?.state).toBe("started");
});
for (const error of ["clone failed", "permission denied pushing repository", "Authentication required", "rate limit exceeded"]) {
  test(`ordinary create failure does not pause: ${error}`, async () => {
    const h = setup();
    await failStart(h, error);
    expect(getOrder(h.db, "o1")?.state).toBe("released");
    expect(pausedUntil(h.db, h.d.now())).toBeNull();
  });
}
test("Claude create usage-limit text does not pause Codex", async () => {
  const h = setup();
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [{ ...polled(), family: "claude" }], pollAfterMs: 30_000 } });
  await failStart(h, "You've hit your usage limit");
  expect(getOrder(h.db, "o1")?.state).toBe("released");
  expect(pausedUntil(h.db, h.d.now())).toBeNull();
});
test("clone failure keeps its original release and never pauses", async () => {
  const h = setup();
  h.d.clone = async () => ({ ok: false, reason: "clone failed" });
  for (let i = 0; i < 3; i++) await h.tick();
  expect(getOrder(h.db, "o1")?.state).toBe("released");
  expect(pausedUntil(h.db, h.d.now())).toBeNull();
});

test("write push-permission probe failure releases without pausing", async () => {
  const h = setup();
  h.d.writeOpen = true;
  h.lend.lend[0].roles = ["review", "write"];
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [{ ...polled(), step: "write", pr: null }], pollAfterMs: 30_000 } });
  h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: { ...wire(), step: "write", pr: null }, text: TEXT, sha256: sha(TEXT),
    lease: { gen: 1, expiresAt: 0, ms: 600_000 }, write: { branch: lendBranch("T93", FP), base: "main" } } });
  h.d.push.probe = async () => ({ ok: false, retry: false, reason: "没有推送权限" });
  for (let i = 0; i < 3; i++) await h.tick();
  expect(getOrder(h.db, "o1")).toMatchObject({ state: "released", reason: "没有推送权限" });
  expect(h.log.created).toEqual([]);
  expect(pausedUntil(h.db, h.d.now())).toBeNull();
});
test("quota read failure after bootstrap limit still releases and uses fallback", async () => {
  const h = setup();
  h.d.codexQuota = async () => { throw new Error("quota fixture unavailable"); };
  const until = h.d.now() + PAUSE_FALLBACK_MS;
  await failStart(h, "You've hit your usage limit");
  expect(getOrder(h.db, "o1")?.state).toBe("released");
  expect(helloBody(h.db, h.lend.lend[0], h.d.now()).paused).toEqual({ reason: "codex_quota", until });
});
