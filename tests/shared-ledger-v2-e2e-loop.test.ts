/** X15 验收线 1：三实例闭环。peer A 网页经本人 bridge（/shared-exec 入口 + X7 客户端）开卡 → 本机领租、推阶段、借单给 peer B 写
 * → peer A 审查 → owner 在中心答复业务授权 → X8 在本机锁内跑假 gh 合并。中心在 127.0.0.1 本地端口，三实例各自临时目录与签名传输；
 * 每一步都断言中心收到的命令（类型 + 状态）、回执与行状态。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Principal } from "../src/lib/principals.js";
import type { V2Command } from "../src/lib/shared-ledger-contract-v2.js";
import { V2_DTO_FIXTURES, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { handleSharedExecApi } from "../src/bridge/local-api/shared-exec.js";
import { configureSharedExecEntry } from "../src/bridge/shared-ledger-v2-entry.js";
import {
  cleanupWorlds, D, F, H0, H1, lease, mergeIntent, MERGED, outcome, REPO, RESOURCE, runMerge, versions, world, type Instance, type World,
} from "./shared-ledger-v2-e2e-world.test.js";

afterEach(() => { configureSharedExecEntry(null); cleanupWorlds(); });

const WEB: Principal = { id: "web:peer-a", role: "external", agents: [], createdAt: "synthetic" };
/** peer A's own bridge: the browser principal maps to peer A's X7 client only; the route is central for the shared feature. */
function peerABridge(w: World) {
  configureSharedExecEntry({
    mode: () => "on",
    clientFor: (p) => p.id === WEB.id ? w.peerA.client : null,
    snapshot: async () => w.peerA.transport.snapshot(F),
    receipt: async (_p, q) => w.peerA.transport.receipt(q),
    scopeFor: () => ({ ...V2_FIXTURE_SCOPE }),
    commandRoute: () => "central",
  });
}
async function web(body: unknown) {
  const url = new URL("http://peer-a-bridge.invalid/api/v1/shared-exec/commands?project=local-project");
  const res = (await handleSharedExecApi(new Request(url.href, { method: "POST", body: JSON.stringify(body) }), "/shared-exec/commands", WEB, url))!;
  return { status: res.status, body: await res.json() as Record<string, any> };
}
const worker = (i: Instance) => ({ kind: "peer_agent" as const, instanceId: i.actor.instanceId, agentId: `worker-${i.id}` });
/** The executor claims the pooled order and reports one result, over its own signed transport (the order's fence, held gen 1). */
async function borrow(w: World, i: Instance, orderId: string, result: { head: string; verdict: string; operationId: string }) {
  const o = w.k.center.rows().orders.get(orderId)!;
  const fence = { serviceGeneration: o.serviceGeneration, epoch: o.epoch, bootId: o.bootId };
  const common = { ...V2_FIXTURE_SCOPE, orderId, taskId: o.taskId, specRev: o.specRev, round: o.round, leaseGen: 1, ...fence,
    executorInstanceId: i.actor.instanceId, worker: worker(i) };
  const claim = await i.raw(i.cmd("lend.claim", { claim: { ...common, head: o.head, grantId: o.grantId, grantDigest: o.grantDigest, claimedAt: w.k.center.time } }));
  const done = await i.raw(i.cmd("lend.result", { result: { ...common, expectedHead: o.head, head: result.head, operationId: result.operationId,
    resultDigest: D, verdict: result.verdict, summary: `${i.label} ${result.verdict}`, artifactIds: [], observedAt: w.k.center.time } }));
  return { claim, done };
}
async function order(w: World, taskId: string, step: "write" | "review", to: Instance, head: string) {
  const r = await w.local.send(w.local.cmd("lend.create", { ...versions(w, taskId), featureId: F, family: "codex", step,
    executorInstanceId: to.actor.instanceId, specArtifactId: "artifact", head, round: 0, branch: step === "write" ? "feat/x15-loop" : null,
    base: step === "write" ? "main" : null, grantId: `grant-${to.id}`, grantDigest: D }));
  return r.result.entityId;
}

