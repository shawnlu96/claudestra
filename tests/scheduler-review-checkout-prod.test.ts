/**
 * dispatch-recovery-RVWT1 · a formal refusal-epoch replacement reviewer, created and then dispatched the way src/scheduler.ts runs
 * it: read-only LedgerReader tick, real ledger CLI children (temp HOME / TMPDIR / state dir, lease), the real MODELX writers
 * (snapshot → model outcome → epoch → bind), production createReplacement with a fake `manager create`, and production
 * autoTickDeps pinReview on temporary git repositories. Old code: create `-ex` succeeded, then pinReview only knew `rv-<task>` and
 * refused the order. The refusal is a synthetic, controlled turn failure for the wiring only — no real model, network, registry or tmux.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { reviewMaterialCheck } from "../src/lib/scheduler-model-wiring.js";
import { latestReviewerSwap } from "../src/lib/scheduler-review-swap.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createReplacement, reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import * as reviewWorktree from "../src/lib/scheduler-review-worktree.js";
import { git as realGit, openReviewWorktree, type Git } from "../src/lib/scheduler-review-worktree.js";
import { bindSchedulerSession, getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const EX = "agent-task-rv-t1-r1-ex";
const MANAGER = resolve("src/manager.ts");
let cleanup: (() => void)[] = [];
const realWs = globalThis.WebSocket;
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); globalThis.WebSocket = realWs; });

/** The production bridgeSend over an in-memory socket whose open is late: `during` runs inside the handshake, before onopen. */
function slowBridge(during: () => void): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  class SlowWs {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void; onclose?: () => void;
    constructor() { setTimeout(() => { during(); this.onopen?.(); }, 5); }
    send(raw: string) {
      const m = JSON.parse(raw);
      frames.push(m);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ requestId: m.requestId, result: { targetChannelId: "c" } }) }));
    }
    close() { /* nothing to release in the double */ }
  }
  globalThis.WebSocket = SlowWs as never;
  return frames;
}

