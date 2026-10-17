import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLedgerDagApi } from "../src/bridge/local-api/ledger-dag.js";
import { handleLedgerApi, setLedgerApiProjectsForTest } from "../src/bridge/local-api/ledger.js";
import { handleProductBoardApi } from "../src/bridge/local-api/product-board.js";
import { handleWorkBoardApi } from "../src/bridge/local-api/work-board.js";
import { ledgerDb, setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { Principal } from "../src/lib/principals.js";
import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { BoardBuildCache, cachedBoardBuild } from "../src/lib/board-build-cache.js";
import { defaultRecoveryMode } from "../src/lib/recovery-key-defaults.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

function fixture(maxEntries = 64) {
  let time = 0, seq = 1, builds = 0, reads = 0;
  const cache = new BoardBuildCache(maxEntries, 15_000, () => time);
  const input = { endpoint: "dag", project: "p", seq: () => { reads++; return seq; },
    build: () => { builds++; return { asOfSeq: seq, value: { asOfSeq: seq, now: time, nodes: [] } }; } };
  return { cache, input, at: (t: number) => { time = t; }, seq: (n: number) => { seq = n; }, counts: () => [builds, reads] };
}

describe("board builds", () => {
  test("five requests share the exact payload for 15 seconds, including its original now and seq", async () => {
    const f = fixture(), first = await f.cache.get(f.input);
    f.seq(2);
    for (let i = 1; i < 5; i++) { f.at(i * 3000); expect(await f.cache.get(f.input)).toBe(first); }
    expect(f.counts()).toEqual([1, 0]);
    f.at(15_000);
    expect(await f.cache.get(f.input)).toEqual({ asOfSeq: 2, now: 15_000, nodes: [] });
    expect(f.counts()).toEqual([2, 1]);
  });

  test("unchanged seq refreshes validation time only; changed seq waits for the next window", async () => {
    const f = fixture(), first = await f.cache.get(f.input);
    f.at(15_000);
    expect(await f.cache.get(f.input)).toBe(first);
    f.seq(2); f.at(29_999);
    expect(await f.cache.get(f.input)).toBe(first);
    expect(first.now).toBe(0);
    f.at(30_000);
    expect((await f.cache.get(f.input)).asOfSeq).toBe(2);
    expect(f.counts()).toEqual([2, 2]);
  });

  test("three requests during a build use one promise and failed builds can retry", async () => {
    const f = fixture();
    let finish!: (value: { asOfSeq: number; value: object }) => void, builds = 0;
    const input = { ...f.input, build: () => { builds++; return new Promise<{ asOfSeq: number; value: object }>(r => { finish = r; }); } };
    const all = [f.cache.get(input), f.cache.get(input), f.cache.get(input)];
    await Promise.resolve();
    expect(builds).toBe(1);
    const value = { now: 0 }; finish({ asOfSeq: 1, value });
    for (const result of await Promise.all(all)) expect(result).toBe(value);
    const failing = { ...f.input, project: "fails", build: () => { throw new Error("fixture failure"); } };
    await expect(f.cache.get(failing)).rejects.toThrow("fixture failure");
    expect(await f.cache.get({ ...f.input, project: "fails" })).toEqual({ asOfSeq: 1, now: 0, nodes: [] });
  });

  test("normalized query order shares; projects, endpoints, dayStart and replacement DBs never share", async () => {
    const f = fixture(), source = {};
    const first = await f.cache.get({ ...f.input, source, query: { dayStart: 1, a: true } });
    expect(await f.cache.get({ ...f.input, source, query: { a: true, dayStart: 1 } })).toBe(first);
    for (const variant of [{ project: "other" }, { endpoint: "product" }, { query: { dayStart: 2 } }, { source: {} }]) {
      expect(await f.cache.get({ ...f.input, source, query: { dayStart: 1, a: true }, ...variant })).not.toBe(first);
    }
    expect(f.counts()[0]).toBe(5);
  });

  test("only the latest query per project/endpoint remains and LRU evicts the least recently used", async () => {
    const f = fixture(2), a = await f.cache.get(f.input);
    await f.cache.get({ ...f.input, project: "b" });
    expect(await f.cache.get(f.input)).toBe(a);
    await f.cache.get({ ...f.input, project: "c" });
    expect(f.cache.size).toBe(2);
    expect(await f.cache.get(f.input)).toBe(a);
    await f.cache.get({ ...f.input, project: "b" });
    expect(f.counts()[0]).toBe(4);
    for (let dayStart = 0; dayStart < 100; dayStart++) await f.cache.get({ ...f.input, query: { dayStart } });
    expect(f.cache.size).toBe(2);
    expect(f.counts()[0]).toBe(104);
  });

  test("in-flight requests still coalesce after their cache slot is evicted", async () => {
    const f = fixture(1);
    let finish!: (v: { asOfSeq: number; value: string }) => void, builds = 0;
    const input = { ...f.input, build: () => { builds++; return new Promise<{ asOfSeq: number; value: string }>(r => { finish = r; }); } };
    const a = f.cache.get(input);
    await f.cache.get({ ...f.input, project: "b" });
    const b = f.cache.get(input);
    finish({ asOfSeq: 1, value: "shared" });
    expect(await Promise.all([a, b])).toEqual(["shared", "shared"]);
    expect(builds).toBe(1);
    expect(f.cache.size).toBe(1);
  });

  test("off builds on every request without watermark reads or warming the cache", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 5 }, () => f.cache.get({ ...f.input, enabled: false })));
    expect(f.counts()).toEqual([5, 0]);
    expect(f.cache.size).toBe(0);
  });

  test("SQL wrapper defaults on, keeps a consistent watermark, and off/observe preserve fresh responses without writes", async () => {
    expect(defaultRecoveryMode("boardBuildCache")).toBe("on");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY); INSERT INTO events VALUES (1); PRAGMA query_only = ON");
    const cache = new BoardBuildCache();
    let builds = 0;
    const build = () => ({ now: ++builds });
    const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, source: "config", manualAfterMs: null });
    const log = spyOn(console, "info").mockImplementation(() => {});
    try {
      const first = await cachedBoardBuild(db, "dag", "p", {}, build, policy("on"), cache);
      expect(await cachedBoardBuild(db, "dag", "p", {}, build, policy("on"), cache)).toBe(first);
      const query = spyOn(db, "query");
      try {
        for (let i = 0; i < 5; i++) await cachedBoardBuild(db, "dag", "p", {}, build, policy("off"), cache);
        expect(query.mock.calls.filter(([sql]) => sql.includes("MAX(seq)"))).toHaveLength(0);
      } finally { query.mockRestore(); }
      expect(builds).toBe(6);
      await cachedBoardBuild(db, "dag", "p", {}, build, policy("observe"), cache);
      expect(builds).toBe(7); expect(log).toHaveBeenCalledTimes(1);
      expect(db.query("SELECT MAX(seq) AS seq FROM events").get()).toEqual({ seq: 1 });
    } finally { log.mockRestore(); db.close(); }
  });
});


