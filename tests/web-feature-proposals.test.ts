/**
 * N7W 网页提案：提交体 / 状态映射 / owner 审批卡的决定规则（纯逻辑，DOM 一侧见 web-feature-proposals-browser.test.ts）。
 * 验收线编号对应 team-project-N7W 规格「验收线」1–7。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { featureProposalsApi, type FeatureProposalsPort, type ProposalAccess, type Reply } from "../web/lib/feature-proposals-api";
import { ProposalsController, rereadOffered } from "../web/lib/feature-proposals-controller";
import { canDecide, parseOperations, parseReview, proposalInput, recordStatus, replyEntry, replyStatus, type ReviewCard } from "../web/lib/feature-proposals-model";
import { ApiError, type ApiInit } from "../web/lib/api/client";
import { ProjectFailure, type SharedProjectsPort } from "../web/lib/shared-projects-model";

const PROJECT = "project-demo";
const node = { key: "N1", oneLine: "做表单", deps: [], fileGlobs: ["web/**"], estimate: "1h" };
const NOW = 1_800_000_000_000;
const raw = (over: Record<string, unknown> = {}) => ({ proposalId: "proposal-1", proposalRev: 3, proposalDigest: "sha256:abc", state: "pending_approval",
  drift: false, title: "新表单", description: "desc", nodes: [node], version: null, expiresAt: NOW + 60_000, proposer: { type: "person", code: "self" }, ...over });
const projects = (role: "owner" | "member" | null, fail?: number): SharedProjectsPort => ({
  list: async () => {
    if (fail) throw new ProjectFailure(fail);
    return { teams: [], localProjects: [], peers: [], projects: [{ centerId: "c", teamId: "t", projectId: PROJECT, name: "P", rev: 1,
      status: "active", role, local: { id: "proj-bound", name: "P", dirs: [] }, availability: "ready" }] };
  },
} as unknown as SharedProjectsPort);

function fakePort(o: { role?: "owner" | "member" | null; access?: number; cards?: unknown[]; decide?: Reply[] } = {}) {
  const calls: { kind: string; arg?: unknown }[] = [];
  const decide = [...(o.decide ?? [])];
  let cards = o.cards ?? [raw()];
  const ops: unknown[] = [];
  const port: FeatureProposalsPort = {
    submit: async input => { calls.push({ kind: "submit", arg: input });
      const operation = { operationId: "op-1", projectId: PROJECT, title: input.title, state: "pending_approval", issue: null, expiresAt: NOW };
      ops.push(operation);
      return { status: 200, body: { ok: true, state: "pending_approval", operation } }; },
    operations: async () => { calls.push({ kind: "operations" }); return { status: 200, body: { ok: true, operations: ops } }; },
    operation: async id => { calls.push({ kind: "operation", arg: id }); return { status: 202, body: { ok: false, code: "pending_sync" } }; },
    access: async (): Promise<ProposalAccess> => ({ status: o.access ?? 200, role: o.access && o.access !== 200 ? null : "role" in o ? o.role ?? null : "owner", localProjectId: "proj-bound" }),
    review: async local => { calls.push({ kind: "review", arg: local }); return { status: 200, body: { ok: true, proposals: cards } }; },
    decide: async (local, d) => { calls.push({ kind: "decide", arg: { local, ...d } }); return decide.shift() ?? { status: 200, body: { ok: true, state: "published" } }; },
  };
  return { port, calls, setCards: (c: unknown[]) => { cards = c; }, count: (k: string) => calls.filter(c => c.kind === k).length };
}
async function ready(o: Parameters<typeof fakePort>[0] = {}, clock = { now: NOW }) {
  const f = fakePort(o), ctrl = new ProposalsController(f.port, PROJECT, () => clock.now);
  await ctrl.poll();
  return { ...f, ctrl, clock };
}

describe("验收线 1 / 2：提案表单只交四个键 + 项目请求头，走提案接口，V1 feature.new 0 次", () => {
  test("POST /shared-feature-proposals 的 body 只有 title / description / ownerWords / nodes，带 X-Shared-Ledger-Project", async () => {
    const seen: { path: string; init: ApiInit }[] = [];
    const client = featureProposalsApi({ fp: "local" }, PROJECT, async (path, init) => { seen.push({ path, init }); return { ok: true, state: "pending_approval" }; }, projects("owner"));
    const input = proposalInput("  新表单 ", "说明", "owner 原话", [{ ...node, key: " N1 " }])!;
    await client.submit(input, new AbortController().signal);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/shared-feature-proposals");
    expect(seen[0]!.init.method).toBe("POST");
    expect(Object.keys(seen[0]!.init.json as object).sort()).toEqual(["description", "nodes", "ownerWords", "title"]);
    expect(JSON.stringify(seen[0]!.init.json)).not.toMatch(/projectId|homeInstanceId|centerId|teamId/);
    expect(seen[0]!.init.headers).toMatchObject({ "X-Shared-Ledger-Project": PROJECT });
    expect(seen.some(s => s.path.startsWith("/shared-ledger/commands"))).toBe(false);
    expect(Object.keys(proposalInput("t", "", "", [node])!).sort()).toEqual(["description", "nodes", "title"]);
  });
  test("表单节点校验：代号唯一、描述与文件范围必填、依赖必须存在", () => {
    expect(proposalInput("", "", "", [node])).toBeNull();
    expect(proposalInput("t", "", "", [node, node])).toBeNull();
    expect(proposalInput("t", "", "", [{ ...node, fileGlobs: [" "] }])).toBeNull();
    expect(proposalInput("t", "", "", [{ ...node, deps: ["N9"] }])).toBeNull();
    expect(proposalInput("t", "", "", [node, { ...node, key: "N2", deps: ["N1"] }])?.nodes).toHaveLength(2);
  });
  test("团队视图的新建入口换成 ProposalForm；表单里没有 project / home / center / team 框（main 上 shared-forms.tsx:18 / :21 有）", () => {
    const to = readFileSync("web/features/collab/shared/team-ops.tsx", "utf8");
    expect(to).not.toMatch(/<NewFeature\b/);
    expect(to).toMatch(/<ProposalForm identity=\{ops\.identity\}/);
    const view = readFileSync("web/features/collab/feature-proposals/proposals-view.tsx", "utf8");
    const form = view.slice(view.indexOf("export function ProposalForm"), view.indexOf("const FINAL"));
    expect(form).not.toMatch(/'项目'|默认规划主场|homeInstanceId|projectId|centerId|teamId/);
    expect(form).not.toMatch(/feature\.new/);
  });
  test("控制器提交只调 port.submit，留下本机记录就把条目放进「我的提案」", async () => {
    const { ctrl, count } = await ready();
    expect(await ctrl.submit(proposalInput("新表单", "", "", [node])!)).toBe(true);
    expect(count("submit")).toBe(1);
    expect(ctrl.get().mine[0]).toMatchObject({ operationId: "op-1", status: { kind: "pending_approval" } });
  });
  test("guest 设备 403：没有 operation，留在表单里显示固定文案", async () => {
    const f = fakePort();
    f.port.submit = async () => ({ status: 403, body: { ok: false, code: "owner_required" } });
    const ctrl = new ProposalsController(f.port, PROJECT, () => NOW);
    expect(await ctrl.submit(proposalInput("t", "", "", [node])!)).toBe(false);
    expect(ctrl.get().formError).toEqual({ kind: "forbidden" });
  });
});

describe("验收线 3：202 / cachedState 一律待同步，只有 state=published 才是已发布", () => {
  test("答复映射", () => {
    expect(replyStatus({ status: 202, body: { ok: false, code: "pending_sync" } })).toEqual({ kind: "pending_sync" });
    expect(replyStatus({ status: 202, body: { ok: false, code: "proposal_drift", cachedState: "pending_approval" } }))
      .toEqual({ kind: "pending_sync", cachedState: "pending_approval" });
    expect(replyStatus({ status: 403, body: { ok: false, code: "forbidden", cachedState: "approved" } })).toEqual({ kind: "pending_sync", cachedState: "approved" });
    expect(replyStatus({ status: 200, body: { ok: true, state: "published", cachedState: "approved", centerFeatureId: "f-1" } }).kind).toBe("pending_sync");
    expect(replyStatus({ status: 200, body: { ok: true, state: "published", centerFeatureId: "f-1", version: 1 } }))
      .toEqual({ kind: "published", featureId: "f-1", version: 1 });
    expect(replyStatus({ status: 200, body: { ok: true, state: "published" } }).kind).toBe("unknown");
    expect(replyStatus({ status: 200, body: { ok: true, state: "approved" } }).kind).toBe("approved");
    for (const s of ["rejected", "expired", "conflict"] as const) expect(replyStatus({ status: 409, body: { code: `proposal_${s}` } }).kind).toBe(s);
    expect(replyStatus({ status: 502, body: { code: "unsupported" } }).kind).toBe("unsupported");
    expect(replyStatus({ status: 0, body: {} }).kind).toBe("unknown");
  });
  test("api() 对 2xx 都 resolve：ok=false 的答复按 202 待同步处理", async () => {
    const client = featureProposalsApi({ fp: "local" }, PROJECT, async () => ({ ok: false, code: "pending_sync", cachedState: "pending_approval" }), projects("owner"));
    const r = await client.submit(proposalInput("t", "", "", [node])!, new AbortController().signal);
    expect(replyStatus(r)).toEqual({ kind: "pending_sync", cachedState: "pending_approval" });
  });
  test("本机记录：unsynced / 带 issue 的都是待同步，published 才带中心 featureId", () => {
    expect(recordStatus({ state: "unsynced", issue: "unavailable" })).toEqual({ kind: "pending_sync" });
    expect(recordStatus({ state: "pending_approval", issue: "drift" })).toEqual({ kind: "pending_sync", cachedState: "pending_approval" });
    expect(recordStatus({ state: "pending_approval", issue: null })).toEqual({ kind: "pending_approval" });
    expect(recordStatus({ state: "published", issue: null, featureId: "f-9", version: 1 })).toEqual({ kind: "published", featureId: "f-9", version: 1 });
    expect(recordStatus({ state: "published", issue: null, featureId: null }).kind).toBe("pending_sync");
    expect(recordStatus({ state: "unsynced", issue: "no_credential" }).kind).toBe("forbidden");
    const ops = parseOperations({ status: 200, body: { operations: [
      { operationId: "op-a", projectId: PROJECT, title: "A", state: "rejected", issue: null, createdAt: 1 },
      { operationId: "op-b", projectId: "other", title: "B", state: "pending_approval", issue: null, createdAt: 2 },
      { operationId: "op-c", projectId: PROJECT, title: "C", state: "approved", issue: null, createdAt: 3 },
    ] } }, PROJECT)!;
    expect(ops.map(o => [o.operationId, o.status.kind])).toEqual([["op-c", "approved"], ["op-a", "rejected"]]);
  });
});

describe("验收线 4：只有 role=owner 有批准 / 驳回", () => {
  test("canDecide：owner 可以，member / null 不行", () => {
    const c = parseReview({ status: 200, body: { proposals: [raw()] } })![0]!;
    expect(canDecide(c, "owner", NOW, [])).toBe(true);
    expect(canDecide(c, "member", NOW, [])).toBe(false);
    expect(canDecide(c, null, NOW, [])).toBe(false);
  });
  for (const role of ["member", null] as const) test(`role=${role}：卡片可见但不可决定，decide 0 次`, async () => {
    const { ctrl, count } = await ready({ role });
    expect(ctrl.get().cards).toHaveLength(1);
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(0);
  });
  test("guest 设备：snapshot 403 → 待审列表 forbidden，不读列表、不发决定", async () => {
    const client = featureProposalsApi({ fp: "local" }, PROJECT, async () => { throw new ApiError("x", 403, { code: "owner_required" }); }, projects(null, 403));
    expect(await client.access(new AbortController().signal)).toEqual({ status: 403, role: null, localProjectId: null });
    const { ctrl, count } = await ready({ access: 403 });
    expect(ctrl.get()).toMatchObject({ access: "forbidden", review: "forbidden", cards: [] });
    await ctrl.decide("proposal-1", "approve");
    expect(count("review") + count("decide")).toBe(0);
  });
  test("access：按中心 projectId 取 N4 snapshot 的 projectRole 和本机项目 id", async () => {
    const client = featureProposalsApi({ fp: "local" }, PROJECT, async () => ({}), projects("member"));
    expect(await client.access(new AbortController().signal)).toEqual({ status: 200, role: "member", localProjectId: "proj-bound" });
  });
});

describe("验收线 5：漂移 / 过期置灰，决定 0 次；打开期间到期的下一次轮询变灰", () => {
  test("漂移卡与过期卡不可决定，decide 0 次", async () => {
    const { ctrl, count } = await ready({ cards: [raw({ proposalId: "p-drift", state: "conflict", drift: true }),
      raw({ proposalId: "p-old", expiresAt: NOW - 1 }), raw({ proposalId: "p-exp", state: "expired" })] });
    expect(ctrl.get().cards.map(c => [c.proposalId, c.drift, c.expired, c.decidable])).toEqual([
      ["p-drift", true, false, false], ["p-old", false, true, false], ["p-exp", false, true, false]]);
    for (const id of ["p-drift", "p-old", "p-exp"]) await ctrl.decide(id, "approve");
    expect(count("decide")).toBe(0);
  });
  test("打开时可决定，时钟过了 expiresAt 后下一次 poll 变灰（即使列表读失败）", async () => {
    const { ctrl, clock, port } = await ready();
    expect(ctrl.get().cards[0]).toMatchObject({ expired: false, decidable: true });
    clock.now = NOW + 60_001;
    expect(ctrl.get().cards[0]!.decidable).toBe(true); // 不读时钟就不变：render 侧没有时钟
    port.review = async () => ({ status: 0, body: {} });
    await ctrl.poll();
    expect(ctrl.get().cards[0]).toMatchObject({ expired: true, decidable: false });
  });
  test("start() 立即轮询一次，按间隔再轮询；最后一个使用者退出后停", async () => {
    const f = fakePort(), ctrl = new ProposalsController(f.port, PROJECT, () => NOW, 5);
    const stop = ctrl.start();
    await Bun.sleep(30);
    stop();
    const n = f.count("review");
    expect(n).toBeGreaterThan(1);
    await Bun.sleep(20);
    expect(f.count("review")).toBe(n);
  });
});

describe("验收线 6：批准带 rev 和 digest；409 重读；503 结果未确认不重发；驳回必须有理由", () => {
  test("批准请求带 proposalRev / proposalDigest / localProjectId", async () => {
    const { ctrl, calls } = await ready();
    await ctrl.decide("proposal-1", "approve");
    expect(calls.find(c => c.kind === "decide")!.arg).toEqual({ local: "proj-bound", proposalId: "proposal-1", decision: "approve",
      proposalDigest: "sha256:abc", proposalRev: 3, reason: "" });
    expect(ctrl.get().notice).toEqual({ kind: "done", state: "published" });
  });
  test("409：重读列表，按新 rev 再决定", async () => {
    const { ctrl, count, setCards, calls } = await ready({ decide: [{ status: 409, body: { ok: false, code: "stale_rev" } }] });
    const before = count("review");
    setCards([raw({ proposalRev: 4, proposalDigest: "sha256:def" })]);
    await ctrl.decide("proposal-1", "approve");
    expect(count("review")).toBe(before + 1);
    expect(ctrl.get().notice).toEqual({ kind: "conflict" });
    expect(ctrl.get().cards[0]).toMatchObject({ proposalRev: 4, decidable: true });
    await ctrl.decide("proposal-1", "approve");
    expect(calls.filter(c => c.kind === "decide").map(c => (c.arg as { proposalRev: number }).proposalRev)).toEqual([3, 4]);
  });
  for (const status of [503, 0]) test(`决定返回 ${status}：显示结果未确认，轮询后也不自动重发；手动重读后才能再点`, async () => {
    const { ctrl, count } = await ready({ decide: [{ status, body: { ok: false, code: "center_unavailable", error: "中心不可达，结果未确认" } }] });
    await ctrl.decide("proposal-1", "approve");
    expect(ctrl.get().notice).toEqual({ kind: "unconfirmed" });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.poll();
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(1);
    await ctrl.reread();
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
  });
  test("驳回不填理由不发请求；填了才带 reason", async () => {
    const { ctrl, calls } = await ready();
    await ctrl.decide("proposal-1", "reject", "   ");
    expect(calls.filter(c => c.kind === "decide")).toHaveLength(0);
    await ctrl.decide("proposal-1", "reject", " 范围太大 ");
    expect(calls.find(c => c.kind === "decide")!.arg).toMatchObject({ decision: "reject", reason: "范围太大" });
  });
  test("owner 自己的提案也不自动批准：没有点就没有决定请求", async () => {
    const { ctrl, count } = await ready();
    expect(ctrl.get().cards[0]!.proposer.code).toBe("self");
    await ctrl.poll();
    expect(count("decide")).toBe(0);
  });
});

/** 一次性可控答复：先挂起，测试手动 resolve */
function gate<T>() {
  let open!: (v: T) => void;
  const p = new Promise<T>(r => { open = r; });
  return { p, open };
}

