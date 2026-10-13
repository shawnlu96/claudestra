/**
 * dispatch-recovery-AUDTRAIN3：巡检只给真正等合并槽的卡标「排队中」（src/lib/ledger-audit-train.ts + ledger-audit-train-facts.ts）。
 * 夹具是临时目录里的真台账库：合并意图 / 合并槽（scheduler_resources merge:p）/ 合并记录，真实路径的用 beginMergeRun / advanceMergeRun；
 * 取数走真快照（collectAuditSnapshots），规则走真巡检入口（auditLedger），开关用注入的恢复策略 auditTrainQueue。
 * 「基线」= 同一份快照去掉列车事实再跑（off 的原路径）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditFinding, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { ackFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { readAuditTrain, type MergeTrainInputs } from "../src/lib/ledger-audit-train.js";
import { readTrainFacts } from "../src/lib/ledger-audit-train-facts.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { advanceMergeRun, beginMergeRun } from "../src/lib/scheduler-merge.js";
import { SLOT_YIELD } from "../src/lib/scheduler-merge-train-hold.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { baselineAudit } from "./ledger-test-helpers.js";

const MIN = 60_000, NOW = 100_000 * MIN, P = "p";
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
const SCH = { actor: "scheduler" };
type Snap = AuditSnapshot & MergeTrainInputs;
const head = (id: string) => (id === "A" ? "a" : id === "B" ? "b" : id === "C" ? "c" : "e").repeat(40);

let db: Database, dir: string, path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-train-recovery-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.run("PRAGMA foreign_keys = OFF"); // 夹具直接写合并槽 / 记录，意图只造用得上的列
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm"] });
  baselineAudit(db, P);
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

const sources = (over: Partial<SnapshotSources> = {}): SnapshotSources => ({
  registry: async () => [], windows: async () => ["master"], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"), ...over,
});
const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "auditTrainQueue" ? mode : "observe", manualAfterMs: null, source: "config" });

/** 自动流程 code 卡，at 时刻进 merge；带当前 head 的有效 PASS（真实合并路径要核） */
function card(id: string, at: number, project = P): void {
  createTask(db, { actor: "owner", now: 0 }, { project, id, title: id, kind: "code", agent: "agent-x", pm: "agent-pm" });
  setWorkflow(db, { actor: "owner", now: 0 }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接手" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=? WHERE id=?").run(head(id), `https://github.com/o/r/pull/${id.charCodeAt(0)}`, `feat/${id}`, id);
  intent(`rv-${id}`, id, "done", "ensure_session");
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-rv',?,'codex','tmux','active',?,0,0)`).run(id, `rv-s-${id}`, `rv-${id}`);
  insertEvent(db, { actor: "agent-rv", now: at - MIN }, { project, target: id, kind: "review", text: "", data: { round: 1, head: head(id), verdict: "pass",
    reviewer: "agent-rv", reviewerSessionId: `rv-s-${id}`, reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false);
  insertEvent(db, { actor: "owner", now: at }, { project, target: id, kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
}
function intent(id: string, taskId: string, status: string, action = "merge", project = P): string {
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,?,?,'merge_deploy',?,1,1,2,1,?,2,?,'seed',0,0)`).run(id, taskId, project, action, head(taskId), status);
  return id;
}
const slot = (taskId: string, intentId: string, project = P) => db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES (?,?,?,?,0)")
  .run(project, `merge:${project}`, taskId, intentId);
const freeSlot = () => db.query("DELETE FROM scheduler_resources WHERE resource = ?").run(`merge:${P}`);
/** 直接写一条合并记录（headOf 缺省 = 卡当前 head） */
function journal(intentId: string, taskId: string, phase: string, at: number, reviewed = head(taskId)): void {
  db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, ?, ?, 'pr', 'b', ?, 'ci', ?, ?, ?)`).run(intentId, taskId, P, reviewed, phase, at, at);
}
/** 真实路径：意图持槽 → beginMergeRun → 推到 to（ready / await_ci / merging） */
function realRun(taskId: string, to: "ready" | "await_ci" | "merging", at: number): string {
  const id = intent(`m-${taskId}`, taskId, "submitted");
  slot(taskId, id);
  beginMergeRun(db, { ...SCH, now: at }, id, ["ci"]);
  if (to !== "ready") advanceMergeRun(db, { ...SCH, now: at }, { intentId: id, from: "ready", to: "await_ci", rev: 1, receipt: "clean" });
  if (to === "merging") advanceMergeRun(db, { ...SCH, now: at }, { intentId: id, from: "await_ci", to: "merging", rev: 2, receipt: "green" });
  return id;
}
const mergeNow = (id: string, at: number) => advanceMergeRun(db, { ...SCH, now: at }, { intentId: id, from: "merging", to: "merged", rev: 3, receipt: "merged", mergeSha: "f".repeat(40) });

const snapshot = async (now = NOW, src = sources()): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, src))[0] as Snap;
const ship = (s: Snap, mode: RecoveryMode, now = NOW) => {
  const r = auditLedger(s, now, policy(mode));
  return { findings: r.findings.filter((f) => f.rule === "ship_stalled"), keep: r.keep.filter((k) => k.includes("|ship_stalled|")) };
};
const of = (s: Snap, mode: RecoveryMode, id: string, now = NOW) => ship(s, mode, now).findings.find((f) => f.taskId === id);
/** 基线：快照不带列车事实（off 原路径） */
const base = (s: Snap, mode: RecoveryMode, now = NOW) => { const { mergeTrain: _m, trainFacts: _f, ...rest } = s; return auditLedger(rest, now, policy(mode)); };
const plain = (id: string, mins: number) => `${id} 在 merge 已 ${mins} 分钟 没推进`;
const keyOf = (id: string, since: number) => `p|ship_stalled|${id}|merge|${since}`;
const strip = (fs: readonly AuditFinding[]) => fs.map((f) => ({ ...f, detail: f.detail.replace(/（排队中：[^）]*）$/, "") }));

