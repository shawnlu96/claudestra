/**
 * dispatch-recovery-AUDW1: the local takeover's observe record goes through the scheduler identity's `ledger scheduler-recovery-observe`
 * (the service's own connection is query_only), and scheduler-pass hands the takeover CFG's localFallback port. On the R1 incident
 * (tests/scheduler-dispatch-block-helpers.ts) with a synthetic temp ledger: the command itself, the production step on a query_only
 * connection, the pass wiring (observe / off / no port) and a failing command (the pass goes on, PM told once).
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { readLocalFallbackFacts, type LocalFallbackPolicyPort } from "../src/lib/recovery-local-fallback-plan.js";
import { recordObserved, recoveryPolicy, RECOVERY_POLICY_PATH, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig, SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { localTakeoverTick, observeByCli, takeoverStep, type TakeoverDeps } from "../src/lib/scheduler-dispatch-recovery.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { schedulerPass, type PassOpts } from "../src/lib/scheduler-pass.js";
import { passPace } from "../src/lib/scheduler-yield.js";
import { blockFixture, E2E_MS, toFix, type Fx } from "./scheduler-dispatch-block-helpers.js";

const BORROW = [{ peer: "mate", projects: ["p"], roles: ["review", "write"] as ("review" | "write")[], maxOpen: 3 }];
const observe: LocalFallbackPolicyPort = () => ({ mode: "observe", manualAfterMs: null });
const quota: InventoryQuota = { status: "known", source: "live", observedAt: 1, plan: null, reason: null,
  windows: [{ id: "weekly", kind: "weekly", usedPct: 10, resetsAtMs: null, resetPassed: false }] };
const OP = "recovery_observe";

/** R1 with the peer assignee cleared, mate healthy and no local author row: with the lease read as ended (`ended`) the takeover is eligible. */
async function ready(): Promise<Fx> {
  const p = await blockFixture();
  await toFix(p, `# 审查报告\nP1：两个 tick 抢同一个意图\n别处粘来的 secret ${randomBytes(32).toString("hex")}`);
  expect(await p.tick()).toMatchObject({ step: "pool_refused" });
  p.policy.remote.agents = { claude: 1, codex: 1 };
  p.f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
  p.f.db.run("UPDATE tasks SET assignee = NULL, assigneeKind = NULL WHERE id = 'T1'");
  p.f.db.run("DELETE FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author'");
  p.hello();
  return p;
}

/** The scheduler service's connection: the same ledger file, query_only (scheduler.ts LedgerReader). */
function serviceDb(p: Fx): Database {
  const ro = new Database(join(p.f.dir, "ledger.sqlite"), { readwrite: true, create: false });
  ro.exec("PRAGMA query_only = ON");
  return ro;
}

type Call = (...args: string[]) => Promise<Record<string, unknown>>;
const notes = (p: Fx) => listEvents(p.f.db, { project: "p" }).filter((e) => e.data.op === OP);
const cliAsScheduler = (p: Fx, seen: string[] = []): Call => (...args) => { seen.push(args[1]!); return p.cli("scheduler", ...args.slice(1)); };

/** The executor's ports with the production observe (observeByCli over `manager`); `ended` = the lease reads as formally ended. */
function deps(p: Fx, db: Database, manager: Call, notices: string[], over: Partial<TakeoverDeps> = {}): TakeoverDeps {
  return { db, policy: observe, manager, ensure: async () => { throw new Error("observe never ensures"); }, worker: p.f.tickDeps.worker, authorRuntime: () => "codex",
    grant: () => ({ remote: p.policy.remote, maxActiveWorkers: 2 }), notifyPm: async (_t, text) => { notices.push(text); }, observe: observeByCli(manager),
    codexQuota: async () => quota, borrow: async () => BORROW, now: p.f.tickDeps.now, told: new Set(),
    readFacts: (...a: Parameters<typeof readLocalFallbackFacts>) => ({ ...readLocalFallbackFacts(...a), lease: null }), ...over };
}

