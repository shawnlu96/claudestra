import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { auditLedger, type AuditResult } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { reconcileFindings } from "../src/lib/ledger-audit-store.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const H = 3_600_000, NOW = 100 * H, P = "p";
let db: Database, path: string;
beforeEach(() => {
  path = tempLedgerPath("audit-stall-"); db = openLedger(path);
  db.run("INSERT INTO ledger_instance VALUES ('origin', 'ab12')");
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm-dispatch", "agent-pm"] });
});
afterEach(() => closeLedger(path));
const sources = (): SnapshotSources => ({ registry: async () => [], windows: async () => [], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dirname(path), "held.json") });
const policy = (mode: RecoveryMode | "throw"): RecoveryPolicyPort => (_p, key) => {
  if (mode === "throw") throw new Error("unreadable");
  return { mode: key === "auditStall" ? mode : "off", manualAfterMs: null, source: "config" };
};
function card(at = NOW - 12 * H - 60_000, mode: "manual" | "auto" | null = "manual") {
  createTask(db, { actor: "owner", now: at - 1 }, { project: P, id: "B", title: "B", kind: "code" });
  if (mode) setWorkflow(db, { actor: "owner", now: at }, { taskId: "B", taskRev: getTask(db, "B")!.rev,
    template: "code", templateVersion: 2, mode, authorFamily: "claude", fallback: "x", reason: "owner_hold: 等推进" });
  for (const [from, to] of [["spec", "restate"], ["restate", "build"], ["build", "review"]] as const)
    moveStage(db, { actor: "owner", now: at }, { taskId: "B", from, to });
  return listEvents(db, { project: P }).at(-1)!;
}
async function run(mode: RecoveryMode | "throw" = "on", now = NOW) {
  const [s] = await collectAuditSnapshots(db, [P], now, sources());
  return auditLedger(s!, now, policy(mode));
}
const mine = (r: AuditResult) => r.findings.filter((f) => f.rule === "manual_stalled");

test("[验收线 1] manual review 停满 12 小时报一条给 PM，包含最后进展 seq", async () => {
  const e = card(); const r = await run();
  expect(mine(r)).toHaveLength(1);
  expect(mine(r)[0]).toMatchObject({ taskId: "B", notify: "agent-pm", since: e.ts });
  for (const text of ["B", "review", new Date(e.ts).toISOString().slice(0, 16), e.kind, String(e.seq)]) expect(mine(r)[0]!.detail).toContain(text);
});
test("[验收线 1] 未满门槛、auto、无流程不报", async () => {
  card(NOW - 12 * H + 60_000); expect(mine(await run())).toEqual([]);
});
test.each(["auto", null] as const)("[验收线 1] 流程 %s 不报", async (mode) => { card(undefined, mode); expect(mine(await run())).toEqual([]); });
test("[验收线 1] 噪音不重置，PM note 重置并换 key", async () => {
  card(); const first = mine(await run())[0]!.key;
  for (const [kind, data] of [["note", { op: "merge_pm_wait" }], ["ask", {}], ["memory", {}], ["scheduler", { op: "memory_rank" }]] as const) {
    db.run("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', ?, 'B', ?, '', ?)", [NOW - 1, P, kind, JSON.stringify(data)]);
  }
  expect(mine(await run())[0]!.key).toBe(first);
  appendEvent(db, { actor: "agent-pm", now: NOW }, { project: P, target: "B", kind: "note", text: "在等审查" });
  expect(mine(await run())).toEqual([]);
  expect(mine(await run("on", NOW + 12 * H))[0]!.key).not.toBe(first);
});
test("[验收线 2] 同段停滞 ack 后不重推；新进展后再次推", async () => {
  const reconcile = async (mode: RecoveryMode, now = NOW) => {
    const r = await run(mode, now); return reconcileFindings(db, P, r.findings, r.evaluated, now, { keep: r.keep });
  };
  await reconcile("observe"); card();
  const first = await reconcile("on");
  expect(first.opened.filter((k) => k.includes("|manual_stalled|"))).toHaveLength(1);
  const key = first.pending.find((f) => f.rule === "manual_stalled")!.key;
  db.run("UPDATE audit_findings SET notifiedAt = ? WHERE key = ?", [NOW, key]);
  expect((await reconcile("on")).pending.filter((f) => f.rule === "manual_stalled")).toEqual([]);
  appendEvent(db, { actor: "owner", now: NOW }, { project: P, target: "B", kind: "note", text: "推进" });
  await reconcile("on");
  expect((await reconcile("on", NOW + 12 * H)).pending.filter((f) => f.rule === "manual_stalled")).toHaveLength(1);
});

