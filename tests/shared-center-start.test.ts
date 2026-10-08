/** N7X2 start_node on a center replica: claim at the center first, open the local card only after it committed (AC1–AC7). */
import { afterEach, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { getTask } from "../src/lib/ledger-store.js";
import { centerClaimsPath, putCenterClaim, readCenterClaims } from "../src/lib/shared-ledger-center-claims.js";
import { readCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import {
  CENTER_START_TEXT, claimCenterNode, configureCenterStart, reconcileCenterClaims,
} from "../src/lib/shared-ledger-center-start.js";
import { featureProposalError, parseFeatureHomeBind, type FeatureHomeBind } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { createFeatureProposalFixtures } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import type { SharedLedgerErrorCode } from "../src/lib/shared-ledger-contract.js";
import { homeBindDigest, SharedLedgerHomeBindClient } from "../src/lib/shared-ledger-feature-proposals-binds.js";
import { resolveMirrorCredential } from "../src/lib/shared-ledger-mirror.js";
import { CENTER, fakeFeature, FEATURE_UUID, ledgerSnapshot, LOCAL_ID, node, replicaKit, type FakeFeature } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => { configureCenterStart(undefined); await open?.close(); open = null; });

const ROOT = "/v1/feature-proposals/binds";
const SPEC = "# 副本节点\n模板：code\n";
const TASK = `${LOCAL_ID}-alpha`;
const FIELDS = ["expectedRev", "featureId", "nodeKey", "operationId", "schemaVersion", "sourceTaskId", "version"];
type Hook = (body: FeatureHomeBind) => Response | "drop" | "hang" | undefined | Promise<Response | "drop" | "hang" | undefined>;

const err = (code: SharedLedgerErrorCode) => Response.json(featureProposalError(code), { status: featureProposalError(code).status });
const hang = (signal?: AbortSignal | null) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));

/** The N7CB side of the fake center (binds): wraps the kit center's transport, everything else goes to the kit. */
function bindCenter(k: Kit) {
  const stored = new Map<string, { digest: string; result: Record<string, unknown>; nodeKey: string; featureId: string }>();
  const posts: { payload: FeatureHomeBind; nonce: string }[] = [], gets: string[] = [], order: string[] = [];
  const postHooks: Hook[] = [], getHooks: ((op: string) => Response | undefined)[] = [];
  const state = { refuse: false, other: 0 };
  const feature = (id: string) => k.center.features.get(id) as FakeFeature | undefined;
  const commit = (b: FeatureHomeBind): Response => {
    const digest = v2ObjectDigest(parseFeatureHomeBind(b)), prior = stored.get(b.operationId), f = feature(b.featureId);
    if (prior) return prior.digest === digest ? Response.json(prior.result) : err("conflict");
    if (!f) return err("forbidden");
    if (b.expectedRev !== f.rev || b.version !== f.version || f.bindings.some((x) => x.nodeKey === b.nodeKey) || !f.nodes.some((n) => n.key === b.nodeKey)) return err("conflict");
    f.rev++;
    f.bindings.push({ nodeKey: b.nodeKey, taskId: `center-${b.sourceTaskId}` });
    const result = { schemaVersion: 1, requestId: b.operationId, commandDigest: digest, serverSeq: 100 + stored.size, committedAt: 1000,
      result: { featureId: f.id, rev: f.rev, version: f.version } };
    stored.set(b.operationId, { digest, result, nodeKey: b.nodeKey, featureId: f.id });
    return Response.json(result);
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (state.refuse) throw new TypeError("connect ECONNREFUSED 127.0.0.1 bearer-for-tests-only");
    if (url.pathname === ROOT && init?.method === "POST") {
      const { attemptNonce, payload } = JSON.parse(String(init.body)) as { attemptNonce: string; payload: FeatureHomeBind };
      posts.push({ payload, nonce: attemptNonce });
      order.push("bind");
      const out = await postHooks.shift()?.(payload);
      if (out === "drop") { commit(payload); return new Response("lost", { status: 503 }); }
      if (out === "hang") return hang(init.signal);
      return out ?? commit(payload);
    }
    if (url.pathname.startsWith(`${ROOT}/`) && init?.method === "GET") {
      const op = url.pathname.slice(ROOT.length + 1);
      gets.push(op);
      const out = getHooks.shift()?.(op);
      if (out) return out;
      const s = stored.get(op);
      return Response.json(s ? { status: "committed", receipt: s.result } : { status: "unknown", requestId: op });
    }
    state.other++;
    return fetch(input, init);
  }) as typeof fetch;
  /** Center rollback: the bind is gone, as if it never committed. */
  const rollback = (op: string) => {
    const s = stored.get(op)!, f = feature(s.featureId)!;
    stored.delete(op);
    f.bindings = f.bindings.filter((b) => b.nodeKey !== s.nodeKey);
    f.rev--;
  };
  return { stored, posts, gets, order, postHooks, getHooks, state, fetch: fetchImpl, rollback };
}

