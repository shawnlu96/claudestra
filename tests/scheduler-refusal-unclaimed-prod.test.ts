/**
 * dispatch-recovery-MODELXW2 · 领单前的策略拒审，按 src/scheduler.ts 的接法测：只读 LedgerReader + 真实台账 CLI 子进程（临时 HOME / TMPDIR / 状态目录）。
 * N3：旧审查单已发唤醒、没人领，绑定会话最后一回合是 cyber 拒审卡，observe 归不到本单。无快照 → 退休旧绑定 → 派带快照的新单；
 * 有快照 → refusal epoch → 换家族 → 豁免 → owner 只告知一次。关联不确定 / observe：不动，报警照旧（带「疑似」）。
 * acp 变体让 observe 读真实 codexFailure()（生产 acpPort 同款）。换审查员一步照 scheduler-model-wiring-prod 在进程内跑、建会话是桩。
 */import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { answerAsk, closeAsk, openAsk } from "../src/lib/ledger-asks.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { codexFailure } from "../src/lib/scheduler-auto-ports.js";
import { boundRef, schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { informKey, snapshotKey } from "../src/lib/scheduler-model-wiring.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { UNCLAIMED_ALARM_MS, unclaimedKey } from "../src/lib/order-mark.js";
import { SUSPECT_NOTE, unclaimedRefusal } from "../src/lib/scheduler-refusal-unclaimed.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const EX = "agent-task-rv-t1-r1-ex";
const MANAGER = resolve("src/manager.ts");
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Fixture = ReturnType<typeof autoFixture>;

async function setup(mode: "on" | "observe" = "on", acp = false) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); f.close(); errors.mockRestore(); });
  writeFileSync(join(f.dir, "T1.md"), "# T1\n验收：原文\n");
  f.db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(f.dir, "T1.md")]);
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
  const child: AutoTickDeps["manager"] = async (...args) => {
    calls.push(args[1]);
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
      const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
      r.agents[EX] = { runtime: family === "codex" ? "codex" : "claude-code", sessionId: "s-ex", cwd: join(f.dir, "rv-ex"), ...(family === "codex" ? { transport: "acp" } : {}) };
      writeFileSync(f.registryPath, JSON.stringify(r));
      return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: EX, sessionId: "s-ex", family, transport: family === "codex" ? "acp" : "tmux" } };
    },
  });
  // 旧代码现象（MODELXW）：列出的子命令撞只读句柄，单照发、什么都没写上
  const legacy = new Set<string>();
  const manager: AutoTickDeps["manager"] = (...a) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message }))
    : legacy.has(a[1]) ? Promise.resolve({ ok: false, code: "write_failed", error: "attempt to write a readonly database" }) : child(...a);
  let refusal: string | null = null, skew = 0;
  const realWorker = f.tickDeps.worker;
  const deps: AutoTickDeps = { ...f.tickDeps, manager, now: () => Date.now() + skew, worker: (ref) => {
    const w = realWorker(ref);
    if ("manual" in w) return w;
    if (refusal !== null) return { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message: refusal! } }) };
    // acp：observe 前按生产 acpPort.turnState 读这个会话的回合失败卡
    return !acp || ref.family !== "codex" ? w : { ...w, observe: async (r, o) => {
      f.acpState.lastFailure = codexFailure(f.db, r.agent, r.sessionId);
      try { return await w.observe(r, o); } finally { delete f.acpState.lastFailure; }
    } };
  } };
  const tick = async () => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    const r = await schedulerAutoTick(ro, { p: { maxActiveWorkers: 2 } }, deps);
    expect(r.failed).toEqual([]);
    return r.cards[0];
  };
  const ops = (op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
  const reviews = () => f.intents().filter((i) => i.action === "review");
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  return { f, tick, calls, ops, reviews, legacy, tags, refuse: (m: string | null) => { refusal = m; }, wait: (ms: number) => { skew += ms; } };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function approve(f: Fixture, at = 2000) {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, at - 1);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true,
    via: "web_card", at, final: true });
}

