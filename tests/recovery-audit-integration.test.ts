/**
 * dispatch-recovery-AUD 的真实链路：临时台账上走真实写口（setWorkflow 接管、setFrozen、createFeature / initDag），取数是真实
 * collectAuditSnapshots（里面跑 MANUAL / PLAN 的原函数），规则是 auditLedger，落库 / 回执是真实巡检库；最后用真实 manager.ts 子进程
 * 演练 off → observe → on → ack → off。只读连接（--dry-run 用的 query_only）不写任何东西。不连 bridge、不发通知。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { ackFindings, openFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH, recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicy, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { SPEC_SETTLE_MS } from "../src/lib/scheduler-autostart.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { testChildEnv } from "./test-env.js";

const P = "proj-aud", T = "aud-1", PM = "agent-pm", EXEC = "agent-exec", MIN = 60_000, HOUR = 60 * MIN, N = 30 * MIN;
const KEY_PRE = `${P}|recovery_manual_stalled|${T}|`;
let db: Database, path: string, t0: number, reads: Record<string, number>;

const schedulerJson = (project = P) => ({ enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { [project]: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/aud-repo" } } });
/** CFG 的假读：modes 按键给，其余按 fallback；每次读都计数（证明每轮现读、off 不取数） */
function cfg(modes: Partial<Record<string, RecoveryMode>> = {}, fallback: RecoveryMode = "on", manualAfterMs: number | null = N): RecoveryPolicyPort {
  return (_project, key) => {
    reads[key] = (reads[key] ?? 0) + 1;
    return { mode: modes[key] ?? fallback, manualAfterMs, source: "config" } as RecoveryPolicy;
  };
}
function sources(port: RecoveryPolicyPort): SnapshotSources {
  return {
    registry: async () => [{ name: PM, channelId: "c-pm", projectId: P }], windows: async () => ["master", PM], turn: async () => "idle",
    fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(tmpdir(), "aud-no-held.json"),
    recovery: { policy: port, config: () => parseSchedulerConfig(schedulerJson()), borrow: async () => [], readSpec: () => null, drafts: () => [] },
  };
}
const mine = <X extends { rule: string }>(xs: readonly X[]) => xs.filter((x) => x.rule.startsWith("recovery_"));

/** 一轮正式巡检：取数 → 规则 → 对账落库，返回本机制的待推 / 跳过 / 还开着的 */
async function round(at: number, port: RecoveryPolicyPort, store = db) {
  const [s] = await collectAuditSnapshots(store, [P], at, sources(port));
  const r = auditLedger(s!, at, port);
  const rec = reconcileFindings(db, P, r.findings, r.evaluated, at, { keep: r.keep });
  return { pending: mine(rec.pending), skipped: mine(r.skipped), open: mine(openFindings(db, P)), evaluated: r.evaluated.filter((x) => x.startsWith("recovery_")) };
}