/** Replica kit whose service credential is this instance (the X1 kit's default instance is someone else's). */
async function setup(nodes?: FakeFeature["nodes"], opts: { createFails?: boolean } = {}) {
  const me = instanceIdSync();
  configureCenterStart(undefined);
  await open?.close();
  const k = open = await replicaKit({ credentialInstance: me });
  k.center.publish(fakeFeature({ homeInstanceId: me, ...(nodes ? { nodes } : {}) }));
  expect(await k.sync()).toMatchObject({ features: [{ result: "created" }] });
  const c = bindCenter(k);
  configureCenterStart({ fetch: c.fetch, timeoutMs: 300 });
  const f = k.f;
  const manager = async (args: string[]) => {
    f.calls.push(args);
    c.order.push(args[0] === "ledger" ? args[1]! : args[0]!);
    if (args[0] === "ledger") return f.ledger(args.slice(1));
    if (args[0] === "create") return opts.createFails ? { ok: false, error: "合成失败" } : { ok: true, agent: `agent-${args[1]}` };
    return { ok: true };
  };
  const deps: DagToolDeps = { db: () => f.db, manager, callerProject: () => f.project, startEnv: () => f.startEnv, stepIO: () => f.io };
  const tools = dagToolHandlers(deps);
  const start = (key = "alpha", extra: Record<string, unknown> = {}) => tools.start_node(f.call, { featureId: LOCAL_ID, key, spec: SPEC, ...extra });
  return { k, c, f, start, me, tools };
}
const counts = (k: Kit) => { const { claims: _c, ...rest } = ledgerSnapshot(k.f.db); return rest; };
const claims = () => readCenterClaims();
const resetClaims = () => writeFileSync(centerClaimsPath(), JSON.stringify({ claims: [] }), { mode: 0o600 });
const noLocalStart = (s: Awaited<ReturnType<typeof setup>>) => {
  expect(s.f.calls.filter((c) => c[0] === "create" || c[1] === "task-new")).toEqual([]);
  expect(getTask(s.f.db, TASK)).toBeNull();
};

test("contract: homeBindDigest is v2ObjectDigest(parseFeatureHomeBind(fixture)), computed not literal", () => {
  const { homeBind } = createFeatureProposalFixtures();
  expect(homeBindDigest(homeBind)).toBe(v2ObjectDigest(parseFeatureHomeBind(homeBind)));
  expect(homeBindDigest({ ...homeBind })).toBe(homeBindDigest(homeBind));
  expect(homeBindDigest({ ...homeBind, operationId: "op-demo-other" })).not.toBe(homeBindDigest(homeBind));
  expect(() => homeBindDigest({ ...homeBind, extra: 1 })).toThrow();
});

