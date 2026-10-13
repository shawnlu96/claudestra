/**
 * dispatch-recovery-CIWAIT1, CIF2's layer: with both gh sets on the external (bounceStep → ciBehindOrRerun, the live path), a
 * required check that is red while its run is still going never reaches planBehind: no second failed-log read, no
 * update-branch, no bounce. Once the run ended, CIF2 merges main in as before. Fixture in tests/scheduler-merge-ci-rerun-wait-kit.ts.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { assertIn, BOUNCED, HEAD, NOTHING, RUN, withWaitCard, type WaitCard } from "./scheduler-merge-ci-rerun-wait-kit.js";

const STALE = "tests/lend-claude-capacity.test.ts";
let errors: Mock<typeof console.error>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => errors.mockRestore());
const logged = () => errors.mock.calls.map((a) => String(a[0]));

const waits = async (c: WaitCard) => {
  const before = c.written();
  await c.tick(200);
  await c.tick(260);
  expect(c.state()).toEqual({ run: "await_ci", stage: "merge" });
  expect(c.acted()).toEqual(NOTHING);
  expect(c.events("merge_conflict")).toEqual([]);
  expect(c.events("merge_ci_behind")).toEqual([]);
  expect(c.written()).toEqual(before);
  expect(logged()).toEqual([]);
};

describe("CIWAIT1 through CIF2: a red required check on a run still in progress", () => {
  test("[验收线 4] gh refuses the failed log → neither layer reads it, no update-branch, no bounce", async () => {
    await withWaitCard({}, (c) => waits(c), { behind: true });
  });

  test("[验收线 4] even with a readable log CIF2 would merge main in for → waits; the run ends → one update-branch, as before", async () => {
    await withWaitCard({ log: assertIn(STALE) }, async (c) => {
      await waits(c);
      c.finish(assertIn(STALE));
      await c.tick(320);
      expect(c.state()).toEqual({ run: "updating", stage: "merge" });
      expect(c.acted()).toMatchObject({ rerun: 0, update: 1 });
      expect(c.events("merge_ci_behind")).toEqual([expect.objectContaining({ oldHead: HEAD, run: RUN, checks: ["ci"] })]);
      expect(c.events("merge_conflict")).toEqual([]);
    }, { behind: true });
  });

  test("[验收线 4] the run ends and gh still cannot give its log → both layers read it and the card goes to fix, as before", async () => {
    await withWaitCard({}, async (c) => {
      await waits(c);
      Object.assign(c.gh, { status: "completed", conclusion: "failure", log: new Error("HTTP 404") });
      await c.tick(320);
      expect([c.state(), c.acted()]).toEqual([BOUNCED, { ...NOTHING, log: 2 }]);
      expect(logged()).toEqual([expect.stringContaining("不自动重跑，退回 fix：读 CI 失败："), expect.stringContaining("不自动合入 main，退回 fix：读 CI / main 失败：")]);
    }, { behind: true });
  });
});
