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
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { HOLD_OP, openRefusal } from "../src/lib/scheduler-review-swap.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const EX = "agent-task-rv-t1-r1-ex";
const MANAGER = resolve("src/manager.ts");
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

async function setup(mode: "on" | "observe" = "on", duringEnsure?: (f: ReturnType<typeof autoFixture>) => void,
  beforeCli?: (command: string, f: ReturnType<typeof autoFixture>) => void) {
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
    beforeCli?.(args[1], f);
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const tags: string[] = [];
  const swapDeps = (): ReviewSwapDeps => ({
    registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: async () => ({ ok: true }),
    ensure: async (task, family, _old, tag) => {
      tags.push(tag ?? "");
      duringEnsure?.(f);
      const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
      const transport = family === "codex" ? "acp" as const : "tmux" as const;
      r.agents[EX] = { runtime: family === "codex" ? "codex" : "claude-code", sessionId: "s-ex", cwd: join(f.dir, "rv-ex"), ...(family === "codex" ? { transport } : {}) };
      writeFileSync(f.registryPath, JSON.stringify(r));
      return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: EX, sessionId: "s-ex", family, transport } };
    },
  });
  // legacy: the old code's read-only failures (MODELXW 现象) for the listed subcommands — the order still went out, nothing was written
  const legacy = new Set<string>();
  const manager: AutoTickDeps["manager"] = (...a) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message }))
    : legacy.has(a[1]) ? Promise.resolve({ ok: false, code: "write_failed", error: "attempt to write a readonly database" }) : child(...a);
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
  return { f, tick, calls, ops, reviews, readonlyLines, refuse: (m: string | null) => { refusal = m; }, legacy, tags };
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
    ["scheduler-refusal-epoch", "T1", "--plan-seq", "1", "--data", "{}"], ["scheduler-model-inform", "T1", "--key", "k", "--text", "t", "--data", "{}"],
    ["scheduler-legacy-review-retire", "T1", "--intent", "x", "--data", "{\"evidence\":\"cyber_policy\"}"]]) {
    expect(await f.cli("pm", ...args)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("agent-task-one", ...args)).toMatchObject({ ok: false, code: "forbidden" });
  }
  // 调度身份也只能写本卡的告知键
  expect(await f.cli("scheduler", "scheduler-model-inform", "T1", "--key", informKey("T2", "cyber_policy"), "--text", "t", "--data", "{\"op\":\"refusal_owner_inform\"}"))
    .toMatchObject({ ok: false, code: "invalid" });
});

/** N3 / PR706 (10-06 23:19): the review went out under the old code — no snapshot; the refusal's MODEL record hit the read-only
 * handle and the card fell back to manual; PM handed it back to auto under on. */
async function legacyCard(s: Awaited<ReturnType<typeof setup>>, outcomeFails = true) {
  s.legacy.add("scheduler-review-snapshot");
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const old = s.reviews().at(-1)!;
  expect(getEventByDedup(s.f.db, snapshotKey(old.id))).toBeNull();
  if (outcomeFails) s.legacy.add("scheduler-model-outcome");
  approve(s.f);
  s.refuse(CYBER);
  expect(await s.tick()).toMatchObject({ step: "manual" });
  s.legacy.clear();
  const w = getWorkflow(s.f.db, "T1")!;
  expect(await s.f.cli("pm", "workflow-resume", "T1", "--rev", String(s.f.task().rev), "--workflow-rev", String(w.rev), "--reason", "监工：交回 auto"))
    .toMatchObject({ ok: true });
  return old;
}

