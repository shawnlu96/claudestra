/**
 * dispatch-recovery-RVSRC1 · 换审查员建新 worktree 的源目录，按 src/scheduler.ts 的接法测：只读 LedgerReader + 真实台账 CLI 子进程
 * （临时 HOME / TMPDIR / 状态目录），临时 git 仓库当 scheduler.json 的 repoDir，建会话走生产 createReplacement、manager 是桩。
 * N3 形态：auto 卡、作者是出借执行者（不在本机 registry，task.agent 为空）、旧审查员已按 MODELXW2 退休、计划了 ensure_session。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { UNCLAIMED_ALARM_MS } from "../src/lib/order-mark.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { createReplacement, reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { reviewSource } from "../src/lib/scheduler-review-swap-source.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const RV = "0199c0de-0000-7000-8000-00000000a3e1";
const MANAGER = resolve("src/manager.ts");
const NEW = "agent-task-rv-t1-r1-re";
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

const sh = (dir: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), `${dir}\n`);
  sh(dir, "add", "a.txt");
  sh(dir, "commit", "-q", "-m", "c");
  return sh(dir, "rev-parse", "HEAD");
}

type Opts = { author?: "remote" | "local"; headLocal?: boolean; create?: "ok" | "unconfirmed" };

async function setup(o: Opts = {}) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  const repoDir = join(f.dir, "repo"), authorDir = join(f.dir, "author"), elsewhere = join(f.dir, "elsewhere");
  const local = repo(repoDir);
  Bun.spawnSync(["git", "clone", "-q", repoDir, authorDir]);
  const head = o.headLocal === false ? repo(elsewhere) : local;
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-rv-t1"].sessionId = RV;
  reg.agents["agent-task-one"].cwd = authorDir;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(f.dir, "codex");
  cleanup.push(() => { if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome; });
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); });
  writeFileSync(join(f.dir, "T1.md"), "# T1\n验收：原文\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(f.dir, "T1.md")]);
  const shared = ["ledger.sqlite", "registry.json", "recovery-policy.json", "scheduler.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); rmSync(join(STATE_DIR, "worktrees"), { recursive: true, force: true }); };
  unlink();
  cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  symlinkSync(f.registryPath, shared[1]);
  writeFileSync(shared[2], JSON.stringify({ projects: { p: { keys: { modelOutcome: "on" } } } }));
  writeFileSync(shared[3], JSON.stringify({ enabled: false, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir } } }));
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  // TMPDIR 继承父进程：子进程的隔离闸按它认临时根，换成更深的目录时父进程的 STATE_DIR 不在其下，会被重定向到空台账
  const home = join(f.dir, "home"), runtime = join(f.dir, "runtime");
  for (const d of [home, runtime]) mkdirSync(d);
  const env = testChildEnv({ HOME: home, CLAUDESTRA_STATE_DIR: STATE_DIR, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  // 子进程按这份 env 求出的有效状态目录必须就是父进程放台账的 STATE_DIR
  const probe = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `console.log((await import(${JSON.stringify(resolve("src/lib/paths.ts"))})).STATE_DIR)`],
    { env, stdout: "pipe", stderr: "pipe" });
  expect({ dir: probe.stdout.toString().trim(), err: probe.stderr.toString() }).toEqual({ dir: STATE_DIR, err: "" });
  const calls: string[] = [];
  const child: AutoTickDeps["manager"] = async (...args) => {
    calls.push(args[1]);
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    // 子进程的状态目录被隔离闸改道 = 读的不是这份台账，直接判失败（不让有效 JSON 把 stderr 的改道提示吞掉）
    if (err.includes("[test-guard]")) return { ok: false, code: "child_state_dir", error: err.trim() };
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  // fake manager：create 照生产登记新会话（或结果未确认）；其余生命周期命令照收
  const creates: string[][] = [];
  const fakeAgent: ReviewSwapDeps["agent"] = async (...args) => {
    if (args[0] !== "create") return { ok: true };
    creates.push(args);
    if (o.create === "unconfirmed") return { ok: false, error: "manager create 超时" };
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    r.agents[args[1]] = { runtime: "codex", transport: "acp", sessionId: "s-new", cwd: args[2] };
    writeFileSync(f.registryPath, JSON.stringify(r));
    return { ok: true };
  };
  const swapDeps = (): ReviewSwapDeps => ({ registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: fakeAgent,
    ensure: (task, family, old, tag, current) => createReplacement(f.db, task, family, old, fakeAgent, tag, { current }) });
  const legacy = new Set<string>();
  const manager: AutoTickDeps["manager"] = (...a) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message }))
    : legacy.has(a[1]) ? Promise.resolve({ ok: false, code: "write_failed", error: "attempt to write a readonly database" }) : child(...a);
  let refusal: string | null = null, skew = 0;
  const realWorker = f.tickDeps.worker;
  let pin = f.tickDeps.pinReview; // RVWT1: production pinReview (default worktree root, same as createReplacement) once the replacement is due
  const deps: AutoTickDeps = { ...f.tickDeps, manager, now: () => Date.now() + skew, pinReview: (...a) => pin(...a), worker: (ref) => {
    const w = realWorker(ref);
    return refusal === null || "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message: refusal! } }) };
  } };
  const tick = async () => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    const r = await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, deps);
    expect(r.failed).toEqual([]);
    return r.cards[0];
  };
  const reviews = () => f.intents().filter((i) => i.action === "review");
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", head)).ok).toBe(true);
  await f.tick();

  // MODELXW2 N3：旧代码派的审查单（无快照）→ 拒审退人工 → PM 交回 auto → 唤醒没人领、绑定会话最后一回合 cyber 拒审 → 正式退休旧绑定
  legacy.add("scheduler-review-snapshot");
  expect(await tick()).toMatchObject({ step: "sent" });
  const old = reviews().at(-1)!;
  legacy.add("scheduler-model-outcome");
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2000, final: true });
  refusal = CYBER;
  expect(await tick()).toMatchObject({ step: "manual" });
  legacy.clear();
  refusal = null;
  const w = getWorkflow(f.db, "T1")!;
  expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--reason", "监工：交回 auto"))
    .toMatchObject({ ok: true });
  const delivered = getEventByDedup(f.db, `scheduler:${old.id}:done`)!.ts;
  openAsk(f.db, { project: "p", source: "codex", kind: "owner_action", fromAgent: "agent-rv-t1", title: "Codex 回合失败", context: CYBER,
    extra: { failure: "error", sessionId: RV, failedAt: delivered + 1 } }, Date.now());
  const rollouts = join(f.dir, "codex", "sessions", "2026", "10", "07");
  mkdirSync(rollouts, { recursive: true });
  const line = (at: number, payload: Record<string, unknown>, type = "event_msg") => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
  writeFileSync(join(rollouts, `rollout-2026-10-07T00-00-00-${RV}.jsonl`), [line(delivered - 5, { id: RV }, "session_meta"),
    line(delivered, { type: "task_started" }), line(delivered + 1, { type: "agent_message", message: "x" })].join("\n") + "\n");
  skew += UNCLAIMED_ALARM_MS + 60_000;
  expect(await tick()).toMatchObject({ step: "legacy_review" });
  expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "retired" });
  pin = autoTickDeps(f.db, { registryPath: f.registryPath }).pinReview;

  if (o.author !== "local") { // 作者是 Sekai 上的出借执行者：本机 registry 里没有，task.agent 为空
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    delete r.agents["agent-task-one"];
    writeFileSync(f.registryPath, JSON.stringify(r));
    f.db.run("UPDATE tasks SET agent = NULL WHERE id = 'T1'");
  }
  const ensureIntent = () => f.intents().findLast((i) => i.action === "ensure_session")!;
  const fallbacks = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "fallback_manual");
  const worktrees = (dir: string) => sh(dir, "worktree", "list", "--porcelain");
  return { f, tick, calls, creates, reviews, head, repoDir, authorDir, ensureIntent, fallbacks, worktrees,
    wt: join(STATE_DIR, "worktrees", "rv-t1-re"), branch: () => sh(repoDir, "symbolic-ref", "HEAD") };
}

test("RVSRC1 旧红新绿（N3）：作者是出借执行者 → 在 repoDir 建固定到 head 的审查 worktree，manager create 家族参数照旧，绑定新审查会话", async () => {
  const s = await setup();
  const fallbacksBefore = s.fallbacks().length;
  // 旧代码：意图 submitted → unknown（找不到作者工作目录），卡仍 auto、停在 review
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(getIntent(s.f.db, s.ensureIntent().id)?.status).toBe("done");
  expect(s.creates).toEqual([["create", NEW, s.wt, "--project", "p", "--task", "T1 审查", "--card", "T1", "--card-role", "reviewer",
    "--purpose", "作者家族变更后的独立复验", "--runtime", "codex", "--transport", "acp"]]);
  expect(sh(s.wt, "rev-parse", "HEAD")).toBe(s.head);
  expect(s.worktrees(s.repoDir)).toContain(s.wt);
  expect(s.worktrees(s.authorDir)).not.toContain(s.wt);
  expect(s.branch()).toBe("refs/heads/main"); // 主树分支、工作区不动
  expect(sh(s.repoDir, "status", "--porcelain")).toBe("");
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ agent: NEW, sessionId: "s-new", state: "active", family: "codex" });
  expect(await s.tick()).toMatchObject({ step: "sent" }); // RVWT1：真实 pinReview 认 rv-t1-re（旧代码只认 rv-t1，拒派）
  expect(s.reviews().at(-1)).toMatchObject({ recipient: NEW, status: "done" });
  expect(sh(s.wt, "rev-parse", "HEAD")).toBe(s.head);
  expect(s.creates).toHaveLength(1);
  expect(getWorkflow(s.f.db, "T1")?.mode).toBe("auto");
  expect(s.fallbacks()).toHaveLength(fallbacksBefore);
}, 120_000);

test("RVSRC1 反例：head 不是 repoDir 的本地提交 → 意图 cancelled、卡转 manual（正式子命令、原因码 + 意图 id）、PM 收到通知，不 fetch、不调 create", async () => {
  const s = await setup({ headLocal: false });
  const notices = s.f.notices.length, id = () => s.ensureIntent().id;
  const out = await s.tick();
  expect(out).toMatchObject({ step: "manual" });
  const intent = getIntent(s.f.db, id())!;
  expect(intent.status).toBe("cancelled");
  expect(intent.receipt).toContain("不是");
  expect(intent.receipt).toContain("本地提交");
  expect(s.calls).toContain("scheduler-fallback-manual");
  expect(s.fallbacks().at(-1)).toMatchObject({ actor: "scheduler", data: { intentId: intent.id, manualReason: { code: "review_source_missing" } } });
  expect(getWorkflow(s.f.db, "T1")?.mode).toBe("manual");
  expect(s.f.notices.slice(notices)).toHaveLength(1);
  expect(s.f.notices.at(-1)).toContain("本地提交");
  expect(s.creates).toEqual([]);
  expect(existsSync(s.wt)).toBe(false);
  expect(existsSync(join(s.repoDir, ".git", "FETCH_HEAD"))).toBe(false);
  expect(s.worktrees(s.repoDir)).not.toContain(s.wt);
}, 120_000);

test("RVSRC1 反例：作者在本机 → 仍用作者 cwd 建审查 worktree（repoDir 不动）", async () => {
  const s = await setup({ author: "local" });
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(s.worktrees(s.authorDir)).toContain(s.wt);
  expect(s.worktrees(s.repoDir)).not.toContain(s.wt);
  expect(s.creates.map((c) => c[1])).toEqual([NEW]);
  expect(await s.tick()).toMatchObject({ step: "sent" });
  expect(s.reviews().at(-1)).toMatchObject({ recipient: NEW, status: "done" });
  expect(sh(s.wt, "rev-parse", "HEAD")).toBe(s.head);
}, 120_000);

test("RVWT1 r1 legacy-window：-re 替代绑定后卡换了新 head（旧单退休来源已过窗口）→ 真实 pinReview 拒派，不向旧替代会话发新 head 的审查单", async () => {
  const s = await setup();
  expect(await s.tick()).toMatchObject({ step: "session" });
  writeFileSync(join(s.repoDir, "a.txt"), "next\n");
  sh(s.repoDir, "commit", "-q", "-am", "next");
  s.f.db.run("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'", [sh(s.repoDir, "rev-parse", "HEAD")]);
  const out = await s.tick();
  // 旧代码：-re 只看绑定建于 swap 之后，不核 swap 的 head/规格/轮次 → sent
  expect(out.step).toBe("manual");
  expect(out.detail).toEqual(expect.stringContaining("旧单退休替代来源已不是"));
  expect(s.reviews().filter((i) => i.recipient === NEW && i.status === "done")).toEqual([]);
  expect(sh(s.wt, "rev-parse", "HEAD")).toBe(s.head);
  expect(s.creates).toHaveLength(1);
}, 120_000);

test("RVSRC1 反例：已调 manager create 但结果未确认 → 照旧 unknown，卡仍 auto，不退人工", async () => {
  const s = await setup({ create: "unconfirmed" });
  const fallbacksBefore = s.fallbacks().length;
  expect(await s.tick()).toMatchObject({ step: "waiting" });
  const intent = getIntent(s.f.db, s.ensureIntent().id)!;
  expect(intent).toMatchObject({ status: "unknown" });
  expect(intent.receipt).toContain("新审查会话创建未确认");
  expect(s.creates).toHaveLength(1);
  expect(getWorkflow(s.f.db, "T1")?.mode).toBe("auto");
  expect(s.fallbacks()).toHaveLength(fallbacksBefore);
}, 120_000);

test("RVSRC1 源目录：peer PR 卡、本机作者不变；作者不在本机才取 repoDir，且 head 要是本地提交", async () => {
  const task = { id: "T1", project: "p", headSHA: "a".repeat(40), extra: {} } as unknown as LedgerTask;
  const read = () => ({ enabled: false, pollMs: 5000, autoDispatch: false, projects: { p: { repoDir: "/repo" } } }) as never;
  const seen: string[][] = [];
  const g = (code: number) => async (args: string[]) => { seen.push(args); return { code, out: "" }; };
  expect(await reviewSource(task, "agent-a", [{ name: "agent-a", cwd: "/author" }], g(0), read)).toEqual({ dir: "/author" });
  expect(await reviewSource(task, "agent-a", [{ name: "agent-a" }], g(0), read)).toEqual({ manual: "找不到作者工作目录，无法建立新的审查 worktree" });
  expect(seen).toEqual([]);
  expect(await reviewSource(task, null, [], g(0), read)).toEqual({ dir: "/repo" });
  expect(seen).toEqual([["-C", "/repo", "cat-file", "-e", `${"a".repeat(40)}^{commit}`]]);
  expect(await reviewSource(task, "agent-gone", [], g(128), read)).toMatchObject({ manual: expect.stringContaining("不是 /repo 的本地提交") });
  expect(await reviewSource(task, null, [], g(0), () => ({ enabled: false, pollMs: 5000, autoDispatch: false, projects: {} }) as never))
    .toMatchObject({ manual: expect.stringContaining("没有项目 p 的 repoDir") });
  expect(await reviewSource({ ...task, headSHA: null } as LedgerTask, null, [], g(0), read)).toMatchObject({ manual: expect.stringContaining("没有交付 head") });
});