const sh = (dir: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

async function setup(at: "state" | "inject" = "inject") {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); });
  writeFileSync(join(f.dir, "T1.md"), "# T1\n验收：原文\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(f.dir, "T1.md")]);
  const shared = ["ledger.sqlite", "registry.json", "recovery-policy.json"].map((n) => join(STATE_DIR, n)), stateTrees = join(STATE_DIR, "worktrees");
  const unlink = () => { for (const at of shared) rmSync(at, { force: true }); rmSync(stateTrees, { recursive: true, force: true }); };
  unlink();
  cleanup.push(unlink);
  symlinkSync(join(f.dir, "ledger.sqlite"), shared[0]);
  symlinkSync(f.registryPath, shared[1]);
  writeFileSync(shared[2], JSON.stringify({ projects: { p: { keys: { modelOutcome: "on" } } } }));
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  const home = join(f.dir, "home"), tmp = join(f.dir, "tmp"), runtime = join(f.dir, "runtime");
  for (const d of [home, tmp, runtime]) mkdirSync(d);
  const env = testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: STATE_DIR, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const child: AutoTickDeps["manager"] = async (...args) => {
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };

  // The author's repository (the card's head is a real local commit) and the ordinary reviewer's checkout as createReviewer leaves it.
  const authorDir = join(f.dir, "author"), root = at === "state" ? stateTrees : join(f.dir, "worktrees");
  mkdirSync(authorDir);
  sh(authorDir, "init", "-q", "-b", "main");
  writeFileSync(join(authorDir, "a.txt"), "one\n");
  sh(authorDir, "add", "a.txt");
  sh(authorDir, "commit", "-q", "-m", "one");
  const base = sh(authorDir, "rev-parse", "HEAD");
  writeFileSync(join(authorDir, "a.txt"), "two\n");
  sh(authorDir, "commit", "-q", "-am", "two");
  const head = sh(authorDir, "rev-parse", "HEAD");
  const rv = join(root, "rv-t1"), ex = join(root, "rv-t1-ex");
  expect(await openReviewWorktree(authorDir, rv, base)).toEqual({ dir: rv });
  const editRegistry = (fn: (r: { agents: Record<string, Record<string, unknown>> }) => void) => {
    const r = JSON.parse(readFileSync(f.registryPath, "utf8")); fn(r); writeFileSync(f.registryPath, JSON.stringify(r));
  };
  editRegistry((r) => { r.agents["agent-task-one"].cwd = authorDir; r.agents["agent-rv-t1"].cwd = rv; });

  // `manager create` registers the new session in the directory it was given, as production does
  const creates: string[][] = [];
  const fakeAgent: ReviewSwapDeps["agent"] = async (...args) => {
    if (args[0] !== "create") return { ok: true };
    creates.push(args);
    const codex = args.includes("codex");
    editRegistry((r) => { r.agents[args[1]] = { runtime: codex ? "codex" : "claude-code", ...(codex ? { transport: "acp" } : {}), sessionId: "s-ex", cwd: args[2] }; });
    return { ok: true };
  };
  const swapDeps = (): ReviewSwapDeps => ({ registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: fakeAgent,
    ensure: (task, family, old, tag, current) => at === "state" ? createReplacement(f.db, task, family, old, fakeAgent, tag, { current })
      : createReplacement(f.db, task, family, old, fakeAgent, tag, { root, current }) });
  const manager: AutoTickDeps["manager"] = (...a) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message }))
    : child(...a);
  // production pin: same worktree root as creation; onCheckout runs right after the checkout effect (state moving under git)
  let onCheckout: (() => void) | null = null;
  const git: Git = async (args) => { const r = await realGit(args); if (args.includes("checkout")) onCheckout?.(); return r; };
  const prod = autoTickDeps(f.db, { registryPath: f.registryPath, git, ...(at === "state" ? {} : { worktreeRoot: root }) }); // state: both production defaults
  let refusal: string | null = null, prodWorker = false;
  const realWorker = f.tickDeps.worker;
  const deps: AutoTickDeps = { ...f.tickDeps, manager, now: () => Date.now(), pinReview: prod.pinReview, worker: (r) => {
    const w = prodWorker ? prod.worker(r) : realWorker(r);
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

  /** ordinary review → real policy refusal path → formal epoch (the refused binding retired, no replacement yet) */
  const toEpoch = async () => {
    expect(await tick()).toMatchObject({ step: "sent" });
    expect(reviews().at(-1)).toMatchObject({ recipient: "agent-rv-t1", status: "done" });
    expect(sh(rv, "rev-parse", "HEAD")).toBe(head);
    approve(f);
    refusal = CYBER;
    expect(await tick()).toMatchObject({ step: "refusal_epoch" });
    refusal = null;
  };
  /** … then createReplacement binds the -ex session (no order yet) */
  const toReplacement = async () => {
    await toEpoch();
    expect(await tick()).toMatchObject({ step: "session" });
    expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ agent: EX, sessionId: "s-ex", state: "active" });
    expect(creates.map((c) => c.slice(0, 3))).toEqual([["create", EX, ex]]);
  };
  const exRef = (): SessionRef => {
    const b = getSchedulerSession(f.db, "T1", "reviewer")!;
    return { taskId: "T1", role: "reviewer", agent: b.agent, sessionId: b.sessionId, family: b.family, transport: b.transport as "acp" | "tmux" };
  };
  return { f, tick, reviews, toEpoch, toReplacement, creates, editRegistry, prod, exRef, head, base, authorDir, root, rv, ex, stateTrees,
    onCheckout: (fn: (() => void) | null) => { onCheckout = fn; }, prodWorker: () => { prodWorker = true; } };
}

function approve(f: ReturnType<typeof autoFixture>, at = 2000) {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, at - 1);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at, final: true });
}

function revoke(f: ReturnType<typeof autoFixture>) {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Revoke refusal rule", askKey: "policy-refusal-rule" }, 2001);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_stop]"], labels: ["stop"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2002, final: true });
}

const exOrders = (s: Awaited<ReturnType<typeof setup>>) => s.reviews().filter((i) => i.recipient === EX && i.status === "done");

const ROOTS = { state: "生产默认根", inject: "同一注入根" } as const;
for (const at of ["state", "inject"] as const) test(`RVWT1 旧红新绿（${ROOTS[at]}）：正式拒审替代 → createReplacement 建 rv-<task>-ex → `
  + "autoTickDeps 派审同一目录、固定 head；旧会话目录不动、只建一次", async () => {
  const s = await setup(at);
  await s.toReplacement();
  // 旧代码：这里 pinReview 只认 rv-t1，"agent-task-rv-t1-r1-ex 的工作目录 …-ex 不是它独立的审查 worktree"，单子未投递、退人工
  expect(await s.tick()).toMatchObject({ step: "sent" });
  expect(exOrders(s)).toHaveLength(1);
  expect(sh(s.ex, "rev-parse", "HEAD")).toBe(s.head);
  expect(JSON.parse(readFileSync(s.f.registryPath, "utf8")).agents[EX].cwd).toBe(s.ex); // registry 路径没被改来凑匹配
  expect(sh(s.rv, "rev-parse", "HEAD")).toBe(s.head); // 旧拒审会话的目录还在、未被覆盖
  expect(s.creates).toHaveLength(1);
  if (at === "inject") expect(existsSync(s.stateTrees)).toBe(false); // 注入的根在创建端与派审端一致，没落到状态根
  expect(s.f.notices.filter((n) => n.includes("不是它独立的审查 worktree"))).toEqual([]);
}, 120_000);

