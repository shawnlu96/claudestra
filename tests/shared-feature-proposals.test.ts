/** N7B 本机提案通路（plan_feature 改道、本地 API、待同步续完成）。
 * 公用部分：临时 state 目录（绑定 / 凭据 / projects 都 0600）、进程内 fake center（按 N7K 契约收发）。不连真实 bridge / 中心。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceKey } from "../src/lib/instance-key.js";
import {
  classifyProposalOperation, featureProposalError, parseFeatureProposal, parseProposalDecision, proposalDigest,
  type FeatureProposal, type ProposalOperation,
} from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { FEATURE_PROPOSAL_FIXTURE_NOW } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import { createFeatureProposalFixtures, FEATURE_PROPOSAL_FIXTURE_DIGESTS } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import { readPendingProposals, resumeProposals, stageProposal, syncProposal, type ProposalRuntime } from "../src/lib/shared-ledger-feature-proposals-store.js";
import { configureFeatureProposals, handleSharedFeatureProposalsApi, PROPOSAL_TEXT, stopFeatureProposalResume } from "../src/bridge/local-api/shared-feature-proposals.js";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import type { Principal } from "../src/lib/principals.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const BEARER = { service: "svc-bearer-SECRET-7f3a", person: "person-bearer-SECRET-91bc" };
const SCOPE = { centerId: "center-demo", teamId: "team-demo", projectId: "project-demo" };
const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const write0600 = (path: string, data: unknown) => { writeFileSync(path, JSON.stringify(data)); chmodSync(path, 0o600); };

/** proj-bound ↔ project-demo（团队项目）；proj-personal 也绑了但是个人项目；proj-local 没绑 */
function stateDir(opts: { credentials?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "n7b-"));
  write0600(join(dir, "shared-ledger-bindings.json"), [
    { ...SCOPE, localProjectId: "proj-bound" },
    { ...SCOPE, projectId: "project-personal", localProjectId: "proj-personal" },
  ]);
  write0600(join(dir, "projects.json"), { projects: [
    { id: "proj-bound", name: "bound", dirs: [], createdAt: "" },
    { id: "proj-personal", name: "personal", dirs: [], createdAt: "", personal: true },
    { id: "proj-local", name: "local", dirs: [], createdAt: "" },
  ] });
  const cred = (kind: "service" | "person") => ({ localSubject: "owner:self", kind, centerId: SCOPE.centerId, baseUrl: "http://127.0.0.1:1/",
    teamId: SCOPE.teamId, personId: kind === "service" ? "service-demo" : "person-demo-owner", instanceId: "instance-demo-a", bearer: BEARER[kind],
    projects: [{ projectId: SCOPE.projectId, actions: ["read", "plan"] }] });
  if (opts.credentials !== false) write0600(join(dir, "shared-ledger-credentials.json"), { credentials: [cred("service"), cred("person")] });
  return dir;
}

function runtime(dir: string, center: FakeCenter, more: Partial<ProposalRuntime> = {}): ProposalRuntime {
  let n = 0;
  const key = newKey();
  return { stateDir: dir, now: () => FEATURE_PROPOSAL_FIXTURE_NOW, newOperationId: () => (n++ ? `op-demo-${n}` : "op-demo-new"),
    ttlMs: 3_600_000, fetch: center.fetch as typeof fetch, key: () => key, instanceId: () => "instance-demo-a", ...more };
}

interface Seen { method: string; path: string; bearer: string }
/** 中心按 operationId 幂等：同摘要回放、不同摘要 409；可注入不可达 / 回包丢失 / 旧版本 / 指定终态 */
class FakeCenter {
  ops = new Map<string, ProposalOperation>();
  received: FeatureProposal[] = [];
  seen: Seen[] = [];
  down = false;
  /** 已入库但回包丢了（连接断） */
  dropResponse = false;
  /** 回给客户端的 schemaVersion（旧中心 / 新中心） */
  schemaVersion: unknown = 1;
  /** 新提案落库后的状态 */
  outcome: Partial<ProposalOperation> = {};
  rejectWith: { status: number; body: unknown } | null = null;
  private n = 0;

  fetch = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const bearer = String((init.headers as Record<string, string>)?.authorization ?? "").replace(/^Bearer /, "");
    if (this.down) throw new TypeError(`connect ECONNREFUSED ${bearer}`);
    this.seen.push({ method, path: url.pathname, bearer });
    if (this.rejectWith) return Response.json(this.rejectWith.body, { status: this.rejectWith.status });
    const m = /^\/v1\/projects\/([^/]+)\/feature-proposals(?:\/operations\/([^/]+)|\/([^/]+)\/decision)?$/.exec(url.pathname);
    if (!m) return Response.json({ error: "not found" }, { status: 404 });
    const reply = (op: ProposalOperation) => {
      if (this.dropResponse) throw new TypeError("socket hang up");
      return Response.json({ ...op, schemaVersion: this.schemaVersion });
    };
    if (method === "GET" && m[2]) {
      const op = this.ops.get(m[2]);
      return op ? reply(op) : Response.json({ error: "not found" }, { status: 404 });
    }
    const { payload } = JSON.parse(String(init.body)) as { payload: unknown };
    if (m[3]) {
      const d = parseProposalDecision(payload);
      const op = [...this.ops.values()].find(o => o.proposalId === d.proposalId)!;
      const next: ProposalOperation = d.decision === "approve"
        ? { ...op, state: "published", featureId: "feature-demo-new", version: 1 } : { ...op, state: "rejected" };
      this.ops.set(op.operationId, next);
      return reply(next);
    }
    const p = parseFeatureProposal(payload, FEATURE_PROPOSAL_FIXTURE_NOW), digest = proposalDigest(p);
    const cls = classifyProposalOperation(this.ops.get(p.operationId) ?? null, digest);
    if (cls === "conflict") return Response.json(featureProposalError("conflict"), { status: 409 });
    if (cls === "new") {
      this.received.push(p);
      this.ops.set(p.operationId, { centerId: p.centerId, teamId: p.teamId, projectId: p.projectId, schemaVersion: 1, operationId: p.operationId,
        proposalDigest: digest, state: "pending_approval", proposalId: `proposal-demo-${++this.n}`, featureId: null, version: null,
        updatedAt: FEATURE_PROPOSAL_FIXTURE_NOW, ...this.outcome });
    }
    return reply(this.ops.get(p.operationId)!);
  };
}