test("legacy-no-snapshot: snapshot-only failure with recorded MODEL plan recovers through continuous readonly ticks", async () => {
  const s = await setup();
  const old = await legacyCard(s, false);
  expect(s.ops("model_refusal_retry").length + s.ops("model_refusal_exempt").length).toBe(1);
  expect(await s.tick()).toMatchObject({ step: "legacy_review" });
  s.refuse(null);
  const next = [];
  for (let i = 0; i < 3; i++) next.push(await s.tick());
  expect(next.some((r) => r?.step === "sent")).toBe(true);
  expect(s.reviews()).toHaveLength(2);
  expect(s.reviews().at(-1)!.id).not.toBe(old.id);
  expect(getEventByDedup(s.f.db, snapshotKey(s.reviews().at(-1)!.id))).not.toBeNull();
  expect(s.ops("reviewer_swap")[0].data.refusal).toBeUndefined();
  const plan = [...s.ops("model_refusal_retry"), ...s.ops("model_refusal_exempt")][0];
  expect(s.ops("reviewer_swap")[0].data.replacedPlanSeq).toBe(plan.seq);
  const events = listEvents(s.f.db, { project: "p", target: "T1" }), swap = s.ops("reviewer_swap")[0];
  for (const key of ["replacedPlanSeq", "intentId", "sessionId", "sentHead", "sentSpecRev", "round"]) {
    const mismatched = events.map((e) => e.seq === swap.seq ? { ...e, data: { ...e.data, [key]: "unrelated" } } : e);
    expect(openRefusal(mismatched)?.seq).toBe(plan.seq);
  }
  const safety = { ...plan, seq: events.at(-1)!.seq + 1, data: { op: HOLD_OP } };
  expect(openRefusal([...events, safety])?.seq).toBe(safety.seq);
  s.refuse(CYBER);
  expect(await s.tick()).toMatchObject({ step: "refusal_epoch" });
}, 120_000);

function hold(f: ReturnType<typeof autoFixture>) {
  f.db.run("UPDATE tasks SET extra = json_set(extra, '$.refusalHold', json('true')) WHERE id = 'T1'");
}

test("legacy-owner-hold: writer rereads hold added after readonly retirement check", async () => {
  const s = await setup("on", undefined, (command, f) => {
    if (command === "scheduler-legacy-review-retire") hold(f);
  });
  await legacyCard(s);
  await s.tick();
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")?.state).toBe("active");
  expect(s.tags).toEqual([]);
}, 120_000);

test("legacy-owner-hold: hold added during ensure prevents binding the created session", async () => {
  const s = await setup("on", (f) => hold(f));
  await legacyCard(s);
  expect(await s.tick()).toMatchObject({ step: "legacy_review" });
  s.refuse(null);
  await s.tick();
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "retired" });
  expect(s.reviews()).toHaveLength(1);
}, 120_000);

for (const command of ["scheduler-review-snapshot", "scheduler-settle"]) {
  test(`legacy-owner-hold: hold during ${command} await prevents delivery`, async () => {
    let armed = false;
    const s = await setup("on", undefined, (sub, f) => { if (armed && sub === command) hold(f); });
    await legacyCard(s);
    expect(await s.tick()).toMatchObject({ step: "legacy_review" });
    s.refuse(null);
    expect(await s.tick()).toMatchObject({ step: "session" });
    const sent = s.f.sent.length;
    armed = true;
    await s.tick();
    expect(s.f.sent).toHaveLength(sent);
  }, 120_000);
}

test("legacy-owner-hold: hold before retirement blocks all replacement effects", async () => {
  const s = await setup();
  await legacyCard(s);
  hold(s.f);
  await s.tick();
  s.refuse(null);
  await s.tick();
  await s.tick();
  expect(s.reviews()).toHaveLength(1);
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")?.state).toBe("active");
  expect(s.tags).toEqual([]);
}, 120_000);

for (const boundary of ["after-retirement", "before-dispatch"] as const) {
  test(`legacy-owner-hold: ${boundary} newly added hold blocks next effects`, async () => {
    const s = await setup();
    await legacyCard(s);
    expect(await s.tick()).toMatchObject({ step: "legacy_review" });
    s.refuse(null);
    if (boundary === "before-dispatch") expect(await s.tick()).toMatchObject({ step: "session" });
    hold(s.f);
    for (let i = 0; i < 3; i++) await s.tick();
    expect(s.reviews()).toHaveLength(1);
    expect(s.tags).toHaveLength(boundary === "before-dispatch" ? 1 : 0);
    expect(s.f.task().extra.refusalHold).toBe(true);
  }, 120_000);
}

function revoke(f: ReturnType<typeof autoFixture>) {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Revoke refusal rule", askKey: "policy-refusal-rule" }, 2001);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_stop]"], labels: ["stop"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at: 2002, final: true });
}