/** auto 卡在 build 时被 PM 接管成 manual（真实接管写口），之后没人动 */
function takeover(at = t0): void {
  let now = at;
  const ctx = (actor: string) => ({ actor, now: now++ });
  createTask(db, ctx(PM), { project: P, id: T, title: "停滞卡", kind: "code", agent: EXEC, pm: PM, branch: "feat/aud-1" });
  setWorkflow(db, ctx(PM), { taskId: T, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
  db.query("UPDATE tasks SET stage = 'build' WHERE id = ?").run(T);
  const w = getWorkflow(db, T)!;
  setWorkflow(db, ctx(PM), { taskId: T, taskRev: getTask(db, T)!.rev, workflowRev: w.rev, template: "code", templateVersion: 2, mode: "manual",
    authorFamily: "claude", fallback: w.fallback, reason: "worker 会话丢了，PM 接手" });
}

beforeEach(() => {
  path = tempLedgerPath("recovery-audit-int-");
  db = openLedger(path);
  t0 = 1_000 * HOUR;
  reads = {};
  setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => closeLedger(path));

describe("manual 停滞行动卡进正式巡检", () => {
  test("on：过了 owner 阈值推给 PM 一次，带证据和正式命令；确认后不重推；卡有了新动静就关掉", async () => {
    takeover();
    const on = cfg();
    expect((await round(t0 + N - MIN, on)).open).toEqual([]); // 没到阈值
    const first = await round(t0 + 2 * HOUR, on);
    expect(first.pending).toHaveLength(1);
    const f = first.pending[0]!;
    expect(f).toMatchObject({ rule: "recovery_manual_stalled", taskId: T, notify: PM, notifiedAt: null });
    expect(f.key.startsWith(KEY_PRE)).toBe(true);
    expect(f.detail).toContain("转人工事件");
    expect(f.suggestion).toContain(`ledger workflow-resume ${T} --rev`);
    expect(ackFindings(db, [f.key], t0 + 2 * HOUR)).toBe(1); // 投递回执
    const again = await round(t0 + 2 * HOUR + 15 * MIN, on);
    expect(again.pending).toEqual([]);
    expect(again.open.map((o) => [o.key, o.notifiedAt])).toEqual([[f.key, t0 + 2 * HOUR]]);
    expect(again.evaluated).toContain("recovery_manual_stalled"); // 推完才建基线
    appendEvent(db, { actor: PM, now: t0 + 3 * HOUR }, { project: P, target: T, kind: "note", text: "在等执行者回复" });
    const moved = await round(t0 + 3 * HOUR + MIN, on);
    expect([moved.pending, moved.open]).toEqual([[], []]);
    // 巡检只出发现：没有交回、没有改模式，卡上除了那条 note 没有新事件
    expect(getWorkflow(db, T)!.mode).toBe("manual");
    expect(listEvents(db, { target: T }).filter((e) => e.data.op === "workflow_resume")).toEqual([]);
  });

  test("off 不取数也不出；observe 落库不推；改成 on 后同一条才推", async () => {
    await round(t0, cfg()); // 没有卡的一轮：建基线
    takeover();
    const at = t0 + 2 * HOUR;
    reads = {};
    const off = await round(at, cfg({ audit: "off" }));
    expect([off.pending, off.open]).toEqual([[], []]);
    expect(off.skipped.map((s) => s.rule)).toEqual(["recovery_manual_stalled", "recovery_plan_gap"]);
    const observe = await round(at + MIN, cfg({ manualStall: "observe" }));
    expect(observe.pending).toEqual([]);
    expect(observe.open).toHaveLength(1);
    expect(observe.skipped.some((s) => s.reason.startsWith("观察中:") && s.reason.endsWith("已满阈值，observe 不推"))).toBe(true);
    const on = await round(at + 2 * MIN, cfg());
    expect(on.pending.map((p) => p.key)).toEqual(observe.open.map((o) => o.key));
    expect(reads.audit).toBeGreaterThanOrEqual(6); // 取数和规则每轮都现读 CFG，不缓存
  });

  test("owner 没设阈值：什么都不判、不推，只在 skipped 里说明", async () => {
    takeover();
    const r = await round(t0 + 100 * HOUR, cfg({}, "on", null));
    expect([r.pending, r.open]).toEqual([[], []]);
    expect(r.skipped).toContainEqual({ rule: "recovery_manual_stalled", reason: "观察中:owner 未设 manualStallHours：1 张非等待类 manual 卡只观察、不判停滞" });
  });

  test("owner 冻结的队列不算停滞：不出卡、不解冻", async () => {
    takeover();
    setFrozen(db, { actor: "owner", now: t0 + 10 }, { project: P, frozen: true, reason: "owner 冻结" });
    const r = await round(t0 + 5 * HOUR, cfg());
    expect([r.pending, r.open]).toEqual([[], []]);
    expect(listEvents(db, { project: P }).filter((e) => e.kind === "unfreeze")).toEqual([]);
  });

  test("项目不在 scheduler.json 的名单里：写明没取数，不评估", async () => {
    takeover();
    const src = sources(cfg());
    src.recovery!.config = () => parseSchedulerConfig(schedulerJson("other"));
    const [s] = await collectAuditSnapshots(db, [P], t0 + 5 * HOUR, src);
    const r = auditLedger(s!, t0 + 5 * HOUR, cfg());
    expect(mine(r.findings)).toEqual([]);
    expect(mine(r.skipped).map((x) => x.reason)).toEqual(Array(2).fill("项目不在调度服务名单（scheduler.json），没取数"));
  });
});

describe("计划不足进正式巡检", () => {
  /** 一个计划节点没有正式规格（卡在 spec 门），本机写槽空着两个 */
  function gapProject(): void {
    db.prepare("INSERT OR REPLACE INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    createFeature(db, { actor: PM, now: t0 }, { project: P, slug: "i28", title: "协作底座" });
    initDag(db, { actor: PM, now: t0 + 1 }, { id: "ab12-i28", rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a.ts"], deps: [] }] });
  }

  test("同一画面持续满阈值才推一次：先落库计时，再推，确认后不重推；observe 永远不推", async () => {
    gapProject();
    const on = cfg();
    const start = await round(t0 + MIN, on);
    expect(start.pending).toEqual([]);
    expect(start.open.map((o) => o.rule)).toEqual(["recovery_plan_gap"]);
    expect(start.skipped.some((s) => s.reason.endsWith("未满阈值，只计时"))).toBe(true);
    const key = start.open[0]!.key;
    const early = await round(t0 + MIN + N - MIN, on);
    expect(early.pending).toEqual([]);
    const due = await round(t0 + MIN + N, on);
    expect(due.pending.map((p) => [p.key, p.notify, p.taskId])).toEqual([[key, PM, null]]);
    expect(due.pending[0]!.detail).toContain("【计划不足】");
    expect(due.pending[0]!.firstSeen).toBe(t0 + MIN); // 时钟从第一次看到这幅画面起算，跨进程靠巡检库接上
    ackFindings(db, [key], t0 + MIN + N);
    expect((await round(t0 + 3 * HOUR, on)).pending).toEqual([]);
    expect((await round(t0 + 4 * HOUR, cfg({ planGap: "observe" }))).pending).toEqual([]);
  });

  test("owner 没设阈值：不落库、不推", async () => {
    gapProject();
    const r = await round(t0 + 50 * HOUR, cfg({}, "on", null));
    expect([r.pending, r.open]).toEqual([[], []]);
    expect(r.skipped.some((s) => s.rule === "recovery_plan_gap" && s.reason.includes("只观察、不提醒"))).toBe(true);
  });
});

describe("计划不足的座位匹配不被 --project 裁掉（审查 shared-capacity）", () => {
  const Q = "proj-aud-b";
  const remote = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "a/b", localPriority: "off" };
  const config = () => parseSchedulerConfig({ enabled: true, pollMs: 5000, autoDispatch: true, projects: Object.fromEntries([P, Q].map((p) =>
    [p, { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/aud-repo", remote }])) });
  let helloSeq = 0;
  /** 两个项目共借 mate 唯一的 codex 空位，本机都不写；pa 的节点缺规格，pb 的节点规格齐（qReady） */
  function shared(): void {
    db.prepare("INSERT OR REPLACE INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    setMeta(db, { actor: "owner", now: 2 }, { project: Q, key: "pms", value: [PM] });
    for (const [project, slug] of [[P, "pa"], [Q, "pb"]] as const) {
      createFeature(db, { actor: PM, now: t0 }, { project, slug, title: slug });
      initDag(db, { actor: PM, now: t0 + 1 }, { id: `ab12-${slug}`, rev: 1, nodes: [{ key: "x", oneLine: `节点 ${slug}`, fileGlobs: [`src/lib/${slug}.ts`], deps: [] }] });
    }
  }
  const hello = (at: number) => recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b", seq: ++helloSeq, paused: null,
    grant: { until: at + 24 * HOUR, roles: ["review", "write"], repos: ["a/b"], ordersPerDay: 50, ordersLeftToday: 50 },
    slots: { codex: { total: 1, busy: 0 }, claude: { total: 0, busy: 0 } } }, at);
  /** 真实取数 → 规则 → 对账；projects = 这次命令请求的项目（--project pa 或全部） */
  async function run(at: number, projects: string[], qReady: boolean) {
    hello(at);
    const src = sources(cfg());
    Object.assign(src.recovery!, { config, borrow: async () => [{ peer: "mate", projects: [P, Q], roles: ["review", "write"], maxOpen: 1 }],
      readSpec: (id: string) => (qReady && id === "pb-x" ? { mtimeMs: t0 - SPEC_SETTLE_MS - 1, text: "# 规格\n模板：code\n\n## 目标\n" } : null) });
    const out: Record<string, { open: string[]; pending: string[] }> = {};
    for (const s of await collectAuditSnapshots(db, projects, at, src)) {
      const r = auditLedger(s, at, cfg());
      const rec = reconcileFindings(db, s.project, r.findings, r.evaluated, at, { keep: r.keep });
      out[s.project] = { open: mine(openFindings(db, s.project)).map((o) => o.rule), pending: mine(rec.pending).map((o) => o.rule) };
    }
    return out;
  }

  test("pb 的就绪卡占着共享座位：只巡 pa 与全项目巡检结论一致，都不催 pa 补计划", async () => {
    shared();
    expect(await run(t0 + MIN, [P], true)).toEqual({ [P]: { open: [], pending: [] } });
    expect(await run(t0 + MIN + N, [P], true)).toEqual({ [P]: { open: [], pending: [] } }); // 跨过阈值也不出
    const all = await run(t0 + MIN + N, [P, Q], true);
    expect(all[P]).toEqual({ open: [], pending: [] });
  });

  test("对照：pb 没有就绪需求时座位确实空着，只巡 pa 照样报出来（不是把规则关了）", async () => {
    shared();
    expect((await run(t0 + MIN, [P], false))[P]!.open).toEqual(["recovery_plan_gap"]);
    expect((await run(t0 + MIN + N, [P], false))[P]!.pending).toEqual(["recovery_plan_gap"]);
  });

  test("竞争项目自己的恢复策略关着，照样算它占的座位", async () => {
    shared();
    hello(t0 + MIN);
    const src = sources((project) => ({ mode: project === Q ? "off" : "on", manualAfterMs: N, source: "config" }) as RecoveryPolicy);
    Object.assign(src.recovery!, { config, borrow: async () => [{ peer: "mate", projects: [P, Q], roles: ["review", "write"], maxOpen: 1 }],
      readSpec: (id: string) => (id === "pb-x" ? { mtimeMs: t0 - SPEC_SETTLE_MS - 1, text: "# 规格\n模板：code\n\n## 目标\n" } : null) });
    const [s] = await collectAuditSnapshots(db, [P], t0 + MIN, src);
    expect(mine(auditLedger(s!, t0 + MIN, cfg()).findings)).toEqual([]);
  });
});

describe("取数和写入之间被别人动过：陈旧快照不落库（审查 stale-reopen）", () => {
  let saved: Buffer | null;
  beforeEach(() => {
    // 命令里的规则读正式策略文件；它在本次测试的临时状态目录里（tests/preload.ts），用完原样放回
    saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [P]: { mode: "on", manualStallHours: 1 } } }));
  });
  afterEach(() => (saved === null ? rmSync(RECOVERY_POLICY_PATH, { force: true }) : writeFileSync(RECOVERY_POLICY_PATH, saved)));

  /** 真实命令入口 runLedger：取数 → 规则 → 对账写事务；over 换掉取数端口（borrow 换成 paused().hold 就停在取数中途：卡和巡检库已读完） */
  function audit(at: number, over: Partial<NonNullable<SnapshotSources["recovery"]>> = {}, ...args: string[]) {
    const src = sources(recoveryPolicy);
    Object.assign(src.recovery!, over);
    return runLedger(["audit", "--project", P, "--json", ...args], { db, actor: "owner", actorProject: P, projectIds: [P], now: () => at, auditSources: src,
      loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {} }) as Promise<Record<string, any>>;
  }
  const row = (key: string) => db.query("SELECT resolvedAt, notifiedAt FROM audit_findings WHERE key = ?").get(key) as { resolvedAt: number | null; notifiedAt: number | null };
  function paused(): { reached: Promise<void>; release(): void; hold(): Promise<never[]> } {
    let release = () => {}, hit = () => {};
    const gate = new Promise<void>((r) => { release = r; }), reached = new Promise<void>((r) => { hit = r; });
    return { reached, release, hold: async () => { hit(); await gate; return []; } };
  }

  test("慢的那次读完旧卡后停住，PM 推进、快的那次关掉已确认的提醒：慢的恢复后不重开、不重推", async () => {
    takeover();
    const at = t0 + 2 * HOUR;
    const first = await audit(at);
    const key = mine(first.pending as { rule: string; key: string }[])[0]!.key;
    expect((await audit(at, {}, "--ack", key)).acked).toBe(1);
    expect(mine((await audit(at + 15 * MIN)).pending)).toEqual([]); // 基线建好，提醒开着、已确认
    const p = paused();
    const slow = audit(at + 16 * MIN, { borrow: p.hold });
    await p.reached; // 慢的那次已读过旧卡和「开着且已确认」的发现
    appendEvent(db, { actor: PM, now: at + 16 * MIN }, { project: P, target: T, kind: "note", text: "PM 推进了" });
    const fast = await audit(at + 17 * MIN);
    expect([fast.ok, mine(fast.projects[0].open), row(key).resolvedAt]).toEqual([true, [], at + 17 * MIN]);
    p.release();
    const late = await slow;
    expect([late.ok, mine(late.pending), mine(late.projects[0].open)]).toEqual([true, [], []]);
    expect(row(key)).toEqual({ resolvedAt: at + 17 * MIN, notifiedAt: at }); // 没被重开，回执还在
    expect(mine((await audit(at + 18 * MIN)).pending)).toEqual([]);
  });

  test("没有别的巡检，只是卡在取数之后有了新动静：按旧版本算出的提醒不写、不推", async () => {
    takeover();
    const p = paused();
    const slow = audit(t0 + 2 * HOUR, { borrow: p.hold });
    await p.reached;
    appendEvent(db, { actor: PM, now: t0 + 2 * HOUR }, { project: P, target: T, kind: "note", text: "刚问过执行者" });
    p.release();
    const late = await slow;
    expect([late.ok, mine(late.pending), mine(openFindings(db, P))]).toEqual([true, [], []]);
    // 对照：没人动卡的同一条路径照常推一次（复核没有把规则关掉）
    const next = await audit(t0 + 4 * HOUR);
    expect(mine(next.pending as { rule: string }[]).map((f) => f.rule)).toEqual(["recovery_manual_stalled"]);
  });

  test("计划画面在取数之后变了（规格到位）：旧画面的计时行不写；没变就照常落库", async () => {
    db.prepare("INSERT OR REPLACE INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    createFeature(db, { actor: PM, now: t0 }, { project: P, slug: "i28", title: "协作底座" });
    initDag(db, { actor: PM, now: t0 + 1 }, { id: "ab12-i28", rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a.ts"], deps: [] }] });
    expect(mine((await audit(t0 + MIN)).projects[0].open).map((o: { rule: string }) => o.rule)).toEqual(["recovery_plan_gap"]); // 画面没变：照常落库计时
    db.query("DELETE FROM audit_findings").run();
    db.query("DELETE FROM audit_baseline").run();
    // 画面在快照之后变：readSpec 第一次（取数）答没有，之后（写事务里复核）答已到位
    let reads = 0;
    const flip = () => (reads++ === 0 ? null : { mtimeMs: t0 - SPEC_SETTLE_MS - 1, text: "# 规格\n模板：code\n\n## 目标\n" });
    const moved = await audit(t0 + 2 * MIN, { readSpec: flip });
    expect([moved.ok, mine(moved.projects[0].open), reads >= 2]).toEqual([true, [], true]);
  });
});

describe("只读连接", () => {
  const readOnly = () => {
    const ro = new Database(path, { readwrite: true, create: false });
    ro.exec("PRAGMA query_only = ON");
    return ro;
  };

  test("--dry-run 用的 query_only 连接：取数照跑，一行不写", async () => {
    takeover();
    const before = (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const ro = readOnly();
    try {
      const [s] = await collectAuditSnapshots(ro, [P], t0 + 2 * HOUR, sources(cfg()));
      expect(mine(auditLedger(s!, t0 + 2 * HOUR, cfg()).findings).map((f) => f.rule)).toEqual(["recovery_manual_stalled"]);
    } finally { ro.close(); }
    expect((db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(before);
    expect(openFindings(db, P)).toEqual([]);
  });

  test("现状钉住：调度服务的只读连接上 recordObserved 写不进去（本机接管的 observe 因此不默认接线）", () => {
    const ro = readOnly();
    try {
      expect(() => recordObserved(ro, { project: P, mechanism: "localFallback", target: T, actionKey: "takeover:act:r0:s1:gate", action: "本机接管" }, t0)).toThrow();
    } finally { ro.close(); }
    expect(listEvents(db, { project: P }).filter((e) => e.data.op === "recovery_observe")).toEqual([]);
  });
});

describe("真实 CLI 演练（manager.ts 子进程，独立状态目录）", () => {
  test("缺配置 observe → owner 设阈值 → on 推一次 → ack 回执 → 不重推 → off 留着不推", async () => {
    const state = mkdtempSync(join(tmpdir(), "recovery-audit-cli-"));
    mkdirSync(join(state, "run"), { recursive: true });
    writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: P, name: "AUD", dirs: [state] }] }));
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "s", agents: { [PM]: { channelId: "111", projectId: P } } }));
    writeFileSync(join(state, "scheduler.json"), JSON.stringify(schedulerJson()));
    closeLedger(path);
    path = join(state, "ledger.sqlite");
    db = openLedger(path);
    setMeta(db, { actor: "owner", now: 1 }, { project: P, key: "pms", value: [PM] });
    takeover(Date.now() - 3 * HOUR);
    const cli = async (...args: string[]): Promise<Record<string, any>> => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "ledger", ...args],
        { env: testChildEnv({ CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") }), stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
    };
    const audit = async (...args: string[]) => {
      const r = await cli("audit", "--project", P, "--json", ...args);
      expect(r.ok).toBe(true);
      const p = r.projects[0] as { open: { rule: string; key: string }[]; skipped: { rule: string; reason: string }[] };
      return { pending: mine((r.pending ?? []) as { rule: string; key: string; notify: string }[]), open: mine(p.open), skipped: mine(p.skipped) };
    };
    const events = () => (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

    // 没有 recovery-policy.json：observe，阈值没设 → 不判、不推
    const unset = await audit();
    expect([unset.pending, unset.open]).toEqual([[], []]);
    expect(unset.skipped.some((s) => s.rule === "recovery_manual_stalled" && s.reason.includes("owner 未设 manualStallHours"))).toBe(true);

    // owner 设阈值（1 小时），模式还是缺省 observe：看得到「已满阈值，observe 不推」，没有待推
    expect(await cli("scheduler-recovery", P, "--manual-stall-hours", "1", "--reason", "演练")).toMatchObject({ ok: true, changed: true });
    const observe = await audit();
    expect(observe.pending).toEqual([]);
    expect(observe.skipped.some((s) => s.reason.endsWith("已满阈值，observe 不推"))).toBe(true);

    // observe 的那条已落库（没推过）；--dry-run 算得出同一条，但一行不写
    const before = [events(), mine(openFindings(db, P))] as const;
    expect(before[1].map((o) => [o.rule, o.notifiedAt, o.queuedAs])).toEqual([["recovery_manual_stalled", null, null]]);
    expect((await audit("--dry-run")).open.map((o) => o.rule)).toEqual(["recovery_manual_stalled"]);
    expect([events(), mine(openFindings(db, P))]).toEqual([...before]);

    // on：推给 PM 一次
    expect(await cli("scheduler-recovery", P, "on", "--reason", "演练 on")).toMatchObject({ ok: true, changed: true });
    const on = await audit();
    expect(on.pending.map((p) => [p.rule, p.notify])).toEqual([["recovery_manual_stalled", PM]]);
    const key = on.pending[0]!.key;
    expect(await cli("audit", "--ack", key)).toMatchObject({ ok: true, acked: 1 });
    const again = await audit();
    expect(again.pending).toEqual([]);
    expect(again.open.map((o) => o.key)).toEqual([key]);

    // off（只关总开关 audit）：不评估，开着的那条留着、不推
    expect(await cli("scheduler-recovery", P, "off", "--key", "audit", "--reason", "演练 off")).toMatchObject({ ok: true, changed: true });
    const off = await audit();
    expect(off.pending).toEqual([]);
    expect(off.open.map((o) => o.key)).toEqual([key]);
    expect(off.skipped.filter((s) => s.reason.includes("为 off 或读不了")).map((s) => s.rule)).toEqual(["recovery_manual_stalled", "recovery_plan_gap"]);
    // 全程卡没被交回、没被改模式
    expect(getWorkflow(db, T)!.mode).toBe("manual");
  }, 120_000);
});