test("AC1 claim committed at the center before the card: 1 POST, 7 contract fields, digest matches, then card / worktree / agent / bind", async () => {
  const s = await setup();
  const out = await s.start();
  expect(out).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.posts).toHaveLength(1);
  const body = s.c.posts[0]!.payload;
  expect(Object.keys(body).sort()).toEqual(FIELDS);
  expect(body).toMatchObject({ schemaVersion: 1, featureId: FEATURE_UUID, nodeKey: "alpha", sourceTaskId: TASK, version: 2, expectedRev: 5 });
  const [claim] = claims();
  expect(claim).toMatchObject({ op: body.operationId, state: "committed", localFeatureId: LOCAL_ID, key: "alpha", taskId: TASK });
  expect(claim!.digest).toBe(v2ObjectDigest(parseFeatureHomeBind(body)));
  expect(s.c.stored.get(body.operationId)!.result.commandDigest).toBe(claim!.digest);
  // Claim first, then the local steps.
  expect(s.c.order[0]).toBe("bind");
  expect(s.c.order.indexOf("task-new")).toBeGreaterThan(0);
  expect(s.c.order).toContain("create");
  expect(getTask(s.f.db, TASK)).toMatchObject({ featureId: LOCAL_ID });
  expect(s.f.db.prepare("SELECT nodeKey, taskId FROM dag_bindings WHERE featureId = ?").all(LOCAL_ID)).toEqual([{ nodeKey: "alpha", taskId: TASK }]);
  const client = new SharedLedgerHomeBindClient(resolveMirrorCredential(CENTER)!, instanceKeySync()!, { fetch: s.c.fetch });
  expect(await client.status(body)).toMatchObject({ requestId: body.operationId, commandDigest: claim!.digest });
  expect(statSync(centerClaimsPath()).mode & 0o777).toBe(0o600);
  // A second start_node is the duplicate answer, no second bind.
  expect(await s.start()).toMatchObject({ ok: true, duplicate: true, taskId: TASK });
  expect(s.c.posts).toHaveLength(1);
});

test("AC2 unreachable / 5xx / timeout / 409 conflict / 403 / 401 / 404 / 400: ledger untouched, only the 0600 claim, fixed text, no bearer", async () => {
  const s = await setup();
  const before = counts(s.k);
  const cases: [string, () => void, string][] = [
    ["5xx", () => s.c.postHooks.push(() => new Response("center exploded: secret detail", { status: 502 })), CENTER_START_TEXT.unreachable],
    ["timeout", () => s.c.postHooks.push(() => "hang"), CENTER_START_TEXT.unreachable],
    ["409 conflict", () => s.c.postHooks.push(() => err("conflict"), () => err("conflict")), CENTER_START_TEXT.conflict],
    ["403 forbidden", () => s.c.postHooks.push(() => err("forbidden")), CENTER_START_TEXT.forbidden],
    ["403 execution_not_shared", () => s.c.postHooks.push(() => err("execution_not_shared")), CENTER_START_TEXT.forbidden],
    ["401", () => s.c.postHooks.push(() => err("bad_signature")), CENTER_START_TEXT.unauthorized],
    ["404", () => s.c.postHooks.push(() => new Response("not found", { status: 404 })), CENTER_START_TEXT.notFound],
    ["400", () => s.c.postHooks.push(() => err("invalid_field")), CENTER_START_TEXT.invalid],
  ];
  for (const [label, arm, text] of cases) {
    resetClaims();
    arm();
    const sent = s.c.posts.length;
    const out = await s.start();
    expect({ label, out }).toMatchObject({ label, out: { ok: false, error: text } });
    expect(JSON.stringify(out)).not.toContain("bearer-for-tests-only");
    expect(JSON.stringify(out)).not.toContain("secret detail");
    expect(counts(s.k)).toEqual(before);
    noLocalStart(s);
    expect(claims().length).toBeGreaterThan(0);
    expect(statSync(centerClaimsPath()).mode & 0o777).toBe(0o600);
    expect(s.c.postHooks).toHaveLength(0);
    expect({ label, posts: s.c.posts.length - sent }).toEqual({ label, posts: label === "409 conflict" ? 2 : 1 }); // only conflict retries, once
  }
  // Center down before anything: not even a claim, same fixed text.
  resetClaims();
  s.c.state.refuse = true;
  const out = await s.start();
  expect(out).toMatchObject({ ok: false, error: CENTER_START_TEXT.unreachable });
  expect(JSON.stringify(out)).not.toContain("bearer");
  expect(claims()).toEqual([]);
  expect(counts(s.k)).toEqual(before);
  noLocalStart(s);
});