/** bridge/acp-link.ts 开的「Codex 回合失败」卡：observe 不读它（fixture 的 turnState 不带 lastFailure），只有台账里这张卡 */
function refusalCard(f: Fixture, o: { sessionId?: string; failedAt?: number; message?: string; agent?: string } = {}) {
  const at = Date.now();
  return openAsk(f.db, { project: "p", source: "codex", kind: "owner_action", fromAgent: o.agent ?? "agent-rv-t1", title: "Codex 回合失败",
    context: o.message ?? CYBER, extra: { failure: "error", sessionId: o.sessionId ?? "s-rv", failedAt: o.failedAt ?? at } }, at);
}

const submittedAt = (f: Fixture, intentId: string): number => getEventByDedup(f.db, `scheduler:${intentId}:submitted`)!.ts;

/** N3：旧代码派出的审查单（无快照），拒审后卡退人工，PM 交回 auto；交回后又以唤醒派出、没人领 */
async function legacyCard(s: Setup) {
  s.legacy.add("scheduler-review-snapshot");
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const old = s.reviews().at(-1)!;
  expect(getEventByDedup(s.f.db, snapshotKey(old.id))).toBeNull();
  s.legacy.add("scheduler-model-outcome");
  approve(s.f);
  s.refuse(CYBER);
  expect(await s.tick()).toMatchObject({ step: "manual" });
  s.legacy.clear();
  s.refuse(null);
  const w = getWorkflow(s.f.db, "T1")!;
  expect(await s.f.cli("pm", "workflow-resume", "T1", "--rev", String(s.f.task().rev), "--workflow-rev", String(w.rev), "--reason", "监工：交回 auto"))
    .toMatchObject({ ok: true });
  return old;
}

test("MODELXW2 旧红新绿（无快照 / N3）：已发唤醒、未领、绑定会话最后一回合 cyber 拒审 → 正式退休旧绑定 → 派带快照的新单，不报未领单", async () => {
  const s = await setup();
  const old = await legacyCard(s);
  expect(s.f.task().round).toBeGreaterThan(0);
  refusalCard(s.f, { failedAt: submittedAt(s.f, old.id) + 1 });
  s.wait(UNCLAIMED_ALARM_MS + 60_000); // N3：唤醒发出已过报警线
  const sends = s.f.sent.length;
  // 旧代码：这里只有未领单报警（step waiting），没有退休、没有新单
  expect(await s.tick()).toMatchObject({ step: "legacy_review" });
  expect(getEventByDedup(s.f.db, unclaimedKey(old.id))).toBeNull();
  expect(s.ops("reviewer_swap")).toMatchObject([{ actor: "scheduler", data: { legacy: true, intentId: old.id, sessionId: "s-rv" } }]);
  expect(s.ops("reviewer_swap")[0].data.refusal).toBeUndefined(); // legacy 退休不带 refusal、不豁免
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "retired" });
  expect(s.f.sent.length).toBe(sends); // 不唤醒旧会话
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const next = s.reviews().at(-1)!;
  expect(next).toMatchObject({ recipient: EX });
  expect(next.id).not.toBe(old.id);
  expect(getEventByDedup(s.f.db, snapshotKey(next.id))).toMatchObject({ actor: "scheduler", data: { intentId: next.id, head: H1 } });
  expect(s.f.notices.filter((n) => n.includes("还没人领"))).toEqual([]);
  expect(s.calls).toContain("scheduler-legacy-review-retire");
}, 120_000);

