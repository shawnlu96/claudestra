/**
 * CARRYCNT1 ledger side on the deploy kit's auto card (HEAD reviewed, PASS by a cross-family pooled-free session): the count receipt
 * is written only by the scheduler right after its own EFFAUTO1 `updating` claim for exactly (H0, H1), with effCountCarry on in the
 * transaction, once per source review; every refusal writes nothing. Both chain orders with a pure-main CARRY2 hop are read by
 * carriedHead / carrySourceTask / MCRY6. On main the count receipt is no CARRY2 receipt (parseCarryReceipt): the merge step throws.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listEvents } from "../src/lib/ledger-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { mustTask } from "../src/lib/ledger-checks.js";
import { countCarryReceipt, countCarryReview, useCountCarryLedgerMode } from "../src/lib/review-count-carry-ledger.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { carrySourceTask } from "../src/lib/review-main-carry-auto-source.js";
import { sendSourceRefusal } from "../src/lib/review-main-carry-send-source.js";
import { advanceMergeRun, carryReceipt, getMergeRun, mergeReviewProof, type MergeRun } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { mergedCard } from "./deploy-test-kit.js";

const H0 = "c".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40), HM = "3".repeat(40), MP = "4".repeat(40), MH = "5".repeat(40);
const B0 = "a".repeat(40), B1 = "b".repeat(40), DIFF = "e".repeat(64);
const sch = { actor: "scheduler", now: 300 };
/** EFFAUTO1's claim receipt as effect-count-refresh.ts pushAndClaim writes it (its real path: tests/review-count-carry.test.ts). */
const claimReceipt = (head: string, sha: string) => `效果点计数自动刷新（CI 只红在效果点计数）：CI head ${head} → 计数提交 ${sha}` +
  "（chore(skip-effects): refresh effect-site counts；scheduler-merge-conflict.ts \"sql=3 stmt=3\"→\"sql=3 stmt=4\"）";
const counted = (from: string, to: string) => countCarryReceipt({ oldHead: from, newHead: to, blobFrom: B0, blobTo: B1 });

type Card = ReturnType<typeof mergedCard>;
const run = (c: Card) => getMergeRun(c.db, c.intent) as MergeRun;
const step = (c: Card, to: MergeRun["phase"], receipt: string, newHead?: string, actor = sch) => {
  const r = run(c);
  return advanceMergeRun(c.db, actor, { intentId: c.intent, from: r.phase, to, rev: r.rev, receipt, ...(newHead ? { newHead } : {}) });
};
/** The kit's card back at await_ci on H0, then EFFAUTO1's claim for (claimFrom, claimTo) into updating. */
function card(claim: [string, string] | null = [H0, H1], claimActor = sch): Card {
  const c = mergedCard();
  c.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(c.intent);
  if (claim) step(c, "updating", claimReceipt(...claim), undefined, claimActor);
  return c;
}
const snapshot = (db: Database) => JSON.stringify([db.query("SELECT seq, kind, data FROM events ORDER BY seq").all(),
  db.query("SELECT * FROM tasks").all(), db.query("SELECT * FROM scheduler_merges").all()]);
const facts = (c: Card) => {
  const task = mustTask(c.db, "T9");
  return { task, read: currentReviewFacts(task, listEvents(c.db, { project: "p", target: "T9" })),
    send: sendSourceRefusal(c.db, run(c), task, getWorkflow(c.db, "T9")!, mergeReviewProof), source: carrySourceTask(c.db, task).headSHA };
};
const carries = (c: Card) => listEvents(c.db, { project: "p", target: "T9" }).filter((e) => e.kind === "scheduler" && e.data.op === "review_carry");
function on<T>(f: () => T, mode: RecoveryMode = "on"): T {
  using _mode = useCountCarryLedgerMode(() => mode);
  return f();
}