test("RVWT1 反例：-ex 目录 / 名字不给豁免——普通审查住在 rv-<task>-ex（无替代来源）照旧拒派，不切 head", async () => {
  const s = await setup();
  expect(await openReviewWorktree(s.authorDir, s.ex, s.base)).toEqual({ dir: s.ex });
  s.editRegistry((r) => { r.agents["agent-rv-t1"].cwd = s.ex; });
  expect(await s.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("不是它独立的审查 worktree") });
  expect(s.reviews().filter((i) => i.status === "done")).toEqual([]);
  expect(sh(s.ex, "rev-parse", "HEAD")).toBe(s.base);
}, 120_000);

test("RVWT1 反例：已绑定的 -ex 会话——旧 head/轮次/规格、他卡、session/家族漂移、目录指向作者树或同前缀邻居一律不派、不动 worktree", async () => {
  const s = await setup();
  await s.toReplacement();
  const task = s.f.task(), ref = s.exRef();
  expect(await openReviewWorktree(s.authorDir, s.ex, s.base)).toEqual({ dir: s.ex }); // 已存在，切回 base 方便看有没有被动
  const pin = (r: SessionRef = ref) => s.prod.pinReview(s.f.task(), r, s.head);
  for (const [col, v] of [["headSHA", s.base], ["round", task.round + 1], ["specRev", task.specRev + 1]] as const) {
    s.f.db.run(`UPDATE tasks SET ${col} = ? WHERE id = 'T1'`, [v]);
    expect(await pin()).toEqual({ manual: expect.stringContaining("拒审替代来源已不是") });
    s.f.db.run(`UPDATE tasks SET ${col} = ? WHERE id = 'T1'`, [task[col]]);
  }
  for (const r of [{ ...ref, taskId: "T2" }, { ...ref, sessionId: "s-other" }, { ...ref, family: ref.family === "codex" ? "claude" as const : "codex" as const },
    { ...ref, agent: "agent-rv-t1", sessionId: "s-rv" }]) {
    expect(await pin(r)).toEqual({ manual: expect.stringContaining("不是本卡当前正式审查绑定") });
  }
  for (const cwd of [s.authorDir, s.rv, `${s.ex}2`]) {
    s.editRegistry((r) => { r.agents[EX].cwd = cwd; });
    expect(await pin()).toEqual({ manual: expect.stringContaining("不是它独立的审查 worktree") });
  }
  s.editRegistry((r) => { r.agents[EX].cwd = s.ex; });
  expect(sh(s.ex, "rev-parse", "HEAD")).toBe(s.base);
  expect(sh(s.authorDir, "status", "--porcelain")).toBe("");
  // tracked 改动不覆盖
  writeFileSync(join(s.ex, "a.txt"), "reviewer edit\n");
  expect(await s.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("已跟踪文件被改过") });
  expect(readFileSync(join(s.ex, "a.txt"), "utf8")).toBe("reviewer edit\n");
  expect(exOrders(s)).toEqual([]);
  expect(s.creates).toHaveLength(1);
}, 120_000);

test("RVWT1 反例：批准撤销、材料漂移照旧退人工，不向 -ex 会话发单、不重复创建", async () => {
  for (const lapse of ["revoke", "material"] as const) {
    const s = await setup();
    await s.toReplacement();
    if (lapse === "revoke") revoke(s.f);
    else writeFileSync(join(s.f.dir, "T1.md"), "# T1\n验收：改过\n");
    expect(await s.tick()).toMatchObject({ step: "manual" });
    expect(exOrders(s)).toEqual([]);
    expect(s.creates).toHaveLength(1);
    for (const c of cleanup.splice(0).reverse()) c();
  }
}, 240_000);

test("RVWT1 反例：固定 head 的 git 效果期间 head 变了 / 批准撤销 → 不向 -ex 会话派单", async () => {
  for (const during of ["head", "revoke"] as const) {
    const s = await setup();
    await s.toReplacement();
    s.onCheckout(() => { if (during === "head") s.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [s.base]); else revoke(s.f); });
    const out = await s.tick();
    expect(out.step).not.toBe("sent");
    if (during === "head") expect(out).toMatchObject({ detail: expect.stringContaining("固定 head 期间变了") });
    expect(exOrders(s)).toEqual([]);
    expect(s.creates).toHaveLength(1);
    for (const c of cleanup.splice(0).reverse()) c();
  }
}, 240_000);