describe("[验收线 2] scheduler-recovery-observe 命令", () => {
  const args = (over: Record<string, string> = {}) => {
    const f = { mechanism: "localFallback", "action-key": "takeover:act:r1:s1:gate", action: "本机 Codex 接管修复", ...over };
    return ["scheduler-recovery-observe", "T1", ...Object.entries(f).flatMap(([k, v]) => [`--${k}`, v])];
  };

  test("非调度身份被拒；未知恢复键、actionKey 不合规、data 不是对象报 invalid；都不落事件", async () => {
    const p = await ready();
    try {
      for (const actor of ["pm", "owner", "agent-task-one"]) expect([actor, (await p.cli(actor, ...args())).code]).toEqual([actor, "forbidden"]);
      expect(await p.cli("scheduler", ...args({ mechanism: "nope" }))).toMatchObject({ ok: false, code: "invalid" });
      expect(await p.cli("scheduler", ...args({ "action-key": "有 空格" }))).toMatchObject({ ok: false, code: "invalid" });
      expect(await p.cli("scheduler", ...args({ "action-key": "k".repeat(121) }))).toMatchObject({ ok: false, code: "invalid" });
      for (const data of ["[1]", "null", "{坏"]) expect(await p.cli("scheduler", ...args({ data }))).toMatchObject({ ok: false, code: "invalid" });
      expect((await p.cli("scheduler", ...args().map((a) => (a === "T1" ? "T404" : a)))).ok).toBe(false);
      expect(notes(p)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("同参数调两次：第二次 recorded=false、seq 相同；事件与 recordObserved 直接写的一致", async () => {
    const p = await ready();
    try {
      const data = JSON.stringify({ key: "k1", kind: "eligible" });
      const first = await p.cli("scheduler", ...args({ data }));
      expect(first).toMatchObject({ ok: true, recorded: true });
      expect(await p.cli("scheduler", ...args({ data }))).toEqual({ ok: true, recorded: false, seq: first.seq });
      const [byCli] = notes(p);
      expect(byCli).toMatchObject({ seq: first.seq, actor: "scheduler", kind: "note", target: "T1",
        data: { op: OP, mechanism: "localFallback", actionKey: "takeover:act:r1:s1:gate", key: "k1", kind: "eligible" } });
      // The library writer on the same action under another key: same text, same shape — the command adds nothing of its own.
      const direct = recordObserved(p.f.db, { project: "p", mechanism: "localFallback", target: "T1", actionKey: "other", action: "本机 Codex 接管修复",
        data: { key: "k1", kind: "eligible" } }, p.f.tickDeps.now());
      const byLib = notes(p).find((e) => e.seq === direct.seq)!;
      const shape = (e: typeof byLib) => ({ actor: e.actor, kind: e.kind, target: e.target, text: e.text, data: { ...e.data, actionKey: "" } });
      expect(shape(byCli!)).toEqual(shape(byLib));
      expect(notes(p)).toHaveLength(2);
    } finally { p.f.close(); }
  }, E2E_MS);

  test("项目没开自动调度时拒绝（和同表命令同一条校验）", async () => {
    const p = await ready();
    try {
      expect(await p.f.cliWith({ autoProjects: () => [] }, "scheduler", ...args())).toMatchObject({ ok: false, code: "forbidden" });
      expect(notes(p)).toEqual([]);
    } finally { p.f.close(); }
  }, E2E_MS);
});

describe("[验收线 1] 生产形态：query_only 连接上 observe 走一轮，台账正好多一条恢复观察", () => {
  test("满足接管条件的卡：一轮记一条（actor 调度身份、op 同 recordObserved），再跑不多记；直接写库在这条连接上写不进去", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      // What takeoverStep did before this card: recordObserved on the service's own connection.
      expect(() => recordObserved(ro, { project: "p", mechanism: "localFallback", target: "T1", actionKey: "takeover:act:r0:s1:gate", action: "x" }, 1)).toThrow();
      expect(notes(p)).toEqual([]);
      const seen: string[] = [], notices: string[] = [], d = deps(p, ro, cliAsScheduler(p, seen), notices);
      const before = listEvents(p.f.db, { project: "p" }).length;
      expect(await localTakeoverTick(d, { p: p.policy })).toEqual({ failed: [],
        cards: [expect.objectContaining({ taskId: "T1", step: "observe", detail: expect.stringContaining("本机 Codex 接管修复") })] });
      expect(await localTakeoverTick(d, { p: p.policy })).toMatchObject({ failed: [], cards: [{ step: "observe" }] });
      expect(notes(p)).toEqual([expect.objectContaining({ actor: "scheduler", kind: "note", target: "T1",
        data: expect.objectContaining({ op: OP, mechanism: "localFallback", kind: "eligible", role: "fix", trigger: "gate_refused" }) })]);
      expect(listEvents(p.f.db, { project: "p" })).toHaveLength(before + 1);
      expect(new Set(seen)).toEqual(new Set(["scheduler-recovery-observe"])); // observe: no plan, no settle, no bind
      expect(notices).toEqual([]);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);

  test("takeoverStep 本身（生产接线，实时授权读 scheduler.json）：query_only 连接上记一条，第二轮不多记", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    const config = parseSchedulerConfig({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: p.f.dir, remote: p.policy.remote } } });
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
      projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: p.f.dir, remote: p.policy.remote } } }));
    try {
      const seen: string[] = [], notices: string[] = [];
      const wire = { db: ro, ledger: cliAsScheduler(p, seen), active: () => {}, lease: undefined, takeoverPolicy: observe };
      const step = () => takeoverStep(wire, config, passPace({}).phase(), async (_p, text) => { notices.push(text); });
      expect(await step()).toEqual([]);
      expect(await step()).toEqual([]);
      // As the incident stands the write lease is still at mate: what on would do is the exact lease_held block, recorded once.
      expect(notes(p)).toEqual([expect.objectContaining({ actor: "scheduler", kind: "note", target: "T1",
        data: expect.objectContaining({ op: OP, mechanism: "localFallback", kind: "blocked" }) })]);
      expect(seen.filter((c) => c !== "scheduler-recovery-observe")).toEqual([]);
      expect(notices).toEqual([]);
    } finally { rmSync(SCHEDULER_CONFIG_PATH, { force: true }); ro.close(); p.f.close(); }
  }, E2E_MS);
});

