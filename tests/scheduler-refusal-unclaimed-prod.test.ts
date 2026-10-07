/**
 * dispatch-recovery-MODELXW2 / MODELXW3 · 领单前的策略拒审，按 src/scheduler.ts 的接法测：只读 LedgerReader + 真实台账 CLI 子进程（临时 HOME / TMPDIR / 状态目录）。
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
import { insertEvent } from "../src/lib/ledger-tx.js";
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
/** 审查会话的 thread id：Codex rollout 按文件名里 36 位的 id 找（codex-session.ts），s-rv 那种短名找不到文件 */
const RV = "0199c0de-0000-7000-8000-00000000a3e1";
const EX = "agent-task-rv-t1-r1-ex";
const MANAGER = resolve("src/manager.ts");
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Fixture = ReturnType<typeof autoFixture>;

async function setup(mode: "on" | "observe" = "on", acp = false) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-rv-t1"].sessionId = RV;
  writeFileSync(f.registryPath, JSON.stringify(reg));
  // 识别在本进程里按生产接法找 rollout（findSessionJsonlBySessionId → CODEX_HOME）：指到临时目录，不读真实 ~/.codex
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(f.dir, "codex");
  cleanup.push(() => { if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome; });
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
  let refusal: string | null = null, skew = 0, beforeSubmit: (() => void) | null = null;
  const realWorker = f.tickDeps.worker;
  const deps: AutoTickDeps = { ...f.tickDeps, manager, now: () => Date.now() + skew, worker: (ref) => {
    const real = realWorker(ref);
    if ("manual" in real) return real;
    // 认领（submitted）已落账、真正发出之前：生产 driveDispatch 的同一个窗口
    const w = { ...real, submit: (...a: Parameters<typeof real.submit>) => { const f = beforeSubmit; beforeSubmit = null; f?.(); return real.submit(...a); } };
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
  return { f, tick, calls, ops, reviews, legacy, tags, refuse: (m: string | null) => { refusal = m; },
    onSubmit: (fn: () => void) => { beforeSubmit = fn; }, wait: (ms: number) => { skew += ms; } };
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
    context: o.message ?? CYBER, extra: { failure: "error", sessionId: o.sessionId ?? RV, failedAt: o.failedAt ?? at } }, at);
}

/** 审查会话的 Codex rollout：最后一个回合在 turnAt 开始（生产 lend-turn-failure.ts lastTurnStartAt 读的 event_msg task_started） */
function rollout(f: Fixture, turnAt: number) {
  const dir = join(f.dir, "codex", "sessions", "2026", "10", "07");
  mkdirSync(dir, { recursive: true });
  const line = (at: number, payload: Record<string, unknown>, type = "event_msg") => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
  writeFileSync(join(dir, `rollout-2026-10-07T00-00-00-${RV}.jsonl`), [line(turnAt - 5, { id: RV }, "session_meta"),
    line(turnAt, { type: "task_started" }), line(turnAt + 1, { type: "agent_message", message: "x" })].join("\n") + "\n");
}

