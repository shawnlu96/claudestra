/**
 * i28-S1 监护名单、台账留痕、调度 pass 接入：
 * - 名单只收在途的调度单和回程还挂着的请求；master / 出借 worker / 别的项目 / 换了会话 / 退回人工的 / 押着没看到的请求一律不收；
 * - 留痕的记录校验、去重、次数按计数范围数；重启键锚在上一次重启认领上；
 * - supervise 关着时 pass 不调监护、不给 auto-tick 套让开那层（与改动前逐项一致）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSuperviseRecord, priorAttempts, recordSupervise, restartKey, superviseEvents, type SuperviseRecord } from "../src/lib/agent-supervisor-ledger.js";
import { HOUR_MS } from "../src/lib/agent-supervisor-policy.js";
import { CALL_STALE_MS, superviseOn, supervisedAgents, type CallRow } from "../src/lib/agent-supervisor-scope.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import type { AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CONFIG: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true, supervise: { enabled: true, stuckMin: 20 },
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/repo" } } };
const ONE: RegistryAgent = { name: "agent-task-one", channelId: "ch-one", sessionId: "s-one", projectId: "p", runtime: "claude-code" };

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0)) c(); });

const scope = (db: Parameters<typeof supervisedAgents>[0]["db"], registry: RegistryAgent[], calls: CallRow[] = [], o: Partial<Parameters<typeof supervisedAgents>[0]> = {}) =>
  supervisedAgents({ config: CONFIG, registry, db, calls, held: () => undefined, now: 10 * HOUR_MS, ...o });

describe("监护名单", () => {
  test("调度单：发出之后、交付之前在名单里；交付了、退回人工了就不在", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await toBuild(f);
    expect(scope(f.db, [ONE]).map((s) => s.agent)).toEqual([]); // build 单还没发
    await f.tick();
    const [s] = scope(f.db, [ONE]);
    expect(s).toMatchObject({ agent: "agent-task-one", sessionId: "s-one", transport: "tmux", work: { kind: "order", taskId: "T1", step: "write" } });
    expect(scope(f.db, [{ ...ONE, sessionId: "s-other" }])).toEqual([]); // 换了会话
    expect(scope(f.db, [{ ...ONE, projectId: "q" }])).toEqual([]); // 别的项目
    expect(scope(f.db, [ONE], [], { config: { ...CONFIG, projects: { p: { ...CONFIG.projects.p, supervise: false } } } })).toEqual([]);
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    expect(scope(f.db, [ONE])).toEqual([]);
  });

  test("退回人工的卡归 PM，不再监护", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    await toBuild(f);
    await f.tick();
    await f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "PM 接手");
    expect(scope(f.db, [ONE])).toEqual([]);
  });

  test("send_to_agent：送到了、没过期的请求才算；押着没看到的、过期的、master / 出借 worker 不算", () => {
    const now = 10 * HOUR_MS;
    const helper: RegistryAgent = { name: "agent-helper", channelId: "ch-h", sessionId: "s-h", projectId: "p" };
    const call = (o: Partial<CallRow>): CallRow => ({ callerChannelId: "ch-a", callerName: "agent-asker", targetName: "agent-helper", ts: now - 1000, ...o });
    expect(scope(null, [helper], [call({ requests: [{ ts: now - 500, deliveredAt: now - 400, messageId: "m1" }, { ts: now - 300, deliveredAt: now - 200 }] })]))
      .toEqual([expect.objectContaining({ agent: "agent-helper", work: { kind: "call", caller: "agent-asker", callerChannelId: "ch-a", since: now - 400 } })]);
    expect(scope(null, [helper], [call({ requests: [{ ts: now - 500, messageId: "m1" }] })], {
      held: () => [{ fromKind: "local", fromChannelId: "ch-a", messageId: "m1" }] })).toEqual([]);
    expect(scope(null, [helper], [call({ ts: now - CALL_STALE_MS - 1 })])).toEqual([]);
    for (const name of ["master", "agent-lend-0123456789"]) {
      expect(scope(null, [{ ...helper, name }], [call({ targetName: name })])).toEqual([]);
    }
  });

  test("开关：scheduler.json 没开、supervise 关、项目不在配置里都不在名单", () => {
    expect(superviseOn(CONFIG, "p")).toBe(true);
    expect(superviseOn({ ...CONFIG, enabled: false }, "p")).toBe(false);
    expect(superviseOn({ ...CONFIG, supervise: undefined }, "p")).toBe(false);
    expect(superviseOn(CONFIG, "q")).toBe(false);
    expect(superviseOn(CONFIG, undefined)).toBe(false);
  });
});

describe("台账留痕", () => {
  const rec = (o: Partial<SuperviseRecord> = {}): SuperviseRecord => ({ agent: "agent-task-one", project: "p", target: "T1", sessionId: "s-one",
    fault: "dead", faultKey: "restart:agent-task-one:after0", workKey: "order:i1", step: "restart", phase: "claim", attempt: 1, limit: 2, ...o });

  test("记录校验：未知种类 / 阶段、done 不带结果、带控制字符的一律拒", () => {
    expect(parseSuperviseRecord(rec())).toEqual(rec());
    expect(() => parseSuperviseRecord({ ...rec(), fault: "meteor" })).toThrow("fault");
    expect(() => parseSuperviseRecord({ ...rec(), phase: "maybe" })).toThrow("phase");
    expect(() => parseSuperviseRecord({ ...rec(), phase: "done" })).toThrow("result");
    expect(() => parseSuperviseRecord({ ...rec(), faultKey: "a b" })).toThrow("faultKey");
    expect(() => parseSuperviseRecord({ ...rec(), detail: "x\u0007" })).toThrow("detail");
    expect(() => parseSuperviseRecord({ ...rec(), attempt: -1 })).toThrow("attempt");
  });

  test("同一去重键第二次写是 duplicate；次数按计数范围数；重启键锚在上一次重启认领", async () => {
    const f = autoFixture();
    cleanup.push(() => f.close());
    const t0 = 10 * HOUR_MS;
    expect(restartKey(f.db, "agent-task-one")).toBe("restart:agent-task-one:after0");
    expect(recordSupervise(f.db, { actor: "scheduler", now: t0 }, rec()).duplicate).toBe(false);
    expect(recordSupervise(f.db, { actor: "scheduler", now: t0 }, rec()).duplicate).toBe(true);
    expect(restartKey(f.db, "agent-task-one")).not.toBe("restart:agent-task-one:after0");
    recordSupervise(f.db, { actor: "scheduler", now: t0 + 1 }, rec({ fault: "stuck", faultKey: restartKey(f.db, "agent-task-one"), workKey: "order:i2" }));
    recordSupervise(f.db, { actor: "scheduler", now: t0 + 2 }, rec({ fault: "cyber", step: "recover", faultKey: "ask_1" }));
    const ev = superviseEvents(f.db, "agent-task-one");
    expect(priorAttempts(ev, "dead", "order:zzz", t0 + 10)).toEqual([t0, t0 + 1]); // 重启额度：宿主死与卡住共用、按小时不分活
    expect(priorAttempts(ev, "dead", "order:zzz", t0 + HOUR_MS + 1)).toEqual([]);
    expect(priorAttempts(ev, "cyber", "order:i1", t0 + 10)).toEqual([t0 + 2]);
    expect(priorAttempts(ev, "cyber", "order:i2", t0 + 10)).toEqual([]);
  });
});

describe("调度 pass 接入", () => {
  test("supervise 关着：pass 不调监护；开着：监护先于 auto-tick 跑（让开那层见 agent-supervisor-e2e）", async () => {
    const state = mkdtempSync(join(tmpdir(), "s1-pass-"));
    const path = join(state, "ledger.sqlite"), db = openLedger(path);
    cleanup.push(() => { closeLedger(path); rmSync(state, { recursive: true, force: true }); });
    const order: string[] = [];
    const baseWorker = () => ({ manual: "x" });
    const autoDeps = () => ({ worker: baseWorker } as unknown as AutoTickDeps);
    const opts = { assertOwner: () => {}, maintenance: { path: join(state, "m.lock"), marker: join(state, "update.marker") }, autoDeps,
      supervise: async () => (order.push("supervise"), { failed: [] }) };
    const config = { ...CONFIG, projects: {} };
    await schedulerPass(db, { ...config, supervise: { enabled: false, stuckMin: 20 } }, opts);
    await schedulerPass(db, { ...config, supervise: undefined }, opts);
    expect(order).toEqual([]);
    const spy = { ...opts, autoDeps: () => { order.push("auto"); return { worker: baseWorker } as unknown as AutoTickDeps; } };
    await schedulerPass(db, config, spy);
    expect(order).toEqual(["supervise", "auto"]);
  });
});