import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { readStallAudit, type StallReadSources } from "../src/lib/ledger-audit-stall-read.js";
import { STALL_RULES, isStallProgress, MANUAL_STALL_AUDIT_MS, LOCK_BLOCKER_STALL_MS, STALL_IGNORED_SCHEDULER_OPS } from "../src/lib/ledger-audit-stall.js";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import { lockYieldWrite } from "../src/lib/scheduler-lock-yield-write.js";
import { addDep, removeDep } from "../src/lib/ledger-deps-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { setFrozen } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS, recoveryPolicy } from "../src/lib/recovery-policy.js";

const blockers = (r: AuditResult) => r.findings.filter((f) => f.rule === "lock_blocker_stalled");
function feature(nodes = [{ key: "X", fileGlobs: ["src/bridge.ts"], deps: [] as string[] }]) {
  db.run("INSERT OR IGNORE INTO ledger_instance VALUES ('origin', 'ab12')");
  createFeature(db, { actor: "owner", now: 1 }, { project: P, slug: "f", title: "f" });
  initDag(db, { actor: "owner", now: 1 }, { id: "ab12-f", rev: 1, nodes: nodes.map((n) => ({ ...n, oneLine: n.key })) });
}
function lock() {
  db.run("UPDATE tasks SET extra = ? WHERE id = 'B'", [JSON.stringify({ fileGlobs: ["src/**"] })]);
  db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('i-B', 'B', 'p', 'write', 'dispatch', 0, 1, 1, 2, 'done', 'w', 1, 1)`);
  db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/bridge.ts', 'B', 'i-B', 1, 'card')");
}
async function blockedRun(mode: RecoveryMode | "throw" = "on", now = NOW, specExists: (path: string) => boolean = () => true) {
  const src: SnapshotSources & StallReadSources = { ...sources(), stallSpecExists: specExists };
  const [s] = await collectAuditSnapshots(db, [P], now, src);
  return auditLedger(s!, now, policy(mode));
}
test("[验收线 3] 卡级锁挡 X、Y 聚成一条；实际锁只挡相交文件", async () => {
  card(NOW - 4 * H - 60_000, "auto"); lock();
  feature(["X", "Y", "Z"].map((key) => ({ key, deps: [], fileGlobs: [key === "Z" ? "src/other.ts" : "src/bridge.ts"] })));
  const paths: string[] = [], r = await blockedRun("on", NOW, (p) => { paths.push(p); return true; });
  expect(blockers(r)).toHaveLength(1);
  const f = blockers(r)[0]!;
  expect(f.taskId).toBe("B");
  for (const t of ["B", "review", "ab12-f/X", "ab12-f/Y", "src/bridge.ts", "1970-"]) expect(f.detail).toContain(t);
  expect(f.detail).not.toContain("ab12-f/Z");
  expect(paths.every((p) => p.endsWith(".md"))).toBe(true);
  expect(mine(r)).toEqual([]);
});
test("[验收线 3] 不满四小时、无正式规格不报", async () => {
  card(NOW - 4 * H + 60_000); lock(); feature();
  expect(blockers(await blockedRun())).toEqual([]);
  expect(blockers(await blockedRun("on", NOW + 2 * H, () => false))).toEqual([]);
});
test("[验收线 3] 依赖没满足与同轮 startNow 计划节点不是挡路卡", async () => {
  feature([{ key: "D", fileGlobs: ["docs/d.md"], deps: [] }, { key: "X", fileGlobs: ["src/bridge.ts"], deps: ["D"] }]);
  card(); lock(); expect(blockers(await blockedRun())).toEqual([]);
});
test("[验收线 3] 只有同轮计划节点文件相交不报", async () => {
  feature(["X", "Y"].map((key) => ({ key, fileGlobs: ["src/bridge.ts"], deps: [] })));
  expect(featureLanes(db, getFeature(db, "ab12-f")!)!.waiting).toMatchObject([{ key: "Y", why: "files", on: ["X"] }]);
  expect(blockers(await blockedRun())).toEqual([]);
});
test("[验收线 3] 图内 key 换成卡号；无锁用节点范围", async () => {
  card(); feature([{ key: "D", fileGlobs: ["src/**"], deps: [] }, { key: "X", fileGlobs: ["src/bridge.ts"], deps: [] }]);
  const f = getFeature(db, "ab12-f")!;
  bindNode(db, { actor: "owner", now: 1 }, { id: f.id, rev: f.rev, key: "D", taskId: "B" });
  expect(blockers(await blockedRun())).toHaveLength(1);
  expect(blockers(await blockedRun())[0]!.taskId).toBe("B");
});
test("[验收线 3] 图外没锁按 extra 范围；正式让锁后不报", async () => {
  card(); lock(); feature();
  db.run("DELETE FROM scheduler_resources");
  expect(blockers(await blockedRun())).toHaveLength(1);
  db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/bridge.ts', 'B', 'i-B', 1, 'card')");
  db.run("UPDATE tasks SET stage = 'blocked', stageBefore = 'review' WHERE id = 'B'");
  const since = NOW - 5 * H;
  insertEvent(db, { actor: "owner", now: since }, { project: P, target: "B", kind: "stage", data: { from: "review", to: "blocked" } }, false);
  const on: RecoveryPolicyPort = () => ({ mode: "on", manualAfterMs: null, source: "config" });
  expect(lockYieldWrite(db, { actor: "scheduler", now: NOW }, "B",
    { v: 1, phase: "yield", basis: "blocked", since, resources: ["src/bridge.ts"], recentMs: 600_000 }, on, new Map())).toMatchObject({ released: ["src/bridge.ts"] });
  expect(blockers(await blockedRun())).toEqual([]);
});
test("[验收线 3] 挡路卡任何阶段都可报，同卡可同时报两条", async () => {
  card(); lock(); feature();
  const r = await blockedRun();
  expect(STALL_RULES.every((rule) => r.findings.some((f) => f.rule === rule))).toBe(true);
  db.run("UPDATE tasks SET stage = 'done' WHERE id = 'B'");
  expect(blockers(await blockedRun())).toHaveLength(1);
});

test.each(["spec", "verified", "done", "cancelled"])("[验收线 1] 阶段 %s 排除", async (stage) => {
  card(); db.run("UPDATE tasks SET stage = ? WHERE id = 'B'", [stage]); expect(mine(await run())).toEqual([]);
});
test("[验收线 1] 依赖未满足、冻结的 merge 卡排除", async () => {
  card(); createTask(db, { actor: "owner", now: 1 }, { project: P, id: "A", title: "A", kind: "code" });
  addDep(db, { actor: "owner", now: 1 }, { from: "A", to: "B", kind: "blocks", when: "A 上线后" });
  expect(mine(await run())).toEqual([]);
  removeDep(db, { actor: "owner", now: 1 }, { from: "A", to: "B" }); db.run("UPDATE tasks SET stage = 'merge' WHERE id = 'B'");
  setFrozen(db, { actor: "owner", now: 1 }, { project: P, frozen: true, reason: "等部署" });
  expect(mine(await run())).toEqual([]);
});
function heartbeat(at: number) {
  db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs, leaseUntil,
    createdBy, createdAt, updatedAt, beatAt, beat) VALUES ('o1', 'B', 'p', 'peer', 'claude', 'write', 1, 0, 'h', 'o/r', '{}', '', '', 'claimed', 600000, ?,
    'owner', 1, ?, ?, ?)`, [NOW + H, NOW, NOW, JSON.stringify({ lastActivityAt: at })]);
}
test("[验收线 1] 出借心跳覆盖更早事件，两条规则共用", async () => {
  card(); lock(); feature(); heartbeat(NOW - H);
  const r = await blockedRun(); expect(mine(r)).toEqual([]); expect(blockers(r)).toEqual([]);
  const later = await blockedRun("on", NOW + 12 * H);
  expect(mine(later)[0]!.detail).toContain("出借心跳"); expect(blockers(later)[0]!.detail).toContain("出借心跳");
  expect(mine(later)[0]!.since).toBe(NOW - H);
  expect(mine(later)[0]!.detail).toContain("actor=出借心跳 peer");
});
test("[验收线 1] 没进展也没心跳不报；只有心跳用 hb 指纹去重", async () => {
  card();
  const emptyEvents = async () => {
    const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
    return auditLedger({ ...s!, tasks: s!.tasks.map((t) => ({ ...t, events: [] })) }, NOW, policy("on"));
  };
  expect(mine(await emptyEvents())).toEqual([]);
  heartbeat(NOW - 13 * H); expect(mine(await emptyEvents())[0]!.key).toEndWith(`|B|hb${NOW - 13 * H}`);
});
test("[验收线 1] 排除表只排服务噪音，所有推进事件都认", () => {
  expect(MANUAL_STALL_AUDIT_MS).toBe(12 * H); expect(LOCK_BLOCKER_STALL_MS).toBe(4 * H);
  for (const op of STALL_IGNORED_SCHEDULER_OPS) {
    expect(isStallProgress({ kind: "scheduler", actor: "scheduler", data: { op } })).toBe(false);
    expect(isStallProgress({ kind: "scheduler", actor: "owner", data: { op } })).toBe(true);
  }
  for (const kind of ["ask", "ask_expire", "ask_cancel", "ask_reopen", "assign_reopen", "memory"] as const)
    expect(isStallProgress({ kind, actor: "owner", data: {} })).toBe(false);
  expect(isStallProgress({ kind: "decision", actor: "owner", data: { askId: "a" } })).toBe(false);
  for (const kind of ["stage", "deliver", "review", "step", "dispatch", "escalate", "decision", "deploy", "verify"] as const)
    expect(isStallProgress({ kind, actor: "scheduler", data: {} })).toBe(true);
  expect(isStallProgress({ kind: "scheduler", actor: "scheduler", data: { op: "merge_phase" } })).toBe(true);
});
const stallSkipped = (r: AuditResult) => r.skipped.filter((f) => STALL_RULES.some((rule) => rule === f.rule));
const rec = async (mode: RecoveryMode | "throw", specExists: (path: string) => boolean = () => true) => {
  const r = await blockedRun(mode, NOW, specExists);
  return { r, rec: reconcileFindings(db, P, r.findings, r.evaluated, NOW, { keep: r.keep }) };
};
test("[验收线 4] 开关一次、缺文件 observe；observe 理由逐字稳定，两规则 evaluated", async () => {
  expect(RECOVERY_KEYS.filter((k) => k === "auditStall")).toHaveLength(1);
  expect(RECOVERY_KEYS.at(-1)).toBe("auditStall");
  expect(recoveryPolicy(P, "auditStall", join(dirname(path), "missing.json")).mode).toBe("observe");
  card(); lock(); feature();
  const first = await blockedRun("observe"), next = await blockedRun("observe", NOW + H);
  expect(first.findings.some((f) => STALL_RULES.some((rule) => rule === f.rule))).toBe(false);
  expect(stallSkipped(first)).toHaveLength(2);
  expect(stallSkipped(first).every((f) => f.reason.startsWith("观察中:"))).toBe(true);
  expect(stallSkipped(first)).toEqual(stallSkipped(next));
  expect(STALL_RULES.every((rule) => first.evaluated.includes(rule))).toBe(true);
});
test("[验收线 4] on 未 ack 的旧发现，observe / off / 抛错不推不结清", async () => {
  await rec("observe"); card(); lock(); feature();
  const first = await rec("on"), keys = first.rec.pending.filter((f) => STALL_RULES.some((rule) => rule === f.rule)).map((f) => f.key);
  expect(keys).toHaveLength(2);
  for (const mode of ["observe", "off", "throw"] as const) {
    const { r, rec: rr } = await rec(mode);
    expect(keys.every((k) => r.keep.includes(k))).toBe(true);
    expect(rr.pending.filter((f) => STALL_RULES.some((rule) => rule === f.rule))).toEqual([]);
    expect(rr.resolved).toEqual([]);
    if (mode !== "observe") {
      expect(STALL_RULES.every((rule) => !r.evaluated.includes(rule))).toBe(true);
      expect(stallSkipped(r)).toHaveLength(2);
    }
  }
  db.run("UPDATE audit_findings SET notifiedAt = ?", [NOW]);
  expect((await rec("observe")).rec.resolved).toEqual([]);
  expect((await rec("on")).rec.pending).toEqual([]);
});
test("[验收线 4] 挡路取数抛错 skipped、旧发现 keep；手动卡照常评估", async () => {
  await rec("observe"); card(); lock(); feature();
  const first = await rec("on"), key = first.rec.pending.find((f) => f.rule === "lock_blocker_stalled")!.key;
  const { r, rec: rr } = await rec("on", () => { throw new Error("spec read failure"); });
  expect(r.evaluated).toContain("manual_stalled"); expect(r.evaluated).not.toContain("lock_blocker_stalled");
  expect(mine(r)).toHaveLength(1); expect(r.keep).toContain(key);
  expect(rr.pending.some((f) => f.rule === "lock_blocker_stalled")).toBe(false);
  expect(r.skipped).toContainEqual({ rule: "lock_blocker_stalled", reason: "挡路卡事实读不了" });
  expect(readStallAudit(db, P, { stallSpecExists: () => { throw new Error("no specs"); } })).toMatchObject({ blockers: { unreadable: "挡路卡事实读不了" } });
});
test("[验收线 4] 不认识的策略值按 off", async () => {
  card(); const [s] = await collectAuditSnapshots(db, [P], NOW, sources());
  const r = auditLedger(s!, NOW, () => ({ mode: "bad" as RecoveryMode, manualAfterMs: null, source: "config" }));
  expect(mine(r)).toEqual([]); expect(STALL_RULES.every((rule) => !r.evaluated.includes(rule))).toBe(true);
});