describe("X15 验收线 1：网页开卡 → 借单 → 写 → 审查 → owner 合并（三实例 + 本地端口中心）", () => {
  test("每一步的中心命令、回执和行状态都对上；合并只经 owner 授权跑一次假 gh", async () => {
    const w = await world();
    const seqs: number[] = [];
    const step = async <T>(expected: string[], run: () => Promise<T>): Promise<T> => {
      const from = w.k.center.log.length, out = await run();
      expect(w.served(from)).toEqual(expected);
      seqs.push(w.k.center.rows().serverSeq);
      return out;
    };

    // 1. 网页开卡：peer A 浏览器 → peer A bridge → X7 → 中心。回执落在 peer A 成员名下，主场随 feature 是本机。
    peerABridge(w);
    const spec = (V2_DTO_FIXTURES.task.valid as { spec: unknown }).spec;
    const opened = await step(["task.new 200"], () => web(w.peerA.cmd("task.new", { featureId: F, expectedRev: w.peerA.view().feature.rev,
      itemId: null, title: "X15 三实例闭环卡", plan: "", kind: "code", repository: REPO, spec })));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ personId: "member", instanceId: "peer-a", command: "task.new" });
    const T: string = opened.body.result.entityId;
    expect(w.task(T)).toMatchObject({ stage: "spec", homeInstanceId: "local", repository: REPO });
    // 网页带 actor / role 的体在 bridge 就被拒，中心零调用
    await step([], async () => expect((await web({ ...w.peerA.cmd("task.set", { taskId: T, expectedRev: 1, expectedSpecRev: 1, patch: { title: "x" } }),
      actor: "owner" })).status).toBe(400));

    // 2. 本机（owner）设工作流、领中心主场租约、spec → build
    await step(["workflow.set 200"], () => w.local.send(w.local.cmd("workflow.set", { taskId: T, expectedRev: 1, expectedSpecRev: 1,
      expectedWorkflowRev: 1, template: "code", templateVersion: 1, mode: "manual", authorFamily: "codex", fallback: [], authorizationAskId: null })));
    await step(["lease.acquire 200"], () => lease(w, T));
    expect(w.k.center.rows().leases.get(T)).toMatchObject({ homeInstanceId: "local", holderInstanceId: "local", bootId: "boot-local" });
    await step(["task.stage 200"], () => w.local.send(w.local.cmd("task.stage", { ...versions(w, T), from: "spec", to: "build", round: 0, authorizationAskId: null })));

    // 3. 借单写：本机建 write 单（指定 peer B）→ peer B 领单、交付 H1 → 本机按订单回写交付
    const write = await step(["lend.create 200"], () => order(w, T, "write", w.peerB, H0));
    expect(w.k.center.rows().orders.get(write)).toMatchObject({ status: "pooled", executorInstanceId: "peer-b", homeInstanceId: "local", leaseGen: 0 });
    const wrote = await step(["lend.claim 200", "lend.result 200"], () => borrow(w, w.peerB, write, { head: H1, verdict: "delivered", operationId: "lend-write" }));
    expect([wrote.claim.instanceId, wrote.done.instanceId]).toEqual(["peer-b", "peer-b"]);
    expect(w.k.center.rows().orders.get(write)).toMatchObject({ status: "done", leaseGen: 1, resultOperationId: "lend-write" });
    expect(w.task(T).stage).toBe("build"); // 订单结果不改整卡：只有主场的交付命令推进
    await step(["task.deliver 200"], () => w.local.send(w.local.cmd("task.deliver", { ...versions(w, T), round: 0, orderId: write, leaseGen: 1,
      head: H1, artifactIds: [], summary: "peer B 交付" })));
    expect(w.task(T)).toMatchObject({ stage: "review", head: H1, delivery: { orderId: write } });

    // 4. 审查：本机建 review 单给 peer A → peer A 领单、pass → 本机回写审查结论
    const review = await step(["lend.create 200"], () => order(w, T, "review", w.peerA, H1));
    await step(["lend.claim 200", "lend.result 200"], () => borrow(w, w.peerA, review, { head: H1, verdict: "pass", operationId: "lend-review" }));
    await step(["task.review 200"], () => w.local.send(w.local.cmd("task.review", { ...versions(w, T), round: 0, orderId: review, leaseGen: 1,
      head: H1, verdict: "pass", reportArtifactId: "artifact-review" })));
    expect(w.task(T)).toMatchObject({ stage: "merge", review: { verdict: "pass", reviewedHead: H1 } });

    // 5. owner 合并：成员不能代签 / 代发合并意图（本机闸拒，中心零调用）；owner 答复业务授权后 X8 跑一次假 gh
    await w.peerA.refresh();
    await step([], async () => {
      await expect(w.peerA.send(w.peerA.cmd("intent.create", { ...versions(w, T), action: "merge", node: "merge_deploy", operationId: "op-forged",
        head: H1, round: 0, dependencyDigest: D, authorizationAskId: "ask-exec", authorizationDigest: D, resources: RESOURCE }))).rejects.toThrow("wrong_home");
    });
    const ctx = await step(["ask.create 200", "ask.answer 200", "intent.create 200"], () => mergeIntent(w, T, H1));
    expect(w.k.center.rows().asks.get(ctx.authorizationAskId)).toMatchObject({ state: "answered", decision: "approved", answeredBy: "person" });
    const merged = await step(["authorization.check 200", "intent.check 200", "authorization.check 200", "intent.check 200", "operation.result 200"],
      () => runMerge(w, ctx));
    expect(outcome(merged)).toEqual({ state: "succeeded", resourceHeld: false, reported: true, replayed: false });
    expect(w.ghCalls()).toEqual([`pr merge 7 --squash --match-head-commit ${H1}`]);
    expect(w.k.center.rows().intents.get(ctx.operationId)).toMatchObject({ status: "done", action: "merge", homeInstanceId: "local" });
    expect(w.k.center.rows().operationResults.get(ctx.operationId)).toMatchObject({ state: "succeeded", head: MERGED });
    expect(w.k.center.rows().resources).toEqual([]);
    await step(["task.stage 200", "lease.release 200"], async () => {
      await w.local.send(w.local.cmd("task.stage", { ...versions(w, T), from: "merge", to: "done", round: 0, authorizationAskId: ctx.authorizationAskId }));
      return w.local.send(w.local.cmd("lease.release", { taskId: T, reason: "合并完成" }));
    });
    expect(w.task(T).stage).toBe("done");

    // 中心序列严格递增；三实例看到同一份中心快照
    expect(seqs.filter((s, i) => i > 0 && s < seqs[i - 1]!)).toEqual([]);
    const views = await Promise.all(w.all.map(i => i.refresh()));
    expect(new Set(views.map(v => v.serverSeq)).size).toBe(1);
    expect(views.every(v => v.value.tasks.find(t => t.id === T)?.stage === "done" && !v.rollback)).toBe(true);
    // 同一张合并单再跑：本机日志回放，不再调假 gh
    expect(outcome(await runMerge(w, ctx))).toEqual({ state: "succeeded", resourceHeld: false, reported: true, replayed: true });
    expect(w.ghCalls()).toHaveLength(1);
  });

  test("网页入口拿不到 peer A 客户端（别的 principal）→ 503，中心零调用", async () => {
    const w = await world();
    peerABridge(w);
    const url = new URL("http://peer-a-bridge.invalid/api/v1/shared-exec/commands?project=local-project");
    const c: V2Command = w.peerA.cmd("task.set", { taskId: "task-exec", expectedRev: 1, expectedSpecRev: 1, patch: { title: "x" } });
    const res = (await handleSharedExecApi(new Request(url.href, { method: "POST", body: JSON.stringify(c) }), "/shared-exec/commands",
      { ...WEB, id: "web:stranger" }, url))!;
    expect(res.status).toBe(503);
    expect(w.served()).toEqual([]);
  });
});
