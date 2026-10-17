/**
 * dispatch-recovery-CIWAIT1: a required check that is red while its run is still going (another job of the run has not ended)
 * waits for the run instead of bouncing on gh's "still in progress" refusal; once the run ended, CIF1 / CIF8 decide as before.
 * Fixture in tests/scheduler-merge-ci-rerun-wait-kit.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { addKnownFlaky, setKnownFlakyModeSource } from "../src/lib/ci-known-flaky.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { assertIn, BOUNCED, BROKEN, HEAD, NOTHING, RUN, SLOW, TIMEOUT_ONLY, WAITING, withWaitCard, type WaitCard } from "./scheduler-merge-ci-rerun-wait-kit.js";
import { setOutOfDiffModeSource } from "../src/lib/ci-out-of-diff-rerun.js";

// merge-arch-CIRERUN1 · this file tests other layers of a red CI: the out-of-diff rerun (on by default) is pinned off here,
// its interplay with them is tests/ci-out-of-diff-rerun.test.ts
beforeEach(() => setOutOfDiffModeSource(() => "off"));
afterEach(() => setOutOfDiffModeSource(null));

let errors: Mock<typeof console.error>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); setKnownFlakyModeSource(null); });
const logged = () => errors.mock.calls.map((a) => String(a[0]));

/** Two ticks on the unfinished run: the card stays where it is, gh is only asked for the run's status, nothing is written or logged. */
const waits = async (c: WaitCard, phase = "await_ci") => {
  const before = c.written();
  await c.tick(200);
  await c.tick(260);
  expect(c.state()).toEqual({ run: phase, stage: "merge" });
  expect(c.acted()).toEqual(NOTHING);
  expect(c.events("merge_conflict")).toEqual([]);
  expect(c.events("merge_ci_rerun")).toEqual([]);
  expect(c.written()).toEqual(before);
  expect(logged()).toEqual([]);
};

describe("CIWAIT1 red required check on a run that is still in progress", () => {
  for (const phase of ["await_ci", "ready"]) {
    test(`[验收线 1] ${phase}: attempt 1 in_progress, gh refuses the failed log → waits, no bounce, no log / files / rerun call`, async () => {
      await withWaitCard({}, async (c) => {
        c.db.query("UPDATE scheduler_merges SET phase=? WHERE intentId=?").run(phase, c.intent);
        await waits(c, phase);
        expect(c.gh.argv.every((a) => a.join(" ") === "gh run view 77 --repo example/repo --json attempt,status,conclusion,headSha")).toBe(true);
      });
    });
  }

  test("[验收线 1] queued (not started yet) waits the same way", async () => {
    await withWaitCard({ status: "queued" }, (c) => waits(c));
  });

  test("[验收线 2] in_progress with a readable timeout-only log → still waits, the log is not read and no rerun is sent", async () => {
    await withWaitCard({ log: TIMEOUT_ONLY }, (c) => waits(c));
  });

  test("[验收线 3] run ends red on timeouts outside the PR → exactly one rerun through CIF1", async () => {
    await withWaitCard({}, async (c) => {
      await waits(c);
      c.finish(TIMEOUT_ONLY);
      await c.tick(320);
      expect([c.state(), c.acted().rerun]).toEqual([WAITING, 1]);
      expect(c.events("merge_ci_rerun")).toEqual([expect.objectContaining({ prHead: HEAD, run: RUN, checks: ["ci"],
        cases: [`${SLOW} > 本机 API last-seen > 过滤在 LIMIT 之前`] })]);
      expect(c.events("merge_conflict")).toEqual([]);
      // The rerun is attempt 2 and going: wait on; it ends red: the second red goes to fix, never a second rerun.
      c.gh.status = "in_progress";
      await c.tick(380);
      expect([c.state(), c.acted().rerun]).toEqual([WAITING, 1]);
      c.finish(TIMEOUT_ONLY);
      await c.tick(440);
      expect([c.state(), c.acted().rerun]).toEqual([BOUNCED, 1]);
    });
  });

  test("[验收线 3] run ends red on an assertion: on the known flaky list → rerun; not on it → fix with 有非超时失败", async () => {
    const owner = { actor: "owner", now: 150 };
    for (const listed of [true, false]) {
      await withWaitCard({}, async (c) => {
        setKnownFlakyModeSource(() => "on");
        if (listed) {
          const featureId = createFeature(c.db, owner, { project: "p", slug: "rel", title: "rel" }).row.id;
          initDag(c.db, owner, { id: featureId, rev: 1, nodes: [{ key: "FLAKY1", oneLine: "修时序竞态" }] });
          addKnownFlaky(c.db, owner, { project: "p", file: BROKEN, featureId, node: "FLAKY1", reason: "时序竞态" });
        }
        await waits(c);
        c.finish(assertIn(BROKEN));
        await c.tick(320);
        if (listed) {
          expect([c.state(), c.acted().rerun]).toEqual([WAITING, 1]);
          expect(c.events("merge_ci_rerun")).toEqual([expect.objectContaining({ run: RUN, knownFlaky: [expect.objectContaining({ file: BROKEN })] })]);
          expect(c.events("merge_conflict")).toEqual([]);
        } else {
          expect([c.state(), c.acted().rerun]).toEqual([BOUNCED, 0]);
          expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail", checks: [{ name: "ci", link: RUN }] })]);
          expect(logged()).toEqual([expect.stringContaining("CI 红，不自动重跑，退回 fix：有非超时失败：b > 断言")]);
        }
      });
    }
  });
});

describe("CIWAIT1 regression: what the run's status already decided stays as it was", () => {
  test("[验收线 5] completed + success with the PR checks still red → waits", async () => {
    await withWaitCard({ status: "completed", conclusion: "success" }, (c) => waits(c));
  });

  test("[验收线 5] attempt > 1 not finished → waits; finished and still red → fix with run 已重跑过", async () => {
    await withWaitCard({ attempt: 2 }, async (c) => {
      await waits(c);
      c.finish(TIMEOUT_ONLY);
      await c.tick(320);
      expect([c.state(), c.acted()]).toEqual([BOUNCED, NOTHING]);
      expect(logged()).toEqual([expect.stringContaining("退回 fix：run 已重跑过（第 2 次仍红）")]);
    });
  });

  test("[验收线 5] reading the run's status itself fails → fix with 读 CI 失败, as before", async () => {
    await withWaitCard({ runView: new Error("HTTP 502: Bad Gateway") }, async (c) => {
      await c.tick();
      expect([c.state(), c.acted()]).toEqual([BOUNCED, NOTHING]);
      expect(c.events("merge_conflict")).toEqual([expect.objectContaining({ cause: "ci_fail" })]);
      expect(logged()).toEqual([expect.stringContaining("退回 fix：读 CI 失败：gh run view 失败：HTTP 502: Bad Gateway")]);
    });
  });

  test("[验收线 5] a completed run whose failed log gh cannot give → fix with 读 CI 失败, as before", async () => {
    await withWaitCard({ status: "completed", conclusion: "failure", log: new Error("HTTP 404") }, async (c) => {
      await c.tick();
      expect([c.state(), c.acted()]).toEqual([BOUNCED, { ...NOTHING, log: 1 }]);
      expect(logged()).toEqual([expect.stringContaining("退回 fix：读 CI 失败：gh run view 失败：HTTP 404")]);
    });
  });
});
