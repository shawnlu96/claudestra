/**
 * RRL-3 r1: a PR the owner's P1 sends back to fix is a draft again before the bounce (the owner's queue skips drafts, so it cannot
 * review the fix's heads first) and turns ready again at the next handoff; a refused undo holds the bounce and is retried on the
 * very next pass. A PR merged at a head with an unhandled owner P1 goes to PM even while the landing proof is still missing.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { recordRemoteReview } from "../src/lib/remote-review-ledger.js";
import { parseRemoteReview } from "../src/lib/remote-review-parse.js";
import type { runBounded } from "../src/lib/run-bounded.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { ghPrState, HANDOFF_POLL_MS, type HandoffPr, type ReadPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2, P2, toBuild } from "./scheduler-auto-helpers.js";
import { pushText } from "./helpers/remote-review-fixture.js";

const PR = "https://github.com/example/repo/pull/7";
type F = ReturnType<typeof autoFixture>;

const book = (f: F, head: string) => recordRemoteReview(f.db, f.at("scheduler"), { taskId: "T1",
  review: parseRemoteReview(pushText({ verdict: "changes", p1: 1 }, { head }))!, peer: "Shawn", reportDir: join(f.dir, "reviews") });

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

/**
 * A GitHub PR as ghPrState moves it (tests/remote-review-draft.test.ts pins the gh argv): OPEN at the followed head, a draft turns
 * ready when handed over and back to a draft on `want: "draft"`; `undoFails` refusals of the undo first.
 */
function github(f: F) {
  const s = { pr: { state: "OPEN", head: H1, mergeSha: null, draft: true } as HandoffPr, undoFails: 0, reads: 0, undos: 0,
    readies: 0, bounceFails: 0 };
  const read: ReadPr = async (_ref, follow, _handing, want) => {
    s.reads++;
    const at = follow && s.pr.state === "OPEN" && s.pr.head === follow.head;
    if (at && want === "draft" && s.pr.draft === false) {
      s.undos++;
      if (s.undoFails > 0) { s.undoFails--; return { ...s.pr, flipError: "gh pr ready --undo 失败：HTTP 502" }; }
      s.pr = { ...s.pr, draft: true };
    } else if (at && !want && s.pr.draft) { s.readies++; s.pr = { ...s.pr, draft: false }; }
    return { ...s.pr };
  };
  // `bounceFails` refusals of the ledger's --remote-bounce write first (a busy ledger after gh already made the PR a draft)
  const manager: typeof f.tickDeps.manager = async (...args) => {
    if (args.includes("--remote-bounce") && s.bounceFails > 0) { s.bounceFails--; return { ok: false, error: "台账忙" }; }
    return f.tickDeps.manager(...args);
  };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps, manager, prState: read });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  return { s, tick };
}
const handoffs = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "merge_handoff");

describe("draft-after-remote-bounce", () => {
  test("ready at the handoff → draft again on the owner's P1 → fix → re-review → ready again at the next handoff", async () => {
    const f = autoFixture(), g = github(f);
    try {
      await toMerge(f);
      expect(await g.tick()).toMatchObject({ step: "handoff" });
      expect(g.s.pr.draft).toBe(false);
      book(f, H1);
      expect(await g.tick()).toMatchObject({ step: "remote_bounce" });
      expect(f.task().stage).toBe("fix");
      expect(g.s.pr.draft).toBe(true); // before the fix's first push the owner's queue no longer sees it

      g.s.pr = { ...g.s.pr, head: H2 }; // the author pushes the fix
      await f.tick(); // fix dispatch
      await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
      await f.tick(); // review order
      await f.review("pass", H2, [P2]);
      await f.tick();
      expect(f.task().stage).toBe("merge");
      expect(g.s.pr.draft).toBe(true); // all through fix and re-review

      expect(await g.tick()).toMatchObject({ step: "handoff" });
      expect(handoffs(f)).toHaveLength(2);
      expect(handoffs(f).at(-1)!.data.evidence).toMatchObject({ head: H2 });
      expect(g.s.pr.draft).toBe(false);
    } finally { f.close(); }
  });

  test("a refused undo holds the bounce (card stays in merge) and the very next pass tries again, no clock moved", async () => {
    const f = autoFixture(), g = github(f);
    try {
      await toMerge(f);
      expect(await g.tick()).toMatchObject({ step: "handoff" });
      book(f, H1);
      g.s.undoFails = 1;
      expect(await g.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("没把 PR 转回草稿，下轮再试：gh pr ready --undo 失败：HTTP 502") });
      expect(f.task().stage).toBe("merge");
      expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "remote_bounce")).toBe(false);
      expect(await g.tick()).toMatchObject({ step: "remote_bounce" });
      expect(g.s.undos).toBe(2);
      expect(g.s.pr.draft).toBe(true);
      expect(f.task().stage).toBe("fix");
    } finally { f.close(); }
  });

  test("undone but the bounce write refused: the retry reads the PR as a draft and never turns it ready first", async () => {
    const f = autoFixture(), g = github(f);
    try {
      await toMerge(f);
      expect(await g.tick()).toMatchObject({ step: "handoff" });
      expect(g.s.readies).toBe(1);
      book(f, H1);
      g.s.bounceFails = 1;
      expect(await g.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("仓库方 P1 打回没记上：台账忙") });
      expect(g.s.pr.draft).toBe(true);
      expect(f.task().stage).toBe("merge");
      expect(await g.tick()).toMatchObject({ step: "remote_bounce" });
      expect(g.s.readies).toBe(1); // no ready → draft window the owner's queue could pick the PR up in
      expect(g.s.undos).toBe(1);
      expect(g.s.pr.draft).toBe(true);
      expect(f.task().stage).toBe("fix");
    } finally { f.close(); }
  });

  test("a PR whose draft state gh did not report is bounced as before, never undone", async () => {
    const f = autoFixture(), g = github(f);
    try {
      await toMerge(f);
      g.s.pr = { state: "OPEN", head: H1, mergeSha: null };
      expect(await g.tick()).toMatchObject({ step: "handoff" });
      book(f, H1);
      expect(await g.tick()).toMatchObject({ step: "remote_bounce" });
      expect(g.s.undos).toBe(0);
    } finally { f.close(); }
  });

  test("ghPrState: want draft runs gh pr ready --undo on a ready PR at the followed head only", async () => {
    const calls: string[][] = [];
    let code = 0;
    const command = (async (argv: string[]) => {
      calls.push(argv);
      if (argv[2] === "ready") return { code, stdout: "", stderr: code ? "HTTP 502\nmore" : "", timedOut: false };
      return { code: 0, stdout: JSON.stringify(view), stderr: "", timedOut: false };
    }) as unknown as typeof runBounded;
    let view: Record<string, unknown> = { state: "OPEN", headRefOid: H1, mergeCommit: null, baseRefName: "main", isDraft: false };
    const none = () => null, read = ghPrState(command, none, none, none);
    expect(await read(PR, { project: "p", head: H1 }, undefined, "draft")).toMatchObject({ draft: true });
    expect(calls.filter((a) => a[2] === "ready")).toEqual([["gh", "pr", "ready", PR, "--undo"]]);
    code = 1;
    expect(await read(PR, { project: "p", head: H1 }, undefined, "draft")).toMatchObject({ draft: false, flipError: "gh pr ready --undo 失败：HTTP 502" });
    calls.length = 0;
    expect(await read(PR, { project: "p", head: H1 })).toMatchObject({ draft: false }); // handed over and ready: nothing to do
    for (const v of [{ isDraft: true }, { isDraft: undefined }, { headRefOid: H2 }, { state: "CLOSED" }]) {
      view = { state: "OPEN", headRefOid: H1, mergeCommit: null, baseRefName: "main", isDraft: false, ...v };
      await read(PR, { project: "p", head: H1 }, undefined, "draft");
    }
    expect(calls.filter((a) => a[2] === "ready")).toEqual([]);
  });
});

