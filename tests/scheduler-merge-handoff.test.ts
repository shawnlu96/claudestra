/**
 * MHO1 merge handoff at the auto tick: a mergeHandoff project's card in `merge` is handed to the repository owner with its review
 * evidence (one ledger event), never gets a merge intent or the merge slot, and follows the PR: MERGED at the handed head → live,
 * CLOSED / a moved head / a mismatch at handoff → PM. Pass-level coverage (train, merge driver, reclaim): scheduler-merge-handoff-pass.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { HANDOFF_POLL_MS, type HandoffPr } from "../src/lib/scheduler-merge-handoff-tick.js";
import { autoFixture, H1, H2, P2, toBuild } from "./scheduler-auto-helpers.js";

const PR = "https://github.com/example/repo/pull/7";
const M = "a".repeat(40);

/** The full auto flow up to `merge`: build → deliver H1 with the PR → cross-family review passes with one P2. */
async function handoffFixture() {
  const f = autoFixture();
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1, "--pr", PR);
  await f.tick(); // reviewer session
  await f.tick(); // review order
  await f.review("pass", H1, [P2]);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  let pr: HandoffPr | Error = { state: "OPEN", head: H1, mergeSha: null };
  const reads: string[] = [];
  const hand = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, mergeHandoff: true } }, { ...f.tickDeps,
      prState: async (ref) => { reads.push(ref); if (pr instanceof Error) throw pr; return pr; } });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const handoffs = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "merge_handoff");
  const mergeIntents = () => f.intents().filter((i) => i.action === "merge");
  const mergeSlot = () => f.db.query("SELECT * FROM scheduler_resources WHERE resource = 'merge:p'").all();
  return { f, hand, reads, handoffs, mergeIntents, mergeSlot, setPr: (p: HandoffPr | Error) => { pr = p; } };
}