describe("验收线 6 补：重读成功之前不解锁（reread-1）", () => {
  test("409 后新列表还没回来：卡全部不可决定，再点批准 0 次；不提前说已重读", async () => {
    const { ctrl, port, count } = await ready({ decide: [{ status: 409, body: { ok: false, code: "stale_rev" } }] });
    const pending = gate<Reply>();
    port.review = async () => pending.p;
    const deciding = ctrl.decide("proposal-1", "approve");
    await Bun.sleep(0);
    expect(ctrl.get()).toMatchObject({ deciding: null, stale: true, notice: { kind: "conflict" } });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(1);
    pending.open({ status: 200, body: { ok: true, proposals: [raw({ proposalRev: 4, proposalDigest: "sha256:def" })] } });
    await deciding;
    expect(ctrl.get().stale).toBe(false);
    expect(ctrl.get().cards[0]).toMatchObject({ proposalRev: 4, decidable: true });
  });
  test("409 后重读失败：保留冲突锁，不可决定；之后重读成功才解锁", async () => {
    const { ctrl, port, count } = await ready({ decide: [{ status: 409, body: { ok: false, code: "stale_rev" } }] });
    const ok = port.review;
    port.review = async () => ({ status: 503, body: {} });
    await ctrl.decide("proposal-1", "approve");
    expect(ctrl.get()).toMatchObject({ stale: true, review: "failed", notice: { kind: "conflict" } });
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(1);
    port.review = ok;
    await ctrl.reread();
    expect(ctrl.get()).toMatchObject({ stale: false, review: "ready", notice: null });
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
  });
  test("409 之前发出、之后才回来的旧列表不算重读", async () => {
    const { ctrl, port } = await ready({ decide: [{ status: 409, body: { ok: false, code: "stale_rev" } }] });
    const old = gate<Reply>(), fresh = gate<Reply>();
    port.review = async () => old.p;
    const polling = ctrl.poll();
    await Bun.sleep(0);
    port.review = async () => fresh.p;
    const deciding = ctrl.decide("proposal-1", "approve");
    await Bun.sleep(0);
    old.open({ status: 200, body: { ok: true, proposals: [raw()] } });
    await polling;
    expect(ctrl.get().stale).toBe(true);
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    fresh.open({ status: 200, body: { ok: true, proposals: [raw({ proposalRev: 4 })] } });
    await deciding;
    expect(ctrl.get().cards[0]).toMatchObject({ proposalRev: 4, decidable: true });
  });
  test("503 后手动重读也失败：结果未确认的锁和提示都保留，决定仍 1 次", async () => {
    const { ctrl, port, count } = await ready({ decide: [{ status: 503, body: { ok: false } }] });
    await ctrl.decide("proposal-1", "approve");
    const ok = port.review;
    port.review = async () => ({ status: 503, body: {} });
    await ctrl.reread();
    expect(ctrl.get()).toMatchObject({ review: "failed", unconfirmed: ["proposal-1"], notice: { kind: "unconfirmed" } });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(1);
    port.review = ok;
    await ctrl.reread();
    expect(ctrl.get()).toMatchObject({ review: "ready", unconfirmed: [], notice: null });
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
  });
});