import { writeFileSync } from "node:fs";
import { testChildEnv } from "./test-env.js";
async function cli(mode: RecoveryMode, dry: boolean) {
  const dir = dirname(path);
  writeFileSync(join(dir, "recovery-policy.json"), JSON.stringify({ projects: { [P]: { keys: { auditStall: mode } } } }));
  const script = join(dir, "cli.ts");
  writeFileSync(script, [
    `import { openLedger } from ${JSON.stringify(join(import.meta.dir, "../src/lib/ledger-store.ts"))};`,
    `import { runLedger } from ${JSON.stringify(join(import.meta.dir, "../src/manager/ledger.ts"))};`,
    `const db = openLedger(${JSON.stringify(path)});`,
    `const r = await runLedger(["audit", "--project", "p", "--json"${dry ? ', "--dry-run"' : ''}], {`,
    `db, actor: "owner", projectIds: ["p"], now: () => ${NOW},`,
    `loadRegistry: async () => ({ agents: {} }), saveRegistry: async () => {},`,
    `auditSources: { registry: async () => [], windows: async () => [], turn: async () => "idle",`,
    `fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: ${JSON.stringify(join(dir, "held.json"))},`,
    `stallSpecExists: () => true } }); console.log(JSON.stringify(r));`,
  ].join("\n"));
  const proc = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }) });
  const output = await new Response(proc.stdout).text(), errors = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0); expect(errors).toBe("");
  return JSON.parse(output) as { ok: boolean; projects: { skipped: AuditResult["skipped"] }[] };
}
const writeFacts = () => ({ events: db.query("SELECT COUNT(*) AS n FROM events").get(),
  tasks: db.query("SELECT id, rev FROM tasks ORDER BY id").all(), locks: db.query("SELECT * FROM scheduler_resources ORDER BY resource").all() });
