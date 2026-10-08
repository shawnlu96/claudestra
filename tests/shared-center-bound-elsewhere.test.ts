/** N7X4 center binds a replica node to a card this instance never claimed: sync reports it, start_node says sync cannot fix it. */
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createTask } from "../src/lib/ledger-write.js";
import { putCenterClaim, setCenterClaimState } from "../src/lib/shared-ledger-center-claims.js";
import { readCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import { CENTER_START_TEXT, configureCenterStart } from "../src/lib/shared-ledger-center-start.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { fakeFeature, FEATURE_UUID, LOCAL_ID, node, replicaKit, type FakeFeature } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => { configureCenterStart(undefined); await open?.close(); open = null; });

const TEXT = "中心已把节点 D 绑到本机没有认领记录的卡，本机不能开工；需要撤销中心绑定（N7X5）";
const NODES = [node("alpha"), node("D")];
const SPEC = "# 副本节点\n模板：code\n";

/** Replica of a home-published feature (this instance), synced once; start_node through the real dag tools. */
async function setup() {
  const me = instanceIdSync();
  const k = open = await replicaKit({ credentialInstance: me });
  const publish = (patch: Partial<FakeFeature> = {}) => k.center.publish(fakeFeature({ homeInstanceId: me, nodes: NODES, ...patch }), "none");
  k.center.publish(fakeFeature({ homeInstanceId: me, nodes: NODES }));
  expect(await k.sync()).toMatchObject({ features: [{ result: "created" }] });
  configureCenterStart({ timeoutMs: 1000 });
  const f = k.f;
  const deps: DagToolDeps = { db: () => f.db, manager: async (args) => (args[0] === "ledger" ? f.ledger(args.slice(1)) : { ok: true }),
    callerProject: () => f.project, startEnv: () => f.startEnv, stepIO: () => f.io };
  const tools = dagToolHandlers(deps);
  const start = (key: string) => tools.start_node(f.call, { featureId: LOCAL_ID, key, spec: SPEC });
  const replica = async () => ((await k.status()) as { replicas: Record<string, unknown>[] }).replicas[0]!;
  return { k, publish, start, replica };
}

async function claim(k: Kit, key: string, taskId: string, state: "committed" | "conflict") {
  const op = `bind-${key}-${state}`;
  await putCenterClaim({ op, body: { featureId: FEATURE_UUID, nodeKey: key, sourceTaskId: taskId }, digest: v2ObjectDigest(op),
    localFeatureId: LOCAL_ID, key, taskId, state: "pending" }, k.dir);
  await setCenterClaimState(op, state, k.dir);
}

test("N7X4-AC1 sync reports a center-bound node with no local card / claim: boundElsewhere + fixed lastError", async () => {
  const s = await setup();
  s.publish({ rev: 6, bindings: [{ nodeKey: "D", taskId: "center-other-card" }] });
  expect(await s.k.sync()).toMatchObject({ features: [{ result: "unchanged" }] });
  expect(await s.replica()).toMatchObject({ centerFeatureId: FEATURE_UUID, boundElsewhere: ["D"], lastError: TEXT });
  expect(readCenterReplicas().replicas[FEATURE_UUID]).toMatchObject({ boundElsewhere: ["D"], lastError: TEXT });
  expect((await s.replica()).lastErrorAt).not.toBeNull();
  // A settled conflict claim never bound at the center: still reported.
  await claim(s.k, "D", "local-d", "conflict");
  await s.k.sync();
  expect(await s.replica()).toMatchObject({ boundElsewhere: ["D"], lastError: TEXT });
});

test("N7X4-AC2 the center bind gone → next sync clears boundElsewhere and lastError", async () => {
  const s = await setup();
  s.publish({ rev: 6, bindings: [{ nodeKey: "D", taskId: "center-other-card" }] });
  await s.k.sync();
  expect(await s.replica()).toMatchObject({ boundElsewhere: ["D"] });
  s.publish({ rev: 7, bindings: [] });
  await s.k.sync();
  expect(await s.replica()).toMatchObject({ boundElsewhere: [], lastError: null, lastErrorAt: null });
});

test("N7X4-AC3 own claims are not reported; BIND_MISSING unchanged; old state file without the field reads as none", async () => {
  const s = await setup();
  // alpha: claimed + locally bound (what start_node leaves); D: committed claim, card not opened yet.
  await claim(s.k, "alpha", "n7x-alpha", "committed");
  createTask(s.k.f.db, { actor: s.k.f.actor }, { project: s.k.f.project, id: "n7x-alpha", title: "卡 alpha", kind: "code",
    extra: { sharedFeatureId: LOCAL_ID, fileGlobs: ["src/n7x/alpha.ts"] } });
  expect(await s.k.f.ledger(["dag-bind", LOCAL_ID, "alpha", "n7x-alpha", "--rev", String(getFeature(s.k.f.db, LOCAL_ID)!.rev)])).toMatchObject({ ok: true });
  await claim(s.k, "D", "n7x-d", "committed");
  s.publish({ rev: 7, bindings: [{ nodeKey: "alpha", taskId: "center-n7x-alpha" }, { nodeKey: "D", taskId: "center-n7x-d" }] });
  await s.k.sync();
  expect(await s.replica()).toMatchObject({ boundElsewhere: [], lastError: null });
  // Locally bound, center lost the bind: the existing failure, boundElsewhere untouched.
  s.publish({ version: 3, rev: 8, bindings: [] });
  expect(await s.k.sync()).toMatchObject({ features: [{ result: "failed", reason: "中心没有本机已绑节点的绑定" }] });
  expect(await s.replica()).toMatchObject({ version: 2, boundElsewhere: [], lastError: "中心没有本机已绑节点的绑定" });
  // Pre-N7X4 state file: entry without boundElsewhere.
  const state = readCenterReplicas();
  delete state.replicas[FEATURE_UUID]!.boundElsewhere;
  writeFileSync(join(s.k.dir, "shared-center-replicas.json"), JSON.stringify(state), { mode: 0o600 });
  expect(await s.replica()).toMatchObject({ boundElsewhere: [], version: 2 });
});

test("N7X4-AC4 start_node on a center-bound node with no claim → conflict with the boundElsewhere text; version changes keep theirs", async () => {
  const s = await setup();
  s.publish({ rev: 6, bindings: [{ nodeKey: "D", taskId: "center-other-card" }] });
  await s.k.sync();
  const out = await s.start("D");
  expect(out).toMatchObject({ ok: false, code: "conflict", error: CENTER_START_TEXT.boundElsewhere });
  expect(CENTER_START_TEXT.boundElsewhere).toBe("中心副本：这个节点在中心已被绑定到本机没有认领记录的卡，sync 解决不了；需要撤销中心绑定（N7X5），未开工");
  expect(CENTER_START_TEXT.boundElsewhere).not.toBe(CENTER_START_TEXT.conflict);
  // A newer center version: still the newer text.
  s.publish({ version: 3, rev: 7, bindings: [] });
  expect(await s.start("alpha")).toMatchObject({ ok: false, code: "conflict", error: CENTER_START_TEXT.newer });
  // Same version, node changed at the center: still the original conflict text.
  s.publish({ version: 2, rev: 8, nodes: [node("alpha", { fileGlobs: ["src/n7x/other.ts"] }), node("D")], bindings: [] });
  expect(await s.start("alpha")).toMatchObject({ ok: false, code: "conflict", error: CENTER_START_TEXT.conflict });
});
