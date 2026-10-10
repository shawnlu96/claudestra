/**
 * QSTOPW 前置缺口：现协议传不来「认证的额度终态 + 无待交结果」证据，正式恢复接线不能开（规格：先报最小协议 / B 侧来源范围并拆节点）。
 * 这里钉住现状，协议补上字段之前任何一条变绿都说明有人在从自由文本 / 空 resultSha 猜：
 *  - B 侧额度卡（kind quota）不产结构化类别，release 只有自由文本 detail；
 *  - release 的 wire 只收 failure{class,sessionId,failedAt}，cause / stopped / resultPending / sideEffects / resetAt 都会被整条拒收；
 *  - A 侧 release stopped 只把单停成 unknown 交 PM，入账事件里没有可当 QuotaStopFact 的字段，也不出新单。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLendOrder, leaseLend, listLendOrders } from "../src/lib/ledger-lend.ts";
import { openLedger } from "../src/lib/ledger-store.ts";
import { lenderFailureOf } from "../src/lib/lend-health.ts";
import { parseLendRequest } from "../src/lib/lend-wire.ts";
import { verifyQuotaStop, type OrderSnap } from "../src/lib/lend-quota-resume-facts.ts";

const T0 = Date.UTC(2026, 9, 5, 9, 0);
const PEER = "peer:B";
const ORDER = "lend:demo:s1:r0:a1";
const base = { v: 1, orderId: ORDER, gen: 1, action: "release", reason: "stopped", detail: "撞额度：claude 周额度用完" } as const;

function claimedDb() {
  const db = openLedger(join(mkdtempSync(join(tmpdir(), "qstopw-gap-")), "ledger.sqlite"));
  const row: Record<string, unknown> = {
    orderId: ORDER, taskId: "demo", project: "p", peer: PEER, family: "claude", step: "write", specRev: 1, round: 0, head: "a".repeat(40),
    repo: "o/r", pr: null, wire: "{}", text: "", sha256: "x", status: "claimed", worker: "w1", leaseGen: 1, leaseMs: 60_000, leaseUntil: T0 + 60_000,
    resultSha: null, receipt: null, eventSeq: null, reason: null, supersedes: null, createdBy: "pm", createdAt: T0 - 60_000,
    updatedAt: T0 - 60_000, branch: "lend/demo-b1a2", base: "a".repeat(40), seenAt: null,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO lend_orders (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(row) as never[]));
  return db;
}

describe("QSTOPW 协议缺口：没有认证额度终态证据", () => {
  test("B 侧额度卡不产结构化失败类别（只有回合 error 才带）", () => {
    expect(lenderFailureOf({ kind: "quota", askId: "a1", message: "usage limit reached" } as never)).toBeNull();
  });

  test("release wire 不收停止原因 / 待交结果 / 副作用 / 重置时刻字段", () => {
    expect(parseLendRequest("lease", base).ok).toBe(true);
    for (const extra of [{ cause: "quota" }, { stopped: true }, { resultPending: false }, { resultCommitted: false }, { sideEffects: "none" }, { resetAt: T0 }]) {
      expect(parseLendRequest("lease", { ...base, ...extra }).ok).toBe(false);
    }
    // 结构化类别只有 class / sessionId / failedAt：没有 reset、没有结果状态，不够组成 QuotaStopFact
    expect(parseLendRequest("lease", { ...base, failure: { class: "usage", sessionId: "s-1", failedAt: T0, resetAt: T0 } }).ok).toBe(false);
  });

  test("A 侧 release stopped 只停成 unknown 交 PM：无可认证事实 → wait，不出新单", () => {
    const db = claimedDb();
    const r = leaseLend(db, { actor: "lend", now: T0 }, PEER, { ...base, failure: { class: "usage", sessionId: "s-1", failedAt: T0 - 1 } });
    expect(r.lease).toBeNull();
    const o = getLendOrder(db, ORDER) as OrderSnap;
    expect(o.status).toBe("unknown");
    expect(o.resultSha).toBeNull();
    // 不从空 resultSha / reason 里的「额度」字样猜：调用方拿不出认证事实，核验只能是 wait
    expect(verifyQuotaStop([], o, T0 + 1).kind).toBe("wait");
    expect(listLendOrders(db, "demo").map((x) => x.orderId)).toEqual([ORDER]);
  });
});
