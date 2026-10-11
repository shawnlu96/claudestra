/**
 * dispatch-recovery-CYBRETRY1 r2 审查 P1：第 2 次截断进退避时新卡还没有恢复认领，按真实调度顺序（监护 tick → auto tick）跑，
 * auto tick 不能把单退人工；让开有界：退避到点加 2 分钟宽限过了监护仍没认领，auto tick 照旧退人工。开关 off / observe 与改动前一样。
 * 真台账 + 进程内 ledger CLI + 自动流程（scheduler-auto-helpers），宿主 / bridge 换成假的；时钟用 setSystemTime 与监护对齐。
 */
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { AgentSupervisor, type SuperviseDeps } from "../src/lib/agent-supervisor.js";
import { cyberBackoffHolds } from "../src/lib/agent-supervisor-bridge.js";
import { supervisorHolds, withSupervisorHold } from "../src/lib/agent-supervisor-hold.js";
import { recordSupervise } from "../src/lib/agent-supervisor-ledger.js";
import { getAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { codexFailure } from "../src/lib/scheduler-auto-ports.js";
import { boundRef, schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { SCHEDULER_CONFIG_PATH, type SchedulerConfig } from "../src/lib/scheduler-config.js";
import { ledgerResult } from "../src/lib/scheduler-work-order.js";
import { createAcpWorker } from "../src/lib/worker-acp.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const MIN = 60_000;
const CYBER = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";
const CONFIG: SchedulerConfig = {
  enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } },
};
const REGISTRY: RegistryAgent[] = [
  { name: "agent-task-one", channelId: "ch-one", sessionId: "s-one", projectId: "p", runtime: "claude-code", status: "active" },
  { name: "agent-rv-t1", channelId: "ch-rv", sessionId: "s-rv", projectId: "p", runtime: "codex", transport: "acp", status: "active" },
];

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

/** 监护：真 AgentSupervisor、真台账，时钟 now 同时设成系统时间（hold 读 Date.now()） */
function harness(f: F) {
  let now = Date.parse("2026-10-11T04:00:00Z");
  setSystemTime(new Date(now));
  cleanup.push(() => setSystemTime());
  const log = { sends: 0, escalations: [] as string[] };
  const deps: SuperviseDeps = {
    registry: () => REGISTRY, calls: () => [], held: () => undefined, probe: async () => "running", activity: () => null, overload: () => ({}),
    record: async (rec) => {
      try { return { ok: true, duplicate: recordSupervise(f.db, { actor: "scheduler", now }, rec).duplicate }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    send: async () => (log.sends++, { ok: true }),
    restart: async () => ({ ok: true }),
    escalate: async (taskId, intentId, reason) => {
      const r = await f.cli("scheduler", "scheduler-fallback-manual", taskId, "--reason", reason, "--intent", intentId);
      if (r.ok !== true) throw new Error(String(r.error));
      log.escalations.push(reason);
    },
    notifyCaller: async () => {}, notifyOwner: async () => {}, now: () => now, log: () => {},
  };
  const sup = new AgentSupervisor(() => {});
  const advance = (ms: number) => { now += ms; setSystemTime(new Date(now)); };
  /** 一轮调度 pass 的顺序（scheduler-pass.ts）：监护在前，auto tick 套 withSupervisorHold 在后 */
  const pass = async (ms = 31_000) => {
    advance(ms);
    const s = await sup.tick(f.db, CONFIG, deps);
    const card = (await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, withSupervisorHold(f.tickDeps, f.db))).cards[0];
    return { outcomes: s.outcomes, card };
  };
  /** 恢复消息之后又被拦：bridge 再开一张带会话、失败时刻的回合失败卡 */
  const cutAgain = () => openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败",
    context: CYBER, extra: { failure: "error", sessionId: "s-rv", failedAt: now } }, now);
  return { pass, cutAgain, advance, log, now: () => now };
}

/** 交付、派出审查；审查员回合被 cyber_policy 截断，bridge 开了「Codex 回合失败」卡 */
async function reviewCut(f: F): Promise<void> {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick();
  const send = async () => {
    const claimed = (f.db.query("SELECT updatedAt FROM scheduler_intents WHERE status = 'submitted'").get() as { updatedAt: number }).updatedAt;
    openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败", context: CYBER, extra: { failure: "error" } }, claimed + 1);
    return { ok: true as const, messageId: "m" };
  };
  f.tickDeps.worker = () => createAcpWorker({
    sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
    ledger: { result: (ref, probe) => ledgerResult(f.db, ref, probe) },
    port: { prompt: send, turnState: async (a) => ({ live: "idle", lastFailure: codexFailure(f.db, a) }), cancel: async () => ({ ok: true, evidence: "c" }) },
  });
  expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
}

