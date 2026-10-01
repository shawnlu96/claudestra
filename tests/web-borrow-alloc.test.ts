/**
 * i28-Q1 网页分配表：从「点档位」到「下一张审查单派到 first 机器」走一遍真链路——网页 PUT → bridge 拼的 argv → CLI 的组条目函数
 * （buildBorrowSet，lend.json 写锁里沿用没带的字段）→ 生效借入名单 → 真实调度 tick 的派审（验收线 1）；本机档位走 scheduler-local（owner 身份）。
 * 另查：改一格不冲掉别的字段（验收线 7）、额度读不到 GET 照常 200 且不影响派单（验收线 2）、写门与形状、网页的纯函数。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { borrowView, setBorrowViewDepsForTest, type RemoteRowView } from "../src/bridge/local-api/lend-peers-view.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { LedgerError } from "../src/lib/ledger-store.js";
import { readLend, updateLend } from "../src/lib/lend-config.js";
import { effectiveLend, type LendContact } from "../src/lib/lend-policy.js";
import type { Principal } from "../src/lib/principals.js";
import type { ProjectDef } from "../src/lib/projects.js";
import { notePeerQuota, resetWeekQuotaCacheForTest } from "../src/lib/quota-week.js";
import { readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { schedulerRemoteCmds } from "../src/manager/ledger-scheduler-remote-cmds.js";
import { BORROW_BOOLS, BORROW_FLAGS, buildBorrowSet } from "../src/manager/lend.js";
import { reviewFirstFor, toggleRole, weekUsed, resetIn, clampMaxOpen, parseMaxOpen, localTierDisabled } from "@/features/borrow/borrow-model";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const at = "2026-09-29T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER = effectivePrincipal({ principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true },
  credential: cred({ agents: ["*"], terminal: true, manage: true }) });
const LEGACY_FULL: Principal = { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at };
const call = (p: Principal, path: string, init?: RequestInit) => handleLocalApi(new Request(`http://x/api/v1${path}`, init), new URL(`http://x/api/v1${path}`), p);
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function ready(opts: { localQuota?: () => Promise<never> } = {}) {
  const f = autoFixture();
  const work = join(f.dir, "repo");
  mkdirSync(work);
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const sched = join(f.dir, "scheduler.json");
  writeFileSync(sched, JSON.stringify({ enabled: true, projects: {
    p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: work, remote: { mode: "balance", roles: ["review"], poolTimeoutMin: 15 } } } }, null, 2));
  const lendPath = join(f.dir, "lend.json");
  // 两台都平分时按借入顺序先给 mate；b 带着 write 角色与上限 3，改档位时它们得留着
  writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: false, lend: [], borrow: [
    { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 2 }, { peer: "b", projects: ["p"], roles: ["review", "write"], maxOpen: 3 }] }));
  const projects: ProjectDef[] = [{ id: "p", name: "P", dirs: [work], createdAt: at }];
  const contacts: LendContact[] = [{ name: "mate" }, { name: "b" }];
  const ctx = { contacts, projects };
  const calls: string[][] = [];
  /** 假 runner = CLI 的同一套解析与组条目（borrow set），scheduler-local 直接跑命令表里那条（owner 身份） */
  const run = async (args: string[]): Promise<Record<string, unknown>> => {
    calls.push(args);
    if (args[0] === "ledger") {
      const spec = schedulerRemoteCmds(sched)["scheduler-local"];
      const p = parseLedgerArgs(args.slice(1), spec.valued, spec.bools);
      if ("error" in p) return { ok: false, error: p.error };
      try { return await spec.run(new LedgerCli({ db: f.db, actor: "owner", projectIds: ["p"], now: f.tickDeps.now,
        loadRegistry: async () => ({ socket: "s", agents: {} }) as never, saveRegistry: async () => {} }, p)); }
      catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
    }
    const p = parseLedgerArgs(args.slice(2), BORROW_FLAGS, BORROW_BOOLS);
    if ("error" in p) return { ok: false, error: p.error };
    const b = await updateLend((file) => {
      const built = buildBorrowSet(p.pos[0]!, p.flags, p.bools.has("keep-unset"), file, ctx);
      if (!built.ok) return built;
      const i = file.borrow.findIndex((e) => e.peer === built.entry.peer);
      if (i >= 0) file.borrow[i] = built.entry;
      else file.borrow.push(built.entry);
      return built;
    }, lendPath);
    return b.ok ? { ok: true } : { ok: false, error: b.error };
  };
  setBorrowViewDepsForTest({ db: () => f.db as Database, lendPath, schedulerPath: sched, now: f.tickDeps.now, context: async () => ctx, run,
    localQuota: opts.localQuota ?? (async () => ({ quota: { codex: { weekUsedPct: 62, resetAt: f.tickDeps.now() + 86_400_000 } }, walled: false })) });
  const borrow = async () => effectiveLend(await readLend(lendPath), contacts, projects, f.tickDeps.now()).borrow;
  const policy = (p: string) => readSchedulerConfig(sched).projects[p] ?? null;
  const tick = async () => {
    const lend = { borrow, notifyPm: async () => {}, schedulerPolicy: policy };
    const deps = { ...f.tickDeps, manager: (...a: string[]) => f.cliWith({ lend } as never, "scheduler", ...a.slice(1)), borrow };
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
  const placed = async () => ((await borrowView()).remote as RemoteRowView[]).find((r) => r.taskId === "T1")?.placement;
  const entry = async (peer: string) => (await readLend(lendPath)).file.borrow.find((e) => e.peer === peer);
  return { f, sched, calls, tick, hello, placed, entry, close: () => { setBorrowViewDepsForTest(); resetWeekQuotaCacheForTest(); f.close(); } };
}

