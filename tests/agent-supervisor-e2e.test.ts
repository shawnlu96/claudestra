/**
 * i28-S1 端到端：真台账 + 进程内 ledger CLI + 自动流程（scheduler-auto-helpers），宿主 / bridge 换成假的。
 * 1. 被 cyber_policy 截断 → 监护同会话续派恢复消息 → auto-tick 让开不退回人工 → 审查员交结论 → 下一个正常回合关掉失败卡；
 * 2. 宿主死了 → 两次观察 → 重启 → 补发「接着做」只一次 → 执行者交付只一次；
 * 外加上限、并发、恢复竞态、越权。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSupervisor, type SuperviseDeps } from "../src/lib/agent-supervisor.js";
import { withSupervisorHold } from "../src/lib/agent-supervisor-hold.js";
import { recordSupervise, superviseEvents } from "../src/lib/agent-supervisor-ledger.js";
import { CYBER_RECOVERY_TEXT, HOUR_MS } from "../src/lib/agent-supervisor-policy.js";
import type { OverloadFile } from "../src/lib/agent-supervisor-bridge.js";
import type { CallRow } from "../src/lib/agent-supervisor-scope.js";
import { getAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import { codexFailure } from "../src/lib/scheduler-auto-ports.js";
import { boundRef, schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { SCHEDULER_CONFIG_PATH, type SchedulerConfig } from "../src/lib/scheduler-config.js";
import { ledgerResult } from "../src/lib/scheduler-work-order.js";
import { createAcpWorker } from "../src/lib/worker-acp.js";
import type { AdapterDeps } from "../src/lib/worker-ports.js";
import type { WorkerLiveness } from "../src/lib/worker-liveness.js";
import { setAsksForTest } from "../src/bridge/asks.js";
import { closeRecoveredCards } from "../src/bridge/stop-settle.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const CYBER = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.";

const CONFIG: SchedulerConfig = {
  enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } },
};

const REGISTRY: RegistryAgent[] = [
  { name: "agent-task-one", channelId: "ch-one", sessionId: "s-one", projectId: "p", runtime: "claude-code", status: "active" },
  { name: "agent-rv-t1", channelId: "ch-rv", sessionId: "s-rv", projectId: "p", runtime: "codex", transport: "acp", status: "active" },
  { name: "master", channelId: "ch-m", sessionId: "s-m", runtime: "claude-code" },
  { name: "agent-lend-0123456789", channelId: "ch-l", sessionId: "s-l", projectId: "p", runtime: "codex", transport: "acp" },
  { name: "agent-other", channelId: "ch-o", sessionId: "s-o", projectId: "q", runtime: "claude-code" },
];

function harness(f: F, opts: { config?: SchedulerConfig; registry?: RegistryAgent[] } = {}) {
  let now = 10 * HOUR_MS;
  const live: Record<string, WorkerLiveness> = {};
  const calls: CallRow[] = [];
  const overload: OverloadFile = {};
  const log = { sends: [] as { agent: string; sessionId: string; text: string }[], restarts: [] as string[], probes: [] as string[],
    escalations: [] as string[], callers: [] as string[], owners: [] as string[] };
  let sendOk = true;
  const deps: SuperviseDeps = {
    registry: () => opts.registry ?? REGISTRY,
    calls: () => calls,
    held: () => undefined,
    probe: async (s) => (log.probes.push(s.agent), live[s.agent] ?? "running"),
    activity: () => null,
    overload: () => overload,
    record: async (rec) => {
      try {
        const r = recordSupervise(f.db, { actor: "scheduler", now }, rec);
        return { ok: true, duplicate: r.duplicate };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    send: async (agent, sessionId, text) => (log.sends.push({ agent, sessionId, text }), sendOk ? { ok: true } : { ok: false, delivered: false, reason: "bridge 拒收" }),
    restart: async (agent) => (log.restarts.push(agent), { ok: true }),
    escalate: async (taskId, intentId, reason) => {
      const r = await f.cli("scheduler", "scheduler-fallback-manual", taskId, "--reason", reason, "--intent", intentId);
      if (r.ok !== true) throw new Error(String(r.error));
      log.escalations.push(reason);
    },
    notifyCaller: async (_c, text) => void log.callers.push(text),
    notifyOwner: async (_ch, text) => void log.owners.push(text),
    now: () => now,
    log: () => {},
  };
  const sup = new AgentSupervisor(() => {});
  const tick = async (ms = 31_000) => { now += ms; return sup.tick(f.db, opts.config ?? CONFIG, deps); };
  const events = (agent: string) => superviseEvents(f.db, agent);
  return { deps, sup, tick, live, calls, overload, log, events, setSend: (ok: boolean) => { sendOk = ok; }, now: () => now, advance: (ms: number) => { now += ms; } };
}

const adapter = (f: F): AdapterDeps => ({
  sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
  ledger: { result: (ref, probe) => ledgerResult(f.db, ref, probe) },
});

/** 交付、派出审查；审查员（Codex ACP）收单后回合被 cyber_policy 截断，bridge 开了「Codex 回合失败」卡 */
async function reviewCut(f: F): Promise<string> {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick(); // ensure reviewer
  let cardId = "";
  const send = async () => {
    const claimed = (f.db.query("SELECT updatedAt FROM scheduler_intents WHERE status = 'submitted'").get() as { updatedAt: number }).updatedAt;
    cardId = openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败",
      context: CYBER, extra: { failure: "error" } }, claimed + 1).id;
    return { ok: true as const, messageId: "m" };
  };
  f.tickDeps.worker = () => createAcpWorker({ ...adapter(f),
    port: { prompt: send, turnState: async (a) => ({ live: "idle", lastFailure: codexFailure(f.db, a) }), cancel: async () => ({ ok: true, evidence: "c" }) } });
  expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
  return cardId;
}

