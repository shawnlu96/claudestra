/** N7X5 `ledger center-replica unbind`: contract, orphan / boundElsewhere revoke, refusals with zero center writes, lost reply,
 * rejection mapping and the texts that point at the command (验收线 1–7). The fake center is an in-test fetch handler: no port,
 * no network.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { getTask } from "../src/lib/ledger-store.js";
import { putCenterClaim, readCenterClaims, setCenterClaimState } from "../src/lib/shared-ledger-center-claims.js";
import { syncCenterReplicas } from "../src/lib/shared-ledger-center-replica.js";
import { readCenterReplicas } from "../src/lib/shared-ledger-center-replica-state.js";
import { CENTER_START_TEXT, configureCenterStart } from "../src/lib/shared-ledger-center-start.js";
import { CENTER_UNBIND_TEXT, configureCenterUnbind } from "../src/lib/shared-ledger-center-unbind.js";
import { centerUnbindsPath, readCenterUnbinds } from "../src/lib/shared-ledger-center-unbind-records.js";
import {
  defaultProposalPolicy, featureProposalError, parseFeatureHomeBind, parseFeatureHomeUnbind, proposalDigest, type FeatureHomeBind,
  type FeatureHomeUnbind, type FeatureProposal,
} from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { createFeatureProposalFixtures } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import type { SharedLedgerErrorCode } from "../src/lib/shared-ledger-contract.js";
import { homeUnbindDigest } from "../src/lib/shared-ledger-feature-proposals-unbinds.js";
import {
  bindLocalReplica, CENTER, detailOf, fakeFeature, FEATURE_UUID, LOCAL_ID, node, projectionAck, replicaDagTools, type FakeFeature,
} from "./shared-center-kit.js";

/** Contract digest of fixtures.homeUnbind; N7X5C's center test asserts the same literal. */
const HOME_UNBIND_DIGEST = "6e6fd5e7a6167466a8a315a4feb1ec2bbdf835205cb9527875eef6b9a6b91041";
const FIELDS = ["expectedRev", "featureId", "nodeKey", "operationId", "reason", "schemaVersion", "taskId", "version"];
const UNBIND = "/v1/feature-proposals/unbinds", BIND = "/v1/feature-proposals/binds";
const SCOPE = { centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId };
const SPEC = "# 副本节点\n模板：code\n";
const POINTER = "用 `ledger center-replica unbind <feature> <节点> --reason ...` 撤销中心绑定后再开工";

type Hook = Response | "drop" | "hang";
const err = (code: SharedLedgerErrorCode) => Response.json(featureProposalError(code), { status: featureProposalError(code).status });
const hang = (signal?: AbortSignal | null) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));