const submittedAt = (f: Fixture, intentId: string): number => getEventByDedup(f.db, `scheduler:${intentId}:submitted`)!.ts;
/** 唤醒的投递回执（submitted→done，worker.submit 返回之后才落账）：晚于它的失败才是唤醒送达之后的回合 */
const deliveredAt = (f: Fixture, intentId: string): number => getEventByDedup(f.db, `scheduler:${intentId}:done`)!.ts;

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
  refusalCard(s.f, { failedAt: deliveredAt(s.f, old.id) + 1 });
  rollout(s.f, deliveredAt(s.f, old.id));
  s.wait(UNCLAIMED_ALARM_MS + 60_000); // N3：唤醒发出已过报警线
  const sends = s.f.sent.length;
  // 旧代码：这里只有未领单报警（step waiting），没有退休、没有新单
  expect(await s.tick()).toMatchObject({ step: "legacy_review" });
  expect(getEventByDedup(s.f.db, unclaimedKey(old.id))).toBeNull();
  expect(s.ops("reviewer_swap")).toMatchObject([{ actor: "scheduler", data: { legacy: true, intentId: old.id, sessionId: RV } }]);
  expect(s.ops("reviewer_swap")[0].data.refusal).toBeUndefined(); // legacy 退休不带 refusal、不豁免
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "retired" });
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
  refusalCard(s.f, { failedAt: deliveredAt(s.f, first.id) + 1 });
  rollout(s.f, deliveredAt(s.f, first.id));
  // 旧代码：observe 归不到本单，只走未领单（未到报警线时 waiting），没有 epoch
  expect(await s.tick()).toMatchObject({ step: "refusal_epoch" });
  expect(s.ops("reviewer_swap")).toMatchObject([{ data: { intentId: first.id, sessionId: RV, refusal: { executed: "exempt_review" } } }]);
  expect(getEventByDedup(s.f.db, informKey("T1", "cyber_policy"))).toMatchObject({ data: { op: "refusal_owner_inform" } });
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "retired" });
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
  { name: "会话对不上", why: "拒审不在绑定的审查会话上", card: (s: Setup, id: string) => refusalCard(s.f, { sessionId: "s-other", failedAt: deliveredAt(s.f, id) + 1 }) },
  { name: "信号读不到（卡上没有失败时刻）", why: "卡上缺失败时刻或会话", card: (s: Setup) => {
    const a = refusalCard(s.f);
    s.f.db.run("UPDATE asks SET extra = json_remove(extra, '$.failedAt') WHERE id = ?", [a.id]);
  } },
  // MODELXW3：卡关了不再等于有别的回合；stop-settle 以「下一个回合正常结束」关卡（带 recoveredAt）才算
  { name: "拒审之后已有正常回合（stop-settle 关卡，带 recoveredAt）", why: "拒审之后会话还有别的回合（下一个回合正常结束）", card: (s: Setup, id: string) => {
    const a = refusalCard(s.f, { failedAt: deliveredAt(s.f, id) + 1 });
    rollout(s.f, deliveredAt(s.f, id));
    closeAsk(s.f.db, a.id, "cancelled", "agent 已恢复：下一个回合正常结束", Date.now(), { recoveredAt: Date.now() });
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
    expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "active" });
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
  refusalCard(s.f, { failedAt: deliveredAt(s.f, first.id) + 1 });
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
  refusalCard(s.f, { failedAt: deliveredAt(s.f, first.id) + 1, message: "context window exhausted" });
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
  refusalCard(s.f, { failedAt: deliveredAt(s.f, sent.id) + 1 });
  rollout(s.f, deliveredAt(s.f, sent.id));
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
  // MODELXW3：Claude 家族会话本卡不接，按关联不确定
  expect(await unclaimedRefusal(s.f.db, s.f.task(), sent, { ...ref, family: "claude" }, idle))
    .toEqual({ kind: "suspected", note: `${SUSPECT_NOTE}（Claude 会话未接）` });
}, 120_000);

/** N3（10-07 生产）：旧单已发唤醒、未领，绑定会话的拒审卡已被关掉（owner 网页删除 / dialog closed / 过期） */
const CLOSED = [
  { name: "owner 删除", close: (f: Fixture, id: string) => closeAsk(f.db, id, "cancelled", "owner 在网页上删除") },
  { name: "dialog closed", close: (f: Fixture, id: string) => closeAsk(f.db, id, "cancelled", "dialog closed") },
  { name: "过期", close: (f: Fixture, id: string) => closeAsk(f.db, id, "expired", "过期") },
];

for (const c of CLOSED) test(`MODELXW3 旧红新绿（N3，拒审卡已关：${c.name}）：rollout 里拒审之后没有 task_started → 正式退休旧绑定 → 派带快照的新单`, async () => {
  const s = await setup();
  const old = await legacyCard(s);
  const failedAt = deliveredAt(s.f, old.id) + 1;
  c.close(s.f, refusalCard(s.f, { failedAt }).id);
  rollout(s.f, failedAt - 1);
  s.wait(UNCLAIMED_ALARM_MS + 60_000);
  const sends = s.f.sent.length;
  // 旧代码：卡不是 open → 「拒审之后会话还有别的回合」，只有未领单报警（step waiting）
  expect(await s.tick()).toMatchObject({ step: "legacy_review" });
  expect(getEventByDedup(s.f.db, unclaimedKey(old.id))).toBeNull();
  expect(s.ops("reviewer_swap")).toMatchObject([{ actor: "scheduler", data: { legacy: true, intentId: old.id, sessionId: RV } }]);
  expect(s.ops("reviewer_swap")[0].data.refusal).toBeUndefined();
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "retired" });
  expect(s.f.sent.length).toBe(sends); // 不唤醒旧会话
  expect(s.f.db.query("SELECT state FROM asks WHERE source = 'codex'").all()).toEqual([{ state: c.name === "过期" ? "expired" : "cancelled" }]); // 不改卡
  expect(await s.tick()).toMatchObject({ step: "session" });
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const next = s.reviews().at(-1)!;
  expect(next).toMatchObject({ recipient: EX });
  expect(getEventByDedup(s.f.db, snapshotKey(next.id))).toMatchObject({ actor: "scheduler", data: { intentId: next.id, head: H1 } });
  expect(s.f.notices.filter((n) => n.includes("还没人领"))).toEqual([]);
}, 120_000);