const autoWithHold = async (f: F) => (await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, withSupervisorHold(f.tickDeps, f.db))).cards[0];

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

describe("cyber_policy 截断 → 自动续派 → 交结论 → 卡被关掉", () => {
  test("全程不退回人工、不通知 PM；恢复后下一个正常回合关卡", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const cardId = await reviewCut(f);
    const h = harness(f);
    const r = await h.tick();
    expect(r.outcomes).toEqual([{ agent: "agent-rv-t1", step: "recover", detail: "第 1 次恢复消息已发" }]);
    expect(h.log.sends).toEqual([{ agent: "agent-rv-t1", sessionId: "s-rv", text: CYBER_RECOVERY_TEXT }]);
    // 自动流程让开：不当失败退回人工
    expect(await autoWithHold(f)).toMatchObject({ step: "waiting" });
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    expect(f.notices).toEqual([]);
    // 下一轮监护不重发
    await h.tick();
    expect(h.log.sends).toHaveLength(1);
    // 审查员交结论；bridge 收到它下一个正常结束的回合 → 关卡
    expect((await f.review("pass", H1, [])).ok).toBe(true);
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ ...CONFIG, supervise: CONFIG.supervise }));
    const regBackup = existsSync(REGISTRY_PATH);
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: Object.fromEntries(REGISTRY.map(({ name, ...a }) => [name, a])) }));
    setAsksForTest({ path: join(f.dir, "ledger.sqlite") });
    cleanup.push(() => { rmSync(SCHEDULER_CONFIG_PATH, { force: true }); if (!regBackup) rmSync(REGISTRY_PATH, { force: true }); setAsksForTest(undefined); });
    const quota = openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "decide", title: "额度", extra: { quota: true } });
    closeRecoveredCards("ch-rv");
    expect(getAsk(f.db, cardId)?.state).toBe("cancelled");
    expect(getAsk(f.db, quota.id)?.state).toBe("open"); // 额度卡不关
    // 留痕：识别与处置在台账上，PM 用 ledger show 看得到
    const notes = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "note" && e.data.op === "supervise");
    expect(notes.map((e) => `${e.data.step}/${e.data.phase}/${e.data.result ?? ""}`)).toEqual(["recover/claim/", "recover/done/ok"]);
  });

  test("同一件活第二次再被拦：不再发恢复消息，退回人工并带建议", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await reviewCut(f);
    const h = harness(f);
    await h.tick();
    // 恢复消息之后又被拦：第一张卡还没被关（没有正常回合），bridge 又开了一张
    openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败",
      context: CYBER, extra: { failure: "error" } }, Date.now());
    const r = await h.tick();
    expect(r.outcomes[0]).toMatchObject({ step: "report" });
    expect(h.log.sends).toHaveLength(1);
    expect(h.log.escalations).toEqual([expect.stringContaining("建议：改 Claude 同家审、标待换模型终审")]);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    expect(f.notices).toEqual([]); // 退回人工由监护做（通知走 deps），auto-tick 没有再退一次
    await h.tick();
    expect(h.log.escalations).toHaveLength(1);
  });

  test("恢复消息没送到：认领记 failed，auto-tick 照旧退回人工（不让开）", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await reviewCut(f);
    const h = harness(f);
    h.setSend(false);
    await h.tick();
    expect(await autoWithHold(f)).toMatchObject({ step: "manual" });
  });
});

