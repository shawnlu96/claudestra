/** N7B2：客户端对齐 N7C 中心（四条路由、record 返回体、403 / 409 replayed / 409 conflict / 漂移），加 owner 待审列表路由。 */
import { describe, expect, test } from "bun:test";
import type { Principal } from "../src/lib/principals.js";
import { featureProposalError, proposalDigest } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { FEATURE_PROPOSAL_FIXTURE_DIGESTS } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import { readPendingProposals, resumeProposals, stageProposal, syncProposal } from "../src/lib/shared-ledger-feature-proposals-store.js";
import { PROPOSAL_TEXT } from "../src/bridge/local-api/shared-feature-proposals.js";
import { FeatureProposalUnsupported } from "../src/lib/shared-ledger-feature-proposals.js";
import {
  afterEach_, api, BEARER, center, directClient, dir, fx, owner, planFeature, runtime, SCOPE, serviceConn, setup, submitBody,
  useProposalHarness,
} from "./shared-feature-proposals-kit.js";

useProposalHarness();

describe("N7B2 验收线 1：fake center = N7C 真实路由 / 严格信封 / record 返回", () => {
  test("提交打到 POST /v1/feature-proposals，信封只有 {attemptNonce, payload} 且 nonce 与头一致；续完成 GET 空体无 query", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    await resumeProposals(runtime(dir, center));
    expect(center.seen.map(s => `${s.method} ${s.path}`)).toEqual(["GET /v1/feature-proposals/operations/op-demo-new", "POST /v1/feature-proposals"]);
    const [get, post] = center.seen;
    expect(get).toMatchObject({ body: "", search: "" });
    const env = JSON.parse(post!.body);
    expect(Object.keys(env).sort()).toEqual(["attemptNonce", "payload"]);
    expect(env.attemptNonce).toBe(post!.nonce);
    expect(env.payload).toEqual(fx.newProposal);
    expect(readPendingProposals(dir)[0]).toMatchObject({ state: "pending_approval", proposalId: "proposal-demo-1", issue: null });
  });
  test("中心只认四条路由：旧路径 /v1/projects/{p}/feature-proposals 是 404", async () => {
    const res = await center.fetch("http://127.0.0.1:1/v1/projects/project-demo/feature-proposals", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("N7B2 验收线 2：record 解包校验", () => {
  const bad: [string, (r: Record<string, any>) => unknown][] = [
    ["proposalRev 0", r => ({ ...r, proposalRev: 0 })],
    ["proposalRev 非整数", r => ({ ...r, proposalRev: "1" })],
    ["摘要与 proposal 不符", r => ({ ...r, proposal: { ...r.proposal, title: "被改过的标题" } })],
    ["record.proposalId ≠ operation.proposalId", r => ({ ...r, proposalId: "proposal-other" })],
    ["proposer 缺 type", r => ({ ...r, proposer: { personId: "x" } })],
  ];
  for (const [name, mangle] of bad) {
    test(`${name} → 拒（不当成功，待同步）`, async () => {
      center.mangle = mangle;
      expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: false, code: "pending_sync" });
      expect(readPendingProposals(dir)[0]).toMatchObject({ state: "unsynced", issue: "unavailable" });
    });
  }
  test("operation.schemaVersion=2 → unsupported；旧形状（顶层直接 operation，含 v1）→ unsupported", async () => {
    center.schemaVersion = 2;
    expect(await planFeature({ project: "proj-bound" })).toEqual({ ok: false, code: "unsupported", error: PROPOSAL_TEXT.unsupported });
    afterEach_(); setup();
    center.legacyShape = true;
    expect(await planFeature({ project: "proj-bound" })).toEqual({ ok: false, code: "unsupported", error: PROPOSAL_TEXT.unsupported });
    await expect(directClient(serviceConn).status(SCOPE, "op-demo-new")).rejects.toBeInstanceOf(FeatureProposalUnsupported);
  });
  test("正确 record：本机记中心 proposalId", async () => {
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "pending_approval", proposalId: "proposal-demo-1" });
  });
});

