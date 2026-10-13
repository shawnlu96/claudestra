/**
 * dispatch-recovery-SUPCNT1：监护的续跑计数只在同一件活内累计。真台账（临时库）+ 临时监护文件 + 合成的监护视图，bridge 那一半
 * （overloadEscalate / noteOverload / 正常 Stop 的清零）和调度服务那一半（AgentSupervisor 留痕、报派活方）接在同一个文件上跑。
 * 起因：BGW-1 的执行者在旧单上续跑用完、PM 恢复后领了 fix 单，监护拿旧单留在文件里的「用完了」把新单退回了人工。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSupervisor, type SuperviseDeps } from "../src/lib/agent-supervisor.js";
import { cardsToClose, noteOverload, overloadEscalate, readOverload, type BridgeView } from "../src/lib/agent-supervisor-bridge.js";
import { recordSupervise, superviseEvents } from "../src/lib/agent-supervisor-ledger.js";
import { HOUR_MS, isAuthFailure, workKeyOf } from "../src/lib/agent-supervisor-policy.js";
import { supervisedAgents, type Supervised } from "../src/lib/agent-supervisor-scope.js";
import { markResumed, RESUME_WINDOW_MS, type ApiErrorState } from "../src/lib/api-error-resume.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { settleStopTurn, type CallerSettleDeps, type StopTurn } from "../src/bridge/stop-settle.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const CONFIG: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } } };
const AGENT = "agent-task-one", CID = "ch-one";
const REGISTRY: RegistryAgent[] = [{ name: AGENT, channelId: CID, sessionId: "s-one", projectId: "p", runtime: "claude-code", status: "active" }];
const ORDER_B = "t68:s30:r1:fix:a0";

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

/** 一张在 build 的卡（单 A 已派给执行者）+ 临时监护文件；bridge 的续跑判定与调度服务的监护读写同一个文件 */
async function setup() {
  const f = autoFixture();
  const dir = mkdtempSync(join(tmpdir(), "supcnt-"));
  cleanup.push(() => { f.close(); rmSync(dir, { recursive: true, force: true }); });
  await toBuild(f);
  await f.tick();
  const path = join(dir, "supervise-overload.json");
  let now = 10 * HOUR_MS;
  const scope = (): Supervised[] => supervisedAgents({ config: CONFIG, registry: REGISTRY, db: f.db, calls: [], held: () => undefined, now });
  const fresh: BridgeView = { config: () => CONFIG, supervised: scope, db: () => f.db };
  const escalations: string[] = [];
  const deps: SuperviseDeps = {
    registry: () => REGISTRY, calls: () => [], held: () => undefined, probe: async () => "running", activity: () => null,
    overload: () => readOverload(path),
    record: async (rec) => ({ ok: true, duplicate: recordSupervise(f.db, { actor: "scheduler", now }, rec).duplicate }),
    send: async () => ({ ok: true }), restart: async () => ({ ok: true }),
    escalate: async (taskId, intentId, reason) => {
      const r = await f.cli("scheduler", "scheduler-fallback-manual", taskId, "--reason", reason, "--intent", intentId);
      if (r.ok !== true) throw new Error(String(r.error));
      escalations.push(reason);
    },
    notifyCaller: async () => {}, notifyOwner: async () => {}, now: () => now, log: () => {},
  };
  const sup = new AgentSupervisor(() => {});
  const states = new Map<string, ApiErrorState>();
  /** 一个回合以 API 错误结束（api-error-resume.ts noteApiError + quota-wall-wiring.ts 的记录，换成临时文件与给定视图）；返回 bridge 的处理 */
  const hit = (error = "server_overloaded", view = fresh): "track" | "escalate" => {
    now += 1000;
    const escalate = overloadEscalate(CID, now, states.get(CID), RESUME_WINDOW_MS, view, path, error);
    if (escalate) states.delete(CID);
    else states.set(CID, { errorAt: now, error });
    noteOverload(CID, AGENT, error, escalate ? "escalate" : "track", now, view, path);
    return escalate ? "escalate" : "track";
  };
  /** 60 秒后 bridge 把续跑发出去了 */
  const resumed = () => { now += 60_000; markResumed(states, CID, now); };
  const book = new AgentCallBook(null);
  const settle: CallerSettleDeps = {
    answerable: (c) => book.answerable(c, () => false), waiting: (c) => book.waiting(c, () => false), rearmResume: () => {},
    consume: (c, pac) => void book.consume(c, pac.callerChannelId, pac), pushBack: async () => {}, nudgeAmbiguous: () => {},
    takeApiErrorNotice: (c) => book.takeApiErrorNotice(c, () => false), markApiError: (c, t, caller) => book.markApiError(c, () => false, t, caller),
    clearWithheld: (c, pac) => book.clearWithheld(c, pac), notify: async () => {}, metric: () => {},
    recovered: () => void cardsToClose(f.db, AGENT, "p", now, CONFIG, path), // closeRecoveredCards 调的就是它，这里换成临时库和临时文件
  };
  /** 执行者自己的回合结束了（stop-settle.ts 的真判定：正常的 Stop 才算恢复） */
  const stop = (t: Partial<StopTurn> = {}) => {
    now += 1000;
    return settleStopTurn(settle, { cid: CID, stopChannelId: CID, stopWs: 1, candidateWs: 1, event: "Stop", drain: { text: null }, ...t });
  };
  return {
    f, path, fresh, escalations, hit, resumed, stop, scope,
    tick: async () => { now += 31_000; return sup.tick(f.db, CONFIG, deps); },
    grant: () => readOverload(path)[CID]?.grant,
    resumes: () => superviseEvents(f.db, AGENT).filter((e) => e.step === "resume").map((e) => `${e.fault}/${e.workKey}/${e.attempt}`),
    notes: () => (f.db.query("SELECT text FROM events WHERE kind = 'note'").all() as { text: string }[]).map((r) => r.text),
    /** PM 恢复了卡、执行者领了新单 B（同一会话、intentId 不同）：台账里多一张派给它的单 */
    takeOrderB: () => {
      now += 60_000;
      f.db.query("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T1'").run();
      f.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head, templateVersion,
        status, attempts, receipt, reason, createdAt, updatedAt) SELECT ?, taskId, project, node, action, recipient, causalSeq + 100, eventSeq + 100, taskRev,
        specRev, head, templateVersion, status, attempts, receipt, reason, ?, ? FROM scheduler_intents WHERE action = 'dispatch' ORDER BY eventSeq DESC LIMIT 1`)
        .run(ORDER_B, now, now);
    },
  };
}

/** 单 A 上续跑 3 次、第 4 次用完 */
function exhaust(h: Awaited<ReturnType<typeof setup>>): void {
  for (let i = 0; i < 3; i++) expect(h.hit()).toBe("track"), h.resumed();
  expect(h.hit()).toBe("escalate");
}

describe("续跑计数只在同一件活内累计", () => {
  test("[验收线 1] 单 A 续跑 3 次用完后领了单 B：旧单的「用完了」不把 B 退回人工，B 上第一次撞 overload 续跑、从第 1 次记", async () => {
    const h = await setup();
    const a = workKeyOf(h.scope()[0].work);
    exhaust(h);
    await h.tick();
    expect(h.escalations).toHaveLength(1); // A 用完：照旧报派活方一次
    expect(getWorkflow(h.f.db, "T1")?.mode).toBe("manual");
    h.takeOrderB();
    expect(workKeyOf(h.scope()[0].work)).toBe(`order:${ORDER_B}`);
    await h.tick(); // 事故就在这一轮：B 上没撞过任何错
    expect(h.escalations).toHaveLength(1);
    expect(getWorkflow(h.f.db, "T1")?.mode).toBe("auto");
    expect(h.hit()).toBe("track");
    expect(h.grant()).toMatchObject({ key: `order:${ORDER_B}@s-one`, used: 1 });
    await h.tick();
    expect(h.escalations).toHaveLength(1);
    expect(h.resumes()).toEqual([`overload/${a}/1`, `overload/${a}/2`, `overload/${a}/3`, `overload/order:${ORDER_B}/1`]);
  });

  test("[验收线 2] 领了单 B、监护视图里的 work 还是 A（刷新滞后）：按台账里已领的单数，不拿 A 的次数升级 B", async () => {
    const h = await setup();
    const stale: BridgeView = { ...h.fresh, supervised: ((list) => () => list)(h.scope()) };
    for (let i = 0; i < 3; i++) expect(h.hit("server_overloaded", stale)).toBe("track"), h.resumed();
    h.takeOrderB();
    expect(stale.supervised(0)[0].work).toMatchObject({ kind: "order", intentId: expect.not.stringMatching(ORDER_B) });
    expect(h.hit("server_overloaded", stale)).toBe("track");
    expect(h.grant()).toMatchObject({ key: `order:${ORDER_B}@s-one`, used: 1 });
    await h.tick();
    expect(h.escalations).toEqual([]);
  });

  test("[验收线 3] 同一件活续跑 2 次后回合正常结束，再撞从第 1 次数；以 API 错误结束的 Stop 不清", async () => {
    const h = await setup();
    const a = workKeyOf(h.scope()[0].work);
    expect(h.hit()).toBe("track"), h.resumed();
    expect(h.hit()).toBe("track"), h.resumed();
    await h.tick(); // 两次续跑进了台账：清零以后不能再从台账数回来
    await h.stop({ drain: { text: null, apiError: true } });
    await h.stop({ event: "StopFailure" });
    expect(h.grant()).toMatchObject({ used: 2 });
    await h.stop();
    expect(h.grant()).toMatchObject({ key: `${a}@s-one`, used: 0 });
    const after = [0, 1, 2].map(() => { const r = h.hit(); h.resumed(); return r; });
    expect([...after, h.hit()]).toEqual(["track", "track", "track", "escalate"]);
    await h.tick();
    expect(h.resumes()).toEqual([1, 2, 1, 2, 3].map((n) => `overload/${a}/${n}`));
    expect(h.escalations).toEqual([expect.stringContaining("3/3")]); // 清零以后这一串用完：照旧报
  });

  test("[验收线 3] 续跑 2 次还没进台账，回合就正常结束了：之后再撞从第 1 次记，清零前的不补进来数", async () => {
    const h = await setup();
    const a = workKeyOf(h.scope()[0].work);
    expect(h.hit()).toBe("track"), h.resumed();
    expect(h.hit()).toBe("track"), h.resumed();
    await h.stop(); // 调度服务的监护还没轮到
    expect(h.hit()).toBe("track");
    expect(h.grant()).toMatchObject({ used: 1 });
    await h.tick();
    expect(h.resumes()).toEqual([`overload/${a}/1`]);
    h.resumed();
    expect(h.hit()).toBe("track"), h.resumed();
    expect(h.hit()).toBe("track"), h.resumed();
    expect(h.hit()).toBe("escalate");
    await h.tick();
    expect(h.resumes()).toEqual([1, 2, 3].map((n) => `overload/${a}/${n}`));
    expect(h.escalations).toHaveLength(1);
  });

  test("[验收线 3] 续跑用完、还没报，人接上后回合正常结束：没有新撞错，不把旧的「用完了」翻出来退回人工", async () => {
    const h = await setup();
    exhaust(h);
    await h.stop();
    expect(h.grant()).toMatchObject({ used: 0 });
    await h.tick();
    await h.tick();
    expect(h.escalations).toEqual([]);
    expect(h.resumes()).toEqual([]);
    expect(getWorkflow(h.f.db, "T1")?.mode).toBe("auto");
    expect(h.hit()).toBe("track"); // 之后再撞：从第 1 次
    await h.tick();
    expect(h.resumes()).toHaveLength(1);
    expect(h.escalations).toEqual([]);
  });

  test("[验收线 3] 次数是 0 的升级（数不住时的兜底）之后回合正常结束：同样以清零为界，不重放", async () => {
    const h = await setup();
    const now = 10 * HOUR_MS + 500;
    noteOverload(CID, AGENT, "server_overloaded", "escalate", now, h.fresh, h.path); // 入口落盘失败按旧行为升级：没有批次数
    expect(h.grant()).toBeUndefined();
    await h.stop();
    expect(readOverload(h.path)[CID].cleared).toBeGreaterThan(now);
    await h.tick();
    expect(h.escalations).toEqual([]);
    const before = JSON.stringify(readOverload(h.path));
    await h.stop(); // 清零后没撞过：不再写盘
    expect(JSON.stringify(readOverload(h.path))).toBe(before);
  });

  test("[验收线 4] 401 续过一次、没有正常结束过，接着撞的是 overload：照第 1 次续跑，完整的 3 次都在", async () => {
    const h = await setup();
    const a = workKeyOf(h.scope()[0].work);
    expect(h.hit("authentication_failed")).toBe("track");
    expect(h.grant()).toBeUndefined(); // 登录失效不批次数
    h.resumed();
    expect(h.hit()).toBe("track");
    expect(h.grant()).toMatchObject({ used: 1 });
    expect(readOverload(h.path)[CID].auth).toBeUndefined(); // 这次不是登录失效：标记去掉
    await h.tick();
    expect(h.escalations).toEqual([]);
    expect(getWorkflow(h.f.db, "T1")?.mode).toBe("auto");
    h.resumed();
    expect(h.hit("authentication_failed")).toBe("track"); // 上一次撞的不是登录失效：这一次 401 还是续一次，不占次数
    expect(h.grant()).toMatchObject({ used: 1 });
    h.resumed();
    expect(h.hit()).toBe("track"), h.resumed();
    expect(h.hit()).toBe("track"), h.resumed();
    expect(h.hit()).toBe("escalate");
    await h.tick();
    expect(h.resumes().filter((r) => r.startsWith("overload/"))).toEqual([1, 2, 3].map((n) => `overload/${a}/${n}`));
    expect(h.escalations).toEqual([expect.stringContaining("3/3")]);
  });

  test("[验收线 4] 登录失效的续跑标记只管那件活、那个会话：单 A 上为 401 续过，领了单 B 又撞 401 不凭它升级", async () => {
    const h = await setup();
    expect(h.hit("authentication_failed")).toBe("track");
    expect(readOverload(h.path)[CID].auth).toMatchObject({ key: `${workKeyOf(h.scope()[0].work)}@s-one` });
    h.takeOrderB();
    h.resumed();
    expect(h.hit("API Error: 401")).toBe("track");
    expect(readOverload(h.path)[CID].auth).toMatchObject({ key: `order:${ORDER_B}@s-one` });
    h.resumed();
    expect(h.hit("API Error: 401")).toBe("escalate");
    expect(h.grant()).toBeUndefined();
  });

  test("[验收线 4] 入口没拿到错误码时（只给了前四个参数）：401 批出去的那一次由记录时退回，不凭 401 标记升级", async () => {
    const h = await setup();
    const t = 10 * HOUR_MS + 1000;
    expect(overloadEscalate(CID, t, undefined, RESUME_WINDOW_MS, h.fresh, h.path)).toBe(false);
    expect(h.grant()).toMatchObject({ used: 1 });
    noteOverload(CID, AGENT, "authentication_failed", "track", t, h.fresh, h.path);
    expect(h.grant()).toMatchObject({ used: 0 });
    expect(overloadEscalate(CID, t + 90_000, { resumedAt: t + 60_000 }, RESUME_WINDOW_MS, h.fresh, h.path)).toBe(false);
    expect(h.grant()).toMatchObject({ used: 1 });
  });

  test("[验收线 4] 401 / authentication_failed 不累加续跑次数，按 auth 规则报，文字里没有 overload 第 N/3 次", async () => {
    const h = await setup();
    expect(["authentication_failed", "API Error: 401", "authentication_error"].map(isAuthFailure)).toEqual([true, true, true]);
    expect(["server_overloaded", "rate_limit", "4010 tokens", ""].map(isAuthFailure)).toEqual([false, false, false, false]);
    expect(h.hit("authentication_failed")).toBe("track");
    h.resumed();
    expect(h.hit("authentication_failed")).toBe("escalate"); // 续过一次、窗口内又撞 401：同改动前，不是 3 次那条线
    expect(h.hit("authentication_failed")).toBe("track");
    expect(h.grant()).toBeUndefined();
    await h.tick();
    await h.tick();
    expect(h.escalations).toEqual([expect.stringContaining("登录失效")]);
    expect(h.escalations[0]).toContain("这类不自动处置");
    const texts = [...h.notes(), ...h.escalations].join("\n");
    expect(texts).not.toMatch(/overload|满载|第 \d+\/3 次|\d\/3 次/);
    expect(h.resumes().every((r) => r.startsWith("auth/") && r.endsWith("/0"))).toBe(true);
  });

  test("[验收线 4] 撞过 401 之后，这件活的 overload 仍有完整的 3 次", async () => {
    const h = await setup();
    expect(h.hit("authentication_failed")).toBe("track");
    h.resumed();
    await h.stop(); // 续跑接上了、回合正常结束
    exhaust(h);
    await h.tick();
    expect(h.escalations).toEqual([expect.stringContaining("模型满载 / 限流")]);
  });

  test("[验收线 5] 同一件活连续 3 次 overload，第 4 次起照旧升级，隔多久、台账里有没有别的单都一样", async () => {
    const h = await setup();
    exhaust(h);
    h.resumed();
    expect([h.hit(), h.hit(), h.hit()]).toEqual(["escalate", "escalate", "escalate"]);
    expect(overloadEscalate(CID, 30 * HOUR_MS, undefined, RESUME_WINDOW_MS, h.fresh, h.path)).toBe(true);
    expect(h.grant()).toMatchObject({ used: 3 });
    await h.tick();
    await h.tick();
    expect(h.escalations).toHaveLength(1);
  });
});
