/** REPLFAIR1 center-replica fairness: new features first, rotation after a 429, paced detail reads, single-feature CLI, phase-aware logs. */
import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getFeature } from "../src/lib/ledger-feature.js";
import { readCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import { centerReplicaLocalId, REPLICA_REASONS, syncCenterReplicas } from "../src/lib/shared-ledger-center-replica.js";
import { orderReplicaIds, paceDetailRead, REPLICA_DETAIL_GAP_MS } from "../src/lib/shared-ledger-center-replica-order.js";
import { runCenterReplicaPull } from "../src/lib/shared-ledger-center-replica-pull.js";
import { openLedgerReadOnly } from "../src/lib/shared-ledger-center-replica-pull-wiring.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { fakeFeature, replicaKit } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => {
  if (open) {
    for (const id of [...OLD, NEW]) await writeSharedLedgerMode(centerReplicaLocalId(id)!, { authorityMode: "source", sharedPlanning: false }, open.dir, open.f.db.filename);
    rmSync(join(open.dir, "shared-ledger-cooldowns"), { recursive: true, force: true });
    await open.close();
  }
  open = null;
});

const OLD = [1, 2, 3, 4, 5].map((i) => `a${i}a${i}a${i}a${i}-2222-4333-8444-555555555555`);
const NEW = "7b02aea6-2222-4333-8444-555555555555";
const BODY = "center-body-must-not-leak";
const detailId = (path: string) => path.match(/\/features\/([^/]+)$/)?.[1] ?? null;

/** Fake clock + sleep (never really waits) and a fetch that lets `budget` requests per round through, then answers 429. */
function harness(k: Kit) {
  let t = Date.now(), left = Infinity;
  const details: { id: string; at: number }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
    if (left-- <= 0) return new Response(BODY, { status: 429 });
    const id = detailId(path);
    if (id) details.push({ id, at: t });
    return fetch(input, init);
  }) as typeof fetch;
  const opts = { localProject: k.f.project, fetch: fetcher, now: () => t, sleep: async (ms: number) => { t += ms; } };
  return {
    details, opts,
    /** One round with this many requests allowed (list included), the last round's cooldown gone (the next pull round, minutes later). */
    async round(budget = Infinity, extra: Partial<Parameters<typeof syncCenterReplicas>[1]> = {}) {
      rmSync(join(k.dir, "shared-ledger-cooldowns"), { recursive: true, force: true });
      t += 1000; left = budget;
      const from = details.length, out = await syncCenterReplicas(k.f.db, { ...opts, ...extra });
      return { out, read: details.slice(from).map((d) => d.id) };
    },
  };
}

/** Five landed replicas (synced in list order), then a new feature published last in the center list. */
async function starvedKit() {
  const k = (open = await replicaKit()), h = harness(k);
  OLD.forEach((id, i) => k.center.publish(fakeFeature({ id, title: `旧功能 ${i + 1}` })));
  const first = await h.round();
  expect(first.out.features.map((f) => f.result)).toEqual(Array(5).fill("created"));
  k.center.publish(fakeFeature({ id: NEW, title: "新功能" }));
  return { k, h };
}

test("order: new ids first in list order, then landed ones by syncedAt, lastErrorAt, list order", () => {
  const replicas = { a: { syncedAt: 30, lastErrorAt: null }, b: { syncedAt: 10, lastErrorAt: 5 }, c: { syncedAt: 10, lastErrorAt: null }, d: { syncedAt: 10, lastErrorAt: null } };
  expect(orderReplicaIds(["a", "x", "b", "c", "y", "d"], replicas)).toEqual(["x", "y", "c", "d", "b", "a"]);
  expect(orderReplicaIds([], replicas)).toEqual([]);
});

test("pace: no wait before the first read, then at least REPLICA_DETAIL_GAP_MS since the last one", async () => {
  let t = 1000;
  const waits: number[] = [], sleep = async (ms: number) => { waits.push(ms); t += ms; };
  expect(await paceDetailRead(null, () => t, sleep)).toBe(1000);
  t += 100;
  expect(await paceDetailRead(1000, () => t, sleep)).toBe(1000 + REPLICA_DETAIL_GAP_MS);
  t += 5000;
  await paceDetailRead(1000, () => t, sleep);
  expect(waits).toEqual([REPLICA_DETAIL_GAP_MS - 100]);
});

test("[验收线 1] starvation: 5 landed + 1 new listed last, 6 requests per round → the new feature lands in round 1", async () => {
  const { k, h } = await starvedKit();
  const { out, read } = await h.round(6);
  expect(read[0]).toBe(NEW);
  expect(out.features[0]).toMatchObject({ centerFeatureId: NEW, result: "created", localFeatureId: centerReplicaLocalId(NEW) });
  expect(getFeature(k.f.db, centerReplicaLocalId(NEW)!)).not.toBeNull();
  expect(readCenterReplicas().replicas[NEW]).toBeDefined();
});