test("all four HTTP boards reuse one build on and build five times off; overview dayStart stays isolated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-cache-api-")), path = join(dir, "ledger.sqlite");
  const previous = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
  const db = openLedger(path);
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "One", kind: "code" });
  const projects = join(dir, "projects.json");
  writeFileSync(projects, JSON.stringify({ projects: [{ id: "p", dirs: [] }] }));
  setLedgerApiProjectsForTest(projects);
  setLedgerFeedForTest({ path, emit: () => {} });
  const read = ledgerDb()!, prepare = spyOn(read, "prepare");
  const principal: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01T00:00:00Z", terminal: true };
  const call = async (endpoint: string, query = "") => {
    const path = `/ledger/p${endpoint === "ledger" ? "" : `/${endpoint}`}`;
    const req = new Request(`http://bridge.local/api/v1${path}${query}`), url = new URL(req.url);
    const response = endpoint === "dag" ? await handleLedgerDagApi(req, path, principal, url)
      : endpoint === "ledger" ? await handleLedgerApi(req, path, principal)
        : endpoint === "product" ? await handleProductBoardApi(req, path, principal, url) : await handleWorkBoardApi(req, path, principal);
    expect(response?.status).toBe(200);
    return response!.json();
  };
  // ledger / product 不再整项目读事件（agents-LEDGERFAST1），改数每次构建只跑一次的 listTasks；dag / work 照旧数整项目读事件
  const buildSql = (endpoint: string) => endpoint === "ledger" || endpoint === "product"
    ? "SELECT * FROM tasks WHERE project = ? ORDER BY id" : "SELECT * FROM events WHERE project = ? ORDER BY seq";
  const builds = (endpoint: string) => prepare.mock.calls.filter(([sql]) => sql === buildSql(endpoint)).length;
  try {
    for (const mode of ["on", "off"] as const) {
      writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { boardBuildCache: mode } } } }));
      for (const endpoint of ["dag", "ledger", "product", "work"]) {
        const count = builds(endpoint), first = await call(endpoint);
        for (let i = 1; i < 5; i++) {
          const next = await call(endpoint);
          if (mode === "on") expect(next).toEqual(first);
        }
        expect(builds(endpoint) - count).toBe(mode === "on" ? 1 : 5);
      }
    }
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { boardBuildCache: "on" } } } }));
    const count = builds("ledger"), dayStart = Date.now() - 1000;
    await call("ledger", `?dayStart=${dayStart}`);
    await call("ledger", `?dayStart=0${dayStart}`);
    expect(builds("ledger") - count).toBe(1);
    await call("ledger", `?dayStart=${dayStart - 1000}`);
    expect(builds("ledger") - count).toBe(2);
  } finally {
    prepare.mockRestore(); setLedgerFeedForTest(undefined); setLedgerApiProjectsForTest(undefined);
    closeLedger(path); rmSync(dir, { recursive: true, force: true });
    if (previous) writeFileSync(RECOVERY_POLICY_PATH, previous); else rmSync(RECOVERY_POLICY_PATH, { force: true });
  }
});
