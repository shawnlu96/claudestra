/**
 * dispatch-recovery-AUD 的真实链路：临时台账上走真实写口（setWorkflow 接管、setFrozen、createFeature / initDag），取数是真实
 * collectAuditSnapshots（里面跑 MANUAL / PLAN 的原函数），规则是 auditLedger，落库 / 回执是真实巡检库；最后用真实 manager.ts 子进程
 * 演练 off → observe → on → ack → off。只读连接（--dry-run 用的 query_only）不写任何东西。不连 bridge、不发通知。
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { recordObserved, type RecoveryMode, type RecoveryPolicy, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
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