describe("[验收线 3] scheduler-pass 接线：recoveryPolicy 收窄成 localFallback 端口", () => {
  const TAKEOVER = ["scheduler-recovery-observe", "scheduler-plan", "scheduler-settle", "scheduler-session-bind"];
  /** One pass on the service's query_only connection with the real autostart hooks (so the real takeoverStep), everything unrelated stubbed. */
  async function pass(p: Fx, ro: Database, recoveryPolicy: RecoveryPolicyPort | undefined, seen: string[], over: Partial<PassOpts> = {}) {
    const maintenance = { path: join(p.f.dir, "m.lock"), marker: join(p.f.dir, "u.marker"), request: join(p.f.dir, "m.req") };
    const config = parseSchedulerConfig({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: p.f.dir, remote: p.policy.remote } } });
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
      projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: p.f.dir, remote: p.policy.remote } } }));
    try {
      // Only the takeover's own commands reach the real CLI; the other steps of the pass (memory, observe, merge, …) are not under test.
      const real = cliAsScheduler(p, seen);
      const manager: Call = async (...args) => (TAKEOVER.includes(args[1]!) ? real(...args) : { ok: true, duplicate: true });
      return await schedulerPass(ro, config, { assertOwner: () => {}, manager, maintenance, ...(recoveryPolicy ? { recoveryPolicy } : {}),
        peerPr: async () => ({ failed: [] }), retire: async () => [], lifecycle: async () => [], lockYield: async () => [],
        // The auto tick is not what is under test: it would re-plan the refused card through the pool every pass.
        autoDeps: () => ({ ...p.f.tickDeps, manager: async () => ({ ok: true, duplicate: true }), borrow: async () => [] }), ...over });
    } finally { rmSync(SCHEDULER_CONFIG_PATH, { force: true }); }
  }

  test("带 recoveryPolicy：takeoverStep 运行并只问 localFallback；observe 记一条观察", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      const asked: string[] = [], seen: string[] = [];
      const policy: RecoveryPolicyPort = (project, mechanism) => { asked.push(`${project}/${mechanism}`); return { mode: "observe", manualAfterMs: null, source: "config" }; };
      expect(await pass(p, ro, policy, seen)).toEqual({ ran: true, failed: [] });
      expect(asked).toContain("p/localFallback");
      expect(notes(p)).toEqual([expect.objectContaining({ actor: "scheduler", target: "T1", data: expect.objectContaining({ op: OP, mechanism: "localFallback" }) })]);
      expect(seen).toEqual(["scheduler-recovery-observe"]);
      expect(await pass(p, ro, policy, seen)).toEqual({ ran: true, failed: [] });
      expect(notes(p)).toHaveLength(1);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);

  test("[验收线 1] 生产入口的形状（src/scheduler.ts：只传 takeoverPolicy = 文件读取器收窄，不传 recoveryPolicy）：缺省 observe，query_only 上记一条", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      expect(existsSync(RECOVERY_POLICY_PATH)).toBe(false); // no recovery-policy.json: localFallback is the default observe
      const seen: string[] = [];
      const entry = (): Partial<PassOpts> => ({ takeoverPolicy: (project) => recoveryPolicy(project, "localFallback") });
      expect(await pass(p, ro, undefined, seen, entry())).toEqual({ ran: true, failed: [] });
      expect(await pass(p, ro, undefined, seen, entry())).toEqual({ ran: true, failed: [] });
      expect(notes(p)).toEqual([expect.objectContaining({ actor: "scheduler", kind: "note", target: "T1", data: expect.objectContaining({ op: OP, mechanism: "localFallback" }) })]);
      expect(seen).toEqual(["scheduler-recovery-observe", "scheduler-recovery-observe"]); // the second is the dedup replay: recorded=false
      // and it is what the daemon passes: its one schedulerV2Pass call hands this port and still no recoveryPolicy
      const daemon = readFileSync(join(import.meta.dir, "../src/scheduler.ts"), "utf8");
      expect(daemon).toContain('takeoverPolicy: (project) => recoveryPolicy(project, "localFallback")');
      expect(daemon).not.toMatch(/\brecoveryPolicy[,:]\s/);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);

  test("专用端口优先于 recoveryPolicy 的收窄：takeoverPolicy 说 off 时，recoveryPolicy 的 observe 不算", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      const seen: string[] = [];
      const general: RecoveryPolicyPort = () => ({ mode: "observe", manualAfterMs: null, source: "config" });
      expect(await pass(p, ro, general, seen, { takeoverPolicy: () => ({ mode: "off", manualAfterMs: null, source: "config" }) })).toEqual({ ran: true, failed: [] });
      expect(notes(p)).toEqual([]);
      expect(seen).toEqual([]);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);

  test("localFallback 配成 off：这一轮没有观察事件、没有任何接管动作", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      const asked: string[] = [], seen: string[] = [];
      const policy: RecoveryPolicyPort = (project, mechanism) => { asked.push(`${project}/${mechanism}`);
        return { mode: mechanism === "localFallback" ? "off" : "observe", manualAfterMs: null, source: "config" }; };
      const before = { intents: p.f.intents().length, sessions: p.f.db.query("SELECT COUNT(*) AS n FROM scheduler_sessions").get(), rev: getTask(p.f.db, "T1")!.rev };
      expect(await pass(p, ro, policy, seen)).toEqual({ ran: true, failed: [] });
      expect(asked).toContain("p/localFallback"); // the step ran and read the switch
      expect(notes(p)).toEqual([]);
      expect(seen).toEqual([]);
      expect({ intents: p.f.intents().length, sessions: p.f.db.query("SELECT COUNT(*) AS n FROM scheduler_sessions").get(), rev: getTask(p.f.db, "T1")!.rev }).toEqual(before);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);

  test("不带 recoveryPolicy：和改前一致，接管不运行（没有观察、没有接管命令）", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      const seen: string[] = [];
      expect(await pass(p, ro, undefined, seen)).toEqual({ ran: true, failed: [] });
      expect(notes(p)).toEqual([]);
      expect(seen).toEqual([]);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);
});

