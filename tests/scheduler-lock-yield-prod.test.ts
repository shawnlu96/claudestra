/**
 * RLOCK2 · 按 src/scheduler.ts 的接法测：只读 LedgerReader + 真实台账 CLI 子进程（临时 HOME / TMPDIR / 状态目录、临时台账）。
 * 复现「blocked 卡 T0 持宽锁 src/lib/** → 新卡 T1 开不了工」：off（旧行为）一直等；observe 只记一条、锁不变；
 * on 让锁 → T1 拿到锁；T0 恢复后拿不回 → 照常等，PM 只收到一次通知。反例：1 小时 59 分不让；活动回合（真实 registry + ACP 心跳，
 * 含观察后才开回合的竞态）、registry 结构坏、合并在途、冻结卡都不让——tick 不调、伪造请求直送 CLI 重核也拒，锁不变、没有让锁事件。
 * 升级前项目级 mode:on 不带上 lockYield（仍 observe）。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { activityPath } from "../src/lib/agent-supervisor-activity.js";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
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
import { localAgents } from "../src/lib/scheduler-lock-yield-agents.js";
import { lockYieldStep } from "../src/lib/scheduler-lock-yield-deps.js";
import { lockYieldPolicy } from "../src/lib/scheduler-lock-yield-policy.js";
import { readYieldFacts } from "../src/lib/scheduler-lock-yield-read.js";
import { lockYieldWrite } from "../src/lib/scheduler-lock-yield-write.js";
import { stallOf } from "../src/lib/scheduler-lock-yield.js";
import { sessionJsonlPath } from "../src/lib/session-source.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = resolve("src/manager.ts");
const HOUR = 3_600_000, MIN = 60_000;
const WIDE = ["src/lib/**", "src/manager/**"];
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Mode = "on" | "observe" | "off" | "default" | "inherit-on";
/** realAgents：不注入本机 agent 活动，走生产 localAgents（状态目录里的 registry.json + acp-activity/）；registry 给对象就写它，不给就链 fixture 的 */
interface SetupOpts { blockedFor?: number; stage?: "blocked" | "fix"; realAgents?: boolean; registry?: unknown }

