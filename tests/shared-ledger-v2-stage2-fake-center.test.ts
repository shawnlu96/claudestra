/** S2C 验收线 1 / 3：回执幂等、旧 epoch、executionOnly、迁移 commit / revert 与查询路由；外加租约 / 意图 / 出借订单的最小状态。
 * 只用合成 fake center（tests/helpers/shared-ledger-v2-fake-center*），不读生产、不连网络。
 */
import { describe, expect, test } from "bun:test";
import { v2ManifestDigest, v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { V2_REVERT_REQUEST_FIXTURE } from "../src/lib/shared-ledger-contract-v2-routes-fixtures.js";
import { V2_ROUTES } from "../src/lib/shared-ledger-contract-v2-routes.js";
import { ACTORS, approvedAsk, code, EXEC_TASK, featureRows, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const { owner, member, executor } = ACTORS;
const H = "b".repeat(40), D = "a".repeat(64);
const titleSet = (k: ReturnType<typeof kit>, title: string, requestId = "request-title", epoch = 1) =>
  k.command("task.set", { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, patch: { title } }, { requestId, epoch });

describe("S2C 验收线 1：回执幂等 / 旧 epoch / executionOnly", () => {
  test("同 requestId 同体重放回同一回执，状态不再变", () => {
    const k = kit(), first = k.post(member, titleSet(k, "新标题"));
    expect(first.status).toBe(200);
    const seq = k.center.rows().serverSeq;
    const again = k.post(member, titleSet(k, "新标题"));
    expect(again).toEqual(first);
    expect(k.center.rows().serverSeq).toBe(seq);
    expect(k.center.rows().tasks.get("task-exec")!.rev).toBe(2);
  });
  test("同 requestId 不同体 → dedup_mismatch，0 写", () => {
    const k = kit();
    k.post(member, titleSet(k, "新标题"));
    const before = k.center.rows();
    const res = k.post(member, titleSet(k, "另一个标题"));
    expect([res.status, code(res)]).toEqual([409, "dedup_mismatch"]);
    expect(k.center.rows()).toEqual(before);
  });
  test("回执去重按 (person, instance, requestId)：别的成员用同一个 requestId 是另一条命令", () => {
    const k = kit();
    expect(k.post(member, titleSet(k, "甲")).status).toBe(200);
    const other = k.post(executor, k.command("task.set", { taskId: "task-exec", expectedRev: 2, expectedSpecRev: 1, patch: { title: "乙" } }, { requestId: "request-title" }));
    expect(other.status).toBe(200);
  });
  test("receipts 路由：已提交回 committed + 原回执；摘要不符 dedup_mismatch；没提交过回 unknown", () => {
    const k = kit(), cmd = titleSet(k, "新标题"), sent = k.post(member, cmd);
    const query = { requestId: cmd.requestId, operationId: null, commandDigest: v2ObjectDigest(cmd) };
    expect(k.call(member, "receipts", query).body).toMatchObject({ status: "committed", receipt: sent.body });
    expect(code(k.call(member, "receipts", { ...query, commandDigest: D }))).toBe("dedup_mismatch");
    expect(k.call(member, "receipts", { ...query, requestId: "never-sent" }).body).toMatchObject({ status: "unknown", receipt: null });
    // 回执只按调用者身份查：别人看不到这条
    expect(k.call(executor, "receipts", query).body).toMatchObject({ status: "unknown" });
  });
  test("home.change 升 epoch 后，带旧 epoch 的命令 stale_epoch；新 epoch 照常", () => {
    const k = kit();
    const change = k.command("home.change", { featureId: "feature-exec", expectedRev: 1, nextHomeInstanceId: "peer-b", nextEpoch: 2,
      authorizationAskId: "ask-exec", oldHomeStopped: true, workersSettled: true, lendSettled: true, unknownReconciled: true });
    expect(k.post(owner, change).status).toBe(200);
    expect(k.center.feature("feature-exec")).toMatchObject({ epoch: 2, homeInstanceId: "peer-b" });
    const stale = k.post(member, titleSet(k, "旧任期", "request-old", 1));
    expect([stale.status, code(stale)]).toEqual([409, "stale_epoch"]);
    expect(k.post(member, titleSet(k, "新任期", "request-new", 2)).status).toBe(200);
  });
  test("executionOnly 命令在未迁 feature 上 execution_not_shared；非 executionOnly 命令照常", () => {
    const k = kit();
    const set = k.post(member, k.command("task.set", { taskId: "task-plan", expectedRev: 1, expectedSpecRev: 1, patch: { title: "x" } }));
    expect([set.status, code(set)]).toEqual([403, "execution_not_shared"]);
    const created = k.post(member, k.command("task.new", { featureId: "feature-plan", expectedRev: 1, itemId: null, title: "新卡",
      plan: "", kind: "code", repository: "team/repository", spec: (V2_DTO_FIXTURES.task.valid as { spec: unknown }).spec }));
    expect(code(created)).toBe("execution_not_shared");
    expect(k.post(member, k.command("feature.set", { featureId: "feature-plan", expectedRev: 1, title: "改名" })).status).toBe(200);
    expect(k.call(member, "features", { featureId: "feature-plan" }).body).toMatchObject({
      capabilities: { "task.set": { enabled: false, code: "execution_not_shared" }, "feature.set": { enabled: true } } });
  });
  test("身份只取注入的 actor：body 带 actor 400，未注入 401，非成员 403，owner 专属命令成员 403", () => {
    const k = kit(), cmd = titleSet(k, "x");
    expect(code(k.post(member, { ...cmd, actor: owner }))).toBe("invalid_field");
    expect(code(k.post(null as never, cmd))).toBe("unauthenticated");
    expect(code(k.post({ ...member, personId: "stranger" }, cmd))).toBe("not_member");
    const wf = k.command("workflow.set", { ...EXEC_TASK, template: "code", templateVersion: 1, mode: "manual", authorFamily: "codex",
      fallback: [], authorizationAskId: null });
    expect(code(k.post(member, wf))).toBe("forbidden");
    expect(k.post(owner, wf).status).toBe(200);
  });
});

describe("S2C 验收线 3：迁移 commit / revert 与查询路由", () => {
  const manifest = () => structuredClone(V2_DTO_FIXTURES.migrationManifest.valid) as Record<string, any>;
  function migrationKit() {
    const k = kit(), rows = featureRows("feature", "task", "planning");
    k.center.seed({ features: [rows.feature], asks: [approvedAsk("ask", "feature", "task")] });
    return k;
  }
  test("dry-run 不改状态；commit 把 feature 切 execution 并升 epoch；查询 committed / unknown", () => {
    const k = migrationKit();
    const dry = k.call(owner, "migrations", {}, { mode: "dry-run", manifest: manifest() });
    expect(dry.status).toBe(200);
    expect(k.center.feature("feature")).toMatchObject({ authorityMode: "planning", epoch: 1 });
    expect(k.call(owner, "migration", { batchId: "batch" }).body).toMatchObject({ status: "unknown", result: null });
    const commit = k.call(owner, "migrations", {}, { mode: "commit", manifest: manifest() });
    expect(commit.status).toBe(200);
    expect(k.center.feature("feature")).toMatchObject({ authorityMode: "execution", epoch: 2 });
    expect(k.call(owner, "migration", { batchId: "batch" }).body).toEqual({ teamId: "team", projectId: "project",
      batchId: "batch", status: "committed", result: commit.body });
    expect(k.call(owner, "migration", { batchId: "batch-other" }).body).toMatchObject({ status: "unknown", result: null });
    // 同批次重放回同一结果；已在 execution 的 feature 换批次再迁 → migration_blocked
    expect(k.call(owner, "migrations", {}, { mode: "commit", manifest: manifest() })).toEqual(commit);
    const again = manifest(); again.batchId = "batch-2";
    again.manifestDigest = v2ManifestDigest(again as { manifestDigest: string });
    expect(code(k.call(owner, "migrations", {}, { mode: "commit", manifest: again }))).toBe("migration_blocked");
    // 迁入后 executionOnly 命令放行，epoch 用新值
    const set = k.command("task.set", { taskId: "task", expectedRev: 1, expectedSpecRev: 1, patch: { title: "迁后" } }, { epoch: 2 });
    expect(k.post(member, set).status).toBe(200);
  });
  test("迁移只认 owner；授权 ask 缺失 → authorization_mismatch，0 写", () => {
    const k = kit(), rows = featureRows("feature", "task", "planning");
    k.center.seed({ features: [rows.feature] });
    expect(code(k.call(member, "migrations", {}, { mode: "commit", manifest: manifest() }))).toBe("forbidden");
    expect(code(k.call(owner, "migrations", {}, { mode: "commit", manifest: manifest() }))).toBe("authorization_mismatch");
    expect(k.center.feature("feature")).toMatchObject({ authorityMode: "planning", epoch: 1 });
  });
  test("revert：execution → planning、epoch+1，查询 committed；之后 executionOnly 命令 execution_not_shared", () => {
    const k = kit(), request = { ...V2_REVERT_REQUEST_FIXTURE, featureIds: ["feature-exec"], authorizationAskId: "ask-exec" };
    expect(code(k.call(owner, "reverts", {}, { ...request, expectedEpoch: 2 }))).toBe("stale_epoch");
    expect(k.call(owner, "revert", { batchId: request.batchId }).body).toMatchObject({ status: "unknown", result: null });
    const res = k.call(owner, "reverts", {}, request);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nextEpoch: 2, views: [{ feature: { id: "feature-exec", authorityMode: "planning", epoch: 2 } }] });
    expect(k.center.feature("feature-exec")).toMatchObject({ authorityMode: "planning", epoch: 2 });
    expect(k.call(owner, "revert", { batchId: request.batchId }).body).toMatchObject({ status: "committed", result: res.body });
    expect(k.call(owner, "reverts", {}, request)).toEqual(res);
    expect(code(k.call(owner, "reverts", {}, { ...request, authorizationAskId: "ask-other" }))).toBe("dedup_mismatch");
    const set = k.command("task.set", { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, patch: { title: "x" } }, { epoch: 2 });
    expect(code(k.post(member, set))).toBe("execution_not_shared");
  });
  test("revert 前置：持有中的租约 → migration_blocked，模式不变", () => {
    const k = kit();
    expect(k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" })).status).toBe(200);
    const res = k.call(owner, "reverts", {}, { ...V2_REVERT_REQUEST_FIXTURE, featureIds: ["feature-exec"], authorizationAskId: "ask-exec" });
    expect(code(res)).toBe("migration_blocked");
    expect(k.center.feature("feature-exec")).toMatchObject({ authorityMode: "execution", epoch: 1 });
  });
});

describe("S2C 最小状态：租约 / 意图 / 出借订单", () => {
  const resources = [{ teamId: "team", projectId: "project", repository: "team/repository", kind: "file", path: "src/example.ts" }];
  const intent = (k: ReturnType<typeof kit>, operationId: string) => k.command("intent.create", { ...EXEC_TASK, action: "dispatch",
    node: "write", operationId, head: H, round: 0, dependencyDigest: D, authorizationAskId: null, authorizationDigest: null, resources });
  test("无租约建意图 lease_expired；非主场领租 wrong_home；租约过期后同样拒", () => {
    const k = kit();
    expect(code(k.post(owner, intent(k, "op-1")))).toBe("lease_expired");
    expect(code(k.post(member, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" })))).toBe("wrong_home");
    expect(k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" })).status).toBe(200);
    k.center.advance(60_000);
    expect(code(k.post(owner, intent(k, "op-1")))).toBe("lease_expired");
  });
  test("意图 pending → submitted → unknown：锁被标 unknown 不释放，重叠意图 resource_busy；视图过 S2K parse", () => {
    const k = kit();
    k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" }));
    const created = k.post(owner, intent(k, "op-1"));
    const intentId = (created.body as any).result.entityId;
    expect((created.body as any).result.operationId).toBe("op-1");
    expect(code(k.post(owner, intent(k, "op-2")))).toBe("resource_busy");
    const check = k.command("intent.check", { ...EXEC_TASK, intentId, operationId: "op-1", authorizationAskId: null, authorizationDigest: null });
    expect(k.post(owner, check).status).toBe(200);
    const result = { teamId: "team", projectId: "project", operationId: "op-1", intentId, taskId: "task-exec", serviceGeneration: 1,
      epoch: 1, bootId: "boot-local", state: "unknown", head: null, approvalAskId: null, summary: "", artifactIds: [], observedAt: 10_000 };
    expect(k.post(owner, k.command("operation.result", { result })).status).toBe(200);
    const view = k.call(member, "features", { featureId: "feature-exec" }).body as any;
    expect(view.intents[0]).toMatchObject({ id: intentId, status: "unknown", attempts: 1 });
    expect(view.resources).toMatchObject([{ intentId, state: "unknown" }]);
    expect(code(k.post(owner, intent(k, "op-3")))).toBe("resource_busy");
  });
  test("出借订单 pooled → claimed → done；GET lend 回包过 S2K parse；旧 leaseGen 的结果 stale_lease_gen", () => {
    const k = kit();
    k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" }));
    const created = k.post(owner, k.command("lend.create", { ...EXEC_TASK, featureId: "feature-exec", family: "codex", step: "review",
      executorInstanceId: "peer-b", specArtifactId: "artifact", head: H, round: 0, branch: null, base: null, grantId: "grant", grantDigest: D }));
    const orderId = (created.body as any).result.entityId;
    expect(k.call(executor, "lend", { orderId }).body).toMatchObject({ order: { status: "pooled", leaseGen: 0 }, lease: null });
    const worker = { kind: "peer_agent", instanceId: "peer-b", agentId: "worker" };
    const claim = { teamId: "team", projectId: "project", orderId, taskId: "task-exec", specRev: 1, round: 0, head: H, leaseGen: 1,
      serviceGeneration: 1, epoch: 1, bootId: "boot-local", executorInstanceId: "peer-b", worker, grantId: "grant", grantDigest: D, claimedAt: 10_000 };
    expect(code(k.post(member, k.command("lend.claim", { claim: { ...claim, executorInstanceId: "peer-a",
      worker: { ...worker, instanceId: "peer-a" } } })))).toBe("stale_order");
    expect(k.post(executor, k.command("lend.claim", { claim })).status).toBe(200);
    expect(k.call(executor, "lend", { orderId }).body).toMatchObject({ order: { status: "claimed", leaseGen: 1 }, lease: { leaseGen: 1 } });
    const result = { teamId: "team", projectId: "project", orderId, taskId: "task-exec", serviceGeneration: 1, epoch: 1, bootId: "boot-local",
      specRev: 1, round: 0, expectedHead: H, head: H, leaseGen: 2, executorInstanceId: "peer-b", worker, operationId: "lend-result",
      resultDigest: D, verdict: "pass", summary: "", artifactIds: [], observedAt: 10_000 };
    expect(code(k.post(executor, k.command("lend.result", { result })))).toBe("stale_lease_gen");
    expect(k.post(executor, k.command("lend.result", { result: { ...result, leaseGen: 1 } })).status).toBe(200);
    expect(k.call(executor, "lend", { orderId }).body).toMatchObject({ order: { status: "done", resultOperationId: "lend-result" }, lease: null });
  });
  test("未建模的命令回 conflict；测试可注入自己的处理器", () => {
    const k = kit({ handlers: { "dep.remove": () => ({ entityId: "task-exec", rev: 1 }) } });
    expect(code(k.post(member, k.command("step.assign", { ...EXEC_TASK, step: "write", round: 0,
      executor: { kind: "agent", instanceId: "local", agentId: "worker" } })))).toBe("wrong_home");
    expect(code(k.post(owner, k.command("step.assign", { ...EXEC_TASK, step: "write", round: 0,
      executor: { kind: "agent", instanceId: "local", agentId: "worker" } })))).toBe("conflict");
    expect(k.post(member, k.command("dep.remove", { fromTask: "task-exec", toTask: "task-plan", expectedRev: 1 })).status).toBe(200);
  });
  test("fetch 适配器：V2_ROUTES 路径 + 注入身份往返，回包可被 S2K parse", async () => {
    const k = kit(), fetch = k.center.fetch(req => req.headers.get("x-test-actor") === "member" ? member : null);
    const params = { teamId: "team", projectId: "project", featureId: "feature-exec" };
    const res = await fetch(`https://center.invalid${V2_ROUTES.features.path(params)}`, { headers: { "x-test-actor": "member" } });
    expect(res.status).toBe(200);
    expect(V2_ROUTES.features.parseResponse(await res.json(), params).feature.id).toBe("feature-exec");
    const anon = await fetch(`https://center.invalid${V2_ROUTES.features.path(params)}`);
    expect([anon.status, ((await anon.json()) as { code: string }).code]).toEqual([401, "unauthenticated"]);
    expect((await fetch("https://center.invalid/v2/teams/team/projects/project/nothing")).status).toBe(404);
  });
});