describe("[验收线 1] 已合并等部署：B 当前 head 已 merged、仍在 merge，A 真实持槽", () => {
  beforeEach(() => {
    card("A", NOW - 10 * MIN);
    card("B", NOW - 40 * MIN);
    journal("m-B", "B", "merged", NOW - 35 * MIN);
  });
  const check = async () => {
    const s = await snapshot();
    expect(s.trainFacts?.cards.B).toEqual({ stage: "merge", merged: true, phase: "merged" });
    expect(of(s, "observe", "B")?.detail).toBe(plain("B", 40)); // 先红：旧判定只看 active，B 被 A 的记录标成排队
    expect(ship(s, "on")).toEqual({ findings: [expect.objectContaining({ taskId: "B", detail: plain("B", 40) })], keep: [] });
    for (const mode of MODES) expect(auditLedger(s, NOW, policy(mode))).toEqual(base(s, mode));
  };
  test("B 已释放槽，A 的意图持槽在 await_ci", async () => {
    slot("A", intent("m-A", "A", "submitted"));
    journal("m-A", "A", "await_ci", NOW - 10 * MIN);
    await check();
  });
  test("B 自己为部署持槽，A 另有残留 ready", async () => {
    slot("B", intent("m-B", "B", "submitted"));
    journal("m-A", "A", "ready", NOW - 10 * MIN);
    await check();
  });
});

describe("[验收线 2] 合并完成边界：真实 advanceMergeRun 把 B 从 merging 提交为 merged", () => {
  const T = NOW;
  beforeEach(() => {
    card("A", T - 10 * MIN);
    card("B", T - 40 * MIN);
  });
  /** B 合并前已把槽交给 A（A 意图持槽、记录 await_ci） */
  const handOver = () => { freeSlot(); slot("A", intent("m-A", "A", "submitted")); journal("m-A", "A", "await_ci", T - 10 * MIN); };
  test("T 与 T+1 秒走真实快照 → 巡检：B 都不标排队，on 不因排队静音", async () => {
    mergeNow(realRun("B", "merging", T - 40 * MIN), T);
    handOver();
    for (const at of [T, T + 1000]) {
      const s = await snapshot(at);
      expect(s.trainFacts?.cards.B?.merged).toBe(true);
      expect(of(s, "observe", "B", at)?.detail).toBe(plain("B", 40));
      expect(of(s, "on", "B", at)?.detail).toBe(plain("B", 40));
      expect(ship(s, "on", at).keep).toEqual([]);
    }
  });
  test("合并提交注入在外部事实读取的 await 里：最终事实读取看到 merged", async () => {
    const id = realRun("B", "merging", T - 40 * MIN);
    handOver();
    let fired = 0;
    const s = await snapshot(T, sources({ mergeCi: async () => { mergeNow(id, T); fired++; return {}; } }));
    expect(fired).toBe(1);
    expect(s.tasks.find((t) => t.task.id === "B")?.task.stage).toBe("merge");
    expect(s.trainFacts?.cards.B).toEqual({ stage: "merge", merged: true, phase: "merged" });
    expect(of(s, "observe", "B")?.detail).toBe(plain("B", 40));
    expect(of(s, "on", "B")?.detail).toBe(plain("B", 40));
  });
});