describe("宿主死了 → 重启 → 补发接着做 → 交付不重复", () => {
  async function building(f: F) {
    await toBuild(f);
    await f.tick(); // build 单发给 agent-task-one
  }

  test("两次观察才重启；起来以后只补发一次；交付一次后不再监护", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await building(f);
    const h = harness(f);
    h.live["agent-task-one"] = "no_window";
    expect((await h.tick()).outcomes).toEqual([]); // 第一次否定只记下
    expect(h.log.restarts).toEqual([]);
    expect((await h.tick()).outcomes[0]).toMatchObject({ step: "restart" });
    expect(h.log.restarts).toEqual(["agent-task-one"]);
    h.live["agent-task-one"] = "running";
    expect((await h.tick()).outcomes[0]).toMatchObject({ step: "nudge" });
    for (let i = 0; i < 5; i++) await h.tick();
    expect(h.log.sends.map((s) => s.text)).toEqual([expect.stringContaining("上次中断了（宿主或窗口退出了")]);
    expect(h.log.sends[0].text).toContain("已经交付过的不要再交一次");
    expect(h.log.restarts).toHaveLength(1);
    expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
    const probes = h.log.probes.length;
    await h.tick(10 * 60_000);
    expect(h.log.probes.length).toBe(probes); // 交付了 = 不在名单，连探活都不做
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "deliver")).toHaveLength(1);
  });

  test("判定后、动手前恢复了：不重启", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await building(f);
    const h = harness(f);
    let n = 0;
    h.deps.probe = async () => (++n <= 2 ? "no_window" : "running");
    await h.tick();
    expect((await h.tick()).outcomes[0]).toMatchObject({ step: "recovered" });
    expect(h.log.restarts).toEqual([]);
  });

  test("认领期间恢复了 / 会话被换了：不重启，记 skipped，不占重启额度", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await building(f);
    let registry = REGISTRY;
    const h = harness(f, { registry: undefined });
    h.deps.registry = () => registry;
    const record = h.deps.record;
    let flip: (() => void) | null = () => { h.live["agent-task-one"] = "running"; };
    h.deps.record = async (rec) => {
      const r = await record(rec);
      if (rec.step === "restart" && rec.phase === "claim" && flip) flip(), (flip = null); // 台账写完、真正重启之前 agent 回来了
      return r;
    };
    h.live["agent-task-one"] = "no_window";
    await h.tick();
    expect((await h.tick()).outcomes[0]).toMatchObject({ step: "recovered" });
    expect(h.log.restarts).toEqual([]);
    expect(h.events("agent-task-one").map((e) => `${e.step}/${e.phase}/${e.result ?? ""}`)).toEqual(["restart/claim/", "restart/done/skipped"]);
    // 换会话：PM 刚把 registry 换成新会话
    h.live["agent-task-one"] = "no_window";
    flip = () => { registry = REGISTRY.map((a) => (a.name === "agent-task-one" ? { ...a, sessionId: "s-new" } : a)); };
    await h.tick();
    expect((await h.tick()).outcomes[0]).toMatchObject({ step: "recovered", detail: expect.stringContaining("不在监护范围") });
    expect(h.log.restarts).toEqual([]);
    // 两次 skipped 都不算数：恢复原会话后照常还有 2 次重启额度
    registry = REGISTRY;
    for (let i = 0; i < 40; i++) await h.tick();
    expect(h.log.restarts).toEqual(["agent-task-one", "agent-task-one"]);
  });

  test("最后一次探活期间活交了 / 退回人工：不重启；生产的重启在拉起 manager 前再核一次", async () => {
    for (const change of ["deliver", "manual"] as const) {
      const f = autoFixture();
      cleanup.push(() => f.close());
      await building(f);
      const h = harness(f);
      let n = 0;
      h.deps.probe = async () => {
        if (++n === 4) { // 认领之后那次探活：探活还没返回，结果先到了
          const r = change === "deliver" ? await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)
            : await f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "PM 接手");
          expect(r.ok).toBe(true);
        }
        return "no_window";
      };
      await h.tick();
      expect((await h.tick()).outcomes[0]).toMatchObject({ step: "recovered", detail: expect.stringContaining("不在监护范围") });
      expect(h.log.restarts).toEqual([]);
    }
    // 探活通过之后、拉起 manager 之前才交的：效果里的 eligible() 拦下
    const f = autoFixture();
    cleanup.push(() => f.close());
    await building(f);
    const h = harness(f);
    h.live["agent-task-one"] = "no_window";
    let checked: string | null = "未调";
    h.deps.restart = async (_a, want) => {
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      checked = want.eligible();
      return checked ? { ok: false, skipped: checked } : { ok: true };
    };
    await h.tick();
    expect((await h.tick()).outcomes[0]).toMatchObject({ step: "recovered" });
    expect(checked).toContain("不在监护范围");
    expect(h.events("agent-task-one").map((e) => `${e.step}/${e.phase}/${e.result ?? ""}`)).toEqual(["restart/claim/", "restart/done/skipped"]);
  });

  test("一小时最多重启 2 次，超了报派活方 + 告诉 owner，这件活不再自动重启", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await building(f);
    const h = harness(f);
    h.live["agent-task-one"] = "no_window";
    for (let i = 0; i < 40; i++) await h.tick();
    expect(h.log.restarts).toEqual(["agent-task-one", "agent-task-one"]);
    expect(h.log.escalations).toEqual([expect.stringContaining("自动处置已做 2/2 次")]);
    expect(h.log.owners).toHaveLength(1);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
  });

  test("两个监护实例同一刻处置同一个 agent：只重启一次（台账认领去重）", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await building(f);
    const a = harness(f), b = harness(f);
    for (const h of [a, b]) h.live["agent-task-one"] = "no_window";
    await a.tick(); await b.tick();
    await Promise.all([a.tick(), b.tick()]);
    expect(a.log.restarts.length + b.log.restarts.length).toBe(1);
  });

  test("撞额度的卡开着：不重启、不续跑，只留痕", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await building(f);
    openAsk(f.db, { project: "p", fromAgent: "agent-task-one", source: "codex", kind: "decide", title: "额度用完", extra: { quota: true } });
    const h = harness(f);
    h.live["agent-task-one"] = "no_window";
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.log.restarts).toEqual([]);
    expect(h.log.sends).toEqual([]);
    expect(h.events("agent-task-one").map((e) => `${e.fault}/${e.step}/${e.phase}`)).toEqual(["quota/report/claim", "quota/report/done"]);
  });
});

