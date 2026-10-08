/** N7B / N7B2 本机提案测试夹具：临时 state 目录（绑定 / 凭据 / projects 都 0600）、进程内 N7C fake center、台账 + plan_feature 管道、
 * 本地 API 调用。不连真实 bridge / 中心。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceKey } from "../src/lib/instance-key.js";
import {
  classifyProposalOperation, defaultProposalPolicy, featureProposalError, parseFeatureProposal, parseProposalDecision, proposalDigest,
  type FeatureProposal, type ProposalOperation,
} from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { createFeatureProposalFixtures, FEATURE_PROPOSAL_FIXTURE_NOW } from "../src/lib/shared-ledger-contract-v2-feature-proposals-fixtures.js";
import type { ProposalRuntime } from "../src/lib/shared-ledger-feature-proposals-store.js";
import { configureFeatureProposals, handleSharedFeatureProposalsApi } from "../src/bridge/local-api/shared-feature-proposals.js";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import type { Principal } from "../src/lib/principals.js";
import { SHARED_LEDGER_AUTH_HEADERS } from "../src/lib/shared-ledger-auth.js";
import { SharedLedgerFeatureProposalClient } from "../src/lib/shared-ledger-feature-proposals.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

export const BEARER = { service: "svc-bearer-SECRET-7f3a", person: "person-bearer-SECRET-91bc" };
export const SCOPE = { centerId: "center-demo", teamId: "team-demo", projectId: "project-demo" };
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

export function runtime(dir: string, center: FakeCenter, more: Partial<ProposalRuntime> = {}): ProposalRuntime {
  let n = 0;
  const key = newKey();
  return { stateDir: dir, now: () => FEATURE_PROPOSAL_FIXTURE_NOW, newOperationId: () => (n++ ? `op-demo-${n}` : "op-demo-new"),
    ttlMs: 3_600_000, fetch: center.fetch as typeof fetch, key: () => key, instanceId: () => "instance-demo-a", ...more };
}

interface Seen { method: string; path: string; bearer: string; search: string; body: string; nonce: string }
type CenterRecord = { proposal: FeatureProposal; proposalId: string; proposalRev: number;
  proposer: { personId: string; instanceId: string; type: "person" | "service" }; operation: ProposalOperation };
const forbidden = () => Response.json(featureProposalError("forbidden"), { status: 403 });
/** N7C 中心的进程内替身：只有四条路由（其余 404），严格信封 {attemptNonce, payload}、GET 空体无 query，回 record；
 * 查无记录或不是本人的 → 403；按 operationId 幂等：同摘要回放（不看时钟）、不同摘要 409 conflict；新提案已过期 → 400 invalid_field；
 * 同 nonce 重放 → 409 replayed。可注入不可达 / 回包丢失 / 旧版本 / 旧形状 / 指定终态 / 漂移 */
export class FakeCenter {
  records = new Map<string, CenterRecord>();
  get ops() { return new Map([...this.records].map(([k, r]) => [k, r.operation])); }
  received: FeatureProposal[] = [];
  seen: Seen[] = [];
  down = false;
  /** 已入库但回包丢了（连接断） */
  dropResponse = false;
  /** 回给客户端的 operation.schemaVersion（旧中心 / 新中心） */
  schemaVersion: unknown = 1;
  /** 旧形状：顶层直接是 operation */
  legacyShape = false;
  /** 回包前改 record（测客户端解包校验） */
  mangle: ((r: Record<string, any>) => unknown) | null = null;
  /** 新提案落库后的状态 */
  outcome: Partial<ProposalOperation> = {};
  rejectWith: { status: number; body: unknown } | null = null;
  /** 接下来 n 次 POST 回 409 replayed */
  replayNext = 0;
  /** GET operations 一律 403（中心有这行但查不到，如换了凭据） */
  hideOnGet = false;
  /** 这些 operationId 的待审行漂移：接口回 state=conflict，库里仍 pending_approval */
  drift = new Set<string>();
  now = FEATURE_PROPOSAL_FIXTURE_NOW;
  private nonces = new Set<string>();
  private n = 0;

