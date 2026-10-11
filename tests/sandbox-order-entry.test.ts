import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getOrder, openLendJournal, patchOrder } from "../src/lib/lend-journal.ts";
import { bindLendSandbox, sandboxOwnersDir, type SandboxRetireRequest } from "../src/lib/lend-sandbox.ts";
import { identityVerdict, listSandboxOwners, probeProcess } from "../src/lib/sandbox-order-owner.ts";
import { harness, toStarted } from "./lend-harness.ts";
import { Fleet, gateHit, gateShell, type StartSpec } from "./sandbox-isolation-start-fixture.ts";
import { testChildEnv } from "./test-env.ts";

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
  await toStarted(h);
  const row = patchOrder(h.db, "o1", ["started"], { leaseUntil: Date.now() + 300_000 }, h.d.now());
  await bindLendSandbox(row, journal);
  const owners = sandboxOwnersDir(journal), requests: SandboxRetireRequest[] = [];
  h.d.sandbox = { owners, mode: () => mode, active: () => {}, card: () => undefined,
    retire: async (r) => { requests.push(r); return { status: "retained", reason: "测试只收事实，不执行回收" }; } };
  const env = testChildEnv({ HOME: home, TMPDIR: join(base, "tmp"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime,
    CLAUDESTRA_SANDBOX_PARENT_PID: String(process.pid) });
  const spec = (name: string): StartSpec => ({ root: join(base, name), cwd: clone, env: () => env, avoid: [3847, 23998, 23999],
    maxAttempts: 1, deadline: Date.now() + 30_000,
    argv: (sub, port) => [process.execPath, "--no-env-file", "--config=/dev/null", SCRIPT, sub, "--root", join(base, name), "--port", String(port)] });
  return { base, h, owners, requests, spec, env, clone };
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

test("off 与无绑定普通沙箱仍可 up/down，不登记或调用端口", async () => {
  const w = await world("off");
  try {
    await fleet.start(w.spec("off"));
    expect(await fleet.stop(w.spec("off").root)).toEqual([]);
    writeFileSync(join(w.base, "state", "scheduler.json"), JSON.stringify({ enabled: false, projects: {}, lifecycle: "on" }));
    await expect(fleet.start(w.spec("off"))).rejects.toThrow("已有沙箱不追认");
    rmSync(join(w.clone, ".git", "claudestra-sandbox-owner.json"));
    rmSync(join(w.clone, ".git"), { recursive: true });
    writeFileSync(join(w.clone, ".git"), "gitdir: ordinary-worktree\n");
    await fleet.start(w.spec("ordinary"));
    expect(readdirSync(join(w.owners, "records"))).toEqual([]);
    expect(w.requests).toEqual([]);
  } finally { try { expect(await fleet.stopAll()).toEqual([]); } finally { w.h.db.close(); } }
}, 60_000);
