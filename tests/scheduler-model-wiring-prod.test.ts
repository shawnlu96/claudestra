/**
 * dispatch-recovery-MODELXW · MODELX wired the way src/scheduler.ts runs it: the auto tick reads a query_only LedgerReader and
 * every write goes through the real ledger CLI in a child process (scheduler identity, lease, minimal env, temp HOME / TMPDIR /
 * state dir). Old code: the snapshot / MODEL record / epoch hit the read-only handle ("attempt to write a readonly database") and
 * the card fell back to manual. New code: snapshot before the order, first policy refusal → MODEL record → epoch → new session →
 * exempt order with its own snapshot, no readonly error anywhere. Only the review-swap step (its own CLI command, not this card's)
 * runs in-process with fake agent creation, as in tests/scheduler-model-exec-material.test.ts.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { informKey, snapshotKey } from "../src/lib/scheduler-model-wiring.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const EX = "agent-task-rv-t1-r1-ex";
const MANAGER = resolve("src/manager.ts");
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

async function setup(mode: "on" | "observe" = "on") {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); });
  writeFileSync(join(f.dir, "T1.md"), "# T1\n验收：原文\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(f.dir, "T1.md")]);
  // One state dir for the tick and its CLI children, as in production (the order text names statePath): the children run in this
  // process's test state dir, whose ledger / registry are links to the fixture's (SQLite resolves the link for its WAL files).
  const shared = ["ledger.sqlite", "registry.json", "recovery-policy.json"].map((n) => join(STATE_DIR, n));
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); };
  unlink();
  cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  symlinkSync(f.registryPath, shared[1]);
  writeFileSync(shared[2], JSON.stringify({ projects: { p: { keys: { modelOutcome: mode } } } }));
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  const home = join(f.dir, "home"), tmp = join(f.dir, "tmp"), runtime = join(f.dir, "runtime");
  for (const d of [home, tmp, runtime]) mkdirSync(d);
  const env = testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: STATE_DIR, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const calls: string[] = [];
  /** The production write path: `bun src/manager.ts ledger <sub> …` as its own process, JSON out. */
  const child: AutoTickDeps["manager"] = async (...args) => {
    calls.push(args[1]);
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const swapDeps = (): ReviewSwapDeps => ({
    registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: async () => ({ ok: true }),
    ensure: async (task, family) => {
      const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
      r.agents[EX] = { runtime: family === "codex" ? "codex" : "claude-code", sessionId: "s-ex", cwd: join(f.dir, "rv-ex") };
      writeFileSync(f.registryPath, JSON.stringify(r));
      return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: EX, sessionId: "s-ex", family, transport: "tmux" } };
    },
  });
  const manager: AutoTickDeps["manager"] = (...a) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message })) : child(...a);
  let refusal: string | null = null;
  const realWorker = f.tickDeps.worker;
  const deps: AutoTickDeps = { ...f.tickDeps, manager, now: () => Date.now(), worker: (ref) => {
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
  const readonlyLines = () => errors.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => /readonly/.test(l));
  const ops = (op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
  const reviews = () => f.intents().filter((i) => i.action === "review");
  // build → deliver, then the review order goes out through the read-only tick
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  return { f, tick, calls, ops, reviews, readonlyLines, refuse: (m: string | null) => { refusal = m; } };
}

function approve(f: ReturnType<typeof autoFixture>) {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1999);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2000, final: true });
}

test("生产接线：只读句柄 + 真实台账 CLI——派审前写快照，首次策略拒审 → 模型结果 → epoch → 新会话 → 豁免单（带快照），全程无只读报错", async () => {
  const s = await setup();
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const first = s.reviews().at(-1)!;
  // 派审前：快照经 scheduler-review-snapshot 写入（旧代码这里没有快照事件）
  expect(getEventByDedup(s.f.db, snapshotKey(first.id))).toMatchObject({ actor: "scheduler", data: { op: "review_material_snapshot", intentId: first.id } });
  expect(s.calls).toContain("scheduler-review-snapshot");
  approve(s.f);
  s.refuse(CYBER);
  expect(await s.tick()).toMatchObject({ step: "refusal_epoch" });
  // 模型结果、epoch、owner 告知都经台账 CLI 落库（旧代码：记模型结果失败，照旧退人工）
  expect(s.ops("model_refusal_retry").length + s.ops("model_refusal_exempt").length).toBe(1);
  expect(s.ops("reviewer_swap")).toMatchObject([{ data: { intentId: first.id, refusal: { executed: "exempt_review" } } }]);
  expect(getEventByDedup(s.f.db, informKey("T1", "cyber_policy"))).toMatchObject({ data: { op: "refusal_owner_inform" } });
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "retired" });
  s.refuse(null);
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const exempt = s.reviews().filter((i) => i.recipient === EX);
  expect(exempt).toHaveLength(1);
  expect(getEventByDedup(s.f.db, snapshotKey(exempt[0].id))!.data.digest).toBe(getEventByDedup(s.f.db, snapshotKey(first.id))!.data.digest);
  expect(s.f.notices.filter((n) => n.includes("退回人工") || n.includes("不可用"))).toEqual([]);
  expect(s.readonlyLines()).toEqual([]);
  expect(s.calls).toEqual(expect.arrayContaining(["scheduler-model-outcome", "scheduler-refusal-epoch", "scheduler-model-inform"]));
}, 120_000);

test("生产接线：observe 下拒审只记 MODEL 观察，不开 epoch、照旧退人工，同样不碰只读句柄", async () => {
  const s = await setup("observe");
  expect(await s.tick()).toMatchObject({ step: "sent" });
  approve(s.f);
  s.refuse(CYBER);
  expect(await s.tick()).toMatchObject({ step: "manual" });
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(listEvents(s.f.db, { project: "p", target: "T1" }).filter((e) => e.data.mode === "observe" && String(e.data.op).startsWith("model_"))).toHaveLength(1);
  expect(s.readonlyLines()).toEqual([]);
}, 120_000);

test("调度服务身份闸：别的身份跑四个子命令一律 forbidden", async () => {
  const f = autoFixture();
  cleanup.push(() => f.close());
  for (const args of [["scheduler-review-snapshot", "x", "--round", "1", "--data", "{\"order\":\"o\"}"], ["scheduler-model-outcome", "x", "--data", "{}"],
    ["scheduler-refusal-epoch", "T1", "--plan-seq", "1", "--data", "{}"], ["scheduler-model-inform", "T1", "--key", "k", "--text", "t", "--data", "{}"]]) {
    expect(await f.cli("pm", ...args)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("agent-task-one", ...args)).toMatchObject({ ok: false, code: "forbidden" });
  }
  // 调度身份也只能写本卡的告知键
  expect(await f.cli("scheduler", "scheduler-model-inform", "T1", "--key", informKey("T2", "cyber_policy"), "--text", "t", "--data", "{\"op\":\"refusal_owner_inform\"}"))
    .toMatchObject({ ok: false, code: "invalid" });
});
