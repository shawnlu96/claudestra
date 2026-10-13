import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { advance, getOrder, openLendJournal, patchOrder } from "../src/lib/lend-journal.ts";
import { sandboxOwnersDir, type SandboxRetireRequest } from "../src/lib/lend-sandbox.ts";
import { identityVerdict, listSandboxOwners, probeProcess } from "../src/lib/sandbox-order-owner.ts";
import { lendDeps } from "../src/lib/lend-deps.ts";
import { settleOrder } from "../src/lib/lend-drive.ts";
import { harness, toStarted, polled, sha } from "./lend-harness.ts";
import { Fleet, gateHit, gateShell, type StartSpec } from "./sandbox-isolation-start-fixture.ts";
import { testChildEnv } from "./test-env.ts";
import { acquireLock } from "../src/lib/file-lock.ts";

const fleet = new Fleet(), bases: string[] = [];
const observed: SandboxRetireRequest[] = [];
const SCRIPT = process.env.SBXC2_ENTRY_SCRIPT ?? resolve(import.meta.dir, "../scripts/sandbox.ts");
afterEach(async () => {
  expect(await fleet.stopAll()).toEqual([]);
  for (const r of observed) {
    const exits = await Promise.all(r.owner.resources.map(async (p) => ({ pid: p.pid, verdict: identityVerdict(p, await probeProcess(p.pid)) })));
    console.log(`SBXC2 private facts ${JSON.stringify({ platform: process.platform, request: r, fixtureExit: exits })}`);
    expect(exits.every((e) => e.verdict === "gone")).toBe(true);
  }
  observed.length = 0;
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

async function world(mode: "on" | "observe" | "off" = "on") {
  const base = mkdtempSync("/tmp/sxc2-"); bases.push(base);
  const home = join(base, "home"), clone = join(base, "clone"), state = join(base, "state"), runtime = join(base, "runtime");
  for (const d of [home, join(clone, ".git"), state, runtime, join(base, "tmp")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: false, projects: {}, lifecycle: mode }));
  const journal = join(state, "lend", "journal.sqlite"), h = harness();
  h.db.close(); h.db = openLendJournal(journal); h.d.db = h.db;
  h.d.clone = async () => ({ ok: true, dir: clone });
  const creates: string[] = [];
  const production = lendDeps(h.db, { get: () => undefined } as never, () => {}, undefined, (_lease, extra) => async (...args) => {
    if (args[0] === "project-add") return { ok: true };
    expect(args[0]).toBe("create");
    expect(Object.values(extra ?? {})).toContain("o1");
    expect(existsSync(join(clone, ".git", "claudestra-sandbox-owner.json"))).toBe(true);
    creates.push(args[1]!); h.registry.set(args[1]!, { sessionId: "fake-session", cwd: clone });
    return { ok: true };
  });
  h.d.worker.create = production.worker.create;
  await toStarted(h);
  expect(creates).toHaveLength(1);
  patchOrder(h.db, "o1", ["started"], { leaseUntil: Date.now() + 300_000 }, h.d.now());
  const owners = sandboxOwnersDir(journal), requests: SandboxRetireRequest[] = [];
  h.d.sandbox = { owners, mode: () => mode, active: () => {}, card: () => undefined,
    retire: async (r) => { requests.push(r); return { status: "retained", reason: "测试只收事实，不执行回收" }; } };
  const env = testChildEnv({ HOME: home, TMPDIR: join(base, "tmp"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime,
    CLAUDESTRA_SANDBOX_PARENT_PID: String(process.pid) });
  const spec = (name: string): StartSpec => ({ root: join(base, name), cwd: clone, env: () => env, avoid: [3847, 23998, 23999],
    maxAttempts: 1, deadline: Date.now() + 30_000,
    argv: (sub, port) => [process.execPath, "--no-env-file", "--config=/dev/null", SCRIPT, sub, "--root", join(base, name), "--port", String(port)] });
  return { base, h, owners, requests, spec, env, clone, production };
}

test("两套真实隔离 up → 订单结束 → 正规 settle → 注入端口；活单不调用，未知回收不假 done", async () => {
  const w = await world();
  try {
    const a = await fleet.start(w.spec("a")), b = await fleet.start(w.spec("b"));
    const catalog = listSandboxOwners(w.owners);
    expect(catalog.status).toBe("ok");
    if (catalog.status !== "ok") throw new Error(catalog.reason);
    expect(catalog.entries).toHaveLength(2);
    for (const entry of catalog.entries) {
      if (entry.read.status !== "ok") throw new Error(entry.read.reason);
      expect(entry.read.record.resources.map((r) => r.kind)).toEqual(["tmux", "child", "bridge"]);
      expect(entry.read.record.key).toMatchObject({ orderId: "o1", worker: getOrder(w.h.db, "o1")!.agent, generation: 1 });
      for (const r of entry.read.record.resources) expect(await probeProcess(r.pid)).toMatchObject({ state: "alive", commandHash: r.commandHash, startedAt: r.startedAt });
    }
    expect(w.requests).toHaveLength(0);
    writeFileSync(join(w.owners, "records", "other-order-corrupt.json"), "invalid");
    w.h.registry.clear();
    // Cancellation is delivered through the normal lender tick, not a direct leaf cleanup.
    w.h.A.lease = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
    w.h.advanceTime(61_000);
    await w.h.tick();
    expect(getOrder(w.h.db, "o1")!.state).toBe("cancelled");
    expect(w.requests).toHaveLength(2);
    expect(w.h.log.removed).toEqual([]);
    expect(getOrder(w.h.db, "o1")!.settle).not.toBeNull();
    expect(w.requests.map((r) => r.owner.resources.find((p) => p.kind === "bridge")!.pid).sort()).toEqual([a.pid, b.pid].sort());
    for (const r of w.requests) {
      observed.push(r);
      const bytes = readFileSync(r.evidence.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(r.evidence.sha256);
      expect(JSON.parse(bytes.toString()).record).toEqual(r.owner);
      expect(r.order).toMatchObject({ orderId: "o1", generation: 1, state: "cancelled" });
      expect(r.observations.every((o) => o.verdict === "same")).toBe(true);
    }
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 60_000);

test("启动前根已登记；tmux 失败保留记录且未发成功证据", async () => {
  const w = await world();
  try {
    const bin = join(w.base, "bin"), gate = join(w.base, "gate"); mkdirSync(bin); writeFileSync(gate, "wait");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\n${gateShell(gate)}\nexit 1\n`); chmodSync(join(bin, "tmux"), 0o755);
    w.env.PATH = `${bin}:${w.env.PATH}`;
    const spec = w.spec("failed");
    const running = fleet.start(spec).then(() => "unexpected success", (e: Error) => e.message);
    await gateHit(gate, 5000);
    const before = listSandboxOwners(w.owners);
    expect(before.status).toBe("ok");
    if (before.status !== "ok") throw new Error(before.reason);
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0]!.read).toMatchObject({ status: "ok", record: { resources: [], dirs: [{ path: expect.any(String) }] } });
    rmSync(gate);
    expect(await running).toContain("沙箱 up 失败");
    expect(existsSync(join(w.owners, "archive"))).toBe(false);
    expect(listSandboxOwners(w.owners).status).toBe("ok");
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 30_000);

test("off 与无绑定普通沙箱仍可 up/down；mode flip 保留未登记事实、不删副本", async () => {
  const w = await world("off");
  try {
    await fleet.start(w.spec("off"));
    w.h.d.sandbox!.mode = () => "observe";
    w.h.A.lease = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
    w.h.advanceTime(61_000);
    await w.h.tick();
    expect(w.h.log.removed).toEqual([]);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    const files = readdirSync(join(w.owners, "deferred"));
    expect(readFileSync(join(w.owners, "deferred", files[0]!), "utf8")).toContain("off 启动未登记资源");
    expect(await fleet.stop(w.spec("off").root)).toEqual([]);
    writeFileSync(join(w.base, "state", "scheduler.json"), JSON.stringify({ enabled: false, projects: {}, lifecycle: "on" }));
    await expect(fleet.start(w.spec("off"))).rejects.toThrow("订单非活代次");
    rmSync(join(w.clone, ".git", "claudestra-sandbox-owner.json"));
    rmSync(join(w.clone, ".git"), { recursive: true });
    writeFileSync(join(w.clone, ".git"), "gitdir: ordinary-worktree\n");
    await fleet.start(w.spec("ordinary"));
    expect(readdirSync(join(w.owners, "records"))).toEqual([]);
    expect(w.requests).toEqual([]);
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 60_000);


test("on 同单 down/up 同根更新自己的资源身份", async () => {
  const w = await world();
  try {
    const first = await fleet.start(w.spec("restart"));
    expect(await fleet.stop(w.spec("restart").root)).toEqual([]);
    const second = await fleet.start(w.spec("restart"));
    expect(second.pid).not.toBe(first.pid);
    const owners = listSandboxOwners(w.owners);
    expect(owners.status).toBe("ok");
    if (owners.status !== "ok" || owners.entries[0]!.read.status !== "ok") throw new Error("restart owner unreadable");
    expect(owners.entries[0]!.read.record.resources.map((r) => r.pid)).toContain(second.pid);
    expect(owners.entries[0]!.read.record.resources.map((r) => r.pid)).not.toContain(first.pid);
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 30_000);

test("无沙箱删副本后收尾失败可重试；启动绑定不随 clone 删除丢失", async () => {
  const w = await world("observe");
  try {
    w.h.d.removeDir = (id) => { w.h.log.removed.push(id); rmSync(w.clone, { recursive: true }); };
    w.h.health.closeOk = false;
    w.h.A.lease = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
    w.h.advanceTime(61_000); await w.h.tick();
    expect(existsSync(w.clone)).toBe(false);
    expect(getOrder(w.h.db, "o1")!.settle?.removeDir).toBe(false);
    w.h.health.closeOk = true;
    await settleOrder(getOrder(w.h.db, "o1")!, w.h.d);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    expect(w.h.log.removed).toEqual(["o1"]);
    expect(w.h.log.receipts).toHaveLength(1);
  } finally { w.h.db.close(); }
});

test("无关坏属主记录不毒化有可信本单启动索引的结单", async () => {
  const w = await world("observe");
  try {
    writeFileSync(join(w.owners, "records", "unrelated.json"), "invalid");
    w.h.A.lease = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
    w.h.advanceTime(61_000); await w.h.tick();
    expect(w.h.log.removed).toEqual(["o1"]);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
  } finally { w.h.db.close(); }
});


test("真实 worker.create gate 拒绝前已登记 clone 外绑定，不调用 manager create", async () => {
  const w = await world("observe");
  try {
    rmSync(join(w.clone, ".git", "claudestra-sandbox-owner.json"));
    let gated = false;
    const r = await w.production.worker.create("unused", w.clone, "fixture", async () => {
      gated = true;
      expect(existsSync(join(w.clone, ".git", "claudestra-sandbox-owner.json"))).toBe(true);
      expect(readdirSync(join(w.owners, "bindings"))).toHaveLength(1);
      return "fixture gate refused";
    }, "o1");
    expect(gated).toBe(true); expect(r).toEqual({ ok: false, error: "fixture gate refused" });
  } finally { w.h.db.close(); }
});


test("已登记根 down 后在 off 重启，切回 on 仍按未登记资源保留", async () => {
  const w = await world();
  try {
    await fleet.start(w.spec("flip"));
    expect(await fleet.stop(w.spec("flip").root)).toEqual([]);
    writeFileSync(join(w.base, "state", "scheduler.json"), JSON.stringify({ enabled: false, projects: {}, lifecycle: "off" }));
    await fleet.start(w.spec("flip"));
    w.h.A.lease = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
    w.h.advanceTime(61_000); await w.h.tick();
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    expect(w.h.log.removed).toEqual([]); expect(w.requests).toEqual([]);
    expect(w.h.log.lines.join("\n")).toContain("off 启动未登记资源");
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 30_000);

test("启动索引丢失不得被 worker.create 重建为空，也不得因此删副本", async () => {
  const w = await world("observe");
  try {
    rmSync(join(w.owners, "bindings"), { recursive: true });
    await expect(w.production.worker.create("unused", w.clone, "fixture", async () => null, "o1")).rejects.toThrow("不追认无沙箱");
    w.h.A.lease = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
    w.h.advanceTime(61_000); await w.h.tick();
    expect(w.h.log.removed).toEqual([]);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    expect(w.h.log.lines.join("\n")).toContain("legacy");
  } finally { w.h.db.close(); }
});

async function cancelWorld(w: Awaited<ReturnType<typeof world>>) {
  w.h.A.lease = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
  w.h.advanceTime(61_000); await w.h.tick();
}

async function cleanSandbox(spec: StartSpec) {
  const argv = spec.argv("down", 24000); argv[4] = "clean";
  const p = Bun.spawn(argv, { cwd: spec.cwd, env: spec.env(), stdout: "pipe", stderr: "pipe" });
  await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(await p.exited).toBe(0); expect(existsSync(spec.root)).toBe(false);
}

test("observe clean 后结单清 settle 并保全缺根事实", async () => {
  const w = await world("observe");
  try {
    const spec = w.spec("cleaned"); await fleet.start(spec);
    expect(await fleet.stop(spec.root)).toEqual([]);
    await cleanSandbox(spec);
    await cancelWorld(w);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    expect(w.h.log.removed).toEqual([]); expect(w.requests).toEqual([]);
    expect(readdirSync(join(w.owners, "deferred"))).toHaveLength(1);
  } finally { w.h.db.close(); }
}, 60_000);

test("result 被拒且无沙箱照常结单", async () => {
  const w = await world("observe");
  try {
    advance(w.h.db, "o1", "started", "result_pending", { payload: { result: "pending" }, payloadSha: sha(JSON.stringify({ result: "pending" })) }, w.h.d.now());
    w.h.A.result = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "cancelled" } });
    await w.h.tick();
    expect(getOrder(w.h.db, "o1")!.state).toBe("cancelled");
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    expect(w.h.log.removed).toEqual(["o1"]);
  } finally { w.h.db.close(); }
});

for (const clean of [false, true]) test(`observe 跨订单 ${clean ? "clean" : "down"} 后同根可启动`, async () => {
  const w = await world("observe");
  try {
    const spec = w.spec("reuse"); await fleet.start(spec);
    expect(await fleet.stop(spec.root)).toEqual([]);
    if (clean) await cleanSandbox(spec);
    await cancelWorld(w);
    const clone = join(w.base, "clone2"); mkdirSync(join(clone, ".git"), { recursive: true });
    w.h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [polled("o2")], pollAfterMs: 30_000 } });
    w.h.d.clone = async () => ({ ok: true, dir: clone });
    w.h.d.worker.create = async (agent, dir, purpose, gate, id) => {
      const r = await w.production.worker.create(agent, dir, purpose, async () => "fixture gate", id);
      expect(r.ok).toBe(false); w.h.registry.set(agent, { sessionId: "fixture2", cwd: clone }); return { ok: true };
    };
    w.h.A.lease = (b) => ({ status: 200, body: { ok: true, v: 1, lease: b.action === "renew" ? { gen: 1, expiresAt: 0, ms: 600_000 } : null } });
    w.h.advanceTime(31_000); for (let i = 0; i < 5; i++) await w.h.tick();
    patchOrder(w.h.db, "o2", ["started"], { leaseUntil: Date.now() + 300_000 }, w.h.d.now());
    const records = readdirSync(join(w.owners, "records")).map((f) => readFileSync(join(w.owners, "records", f), "utf8"));
    await fleet.start({ ...w.spec("reuse"), cwd: clone });
    expect(readdirSync(join(w.owners, "records")).map((f) => readFileSync(join(w.owners, "records", f), "utf8"))).toEqual(records);
    w.h.registry.clear(); await cancelWorld(w);
    expect(getOrder(w.h.db, "o2")!.settle).toBeNull(); expect(w.requests).toEqual([]);
    expect(w.h.log.removed).toEqual([]);
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 60_000);

test("属主登记拒绝不污染结单", async () => {
  const w = await world("on");
  try {
    writeFileSync(join(w.owners, "records", "corrupt.json"), "invalid");
    await expect(fleet.start(w.spec("refused"))).rejects.toThrow("说不清的记录");
    const catalog = JSON.parse(readFileSync(join(w.owners, "bindings", readdirSync(join(w.owners, "bindings"))[0]!), "utf8"));
    expect(catalog.sandboxes).toEqual([]);
    await cancelWorld(w);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull(); expect(w.h.log.removed).toEqual(["o1"]);
  } finally { w.h.db.close(); }
}, 30_000);

for (const mode of ["off", "observe"] as const) test(`${mode} 真实 up 不受出借 journal 写锁阻塞`, async () => {
  const w = await world(mode);
  const writer = new Database(w.h.db.filename);
  try {
    const spec = w.spec("busy");
    if (mode === "observe") {
      await fleet.start(spec);
      expect(await fleet.stop(spec.root)).toEqual([]);
    }
    writer.exec("BEGIN IMMEDIATE");
    await fleet.start(spec);
    expect(listSandboxOwners(w.owners).status).toBe("ok");
  } finally {
    writer.exec("ROLLBACK"); writer.close();
    try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); }
  }
}, 60_000);

for (const mode of ["off", "observe"] as const) test(`${mode} catalog 锁占用仍启动且不留下悬空属主`, async () => {
  const w = await world(mode);
  const file = join(w.owners, "bindings", readdirSync(join(w.owners, "bindings"))[0]!);
  const lock = await acquireLock(`${file}.lock`, 0);
  if (!lock) throw new Error("fixture lock unavailable");
  try {
    await fleet.start(w.spec("locked-catalog"));
    expect(readdirSync(join(w.owners, "records"))).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).sandboxes).toEqual([]);
    w.h.d.sandbox!.mode = () => "on";
    await cancelWorld(w);
    expect(w.h.log.removed).toEqual([]); expect(w.requests).toEqual([]);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
  } finally { lock.release(); try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 60_000);

test("off catalog 丢失仍启动，切 on 保全独立未登记事实", async () => {
  const w = await world("off");
  try {
    rmSync(join(w.owners, "bindings"), { recursive: true });
    await fleet.start(w.spec("missing-catalog"));
    w.h.d.sandbox!.mode = () => "on";
    await cancelWorld(w);
    expect(w.h.log.removed).toEqual([]); expect(w.requests).toEqual([]);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    expect(w.h.log.lines.join("\n")).toContain("off 启动未登记资源");
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 30_000);

test("on clean 后结单向端口交缺根事实，retained 保留收尾，done 才完成", async () => {
  const w = await world("on");
  try {
    const spec = w.spec("cleaned-on"); await fleet.start(spec);
    expect(await fleet.stop(spec.root)).toEqual([]);
    await cleanSandbox(spec);
    await cancelWorld(w);
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]!.observations.every((o) => o.verdict === "gone")).toBe(true);
    expect(getOrder(w.h.db, "o1")!.settle).not.toBeNull();
    w.h.d.sandbox!.retire = async (r) => { w.requests.push(r); return { status: "done" }; };
    await settleOrder(getOrder(w.h.db, "o1")!, w.h.d);
    expect(w.requests).toHaveLength(2);
    expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
  } finally { w.h.db.close(); }
}, 60_000);

for (const mode of ["on", "observe"] as const) test(`${mode} catalog 写失败回滚已写属主登记`, async () => {
  const w = await world(mode);
  const file = join(w.owners, "bindings", readdirSync(join(w.owners, "bindings"))[0]!);
  const original = readFileSync(file);
  mkdirSync(join(w.owners, "locks"));
  const lock = await acquireLock(join(w.owners, "locks", "ownership.lock"), 0);
  if (!lock) throw new Error("fixture owner lock unavailable");
  try {
    const running = fleet.start(w.spec("catalog-write-failure")).then(() => "started", (e: Error) => e.message);
    const deadline = Date.now() + 5000;
    while (!existsSync(`${file}.lock`)) {
      if (Date.now() > deadline) throw new Error("catalog lock not reached");
      await Bun.sleep(10);
    }
    rmSync(file); mkdirSync(file); // Force the catalog rename to fail after the owner write, without mocking production wiring.
    lock.release();
    const result = await running;
    expect(mode === "observe" ? result === "started" : result.includes("EISDIR")).toBe(true);
    expect(readdirSync(join(w.owners, "records"))).toEqual([]);
    expect(readdirSync(join(w.owners, "archive"))).toHaveLength(1);
    rmSync(file, { recursive: true }); writeFileSync(file, original);
    if (mode === "observe") {
      await cancelWorld(w);
      expect(w.h.log.removed).toEqual([]); expect(w.requests).toEqual([]);
      expect(getOrder(w.h.db, "o1")!.settle).toBeNull();
    }
  } finally { lock.release(); try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 30_000);