async function setup(mode: "on" | "observe" | "off") {
  const f = autoFixture();
  cleanup.push(() => f.close());
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ ...CONFIG, supervise: { ...CONFIG.supervise, cyberRetry: mode } }));
  cleanup.push(() => rmSync(SCHEDULER_CONFIG_PATH, { force: true }));
  await reviewCut(f);
  const h = harness(f);
  const first = await h.pass();
  expect(first.outcomes[0]).toMatchObject({ step: "recover" });
  expect(first.card).toMatchObject({ step: "waiting" }); // 第 1 次：监护当轮认领，auto tick 让开（改动前就如此）
  return { f, h };
}

describe("[验收线 1] cyber 退避期间 auto tick 不退人工（真实 监护 → auto tick 顺序）", () => {
  test("第 2 次截断进退避：auto tick 让开；到点监护发第 2 次；第 3 次同理；次数用满后第 4 次退人工", async () => {
    const { f, h } = await setup("on");
    h.cutAgain();
    const wait2 = await h.pass(); // 距第 1 次不到 2 分钟
    expect(wait2.outcomes.filter((o) => o.step === "recover" || o.step === "report")).toEqual([]);
    expect(wait2.card).toMatchObject({ step: "waiting" });
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    expect((await h.pass(2 * MIN)).outcomes[0]).toMatchObject({ step: "recover" }); // 第 2 次
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    h.cutAgain();
    for (const ms of [31_000, 3 * MIN, 5 * MIN]) { // 第 3 次的 10 分钟退避里每一轮都让开
      expect((await h.pass(ms)).card).toMatchObject({ step: "waiting" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    }
    expect((await h.pass(2 * MIN)).outcomes[0]).toMatchObject({ step: "recover" }); // 第 3 次
    expect(h.log.sends).toBe(3);
    h.cutAgain();
    const r = await h.pass();
    expect(r.outcomes[0]).toMatchObject({ step: "report" });
    expect(h.log.escalations).toEqual([expect.stringContaining("建议：改 Claude 同家审、标待换模型终审")]);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    expect(f.notices).toEqual([]);
  });

  test("反例：退避到点加 2 分钟宽限过了监护仍没认领 → auto tick 照旧退人工", async () => {
    const { f, h } = await setup("on");
    const card = h.cutAgain();
    const at = h.now();
    // 监护这期间没跑（宕了）：只看让开判定本身
    expect(supervisorHolds(f.db, "agent-rv-t1")).toBe(true);
    h.advance(4 * MIN - 1000); // 第 1 次恢复与这张卡同一刻（at）：第 2 次到点 = at + 2 分钟，加宽限 = at + 4 分钟
    expect(cyberBackoffHolds(f.db, "agent-rv-t1", getAsk(f.db, card.id)!, Date.now(), "on")).toBe(true); // 宽限内
    h.advance(2000);
    expect(Date.now() - at).toBeGreaterThan(4 * MIN);
    expect(supervisorHolds(f.db, "agent-rv-t1")).toBe(false);
    expect((await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, withSupervisorHold(f.tickDeps, f.db))).cards[0]).toMatchObject({ step: "manual" });
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
  });

  test("上一次恢复消息确定没发出去 / 不是 cyber 的回合失败：不让开", async () => {
    const { f, h } = await setup("on");
    const other = openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败",
      context: "boom", extra: { failure: "error" } }, h.now());
    expect(cyberBackoffHolds(f.db, "agent-rv-t1", other, h.now(), "on")).toBe(false);
    expect(supervisorHolds(f.db, "agent-rv-t1")).toBe(false);
    const g = autoFixture();
    cleanup.push(() => g.close());
    const t = h.now();
    recordSupervise(g.db, { actor: "scheduler", now: t }, { agent: "a", project: "p", target: "", sessionId: "s", fault: "cyber", faultKey: "k1", workKey: "order:i",
      step: "recover", attempt: 1, limit: 3, phase: "claim" });
    recordSupervise(g.db, { actor: "scheduler", now: t }, { agent: "a", project: "p", target: "", sessionId: "s", fault: "cyber", faultKey: "k1", workKey: "order:i",
      step: "recover", attempt: 1, limit: 3, phase: "done", result: "failed" });
    const c = openAsk(g.db, { project: "p", fromAgent: "a", source: "codex", kind: "owner_action", title: "Codex 回合失败", context: CYBER, extra: { failure: "error" } }, t + 1000);
    expect(cyberBackoffHolds(g.db, "a", c, t + 2000, "on")).toBe(false);
  });
});

describe("[验收线 4] 开关 off / observe：与改动前一样（第 2 次截断由监护报派活方退人工）", () => {
  for (const mode of ["off", "observe"] as const) {
    test(mode, async () => {
      const logs: string[] = [];
      const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
      cleanup.push(() => spy.mockRestore());
      const { f, h } = await setup(mode);
      const card = h.cutAgain();
      expect(cyberBackoffHolds(f.db, "agent-rv-t1", card, h.now() + 1000, mode)).toBe(false);
      const r = await h.pass();
      expect(r.outcomes[0]).toMatchObject({ step: "report" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(h.log.sends).toBe(1);
      expect(logs.some((l) => l.includes("auto tick 本该让开"))).toBe(mode === "observe");
    });
  }
});
