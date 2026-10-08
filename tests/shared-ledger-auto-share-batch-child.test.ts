/** team-project-N8A3 acceptance 4: a pass runs outside the cron event loop; a child past its timeout is killed, outcome unknown. */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { runSharedLedgerAutoSharePass } from "../src/lib/shared-ledger-auto-share.js";
import { runAutoSharePassInChild } from "../src/lib/shared-ledger-auto-share-run.js";
import { main } from "../scripts/shared-ledger-auto-share-pass.ts";
import { updateAutoShareProject } from "../src/lib/shared-ledger-auto-share-state.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { migrationLockPath } from "../src/lib/shared-ledger-mirror.js";
import { autoShareFixture, cleanupAutoShareState, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";

afterEach(() => cleanupAutoShareState());
const T0 = Date.UTC(2026, 9, 9, 12, 0);

/** Largest gap between ticks of a 100 ms timer while `run` is in flight (the cron loop's view of a pass). */
async function maxTickGap(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now(), worst = 0;
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 100);
  try { await run(); } finally { clearInterval(timer); }
  return Math.max(worst, performance.now() - last);
}

/** One feature with 120 DAG versions of 80 nodes each (b5cf-i28 has 108): its pre-check export preview is seconds of sync work. */
async function largeFixture() {
  const f = await autoShareFixture(["large"]);
  const id = f.features[0]!, insert = f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,?,'new_issue','More','owner',1000,?)");
  for (let v = 2; v <= 121; v++) {
    insert.run(id, v, JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ key: `n${i}`, taskId: null, oneLine: `Version ${v} node ${i}`,
      deps: i ? [`n${i - 1}`] : [], fileGlobs: [`src/n${i}.ts`], estimate: "1h" }))));
  }
  f.db.prepare("UPDATE features SET currentVersion = 121 WHERE id = ?").run(id);
  return f;
}

test("N8A3-4 a pass over a 120-version feature in the child leaves the parent's 100 ms timer under 1 s apart", async () => {
  const f = await largeFixture();
  try {
    await f.ledger(["shared-auto", "observe", PROJECT]);
    // In-process (main's cron host): the timer stalls for the whole pre-check.
    const inProcess = await maxTickGap(() => runSharedLedgerAutoSharePass({ ledgerPath: f.path }));
    const { at: _at, ...inProcessResult } = f.state().features![f.features[0]!]!;
    let result: Awaited<ReturnType<typeof runAutoSharePassInChild>> | undefined;
    const child = await maxTickGap(async () => { result = await runAutoSharePassInChild({ ledgerPath: f.path }); });
    expect(result).toEqual({ status: "done", outcomes: { [PROJECT]: { action: "observe" } } });
    expect({ ...f.state().features![f.features[0]!], at: undefined }).toEqual({ ...inProcessResult, at: undefined }); // the same pre-check ran in the child
    expect(child).toBeLessThan(1000);
    expect(inProcess).toBeGreaterThan(child);
  } finally { await f.close(); }
}, 60_000);

test("N8A3-4 a child that never returns is killed at the timeout: open batch unknown, pass lock released, no gate written", async () => {
  const f = await autoShareFixture(["alpha"]);
  try {
    await f.ledger(["shared-auto", "on", PROJECT]);
    const pending = { batchId: `auto-${PROJECT}-202610091200`, digest: "", featureIds: [f.features[0]!], unknown: 0, at: T0 };
    await updateAutoShareProject(STATE_DIR, PROJECT, (p) => { p.pending = pending; });
    const modes = f.modesRaw(), started = performance.now();
    const result = await runAutoSharePassInChild({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeoutMs: 300, now: () => T0 });
    expect(result).toEqual({ status: "timeout" });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(f.state()).toMatchObject({ pending: { ...pending, unknown: 1 }, lastError: "提交结果未知（第 1 次），下轮重试同一批" });
    expect(f.modesRaw()).toBe(modes);
    expect(existsSync(join(STATE_DIR, "shared-ledger-migrations"))).toBe(false);
    const lock = await acquireLock(join(STATE_DIR, "shared-ledger-auto-share.pass.lock"), 0);
    expect(lock).not.toBeNull();
    lock!.release();
  } finally { await f.close(); }
});