  setState(operationId: string, change: Partial<ProposalOperation>) {
    const r = this.records.get(operationId)!;
    this.records.set(operationId, { ...r, operation: { ...r.operation, ...change } });
  }

  fetch = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const bearer = String(headers.authorization ?? "").replace(/^Bearer /, "");
    if (this.down) throw new TypeError(`connect ECONNREFUSED ${bearer}`);
    const body = init.body === undefined ? "" : String(init.body), nonce = headers[SHARED_LEDGER_AUTH_HEADERS.nonce] ?? "";
    this.seen.push({ method, path: url.pathname, bearer, search: url.search, body, nonce });
    if (this.rejectWith) return Response.json(this.rejectWith.body, { status: this.rejectWith.status });
    const route = method === "POST" && url.pathname === "/v1/feature-proposals" ? { kind: "submit" as const }
      : (/^\/v1\/feature-proposals\/operations\/([^/]+)$/.exec(url.pathname) && method === "GET") ? { kind: "status" as const, id: url.pathname.split("/").at(-1)! }
      : (/^\/v1\/feature-proposals\/projects\/([^/]+)$/.exec(url.pathname) && method === "GET") ? { kind: "list" as const, id: url.pathname.split("/").at(-1)! }
      : (/^\/v1\/feature-proposals\/decisions\/([^/]+)$/.exec(url.pathname) && method === "POST") ? { kind: "decide" as const, id: url.pathname.split("/").at(-1)! }
      : null;
    if (!route) return Response.json({ error: "not found" }, { status: 404 });
    const invalid = () => Response.json(featureProposalError("invalid_field"), { status: 400 });
    if (url.search || !/^[0-9a-f]{48}$/.test(nonce)) return invalid();
    if (method === "GET" && body) return invalid();
    if (this.nonces.has(nonce)) return Response.json(featureProposalError("replayed"), { status: 409 });
    this.nonces.add(nonce);
    if (method === "POST" && this.replayNext > 0) { this.replayNext--; return Response.json(featureProposalError("replayed"), { status: 409 }); }
    const caller = bearer === BEARER.person ? { personId: "person-demo-owner", type: "person" as const } : bearer === BEARER.service
      ? { personId: "service-demo", type: "service" as const } : null;
    if (!caller) return forbidden();
    const view = (r: CenterRecord): unknown => {
      const operation = { ...r.operation, schemaVersion: this.schemaVersion,
        ...(this.drift.has(r.operation.operationId) && r.operation.state === "pending_approval" ? { state: "conflict" } : {}) };
      const out = this.legacyShape ? operation : { ...r, operation };
      return this.mangle ? this.mangle(structuredClone(out) as Record<string, any>) : out;
    };
    const reply = (r: CenterRecord) => {
      if (this.dropResponse) throw new TypeError("socket hang up");
      return Response.json(view(r));
    };
    if (route.kind === "status") {
      const r = this.records.get(route.id);
      return r && !this.hideOnGet && r.proposer.personId === caller.personId ? reply(r) : forbidden();
    }
    if (route.kind === "list") {
      return Response.json({ policy: defaultProposalPolicy({ ...SCOPE, projectId: route.id }),
        proposals: [...this.records.values()].filter(r => r.proposal.projectId === route.id).map(view) });
    }
    const envelope = JSON.parse(body) as Record<string, unknown>;
    if (Object.keys(envelope).sort().join() !== "attemptNonce,payload" || envelope.attemptNonce !== nonce) return invalid();
    const { payload } = envelope;
    if (route.kind === "decide") {
      const d = parseProposalDecision(payload);
      if (d.proposalId !== route.id || caller.type !== "person") return forbidden();
      const r = [...this.records.values()].find(o => o.proposalId === d.proposalId);
      if (!r) return forbidden();
      if (d.proposalRev !== r.proposalRev || d.proposalDigest !== r.operation.proposalDigest) return Response.json(featureProposalError("conflict"), { status: 409 });
      this.setState(r.operation.operationId, d.decision === "approve" ? { state: "published", featureId: "feature-demo-new", version: 1 } : { state: "rejected" });
      return reply(this.records.get(r.operation.operationId)!);
    }
    const digest = proposalDigest(payload), p = payload as FeatureProposal;
    const cls = classifyProposalOperation(this.records.get(p.operationId)?.operation ?? null, digest);
    if (cls === "conflict") return Response.json(featureProposalError("conflict"), { status: 409 });
    if (cls === "new") {
      try { parseFeatureProposal(p, this.now); } catch { return invalid(); } // 过期后首次提交
      this.received.push(p);
      this.records.set(p.operationId, { proposal: p, proposalId: `proposal-demo-${++this.n}`, proposalRev: 1,
        proposer: { personId: caller.personId, instanceId: "instance-demo-a", type: caller.type },
        operation: { centerId: p.centerId, teamId: p.teamId, projectId: p.projectId, schemaVersion: 1, operationId: p.operationId,
          proposalDigest: digest, state: "pending_approval", proposalId: `proposal-demo-${this.n}`, featureId: null, version: null,
          updatedAt: this.now, ...this.outcome } });
    }
    return reply(this.records.get(p.operationId)!);
  };
}