test("MODELXW2 旧红新绿（有快照）：领单前拒审 → refusal epoch → 换家族 → 豁免标记 → owner 只告知一次", async () => {
  const s = await setup();
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const first = s.reviews().at(-1)!;
  expect(getEventByDedup(s.f.db, snapshotKey(first.id))).not.toBeNull();
  approve(s.f);
  refusalCard(s.f, { failedAt: submittedAt(s.f, first.id) + 1 });
  // 旧代码：observe 归不到本单，只走未领单（未到报警线时 waiting），没有 epoch
  expect(await s.tick()).toMatchObject({ step: "refusal_epoch" });
  expect(s.ops("reviewer_swap")).toMatchObject([{ data: { intentId: first.id, sessionId: "s-rv", refusal: { executed: "exempt_review" } } }]);
  expect(getEventByDedup(s.f.db, informKey("T1", "cyber_policy"))).toMatchObject({ data: { op: "refusal_owner_inform" } });
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "retired" });
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const exempt = s.reviews().filter((i) => i.recipient === EX);
  expect(exempt).toHaveLength(1);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ agent: EX, family: "claude", state: "active" }); // 原审查员是 codex：换家族
  expect(getEventByDedup(s.f.db, snapshotKey(exempt[0].id))!.data.digest).toBe(getEventByDedup(s.f.db, snapshotKey(first.id))!.data.digest);
  await s.tick();
  expect(s.ops("refusal_owner_inform")).toHaveLength(1);
  expect(s.f.notices.filter((n) => n.includes("退回人工"))).toEqual([]);
}, 120_000);

for (const c of [
  { name: "拒审在唤醒之前", why: "拒审发生在唤醒之前", card: (s: Setup, id: string) => refusalCard(s.f, { failedAt: submittedAt(s.f, id) - 1 }) },
  { name: "会话对不上", why: "拒审不在绑定的审查会话上", card: (s: Setup, id: string) => refusalCard(s.f, { sessionId: "s-other", failedAt: submittedAt(s.f, id) + 1 }) },
  { name: "信号读不到（卡上没有失败时刻）", why: "卡上缺失败时刻或会话", card: (s: Setup) => {
    const a = refusalCard(s.f);
    s.f.db.run("UPDATE asks SET extra = json_remove(extra, '$.failedAt') WHERE id = ?", [a.id]);
  } },
  { name: "拒审之后已有正常回合（卡被关）", why: "拒审之后会话还有别的回合", card: (s: Setup, id: string) => {
    const a = refusalCard(s.f, { failedAt: submittedAt(s.f, id) + 1 });
    closeAsk(s.f.db, a.id, "cancelled", "下一回合正常结束");
  } },
]) {
  test(`MODELXW2 关联不确定就不动：${c.name} → 照旧未领单报警，正文写明疑似领单前拒审`, async () => {
    const s = await setup();
    expect(await s.tick()).toMatchObject({ step: "sent" });
    const first = s.reviews().at(-1)!;
    approve(s.f);
    c.card(s, first.id);
    s.wait(UNCLAIMED_ALARM_MS + 60_000);
    expect(await s.tick()).toMatchObject({ step: "waiting" });
    expect(s.ops("reviewer_swap")).toEqual([]);
    expect(s.ops("model_refusal_retry").length + s.ops("model_refusal_exempt").length).toBe(0);
    expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
    const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
    expect(alarm).toHaveLength(1);
    expect(alarm[0]).toContain(`${SUSPECT_NOTE}（${c.why}）`);
  }, 120_000);
}

test("MODELXW2 其他情况不变：observe 下同样的领单前拒审只报未领单（正文不变），不记模型结果、不退休", async () => {
  const s = await setup("observe");
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const first = s.reviews().at(-1)!;
  approve(s.f);
  refusalCard(s.f, { failedAt: submittedAt(s.f, first.id) + 1 });
  s.wait(UNCLAIMED_ALARM_MS + 60_000);
  expect(await s.tick()).toMatchObject({ step: "waiting" });
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(listEvents(s.f.db, { project: "p", target: "T1" }).filter((e) => String(e.data.op).startsWith("model_"))).toEqual([]);
  const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
  expect(alarm).toHaveLength(1);
  expect(alarm[0]).not.toContain("疑似");
}, 120_000);