describe("[验收线 3] 自身 ready / await_ci 等车：B 有开放意图和记录，A 的意图持项目合并槽", () => {
  beforeEach(() => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
  });
  const holdA = () => { slot("A", intent("m-A", "A", "submitted")); journal("m-A", "A", "await_ci", NOW - 40 * MIN); };
  const expectWaiting = async () => {
    const s = await snapshot();
    expect(of(s, "observe", "B")?.detail).toBe(`${plain("B", 40)}（排队中：列车在合 A，await_ci）`); // 先红：旧实现因 B 自身在 active 直接返回原规则
    expect(of(s, "observe", "A")?.detail).toBe(plain("A", 40));
    const on = ship(s, "on");
    expect(on.findings.map((f) => [f.taskId, f.detail])).toEqual([["A", plain("A", 40)]]);
    expect(on.keep).toEqual([keyOf("B", NOW - 40 * MIN)]);
    return s;
  };
  for (const phase of ["ready", "await_ci"] as const) {
    test(`直接夹具：B 意图 submitted、记录 ${phase}`, async () => {
      intent("m-B", "B", "submitted");
      journal("m-B", "B", phase, NOW - 40 * MIN);
      holdA();
      await expectWaiting();
    });
    test(`真实让槽路径：B 持槽 ${phase} → 同阶段让出合并槽 → A 持槽`, async () => {
      const id = realRun("B", phase, NOW - 40 * MIN);
      advanceMergeRun(db, { ...SCH, now: NOW - 39 * MIN }, { intentId: id, from: phase, to: phase, rev: phase === "ready" ? 1 : 2, receipt: `${SLOT_YIELD}测试列车` });
      expect(db.query("SELECT COUNT(*) AS n FROM scheduler_resources").get()).toEqual({ n: 0 });
      holdA();
      await expectWaiting();
    });
  }
  test("合并队列口径：B 是 ready、blocked 为 null；observe 报过 → on 不报，同标识旧发现保持未解决", async () => {
    intent("m-B", "B", "submitted");
    journal("m-B", "B", "ready", NOW - 40 * MIN);
    holdA();
    const q = await runLedger(["merge-queue", "--project", P], { db, actor: "owner", projectIds: [P], loadRegistry: async () => ({} as Registry),
      saveRegistry: async () => {}, now: () => NOW }) as { rows?: { task: string; phase: string; blocked: string | null }[] };
    expect(q.rows?.find((r) => r.task === "B")).toMatchObject({ phase: "ready", blocked: null });
    const round = async (mode: RecoveryMode, now: number) => {
      const r = auditLedger(await snapshot(now), now, policy(mode));
      const pending = reconcileFindings(db, P, r.findings, r.evaluated, now, { keep: r.keep }).pending.filter((f) => f.rule === "ship_stalled");
      ackFindings(db, pending.map((f) => f.key), now);
      return pending.map((f) => f.taskId).sort();
    };
    expect(await round("observe", NOW)).toEqual(["A", "B"]);
    expect(await round("on", NOW + 5 * MIN)).toEqual([]);
    expect(db.query("SELECT taskId, resolvedAt FROM audit_findings WHERE rule = 'ship_stalled' ORDER BY taskId").all())
      .toEqual([{ taskId: "A", resolvedAt: null }, { taskId: "B", resolvedAt: null }]);
  });
});

