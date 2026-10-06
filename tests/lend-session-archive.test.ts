/** Exact settle hook and historical read-only scan use only temporary journals and session files. */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveEndedWorker, sweepEndedLendThreads } from "../src/lib/lend-session-archive.js";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { workerName } from "../src/lib/lend-worker-name.js";
import { harness, sha, toStarted } from "./lend-harness.js";

const root = mkdtempSync(join(tmpdir(), "lend-session-archive-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const worker = workerName("o1");
function world() {
  const dir = mkdtempSync(join(root, "w-")), session = join(dir, "session.jsonl");
  writeFileSync(session, '{"sessionId":"session-1","history":"original"}\n', { mode: 0o640 });
  const opts = { keep: new Set<string>(), codexRoot: dir, archiveRoot: join(dir, "archived"), locksDir: join(dir, "locks") };
  mkdirSync(opts.locksDir);
  const row = { orderId: "o1", family: "codex", agent: worker, sessionId: "session-1", leaseGen: 3, state: "acked" as const };
  return { dir, session, opts, row };
}

test.each(["acked", "cancelled", "released"] as const)("%s hook preserves history and propagates blocked-capability", async (state) => {
  const w = world(), before = readFileSync(w.session, "utf8");
  const calls: string[][] = [];
  await expect(archiveEndedWorker({ ...w.row, state }, () => {}, w.opts, async (...args) => {
    calls.push(args); return { ok: false, code: "blocked-capability", recoverable: true };
  })).rejects.toThrow("blocked-capability");
  expect(calls).toEqual([["archive-workflows", "--lend-worker", "settle", JSON.stringify({ orderId: "o1", agent: worker, sessionId: "session-1", leaseGen: 3 })]]);
  expect(readFileSync(w.session, "utf8")).toBe(before);
  expect(statSync(w.session).mode & 0o777).toBe(0o640);
  expect(existsSync(w.opts.archiveRoot)).toBe(false);
});

test("stopped, active, unknown and unstarted orders cannot infer retirement or invoke manager", async () => {
  const w = world();
  let calls = 0;
  const manager = async () => { calls++; return {}; };
  for (const state of ["stopped", "started", "result_pending", "unknown", undefined]) {
    await archiveEndedWorker({ ...w.row, state: state as typeof w.row.state }, () => {}, w.opts, manager);
  }
  await archiveEndedWorker({ ...w.row, agent: null, sessionId: null }, () => {}, w.opts, manager);
  expect(calls).toBe(0);
  await expect(archiveEndedWorker(w.row, () => {}, w.opts)).rejects.toThrow("blocked-capability");
  await expect(archiveEndedWorker({ ...w.row, leaseGen: null }, () => {}, w.opts, manager)).rejects.toThrow("身份不完整");
  expect(readFileSync(w.session, "utf8")).toContain("original");
});

test.each(["stopped", "cancelled"] as const)("daily %s scan is metadata only and retains original history and journal bytes", async (state) => {
  const w = world(), path = join(w.dir, "journal.sqlite"), db = openLendJournal(path);
  recordAsked(db, { orderId: "o1", peer: "A", fp: "fp", family: "codex", preview: {} });
  advance(db, "o1", "asked", "claimed", { leaseGen: 3, agent: worker, dir: w.dir });
  advance(db, "o1", "claimed", "cloned");
  advance(db, "o1", "cloned", "started", { sessionId: "session-1" });
  advance(db, "o1", "started", state);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const before = readFileSync(path);
  for (const status of ["active", "unknown", "stopped"]) {
    expect(await sweepEndedLendThreads([{ name: worker, status, sessionId: "session-1", kind: "worker", runtime: "codex", cwd: w.dir }],
      { ...w.opts, journalPath: path })).toBe(0);
  }
  expect(readFileSync(w.session, "utf8")).toContain("original");
  expect(readFileSync(path)).toEqual(before);
  expect(existsSync(w.opts.archiveRoot)).toBe(false);
});

test("missing, corrupt and unreadable journal never causes archive or permission repair", async () => {
  const w = world(), path = join(w.dir, "journal.sqlite");
  const scan = () => sweepEndedLendThreads([{ name: worker, status: "stopped", sessionId: "session-1" }], { ...w.opts, journalPath: path });
  expect(await scan()).toBe(0);
  expect(existsSync(path)).toBe(false);
  writeFileSync(path, "broken sqlite", { mode: 0o640 });
  expect(await scan()).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("broken sqlite");
  chmodSync(path, 0);
  expect(await scan()).toBe(0);
  expect(statSync(path).mode & 0o777).toBe(0);
  expect(readFileSync(w.session, "utf8")).toContain("original");
});

describe("settleOrder preserves recoverable completion", () => {
  async function toAcked(h: ReturnType<typeof harness>) {
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    await h.tick();
  }

  test("blocked real hook retains acked, receipt and settle across journal restart", async () => {
    const original = harness();
    original.db.close();
    const disk = openLendJournal(join(mkdtempSync(join(root, "restart-")), "journal.sqlite"));
    original.d.db = disk;
    const h = { ...original, db: disk };
    h.d.archiveSessions = (row) => archiveEndedWorker(row, () => {}, undefined, async () => ({ ok: false, code: "blocked-capability" }));
    await toAcked(h);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "acked", settle: { notify: null, removeDir: false } });
    expect(h.log.receipts.length).toBeGreaterThan(0);
    const path = h.db.filename;
    h.db.close();
    h.d.db = openLendJournal(path);
    try {
      expect(getOrder(h.d.db, "o1")).toMatchObject({ state: "acked", settle: { notify: null, removeDir: false } });
    } finally { h.d.db.close(); }
  });

  test("failed directory cleanup retains removeDir and never reaches receipt/archive", async () => {
    const h = harness();
    let calls = 0;
    h.d.archiveSessions = async () => { calls++; };
    h.d.removeDir = () => { throw new Error("副本状态读不到"); };
    await toAcked(h);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "acked", settle: { notify: null, removeDir: true } });
    expect(calls).toBe(0);
    expect(h.log.receipts).toHaveLength(0);
  });

  test("failed archiving retains settle; only a successful retirement can clear it", async () => {
    const h = harness();
    h.d.archiveSessions = async () => { throw new Error("blocked-capability"); };
    await toAcked(h);
    await h.tick();
    expect(getOrder(h.db, "o1")?.settle).not.toBeNull();
    h.d.archiveSessions = async () => {};
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "acked", settle: null });
  });
});
