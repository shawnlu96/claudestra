/** N7X1 gates on a center replica: local planning all closed (AC2); a committed claim opens exactly one card and node (AC4). */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { getFeature } from "../src/lib/ledger-feature.js";
import { assignFeature } from "../src/lib/ledger-feature-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart } from "../src/lib/dag-tools-steps.js";
import { featureGate } from "../src/lib/scheduler-autostart.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { requireSharedLedgerStart } from "../src/lib/shared-ledger-gate.js";
import {
  centerClaimCommitted, centerClaimsPath, findCenterClaim, putCenterClaim, readCenterClaims, setCenterClaimState, type CenterClaim, type CenterClaimState,
} from "../src/lib/shared-ledger-center-claims.js";
import { fakeFeature, FEATURE_UUID, ledgerSnapshot, LOCAL_ID, replicaKit } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => { await open?.close(); open = null; });
async function replica() {
  const k = open = await replicaKit();
  k.center.publish(fakeFeature());
  expect(await k.sync()).toMatchObject({ features: [{ result: "created" }] });
  return k;
}
const TASK = `${LOCAL_ID}-alpha`;
const claim = (patch: Partial<CenterClaim> = {}): CenterClaim => {
  const op = patch.op ?? "bind-alpha";
  return { op, body: { featureId: FEATURE_UUID, nodeKey: "alpha" }, digest: v2ObjectDigest(op), localFeatureId: LOCAL_ID, key: "alpha", taskId: TASK,
    state: "pending", ...patch };
};
async function claimed(k: Kit, state: CenterClaimState, patch: Partial<CenterClaim> = {}) {
  const c = await putCenterClaim(claim(patch), k.dir);
  if (state !== "pending") await setCenterClaimState(c.op, state, k.dir);
}
const SPEC = "# 副本节点\n模板：code\n";
const rev = (k: Kit) => String(getFeature(k.f.db, LOCAL_ID)!.rev);
const forbidden = { ok: false, code: "forbidden" };

test("AC2 every local planning write on a replica is forbidden and writes nothing (no claim)", async () => {
  const k = await replica(), f = k.f;
  const before = ledgerSnapshot(f.db);
  const nodes = JSON.stringify([{ key: "alpha", oneLine: "本机改", fileGlobs: ["src/n7x/alpha.ts"] }]);
  expect(await f.ledger(["feature-set", LOCAL_ID, "--rev", rev(k), "--title", "本机改名"])).toMatchObject(forbidden);
  expect(await f.ledger(["dag-init", LOCAL_ID, "--rev", rev(k), "--nodes", nodes])).toMatchObject(forbidden);
  expect(await f.ledger(["dag-rewrite", LOCAL_ID, "--rev", rev(k), "--nodes", nodes, "--reason-kind", "new_issue", "--reason", "本机改图"]))
    .toMatchObject({ ok: false, proposal: { kind: "revise", state: "unsynced" } }); // N7X3: a revise proposal record, never a local rewrite
  expect(await f.ledger(["dag-approve", LOCAL_ID])).toMatchObject(forbidden);
  expect(await f.ledger(["feature-dep-add", LOCAL_ID, f.id])).toMatchObject(forbidden);
  expect(await f.ledger(["feature-dep-add", f.id, LOCAL_ID])).toMatchObject(forbidden);
  expect(await f.ledger(["feature-split", LOCAL_ID, "--plan", "/nonexistent/plan.json"])).toMatchObject(forbidden);
  expect(() => assignFeature(f.db, { actor: f.actor }, { id: LOCAL_ID, taskIds: ["c5-existing"] })).toThrow("中心副本");
  expect(() => createTask(f.db, { actor: f.actor }, { project: f.project, id: TASK, title: "x", kind: "code",
    extra: { sharedFeatureId: LOCAL_ID, fileGlobs: ["src/n7x/alpha.ts"] } })).toThrow("共享规划禁止本机开新节点");
  expect(await f.ledger(["dag-bind", LOCAL_ID, "alpha", "c5-existing", "--rev", rev(k)])).toMatchObject(forbidden);
  const start = await f.tools.start_node(f.call, { featureId: LOCAL_ID, key: "alpha", spec: SPEC });
  expect(start).toMatchObject(forbidden);
  expect((start as { error: string }).error).toContain("中心副本");
  expect(ledgerSnapshot(f.db)).toEqual(before);
  expect(f.calls.some((c) => c[0] === "create")).toBe(false);
});

test("AC2 autostart keeps stopping on a replica even with a committed claim (stage one has no auto start)", async () => {
  const k = await replica();
  await claimed(k, "committed");
  expect(featureGate(k.f.db, getFeature(k.f.db, LOCAL_ID)!, { autoDispatch: true, projects: [k.f.project], maxWorkers: () => 3 }))
    .toMatchObject({ gate: "feature", why: expect.stringContaining("中心副本") });
});

