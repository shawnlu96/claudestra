/**
 * dispatch-recovery-RVCAP1 · 验收线 4：换审查员接续的容量回归走正式入口——真实 manager CLI 子进程（`ledger scheduler-review-swap`，
 * CLAUDESTRA_SCHEDULER_SERVICE=1 + 持有中的 singleton / maintenance lease），生产 createReplacement 建 worktree、生产 runManagerProcess
 * 起 `manager create`。唯一的假件是 PATH 里的 bun 包装：只截下 `manager.ts create` 这一个外部效果（记录参数与收到的 lease、照生产登记
 * registry），其余命令原样交给真 bun。临时 HOME / 状态 / 运行目录，台账与 registry 以符号链接进子进程的状态目录。
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { acquireLock } from "../src/lib/file-lock.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { localReviewerCount } from "../src/lib/scheduler-pool-facts.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { HOLD_OP } from "../src/lib/scheduler-review-swap.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { finishSwap, scenario } from "./scheduler-review-swap.test.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = resolve("src/manager.ts");
const OLD_STAGES = ["blocked", "fix", "merge", "live", "blocked", "fix", "merge"];
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

const sh = (dir: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** PATH 里的 bun：`manager.ts create` 记一行（参数、收到的 lease）、按 FAKE_CREATE 登记新会话或报失败；别的调用原样交给真 bun。 */
function fakeBun(dir: string, log: string, registry: string): string {
  const bin = join(dir, "fake-bin"), js = join(dir, "fake-bun.js");
  mkdirSync(bin, { recursive: true });
  writeFileSync(js, `const fs = require("node:fs");
const args = process.argv.slice(2), at = args.findIndex((a) => a.endsWith("manager.ts"));
if (at < 0 || args[at + 1] !== "create") {
  const p = Bun.spawnSync([process.execPath, ...args], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  process.exit(p.exitCode ?? 1);
}
const create = args.slice(at + 1), name = create[1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: create, lease: process.env.CLAUDESTRA_SCHEDULER_LEASE ?? null }) + "\\n");
// 并发用例：create 停在这里，直到测试放行（另一次 CLI 此时整段跑完）
while (process.env.FAKE_CREATE_GATE && !fs.existsSync(process.env.FAKE_CREATE_GATE)) await Bun.sleep(50);
if (process.env.FAKE_CREATE === "fail") { console.log(JSON.stringify({ ok: false, error: "manager create 超时" })); process.exit(1); }
const r = JSON.parse(fs.readFileSync(${JSON.stringify(registry)}, "utf8"));
r.agents[name] = { runtime: "codex", transport: "acp", sessionId: "s-new-" + process.pid, cwd: create[2], status: "active" };
fs.writeFileSync(${JSON.stringify(registry)}, JSON.stringify(r));
console.log(JSON.stringify({ ok: true, agent: name }));
`);
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(js)} "$@"\n`);
  chmodSync(join(bin, "bun"), 0o755);
  return bin;
}

function reviewer(db: Database, id: string, stage: string) {
  db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES (?, 'p', ?, 'code', ?, ?, 0, 0)`).run(id, id, stage, `author-${id}`);
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, 'reviewer', ?, ?, 'codex', 'acp', 'active', ?, 0, 0)`).run(id, `rv-${id}`, `s-${id}`, `i-${id}`);
}

/** 照调度器的正式写口记下本卡换审查员后的 ensure_session 意图（规划层名额放宽，只为让 CLI 有一张 pending 意图可推）。 */
function planEnsure(db: Database) {
  const task = getTask(db, "T1")!, workflow = getWorkflow(db, task.id)!;
  const plan = planScheduler(autoSnapshot(db, task, { registry: [], maxWorkers: 32 }));
  if (plan.kind !== "intent" || plan.action !== "ensure_session") throw new Error(JSON.stringify(plan));
  const seq = (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  return planIntent(db, { actor: "scheduler", now: Date.now() }, { id: plan.id, taskId: task.id, taskRev: task.rev, workflowRev: workflow.rev,
    causalSeq: seq, action: plan.action, node: plan.node, reason: plan.reason, resources: plan.resources }).intent;
}

/** 本卡（T1）旧审查员已正式换下；同项目再放 8 张别的卡的 active 审查绑定（stages 定它们的卡阶段）。 */
async function world(stages: string[]) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const p = await scenario();
  p.hello("Sekai", 0); p.hello("HedeMacBook-Pro", 0); // 无出借空位：只剩本机跨家族建会话一条路
  await finishSwap(p);
  const { f } = p;
  cleanup.push(() => { f.close(); errors.mockRestore(); });
  f.db.run("PRAGMA foreign_keys=OFF");
  stages.forEach((stage, i) => reviewer(f.db, `X${i}`, stage));
  f.db.run("PRAGMA foreign_keys=ON");
  // 作者在本机：审查 worktree 从作者 cwd 建，head 必须是那里的真实提交
  const repo = join(f.dir, "author-repo");
  mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  sh(repo, "add", "a.txt");
  sh(repo, "commit", "-q", "-m", "c");
  const head = sh(repo, "rev-parse", "HEAD");
  p.editRegistry((r) => { r.agents["agent-task-one"].cwd = repo; });
  f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [head]);
  const ensure = planEnsure(f.db);

  const shared = ["ledger.sqlite", "registry.json", "scheduler.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); rmSync(join(STATE_DIR, "worktrees"), { recursive: true, force: true }); };
  unlink();
  cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  symlinkSync(f.registryPath, shared[1]);
  writeFileSync(shared[2], JSON.stringify({ enabled: false, projects: { p: { maxActiveWorkers: 8, requiredChecks: ["ci"] } } }));
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  const lease = encodeLease({ singleton: { path: singletonPath, token: singleton.token }, maintenance: { path: maintenancePath, token: maintenance.token } });
  const home = join(f.dir, "home"), runtime = join(f.dir, "runtime"), log = join(f.dir, "creates.jsonl");
  for (const d of [home, runtime]) mkdirSync(d);
  const bin = fakeBun(f.dir, log, f.registryPath);
  const env = (extra: Record<string, string> = {}) => testChildEnv({ HOME: home, CLAUDESTRA_STATE_DIR: STATE_DIR, CLAUDESTRA_RUNTIME_DIR: runtime,
    CLAUDESTRA_TEST: "1", CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: lease, PATH: `${bin}:${process.env.PATH}`, ...extra });
  // 正式入口：调度服务对 driveReviewSwap 发出的同一条 manager 命令
  const cli = async (extra: Record<string, string> = {}) => {
    const c = Bun.spawn([process.execPath, "--no-env-file", MANAGER, "ledger", "scheduler-review-swap", ensure.id, "--max-workers", "8"],
      { env: env(extra), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text()]);
    await c.exited;
    if (err.includes("[test-guard]")) throw new Error(`子进程状态目录被改道：${err}`);
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const creates = (): { args: string[]; lease: string | null }[] =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const status = () => getIntent(f.db, ensure.id)?.status;
  return { p, f, cli, creates, status, ensure, head, lease, stopLease: () => singleton.release(), wt: join(STATE_DIR, "worktrees", "rv-t1") };
}

test("RVCAP1 真 CLI + 真 lease：真满 8 仍等待、零创建；N3 旧绑定形态下建一次新审查会话，create 收到的正是持有中的 lease，重放不重建", async () => {
  const full = await world(Array(8).fill("review"));
  expect(localReviewerCount(full.f.db, "p", "T1")).toBe(8);
  expect(await full.cli()).toMatchObject({ ok: true, step: "waiting", detail: expect.stringContaining("名额已满") });
  expect(full.status()).toBe("pending");
  expect(full.creates()).toEqual([]);
  for (const c of cleanup.splice(0).reverse()) c();

  const n3 = await world([...OLD_STAGES, "review"]);
  expect(localReviewerCount(n3.f.db, "p", "T1")).toBe(1); // 改前 8：同一条 CLI 返回「名额已满」
  expect(await n3.cli()).toMatchObject({ ok: true, step: "session" });
  expect(n3.creates()).toHaveLength(1);
  expect(n3.creates()[0]).toMatchObject({ lease: n3.lease, args: expect.arrayContaining(["create", "agent-task-rv-t1-r2", n3.wt, "--card", "T1", "--card-role", "reviewer"]) });
  expect(sh(n3.wt, "rev-parse", "HEAD")).toBe(n3.head);
  expect(n3.status()).toBe("done");
  expect(getSchedulerSession(n3.f.db, "T1", "reviewer")).toMatchObject({ agent: "agent-task-rv-t1-r2", createIntentId: n3.ensure.id, state: "active" });
  expect(await n3.cli()).toMatchObject({ ok: true, step: "session", detail: "审查会话处理已完成" });
  expect(n3.creates()).toHaveLength(1);
}, 180_000);

test("RVCAP1 真 CLI：两次并发调用同一张意图只建一次——第一次停在 create 时第二次跑完，只等绑定回执", async () => {
  const s = await world([...OLD_STAGES, "review"]);
  const gate = join(s.f.dir, "create-go");
  const first = s.cli({ FAKE_CREATE_GATE: gate });
  for (let n = 0; s.creates().length === 0; n++) { if (n > 600) throw new Error("第一次 CLI 没走到 create"); await Bun.sleep(50); }
  expect(s.status()).toBe("submitted");
  expect(await s.cli()).toMatchObject({ ok: true, step: "waiting", detail: expect.stringContaining("等待绑定回执") });
  writeFileSync(gate, "");
  expect(await first).toMatchObject({ ok: true, step: "session" });
  expect(s.creates()).toHaveLength(1);
  expect(s.status()).toBe("done");
}, 180_000);

test("RVCAP1 真 CLI：失租、模型安全拒绝未处置、批准撤回（交回 manual）都零创建，意图不动", async () => {
  const s = await world([...OLD_STAGES, "review"]);
  s.stopLease();
  expect(await s.cli()).toMatchObject({ ok: false, error: expect.stringMatching(/lease|租/i) });
  expect(s.creates()).toEqual([]);
  expect(s.status()).toBe("pending");
  for (const c of cleanup.splice(0).reverse()) c();

  const r = await world([...OLD_STAGES, "review"]);
  r.f.db.query("INSERT INTO events (ts, actor, project, target, kind, data) VALUES (?, 'scheduler', 'p', 'T1', 'note', ?)")
    .run(Date.now(), JSON.stringify({ op: HOLD_OP }));
  expect(await r.cli()).toMatchObject({ ok: false, error: expect.stringContaining("模型安全拒绝") });
  expect(r.creates()).toEqual([]);
  expect(r.status()).toBe("pending");
  for (const c of cleanup.splice(0).reverse()) c();

  const m = await world([...OLD_STAGES, "review"]);
  m.f.db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
  expect(await m.cli()).toMatchObject({ ok: false });
  expect(m.creates()).toEqual([]);
  expect(m.status()).toBe("pending");
}, 240_000);

test("RVCAP1 真 CLI：错 head / spec / round（taskRev）/ 新名字被别的会话占着，零创建", async () => {
  const drift: [string, (s: Awaited<ReturnType<typeof world>>) => void][] = [
    ["head", (s) => s.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["f".repeat(40)])],
    ["spec", (s) => s.f.db.run("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'")],
    ["round", (s) => s.f.db.run("UPDATE tasks SET rev = rev + 1, round = round + 1 WHERE id = 'T1'")],
  ];
  for (const [what, edit] of drift) {
    const s = await world([...OLD_STAGES, "review"]);
    edit(s);
    expect({ what, r: await s.cli() }).toMatchObject({ what, r: { ok: false, error: expect.stringContaining("变化") } });
    expect(s.creates()).toEqual([]);
    expect(s.status()).toBe("pending");
    for (const c of cleanup.splice(0).reverse()) c();
  }
  const sid = await world([...OLD_STAGES, "review"]);
  sid.p.editRegistry((r) => { r.agents["agent-task-rv-t1-r2"] = { runtime: "codex", transport: "acp", sessionId: "someone-else", status: "active" }; });
  expect(await sid.cli()).toMatchObject({ ok: true, step: "waiting", detail: expect.stringContaining("被其他会话占用") });
  expect(sid.creates()).toEqual([]);
  expect(sid.status()).toBe("unknown");
  expect(await sid.cli()).toMatchObject({ ok: true, step: "held" });
  expect(sid.creates()).toEqual([]);
}, 300_000);

test("RVCAP1 真 CLI：create 结果未知 → unknown，再推不重复创建", async () => {
  const s = await world([...OLD_STAGES, "review"]);
  expect(await s.cli({ FAKE_CREATE: "fail" })).toMatchObject({ ok: true, step: "waiting", detail: expect.stringContaining("创建未确认") });
  expect(s.creates()).toHaveLength(1);
  expect(s.status()).toBe("unknown");
  expect(await s.cli()).toMatchObject({ ok: true, step: "held" });
  expect(s.creates()).toHaveLength(1);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "retired" }); // 没绑上新会话
}, 180_000);
