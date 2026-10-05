import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock } from "../src/lib/file-lock.js";
import { adoptSchedulerLease, encodeLease, forwardSchedulerLease, resetSchedulerLeaseForTest, SCHEDULER_LEASE_ENV } from "../src/lib/scheduler-lease-env.js";
import { reviewSwapManagerEnv } from "../src/lib/scheduler-review-swap-runtime.js";

const leaseModule = join(import.meta.dir, "../src/lib/scheduler-lease-env.ts");
const adapterModule = join(import.meta.dir, "../src/lib/acp/adapter-proc.ts");
afterEach(resetSchedulerLeaseForTest);

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "review-swap-lease-"));
  const singleton = join(dir, "scheduler.pid"), maintenance = join(dir, "maintenance.lock");
  const a = (await acquireLock(singleton, 0))!, b = (await acquireLock(maintenance, 0))!;
  const lease = encodeLease({ singleton: { path: singleton, token: a.token }, maintenance: { path: maintenance, token: b.token } });
  adoptSchedulerLease({ [SCHEDULER_LEASE_ENV]: lease });
  return { lease, stop: () => a.release(), close: () => { a.release(); b.release(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Probe create's Codex bootstrap path: manager adopts, then adapterEnv explicitly supplies the agent environment. */
async function lifecycleChild(env: Record<string, string | undefined>, action: string) {
  const agentProbe = `console.log(JSON.stringify({ hasLease: Object.hasOwn(process.env, ${JSON.stringify(SCHEDULER_LEASE_ENV)}) }))`;
  const code = `import { adoptSchedulerLease, assertSchedulerLease, forwardSchedulerLease } from ${JSON.stringify(leaseModule)};
import { adapterEnv } from ${JSON.stringify(adapterModule)};
const received = process.env[${JSON.stringify(SCHEDULER_LEASE_ENV)}];
adoptSchedulerLease();
try {
  assertSchedulerLease();
  let agent = null;
  if (${JSON.stringify(action)} === "create") {
    const env = adapterEnv({ base: process.env, bunBin: process.execPath, channelServer: "unused", mcpName: "claudestra", logsDir: "/tmp" });
    const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", ${JSON.stringify(agentProbe)}], { env, stdout: "pipe" });
    agent = JSON.parse(await new Response(p.stdout).text()); await p.exited;
  }
  console.log(JSON.stringify({ ok: true, received, forwarded: forwardSchedulerLease(), hasInheritedLease: Object.hasOwn(process.env,
    ${JSON.stringify(SCHEDULER_LEASE_ENV)}), agent }));
} catch (e) { console.log(JSON.stringify({ ok: false, name: e.constructor.name, error: e.message })); }`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code], { env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text(), err = await new Response(child.stderr).text();
  expect(await child.exited, err).toBe(0);
  return JSON.parse(out.trim());
}

const baseEnv = () => ({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: process.env.HOME,
  CLAUDESTRA_STATE_DIR: process.env.CLAUDESTRA_STATE_DIR, CLAUDESTRA_RUNTIME_DIR: process.env.CLAUDESTRA_RUNTIME_DIR,
  BRIDGE_URL: process.env.BRIDGE_URL });

test("archive / kill / create receive exactly the adopted parent lease; the created agent inherits none", async () => {
  const w = await world();
  try {
    const base = { ...baseEnv(), [SCHEDULER_LEASE_ENV]: "do not reuse raw env", CLAUDESTRA_SCHEDULER_SERVICE: "1" };
    const env = reviewSwapManagerEnv(base);
    expect(base[SCHEDULER_LEASE_ENV]).toBe("do not reuse raw env");
    expect(env).not.toHaveProperty("CLAUDESTRA_SCHEDULER_SERVICE");
    for (const action of ["archive", "kill", "create"]) {
      const r = await lifecycleChild(env, action);
      expect(r).toMatchObject({ ok: true, received: w.lease, forwarded: w.lease, hasInheritedLease: false });
      if (action === "create") expect(r.agent).toEqual({ hasLease: false });
    }
  } finally { w.close(); }
});

test("a child with the forwarded lease refuses execution after its parent loses ownership", async () => {
  const w = await world();
  try {
    const env = reviewSwapManagerEnv(baseEnv());
    w.stop();
    expect(await lifecycleChild(env, "kill")).toMatchObject({ ok: false, name: "SchedulerLeaseLost" });
  } finally { w.close(); }
});

test("unreadable adopted lease forwards empty and fails closed; ordinary CLI forwards no lease", async () => {
  adoptSchedulerLease({ [SCHEDULER_LEASE_ENV]: "broken" });
  expect(forwardSchedulerLease()).toBe("");
  expect(reviewSwapManagerEnv(baseEnv())[SCHEDULER_LEASE_ENV]).toBe("");
  expect(await lifecycleChild(reviewSwapManagerEnv(baseEnv()), "archive")).toMatchObject({ ok: false, name: "SchedulerLeaseLost" });
  resetSchedulerLeaseForTest();
  expect(forwardSchedulerLease()).toBeUndefined();
  const env = reviewSwapManagerEnv({ ...baseEnv(), [SCHEDULER_LEASE_ENV]: "stale value" });
  expect(env).not.toHaveProperty(SCHEDULER_LEASE_ENV);
  expect(await lifecycleChild(env, "create")).toMatchObject({ ok: true, hasInheritedLease: false, agent: { hasLease: false } });
});