/** T0：auto 卡，持 WIDE 两把卡级文件锁，blockedFor 之前进了 blocked（stage fix：不进 blocked，5 小时前起无进展）；T1：fixture 卡，要 src/lib/x.ts */
async function setup(mode: Mode, opts: SetupOpts | number = {}) {
  const o: SetupOpts = typeof opts === "number" ? { blockedFor: opts } : opts;
  const blockedFor = o.blockedFor ?? 2 * HOUR + 5 * MIN;
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const logs = spyOn(console, "log").mockImplementation(() => {});
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); logs.mockRestore(); });
  f.advance(Date.now() - 60 * MIN); // fixture 的时钟对齐真实时间：子进程按 Date.now() 重核
  const shared = ["ledger.sqlite", "registry.json", "recovery-policy.json", "acp-activity"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true, recursive: true }); };
  unlink();
  cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  if (o.registry === undefined) symlinkSync(f.registryPath, shared[1]);
  else writeFileSync(shared[1], JSON.stringify(o.registry));
  const projects = mode === "default" ? { q: { mode: "on" } } : mode === "inherit-on" ? { p: { mode: "on" } } : { p: { keys: { lockYield: mode } } };
  writeFileSync(shared[2], JSON.stringify({ projects }));
  const old = Date.now() - 5 * HOUR, blockedAt = Date.now() - blockedFor;
  createTask(f.db, { actor: "owner", now: old }, { project: "p", id: "T0", title: "old", kind: "code", agent: "agent-old", branch: "feat/t0", extra: { fileGlobs: WIDE } });
  setWorkflow(f.db, { actor: "owner", now: old }, { taskId: "T0", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  f.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('i-T0', 'T0', 'p', 'write', 'dispatch', 'agent-old', 0, 1, 1, 2, 'done', 'old write', ?, ?)`, [old, old]);
  for (const r of WIDE) f.db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'T0', 'i-T0', ?, 'card')", [r, old]);
  if ((o.stage ?? "blocked") === "blocked") {
    f.db.run("UPDATE tasks SET stage = 'blocked', stageBefore = 'build' WHERE id = 'T0'");
    insertEvent(f.db, { actor: "pm", now: blockedAt }, { project: "p", target: "T0", kind: "stage", data: { from: "build", to: "blocked" } }, false);
  } else f.db.run("UPDATE tasks SET stage = 'fix' WHERE id = 'T0'");
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
  /** 生产接法：只读句柄、默认策略读取（状态目录里的 recovery-policy.json）、真实子进程；本机 agent 活动默认注入（T0 的 agent-old 不在本机），realAgents 走生产取法 */
  const step = async (via: typeof manager = manager) => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    return lockYieldStep(ro, config, via, async (_t: LedgerTask, text: string) => { pm.push(text); }, undefined,
      o.realAgents ? {} : { agents: async () => new Map() });
  };
  const held = (task: string) => (f.db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? ORDER BY resource").all(task) as { resource: string }[])
    .map((r) => r.resource);
  const ops = (target: string, op: string) => listEvents(f.db, { project: "p", target }).filter((e) => e.data.op === op);
  return { f, step, held, ops, pm, calls, manager };
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

test("升级前项目级 mode:on、没有 lockYield 键 → 仍是 observe：只记一条，不释放", async () => {
  const s = await setup("inherit-on");
  for (let i = 0; i < 2; i++) expect(await s.step()).toEqual([]);
  expect(s.ops("T0", "recovery_observe")).toHaveLength(1);
  expect(s.ops("T0", "lock_yield_released")).toEqual([]);
  expect(s.held("T0")).toEqual(WIDE);
});

const OLD_AGENT = { runtime: "codex", transport: "acp", sessionId: "s-old", cwd: "/nonexistent/rlock2", status: "active" };
/** agent-old 的 ACP 心跳：busy = 回合在跑；lastAt = 最近一次动静 */
function heartbeat(busy: boolean, lastAt: number, sessionId = "s-old"): void {
  const path = activityPath("agent-old");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ v: 1, agent: "agent-old", sessionId, hostPid: 1, busy, turnAt: lastAt, updateAt: lastAt, writtenAt: lastAt }));
}
/** 跳过 tick、直接把一份「看着能让」的请求送进真实 CLI：写侧自己重核 */
const forged = (s: Awaited<ReturnType<typeof setup>>, basis: "blocked" | "idle", since: number) =>
  s.manager("ledger", "scheduler-lock-yield", "T0", "--data", JSON.stringify({ v: 1, phase: "yield", basis, since, resources: WIDE, recentMs: 10 * MIN }));
const untouched = (s: Awaited<ReturnType<typeof setup>>) => {
  expect(s.held("T0")).toEqual(WIDE);
  expect(s.ops("T0", "lock_yield_released")).toEqual([]);
};

test("对照：fix 卡 5 小时无进展、agent-old 心跳 3 小时前停 → 生产取法判空闲，on 让锁", async () => {
  const s = await setup("on", { stage: "fix", realAgents: true, registry: { agents: { "agent-old": OLD_AGENT } } });
  heartbeat(false, Date.now() - 3 * HOUR);
  expect(await s.step()).toEqual([]);
  expect(s.held("T0")).toEqual([]);
  expect(s.ops("T0", "lock_yield_released")[0].data).toMatchObject({ basis: "idle" });
});

test("反例：绑定的 agent 有活动回合（真实 registry + ACP 心跳）→ 不让；伪造请求直送 CLI 也拒", async () => {
  const s = await setup("on", { stage: "fix", realAgents: true, registry: { agents: { "agent-old": OLD_AGENT } } });
  heartbeat(true, Date.now() - 3 * HOUR);
  expect(await s.step()).toEqual([]);
  expect(s.calls).toEqual([]);
  const r = await forged(s, "idle", Date.now() - 3 * HOUR);
  expect(r).toMatchObject({ ok: false, code: "conflict" });
  expect(String(r.error)).toContain("agent-old 有活动回合");
  untouched(s);
});

test("反例（竞态）：tick 看着空闲，送进 CLI 前 agent 开了回合 → 写侧重读活动、拒，锁不变", async () => {
  const s = await setup("on", { stage: "fix", realAgents: true, registry: { agents: { "agent-old": OLD_AGENT } } });
  const last = Date.now() - 3 * HOUR;
  heartbeat(false, last);
  const seen: Record<string, unknown>[] = [];
  const racing = async (...args: string[]) => {
    heartbeat(true, last); // 用户消息刚进来：同一会话开了回合，心跳时刻还没刷新，台账也没有新事实
    const r = await s.manager(...args);
    seen.push(r);
    return r;
  };
  expect(await s.step(racing)).toEqual([]);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ ok: false, code: "conflict" });
  expect(String(seen[0].error)).toContain("agent-old 有活动回合");
  untouched(s);
});

for (const [name, registry] of [["条目是 null", { agents: { "agent-old": null } }], ["另一个条目是 null", { agents: { "agent-old": OLD_AGENT, "agent-x": null } }]] as const) {
  test(`反例：registry 结构坏（${name}）→ 活动读不了，不让；伪造请求直送 CLI 也拒`, async () => {
    const s = await setup("on", { stage: "fix", realAgents: true, registry });
    heartbeat(true, Date.now() - 3 * HOUR);
    expect(await s.step()).toEqual([]);
    expect(s.calls).toEqual([]);
    const r = await forged(s, "idle", Date.now() - 5 * HOUR);
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(String(r.error)).toContain("本机 agent 活动读不了");
    untouched(s);
  });
}

test("反例：合并在途（scheduler_merges 未结）→ blocked 满 2 小时也不让；伪造请求直送 CLI 也拒", async () => {
  const s = await setup("on");
  const at = Date.now() - HOUR;
  s.f.db.run(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES ('i-T0', 'T0', 'p', '#1', 'feat/t0', 'abc', '[]', 'merging', ?, ?)`, [at, at]);
  expect(await s.step()).toEqual([]);
  expect(s.calls).toEqual([]);
  const since = listEvents(s.f.db, { project: "p", target: "T0" }).find((e) => e.kind === "stage")!.ts;
  const r = await forged(s, "blocked", since);
  expect(r).toMatchObject({ ok: false, code: "conflict" });
  expect(String(r.error)).toContain("合并在途");
  untouched(s);
});