describe("点档位 → 派单按新档位走", () => {
  test("把 b 点成「先用」：lend.json 只改了 priority，下一张审查单派给 b（不是按顺序的 mate）", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      p.hello("b");
      expect((await call(OWNER, "/borrow/peers/b", put({ priority: "first" })))?.status).toBe(200);
      expect(p.calls).toEqual([["borrow", "set", "--keep-unset", "--priority=first", "--", "b"]]);
      expect(await p.entry("b")).toEqual({ peer: "b", projects: ["p"], roles: ["review", "write"], maxOpen: 3, priority: "first" });
      await p.tick();
      expect(await p.placed()).toMatchObject({ role: "review", where: "peer:b" });
    } finally { p.close(); }
  });

  test("本机点成「先用」、两台 peer 平分 → 审查派回本机（不点档位的对照见下面「额度读不到」：同一局面派给 mate）", async () => {
    const p = await ready();
    try {
      p.hello("mate");
      p.hello("b");
      expect((await call(OWNER, "/borrow/local/p", put({ priority: "first" })))?.status).toBe(200);
      expect(p.calls).toEqual([["ledger", "scheduler-local", "p", "--priority=first", "--reason=网页分配表"]]);
      expect(JSON.parse(readFileSync(p.sched, "utf8")).projects.p.remote).toEqual({ mode: "balance", roles: ["review"], poolTimeoutMin: 15, localPriority: "first" });
      await p.tick();
      // 派在本机 = 这一轮给审查节点建了本机审查会话、没有出借单（远端行只列出借单）
      expect(p.f.db.query("SELECT action, status, receipt FROM scheduler_intents WHERE node = 'adversarial_review'").all())
        .toEqual([{ action: "ensure_session", status: "done", receipt: "bound agent-rv-t1/s-rv" }]);
      expect(p.f.db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE taskId = 'T1'").get()).toEqual({ n: 0 });
      expect(await p.placed()).toBeUndefined();
    } finally { p.close(); }
  });
});

describe("改一格不冲掉别的（验收线 7）", () => {
  test("只改上限 / 只改角色 / 只改项目：priority 与 write 角色都留着", async () => {
    const p = await ready();
    try {
      await call(OWNER, "/borrow/peers/b", put({ priority: "low" }));
      await call(OWNER, "/borrow/peers/b", put({ maxOpen: 7 }));
      expect(await p.entry("b")).toEqual({ peer: "b", projects: ["p"], roles: ["review", "write"], maxOpen: 7, priority: "low" });
      await call(OWNER, "/borrow/peers/b", put({ roles: ["write"] }));
      expect(await p.entry("b")).toEqual({ peer: "b", projects: ["p"], roles: ["write"], maxOpen: 7, priority: "low" });
      await call(OWNER, "/borrow/local/p", put({ maxActiveWorkers: 5 }));
      expect(JSON.parse(readFileSync(p.sched, "utf8")).projects.p).toMatchObject({ maxActiveWorkers: 5, remote: { mode: "balance", roles: ["review"], poolTimeoutMin: 15 } });
    } finally { p.close(); }
  });

  test("形状不对 400、不起 CLI：空体、不认识的键、空角色 / 未知角色 / 重复角色、坏档位、本机上限越界", async () => {
    const p = await ready();
    try {
      const bad: [string, unknown][] = [
        ["/borrow/peers/b", {}], ["/borrow/peers/b", { priority: "first", roles: ["review"], extra: 1 }], ["/borrow/peers/b", { roles: [] }],
        ["/borrow/peers/b", { roles: ["admin"] }], ["/borrow/peers/b", { roles: ["review", "review"] }], ["/borrow/peers/b", { priority: "urgent" }],
        ["/borrow/local/p", {}], ["/borrow/local/p", { priority: "urgent" }], ["/borrow/local/p", { maxActiveWorkers: 33 }],
        ["/borrow/local/p", { maxActiveWorkers: -1 }], ["/borrow/local/p", { maxActiveWorkers: 1, mode: "off" }], ["/borrow/local/%2F", { priority: "first" }],
      ];
      for (const [path, body] of bad) expect([path, body, (await call(OWNER, path, put(body)))?.status]).toEqual([path, body, 400]);
      expect(p.calls).toEqual([]);
    } finally { p.close(); }
  });

  test("写门：不是 owner 本人的全权凭据 → 403，不起 CLI；本机路由只收 PUT", async () => {
    const p = await ready();
    try {
      expect((await call(LEGACY_FULL, "/borrow/local/p", put({ priority: "first" })))?.status).toBe(403);
      expect((await call(OWNER, "/borrow/local/p"))?.status).toBe(405);
      expect(p.calls).toEqual([]);
      expect((await call(OWNER, "/borrow/local/zzz", put({ priority: "first" })))?.status).toBe(409);
    } finally { p.close(); }
  });
});

