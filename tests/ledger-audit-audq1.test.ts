/**
 * AUDQ-1：巡检三处误报 / 重复推送 + manual 卡交付后推 PM。
 * merge_ready_idle 只因 note 推后计时不重推；终态卡不报 manual_*；registry stopped 的执行者不报孤儿 / 回收；manual_deliver_no_review 推 PM。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger, type AuditAgent, type AuditRule, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import type { MergeCiFact, MergeReadyInputs } from "../src/lib/ledger-audit-merge-ready.js";
import { ackFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import type { EventKind, LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const MIN = 60_000, NOW = 50_000 * MIN, PM = "agent-pm", DISPATCH = "agent-pm-dispatch", EXE = "agent-task-q1";
const H = "d".repeat(40), H2 = "e".repeat(40);
let seq = 0;
const ev = (ts: number, kind: EventKind, data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "x", project: "p", target: "Q1", kind, text: "", data, dedupKey: null });
const mkTask = (stage: Stage, over: Partial<LedgerTask> = {}): LedgerTask => ({ id: "Q1", project: "p", itemId: null, title: "Q1", kind: "code", stage,
  stageBefore: null, round: 1, agent: EXE, pm: PM, branch: "b", pr: "https://github.com/o/r/pull/9", headSHA: H, spec: null, specRev: 1,
  model: null, rev: 1, extra: {}, createdAt: 0, updatedAt: 0, assigneeKind: "agent", assignee: EXE, ...over });
const pass = (head: string, at: number) => ev(at, "review", { round: 1, head, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "s",
  reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 });
const agent = (name: string, over: Partial<AuditAgent> = {}): AuditAgent =>
  ({ name, projectId: "p", windowAlive: true, turn: "idle", lastWriteAt: null, startedAt: 0, ...over });
const base = (tasks: AuditSnapshot["tasks"], over: Partial<AuditSnapshot & MergeReadyInputs> = {}): AuditSnapshot & MergeReadyInputs =>
  ({ project: "p", pms: [PM, DISPATCH], tasks, agents: [agent(PM)], reviewers: [], held: [], ownerInbox: [], ...over });
const observe: RecoveryPolicyPort = () => ({ mode: "observe", manualAfterMs: null, source: "config" });
const rule = (s: AuditSnapshot, r: AuditRule, now = NOW) => auditLedger(s, now, observe).findings.filter((f) => f.rule === r);

describe("验收 1：merge_ready_idle 只追加 note 不重推", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const ci = (head = H): MergeCiFact => ({ head, state: "green", source: "live", checkedAt: NOW, blockers: [] });
  const at = NOW - 30 * MIN;
  /** 同一份历史（seq 固定）：PASS 后 at 时进 merge；extra 追加在后面 */
  const history = [ev(0, "task", { op: "new" }), pass(H, at - MIN), ev(at, "stage", { from: "review", to: "merge" })];
  const card = (extra: LedgerEvent[] = [], head = H) => ({ task: mkTask("merge", { headSHA: head }), events: [...history, ...extra] });

  test("已推过一次后 PM 记 note，超过阈值同一事实不再推；head 变 / 新审查结论 → 新 key 再推", () => {
    const dir = mkdtempSync(join(tmpdir(), "audq1-")), path = join(dir, "ledger.sqlite");
    dirs.push(dir);
    const db = openLedger(path);
    try {
      const round = (s: AuditSnapshot, now: number) => {
        const r = auditLedger(s, now, observe);
        const out = reconcileFindings(db, "p", r.findings, r.evaluated, now, { keep: r.keep });
        const pushed = out.pending.filter((f) => f.rule === "merge_ready_idle");
        ackFindings(db, pushed.map((f) => f.key), now);
        return pushed.map((f) => f.key);
      };
      expect(round(base([card()], { mergeCi: { Q1: ci() } }), NOW)).toEqual([]); // 首轮：建基线，还没满 60 分钟
      const first = round(base([card()], { mergeCi: { Q1: ci() } }), NOW + 31 * MIN);
      expect(first).toEqual([expect.stringContaining(H)]);
      const note = ev(NOW + 32 * MIN, "note");
      // note 推后计时：这一轮判不满阈值，但 key 保持打开，不标已解决
      expect(round(base([card([note])], { mergeCi: { Q1: ci() } }), NOW + 40 * MIN)).toEqual([]);
      expect(db.query("SELECT resolvedAt FROM audit_findings WHERE key = ?").get(first[0]!)).toEqual({ resolvedAt: null });
      // 再过阈值：同卡同 head 同审查 = 同一条，不推第二次
      expect(round(base([card([note])], { mergeCi: { Q1: ci() } }), NOW + 95 * MIN)).toEqual([]);
      // 对照：新审查结论（同 head）→ 新 key
      const again = round(base([card([note, pass(H, NOW + 96 * MIN)])], { mergeCi: { Q1: ci() } }), NOW + 160 * MIN);
      expect(again).toHaveLength(1);
      expect(again[0]).not.toBe(first[0]);
      // 对照：head 变了 → 新 key
      const moved = round(base([card([note, pass(H2, NOW + 161 * MIN)], H2)], { mergeCi: { Q1: ci(H2) } }), NOW + 230 * MIN);
      expect(moved).toEqual([expect.stringContaining(H2)]);
    } finally { closeLedger(path); }
  });
});

