/**
 * dispatch-recovery-AUDTRAIN4：merge_ready_idle（与 ship_stalled 共用 trainSlots）也认 PM 的人工合入登记（`ledger manual-merge-record`）。
 * 夹具是临时目录真台账库 + 真取数（collectAuditSnapshots，gh 用假的）+ 真规则（auditLedger）；登记走真命令（runLedger）。
 * 「基线」= 同一份快照去掉列车事实再跑（off 的原路径）。ship_stalled 与入口本身在 ledger-audit-train-manual-merged.test.ts。
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
import type { MergeTrainInputs } from "../src/lib/ledger-audit-train.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { Run } from "../src/lib/review-main-carry-manual-ci.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { baselineAudit } from "./ledger-test-helpers.js";

const MIN = 60_000, NOW = 100_000 * MIN, P = "p", H = "a".repeat(40), PR = "https://github.com/o/r/pull/1";
const MODES: readonly RecoveryMode[] = ["off", "observe", "on"];
type Snap = AuditSnapshot & MergeReadyInputs & MergeTrainInputs;
const QUEUED = "列车排队中，等列车轮到它；列车本身停滞看 ship_stalled";

let db: Database, dir: string, report: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-audit-train-manual-merged-ready-"));
  mkdirSync(statePath("ledger", "reviews"), { recursive: true });
  report = join(mkdtempSync(join(statePath("ledger", "reviews"), "audtrain4-")), "r.md");
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
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr=? WHERE id=?").run(H, PR, id);
  if (pass) insertEvent(db, { actor: "rv", now: at - MIN }, { project: P, target: id, kind: "review", text: "", data: { round: 1, head: H, verdict: "pass",
    reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", path: report, findings: [], p0: 0, p1: 0, p2: 0 } }, false);
  insertEvent(db, { actor: "pm", now: at }, { project: P, target: id, kind: "stage", text: "", data: { from: "review", to: "merge" } }, false);
}
function journal(taskId: string, phase: string, at: number): string {
  const intentId = `m-${taskId}-${at}`;
  db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, ?, ?, 'pr', 'b', ?, 'ci', ?, ?, ?)`).run(intentId, taskId, P, H, phase, at, at);
  return intentId;
}
const slot = (taskId: string, intentId: string) => db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES (?,?,?,?,0)")
  .run(P, `merge:${P}`, taskId, intentId);
/** 真命令登记；登记时刻在进 merge 之后不久，不把 merge_ready_idle 的 60 分钟计时推回阈值内 */
const record = async (id: string, over: Record<string, string> = {}) => {
  const f: Record<string, string> = { head: H, "merge-sha": "d".repeat(40), pr: PR, base: "main", "main-head": "1".repeat(40), receipt: "reviews/private-merge.md", ...over };
  const r = await runLedger(["manual-merge-record", id, ...Object.entries(f).flatMap(([k, v]) => [`--${k}`, v])], { db, actor: "agent-pm", projectIds: [P],
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => NOW - 65 * MIN });
  expect(r).toMatchObject({ ok: true });
};

const snapshot = async (now = NOW): Promise<Snap> => (await collectAuditSnapshots(db, [P], now, sources()))[0] as Snap;
const base = (s: Snap, mode: RecoveryMode) => { const { mergeTrain: _m, trainFacts: _f, ...rest } = s; return auditLedger(rest, NOW, policy(mode)); };
const idle = (s: Snap, mode: RecoveryMode, id = "B") => {
  const r = auditLedger(s, NOW, policy(mode));
  return { findings: r.findings.filter((f) => f.rule === "merge_ready_idle" && f.taskId === id), keep: r.keep.filter((k) => k.includes("|merge_ready_idle|")) };
};

describe("[验收线 1] merge_ready_idle：私仓人工合入等部署的 B 不被判成排队压掉，A 真实持槽", () => {
  beforeEach(() => {
    card("A", NOW - 10 * MIN, false);
    card("B", NOW - 70 * MIN, true);
    slot("A", journal("A", "await_ci", NOW - 10 * MIN));
  });
  test("登记前 observe 写排队中、on 压掉；登记后 observe 不写排队、on 照报，三种模式与基线逐字一致", async () => {
    const before = await snapshot();
    expect(idle(before, "observe").findings[0]!.detail).toContain("排队中：列车在合 A，await_ci");
    expect(idle(before, "on").findings).toEqual([]);
    await record("B");
    const s = await snapshot();
    expect(s.trainFacts?.cards.B?.merged).toBe(true);
    const [f] = idle(s, "observe").findings;
    expect(f!.detail).not.toContain("排队中"); // 先红：旧实现只认 scheduler_merges，B 仍被标排队
    expect(f!.suggestion).not.toBe(QUEUED);
    expect(idle(s, "on")).toEqual({ findings: [expect.objectContaining({ taskId: "B" })], keep: [] });
    for (const mode of MODES) expect(auditLedger(s, NOW, policy(mode))).toEqual(base(s, mode));
  });
  test("[验收线 2] 无效登记（旧 head 的事实）不豁免：仍写排队中", async () => {
    await record("B");
    db.query("UPDATE tasks SET headSHA = ? WHERE id = 'B'").run("b".repeat(40));
    const s = await snapshot();
    expect(s.trainFacts?.cards.B?.merged).toBe(false);
    expect(idle(s, "on").findings).toEqual([]);
  });
});

describe("[验收线 2] merge_ready_idle：B 持槽且有效登记，未合并的 C 仍等待", () => {
  test("C 的实际阻塞写 B 已合并、在等部署；B 自身照报", async () => {
    card("B", NOW - 70 * MIN, true);
    card("C", NOW - 70 * MIN, true);
    slot("B", journal("B", "await_ci", NOW - 69 * MIN));
    db.query("UPDATE scheduler_merges SET reviewedHead = ? WHERE taskId = 'B'").run("9".repeat(40)); // 记录是旧 head 的：只有登记能让 B 当前 head 算合并
    await record("B");
    const s = await snapshot();
    expect(idle(s, "observe", "C").findings[0]!.detail).toContain("排队中：合并槽在 B，它已合并、在等部署");
    expect(idle(s, "observe", "B").findings[0]!.detail).not.toContain("排队中");
    expect(idle(s, "on", "C").findings).toEqual([]);
    expect(idle(s, "on", "B").findings).toHaveLength(1);
  });
});
