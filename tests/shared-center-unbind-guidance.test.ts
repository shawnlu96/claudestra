/** N7X5F unbind guidance: a card the center already holds a projection of is refused locally (no POST, no row); repeated 409
 * conflicts of a node share one counted row with the "just changed" text; an orphan revoke and the orphan refusal both say
 * start_node needs a new taskId. The fake center is an in-test fetch handler: no port, no network.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { readCenterClaims } from "../src/lib/shared-ledger-center-claims.js";
import { syncCenterReplicas } from "../src/lib/shared-ledger-center-replica.js";
import { CENTER_START_TEXT, configureCenterStart } from "../src/lib/shared-ledger-center-start.js";
import { CENTER_UNBIND_TEXT, configureCenterUnbind } from "../src/lib/shared-ledger-center-unbind.js";
import { centerUnbindsPath, readCenterUnbinds } from "../src/lib/shared-ledger-center-unbind-records.js";
import {
  defaultProposalPolicy, featureProposalError, parseFeatureHomeBind, parseFeatureHomeUnbind, proposalDigest, type FeatureHomeBind,
  type FeatureHomeUnbind, type FeatureProposal,
} from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import type { SharedLedgerFeatureDetail, SharedLedgerErrorCode } from "../src/lib/shared-ledger-contract.js";
import {
  bindLocalReplica, CENTER, detailOf, fakeFeature, FEATURE_UUID, LOCAL_ID, node, projectionAck, replicaDagTools, type FakeFeature,
} from "./shared-center-kit.js";

const UNBIND = "/v1/feature-proposals/unbinds", BIND = "/v1/feature-proposals/binds";
const SCOPE = { centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId };
const SPEC = "# 副本节点\n模板：code\n";
const NEW_ID = "之后 start_node 要换一个新的 taskId（原卡号已被取消的卡占用）";
const err = (code: SharedLedgerErrorCode) => Response.json(featureProposalError(code), { status: featureProposalError(code).status });

/** A center task projection of `taskId` as the V1 detail carries it (the center received this card's projection). */
const projected = (taskId: string, sourceTaskId: string): SharedLedgerFeatureDetail["tasks"][number] => ({ taskId, sourceTaskId, sourceRev: 1,
  sourceSeq: 1, stage: "in_progress", assigneeCode: null, executorInstanceId: null, pr: null, head: null, deps: [], specSummary: "x",
  specDigest: null, fullText: "home_only", steps: [], asks: [] });

