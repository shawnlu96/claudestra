/** S2K2: the V1 read view reports authorityMode "execution" (a migrated feature); V1 writes and imports still refuse it.
 * Synthetic data only: the fake center is the kit's 127.0.0.1 server, no real center.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { getTask } from "../src/lib/ledger-store.js";
import { readCenterClaims } from "../src/lib/shared-ledger-center-claims.js";
import { REPLICA_REASONS } from "../src/lib/shared-ledger-center-replica.js";
import { readCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import { CENTER_START_TEXT, configureCenterStart } from "../src/lib/shared-ledger-center-start.js";
import { CENTER_UNBIND_TEXT, configureCenterUnbind } from "../src/lib/shared-ledger-center-unbind.js";
import { readCenterUnbinds } from "../src/lib/shared-ledger-center-unbind-records.js";
import {
  SHARED_LEDGER_COMMAND_FIXTURES, SHARED_LEDGER_FEATURE_FIXTURE, SHARED_LEDGER_IMPORT_FIXTURE, SHARED_LEDGER_LIST_FIXTURE,
} from "../src/lib/shared-ledger-contract-fixtures.js";
import { parseSharedLedgerResponse } from "../src/lib/shared-ledger-contract-responses.js";
import { parseSharedLedgerImport } from "../src/lib/shared-ledger-contract-transfer.js";
import { assertSharedLedgerMutation } from "../src/lib/shared-ledger-contract-validation.js";
import { fakeFeature, FEATURE_UUID, ledgerSnapshot, LOCAL_ID, replicaDagTools, replicaKit, type FakeFeature } from "./shared-center-kit.js";

/** The kit's fake feature is typed for the pre-migration modes; the center serves the value verbatim. */
const EXECUTION = "execution" as FakeFeature["authorityMode"];
const planning = SHARED_LEDGER_FEATURE_FIXTURE.feature;
const withMode = (authorityMode: string, patch: Record<string, unknown> = {}) => ({ ...planning, ...patch, authorityMode });
const detailWith = (authorityMode: string) => ({ ...SHARED_LEDGER_FEATURE_FIXTURE, feature: withMode(authorityMode) });

describe("[验收线 1] V1 read view parses execution", () => {
  test("a features list with one execution feature next to a planning one keeps both", () => {
    const list = { ...SHARED_LEDGER_LIST_FIXTURE, features: [planning, withMode("execution", { id: "feature-migrated" })] };
    const parsed = parseSharedLedgerResponse("features", list);
    expect(parsed.features.map((f) => [f.id, f.authorityMode])).toEqual([["feature-a", "planning"], ["feature-migrated", "execution"]]);
    expect(parsed).toEqual(list as typeof parsed);
  });
  test("a feature detail whose feature is execution parses to itself", () => {
    const parsed = parseSharedLedgerResponse("feature", detailWith("execution"));
    expect(parsed.feature.authorityMode).toBe("execution");
    expect(parsed).toEqual(detailWith("execution") as typeof parsed);
  });
});

describe("[验收线 3] nothing else is widened", () => {
  test("an import manifest with an execution feature is still refused", () => {
    const { payload } = SHARED_LEDGER_IMPORT_FIXTURE;
    expect(parseSharedLedgerImport(payload)).toEqual(payload);
    const bad = { ...payload, manifest: { ...payload.manifest, features: payload.manifest.features.map((f) => ({ ...f, authorityMode: "execution" })) } };
    expect(() => parseSharedLedgerImport(bad)).toThrow("invalid_field");
  });
  test("other values in the V1 read view are still refused, in the list and in the detail", () => {
    for (const mode of ["exec", "Execution", "execution ", "", null, 1]) {
      const list = { ...SHARED_LEDGER_LIST_FIXTURE, features: [planning, { ...planning, id: "feature-b", authorityMode: mode }] };
      expect(() => parseSharedLedgerResponse("features", list)).toThrow("invalid_field");
      expect(() => parseSharedLedgerResponse("feature", { ...SHARED_LEDGER_FEATURE_FIXTURE, feature: { ...planning, authorityMode: mode } })).toThrow("invalid_field");
    }
    const { authorityMode: _mode, ...missing } = planning;
    expect(() => parseSharedLedgerResponse("features", { ...SHARED_LEDGER_LIST_FIXTURE, features: [missing] })).toThrow("invalid_field");
  });
  test("a V1 command against an execution feature is execution_not_shared", () => {
    const current = parseSharedLedgerResponse("feature", detailWith("execution"));
    const commands = SHARED_LEDGER_COMMAND_FIXTURES.map((c) => c.payload).filter((c) => c.type !== "feature.new");
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(() => assertSharedLedgerMutation(command, current, false)).toThrow("execution_not_shared");
  });
});

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => { configureCenterStart(undefined); configureCenterUnbind(undefined); await open?.close(); open = null; });
const centerWrites = (k: Kit) => k.center.requests.filter((r) => r.method !== "GET");