test("[验收线 2] rotation: landed replicas read oldest first; a round cut by 429 resumes with the unread ones; all get read", async () => {
  const { h } = await starvedKit();
  // Round 1: list + 3 details, the 4th detail is limited, 2 unread.
  const r1 = await h.round(4);
  expect(r1.read).toEqual([NEW, OLD[0], OLD[1]]);
  expect(r1.out.features.map((f) => [f.centerFeatureId, f.result])).toEqual([[NEW, "created"], [OLD[0], "unchanged"], [OLD[1], "unchanged"],
    [OLD[2], "failed"], [OLD[3], "skipped"], [OLD[4], "skipped"]]);
  const state = readCenterReplicas();
  for (const id of [OLD[2], OLD[3], OLD[4]]) expect(state.replicas[id]).toMatchObject({ lastError: REPLICA_REASONS.rateLimited, lastErrorAt: expect.any(Number) });
  expect(state.skipped?.[OLD[3]!]).toMatchObject({ lastSkip: REPLICA_REASONS.rateLimited });
  // Round 2 starts with the ones round 1 did not read; round 3 with the rest.
  const r2 = await h.round(4);
  expect(r2.read).toEqual([OLD[2], OLD[3], OLD[4]]);
  expect(readCenterReplicas().replicas[OLD[3]!]).toMatchObject({ lastError: null, lastErrorAt: null });
  expect(readCenterReplicas().skipped?.[OLD[3]!]).toBeUndefined();
  const r3 = await h.round(4);
  expect(r3.read).toEqual([NEW, OLD[0], OLD[1]]);
  expect(new Set([...r1.read, ...r2.read, ...r3.read])).toEqual(new Set([...OLD, NEW]));
});

test("[验收线 2] observe (dryRun) answers in the same order and writes nothing", async () => {
  const { k, h } = await starvedKit();
  const raw = readFileSync(join(k.dir, "shared-center-replicas.json"), "utf8");
  const { out, read } = await h.round(6, { dryRun: true });
  expect(read[0]).toBe(NEW);
  expect(out.features[0]).toMatchObject({ centerFeatureId: NEW, result: "created" });
  expect(readFileSync(join(k.dir, "shared-center-replicas.json"), "utf8")).toBe(raw);
});

test("[验收线 3] pacing: adjacent detail reads in one round are at least REPLICA_DETAIL_GAP_MS apart (injected clock)", async () => {
  const { h } = await starvedKit();
  const from = h.details.length;
  await h.round();
  const at = h.details.slice(from).map((d) => d.at);
  expect(at).toHaveLength(6);
  for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(REPLICA_DETAIL_GAP_MS);
});

test("[验收线 4] CLI --center-feature-id: one list read, one detail read, only that id; a non-uuid id is invalid", async () => {
  const k = (open = await replicaKit());
  k.center.publish(fakeFeature({ id: OLD[0], title: "旧功能 1" }));
  k.center.publish(fakeFeature({ id: NEW, title: "新功能" }));
  const out = await k.f.ledger(["center-replica", "sync", "--center-feature-id", NEW]) as { features: { centerFeatureId: string; result: string }[] };
  expect(out.features).toEqual([expect.objectContaining({ centerFeatureId: NEW, result: "created" })]);
  expect(k.center.requests.map((r) => detailId(r.path) ?? "list")).toEqual(["list", NEW]);
  expect(readCenterReplicas().replicas[OLD[0]!]).toBeUndefined();
  for (const bad of ["abc", "7b02aea6", `${NEW}x`]) {
    expect(await k.f.ledger(["center-replica", "sync", "--center-feature-id", bad])).toMatchObject({ ok: false, code: "invalid" });
  }
  expect(await k.f.ledger(["center-replica", "sync", "--center-feature-id", NEW], "agent-stranger")).toMatchObject({ ok: false, code: "forbidden" });
  expect(k.center.requests).toHaveLength(2);
  // Without the flag: the whole project, new-first as in [验收线 1].
  const all = await k.f.ledger(["center-replica", "sync"]) as { features: { centerFeatureId: string; result: string }[] };
  expect(all.features.map((f) => [f.centerFeatureId, f.result])).toEqual([[OLD[0], "created"], [NEW, "unchanged"]]);
});

test("[验收线 5] limited rounds name the phase and counts; a local-cooldown 429 is told apart; no center body in logs or state", async () => {
  const { k, h } = await starvedKit();
  const r1 = await h.round(4);
  const detailError = r1.out.scopes[0]!.error!;
  expect(detailError).toBe(`${REPLICA_REASONS.rateLimited}（读详情时；本轮成功 3 个、跳过 2 个；中心回 429）`);
  // Same instant: the transport's own cooldown answers the list read without a request.
  const sent = k.center.requests.length;
  const r2 = await syncCenterReplicas(k.f.db, h.opts);
  expect(r2.scopes[0]!.error).toBe(`${REPLICA_REASONS.rateLimited}（读列表时；本机冷却未到期，未发请求）`);
  expect(k.center.requests.length).toBe(sent);
  expect(readCenterReplicas().scopes).toMatchObject({ [Object.keys(readCenterReplicas().scopes)[0]!]: { lastError: r2.scopes[0]!.error } });
  // The background pull logs the scope error line.
  rmSync(join(k.dir, "shared-ledger-cooldowns"), { recursive: true, force: true });
  const lines: string[] = [];
  let left = 2;
  const limited = (async (input: string | URL | Request, init?: RequestInit) => (left-- <= 0 ? new Response(BODY, { status: 429 }) : fetch(input, init))) as typeof fetch;
  await runCenterReplicaPull({ db: () => k.f.db, readDb: () => openLedgerReadOnly(k.f.db.filename), policy: () => ({ mode: "on" }),
    log: (l) => lines.push(l), stateDir: k.dir, fetch: limited });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("读详情时；本轮成功 1 个、跳过 4 个；中心回 429");
  const raw = readFileSync(join(k.dir, "shared-center-replicas.json"), "utf8");
  for (const text of [raw, ...lines]) { expect(text).not.toContain(BODY); expect(text).not.toContain("bearer-for-tests-only"); }
});