describe("[验收线 4] 真排队与部署持槽", () => {
  beforeEach(() => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
    slot("A", intent("m-A", "A", "submitted"));
    journal("m-A", "A", "await_ci", NOW - 40 * MIN);
  });
  const B = (s: Snap, mode: RecoveryMode, now = NOW) => of(s, mode, "B", now)?.detail;
  test("B 没有自己的记录、A 持槽 await_ci：observe 照常报 A、B 带标注；on 不报 B 并保留旧发现", async () => {
    const s = await snapshot();
    expect(of(s, "observe", "A")?.detail).toBe(plain("A", 40));
    expect(B(s, "observe")).toBe(`${plain("B", 40)}（排队中：列车在合 A，await_ci）`);
    expect(ship(s, "on")).toEqual({ findings: [expect.objectContaining({ taskId: "A" })], keep: [keyOf("B", NOW - 40 * MIN)] });
  });
  test("A 已 merged、部署没结束仍持槽：B 仍标等待，说明写 A 在等部署；A 自身不标", async () => {
    db.query("UPDATE scheduler_merges SET phase = 'merged', updatedAt = ? WHERE intentId = 'm-A'").run(NOW - 5 * MIN);
    const s = await snapshot();
    expect(B(s, "observe")).toBe(`${plain("B", 40)}（排队中：合并槽在 A，它已合并、在等部署）`);
    expect(of(s, "observe", "A")?.detail).toBe(plain("A", 40));
    expect(ship(s, "on").findings.map((f) => f.taskId)).toEqual(["A"]);
  });
  test("A 结清释放槽：B 不再标；on 下原空出计时照常（从 A 的 merged 起算）", async () => {
    db.query("UPDATE scheduler_merges SET phase = 'merged', updatedAt = ? WHERE intentId = 'm-A'").run(NOW - 5 * MIN);
    freeSlot();
    const s = await snapshot();
    expect(B(s, "observe")).toBe(plain("B", 40));
    expect(ship(s, "on")).toEqual({ findings: [expect.objectContaining({ taskId: "A" })], keep: [keyOf("B", NOW - 40 * MIN)] });
    const late = await snapshot(NOW + 26 * MIN);
    expect(of(late, "on", "B", NOW + 26 * MIN)).toMatchObject({ since: NOW - 5 * MIN, detail: plain("B", 31) });
  });
  test("误判排除：无槽的旧 await_review、别项目资源都不叫排队", async () => {
    freeSlot();
    card("C", NOW - 40 * MIN);
    journal("m-C", "C", "await_review", NOW - 40 * MIN);
    slot("A", "m-A", "q");
    const s = await snapshot();
    for (const id of ["B", "C"]) expect(of(s, "observe", id)?.detail).toBe(plain(id, 40));
    expect(ship(s, "on").keep).toEqual([]);
  });
  test("持槽意图的合并记录记在别的项目：不当本项目持槽者", async () => {
    db.query("UPDATE scheduler_merges SET project = 'q' WHERE intentId = 'm-A'").run();
    const s = await snapshot();
    expect(s.trainFacts?.holder).toBeNull();
    expect(B(s, "observe")).toBe(plain("B", 40));
  });
  test("非当前 head 的 merged 不算已合并：B 仍在等槽", async () => {
    journal("m-B-old", "B", "merged", NOW - 50 * MIN, "9".repeat(40));
    const s = await snapshot();
    expect(s.trainFacts?.cards.B?.merged).toBe(false);
    expect(B(s, "observe")).toBe(`${plain("B", 40)}（排队中：列车在合 A，await_ci）`);
  });
  test("resolved 不当合并成功；同卡旧意图持槽 = 自身持槽，照原规则报", async () => {
    freeSlot();
    journal("m-B-old", "B", "resolved", NOW - 50 * MIN);
    slot("B", intent("m-B-old2", "B", "cancelled"));
    const s = await snapshot();
    expect(s.trainFacts?.cards.B?.merged).toBe(false);
    expect(B(s, "observe")).toBe(plain("B", 40));
    expect(B(s, "on")).toBe(plain("B", 40));
    expect(of(s, "observe", "A")?.detail).toBe(`${plain("A", 40)}（排队中：列车在合 B，未开始合并）`); // A 自身 await_ci、槽在 B 手里
  });
});