test("AC3 lost reply: next start_node asks binds/{op}, committed resumes with the claim's card, one center bind", async () => {
  const s = await setup();
  s.c.postHooks.push(() => "drop");
  expect(await s.start()).toMatchObject({ ok: false, error: CENTER_START_TEXT.unreachable });
  expect(claims()).toMatchObject([{ state: "pending", taskId: TASK }]);
  noLocalStart(s);
  const out = await s.start("alpha", { taskId: `${TASK}-other` }); // the claim's card wins
  expect(out).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.gets).toEqual([s.c.posts[0]!.payload.operationId]);
  expect(s.c.posts).toHaveLength(1);
  expect(s.c.stored.size).toBe(1);
  expect(s.k.center.features.get(FEATURE_UUID)!.bindings).toHaveLength(1);
  expect(claims()).toMatchObject([{ state: "committed" }]);
});

test("AC3 unknown after a center rollback: same op, same body resent; 409 replayed retried once with a new nonce", async () => {
  const s = await setup();
  s.c.postHooks.push(() => "drop");
  expect(await s.start()).toMatchObject({ ok: false });
  const op = s.c.posts[0]!.payload.operationId;
  s.c.rollback(op);
  s.c.postHooks.push(() => err("replayed"));
  expect(await s.start()).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.gets).toEqual([op]);
  expect(s.c.posts).toHaveLength(3);
  for (const p of s.c.posts) expect(p.payload).toEqual(s.c.posts[0]!.payload);
  expect(new Set(s.c.posts.map((p) => p.nonce)).size).toBe(3);
  expect(claims()).toMatchObject([{ op, state: "committed" }]);
  expect(s.k.center.features.get(FEATURE_UUID)!.bindings).toHaveLength(1);
});

test("AC4 an echo with another commandDigest / requestId / featureId / version is unreachable: zero local writes", async () => {
  const s = await setup();
  const before = counts(s.k);
  const tampers: ((r: Record<string, any>) => void)[] = [
    (r) => { r.commandDigest = "e".repeat(64); }, (r) => { r.requestId = "bind-someone-else"; },
    (r) => { r.result.featureId = "0f1e2d3c-0000-4978-8796-a5b4c3d2e1f0"; }, (r) => { r.result.version = 9; },
  ];
  for (const tamper of tampers) {
    resetClaims();
    s.c.postHooks.push((b) => {
      const r = { schemaVersion: 1, requestId: b.operationId, commandDigest: v2ObjectDigest(parseFeatureHomeBind(b)), serverSeq: 1, committedAt: 1,
        result: { featureId: b.featureId, rev: b.expectedRev + 1, version: b.version } };
      tamper(r);
      return Response.json(r);
    });
    expect(await s.start()).toMatchObject({ ok: false, error: CENTER_START_TEXT.unreachable });
    expect(claims()).toMatchObject([{ state: "pending" }]);
    expect(counts(s.k)).toEqual(before);
    noLocalStart(s);
  }
});

test("AC5 two nodes of one feature concurrently both succeed; a 409 from a moved rev retries once with a new op", async () => {
  const s = await setup([node("alpha"), node("gamma")]);
  const [a, g] = await Promise.all([s.start("alpha"), s.start("gamma")]);
  expect(a).toMatchObject({ ok: true, taskId: TASK });
  expect(g).toMatchObject({ ok: true, taskId: `${LOCAL_ID}-gamma` });
  expect(s.k.center.features.get(FEATURE_UUID)!.bindings.map((b) => b.nodeKey).sort()).toEqual(["alpha", "gamma"]);

  // Another instance moves the rev between our read and our POST: 409 → not committed → re-read → new op.
  const t = await setup([node("alpha"), node("gamma")]);
  t.c.postHooks.push((b) => { t.k.center.features.get(b.featureId)!.rev++; return undefined; });
  expect(await t.start("alpha")).toMatchObject({ ok: true, taskId: TASK });
  expect(t.c.posts).toHaveLength(2);
  expect(t.c.posts[1]!.payload.operationId).not.toBe(t.c.posts[0]!.payload.operationId);
  expect(t.c.posts[1]!.payload.expectedRev).toBe(t.c.posts[0]!.payload.expectedRev + 1);
  expect(t.c.gets).toEqual([t.c.posts[0]!.payload.operationId]);
  expect(claims().map((c) => c.state)).toEqual(["conflict", "committed"]);
});

