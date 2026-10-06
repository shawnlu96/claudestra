/**
 * dispatch-recovery-MAN1 on a real temp ledger through the formal entries: `ledger workflow-set`, `ledger scheduler-fallback-manual`,
 * the patrol (collectAuditSnapshots → auditLedger → reconcileFindings). A missing / unknown reason refuses the whole write (no pool,
 * intent or workflow change); the patrol only reports, and every scenario ends with zero actions on intents, workflow or events.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { auditLedger, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import type { Database } from "bun:sqlite";
import { autoFixture } from "./scheduler-auto-helpers.js";

const MIN = 60_000;
type F = ReturnType<typeof autoFixture>;

const projectSeq = (db: Database) => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
const wfRow = (db: Database) => db.query("SELECT mode, rev FROM task_workflows WHERE taskId = 'T1'").get() as { mode: string; rev: number };
/** Everything an action would change: intents, claimed resources, the workflow row and the event log. */
const state = (db: Database) => ({
  intents: db.query("SELECT id, status FROM scheduler_intents ORDER BY id").all(),
  resources: db.query("SELECT resource, intentId FROM scheduler_resources ORDER BY resource").all(),
  workflow: wfRow(db),
  events: projectSeq(db),
});

async function pending(f: F): Promise<void> {
  const r = await f.cli("scheduler", "scheduler-plan", "T1", "--id", "k:write", "--rev", String(f.task().rev), "--workflow-rev", String(wfRow(f.db).rev),
    "--seq", String(projectSeq(f.db)), "--node", "write", "--action", "dispatch", "--reason", "开工", "--resources", "task:t1");
  expect(r).toMatchObject({ ok: true });
}

const wfSet = (f: F, extra: string[], rev = f.task().rev) => f.cli("pm", "workflow-set", "T1", "--rev", String(rev), "--workflow-rev", String(wfRow(f.db).rev),
  "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", ...extra);

const sources = (dir: string): SnapshotSources => ({
  registry: async () => [], windows: async () => ["master"], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held-messages.json"),
});
/** The formal patrol entry (`ledger audit`): snapshots → auditLedger with CFG's file-backed policy port → reconcile. */
const auditCli = async (f: F) => {
  const r = await f.cliWith({ auditSources: sources(f.dir) }, "owner", "audit", "--project", "p", "--json") as Record<string, any>;
  expect(r).toMatchObject({ ok: true });
  return r.projects[0] as { open: { rule: string; taskId: string }[]; skipped: { rule: string; reason: string }[] };
};
const audit = async (db: Database, dir: string, now: number, over: Partial<AuditSnapshot> = {}) => {
  const [snap] = await collectAuditSnapshots(db, ["p"], now, sources(dir));
  return auditLedger({ ...snap, ...over }, now);
};
const manualFindings = (r: Awaited<ReturnType<typeof audit>>) => r.findings.filter((x) => x.rule.startsWith("manual_"));

