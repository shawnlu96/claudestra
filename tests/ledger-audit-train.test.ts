/**
 * dispatch-recovery-AUDTRAIN1：合并列车在合别的卡时，排队的 merge 卡不报「合并部署停滞」（src/lib/ledger-audit-train.ts）。
 * 夹具是真台账库 + 真取数（collectAuditSnapshots 读 scheduler_merges）+ 真规则（auditLedger），开关用注入的恢复策略 auditTrainQueue。
 * 「改动前」= 同一份快照去掉 mergeTrain 再跑一遍（shipStalled 原路径），另把 detail / key / since 写死核对。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditFinding, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { ackFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { readMergeTrain, trainSlots, type MergeTrainInputs } from "../src/lib/ledger-audit-train.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { RECOVERY_KEYS, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000, DAY = 24 * 60 * MIN;
const NOW = 100_000 * MIN;
const P = "p";
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
type Snap = AuditSnapshot & MergeTrainInputs;

let db: Database, path: string, dir: string;
beforeEach(() => {
  path = tempLedgerPath("ledger-audit-train-");
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-train-"));
  db = openLedger(path);
  db.run("PRAGMA foreign_keys = OFF"); // 夹具直接写合并 journal，不造意图
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm"] });
  baselineAudit(db, P);
});
afterEach(() => closeLedger(path));

const sources = (): SnapshotSources => ({
  registry: async () => [], windows: async () => ["master"], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"),
});
/** 只有 auditTrainQueue 用被测模式，其余开关固定 observe */
const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "auditTrainQueue" ? mode : "observe", manualAfterMs: null, source: "config" });

