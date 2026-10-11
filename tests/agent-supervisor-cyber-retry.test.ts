/**
 * dispatch-recovery-CYBRETRY1：cyber 截断自动恢复 3 次（立刻 / 2 分钟 / 10 分钟），有派活方的会话失败卡不推 owner，
 * 会话被 remove / kill 后关掉它的回合失败卡；开关 on / observe / off。合成台账与注册表，不连真实 bridge。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armGoneCardSweep, closeGoneAgentCards, cyberFailureCardQuiet, failureCardQuiet, goneSweepState, readCyberRetryMode, resetGoneSweepForTest,
  strictRegistry, type BridgeView, type CyberRetryMode } from "../src/lib/agent-supervisor-bridge.js";
import "../src/bridge/stop-settle.js"; // 模块加载时接上收会话关卡的周期扫
import { decide, workKeyOf, type WorkRef } from "../src/lib/agent-supervisor-policy.js";
import { recordSupervise } from "../src/lib/agent-supervisor-ledger.js";
import type { Supervised } from "../src/lib/agent-supervisor-scope.js";
import { getAsk, openAsk, type Ask } from "../src/lib/ledger-asks.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const MIN = 60_000;
const CYBER = "This content was flagged for possible cybersecurity risk.";
const CONFIG: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } } };
const ORDER: WorkRef = { kind: "order", taskId: "T1", intentId: "i-1", step: "review" };
const CALL: WorkRef = { kind: "call", caller: "agent-pm", callerChannelId: "ch-pm", since: 5 };
const sup = (agent: string, work: WorkRef): Supervised => ({ agent, channelId: `ch-${agent}`, sessionId: `s-${agent}`, project: "p", runtime: "codex",
  transport: "acp", work });
const reg = (name: string, o: Partial<RegistryAgent> = {}): RegistryAgent => ({ name, status: "active", channelId: `ch-${name}`, sessionId: `s-${name}`,
  projectId: "p", ...o });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

function fixture(mode: CyberRetryMode | undefined, list: Supervised[], registry: RegistryAgent[] | null) {
  const f = autoFixture();
  cleanup.push(() => f.close());
  const view: BridgeView = { config: () => CONFIG, db: () => f.db, supervised: () => list, registry: () => registry,
    ...(mode ? { cyberMode: () => mode } : {}) };
  return { f, view };
}

function logs() {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  cleanup.push(() => spy.mockRestore());
  return lines;
}

/** 监护认领一次恢复（台账事件），计数从这里出 */
function recovered(db: ReturnType<typeof autoFixture>["db"], s: Supervised, i: number, ts: number): void {
  recordSupervise(db, { actor: "scheduler", now: ts }, { agent: s.agent, project: "p", target: "T1", sessionId: s.sessionId, fault: "cyber",
    faultKey: `cyber-${s.agent}-${i}`, workKey: workKeyOf(s.work), step: "recover", phase: "claim", attempt: i, limit: 3 });
}

/** bridge 开一张回合失败卡（同 acp-link onFailure 的 extra） */
const failCard = (db: ReturnType<typeof autoFixture>["db"], agent: string, extra: Record<string, unknown> = {}, title = "Codex 回合失败"): Ask =>
  openAsk(db, { project: "p", fromAgent: agent, source: "codex", kind: "owner_action", title, context: CYBER,
    extra: { failure: "error", sessionId: `s-${agent}`, ...extra } }, Date.now() - 10);

describe("[验收线 1] 同一件活 3 次恢复：立刻、2 分钟后、10 分钟后；第 4 次 report", () => {
  test("开关 on：退避没到返回 wait，到了 act；三次用完 report 并带建议", () => {
    const t0 = 1_000_000;
    expect(decide("cyber", [], t0, t0, "on")).toEqual({ kind: "act", action: "recover", attempt: 1, limit: 3 });
    const t1 = t0;
    expect(decide("cyber", [t1], t1 + 30_000, t1 + MIN, "on")).toEqual({ kind: "wait", untilMs: t1 + 2 * MIN, attempt: 2 }); // 先红：改动前这里就 report
    expect(decide("cyber", [t1], t1 + 30_000, t1 + 2 * MIN, "on")).toEqual({ kind: "act", action: "recover", attempt: 2, limit: 3 });
    const t2 = t1 + 2 * MIN;
    expect(decide("cyber", [t1, t2], t2 + MIN, t2 + 9 * MIN, "on")).toEqual({ kind: "wait", untilMs: t2 + 10 * MIN, attempt: 3 });
    expect(decide("cyber", [t1, t2], t2 + MIN, t2 + 10 * MIN, "on")).toEqual({ kind: "act", action: "recover", attempt: 3, limit: 3 });
    const t3 = t2 + 10 * MIN;
    expect(decide("cyber", [t1, t2, t3], t3 + MIN, t3 + 60 * MIN, "on")).toEqual({ kind: "report", attempts: 3, limit: 3, advice: "改 Claude 同家审、标待换模型终审" });
  });
});

