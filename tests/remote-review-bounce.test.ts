/**
 * RRL-2: the repository owner's P1 on a handed-over card. Merge (before / after the handoff) → back to fix to the original author,
 * the report on the fix order and take_order, a targeted re-review line, and a fresh handoff once re-reviewed; review / build / fix
 * and manual cards only carry the report; the 4th bounce, a P0 and a lender-written head go to PM.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { takeOrderResult } from "../src/lib/order-take.js";
import { takeReview } from "../src/lib/review-order.js";
import { recordRemoteReview } from "../src/lib/remote-review-ledger.js";
import { parseRemoteReview } from "../src/lib/remote-review-parse.js";
import { unsentRemoteNotices } from "../src/lib/remote-review-read.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import { HANDOFF_POLL_MS, type HandoffPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";
import { INJECT, pushText } from "./helpers/remote-review-fixture.js";

const PR = "https://github.com/example/repo/pull/7";
const H3 = "3".repeat(40), H4 = "4".repeat(40);
const call = { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" } as never;
type F = ReturnType<typeof autoFixture>;

/** Book the owner's review of `head` the way the intake does (parsed text, report copy under the fixture dir). */
function book(f: F, head: string, counts: { verdict?: "pass" | "changes" | "block"; p0?: number; p1?: number; round?: number } = {}) {
  const review = parseRemoteReview(pushText({ verdict: "changes", p1: 2, ...counts }, { head }))!;
  return recordRemoteReview(f.db, f.at("scheduler"), { taskId: "T1", review, peer: "Shawn", reportDir: join(f.dir, "reviews") });
}

function harness(f: F) {
  let pr: HandoffPr | null = null, reads = 0; // default: the PR open at the card's head
  const hand = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps,
      prState: async () => { reads++; return pr ?? { state: "OPEN", head: f.task().headSHA!, mergeSha: null }; } });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const handoffs = () => events().filter((e) => e.data.op === "merge_handoff");
  const order = () => {
    const r = takeOrderResult(f.db, call);
    if (!r.ok || !r.order) throw new Error(JSON.stringify(r));
    return r.order;
  };
  return { hand, handoffs, events, order, reads: () => reads, setPr: (p: HandoffPr | null) => { pr = p; } };
}

/** build → deliver `head` with the PR → the review order is out (card in review). */
async function toReview(f: F, head = H1) {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", head, "--pr", PR);
  await f.tick(); // reviewer session
  await f.tick(); // review order
}

/** review passes at `head` → merge. */
async function passToMerge(f: F, head: string) {
  await f.review("pass", head, [P2]);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
}

/** The dispatch body the next fix order goes out with (the channel message only points at take_order). */
function dispatchBody(f: F): string {
  const plan = planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
  if (plan.kind !== "intent" || plan.node !== "fix") throw new Error(JSON.stringify(plan));
  const t = f.task(), intent = { id: plan.id, node: plan.node, head: t.headSHA, specRev: t.specRev } as SchedulerIntent;
  const o = workOrderFor(t, intent, plan, { taskId: "T1", role: "author", agent: "agent-task-one", sessionId: "s-one", family: "claude", transport: "tmux" }, undefined, f.db)!;
  return [...o.inputs, ...o.acceptance].join("\n");
}