test("RVWT1 r1 cwd-drift：正式 -ex 绑定后，固定 head 的 checkout 期间 registry 目录移到作者树 → 不派审（复核实际 cwd，不只比规范目录）", async () => {
  const s = await setup();
  await s.toReplacement();
  s.onCheckout(() => s.editRegistry((r) => { r.agents[EX].cwd = s.authorDir; })); // 同一 agent / session，只有目录变了
  const out = await s.tick();
  // 旧代码：git 后只重算规范目录（没变）→ sent，向住在作者树的会话派了审查单
  expect(out.step).toBe("manual");
  expect(out.detail).toEqual(expect.stringMatching(/固定 head 期间变了.*不是它独立的审查 worktree/));
  expect(exOrders(s)).toEqual([]);
  expect(sh(s.authorDir, "status", "--porcelain")).toBe("");
  expect(s.creates).toHaveLength(1);
}, 120_000);

test("RVWT1 r1 create-drift：正式拒审 epoch 后 createReplacement 首个 git 期间卡的 head/rev 变了 → 后续 worktree add / manager create 都不做", async () => {
  const s = await setup();
  await s.toEpoch();
  const real = reviewWorktree.git;
  let moved = false;
  const spy = spyOn(reviewWorktree, "git").mockImplementation(async (args) => {
    const r = await real(args);
    if (!moved) { moved = true; s.f.db.run("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'", [s.base]); }
    return r;
  });
  cleanup.push(() => spy.mockRestore());
  const out = await s.tick();
  spy.mockRestore();
  expect(moved).toBe(true);
  // 旧代码：内部 active 只核 lease 和 refusalEpochLapse（窗口外答 null）→ 照样建旧 head 的 -ex 工作树、调 create 一次
  expect(out.step).not.toBe("session");
  expect(s.creates).toEqual([]);
  expect(existsSync(s.ex)).toBe(false);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ agent: "agent-rv-t1", state: "retired" });
  expect(s.f.intents().findLast((i) => i.action === "ensure_session")).toMatchObject({ status: "submitted" }); // 已认领，不重复创建
  expect(exOrders(s)).toEqual([]);
}, 120_000);

test("RVWT1 r2 cwd-drift：生产 worker / bridgeSend 派审，ws 握手期间目录移到作者树、绑定换人、卡 head/rev 变了 → 不发帧、审查意图不结 done", async () => {
  for (const during of ["cwd", "binding", "head"] as const) {
    const s = await setup();
    await s.toReplacement();
    s.prodWorker();
    const frames = slowBridge(() => {
      if (during === "cwd") s.editRegistry((r) => { r.agents[EX].cwd = s.authorDir; });
      else if (during === "binding") s.f.db.run("UPDATE scheduler_sessions SET sessionId = 's-other' WHERE agent = ? AND state = 'active'", [EX]);
      else s.f.db.run("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'", [s.base]);
    });
    const out = await s.tick();
    // 旧代码：发送入口复核早于握手，onopen 的 stillActive 只核服务 / lease → step=sent、frames=1、旧意图 done
    expect(frames).toEqual([]);
    expect(out.step).not.toBe("sent");
    expect(exOrders(s)).toEqual([]);
    expect(s.creates).toHaveLength(1);
    for (const c of cleanup.splice(0).reverse()) c();
  }
}, 240_000);

test("RVWT1 r2 create-drift：createReplacement 首个 git 期间正式 writer 已把审查绑定给别的会话 → 不再 worktree add / manager create", async () => {
  const s = await setup();
  await s.toEpoch();
  const family = latestReviewerSwap(listEvents(s.f.db, { project: "p", target: "T1" }))!.data.toFamily as "claude" | "codex";
  s.editRegistry((r) => { r.agents["agent-competing"] = { runtime: family === "codex" ? "codex" : "claude-code", sessionId: "s-comp", cwd: s.rv }; });
  const real = reviewWorktree.git;
  let bound = false;
  const spy = spyOn(reviewWorktree, "git").mockImplementation(async (args) => {
    const r = await real(args);
    if (!bound) {
      bound = true;
      const ensure = s.f.intents().findLast((i) => i.action === "ensure_session")!;
      bindSchedulerSession(s.f.db, s.f.at("scheduler"), { taskId: "T1", role: "reviewer", agent: "agent-competing", sessionId: "s-comp", family,
        transport: "tmux", intentId: ensure.id, registryPath: s.f.registryPath, refusalCheck: reviewMaterialCheck(s.f.db) });
    }
    return r;
  });
  cleanup.push(() => spy.mockRestore());
  const out = await s.tick();
  spy.mockRestore();
  expect(bound).toBe(true);
  // 旧代码：current 只核卡窗口 / 版本 / 拒审授权（task.rev 没变）→ 照样 worktree add、create 一次，最后 bind 才冲突
  expect(out.step).not.toBe("session");
  expect(s.creates).toEqual([]);
  expect(existsSync(s.ex)).toBe(false);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ agent: "agent-competing", state: "active" }); // 正式绑定保留
  expect(exOrders(s)).toEqual([]);
}, 120_000);