describe("N7B2 验收线 3：续完成（查 403 → 同一摘要重交）", () => {
  test("中心从没收到：查询 403 → 同一摘要重交，中心只入一次；再续只 GET", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    const [r] = await resumeProposals(runtime(dir, center));
    expect(r).toMatchObject({ state: "pending_approval", issue: null });
    expect(center.received.map(p => proposalDigest(p))).toEqual([FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal]);
    center.seen = [];
    await resumeProposals(runtime(dir, center));
    expect(center.seen.map(s => s.method)).toEqual(["GET"]);
    expect(center.received).toHaveLength(1);
  });
  test("过 TTL：查询 403 → 重交，中心按 operationId 重放 published（不看时钟）→ 本机 published", async () => {
    center.dropResponse = true;
    await planFeature({ project: "proj-bound" });
    center.dropResponse = false;
    center.setState("op-demo-new", { state: "published", featureId: "feature-demo-new", version: 1 });
    center.hideOnGet = true;
    center.now = fx.newProposal.expiresAt + 1;
    center.seen = [];
    const [r] = await resumeProposals(runtime(dir, center, { now: () => fx.newProposal.expiresAt + 1 }));
    expect(center.seen.map(s => s.method)).toEqual(["GET", "POST"]);
    expect(r).toMatchObject({ state: "published", featureId: "feature-demo-new", version: 1, issue: null });
    expect(center.received).toHaveLength(1);
  });
  test("POST 400 invalid_field 且已过 TTL → expired；未过 TTL 的 400 不是终态", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    center.rejectWith = { status: 400, body: featureProposalError("invalid_field") };
    const [early] = await resumeProposals(runtime(dir, center));
    expect(early).toMatchObject({ state: "unsynced", issue: "rejected_request" });
    center.rejectWith = null;
    center.now = fx.newProposal.expiresAt + 1;
    const [late] = await resumeProposals(runtime(dir, center, { now: () => fx.newProposal.expiresAt + 1 }));
    expect(late!.state).toBe("expired");
    expect(center.received).toEqual([]);
  });
  test("查询 403 且 POST 也 403（凭据过期）→ forbidden，不当终态", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    center.rejectWith = { status: 403, body: featureProposalError("forbidden") };
    const [r] = await resumeProposals(runtime(dir, center));
    expect(center.seen.slice(-2).map(s => s.method)).toEqual(["GET", "POST"]);
    expect(r).toMatchObject({ state: "unsynced", issue: "forbidden" });
  });
});

describe("N7B2 验收线 4：409 replayed / conflict / 漂移", () => {
  test("409 replayed 不当终态：换 nonce 重试一次即成功，中心只入一次", async () => {
    center.replayNext = 1;
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "pending_approval" });
    const posts = center.seen.filter(s => s.method === "POST");
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map(s => s.nonce)).size).toBe(2);
    expect(JSON.parse(posts[0]!.body).payload).toEqual(JSON.parse(posts[1]!.body).payload);
    expect(center.received).toHaveLength(1);
  });
  test("连续 409 replayed：只重试一次，记非终态，之后还能续", async () => {
    center.replayNext = 2;
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: false, code: "pending_sync" });
    expect(center.seen.filter(s => s.method === "POST")).toHaveLength(2);
    expect(readPendingProposals(dir)[0]).toMatchObject({ state: "unsynced", issue: "rejected_request" });
    const [r] = await resumeProposals(runtime(dir, center));
    expect(r!.state).toBe("pending_approval");
  });
  test("409 conflict（同 operationId 不同内容）→ 终态 conflict，续不再请求", async () => {
    const { operationId: _o, expiresAt: _e, ...draft } = fx.newProposal;
    const rt = runtime(dir, center);
    const rec = await stageProposal(rt, draft, "proj-bound", "service");
    // 中心上同一 operationId 已有另一份内容
    await directClient(serviceConn).submit({ ...rec.proposal, title: "另一份" }, center.now);
    center.hideOnGet = true;
    const synced = await syncProposal(rt, rec.operationId);
    expect(synced).toMatchObject({ state: "conflict", issue: null });
    center.seen = [];
    expect(await resumeProposals(rt)).toEqual([]);
    expect(center.seen).toEqual([]);
  });
  test("漂移：查询回 operation.state=conflict（中心仍 pending）→ 记 drift、不当终态、继续查、不自动重交；中心发布后转 published", async () => {
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "pending_approval" });
    center.drift.add("op-demo-new");
    center.seen = [];
    const [r] = await resumeProposals(runtime(dir, center));
    expect(r).toMatchObject({ state: "pending_approval", issue: "drift" });
    const [again] = await resumeProposals(runtime(dir, center));
    expect(again).toMatchObject({ state: "pending_approval", issue: "drift" });
    expect(center.seen.map(s => s.method)).toEqual(["GET", "GET"]);
    expect(center.received).toHaveLength(1);
    const st = await api("GET", "/api/v1/shared-feature-proposals/operations/op-demo-new");
    expect(st.status).toBe(202);
    expect(await st.json()).toMatchObject({ ok: false, code: "proposal_drift", error: PROPOSAL_TEXT.drift, cachedState: "pending_approval" });
    center.drift.clear();
    center.setState("op-demo-new", { state: "published", featureId: "feature-demo-new", version: 1 });
    const [done] = await resumeProposals(runtime(dir, center));
    expect(done).toMatchObject({ state: "published", issue: null, featureId: "feature-demo-new" });
  });
});

