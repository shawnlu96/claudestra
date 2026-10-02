import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked, type LendState } from "../src/lib/lend-journal.js";
import { orderDir, orderDirName } from "../src/lib/lend-clone.js";
import { lendTickWithRetention, STOPPED_RETENTION_MS as DAY, stoppedWorkSummary, sweepStoppedWork } from "../src/lib/lend-work-retention.js";
import { CLAUDE_LEND_ROOT } from "../src/lib/lend-claude-worker-session.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { harness } from "./lend-harness.js";
import { checkLendLoop } from "../src/lib/doctor-lend.js";
import { testChildEnv } from "./test-env.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const NOW = 10 * DAY;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "retention-"));
  const root = join(home, "lend");
  const db = openLendJournal(join(root, "journal.sqlite"));
  cleanups.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const lines: string[] = [];
  const sweep = (now = NOW) => sweepStoppedWork(db, { root, now, log: (line) => lines.push(line) });
  function add(id: string, state: LendState = "stopped", at = NOW - DAY, family = "codex") {
    recordAsked(db, { orderId: id, peer: "test", fp: null, family, preview: {} }, at - 100);
    // Fixtures cover every terminal/nonterminal state; transition mechanics have their own journal tests.
    db.query("UPDATE lend_orders SET state = ?, updatedAt = ?, agent = ? WHERE orderId = ?").run(state, at, workerName(id), id);
    for (const area of ["work", "push"] as const) {
      const dir = orderDir(id, root, area);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "keep"), id);
    }
  }
  return { home, root, db, lines, sweep, add };
}

test("24-hour boundary: only stopped work/push are reclaimed, even when row.dir points elsewhere", () => {
  const f = fixture();
  f.add("due");
  f.add("young", "stopped", NOW - DAY + 1);
  for (const state of ["asked", "claimed", "cloned", "started", "result_pending", "acked", "cancelled", "released", "declined"] as LendState[]) f.add(state, state);
  const outside = join(f.home, "outside");
  mkdirSync(outside);
  patchOrder(f.db, "due", ["stopped"], { dir: outside }, NOW - DAY);
  expect(f.sweep()).toBe(1);
  for (const area of ["work", "push"] as const) {
    expect(existsSync(orderDir("due", f.root, area))).toBe(false);
    for (const id of ["young", "asked", "claimed", "cloned", "started", "result_pending", "acked", "cancelled", "released", "declined"]) {
      expect(existsSync(orderDir(id, f.root, area))).toBe(true);
    }
  }
  expect(existsSync(outside)).toBe(true);
  expect(f.sweep()).toBe(0);
  expect(f.sweep(NOW + 1)).toBe(1);
});

test("one pass attempts at most five orders; old cleaned rows do not consume later batches", () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) f.add(`o${i}`, "stopped", NOW - DAY - i);
  expect(f.sweep()).toBe(5);
  expect(stoppedWorkSummary(f.db, f.root)).toEqual({ count: 7, oldestStoppedAt: NOW - DAY - 6 });
  expect(f.sweep()).toBe(5);
  expect(f.sweep()).toBe(2);
  expect(f.sweep()).toBe(0);
  expect(stoppedWorkSummary(f.db, f.root)).toEqual({ count: 0, oldestStoppedAt: null });
});

test("Claude per-order config is removed even if both checkout directories were already absent", () => {
  const f = fixture();
  const id = `claude-${f.home.split("/").at(-1)}`;
  f.add(id, "stopped", NOW - DAY, "claude");
  for (const area of ["work", "push"] as const) rmSync(orderDir(id, f.root, area), { recursive: true });
  const config = join(CLAUDE_LEND_ROOT, workerName(id));
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "launch.json"), "{}");
  cleanups.push(() => rmSync(config, { recursive: true, force: true }));
  expect(f.sweep()).toBe(1);
  expect(existsSync(config)).toBe(false);
});

test("partial cleanup failure is logged and retried on the next pass", () => {
  const f = fixture();
  f.add("retry");
  let calls = 0;
  const options = { root: f.root, now: NOW, log: (line: string) => f.lines.push(line), removeConfig: () => { if (++calls === 1) throw new Error("disk busy"); } };
  expect(sweepStoppedWork(f.db, options)).toBe(1);
  expect(f.lines.join("\n")).toContain("disk busy");
  expect(f.lines.join("\n")).toContain("下轮再试");
  expect(sweepStoppedWork(f.db, options)).toBe(1);
  expect(calls).toBe(2);
  expect(sweepStoppedWork(f.db, options)).toBe(0);
});

test("settlement retries cannot move the recorded stop time; new stop gets a full day", () => {
  const f = fixture();
  f.add("stopped", "claimed", NOW - 2 * DAY);
  const row = advance(f.db, "stopped", "claimed", "stopped", {}, NOW);
  expect(f.sweep(NOW)).toBe(0);
  patchOrder(f.db, row.orderId, ["stopped"], { reason: "late receipt" }, NOW + DAY - 1);
  expect(stoppedWorkSummary(f.db, f.root).oldestStoppedAt).toBe(NOW);
  expect(f.sweep(NOW + DAY - 1)).toBe(0);
  expect(f.sweep(NOW + DAY)).toBe(1);
  expect(getOrder(f.db, row.orderId)?.state).toBe("stopped");
});

