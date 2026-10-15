/**
 * RRL-2 round-1 findings: after a carry only the PR head the handoff follows can bounce (a late review of the card's old head never
 * acts); an owner P1 still rides along when the fix already carries a bounce (merge conflict, or an older remote round); a merge-run
 * receipt is never made for a remote_review bounce.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { takeOrderResult } from "../src/lib/order-take.js";
import { recordRemoteReview } from "../src/lib/remote-review-ledger.js";
import { parseRemoteReview } from "../src/lib/remote-review-parse.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { bounceReceipt, type MergeBounce } from "../src/lib/scheduler-merge-conflict.js";
import { HANDOFF_POLL_MS, type HandoffPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { autoFixture, H1, H2, P2, toBuild } from "./scheduler-auto-helpers.js";
import { pushText } from "./helpers/remote-review-fixture.js";

const PR = "https://github.com/example/repo/pull/7";
const call = { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" } as never;
type F = ReturnType<typeof autoFixture>;

const book = (f: F, head: string, round = 1) => recordRemoteReview(f.db, f.at("scheduler"), { taskId: "T1",
  review: parseRemoteReview(pushText({ verdict: "changes", p1: 1, round }, { head }))!, peer: "Shawn", reportDir: join(f.dir, "reviews") });

async function toMerge(f: F) {
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, [P2]);
  await f.tick();
  expect(f.task().stage).toBe("merge");
}

function hand(f: F, pr: () => HandoffPr) {
  return async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps, prState: async () => pr() });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
}

/** Both order texts the author gets for the fix: take_order and the dispatch body. */
function fixTexts(f: F): string[] {
  const o = takeOrderResult(f.db, call);
  if (!o.ok || !o.order) throw new Error(JSON.stringify(o));
  const plan = planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
  if (plan.kind !== "intent") throw new Error(JSON.stringify(plan));
  const t = f.task(), intent = { id: plan.id, node: plan.node, head: t.headSHA, specRev: t.specRev } as SchedulerIntent;
  const d = workOrderFor(t, intent, plan, { taskId: "T1", role: "author", agent: "agent-task-one", sessionId: "s-one", family: "claude", transport: "tmux" }, undefined, f.db)!;
  return [[...o.order.inputs, ...o.order.acceptance].join("\n"), [...d.inputs, ...d.acceptance].join("\n")];
}

describe("RRL-2 r1", () => {
  test("stale-carried-head-bounce: after a carry H1 → H2 a late P1 on H1 never bounces; one on H2 does", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      const carry = { ok: true as const, reason: "净 diff 一致", mainParent: "b".repeat(40), mainHead: "c".repeat(40), diffHash: "d".repeat(64), basis: "net-diff" as const };
      let pr: HandoffPr = { state: "OPEN", head: H1, mergeSha: null };
      const tick = hand(f, () => pr);
      expect(await tick()).toMatchObject({ step: "handoff" });
      pr = { state: "OPEN", head: H2, mergeSha: null, carry };
      f.advance(HANDOFF_POLL_MS);
      expect(await tick()).toMatchObject({ step: "waiting" });
      expect(f.task().headSHA).toBe(H1); // the card keeps its reviewed head; the handoff follows H2
      book(f, H1);
      f.advance(HANDOFF_POLL_MS);
      expect(await tick()).toMatchObject({ step: "waiting" });
      expect(f.task().stage).toBe("merge");
      book(f, H2);
      f.advance(HANDOFF_POLL_MS);
      expect(await tick()).toMatchObject({ step: "remote_bounce" });
      const moved = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "stage")!;
      expect(moved.data).toMatchObject({ to: "fix", mergeBounce: { cause: "remote_review", prHead: H2 } });
    } finally { f.close(); }
  });

  test("remote-p1-hidden-by-existing-bounce: a fix bounced for a conflict still carries the owner's P1 on that head", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      const conflict: MergeBounce = { cause: "conflict", prHead: H1, mainHead: "e".repeat(40), checks: [] };
      f.db.query("UPDATE tasks SET stage = 'fix', round = round + 1 WHERE id = 'T1'").run();
      insertEvent(f.db, f.at("scheduler"), { project: "p", target: "T1", kind: "stage", text: "PR 和 main 冲突，退回 fix 解冲突",
        data: { from: "merge", to: "fix", round: f.task().round, specRev: 1, head: H1, mergeBounce: conflict } }, false);
      const path = String(book(f, H1).event.data.reportPath);
      for (const text of fixTexts(f)) {
        expect(text).toContain("解冲突");
        expect(text).toContain(path);
        expect(text).toContain("另外逐条修仓库方报告里的 P1");
      }
    } finally { f.close(); }
  });

  test("remote-p1-hidden-by-existing-bounce: a newer owner round on the same head rides along with the bounce's own report, once each", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      const first = String(book(f, H1, 1).event.data.reportPath);
      expect(await hand(f, () => ({ state: "OPEN", head: H1, mergeSha: null }))()).toMatchObject({ step: "remote_bounce" });
      for (const text of fixTexts(f)) {
        expect(text.split(first).length - 1).toBe(1); // the bounce names it; not repeated
      }
      const second = String(book(f, H1, 2).event.data.reportPath);
      expect(second).not.toBe(first);
      for (const text of fixTexts(f)) {
        expect(text).toContain(first);
        expect(text).toContain(second);
      }
    } finally { f.close(); }
  });

  test("remote-bounce-receipt-type: no merge-run receipt is made for a remote_review bounce", () => {
    const b: MergeBounce = { cause: "remote_review", prHead: H1, mainHead: null, checks: [], remote: { seq: 1, reportId: "PR7-r1", reportPath: "x", p1: 1 } };
    expect(() => bounceReceipt(b)).toThrow("仓库方审查退回不走合并运行回执");
  });
});

