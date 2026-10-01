/**
 * i28-A2b：审查员实际领到的单（本机 take_review 的 reviewOrderOf、池子的 offerLendCore 审查单）在合并退回后的复验轮带定向复验说明；
 * 池子审查单从第 2 轮起带上一轮的逐项结论（和本机单同一个 prevReview），第 1 轮仍是空数组。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listLendOrders, offerLendCore } from "../src/lib/ledger-lend.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { OrderWire } from "../src/lib/order-wire.js";
import { reviewOrderOf } from "../src/lib/review-order.js";
import type { MergeBounce } from "../src/lib/scheduler-merge-conflict.js";

const P = "claude-orchestrator";
const H1 = "a".repeat(40), H2 = "b".repeat(40);
const CI: MergeBounce = { cause: "ci_fail", prHead: H1, mainHead: null, checks: [{ name: "check", link: "https://github.com/o/r/actions/runs/7" }] };
const CONFLICT: MergeBounce = { cause: "conflict", prHead: H1, mainHead: "e".repeat(40), checks: [] };
const F1 = { findingId: "F1", family: "rounds", severity: "P1" as const, probe: "第 2 轮通过后 CI 失败会被误判成轮次到顶" };
const dir = mkdtempSync(join(tmpdir(), "review-order-bounce-"));
let db: Database;

const ev = (kind: LedgerEvent["kind"], data: Record<string, unknown>) =>
  insertEvent(db, { actor: "scheduler", now: 1_000 }, { project: P, target: "T9", kind, text: "", data }, false);
/** 卡停在 review、第 `round` 轮、审 head H2；`history` 先写进台账 */
function card(round: number, history: () => void = () => {}): void {
  history();
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H2}', round = ${round} WHERE id = 'T9'`);
}
/** 第 1 轮 P1 → fix → 第 2 轮通过 → merge → 合并退回 fix → 修好交付进第 3 轮 */
const bounced = (b: MergeBounce) => () => {
  ev("review", { round: 1, head: H1, verdict: "changes", p1: 1, findings: [F1], path: join(dir, "T9-r1.md") });
  ev("stage", { from: "review", to: "fix", round: 1 });
  ev("stage", { from: "fix", to: "review", round: 2 });
  ev("review", { round: 2, head: H1, verdict: "pass", p1: 0, findings: [], path: join(dir, "T9-r2.md") });
  ev("stage", { from: "review", to: "merge", round: 2 });
  ev("stage", { from: "merge", to: "fix", round: 2, mergeBounce: b });
  ev("scheduler", { op: "merge_conflict", intentId: "m1", cause: b.cause, prHead: b.prHead, checks: b.checks, count: 1, escalated: false });
  ev("stage", { from: "fix", to: "review", round: 3 });
};
/** 普通的 P1 复验：第 1 轮 P1 → fix → 第 2 轮 */
const p1Round = () => {
  ev("review", { round: 1, head: H1, verdict: "changes", p1: 1, findings: [F1], path: join(dir, "T9-r1.md") });
  ev("stage", { from: "review", to: "fix", round: 1 });
  ev("stage", { from: "fix", to: "review", round: 2 });
};

function localOrder(): OrderWire {
  const r = reviewOrderOf(db, { task: getTask(db, "T9")!, orderId: "T9:review:r", node: "review", head: H2, auto: false }, dir);
  if (!r.ok) throw new Error(r.error);
  return r.order;
}
function poolOrder(): OrderWire {
  offerLendCore(db, { actor: "scheduler", now: 1_000 }, { taskId: "T9", peer: "mate", family: "codex", repo: "shawnlu96/claudestra", pr: 12,
    spec: "规格", borrow: { peer: "mate", projects: [P], roles: ["review"], maxOpen: 1 } });
  return listLendOrders(db, "T9")[0]!.wire;
}
/** 池子单经外发闸 NFKC 折叠过（全角标点变半角），按词找 */
const targeted = (o: OrderWire) => o.inputs.filter((l) => l.startsWith("定向复验"));

beforeEach(() => {
  db = openLedger(":memory:");
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "# T9\n\n## 验收线\n1. 不误判\n");
  createTask(db, { actor: "owner", now: 1_000 }, { project: P, id: "T9", title: "T9", kind: "code", spec });
});
afterEach(() => closeLedger(":memory:"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("合并退回后的复验单带定向复验说明", () => {
  for (const [name, b, line] of [["CI 失败", CI, "只看修 CI 的改动"], ["和 main 冲突", CONFLICT, "只看解冲突的合并提交"]] as const) {
    test(`${name}：本机审查单的 inputs 里有一行`, () => {
      card(3, bounced(b));
      expect(targeted(localOrder())).toEqual([expect.stringContaining(line)]);
    });
    test(`${name}：池子审查单的 inputs 里也有一行（脱敏后仍在）`, () => {
      card(3, bounced(b));
      const o = poolOrder();
      expect(targeted(o)).toEqual([expect.stringContaining(line)]);
      expect(targeted(o)[0]).toContain(H1.slice(0, 12));
    });
  }
  test("普通的 P1 复验、第 1 轮：两种单都没有定向复验行", () => {
    card(2, p1Round);
    expect(targeted(localOrder())).toEqual([]);
    expect(targeted(poolOrder())).toEqual([]);
  });
});

describe("池子审查单带上一轮逐项结论", () => {
  test("第 2 轮：findings 是第 1 轮的逐项结论，和本机审查单一致", () => {
    card(2, p1Round);
    const pool = poolOrder();
    expect(pool.findings).toEqual([F1]);
    expect(pool.findings).toEqual(localOrder().findings);
  });
  test("第 1 轮：findings 仍是空数组", () => {
    card(1);
    expect(poolOrder().findings).toEqual([]);
  });
});
