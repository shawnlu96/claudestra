/** Real read-only tick + ledger CLI subprocesses, with only lifecycle effects replaced by a fake manager. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { createReplacement, reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { staleFixture } from "./scheduler-review-stale-fixture.test.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = resolve("src/manager.ts"), NEW = "agent-task-rv-t1-r4";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });
const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

async function setup(mode: "on" | "observe" | "off", failure?: "archive" | "dirty" | "occupied") {
  const s = staleFixture(), f = s.f;
  cleanups.push(f.close);
  const repo = join(f.dir, "repo"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "old\n"); git(repo, "add", "a.txt"); git(repo, "commit", "-qm", "old");
  const h1 = git(repo, "rev-parse", "HEAD");
  // The historical source remains immutable; only the new card head needs to be a real local commit.
  writeFileSync(join(repo, "a.txt"), "next\n"); git(repo, "commit", "-qam", "next");
  const head = git(repo, "rev-parse", "HEAD");
  f.db.run("UPDATE tasks SET headSHA = ?, spec = ? WHERE id = 'T1'", [head, join(f.dir, "T1.md")]);
  writeFileSync(join(f.dir, "T1.md"), "# T1\n验收：审查当前提交\n");
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-task-one"].cwd = repo;
  const wt = join(STATE_DIR, "worktrees", "rv-t1");
  if (failure === "occupied") reg.agents[NEW] = { runtime: "codex", transport: "acp", sessionId: "s-occupied", status: "idle", cwd: wt };
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const shared = ["ledger.sqlite", "registry.json", "recovery-policy.json", "scheduler.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const p of shared) rmSync(p, { force: true }); rmSync(join(STATE_DIR, "worktrees"), { recursive: true, force: true }); };
  unlink(); cleanups.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]); symlinkSync(f.registryPath, shared[1]);
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { staleReplacement: mode } } } }));
  writeFileSync(shared[3], JSON.stringify({ enabled: false, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: repo } } }));
  if (failure === "dirty") {
    mkdirSync(join(STATE_DIR, "worktrees"), { recursive: true });
    git(repo, "worktree", "add", "--detach", wt, h1); writeFileSync(join(wt, "a.txt"), "dirty\n");
  }
  const locks = await Promise.all(["singleton", "maintenance"].map((n) => acquireLock(join(f.dir, `${n}.lock`), 0)));
  cleanups.push(() => { for (const l of locks) l!.release(); });
  const home = join(f.dir, "home"), runtime = join(f.dir, "runtime"); mkdirSync(home); mkdirSync(runtime);
  const env = testChildEnv({ HOME: home, CLAUDESTRA_STATE_DIR: STATE_DIR, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: join(f.dir, "singleton.lock"), token: locks[0]!.token },
      maintenance: { path: join(f.dir, "maintenance.lock"), token: locks[1]!.token } }) });
  const calls: string[][] = [], commands: string[] = [];
  let stopped = false;
  const agent: ReviewSwapDeps["agent"] = async (...a) => {
    calls.push(a);
    if (a[0] === "archive" && failure === "archive") return { ok: false, error: "archive failed" };
    if (a[0] === "kill") stopped = true;
    if (a[0] === "create") {
      const registry = JSON.parse(readFileSync(f.registryPath, "utf8"));
      registry.agents[a[1]] = { runtime: "codex", transport: "acp", sessionId: "s-new", cwd: a[2] };
      writeFileSync(f.registryPath, JSON.stringify(registry));
    }
    return { ok: true };
  };
  const swapDeps: ReviewSwapDeps = { registryPath: f.registryPath, active: () => {}, agent,
    agents: async () => [{ name: s.agent, sessionId: s.sessionId, status: stopped ? "stopped" : "idle", pending: false, window: !stopped }],
    ensure: (task, family, old, tag, current) => createReplacement(f.db, task, family, old, agent, tag, { current }) };
  const manager: AutoTickDeps["manager"] = async (...a) => {
    commands.push(a[1]);
    if (a[1] === "scheduler-review-swap") return reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps);
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...a], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); await p.exited;
    if (err.includes("[test-guard]")) throw new Error(err);
    try { return JSON.parse(out); } catch { throw new Error(`${out}\n${err}`); }
  };
  const pinReview = autoTickDeps(f.db, { registryPath: f.registryPath }).pinReview;
  const tick = async () => {
    const ro = f.reader.get()!; expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    const r = await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps, manager, pinReview });
    expect(r.failed).toEqual([]); return r.cards[0];
  };
  const events = () => listEvents(f.db, { target: "T1" });
  return { ...s, tick, calls, commands, wt, head, events, repo };
}

test("[验收线 2] on 真 tick/台账命令：归档后下一轮 kill，再建普通目录新审查员并派当前 head", async () => {
  const s = await setup("on"), before = s.events(), oldEnsure = getIntent(s.f.db, "ensure-r3");
  expect(await s.tick()).toMatchObject({ step: "waiting" });
  expect(getIntent(s.f.db, s.id)?.status).toBe("submitted");
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ state: "retired", archiveReceipt: expect.any(String), killReceipt: null });
  const swap = s.events().findLast((e) => e.data.op === "reviewer_swap")!;
  expect(swap.data).toMatchObject({ intentId: s.id, stale: { seq: s.swap.seq, tag: "-re", round: 3 }, head: s.head, round: 4 });
  expect(swap.data).not.toHaveProperty("legacy"); expect(swap.data).not.toHaveProperty("refusal");
  expect(s.calls).toEqual([["archive", s.agent]]);
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(s.calls).toEqual([["archive", s.agent], ["kill", s.agent]]);
  expect(getIntent(s.f.db, s.id)?.status).toBe("done");
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(s.calls.at(-1)!.slice(0, 3)).toEqual(["create", NEW, s.wt]);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ agent: NEW, sessionId: "s-new", family: "codex", state: "active" });
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const review = s.f.intents().findLast((i) => i.action === "review")!;
  expect(getIntent(s.f.db, review.id)).toMatchObject({ recipient: NEW, head: s.head, status: "done" });
  expect(s.f.sent.map((m) => m.agent)).toEqual([NEW]);
  expect(git(s.wt, "rev-parse", "HEAD")).toBe(s.head);
  expect(s.events().slice(0, before.length)).toEqual(before); expect(getIntent(s.f.db, "ensure-r3")).toEqual(oldEnsure);
}, 120_000);

for (const mode of ["observe", "off"] as const) {
  test(`[验收线 ${mode === "observe" ? 3 : 4}] ${mode}：真实 pin 拒派，cancelled 原文不变，仅 observe 附观察计划`, async () => {
    const s = await setup(mode), old = getSchedulerSession(s.f.db, "T1", "reviewer");
    const original = `${s.agent} 的旧单退休替代来源已不是本卡当前 head/规格/轮次的，不派审`;
    expect(await s.tick()).toMatchObject({ step: "manual" });
    const fallback = s.events().findLast((e) => e.data.op === "fallback_manual")!;
    expect(fallback.data.reason).toBe(mode === "off" ? original : `review_source_missing: ${original};恢复观察 staleReplacement:本会退休 ${s.agent}` +
      "(-re,来源第 3 轮)的审查绑定,先归档再停止,再按当前 head 重建审查员");
    if (mode === "observe") expect(fallback.data).toMatchObject({ manualReason: { code: "review_source_missing" } });
    const review = s.f.intents().findLast((i) => i.action === "review")!;
    expect(getIntent(s.f.db, review.id)).toMatchObject({ status: "cancelled", receipt: `未投递：${original}` });
    expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toEqual(old);
    expect(s.events().filter((e) => e.data.op === "reviewer_swap")).toHaveLength(1);
    expect(getWorkflow(s.f.db, "T1")?.mode).toBe("manual"); expect(s.calls).toEqual([]); expect(s.f.sent).toEqual([]);
  }, 120_000);
}

test("[验收线 2] 归档失败等待，不 kill、不 create", async () => {
  const s = await setup("on", "archive");
  expect(await s.tick()).toMatchObject({ step: "waiting" }); expect(await s.tick()).toMatchObject({ step: "waiting" });
  expect(s.calls).toEqual([["archive", s.agent], ["archive", s.agent]]);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ state: "retired", archiveReceipt: null, killReceipt: null });
}, 120_000);

for (const failure of ["dirty", "occupied"] as const) {
  test(`[验收线 2] 重建出口 ${failure} 沿用原规则`, async () => {
    const s = await setup("on", failure); await s.tick(); await s.tick();
    expect(await s.tick()).toMatchObject({ step: failure === "dirty" ? "manual" : "waiting" });
    const ensure = s.f.intents().findLast((i) => i.action === "ensure_session")!;
    expect(getIntent(s.f.db, ensure.id)?.status).toBe(failure === "dirty" ? "cancelled" : "unknown");
    expect(s.calls).toEqual([["archive", s.agent], ["kill", s.agent]]);
  }, 120_000);
}