describe("[验收线 2] 有派活方的会话 4 次都不推 owner；owner 自己的会话第 4 次才推", () => {
  for (const work of [ORDER, CALL]) {
    test(`有派活方（${work.kind}）：4 次截断失败卡都 quiet，次数用完也不推`, () => {
      const s = sup("agent-rv", work);
      const { f, view } = fixture("on", [s], [reg("agent-rv")]);
      logs();
      const got: boolean[] = [];
      for (let i = 1; i <= 4; i++) {
        got.push(cyberFailureCardQuiet(s.agent, CYBER, Date.now(), { sessionId: s.sessionId }, () => false, view));
        failCard(f.db, s.agent);
        if (i <= 3) recovered(f.db, s, i, Date.now() - (4 - i) * 1000); // 监护发了第 i 次恢复消息
      }
      expect(got).toEqual([true, true, true, true]);
    });
  }

  test("派单会话由派活方接手（dispatched）：照旧 quiet，不在名单也一样", () => {
    const { view } = fixture("on", [], [reg("agent-rv")]);
    expect(cyberFailureCardQuiet("agent-rv", CYBER, Date.now(), { sessionId: "s-agent-rv" }, () => true, view)).toBe(true);
  });

  test("没有派活方的会话：前 3 次 quiet，第 4 次推 owner；换了会话从头数", () => {
    const { f, view } = fixture("on", [], [reg("agent-own")]);
    logs();
    const got: boolean[] = [];
    for (let i = 1; i <= 4; i++) {
      got.push(cyberFailureCardQuiet("agent-own", CYBER, Date.now(), { sessionId: "s-agent-own" }, () => false, view));
      failCard(f.db, "agent-own");
    }
    expect(got).toEqual([true, true, true, false]);
    expect(cyberFailureCardQuiet("agent-own", CYBER, Date.now(), { sessionId: "s-new" }, () => false, view)).toBe(true);
  });

  test("不是 cyber、没开监护的项目、master：照旧推", () => {
    const { view } = fixture("on", [sup("agent-rv", CALL)], [reg("agent-own"), reg("agent-q", { projectId: "q" }), reg("master")]);
    expect(cyberFailureCardQuiet("agent-rv", "Context window exceeded", Date.now(), {}, () => false, view)).toBe(false);
    expect(cyberFailureCardQuiet("agent-q", CYBER, Date.now(), {}, () => false, view)).toBe(false);
    expect(cyberFailureCardQuiet("master", CYBER, Date.now(), {}, () => false, view)).toBe(false);
  });
});

describe("[验收线 3] 会话被 remove / kill 后关掉它开着的回合失败卡", () => {
  test("被 remove、被 kill 的关；投递不明、额度、登录、还活着的、出借 worker 的不关", () => {
    const { f, view } = fixture("on", [], [reg("agent-live"), reg("agent-killed", { status: "stopped" })]);
    logs();
    const removed = failCard(f.db, "agent-gone");
    const killed = failCard(f.db, "agent-killed");
    const unknown = failCard(f.db, "agent-gone", { deliveryUnknown: true });
    const quota = openAsk(f.db, { project: "p", fromAgent: "agent-gone", source: "codex", kind: "decide", title: "额度", extra: { quota: true } });
    const auth = openAsk(f.db, { project: "p", fromAgent: "agent-gone", source: "codex", kind: "owner_action", title: "Codex 需要 owner 登录" });
    const live = failCard(f.db, "agent-live");
    const lend = failCard(f.db, "agent-lend-x1");
    const published: string[] = [];
    const r = closeGoneAgentCards(f.db, (a) => void published.push(a.id), Date.now(), view);
    expect(r.closed.sort()).toEqual([removed.id, killed.id].sort());
    expect(published.sort()).toEqual(r.closed.sort());
    expect(getAsk(f.db, removed.id)?.state).toBe("cancelled");
    expect(getAsk(f.db, removed.id)?.extra.sessionGoneAt).toBeNumber();
    for (const a of [unknown, quota, auth, live, lend]) expect(getAsk(f.db, a.id)?.state).toBe("open");
    expect(closeGoneAgentCards(f.db, () => {}, Date.now(), view).closed).toEqual([]); // 再扫一次没有可关的
  });

  test("registry 读不出来：一张都不关（不能当所有人都没了）；监护关着也不关", () => {
    const a = fixture("on", [], null);
    const card = failCard(a.f.db, "agent-gone");
    expect(closeGoneAgentCards(a.f.db, () => {}, Date.now(), a.view).closed).toEqual([]);
    expect(getAsk(a.f.db, card.id)?.state).toBe("open");
    const off: BridgeView = { ...a.view, registry: () => [], config: () => ({ ...CONFIG, supervise: { enabled: false, stuckMin: 20 } }) };
    expect(closeGoneAgentCards(a.f.db, () => {}, Date.now(), off).closed).toEqual([]);
    expect(getAsk(a.f.db, card.id)?.state).toBe("open");
  });
});