/** 卡 id 在 at 时刻进 merge */
function card(id: string, at: number, project = P): void {
  createTask(db, { actor: "owner", now: 0 }, { project, id, title: id, kind: "code", agent: "agent-x", pm: "agent-pm", stage: "build" });
  moveStage(db, { actor: "owner", now: at }, { taskId: id, from: "build", to: "review" });
  moveStage(db, { actor: "owner", now: at }, { taskId: id, from: "review", to: "merge" });
}
function run(taskId: string, phase: string, createdAt: number, updatedAt = createdAt, project = P): string {
  const intentId = `i-${taskId}-${createdAt}`;
  db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, ?, ?, 'pr', 'b', 'h', '', ?, ?, ?)`).run(intentId, taskId, project, phase, createdAt, updatedAt);
  return intentId;
}
const snapshot = async (now = NOW): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, sources()))[0] as Snap;
const stalled = (s: Snap, mode: RecoveryMode, now = NOW) => {
  const r = auditLedger(s, now, policy(mode));
  return { findings: r.findings.filter((f) => f.rule === "ship_stalled"), keep: r.keep.filter((k) => k.includes("|ship_stalled|")) };
};
/** 改动前的输出：快照不带列车事实 */
const before = (s: Snap, mode: RecoveryMode, now = NOW) => { const { mergeTrain: _drop, ...rest } = s; return auditLedger(rest, now, policy(mode)); };
const brief = (f: AuditFinding) => ({ taskId: f.taskId, since: f.since, detail: f.detail, suggestion: f.suggestion, key: f.key });
const B_KEY = `p|ship_stalled|B|merge|${NOW - 40 * MIN}`;
const B_PLAIN = { taskId: "B", since: NOW - 40 * MIN, detail: "B 在 merge 已 40 分钟 没推进", suggestion: "补做合并部署，做完推阶段", key: B_KEY };

describe("[验收线 1] A 占着列车（await_ci 10 分钟），B 在 merge 40 分钟、没有自己的记录", () => {
  beforeEach(() => {
    card("A", NOW - 10 * MIN);
    card("B", NOW - 40 * MIN);
    run("A", "await_ci", NOW - 10 * MIN);
  });
  test("取数：A 是占着列车的那条，列车没空出过", async () => {
    expect((await snapshot()).mergeTrain).toEqual({ active: [{ taskId: "A", phase: "await_ci", createdAt: NOW - 10 * MIN }], freedAt: null });
  });
  test("off：输出和改动前逐字一致", async () => {
    const s = await snapshot();
    expect(auditLedger(s, NOW, policy("off"))).toEqual(before(s, "off"));
    expect(stalled(s, "off").findings.map(brief)).toEqual([B_PLAIN]);
  });
  test("observe：B 照报，detail 末尾带排队说明，key / since / 建议不变", async () => {
    const f = stalled(await snapshot(), "observe").findings.map(brief);
    expect(f).toEqual([{ ...B_PLAIN, detail: `${B_PLAIN.detail}（排队中：列车在合 A，await_ci）` }]);
    expect(f[0].detail.endsWith("（排队中：列车在合 A，await_ci）")).toBe(true);
  });
  test("on：B 不报、原 key keep 住；A 没满 30 分钟也不报", async () => {
    expect(stalled(await snapshot(), "on")).toEqual({ findings: [], keep: [B_KEY] });
  });
  test("别的项目的列车记录不算：B 照报", async () => {
    db.query("UPDATE scheduler_merges SET project = 'q'").run();
    expect(stalled(await snapshot(), "on").findings.map(brief)).toEqual([B_PLAIN]);
  });
});

describe("[验收线 2] A 的记录在 T 变成 merged：on 下 B 从 T 起算", () => {
  const T = NOW;
  beforeEach(() => {
    card("A", T - 10 * MIN);
    card("B", T - 40 * MIN);
    const id = run("A", "await_ci", T - 10 * MIN);
    db.query("UPDATE scheduler_merges SET phase = 'merged', updatedAt = ? WHERE intentId = ?").run(T, id);
    moveStage(db, { actor: "owner", now: T }, { taskId: "A", from: "merge", to: "live" });
  });
  test("T+29 分钟不报（原 key keep 住），T+31 分钟报，since 等于 T", async () => {
    expect((await snapshot(T + 29 * MIN)).mergeTrain).toEqual({ active: [], freedAt: T });
    expect(stalled(await snapshot(T + 29 * MIN), "on", T + 29 * MIN)).toEqual({ findings: [], keep: [B_KEY] });
    const late = stalled(await snapshot(T + 31 * MIN), "on", T + 31 * MIN).findings.map(brief);
    expect(late).toEqual([{ ...B_PLAIN, since: T, detail: "B 在 merge 已 31 分钟 没推进" }]);
  });
  test("边界：恰好 30 分钟不报，多 1ms 报", async () => {
    expect(stalled(await snapshot(T + 30 * MIN), "on", T + 30 * MIN).findings).toEqual([]);
    expect(stalled(await snapshot(T + 30 * MIN + 1), "on", T + 30 * MIN + 1).findings).toHaveLength(1);
  });
  test("off / observe：不从列车空出起算，和改动前一致", async () => {
    const s = await snapshot(T + 29 * MIN);
    for (const mode of ["off", "observe"] as const) expect(auditLedger(s, T + 29 * MIN, policy(mode))).toEqual(before(s, mode, T + 29 * MIN));
    expect(stalled(s, "observe", T + 29 * MIN).findings.map(brief)).toEqual([{ ...B_PLAIN, detail: "B 在 merge 已 69 分钟 没推进" }]);
  });
});

describe("[验收线 3] 正在被合的卡自己的记录卡在 await_ci 40 分钟", () => {
  test("三种开关都照报，和改动前一致；排在它后面的卡 on 下不跟着刷", async () => {
    card("A", NOW - 40 * MIN);
    card("B", NOW - 35 * MIN);
    run("A", "await_ci", NOW - 40 * MIN);
    const s = await snapshot();
    const A = { taskId: "A", since: NOW - 40 * MIN, detail: "A 在 merge 已 40 分钟 没推进", suggestion: "补做合并部署，做完推阶段", key: `p|ship_stalled|A|merge|${NOW - 40 * MIN}` };
    for (const mode of MODES) expect(stalled(s, mode).findings.map(brief).filter((f) => f.taskId === "A")).toEqual([A]);
    expect(auditLedger(s, NOW, policy("off"))).toEqual(before(s, "off"));
    expect(stalled(s, "on").findings.map((f) => f.taskId)).toEqual(["A"]);
  });
});

describe("[验收线 4] 没有 scheduler_merges 表", () => {
  test("三种开关下输出都和改动前一致", async () => {
    card("A", NOW - 10 * MIN);
    card("B", NOW - 40 * MIN);
    db.run("DROP TABLE scheduler_merges");
    const s = await snapshot();
    expect(s.mergeTrain).toBeUndefined();
    for (const mode of MODES) {
      expect(auditLedger(s, NOW, policy(mode))).toEqual(before(s, mode));
      expect(stalled(s, mode)).toEqual({ findings: [expect.objectContaining(B_PLAIN)], keep: [] });
    }
  });
});

describe("[验收线 6] 旧记录不算占着列车", () => {
  test("C 已 live 留着 await_review、D 旧 await_review + 新 merged：on 下 B 照报", async () => {
    card("C", NOW - 9 * DAY);
    moveStage(db, { actor: "owner", now: NOW - 8 * DAY }, { taskId: "C", from: "merge", to: "live" });
    run("C", "await_review", NOW - 9 * DAY, NOW - 8 * DAY);
    card("D", NOW - 3 * DAY); // 还在 merge 阶段：只靠「最新一条记录」排除
    run("D", "await_review", NOW - 3 * DAY);
    run("D", "merged", NOW - 2 * DAY);
    card("B", NOW - 40 * MIN);
    const s = await snapshot();
    expect(s.mergeTrain).toEqual({ active: [], freedAt: NOW - 2 * DAY });
    expect(stalled(s, "on").findings.map(brief).filter((f) => f.taskId === "B")).toEqual([B_PLAIN]);
    expect(stalled(s, "observe").findings.map(brief).filter((f) => f.taskId === "B")).toEqual([B_PLAIN]);
  });
  test("同一张卡旧记录已结、新记录进行中：算占着列车", () => {
    card("D", NOW - 3 * DAY);
    run("D", "resolved", NOW - 3 * DAY, NOW - 2 * DAY);
    run("D", "updating", NOW - 5 * MIN);
    const tasks = [{ task: { id: "D", stage: "merge" } }];
    expect(readMergeTrain(db, P, tasks)).toEqual({ active: [{ taskId: "D", phase: "updating", createdAt: NOW - 5 * MIN }], freedAt: NOW - 2 * DAY });
  });
});

describe("开关与对账", () => {
  test("auditTrainQueue 登记一次，缺省 observe；策略读不了按 off", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "auditTrainQueue")).toHaveLength(1);
    expect(recoveryPolicy(P, "auditTrainQueue", join(dir, "none.json")).mode).toBe("observe");
    const train = { active: [{ taskId: "A", phase: "merging", createdAt: 1 }], freedAt: null };
    const broken: RecoveryPolicyPort = () => { throw new Error("读不了"); };
    expect(trainSlots({ project: P, mergeTrain: train }, broken)({ id: "B", stage: "merge" })).toEqual({ parked: false, freedAt: null, note: "" });
    expect(trainSlots({ project: P, mergeTrain: train }, policy("on"))({ id: "B", stage: "live" })).toEqual({ parked: false, freedAt: null, note: "" });
  });
  test("observe 报过 → 切 on 排队中 → 列车空出再满 30 分钟：同一个 key 一直开着，不当新发现重推", async () => {
    card("A", NOW - 10 * MIN);
    card("B", NOW - 40 * MIN);
    const id = run("A", "await_ci", NOW - 10 * MIN);
    const round = async (mode: RecoveryMode, now: number) => {
      const r = auditLedger(await snapshot(now), now, policy(mode));
      const pending = reconcileFindings(db, P, r.findings, r.evaluated, now, { keep: r.keep }).pending.filter((f) => f.rule === "ship_stalled");
      ackFindings(db, pending.map((f) => f.key), now);
      return pending.map((f) => f.key);
    };
    expect(await round("observe", NOW)).toEqual([B_KEY]);
    expect(await round("on", NOW + 5 * MIN)).toEqual([]);
    db.query("UPDATE scheduler_merges SET phase = 'merged', updatedAt = ? WHERE intentId = ?").run(NOW + 10 * MIN, id);
    moveStage(db, { actor: "owner", now: NOW + 10 * MIN }, { taskId: "A", from: "merge", to: "live" });
    expect(await round("on", NOW + 20 * MIN)).toEqual([]);
    expect(await round("on", NOW + 41 * MIN)).toEqual([]);
    expect(db.query("SELECT key, resolvedAt FROM audit_findings WHERE rule = 'ship_stalled'").all()).toEqual([{ key: B_KEY, resolvedAt: null }]);
  });
});