describe("验收线 4 补：角色每次轮询重读，拒绝时撤销决定权（role-1）", () => {
  test("owner 被降为 member：下一次 poll 角色变 member，卡不可决定，decide 0 次", async () => {
    const { ctrl, port, count } = await ready();
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
    port.access = async () => ({ status: 200, role: "member", localProjectId: "proj-bound" });
    await ctrl.poll();
    expect(ctrl.get().role).toBe("member");
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(0);
  });
  test("列表返回 403：撤销角色，卡不可决定，decide 0 次", async () => {
    const { ctrl, port, count } = await ready();
    port.review = async () => ({ status: 403, body: { ok: false, code: "owner_required" } });
    await ctrl.poll();
    expect(ctrl.get()).toMatchObject({ review: "forbidden", role: null });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(0);
  });
  test("snapshot 变 403：撤销角色", async () => {
    const { ctrl, port } = await ready();
    port.access = async () => ({ status: 403, role: null, localProjectId: null });
    await ctrl.poll();
    expect(ctrl.get()).toMatchObject({ access: "forbidden", review: "forbidden", role: null });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
  });
  test("决定返回 403：撤销角色", async () => {
    const { ctrl } = await ready({ decide: [{ status: 403, body: { ok: false, code: "owner_required" } }] });
    await ctrl.decide("proposal-1", "approve");
    expect(ctrl.get()).toMatchObject({ role: null, notice: { kind: "forbidden" } });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
  });
});

