/**
 * dispatch-recovery-AUDTRAIN3：merge_ready_idle（AUDTRAIN2 复用的 trainSlots）只把真正等合并槽的卡当排队（src/lib/ledger-audit-train.ts）。
 * 夹具是临时目录真台账库 + 真取数（collectAuditSnapshots，gh 用假的）+ 真规则（auditLedger）；合并槽 = scheduler_resources merge:p。
 * 「基线」= 同一份快照去掉列车事实再跑（off 的原路径）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditFinding, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectMergeCi, mergeBlockersOf, MERGE_READY_RULES, type MergeReadyInputs } from "../src/lib/ledger-audit-merge-ready.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { reconcileFindings } from "../src/lib/ledger-audit-store.js";
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
const QUEUED = "列车排队中，等列车轮到它；列车本身停滞看 ship_stalled";

let db: Database, dir: string, report: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-merge-ready-train-recovery-"));
  mkdirSync(statePath("ledger", "reviews"), { recursive: true });
  report = join(mkdtempSync(join(statePath("ledger", "reviews"), "audtrain3-")), "r.md");
  writeFileSync(report, `审查 head ${H.slice(0, 12)}：PASS\n`);
  db = openLedger(join(dir, "ledger.sqlite"));
  db.run("PRAGMA foreign_keys = OFF"); // 夹具直接写合并槽 / 记录
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm"] });
  baselineAudit(db, P);
  reconcileFindings(db, P, [], [...MERGE_READY_RULES], 0);
});
afterEach(() => { closeLedger(join(dir, "ledger.sqlite")); for (const d of [dir, join(report, "..")]) rmSync(d, { recursive: true, force: true }); });

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
const policy = (mode: RecoveryMode): RecoveryPolicyPort => (_p, key) => ({ mode: key === "auditTrainQueue" ? mode : "observe", manualAfterMs: null, source: "config" });

/** 卡 id 在 at 时刻进 merge；pass = 有本轮有效 PASS（merge_ready_idle 才看它） */
function card(id: string, at: number, pass: boolean): void {
  createTask(db, { actor: "owner", now: 0 }, { project: P, id, title: id, kind: "code", agent: "agent-x", pm: "agent-pm" });
  setWorkflow(db, { actor: "owner", now: 0 }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude",
    fallback: "人工", reason: "pm_takeover: 测试" });
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr='https://github.com/o/r/pull/1' WHERE id=?").run(H, id);
  if (pass) insertEvent(db, { actor: "rv", now: at - MIN }, { project: P, target: id, kind: "review", text: "", data: { round: 1, head: H, verdict: "pass",
    reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: report, findings: [], p0: 0, p1: 0, p2: 0 } }, false);
  insertEvent(db, { actor: "pm", now: at }, { project: P, target: id, kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
}
function journal(taskId: string, phase: string, at: number, reviewed = H): string {
  const intentId = `m-${taskId}-${at}`;
  db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, ?, ?, 'pr', 'b', ?, 'ci', ?, ?, ?)`).run(intentId, taskId, P, reviewed, phase, at, at);
  return intentId;
}
const slot = (taskId: string, intentId: string) => db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES (?,?,?,?,0)")
  .run(P, `merge:${P}`, taskId, intentId);

const snapshot = async (now = NOW): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, sources()))[0] as Snap;
const base = (s: Snap, mode: RecoveryMode) => { const { mergeTrain: _m, trainFacts: _f, ...rest } = s; return auditLedger(rest, NOW, policy(mode)); };
const idle = (s: Snap, mode: RecoveryMode) => {
  const r = auditLedger(s, NOW, policy(mode));
  return { findings: r.findings.filter((f) => f.rule === "merge_ready_idle" && f.taskId === "B"), keep: r.keep.filter((k) => k.includes("|merge_ready_idle|")) };
};
/** 把 observe 的排队分支换回原样：去掉「排队中…」阻塞项、建议改回基线（只用来比对其余文字逐字一致） */
const unqueue = (fs: readonly AuditFinding[], was: readonly AuditFinding[]) => fs.map((f) => {
  if (!f.detail.includes("排队中：")) return f;
  return { ...f, detail: f.detail.replace(/实际阻塞：(.*?)；?排队中：[^；]*；mainCarry/, (_m, b: string) => `实际阻塞：${b || "台账合并门全过（台账外的测量输入等不可核实）"}；mainCarry`),
    suggestion: was.find((w) => w.key === f.key)?.suggestion ?? f.suggestion };
});

describe("[验收线 1] merge_ready_idle：已合并等部署的 B 不被判成排队压掉", () => {
  beforeEach(() => {
    card("A", NOW - 10 * MIN, false);
    card("B", NOW - 70 * MIN, true);
    journal("B", "merged", NOW - 65 * MIN);
  });
  const check = async () => {
    const s = await snapshot();
    expect(s.trainFacts?.cards.B?.merged).toBe(true);
    const obs = idle(s, "observe").findings;
    expect(obs).toHaveLength(1);
    expect(obs[0]!.detail).not.toContain("排队中"); // 先红：旧判定只看 active，B 被 A 的记录标成排队
    expect(obs[0]!.suggestion).not.toBe(QUEUED);
    expect(idle(s, "on")).toEqual({ findings: [expect.objectContaining({ taskId: "B" })], keep: [] });
    for (const mode of MODES) expect(auditLedger(s, NOW, policy(mode))).toEqual(base(s, mode));
  };
  test("B 已释放槽，A 的意图持槽在 ready", async () => {
    slot("A", journal("A", "ready", NOW - 10 * MIN));
    await check();
  });
  test("B 自己为部署持槽，A 另有残留 ready", async () => {
    slot("B", "m-B-" + (NOW - 65 * MIN));
    journal("A", "ready", NOW - 10 * MIN);
    await check();
  });
});

describe("[验收线 3] merge_ready_idle：B 自身 ready 等槽，A 真实持槽", () => {
  beforeEach(() => {
    card("A", NOW - 10 * MIN, false);
    card("B", NOW - 70 * MIN, true);
    journal("B", "ready", NOW - 65 * MIN);
    slot("A", journal("A", "await_ci", NOW - 10 * MIN));
  });
  test("observe 写排队中、建议等列车；on 不报、keep 住原 key", async () => {
    const s = await snapshot();
    const [f] = idle(s, "observe").findings;
    expect(f!.detail).toContain("排队中：列车在合 A，await_ci；mainCarry="); // 先红：旧实现因 B 自身在 active 直接按原规则
    expect(f!.suggestion).toBe(QUEUED);
    expect(idle(s, "on")).toEqual({ findings: [], keep: [f!.key] });
  });
  test("[验收线 5] off 完整输出逐字一致；observe 除排队标注和既有排队建议分支外逐字一致", async () => {
    const s = await snapshot();
    expect(auditLedger(s, NOW, policy("off"))).toEqual(base(s, "off"));
    const obs = auditLedger(s, NOW, policy("observe")), was = base(s, "observe");
    const ship = (fs: readonly AuditFinding[]) => fs.map((f) => (f.rule === "ship_stalled" ? { ...f, detail: f.detail.replace(/（排队中：[^）]*）$/, "") } : f));
    expect({ ...obs, findings: ship(unqueue(obs.findings, was.findings)) }).toEqual(was);
  });
});

describe("[验收线 6] 失败降级：槽事实缺失时 observe / on 与 off 逐字一致", () => {
  beforeEach(() => {
    card("A", NOW - 10 * MIN, false);
    card("B", NOW - 70 * MIN, true);
    slot("A", journal("A", "ready", NOW - 10 * MIN));
  });
  const same = (s: Snap) => {
    const off = auditLedger(s, NOW, policy("off"));
    for (const mode of ["observe", "on"] as const) expect(auditLedger(s, NOW, policy(mode))).toEqual(off);
    expect(idle(s, "on").findings[0]!.detail).not.toContain("排队中");
  };
  test("缺 scheduler_resources 表", async () => {
    db.run("DROP TABLE scheduler_resources");
    same(await snapshot());
  });
  test("快照没带槽事实", async () => {
    const { trainFacts: _drop, ...s } = await snapshot();
    same(s);
  });
  test("策略读取抛错", async () => {
    const s = await snapshot();
    const broken: RecoveryPolicyPort = (p, key) => { if (key === "auditTrainQueue") throw new Error("读不了"); return policy("observe")(p, key); };
    expect(auditLedger(s, NOW, broken)).toEqual(auditLedger(s, NOW, policy("off")));
  });
});
