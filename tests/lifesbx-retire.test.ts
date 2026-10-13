/**
 * LIFESBX1：订单沙箱与订单副本的回收都只经 LIFE1 入口（agent-lifecycle-run.ts runSandboxRetire / runLendWorkRetire）。
 * 真实子进程（perl sleep）登记在 /tmp 临时根下：on 且证据齐才真的停掉；observe、身份说不清、快照后记录变了都零信号。
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLendWorkRetire, runSandboxRetire } from "../src/lib/agent-lifecycle-run.ts";
import { orderDir } from "../src/lib/lend-clone.ts";
import { settleOrder, withSandboxRetire } from "../src/lib/lend-drive.ts";
import { advance, getOrder, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.ts";
import type { SandboxRetireRequest } from "../src/lib/lend-sandbox.ts";
import { lendTickWithRetention, STOPPED_RETENTION_MS as DAY, sweepStoppedWork } from "../src/lib/lend-work-retention.ts";
import { workerName } from "../src/lib/lend-worker-name.ts";
import { ownerRecordId, probeProcess, readSandboxOwner, registerSandboxOwner, type SandboxOwnerRecord } from "../src/lib/sandbox-order-owner.ts";
import { harness, toStarted } from "./lend-harness.ts";

const roots: string[] = [], children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const p of children.splice(0)) { p.kill("SIGKILL"); await p.exited; }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const alive = async (pid: number) => (await probeProcess(pid)).state === "alive";

/** 一张已到终态的单 + 一个登记在它名下的真实子进程；sandbox 端口不带 retire，和 lend-deps.ts 装出来的一样 */
async function fixture(mode: "on" | "observe" | "off" = "on") {
  const h = harness(); await toStarted(h); h.registry.clear();
  const base = mkdtempSync("/tmp/lsx-"); roots.push(base);
  const root = join(base, "sandbox"), owners = join(base, "owners"), tmp = join(base, "owned-tmp");
  mkdirSync(root); mkdirSync(tmp);
  const live = getOrder(h.db, "o1")!;
  const key = { orderId: live.orderId, worker: live.agent!, generation: live.leaseGen!, scope: "test" };
  const p = Bun.spawn(["perl", "-e", "sleep 300"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  children.push(p);
  await registerSandboxOwner(owners, { key, root, dirs: [root, tmp], resources: [{ kind: "child", pid: p.pid }] });
  h.d.sandbox = { owners, mode: () => mode, card: () => undefined, active: () => {} };
  const row = advance(h.db, "o1", "started", "cancelled", { settle: { notify: null, removeDir: true } }, h.d.now());
  const record = () => {
    const r = readSandboxOwner(owners, key, false);
    if (r.status !== "ok") throw new Error(r.reason);
    return r.record;
  };
  return { h, row, root, tmp, owners, key, pid: p.pid, record, file: join(owners, "records", `${ownerRecordId(key)}.json`) };
}

test("on：结单经 LIFE1 入口停掉登记进程、删登记的临时目录、留根，之后才删副本并清收尾", async () => {
  const f = await fixture();
  try {
    await settleOrder(f.row, withSandboxRetire(f.h.d));
    expect(await alive(f.pid)).toBe(false);
    expect(existsSync(f.tmp)).toBe(false);
    expect(existsSync(f.root)).toBe(true);
    expect(f.record().cleanup).toMatchObject({ done: true, attempts: 1 });
    expect(f.h.log.removed).toEqual(["o1"]);
    expect(getOrder(f.h.db, "o1")!.settle).toBeNull();
  } finally { f.h.db.close(); }
}, 30_000);

test("生产一轮（lendTickWithRetention）自己接上回收端口；不经它的调用方仍是只报告", async () => {
  const f = await fixture();
  try {
    await settleOrder(f.row, f.h.d);
    expect(await alive(f.pid)).toBe(true);
    expect(f.h.log.lines.join("\n")).toContain("回收入口未接");
    expect(f.h.log.removed).toEqual([]);
    patchOrder(f.h.db, "o1", ["cancelled"], { settle: { notify: null, removeDir: true } }, f.h.d.now());
    await lendTickWithRetention(f.h.d, () => {}, join(f.owners, "..", "lend-root"));
    expect(await alive(f.pid)).toBe(false);
    expect(f.h.log.removed).toEqual(["o1"]);
    expect(f.h.d.sandbox!.retire).toBeUndefined();
  } finally { f.h.db.close(); }
}, 30_000);

test("observe / off 沿用 SBXC2 开关：observe 只保全不发信号，off 走原收尾，进程都不动", async () => {
  for (const mode of ["observe", "off"] as const) {
    const f = await fixture(mode);
    try {
      await settleOrder(f.row, withSandboxRetire(f.h.d));
      expect(await alive(f.pid)).toBe(true);
      expect(existsSync(f.tmp)).toBe(true);
      expect(f.record().cleanup).toBeUndefined();
      expect(f.h.log.removed).toEqual(mode === "off" ? ["o1"] : []);
    } finally { f.h.db.close(); }
  }
}, 30_000);

test("状态不明只报告：身份对不上、worker 活性未知、关联本机卡都零信号、不删、收尾留着重试", async () => {
  const cases: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => { const r = JSON.parse(readFileSync(f.file, "utf8")); r.resources[0].startedAt -= 1000; writeFileSync(f.file, JSON.stringify(r)); },
    (f) => { f.h.liveness.set(f.row.agent!, "unknown"); },
    (f) => { f.h.d.sandbox!.card = () => ({ taskId: "T1" }) as never; },
  ];
  for (const spoil of cases) {
    const f = await fixture();
    try {
      spoil(f);
      await settleOrder(f.row, withSandboxRetire(f.h.d));
      expect(await alive(f.pid)).toBe(true);
      expect(existsSync(f.tmp)).toBe(true);
      expect(f.h.log.removed).toEqual([]);
      expect(getOrder(f.h.db, "o1")!.settle).not.toBeNull();
    } finally { f.h.db.close(); }
  }
}, 30_000);

test("端口只认快照时的那份记录和那一代订单；已给的端口不被替换", async () => {
  const f = await fixture();
  try {
    const d = withSandboxRetire(f.h.d), retire = d.sandbox!.retire!;
    const request = (owner: SandboxOwnerRecord) => ({ owner, order: {}, observations: [], evidence: {} }) as unknown as SandboxRetireRequest;
    expect(await retire(request({ ...f.record(), createdAt: 1 }))).toEqual({ status: "retained", reason: "属主记录在快照后变了" });
    const snapshot = f.record();
    patchOrder(f.h.db, "o1", ["cancelled"], { leaseGen: 7 }, f.h.d.now());
    expect(await retire(request(snapshot))).toEqual({ status: "retained", reason: "订单 / worker / 代次已不是快照里的那一代" });
    expect(await alive(f.pid)).toBe(true);
    expect(f.record().cleanup).toBeUndefined();
    const given = { ...f.h.d, sandbox: { ...f.h.d.sandbox!, retire: async () => ({ status: "retained" as const }) } };
    expect(withSandboxRetire(given)).toBe(given);
  } finally { f.h.db.close(); }
}, 30_000);

test("执行器自己也拒：记录没冻结、或计划不是这份记录登记的资源，一个信号都不发", async () => {
  const f = await fixture();
  try {
    const signals: number[] = [], record = f.record();
    const deps = { probe: probeProcess, signal: (pid: number) => void signals.push(pid), graceMs: 10, killWaitMs: 10, authorize: async () => {} };
    const plan = record.resources.map((r) => ({ r, verdict: "same" as const }));
    await expect(runSandboxRetire(record, plan, deps)).rejects.toThrow("没有冻结");
    const frozen = { ...record, cleanup: { attempts: 1, lastAt: 1, done: false, outcomes: [] } };
    await expect(runSandboxRetire(frozen, [{ r: { ...record.resources[0]! }, verdict: "same" }], deps)).rejects.toThrow("不是这份属主记录登记的资源");
    await expect(runSandboxRetire({ ...frozen, cleanup: { ...frozen.cleanup, done: true } }, plan, deps)).rejects.toThrow("没有冻结");
    expect(signals).toEqual([]);
    expect(await alive(f.pid)).toBe(true);
  } finally { f.h.db.close(); }
});

test("副本回收入口：复核抛了就不删；结单删副本前订单换了代就留着", async () => {
  const removed: string[] = [];
  expect(() => runLendWorkRetire({ orderId: "x", assertCurrent: () => { throw new Error("变了"); } }, { remove: (id) => void removed.push(id) })).toThrow("变了");
  runLendWorkRetire({ orderId: "y", assertCurrent: () => {} }, { remove: (id) => void removed.push(id) });
  expect(removed).toEqual(["y"]);
  const h = harness();
  try {
    await toStarted(h); h.registry.clear();
    const row = advance(h.db, "o1", "started", "cancelled", { settle: { notify: null, removeDir: true } }, h.d.now());
    h.d.reapOrder = async () => { patchOrder(h.db, "o1", ["cancelled"], { leaseGen: 9 }, h.d.now()); };
    await settleOrder(row, h.d);
    expect(h.log.removed).toEqual([]);
    expect(h.log.lines.join("\n")).toContain("订单状态 / 代次已变，不删");
  } finally { h.db.close(); }
});

test("保留期清扫经同一入口：到期批次里已不是 stopped 的单不删，仍是 stopped 的照删", () => {
  const home = mkdtempSync(join(tmpdir(), "lsx-sweep-")); roots.push(home);
  const root = join(home, "lend"), db = openLendJournal(join(root, "journal.sqlite")), NOW = 10 * DAY, lines: string[] = [];
  try {
    for (const id of ["kept", "gone"]) {
      recordAsked(db, { orderId: id, peer: "test", fp: null, family: "codex", preview: {} }, NOW - DAY - 100);
      db.query("UPDATE lend_orders SET state = 'stopped', updatedAt = ?, agent = ? WHERE orderId = ?").run(NOW - DAY, workerName(id), id);
      for (const area of ["work", "push"] as const) mkdirSync(orderDir(id, root, area), { recursive: true });
    }
    const batch = ["kept", "gone"].map((id) => ({ row: { orderId: id, updatedAt: NOW - DAY }, kept: { stoppedAt: NOW - DAY } }));
    db.query("UPDATE lend_orders SET state = 'started' WHERE orderId = 'kept'").run(); // 批次算好之后被重新领走
    expect(sweepStoppedWork(db, { root, now: NOW, batch, log: (m) => lines.push(m), removeConfig: () => {} })).toBe(2);
    expect(existsSync(orderDir("kept", root)) && existsSync(orderDir("kept", root, "push"))).toBe(true);
    expect(existsSync(orderDir("gone", root)) || existsSync(orderDir("gone", root, "push"))).toBe(false);
    expect(lines).toEqual(["清理 stopped 单 kept 失败，下轮再试：订单已不是 stopped，不删"]);
  } finally { db.close(); }
});