/** Child that runs the real pass up to a real prepare (gate installed, journal prepared), then holds the migration lock and hangs. */
const HANGING_AFTER_PREPARE = `
import { runSharedLedgerAutoSharePass } from ${JSON.stringify(join(import.meta.dir, "../src/lib/shared-ledger-auto-share.ts"))};
import { prepareSharedLedgerImport } from ${JSON.stringify(join(import.meta.dir, "../src/lib/shared-ledger-import-run.ts"))};
import { acquireLock } from ${JSON.stringify(join(import.meta.dir, "../src/lib/file-lock.ts"))};
import { migrationLockPath } from ${JSON.stringify(join(import.meta.dir, "../src/lib/shared-ledger-mirror.ts"))};
await runSharedLedgerAutoSharePass({ heldLock: JSON.parse(process.env.CLAUDESTRA_AUTO_SHARE_PASS_LOCK), ledgerPath: process.argv[1],
  client: () => ({}), scrub: async () => ({ identity: { username: "pj1-user", hostname: "pj1-host" } }),
  prepare: async (db, opts) => {
    await prepareSharedLedgerImport(db, opts);
    await acquireLock(migrationLockPath(opts.stateDir));
    if (process.argv[2]) await Bun.write(process.argv[2], "prepared");
    console.error("prepared");
    await new Promise(() => setInterval(() => {}, 1000));
    throw new Error("unreachable");
  } });`;

test("N8A3-4 a child killed after prepare installed the gate: the uncommitted batch is revoked, no gate, no backup, locks free", async () => {
  const f = await autoShareFixture(["alpha"]);
  try {
    await f.ledger(["shared-auto", "on", PROJECT]);
    const id = f.features[0]!;
    const result = await runAutoSharePassInChild({ cmd: [process.execPath, "--no-env-file", "-e", HANGING_AFTER_PREPARE, f.path],
      ledgerPath: f.path, timeoutMs: 3000, now: () => T0 });
    expect(result).toEqual({ status: "timeout" });
    const batchId = f.state().batches!.at(-1)!.batchId;
    expect(f.journal(batchId).phase).toBe("aborted");
    expect(readSharedLedgerMode(id).sharedPlanning).toBe(false);
    expect(existsSync(join(STATE_DIR, "shared-ledger-migrations", `${batchId}.backup.sqlite`))).toBe(false);
    expect(f.state()).toMatchObject({ pending: null, lastError: "自动共享本轮超时，已终止；批次未提交，已撤闸",
      features: { [id]: { status: "refused", reason: "导入准备失败", rules: 3 } } });
    expect(f.state().batches!.at(-1)!.outcome).toBe("timeout");
    expect(f.center.calls).toEqual([]);
    for (const path of [migrationLockPath(STATE_DIR), join(STATE_DIR, "shared-ledger-auto-share.pass.lock")]) {
      const lock = await acquireLock(path, 0);
      expect(lock).not.toBeNull();
      lock!.release();
    }
  } finally { await f.close(); }
}, 30_000);

test("N8A3-4 switched off after prepare installed the gate, then killed at the timeout: the batch is still revoked, mode stays off", async () => {
  const f = await autoShareFixture(["alpha"]);
  try {
    await f.ledger(["shared-auto", "on", PROJECT]);
    const id = f.features[0]!, marker = join(STATE_DIR, "prepared.marker");
    const run = runAutoSharePassInChild({ cmd: [process.execPath, "--no-env-file", "-e", HANGING_AFTER_PREPARE, f.path, marker],
      ledgerPath: f.path, timeoutMs: 3000, now: () => T0 });
    while (!existsSync(marker)) await Bun.sleep(20);
    await f.ledger(["shared-auto", "off", PROJECT]);
    expect(await run).toEqual({ status: "timeout" });
    const batchId = f.state().batches!.at(-1)!.batchId;
    expect(f.journal(batchId).phase).toBe("aborted");
    expect(readSharedLedgerMode(id).sharedPlanning).toBe(false);
    expect(existsSync(join(STATE_DIR, "shared-ledger-migrations", `${batchId}.backup.sqlite`))).toBe(false);
    expect(f.state()).toMatchObject({ mode: "off", pending: null, features: { [id]: { status: "refused", reason: "导入准备失败", rules: 3 } } });
    expect(f.state().batches!.at(-1)!.outcome).toBe("timeout");
    expect(f.center.calls).toEqual([]);
  } finally { await f.close(); }
}, 30_000);

test("N8A3-4 single flight: a second pass while the lock is held is busy; the child refuses to run without the parent's lock", async () => {
  const lock = await acquireLock(join(STATE_DIR, "shared-ledger-auto-share.pass.lock"), 0);
  try { expect(await runAutoSharePassInChild({ cmd: [process.execPath, "-e", "0"] })).toEqual({ status: "busy" }); }
  finally { lock!.release(); }
  expect(await main([], { CLAUDESTRA_AUTO_SHARE_PASS_LOCK: "" })).toBe(2);
  expect(await main([], { CLAUDESTRA_AUTO_SHARE_PASS_LOCK: JSON.stringify({ path: "elsewhere", token: "stale" }) })).toBe(0); // runs, does nothing
});