for (const boundary of ["before-retirement", "after-retirement", "during-ensure", "before-dispatch"] as const) {
  test(`legacy-owner-hold: ${boundary} revoked approval blocks binding and dispatch`, async () => {
    const s = await setup("on", boundary === "during-ensure" ? revoke : undefined);
    await legacyCard(s);
    if (boundary !== "before-retirement") expect(await s.tick()).toMatchObject({ step: "legacy_review" });
    if (boundary === "before-dispatch") {
      s.refuse(null);
      expect(await s.tick()).toMatchObject({ step: "session" });
    }
    if (boundary !== "during-ensure") revoke(s.f);
    for (let i = 0; i < 3; i++) await s.tick();
    expect(s.reviews()).toHaveLength(1);
    expect(getSchedulerSession(s.f.db, "T1", "reviewer")?.sessionId).toBe(boundary === "before-dispatch" ? "s-ex" : "s-rv");
    expect(s.tags).toHaveLength(boundary === "during-ensure" || boundary === "before-dispatch" ? 1 : 0);
  }, 120_000);
}

test("旧拒审单接续（验收线 4）：无快照旧单交回 auto → 退休旧绑定（不唤醒、不豁免）→ 新会话 → 按当前 head 派带快照的新单；新单再拒走 MODELX 豁免", async () => {
  const s = await setup();
  const old = await legacyCard(s);
  const sends = s.f.sent.length, stale = s.readonlyLines().length;
  expect(stale).toBe(2); // 模拟的旧代码现象：快照、模型结果两行只读报错
  // 旧代码：同一 tick 退人工（"原派单无材料快照"），没有新会话、新单
  expect(await s.tick()).toMatchObject({ step: "legacy_review" });
  expect(s.ops("reviewer_swap")).toMatchObject([{ actor: "scheduler", data: { legacy: true, intentId: old.id, sessionId: "s-rv" } }]);
  expect(s.ops("reviewer_swap")[0].data.refusal).toBeUndefined(); // 不是 epoch，不带豁免
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "retired" });
  expect(s.f.sent.length).toBe(sends); // 旧会话没被唤醒
  s.refuse(null);
  // 新会话：照换审查员之后的正式建会话路径（scheduler-review-swap），跨家族（codex），名字与仍可能在跑的旧审查员分开（-re）
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(s.tags).toEqual(["-re"]);
  const NEW = EX; // 测试的建会话桩不按 tag 起名
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ agent: NEW, sessionId: "s-ex", family: "codex", state: "active" });
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const next = s.reviews().at(-1)!;
  expect(next).toMatchObject({ recipient: NEW });
  expect(next.id).not.toBe(old.id);
  expect(getEventByDedup(s.f.db, snapshotKey(next.id))).toMatchObject({ actor: "scheduler", data: { head: H1, intentId: next.id } });
  expect(s.f.sent.at(-1)).toMatchObject({ agent: NEW });
  // 新单再被策略拒审：MODELX 的首次拒审 → epoch（豁免），不退人工
  s.refuse(CYBER);
  expect(await s.tick()).toMatchObject({ step: "refusal_epoch" });
  expect(s.ops("reviewer_swap").filter((e) => e.data.refusal)).toMatchObject([{ data: { intentId: next.id, sessionId: "s-ex" } }]);
  expect(getWorkflow(s.f.db, "T1")?.mode).toBe("auto");
  expect(s.readonlyLines().slice(stale)).toEqual([]);
  expect(s.calls).toContain("scheduler-legacy-review-retire");
}, 120_000);

test("旧拒审单接续只在 on：observe 下交回 auto 后照旧退人工，不退休绑定、不重派", async () => {
  const s = await setup("observe");
  await legacyCard(s);
  expect(await s.tick()).toMatchObject({ step: "manual" });
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
}, 120_000);

test("旧拒审单退休的写口：只给调度身份；条件不符（有快照 / 没交回 / 不是策略拒审）一律拒绝，不碰绑定", async () => {
  const s = await setup();
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const sent = s.reviews().at(-1)!;
  const retire = (actor: string, evidence = CYBER) => s.f.cli(actor, "scheduler-legacy-review-retire", "T1", "--intent", sent.id, "--data", JSON.stringify({ evidence }));
  expect(await retire("pm")).toMatchObject({ ok: false, code: "forbidden" });
  expect(await retire("scheduler", "socket hang up")).toMatchObject({ ok: false, code: "invalid" });
  expect(await retire("scheduler")).toMatchObject({ ok: false, code: "conflict" }); // 有快照，走 MODELX
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
  expect(s.ops("reviewer_swap")).toEqual([]);
}, 120_000);