test("AC5 one node concurrently is claimed once (start_node busy; direct claims share the committed claim)", async () => {
  const s = await setup();
  const [one, two] = await Promise.all([s.start(), s.start()]);
  expect([one, two].filter((r) => r.ok)).toHaveLength(1);
  expect([one, two].find((r) => !r.ok)).toMatchObject({ code: "busy" });
  expect(s.c.posts).toHaveLength(1);

  const t = await setup([node("alpha"), node("gamma")]);
  const f = getFeature(t.f.db, LOCAL_ID)!;
  const outs = await Promise.all([claimCenterNode(t.f.db, f, "gamma"), claimCenterNode(t.f.db, f, "gamma"), claimCenterNode(t.f.db, f, "gamma")]);
  for (const out of outs) expect(out).toEqual({ ok: true, taskId: `${LOCAL_ID}-gamma` });
  expect(t.c.posts).toHaveLength(1);
  expect(claims()).toMatchObject([{ key: "gamma", state: "committed" }]);
});

test("AC5 center newer than the replica: refused with zero ledger writes (no sync inside the claim), claims at the new version after a sync", async () => {
  const s = await setup();
  const before = counts(s.k);
  const newer = fakeFeature({ homeInstanceId: s.me, version: 3, rev: 6, nodes: [node("alpha", { fileGlobs: ["src/n7x/alpha-v3.ts"] }), node("beta", { deps: ["alpha"] })] });
  s.k.center.publish(newer, "revise");
  expect(await s.start()).toMatchObject({ ok: false, code: "conflict", error: CENTER_START_TEXT.newer });
  expect(s.c.posts).toEqual([]);
  expect(claims()).toEqual([]);
  expect(counts(s.k)).toEqual(before); // events seq and dag_versions untouched
  expect(readCenterReplicas().replicas[FEATURE_UUID]).toMatchObject({ version: 2 });
  noLocalStart(s);
  // review sync-before-bind: center newer and the bind would be refused — still no sync event, no new version.
  s.c.postHooks.push(() => err("forbidden"));
  expect(await s.start()).toMatchObject({ ok: false, error: CENTER_START_TEXT.newer });
  expect(counts(s.k)).toEqual(before);
  s.c.postHooks.length = 0;
  // After the explicit sync, the claim goes out at the new version.
  await s.k.sync();
  expect(await s.start()).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.posts).toHaveLength(1);
  expect(s.c.posts[0]!.payload).toMatchObject({ version: 3, expectedRev: 6 });
  expect(getTask(s.f.db, TASK)).toMatchObject({ extra: { fileGlobs: ["src/n7x/alpha-v3.ts"] } });
});

test("AC5 409 conflict after the center moved to another version: re-read refuses, no second POST at the new version", async () => {
  const s = await setup();
  s.c.postHooks.push(() => {
    s.k.center.publish(fakeFeature({ homeInstanceId: s.me, version: 3, rev: 6, nodes: [node("alpha", { fileGlobs: ["src/n7x/changed.ts"] }), node("beta", { deps: ["alpha"] })] }), "revise");
    return err("conflict");
  });
  const before = counts(s.k);
  expect(await s.start()).toMatchObject({ ok: false, code: "conflict" });
  expect(s.c.posts.map((p) => p.payload.version)).toEqual([2]);
  expect(s.c.gets).toEqual([s.c.posts[0]!.payload.operationId]);
  expect(claims().map((c) => c.state)).toEqual(["conflict"]);
  expect(counts(s.k)).toEqual(before);
  noLocalStart(s);
});

test("AC6 local steps fail after the claim: rolled back, claim orphan, the node is then always refused (no new claim)", async () => {
  const s = await setup(undefined, { createFails: true });
  const out = await s.start();
  expect(out).toMatchObject({ ok: false });
  expect(getTask(s.f.db, TASK)).toMatchObject({ stage: "cancelled" });
  expect(claims()).toMatchObject([{ state: "orphan", taskId: TASK }]);
  for (const extra of [{}, { taskId: `${TASK}-again` }]) {
    expect(await s.start("alpha", extra)).toMatchObject({ ok: false, code: "forbidden", error: CENTER_START_TEXT.orphan });
  }
  expect(s.c.posts).toHaveLength(1);
  expect(claims()).toHaveLength(1);
});