describe("merged-pr-p1-landing-held", () => {
  const unproven: [string, HandoffPr][] = [
    ["the landing proof failed", { state: "MERGED", head: H1, mergeSha: "a".repeat(40), base: "main", landing: { ok: false, reason: "fetch failed" } }],
    ["the merge commit is not readable yet", { state: "MERGED", head: H1, mergeSha: null, base: "main" }],
  ];
  for (const [why, merged] of unproven) {
    test(`merged at the P1's head while ${why}: PM with the report path in that pass, not held`, async () => {
      const f = autoFixture(), g = github(f);
      try {
        await toMerge(f);
        expect(await g.tick()).toMatchObject({ step: "handoff" });
        const path = String(book(f, H1).event.data.reportPath);
        g.s.pr = merged;
        expect(await g.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("仓库方已合并 PR") });
        expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
        expect(f.notices.at(-1)).toContain(path);
        expect(f.task().stage).toBe("merge");
      } finally { f.close(); }
    });
  }

  test("without a P1 on that head an unproven merge is still held, as before", async () => {
    const f = autoFixture(), g = github(f);
    try {
      await toMerge(f);
      expect(await g.tick()).toMatchObject({ step: "handoff" });
      book(f, H2);
      g.s.pr = unproven[0]![1];
      f.advance(HANDOFF_POLL_MS); // nothing pending on this head: the poll pace holds
      expect(await g.tick()).toMatchObject({ step: "held" });
      expect(getWorkflow(f.db, "T1")!.mode).toBe("auto");
    } finally { f.close(); }
  });
});

describe("bounce-second-read-stale", () => {
  const changed: [string, HandoffPr][] = [
    ["closed (and a draft)", { state: "CLOSED", head: H1, mergeSha: null, draft: true }],
    ["moved to another head (and a draft)", { state: "OPEN", head: H2, mergeSha: null, draft: true }],
  ];
  for (const [why, second] of changed) {
    test(`the undo's read finds the PR ${why}: no bounce on the first read's head, the next pass takes the PR as it now is`, async () => {
      const f = autoFixture(), replies: HandoffPr[] = [{ state: "OPEN", head: H1, mergeSha: null, draft: false }, second];
      const read: ReadPr = async () => ({ ...(replies.length > 1 ? replies.shift()! : replies[0]!) });
      const tick = () => schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps, prState: read });
      try {
        await toMerge(f);
        book(f, H1); // before the handoff: PM had made the PR ready by hand
        expect((await tick()).cards[0]).toMatchObject({ step: "held", detail: expect.stringContaining("PR 变了") });
        expect(f.task().stage).toBe("merge");
        expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "remote_bounce")).toBe(false);
        expect((await tick()).cards[0]).toMatchObject({ step: "manual", detail: expect.stringContaining("不交接") });
        expect(f.task().stage).toBe("merge");
      } finally { f.close(); }
    });
  }
});
