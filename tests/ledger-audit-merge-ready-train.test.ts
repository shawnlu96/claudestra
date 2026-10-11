/**
 * dispatch-recovery-AUDTRAIN2：排在合并列车后面的卡，merge_ready_idle 不再建议「走正式合并入口」（src/lib/ledger-audit-merge-ready.ts）。
 * 夹具是真台账库（临时目录）+ 真取数（collectAuditSnapshots 读 scheduler_merges、现跑台账合并门，gh 用假的）+ 真规则（auditLedger），
 * 开关用注入的恢复策略 auditTrainQueue。「改前」的输出写死成字面量（PLAIN / SHIP），改动前后都要对得上。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditFinding, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectMergeCi, mergeBlockersOf, MERGE_READY_RULES, type MergeReadyInputs } from "../src/lib/ledger-audit-merge-ready.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { ackFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import type { MergeTrainInputs } from "../src/lib/ledger-audit-train.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { Run } from "../src/lib/review-main-carry-manual-ci.js";
import { baselineAudit } from "./ledger-test-helpers.js";

const MIN = 60_000, NOW = 100_000 * MIN, P = "p", H = "a".repeat(40);
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
type Snap = AuditSnapshot & MergeReadyInputs & MergeTrainInputs;

let db: Database, path: string, dir: string, report: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-merge-ready-train-"));
  path = join(dir, "ledger.sqlite");
  mkdirSync(statePath("ledger", "reviews"), { recursive: true }); // 台账合并门要读报告原件（测试进程的状态目录是临时的）
  report = join(mkdtempSync(join(statePath("ledger", "reviews"), "audtrain2-")), "r.md");
  writeFileSync(report, `审查 head ${H.slice(0, 12)}：PASS\n`);
  db = openLedger(path);
  db.run("PRAGMA foreign_keys = OFF"); // 夹具直接写合并 journal，不造意图
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm"] });
  baselineAudit(db, P);
  reconcileFindings(db, P, [], [...MERGE_READY_RULES], 0); // 空快照不带 CI 来源，这条规则的首轮基线另记
});
afterEach(() => { closeLedger(path); for (const d of [dir, join(report, "..")]) rmSync(d, { recursive: true, force: true }); });

/** 必需检查全绿的假 gh */
const gh: Run = async (argv) => {
  const head = /commits\/([a-f0-9]{40})\/check-runs/.exec(argv[2] ?? "")?.[1]!;
  const list = ["typecheck", "test"].map((name, i) => ({ id: i + 1, head_sha: head, name, status: "completed", conclusion: "success" }));
  return { code: 0, stdout: JSON.stringify({ total_count: list.length, check_runs: list }), stderr: "", timedOut: false };
};
const sources = (): SnapshotSources => ({
  registry: async () => [], windows: async () => ["master"], turn: async () => "idle",
  fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"),
  mergeCi: (p, t, n, d) => collectMergeCi(p, t, n, { run: gh, checksOf: () => ["typecheck", "test"], blockersOf: (x) => mergeBlockersOf(d, x, n) }),
});
/** 只有 auditTrainQueue 用被测模式，其余开关固定 observe */
const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "auditTrainQueue" ? mode : "observe", manualAfterMs: null, source: "config" });

