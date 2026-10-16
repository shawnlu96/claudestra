/**
 * merge-arch-AUDTRAIN5：foreign_repo 的卡不参加项目合并列车，巡检不给它标「排队中」（src/lib/ledger-audit-train.ts）。
 * 夹具是临时目录真台账库 + 真取数（collectAuditSnapshots，gh 用假的）+ 真规则（auditLedger）；项目仓库走注入查询（setForeignRepoLookupForTest），
 * 不访问真实仓库或生产台账。「基线」= 同一份快照去掉列车事实再跑（off 的原路径）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectMergeCi, mergeBlockersOf, MERGE_READY_RULES, type MergeReadyInputs } from "../src/lib/ledger-audit-merge-ready.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { readAuditTrain, trainSlots, type MergeTrainInputs } from "../src/lib/ledger-audit-train.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { Run } from "../src/lib/review-main-carry-manual-ci.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { baselineAudit } from "./ledger-test-helpers.js";

const MIN = 60_000, NOW = 100_000 * MIN, P = "p", H = "a".repeat(40), REPO = "o/r";
const OWN_PR = (n: number) => `https://github.com/o/r/pull/${n}`, FOREIGN_PR = "https://github.com/x/priv/pull/2";
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
const PLAIN = { parked: false, freedAt: null, note: "" };
type Snap = AuditSnapshot & MergeReadyInputs & MergeTrainInputs;

let db: Database, dir: string, report: string, lookups: string[], repoOf: (project: string) => string | null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-train-foreign-repo-"));
  mkdirSync(statePath("ledger", "reviews"), { recursive: true });
  report = join(mkdtempSync(join(statePath("ledger", "reviews"), "audtrain5-")), "r.md");
  writeFileSync(report, `审查 head ${H.slice(0, 12)}：PASS\n`);
  db = openLedger(join(dir, "ledger.sqlite"));
  db.run("PRAGMA foreign_keys = OFF"); // 夹具直接写合并槽 / 记录
  setMeta(db, { actor: "owner", now: 0 }, { project: P, key: "pms", value: ["agent-pm"] });
  baselineAudit(db, P);
  reconcileFindings(db, P, [], [...MERGE_READY_RULES], 0);
  lookups = [];
  repoOf = () => REPO;
  setForeignRepoLookupForTest({ project: (p) => { lookups.push(p); return repoOf(p); } });
});
afterEach(() => {
  setForeignRepoLookupForTest({ project: null });
  closeLedger(join(dir, "ledger.sqlite"));
  for (const d of [dir, join(report, "..")]) rmSync(d, { recursive: true, force: true });
});

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
const policy = (mode: RecoveryMode, priv: RecoveryMode = "observe"): RecoveryPolicyPort => (_p, key) =>
  ({ mode: key === "auditTrainQueue" ? mode : key === "privateRepoMerge" ? priv : "observe", manualAfterMs: null, source: "config" });

/** 卡 id 在 at 时刻进 merge，带本轮有效 PASS；pr = 卡的 PR（null = 只靠 extra.repo） */
function card(id: string, at: number, pr: string | null, extra: Record<string, unknown> = {}): void {
  createTask(db, { actor: "owner", now: 0 }, { project: P, id, title: id, kind: "code", agent: "agent-x", pm: "agent-pm" });
  setWorkflow(db, { actor: "owner", now: 0 }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude",
    fallback: "人工", reason: "pm_takeover: 测试" });
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr=?, extra=? WHERE id=?").run(H, pr, JSON.stringify(extra), id);
  insertEvent(db, { actor: "rv", now: at - MIN }, { project: P, target: id, kind: "review", text: "", data: { round: 1, head: H, verdict: "pass",
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
const slotOf = (s: Snap, mode: RecoveryMode, id = "B", priv: RecoveryMode = "observe") =>
  trainSlots(s, policy(mode, priv))(s.tasks.find((t) => t.task.id === id)!.task);
const rules = (s: Snap, mode: RecoveryMode, id = "B", priv: RecoveryMode = "observe") => {
  const r = auditLedger(s, NOW, policy(mode, priv));
  return { findings: r.findings.filter((f) => f.taskId === id && (f.rule === "ship_stalled" || f.rule === "merge_ready_idle")),
    keep: r.keep.filter((k) => k.includes(`|${id}|`)) };
};
const ofBase = (s: Snap, mode: RecoveryMode, id = "B") => base(s, mode).findings.filter((f) => f.taskId === id);
const plain = (id: string, mins: number) => `${id} 在 merge 已 ${mins} 分钟 没推进`;
const eventCount = () => (db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

/** A（项目仓库）真实持槽 await_ci；B 在 70 分钟前进 merge，两条规则都过阈值 */
const holdA = () => { card("A", NOW - 10 * MIN, OWN_PR(1)); slot("A", journal("A", "await_ci", NOW - 10 * MIN)); };

describe("[验收线 1] foreign_repo 的 B：A 持项目槽、B 自身未合并", () => {
  /** 没有 PR 的卡取不到 head CI，merge_ready_idle 本就不看它 */
  const variants: [string, () => void, string[]][] = [
    ["PR 在别的仓库", () => card("B", NOW - 70 * MIN, FOREIGN_PR), ["merge_ready_idle", "ship_stalled"]],
    ["没有 PR、extra.repo 在别的仓库", () => card("B", NOW - 70 * MIN, null, { repo: "x/priv" }), ["ship_stalled"]],
  ];
  for (const [name, mk, want] of variants) for (const phase of [null, "ready", "await_ci"] as const) {
    test(`${name}，B 记录 ${phase ?? "无"}：observe / on 都是完整 PLAIN，照原规则报`, async () => {
      holdA();
      mk();
      if (phase) journal("B", phase, NOW - 69 * MIN);
      const s = await snapshot();
      expect(s.projectRepo).toBe(REPO);
      for (const mode of ["observe", "on"] as const) {
        expect(slotOf(s, mode)).toEqual(PLAIN); // 先红：旧实现 observe 带排队说明、on parked
        const r = rules(s, mode);
        expect(r.findings.map((f): string => f.rule).sort()).toEqual(want);
        expect(r.findings.some((f) => f.detail.includes("排队中") || f.suggestion.includes("排队"))).toBe(false);
        expect(r.findings.every((f) => f.since === NOW - 70 * MIN)).toBe(true); // 不因列车延后起算
        expect(r.findings).toEqual(ofBase(s, mode));
        expect(r.keep).toEqual([]); // 不因列车静音
      }
      expect(rules(s, "observe").findings.find((f) => f.rule === "ship_stalled")?.detail).toBe(plain("B", 70));
    });
  }
});

describe("[验收线 2] 同一夹具换成项目仓库：原规则不变", () => {
  test("仓库是项目仓库（大小写不同也算同仓）：observe 标排队、on parked", async () => {
    holdA();
    card("B", NOW - 70 * MIN, "https://github.com/O/R/pull/2");
    journal("B", "ready", NOW - 69 * MIN);
    const s = await snapshot();
    expect(slotOf(s, "observe")).toEqual({ ...PLAIN, note: "（排队中：列车在合 A，await_ci）" });
    expect(slotOf(s, "on")).toEqual({ ...PLAIN, parked: true });
    expect(rules(s, "observe").findings.find((f) => f.rule === "ship_stalled")?.detail).toBe(`${plain("B", 70)}（排队中：列车在合 A，await_ci）`);
    expect(rules(s, "on").findings).toEqual([]);
  });
  test("无人持槽：on 从列车最近一次空出起算", async () => {
    card("A", NOW - 10 * MIN, OWN_PR(1));
    journal("A", "resolved", NOW - 20 * MIN);
    card("B", NOW - 70 * MIN, OWN_PR(2));
    const s = await snapshot();
    expect(slotOf(s, "on")).toEqual({ ...PLAIN, freedAt: NOW - 20 * MIN });
    expect(slotOf(s, "observe")).toEqual(PLAIN);
  });
  test("自己持槽、当前 head 已合并：PLAIN", async () => {
    card("B", NOW - 70 * MIN, OWN_PR(2));
    slot("B", journal("B", "await_ci", NOW - 69 * MIN));
    let s = await snapshot();
    for (const mode of MODES) expect(slotOf(s, mode)).toEqual(PLAIN);
    db.run("DELETE FROM scheduler_resources");
    holdA();
    journal("B", "merged", NOW - 5 * MIN);
    s = await snapshot();
    for (const mode of MODES) expect(slotOf(s, mode)).toEqual(PLAIN);
  });
});

describe("[验收线 3] foreign 私仓卡：privateRepoMerge 三档都不归入项目列车", () => {
  for (const priv of MODES) {
    test(`privateRepoMerge=${priv}：私仓接管（自身 ready / await_ci 记录）也是 PLAIN，巡检不写私仓事件`, async () => {
      holdA();
      card("B", NOW - 70 * MIN, FOREIGN_PR);
      card("C", NOW - 70 * MIN, "https://github.com/x/priv/pull/3"); // 同私仓的另一张卡：私仓串行等待
      journal("B", "await_ci", NOW - 69 * MIN);
      journal("C", "ready", NOW - 69 * MIN);
      const s = await snapshot();
      const before = eventCount();
      for (const mode of ["observe", "on"] as const) for (const id of ["B", "C"]) {
        expect(slotOf(s, mode, id, priv)).toEqual(PLAIN);
        const r = rules(s, mode, id, priv);
        expect(r.findings.some((f) => f.detail.includes("排队中"))).toBe(false);
        expect(r.findings).toEqual(ofBase(s, mode, id));
      }
      expect(eventCount()).toBe(before); // 不触发私仓合并 / 不新增私仓观察事件
      expect(db.query("SELECT COUNT(*) AS n FROM events WHERE kind LIKE '%recovery%' OR text LIKE '%privateRepoMerge%'").get()).toEqual({ n: 0 });
    });
  }
});

describe("[验收线 4] 取数接线：readAuditTrain → 快照 → 巡检", () => {
  beforeEach(() => { holdA(); card("B", NOW - 70 * MIN, FOREIGN_PR); });
  test("每项目读一次项目仓库，沿快照带给巡检", async () => {
    const s = await snapshot();
    expect(lookups).toEqual([P]);
    expect(s.projectRepo).toBe(REPO);
    expect(readAuditTrain(db, P, s.tasks).projectRepo).toBe(REPO);
  });
  test("项目仓库未知：不猜 foreign，照原规则标排队", async () => {
    repoOf = () => null;
    const s = await snapshot();
    expect(s.projectRepo).toBeNull();
    expect(slotOf(s, "observe").note).toBe("（排队中：列车在合 A，await_ci）");
    expect(slotOf(s, "on").parked).toBe(true);
  });
  test("仓库查询抛错：按未知，列车与槽事实照常可用", async () => {
    repoOf = () => { throw new Error("git 读不了"); };
    const s = await snapshot();
    expect(s.mergeTrain).toBeDefined();
    expect(s.trainFacts?.holder?.taskId).toBe("A");
    expect(s.projectRepo).toBeNull();
    expect(slotOf(s, "on").parked).toBe(true);
  });
  test("缺列车事实：不读仓库，按 off", async () => {
    db.run("DROP TABLE scheduler_resources");
    const s = await snapshot();
    expect(s.trainFacts).toBeUndefined();
    expect(s.projectRepo).toBeUndefined();
    expect(lookups).toEqual([]);
    for (const mode of MODES) expect(auditLedger(s, NOW, policy(mode))).toEqual(auditLedger(s, NOW, policy("off")));
  });
  test("auditTrainQueue=off：完整输出与基线逐字一致", async () => {
    const s = await snapshot();
    expect(auditLedger(s, NOW, policy("off"))).toEqual(base(s, "off"));
  });
});

describe("[验收线 5] observe 照既有规则记录，既有豁免仍有效", () => {
  test("foreign 卡过阈值照报两条规则；同项目排队卡记录不变", async () => {
    holdA();
    card("B", NOW - 70 * MIN, FOREIGN_PR);
    card("C", NOW - 70 * MIN, OWN_PR(3));
    const s = await snapshot();
    expect(rules(s, "observe").findings.map((f) => f.rule).sort()).toEqual(["merge_ready_idle", "ship_stalled"]);
    expect(rules(s, "observe", "C").findings.every((f) => f.detail.includes("排队中：列车在合 A，await_ci"))).toBe(true);
    expect(rules(s, "on", "C").findings).toEqual([]);
  });
  test("队列冻结：foreign 卡仍按冻结不报 ship_stalled，与基线一致", async () => {
    holdA();
    card("B", NOW - 70 * MIN, FOREIGN_PR);
    setFrozen(db, { actor: "owner", now: NOW - 80 * MIN }, { project: P, frozen: true, reason: "测试" });
    const s = await snapshot();
    for (const mode of MODES) {
      expect(rules(s, mode).findings.filter((f) => f.rule === "ship_stalled")).toEqual([]);
      expect(rules(s, mode).findings).toEqual(ofBase(s, mode));
    }
  });
});
