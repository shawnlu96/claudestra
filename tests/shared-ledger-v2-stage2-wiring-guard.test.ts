/**
 * S2F r2 fixes (composition-lease / composition-maintenance), over the daemon's real pass entry:
 *  - a card whose own task lease another boot still holds gets no fence, even while the feature's other cards are leased;
 *  - the pre-pass projection and lease extension run inside the pass's maintenance lease / stop / singleton guard.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import { acquireMaintenance, SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { stage2LeaseAdapter } from "../src/lib/scheduler-v2-wiring-lease.js";
import { V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { schedulerV2Pass } from "../src/lib/scheduler-v2-wiring.js";
import { commands, F, intentsOf, memberCards, P, until, resetWorld, world } from "./shared-ledger-v2-stage2-wiring-world.test.js";

beforeEach(resetWorld);
afterEach(resetWorld);

const feature = { localFeatureId: F, projectId: P, homeInstanceId: "local",
  centerExecution: { centerId: "center", ...V2_FIXTURE_SCOPE, centerFeatureId: F, epoch: 1 } };

test("partial task lease: a card leased by another boot gets no fence, no claim and no ensure; the feature's other cards keep theirs", async () => {
  const s = await world();
  await until(() => s.w.leases.current(F) !== null);
  const { T } = await memberCards(s);
  // An older boot of this home still holds T's live task lease at the center (task-exec stays ours: resource_busy, transient).
  const leases = () => s.k.center.rows().leases;
  await stage2LeaseAdapter(s.wiring, () => "local").command(feature, "lease.acquire", "other-boot", null);
  expect(leases().get(T)!.bootId).toBe("other-boot");
  expect(await s.pass()).toEqual({ ran: true, failed: [] });
  expect(getTask(s.db, T)).toMatchObject({ featureId: F }); // projected
  expect(s.ensured).toEqual([]);
  expect(intentsOf(s.db, T)).toEqual([]);
  expect(leases().get(T)!.bootId).toBe("other-boot");
  expect(s.w.leases.current(F)).not.toBeNull();
});

test("maintenance held: the pass stands aside before any projection write or lease request", async () => {
  const s = await world();
  await until(() => s.w.leases.current(F) !== null);
  const { T } = await memberCards(s);
  const lock = await acquireMaintenance("deploy", { path: s.opts.maintenance!.path, marker: s.opts.maintenance!.marker });
  expect(lock).not.toBeNull();
  const before = s.requests.length;
  try {
    expect(await s.pass()).toEqual({ ran: false, failed: [] });
  } finally { lock!.release(); }
  expect(getTask(s.db, T)).toBeNull();
  expect(s.requests.slice(before)).toEqual([]);
});

test("stop / lost singleton: the pass throws before any projection write or lease request", async () => {
  const s = await world();
  await until(() => s.w.leases.current(F) !== null);
  const { T } = await memberCards(s);
  const before = s.requests.length;
  const stopped = { ...s.opts, assertOwner: () => { throw new SchedulerStopped("lost singleton"); } };
  await expect(schedulerV2Pass(s.db, s.config, stopped)).rejects.toBeInstanceOf(SchedulerStopped);
  expect(getTask(s.db, T)).toBeNull();
  expect(commands(s.requests.slice(before))).toEqual([]);
  expect(s.requests.slice(before)).toEqual([]);
});