/** 卡 id 在 at 时刻进 merge；pass = 进 merge 前一分钟有本轮有效 PASS */
function card(id: string, at: number, pass: boolean): void {
  createTask(db, { actor: "owner", now: 0 }, { project: P, id, title: id, kind: "code", agent: "agent-x", pm: "agent-pm" });
  setWorkflow(db, { actor: "owner", now: 0 }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude",
    fallback: "人工", reason: "pm_takeover: 测试" });
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr='https://github.com/o/r/pull/1' WHERE id=?").run(H, id);
  if (pass) insertEvent(db, { actor: "rv", now: at - MIN }, { project: P, target: id, kind: "review", text: "", data: { round: 1, head: H, verdict: "pass",
    reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: report, findings: [], p0: 0, p1: 0, p2: 0 } }, false);
  insertEvent(db, { actor: "pm", now: at }, { project: P, target: id, kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
}
function run(taskId: string, phase: string, createdAt: number): string {
  const intentId = `i-${taskId}-${createdAt}`;
  db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, ?, ?, 'pr', 'b', 'h', '', ?, ?, ?)`).run(intentId, taskId, P, phase, createdAt, createdAt);
  // AUDTRAIN3（PM 补 10-12 03:36）：A 的意图真实持有项目合并槽（land 时删掉）
  if (taskId === "A") db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt) VALUES (?, ?, ?, ?, ?)").run(P, `merge:${P}`, taskId, intentId, createdAt);
  return intentId;
}
/** A 占着列车 → merged，卡推到 live */
function land(intentId: string, at: number): void {
  db.query("UPDATE scheduler_merges SET phase = 'merged', updatedAt = ? WHERE intentId = ?").run(at, intentId);
  db.query("UPDATE tasks SET stage='live' WHERE id='A'").run();
  db.query("DELETE FROM scheduler_resources WHERE intentId = ?").run(intentId);
  insertEvent(db, { actor: "pm", now: at }, { project: P, target: "A", kind: "stage", text: "", data: { from: "merge", to: "live" } }, false);
}
const snapshot = async (now = NOW): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, sources()))[0] as Snap;
const brief = (f: AuditFinding) => ({ taskId: f.taskId, since: f.since, detail: f.detail, suggestion: f.suggestion, key: f.key });
const of = (rule: string, s: Snap, pol: RecoveryPolicyPort, now = NOW) => {
  const r = auditLedger(s, now, pol);
  return { findings: r.findings.filter((f) => f.rule === rule).map(brief), keep: r.keep.filter((k) => k.includes(`|${rule}|`)) };
};
const ready = (s: Snap, mode: RecoveryMode, now = NOW) => of("merge_ready_idle", s, policy(mode), now);
const reviewSeq = () => (db.query("SELECT seq FROM events WHERE target = 'B' AND kind = 'review'").get() as { seq: number }).seq;
const key = () => `p|merge_ready_idle|B|${H}|${reviewSeq()}`;
/** 改前的输出：B 在 merge、PASS、CI 绿、70 分钟没动，台账合并门全过 */
const PASSED = "台账合并门全过（台账外的测量输入等不可核实）";
const plain = (mins = 70, since = NOW - 70 * MIN, blocker = "") => ({ taskId: "B", since, key: key(),
  detail: `B 在 merge，审查 #${reviewSeq()} 已 PASS、当前 head ${H.slice(0, 12)} CI 全绿，已 ${mins} 分钟没动；实际阻塞：${blocker || PASSED}；mainCarry=observe`,
  suggestion: blocker ? "先解掉上面的阻塞，再走正式合并入口" : "走正式合并入口（preflight 核台账合并门 / 最终 head / main / CI 后钉 head 合并）" });
const QUEUED = "列车排队中，等列车轮到它；列车本身停滞看 ship_stalled";

describe("[验收线 1] observe：B 排在列车后面（A 占着，phase ready）", () => {
  beforeEach(() => { card("A", NOW - 10 * MIN, false); card("B", NOW - 70 * MIN, true); run("A", "ready", NOW - 10 * MIN); });
  test("照报一条，实际阻塞写排队中，不再建议走正式合并入口；key / since 不变", async () => {
    const s = await snapshot();
    expect(s.mergeTrain).toEqual({ active: [{ taskId: "A", phase: "ready", createdAt: NOW - 10 * MIN }], freedAt: null });
    const { findings, keep } = ready(s, "observe");
    expect(findings).toEqual([{ ...plain(), suggestion: QUEUED,
      detail: plain().detail.replace(PASSED, "排队中：列车在合 A，ready") }]);
    expect(findings[0]!.detail).toContain("实际阻塞：排队中：列车在合 A，ready；mainCarry=");
    expect(findings[0]!.suggestion).not.toContain("正式合并入口");
    expect(keep).toEqual([]);
  });
  test("别的阻塞照列，排队中排在后面", async () => {
    const { findings } = ready({ ...(await snapshot()), queueFrozen: true }, "observe");
    expect(findings[0]!.detail).toContain("实际阻塞：合并队列冻结；排队中：列车在合 A，ready；mainCarry=");
    expect(findings[0]!.suggestion).toBe(QUEUED);
  });
});

describe("[验收线 2] on：排队中的卡不报，已有的发现留住；列车空出后重新计时", () => {
  let intent: string;
  beforeEach(() => { card("A", NOW - 10 * MIN, false); card("B", NOW - 70 * MIN, true); intent = run("A", "ready", NOW - 10 * MIN); });
  test("同样输入不报，原 key keep 住", async () => {
    expect(ready(await snapshot(), "on")).toEqual({ findings: [], keep: [key()] });
  });
  test("列车空出（A merged）后满 60 分钟照常上报，since 从空出起算；没满只 keep", async () => {
    const T = NOW + 10 * MIN;
    land(intent, T);
    expect((await snapshot(T + 60 * MIN)).mergeTrain).toEqual({ active: [], freedAt: T });
    expect(ready(await snapshot(T + 60 * MIN), "on", T + 60 * MIN)).toEqual({ findings: [], keep: [key()] });
    expect(ready(await snapshot(T + 61 * MIN), "on", T + 61 * MIN)).toEqual({ findings: [plain(61, T)], keep: [] });
  });
  test("observe 报过 → 切 on 排队中 → 列车空出再满 60 分钟：同一个 key 一直开着，没被标已解决", async () => {
    const round = async (mode: RecoveryMode, now: number) => {
      const r = auditLedger(await snapshot(now), now, policy(mode));
      const rec = reconcileFindings(db, P, r.findings, r.evaluated, now, { keep: r.keep });
      const pending = rec.pending.filter((f) => f.rule === "merge_ready_idle");
      ackFindings(db, pending.map((f) => f.key), now);
      return { pushed: pending.map((f) => f.key), found: r.findings.filter((f) => f.rule === "merge_ready_idle").length };
    };
    const open = () => db.query("SELECT key, resolvedAt FROM audit_findings WHERE rule = 'merge_ready_idle'").all();
    expect(await round("observe", NOW)).toEqual({ pushed: [key()], found: 1 });
    expect(await round("on", NOW + 5 * MIN)).toEqual({ pushed: [], found: 0 });
    expect(open()).toEqual([{ key: key(), resolvedAt: null }]);
    land(intent, NOW + 10 * MIN);
    expect(await round("on", NOW + 30 * MIN)).toEqual({ pushed: [], found: 0 });
    expect(open()).toEqual([{ key: key(), resolvedAt: null }]);
    expect((await round("on", NOW + 71 * MIN)).found).toBe(1);
    expect(open()).toEqual([{ key: key(), resolvedAt: null }]);
  });
});