// ---- 台账 + plan_feature（同 tests/dag-tools-bridge.test.ts 的管道：manager 用进程内 runLedger，按频道认 actor） ----
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };
const PROJECTS = ["proj-bound", "proj-personal", "proj-local"];
const fx = createFeatureProposalFixtures();
let dir: string, db: Database, center: FakeCenter, managerCalls: string[][], now: number;
const agents = { [PM.agent]: { channelId: "ch-pm", projectId: "proj-bound" } };
const deps = (): DagToolDeps => ({
  db: () => db,
  manager: async (args, channelId) => {
    managerCalls.push(args);
    const who = resolveActor({ channelId, controlChannelId: "ch-ctl" }, agents);
    if (!who.ok) return { ok: false, code: "forbidden", error: who.error };
    return runLedger(args.slice(1), { db, actor: who.actor, projectIds: PROJECTS, loadRegistry: async () => ({ socket: "", agents }) as never,
      saveRegistry: async () => {}, now: () => now++, autoDispatch: () => false, autoProjects: () => [] });
  },
  callerProject: () => "proj-bound",
  startEnv: () => { throw new Error("unused"); }, stepIO: () => { throw new Error("unused"); },
});
const planFeature = (args: Record<string, unknown>) =>
  dagToolHandlers(deps()).plan_feature!(PM, { slug: "demo", title: fx.newProposal.title, description: fx.newProposal.description,
    nodes: fx.newProposal.nodes, ...args }) as Promise<Record<string, any>>;
const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const ledgerWrites = () => ({ features: count("features"), dags: count("dag_versions"), bindings: count("dag_bindings"), tasks: count("tasks") });
const ZERO = { features: 0, dags: 0, bindings: 0, tasks: 0 };
const journalPath = () => join(dir, "shared-feature-proposals.json");

function setup(opts: { credentials?: boolean } = {}, more: Partial<ProposalRuntime> = {}) {
  dir = stateDir(opts);
  center = new FakeCenter();
  configureFeatureProposals(runtime(dir, center, more));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  for (const project of PROJECTS) setMeta(db, { actor: "owner", now: 500 }, { project, key: "pms", value: [PM.agent] });
}
beforeEach(() => { now = 1_000; managerCalls = []; setup(); });
afterEach(() => { configureFeatureProposals(undefined); closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); });

describe("验收线 1：已绑定团队项目上 plan_feature 只交中心提案", () => {
  test("bound plan_feature → 中心收到一次提案，摘要等于 N7K fixture；本机 feature / dag / 卡零写、没调 manager", async () => {
    const r = await planFeature({ project: "proj-bound" });
    expect(r).toMatchObject({ ok: true, state: "pending_approval", operationId: "op-demo-new", message: PROPOSAL_TEXT.pending_approval });
    expect(center.received).toEqual([fx.newProposal]);
    expect(proposalDigest(center.received[0])).toBe(FEATURE_PROPOSAL_FIXTURE_DIGESTS.newProposal);
    expect(center.seen.map(s => `${s.method} ${s.path}`)).toEqual(["POST /v1/projects/project-demo/feature-proposals"]);
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
      now = 1_000; managerCalls = [];
      const plain = await planFeature({ project });
      expect(plain).toEqual(withBindings);
      expect(managerCalls).toEqual(calls);
      expect(calls.map(c => c[1])).toEqual(["feature-new", "dag-init"]);
    });
  }
});
function afterEach_() { configureFeatureProposals(undefined); closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); }

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
  test("中心从没收到：恢复时先查（404）再交同一摘要；再次续不再交", async () => {
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
  test("过期前没同步上：不再重交，标 expired", async () => {
    center.down = true;
    await planFeature({ project: "proj-bound" });
    center.down = false;
    const [r] = await resumeProposals(runtime(dir, center, { now: () => fx.newProposal.expiresAt }));
    expect(r!.state).toBe("expired");
    expect(center.seen.filter(s => s.method === "POST")).toEqual([]);
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

const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-10-02T00:00:00Z" } as Principal;
const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, who: Principal = owner) =>
  handleSharedFeatureProposalsApi(new Request(`http://127.0.0.1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    new URL(`http://127.0.0.1${path}`), { auth: async () => who }) as Promise<Response>;
const submitBody = { localProjectId: "proj-bound", title: fx.newProposal.title, description: fx.newProposal.description, nodes: fx.newProposal.nodes };

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
    expect(center.seen.at(-1)).toMatchObject({ method: "POST", path: `/v1/projects/project-demo/feature-proposals/${body.proposalId}/decision`, bearer: BEARER.person });
    const status = await (await api("GET", "/api/v1/shared-feature-proposals/operations/op-demo-new")).json();
    expect(status).toMatchObject({ ok: true, state: "published", centerFeatureId: "feature-demo-new" });
    expect(center.seen.filter(s => s.path.endsWith("/decision"))).toHaveLength(1);
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
    const [r2] = await resumeProposals(late);
    expect(r2!.state).toBe("expired");
    expect(center.seen.map(s => s.method)).toEqual(["GET"]);
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