describe("workflow-set: entering manual needs a recognised reason; refusal writes nothing", () => {
  test("no reason / unknown reason / unknown code / code without text / stale rev (CAS) are refused with zero side effects", async () => {
    const f = autoFixture();
    try {
      await pending(f);
      const before = state(f.db);
      expect(await wfSet(f, [])).toMatchObject({ ok: false, error: expect.stringContaining("要带 --reason") });
      expect(await wfSet(f, ["--reason", "随便"])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("manual 理由不认识") });
      expect(await wfSet(f, ["--reason", "foo: bar"])).toMatchObject({ ok: false, code: "invalid" });
      expect(await wfSet(f, ["--reason-code", "bogus", "--reason", "依赖 T0"])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("理由码不认识") });
      expect(await wfSet(f, ["--reason", "deps_not_live: 等 T0；事件：#99999"])).toMatchObject({ ok: false, error: expect.stringContaining("#99999") });
      expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", "等 T0"], f.task().rev + 7)).toMatchObject({ ok: false, code: "conflict" });
      expect(state(f.db)).toEqual(before);
      expect(before.intents).toEqual([{ id: "k:write", status: "pending" }]);
    } finally { f.close(); }
  });

  test("a first configuration straight into manual is a new manual write: no / unknown reason refused, nothing written", async () => {
    const f = autoFixture();
    try {
      createTask(f.db, f.at("owner"), { project: "p", id: "NEW", title: "新卡", kind: "code" });
      const set = (...extra: string[]) => f.cli("pm", "workflow-set", "NEW", "--rev", "1", "--template", "code", "--version", "2", "--mode", "manual",
        "--author-family", "claude", "--fallback", "人工", ...extra);
      const row = () => f.db.query("SELECT mode, rev FROM task_workflows WHERE taskId = 'NEW'").get();
      const seq = projectSeq(f.db);
      expect(await set()).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("进入 manual 要带理由") });
      expect(await set("--reason", "随便")).toMatchObject({ ok: false, code: "invalid" });
      expect(await set("--reason", "bogus_code: owner 等待")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("理由码不认识：bogus_code") });
      expect(await set("--reason-code", "bogus", "--reason", "owner 等待")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("理由码不认识") });
      expect([row(), projectSeq(f.db)]).toEqual([null, seq]);
      expect(await set("--reason", "pm_takeover: PM 亲自推进；解除：PM 交回")).toMatchObject({ ok: true });
      expect(row()).toEqual({ mode: "manual", rev: 1 });
      expect(listEvents(f.db, { project: "p", target: "NEW" }).at(-1)!.data).toMatchObject({ op: "workflow", mode: "manual",
        manualReason: { code: "pm_takeover", text: "PM 亲自推进", release: "PM 交回", approval: false } });
    } finally { f.close(); }
  });

  test("an explicit unknown code is refused even when its text has known keywords (no keyword fallback)", async () => {
    const f = autoFixture();
    try {
      await pending(f);
      const before = state(f.db);
      expect(await wfSet(f, ["--reason", "bogus_code: owner 等待"])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("理由码不认识：bogus_code") });
      expect(await wfSet(f, ["--reason", "xyz：依赖 T0"])).toMatchObject({ ok: false, code: "invalid" });
      expect(await f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "bogus_code: owner 等待", "--intent", "k:write"))
        .toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("理由码不认识：bogus_code") });
      expect(await f.cli("pm", "scheduler-fallback-manual", "T1", "--reason", "nope：PM 接管")).toMatchObject({ ok: false, code: "invalid" });
      expect(state(f.db)).toEqual(before);
      expect(wfRow(f.db)).toMatchObject({ mode: "auto" });
    } finally { f.close(); }
  });

  test("a coded reason is recorded with blocking event and release condition, and is not an approval", async () => {
    const f = autoFixture();
    try {
      await pending(f);
      const last = projectSeq(f.db);
      expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", "等 T0 上线；解除：T0 live"])).toMatchObject({ ok: true });
      const e = listEvents(f.db, { project: "p", target: "T1" }).at(-1)!;
      expect(e.data).toMatchObject({ op: "workflow", mode: "manual", takeover: "等 T0 上线；解除：T0 live", cancelledIntents: ["k:write"],
        manualReason: { v: 1, code: "deps_not_live", text: "等 T0 上线", release: "T0 live", approval: false, specRev: 1, blocking: { seq: last } } });
      // a hold on top must classify too; a legacy free-text hold that the fixed table knows is accepted
      expect(await wfSet(f, ["--reason", "随便"])).toMatchObject({ ok: false, code: "invalid" });
      expect(await wfSet(f, ["--reason", "owner 要亲自盯"])).toMatchObject({ ok: true });
      expect(listEvents(f.db, { project: "p", target: "T1" }).at(-1)!.data).toMatchObject({ hold: "owner 要亲自盯", manualReason: { code: "owner_hold" } });
    } finally { f.close(); }
  });
});