test("[验收线 5] 真 ledger audit 只写巡检表，dry-run 展示观察条目且完全只读", async () => {
  card(); lock(); feature();
  const before = writeFacts();
  expect((await cli("on", false)).ok).toBe(true);
  expect(writeFacts()).toEqual(before);
  expect(db.query("SELECT COUNT(*) AS n FROM audit_findings WHERE rule IN ('manual_stalled', 'lock_blocker_stalled')").get()).toEqual({ n: 2 });
  const stored = db.query("SELECT * FROM audit_findings ORDER BY key").all(), baseline = db.query("SELECT * FROM audit_baseline ORDER BY rule").all();
  const dry = await cli("observe", true);
  expect(dry.ok).toBe(true); expect(stallSkipped({ skipped: dry.projects[0]!.skipped } as AuditResult)).toHaveLength(2);
  expect(stallSkipped({ skipped: dry.projects[0]!.skipped } as AuditResult).every((f) => f.reason.startsWith("观察中:"))).toBe(true);
  expect(writeFacts()).toEqual(before);
  expect(db.query("SELECT * FROM audit_findings ORDER BY key").all()).toEqual(stored);
  expect(db.query("SELECT * FROM audit_baseline ORDER BY rule").all()).toEqual(baseline);
});

test("[验收线 2] 心跳恢复后再次停满，两规则各生成新指纹并重推", async () => {
  await rec("observe"); card(NOW - 14 * H); lock(); feature(); heartbeat(NOW - 13 * H);
  const first = await rec("on"), oldKeys = first.rec.pending.filter((f) => STALL_RULES.some((rule) => rule === f.rule)).map((f) => f.key);
  expect(oldKeys).toHaveLength(2); expect(oldKeys.every((k) => k.endsWith(`|hb${NOW - 13 * H}`))).toBe(true);
  db.run("UPDATE audit_findings SET notifiedAt = ?", [NOW]);
  db.run("UPDATE lend_orders SET beat = ? WHERE orderId = 'o1'", [JSON.stringify({ lastActivityAt: NOW })]);
  expect((await rec("on")).rec.resolved).toEqual(expect.arrayContaining(oldKeys));
  const later = await blockedRun("on", NOW + 12 * H);
  const rr = reconcileFindings(db, P, later.findings, later.evaluated, NOW + 12 * H, { keep: later.keep });
  const newKeys = rr.pending.filter((f) => STALL_RULES.some((rule) => rule === f.rule)).map((f) => f.key);
  expect(newKeys).toHaveLength(2); expect(newKeys.every((k) => k.endsWith(`|hb${NOW}`))).toBe(true);
  expect(newKeys.every((k) => !oldKeys.includes(k))).toBe(true);
});
test("[验收线 2] 报过后冻结再解冻，无进展不结清、不重开、不重推", async () => {
  await rec("observe"); card(); db.run("UPDATE tasks SET stage = 'merge' WHERE id = 'B'");
  const first = await rec("on"), key = first.rec.pending.find((f) => f.rule === "manual_stalled")!.key;
  expect(key).toMatch(/\|B\|e\d+$/);
  db.run("UPDATE audit_findings SET notifiedAt = ? WHERE key = ?", [NOW, key]);
  setFrozen(db, { actor: "owner", now: NOW }, { project: P, frozen: true, reason: "暂停队列" });
  const frozen = await rec("on");
  expect(frozen.r.keep).toContain(key); expect(frozen.rec.resolved).not.toContain(key);
  expect(frozen.rec.pending.some((f) => f.rule === "manual_stalled")).toBe(false);
  setFrozen(db, { actor: "owner", now: NOW }, { project: P, frozen: false, reason: "恢复队列" });
  const thaw = await rec("on");
  expect(thaw.rec.opened).not.toContain(key); expect(thaw.rec.resolved).not.toContain(key);
  expect(thaw.rec.pending.some((f) => f.rule === "manual_stalled")).toBe(false);
});