describe("第 3 轮复现：重叠刷新的旧角色不回写；未确认卡的重读入口不被别卡结果覆盖", () => {
  test("role-1 重叠 poll：在途时再来的 poll 合并成紧随其后的一轮，按发出顺序落地，最后是 member；decide 0 次", async () => {
    const { ctrl, port, count } = await ready();
    const old = gate<ProposalAccess>();
    let accessCalls = 0;
    port.access = async () => { accessCalls++; return old.p; };
    const first = ctrl.poll();
    await Bun.sleep(0);
    port.access = async () => { accessCalls++; return { status: 200, role: "member", localProjectId: "proj-bound" }; };
    const second = ctrl.poll();
    await Bun.sleep(0);
    expect(accessCalls).toBe(1);
    old.open({ status: 200, role: "owner", localProjectId: "proj-bound" });
    await first;
    await second;
    expect(accessCalls).toBe(2);
    expect(ctrl.get().role).toBe("member");
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(0);
  });
  test("role-1 定时轮询：access 每次都比轮询周期略慢且失败，失败照样落地撤权，decide 0 次", async () => {
    const f = fakePort(), ctrl = new ProposalsController(f.port, PROJECT, () => NOW, 20);
    await ctrl.poll();
    expect(ctrl.get()).toMatchObject({ access: "ready", role: "owner" });
    let fails = 0;
    f.port.access = async () => { await Bun.sleep(25); fails++; return { status: 0, role: null, localProjectId: null }; };
    const stop = ctrl.start();
    await Bun.sleep(70);
    expect(fails).toBeGreaterThanOrEqual(2);
    expect(ctrl.get()).toMatchObject({ access: "failed", role: null });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(f.count("decide")).toBe(0);
    stop();
  });
  test("poll-1 持续慢轮询：每轮都慢于周期时手动重读仍在有限轮次内完成，取到新角色和列表后清掉未确认锁", async () => {
    const f = fakePort({ decide: [{ status: 503, body: { ok: false } }] }), ctrl = new ProposalsController(f.port, PROJECT, () => NOW, 20);
    await ctrl.poll();
    await ctrl.decide("proposal-1", "approve");
    expect(ctrl.get().unconfirmed).toEqual(["proposal-1"]);
    const access = f.port.access;
    f.port.access = async () => ({ status: 0, role: null, localProjectId: null });
    await ctrl.poll();
    expect(ctrl.get().access).toBe("failed");
    f.port.access = access;
    const ops = f.port.operations;
    f.port.operations = async signal => { await Bun.sleep(25); return ops(signal); };
    const stop = ctrl.start();
    let finished = false;
    void ctrl.reread().then(() => { finished = true; });
    await Bun.sleep(140);
    expect(finished).toBe(true);
    expect(ctrl.get()).toMatchObject({ access: "ready", role: "owner", stale: false, unconfirmed: [] });
    expect(ctrl.get().notice).toBeNull();
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
    expect(f.count("decide")).toBe(1);
    stop();
  });
  test("role-1 首次载入：access 持续慢于轮询周期且失败，显示读失败而不是一直 loading", async () => {
    const f = fakePort(), ctrl = new ProposalsController(f.port, PROJECT, () => NOW, 20);
    f.port.access = async () => { await Bun.sleep(25); return { status: 0, role: null, localProjectId: null }; };
    const stop = ctrl.start();
    await Bun.sleep(60);
    expect(ctrl.get()).toMatchObject({ access: "failed", role: null });
    expect(rereadOffered(ctrl.get())).toBe(true);
    stop();
  });
  test("role-1 access 失败后连点两次重读：合并成一轮刷新，旧 owner 不覆盖 member", async () => {
    const { ctrl, port, count } = await ready();
    port.access = async () => ({ status: 503, role: null, localProjectId: null });
    await ctrl.poll();
    expect(ctrl.get().access).toBe("failed");
    const old = gate<ProposalAccess>();
    let accessCalls = 0;
    port.access = async () => { accessCalls++; return old.p; };
    const r1 = ctrl.reread();
    await Bun.sleep(0);
    port.access = async () => { accessCalls++; return { status: 200, role: "member", localProjectId: "proj-bound" }; };
    const r2 = ctrl.reread();
    await Bun.sleep(0);
    expect(accessCalls).toBe(1);
    old.open({ status: 200, role: "owner", localProjectId: "proj-bound" });
    await Promise.all([r1, r2]);
    await ctrl.poll();
    expect(ctrl.get().role).toBe("member");
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    await ctrl.decide("proposal-1", "approve");
    expect(count("decide")).toBe(0);
  });
  test("reread-1 多卡：A 503 后批准 B 成功，A 的未确认提示与重读入口仍在；重读后 A 可再决定", async () => {
    const { ctrl, setCards, count } = await ready({ cards: [raw({ proposalId: "p-a" }), raw({ proposalId: "p-b" })],
      decide: [{ status: 503, body: { ok: false } }, { status: 200, body: { ok: true, state: "published" } }] });
    await ctrl.decide("p-a", "approve");
    expect(rereadOffered(ctrl.get())).toBe(true);
    await ctrl.decide("p-b", "approve");
    setCards([raw({ proposalId: "p-a" })]);
    await ctrl.poll();
    expect(ctrl.get()).toMatchObject({ notice: { kind: "done", state: "published" }, unconfirmed: ["p-a"] });
    expect(ctrl.get().cards[0]!.decidable).toBe(false);
    expect(rereadOffered(ctrl.get())).toBe(true);
    await ctrl.reread();
    expect(ctrl.get().unconfirmed).toEqual([]);
    expect(rereadOffered(ctrl.get())).toBe(false);
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
    expect(count("decide")).toBe(2);
  });
  test("reread-1 页面：未确认提示和重读按钮按 unconfirmed 集合 / rereadOffered 渲染，不绑全局 notice", () => {
    const view = readFileSync("web/features/collab/feature-proposals/proposals-view.tsx", "utf8");
    expect(view).toMatch(/rereadOffered\(state\)/);
    expect(view).toMatch(/state\.unconfirmed\.length > 0/);
    expect(view).not.toMatch(/n\.kind === 'unconfirmed' \|\|/);
  });
});