describe("system fallback: classified before any pool / intent / workflow write", () => {
  test("unknown reason refused with zero side effects; a fixed caller sentence and a planner code are recorded", async () => {
    const f = autoFixture();
    try {
      await pending(f);
      const before = state(f.db);
      expect(await f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "随便写写", "--intent", "k:write"))
        .toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("manual 理由不认识") });
      expect(await f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "   ")).toMatchObject({ ok: false });
      expect(state(f.db)).toEqual(before);
      expect(await f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "merge_retry_requires_pm：合并意图 i1 已取消，先由 PM 核对外部结果",
        "--intent", "k:write")).toMatchObject({ ok: true });
      expect(listEvents(f.db, { project: "p", target: "T1" }).at(-1)!.data).toMatchObject({ op: "fallback_manual", cancelledIntents: ["k:write"],
        manualReason: { code: "merge_unknown", approval: false } });
    } finally { f.close(); }
    const g = autoFixture();
    try {
      expect(await g.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", "Pi 会话没有已核实的模型家族配对，不自动派")).toMatchObject({ ok: true });
      expect(listEvents(g.db, { project: "p", target: "T1" }).at(-1)!.data).toMatchObject({ manualReason: { code: "runtime_unavailable" } });
    } finally { g.close(); }
  });
});