describe("[验收线 2] downstream treats execution as not planning", () => {
  test("replica sync of an execution feature: skipped / notPlanned, zero local write, not failed", async () => {
    const k = open = await replicaKit();
    const before = ledgerSnapshot(k.f.db);
    k.center.publish(fakeFeature({ authorityMode: EXECUTION }));
    const out = await k.sync();
    expect(out).toMatchObject({ ok: true, scopes: [{ error: null }] });
    expect(out.features).toEqual([{ centerFeatureId: FEATURE_UUID, result: "skipped", reason: REPLICA_REASONS.notPlanned }]);
    expect(ledgerSnapshot(k.f.db)).toEqual(before);
    expect(readCenterReplicas()).toMatchObject({ replicas: {}, refused: {} });
    expect(centerWrites(k)).toEqual([]);
  });

  /** A replica landed while the feature was planning; the center then reports it as execution (migrated). */
  async function migratedReplica() {
    const me = instanceIdSync();
    const k = open = await replicaKit({ credentialInstance: me });
    k.center.publish(fakeFeature({ homeInstanceId: me }));
    expect(await k.sync()).toMatchObject({ features: [{ result: "created", localFeatureId: LOCAL_ID }] });
    k.center.features.get(FEATURE_UUID)!.authorityMode = EXECUTION;
    configureCenterStart({ timeoutMs: 300 });
    configureCenterUnbind({ timeoutMs: 300 });
    k.center.requests.length = 0;
    return { k, before: ledgerSnapshot(k.f.db), replica: structuredClone(readCenterReplicas().replicas[FEATURE_UUID]) };
  }

  test("a later sync of the migrated replica is skipped / notPlanned and leaves the landed replica as it was", async () => {
    const { k, before, replica } = await migratedReplica();
    expect((await k.sync()).features).toEqual([{ centerFeatureId: FEATURE_UUID, result: "skipped", reason: REPLICA_REASONS.notPlanned }]);
    expect(ledgerSnapshot(k.f.db)).toEqual(before);
    expect(readCenterReplicas().replicas[FEATURE_UUID]).toEqual(replica!);
  });

  test("center-start (start_node) is forbidden with the existing text: no bind sent, no card", async () => {
    const { k, before } = await migratedReplica();
    const tools = replicaDagTools(k.f, { createFails: false });
    const out = await tools.start_node(k.f.call, { featureId: LOCAL_ID, key: "alpha", spec: "# 副本节点\n模板：code\n" });
    expect(out).toMatchObject({ ok: false, code: "forbidden", error: CENTER_START_TEXT.stale });
    expect(k.center.requests.some((r) => r.method === "GET" && r.path.endsWith(`/features/${FEATURE_UUID}`))).toBe(true);
    expect(centerWrites(k)).toEqual([]);
    expect(readCenterClaims()).toEqual([]);
    expect(getTask(k.f.db, `${LOCAL_ID}-alpha`)).toBeNull();
    expect(k.f.calls.filter((c) => c[0] === "create")).toEqual([]);
    expect(ledgerSnapshot(k.f.db)).toEqual(before);
  });

  test("center-unbind is forbidden with the existing text: no unbind sent, no record", async () => {
    const { k, before } = await migratedReplica();
    const out = await k.f.ledger(["center-replica", "unbind", LOCAL_ID, "alpha", "--reason", "合成：迁移后撤销"]);
    expect(out).toMatchObject({ ok: false, code: "forbidden", error: CENTER_UNBIND_TEXT.notReplica });
    expect(k.center.requests.some((r) => r.method === "GET" && r.path.endsWith(`/features/${FEATURE_UUID}`))).toBe(true);
    expect(centerWrites(k)).toEqual([]);
    expect(readCenterUnbinds()).toEqual([]);
    expect(ledgerSnapshot(k.f.db)).toEqual(before);
  });
});