describe("越权与开关", () => {
  test("master、出借 worker、别的项目、换了会话、没有在途活的：一个都不碰", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await toBuild(f);
    await f.tick();
    const registry = REGISTRY.map((r) => (r.name === "agent-task-one" ? { ...r, sessionId: "s-new" } : r));
    const h = harness(f, { registry });
    for (const r of registry) h.live[r.name] = "no_window";
    h.calls.push({ callerChannelId: "ch-x", callerName: "agent-x", targetName: "master", ts: h.now() });
    h.calls.push({ callerChannelId: "ch-x", callerName: "agent-x", targetName: "agent-lend-0123456789", ts: h.now() });
    h.calls.push({ callerChannelId: "ch-x", callerName: "agent-x", targetName: "agent-other", ts: h.now() });
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.log.probes).toEqual([]);
    expect(h.log.restarts).toEqual([]);
  });

  test("send_to_agent 回程挂着的 agent 在监护里，派活方 = 发请求的那个 agent", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const registry: RegistryAgent[] = [{ name: "agent-helper", channelId: "ch-h", sessionId: "s-h", projectId: "p", runtime: "claude-code" }];
    const h = harness(f, { registry });
    h.calls.push({ callerChannelId: "ch-a", callerName: "agent-asker", targetName: "agent-helper", ts: h.now(), requests: [{ ts: h.now(), deliveredAt: h.now() }] });
    h.live["agent-helper"] = "no_window";
    for (let i = 0; i < 40; i++) await h.tick();
    expect(h.log.restarts).toEqual(["agent-helper", "agent-helper"]);
    expect(h.log.callers).toEqual([expect.stringContaining("给 agent-asker 的答复")]);
    expect(h.log.escalations).toEqual([]);
  });

  test("supervise 关着（全局或项目）：tick 什么都不读、不做", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await toBuild(f);
    await f.tick();
    for (const config of [{ ...CONFIG, supervise: { enabled: false, stuckMin: 20 } }, { ...CONFIG, supervise: undefined },
      { ...CONFIG, projects: { p: { ...CONFIG.projects.p, supervise: false } } }]) {
      const h = harness(f, { config });
      let reads = 0;
      h.deps.registry = () => (reads++, REGISTRY);
      h.live["agent-task-one"] = "no_window";
      for (let i = 0; i < 3; i++) await h.tick();
      expect(h.log.probes).toEqual([]);
      expect(h.log.restarts).toEqual([]);
      if (!config.supervise?.enabled) expect(reads).toBe(0);
    }
  });
});

