import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { requestSharedLedger } from "../src/lib/shared-ledger-client-transport.js";
import { createStage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import { V2_ROUTE_FIXTURES } from "../src/lib/shared-ledger-contract-v2-routes-fixtures.js";

test("[验收线 2] read 429 gates V1 reads/writes and V2 in another client until Retry-After", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "budget-"));
  try {
    const key = instanceKeySync(stateDir)!;
    const connection = { centerId: "test", baseUrl: "https://budget.invalid", teamId: "team", personId: "owner", instanceId: "home", bearer: "test" };
    let time = 100_000, calls = 0;
    const fetcher = (async () => { calls++; return new Response("nginx", { status: 429, headers: { "Retry-After": "30" } }); }) as unknown as typeof fetch;
    const options = { stateDir, now: () => time, fetch: fetcher };
    const read = () => requestSharedLedger(connection, key, options, "GET", "/v1/teams/team/features");
    await expect(read()).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
    await expect(read()).rejects.toMatchObject({ status: 429 });
    await expect(requestSharedLedger(connection, key, options, "POST", "/v1/teams/team/projections", {})).rejects.toMatchObject({ status: 429 });
    const v2 = createStage2Transport({ connection, key, projectId: "project", ...options });
    await expect(v2.snapshot("feature")).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1);
    time += 30_000;
    const fx = V2_ROUTE_FIXTURES.features;
    const resumed = createStage2Transport({ connection, key, projectId: "project", ...options,
      fetch: (async () => { calls++; return Response.json(fx.response.valid); }) as unknown as typeof fetch });
    await resumed.snapshot(String(fx.params.featureId));
    expect(calls).toBe(2);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

import { fakeFeature, replicaKit } from "./shared-center-kit.js";
import { syncCenterReplicas, REPLICA_REASONS } from "../src/lib/shared-ledger-center-replica.js";

test("[验收线 3] second detail 429 fails once and skips the remaining features", async () => {
  const k = await replicaKit();
  try {
    for (let i = 1; i <= 4; i++) k.center.publish(fakeFeature({ id: `${i}1111111-2222-4333-8444-555555555555`, title: `Feature ${i}` }));
    let details = 0;
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (/\/features\//.test(String(url)) && ++details === 2) return new Response("nginx", { status: 429, headers: { "Retry-After": "30" } });
      return fetch(url, init);
    }) as typeof fetch;
    const result = await syncCenterReplicas(k.f.db, { stateDir: k.dir, fetch: fetcher, key: () => instanceKeySync(k.dir), dryRun: true });
    expect(result.features.map(f => f.result)).toEqual(["created", "failed", "skipped", "skipped"]);
    expect(result.features.slice(1).map(f => "reason" in f && f.reason)).toEqual(Array(3).fill(REPLICA_REASONS.rateLimited));
    expect(details).toBe(2);
  } finally { await k.close(); }
});

import { lendBudgetPaused, settleLendBudget } from "../src/lib/center-request-budget.js";
import { SharedLedgerRemoteError, sharedLedgerRateLimited, sharedLedgerSucceeded, sharedLedgerNotBefore } from "../src/lib/shared-ledger-client-transport.js";