describe("RRL-2 r2", () => {
  const M = "a".repeat(40);
  const ended: [string, HandoffPr, string][] = [
    ["MERGED", { state: "MERGED", head: H1, mergeSha: M, base: "main", landing: { ok: true, mainHead: "e".repeat(40) } }, "landed"],
    ["CLOSED", { state: "CLOSED", head: H1, mergeSha: null }, "manual"],
  ];
  for (const [name, read, step] of ended) {
    test(`bounce-before-pr-state: after the handoff a ${name} PR ends the stay as before, an aligned P1 never sends it to fix`, async () => {
      const f = autoFixture();
      try {
        await toMerge(f);
        let pr: HandoffPr = { state: "OPEN", head: H1, mergeSha: null }, reads = 0;
        const tick = hand(f, () => { reads++; return pr; });
        expect(await tick()).toMatchObject({ step: "handoff" });
        book(f, H1);
        pr = read;
        f.advance(HANDOFF_POLL_MS);
        expect(await tick()).toMatchObject({ step });
        expect(reads).toBe(2);
        expect(f.task().stage).toBe(name === "MERGED" ? "live" : "merge");
        expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "remote_bounce")).toBe(false);
      } finally { f.close(); }
    });
  }

  test("bounce-before-pr-state: before the handoff a PR already merged goes to PM as before, not to fix", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      book(f, H1);
      let reads = 0;
      const tick = hand(f, () => { reads++; return { state: "MERGED", head: H1, mergeSha: M }; });
      expect(await tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("不交接") });
      expect(reads).toBe(1);
      expect(f.task().stage).toBe("merge");
      expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
    } finally { f.close(); }
  });

  test("bounce-before-pr-state: an open PR whose head is not the P1's head is not bounced on that read", async () => {
    const f = autoFixture();
    try {
      await toMerge(f);
      expect(await hand(f, () => ({ state: "OPEN", head: H1, mergeSha: null }))()).toMatchObject({ step: "handoff" });
      book(f, H1);
      f.advance(HANDOFF_POLL_MS);
      // the owner moved the PR in a way this machine cannot vouch for: PM, as before; never a fix on a head the PR left
      expect(await hand(f, () => ({ state: "OPEN", head: H2, mergeSha: null }))()).toMatchObject({ step: "manual" });
      expect(f.task().stage).toBe("merge");
    } finally { f.close(); }
  });
});