/** The center in one fetch handler: proposal list, V1 detail, projections, binds (N7CB) and unbinds (N7X5C as specified). */
function fakeCenter() {
  const features = new Map<string, FakeFeature>(), proposals: unknown[] = [];
  const binds = new Map<string, { digest: string; result: unknown }>(), unbinds = new Map<string, { digest: string; result: unknown }>();
  const posts: { path: string; payload: Record<string, unknown> }[] = [], gets: string[] = [];
  const postHooks: Hook[] = [], getHooks: Response[] = [];
  const result = (op: string, digest: string, f: FakeFeature, n: number) => ({ schemaVersion: 1, requestId: op, commandDigest: digest,
    serverSeq: n, committedAt: 1000, result: { featureId: f.id, rev: f.rev, version: f.version } });
  const commitBind = (b: FeatureHomeBind) => {
    const digest = v2ObjectDigest(parseFeatureHomeBind(b)), prior = binds.get(b.operationId), f = features.get(b.featureId);
    if (prior) return prior.digest === digest ? Response.json(prior.result) : err("conflict");
    if (!f || b.expectedRev !== f.rev || b.version !== f.version || f.bindings.some((x) => x.nodeKey === b.nodeKey)) return err("conflict");
    f.rev++;
    f.bindings.push({ nodeKey: b.nodeKey, taskId: `center-${b.sourceTaskId}` });
    binds.set(b.operationId, { digest, result: result(b.operationId, digest, f, 100 + binds.size) });
    return Response.json(binds.get(b.operationId)!.result);
  };
  const commitUnbind = (u: FeatureHomeUnbind) => {
    let digest: string;
    try { digest = v2ObjectDigest(parseFeatureHomeUnbind(u)); } catch { return err("invalid_field"); }
    const prior = unbinds.get(u.operationId), f = features.get(u.featureId);
    if (prior) return prior.digest === digest ? Response.json(prior.result) : err("conflict");
    if (!f) return err("forbidden");
    const bound = f.bindings.find((b) => b.nodeKey === u.nodeKey);
    if (u.expectedRev !== f.rev || u.version !== f.version || !bound || bound.taskId !== u.taskId) return err("conflict");
    f.rev++;
    f.bindings = f.bindings.filter((b) => b.nodeKey !== u.nodeKey);
    unbinds.set(u.operationId, { digest, result: result(u.operationId, digest, f, 200 + unbinds.size) });
    return Response.json(unbinds.get(u.operationId)!.result);
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname, method = init?.method ?? "GET";
    if (method === "GET" && path === `/v1/feature-proposals/projects/${CENTER.projectId}`) return Response.json({ policy: defaultProposalPolicy(SCOPE), proposals });
    const detail = path.match(/^\/v1\/teams\/team-a\/features\/([^/]+)$/);
    if (method === "GET" && detail) {
      const f = features.get(detail[1]!);
      return f ? Response.json(detailOf(f)) : Response.json({ code: "forbidden", status: 403, message: "x" }, { status: 403 });
    }
    if (method === "POST" && (path === BIND || path === UNBIND)) {
      const { payload } = JSON.parse(String(init!.body)) as { payload: Record<string, unknown> };
      posts.push({ path, payload });
      if (path === BIND) return commitBind(payload as unknown as FeatureHomeBind);
      const hook = postHooks.shift();
      if (hook === "hang") return hang(init?.signal);
      if (hook === "drop") { commitUnbind(payload as unknown as FeatureHomeUnbind); return new Response("lost", { status: 503 }); }
      return hook ?? commitUnbind(payload as unknown as FeatureHomeUnbind);
    }
    for (const [root, store] of [[BIND, binds], [UNBIND, unbinds]] as const) {
      if (method === "GET" && path.startsWith(`${root}/`)) {
        const op = path.slice(root.length + 1);
        if (root === UNBIND) { gets.push(op); const hook = getHooks.shift(); if (hook) return hook; }
        const s = store.get(op);
        return Response.json(s ? { status: "committed", receipt: s.result } : { status: "unknown", requestId: op });
      }
    }
    if (method === "POST" && path === "/v1/teams/team-a/projections") return projectionAck(init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    features, posts, gets, postHooks, getHooks, fetch: fetchImpl,
    unbindPosts: () => posts.filter((p) => p.path === UNBIND).map((p) => p.payload as unknown as FeatureHomeUnbind),
    publish(f: FakeFeature, withProposal = false) {
      features.set(f.id, structuredClone(f));
      if (!withProposal) return;
      const proposal = { schemaVersion: 1, ...SCOPE, operationId: "op-new-1", title: f.title, description: "", ownerWords: null, nodes: f.nodes,
        homeInstanceId: f.homeInstanceId, expiresAt: 9_000_000_000_000, kind: "new" } as FeatureProposal;
      proposals.push({ proposal, proposalId: "proposal-new-1", proposalRev: 1, proposer: { type: "person", personId: "person-a", instanceId: null },
        operation: { schemaVersion: 1, ...SCOPE, operationId: "op-new-1", proposalDigest: proposalDigest(proposal), state: "published",
          proposalId: "proposal-new-1", featureId: f.id, version: f.version, updatedAt: 1000 } });
    },
    /** Republish with a patch, keeping the center's own rev / bindings unless the patch sets them. */
    patch(p: Partial<FakeFeature>) { features.set(FEATURE_UUID, { ...features.get(FEATURE_UUID)!, ...structuredClone(p) }); },
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { configureCenterStart(undefined); configureCenterUnbind(undefined); await cleanup?.(); cleanup = null; });

/** Local ledger + replica of a feature homed here, synced once through the fake center; start_node through the real dag tools. */
async function setup(nodes = [node("alpha"), node("D")]) {
  const c = fakeCenter(), me = instanceIdSync();
  const { f, dir, close } = await bindLocalReplica({ baseUrl: "http://127.0.0.1:9/", instanceId: me });
  cleanup = close;
  c.publish(fakeFeature({ homeInstanceId: me, nodes }), true);
  const sync = () => syncCenterReplicas(f.db, { localProject: f.project, fetch: c.fetch });
  expect(await sync()).toMatchObject({ features: [{ result: "created" }] });
  configureCenterStart({ fetch: c.fetch, timeoutMs: 300 });
  let n = 0;
  configureCenterUnbind({ fetch: c.fetch, timeoutMs: 300, newOperationId: () => `unbind-op-${++n}` });
  const opts = { createFails: false };
  const tools = replicaDagTools(f, opts);
  const start = (key: string, extra: Record<string, unknown> = {}) => tools.start_node(f.call, { featureId: LOCAL_ID, key, spec: SPEC, ...extra });
  const unbind = (key: string, who?: string, feature = LOCAL_ID) =>
    f.ledger(["center-replica", "unbind", feature, key, "--reason", "本机开卡失败，撤销孤儿绑定"], who) as Promise<Record<string, unknown>>;
  const replica = () => readCenterReplicas().replicas[FEATURE_UUID]!;
  const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
  const files = () => ({ unbinds: read(centerUnbindsPath()), claims: read(join(dir, "shared-center-binds.json")) });
  const localTask = (key: string) => (f.db.prepare("SELECT taskId FROM dag_bindings WHERE featureId = ? AND nodeKey = ?").get(LOCAL_ID, key) as { taskId: string } | null)?.taskId ?? null;
  return { f, c, me, opts, sync, start, unbind, replica, files, localTask };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** start_node whose local steps fail after the center bind: the claim ends orphan, the card cancelled. */
async function orphanAlpha(s: Setup) {
  s.opts.createFails = true;
  expect(await s.start("alpha")).toMatchObject({ ok: false });
  s.opts.createFails = false;
  const [claim] = readCenterClaims();
  expect(claim).toMatchObject({ state: "orphan", key: "alpha" });
  return claim!;
}

test("验收线1 契约：fixture 通过、恰 8 字段、reason 非空、非法 id 拒、摘要等于字面值", () => {
  const { homeUnbind } = createFeatureProposalFixtures();
  expect(parseFeatureHomeUnbind(homeUnbind)).toEqual(homeUnbind);
  expect(Object.keys(homeUnbind).sort()).toEqual(FIELDS);
  expect(homeUnbind).toMatchObject({ featureId: "feature-demo", version: 4, nodeKey: "n3", taskId: "ctask-demo-n3", expectedRev: 9, operationId: "op-demo-unbind" });
  expect(homeUnbindDigest(homeUnbind)).toBe(HOME_UNBIND_DIGEST);
  expect(v2ObjectDigest(homeUnbind)).toBe(HOME_UNBIND_DIGEST);
  const { reason: _r, ...missing } = homeUnbind;
  const { taskId: _t, ...noTask } = homeUnbind;
  for (const bad of [{ ...homeUnbind, extra: 1 }, { ...homeUnbind, sourceTaskId: "task-demo-1" }, missing, noTask, { ...homeUnbind, reason: "" },
    { ...homeUnbind, taskId: "bad id" }, { ...homeUnbind, featureId: "-x" }, { ...homeUnbind, nodeKey: "" }, { ...homeUnbind, expectedRev: 0 },
    { ...homeUnbind, schemaVersion: 2 }]) {
    expect(() => parseFeatureHomeUnbind(bad)).toThrow();
  }
});

test("验收线2 孤儿认领撤销：1 次 POST 8 字段、摘要一致；认领 released、sync 后节点仍空；start_node 新 op 认领建卡", async () => {
  const s = await setup();
  const orphan = await orphanAlpha(s);
  expect(await s.start("alpha", { taskId: "n7x-alpha-2" })).toMatchObject({ ok: false, error: CENTER_START_TEXT.orphan });
  const centerTask = `center-${orphan.taskId}`;
  expect(s.c.features.get(FEATURE_UUID)!.bindings).toEqual([{ nodeKey: "alpha", taskId: centerTask }]);
  const out = await s.unbind("alpha");
  expect(out).toMatchObject({ ok: true, key: "alpha", taskId: centerTask, released: [orphan.op], sync: { features: [{ result: "unchanged" }] } });
  const posts = s.c.unbindPosts();
  expect(posts).toHaveLength(1);
  expect(Object.keys(posts[0]!).sort()).toEqual(FIELDS);
  expect(posts[0]).toMatchObject({ schemaVersion: 1, featureId: FEATURE_UUID, nodeKey: "alpha", taskId: centerTask, version: 2, expectedRev: 6,
    reason: "本机开卡失败，撤销孤儿绑定" });
  const [row] = readCenterUnbinds();
  expect(row).toMatchObject({ op: posts[0]!.operationId, state: "committed", localFeatureId: LOCAL_ID, key: "alpha", taskId: centerTask });
  expect(row!.digest).toBe(homeUnbindDigest(posts[0]));
  expect(statSync(centerUnbindsPath()).mode & 0o777).toBe(0o600);
  expect(readCenterClaims()).toMatchObject([{ op: orphan.op, state: "released" }]);
  expect(s.localTask("alpha")).toBeNull();
  expect(s.replica()).toMatchObject({ rev: 7, boundElsewhere: [], lastError: null });
  // released counts as no claim: a new op, a new card.
  expect(await s.start("alpha", { taskId: "n7x-alpha-2" })).toMatchObject({ ok: true, taskId: "n7x-alpha-2" });
  const claims = readCenterClaims();
  expect(claims).toHaveLength(2);
  expect(claims[1]).toMatchObject({ state: "committed", taskId: "n7x-alpha-2" });
  expect(claims[1]!.op).not.toBe(orphan.op);
  expect(getTask(s.f.db, "n7x-alpha-2")).toMatchObject({ featureId: LOCAL_ID });
  expect(s.localTask("alpha")).toBe("n7x-alpha-2");
});

test("验收线2 第二轮：撤销后新认领再成孤儿 → 再次 unbind 真撤销新绑定（第 2 次 POST），旧 committed 记录不冒充、只释放新孤儿", async () => {
  const s = await setup();
  const first = await orphanAlpha(s);
  expect(await s.unbind("alpha")).toMatchObject({ ok: true, released: [first.op] });
  s.opts.createFails = true;
  expect(await s.start("alpha", { taskId: "n7x-alpha-2" })).toMatchObject({ ok: false });
  s.opts.createFails = false;
  const second = readCenterClaims()[1]!;
  expect(second).toMatchObject({ state: "orphan", key: "alpha", taskId: "n7x-alpha-2" });
  expect(s.c.features.get(FEATURE_UUID)!.bindings).toEqual([{ nodeKey: "alpha", taskId: "center-n7x-alpha-2" }]);
  const out = await s.unbind("alpha");
  expect(out).toMatchObject({ ok: true, taskId: "center-n7x-alpha-2", released: [second.op] });
  const posts = s.c.unbindPosts();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ nodeKey: "alpha", taskId: "center-n7x-alpha-2" });
  expect(out.op).toBe(posts[1]!.operationId);
  expect(readCenterUnbinds()).toMatchObject([{ state: "committed", orphans: [first.op] }, { state: "committed", orphans: [second.op] }]);
  expect(s.c.features.get(FEATURE_UUID)!.bindings).toEqual([]);
  expect(readCenterClaims().map((c) => c.state)).toEqual(["released", "released"]);
  expect(await s.start("alpha", { taskId: "n7x-alpha-3" })).toMatchObject({ ok: true, taskId: "n7x-alpha-3" });
  expect(s.localTask("alpha")).toBe("n7x-alpha-3");
});

test("验收线3 boundElsewhere 撤销：无认领、中心绑到本机没有的卡 → 成功；sync 后 boundElsewhere 与 lastError 清空", async () => {
  const s = await setup();
  s.c.patch({ rev: 6, bindings: [{ nodeKey: "D", taskId: "center-other-card" }] });
  await s.sync();
  expect(s.replica()).toMatchObject({ boundElsewhere: ["D"] });
  expect(s.replica().lastError).toContain(POINTER);
  expect(await s.start("D")).toMatchObject({ ok: false, error: CENTER_START_TEXT.boundElsewhere });
  expect(await s.unbind("D")).toMatchObject({ ok: true, key: "D", taskId: "center-other-card", released: [] });
  expect(s.c.unbindPosts()).toMatchObject([{ nodeKey: "D", taskId: "center-other-card", expectedRev: 6, version: 2 }]);
  expect(s.replica()).toMatchObject({ boundElsewhere: [], lastError: null, lastErrorAt: null, rev: 7 });
  expect(readCenterClaims()).toEqual([]);
});

test("验收线4 拒绝且零中心写请求：本机已有卡 / 认领 pending / committed / 版本变 / 中心无绑定 / 非 PM / 非副本 / 主场不是本机", async () => {
  const s = await setup([node("alpha"), node("D"), node("E"), node("F")]);
  expect(await s.start("alpha")).toMatchObject({ ok: true }); // alpha: local card
  // E: pending claim (center committed, reply lost)
  s.c.postHooks.length = 0;
  await putCenterClaim({ op: "bind-E", body: { schemaVersion: 1, featureId: FEATURE_UUID, expectedRev: 6, version: 2, nodeKey: "E", sourceTaskId: "n7x-e",
    operationId: "bind-E" }, digest: "e".repeat(64), localFeatureId: LOCAL_ID, key: "E", taskId: "n7x-e", state: "pending" });
  // F: committed claim, card not opened yet
  await putCenterClaim({ op: "bind-F", body: { schemaVersion: 1, featureId: FEATURE_UUID, expectedRev: 6, version: 2, nodeKey: "F", sourceTaskId: "n7x-f",
    operationId: "bind-F" }, digest: "f".repeat(64), localFeatureId: LOCAL_ID, key: "F", taskId: "n7x-f", state: "pending" });
  await setCenterClaimState("bind-F", "committed");
  s.c.patch({ bindings: [...s.c.features.get(FEATURE_UUID)!.bindings, { nodeKey: "D", taskId: "center-other-card" },
    { nodeKey: "E", taskId: "center-n7x-e" }, { nodeKey: "F", taskId: "center-n7x-f" }] });
  const before = s.files();
  const refuse = async (label: string, run: () => Promise<Record<string, unknown>>, error: string | RegExp, code?: string) => {
    const out = await run();
    expect({ label, ok: out.ok }).toEqual({ label, ok: false });
    if (typeof error === "string") expect({ label, error: out.error }).toEqual({ label, error });
    else expect(String(out.error)).toMatch(error);
    if (code) expect(out.code).toBe(code);
    expect({ label, posts: s.c.unbindPosts().length }).toEqual({ label, posts: 0 });
    expect({ label, files: s.files() }).toEqual({ label, files: before });
  };
  await refuse("本机已有卡", () => s.unbind("alpha"), CENTER_UNBIND_TEXT.localCard);
  await refuse("认领 pending", () => s.unbind("E"), CENTER_UNBIND_TEXT.inFlight);
  await refuse("认领 committed", () => s.unbind("F"), CENTER_UNBIND_TEXT.inFlight);
  await refuse("非 PM", () => s.unbind("D", "agent-stranger"), /PM \/ master \/ owner/, "forbidden");
  await refuse("不是副本", () => s.unbind("alpha", undefined, s.f.id), CENTER_UNBIND_TEXT.notReplica);
  await refuse("缺 reason", () => s.f.ledger(["center-replica", "unbind", LOCAL_ID, "D"]) as Promise<Record<string, unknown>>, CENTER_UNBIND_TEXT.reason);
  s.c.patch({ version: 3 });
  await refuse("中心版本变了", () => s.unbind("D"), CENTER_UNBIND_TEXT.versionChanged);
  s.c.patch({ version: 2, homeInstanceId: "home-elsewhere" });
  await refuse("主场不是本机", () => s.unbind("D"), CENTER_UNBIND_TEXT.notHome);
  s.c.patch({ homeInstanceId: s.me, bindings: s.c.features.get(FEATURE_UUID)!.bindings.filter((b) => b.nodeKey !== "D") });
  await refuse("中心该节点没有绑定", () => s.unbind("D"), CENTER_UNBIND_TEXT.notBound);
  expect(CENTER_UNBIND_TEXT.localCard).toBe("撤销中心绑定：本机已有卡，不撤销");
  expect(CENTER_UNBIND_TEXT.inFlight).toBe("撤销中心绑定：这个节点在开卡途中，用 start_node 续上，不撤销");
  expect(CENTER_UNBIND_TEXT.versionChanged).toBe("撤销中心绑定：中心版本已变，先 sync");
});

test("验收线5 丢回复：超时 → pending；GET committed 不重发走完；GET unknown 同 op 同体重发；GET 失败 → 拒、仍 pending", async () => {
  const s = await setup([node("alpha"), node("D"), node("E")]);
  s.c.patch({ rev: 6, bindings: [{ nodeKey: "D", taskId: "center-d" }, { nodeKey: "E", taskId: "center-e" }] });
  await s.sync();
  // D: POST times out (center never saw it) → pending; GET fails → still pending; GET unknown → same op, same body.
  s.c.postHooks.push("hang");
  expect(await s.unbind("D")).toMatchObject({ ok: false, error: CENTER_UNBIND_TEXT.unreachable });
  expect(readCenterUnbinds()).toMatchObject([{ key: "D", state: "pending" }]);
  for (const res of [new Response("down: secret detail", { status: 503 }), err("forbidden"), new Response("nope", { status: 404 }), err("bad_signature")]) {
    s.c.getHooks.push(res);
    const out = await s.unbind("D");
    expect(out).toMatchObject({ ok: false, error: CENTER_UNBIND_TEXT.unconfirmed });
    expect(JSON.stringify(out)).not.toContain("secret detail");
    expect(readCenterUnbinds()).toMatchObject([{ key: "D", state: "pending" }]);
  }
  expect(s.c.unbindPosts()).toHaveLength(1);
  expect(await s.unbind("D")).toMatchObject({ ok: true, key: "D" });
  const [first, again] = s.c.unbindPosts();
  expect(again).toEqual(first!);
  expect(homeUnbindDigest(again)).toBe(readCenterUnbinds()[0]!.digest);
  expect(readCenterUnbinds()).toMatchObject([{ key: "D", state: "committed" }]);
  // E: the center commits but the reply is lost → pending; next run GET committed → no resend, finishes (sync clears E).
  s.c.postHooks.push("drop");
  expect(await s.unbind("E")).toMatchObject({ ok: false, error: CENTER_UNBIND_TEXT.unreachable });
  expect(readCenterUnbinds()[1]).toMatchObject({ key: "E", state: "pending" });
  const sent = s.c.unbindPosts().length;
  expect(await s.unbind("E")).toMatchObject({ ok: true, key: "E", taskId: "center-e" });
  expect(s.c.unbindPosts()).toHaveLength(sent);
  expect(s.c.gets.at(-1)).toBe(readCenterUnbinds()[1]!.op);
  expect(readCenterUnbinds()[1]).toMatchObject({ state: "committed" });
  expect(s.c.features.get(FEATURE_UUID)!.bindings).toEqual([]);
  expect(s.replica()).toMatchObject({ boundElsewhere: [], lastError: null });
});

test("验收线6 拒绝映射：404 unsupported；409 conflict 不重试；409 replayed 重试恰 1 次；400 / 403 conflict；认领不动、输出不含原文", async () => {
  const s = await setup();
  const orphan = await orphanAlpha(s);
  const claimsBefore = s.files().claims;
  const cases: [string, Response[], string, string, number][] = [
    ["404", [new Response("nginx: no route secret detail", { status: 404 })], "unsupported", CENTER_UNBIND_TEXT.unsupported, 1],
    ["409 conflict", [err("conflict")], "conflict", CENTER_UNBIND_TEXT.conflict, 1],
    ["400", [err("invalid_field")], "conflict", CENTER_UNBIND_TEXT.invalid, 1],
    ["403 forbidden", [err("forbidden")], "conflict", CENTER_UNBIND_TEXT.forbidden, 1],
    ["403 execution_not_shared", [err("execution_not_shared")], "conflict", CENTER_UNBIND_TEXT.forbidden, 1],
    ["403 raw body", [Response.json({ message: "secret detail" }, { status: 403 })], "conflict", CENTER_UNBIND_TEXT.forbidden, 1],
    ["409 replayed twice", [err("replayed"), err("replayed")], "conflict", CENTER_UNBIND_TEXT.conflict, 2],
    // An unknown schemaVersion body keeps its HTTP status: only a real 404 is "unsupported".
    ["403 unknown schemaVersion", [Response.json({ schemaVersion: 2, code: "forbidden", reason: "x" }, { status: 403 })], "conflict", CENTER_UNBIND_TEXT.forbidden, 1],
    ["409 unknown schemaVersion", [Response.json({ schemaVersion: 2, code: "replayed", reason: "x" }, { status: 409 })], "conflict", CENTER_UNBIND_TEXT.conflict, 1],
    ["400 unknown schemaVersion", [Response.json({ schemaVersion: 2, code: "invalid_field", reason: "x" }, { status: 400 })], "conflict", CENTER_UNBIND_TEXT.invalid, 1],
  ];
  for (const [label, hooks, state, error, posts] of cases) {
    const sent = s.c.unbindPosts().length;
    s.c.postHooks.push(...hooks);
    const out = await s.unbind("alpha");
    expect({ label, out }).toMatchObject({ label, out: { ok: false, error } });
    expect(JSON.stringify(out)).not.toContain("secret detail");
    expect(JSON.stringify(out)).not.toContain("bearer-for-tests-only");
    expect({ label, posts: s.c.unbindPosts().length - sent }).toEqual({ label, posts });
    expect({ label, row: readCenterUnbinds().at(-1)!.state as string }).toEqual({ label, row: state });
    expect(s.files().claims).toBe(claimsBefore);
    expect(s.c.postHooks).toHaveLength(0);
  }
  expect(s.files().unbinds).not.toContain("secret detail");
  expect(CENTER_UNBIND_TEXT.unsupported).toBe("中心还不支持撤销绑定（404）");
  // 409 replayed once: a new nonce, exactly one retry, then committed.
  const sent = s.c.unbindPosts().length;
  s.c.postHooks.push(err("replayed"));
  expect(await s.unbind("alpha")).toMatchObject({ ok: true, released: [orphan.op] });
  const retried = s.c.unbindPosts().slice(sent);
  expect(retried).toHaveLength(2);
  expect(retried[1]).toEqual(retried[0]!);
  expect(readCenterUnbinds().at(-1)).toMatchObject({ state: "committed" });
});

test("验收线7 文案：N7X4 lastError、start_node boundElsewhere 与孤儿拒绝都指向 unbind 命令", async () => {
  expect(CENTER_START_TEXT.boundElsewhere).toBe(`中心副本：这个节点在中心已被绑定到本机没有认领记录的卡，sync 解决不了；${POINTER}，未开工`);
  expect(CENTER_START_TEXT.orphan).toBe(`中心副本：这个节点的认领已成孤儿绑定（中心已绑、本机开工失败已回滚），不会换卡号重新认领；${POINTER}；之后 start_node 要换一个新的 taskId（原卡号已被取消的卡占用）`);
  for (const t of [CENTER_START_TEXT.boundElsewhere, CENTER_START_TEXT.orphan]) expect(t).not.toContain("N7X5");
  const s = await setup();
  s.c.patch({ rev: 6, bindings: [{ nodeKey: "D", taskId: "center-other-card" }] });
  await s.sync();
  expect(s.replica().lastError).toBe(`中心已把节点 D 绑到本机没有认领记录的卡，本机不能开工；${POINTER}`);
});
