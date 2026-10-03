/**
 * 借入面板远端行的放置结果（bridge lend-peers-view.ts）与 W5 只读命令 `ledger lend-orders` 一致：同一个台账、同一份
 * scheduler.json、同一份生效借入名单下，两边给出的 {role, where, reason} 逐字相等（两边都调 lib/lend-placement-view.ts 的 placementOf）。
 * 两条路：还没派审时（放置走 reviewPlacement，结果取决于借入名单与 hello）翻 peer 可用 / hello 过期 / remote.mode = off；
 * 真实 tick 挂出之后（放置走「已派给」）。端点若换一份名单或另算，前一条会红。另查端点源码里没有 placeFor。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { borrowView, setBorrowViewDepsForTest, type RemoteRowView } from "../src/bridge/local-api/lend-peers-view.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const MIN = 60_000;
const BORROW: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 2 }, { peer: "b", projects: ["p"], roles: ["review"], maxOpen: 2 }];

async function ready() {
  const f = autoFixture();
  const work = join(f.dir, "repo");
  mkdirSync(work);
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const sched = join(f.dir, "scheduler.json");
  const writeSched = (mode: "balance" | "off") => writeFileSync(sched, JSON.stringify({ enabled: true, projects: {
    p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: work, remote: { mode, roles: ["review"], poolTimeoutMin: 15 } } } }));
  writeSched("balance");
  const lendPath = join(f.dir, "lend.json");
  writeFileSync(lendPath, JSON.stringify({ version: 1, enabled: false, lend: [], borrow: BORROW }));
  const projects: ProjectDef[] = [{ id: "p", name: "P", dirs: [work], createdAt: "2026-09-29T00:00:00Z" }];
  setBorrowViewDepsForTest({ db: () => f.db, lendPath, schedulerPath: sched, now: f.tickDeps.now,
    context: async () => ({ contacts: [{ name: "mate" }, { name: "b" }], projects }) });
  // CLI 这边读同一份 scheduler.json 与同一份名单：比的是同一个快照
  const policy = (p: string) => readSchedulerConfig(sched).projects[p] ?? null;
  const lend = { borrow: async () => BORROW, notifyPm: async () => {}, schedulerPolicy: policy };
  const cli = (...args: string[]) => f.cliWith({ lend } as never, "pm", ...args) as Promise<Record<string, any>>;
  const tick = async () => {
    const deps = { ...f.tickDeps, manager: (...a: string[]) => f.cliWith({ lend } as never, "scheduler", ...a.slice(1)), borrow: async () => BORROW };
    const r = await schedulerAutoTick(f.db, { p: readSchedulerConfig(sched).projects.p! }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
  };
  let seq = 0;
  const hello = (peer: string) => recordHello(f.db, peer, null, { v: 1, proto: 2, boot: `boot-${peer}`, seq: ++seq,
    slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null,
    grant: { until: f.tickDeps.now() + 3_600_000, roles: ["review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  /** 端点给 T1 的放置（每一行都要相同）与 lend-orders 的放置 */
  const both = async () => {
    const rows = ((await borrowView()).remote as RemoteRowView[]).filter((r) => r.taskId === "T1");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.placement).toEqual(rows[0]!.placement);
    return { view: rows[0]!.placement, cli: (await cli("lend-orders", "T1")).placement };
  };
  /** 一条还没结的出借单（不经调度器，台账里没有对应的派审意图） */
  const order = (peer: string) => f.db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text,
    sha256, status, leaseMs, leaseUntil, createdBy, createdAt, updatedAt) VALUES (?, 'T1', 'p', ?, 'codex', 'review', 1, 1, ?, 'o/r', '{}', 't', 's', 'claimed',
    60000, ?, 'owner', ?, ?)`).run(`ord-${peer}`, peer, H1, f.tickDeps.now() + 60_000, f.tickDeps.now(), f.tickDeps.now());
  return { f, tick, hello, both, order, writeSched, close: () => { setBorrowViewDepsForTest(); f.close(); } };
}

describe("远端行的放置 = ledger lend-orders 的放置", () => {
  test("还没派审：peer 可用、hello 过期、remote.mode = off 三种快照下逐字相等", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      p.hello("b");
      p.order("b");
      const fresh = await p.both();
      expect(fresh.view).toEqual(fresh.cli);
      expect(fresh.view).toMatchObject({ role: "review", where: expect.stringMatching(/^peer:/) });

      p.f.advance(10 * MIN);
      const stale = await p.both();
      expect(stale.view).toEqual(stale.cli);
      expect(stale.view).toMatchObject({ where: "local" });

      p.writeSched("off");
      const off = await p.both();
      expect(off.view).toEqual(off.cli);
      expect(off.view).toMatchObject({ where: "local", reason: expect.stringContaining("off") });
    } finally { p.close(); }
  });

  test("真实 tick 挂给 peer 之后、hello 过期之后、remote.mode 改成 off 之后，逐字相等", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      p.hello("b");
      await p.tick();
      const pooled = await p.both();
      expect(pooled.view).toEqual(pooled.cli);
      expect(pooled.view).toMatchObject({ role: "review", where: "peer:mate" });

      p.f.advance(10 * MIN);
      const stale = await p.both();
      expect(stale.view).toEqual(stale.cli);

      p.writeSched("off");
      const off = await p.both();
      expect(off.view).toEqual(off.cli);
    } finally { p.close(); }
  });

  test("端点不另算：源码里没有 placeFor / explainPlacement / autoSnapshot，只调 placementOf", () => {
    // 只看代码：先剥掉块注释与行注释（注释里提到函数名不算）
    const src = readFileSync(new URL("../src/bridge/local-api/lend-peers-view.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/placeFor|explainPlacement|autoSnapshot/);
    expect(src).toContain("placementOf(");
  });
});
