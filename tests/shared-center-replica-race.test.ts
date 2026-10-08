/** N7X1 review fixes: concurrent syncs of two center features colliding on one local id (AC1 / AC5), verbatim center nodes (AC1). */
import { afterEach, expect, test } from "bun:test";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { LedgerError } from "../src/lib/ledger-store.js";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { readCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import { centerReplicaLocalId, REPLICA_REASONS, syncCenterReplicas } from "../src/lib/shared-ledger-center-replica.js";
import { REPLICA_ACTOR, REPLICA_ID_CLAIMED, writeCenterReplica } from "../src/lib/shared-ledger-center-replica-write.js";
import { CENTER, fakeFeature, FEATURE_UUID, LOCAL_ID, node, replicaKit } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => { await open?.close(); open = null; });
async function kit() { open = await replicaKit(); return open; }

/** Same first 10 hex as FEATURE_UUID → same local id. */
const TWIN_UUID = "0f1e2d3c-4b99-4111-8222-333344445555";
const storedNodes = (k: Kit, version: number) => effectiveNodes(k.f.db, getDagVersion(k.f.db, LOCAL_ID, version)!)
  .map(({ key, oneLine, deps, fileGlobs, estimate }) => ({ key, oneLine, deps, fileGlobs, estimate }));

for (const twinVersion of [2, 3]) {
  test(`AC1/AC5 concurrent syncs of colliding center ids (twin v${twinVersion}): one lands, the other is refused, no cross-over`, async () => {
    const k = await kit();
    expect(centerReplicaLocalId(TWIN_UUID)).toBe(LOCAL_ID);
    const first = fakeFeature(), twin = fakeFeature({ id: TWIN_UUID, title: "撞名的另一个中心功能", version: twinVersion,
      nodes: [node("gamma"), node("delta", { deps: ["gamma"] })] });
    k.center.publish(first);
    k.center.publish(twin);
    // Barrier on the real transport: both detail responses are handed back together, so both syncs have read the
    // center before either writes (only the timing is controlled; production functions are unchanged).
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    let seen = 0;
    const barrier = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const res = await fetch(input, init);
      if (!/\/features\/[^/]+$/.test(new URL(String(input instanceof Request ? input.url : input)).pathname)) return res;
      const body = await res.text();
      if (++seen === 2) release();
      await both;
      return new Response(body, { status: res.status, headers: res.headers });
    }) as typeof fetch;
    const run = (id: string) => syncCenterReplicas(k.f.db, { localProject: k.f.project, centerFeatureId: id, fetch: barrier });
    const [a, b] = await Promise.all([run(FEATURE_UUID), run(TWIN_UUID)]);
    const results = [...a.features, ...b.features];
    const won = results.filter((r) => r.result === "created");
    expect(won).toHaveLength(1);
    const winner = won[0]!.centerFeatureId === FEATURE_UUID ? first : twin, loser = winner === first ? twin : first;
    expect(results.find((r) => r.centerFeatureId === loser.id)).toEqual({ centerFeatureId: loser.id, result: "refused", reason: REPLICA_REASONS.idTaken });
    // Ledger, mode, mirror and replica state all point at the winner only.
    expect(getFeature(k.f.db, LOCAL_ID)).toMatchObject({ title: winner.title, currentVersion: winner.version });
    expect(storedNodes(k, winner.version)).toEqual(winner.nodes);
    expect(readSharedLedgerMode(LOCAL_ID).centerPlanned?.centerFeatureId).toBe(winner.id);
    expect(readSharedLedgerMirrors()[LOCAL_ID]).toMatchObject({ enabled: true, centerFeatureId: winner.id, sourceInstanceId: CENTER.instanceId });
    const state = readCenterReplicas();
    expect(Object.keys(state.replicas)).toEqual([winner.id]);
    expect(state.refused[loser.id]?.reason).toBe(REPLICA_REASONS.idTaken);
    // A later sync of everything changes nothing for the winner and still refuses the loser.
    const again = await syncCenterReplicas(k.f.db, { localProject: k.f.project });
    expect(again.features.find((r) => r.centerFeatureId === winner.id)).toMatchObject({ result: "unchanged" });
    expect(again.features.find((r) => r.centerFeatureId === loser.id)).toMatchObject({ result: "refused", reason: REPLICA_REASONS.idTaken });
    expect(readSharedLedgerMirrors()[LOCAL_ID]).toMatchObject({ enabled: true, centerFeatureId: winner.id });
  });
}

test("AC1 the writer never treats another center feature as a newer version of a replica", async () => {
  const k = await kit();
  k.center.publish(fakeFeature());
  expect((await k.sync()).features).toMatchObject([{ result: "created" }]);
  const before = getFeature(k.f.db, LOCAL_ID)!;
  const write = { localFeatureId: LOCAL_ID, localProject: k.f.project, centerFeatureId: TWIN_UUID, title: "撞名的另一个中心功能", version: 3,
    nodes: [node("alpha"), node("beta", { deps: ["alpha"] })] };
  let err: unknown;
  try { writeCenterReplica(k.f.db, { actor: REPLICA_ACTOR, now: 5 }, write); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(LedgerError);
  expect((err as LedgerError).message).toBe(REPLICA_ID_CLAIMED);
  expect(getFeature(k.f.db, LOCAL_ID)).toEqual(before);
});

test("AC1 valid center fileGlobs land verbatim: order kept, empty array kept; resync unchanged, replay keeps them", async () => {
  const k = await kit();
  const center = fakeFeature({ nodes: [node("alpha", { fileGlobs: ["src/z.ts", "src/a.ts"] }), node("beta", { deps: ["alpha"], fileGlobs: [] })] });
  k.center.publish(center);
  expect((await k.sync()).features).toMatchObject([{ centerFeatureId: FEATURE_UUID, result: "created", version: 2 }]);
  expect(storedNodes(k, 2)).toEqual(center.nodes);
  expect((await k.sync()).features).toMatchObject([{ result: "unchanged", version: 2 }]);
  const v3 = { ...center, version: 3, rev: 6, nodes: [...center.nodes, node("gamma", { deps: ["beta", "alpha"], fileGlobs: ["src/y/*", "src/b.ts"] })] };
  k.center.publish(v3, "none");
  expect((await k.sync()).features).toMatchObject([{ result: "replayed", version: 3 }]);
  expect(storedNodes(k, 3)).toEqual(v3.nodes);
});