describe("满载 / 限流：并进 bridge 的 60 秒续跑，不跑出两套", () => {
  test("bridge 每次续跑补进台账；bridge 说续跑用完了 → 报派活方一次", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await toBuild(f);
    await f.tick();
    const h = harness(f);
    const t = h.now();
    h.overload["ch-one"] = { agent: "agent-task-one", events: [{ at: t, error: "server_overloaded", act: "track" }, { at: t + 1, error: "server_overloaded", act: "track" }] };
    await h.tick();
    expect(h.events("agent-task-one").map((e) => `${e.step}/${e.phase}/${e.attempt}`)).toEqual(["resume/done/1", "resume/done/2"]);
    expect(h.log.sends).toEqual([]); // 续跑是 bridge 发的，监护不另发
    h.overload["ch-one"].events.push({ at: t + 2, error: "server_overloaded", act: "escalate" });
    expect((await h.tick()).outcomes[0]).toMatchObject({ step: "report" });
    await h.tick();
    expect(h.log.escalations).toEqual([expect.stringContaining("模型满载 / 限流")]);
  });

  test("cyber 卡开出时 bridge 已在续跑（适配器没给结构化失败）：只认领、不再发恢复消息", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await reviewCut(f);
    const h = harness(f);
    const card = f.db.query("SELECT createdAt FROM asks WHERE fromAgent = 'agent-rv-t1'").get() as { createdAt: number };
    h.overload["ch-rv"] = { agent: "agent-rv-t1", events: [{ at: card.createdAt + 50, error: "API Error", act: "track" }] };
    expect((await h.tick()).outcomes.find((o) => o.agent === "agent-rv-t1")).toMatchObject({ step: "recover", detail: "bridge 续跑接手" });
    expect(h.log.sends).toEqual([]);
    expect(await autoWithHold(f)).toMatchObject({ step: "waiting" });
  });
});
