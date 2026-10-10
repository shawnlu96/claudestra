/** N7B 本机提案通路（plan_feature 改道、本地 API、待同步续完成）。夹具（临时 state 目录、N7C fake center）在 shared-feature-proposals-kit.ts。 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import { featureProposalError, proposalDigest } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { FEATURE_PROPOSAL_FIXTURE_DIGESTS } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import { readPendingProposals, resumeProposals, stageProposal, syncProposal } from "../src/lib/shared-ledger-feature-proposals-store.js";
import { configureFeatureProposals, PROPOSAL_TEXT, stopFeatureProposalResume } from "../src/bridge/local-api/shared-feature-proposals.js";
import type { FakeCenter } from "./shared-feature-proposals-kit.js";
import {
  afterEach_, api, BEARER, center, dir, fx, journalPath, ledgerWrites, managerCalls, owner, planFeature, resetLedgerClock, runtime,
  SCOPE, setup, submitBody, useProposalHarness, ZERO,
} from "./shared-feature-proposals-kit.js";

useProposalHarness();

describe("验收线 1：已绑定团队项目上 plan_feature 只交中心提案", () => {
  test("bound plan_feature → 中心收到一次提案，摘要等于 N7K fixture；本机 feature / dag / 卡零写、没调 manager", async () => {
    const r = await planFeature({ project: "proj-bound" });
    expect(r).toMatchObject({ ok: true, state: "pending_approval", operationId: "op-demo-new", message: PROPOSAL_TEXT.pending_approval });
    expect(center.received).toEqual([fx.newProposal]);
    expect(proposalDigest(center.received[0])).toBe(FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal);
    expect(center.seen.map(s => `${s.method} ${s.path}`)).toEqual(["POST /v1/feature-proposals"]);
    expect(managerCalls).toEqual([]);
    expect(ledgerWrites()).toEqual(ZERO);
  });
  test("调用方给的 projectId / centerId / teamId 被忽略：project 只由绑定决定", async () => {
    await planFeature({ project: "proj-bound", projectId: "project-evil", centerId: "center-evil", teamId: "team-evil" });
    expect(center.received.map(p => [p.centerId, p.teamId, p.projectId])).toEqual([[SCOPE.centerId, SCOPE.teamId, SCOPE.projectId]]);
  });
});

describe("验收线 2：未绑定 / 个人项目原路径不变", () => {
  for (const project of ["proj-local", "proj-personal"]) {
    test(`${project}：plan_feature 走本机台账，结果与 manager 调用和没有任何绑定时逐字相同`, async () => {
      const withBindings = await planFeature({ project });
      const calls = managerCalls.map(c => c.slice());
      expect(withBindings).toMatchObject({ ok: true, feature: "ab12-demo" });
      expect(center.seen).toEqual([]);
      expect(existsSync(journalPath())).toBe(false);
      afterEach_();
      setup({ credentials: false });
      rmSync(join(dir, "shared-ledger-bindings.json"));
      resetLedgerClock();
      const plain = await planFeature({ project });
      expect(plain).toEqual(withBindings);
      expect(managerCalls).toEqual(calls);
      expect(calls.map(c => c[1])).toEqual(["feature-new", "dag-init"]);
    });
  }
});

describe("验收线 3：中心不可达 → 待同步；恢复后先查后交", () => {
  test("不可达：返回待同步（不是成功），只写一份 0600 记录，本机台账零写", async () => {
    center.down = true;
    const r = await planFeature({ project: "proj-bound" });
    expect(r).toMatchObject({ ok: false, code: "pending_sync" });
    expect(r.error).toContain("待同步，结果未确认");
    expect(statSync(journalPath()).mode & 0o777).toBe(0o600);
    const [rec] = readPendingProposals(dir);
    expect(rec).toMatchObject({ operationId: "op-demo-new", state: "unsynced", proposalDigest: FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal, expiresAt: fx.newProposal.expiresAt });
    expect(readPendingProposals(dir)).toHaveLength(1);
    expect(ledgerWrites()).toEqual(ZERO);
    expect(managerCalls).toEqual([]);
  });
  test("回包丢失后恢复：先 GET operationId，中心已有就不重交；没有才重交同一摘要，只入一次", async () => {
    center.dropResponse = true; // 中心已入库，回包丢了
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ code: "pending_sync" });
    center.dropResponse = false;
    center.seen = [];
    const [resumed] = await resumeProposals(runtime(dir, center));
    expect(center.seen.map(s => s.method)).toEqual(["GET"]);
    expect(resumed).toMatchObject({ state: "pending_approval" });
    expect(center.received).toHaveLength(1);
  });
  test("中心从没收到：恢复时先查（N7C 回 403）再交同一摘要；再次续不再交", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    await resumeProposals(runtime(dir, center));
    expect(center.seen.map(s => s.method)).toEqual(["GET", "POST"]);
    expect(center.received.map(p => proposalDigest(p))).toEqual([FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal]);
    // 同内容重调 plan_feature：复用同一 operationId，中心仍只一份
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, operationId: "op-demo-new" });
    expect(center.received).toHaveLength(1);
  });
  test("内容改了换新 operationId", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    await planFeature({ project: "proj-bound", description: "改过的描述" });
    const ids = readPendingProposals(dir).map(r => r.operationId).sort();
    expect(ids).toHaveLength(2);
    expect(new Set(readPendingProposals(dir).map(r => r.proposalDigest)).size).toBe(2);
  });
  test("并发两次提交同一内容 / 同一 operationId：只一份记录、中心只入一次", async () => {
    const [a, b] = await Promise.all([planFeature({ project: "proj-bound" }), planFeature({ project: "proj-bound" })]);
    expect(a.operationId).toBe(b.operationId);
    expect(readPendingProposals(dir)).toHaveLength(1);
    expect(center.received).toHaveLength(1);
    const rt = runtime(dir, center);
    await Promise.all([syncProposal(rt, a.operationId), syncProposal(rt, a.operationId)]);
    expect(readPendingProposals(dir)).toHaveLength(1);
    expect(center.received).toHaveLength(1);
  });
  test("过期前没同步上：查 403 → 同一摘要重交，中心 400 invalid_field 且已过 TTL → 标 expired，中心零入库", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    center.now = fx.newProposal.expiresAt;
    const [r] = await resumeProposals(runtime(dir, center, { now: () => fx.newProposal.expiresAt }));
    expect(r!.state).toBe("expired");
    expect(center.seen.map(s => s.method)).toEqual(["GET", "POST"]);
    expect(center.received).toEqual([]);
  });
});

describe("验收线 4：拒绝 / 过期 / 409 → 固定文本，不建本机 feature / 卡、不派单", () => {
  const cases: [string, (c: FakeCenter) => void, string][] = [
    ["rejected", c => { c.outcome = { state: "rejected" }; }, PROPOSAL_TEXT.rejected],
    ["expired", c => { c.outcome = { state: "expired" }; }, PROPOSAL_TEXT.expired],
    ["conflict", c => { c.rejectWith = { status: 409, body: featureProposalError("conflict") }; }, PROPOSAL_TEXT.conflict],
  ];
  for (const [state, arrange, text] of cases) {
    test(`${state}`, async () => {
      arrange(center);
      const r = await planFeature({ project: "proj-bound" });
      expect(r).toEqual({ ok: false, code: `proposal_${state}`, error: text });
      expect(ledgerWrites()).toEqual(ZERO);
      expect(managerCalls).toEqual([]);
      expect(readPendingProposals(dir)[0]!.state).toBe(state as never);
    });
  }
  test("published → 返回中心 featureId，本机仍零写", async () => {
    center.outcome = { state: "published", featureId: "feature-demo-new", version: 1 };
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "published", centerFeatureId: "feature-demo-new", version: 1 });
    expect(ledgerWrites()).toEqual(ZERO);
  });
});


describe("验收线 5：凭据与 project 选择", () => {
  test("MCP（plan_feature）走 owner:self 的 service 凭据；网页（本地 API）走 person 凭据", async () => {
    await planFeature({ project: "proj-bound" });
    expect(center.seen.map(s => s.bearer)).toEqual([BEARER.service]);
    center.seen = [];
    const res = await api("POST", "/api/v1/shared-feature-proposals", { ...submitBody, description: "网页提的" });
    expect(res.status).toBe(200);
    expect(center.seen.map(s => s.bearer)).toEqual([BEARER.person]);
  });
  test("本地 API 不收调用方指定的 projectId / centerId / teamId（400，中心零请求）", async () => {
    for (const extra of [{ projectId: "project-evil" }, { centerId: "center-evil" }, { teamId: "team-evil" }]) {
      const res = await api("POST", "/api/v1/shared-feature-proposals", { ...submitBody, ...extra });
      expect(res.status).toBe(400);
    }
    expect((await api("POST", "/api/v1/shared-feature-proposals", submitBody, { "x-shared-ledger-project": "project-evil" })).status).toBe(404);
    expect(center.seen).toEqual([]);
  });
  test("非 owner 主体 403；个人项目 409", async () => {
    const guest = { ...owner, id: "device:guest", role: "external" } as Principal;
    expect((await api("GET", "/api/v1/shared-feature-proposals", undefined, {}, guest)).status).toBe(403);
    expect((await api("POST", "/api/v1/shared-feature-proposals", { ...submitBody, localProjectId: "proj-personal" })).status).toBe(409);
  });
  test("bearer 不进返回值、不进日志、不进待同步记录（含中心不可达时的异常文本）", async () => {
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    try {
      center.down = true;
      const outputs = [JSON.stringify(await planFeature({ project: "proj-bound" }))];
      for (const res of [await api("POST", "/api/v1/shared-feature-proposals", submitBody), await api("GET", "/api/v1/shared-feature-proposals")]) {
        outputs.push(await res.text());
      }
      center.down = false;
      outputs.push(await (await api("GET", "/api/v1/shared-feature-proposals/operations/op-demo-new")).text());
      const all = [...outputs, ...logs, readFileSync(journalPath(), "utf8")].join("\n");
      for (const secret of Object.values(BEARER)) expect(all).not.toContain(secret);
    } finally { Object.assign(console, orig); }
  });
  test("本机没有凭据：不提交、明确报缺凭据，不当成功", async () => {
    afterEach_();
    setup({ credentials: false });
    expect(await planFeature({ project: "proj-bound" })).toEqual({ ok: false, code: "forbidden", error: PROPOSAL_TEXT.no_credential });
    expect(center.seen).toEqual([]);
  });
});

describe("验收线 6：旧中心 / 未知 schemaVersion 明确报不支持", () => {
  for (const v of [2, 0, undefined, "1"]) {
    test(`schemaVersion=${JSON.stringify(v) ?? "缺省"}`, async () => {
      center.schemaVersion = v;
      expect(await planFeature({ project: "proj-bound" })).toEqual({ ok: false, code: "unsupported", error: PROPOSAL_TEXT.unsupported });
      expect(readPendingProposals(dir)[0]).toMatchObject({ state: "unsynced", issue: "unsupported" });
    });
  }
  test("中心没有提案接口（404）也报不支持；错误体 schemaVersion 不认也报不支持", async () => {
    center.rejectWith = { status: 404, body: { error: "not found" } };
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ code: "unsupported" });
    afterEach_(); setup();
    center.rejectWith = { status: 409, body: { ...featureProposalError("conflict"), schemaVersion: 2 } };
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ code: "unsupported" });
  });
  test("v1 但类型不对（published 缺 featureId）不被忽略：不报成功", async () => {
    center.outcome = { state: "published", featureId: null, version: null };
    const r = await planFeature({ project: "proj-bound" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("pending_sync");
  });
});

describe("本地 API（N7W）", () => {
  test("提交 → 列表 → 按 operationId 查 → owner 审批转发（person 凭据，不自动重放）", async () => {
    const sub = await api("POST", "/api/v1/shared-feature-proposals", submitBody);
    const body = await sub.json() as Record<string, any>;
    expect(body).toMatchObject({ ok: true, state: "pending_approval", operation: { operationId: "op-demo-new", projectId: "project-demo", localProjectId: "proj-bound" } });
    const list = await (await api("GET", "/api/v1/shared-feature-proposals")).json() as { operations: unknown[] };
    expect(list.operations).toHaveLength(1);
    const decide = await api("POST", "/api/v1/shared-feature-proposals/decisions", { localProjectId: "proj-bound", proposalId: body.proposalId,
      decision: "approve", proposalDigest: FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal, proposalRev: 1, reason: "" });
    expect(await decide.json()).toMatchObject({ ok: true, state: "published", featureId: "feature-demo-new" });
    expect(center.seen.at(-1)).toMatchObject({ method: "POST", path: `/v1/feature-proposals/decisions/${body.proposalId}`, bearer: BEARER.person });
    const status = await (await api("GET", "/api/v1/shared-feature-proposals/operations/op-demo-new")).json();
    expect(status).toMatchObject({ ok: true, state: "published", centerFeatureId: "feature-demo-new" });
    expect(center.seen.filter(s => s.path.startsWith("/v1/feature-proposals/decisions/"))).toHaveLength(1);
    expect((await api("GET", "/api/v1/shared-feature-proposals/operations/op-unknown")).status).toBe(404);
  });
  test("stageProposal 落盘 0600，一份记录", async () => {
    const rt = runtime(dir, center);
    const { operationId: _o, expiresAt: _e, ...draft } = fx.newProposal;
    await Promise.all([stageProposal(rt, draft, "proj-bound", "person"), stageProposal(rt, draft, "proj-bound", "person")]);
    expect(readPendingProposals(dir)).toHaveLength(1);
    expect(statSync(journalPath()).mode & 0o777).toBe(0o600);
  });
});

describe("第 1 轮审查回归", () => {
  test("expiry-query：中心已发布但回包丢失，跨过 TTL 恢复 → 先 GET 拿到 published，不判过期", async () => {
    center.outcome = { state: "published", featureId: "feature-demo-new", version: 1 };
    center.dropResponse = true;
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ code: "pending_sync" });
    center.dropResponse = false;
    center.seen = [];
    const [r] = await resumeProposals(runtime(dir, center, { now: () => fx.newProposal.expiresAt + 1 }));
    expect(center.seen.map(s => s.method)).toEqual(["GET"]);
    expect(r).toMatchObject({ state: "published", featureId: "feature-demo-new", version: 1 });
  });
  test("expiry-query：跨过 TTL 且中心仍不可达 → 保持结果未确认，不自判 expired；可达后中心没有才按 TTL 判过期", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    const late = runtime(dir, center, { now: () => fx.newProposal.expiresAt + 1 });
    const [r] = await resumeProposals(late);
    expect(r).toMatchObject({ state: "unsynced", issue: "unavailable" });
    center.down = false;
    center.now = fx.newProposal.expiresAt + 1;
    const [r2] = await resumeProposals(late);
    expect(r2!.state).toBe("expired");
    expect(center.seen.map(s => s.method)).toEqual(["GET", "POST"]);
    expect(center.received).toEqual([]);
  });
  test("expiry-query：只落盘、从未发出的记录恢复时也先 GET 再 POST", async () => {
    const rt = runtime(dir, center);
    const { operationId: _o, expiresAt: _e, ...draft } = fx.newProposal;
    await stageProposal(rt, draft, "proj-bound", "service");
    const [r] = await resumeProposals(rt);
    expect(center.seen.map(s => s.method)).toEqual(["GET", "POST"]);
    expect(r!.state).toBe("pending_approval");
  });
  test("schema-state：已有 pending_approval，本次同步遇未知 schemaVersion → plan_feature 与状态 API 都报不支持", async () => {
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "pending_approval" });
    center.schemaVersion = 2;
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: false, code: "unsupported", error: PROPOSAL_TEXT.unsupported, cachedState: "pending_approval" });
    const res = await api("GET", "/api/v1/shared-feature-proposals/operations/op-demo-new");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, code: "unsupported", cachedState: "pending_approval" });
  });
  test("schema-state：已有 pending_approval，本次中心不可达 → 待同步而非成功", async () => {
    await planFeature({ project: "proj-bound" });
    center.down = true;
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: false, code: "pending_sync", cachedState: "pending_approval" });
  });
  test("resume-start：bridge 启动（initApiRoutes）即按 operationId 续待同步记录，无需新请求", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    center.seen = [];
    const { initApiRoutes } = await import("../src/bridge/api-routes.ts");
    try {
      initApiRoutes({} as never);
      for (let i = 0; i < 200 && readPendingProposals(dir)[0]!.state === "unsynced"; i++) await Bun.sleep(10);
      expect(center.seen.map(s => s.method)).toEqual(["GET", "POST"]);
      expect(readPendingProposals(dir)[0]!.state).toBe("pending_approval");
    } finally { stopFeatureProposalResume(); }
  });
});

describe("第 2 轮审查回归", () => {
  test("expiry-query：中心已发布但回包丢失，跨过 TTL 原样重调 plan_feature → 先 GET 旧操作拿到 published，不换 operationId", async () => {
    center.outcome = { state: "published", featureId: "feature-demo-new", version: 1 };
    center.dropResponse = true;
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ code: "pending_sync" });
    center.dropResponse = false;
    center.seen = [];
    configureFeatureProposals(runtime(dir, center, { now: () => fx.newProposal.expiresAt + 1 }));
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "published", operationId: "op-demo-new", centerFeatureId: "feature-demo-new" });
    expect(center.seen.map(s => s.method)).toEqual(["GET"]);
    expect(center.received).toHaveLength(1);
    expect(readPendingProposals(dir)).toHaveLength(1);
  });
  test("credential-expiry：GET 回 401 expired（凭据 / 签名过期）→ 可恢复问题，不记提案终态；续凭据后查回 published", async () => {
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "pending_approval" });
    center.rejectWith = { status: 401, body: featureProposalError("expired") };
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: false, code: "forbidden", cachedState: "pending_approval" });
    expect(readPendingProposals(dir)[0]).toMatchObject({ state: "pending_approval", issue: "forbidden" });
    center.rejectWith = null;
    center.setState("op-demo-new", { state: "published", featureId: "feature-demo-new", version: 1 });
    center.seen = [];
    const [r] = await resumeProposals(runtime(dir, center));
    expect(center.seen.map(s => s.method)).toEqual(["GET"]);
    expect(r).toMatchObject({ state: "published", featureId: "feature-demo-new", issue: null });
    expect(await planFeature({ project: "proj-bound" })).toMatchObject({ ok: true, state: "published", centerFeatureId: "feature-demo-new" });
  });
});