describe("[验收线 3] 注册表结构坏了不当删除证据；remove 后不靠别的会话正常结束也关卡", () => {
  test("strictRegistry：顶层没 agents、agents 不是对象、条目是 null → null；完好的照常规范化", () => {
    for (const bad of [{}, null, [], { agents: [] }, { agents: null }, { agents: { "agent-live": null } }, { agents: { a: {}, b: 3 } }]) expect(strictRegistry(bad)).toBeNull();
    expect(strictRegistry({ agents: {} })).toEqual([]);
    expect(strictRegistry({ agents: { "agent-live": { status: "active", projectId: "p" } } })?.map((a) => a.name)).toEqual(["agent-live"]);
  });

  test("结构坏的注册表（{}、条目为 null）：活着的 agent 的回合失败卡不关", () => {
    for (const raw of [{}, { agents: { "agent-live": null } }]) {
      const { f, view } = fixture("on", [], strictRegistry(raw));
      const card = failCard(f.db, "agent-live");
      expect(closeGoneAgentCards(f.db, () => {}, Date.now(), view)).toEqual({ closed: [], observed: [] });
      expect(getAsk(f.db, card.id)?.state).toBe("open");
    }
  });

  test("接线：bridge 加载 stop-settle 就接上周期扫；agent 被 remove 后没有任何正常 Stop，下一次扫也把卡关掉", () => {
    expect(goneSweepState().wired).toBe(true); // stop-settle.ts 模块加载时调的 armGoneCardSweep（测试进程不起真计时器）
    expect(goneSweepState().running).toBe(false);
    resetGoneSweepForTest();
    cleanup.push(() => resetGoneSweepForTest());
    let registry: RegistryAgent[] = [reg("agent-a"), reg("agent-b")];
    const { f } = fixture("on", [], null);
    const view: BridgeView = { config: () => CONFIG, db: () => f.db, supervised: () => [], registry: () => registry, cyberMode: () => "on" };
    logs();
    const ticks: (() => void)[] = [];
    const start = (t: () => void, ms: number) => (ticks.push(t), expect(ms).toBe(60_000), setInterval(() => {}, 1 << 30));
    const published: string[] = [];
    armGoneCardSweep(() => f.db, (a) => void published.push(a.id), start, view);
    armGoneCardSweep(() => f.db, () => {}, start, view); // 重复调只起一个
    expect(ticks).toHaveLength(1);
    expect(goneSweepState()).toEqual({ wired: true, running: true });
    const card = failCard(f.db, "agent-a");
    ticks[0]();
    expect(getAsk(f.db, card.id)?.state).toBe("open"); // 还活着
    registry = [reg("agent-b")]; // manager remove agent-a；agent-b 一直空闲，没有正常 Stop
    ticks[0]();
    expect(getAsk(f.db, card.id)?.state).toBe("cancelled");
    expect(published).toEqual([card.id]);
  });
});