describe("回归：决定在途时卸载（abort-1）", () => {
  test("stop 中止在途决定：清掉忙碌锁、记成结果未确认；重开后重读即可再决定", async () => {
    const f = fakePort(), ctrl = new ProposalsController(f.port, PROJECT, () => NOW, 60_000);
    const stop = ctrl.start();
    await Bun.sleep(5);
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
    f.port.decide = (_local, _d, signal) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: 0, body: {} })));
    const deciding = ctrl.decide("proposal-1", "approve");
    await Bun.sleep(0);
    expect(ctrl.get().deciding).toBe("proposal-1");
    stop();
    await deciding;
    expect(ctrl.get()).toMatchObject({ deciding: null, unconfirmed: ["proposal-1"], notice: { kind: "unconfirmed" } });
    const stop2 = ctrl.start();
    await Bun.sleep(5);
    expect(ctrl.get()).toMatchObject({ review: "ready", deciding: null });
    await ctrl.reread();
    expect(ctrl.get().cards[0]!.decidable).toBe(true);
    stop2();
  });
});

describe("验收线 7：页面不带 bearer / 中心原文 / 他人 personId；改动面", () => {
  test("答复里的原文、凭据、personId 不进模型", () => {
    const leak = "Bearer sk-secret raw center text person-other";
    const entry = replyEntry({ status: 403, body: { ok: false, code: "center_rejected", error: leak, operation: { operationId: "op-1", title: "T" } } }, "T");
    expect(JSON.stringify(entry)).not.toContain("secret");
    const cards = parseReview({ status: 200, body: { proposals: [raw({ proposer: { type: "person", personId: "person-other", instanceId: "i-x" }, bearer: leak,
      nodes: [{ ...node, personId: "person-other" }] })] } }) as ReviewCard[];
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards)).not.toMatch(/person-other|i-x|secret/);
    expect(cards[0]!.proposer).toEqual({ type: "person", code: null });
  });
  test("坏卡不渲染：缺 digest / rev 或节点形状不对就丢掉", () => {
    expect(parseReview({ status: 200, body: { proposals: [raw({ proposalDigest: 7 }), raw({ proposalRev: 0 }), raw({ nodes: [{ key: "" }] })] } })).toEqual([]);
  });
});
