import { DISPUTE_RULE, FIX_STRATEGY_RULE } from "../src/lib/fix-strategy.js";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { offerLendCore, listLendOrders } from "../src/lib/ledger-lend.js";
import { holdWriteLease, writeOrderWire } from "../src/lib/ledger-lend-lease.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { sanitizeForeign } from "../src/lib/order-wire-render.js";
import { parseOrderWire } from "../src/lib/order-wire.js";
import type { MergeBounce } from "../src/lib/scheduler-merge-conflict.js";
import type { PlannerDecision } from "../src/lib/scheduler-plan.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";

const H = "a".repeat(40), MAIN = "b".repeat(40), BRANCH = "lend/T1-abcd";
const conflict: MergeBounce = { cause: "conflict", prHead: H, mainHead: MAIN, checks: [] };
const ciFail: MergeBounce = { cause: "ci_fail", prHead: H, mainHead: null,
  checks: [{ name: "typecheck + test + guard", link: "https://github.com/o/r/actions/runs/42" },
    { name: "web typecheck + lint", link: "https://github.com/o/r/actions/runs/43" }] };
const updateFail: MergeBounce = { cause: "update_fail", prHead: H, mainHead: null, checks: [], error: "GitHub update refused" };
const finding = { findingId: "race-1", family: "race", severity: "P1" as const, probe: "two concurrent writes" };
const ctx = { actor: "scheduler", now: 1_000 };
let db: Database;
const task = () => getTask(db, "T1")!;
const add = (kind: "review" | "stage", data: Record<string, unknown>) =>
  insertEvent(db, ctx, { project: "p", target: "T1", kind, text: kind, data }, true);
const bounceToFix = (b: MergeBounce) => add("stage", { from: "merge", to: "fix", round: 1, mergeBounce: b });
const offer = (spec = "规格", report: string | null = "# Review\nAll checks pass.") => offerLendCore(db, ctx, {
  taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 7, spec,
  borrow: { peer: "mate", projects: ["p"], roles: ["write"], maxOpen: 1 },
  write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: null, report },
});
// Only SHA presentation and the normal peer fold differ from the local package; no bounce text is reimplemented here.
const peerText = (s: string) => sanitizeForeign(s.replaceAll(H, H.slice(0, 12)).replaceAll(MAIN, MAIN.slice(0, 12)));

beforeEach(() => {
  db = openLedger(":memory:");
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  db.run("UPDATE tasks SET stage='fix', round=1, headSHA=?, branch=? WHERE id='T1'", [H, BRANCH]);
  holdWriteLease(db, task(), { peer: "mate", fp: "abcd-ef01-2345-6789", branch: BRANCH, repo: "o/r" }, 1);
  add("review", { round: 1, head: H, verdict: "pass", path: "reviews/T1-r1/report.md", findings: [{ ...finding, severity: "P2" }] });
});
afterEach(() => closeLedger(":memory:"));

describe("lent merge-bounce fix orders", () => {
  for (const b of [conflict, ciFail, updateFail]) {
    test(`${b.cause}: the stored and rendered order carries the local work package instead of the passed report`, () => {
      bounceToFix(b);
      const o = offer();
      const plan: Extract<PlannerDecision, { kind: "intent" }> = { kind: "intent", id: "fix-order", node: "fix", action: "dispatch",
        recipient: "author", resources: [], reason: "merge bounce", observedOnly: false,
        workOrder: { reportPath: "", findings: [], fallbackWarning: null, bounce: b } };
      const local = workOrderFor(task(), { id: "fix-order", node: "fix", head: H, specRev: 1 } as SchedulerIntent, plan,
        { agent: "author", sessionId: "s1", taskId: "T1", family: "codex", role: "author", transport: "tmux" })!;
      // CONV3 owns remote convergence; this comparison continues to prove the shared merge-bounce package.
      expect(local.inputs).toContain(DISPUTE_RULE);
      expect(local.inputs).toContain(FIX_STRATEGY_RULE);
      const bounceInputs = local.inputs.slice(1).filter((line) => line !== DISPUTE_RULE && line !== FIX_STRATEGY_RULE);
      expect(o.wire.inputs.slice(1)).toEqual(bounceInputs.map(peerText));
      expect(local.acceptance.slice(0, o.wire.acceptance.length - 2).map(peerText)).toEqual(o.wire.acceptance.slice(2));
      expect(o.wire.findings).toEqual([]);
      expect(o.wire.head).toBe(H);
      expect(o.wire.acceptance[0]).toContain(BRANCH);
      expect(o.wire.acceptance[1]).toContain("不推 main");
      expect(o.text).not.toContain("All checks pass");
      expect(o.text).not.toContain("逐条修上一轮审查");
      expect(o.text).toContain(b.cause === "conflict" ? "合入最新 origin/main" : b.cause === "update_fail" ? b.error! : ciFail.checks[0]!.link);
      expect(o.text).toContain(b.cause === "conflict" ? "解冲突" : b.cause === "update_fail" ? "合入" : ciFail.checks[1]!.name);
      expect(parseOrderWire(JSON.parse(JSON.stringify(o.wire))).ok).toBe(true);
      expect(listLendOrders(db, "T1")[0]!.wire).toEqual(o.wire);
    });
  }

  test("an ordinary P1 fix after an older bounce still carries exactly the old report and findings", () => {
    bounceToFix(conflict);
    add("review", { round: 1, head: H, verdict: "changes", path: "reviews/T1-r1/report.md", findings: [finding] });
    add("stage", { from: "review", to: "fix", round: 1 });
    const report = "# Review\nP1: concurrent writes lose data";
    const o = offer("规格", report);
    const previous = writeOrderWire(task(), { orderId: o.orderId, step: "fix", head: H, branch: BRANCH, base: "main", spec: "规格",
      report, findings: [finding], repo: "o/r", pr: 7 });
    expect(o.wire.inputs).toEqual(previous.inputs.map(sanitizeForeign));
    expect(o.wire.acceptance).toEqual(previous.acceptance.map(sanitizeForeign));
    expect(o.wire.findings).toEqual([finding]);
    expect(o.text).not.toContain("解冲突");
  });

  test("a split spec keeps every part alongside the bounce and the unused pass report is omitted", () => {
    bounceToFix(conflict);
    const spec = "验收 保留每一行\n".repeat(800);
    const o = offer(spec, "stale report\n".repeat(4_000));
    const parts = o.wire.inputs.filter((s) => s.startsWith("规格原文"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((s) => s.slice(s.indexOf("\n") + 1)).join("")).toBe(spec);
    expect(o.text).toContain("解冲突");
    expect(o.text).not.toContain("stale report");
  });

  test("bounce check names and run links still pass through the peer secret gate", () => {
    bounceToFix({ ...ciFail, checks: [{ name: "check", link: `https://github.com/o/r/actions/runs/42?key=${"c".repeat(40)}` }] });
    expect(() => offer()).toThrow(/疑似含密钥/);
    expect(listLendOrders(db, "T1")).toEqual([]);
  });
});
