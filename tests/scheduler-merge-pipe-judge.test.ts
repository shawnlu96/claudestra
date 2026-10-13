/**
 * merge-arch-MRGPIPE1 · the pipe's pure judgments one by one (scheduler-merge-pipe-judge.ts): file disjointness, the project
 * gates, the holder's own state and CI, the borrower's PR. The pass-level world runs in scheduler-merge-pipe.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { borrowerReady, filesDisjoint, holderRefusal, holderWaits, PIPE_CANDIDATES, PIPE_LENDS_MAX, pipeBorrower, pipeReceipt, projectRefusal,
  type PipeHolderFacts, type PipeProjectFacts } from "../src/lib/scheduler-merge-pipe-judge.js";
import { isSlotTurn, SLOT_RECLAIM, SLOT_YIELD } from "../src/lib/scheduler-merge-train-hold.js";

const HEAD = "a".repeat(40);
type Check = PrSnapshot["checks"][number];
const pr = (o: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head: HEAD, branch: "task/T2", crossRepository: false, base: "main", draft: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...o });
const checks = (...c: [string, Check["bucket"]][]): Check[] => c.map(([name, bucket]) => ({ name, bucket }));

describe("[验收线 2] files", () => {
  test("disjoint only when both lists were read and share no path", () => {
    expect(filesDisjoint(["src/a.ts"], ["src/b.ts"])).toBe(true);
    expect(filesDisjoint([], ["src/b.ts"])).toBe(true);
    expect(filesDisjoint(["src/a.ts", "src/lib/recovery-keys.ts"], ["src/lib/recovery-keys.ts"])).toBe(false);
  });
  test("an old rename path in either list overlaps", () => {
    expect(filesDisjoint(["src/a.ts"], ["src/new.ts", "src/a.ts"])).toBe(false); // the borrower renamed the holder's file
    expect(filesDisjoint(["src/moved.ts", "src/b.ts"], ["src/b.ts"])).toBe(false);
  });
  test("an unread list (null: past GitHub's 3000-file cap or no port) overlaps", () => {
    expect(filesDisjoint(null, ["src/b.ts"])).toBe(false);
    expect(filesDisjoint(["src/a.ts"], null)).toBe(false);
    expect(filesDisjoint(null, null)).toBe(false);
  });
});

describe("[验收线 4] project gates", () => {
  const ok: PipeProjectFacts = { mode: "on", direct: true, autoDispatch: true, store: true, trainHolds: false, manualBlocks: false, frozen: false,
    mainCiPaused: false, ciCoverageOn: false };
  test("all clear: no refusal (on and observe judge alike)", () => {
    expect(projectRefusal(ok)).toBeNull();
    expect(projectRefusal({ ...ok, mode: "observe" })).toBeNull();
  });
  const each: [string, Partial<PipeProjectFacts>][] = [
    ["mergePipe off", { mode: "off" }], ["mergeDirect observe / off / unreadable", { direct: false }], ["autoDispatch off", { autoDispatch: false }],
    ["no train store (store \"default\" in a test process)", { store: false }], ["a live train", { trainHolds: true }],
    ["a manual merge request due or merging", { manualBlocks: true }], ["queue frozen", { frozen: true }], ["main CI paused", { mainCiPaused: true }],
    ["ciCoverageGate on", { ciCoverageOn: true }],
  ];
  for (const [what, f] of each) test(`refused: ${what}`, () => expect(projectRefusal({ ...ok, ...f })).toEqual(expect.any(String)));
});

describe("[验收线 4] the holder", () => {
  const ok: PipeHolderFacts = { manual: false, intentStatus: "submitted", phase: "await_ci", drift: null, lends: 0, late: false, skip: false };
  test("an auto run at await_ci, undrifted, under the lend cap: read its PR", () => {
    expect(holderRefusal(ok)).toBeNull();
    expect(holderRefusal({ ...ok, lends: PIPE_LENDS_MAX - 1 })).toBeNull();
  });
  const each: [string, Partial<PipeHolderFacts>][] = [
    ["a manual merge (mmq intent)", { manual: true }], ["phase ready", { phase: "ready" }], ["phase updating", { phase: "updating" }],
    ["phase merging", { phase: "merging" }], ["intent unknown", { intentStatus: "unknown" }], ["drifted", { drift: "卡已离开 merge" }],
    [`${PIPE_LENDS_MAX} lends already`, { lends: PIPE_LENDS_MAX }], ["taken back this pass", { late: true }], ["a skip card", { skip: true }],
  ];
  for (const [what, f] of each) test(`refused: ${what}`, () => expect(holderRefusal({ ...ok, ...f })).toEqual(expect.any(String)));

  const run = { reviewedHead: HEAD, requiredChecks: "check" };
  test("still waiting: the required check is pending or not reported yet → lend", () => {
    expect(holderWaits(run, pr({ mergeState: "UNSTABLE", checks: checks(["check", "pending"]) }))).toBeNull();
    expect(holderWaits(run, pr({ mergeState: "UNSTABLE", checks: checks(["test (1/8)", "pending"]) }))).toBeNull();
    expect(holderWaits({ ...run, requiredChecks: "check,guard" }, pr({ mergeState: "UNSTABLE", checks: checks(["check", "pass"]) }))).toBeNull();
  });
  test("CIF3 unsettled (a shard red, the required gate still pending) → still lends", () => {
    expect(holderWaits(run, pr({ mergeState: "UNSTABLE", checks: checks(["test (2/8)", "fail"], ["check", "pending"]) }))).toBeNull();
  });
  test("every required check green, or one failed / cancelled → no lend (it merges or bounces next)", () => {
    expect(holderWaits(run, pr())).toEqual(expect.any(String));
    expect(holderWaits(run, pr({ mergeState: "UNSTABLE", checks: checks(["check", "pass"], ["extra", "pending"]) }))).toEqual(expect.any(String));
    expect(holderWaits(run, pr({ mergeState: "UNSTABLE", checks: checks(["check", "fail"]) }))).toEqual(expect.any(String));
    expect(holderWaits(run, pr({ mergeState: "UNSTABLE", checks: checks(["check", "cancel"]) }))).toEqual(expect.any(String));
  });
  test("its PR moved, closed or DIRTY → no lend", () => {
    const pending = checks(["check", "pending"]);
    expect(holderWaits(run, pr({ checks: pending, head: "b".repeat(40) }))).toEqual(expect.any(String));
    expect(holderWaits(run, pr({ checks: pending, state: "CLOSED" }))).toEqual(expect.any(String));
    expect(holderWaits(run, pr({ checks: pending, mergeState: "DIRTY" }))).toEqual(expect.any(String));
  });
});

describe("[验收线 4] the borrower", () => {
  const task = { headSHA: HEAD, branch: "task/T2" };
  test("open, at the card head, CLEAN or BEHIND, all green → ready", () => {
    expect(borrowerReady(task, "check", pr())).toBeNull();
    expect(borrowerReady(task, "check", pr({ mergeState: "BEHIND" }))).toBeNull();
    expect(borrowerReady({ ...task, headSHA: HEAD.toUpperCase() }, "check", pr())).toBeNull();
  });
  const each: [string, Partial<PrSnapshot>][] = [
    ["CI pending", { mergeState: "UNSTABLE", checks: checks(["check", "pending"]) }],
    ["CI red", { mergeState: "UNSTABLE", checks: checks(["check", "fail"]) }],
    ["a required check missing", { checks: checks(["other", "pass"]) }],
    ["a non-required check pending", { checks: checks(["check", "pass"], ["extra", "pending"]) }],
    ["mergeState UNKNOWN", { mergeState: "UNKNOWN" }], ["mergeState DIRTY", { mergeState: "DIRTY" }],
    ["mergeState BLOCKED", { mergeState: "BLOCKED" }], ["mergeState UNSTABLE", { mergeState: "UNSTABLE" }],
    ["head differs from task.headSHA", { head: "b".repeat(40) }], ["draft", { draft: true }], ["closed", { state: "CLOSED" }],
    ["cross-repository", { crossRepository: true }], ["base not main", { base: "dev" }], ["another branch", { branch: "task/X" }],
  ];
  for (const [what, o] of each) test(`not ready: ${what}`, () => expect(borrowerReady(task, "check", pr(o))).toEqual(expect.any(String)));
  test("no head on the card → not ready", () => expect(borrowerReady({ ...task, headSHA: null }, "check", pr())).toEqual(expect.any(String)));
});

describe("receipt and limits", () => {
  test("the yield receipt is a slot turn (SLOT_YIELD) that names its borrower; other receipts name none", () => {
    const r = pipeReceipt("merge-arch-T2");
    expect(r.startsWith(SLOT_YIELD)).toBe(true);
    expect(isSlotTurn(r)).toBe(true);
    expect(pipeBorrower(r)).toBe("merge-arch-T2");
    expect(pipeBorrower(`${SLOT_YIELD}T1 等第 1 辆列车 x 结束`)).toBeNull();
    expect(pipeBorrower(SLOT_RECLAIM)).toBeNull();
    expect(pipeBorrower(null)).toBeNull();
  });
  test("thresholds as decided: 3 candidates per pass, 5 lends per run", () => {
    expect([PIPE_CANDIDATES, PIPE_LENDS_MAX]).toEqual([3, 5]);
  });
});