describe("patrol: observe reports once, off is silent, nothing ever acts", () => {
  test("deps planned / CI green → no report; live → one would-resume, deduped across ticks and a restart; zero actions", async () => {
    const f = autoFixture();
    try {
      const owner = f.at("owner");
      createTask(f.db, owner, { project: "p", id: "T0", title: "前置", kind: "code" });
      addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
      expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", "等 T0 上线"])).toMatchObject({ ok: true });
      const t0 = 10_000;
      expect(manualFindings(await audit(f.db, f.dir, t0))).toEqual([]); // T0 only planned
      for (const [from, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"]] as const) {
        moveStage(f.db, f.at("owner"), { taskId: "T0", from, to });
      }
      expect(manualFindings(await audit(f.db, f.dir, t0))).toEqual([]); // CI green / in merge is not live
      moveStage(f.db, f.at("owner"), { taskId: "T0", from: "merge", to: "live" });
      const before = state(f.db);
      const r1 = await audit(f.db, f.dir, t0);
      expect(manualFindings(r1)).toEqual([expect.objectContaining({ rule: "manual_would_resume", taskId: "T1",
        detail: expect.stringContaining("本巡检不执行恢复") })]);
      expect(r1.evaluated).toContain("manual_would_resume");
      const first = reconcileFindings(f.db, "p", r1.findings, r1.evaluated, t0);
      expect(first.opened.filter((k) => k.includes("manual_would_resume"))).toHaveLength(1);
      for (let i = 1; i <= 3; i++) { // repeated ticks
        const r = await audit(f.db, f.dir, t0 + i * MIN);
        expect(reconcileFindings(f.db, "p", r.findings, r.evaluated, t0 + i * MIN).opened).toEqual([]);
      }
      closeLedger(join(f.dir, "ledger.sqlite")); // restart
      const db2 = openLedger(join(f.dir, "ledger.sqlite"));
      const r2 = await audit(db2, f.dir, t0 + 10 * MIN);
      expect(reconcileFindings(db2, "p", r2.findings, r2.evaluated, t0 + 10 * MIN).opened).toEqual([]);
      expect(state(db2)).toEqual(before);
      expect(wfRow(db2)).toMatchObject({ mode: "manual" });
      closeLedger(join(f.dir, "ledger.sqlite"));
    } finally { f.close(); }
  });

  test("formal CFG policy via `ledger scheduler-recovery` + `ledger audit`: off and an unreadable policy file report nothing; default observe reports", async () => {
    // RECOVERY_POLICY_PATH sits in the test run's temp state dir (tests/preload.ts), never the real one
    expect(RECOVERY_POLICY_PATH.startsWith(join(homedir(), ".claude-orchestrator"))).toBe(false);
    // the state dir is shared by the whole run: keep the exact bytes (or absence) of whatever policy file is there and put them back
    const saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
    const f = autoFixture();
    try {
      createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "前置", kind: "code" });
      addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
      expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", "等 T0 上线"])).toMatchObject({ ok: true });
      for (const [from, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"], ["merge", "live"]] as const) {
        moveStage(f.db, f.at("owner"), { taskId: "T0", from, to });
      }
      expect(await f.cli("pm", "scheduler-recovery", "p", "off", "--key", "manualStall", "--reason", "MAN1 负例：恢复观察关")).toMatchObject({ ok: true, changed: true });
      const before = state(f.db);
      const would = (o: Awaited<ReturnType<typeof auditCli>>) => o.open.filter((x) => x.rule === "manual_would_resume");
      const skippedOff = { rule: "manual_would_resume", reason: expect.stringContaining("manual 恢复观察为 off") };
      for (let i = 0; i < 2; i++) { // repeated ticks under off
        const off = await auditCli(f);
        expect(would(off)).toEqual([]);
        expect(off.skipped).toContainEqual(skippedOff);
      }
      writeFileSync(RECOVERY_POLICY_PATH, "{ not json"); // 失读: CFG answers off
      const broken = await auditCli(f);
      expect(would(broken)).toEqual([]);
      expect(broken.skipped).toContainEqual(skippedOff);
      expect(state(f.db)).toEqual(before);
      rmSync(RECOVERY_POLICY_PATH, { force: true }); // absent = default observe: the same formal path now reports, once
      expect(would(await auditCli(f))).toEqual([expect.objectContaining({ taskId: "T1" })]);
      expect(would(await auditCli(f))).toHaveLength(1);
      expect(state(f.db)).toEqual(before);
      expect(wfRow(f.db)).toMatchObject({ mode: "manual" });
    } finally {
      if (saved === null) rmSync(RECOVERY_POLICY_PATH, { force: true });
      else writeFileSync(RECOVERY_POLICY_PATH, saved);
      f.close();
    }
  });

  test("a sticky reason (owner hold) and an unknown merge never report would-resume, whatever else is clear", async () => {
    const f = autoFixture();
    try {
      expect(await wfSet(f, ["--reason-code", "owner_hold", "--reason", "owner 拍板前不动"])).toMatchObject({ ok: true });
      const r = await audit(f.db, f.dir, 10_000);
      expect(manualFindings(r)).toEqual([]);
      const unknown = await audit(f.db, f.dir, 10_000, { mergeUnknown: [{ intentId: "m1", taskId: "T1", reason: "x", since: 1 }] });
      expect(manualFindings(unknown)).toEqual([]);
    } finally { f.close(); }
  });

  test("an old manual without a reason: one audit alarm after 30 minutes, nothing else changes", async () => {
    const f = autoFixture();
    try {
      // a pre-MAN1 takeover with no reason recorded (synthesised in this temp ledger only)
      const ts = 5_000;
      f.db.query("UPDATE task_workflows SET mode = 'manual', rev = rev + 1 WHERE taskId = 'T1'").run();
      insertEvent(f.db, { actor: "pm", now: ts }, { project: "p", target: "T1", kind: "scheduler", text: "流程设为 manual",
        data: { op: "workflow", mode: "manual", template: "code", templateVersion: 2 } }, false);
      const before = state(f.db);
      expect(manualFindings(await audit(f.db, f.dir, ts + 29 * MIN))).toEqual([]);
      const r = await audit(f.db, f.dir, ts + 31 * MIN);
      expect(manualFindings(r)).toEqual([expect.objectContaining({ rule: "manual_reason_missing", taskId: "T1",
        detail: expect.stringMatching(/理由：（空）；解除节点：PM 补理由；证据缺口：进入 manual 时没记理由（只报警，不改模式、不派单）/),
        suggestion: expect.stringContaining("--reason") })]);
      expect(r.findings.some((x) => /token|secret|password/i.test(x.detail))).toBe(false);
      const once = reconcileFindings(f.db, "p", r.findings, r.evaluated, ts + 31 * MIN);
      const again = await audit(f.db, f.dir, ts + 40 * MIN);
      expect(reconcileFindings(f.db, "p", again.findings, again.evaluated, ts + 40 * MIN).opened).toEqual([]);
      expect(once.opened.some((k) => k.includes("manual_reason_missing"))).toBe(true);
      expect(state(f.db)).toEqual(before);
    } finally { f.close(); }
  });
});