// ---- 台账 + plan_feature（同 tests/dag-tools-bridge.test.ts 的管道：manager 用进程内 runLedger，按频道认 actor） ----
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };
const PROJECTS = ["proj-bound", "proj-personal", "proj-local"];
export const fx = createFeatureProposalFixtures();
export let dir: string, center: FakeCenter, managerCalls: string[][];
let db: Database, now: number;
/** 测试里重建台账后把 manager 记录与时钟归零 */
export function resetLedgerClock() { now = 1_000; managerCalls = []; }
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
export const planFeature = (args: Record<string, unknown>) =>
  dagToolHandlers(deps()).plan_feature!(PM, { slug: "demo", title: fx.newProposal.title, description: fx.newProposal.description,
    nodes: fx.newProposal.nodes, ...args }) as Promise<Record<string, any>>;
const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
export const ledgerWrites = () => ({ features: count("features"), dags: count("dag_versions"), bindings: count("dag_bindings"), tasks: count("tasks") });
export const ZERO = { features: 0, dags: 0, bindings: 0, tasks: 0 };
export const journalPath = () => join(dir, "shared-feature-proposals.json");

export function setup(opts: { credentials?: boolean } = {}, more: Partial<ProposalRuntime> = {}) {
  dir = stateDir(opts);
  center = new FakeCenter();
  configureFeatureProposals(runtime(dir, center, more));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  for (const project of PROJECTS) setMeta(db, { actor: "owner", now: 500 }, { project, key: "pms", value: [PM.agent] });
}
/** 每个测试一份临时 state 目录 + 台账 + fake center；用到本夹具的测试文件在顶层调一次 */
export function useProposalHarness() {
  beforeEach(() => { resetLedgerClock(); setup(); });
  afterEach(() => afterEach_());
}
export function afterEach_() { configureFeatureProposals(undefined); closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); }
export const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-10-02T00:00:00Z" } as Principal;
export const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, who: Principal = owner) =>
  handleSharedFeatureProposalsApi(new Request(`http://127.0.0.1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    new URL(`http://127.0.0.1${path}`), { auth: async () => who }) as Promise<Response>;
export const submitBody = { localProjectId: "proj-bound", title: fx.newProposal.title, description: fx.newProposal.description, nodes: fx.newProposal.nodes };
const personConn = { centerId: SCOPE.centerId, baseUrl: "http://127.0.0.1:1/", teamId: SCOPE.teamId, personId: "person-demo-owner",
  instanceId: "instance-demo-a", bearer: BEARER.person };
export const serviceConn = { ...personConn, personId: "service-demo", bearer: BEARER.service };
export const directClient = (conn = personConn) => new SharedLedgerFeatureProposalClient(conn, newKey(), { fetch: center.fetch as typeof fetch, now: () => center.now });