test("AC6 a committed claim whose card was rolled back (crash before the orphan mark) is orphaned on the next start_node or tick", async () => {
  const s = await setup(undefined, { createFails: true });
  await s.start();
  // Pretend the orphan mark was lost: rewrite the claim back to committed.
  const [c] = claims();
  writeFileSync(centerClaimsPath(), JSON.stringify({ claims: [{ ...c, state: "committed" }] }), { mode: 0o600 });
  await reconcileCenterClaims(s.f.db);
  expect(claims()).toMatchObject([{ state: "orphan" }]);
  writeFileSync(centerClaimsPath(), JSON.stringify({ claims: [{ ...c, state: "committed" }] }), { mode: 0o600 });
  expect(await s.start()).toMatchObject({ ok: false, error: CENTER_START_TEXT.orphan });
  expect(claims()).toMatchObject([{ state: "orphan" }]);
});

test("tick settles a pending claim the center committed (lost reply), never posts", async () => {
  const s = await setup();
  s.c.postHooks.push(() => "drop");
  await s.start();
  expect(claims()).toMatchObject([{ state: "pending" }]);
  await reconcileCenterClaims();
  expect(claims()).toMatchObject([{ state: "committed" }]);
  expect(s.c.posts).toHaveLength(1);
  expect(await s.start()).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.posts).toHaveLength(1);
});

test("no committed claim without this instance's service credential: refused before any claim or center request", async () => {
  const s = await setup();
  configureCenterStart({ fetch: s.c.fetch, instanceId: () => "someone-else" });
  const other = s.c.state.other;
  expect(await s.start()).toMatchObject({ ok: false, code: "forbidden", error: CENTER_START_TEXT.noCredential });
  expect(s.c.state.other).toBe(other);
  expect(s.c.posts).toEqual([]);
  expect(existsSync(centerClaimsPath()) ? claims() : []).toEqual([]);
});

test("AC7 a non-replica feature's start_node sends no center request and never touches claims", async () => {
  const s = await setup();
  const before = s.c.state.other;
  const out = await s.tools.start_node(s.f.call, { featureId: s.f.id, key: "next", spec: SPEC });
  expect(out).toMatchObject({ ok: true });
  expect(s.c.state.other).toBe(before);
  expect(s.c.posts).toEqual([]);
  expect(s.c.gets).toEqual([]);
  expect(await claimCenterNode(s.f.db, getFeature(s.f.db, s.f.id)!, "next")).toEqual({ ok: true });
  expect(claims()).toEqual([]);
  // A stray claim on another feature never makes a non-replica node claim either.
  await putCenterClaim({ op: "bind-x", body: { a: 1 }, digest: "a".repeat(64), localFeatureId: s.f.id, key: "next", taskId: "c5a0-gate-next", state: "pending" });
  expect(await claimCenterNode(s.f.db, getFeature(s.f.db, s.f.id)!, "next")).toEqual({ ok: true });
  expect(s.c.gets).toEqual([]);
});

test("AC1/AC3 a committed claim with no card yet is not a licence: rollback + center down refuses with zero local steps, back up resends the same op", async () => {
  const s = await setup();
  s.c.postHooks.push(() => "drop");
  expect(await s.start()).toMatchObject({ ok: false });
  await reconcileCenterClaims();
  expect(claims()).toMatchObject([{ state: "committed" }]);
  const op = s.c.posts[0]!.payload.operationId;
  s.c.rollback(op);
  s.c.state.refuse = true;
  const before = counts(s.k);
  expect(await s.start()).toMatchObject({ ok: false, error: CENTER_START_TEXT.unreachable });
  expect(counts(s.k)).toEqual(before);
  noLocalStart(s);
  expect(s.c.stored.size).toBe(0);
  // Center back: GET says unknown → same op, same body resent → card opens.
  s.c.state.refuse = false;
  expect(await s.start()).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.posts).toHaveLength(2);
  expect(s.c.posts[1]!.payload).toEqual(s.c.posts[0]!.payload);
  expect(s.c.stored.size).toBe(1);
  expect(claims()).toMatchObject([{ op, state: "committed" }]);
});