/** Proposal list, V1 detail (with `tasks` the test sets), projections, binds and unbinds; unbind POSTs can be answered by hooks. */
function fakeCenter() {
  const features = new Map<string, FakeFeature>(), tasks: SharedLedgerFeatureDetail["tasks"] = [], proposals: unknown[] = [];
  const binds = new Map<string, unknown>(), unbinds = new Map<string, unknown>(), unbindPosts: FeatureHomeUnbind[] = [], postHooks: Response[] = [];
  const result = (op: string, digest: string, f: FakeFeature, n: number) => ({ schemaVersion: 1, requestId: op, commandDigest: digest,
    serverSeq: n, committedAt: 1000, result: { featureId: f.id, rev: f.rev, version: f.version } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname, method = init?.method ?? "GET";
    if (method === "GET" && path === `/v1/feature-proposals/projects/${CENTER.projectId}`) return Response.json({ policy: defaultProposalPolicy(SCOPE), proposals });
    const detail = path.match(/^\/v1\/teams\/team-a\/features\/([^/]+)$/);
    if (method === "GET" && detail) {
      const d = detailOf(features.get(detail[1]!)!);
      // tasks need the feature's projection (home source): the center serves both once a projection arrived.
      if (tasks.length) d.feature.projection = { sourceInstanceId: d.feature.homeInstanceId, sourceSeq: 1, observedAt: 1000, receivedAt: 1000 };
      return Response.json({ ...d, tasks });
    }
    if (method === "POST" && path === BIND) {
      const b = (JSON.parse(String(init!.body)) as { payload: FeatureHomeBind }).payload, f = features.get(b.featureId)!;
      const digest = v2ObjectDigest(parseFeatureHomeBind(b));
      if (b.expectedRev !== f.rev || f.bindings.some((x) => x.nodeKey === b.nodeKey)) return err("conflict");
      f.rev++;
      f.bindings.push({ nodeKey: b.nodeKey, taskId: `center-${b.sourceTaskId}` });
      binds.set(b.operationId, result(b.operationId, digest, f, 100 + binds.size));
      return Response.json(binds.get(b.operationId));
    }
    if (method === "POST" && path === UNBIND) {
      const u = (JSON.parse(String(init!.body)) as { payload: FeatureHomeUnbind }).payload, f = features.get(u.featureId)!;
      unbindPosts.push(u);
      const hook = postHooks.shift();
      if (hook) return hook;
      const digest = v2ObjectDigest(parseFeatureHomeUnbind(u)), bound = f.bindings.find((b) => b.nodeKey === u.nodeKey);
      if (u.expectedRev !== f.rev || !bound || bound.taskId !== u.taskId) return err("conflict");
      f.rev++;
      f.bindings = f.bindings.filter((b) => b.nodeKey !== u.nodeKey);
      unbinds.set(u.operationId, result(u.operationId, digest, f, 200 + unbinds.size));
      return Response.json(unbinds.get(u.operationId));
    }
    for (const [root, store] of [[BIND, binds], [UNBIND, unbinds]] as const) {
      if (method === "GET" && path.startsWith(`${root}/`)) {
        const op = path.slice(root.length + 1), s = store.get(op);
        return Response.json(s ? { status: "committed", receipt: s } : { status: "unknown", requestId: op });
      }
    }
    if (method === "POST" && path === "/v1/teams/team-a/projections") return projectionAck(init);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    features, tasks, unbindPosts, postHooks, fetch: fetchImpl,
    publish(f: FakeFeature) {
      features.set(f.id, structuredClone(f));
      const proposal = { schemaVersion: 1, ...SCOPE, operationId: "op-new-1", title: f.title, description: "", ownerWords: null, nodes: f.nodes,
        homeInstanceId: f.homeInstanceId, expiresAt: 9_000_000_000_000, kind: "new" } as FeatureProposal;
      proposals.push({ proposal, proposalId: "proposal-new-1", proposalRev: 1, proposer: { type: "person", personId: "person-a", instanceId: null },
        operation: { schemaVersion: 1, ...SCOPE, operationId: "op-new-1", proposalDigest: proposalDigest(proposal), state: "published",
          proposalId: "proposal-new-1", featureId: f.id, version: f.version, updatedAt: 1000 } });
    },
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => { configureCenterStart(undefined); configureCenterUnbind(undefined); await cleanup?.(); cleanup = null; });

/** Replica of a feature homed here, synced once; alpha's start_node fails locally after the center bind → orphan claim. */
async function orphanSetup() {
  const c = fakeCenter(), me = instanceIdSync();
  const { f, close } = await bindLocalReplica({ baseUrl: "http://127.0.0.1:9/", instanceId: me });
  cleanup = close;
  c.publish(fakeFeature({ homeInstanceId: me, nodes: [node("alpha")] }));
  expect(await syncCenterReplicas(f.db, { localProject: f.project, fetch: c.fetch })).toMatchObject({ features: [{ result: "created" }] });
  configureCenterStart({ fetch: c.fetch, timeoutMs: 300 });
  let n = 0;
  configureCenterUnbind({ fetch: c.fetch, timeoutMs: 300, newOperationId: () => `unbind-op-${++n}` });
  const opts = { createFails: true };
  const tools = replicaDagTools(f, opts);
  const start = (extra: Record<string, unknown> = {}) => tools.start_node(f.call, { featureId: LOCAL_ID, key: "alpha", spec: SPEC, ...extra });
  expect(await start()).toMatchObject({ ok: false });
  opts.createFails = false;
  const [orphan] = readCenterClaims();
  expect(orphan).toMatchObject({ state: "orphan", key: "alpha" });
  const unbind = () => f.ledger(["center-replica", "unbind", LOCAL_ID, "alpha", "--reason", "本机开卡失败，撤销孤儿绑定"]) as Promise<Record<string, unknown>>;
  const unbindsFile = () => existsSync(centerUnbindsPath()) ? readFileSync(centerUnbindsPath(), "utf8") : null;
  return { c, orphan: orphan!, start, unbind, unbindsFile, centerTask: `center-${orphan!.taskId}` };
}

test("N7X5F-1 已开工本机拒：中心详情 tasks 含该卡 → 固定文案、0 次 POST、撤销记录不变、认领仍 orphan", async () => {
  const s = await orphanSetup();
  s.c.tasks.push(projected(s.centerTask, s.orphan.taskId));
  const before = s.unbindsFile();
  expect(await s.unbind()).toMatchObject({ ok: false, code: "conflict", error: CENTER_UNBIND_TEXT.started });
  expect(CENTER_UNBIND_TEXT.started).toContain("这张卡在中心已有进度，不能撤销绑定；需要 owner 处理");
  expect(s.c.unbindPosts).toHaveLength(0);
  expect(s.unbindsFile()).toBe(before);
  expect(readCenterClaims()).toMatchObject([{ op: s.orphan.op, state: "orphan" }]);
  expect(s.c.features.get(FEATURE_UUID)!.bindings).toEqual([{ nodeKey: "alpha", taskId: s.centerTask }]);
  // Another card's projection is not this one: the revoke goes through.
  s.c.tasks.length = 0;
  s.c.tasks.push(projected("center-some-other-card", "some-other-card"));
  expect(await s.unbind()).toMatchObject({ ok: true, released: [s.orphan.op] });
  expect(s.c.unbindPosts).toHaveLength(1);
});

test("N7X5F-2 conflict 不刷行：详情不含该卡、中心两次 409 conflict → 『刚变』文案；同节点只一行、计数 2", async () => {
  const s = await orphanSetup();
  expect(CENTER_UNBIND_TEXT.conflict).toContain("中心的绑定或版本刚变，先 sync 再看");
  for (let i = 0; i < 2; i++) {
    s.c.postHooks.push(err("conflict"));
    expect(await s.unbind()).toMatchObject({ ok: false, code: "conflict", error: CENTER_UNBIND_TEXT.conflict });
  }
  expect(s.c.unbindPosts).toHaveLength(2);
  const rows = readCenterUnbinds();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ key: "alpha", state: "conflict", count: 2, op: s.c.unbindPosts[0]!.operationId });
  expect(readCenterClaims()).toMatchObject([{ op: s.orphan.op, state: "orphan" }]);
  // A success afterwards is its own row; a conflict after it starts a new row again.
  expect(await s.unbind()).toMatchObject({ ok: true });
  expect(readCenterUnbinds().map((u) => [u.state, u.count])).toEqual([["conflict", 2], ["committed", undefined]]);
});

test("N7X5F-3 换卡号提示：孤儿拒绝文案带换卡号一句；撤销成功结果含 next；随后新 taskId start_node 成功", async () => {
  const s = await orphanSetup();
  expect(CENTER_START_TEXT.orphan.endsWith(NEW_ID)).toBe(true);
  expect(await s.start({ taskId: "n7x-alpha-2" })).toMatchObject({ ok: false, error: CENTER_START_TEXT.orphan });
  const out = await s.unbind();
  expect(out).toMatchObject({ ok: true, released: [s.orphan.op], next: CENTER_UNBIND_TEXT.next });
  expect(CENTER_UNBIND_TEXT.next).toBe("之后 start_node 需要换一个新的 taskId（原卡号已被取消的卡占用）");
  // The default id is still the cancelled orphan card's; a new one goes through.
  expect(await s.start()).toMatchObject({ ok: false, error: CENTER_START_TEXT.cardTaken });
  expect(await s.start({ taskId: "n7x-alpha-2" })).toMatchObject({ ok: true, taskId: "n7x-alpha-2" });
});