test("[验收线 4] forbidden survives another reader, rotation resumes; observe/off never suppress requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lend-budget-"));
  try {
    await settleLendBudget(dir, "order", "credential1", new SharedLedgerRemoteError(403, null), 100);
    for (let i = 0; i < 10; i++) expect(lendBudgetPaused(dir, "order", "credential1", "on", 1_000_000)).toBe(true);
    expect(lendBudgetPaused(dir, "order", "credential2", "on", 101)).toBe(false);
    expect(lendBudgetPaused(dir, "another-order", "credential1", "on", 101)).toBe(false);
    for (const mode of ["off", "observe"] as const) expect(lendBudgetPaused(dir, "order", "credential1", mode, 101)).toBe(false);
    await settleLendBudget(dir, "order", "credential2", new Error("network"), 100);
    expect(lendBudgetPaused(dir, "order", "credential2", "on", 5099)).toBe(true);
    expect(lendBudgetPaused(dir, "order", "credential2", "on", 6101)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[验收线 2] fallback doubles across clients, caps at two minutes and success resets its streak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backoff-budget-")), origin = "https://budget.invalid";
  try {
    let now = 100;
    for (let n = 0; n < 8; n++) {
      const delay = await sharedLedgerRateLimited(origin, null, now, dir);
      expect(delay).toBeGreaterThanOrEqual(Math.min(120_000, 5000 * 2 ** n));
      expect(delay).toBeLessThanOrEqual(Math.min(120_000, 6000 * 2 ** n));
      expect(sharedLedgerNotBefore(origin, dir)).toBe(Math.ceil(now + delay));
      now += 200_000;
    }
    await sharedLedgerSucceeded(origin, now, dir);
    const delay = await sharedLedgerRateLimited(origin, null, now, dir);
    expect(delay).toBeGreaterThanOrEqual(5000);
    expect(delay).toBeLessThanOrEqual(6000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { writeFileSync } from "node:fs";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { writeLendCentralOrder } from "../src/lib/ledger-lend-central-home.js";
import { lendBindings } from "../src/bridge/shared-ledger-v2-wiring-lend.js";
import { configureSchedulerV2Pass } from "../src/lib/scheduler-v2-pass.js";
import type { Stage2Wiring } from "../src/lib/shared-ledger-v2-wiring.js";
import { lendCentralPoolPort } from "../src/lib/ledger-lend-central-pool.js";

for (const mode of ["off", "observe", "on"] as const) test(`[验收线 4] [验收线 5] real bindingFor and pooled reads (${mode})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "prime-budget-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  try {
    const configure = (authorityMode: string) => writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: {
      feature: { authorityMode, sharedPlanning: true, ...(authorityMode === "execution"
        ? { centerExecution: { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: "feature", epoch: 1 } } : {}) },
    } }));
    configure("source");
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: m => m });
    writeFileSync(join(dir, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { centerRequestBudget: mode } } } }));
    createTask(db, { actor: "owner" }, { project: "p", id: "task", title: "Task", kind: "code", extra: { sharedFeatureId: "feature" } });
    writeLendCentralOrder(db, "order", { taskId: "task", project: "p", peer: "peer", family: "codex", step: "write", specRev: 1, round: 0,
      head: "b".repeat(40), repo: "team/repository", pr: null, wire: { v: 1, orderId: "order", taskId: "task" }, text: "order", sha256: "a".repeat(64),
      leaseMs: 60_000, createdBy: "scheduler", branch: "lend/task", base: "main" });
    let reads = 0, resets = 0;
    const wiring = { dir, scope: () => ({ centerId: "center", teamId: "team", projectId: "project", localProjectId: "p" }),
      transportFor: () => ({ lend: () => ({ view: async () => { reads++; throw new SharedLedgerRemoteError(403, null); } }) }), reset: () => { resets++; },
    } as unknown as Stage2Wiring;
    const bindings = lendBindings({ wiring, db: () => db, outboxDir: join(dir, "outbox"), peer: async () => null });
    const prime = async () => { expect(bindings.bindingFor("order")).toBeNull(); await new Promise<void>(resolve => setImmediate(resolve)); };
    await prime();
    expect(reads).toBe(mode === "on" ? 0 : 1);
    configure("execution");
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: m => m });
    for (let i = 0; i < 10; i++) await prime();
    expect(reads).toBe(mode === "on" ? 1 : 11);
    writeFileSync(join(dir, "shared-ledger-credentials.json"), JSON.stringify({ version: 2 }));
    await prime();
    expect(reads).toBe(mode === "on" ? 2 : 12);
    expect(resets).toBe(1);
    const pool = lendCentralPoolPort({ wiring, db: () => db, fence: () => null, instanceId: () => "home" });
    for (let i = 0; i < 3; i++) await pool.readOrder!("p", "order").catch(() => null);
    expect(reads).toBe(mode === "on" ? 2 : 15);
  } finally { configureSchedulerV2Pass(null); closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});

test("[验收线 2] another Bun process honors a read's origin cooldown without invoking fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "process-budget-")), origin = "https://process-budget.invalid";
  try {
    await sharedLedgerRateLimited(origin, "30", 100_000, dir);
    const script = `
      import { requestSharedLedger } from './src/lib/shared-ledger-client-transport.ts';
      import { instanceKeySync } from './src/lib/instance-key.ts';
      const dir = process.argv[1];
      const connection = {centerId:'c',baseUrl:'${origin}',teamId:'t',personId:'p',instanceId:'i',bearer:'fixture'};
      let sent = 0;
      try { await requestSharedLedger(connection, instanceKeySync(dir), {stateDir:dir,now:()=>100001,
        fetch:async()=>{sent++;throw new Error('must not send')}}, 'GET', '/v1/teams/t/features'); }
      catch(e) { console.log(JSON.stringify({status:e.status,sent})); }
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script, dir], { stdout: "pipe", stderr: "pipe" });
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(JSON.parse(out)).toEqual({ status: 429, sent: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[验收线 5] default observe aggregates would-skip counts into one ten-minute log, off is silent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observe-budget-"));
  try {
    const script = `
      const scheduled = [], logs = [];
      globalThis.setTimeout = (fn, ms) => { scheduled.push({fn,ms}); return {unref(){}}; };
      console.info = line => logs.push(line);
      const {budgetWouldSkip, centerRequestBudgetMode} = await import('./src/lib/center-request-budget.ts');
      const mode = centerRequestBudgetMode('p', process.argv[1]);
      for(let i=0;i<4;i++) budgetWouldSkip('observe','projection-idle');
      for(let i=0;i<4;i++) budgetWouldSkip('off','lend-local');
      const before = logs.length;
      scheduled[0].fn();
      console.log(JSON.stringify({mode,before,timers:scheduled.map(x=>x.ms),logs}));
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script, dir], { stdout: "pipe", stderr: "pipe" });
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(JSON.parse(out)).toEqual({ mode: "observe", before: 0, timers: [600_000],
      logs: ['[centerRequestBudget] 本会跳过 {"projection-idle":4}'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