describe("[验收线 5] 共存：同一快照与基线逐字对比", () => {
  test("off 完整输出逐字一致；observe 除排队标注外逐字一致；live / 30 分钟边界不变", async () => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 40 * MIN);
    card("C", NOW - 30 * MIN); // 恰好 30 分钟：不报
    card("D", NOW - 3 * 60 * MIN);
    db.query("UPDATE tasks SET stage = 'live' WHERE id = 'D'").run();
    insertEvent(db, { actor: "owner", now: NOW - 61 * MIN }, { project: P, target: "D", kind: "stage", text: "", data: { from: "merge", to: "live" } }, false);
    slot("A", intent("m-A", "A", "submitted"));
    journal("m-A", "A", "await_ci", NOW - 40 * MIN);
    const s = await snapshot();
    expect(auditLedger(s, NOW, policy("off"))).toEqual(base(s, "off"));
    const obs = auditLedger(s, NOW, policy("observe")), was = base(s, "observe");
    expect({ ...obs, findings: strip(obs.findings) }).toEqual(was);
    expect(obs.findings.filter((f) => f.detail.includes("排队中")).map((f) => f.taskId)).toEqual(["B"]);
    expect(obs.findings.filter((f) => f.rule === "ship_stalled").map((f) => f.taskId).sort()).toEqual(["A", "B", "D"]);
  });
});

describe("[验收线 6] 失败降级：observe / on 都按 off", () => {
  beforeEach(() => {
    card("A", NOW - 10 * MIN);
    card("B", NOW - 40 * MIN);
    slot("A", intent("m-A", "A", "submitted"));
    journal("m-A", "A", "await_ci", NOW - 10 * MIN);
    journal("m-Z", "A", "resolved", NOW - 60 * MIN); // 列车空出过：未知事实不得当槽空了重置计时
  });
  const same = (s: Snap) => {
    const off = auditLedger(s, NOW, policy("off"));
    for (const mode of ["observe", "on"] as const) expect(auditLedger(s, NOW, policy(mode))).toEqual(off);
    expect(of(s, "on", "B")?.detail).toBe(plain("B", 40));
  };
  test("策略读取抛错", async () => {
    const s = await snapshot();
    const broken: RecoveryPolicyPort = (_p, key) => { if (key === "auditTrainQueue") throw new Error("读不了"); return policy("observe")(_p, key); };
    expect(auditLedger(s, NOW, broken)).toEqual(auditLedger(s, NOW, policy("off")));
  });
  test("缺 scheduler_resources 表", async () => {
    db.run("DROP TABLE scheduler_resources");
    const s = await snapshot();
    expect(s.trainFacts).toBeUndefined();
    same(s);
  });
  test("缺 scheduler_merges 表", async () => {
    db.run("DROP TABLE scheduler_merges");
    const s = await snapshot();
    expect(s.trainFacts).toBeUndefined();
    same(s);
  });
  test("资源事实读取失败", async () => {
    db.run("ALTER TABLE scheduler_resources RENAME COLUMN intentId TO holderIntent");
    expect(readTrainFacts(db, P)).toBeUndefined();
    const s = await snapshot();
    expect(s.mergeTrain).toBeDefined();
    same(s);
  });
  test("快照没带槽事实（带 active 列车记录）", async () => {
    const { trainFacts: _drop, ...s } = await snapshot();
    expect(s.mergeTrain?.active.length).toBe(1);
    same(s);
  });
});

describe("[验收线 7] 只读事实无副作用", () => {
  test("取数不写库、不建表，事务结束后连接不留在事务里", () => {
    card("A", NOW - 10 * MIN);
    slot("A", intent("m-A", "A", "submitted"));
    journal("m-A", "A", "await_ci", NOW - 10 * MIN);
    const schema = () => db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    const before = { schema: schema(), changes: db.query("SELECT total_changes() AS n").get() };
    const got = readAuditTrain(db, P, [{ task: { id: "A", stage: "merge" } }]);
    expect(got.trainFacts?.holder).toEqual({ taskId: "A", intentId: "m-A", phase: "await_ci", merged: false });
    expect({ schema: schema(), changes: db.query("SELECT total_changes() AS n").get() }).toEqual(before);
    expect(db.inTransaction).toBe(false);
  });
});