describe("[验收线 4] observe 只记「本该」，off 与改动前完全一致", () => {
  test("observe：推卡照旧（owner 会话推、名单里次数用完推），日志有「本该不推」；关卡不关，日志有「本该关」", () => {
    const s = sup("agent-rv", CALL);
    const { f, view } = fixture("observe", [s], [reg("agent-own"), reg("agent-rv")]);
    const lines = logs();
    for (let i = 1; i <= 3; i++) recovered(f.db, s, i, Date.now() - 1000 * i);
    expect(cyberFailureCardQuiet("agent-rv", CYBER, Date.now(), {}, () => false, view)).toBe(false); // 改动前：用完就推
    expect(cyberFailureCardQuiet("agent-own", CYBER, Date.now(), { sessionId: "s-agent-own" }, () => false, view)).toBe(false); // 改动前：不在名单就推
    expect(lines.filter((l) => l.includes("本该不推 owner"))).toHaveLength(2);
    const card = failCard(f.db, "agent-gone");
    const r = closeGoneAgentCards(f.db, () => {}, Date.now(), view);
    expect(r).toEqual({ closed: [], observed: [card.id] });
    expect(getAsk(f.db, card.id)?.state).toBe("open");
    expect(lines.filter((l) => l.includes(`${card.id} 本该关`))).toHaveLength(1);
    closeGoneAgentCards(f.db, () => {}, Date.now(), view);
    expect(lines.filter((l) => l.includes(`${card.id} 本该关`))).toHaveLength(1); // 每张只记一次
  });

  for (const mode of ["off", undefined] as const) {
    test(`off（${mode ?? "view 不带开关"}）：判定 = failureCardQuiet || dispatched，短路一样；不关卡、不记日志`, () => {
      const s = sup("agent-rv", CALL);
      const { f, view } = fixture(mode, [s], [reg("agent-own"), reg("agent-rv")]);
      const lines = logs();
      let calls = 0;
      const dispatched = () => (calls++, false);
      expect(cyberFailureCardQuiet("agent-rv", CYBER, Date.now(), {}, dispatched, view)).toBe(true); // 监护还有次数：改动前就 quiet
      expect(calls).toBe(0);
      for (let i = 1; i <= 3; i++) recovered(f.db, s, i, Date.now() - 1000 * i);
      expect(cyberFailureCardQuiet("agent-rv", CYBER, Date.now(), {}, dispatched, view)).toBe(false);
      expect(cyberFailureCardQuiet("agent-own", CYBER, Date.now(), {}, dispatched, view)).toBe(false);
      expect(cyberFailureCardQuiet("agent-own", CYBER, Date.now(), {}, () => true, view)).toBe(true);
      expect(calls).toBe(2);
      const card = failCard(f.db, "agent-gone");
      expect(closeGoneAgentCards(f.db, () => {}, Date.now(), view)).toEqual({ closed: [], observed: [] });
      expect(getAsk(f.db, card.id)?.state).toBe("open");
      expect(lines).toEqual([]);
    });
  }

  test("observe / off：次数判定照改动前（一次恢复后就 report），observe 记「本该」；on 才用新规则", () => {
    const t1 = 1_000_000;
    const lines = logs();
    for (const mode of ["off", "observe"] as const) {
      expect(decide("cyber", [], t1, t1, mode)).toEqual({ kind: "act", action: "recover", attempt: 1, limit: 1 });
      expect(decide("cyber", [t1], t1 + 30_000, t1 + MIN, mode)).toEqual({ kind: "report", attempts: 1, limit: 1, advice: "改 Claude 同家审、标待换模型终审" });
    }
    expect(lines.filter((l) => l.includes("本该等退避后发第 2 次恢复消息"))).toHaveLength(1); // 只有 observe 记，off 不记
    decide("cyber", [t1], t1 + 30_000, t1 + MIN, "observe");
    expect(lines.filter((l) => l.includes("本该"))).toHaveLength(1); // 同一次判定只记一次
    expect(decide("cyber", [t1], t1 + 30_000, t1 + MIN, "on")).toMatchObject({ kind: "wait", attempt: 2 });
  });

  test("一次恢复已用、有派活方：off / observe 照改动前推 owner（quiet=false），observe 记「本该不推」；on 不推", () => {
    const s = sup("agent-rv", CALL);
    const lines = logs();
    const got: Record<string, boolean[]> = {};
    for (const mode of ["off", "observe", "on"] as const) {
      const { f, view } = fixture(mode, [s], [reg("agent-rv")]);
      recovered(f.db, s, 1, Date.now() - 1000);
      got[mode] = [failureCardQuiet(s.agent, CYBER, Date.now(), view), cyberFailureCardQuiet(s.agent, CYBER, Date.now(), { sessionId: s.sessionId }, () => false, view)];
    }
    expect(got).toEqual({ off: [false, false], observe: [false, false], on: [true, true] });
    expect(lines.filter((l) => l.includes("本该不推 owner"))).toHaveLength(1);
  });

  test("开关读 scheduler.json 的 supervise.cyberRetry；没写、写错、读不了 = observe", () => {
    const dir = mkdtempSync(join(tmpdir(), "cybretry-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, "scheduler.json");
    expect(readCyberRetryMode(p)).toBe("observe");
    for (const [raw, want] of [[{ supervise: { cyberRetry: "on" } }, "on"], [{ supervise: { cyberRetry: "off" } }, "off"],
      [{ supervise: true }, "observe"], [{ supervise: { cyberRetry: "yes" } }, "observe"]] as const) {
      writeFileSync(p, JSON.stringify({ enabled: true, ...raw }));
      expect(readCyberRetryMode(p)).toBe(want);
    }
    writeFileSync(p, "{broken");
    expect(readCyberRetryMode(p)).toBe("observe");
  });
});
