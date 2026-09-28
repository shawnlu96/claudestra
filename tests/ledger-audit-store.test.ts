/** 巡检结果落库（lib/ledger-audit-store.ts）：开 / 仍在 / 解决 / 重开、取数失败不误关、ack 去重；读侧总览带 audit、v1 库兼容、变更推送 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AuditFinding, AuditRule } from "../src/lib/ledger-audit.js";
import { ackFindings, openFindings, reconcileFindings } from "../src/lib/ledger-audit-store.js";
import { LedgerReader, ledgerFeedTicker, projectView } from "../src/lib/ledger-read.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { seedLedger, tempLedgerPath } from "./ledger-test-helpers.js";

const ALL: AuditRule[] = ["review_no_reviewer", "pm_held", "ship_stalled"];

function finding(key: string, rule: AuditRule = "review_no_reviewer", over: Partial<AuditFinding> = {}): AuditFinding {
  return { key: `p|${rule}|${key}`, project: "p", taskId: "T1", rule, since: 1, detail: `d-${key}`, suggestion: "s", notify: "agent-pm", ...over };
}

function fresh() {
  const path = tempLedgerPath("ledger-audit-");
  return { path, db: openLedger(path) };
}

describe("reconcileFindings", () => {
  test("新出现 → 开并进 pending；再跑一次仍在 → 不再算新开，firstSeen 不变、lastSeen 更新", () => {
    const { db } = fresh();
    const a = reconcileFindings(db, "p", [finding("a")], ALL, 100);
    expect(a.opened).toEqual(["p|review_no_reviewer|a"]);
    expect(a.pending.map((f) => f.key)).toEqual(["p|review_no_reviewer|a"]);
    const b = reconcileFindings(db, "p", [finding("a", "review_no_reviewer", { detail: "新文案" })], ALL, 200);
    expect(b.opened).toEqual([]);
    const row = openFindings(db, "p")[0];
    expect(row).toMatchObject({ firstSeen: 100, lastSeen: 200, detail: "新文案", changedAt: 100, resolvedAt: null });
  });

  test("推过（ack）之后不再进 pending——去重的核心；重复 ack 不改时间", () => {
    const { db } = fresh();
    reconcileFindings(db, "p", [finding("a")], ALL, 100);
    expect(ackFindings(db, ["p|review_no_reviewer|a"], 150)).toBe(1);
    expect(ackFindings(db, ["p|review_no_reviewer|a"], 160)).toBe(0);
    expect(reconcileFindings(db, "p", [finding("a")], ALL, 200).pending).toEqual([]);
    expect(openFindings(db, "p")[0].notifiedAt).toBe(150);
  });

  test("没 ack（推送失败 / 收件人不在线）→ 下一轮还在 pending", () => {
    const { db } = fresh();
    reconcileFindings(db, "p", [finding("a")], ALL, 100);
    expect(reconcileFindings(db, "p", [finding("a")], ALL, 200).pending).toHaveLength(1);
  });

  test("这一轮没再出现 → 标已解决（resolvedAt、changedAt），不推「已恢复」", () => {
    const { db } = fresh();
    reconcileFindings(db, "p", [finding("a"), finding("b")], ALL, 100);
    const r = reconcileFindings(db, "p", [finding("b")], ALL, 200);
    expect(r.resolved).toEqual(["p|review_no_reviewer|a"]);
    expect(r.pending.map((f) => f.key)).toEqual(["p|review_no_reviewer|b"]);
    expect(openFindings(db, "p").map((f) => f.key)).toEqual(["p|review_no_reviewer|b"]);
    const row = db.query("SELECT resolvedAt, changedAt FROM audit_findings WHERE key = ?").get("p|review_no_reviewer|a");
    expect(row).toEqual({ resolvedAt: 200, changedAt: 200 });
  });

  test("规则这一轮没跑（取数失败）→ 它的旧异常原样开着", () => {
    const { db } = fresh();
    reconcileFindings(db, "p", [finding("a", "pm_held")], ALL, 100);
    const r = reconcileFindings(db, "p", [], ["review_no_reviewer", "ship_stalled"], 200);
    expect(r.resolved).toEqual([]);
    expect(openFindings(db, "p")).toHaveLength(1);
  });

  test("解决后同一个 key 又出现 → 重开：firstSeen 取这次、notifiedAt 清空、会再推", () => {
    const { db } = fresh();
    reconcileFindings(db, "p", [finding("a")], ALL, 100);
    ackFindings(db, ["p|review_no_reviewer|a"], 110);
    reconcileFindings(db, "p", [], ALL, 200);
    const r = reconcileFindings(db, "p", [finding("a")], ALL, 300);
    expect(r.opened).toEqual(["p|review_no_reviewer|a"]);
    expect(r.pending).toHaveLength(1);
    expect(openFindings(db, "p")[0]).toMatchObject({ firstSeen: 300, notifiedAt: null, resolvedAt: null, changedAt: 300 });
  });

  test("没有收件人的只落库不进 pending；别的项目的不受影响", () => {
    const { db } = fresh();
    reconcileFindings(db, "q", [{ ...finding("x"), key: "q|review_no_reviewer|x", project: "q" }], ALL, 50);
    const r = reconcileFindings(db, "p", [finding("a", "review_no_reviewer", { notify: null })], ALL, 100);
    expect(r.pending).toEqual([]);
    reconcileFindings(db, "p", [], ALL, 200);
    expect(openFindings(db, "q")).toHaveLength(1);
  });

  test("不写 events 表：任务的 lastEvent 与项目级事件不受巡检影响（T11a P1-5 的坑）", () => {
    const path = tempLedgerPath("ledger-audit-");
    seedLedger(path);
    const w = openLedger(path);
    const before = projectView(w, "p", 2_000);
    const n = listEvents(w).length;
    reconcileFindings(w, "p", [finding("a", "pm_held", { taskId: null }), finding("b", "review_no_reviewer")], ALL, 1_000);
    expect(listEvents(w).length).toBe(n);
    const after = projectView(w, "p", 2_000);
    expect(after.audit.map((f) => f.key)).toEqual(["p|pm_held|a", "p|review_no_reviewer|b"]);
    expect(after.projectEvents).toEqual(before.projectEvents);
    expect(after.tasks.map((t) => t.lastEvent)).toEqual(before.tasks.map((t) => t.lastEvent));
    closeLedger(path);
  });
});

describe("读侧", () => {
  test("v1 库（还没有 audit_findings 表）→ 总览 audit 为空，变更推送照常", () => {
    const path = tempLedgerPath("ledger-audit-v1-");
    seedLedger(path);
    const raw = new Database(path);
    raw.exec("DROP TABLE audit_findings; PRAGMA user_version = 1");
    raw.close();
    const reader = new LedgerReader(path);
    const db = reader.get();
    expect(db).not.toBeNull();
    expect(projectView(db as Database, "p", 0).audit).toEqual([]);
    const emitted: string[] = [];
    const tick = ledgerFeedTicker({ reader, emit: (p) => emitted.push(p), log: () => {} });
    tick();
    expect(emitted).toEqual([]);
    reader.close();
  });

  test("巡检开 / 关一条 → 推一次对应项目；只刷新 lastSeen 不推", () => {
    const path = tempLedgerPath("ledger-audit-feed-");
    seedLedger(path);
    const reader = new LedgerReader(path);
    const emitted: string[] = [];
    const tick = ledgerFeedTicker({ reader, emit: (p) => emitted.push(p), log: () => {} });
    tick();
    const w = openLedger(path);
    reconcileFindings(w, "q", [{ ...finding("x"), key: "q|review_no_reviewer|x", project: "q" }], ALL, 5_000);
    tick();
    expect(emitted).toEqual(["q"]);
    reconcileFindings(w, "q", [{ ...finding("x"), key: "q|review_no_reviewer|x", project: "q" }], ALL, 6_000);
    tick();
    expect(emitted).toEqual(["q"]);
    reconcileFindings(w, "q", [], ALL, 7_000);
    tick();
    expect(emitted).toEqual(["q", "q"]);
    closeLedger(path);
    reader.close();
  });
});