/** A bounced card in fix: the fix order goes out, the author delivers `head`, the targeted review order goes out. */
async function fixAndReview(f: F, head: string) {
  const body = dispatchBody(f);
  await f.tick(); // fix dispatch
  const fix = { ...f.sent.at(-1)!, body };
  await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", head);
  await f.tick(); // review order
  const rv = takeReview(f.db, { agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", verified: true } as never, join(f.dir, "reviews"));
  if (!rv.ok || rv.orders.length !== 1) throw new Error(JSON.stringify(rv));
  return { fix, review: { text: [...rv.orders[0]!.inputs, ...rv.orders[0]!.acceptance].join("\n") } };
}

describe("RRL-2 owner P1 in merge", () => {
  for (const when of ["before", "after"] as const) {
    test(`[验收线 6] ${when} the handoff: merge → fix to the author, report on both orders, targeted re-review, a new handoff`, async () => {
      const f = autoFixture(), h = harness(f);
      try {
        await toReview(f);
        await passToMerge(f, H1);
        if (when === "after") expect(await h.hand()).toMatchObject({ step: "handoff" });
        const booked = book(f, H1);
        expect(booked.event.data).toMatchObject({ matched: true, action: null });
        expect(await h.hand()).toMatchObject({ step: "remote_bounce" });
        expect(f.task().stage).toBe("fix");
        const moved = h.events().findLast((e) => e.kind === "stage")!;
        expect(moved.data).toMatchObject({ from: "merge", to: "fix", mergeBounce: { cause: "remote_review", prHead: H1,
          remote: { seq: booked.event.seq, reportId: "PR1600-r1", p1: 2 } } });
        const reportPath = String(booked.event.data.reportPath);
        expect(f.notices.at(-1)).toContain("已退回 fix");

        const order = h.order();
        expect(order.inputs.join("\n")).toContain(reportPath);
        expect(order.acceptance).toContain("逐条修报告里的 P1，push 到本 PR 分支，用 deliver 报新 head");
        const { fix, review } = await fixAndReview(f, H2);
        expect(fix.agent).toBe("agent-task-one");
        expect(fix.body).toContain(reportPath);
        expect(fix.body).toContain("逐条修报告里的 P1");
        expect(review.text).toContain("定向复验：核对仓库方 PR1600-r1 的 P1 是否修好");
        expect(review.text).not.toContain(INJECT);

        await passToMerge(f, H2);
        expect(await h.hand()).toMatchObject({ step: "handoff" });
        expect(h.handoffs().at(-1)!.data.evidence).toMatchObject({ head: H2 });
        expect(h.handoffs()).toHaveLength(when === "after" ? 2 : 1);
        expect(getWorkflow(f.db, "T1")!.mode).toBe("auto");
      } finally { f.close(); }
    });
  }

  test("a replayed bounce is a duplicate; a P1 for another head never bounces until the card reaches it", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      await passToMerge(f, H1);
      book(f, H2); // early: the card is still at H1
      expect(await h.hand()).toMatchObject({ step: "handoff" });
      expect(f.task().stage).toBe("merge");
      const p = book(f, H1);
      expect(await h.hand()).toMatchObject({ step: "remote_bounce" });
      const again = await f.tickDeps.manager("ledger", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR, "--remote-bounce", String(p.event.seq));
      expect(again).toMatchObject({ ok: true, duplicate: true });
      expect(h.events().filter((e) => e.data.op === "remote_bounce")).toHaveLength(1);
      const byPm = await f.cli("pm", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR, "--remote-bounce", String(p.event.seq));
      expect(byPm.ok).not.toBe(true);
    } finally { f.close(); }
  });

  test("[验收线 8] the 4th owner bounce goes to PM: manual, one notice, no fix", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      await passToMerge(f, H1);
      const heads = [H1, H2, H3, H4];
      for (let i = 0; i < 3; i++) {
        book(f, heads[i]!);
        expect(await h.hand()).toMatchObject({ step: "remote_bounce" });
        await fixAndReview(f, heads[i + 1]!);
        await passToMerge(f, heads[i + 1]!);
      }
      book(f, H4);
      const before = f.notices.length;
      expect(await h.hand()).toMatchObject({ step: "manual", detail: expect.stringContaining("第 4 次打回") });
      expect(f.task().stage).toBe("merge");
      expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
      expect(f.notices.slice(before)).toHaveLength(1);
      expect(f.notices.at(-1)).toContain("T1-remote-PR1600-r1");
    } finally { f.close(); }
  });

  test("[验收线 8] a P0 or a P1 at the owner's cap goes to PM through the booking: manual, one notice, no bounce", async () => {
    for (const counts of [{ verdict: "block" as const, p0: 1, p1: 0 }, { p1: 1, round: 3 }]) {
      const f = autoFixture(), h = harness(f);
      try {
        await toReview(f);
        await passToMerge(f, H1);
        book(f, H1, counts);
        expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
        expect(unsentRemoteNotices(f.db, "p")).toHaveLength(1);
        expect(await h.hand()).toBeUndefined(); // a manual card is not ticked
        expect(f.task().stage).toBe("merge");
        expect(h.events().some((e) => e.data.op === "remote_bounce")).toBe(false);
      } finally { f.close(); }
    }
  });

  test("[验收线 9] a pass is only booked: the handoff goes on, the stage is unchanged", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      await passToMerge(f, H1);
      book(f, H1, { verdict: "pass", p1: 0 });
      expect(await h.hand()).toMatchObject({ step: "handoff" });
      expect(f.task().stage).toBe("merge");
    } finally { f.close(); }
  });

  test("[验收线 11] a head a lender wrote goes to PM with the report path, not back to fix", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      await passToMerge(f, H1);
      const deliver = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "deliver")!;
      f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
        status, leaseMs, createdBy, createdAt, updatedAt, eventSeq) VALUES ('lent', 'T1', 'p', 'Other', 'claude', 'write', 1, 1, ?, 'o/r', '{}', '', '',
        'done', 1000, 'owner', 1, 1, ?)`).run(H1, deliver.seq);
      const p = book(f, H1);
      expect(await h.hand()).toMatchObject({ step: "manual", detail: expect.stringContaining("出借方写的") });
      expect(f.notices.at(-1)).toContain(String(p.event.data.reportPath));
      expect(f.task().stage).toBe("merge");
      expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
    } finally { f.close(); }
  });
});

describe("RRL-2 owner P1 outside merge: the report rides along", () => {
  test("[验收线 7] in review, local P1 too: the fix order carries both reports", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      const p = book(f, H1);
      expect(p.event.data).toMatchObject({ matched: true, action: null });
      await f.review("changes", H1, [P1]);
      await f.tick(); // review → fix
      const reportPath = String(p.event.data.reportPath), body = dispatchBody(f);
      await f.tick(); // fix dispatch
      expect(f.task().stage).toBe("fix");
      expect(body).toContain("reviews/T1-r1/report.md");
      expect(body).toContain(reportPath);
      const order = h.order();
      expect(order.inputs.join("\n")).toContain("reviews/T1-r1/report.md");
      expect(order.inputs.join("\n")).toContain(reportPath);
      expect(order.findings.map((x) => x.findingId)).toEqual([P1.findingId]);
    } finally { f.close(); }
  });

  test("[验收线 7] in review, local pass: bounced in merge, never handed over", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      book(f, H1);
      await passToMerge(f, H1);
      expect(await h.hand()).toMatchObject({ step: "remote_bounce" });
      expect(h.handoffs()).toEqual([]);
    } finally { f.close(); }
  });

  test("[验收线 10] manual card: one notice without the report text; once PM moves it to fix, take_order carries the report", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      await f.review("changes", H1, [P1]);
      await f.cli("pm", "scheduler-fallback-manual", "T1", "--reason", "PM 接手");
      const p = book(f, H1);
      const [notice] = unsentRemoteNotices(f.db, "p");
      expect(notice!.text).toContain(String(p.event.data.reportPath));
      expect(notice!.text).not.toContain(INJECT);
      await f.cli("pm", "stage", "T1", "--from", "review", "--to", "fix");
      expect(f.task().stage).toBe("fix");
      expect(h.order().inputs.join("\n")).toContain(String(p.event.data.reportPath));
    } finally { f.close(); }
  });

  test("a superseded P1 (a later pass on the same head) no longer rides along or bounces", async () => {
    const f = autoFixture(), h = harness(f);
    try {
      await toReview(f);
      book(f, H1, { p1: 1, round: 1 });
      book(f, H1, { verdict: "pass", p1: 0, round: 2 });
      await passToMerge(f, H1);
      expect(await h.hand()).toMatchObject({ step: "handoff" });
    } finally { f.close(); }
  });
});