test("反例：冻结卡（extra.frozen）→ blocked 满 2 小时也不让；伪造请求直送 CLI 也拒", async () => {
  const s = await setup("on");
  s.f.db.run("UPDATE tasks SET extra = ? WHERE id = 'T0'", [JSON.stringify({ fileGlobs: WIDE, frozen: true })]);
  expect(await s.step()).toEqual([]);
  expect(s.calls).toEqual([]);
  const since = listEvents(s.f.db, { project: "p", target: "T0" }).find((e) => e.kind === "stage")!.ts;
  const r = await forged(s, "blocked", since);
  expect(r).toMatchObject({ ok: false, code: "conflict" });
  expect(String(r.error)).toContain("冻结卡");
  untouched(s);
});

/**
 * 写事务前最后一道（activity-race）：生产 localAgents 已读完「agent-old 旧会话空闲 3 小时」，在进写事务前心跳变了（台账没有新事实）。
 * 和 CLI 命令内部的窗口一样：localAgents 的 await / 读别的 agent 期间。直接调真实 lockYieldWrite（写库句柄），事务里要自己重读、看出变化就拒。
 */
for (const [name, change] of [
  ["同一会话刚跑完一个短回合（busy=false、turnAt/updateAt=now）", () => heartbeat(false, Date.now())],
  ["换了新会话、回合在跑（s-new busy=true）", () => heartbeat(true, Date.now() - 3 * HOUR, "s-new")],
] as const) {
  test(`反例（竞态）：重读之后、写事务之前 ${name} → 事务里重核拒，锁不变`, async () => {
    const s = await setup("on", { stage: "fix", realAgents: true, registry: { agents: { "agent-old": OLD_AGENT } } });
    heartbeat(false, Date.now() - 3 * HOUR);
    const now = Date.now();
    const fresh = await localAgents(s.f.db, now, 10 * MIN);
    expect(fresh?.get("T0")).toMatchObject([{ name: "agent-old", recent: false }]);
    const f = readYieldFacts(s.f.db, "p"), st = stallOf(f.cards.find((c) => c.id === "T0")!, f.held, fresh!.get("T0")!, now);
    expect(st).toMatchObject({ kind: "stalled", basis: "idle" });
    change();
    const wire = { v: 1 as const, phase: "yield" as const, basis: "idle" as const, since: (st as { since: number }).since, resources: WIDE, recentMs: 10 * MIN };
    expect(() => lockYieldWrite(s.f.db, { actor: "scheduler", now }, "T0", wire, lockYieldPolicy, fresh)).toThrow(/agent-old/);
    untouched(s);
  });
}