describe("验收 2：终态卡不报 manual_*", () => {
  const manual = (stage: Stage, reason: boolean) => ({ task: mkTask(stage), events: [ev(0, "task", { op: "new" }), ev(MIN, "stage", { to: stage }),
    ev(2 * MIN, "scheduler", { op: "workflow", mode: "manual", ...(reason ? { manualReason: { v: 1, code: "merge_unknown", label: "m", text: "t",
      blocking: null, release: "resolve", node: "PM", approval: false, specRev: 1, head: H, uiDigest: null } } : {}) })] });
  test("verified / done / cancelled：manual_would_resume 与 manual_reason_missing 都不报；live 照报（对照）", () => {
    for (const stage of ["verified", "done", "cancelled"] as Stage[]) {
      expect(rule(base([manual(stage, true)], { mergeUnknown: [] }), "manual_would_resume")).toEqual([]);
      expect(rule(base([manual(stage, false)]), "manual_reason_missing")).toEqual([]);
    }
    expect(rule(base([manual("live", true)], { mergeUnknown: [] }), "manual_would_resume")).toHaveLength(1);
    expect(rule(base([manual("live", false)]), "manual_reason_missing")).toHaveLength(1);
  });
});

describe("验收 3：registry stopped 的执行者不报孤儿 / 回收", () => {
  const ended = { task: mkTask("done"), events: [ev(0, "task", { op: "new" }), ev(NOW - 60 * MIN, "stage", { to: "done" })] };
  test("stopped 墓碑：无任务不报 orphan_executor，任务已结束窗口还在也不报 reclaim_executor", () => {
    expect(rule(base([], { agents: [agent(PM), agent("agent-task-old", { status: "stopped" })] }), "orphan_executor")).toEqual([]);
    expect(rule(base([ended], { agents: [agent(PM), agent(EXE, { status: "stopped" })] }), "reclaim_executor")).toEqual([]);
  });
  test("负例：active 且无任务照报 orphan_executor；active 任务结束照报 reclaim_executor", () => {
    expect(rule(base([], { agents: [agent(PM), agent("agent-task-old", { status: "active" })] }), "orphan_executor")).toHaveLength(1);
    expect(rule(base([ended], { agents: [agent(PM), agent(EXE, { status: "active" })] }), "reclaim_executor")).toHaveLength(1);
  });
});