test("MODELXW2 其他情况不变：非策略的回合失败卡（普通错误）不算拒审，报警正文不带疑似", async () => {
  const s = await setup();
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const first = s.reviews().at(-1)!;
  refusalCard(s.f, { failedAt: submittedAt(s.f, first.id) + 1, message: "context window exhausted" });
  s.wait(UNCLAIMED_ALARM_MS + 60_000);
  expect(await s.tick()).toMatchObject({ step: "waiting" });
  expect(s.ops("reviewer_swap")).toEqual([]);
  const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
  expect(alarm).toHaveLength(1);
  expect(alarm[0]).not.toContain("疑似");
}, 120_000);

test("MODELXW2 读失败不猜：拒审卡读不到 → 不确认，返回疑似（报警照发），observe 已给结果时一行不读", async () => {
  const s = await setup();
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const sent = getIntent(s.f.db, s.reviews().at(-1)!.id)!;
  refusalCard(s.f, { failedAt: submittedAt(s.f, sent.id) + 1 });
  const ref = boundRef(s.f.db, "T1", "reviewer")!;
  // 只让读拒审卡的那条查询失败，别的照常
  const db = new Proxy(s.f.db, { get: (t, k) => k === "query"
    ? (sql: string) => { if (/FROM asks/.test(sql)) throw new Error("disk I/O error"); return t.query(sql); }
    : (typeof t[k as keyof typeof t] === "function" ? (t[k as keyof typeof t] as (...a: unknown[]) => unknown).bind(t) : t[k as keyof typeof t]) });
  const idle = { state: "running" as const, busy: false };
  expect(await unclaimedRefusal(db, s.f.task(), sent, ref, idle)).toEqual({ kind: "suspected", note: `${SUSPECT_NOTE}（信号读不到：disk I/O error）` });
  expect(await unclaimedRefusal(s.f.db, s.f.task(), sent, ref, idle)).toMatchObject({ kind: "confirmed" });
  const failed = { state: "result" as const, outcome: "failed" as const, failure: { kind: "quota" as const, message: "q" } };
  expect(await unclaimedRefusal(db, s.f.task(), sent, ref, failed)).toBeNull(); // 原失败不被吞
}, 120_000);

for (const c of [
  { name: "策略拒审卡缺失败时刻", message: CYBER, step: "waiting", suspect: true },
  { name: "普通错误卡缺失败时刻（其他失败照旧退人工）", message: "context window exhausted", step: "manual", suspect: false },
]) {
  test(`MODELXW2 真实 codexFailure 链路：${c.name} → observe 为 unknown + failure`, async () => {
    const s = await setup("on", true);
    expect(await s.tick()).toMatchObject({ step: "sent" });
    const sent = getIntent(s.f.db, s.reviews().at(-1)!.id)!;
    approve(s.f);
    const a = refusalCard(s.f, { failedAt: submittedAt(s.f, sent.id) + 1, message: c.message });
    s.f.db.run("UPDATE asks SET extra = json_remove(extra, '$.failedAt') WHERE id = ?", [a.id]);
    expect(codexFailure(s.f.db, "agent-rv-t1", "s-rv")).toMatchObject({ afterKey: null });
    s.wait(UNCLAIMED_ALARM_MS + 60_000);
    // 旧代码：两种都在识别之前提前退人工（step manual，只通知退回人工，没有未领单报警）
    expect(await s.tick()).toMatchObject({ step: c.step });
    expect(s.ops("reviewer_swap")).toEqual([]);
    expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
    const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
    if (c.suspect) expect(alarm.map((n) => n.includes(`${SUSPECT_NOTE}（卡上缺失败时刻或会话）`))).toEqual([true]);
    else expect(alarm).toEqual([]);
  }, 120_000);
}