/** activity-unreadable：ACP 心跳文件在但读坏 → 不能退回旧会话文件的 mtime 判空闲 */
test("反例：绑定 agent 的 ACP 心跳读坏（会话文件 3 小时前）→ 活动读不了，不让；伪造请求直送 CLI 也拒", async () => {
  const agent = { ...OLD_AGENT, runtime: "claude-code", cwd: "/tmp/rlock2-cwd" };
  const s = await setup("on", { stage: "fix", realAgents: true, registry: { agents: { "agent-old": agent } } });
  const jsonl = sessionJsonlPath(agent.runtime, agent.cwd, agent.sessionId)!;
  mkdirSync(join(jsonl, ".."), { recursive: true });
  writeFileSync(jsonl, "{}\n");
  const old = (Date.now() - 3 * HOUR) / 1000;
  utimesSync(jsonl, old, old);
  cleanup.push(() => rmSync(jsonl, { force: true }));
  const path = activityPath("agent-old");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{");
  const fresh = await localAgents(s.f.db, Date.now(), 10 * MIN);
  expect(fresh?.get("T0")?.[0]).toMatchObject({ name: "agent-old", unknown: expect.stringContaining("心跳") });
  expect(await s.step()).toEqual([]);
  expect(s.calls).toEqual([]);
  const r = await forged(s, "idle", Date.now() - 3 * HOUR);
  expect(r).toMatchObject({ ok: false, code: "conflict" });
  expect(String(r.error)).toContain("活动读不了");
  untouched(s);
});

/**
 * stale-session-busy：旧 ACP 宿主异常退出留下 s-old 的 busy=true 心跳（稳定不变），同名 agent 已换 tmux 新会话 s-new、会话文件 3 小时没动。
 * 与 LIFE1 同口径只认当前会话：取数判空闲，写事务也不能把旧会话心跳当否决——on 让锁、observe 记一条。
 */
async function staleSessionBusy(mode: "on" | "observe") {
  const agent = { runtime: "claude-code", transport: "tmux", sessionId: "s-new", cwd: "/tmp/rlock2-stale-cwd", status: "active" };
  const s = await setup(mode, { stage: "fix", realAgents: true, registry: { agents: { "agent-old": agent } } });
  // 本进程（直调 / tick 取数）与 CLI 子进程（临时 HOME）各看自己 HOME 下的会话文件：两处都放一份
  const mine = sessionJsonlPath(agent.runtime, agent.cwd, agent.sessionId)!;
  const old = (Date.now() - 3 * HOUR) / 1000;
  for (const jsonl of [mine, join(s.f.dir, "home", relative(homedir(), mine))]) {
    mkdirSync(join(jsonl, ".."), { recursive: true });
    writeFileSync(jsonl, "{}\n");
    utimesSync(jsonl, old, old);
    cleanup.push(() => rmSync(jsonl, { force: true }));
  }
  heartbeat(true, Date.now() - 3 * HOUR, "s-old");
  return s;
}

test("旧会话稳定 busy 心跳（当前 tmux 会话 s-new 空闲 3 小时）→ 写事务不否决：on 让锁", async () => {
  const s = await staleSessionBusy("on");
  const now = Date.now();
  const fresh = await localAgents(s.f.db, now, 10 * MIN);
  expect(fresh?.get("T0")).toMatchObject([{ name: "agent-old", recent: false, sessionId: "s-new" }]);
  expect(await s.step()).toEqual([]);
  expect(s.held("T0")).toEqual([]);
  expect(s.ops("T0", "lock_yield_released")[0].data).toMatchObject({ basis: "idle" });
});

test("旧会话稳定 busy 心跳 → observe 记一条本可让锁，锁不变", async () => {
  const s = await staleSessionBusy("observe");
  for (let i = 0; i < 2; i++) expect(await s.step()).toEqual([]);
  expect(s.ops("T0", "recovery_observe")).toHaveLength(1);
  untouched(s);
});

test("旧会话稳定 busy 心跳 → 直调真实 lockYieldWrite 通过；当前会话 s-new 心跳在跑回合则拒", async () => {
  const s = await staleSessionBusy("on");
  const now = Date.now();
  const fresh = await localAgents(s.f.db, now, 10 * MIN);
  const f = readYieldFacts(s.f.db, "p"), st = stallOf(f.cards.find((c) => c.id === "T0")!, f.held, fresh!.get("T0")!, now);
  expect(st).toMatchObject({ kind: "stalled", basis: "idle" });
  const wire = { v: 1 as const, phase: "yield" as const, basis: "idle" as const, since: (st as { since: number }).since, resources: WIDE, recentMs: 10 * MIN };
  heartbeat(true, Date.now() - 3 * HOUR, "s-new"); // 当前会话开了回合：签名也变了
  expect(() => lockYieldWrite(s.f.db, { actor: "scheduler", now }, "T0", wire, lockYieldPolicy, fresh)).toThrow(/agent-old/);
  untouched(s);
  heartbeat(true, Date.now() - 3 * HOUR, "s-old"); // 回到稳定旧会话心跳：签名对上，当场重核通过
  const again = await localAgents(s.f.db, now, 10 * MIN);
  lockYieldWrite(s.f.db, { actor: "scheduler", now }, "T0", wire, lockYieldPolicy, again);
  expect(s.held("T0")).toEqual([]);
});