describe("[验收线 3] 共存：与改前逐字一致的几种情形", () => {
  test("off：排队中也照原样报", async () => {
    card("A", NOW - 10 * MIN, false); card("B", NOW - 70 * MIN, true); run("A", "ready", NOW - 10 * MIN);
    expect(ready(await snapshot(), "off")).toEqual({ findings: [plain()], keep: [] });
  });
  test("卡自己正占着列车：三种开关都照原样报", async () => {
    card("B", NOW - 70 * MIN, true); run("B", "await_ci", NOW - 70 * MIN);
    const s = await snapshot();
    expect(s.mergeTrain?.active.map((r) => r.taskId)).toEqual(["B"]);
    const own = plain(70, NOW - 70 * MIN, `正式合并门：引擎合并 i-B-${NOW - 70 * MIN} 正在 await_ci，沿用由引擎自己做`); // 台账合并门自己认得这条记录
    for (const mode of MODES) expect(ready(s, mode)).toEqual({ findings: [own], keep: [] });
  });
  test("列车事实缺失（没有 scheduler_merges 表 / 快照没带）：三种开关都照原样报", async () => {
    card("A", NOW - 10 * MIN, false); card("B", NOW - 70 * MIN, true); run("A", "ready", NOW - 10 * MIN);
    const { mergeTrain: _drop, ...bare } = await snapshot();
    for (const mode of MODES) expect(ready(bare, mode)).toEqual({ findings: [plain()], keep: [] });
    db.run("DROP TABLE scheduler_merges");
    const s = await snapshot();
    expect(s.mergeTrain).toBeUndefined();
    for (const mode of MODES) expect(ready(s, mode)).toEqual({ findings: [plain()], keep: [] });
  });
  test("策略读取抛错：照原样报", async () => {
    card("A", NOW - 10 * MIN, false); card("B", NOW - 70 * MIN, true); run("A", "ready", NOW - 10 * MIN);
    const broken: RecoveryPolicyPort = (p, k) => { if (k === "auditTrainQueue") throw new Error("读不了"); return policy("on")(p, k); };
    expect(of("merge_ready_idle", await snapshot(), broken)).toEqual({ findings: [plain()], keep: [] });
  });
  test("列车空着：observe 不从空出起算（与改前一致）；on 从最近一次空出起算", async () => {
    card("A", NOW - 10 * MIN, false); card("B", NOW - 3 * 60 * MIN, true);
    land(run("A", "ready", NOW - 2 * 60 * MIN), NOW - 30 * MIN);
    const s = await snapshot();
    expect(ready(s, "observe")).toEqual({ findings: [plain(180, NOW - 3 * 60 * MIN)], keep: [] });
    expect(ready(s, "on")).toEqual({ findings: [], keep: [key()] }); // 空出才 30 分钟：重新计时
  });
  test("同一快照里 ship_stalled 的结果不变", async () => {
    card("A", NOW - 10 * MIN, false); card("B", NOW - 70 * MIN, true); run("A", "ready", NOW - 10 * MIN);
    const s = await snapshot();
    const SHIP_KEY = `p|ship_stalled|B|merge|${NOW - 70 * MIN}`;
    const SHIP = { taskId: "B", since: NOW - 70 * MIN, detail: "B 在 merge 已 70 分钟 没推进", suggestion: "补做合并部署，做完推阶段", key: SHIP_KEY };
    expect(of("ship_stalled", s, policy("off"))).toEqual({ findings: [SHIP], keep: [] });
    expect(of("ship_stalled", s, policy("observe"))).toEqual({ findings: [{ ...SHIP, detail: `${SHIP.detail}（排队中：列车在合 A，ready）` }], keep: [] });
    expect(of("ship_stalled", s, policy("on"))).toEqual({ findings: [], keep: [SHIP_KEY] });
  });
});