describe("N7B2 验收线 5：决定", () => {
  const decision = (proposalId: string) => ({ schemaVersion: 1 as const, proposalId, decision: "approve" as const,
    proposalDigest: FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal, proposalRev: 1, reason: "" });
  test("路径 /v1/feature-proposals/decisions/{proposalId}，published 返回中心 featureId", async () => {
    await planFeature({ project: "proj-bound" });
    const rec = await directClient().decide(SCOPE, "proposal-demo-1", decision("proposal-demo-1"));
    expect(center.seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/feature-proposals/decisions/proposal-demo-1", bearer: BEARER.person });
    expect(rec.operation).toMatchObject({ state: "published", featureId: "feature-demo-new", version: 1 });
  });
  test("body 的 proposalId 与路径不一致 → 不发请求", async () => {
    await planFeature({ project: "proj-bound" });
    center.seen = [];
    await expect(directClient().decide(SCOPE, "proposal-demo-1", decision("proposal-demo-9"))).rejects.toThrow("decision proposalId mismatch");
    expect(center.seen).toEqual([]);
  });
  test("service 凭据决定 → 中心 403，客户端照报 403", async () => {
    await planFeature({ project: "proj-bound" });
    await expect(directClient(serviceConn).decide(SCOPE, "proposal-demo-1", decision("proposal-demo-1")))
      .rejects.toMatchObject({ status: 403 });
  });
});

describe("N7B2 验收线 6：owner 待审列表路由 GET /api/v1/shared-feature-proposals/projects/{localProjectId}", () => {
  const LIST = "/api/v1/shared-feature-proposals/projects/proj-bound";
  test("owner：person 凭据读中心列表，带 proposalRev / 摘要 / drift；不含 bearer、他人 personId、policy.setBy", async () => {
    await planFeature({ project: "proj-bound" }); // service 提的
    await api("POST", "/api/v1/shared-feature-proposals", { ...submitBody, description: "网页提的" }); // owner 本人提的
    center.drift.add("op-demo-new");
    center.seen = [];
    const res = await api("GET", LIST);
    expect(res.status).toBe(200);
    expect(center.seen).toMatchObject([{ method: "GET", path: "/v1/feature-proposals/projects/project-demo", bearer: BEARER.person, body: "", search: "" }]);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.policy).toEqual({ approvers: "project_owner", rev: 0, updatedAt: 0 });
    expect(body.proposals).toHaveLength(2);
    const [svc, mine] = body.proposals;
    expect(Object.keys(svc).sort()).toEqual(["description", "drift", "expiresAt", "nodes", "proposalDigest", "proposalId", "proposalRev",
      "proposer", "state", "title", "version"]);
    expect(svc).toMatchObject({ proposalId: "proposal-demo-1", proposalRev: 1, proposalDigest: FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal,
      state: "conflict", drift: true, title: fx.newProposal.title, nodes: fx.newProposal.nodes, version: null, expiresAt: fx.newProposal.expiresAt,
      proposer: { type: "service" } });
    expect(mine).toMatchObject({ proposalId: "proposal-demo-2", drift: false, state: "pending_approval", description: "网页提的", proposer: { type: "person", code: "self" } });
    for (const secret of [...Object.values(BEARER), "service-demo", "person-demo-owner", "instance-demo-a"]) expect(text).not.toContain(secret);
  });
  test("非 owner 403；带 query 400；未绑定项目 404；个人项目 409；都不打中心", async () => {
    const guest = { ...owner, id: "device:guest", role: "external" } as Principal;
    expect((await api("GET", LIST, undefined, {}, guest)).status).toBe(403);
    expect((await api("GET", `${LIST}?state=pending`)).status).toBe(400);
    expect((await api("GET", "/api/v1/shared-feature-proposals/projects/proj-local")).status).toBe(404);
    expect((await api("GET", "/api/v1/shared-feature-proposals/projects/proj-personal")).status).toBe(409);
    expect((await api("POST", LIST, {})).status).toBe(405);
    expect(center.seen).toEqual([]);
  });
  test("中心拒绝 / 旧版本 / 不可达：只回固定 code，不回中心原文", async () => {
    center.rejectWith = { status: 403, body: { error: "raw center text person-demo-owner" } };
    const rej = await api("GET", LIST);
    expect(rej.status).toBe(403);
    expect(await rej.text()).not.toContain("raw center text");
    center.rejectWith = null;
    center.schemaVersion = 2;
    await planFeature({ project: "proj-bound" });
    expect((await api("GET", LIST)).status).toBe(502);
    center.down = true;
    expect((await api("GET", LIST)).status).toBe(503);
  });
  test("没有 person 凭据 → 403，不打中心", async () => {
    afterEach_();
    setup({ credentials: false });
    expect((await api("GET", LIST)).status).toBe(403);
    expect(center.seen).toEqual([]);
  });
});