test("AC3 a committed claim whose resend is refused stays committed and refused (lapsed), never opens the card", async () => {
  const s = await setup();
  s.c.postHooks.push(() => "drop");
  await s.start();
  await reconcileCenterClaims();
  s.c.rollback(s.c.posts[0]!.payload.operationId);
  s.c.postHooks.push(() => err("conflict"));
  expect(await s.start()).toMatchObject({ ok: false, code: "conflict", error: CENTER_START_TEXT.lapsed });
  expect(claims()).toMatchObject([{ state: "committed" }]);
  noLocalStart(s);
});

test("AC3 a failing GET binds/{op} (401 / 403 / 404) proves nothing: the claim stays pending and resumes once the center answers", async () => {
  for (const bad of [() => err("bad_signature"), () => err("forbidden"), () => new Response("nope", { status: 404 })]) {
    const s = await setup();
    s.c.postHooks.push(() => "drop");
    expect(await s.start()).toMatchObject({ ok: false });
    s.c.getHooks.push(bad);
    expect(await s.start()).toMatchObject({ ok: false });
    expect(claims()).toMatchObject([{ state: "pending" }]);
    noLocalStart(s);
    expect(await s.start()).toMatchObject({ ok: true, taskId: TASK });
    expect(s.c.posts).toHaveLength(1);
    expect(s.c.gets).toHaveLength(2);
    expect(claims()).toMatchObject([{ state: "committed" }]);
  }
});

test("AC3 409 conflict whose GET binds/{op} fails stays pending (no conflict settle, no retry)", async () => {
  const s = await setup();
  s.c.postHooks.push(() => err("conflict"));
  s.c.getHooks.push(() => err("bad_signature"));
  expect(await s.start()).toMatchObject({ ok: false, error: CENTER_START_TEXT.unauthorized });
  expect(s.c.posts).toHaveLength(1);
  expect(claims()).toMatchObject([{ state: "pending" }]);
});

test("AC2 a taken card id is refused before any claim; a free card id then claims normally", async () => {
  const s = await setup();
  const taken = (s.f.db.query("SELECT id FROM tasks LIMIT 1").get() as { id: string }).id;
  for (const taskId of [taken, taken.toUpperCase(), "-bad id"]) {
    expect(await s.start("alpha", { taskId })).toMatchObject({ ok: false, code: "conflict", error: CENTER_START_TEXT.cardTaken });
  }
  expect(s.c.posts).toEqual([]);
  expect(s.c.state.other).toBe(0);
  expect(claims()).toEqual([]);
  expect(await s.start("alpha", { taskId: TASK })).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.posts).toHaveLength(1);
});

test("preflight refusing after the claim: the claim keeps its card and the refusal names it; a card taken meanwhile orphans the claim", async () => {
  const s = await setup();
  expect(await s.start("alpha", { spec: "" })).toMatchObject({ ok: false, code: "no_spec" });
  expect(claims()).toMatchObject([{ state: "committed", taskId: TASK }]);
  expect((await s.start("alpha", { spec: "" })) as { error: string }).toMatchObject({ error: expect.stringContaining(TASK) });
  expect(await s.start()).toMatchObject({ ok: true, taskId: TASK });
  expect(s.c.posts).toHaveLength(1);

  const t = await setup();
  expect(await t.start("alpha", { spec: "" })).toMatchObject({ ok: false, code: "no_spec" });
  // Someone else's card under the same id, created after the claim.
  t.f.db.run("CREATE TEMP TABLE other_card AS SELECT * FROM tasks LIMIT 1");
  t.f.db.run("UPDATE other_card SET id = ?, featureId = NULL, stage = 'build'", [TASK]);
  t.f.db.run("INSERT INTO tasks SELECT * FROM other_card");
  expect(await t.start()).toMatchObject({ ok: false, code: "forbidden", error: CENTER_START_TEXT.orphan });
  expect(claims()).toMatchObject([{ state: "orphan" }]);
  expect(t.c.posts).toHaveLength(1);
});