test("order IDs containing traversal/absolute paths only remove their hashed order directories", () => {
  const f = fixture();
  const victim = join(f.home, "victim");
  writeFileSync(victim, "safe");
  for (const id of ["..", "../../victim", victim, "a/../../../victim"]) f.add(id);
  expect(f.sweep()).toBe(4);
  expect(readFileSync(victim, "utf8")).toBe("safe");
});

for (const area of ["work", "push"] as const) {
  test(`${area} order symlinks (including dangling) are rejected before either directory is deleted`, () => {
    const f = fixture();
    f.add("symlink");
    const victim = join(f.home, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "keep"), "safe");
    const path = orderDir("symlink", f.root, area);
    rmSync(path, { recursive: true });
    symlinkSync(victim, path);
    expect(f.sweep()).toBe(1);
    expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
    expect(existsSync(orderDir("symlink", f.root, area === "work" ? "push" : "work"))).toBe(true);
    rmSync(path);
    symlinkSync(join(f.home, "missing"), path);
    expect(f.sweep()).toBe(1);
    expect(f.lines).toHaveLength(2);
    rmSync(path);
    mkdirSync(path);
    expect(f.sweep()).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  test(`${area} parent symlink cannot redirect deletion outside lend root`, () => {
    const f = fixture();
    f.add("area-link");
    const victim = join(f.home, "outside");
    const target = join(victim, orderDirName("area-link"));
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep"), "safe");
    const parent = dirname(orderDir("area-link", f.root, area));
    rmSync(parent, { recursive: true });
    symlinkSync(victim, parent);
    expect(f.sweep()).toBe(1);
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("safe");
    expect(f.lines).toHaveLength(1);
  });
}

test("symlinked lend root is refused and symlinks inside a normal checkout never delete their targets", () => {
  const f = fixture();
  f.add("inside");
  const alias = join(f.home, "alias");
  symlinkSync(f.root, alias);
  expect(sweepStoppedWork(f.db, { root: alias, now: NOW, log: (s) => f.lines.push(s) })).toBe(1);
  expect(existsSync(orderDir("inside", f.root))).toBe(true);
  const victim = join(f.home, "outside");
  writeFileSync(victim, "safe");
  symlinkSync(victim, join(orderDir("inside", f.root), "link"));
  expect(f.sweep()).toBe(1);
  expect(readFileSync(victim, "utf8")).toBe("safe");
});

test("loss of scheduler ownership escapes without removing a checkout", () => {
  const f = fixture();
  f.add("owned");
  expect(() => sweepStoppedWork(f.db, { root: f.root, now: NOW, log: () => {}, active: () => { throw new SchedulerStopped(); } })).toThrow(SchedulerStopped);
  expect(existsSync(orderDir("owned", f.root))).toBe(true);
});

test("production pass wrapper cleans at most five even when lending is disabled and no live orders exist", async () => {
  const f = fixture();
  const h = harness();
  cleanups.push(() => h.db.close());
  h.lend.enabled = false;
  h.lend.lend = [];
  for (let i = 0; i < 7; i++) f.add(`idle-${i}`);
  const d = { ...h.d, db: f.db, now: () => NOW };
  expect(await lendTickWithRetention(d, () => {}, f.root)).toEqual({ failed: [] });
  expect(stoppedWorkSummary(f.db, f.root).count).toBe(2);
  expect(await lendTickWithRetention(d, () => {}, f.root)).toEqual({ failed: [] });
  expect(stoppedWorkSummary(f.db, f.root).count).toBe(0);
  expect(h.calls).toHaveLength(0);
});

test("status and doctor count retained orders (including push-only) and show oldest timestamp", async () => {
  const f = fixture();
  f.add("old", "stopped", NOW - 2 * DAY);
  f.add("young", "stopped", NOW - DAY + 1);
  f.add("already-gone", "stopped", NOW - 3 * DAY);
  f.add("active", "started", NOW - 4 * DAY);
  rmSync(orderDir("old", f.root), { recursive: true });
  for (const area of ["work", "push"] as const) rmSync(orderDir("already-gone", f.root, area), { recursive: true });
  const expected = { count: 2, oldestStoppedAt: NOW - 2 * DAY };
  expect(stoppedWorkSummary(f.db, f.root)).toEqual(expected);
  const p = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "lend", "status"], {
    env: testChildEnv({ HOME: f.home, CLAUDESTRA_STATE_DIR: f.home, CLAUDESTRA_RUNTIME_DIR: join(f.home, "runtime") }), stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  const status = JSON.parse(p.stdout.toString().trim().split("\n").at(-1)!);
  expect(status.stoppedWork).toEqual(expected);
  expect(status.stoppedWorkText).toContain("stopped 工作副本 2 个");
  const [check] = await checkLendLoop(join(f.home, "lend.json"), join(f.root, "journal.sqlite"), NOW);
  expect(check.detail).toContain(status.stoppedWorkText);
  expect(check.detail).toContain(new Date(expected.oldestStoppedAt).toISOString());
  f.sweep();
  const [after] = await checkLendLoop(join(f.home, "lend.json"), join(f.root, "journal.sqlite"), NOW);
  expect(after.detail).toContain("stopped 工作副本 1 个");
});
