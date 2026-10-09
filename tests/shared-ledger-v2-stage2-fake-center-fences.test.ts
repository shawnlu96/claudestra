/** S2C 第 1 轮审查复现：跨任期意图、出借结果的状态关系、中心重启失租、旧主场旧 epoch 的错误码。
 * 只用合成 fake center（tests/helpers/shared-ledger-v2-fake-center*），不读生产、不连网络。
 */
import { describe, expect, test } from "bun:test";
import { ACTORS, code, EXEC_TASK, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const { owner, executor } = ACTORS;
const H = "b".repeat(40), D = "a".repeat(64);
const resources = [{ teamId: "team", projectId: "project", repository: "team/repository", kind: "file", path: "src/example.ts" }];
const acquire = (k: ReturnType<typeof kit>, bootId = "boot-local") =>
  k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" }, { bootId }));

describe("S2C r1：意图只在创建它的租约任期内推进", () => {
  const setup = () => {
    const k = kit();
    acquire(k);
    const created = k.post(owner, k.command("intent.create", { ...EXEC_TASK, action: "dispatch", node: "write", operationId: "op-1",
      head: H, round: 0, dependencyDigest: D, authorizationAskId: null, authorizationDigest: null, resources }));
    const intentId = (created.body as any).result.entityId as string;
    const check = (bootId: string) => k.command("intent.check", { ...EXEC_TASK, intentId, operationId: "op-1",
      authorizationAskId: null, authorizationDigest: null }, { bootId });
    return { k, intentId, check };
  };
  test("租约过期、换 boot 重新领租后，新任期 check 旧意图 → stale_epoch，意图仍 pending、锁仍占着", () => {
    const { k, intentId, check } = setup();
    k.center.advance(60_001);
    expect(acquire(k, "boot-next").status).toBe(200);
    const before = k.center.rows();
    expect(code(k.post(owner, check("boot-next")))).toBe("stale_epoch");
    expect(k.center.rows()).toEqual(before);
    expect(before.intents.get(intentId)).toMatchObject({ status: "pending", bootId: "boot-local" });
    expect(before.resources).toMatchObject([{ intentId, state: "held" }]);
  });
  test("别的 boot 接手又过期、原 boot 再领租：fence 相同也不能推进上一任期的意图（lease_expired）", () => {
    const { k, check } = setup();
    k.center.advance(60_001);
    acquire(k, "boot-next");
    k.center.advance(60_001);
    expect(acquire(k).status).toBe(200);
    expect(code(k.post(owner, check("boot-local")))).toBe("lease_expired");
  });
  test("同 boot 在租期内重复 acquire 不开新任期：意图照常推进", () => {
    const { k, check } = setup();
    k.center.advance(1_000);
    expect(acquire(k).status).toBe(200);
    expect(k.post(owner, check("boot-local")).status).toBe(200);
  });
});

describe("S2C r1：出借结果核订单版本 / head / 认领 worker / 中心租约", () => {
  const worker = { kind: "peer_agent", instanceId: "peer-b", agentId: "worker" };
  const setup = () => {
    const k = kit();
    acquire(k);
    const created = k.post(owner, k.command("lend.create", { ...EXEC_TASK, featureId: "feature-exec", family: "codex", step: "review",
      executorInstanceId: "peer-b", specArtifactId: "artifact", head: H, round: 0, branch: null, base: null, grantId: "grant", grantDigest: D }));
    const orderId = (created.body as any).result.entityId as string;
    const scoped = { teamId: "team", projectId: "project", orderId, taskId: "task-exec", serviceGeneration: 1, epoch: 1, bootId: "boot-local" };
    expect(k.post(executor, k.command("lend.claim", { claim: { ...scoped, specRev: 1, round: 0, head: H, leaseGen: 1,
      executorInstanceId: "peer-b", worker, grantId: "grant", grantDigest: D, claimedAt: 10_000 } })).status).toBe(200);
    const result = { ...scoped, specRev: 1, round: 0, expectedHead: H, head: "c".repeat(40), leaseGen: 1, executorInstanceId: "peer-b",
      worker, operationId: "lend-result", resultDigest: D, verdict: "pass", summary: "", artifactIds: [], observedAt: 10_000 };
    // The contract parser already pins the result's fence to the command's, so a foreign fence travels on both.
    const post = (patch: Record<string, unknown>) => k.post(executor, k.command("lend.result", { result: { ...result, ...patch } },
      typeof patch.bootId === "string" ? { bootId: patch.bootId } : {}));
    return { k, orderId, post };
  };
  const cases: [string, Record<string, unknown>, string, number][] = [
    ["specRev / round 不符", { specRev: 2, round: 1 }, "stale_order", 0],
    ["expectedHead 不是订单 head", { expectedHead: "d".repeat(40) }, "stale_order", 0],
    ["同实例另一个 worker", { worker: { ...worker, agentId: "other-worker" } }, "forbidden", 0],
    ["中心租约已过期", {}, "lease_expired", 60_001],
    ["fence 不是订单的 fence", { bootId: "boot-other" }, "stale_epoch", 0],
  ];
  for (const [name, patch, expected, wait] of cases) test(`${name} → ${expected}，订单仍 claimed、租约不动`, () => {
    const { k, orderId, post } = setup();
    k.center.advance(wait);
    const before = k.center.rows();
    expect(code(post(patch))).toBe(expected);
    expect(k.center.rows()).toEqual(before);
    expect(before.orders.get(orderId)).toMatchObject({ status: "claimed" });
    expect(before.lendLeases.has(orderId)).toBe(true);
  });
  test("全部对得上 → done，租约删除", () => {
    const { k, orderId, post } = setup();
    expect(post({}).status).toBe(200);
    expect(k.center.rows().orders.get(orderId)).toMatchObject({ status: "done" });
    expect(k.center.rows().lendLeases.has(orderId)).toBe(false);
  });
});

describe("S2C r1：中心重启失租 / 旧主场旧 epoch", () => {
  test("中心重启后旧租约失效：旧 fence 续租 lease_expired，重新 acquire 照常", () => {
    const k = kit();
    expect(acquire(k).status).toBe(200);
    k.center.restart();
    expect(code(k.post(owner, k.command("lease.renew", { taskId: "task-exec", homeInstanceId: "local" })))).toBe("lease_expired");
    expect(acquire(k).status).toBe(200);
    expect(k.post(owner, k.command("lease.renew", { taskId: "task-exec", homeInstanceId: "local" })).status).toBe(200);
  });
  test("换主场升 epoch 后，旧主场带旧 epoch 领租 → stale_epoch（epoch 先于主场核）；带新 epoch → wrong_home", () => {
    const k = kit();
    expect(k.post(owner, k.command("home.change", { featureId: "feature-exec", expectedRev: 1, nextHomeInstanceId: "peer-b", nextEpoch: 2,
      authorizationAskId: "ask-exec", oldHomeStopped: true, workersSettled: true, lendSettled: true, unknownReconciled: true })).status).toBe(200);
    const stale = k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" }));
    expect([stale.status, code(stale)]).toEqual([409, "stale_epoch"]);
    const home = k.post(owner, k.command("lease.acquire", { ...EXEC_TASK, homeInstanceId: "local" }, { epoch: 2 }));
    expect([home.status, code(home)]).toEqual([403, "wrong_home"]);
  });
});