test("AC4 a committed claim opens preflight, every runStart step, task-new and dag-bind for that card and node", async () => {
  const k = await replica(), f = k.f;
  await claimed(k, "committed");
  const pre = await preflightStart(f.startEnv, { featureId: LOCAL_ID, key: "alpha", spec: SPEC });
  if (!pre.ok || "already" in pre) throw new Error(`expected a plan: ${JSON.stringify(pre)}`);
  expect(pre.plan.taskId).toBe(TASK);
  const out = await runStart({ ...f.io, manager: async (args) => args[0] === "create" ? { ok: true, agent: pre.plan.agent } : f.io.manager(args) }, pre.plan);
  expect(out).toMatchObject({ ok: true, taskId: TASK, steps: ["task-new", "spec", "worktree", "prompt", "agent", "task-set", "workflow", "bind"] });
  expect(getTask(f.db, TASK)).toMatchObject({ featureId: LOCAL_ID, extra: { sharedFeatureId: LOCAL_ID, fileGlobs: ["src/n7x/alpha.ts"] } });
  expect(f.db.prepare("SELECT nodeKey, taskId FROM dag_bindings WHERE featureId = ?").all(LOCAL_ID)).toEqual([{ nodeKey: "alpha", taskId: TASK }]);
  // The same claim does not open another node, and the bound node is not re-bindable.
  expect(await preflightStart(f.startEnv, { featureId: LOCAL_ID, key: "beta", spec: SPEC })).toMatchObject(forbidden);
});

test("AC4 another node, another card id, or a pending / conflict / orphan claim keeps every gate closed", async () => {
  const k = await replica(), f = k.f;
  // task-new has no node: for the claimed card id it is open, the node is enforced at preflight and dag-bind.
  const tryAll = async (key: string, taskId: string, taskNew = true) => {
    const before = ledgerSnapshot(f.db);
    expect(await preflightStart(f.startEnv, { featureId: LOCAL_ID, key, taskId, spec: SPEC })).toMatchObject(forbidden);
    expect(() => requireSharedLedgerStart(LOCAL_ID, key, taskId)).toThrow("中心副本");
    if (taskNew) expect(() => createTask(f.db, { actor: f.actor }, { project: f.project, id: taskId, title: "x", kind: "code",
      extra: { sharedFeatureId: LOCAL_ID, fileGlobs: ["src/n7x/x.ts"] } })).toThrow();
    expect(await f.ledger(["dag-bind", LOCAL_ID, key, taskId, "--rev", rev(k)])).toMatchObject(forbidden);
    expect(ledgerSnapshot(f.db)).toEqual(before);
  };
  await claimed(k, "committed");
  await tryAll("beta", TASK, false); // other node
  await tryAll("alpha", `${TASK}-other`); // other card
  expect(await f.ledger(["dag-bind", LOCAL_ID, "alpha", "c5-existing", "--rev", rev(k)])).toMatchObject(forbidden); // claimed node, other card
  for (const state of ["pending", "conflict", "orphan"] as const) {
    writeFileSync(centerClaimsPath(k.dir), JSON.stringify({ claims: [] }), { mode: 0o600 });
    await claimed(k, state, { op: `bind-${state}` });
    await tryAll("alpha", TASK);
  }
  // A corrupt claims file fails closed.
  writeFileSync(centerClaimsPath(k.dir), "{not json", { mode: 0o600 });
  await tryAll("alpha", TASK);
});

test("AC4 a claim for one replica never opens a non-replica planning feature", async () => {
  const k = await replica(), f = k.f;
  await f.mode(true);
  await claimed(k, "committed", { localFeatureId: f.id, key: "next", taskId: "c5a0-gate-next" });
  expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: SPEC })).toMatchObject(forbidden);
  expect(() => requireSharedLedgerStart(f.id, "next", "c5a0-gate-next")).toThrow("已迁入共享规划");
});

test("claims API for N7X2: retry is idempotent, other content / live duplicates refused, states only move forward", async () => {
  const k = await replica();
  expect(await putCenterClaim(claim(), k.dir)).toEqual(claim());
  expect(await putCenterClaim(claim(), k.dir)).toEqual(claim());
  await expect(putCenterClaim(claim({ digest: v2ObjectDigest("other") }), k.dir)).rejects.toThrow("other content");
  await expect(putCenterClaim(claim({ op: "bind-again" }), k.dir)).rejects.toThrow("live center claim");
  await expect(putCenterClaim(claim({ op: "bind-card", key: "beta" }), k.dir)).rejects.toThrow("live center claim");
  expect(centerClaimCommitted(LOCAL_ID, "alpha", TASK, k.dir)).toBe(false);
  expect(await setCenterClaimState("bind-alpha", "committed", k.dir)).toMatchObject({ state: "committed" });
  expect(centerClaimCommitted(LOCAL_ID, "alpha", TASK, k.dir)).toBe(true);
  await expect(setCenterClaimState("bind-alpha", "pending", k.dir)).rejects.toThrow("cannot move");
  await expect(setCenterClaimState("missing", "committed", k.dir)).rejects.toThrow("not found");
  expect(await setCenterClaimState("bind-alpha", "orphan", k.dir)).toMatchObject({ state: "orphan" });
  expect(centerClaimCommitted(LOCAL_ID, "alpha", TASK, k.dir)).toBe(false);
  // An orphaned claim frees the node for a new attempt.
  expect(await putCenterClaim(claim({ op: "bind-retry" }), k.dir)).toMatchObject({ state: "pending" });
  expect(findCenterClaim("bind-retry", k.dir)).toMatchObject({ op: "bind-retry" });
  expect(readCenterClaims(k.dir).map((c) => c.state)).toEqual(["orphan", "pending"]);
  const { statSync } = await import("node:fs");
  expect(statSync(centerClaimsPath(k.dir)).mode & 0o777).toBe(0o600);
});