describe("[验收线 4] 命令失败：这一轮正常结束，其余卡照常处理，PM 只收到一次通知", () => {
  /** A second auto build card with no trigger: the takeover looks at it and leaves it (a quiet block, nothing to record). */
  function second(p: Fx) {
    createTask(p.f.db, p.f.at("owner"), { project: "p", id: "T2", title: "auto 2", kind: "code", extra: { fileGlobs: ["src/lib/y.ts"] } });
    setWorkflow(p.f.db, p.f.at("owner"), { taskId: "T2", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "codex", fallback: "只报错不修" });
    p.f.db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T2'");
  }

  /** The bridge the real pass notifies the PM through (autostartHooks → notifyProjectPm): every frame is accepted, its text kept. */
  const RealWebSocket = globalThis.WebSocket;
  function fakeBridge(): string[] {
    const texts: string[] = [];
    class FakeWs {
      onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void; onclose?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(s: string) {
        const m = JSON.parse(s);
        texts.push(String(m.text));
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ requestId: m.requestId, result: { ok: true } }) }));
      }
      close() { /* nothing to release in the double */ }
    }
    globalThis.WebSocket = FakeWs as never;
    return texts;
  }

  test("命令返回失败（含租约丢失的拒绝）：卡按 observe 结束、不抛、不重试；同进程多轮只通知一次", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      second(p);
      const seen: string[] = [], notices: string[] = [];
      const failing: Call = async (...args) => { seen.push(args[1]!); return { ok: false, code: "lease-lost", error: "scheduler lease lost（T1）" }; };
      const d = deps(p, ro, failing, notices);
      for (let i = 0; i < 3; i++) {
        const r = await localTakeoverTick(d, { p: p.policy });
        expect(r.failed).toEqual([]);
        expect(r.cards.map((c) => `${c.taskId}:${c.step}`)).toEqual(["T1:observe", "T2:observe"]);
      }
      expect(seen).toEqual(["scheduler-recovery-observe", "scheduler-recovery-observe", "scheduler-recovery-observe"]); // once per pass, never retried inside one
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("观察记录没写进台账");
      expect(notices[0]).toContain("scheduler lease lost");
      expect(notes(p)).toEqual([]);
      // The command works again: the next pass records it, and says nothing more.
      const ok = deps(p, ro, cliAsScheduler(p), notices, { told: d.told });
      await localTakeoverTick(ok, { p: p.policy });
      expect(notes(p)).toHaveLength(1);
      expect(notices).toHaveLength(1);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);

  test("生产 pass（真实 schedulerPass / autostartHooks / takeoverStep）：observe 命令答 lease-lost 而本轮租约仍在，这一轮照常结束、后面的步骤照走、PM 只收一次", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    const maintenance = { path: join(p.f.dir, "m.lock"), marker: join(p.f.dir, "u.marker"), request: join(p.f.dir, "m.req") };
    const raw = { enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: p.f.dir, remote: p.policy.remote } } };
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(raw));
    try {
      const seen: string[] = [], later: string[] = [], notices = fakeBridge();
      let owner = true, lost = true;
      // Only the observe command is refused; every other command of the pass answers a successful duplicate.
      const manager: Call = async (...args) => {
        if (args[1] !== "scheduler-recovery-observe") return { ok: true, duplicate: true };
        seen.push(args[1]);
        return lost ? { ok: false, code: "lease-lost", error: "synthetic observe write rejection" } : p.cli("scheduler", ...args.slice(1));
      };
      const run = () => schedulerPass(ro, parseSchedulerConfig(raw), { assertOwner: () => { if (!owner) throw new SchedulerStopped("not the owner"); }, manager, maintenance,
        takeoverPolicy: observe, peerPr: async () => ({ failed: [] }), lifecycle: async () => [], lockYield: async () => [],
        retire: async () => { later.push("retire"); return []; }, // a step after the takeover: reached only when the pass goes on
        autoDeps: () => ({ ...p.f.tickDeps, manager: async () => ({ ok: true, duplicate: true }), borrow: async () => [] }) });
      for (let i = 0; i < 3; i++) expect(await run()).toEqual({ ran: true, failed: [] });
      expect(seen).toHaveLength(3); // once per pass, never retried inside one
      expect(later).toEqual(["retire", "retire", "retire"]);
      const failed = () => notices.filter((n) => n.includes("观察记录没写进台账"));
      expect(failed()).toHaveLength(1);
      expect(failed()[0]).toContain("synthetic observe write rejection");
      expect(notes(p)).toEqual([]);
      // The service really stopping while the command is out still ends the pass as SchedulerStopped: no notice, nothing after it.
      owner = false;
      await expect(run()).rejects.toBeInstanceOf(SchedulerStopped);
      expect(later).toHaveLength(3);
      expect(failed()).toHaveLength(1);
      // The command works again: the next pass records it and says nothing more.
      owner = true; lost = false;
      expect(await run()).toEqual({ ran: true, failed: [] });
      expect(notes(p)).toHaveLength(1);
      expect(failed()).toHaveLength(1);
    } finally { globalThis.WebSocket = RealWebSocket; rmSync(SCHEDULER_CONFIG_PATH, { force: true }); ro.close(); p.f.close(); }
  }, E2E_MS);

  test("命令抛普通错误同样只算这张卡没记上；服务在停（SchedulerStopped）照旧上抛", async () => {
    const p = await ready();
    const ro = serviceDb(p);
    try {
      const notices: string[] = [];
      const thrown = deps(p, ro, async () => { throw new Error("child exit=1"); }, notices);
      expect(await localTakeoverTick(thrown, { p: p.policy })).toMatchObject({ failed: [], cards: [{ taskId: "T1", step: "observe" }] });
      expect(notices).toHaveLength(1);
      const stopped = deps(p, ro, async () => { throw new SchedulerStopped("stopping"); }, notices);
      await expect(localTakeoverTick(stopped, { p: p.policy })).rejects.toBeInstanceOf(SchedulerStopped);
      expect(notices).toHaveLength(1);
      expect(notes(p)).toEqual([]);
    } finally { ro.close(); p.f.close(); }
  }, E2E_MS);
});