describe("额度（只读参考，验收线 2）", () => {
  test("GET 带本机额度、peer 上报额度、档位与角色；peer 没报 = null", async () => {
    const p = await ready();
    try {
      notePeerQuota("b", { codex: { weekUsedPct: 18, resetAt: p.f.tickDeps.now() + 86_400_000 } }, p.f.tickDeps.now());
      const v = await borrowView();
      expect(v.localQuota).toMatchObject({ quota: { codex: { weekUsedPct: 62 } }, walled: false });
      const peers = v.peers as { peer: string; quota: unknown; priority: string; roles: string[] }[];
      expect(peers.find((x) => x.peer === "b")).toMatchObject({ quota: { codex: { weekUsedPct: 18 } }, priority: "balance", roles: ["review", "write"] });
      expect(peers.find((x) => x.peer === "mate")!.quota).toBeNull();
      expect((v.projects as { localPriority: string }[])[0]!.localPriority).toBe("balance");
    } finally { p.close(); }
  });

  test("读本机额度抛错：GET 照常 200、localQuota 为 null；派单照旧", async () => {
    const p = await ready({ localQuota: async () => { throw new Error("rollout 坏了"); } });
    try {
      p.hello("mate");
      p.hello("b");
      const r = await call(OWNER, "/borrow");
      expect(r?.status).toBe(200);
      expect(((await r!.json()) as { localQuota: unknown }).localQuota).toBeNull();
      await p.tick();
      expect(await p.placed()).toMatchObject({ where: "peer:mate" });
    } finally { p.close(); }
  });
});

describe("网页纯函数", () => {
  test("toggleRole 至少留一个、顺序固定；reviewFirstFor；weekUsed 过重置给 null；resetIn；本机上限可到 0", () => {
    expect(toggleRole(["review"], "write")).toEqual(["review", "write"]);
    expect(toggleRole(["write", "review"], "review")).toEqual(["write"]);
    expect(toggleRole(["review"], "review")).toBeNull();
    const view = { projects: [{ id: "p", mode: "balance" as const, maxActiveWorkers: 1, reviewFirst: ["Sekai"] }, { id: "q", mode: "off" as const, maxActiveWorkers: 1 }] };
    expect(reviewFirstFor(view, "Sekai")).toBe(true);
    expect(reviewFirstFor(view, "mate")).toBe(false);
    expect(weekUsed({ codex: { weekUsedPct: 5, resetAt: 100 } }, "codex", 50)).toEqual({ pct: 5, resetAt: 100 });
    expect(weekUsed({ codex: { weekUsedPct: 5, resetAt: 100 } }, "codex", 100)).toBeNull();
    expect(weekUsed(null, "claude", 0)).toBeNull();
    expect(resetIn(3 * 86_400_000 + 1, 0)).toEqual({ n: 3, unit: "d" });
    expect(resetIn(1000, 0)).toEqual({ n: 1, unit: "h" });
    expect(clampMaxOpen(-3, 32, 0)).toBe(0);
    expect(parseMaxOpen("0", 32, 0)).toEqual({ value: 0, clamped: false });
    expect(parseMaxOpen("0", 20)).toEqual({ value: 1, clamped: true });
  });

  test("本机档位：mode=off（只用本机）时禁用，与锁 / 写权限无关；balance 时只看卡片本身；本机行用的就是它、上限步进器不受影响", () => {
    expect(localTierDisabled(false, { mode: "off" })).toBe(true);
    expect(localTierDisabled(false, { mode: "balance" })).toBe(false);
    expect(localTierDisabled(true, { mode: "balance" })).toBe(true);
    const src = readFileSync(join(import.meta.dir, "../web/features/borrow/borrow-alloc.tsx"), "utf8");
    expect(src).toContain("rolesReadOnly disabled={localTierDisabled(disabled, p)}");
    expect(src).toMatch(/<Stepper value=\{p\.maxActiveWorkers\}[^>]*disabled=\{disabled\}/);
  });
});