test("MODELXW3 旧红新绿（r1 审查 latest-failure-created-earlier）：同会话早失败晚写卡不遮住最后一次拒审 → 按 failedAt 取卡，正式退休旧绑定", async () => {
  const s = await setup();
  const old = await legacyCard(s);
  const done = deliveredAt(s.f, old.id);
  const a = refusalCard(s.f, { failedAt: done + 100 });
  closeAsk(s.f.db, a.id, "cancelled", "owner 在网页上删除");
  const b = refusalCard(s.f, { failedAt: done + 50 });
  s.f.db.run("UPDATE asks SET createdAt = ? WHERE id = ?", [a.createdAt + 100, b.id]); // 较早的失败晚到写卡
  rollout(s.f, done + 99);
  s.wait(UNCLAIMED_ALARM_MS + 60_000);
  // 旧代码：按 createdAt 取到 B，被 A 的更晚 failedAt 否决 → 只有未领单报警（step waiting），reviewer_swap 为空
  expect(await s.tick()).toMatchObject({ step: "legacy_review" });
  expect(getEventByDedup(s.f.db, unclaimedKey(old.id))).toBeNull();
  expect(s.ops("reviewer_swap")).toMatchObject([{ actor: "scheduler", data: { legacy: true, intentId: old.id, sessionId: RV } }]);
  expect(s.ops("reviewer_swap")[0].data.refusal).toBeUndefined();
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "retired" });
  expect(s.f.db.query("SELECT id, state FROM asks WHERE source = 'codex' ORDER BY id").all())
    .toEqual([{ id: a.id, state: "cancelled" }, { id: b.id, state: "open" }].sort((x, y) => x.id < y.id ? -1 : 1)); // 不改卡
}, 120_000);