describe("CARRYCNT1 count carry in the merge step's transaction", () => {
  test("[验收线 3] the scheduler with its own claim: carried to await_ci, the PASS still read, round unchanged", () => {
    const c = card();
    try {
      const before = mustTask(c.db, "T9");
      const after = on(() => step(c, "await_ci", counted(H0, H1), H1));
      expect([after.phase, after.reviewedHead]).toEqual(["await_ci", H1]);
      const [carry] = carries(c), events = listEvents(c.db, { project: "p", target: "T9" });
      expect(carry!.data).toMatchObject({ op: "review_carry", carryKind: "count", from: H0, to: H1, round: before.round, specRev: before.specRev,
        sourceReviewSeq: expect.any(Number), claimSeq: expect.any(Number), inventory: "src/lib/scheduler-v2-skip-effects.ts", blobFrom: B0, blobTo: B1 });
      expect(events.find((e) => e.seq === carry!.seq + 1)?.data).toMatchObject({ op: "merge_phase", to: "await_ci", carrySeq: carry!.seq });
      const f = facts(c);
      expect([f.task.stage, f.task.headSHA, f.task.round, f.read.kind, f.send, f.source]).toEqual(["merge", H1, before.round, "facts", null, H0]);
      expect(events.some((e) => e.kind === "stage")).toBe(false);
    } finally { c.close(); }
  });

  test("[验收线 3] every refusal writes no event, task or run row", () => {
    const none = () => {}, owner = { actor: "owner", now: 300 };
    const noClaim = () => { const c = card(null); c.db.query("UPDATE scheduler_merges SET phase='updating' WHERE intentId=?").run(c.intent); return c; };
    const refusals: [string, () => Card, (c: Card) => void, string, RecoveryMode?][] = [
      ["owner identity", card, none, "只许调度服务"],
      ["no claim", noClaim, none, "认领"],
      ["claim for another pair", () => card([H0, H2]), none, "对不上"],
      ["an older claim, then a plain refresh", () => {
        const c = card();
        step(c, "await_ci", "head 未变，等待 CI"); step(c, "updating", "等 CI 期间 main 前进，重新更新分支");
        return c;
      },
        none, "不是效果点计数刷新"],
      ["claim by a PM", () => card([H0, H1], owner), none, "调度服务自己写"],
      ["UI card", card, (c) => c.db.query("UPDATE task_workflows SET template='ui'").run(), "UI 卡"],
      ["manual_merge", card, (c) => c.db.query("UPDATE scheduler_intents SET node='manual_merge' WHERE id=?").run(c.intent), "人工合并"],
      ["key off in the transaction", card, none, "不是 on", "off"],
      ["key observe in the transaction", card, none, "不是 on", "observe"],
      ["source PASS gate", card, (c) => c.db.query("DELETE FROM scheduler_sessions").run(), "正式来源审查门"],
      ["a count carry since the source review", card, (c) => c.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES
        (250,'scheduler','p','T9','scheduler','',?)`).run(JSON.stringify({ op: "review_carry", carryKind: "count", from: H2, to: H0 })), "已沿用过一次"],
    ];
    for (const [name, make, mutate, why, mode] of refusals) {
      const c = make();
      try {
        mutate(c);
        const before = snapshot(c.db), actor = name === "owner identity" ? owner : sch;
        const direct = () => c.db.transaction(() => countCarryReview(c.db, actor, run(c), H1, counted(H0, H1), 300, mergeReviewProof))();
        expect(() => on(direct, mode), name).toThrow(why);
        expect(snapshot(c.db), name).toBe(before);
        expect(() => on(() => step(c, "await_ci", counted(H0, H1), H1, actor), mode), name).toThrow();
        expect(snapshot(c.db), name).toBe(before);
      } finally { c.close(); }
    }
  });

  test("[验收线 3] not in updating, or a receipt naming other heads: refused, nothing written", () => {
    const c = card(null);
    try {
      c.db.query("UPDATE scheduler_merges SET phase='ready' WHERE intentId=?").run(c.intent);
      const before = snapshot(c.db);
      expect(() => on(() => step(c, "await_ci", counted(H0, H1), H1))).toThrow("只在 updating");
      expect(snapshot(c.db)).toBe(before);
    } finally { c.close(); }
    const d = card();
    try {
      const before = snapshot(d.db);
      expect(() => on(() => step(d, "await_ci", counted(H2, H1), H1))).toThrow("head 对不上");
      expect(() => on(() => step(d, "await_ci", `${counted(H0, H1)}；附注`, H1))).toThrow("缺证据");
      expect(snapshot(d.db)).toBe(before);
    } finally { d.close(); }
  });

  test("[验收线 3] one count carry per source review: count → main → count is refused", () => {
    const c = card();
    try {
      on(() => step(c, "await_ci", counted(H0, H1), H1));
      step(c, "updating", "等 CI 期间 main 前进，重新更新分支");
      on(() => step(c, "await_ci", carryReceipt({ oldHead: H1, newHead: H2, mainParent: MP, mainHead: MH, diffHash: DIFF }) +
        carryChainSuffix([{ previousHead: H1, head: H2, mainParent: MP }]), H2));
      step(c, "updating", claimReceipt(H2, HM));
      const before = snapshot(c.db);
      expect(() => on(() => step(c, "await_ci", counted(H2, HM), HM))).toThrow("已沿用过一次");
      expect(snapshot(c.db)).toBe(before);
    } finally { c.close(); }
  });

  test("[验收线 4] both chain orders are read by carriedHead, carrySourceTask and the before-send re-proof", () => {
    const pure = (from: string, to: string) => carryReceipt({ oldHead: from, newHead: to, mainParent: MP, mainHead: MH, diffHash: DIFF }) +
      carryChainSuffix([{ previousHead: from, head: to, mainParent: MP }]);
    const countFirst = card();
    try { // H0 → H1 (count) → H2 (pure main)
      on(() => step(countFirst, "await_ci", counted(H0, H1), H1));
      step(countFirst, "updating", "等 CI 期间 main 前进，重新更新分支");
      on(() => step(countFirst, "await_ci", pure(H1, H2), H2));
      const f = facts(countFirst);
      expect([f.task.headSHA, f.read.kind, f.send, f.source, carries(countFirst).map((e) => e.data.carryKind ?? "main")]).toEqual([H2, "facts", null, H0, ["count", "main"]]);
    } finally { countFirst.close(); }
    const mainFirst = card(null);
    try { // H0 → HM (pure main) → H1 (count)
      step(mainFirst, "updating", "等 CI 期间 main 前进，重新更新分支");
      on(() => step(mainFirst, "await_ci", pure(H0, HM), HM));
      step(mainFirst, "updating", claimReceipt(HM, H1));
      on(() => step(mainFirst, "await_ci", counted(HM, H1), H1));
      const f = facts(mainFirst);
      expect([f.task.headSHA, f.read.kind, f.send, f.source, carries(mainFirst).map((e) => e.data.carryKind ?? "main")]).toEqual([H1, "facts", null, H0, ["main", "count"]]);
    } finally { mainFirst.close(); }
  });

  test("a CARRY2 receipt is untouched by the count path", () => {
    const c = card(null);
    try {
      expect(on(() => c.db.transaction(() => countCarryReview(c.db, sch, run(c), H1, "沿用审查：…", 300, mergeReviewProof))())).toBeNull();
    } finally { c.close(); }
  });
});
