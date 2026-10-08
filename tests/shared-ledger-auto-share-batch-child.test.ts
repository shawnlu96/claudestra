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

test("N8A3-4 single flight: a second pass while the lock is held is busy; the child refuses to run without the parent's lock", async () => {
  const lock = await acquireLock(join(STATE_DIR, "shared-ledger-auto-share.pass.lock"), 0);
  try { expect(await runAutoSharePassInChild({ cmd: [process.execPath, "-e", "0"] })).toEqual({ status: "busy" }); }
  finally { lock!.release(); }
  expect(await main([], { CLAUDESTRA_AUTO_SHARE_PASS_LOCK: "" })).toBe(2);
  expect(await main([], { CLAUDESTRA_AUTO_SHARE_PASS_LOCK: JSON.stringify({ path: "elsewhere", token: "stale" }) })).toBe(0); // runs, does nothing
});