for (const c of [
  { name: "rollout 在 failedAt 之后有 task_started", why: "拒审之后会话还有别的回合", prep: (s: Setup, failedAt: number, id: string) => {
    s.f.db.run("UPDATE asks SET state = 'cancelled' WHERE id = ?", [id]);
    rollout(s.f, failedAt + 1000);
  } },
  { name: "卡带 recoveredAt", why: "拒审之后会话还有别的回合（下一个回合正常结束）", prep: (s: Setup, failedAt: number, id: string) => {
    closeAsk(s.f.db, id, "cancelled", "agent 已恢复：下一个回合正常结束", failedAt + 2000, { recoveredAt: failedAt + 2000 });
    rollout(s.f, failedAt - 1);
  } },
  { name: "rollout 读不到", why: "找不到会话的 rollout", prep: (s: Setup, _failedAt: number, id: string) => {
    closeAsk(s.f.db, id, "cancelled", "owner 在网页上删除");
  } },
  { name: "rollout 里没有回合开始记录", why: "rollout 里读不到回合开始记录", prep: (s: Setup, failedAt: number, id: string) => {
    closeAsk(s.f.db, id, "cancelled", "owner 在网页上删除");
    rollout(s.f, failedAt - 1);
    const dir = join(s.f.dir, "codex", "sessions", "2026", "10", "07"), file = join(dir, `rollout-2026-10-07T00-00-00-${RV}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8").replace("task_started", "task_complete"));
  } },
  { name: "同会话有更晚的失败卡", why: "拒审之后会话还有别的回合", prep: (s: Setup, failedAt: number, id: string) => {
    closeAsk(s.f.db, id, "cancelled", "owner 在网页上删除");
    const later = refusalCard(s.f, { failedAt: failedAt + 50, message: "context window exhausted" });
    s.f.db.run("UPDATE asks SET createdAt = createdAt - 100000 WHERE id = ?", [later.id]); // 写卡更早、失败更晚：按 failedAt 比，不按 createdAt
    rollout(s.f, failedAt - 1);
  } },
]) test(`MODELXW3 关联不确定就不动（N3 反例）：${c.name} → 不退休，未领单报警带疑似`, async () => {
  const s = await setup();
  const old = await legacyCard(s);
  const failedAt = deliveredAt(s.f, old.id) + 1;
  c.prep(s, failedAt, refusalCard(s.f, { failedAt }).id);
  s.wait(UNCLAIMED_ALARM_MS + 60_000);
  expect(await s.tick()).toMatchObject({ step: "waiting" });
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "active" });
  const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
  expect(alarm).toHaveLength(1);
  expect(alarm[0]).toContain(`${SUSPECT_NOTE}（${c.why}）`);
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
    const a = refusalCard(s.f, { failedAt: deliveredAt(s.f, sent.id) + 1, message: c.message });
    s.f.db.run("UPDATE asks SET extra = json_remove(extra, '$.failedAt') WHERE id = ?", [a.id]);
    expect(codexFailure(s.f.db, "agent-rv-t1", RV)).toMatchObject({ afterKey: null });
    s.wait(UNCLAIMED_ALARM_MS + 60_000);
    // 旧代码：两种都在识别之前提前退人工（step manual，只通知退回人工，没有未领单报警）
    expect(await s.tick()).toMatchObject({ step: c.step });
    expect(s.ops("reviewer_swap")).toEqual([]);
    expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "active" });
    const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
    if (c.suspect) expect(alarm.map((n) => n.includes(`${SUSPECT_NOTE}（卡上缺失败时刻或会话）`))).toEqual([true]);
    else expect(alarm).toEqual([]);
  }, 120_000);
}

for (const acp of [false, true]) test(`MODELXW2 认领与投递之间的旧回合拒审不算本单（复现 ${acp ? "r3 wake-time：真实 codexFailure 归给本单" : "r2 wake-time"}）：只报未领单（疑似），不退休、不开 epoch`, async () => {
  const s = await setup("on", acp);
  approve(s.f);
  // submitted 认领已写、worker.submit 之前，同绑定会话上旧回合的 cyber 拒审落账
  s.onSubmit(() => { refusalCard(s.f); });
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const first = s.reviews().at(-1)!;
  s.wait(UNCLAIMED_ALARM_MS + 60_000);
  // acp：生产 codexFailure 按 submitted 认领时刻把这张卡归给本单（observe 给 result/failed）
  if (acp) expect(codexFailure(s.f.db, "agent-rv-t1", RV)).toMatchObject({ afterKey: first.id });
  // 旧代码：认领时刻当唤醒时刻 → confirmed → refusal_epoch，原审查绑定被退休（r3 前 acp 变体照样 refusal_epoch）
  expect(await s.tick()).toMatchObject({ step: "waiting" });
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(s.ops("model_refusal_retry").length + s.ops("model_refusal_exempt").length).toBe(0);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "active" });
  expect(getEventByDedup(s.f.db, unclaimedKey(first.id))).not.toBeNull();
  const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
  expect(alarm).toHaveLength(1);
  expect(alarm[0]).toContain(`${SUSPECT_NOTE}（拒审落在认领与投递回执之间`);
}, 120_000);

test("MODELXW2 真实 codexFailure 链路（复现 r2 refusal-uncertain）：唤醒前开出、缺会话与时刻的旧拒审卡 → 不提前退人工，未领单报警带疑似", async () => {
  const s = await setup("on", true);
  expect(await s.tick()).toMatchObject({ step: "sent" });
  const sent = getIntent(s.f.db, s.reviews().at(-1)!.id)!;
  approve(s.f);
  // 同一审查员此前派过的单（认领早于当前单）；旧拒审卡开在两次认领之间，宿主没报会话和时刻
  const before = submittedAt(s.f, sent.id) - 60_000;
  s.f.db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head,
    templateVersion, status, attempts, receipt, reason, createdAt, updatedAt) SELECT 'prior-review', taskId, project, node, action, recipient,
    causalSeq, eventSeq - 1, taskRev, specRev, head, templateVersion, 'cancelled', attempts, receipt, reason, ?, ? FROM scheduler_intents WHERE id = ?`,
  [before, before, sent.id]);
  insertEvent(s.f.db, { actor: "scheduler", now: before, dedupKey: "scheduler:prior-review:submitted" },
    { project: "p", target: "T1", kind: "scheduler", text: "调度意图 submitted", data: { op: "settle", id: "prior-review", to: "submitted" } }, true);
  const a = refusalCard(s.f);
  s.f.db.run("UPDATE asks SET createdAt = ?, extra = json_remove(extra, '$.failedAt', '$.sessionId') WHERE id = ?", [before + 1, a.id]);
  expect(codexFailure(s.f.db, "agent-rv-t1", RV)).toMatchObject({ afterKey: null });
  s.wait(UNCLAIMED_ALARM_MS + 60_000);
  // 旧代码：候选卡筛掉了这张卡，识别返回 null → 提前 manual，只通知退回人工
  expect(await s.tick()).toMatchObject({ step: "waiting" });
  expect(s.ops("reviewer_swap")).toEqual([]);
  expect(getSchedulerSession(s.f.db, "T1", "reviewer")).toMatchObject({ sessionId: RV, state: "active" });
  expect(s.f.notices.filter((n) => n.includes("退回人工"))).toEqual([]);
  const alarm = s.f.notices.filter((n) => n.includes("还没人领"));
  expect(alarm.map((n) => n.includes(`${SUSPECT_NOTE}（宿主报了归不到单的策略拒审）`))).toEqual([true]);
}, 120_000);