describe("MHO1 merge handoff (auto tick)", () => {
  test("hands over with the listed evidence instead of a merge intent; MERGED at that head moves the card to live", async () => {
    const h = await handoffFixture(), { f } = h;
    try {
      expect(await h.hand()).toMatchObject({ step: "handoff", detail: `已交仓库方合并 ${PR}` });
      const [ev] = h.handoffs();
      const review = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review")!;
      expect(ev).toMatchObject({ actor: "scheduler", kind: "scheduler" });
      expect(ev!.data).toEqual({ op: "merge_handoff", evidence: { v: 1, pr: PR, head: H1, specRev: 1, template: "code", authorFamily: "claude",
        review: { round: 1, verdict: "pass", reviewerFamily: "codex", reportPath: "reviews/T1-r1/report.md", p2: 1, reviewSeq: review.seq } } });
      expect(f.notices.at(-1)).toContain(`T1 审查通过，合并交给仓库方：${PR}`);
      expect(h.mergeIntents()).toEqual([]);
      expect(h.mergeSlot()).toEqual([]);

      // waiting on the owner: no second record, no gh read inside the poll interval
      expect(await h.hand()).toMatchObject({ step: "waiting", detail: "已交仓库方合并，等 PR 结果" });
      expect(h.reads).toHaveLength(1);
      f.advance(HANDOFF_POLL_MS);
      expect(await h.hand()).toMatchObject({ step: "waiting" });
      expect(h.reads).toHaveLength(2);
      expect(h.handoffs()).toHaveLength(1);

      h.setPr({ state: "MERGED", head: H1, mergeSha: M });
      f.advance(HANDOFF_POLL_MS);
      expect(await h.hand()).toMatchObject({ step: "landed" });
      expect(f.task()).toMatchObject({ stage: "live", headSHA: H1 });
      const moved = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "stage")!;
      expect(moved).toMatchObject({ actor: "scheduler", data: { from: "merge", to: "live", head: H1, mergeSha: M, handoffSeq: ev!.seq } });
      expect(f.notices.at(-1)).toContain("已由仓库方合并");
      expect(await h.hand()).toMatchObject({ step: "waiting", detail: "verify 由合并队列 / 收尾步骤（scheduler-retire.ts）处理" });
      expect(h.mergeIntents()).toEqual([]);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    } finally { f.close(); }
  });

  test("a PR head that differs from the ledger head at handoff goes to PM and records nothing", async () => {
    const h = await handoffFixture(), { f } = h;
    try {
      h.setPr({ state: "OPEN", head: H2, mergeSha: null });
      expect(await h.hand()).toMatchObject({ step: "manual" });
      expect(h.handoffs()).toEqual([]);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(f.notices.at(-1)).toContain("不交接");
      expect(f.task().stage).toBe("merge");
    } finally { f.close(); }
  });

  test("a PR already merged or closed before the handoff is not handed over either", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const h = await handoffFixture(), { f } = h;
      try {
        h.setPr({ state, head: H1, mergeSha: state === "MERGED" ? M : null });
        expect(await h.hand()).toMatchObject({ step: "manual" });
        expect(h.handoffs()).toEqual([]);
        expect(f.task().stage).toBe("merge");
      } finally { f.close(); }
    }
  });

  test("CLOSED after the handoff, a moved PR head, or a merge at another head all go back to PM; the card stays in merge", async () => {
    const cases: [HandoffPr, string][] = [
      [{ state: "CLOSED", head: H1, mergeSha: null }, "被关闭、没有合并"],
      [{ state: "OPEN", head: H2, mergeSha: null }, "交接后 PR head 变了"],
      [{ state: "MERGED", head: H2, mergeSha: M }, "交接后 PR head 变了"],
    ];
    for (const [pr, why] of cases) {
      const h = await handoffFixture(), { f } = h;
      try {
        expect(await h.hand()).toMatchObject({ step: "handoff" });
        h.setPr(pr);
        f.advance(HANDOFF_POLL_MS);
        expect(await h.hand()).toMatchObject({ step: "manual", detail: expect.stringContaining(why) });
        expect(f.task().stage).toBe("merge");
        expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
        expect(h.mergeIntents()).toEqual([]);
      } finally { f.close(); }
    }
  });

  test("a PR changed on the card after the handoff goes to PM; the new PR is never read, even merged at the same head", async () => {
    const h = await handoffFixture(), { f } = h;
    const other = "https://github.com/example/other/pull/8";
    try {
      expect(await h.hand()).toMatchObject({ step: "handoff" });
      expect((await f.cli("pm", "task-set", "T1", "--rev", String(f.task().rev), "--pr", other)).ok).toBe(true);
      h.setPr({ state: "MERGED", head: H1, mergeSha: M });
      f.advance(HANDOFF_POLL_MS);
      expect(await h.hand()).toMatchObject({ step: "manual", detail: expect.stringContaining("卡上的 PR 已不是交接的那个") });
      expect(h.reads).toEqual([PR]);
      expect(f.task()).toMatchObject({ stage: "merge", pr: other });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    } finally { f.close(); }
  });

  test("landing rechecks the handed PR itself: a merge reported for another PR at the same head is refused", async () => {
    const h = await handoffFixture(), { f } = h;
    const other = "https://github.com/example/other/pull/8";
    try {
      expect(await h.hand()).toMatchObject({ step: "handoff" });
      f.db.query("UPDATE tasks SET pr = ? WHERE id = 'T1'").run(other);
      expect(await f.tickDeps.manager("ledger", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", other, "--merged", M))
        .toMatchObject({ ok: false, code: "conflict", error: "这个 PR 和 head 没有交接记录" });
      expect(await f.tickDeps.manager("ledger", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR, "--merged", M))
        .toMatchObject({ ok: false, code: "conflict" }); // the handed PR is no longer the card's either
      expect(f.task().stage).toBe("merge");
    } finally { f.close(); }
  });

  test("an unreadable PR holds the card without writing; the next pass reads again", async () => {
    const h = await handoffFixture(), { f } = h;
    try {
      h.setPr(new Error("gh 断网"));
      expect(await h.hand()).toMatchObject({ step: "held", detail: "读 PR 状态失败，下轮再试：gh 断网" });
      expect(h.handoffs()).toEqual([]);
      h.setPr({ state: "OPEN", head: H1, mergeSha: null });
      expect(await h.hand()).toMatchObject({ step: "handoff" });
      expect(h.reads).toHaveLength(2);
    } finally { f.close(); }
  });

  test("a merge intent left from before the switch goes to PM instead of the merge queue", async () => {
    const h = await handoffFixture(), { f } = h;
    try {
      expect(await f.tick()).toMatchObject({ step: "merge_queue" }); // the project still merged locally
      const [intent] = h.mergeIntents();
      expect(intent).toMatchObject({ status: "pending" });
      expect(await h.hand()).toMatchObject({ step: "manual", detail: expect.stringContaining(`本机不执行合并意图 ${intent!.id}`) });
      expect(h.mergeIntents()).toEqual([{ ...intent!, status: "cancelled" }]);
      expect(h.handoffs()).toEqual([]);
      expect(h.reads).toEqual([]);
    } finally { f.close(); }
  });

  test("the handoff command is the scheduler's alone and rechecks head, PR and record in its own transaction", async () => {
    const h = await handoffFixture(), { f } = h;
    try {
      expect(await f.cli("pm", "scheduler-merge-handoff", "T1", "--head", H1, "--pr", PR)).toMatchObject({ ok: false, code: "forbidden" });
      const as = (...args: string[]) => f.tickDeps.manager("ledger", "scheduler-merge-handoff", "T1", ...args);
      expect(await as("--head", H2, "--pr", PR)).toMatchObject({ ok: false, code: "conflict" });
      expect(await as("--head", H1, "--pr", `${PR}0`)).toMatchObject({ ok: false, code: "conflict" });
      expect(await as("--head", H1, "--pr", PR, "--merged", M)).toMatchObject({ ok: false, code: "conflict", error: "这个 PR 和 head 没有交接记录" });
      const first = await as("--head", H1, "--pr", PR);
      expect(first).toMatchObject({ ok: true, duplicate: false });
      expect(await as("--head", H1, "--pr", PR)).toMatchObject({ ok: true, duplicate: true });
      expect(await as("--head", H1, "--pr", PR, "--merged", "abc")).toMatchObject({ ok: false, code: "invalid" });
      expect(f.task().stage).toBe("merge");
    } finally { f.close(); }
  });
});

describe("MHO1 scheduler.json mergeHandoff", () => {
  const project = (extra: Record<string, unknown>) => ({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/tmp/p", ...extra } } });
  test("true is kept, absent / false leave the project exactly as before, anything else or with deploy is refused", () => {
    expect(parseSchedulerConfig(project({ mergeHandoff: true })).projects.p!.mergeHandoff).toBe(true);
    expect("mergeHandoff" in parseSchedulerConfig(project({})).projects.p!).toBe(false);
    expect(parseSchedulerConfig(project({ mergeHandoff: false })).projects.p).toEqual(parseSchedulerConfig(project({})).projects.p);
    expect(() => parseSchedulerConfig(project({ mergeHandoff: "yes" }))).toThrow("mergeHandoff must be boolean");
    expect(() => parseSchedulerConfig(project({ mergeHandoff: true, deploy: { restartLabels: ["x.fake"] } }))).toThrow("mergeHandoff cannot deploy");
  });
});