describe("验收 5：manual 卡交付后没审查 → manual_deliver_no_review 推 PM", () => {
  const delivered = (stage: Stage, extra: LedgerEvent[] = [], at = NOW - 40 * MIN) => {
    const d = ev(at, "deliver", { round: 1, headSHA: H, evidence: "e.md" });
    return { task: mkTask(stage), events: [ev(0, "task", { op: "new" }), ev(at - 5 * MIN, "stage", { to: stage }), d, ...extra], workflowMode: "manual" as const };
  };
  test("manual + CLI deliver + 无 review 超阈值 → 报 PM（不进调度助理），key 绑这次交付", () => {
    const f = rule(base([delivered("review")]), "manual_deliver_no_review");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ taskId: "Q1", notify: PM });
    expect(rule(base([{ ...delivered("fix"), workflowMode: null }]), "manual_deliver_no_review")).toHaveLength(1); // 没有 workflow 同 manual
  });
  test("同一次交付只推一次：再跑一轮 key 不变", () => {
    const c = delivered("review");
    expect(rule(base([c]), "manual_deliver_no_review", NOW + 30 * MIN)[0]!.key).toBe(rule(base([c]), "manual_deliver_no_review")[0]!.key);
  });
  test("auto 卡 / 交付后已有 review / 阈值内 / 已推进到 merge → 不报", () => {
    expect(rule(base([{ ...delivered("review"), workflowMode: "auto" }]), "manual_deliver_no_review")).toEqual([]);
    const reviewed = delivered("review");
    reviewed.events.push(ev(NOW - 10 * MIN, "review", { verdict: "changes" })); // 交付之后（seq 更大）的审查结论
    expect(rule(base([reviewed]), "manual_deliver_no_review")).toEqual([]);
    expect(rule(base([delivered("review", [], NOW - 10 * MIN + 1)]), "manual_deliver_no_review")).toEqual([]); // RVF-2：满 N（缺省 10 分钟，≥）才报
    expect(rule(base([delivered("merge")]), "manual_deliver_no_review")).toEqual([]);
  });
  const RV = "agent-rv-local";
  /** 本轮审查显式派给本机 RV（reviewStep），RV 的画面状态由 over 定 */
  const bound = (c: ReturnType<typeof delivered>) => ({ ...c, reviewStep: { executor: RV, executorKind: "agent" as const, at: NOW - 35 * MIN } });
  const rv = (over: Partial<AuditAgent>) => ({ agents: [agent(PM), agent(RV, over)] });
  test("验收追加 7 review-busy：绑定的本机审查员主回合在跑（busy / compacting / unknown 但刚写过）→ 不推、keep 住同一 key", () => {
    for (const over of [{ turn: "busy" }, { turn: "compacting" }, { turn: "unknown", lastWriteAt: NOW - MIN }] as Partial<AuditAgent>[]) {
      const r = auditLedger(base([bound(delivered("review"))], rv(over)), NOW, observe);
      expect(r.findings.filter((f) => f.rule === "manual_deliver_no_review")).toEqual([]);
      expect(r.keep.filter((k) => k.includes("manual_deliver_no_review"))).toHaveLength(1);
      expect(r.evaluated).toContain("manual_deliver_no_review");
    }
    // 对照：绑定的审查员空闲 / 好久没写 → 照报
    for (const over of [{ turn: "idle" }, { turn: "unknown", lastWriteAt: NOW - 30 * MIN }] as Partial<AuditAgent>[]) {
      expect(rule(base([bound(delivered("review"))], rv(over)), "manual_deliver_no_review")).toHaveLength(1);
    }
  });
  test("验收追加 9 review-round：只有上一轮的子审查员在跑 → 不算本轮在审，照推 PM；本轮 / 轮次不明的照样压住", () => {
    const r2 = { ...delivered("fix"), task: mkTask("fix", { round: 2 }) };
    expect(rule(base([r2], { reviewers: [{ taskId: "q1", round: 1 }] }), "manual_deliver_no_review")).toHaveLength(1);
    for (const round of [2, null]) expect(rule(base([r2], { reviewers: [{ taskId: "q1", round }] }), "manual_deliver_no_review")).toEqual([]);
  });
  test("子审查员在跑 / 审查员名单取不到 → 不推、keep 住；不影响 evaluated", () => {
    for (const reviewers of [[{ taskId: "q1", round: 1 }], null]) {
      const r = auditLedger(base([delivered("review")], { reviewers }), NOW, observe);
      expect(r.findings.filter((f) => f.rule === "manual_deliver_no_review")).toEqual([]);
      expect(r.keep.filter((k) => k.includes("manual_deliver_no_review"))).toHaveLength(1);
      expect(r.evaluated).toContain("manual_deliver_no_review");
    }
  });

  describe("真库：推送与去重（r1 P1）", () => {
    const dirs: string[] = [];
    afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
    type Round = (s: AuditSnapshot, now: number) => { pushed: string[]; silenced: string[] };
    const withDb = (fn: (round: Round, db: ReturnType<typeof openLedger>) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "audq1-mdr-")), path = join(dir, "ledger.sqlite");
      dirs.push(dir);
      const db = openLedger(path);
      try {
        fn((s, now) => {
          const r = auditLedger(s, now, observe);
          const out = reconcileFindings(db, "p", r.findings, r.evaluated, now, { keep: r.keep });
          const pushed = out.pending.filter((f) => f.rule === "manual_deliver_no_review").map((f) => f.key);
          ackFindings(db, pushed, now);
          return { pushed, silenced: out.silenced.filter((k) => k.includes("manual_deliver_no_review")) };
        }, db);
      } finally { closeLedger(path); }
    };
    test("首轮（空基线）已有的未审交付推一次、第二轮不再推", () => withDb((round) => {
      const c = delivered("review", [], NOW - 31 * MIN);
      const r = round(base([c]), NOW);
      expect(r.silenced).toEqual([]);
      expect(r.pushed).toHaveLength(1);
      expect(round(base([c]), NOW + 15 * MIN).pushed).toEqual([]);
    }));
    test("验收追加 8 delivery-repush：审查员跑一阵停一阵，同一次交付全程只推一次、通知记录不被清掉", () => withDb((round, db) => {
      const c = delivered("review");
      expect(round(base([delivered("review", [], NOW - 10 * MIN)]), NOW - 10 * MIN).pushed).toEqual([]); // 先建基线（交付还没满阈值）
      const first = round(base([c]), NOW).pushed;
      expect(first).toHaveLength(1);
      const row = () => db.query("SELECT firstSeen, resolvedAt, notifiedAt FROM audit_findings WHERE key = ?").get(first[0]!);
      const told = row();
      const busy = [{ reviewers: [{ taskId: "q1", round: 1 }] }, rv({ turn: "busy" })];
      let now = NOW;
      for (const over of busy) {
        now += 15 * MIN;
        expect(round(base([over === busy[1] ? bound(c) : c], over), now).pushed).toEqual([]); // 在跑：不推，也不关
        expect(row()).toEqual(told);
        now += 15 * MIN;
        expect(round(base([bound(c)], rv({ turn: "idle" })), now).pushed).toEqual([]); // 停了还没结论：同一条，不重推
        expect(row()).toEqual(told);
      }
    }));
  });
});
