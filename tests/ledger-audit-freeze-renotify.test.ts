/** AUDN1：合并队列冻结 / 解冻不让巡检把同一张停放 merge 卡当「新发现」重推（auditLedger keep + reconcileFindings 端到端） */
import { describe, expect, test } from "bun:test";
import { auditLedger, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { ackFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import type { EventKind, LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { openLedger } from "../src/lib/ledger-store.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";

const MIN = 60_000;
const T0 = 1_000 * MIN;
const PM = "agent-claudestra";

let seq = 0;
const ev = (ts: number, kind: EventKind, data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "x", project: "p", target: "T1", kind, text: "", data, dedupKey: null });
const task = (): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "T1", kind: "code", stage: "merge", stageBefore: null, round: 1, agent: "agent-t1", pm: PM, branch: null,
  pr: null, headSHA: null, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 0, updatedAt: 0, assigneeKind: "agent", assignee: "agent-t1",
});
/** merge 卡在 stageAt 进 merge，extra = 之后的事件 */
const merge = (stageAt: number, extra: LedgerEvent[] = []) =>
  ({ task: task(), events: [ev(0, "task", { op: "new", patch: { stage: "spec" } }), ev(stageAt, "stage", { from: "review", to: "merge" }), ...extra] });
const snap = (tasks: AuditSnapshot["tasks"], over: Partial<AuditSnapshot> = {}): AuditSnapshot =>
  ({ project: "p", pms: [PM], tasks, agents: null, reviewers: null, held: null, ownerInbox: null, ...over });

function fresh() {
  const db = openLedger(tempLedgerPath("ledger-audit-freeze-"));
  baselineAudit(db, "p");
  /** 一轮巡检 + 对账 + 推送成功即 ack；返回本轮推出去的 ship_stalled key */
  const round = (s: AuditSnapshot, now: number) => {
    const r = auditLedger(s, now);
    const pending = reconcileFindings(db, "p", r.findings, r.evaluated, now, { keep: r.keep }).pending.filter((f) => f.rule === "ship_stalled");
    ackFindings(db, pending.map((f) => f.key), now);
    return pending.map((f) => f.key);
  };
  return { db, round };
}

describe("AUDN1 冻结 / 解冻不重推同一张 merge 停放卡", () => {
  test("已报 → 冻结 → 解冻 → 再满足阈值：不再推（旧代码在此重推一次）", () => {
    const { db, round } = fresh();
    const t = [merge(T0)];
    expect(round(snap(t), T0 + 31 * MIN)).toHaveLength(1);
    // 冻结中：不报（跳过逻辑不变），但 key 保持打开
    const frozen = auditLedger(snap(t, { queueFrozen: true }), T0 + 40 * MIN);
    expect(frozen.findings.filter((f) => f.rule === "ship_stalled")).toEqual([]);
    expect(round(snap(t, { queueFrozen: true }), T0 + 40 * MIN)).toEqual([]);
    // 解冻后宽限期（停滞从解冻起算、还没到阈值）：同样保持打开
    const unfrozenAt = T0 + 45 * MIN;
    expect(round(snap(t, { unfrozenAt }), T0 + 50 * MIN)).toEqual([]);
    expect(db.query("SELECT resolvedAt FROM audit_findings WHERE rule = 'ship_stalled'").get()).toEqual({ resolvedAt: null });
    // 解冻 31 分钟后再次满足阈值：同一个 key 仍开着、已推过 → 不推
    expect(round(snap(t, { unfrozenAt }), T0 + 77 * MIN)).toEqual([]);
  });

  test("反例：解冻后卡换了 stageSince（重新进 merge）→ 新 key，照常推", () => {
    const { round } = fresh();
    expect(round(snap([merge(T0)]), T0 + 31 * MIN)).toHaveLength(1);
    round(snap([merge(T0)], { queueFrozen: true }), T0 + 40 * MIN);
    const unfrozenAt = T0 + 45 * MIN;
    const again = merge(T0, [ev(T0 + 42 * MIN, "stage", { from: "merge", to: "fix" }), ev(T0 + 44 * MIN, "stage", { from: "fix", to: "merge" })]);
    expect(round(snap([again], { unfrozenAt }), T0 + 50 * MIN)).toEqual([]);
    expect(round(snap([again], { unfrozenAt }), T0 + 77 * MIN)).toHaveLength(1);
  });

  test("反例：冻结期间有 deploy（真推进）→ 不保持打开，解冻后再停够照常推", () => {
    const { round } = fresh();
    expect(round(snap([merge(T0)]), T0 + 31 * MIN)).toHaveLength(1);
    const deployed = [merge(T0, [ev(T0 + 38 * MIN, "deploy")])];
    expect(round(snap(deployed, { queueFrozen: true }), T0 + 40 * MIN)).toEqual([]);
    const unfrozenAt = T0 + 45 * MIN;
    expect(round(snap(deployed, { unfrozenAt }), T0 + 50 * MIN)).toEqual([]);
    expect(round(snap(deployed, { unfrozenAt }), T0 + 77 * MIN)).toHaveLength(1);
  });

  test("反例：满足条件后真被解决过（不是冻结跳过），再停滞照常推", () => {
    const { round } = fresh();
    expect(round(snap([merge(T0)]), T0 + 31 * MIN)).toHaveLength(1);
    const deployed = [merge(T0, [ev(T0 + 35 * MIN, "deploy")])];
    expect(round(snap(deployed), T0 + 36 * MIN)).toEqual([]);
    expect(round(snap(deployed), T0 + 66 * MIN)).toHaveLength(1);
  });

  test("冻结前没报过、冻结期间才停够：keep 不凭空开 key，解冻后停够按新发现推一次", () => {
    const { round } = fresh();
    const t = [merge(T0)];
    expect(round(snap(t, { queueFrozen: true }), T0 + 40 * MIN)).toEqual([]);
    expect(round(snap(t, { unfrozenAt: T0 + 45 * MIN }), T0 + 77 * MIN)).toHaveLength(1);
  });
});
