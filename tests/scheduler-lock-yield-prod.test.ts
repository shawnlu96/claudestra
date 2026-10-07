/**
 * RLOCK2 · 按 src/scheduler.ts 的接法测：只读 LedgerReader + 真实台账 CLI 子进程（临时 HOME / TMPDIR / 状态目录、临时台账）。
 * 复现「blocked 卡 T0 持宽锁 src/lib/** → 新卡 T1 开不了工」：off（旧行为）一直等；observe 只记一条、锁不变；
 * on 让锁 → T1 拿到锁；T0 恢复后拿不回 → 照常等，PM 只收到一次通知。反例：1 小时 59 分不让。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { STATE_DIR } from "../src/lib/paths.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { lockYieldStep } from "../src/lib/scheduler-lock-yield-deps.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = resolve("src/manager.ts");
const HOUR = 3_600_000, MIN = 60_000;
const WIDE = ["src/lib/**", "src/manager/**"];
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

/** T0：auto 卡，持 WIDE 两把卡级文件锁，blockedFor 之前进了 blocked；T1：fixture 卡，要 src/lib/x.ts */
async function setup(mode: "on" | "observe" | "off" | "default", blockedFor = 2 * HOUR + 5 * MIN) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const logs = spyOn(console, "log").mockImplementation(() => {});
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); logs.mockRestore(); });
  f.advance(Date.now() - 60 * MIN); // fixture 的时钟对齐真实时间：子进程按 Date.now() 重核
  const shared = ["ledger.sqlite", "registry.json", "recovery-policy.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); };
  unlink();
  cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  symlinkSync(f.registryPath, shared[1]);
  writeFileSync(shared[2], JSON.stringify({ projects: mode === "default" ? { q: { mode: "on" } } : { p: { keys: { lockYield: mode } } } }));
  const old = Date.now() - 5 * HOUR, blockedAt = Date.now() - blockedFor;
  createTask(f.db, { actor: "owner", now: old }, { project: "p", id: "T0", title: "old", kind: "code", agent: "agent-old", branch: "feat/t0", extra: { fileGlobs: WIDE } });
  setWorkflow(f.db, { actor: "owner", now: old }, { taskId: "T0", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  f.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('i-T0', 'T0', 'p', 'write', 'dispatch', 'agent-old', 0, 1, 1, 2, 'done', 'old write', ?, ?)`, [old, old]);
  for (const r of WIDE) f.db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'T0', 'i-T0', ?, 'card')", [r, old]);
  f.db.run("UPDATE tasks SET stage = 'blocked', stageBefore = 'build' WHERE id = 'T0'");
  insertEvent(f.db, { actor: "pm", now: blockedAt }, { project: "p", target: "T0", kind: "stage", data: { from: "build", to: "blocked" } }, false);
  f.db.run("UPDATE tasks SET branch = 'feat/t1' WHERE id = 'T1'");

  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  const home = join(f.dir, "home"), tmp = join(f.dir, "tmp"), runtime = join(f.dir, "runtime");
  for (const d of [home, tmp, runtime]) mkdirSync(d);
  const env = testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: STATE_DIR, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const calls: string[] = [];
  const manager = async (...args: string[]) => {
    calls.push(args[1]);
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const pm: string[] = [];
  const config = { projects: { p: { maxActiveWorkers: 2 } } } as unknown as SchedulerConfig;
  /** 生产接法：只读句柄、默认策略读取（状态目录里的 recovery-policy.json）、真实子进程；本机 agent 活动注入（T0 没有绑定 agent） */
  const step = async () => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    return lockYieldStep(ro, config, manager, async (_t: LedgerTask, text: string) => { pm.push(text); }, undefined, { agents: async () => new Map() });
  };
  const held = (task: string) => (f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? ORDER BY resource").all(task) as { resource: string }[])
    .map((r) => r.resource);
  const ops = (target: string, op: string) => listEvents(f.db, { project: "p", target }).filter((e) => e.data.op === op);
  return { f, step, held, ops, pm, calls };
}

/** T1 走到 build 开工：派单前被 T0 的 src/lib/** 挡住就是 waiting / resource_busy */
async function t1Tick(f: ReturnType<typeof autoFixture>): Promise<string> {
  const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
  expect(r.failed).toEqual([]);
  return JSON.stringify(r.cards.find((c) => c.taskId === "T1"));
}
async function t1Waits(f: ReturnType<typeof autoFixture>): Promise<string> {
  if (getTask(f.db, "T1")?.stage === "spec") await toBuild(f);
  return t1Tick(f);
}

test("off（旧行为）：T0 一直占着锁，T1 一直等", async () => {
  const s = await setup("off");
  expect(await t1Waits(s.f)).toContain("src/lib/**");
  for (let i = 0; i < 2; i++) expect(await s.step()).toEqual([]);
  expect(s.calls).toEqual([]);
  expect(s.held("T0")).toEqual(WIDE);
  expect(await t1Waits(s.f)).toContain("src/lib/**");
});

test("observe：每段停滞只记一条「本可让锁」，列出资源与可开工的卡；锁不变", async () => {
  const s = await setup("observe");
  expect(await t1Waits(s.f)).toContain("src/lib/**");
  for (let i = 0; i < 3; i++) expect(await s.step()).toEqual([]);
  const seen = s.ops("T0", "recovery_observe");
  expect(seen).toHaveLength(1);
  expect(seen[0].data).toMatchObject({ mechanism: "lockYield", basis: "blocked", resources: WIDE,
    waiters: [{ taskId: "T1", files: ["src/lib/**"], canStart: true, stillBlockedBy: [] }] });
  expect(seen[0].text).toContain("T1可开工");
  expect(s.calls).toEqual(["scheduler-lock-yield"]); // 记过之后 tick 不再调子命令
  expect(s.held("T0")).toEqual(WIDE);
  expect(s.ops("T0", "lock_yield_released")).toEqual([]);
  expect(await t1Waits(s.f)).toContain("src/lib/**");
});

test("默认 observe：文件里没有 lockYield 键、本项目也没有项目级 mode → 只记事件，不释放锁", async () => {
  const s = await setup("default");
  for (let i = 0; i < 2; i++) expect(await s.step()).toEqual([]);
  expect(s.ops("T0", "recovery_observe")).toHaveLength(1);
  expect(s.ops("T0", "lock_yield_released")).toEqual([]);
  expect(s.held("T0")).toEqual(WIDE);
});

test("on：让锁 → T1 拿到锁；T0 恢复后拿不回 → 照常等，PM 只收到一次通知", async () => {
  const s = await setup("on");
  expect(await t1Waits(s.f)).toContain("src/lib/**");
  expect(await s.step()).toEqual([]);
  expect(s.held("T0")).toEqual([]);
  const rel = s.ops("T0", "lock_yield_released");
  expect(rel).toHaveLength(1);
  expect(rel[0].data).toMatchObject({ basis: "blocked", resources: WIDE, branch: "feat/t0" });
  const t0 = s.f.db.query("SELECT stage, branch, extra FROM tasks WHERE id = 'T0'").get();
  expect(t0).toEqual({ stage: "blocked", branch: "feat/t0", extra: JSON.stringify({ fileGlobs: WIDE }) }); // 只动锁

  expect(await t1Tick(s.f)).not.toContain("src/lib/**");
  expect(s.held("T1")).toContain("src/lib/x.ts");

  expect(await s.step()).toEqual([]); // T0 还没恢复：不通知
  expect(s.pm).toEqual([]);
  s.f.db.run("UPDATE tasks SET stage = 'build', stageBefore = NULL WHERE id = 'T0'");
  insertEvent(s.f.db, { actor: "pm", now: Date.now() }, { project: "p", target: "T0", kind: "stage", data: { from: "blocked", to: "build" } }, false);
  for (let i = 0; i < 3; i++) expect(await s.step()).toEqual([]);
  expect(s.pm).toHaveLength(1);
  expect(s.pm[0]).toContain("T1（分支 feat/t1）占着 src/lib/x.ts");
  expect(s.pm[0]).toContain("本卡分支 feat/t0");
  expect(s.pm[0]).toContain("两边的改动都要保留");
  expect(s.held("T0")).toEqual([]); // 不抢回
  expect(s.held("T1")).toContain("src/lib/x.ts"); // 不踢后来的卡
  expect(s.ops("T0", "lock_yield_contended")).toHaveLength(1);
  expect(s.ops("T0", "lock_yield_contended_sent")).toHaveLength(1);
});

test("反例：blocked 1 小时 59 分不让（on 也不动）", async () => {
  const s = await setup("on", HOUR + 59 * MIN);
  expect(await s.step()).toEqual([]);
  expect(s.calls).toEqual([]);
  expect(s.held("T0")).toEqual(WIDE);
});
